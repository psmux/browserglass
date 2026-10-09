import {
  CAPABILITIES,
  type Capability,
  ROLE_BUNDLES,
  type TenantId,
  isCapability,
  newId,
} from '@browserglass/protocol';
import type { AppSigningKey } from '../config/types.js';
import { compact } from '../util/compact.js';
import { effectiveCapabilities } from './capabilities.js';
import { generateEd25519KeyMaterial, signCompactJws } from './jwt.js';
import {
  type IssueTokenRequest,
  type IssuedToken,
  type PublicKeyRef,
  type TokenApi,
  TokenError,
} from './types.js';
import { type VerifyTokenDeps, verifyToken } from './verify.js';

export interface TokenApiOptions extends VerifyTokenDeps {
  readonly keys: readonly AppSigningKey[];
  readonly defaultTtlSeconds: number;
  readonly maxTtlSeconds: number;
  readonly maxCaps: readonly Capability[];
  /** `tenant.allowed_caps`. All 18 when the tenant sets none. */
  readonly tenantAllowedCaps: readonly Capability[];
  readonly clock: { now(): number };
}

/**
 * The concrete `bg.tokens` implementation. Holds its own mutable key table
 * seeded from `ResolvedConfig.auth.keys` so {@link TokenApi.rotate} can add
 * a key without touching the frozen `ResolvedConfig`.
 */
export class TokenApiImpl implements TokenApi {
  private readonly keysByKid = new Map<string, AppSigningKey>();
  private readonly opts: TokenApiOptions;

  constructor(opts: TokenApiOptions) {
    this.opts = opts;
    for (const key of opts.keys) this.keysByKid.set(key.kid, key);
  }

  private resolveKey(kid: string): AppSigningKey | undefined {
    return this.keysByKid.get(kid);
  }

  private activeSigningKey(appId: string): AppSigningKey {
    for (const key of this.keysByKid.values()) {
      if (
        (key.appId ?? this.opts.issuer) === appId &&
        (key.status ?? 'active') === 'active' &&
        key.privateKey !== undefined
      ) {
        return key;
      }
    }
    throw new TokenError(
      'E_NO_SIGNING_KEY',
      `No active signing key for app "${appId}". Add one to auth.keys.`,
    );
  }

  async issue(req: IssueTokenRequest): Promise<string> {
    return (await this.issueWithMeta(req)).token;
  }

  async issueWithMeta(req: IssueTokenRequest): Promise<IssuedToken> {
    const tenantId = req.tenantId ?? this.opts.tenantId;
    const appId = req.appId ?? this.opts.appId;

    let requestedCaps: readonly Capability[];
    if (req.role !== undefined) {
      requestedCaps = ROLE_BUNDLES[req.role];
      if (req.role === 'owner' && req.iUnderstandAdmin !== true) {
        throw new TokenError(
          'E_ADMIN_NOT_ACKNOWLEDGED',
          'role "owner" expands to admin; pass iUnderstandAdmin: true to acknowledge.',
        );
      }
    } else {
      requestedCaps = req.caps ?? [];
    }
    if (requestedCaps.includes('admin') && req.iUnderstandAdmin !== true) {
      throw new TokenError(
        'E_ADMIN_NOT_ACKNOWLEDGED',
        'caps includes "admin"; pass iUnderstandAdmin: true to acknowledge.',
      );
    }
    for (const cap of requestedCaps) {
      if (!isCapability(cap)) {
        throw new TokenError(
          'E_CAP_UNKNOWN',
          `"${cap}" is not one of the ${CAPABILITIES.length} canonical capabilities.`,
        );
      }
    }

    const ttlSeconds = req.ttlSeconds ?? this.opts.defaultTtlSeconds;
    if (ttlSeconds > this.opts.maxTtlSeconds) {
      throw new TokenError(
        'E_TTL_TOO_LONG',
        `ttlSeconds ${ttlSeconds} exceeds auth.maxTtlSeconds ${this.opts.maxTtlSeconds}.`,
      );
    }

    const { caps, narrowed } = effectiveCapabilities(
      requestedCaps,
      this.opts.maxCaps,
      this.opts.tenantAllowedCaps,
    );

    const key = this.activeSigningKey(appId);
    const nowSec = Math.floor(this.opts.clock.now() / 1000);
    const jti = newId('jti');
    const expSec = nowSec + ttlSeconds;

    const token = signCompactJws(
      compact({
        iss: this.opts.issuer,
        aid: appId,
        tid: tenantId,
        sub: req.sub,
        sub_kind: req.subKind,
        name: req.name,
        caps: [...caps].sort() as Capability[],
        scope: req.scope,
        iat: nowSec,
        exp: expSec,
        jti,
        rfr: req.refreshable ?? true,
        rfr_until: req.refreshUntil,
        pol: req.policy as import('@browserglass/protocol').TokenPolicyOverrides | undefined,
      }),
      key,
    );

    return { token, jti, expiresAt: expSec * 1000, caps, narrowed };
  }

  async verify(token: string) {
    return verifyToken(token, this.opts, (kid) => this.resolveKey(kid));
  }

  async revoke(jti: string, opts?: { readonly untilExp?: boolean }): Promise<void> {
    if (this.opts.store === undefined) return;
    const now = this.opts.clock.now();
    // Rows expire after 15 minutes: older than the token max lifetime plus clock skew cannot matter.
    const expiresAt =
      opts?.untilExp === true ? now + this.opts.maxTtlSeconds * 1000 : now + 15 * 60 * 1000;
    await this.opts.store.putRevocation({
      tenantId: this.opts.tenantId as TenantId,
      kind: 'jti',
      value: jti,
      reason: 'manual_revoke',
      effectiveAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  async keys(): Promise<readonly PublicKeyRef[]> {
    return [...this.keysByKid.values()]
      .filter((k) => k.status !== 'revoked')
      .map((k) => ({
        kid: k.kid,
        appId: k.appId ?? this.opts.issuer,
        alg: k.alg,
        publicKey: k.publicKey,
        status: k.status ?? 'active',
      }));
  }

  async rotate(opts?: { readonly retireAfterMs?: number }): Promise<PublicKeyRef> {
    void opts;
    const material = generateEd25519KeyMaterial();
    const kid = newId('key');
    const newKey: AppSigningKey = {
      kid,
      appId: this.opts.issuer,
      alg: 'EdDSA',
      publicKey: material.publicKey,
      privateKey: material.privateKey,
      status: 'active',
    };
    for (const [existingKid, existing] of this.keysByKid) {
      if (
        (existing.appId ?? this.opts.issuer) === this.opts.issuer &&
        existing.status === 'active'
      ) {
        this.keysByKid.set(existingKid, { ...existing, status: 'retiring' });
      }
    }
    this.keysByKid.set(kid, newKey);
    return {
      kid,
      appId: this.opts.issuer,
      alg: 'EdDSA',
      publicKey: material.publicKey,
      status: 'active',
    };
  }
}
