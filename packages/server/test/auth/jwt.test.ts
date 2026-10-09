import { describe, expect, it } from 'vitest';
import {
  generateEd25519KeyMaterial,
  signCompactJws,
  verifyCompactJws,
} from '../../src/auth/jwt.js';
import type { AppSigningKey } from '../../src/config/types.js';

function key(overrides: Partial<AppSigningKey> = {}): AppSigningKey {
  const material = generateEd25519KeyMaterial();
  return {
    kid: 'key_test',
    alg: 'EdDSA',
    publicKey: material.publicKey,
    privateKey: material.privateKey,
    status: 'active',
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: 'app_00000000000000000000000000',
    aid: 'app_00000000000000000000000000',
    tid: 'ten_00000000000000000000000000',
    sub: 'user:1',
    caps: ['view'],
    scope: { kind: 'tenant' },
    iat: nowSec,
    exp: nowSec + 120,
    jti: 'jti_test',
    ...overrides,
  } as never;
}

describe('EdDSA compact JWS sign and verify', () => {
  it('round trips a signed token', () => {
    const k = key();
    const token = signCompactJws(claims(), k);
    const result = verifyCompactJws(token, () => k);
    expect(result.claims.sub).toBe('user:1');
    expect(result.header.alg).toBe('EdDSA');
    expect(result.header.typ).toBe('bgls+jwt');
  });

  it('fails verification when the header alg disagrees with the key record, never trusting the header for algorithm selection', () => {
    const k = key({
      kid: 'key_hs',
      alg: 'HS256',
      publicKey: Buffer.from('shared-secret-1234567890123456').toString('base64url'),
    });
    const token = signCompactJws(claims(), k);

    // Tamper the header to claim EdDSA while the key record says HS256.
    const [headerB64, payloadB64, sigB64] = token.split('.');
    const forgedHeader = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'bgls+jwt', kid: k.kid }),
      'utf8',
    ).toString('base64url');
    const forged = `${forgedHeader}.${payloadB64}.${sigB64}`;

    expect(() => verifyCompactJws(forged, () => k)).toThrow(/alg/i);
  });

  it('rejects a typ other than bgls+jwt', () => {
    const k = key();
    const token = signCompactJws(claims(), k);
    const [, payloadB64, sigB64] = token.split('.');
    const badTypHeader = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: k.kid }),
      'utf8',
    ).toString('base64url');
    const forged = `${badTypHeader}.${payloadB64}.${sigB64}`;
    expect(() => verifyCompactJws(forged, () => k)).toThrow(/typ/i);
  });

  it('rejects a signature made with a different key', () => {
    const k1 = key({ kid: 'key_1' });
    const k2 = key({ kid: 'key_1' }); // same kid, different keypair, simulating a forged signature
    const token = signCompactJws(claims(), k1);
    expect(() => verifyCompactJws(token, () => k2)).toThrow();
  });
});
