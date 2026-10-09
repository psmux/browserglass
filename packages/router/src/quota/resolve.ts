/**
 * Cached quota resolution: narrowing
 * only, computed once per admission and cached for `quotaCacheMs` (default
 * 5000ms). The narrowing itself (tenant down through app) is the injected
 * `QuotaProvider`'s job (`protocol`'s own TSDoc: "resolved live rather than
 * baked into config at startup"); this module only adds the cache.
 */

import type { QuotaLimits, QuotaProvider } from '@browserglass/protocol';
import type { Clock } from '../router/clock.js';
import { TtlCache } from './cache.js';

/**
 * The shape `QuotaProvider.limits()` resolves to. Structurally identical
 * to the domain `QuotaLimits` entity (both carry the same nine fields), so
 * it is aliased rather than redeclared: `admit()` and `reserveAdmission()`
 * take a `QuotaLimits`, and a `CachedQuotaResolver` result is assignable to
 * it directly.
 */
export type ResolvedQuotaLimits = QuotaLimits;

/**
 * Wraps a `QuotaProvider` with a `quotaCacheMs` TTL cache keyed on
 * `(tenantId, appId)`. Every `BrowserRouter.acquire` call resolves quotas
 * through this rather than calling the injected `QuotaProvider` directly.
 */
export class CachedQuotaResolver {
  private readonly cache: TtlCache<ResolvedQuotaLimits>;

  constructor(
    private readonly provider: QuotaProvider,
    clock: Clock,
    quotaCacheMs: number,
  ) {
    this.cache = new TtlCache<ResolvedQuotaLimits>(clock, quotaCacheMs);
  }

  /** The effective, narrowed quota limits for `(tenantId, appId)`, cached. */
  async limits(tenantId: string, appId: string | null): Promise<ResolvedQuotaLimits> {
    const key = `${tenantId}\u0000${appId ?? ''}`;
    return this.cache.getOrCompute(key, () => this.provider.limits(tenantId, appId));
  }

  /** Forces the next `limits()` call for `(tenantId, appId)` to re-resolve, bypassing the cache. */
  invalidate(tenantId: string, appId: string | null): void {
    this.cache.invalidate(`${tenantId}\u0000${appId ?? ''}`);
  }
}
