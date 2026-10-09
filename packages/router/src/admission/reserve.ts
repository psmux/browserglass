/**
 * Atomic admission reservation. `admit()` (`./admit.js`) makes the
 * *decision* (reject, evict, queue, or admit) from a store read; this
 * module makes that decision *stick* atomically, so two acquires racing
 * past `admit()`'s read with the same limit of one do not both proceed.
 *
 * Built on `Store.reserveQuota`, described in `protocol` as "atomic check
 * and increment for concurrency window quotas... the whole point is that
 * two concurrent acquires cannot both pass a limit of one." `reserveQuota`'s
 * signature carries no limit parameter, only `{tenantId, scope, metric,
 * amount}`; this module does not assume the store has some separately
 * configured `quotas` row for the scope (nothing in `protocol` requires
 * `setQuota` to have ever been called for it, and `QuotaLimits`/`PoolLimits`,
 * the numbers `admit()` and this module actually enforce, come from the
 * entirely separate `QuotaProvider`/`Pool.limits` path). Instead, the
 * contract this module relies on, and any `Store` implementation must
 * honour, is: `reserveQuota` unconditionally increments an atomic per
 * `(tenantId, scope, metric)` gauge and returns the post increment value
 * (`allowed`/`limit` in the response are the store's own opinion, if it
 * has one, and are ignored here); the caller compares the returned value
 * against its own known limit and calls `releaseQuota` to roll back an
 * increment that turned out to be over limit. This is what makes the
 * mechanism correct without requiring quota configuration to be
 * duplicated into the store ahead of time. Every store package (including
 * `store-sqlite`) must implement `reserveQuota` as an unconditional atomic
 * increment for this to hold.
 */

import type {
  AppId,
  PoolId,
  PoolLimits,
  QuotaLimits,
  Store,
  TenantId,
} from '@browserglass/protocol';
import type { AdmissionScope } from './admit.js';

/** The metric name every admission reservation uses. */
const METRIC = 'instances';

/** One scoped reservation `reserveAdmission` took, kept so it can be rolled back or released later. */
export interface AdmissionScopeReservation {
  scope: string;
  metric: string;
}

/** The live set of reservations one admitted `acquire` call holds, released together at instance release (or immediately, on a later failure). */
export interface AdmissionReservation {
  tenantId: TenantId;
  reservations: readonly AdmissionScopeReservation[];
}

/** `reserveAdmission`'s result: either every scoped limit had room and all reservations were taken, or the first scope without room, with every reservation taken before it already rolled back. */
export type ReserveAdmissionResult =
  | { kind: 'reserved'; reservation: AdmissionReservation }
  | { kind: 'refused'; scope: AdmissionScope; limit: number; current: number };

function scopeKey(
  scope: AdmissionScope,
  tenantId: string,
  appId: string,
  poolId: string | null,
  subject: string | null,
): string {
  switch (scope) {
    case 'tenant':
      return `tenant:${tenantId}`;
    case 'app':
      return `app:${appId}`;
    case 'pool':
      return `pool:${poolId ?? ''}`;
    case 'user':
      return `user:${poolId ?? ''}:${subject ?? ''}`;
  }
}

/**
 * Atomically reserves one admission slot across every finite scoped limit
 * (tenant, app, pool, user), cheapest first, exactly mirroring `admit()`'s
 * scope order. Rolls back on the first refusal so a caller never holds a
 * partial reservation.
 */
export async function reserveAdmission(
  store: Store,
  tenantId: TenantId,
  appId: AppId,
  poolId: PoolId | null,
  subject: string | null,
  limits: QuotaLimits,
  poolLimits: PoolLimits,
): Promise<ReserveAdmissionResult> {
  const checks: readonly { scope: AdmissionScope; limit: number }[] = [
    { scope: 'tenant', limit: limits.maxInstances },
    { scope: 'app', limit: limits.maxInstancesPerApp },
    { scope: 'pool', limit: poolLimits.maxInstances },
    { scope: 'user', limit: poolLimits.maxInstancesPerUser },
  ];
  const taken: AdmissionScopeReservation[] = [];
  for (const check of checks) {
    if (!Number.isFinite(check.limit) || check.limit <= 0) continue;
    const scope = scopeKey(check.scope, tenantId, appId, poolId, subject);
    const result = await store.reserveQuota({ tenantId, scope, metric: METRIC, amount: 1 });
    if (result.value > check.limit) {
      // Lost the race: this increment pushed the gauge over the caller's
      // known limit. Undo it before reporting refused.
      await store.releaseQuota({ tenantId, scope, metric: METRIC, amount: 1 });
      await releaseAdmission(store, { tenantId, reservations: taken });
      return { kind: 'refused', scope: check.scope, limit: check.limit, current: result.value - 1 };
    }
    taken.push({ scope, metric: METRIC });
  }
  return { kind: 'reserved', reservation: { tenantId, reservations: taken } };
}

/** Releases every scope a `reserveAdmission` call reserved. Idempotent to call with an already empty reservation. */
export async function releaseAdmission(
  store: Store,
  reservation: AdmissionReservation,
): Promise<void> {
  for (const r of reservation.reservations) {
    await store.releaseQuota({
      tenantId: reservation.tenantId,
      scope: r.scope,
      metric: r.metric,
      amount: 1,
    });
  }
}
