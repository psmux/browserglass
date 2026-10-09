/**
 * `admit`, the pure admission decision: scopes checked cheapest first (tenant, app, pool, user), and
 * three policies at the limit (`reject`, `queue` the default, `evictIdle`).
 * `AcquireRequest.onFull` may only narrow `PoolLimits.onFull`, never widen
 * it: `'queue'|'reject'` on the request, `'reject'|'queue'|'evictIdle'`
 * on the pool.
 */

import type { PoolLimits, QuotaLimits } from '@browserglass/protocol';
import type { LiveCounts } from './counts.js';

/** The scope an admission check breached, cheapest first order. */
export type AdmissionScope = 'tenant' | 'app' | 'pool' | 'user';

/** `admit`'s result: proceed, reject outright, evict an idle instance and retry, or enqueue. */
export type AdmissionVerdict =
  | { kind: 'admit' }
  | { kind: 'reject'; scope: AdmissionScope; limit: number; current: number }
  | { kind: 'evict'; scope: AdmissionScope; limit: number; current: number }
  | { kind: 'queue'; scope: AdmissionScope; limit: number; current: number };

/** The three request-narrowable `onFull` policies `admit` accepts. */
export type OnFullPolicy = 'reject' | 'queue' | 'evictIdle';

function resolveOnFull(
  poolOnFull: OnFullPolicy,
  requestOnFull: 'queue' | 'reject' | undefined,
): OnFullPolicy {
  if (requestOnFull === undefined) return poolOnFull;
  // A request may only narrow: 'reject' always narrows (it is stricter
  // than 'queue' or 'evictIdle'); 'queue' narrows 'evictIdle' (queueing
  // never evicts someone else's browser) but cannot widen a pool
  // configured 'reject' into 'queue'.
  if (requestOnFull === 'reject') return 'reject';
  return poolOnFull === 'reject' ? 'reject' : 'queue';
}

/**
 * Checks the four scopes in order and returns the first breach, or
 * `{kind:'admit'}` when every scope has headroom. `limits` is the merged,
 * narrowed `QuotaLimits` (tenant narrowed by app, already resolved by the
 * quota module); `poolLimits` supplies the pool's own ceiling, its per
 * user ceiling, and its `onFull` policy.
 */
export function admit(
  counts: LiveCounts,
  limits: QuotaLimits,
  poolLimits: PoolLimits,
  requestOnFull: 'queue' | 'reject' | undefined,
): AdmissionVerdict {
  const checks: readonly { scope: AdmissionScope; current: number; limit: number }[] = [
    { scope: 'tenant', current: counts.tenantLive, limit: limits.maxInstances },
    { scope: 'app', current: counts.appLive, limit: limits.maxInstancesPerApp },
    { scope: 'pool', current: counts.poolLive, limit: poolLimits.maxInstances },
    { scope: 'user', current: counts.userLive, limit: poolLimits.maxInstancesPerUser },
  ];
  for (const check of checks) {
    if (!Number.isFinite(check.limit) || check.limit <= 0) continue;
    if (check.current < check.limit) continue;
    const onFull = resolveOnFull(poolLimits.onFull, requestOnFull);
    if (onFull === 'reject')
      return { kind: 'reject', scope: check.scope, limit: check.limit, current: check.current };
    if (onFull === 'evictIdle')
      return { kind: 'evict', scope: check.scope, limit: check.limit, current: check.current };
    return { kind: 'queue', scope: check.scope, limit: check.limit, current: check.current };
  }
  return { kind: 'admit' };
}
