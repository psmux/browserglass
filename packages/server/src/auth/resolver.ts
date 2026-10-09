import type { IncomingMessage } from 'node:http';
import type {
  AppId,
  AuthContext,
  AuthRejection,
  AuthResolver,
  JtiCache,
  Principal,
  Scope,
  Store,
  TenantId,
} from '@browserglass/protocol';
import type { AppSigningKey } from '../config/types.js';
import { compact } from '../util/compact.js';
import { verifyToken } from './verify.js';

/** Thrown by {@link principalFor} on any resolver rejection. Carries the {@link AuthRejection} unmodified. */
export class AuthError extends Error {
  readonly rejection: AuthRejection;
  constructor(rejection: AuthRejection) {
    super(rejection.message);
    this.name = 'AuthError';
    this.rejection = rejection;
  }
}

/**
 * Builds the wire level {@link AuthContext} from a Node request, the shape
 * every `AuthResolver` receives: remote address, `X-Forwarded-For`,
 * `Origin`, and `User-Agent`. Deliberately narrow (no cookies pre-parsed,
 * no framework request object), so one resolver works across every framework adapter.
 */
export function authContextFromRequest(req: IncomingMessage): AuthContext {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  };
  return compact({
    remoteAddress: req.socket.remoteAddress,
    forwardedFor: header('x-forwarded-for'),
    origin: header('origin'),
    userAgent: header('user-agent'),
  });
}

/**
 * Extracts a bearer token from `Authorization: Bearer <token>`. Returns
 * `undefined` for a missing or malformed header. This is the highest
 * precedence credential carrier.
 */
export function bearerTokenFromRequest(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (value === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value);
  return m?.[1];
}

/** Extracts `?ticket=` or a bearer token from a query token param, respecting `auth.allowQueryToken`. */
export function queryTokenFromRequest(
  req: IncomingMessage,
  allowQueryToken: boolean,
): string | undefined {
  if (!allowQueryToken || req.url === undefined) return undefined;
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') ?? undefined;
}

/**
 * Builds the default JWT backed `AuthResolver`. Verification is delegated
 * to {@link verifyToken}, so this resolver and `TokenApi.verify` share
 * exactly one code path.
 */
export function jwtAuthResolver(opts: {
  readonly keys: readonly AppSigningKey[];
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly issuer: AppId;
  readonly clockSkewSeconds: number;
  readonly jtiCache: JtiCache;
  readonly store?: Store;
}): AuthResolver {
  const keysByKid = new Map(opts.keys.map((k) => [k.kid, k] as const));
  const resolveKey = (kid: string): AppSigningKey | undefined => keysByKid.get(kid);

  return {
    async verify(token: string): Promise<Principal | AuthRejection> {
      try {
        return await verifyToken(token, opts, resolveKey);
      } catch (err) {
        return tokenErrorToRejection(err);
      }
    },
    async refresh(_ctx: AuthContext, token: string): Promise<Principal | AuthRejection> {
      try {
        return await verifyToken(token, opts, resolveKey);
      } catch (err) {
        return tokenErrorToRejection(err);
      }
    },
  };
}

function tokenErrorToRejection(err: unknown): AuthRejection {
  const code =
    err instanceof Error && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'E_TOKEN_INVALID';
  const message = err instanceof Error ? err.message : 'Token verification failed.';
  const closeCode = code === 'E_TOKEN_EXPIRED' ? 4201 : 4200;
  return { code, message, closeCode };
}

const principalCache = new WeakMap<object, Promise<Principal>>();

/**
 * Resolves the `Principal` for a REST request, caching per request object:
 * calling `principalFor` three times in three middlewares for one route
 * runs the resolver once. Extracts the token via
 * {@link bearerTokenFromRequest} (and, when `allowQueryToken` is set, a
 * `?token=` query param) and calls `resolver.verify`. Throws
 * {@link AuthError} on rejection.
 */
export async function principalFor(
  req: IncomingMessage,
  resolver: AuthResolver,
  opts: { readonly allowQueryToken: boolean },
): Promise<Principal> {
  const cached = principalCache.get(req);
  if (cached !== undefined) return cached;

  const promise = (async () => {
    const token = bearerTokenFromRequest(req) ?? queryTokenFromRequest(req, opts.allowQueryToken);
    if (token === undefined) {
      throw new AuthError({
        code: 'E_UNAUTHENTICATED',
        message: 'No bearer token presented.',
        closeCode: 4200,
      });
    }
    const ctx = authContextFromRequest(req);
    const result = await resolver.verify(token, ctx);
    if (!isPrincipal(result)) throw new AuthError(result);
    return result;
  })();

  principalCache.set(req, promise);
  return promise;
}

function isPrincipal(value: Principal | AuthRejection): value is Principal {
  return (
    typeof (value as Principal).sub === 'string' &&
    typeof (value as Principal).tenantId === 'string'
  );
}

/**
 * Builds a `Principal` directly from app supplied claims, for apps that
 * already know who the user is (no token to verify). Fills every field a
 * bare partial might omit with a safe default.
 */
export function principalFromClaims(
  claims: Partial<Principal> & {
    readonly tenantId: string;
    readonly appId: string;
    readonly sub: string;
  },
  opts: { readonly scope?: Scope; readonly defaultExpiresInSeconds?: number } = {},
): Principal {
  const nowSec = Math.floor(Date.now() / 1000);
  return compact({
    tenantId: claims.tenantId as TenantId,
    appId: claims.appId as AppId,
    sub: claims.sub,
    subKind: claims.subKind ?? 'service',
    name: claims.name,
    caps: claims.caps ?? [],
    scope: claims.scope ?? opts.scope ?? { kind: 'tenant' as const },
    jti: claims.jti ?? `local:${claims.sub}:${nowSec}`,
    exp: claims.exp ?? nowSec + (opts.defaultExpiresInSeconds ?? 3600),
  });
}
