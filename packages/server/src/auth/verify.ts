import type { AppId, JtiCache, Principal, Store, TenantId } from '@browserglass/protocol';
import type { AppSigningKey } from '../config/types.js';
import { compact } from '../util/compact.js';
import { type BglsJwtHeader, JwtVerificationError, verifyCompactJws } from './jwt.js';
import { TokenError } from './types.js';

/** Tokens claiming a lifetime longer than this many seconds are rejected outright. */
export const MAX_TOKEN_LIFETIME_SEC = 900;

/** Tokens with `exp - iat` above this are never cached or replay checked; see {@link JTI_CACHE_MAX_LIFETIME_SEC}. */
const JTI_REPLAY_CEILING_SEC = 300;

/** Dependencies {@link verifyToken} needs beyond the token string and a key resolver. */
export interface VerifyTokenDeps {
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly issuer: AppId;
  readonly clockSkewSeconds: number;
  readonly jtiCache: JtiCache;
  readonly store?: Store;
}

/**
 * Verifies a compact JWS and returns the resulting {@link Principal}.
 * Enforces every claim-shape rule: `typ` must be
 * `bgls+jwt` (checked inside {@link verifyCompactJws}), `alg` is taken
 * from the key record never the header, `iss` must equal `aid`, the token
 * lifetime is capped at {@link MAX_TOKEN_LIFETIME_SEC} regardless of what
 * was requested, and a `jti` shorter lived than
 * {@link JTI_REPLAY_CEILING_SEC} is replay checked via `jtiCache`. When a
 * `store` is supplied, consults the durable revocations table for
 * `sub`, `jti`, `kid`, and (when present) `del.inviteId`.
 */
export async function verifyToken(
  token: string,
  deps: VerifyTokenDeps,
  resolveKey: (kid: string) => AppSigningKey | undefined,
): Promise<Principal> {
  let header: BglsJwtHeader;
  let claims: Awaited<ReturnType<typeof verifyCompactJws>>['claims'];
  try {
    ({ header, claims } = verifyCompactJws(token, resolveKey));
  } catch (err) {
    if (err instanceof JwtVerificationError) {
      throw new TokenError('E_TOKEN_INVALID', err.message);
    }
    throw err;
  }

  if (claims.iss !== claims.aid) {
    throw new TokenError(
      'E_TOKEN_INVALID',
      `Claim "iss" (${claims.iss}) must equal "aid" (${claims.aid}).`,
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const lifetimeSec = claims.exp - claims.iat;
  if (lifetimeSec > MAX_TOKEN_LIFETIME_SEC) {
    throw new TokenError(
      'E_TOKEN_INVALID',
      `Token lifetime ${lifetimeSec}s exceeds the ${MAX_TOKEN_LIFETIME_SEC}s ceiling enforced at verification.`,
    );
  }
  if (nowSec > claims.exp + deps.clockSkewSeconds) {
    throw new TokenError('E_TOKEN_EXPIRED', `Token expired at ${claims.exp}, now is ${nowSec}.`);
  }
  const notBefore = claims.nbf ?? claims.iat;
  if (nowSec < notBefore - deps.clockSkewSeconds) {
    throw new TokenError(
      'E_TOKEN_INVALID',
      `Token not valid until ${notBefore}, now is ${nowSec}.`,
    );
  }

  if (lifetimeSec <= JTI_REPLAY_CEILING_SEC) {
    const admitted = deps.jtiCache.admit(claims.aid, claims.jti, claims.exp);
    if (!admitted) {
      throw new TokenError(
        'E_TOKEN_REPLAYED',
        `jti "${claims.jti}" was already presented and is still within its window.`,
      );
    }
  }

  if (deps.store !== undefined) {
    const checks = [
      { kind: 'sub' as const, value: claims.sub },
      { kind: 'jti' as const, value: claims.jti },
      { kind: 'kid' as const, value: header.kid },
      ...(claims.del?.inviteId !== undefined
        ? [{ kind: 'invite' as const, value: claims.del.inviteId }]
        : []),
    ];
    const revokedId = await deps.store.checkRevoked(claims.tid, checks);
    if (revokedId !== null) {
      throw new TokenError(
        'E_TOKEN_REVOKED',
        `Token is covered by revocation record "${revokedId}".`,
      );
    }
  }

  return compact({
    tenantId: claims.tid,
    appId: claims.aid,
    sub: claims.sub,
    subKind: claims.sub_kind ?? 'user',
    name: claims.name,
    caps: claims.caps,
    scope: claims.scope,
    jti: claims.jti,
    exp: claims.exp,
  });
}
