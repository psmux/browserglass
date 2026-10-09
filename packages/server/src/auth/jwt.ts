import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  timingSafeEqual,
} from 'node:crypto';
import type { BglsClaims } from '@browserglass/protocol';
import type { AppSigningKey } from '../config/types.js';

/** The one legal `typ` value for a BrowserGlass token. Any other value fails verification. */
export const BGLS_JWT_TYP = 'bgls+jwt';

/** The compact JWS header BrowserGlass writes and reads. `alg` is authoritative on the key record, never used to select it at verification. */
export interface BglsJwtHeader {
  readonly alg: 'EdDSA' | 'HS256';
  readonly typ: 'bgls+jwt';
  readonly kid: string;
}

/** Thrown by {@link verifyCompactJws} for every verification failure, with a machine readable `reason`. */
export class JwtVerificationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'JwtVerificationError';
    this.reason = reason;
  }
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function b64urlJson(value: unknown): string {
  return b64url(Buffer.from(JSON.stringify(value), 'utf8'));
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/** Builds a Node `KeyObject` for Ed25519 verification from a raw 32 byte base64url public key. */
function ed25519PublicKeyObject(publicKeyB64url: string) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64url },
    format: 'jwk',
  });
}

/** Builds a Node `KeyObject` for Ed25519 signing from raw 32 byte base64url public and private key material. */
function ed25519PrivateKeyObject(publicKeyB64url: string, privateKeyB64url: string) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64url, d: privateKeyB64url },
    format: 'jwk',
  });
}

/**
 * Signs `claims` as a compact JWS using `key`. EdDSA is signed directly
 * against `node:crypto`'s native Ed25519 support (`crypto.sign(null, ...)`,
 * no intermediate hash); HS256 uses HMAC-SHA256 and
 * exists only for single process embedded/dev deployments. There is no
 * JWT library in the hot path: this module hand rolls both algorithms.
 */
export function signCompactJws(claims: BglsClaims, key: AppSigningKey): string {
  if (key.alg === 'EdDSA' && key.privateKey === undefined) {
    throw new Error(`signCompactJws: key "${key.kid}" has no privateKey, cannot sign.`);
  }
  const header: BglsJwtHeader = { alg: key.alg, typ: BGLS_JWT_TYP, kid: key.kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature =
    key.alg === 'EdDSA'
      ? cryptoSign(
          null,
          Buffer.from(signingInput, 'utf8'),
          ed25519PrivateKeyObject(key.publicKey, key.privateKey!),
        )
      : createHmac('sha256', Buffer.from(key.publicKey, 'base64url'))
          .update(signingInput, 'utf8')
          .digest();
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Verifies a compact JWS against the key its header names, resolved via
 * `resolveKey(kid)`. `alg` is never taken from the header for algorithm
 * selection: the key record's own `alg` is authoritative, and a header
 * that disagrees fails verification outright. This closes alg confusion
 * attacks (`alg: none`, an HS256 signature checked against an EdDSA
 * public key) by construction.
 */
export function verifyCompactJws(
  token: string,
  resolveKey: (kid: string) => AppSigningKey | undefined,
): { readonly header: BglsJwtHeader; readonly claims: BglsClaims } {
  const parts = token.split('.');
  if (parts.length !== 3)
    throw new JwtVerificationError('malformed', 'Token is not a three part compact JWS.');
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: BglsJwtHeader;
  try {
    header = JSON.parse(fromB64url(headerB64).toString('utf8')) as BglsJwtHeader;
  } catch {
    throw new JwtVerificationError('malformed', 'Token header is not valid JSON.');
  }
  if (header.typ !== BGLS_JWT_TYP) {
    throw new JwtVerificationError(
      'bad_typ',
      `Token header "typ" is "${header.typ}", expected "${BGLS_JWT_TYP}". This rejects cross purpose token replay.`,
    );
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new JwtVerificationError('missing_kid', 'Token header is missing "kid".');
  }

  const key = resolveKey(header.kid);
  if (key === undefined) {
    throw new JwtVerificationError('unknown_kid', `No key record for kid "${header.kid}".`);
  }
  if (key.status === 'revoked' || key.status === 'pending') {
    throw new JwtVerificationError(
      'key_not_active',
      `Key "${header.kid}" is ${key.status}, not active or retiring.`,
    );
  }
  if (header.alg !== key.alg) {
    throw new JwtVerificationError(
      'alg_mismatch',
      `Token header "alg" is "${header.alg}" but key "${header.kid}" is registered for "${key.alg}". The key record decides the algorithm, never the header.`,
    );
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = fromB64url(sigB64);
  const ok =
    key.alg === 'EdDSA'
      ? cryptoVerify(
          null,
          Buffer.from(signingInput, 'utf8'),
          ed25519PublicKeyObject(key.publicKey),
          signature,
        )
      : timingSafeEqualHmac(signingInput, signature, key.publicKey);
  if (!ok) {
    throw new JwtVerificationError('bad_signature', 'Signature verification failed.');
  }

  let claims: BglsClaims;
  try {
    claims = JSON.parse(fromB64url(payloadB64).toString('utf8')) as BglsClaims;
  } catch {
    throw new JwtVerificationError('malformed', 'Token payload is not valid JSON.');
  }

  return { header, claims };
}

function timingSafeEqualHmac(
  signingInput: string,
  signature: Buffer,
  secretB64url: string,
): boolean {
  const expected = createHmac('sha256', Buffer.from(secretB64url, 'base64url'))
    .update(signingInput, 'utf8')
    .digest();
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(expected, signature);
}

/** Generates a fresh Ed25519 keypair, base64url raw 32 byte material for both halves. Used by `ephemeral` dev key setup. */
export function generateEd25519KeyMaterial(): {
  readonly publicKey: string;
  readonly privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { publicKey: pubJwk.x, privateKey: privJwk.d };
}
