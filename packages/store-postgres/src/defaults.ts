/**
 * Zero-value defaults for the entity fields the protocol documents as in
 * memory only, derived, or belonging to a table this DDL does not model
 * (`NodeLoad`, `Session`'s live `Map`s, a `Viewer`'s token bucket and resume
 * snapshot, `Instance.runtime`/`incidents`, a `Tenant`'s nested
 * `TenantDefaults`). The store persists durable columns faithfully;
 * reconstructing true runtime state from a cold row is a gateway process
 * responsibility, not the store's. Identical to `store-sqlite`'s
 * `defaults.ts`, duplicated here because the two adapters do not share an
 * implementation package.
 */
import type { NodeLoad, PoolLimits, QuotaLimits, TenantDefaults } from '@browserglass/protocol';

/** A quiescent `NodeLoad`: correct for a node the caller has not sampled, since the DDL only ever stores the latest heartbeat, not a rolling load history. */
export function zeroNodeLoad(sampledAt: number): NodeLoad {
  return {
    liveInstances: 0,
    warmInstances: 0,
    launchingInstances: 0,
    cpuPercent: 0,
    memoryUsedMb: 0,
    profileDiskUsedMb: 0,
    loadAvg1: 0,
    sampledAt,
  };
}

/** Deployment-wide default `QuotaLimits`, used when a tenant has no matching rows in `quotas`. Generous, since the absence of a row means "no limit configured" in this schema, not "zero". */
export const DEFAULT_QUOTA_LIMITS: QuotaLimits = Object.freeze({
  maxInstances: 1000,
  maxInstancesPerApp: 1000,
  maxInstancesPerUser: 100,
  maxViewers: 10000,
  maxProfiles: 100000,
  maxProfileBytes: 1024 * 1024 * 1024 * 1024,
  maxSessionMinutesPerDay: 24 * 60,
  maxAcquiresPerMinute: 1000,
  maxFrameBytesPerMinute: Number.MAX_SAFE_INTEGER,
});

/** Default `TenantDefaults`, used when a tenant's `policy` JSON blob carries no `defaults` key. */
export const DEFAULT_TENANT_DEFAULTS: TenantDefaults = Object.freeze({
  browserSpec: {},
  profileTtlMs: 30 * 24 * 60 * 60 * 1000,
  sessionIdleMs: 1_800_000,
  sessionMaxDurationMs: 14_400_000,
  controlLeaseMs: 30000,
  controlForceClaim: 'requiresAdmin',
  maxViewersPerStream: 32,
  maxStreamsPerSession: 28,
  maxStreamsPerViewer: 4,
});

/**
 * Default `PoolLimits` for fields the `pools` DDL row does not carry (only
 * `max_instances` and the two duration columns are real columns; the rest
 * the `pools` table never named).
 *
 * `maxInstancesPerUser` (50, was 10) is the number that actually governs
 * `admit()`'s `'user'` scope check (`packages/router/src/admission/admit.ts`'s
 * `checks` array reads `poolLimits.maxInstancesPerUser`, never
 * `QuotaLimits.maxInstancesPerUser`): every pool row gets this value
 * unconditionally, since there is no backing column for it to override.
 * That makes it the REAL per-subject ceiling for any pool, independent of
 * `BGLS_MAX_INSTANCES_PER_SUBJECT`/`ResolvedConfig.limits.maxInstancesPerSubject`,
 * which only ever reaches `QuotaLimits.maxInstancesPerUser`
 * (`server/src/lifecycle/wiring.ts`'s `quotaProviderFromLimits`) and is
 * therefore never consulted by admission at all. Raised in step with that
 * config default (also 50, `server/src/config/resolve.ts`) so the two
 * numbers agree even though only one of them is actually load-bearing;
 * see that file's own comment for why 3 (nee 10 here) was the single most
 * swarm-hostile default in the system.
 */
export const DEFAULT_POOL_LIMITS: Omit<
  PoolLimits,
  'maxInstances' | 'sessionIdleMs' | 'sessionMaxDurationMs'
> = Object.freeze({
  maxInstancesPerUser: 50,
  maxViewersPerStream: 32,
  maxStreamsPerSession: 28,
  onFull: 'queue',
  queueMaxDepth: 200,
  queueMaxWaitMs: 60000,
});
