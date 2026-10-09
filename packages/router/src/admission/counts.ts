/**
 * The admission counter: one query,
 * four counters (tenant, app, pool, user), **including the in flight
 * states**, which is what stops a burst of simultaneous acquires from all
 * passing admission and then all launching.
 *
 * The doc's own pseudocode counts `Instance.state IN ('requested',
 * 'placing', 'launching', 'ready', 'degraded', 'recovering', 'draining')`.
 * The `Store` interface this build's `protocol` package defines counts by
 * the coarser, DDL derived `InstanceStatus` (`launching` already collapses
 * `requested`/`placing`/`launching`, and `ready` splits into `warm`/`live`),
 * so the equivalent "live or in flight" status set here is `['launching',
 * 'warm', 'live', 'recovering', 'draining']`, everything except the two
 * terminal statuses `released` and `failed`.
 *
 * Counting goes through `Store.listInstances` rather than an in process
 * counter, deliberately: an in memory counter drifts from reality the
 * moment two processes (or, for a real store adapter, two connections)
 * disagree about what "live" means at this instant.
 */

import type {
  AppId,
  Instance,
  InstanceStatus,
  PoolId,
  Store,
  TenantId,
} from '@browserglass/protocol';

/** The four live/in-flight admission counters. */
export interface LiveCounts {
  tenantLive: number;
  appLive: number;
  poolLive: number;
  userLive: number;
}

/**
 * Every `InstanceStatus` that counts toward admission: live plus every in
 * flight state. Excludes the two terminal statuses, `released` and
 * `failed`.
 */
export const LIVE_INSTANCE_STATUSES: readonly InstanceStatus[] = Object.freeze([
  'launching',
  'warm',
  'live',
  'recovering',
  'draining',
]);

/**
 * Counts live and in flight instances for a tenant, narrowed by app, pool,
 * and subject, from the store. Never from an in process counter.
 */
export async function countLiveInstances(
  store: Store,
  tenantId: TenantId,
  appId: AppId,
  poolId: PoolId | null,
  subject: string | null,
): Promise<LiveCounts> {
  const rows: Instance[] = await store.listInstances(tenantId, { status: LIVE_INSTANCE_STATUSES });
  let tenantLive = 0;
  let appLive = 0;
  let poolLive = 0;
  let userLive = 0;
  for (const row of rows) {
    tenantLive += 1;
    if (row.appId === appId) appLive += 1;
    if (poolId != null && row.poolId === poolId) poolLive += 1;
    if (poolId != null && row.poolId === poolId && subject != null && row.subject === subject)
      userLive += 1;
  }
  return { tenantLive, appLive, poolLive, userLive };
}
