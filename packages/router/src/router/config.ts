/**
 * `RouterConfig`, with every field this single node embedded build
 * actually consults. Fields that only matter to a distributed deployment (leader election, node lease
 * regrant, handoff, relocation reservation) are kept on the type for wire
 * and config file compatibility with a future multi node build, but are
 * never read by anything in this package.
 */

/** The seven placement score terms, `RouterConfig.placementWeights` (a mutable `Record`, not a literal object type, or the config cannot be constructed at all). */
export type PlacementWeightKey =
  | 'affinity'
  | 'pack'
  | 'cpu'
  | 'memory'
  | 'disk'
  | 'warm'
  | 'spread';

/** Full router configuration. See `DEFAULT_ROUTER_CONFIG` for every default value. */
export interface RouterConfig {
  // identity
  /** Hostname plus pid, or an explicit value. Fixed for a single node build. */
  routerId: string;
  /** Unused single node: no leader election. Kept for config file compatibility. */
  lockTtlMs: number;

  // node registry
  /** Internal heartbeat tick interval. */
  heartbeatIntervalMs: number;
  /** A node's heartbeat older than this is stale, and it drops out of placement candidacy. */
  nodeStaleMs: number;
  /** Unused single node: no remote node lease to lose. */
  nodeLeaseTtlMs: number;
  /** Unused single node. */
  nodeRegrantWindowMs: number;
  /** Unused single node: no WS transport. */
  nodePingIntervalMs: number;
  /** Unused single node. */
  nodePingTimeoutMs: number;
  /** Staleness bound for the startup reconcile's inventory scan. */
  inventoryStaleMs: number;

  // placement
  placementWeights: Record<PlacementWeightKey, number>;
  /** The packing term's target utilisation, `P(n)`. */
  targetUtilisation: number;
  /** How many placement candidates `acquire` tries before giving up. */
  maxPlacementAttempts: number;
  /** Window a node stays penalised after a launch failure on it. */
  launchFailurePenaltyWindowMs: number;
  /** A node scoring below this floor is not selected. */
  scoreFloor: number;

  // profiles
  profileLeaseTtlMs: number;
  /** Unused single node: replication factor of 1 (home only) is already the default. */
  replication: { factor: number };
  ephemeralGraceMs: number;
  /** Unused single node: no cross node migration. */
  drainMigrateMaxBytes: number;

  // reuse and warm
  shareMinRemainingMs: number;
  /**
   * How long an acquire naming a persistent profile waits for that
   * profile's holder to finish launching, so it can share the browser
   * rather than be refused. Two scripts started together with the same
   * key otherwise race: one launches, the other is told the profile is
   * busy. Zero turns the wait off.
   */
  profileShareWaitMs: number;
  warmReconcileMs: number;
  warmLaunchBurst: number;
  warmSafetyFactor: number;

  // admission
  quotaCacheMs: number;
  idempotencyWindowMs: number;
  queueMaxAttempts: number;
  evictIdleMinAgeMs: number;

  // lifecycle
  reaperIntervalMs: number;
  reconcileIntervalMs: number;
  idleGraceUnderPressureMs: number;
  killGraceMs: number;
  /** Unused single node: no handoff between nodes. */
  handoffLingerMs: number;
  /** Unused single node. */
  handoffWaitMs: number;
  /** Unused single node: no relocate reservation. */
  reservationTtlMs: number;
  /** Default instance lifetime, `viewer-bound` releases after the last viewer leaves plus `instanceLingerMs`; `explicit` lives until released or `maxDurationMs`. */
  instanceLingerMs: number;
  /** Hard ceiling on any instance's lifetime, default 4 hours. */
  maxDurationMs: number;
  /**
   * Floor between two `store.touchInstance` writes for the same instance,
   * from `BrowserRouter.recordActivity`. Real activity (currently just
   * `attach()`; the wire layer's per-input/subscribe events are a natural
   * later caller, see `recordActivity`'s own comment) never had a
   * production caller until a fix landed, so
   * `lastActivityAt` sat frozen at acquire time and every instance was
   * idle-reaped on a fixed clock no matter how hard it was actually being
   * driven. 30s (rather than every event) keeps a busy instance's SQLite
   * writes bounded regardless of how often the caller signals activity.
   */
  activityTouchThrottleMs: number;
  /**
   * How long a non forced `release()` waits for a non zero live viewer
   * count to fall to zero before it answers `detached`. A script that
   * closes its own socket and then releases at once used to find that
   * socket still counted (the server only drops a viewer once the close
   * handshake finishes), so the browser it meant to end kept running.
   * Polled every 50 ms, so a release nobody else is watching pays only as
   * long as its own socket takes to go away. 0 turns the wait off.
   */
  releaseViewerSettleMs: number;

  // drain
  drainDefaultDeadlineMs: number;
  drainForceGraceMs: number;
  /** Unused single node: no relocation batch. */
  drainConcurrency: number;

  // retention
  idRetentionDays: number;
}

/** Every `RouterConfig` default. */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = Object.freeze({
  routerId: 'local',
  lockTtlMs: 15_000,

  heartbeatIntervalMs: 5_000,
  nodeStaleMs: 12_000,
  nodeLeaseTtlMs: 30_000,
  nodeRegrantWindowMs: 60_000,
  nodePingIntervalMs: 15_000,
  nodePingTimeoutMs: 15_000,
  inventoryStaleMs: 60_000,

  placementWeights: Object.freeze({
    affinity: 0.35,
    pack: 0.2,
    cpu: 0.15,
    memory: 0.15,
    disk: 0.05,
    warm: 0.05,
    spread: 0.05,
  }) as Record<PlacementWeightKey, number>,
  targetUtilisation: 0.65,
  maxPlacementAttempts: 3,
  launchFailurePenaltyWindowMs: 120_000,
  scoreFloor: 0.05,

  profileLeaseTtlMs: 30_000,
  replication: Object.freeze({ factor: 1 }),
  ephemeralGraceMs: 300_000,
  drainMigrateMaxBytes: 1_073_741_824,

  shareMinRemainingMs: 60_000,
  profileShareWaitMs: 30_000,
  warmReconcileMs: 10_000,
  warmLaunchBurst: 2,
  warmSafetyFactor: 1.5,

  quotaCacheMs: 5_000,
  idempotencyWindowMs: 300_000,
  queueMaxAttempts: 3,
  evictIdleMinAgeMs: 60_000,

  reaperIntervalMs: 30_000,
  reconcileIntervalMs: 15_000,
  idleGraceUnderPressureMs: 30_000,
  killGraceMs: 5_000,
  handoffLingerMs: 2_000,
  handoffWaitMs: 10_000,
  reservationTtlMs: 30_000,
  instanceLingerMs: 300_000,
  maxDurationMs: 14_400_000,
  activityTouchThrottleMs: 30_000,

  drainDefaultDeadlineMs: 900_000,
  drainForceGraceMs: 300_000,
  releaseViewerSettleMs: 1_500,
  drainConcurrency: 2,

  idRetentionDays: 30,
}) satisfies RouterConfig;
