import type {
  AppId,
  Capability,
  JtiCache,
  Principal,
  Scope,
  TenantId,
} from '@browserglass/protocol';

/** `ROLE_BUNDLES` key names, re-declared here only for a friendlier `IssueTokenRequest.role` type. */
export type RoleBundleName = 'observer' | 'driver' | 'operator' | 'agent' | 'owner';

/** Narrowing only per token policy overrides, `pol` on the JWT claim set. */
export interface TokenPolicy {
  readonly urlAllow?: readonly string[];
  readonly urlDeny?: readonly string[];
  readonly maxSessionSec?: number;
  readonly maxIdleSec?: number;
  readonly downloadMaxBytes?: number;
  readonly clipboardMaxBytes?: number;
  readonly qualityCeiling?: 'low' | 'medium' | 'high' | 'auto';
}

/** Input to {@link TokenApi.issue} / {@link TokenApi.issueWithMeta}. */
export interface IssueTokenRequest {
  readonly sub: string;
  readonly caps?: readonly Capability[];
  readonly role?: RoleBundleName;
  readonly iUnderstandAdmin?: boolean;
  readonly scope: Scope;
  readonly tenantId?: TenantId;
  readonly appId?: AppId;
  readonly subKind?: 'user' | 'agent' | 'guest' | 'service';
  readonly name?: string;
  readonly ttlSeconds?: number;
  readonly refreshable?: boolean;
  readonly refreshUntil?: number;
  readonly policy?: TokenPolicy;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Result of {@link TokenApi.issueWithMeta}. `caps` is always the effective set post intersection, never the requested one. */
export interface IssuedToken {
  readonly token: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly caps: readonly Capability[];
  readonly narrowed: readonly Capability[];
}

/** One entry from {@link TokenApi.keys}. Never carries private key material. */
export interface PublicKeyRef {
  readonly kid: string;
  readonly appId: AppId;
  readonly alg: 'EdDSA' | 'HS256';
  readonly publicKey: string;
  readonly status: 'pending' | 'active' | 'retiring' | 'revoked';
}

/**
 * Token issuance and verification surface exposed as `bg.tokens`.
 */
export interface TokenApi {
  issue(req: IssueTokenRequest): Promise<string>;
  issueWithMeta(req: IssueTokenRequest): Promise<IssuedToken>;
  verify(token: string): Promise<Principal>;
  revoke(jti: string, opts?: { readonly untilExp?: boolean }): Promise<void>;
  keys(): Promise<readonly PublicKeyRef[]>;
  rotate(opts?: { readonly retireAfterMs?: number }): Promise<PublicKeyRef>;
}

/** Thrown by `TokenApi` methods. `code` is one of the `E_*` token error codes. */
export class TokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

/** Re-exported for callers that only need the cache shape, not a construction helper. */
export type { JtiCache };
