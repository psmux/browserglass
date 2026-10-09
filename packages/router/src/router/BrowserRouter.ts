/**
 * `BrowserRouter`: the router's public API, all ten methods. Depends on
 * `@browserglass/protocol` only; it must never import `@browserglass/core`, which is what
 * makes a standalone `bgls router` process possible later, and is enforced
 * by `scripts/check-deps.mjs`'s layer gate.
 *
 * The nine step `acquire` flow
 * preserves its three load bearing details exactly: reuse is checked
 * before admission (a shared browser consumes no new quota slot); the
 * instance row is inserted before placement (a later failure updates a
 * `failed` row, never nothing); and the per candidate loop classifies
 * failures three ways (profile phase errors break immediately, capacity
 * errors penalise briefly and continue, everything else penalises for the
 * full window).
 */

import type {
  AffinityHints,
  AppId,
  AuditSink,
  BrowserSpec,
  Instance,
  InstanceId,
  InstanceLifecycleState,
  InstanceRuntimeInfo,
  InstanceStatus,
  MetricsSink,
  Node,
  NodeActionRequest,
  NodeActionResult,
  NodeId,
  NodeSnapshot,
  NodeState,
  NodeStatus,
  NodeTransport,
  OverridePolicy,
  PlacementPolicy,
  Pool,
  PoolId,
  Principal,
  ProfileAction,
  ProfileId,
  QuotaProvider,
  ResolvedProfileSpec,
  Scope,
  Store,
  TargetSummary,
  TenantId,
  TerminateResult,
} from '@browserglass/protocol';
import {
  DEFAULT_BROWSER_SPEC,
  STRICT_OVERRIDE_POLICY,
  newId,
  resolveBrowserSpec,
} from '@browserglass/protocol';
import {
  LIVE_INSTANCE_STATUSES,
  TokenBucketRegistry,
  admit,
  countLiveInstances,
  releaseAdmission,
  reserveAdmission,
} from '../admission/index.js';
import type { NodeRegistry } from '../node/NodeRegistry.js';
import { placementCandidates } from '../placement/candidates.js';
import type { PlacementSignalsPort } from '../placement/policy.js';
import { type PoolRef, WarmPoolReconciler } from '../pool/warm.js';
import {
  type PlaceAttemptOutcome,
  QueueDepthTracker,
  claimAndPlace,
  enqueue as enqueuePlacement,
} from '../queue/index.js';
import { CachedQuotaResolver } from '../quota/resolve.js';
import type { Clock, ClockTimer } from './clock.js';
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from './config.js';
import { routerErr } from './errors.js';
import { IdempotencyTable } from './idempotency.js';
import { MetadataValidationError, validateAcquireMetadata } from './instanceMetadata.js';
import {
  STUCK_LAUNCH_STATES,
  evaluateIdle,
  isMaxDurationExceeded,
  isOrphaned,
  isStuckLaunching,
  isTtlExpired,
} from './lifecycle.js';
import { type RouterLogger, consoleWarnRouterLogger, errorLogFields } from './logger.js';
import { findReusable } from './reuse.js';
import { profileSpecFromResolved, toStoredSpecInput } from './specMapping.js';
import {
  type AcquireHandle,
  type AcquireRequest,
  type AcquireResult,
  type AttachCredential,
  type AttachCredentialIssuer,
  type AttachCredentialRequest,
  type AttachRequest,
  type AttachResult,
  type DrainHandle,
  type DrainOptions,
  type DriveResolution,
  type InstanceListFilter,
  type InstanceView,
  type LaunchAttempt,
  type LiveViewerPort,
  type ProfileLeaseGrant,
  type ProfileServicePort,
  type ReleaseOptions,
  type ReleaseResult,
  type RestartOptions,
  type RestartResult,
  SYSTEM_PRINCIPAL,
  type TopologyView,
  narrowCapabilities,
  systemPrincipalFor,
} from './types.js';

/** The idle grace period, default 600000 (10 minutes). Not narrowable per pool: `PoolLimits` carries `sessionIdleMs` but no matching grace field. */
const IDLE_GRACE_MS_DEFAULT = 600_000;
/** The idle threshold fallback when a pool has no `limits.sessionIdleMs` configured, default 1800000 (30 minutes). */
const DEFAULT_IDLE_MS = 1_800_000;
/** How often `release()` re-reads the live viewer count while it waits for a closing socket to drop out. */
const RELEASE_VIEWER_POLL_MS = 50;

/**
 * `BrowserRouter`'s constructor options, plus the single node addition
 * this build needs:
 * `nodeRegistry`, since protocol's `NodeTransport` is a pure RPC surface
 * (heartbeat/launch/terminate/list) with no state query, so placement
 * candidate gathering needs a separate registry. `nodes` is typically a
 * `LocalNodeTransport` wrapping a `LocalNode`, injected here already
 * assembled; `BrowserRouter` only ever depends on the `NodeTransport`
 * interface, never on `LocalNode`/`LocalNodeTransport` directly, so a
 * future `WebSocketNodeTransport` slots in with no change to this class.
 */
export interface BrowserRouterOptions {
  store: Store;
  nodes: NodeTransport;
  nodeRegistry: NodeRegistry;
  placement: PlacementPolicy;
  placementSignals?: PlacementSignalsPort;
  profiles: ProfileServicePort;
  quotas: QuotaProvider;
  audit: AuditSink;
  metrics: MetricsSink;
  clock: Clock;
  config?: Partial<RouterConfig>;
  overridePolicy?: OverridePolicy;
  /**
   * How many viewers are attached to an instance right now. Optional: left
   * out, this router uses a constant 0, exactly the value `doAcquire`
   * hardcoded before this port existed. See `LiveViewerPort`'s own doc for
   * why the count cannot be kept in this package.
   */
  viewers?: LiveViewerPort;
  /**
   * Where the router reports a reclaim failure it deliberately does not
   * throw on. Optional; left out, {@link consoleWarnRouterLogger} is used,
   * because the alternative for the one call site that needs this is
   * silence, and silence is what let a profile directory leak go unnoticed
   * until the profile root reached gigabytes. See `release()` step 6.
   */
  logger?: RouterLogger;
  /**
   * Mints the real, redeemable credential `attach()`/`acquire()` hand
   * back: see {@link AttachCredentialIssuer}'s own doc for why this package
   * cannot build one itself. Optional so router-only unit tests (this
   * package's own `test/support/createTestRouter.ts`, which never opens a
   * socket and never redeems anything) do not each have to stub a signer;
   * every production caller (`@browserglass/server`'s
   * `lifecycle/wiring.ts`) supplies one. Left unconfigured,
   * `mintAttachCredential` below returns a credential no client can
   * dial or redeem, deliberately shaped to fail loudly (`unwired://`
   * scheme) rather than resemble a working one.
   */
  attachCredentials?: AttachCredentialIssuer;
  /**
   * Whether `nodes` can reach any node other than this router's own. A
   * standalone gateway (no peer link configured) cannot, so an instance
   * row naming another node is one it can never hand out: that node is a
   * previous run of this gateway, or a separate process sharing the store.
   * Default `true`, in which case another node's row is servable while
   * that node reads `ready` with a fresh heartbeat.
   */
  reachesPeerNodes?: boolean;
}

/** Deferred pair for a queued acquire's `ready` promise, resolved once `processQueue` places it. */
interface ReadyDeferred {
  resolve: (result: AcquireResult) => void;
  reject: (err: unknown) => void;
}

/**
 * One `driveCache` entry: the resolution `driveInstance` hands back, plus
 * every instance fact the authorization decision needs.
 *
 * `poolId` is here rather than on `DriveResolution` (which is public, and
 * describes where to drive, not who may) precisely so the pool scope check
 * below can run on a cache hit without re-reading the store. The rule this
 * shape enforces: the cache may spare the I/O, never the decision. Anything
 * an authorization check reads either lives in the cache key or lives in
 * this record, so no cached entry can ever answer a question it was not
 * authorised for.
 */
interface DriveCacheEntry {
  readonly resolution: DriveResolution;
  /** The instance's own pool, `null` for a pool-less instance. Only a `{ kind: 'pool' }` scope reads it. */
  readonly poolId: PoolId | null;
}

/**
 * `driveCache`'s key. The tenant is IN the key, not checked beside it:
 * `driveInstance`'s only tenant check is `store.getInstance(principal.tenantId, ...)`,
 * which a cache hit returns before ever reaching, so a cache keyed by
 * `instanceId` alone handed a foreign tenant a full `DriveResolution` with
 * no tenant check performed at all. Keying by both means a foreign tenant
 * can only ever miss, and a miss falls through to the store read that
 * refuses it. A NUL byte separates the two halves because it cannot occur
 * in a prefixed ULID id, so no pair of ids can collide into one key.
 */
function driveCacheKey(tenantId: string, instanceId: InstanceId): string {
  return `${tenantId}\u0000${instanceId}`;
}

/**
 * The `principal.scope` check, `protocol/src/wire/auth.ts`'s `Scope`
 * contract: four kinds narrowing left to right, `tenant > pool > instance
 * > stream`, "checked at handshake and again whenever a viewer reaches for
 * something new". Nothing in this file read `scope` at
 * all before this function existed, so a token minted for one instance
 * could reach every other instance of its tenant, and the WebSocket path
 * (`server/src/ws/credentials.ts`) was the only surface where the narrowing
 * meant anything. That path enforces it structurally rather than with a
 * predicate: it takes the connection's `instanceId` FROM `scope.instanceId`,
 * so there is no caller-supplied id to disagree with. REST, CLI, MCP, and
 * CDP passthrough all name an instance in the request, so they need this
 * explicit form of the same contract.
 *
 * Called by every verb in this class that acts on ONE named instance:
 * `attach`, `driveInstance`, `release`, `restart`, `describe`, and
 * `doAcquire`'s attach-by-`instanceId` short circuit. `list` narrows its
 * result instead ({@link scopeAllowsInstanceRow}), because a narrowed token
 * asking "what may I see" has a correct non-empty answer rather than a
 * refusal. `topology` takes no instance at all; see its own comment.
 *
 * Refuses with `E_INSTANCE_NOT_FOUND`, never a distinct "out of scope"
 * code, and is called BEFORE the `released`/`failed`/not-`ready` checks on
 * the fresh path for the same reason: a caller who may not drive an
 * instance must not learn from the error code whether it exists, is mid
 * launch, or was released. `E_INSTANCE_NOT_FOUND` is already this file's
 * answer for "a different tenant", so an out-of-scope instance simply joins
 * that set and the error surface gains nothing to distinguish.
 *
 * Callers hold the tenant check separately (`store.getInstance` on the
 * fresh path, {@link driveCacheKey} on the cached one); this function only
 * decides the narrowing WITHIN an already-established tenant.
 *
 * KNOWN LIMIT, stated rather than papered over: a `{ kind: 'stream' }`
 * scope also narrows to a `targets` list, and nothing in this class ever
 * sees a `targetId`, so only the instance half of that scope is enforceable
 * here. Per-target narrowing has to happen where the target id is known,
 * which is the session layer in `@browserglass/server`, not this class.
 */
function assertScopeAllowsInstance(
  scope: Scope | undefined,
  instanceId: InstanceId,
  poolId: PoolId | null,
): void {
  if (!scopeAllowsInstanceRow(scope, instanceId, poolId)) {
    throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${instanceId} not found`);
  }
}

/**
 * The same narrowing as {@link assertScopeAllowsInstance}, as a predicate
 * rather than a refusal, for `list`. Kept as the single source of truth for
 * both so the two can never drift into disagreeing about what a scope
 * covers, which is the failure mode that makes a listing show a row a
 * caller is then refused when it asks for it directly.
 */
function scopeAllowsInstanceRow(
  scope: Scope | undefined,
  instanceId: InstanceId,
  poolId: PoolId | null,
): boolean {
  // `Principal.scope` is a required field, and this parameter is still
  // typed `| undefined`, because the type is not enforced at either place a
  // `Principal` actually enters this system. `server/src/auth/verify.ts`
  // copies `claims.scope` out of a decoded JWT without ever checking the
  // claim is present, and both `server/src/auth/resolver.ts` and
  // `server/src/ws/credentials.ts` decide whether an app supplied
  // `AuthResolver` returned a `Principal` with a duck-type guard that tests
  // `sub` and `tenantId` and nothing else. So an app with its own resolver,
  // or a token minted with no `scope` claim, reaches this class with
  // `principal.scope === undefined` no matter what the type says. A
  // security predicate that throws a `TypeError` on that input is worse
  // than useless: it turns a refusal into a 500, and anything that catches
  // broadly turns it into a silent pass.
  //
  // An absent scope reads as tenant scope, which is not leniency invented
  // here. It is the same default `server/src/auth/resolver.ts`'s
  // `principalFromClaims` already writes down
  // (`claims.scope ?? opts.scope ?? { kind: 'tenant' }`), and it is the
  // honest meaning of the input: a token carrying no narrowing is a token
  // that was never narrowed. Reading it as anything tighter would refuse
  // every such token at every verb in this class.
  if (scope === undefined) return true;
  // The widest scope: every instance of the tenant, which the caller's own
  // tenant check has already established.
  if (scope.kind === 'tenant') return true;
  // A pool-less instance is in no pool, so it is not in this one.
  if (scope.kind === 'pool') return poolId !== null && poolId === scope.poolId;
  if (scope.kind === 'instance' || scope.kind === 'stream') return scope.instanceId === instanceId;
  // A scope kind this build does not know. Unlike an absent scope this is
  // not a documented default but an unrecognised narrowing, and the only
  // safe reading of a narrowing we cannot evaluate is that it does not
  // cover this instance. Unreachable while `Scope` stays a closed union;
  // present because this runs on decoded JSON, not on the type.
  return false;
}

/**
 * How long `terminateGraceThenForce` keeps waiting on a graceful terminate
 * that is still running after the force attempt behind it failed. The
 * graceful ladder's own confirm scan can take several seconds per round on
 * a loaded Windows box, so this has to cover at least one more round.
 */
const GRACEFUL_LATE_WAIT_MS = 20_000;

/** A promise's outcome as a value, so a rejection can be inspected after the fact instead of thrown. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/**
 * The control plane: placement,
 * reuse, admission, leases (fencing, via the injected `ProfileServicePort`),
 * lifecycle, and (reduced, single node) topology change. Never carries
 * frames or input, never holds a CDP connection, never authenticates end
 * users, never decides navigation policy.
 */
export class BrowserRouter {
  private readonly store: Store;
  private readonly nodes: NodeTransport;
  private readonly nodeRegistry: NodeRegistry;
  private readonly placement: PlacementPolicy;
  private readonly profiles: ProfileServicePort;
  private readonly quotas: CachedQuotaResolver;
  private readonly audit: AuditSink;
  private readonly metrics: MetricsSink;
  private readonly clock: Clock;
  readonly config: RouterConfig;
  private readonly overridePolicy: OverridePolicy;
  private readonly viewers: LiveViewerPort;
  private readonly reachesPeerNodes: boolean;
  private readonly logger: RouterLogger;
  private readonly attachCredentials: AttachCredentialIssuer | null;

  private readonly idempotency: IdempotencyTable;
  private readonly rateLimits: TokenBucketRegistry;
  private readonly queueDepth = new QueueDepthTracker();
  private readonly warmPool: WarmPoolReconciler;
  private readonly readyDeferreds = new Map<string, ReadyDeferred>();
  /**
   * `instanceId` -> the live runtime detail (`cdpWsUrl`, `browserGuid`
   * among it) `this.nodes.launch(...)` returned for an instance this
   * router process itself launched. `store-sqlite`'s `rowToInstance`
   * hardcodes `Instance.runtime: null` by design (this state is
   * rebuilt by the gateway process on demand, not read from the store),
   * so `describe()` consults this map to fill it back in for any instance
   * this process is still the launcher of. Cleaned up on release and on
   * every launch failure path, so it never leaks a stale entry for an
   * instance this process no longer holds.
   */
  private readonly liveRuntimeByInstance = new Map<InstanceId, InstanceRuntimeInfo>();

  /** Wall clock time of this router's last `store.touchInstance` write per instance, `recordActivity`'s throttle state. */
  private readonly lastActivityTouch = new Map<InstanceId, number>();

  /**
   * `driveInstance`'s cache: {@link driveCacheKey} (tenant AND instance,
   * never instance alone) -> its already resolved {@link DriveCacheEntry}.
   * Populated on a cache miss, consulted first on every call, and deleted
   * at the two places in this class that move an already resolved instance
   * out of the `ready`/`degraded` states that make it drivable (`release()`
   * and `restart()`). See `driveInstance`'s own comment for why those two
   * call sites are sufficient, and {@link driveCacheKey} for why the tenant
   * belongs in the key rather than in a check beside it.
   */
  private readonly driveCache = new Map<string, DriveCacheEntry>();

  private reaperTimer: ClockTimer | null = null;
  private heartbeatTimer: ClockTimer | null = null;
  private started = false;

  /**
   * `Store.heartbeatNode`'s own monotonic sequence, per `NodeHeartbeat.seq`
   * (`store-types.ts`): a single counter for this process's lifetime, one
   * durable `node_heartbeats` row upserted in place
   * (`store-sqlite`'s `heartbeatNode`, `ON CONFLICT (node_id) DO UPDATE`),
   * never reset. `seq` itself is not currently consulted by anything that
   * reads a `Node` back (`placementCandidates` orders candidates by score,
   * not by heartbeat sequence), but the column exists and the interface
   * requires a value, so this stays a real, incrementing counter rather
   * than a constant that would make every heartbeat after the first
   * indistinguishable from a duplicate to a future reader that does care.
   */
  private heartbeatSeq = 0;

  constructor(opts: BrowserRouterOptions) {
    this.store = opts.store;
    this.nodes = opts.nodes;
    this.nodeRegistry = opts.nodeRegistry;
    this.placement = opts.placement;
    this.profiles = opts.profiles;
    this.quotas = new CachedQuotaResolver(
      opts.quotas,
      opts.clock,
      opts.config?.quotaCacheMs ?? DEFAULT_ROUTER_CONFIG.quotaCacheMs,
    );
    this.audit = opts.audit;
    this.metrics = opts.metrics;
    this.clock = opts.clock;
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...opts.config };
    this.overridePolicy = opts.overridePolicy ?? STRICT_OVERRIDE_POLICY;
    this.viewers = opts.viewers ?? { countFor: () => 0 };
    this.reachesPeerNodes = opts.reachesPeerNodes ?? true;
    this.logger = opts.logger ?? consoleWarnRouterLogger;
    this.attachCredentials = opts.attachCredentials ?? null;
    this.idempotency = new IdempotencyTable(opts.clock);
    this.rateLimits = new TokenBucketRegistry(opts.clock);
    this.warmPool = new WarmPoolReconciler(
      opts.clock,
      this.config.warmReconcileMs,
      this.config.warmLaunchBurst,
      this.config.warmSafetyFactor,
      (ref) => this.currentWarmCount(ref),
      (ref) => this.launchWarmInstance(ref),
    );
  }

  // ── lifecycle: start/stop ────────────────────────────────────────────

  /** Marks the local node ready and starts the heartbeat, reaper, and warm pool reconcile timers. */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.nodeRegistry.markReady();
    this.heartbeatTimer = this.clock.setInterval(() => {
      void this.tickHeartbeat();
    }, this.config.heartbeatIntervalMs);
    this.reaperTimer = this.clock.setInterval(() => {
      void this.reaperSweep();
      // Piggybacked on the reaper tick rather than a separate timer:
      // nothing ever called `processQueue` on any schedule before this,
      // so once a pool hit its ceiling
      // (`onFull: 'queue'`), `acquire()` returned `state: 'queued'` and the
      // caller's `ready` promise (`readyPromiseFor`, `acquire()`'s own
      // comment) simply hung forever; nothing ever resolved or rejected
      // it. Stopped the same way `reaperSweep` is: clearing `reaperTimer`
      // in `stop()` below.
      void this.processQueue();
    }, this.config.reaperIntervalMs);
    this.warmPool.start(() => this.activePoolRefs());
    return Promise.resolve();
  }

  /** Stops every timer and, best effort within `opts.drainMs`, drains the local node. */
  async stop(opts: { drainMs: number }): Promise<void> {
    if (this.heartbeatTimer) this.clock.clearInterval(this.heartbeatTimer);
    if (this.reaperTimer) this.clock.clearInterval(this.reaperTimer);
    this.warmPool.stop();
    this.heartbeatTimer = null;
    this.reaperTimer = null;
    this.started = false;
    try {
      await this.drainNode(
        this.nodeRegistry.id(),
        { mode: 'graceful', deadlineMs: opts.drainMs },
        SYSTEM_PRINCIPAL,
      );
    } catch {
      // best effort: stop() must not throw on a slow or failing drain
    }
  }

  /**
   * Not `private`: matches `reaperSweep()`/`processQueue()`'s own
   * convention, both likewise driven by an internal `clock.setInterval`
   * AND called directly (`router.reaperSweep()`) by this package's own
   * tests, since a `FakeClock.advance()` fires the timer callback
   * synchronously but the callback's own `await`s inside still resolve as
   * real microtasks, so a test asserting on THIS tick's effects has to
   * call it directly and await it rather than advance-and-hope.
   */
  async tickHeartbeat(): Promise<void> {
    const payload = {
      nodeId: this.nodeRegistry.id(),
      epoch: 0,
      load: this.nodeRegistry.currentLoad(),
      hostsProfiles: [] as readonly string[],
      at: this.clock.now(),
    };
    const ack = await this.nodes.heartbeat(this.nodeRegistry.id(), payload);
    this.nodeRegistry.heartbeat({}, payload.hostsProfiles);
    if (ack.drain && this.nodeRegistry.drainState() === null) {
      this.nodeRegistry.markDraining(ack.drain.deadlineAt, ack.drain.mode);
    }
    // Durable half of this tick, on the same interval as the in-memory
    // half above. `this.nodes.heartbeat(...)` only ever reaches THIS
    // process's own `NodeRegistry` (`LocalNodeTransport.heartbeat`
    // ignores its own `nodeId` argument and always answers from the local
    // `registry.drainState()`, `WebSocketNodeTransport.heartbeat` only
    // forwards for a FOREIGN `nodeId`), so nothing above this line ever
    // writes anywhere another gateway process could read it back from.
    // `persistNodeState` is that write: it is what makes `liveNodeSnapshots`
    // (`doAcquire`'s placement step, below) able to see THIS node from a
    // DIFFERENT router process sharing the same store. See
    // `docs/scaling.md`'s placement section for why this was the actual
    // ceiling: `store.heartbeatNode`/`store.setNodeStatus` existed with a
    // full DDL (`nodes`, `node_heartbeats`) since before this change, doc
    // 15's own schema, but had zero production callers, so every node's
    // row sat at `status = 'joining'` forever and `placementCandidates`
    // correctly refused to ever treat one as a candidate.
    try {
      await this.persistNodeState();
    } catch (err) {
      // Best effort, deliberately not fatal to the tick: a store hiccup
      // here must not stop the drain-ack handling above, which is this
      // node's own operator initiated shutdown signal and matters more
      // than one missed durable heartbeat. The cost of a miss is bounded
      // and self healing: `placementCandidates`' staleness check
      // (`req.now - n.lastHeartbeatAt >= req.nodeStaleMs`) simply drops
      // this node from OTHER processes' candidate pools until the next
      // tick succeeds, which is the same fate a genuinely dead node gets,
      // rather than a worse one (a store write failure does not, and must
      // not, make this node look more alive than it is).
      this.logger.warn(
        { nodeId: this.nodeRegistry.id(), ...errorLogFields(err) },
        'tickHeartbeat: failed to persist durable node state; this node may be invisible to cross node placement until the next successful tick',
      );
    }
  }

  /**
   * Writes this node's current, authoritative, in-memory state
   * (`NodeRegistry.snapshot()`, never the store's own possibly stale copy)
   * into the two durable rows `docs/scaling.md`'s placement section
   * describes: its `nodes.status` (`store.setNodeStatus`) and its one
   * `node_heartbeats` row (`store.heartbeatNode`, upserted in place by
   * `node_id`). Called on every heartbeat tick, not once at `start()`, so
   * a transient store failure heals itself on the next tick rather than
   * leaving this node permanently invisible until a restart, and so a
   * drain that begins mid-run (`drainNode`, below) is reflected here
   * within one tick even without that method's own best-effort write.
   *
   * `memFreeMib`/`diskFreeMib` are stored FREE, the inverse of
   * `NodeLoad.memoryUsedMb`/`profileDiskUsedMb` (USED): see
   * `store-sqlite`'s `rowToNode` for the read side of this conversion and
   * why getting it backwards silently defeats `placementCandidates`'s
   * memory/disk headroom check for every node whose snapshot is read back
   * through the store.
   *
   * `warmInstances`/`launchingInstances`/`loadAvg1` have no DDL column
   * (`node_heartbeats`' own schema is unchanged) and
   * ride in `detail`, the JSON field `NodeHeartbeat.detail?: Json`
   * (`store-types.ts`) already exists for exactly this: data a caller
   * wants to persist without a schema change. `launchingInstances`
   * matters most of the three: `placementCandidates`'s
   * `n.load.launchingInstances >= n.capacity.maxConcurrentLaunches` check
   * is a real capacity gate (a Chrome launch is CPU spiky), and every node whose `launchingInstances` cannot be read back
   * would otherwise look permanently idle on that one axis to every OTHER
   * node's placement decision, which is exactly the kind of unbounded
   * concurrent launch this check exists to prevent. `store-sqlite`'s
   * `rowToNode` is the read side that parses `detail` back out; the two
   * sides agree on this shape informally, there being no shared type
   * across the package boundary for a field that is not DDL (see that
   * function's own `StoredHeartbeatDetail` comment).
   */
  private async persistNodeState(): Promise<void> {
    const snap = this.nodeRegistry.snapshot();
    await this.store.setNodeStatus(snap.nodeId, storeStatusFor(snap.state));
    await this.store.heartbeatNode({
      nodeId: snap.nodeId,
      beatAt: new Date(this.clock.now()).toISOString(),
      seq: ++this.heartbeatSeq,
      liveInstances: snap.load.liveInstances,
      memFreeMib: Math.max(0, snap.capacity.maxMemoryMb - snap.load.memoryUsedMb),
      cpuLoadPct: snap.load.cpuPercent,
      diskFreeMib: Math.max(0, snap.capacity.profileDiskMb - snap.load.profileDiskUsedMb),
      detail: {
        warmInstances: snap.load.warmInstances,
        launchingInstances: snap.load.launchingInstances,
        loadAvg1: snap.load.loadAvg1,
      },
    });
  }

  /**
   * Whether this router can hand out `instance`: it lives on this router's
   * own node, or on a peer this router can reach that is still alive
   * (`ready`, heartbeat fresher than `nodeStaleMs`). See
   * `FindReusableRequest.ownerServable` for the failure this prevents.
   */
  private async ownerServable(instance: Instance): Promise<boolean> {
    if (instance.nodeId === null || instance.nodeId === this.nodeRegistry.id()) return true;
    if (!this.reachesPeerNodes) return false;
    const node = await this.store.getNode(instance.nodeId).catch(() => null);
    if (node === null || node.state !== 'ready') return false;
    return this.clock.now() - node.lastHeartbeatAt < this.config.nodeStaleMs;
  }

  /**
   * The node a release sends its terminate to. Normally the row's own
   * node. A standalone gateway reaches no other node, so for a row naming
   * another one (left by a previous run of this gateway) it asks its own
   * node instead: `LocalNode.terminate` then answers from the runtime
   * inventory, reporting a browser that died with that run as already
   * gone and refusing one that is still running unadopted. Addressed to
   * the dead node id, the call was refused outright and every release of
   * such a row failed with E_TERMINATE_FAILED until the startup sweep
   * retired it.
   */
  private terminateTargetFor(instance: Instance): NodeId {
    const own = this.nodeRegistry.id();
    if (!this.reachesPeerNodes) return own;
    return instance.nodeId ?? own;
  }

  /**
   * Marks the row of an abandoned profile holder `failed` once a fresh
   * launch has taken over its profile lease. Only reached on a standalone
   * gateway (`reachesPeerNodes: false`) for a row naming another node,
   * which by then has also lost its lease to the new instance, so nothing
   * could serve it anyway. Best effort: the startup orphan sweep retires
   * it later if this write fails.
   */
  private async retireAbandonedHolder(holder: Instance): Promise<void> {
    const moved = await this.store
      .transitionInstance(holder.tenantId, holder.id, [...LIVE_INSTANCE_STATUSES], 'failed', {
        stateReason: 'owner_gone',
      })
      .catch(() => false);
    if (moved) {
      this.logger.warn(
        { instanceId: holder.id, nodeId: holder.nodeId },
        'acquire: retired an instance row owned by a node this gateway cannot reach; its profile went to a fresh launch',
      );
    }
  }

  /**
   * Every OTHER node's `NodeSnapshot`, read back from the shared store,
   * for `doAcquire`'s placement step to merge with this process's own
   * live snapshot. See {@link persistNodeState} for the write side this
   * read depends on: a peer that has never called it (an older build, or
   * one that has not ticked yet) simply has no `node_heartbeats` row and
   * fails `placementCandidates`'s staleness check the same way a dead one
   * would, `n.lastHeartbeatAt` falling back to `row.created_at`
   * (`store-sqlite`'s `rowToNode`) rather than throwing.
   *
   * THIS node is deliberately excluded from the store read and supplied
   * by the caller from `this.nodeRegistry.snapshot()` instead (see
   * `doAcquire`'s own comment at the call site): the in-memory registry is
   * always at least as fresh as anything a round trip through this
   * process's own store write could read back, and reading it back would
   * additionally re-introduce the exact startup race `persistNodeState`'s
   * own doc names (`nodes.status` resets to `'joining'` on every
   * `registerNode`, `store-sqlite`'s own comment on that method, and stays
   * there until the first successful heartbeat tick writes `'ready'`) into
   * this node's OWN placement candidacy, which is precisely the
   * regression "a single node deployment must behave exactly as it does
   * today at every point" rules out.
   *
   * Best effort: a store read failure here must not turn "the local node
   * has capacity" into "acquire fails", so a `listNodes` error is
   * swallowed to `[]` (`everyTenant`'s own established pattern, above),
   * the same outcome as a healthy store that simply has no other node
   * registered, which is exactly what every existing single node
   * deployment and test in this package's own suite looks like.
   */
  private async remoteNodeSnapshots(): Promise<readonly NodeSnapshot[]> {
    const selfId = this.nodeRegistry.id();
    const nodes = await this.store.listNodes({ status: ['ready'] }).catch(() => [] as Node[]);
    return nodes.filter((n) => n.id !== selfId).map(nodeToSnapshot);
  }

  private async everyTenant(): Promise<readonly TenantId[]> {
    const tenants = await this.store.listTenants().catch(() => []);
    return tenants.map((t) => t.id);
  }

  private async activePoolRefs(): Promise<readonly { ref: PoolRef; warm: Pool['warm'] }[]> {
    const out: { ref: PoolRef; warm: Pool['warm'] }[] = [];
    for (const tenantId of await this.everyTenant()) {
      const pools = await this.store.listPools(tenantId).catch(() => []);
      for (const pool of pools.filter((p) => p.state === 'active')) {
        out.push({ ref: { tenantId, poolId: pool.id }, warm: pool.warm });
      }
    }
    return out;
  }

  // ── acquire ───────────────────────────────────────────────────────────

  /**
   * The nine step acquire flow. `acquire()` resolves once placement and
   * profile leasing have succeeded; the returned handle's `ready` promise resolves
   * once the instance is ready. For a direct (non queued) result this is
   * already true by the time `acquire` itself resolves, so `ready`
   * resolves immediately with the same result; for `state: 'queued'` it
   * resolves once `processQueue` places the request.
   */
  async acquire(req: AcquireRequest, principal: Principal): Promise<AcquireHandle> {
    const result = await this.idempotency.withIdempotency(
      principal.tenantId,
      principal.appId,
      req,
      this.config.idempotencyWindowMs,
      () => this.doAcquire(req, principal),
    );
    return { result, ready: this.readyPromiseFor(result) };
  }

  private readyPromiseFor(result: AcquireResult): Promise<AcquireResult> {
    if (result.state !== 'queued') return Promise.resolve(result);
    // The correlation key for `readyDeferreds` was always the
    // placement_queue row id, not an instance id (`processQueue`'s own
    // `settleReady(entry.id, ...)` calls, below, key on the same id). This
    // used to read `result.instanceId` because `enqueueAcquire` wrote that
    // same row id into `instanceId` as a disguise; now that a queued
    // result carries it honestly in `placementId`, this reads that field
    // instead. The value at the wire is unchanged, only which typed field
    // holds it.
    const placementId = result.placementId;
    if (!placementId)
      return Promise.reject(new Error('a queued AcquireResult is missing its placementId'));
    return new Promise<AcquireResult>((resolve, reject) => {
      this.readyDeferreds.set(placementId, { resolve, reject });
    });
  }

  private settleReady(instanceId: string, result: AcquireResult | null, err?: unknown): void {
    const deferred = this.readyDeferreds.get(instanceId);
    if (!deferred) return;
    this.readyDeferreds.delete(instanceId);
    if (err !== undefined) deferred.reject(err);
    else if (result) deferred.resolve(result);
  }

  private async doAcquire(req: AcquireRequest, principal: Principal): Promise<AcquireResult> {
    const t0 = this.clock.now();
    const timings = { admissionMs: 0, placementMs: 0, profileMs: 0, launchMs: 0, totalMs: 0 };

    // 1. authorise
    if (!principal.caps.includes('instance.create'))
      throw routerErr('E_FORBIDDEN', 'principal lacks instance.create');
    const tenant = await this.store.getTenant(principal.tenantId);
    if (!tenant) throw routerErr('E_TENANT_SUSPENDED', 'unknown tenant');
    if (tenant.state === 'suspended')
      throw routerErr('E_TENANT_SUSPENDED', `tenant ${principal.tenantId} is suspended`);

    // attach-by-instanceId short circuit: never launches.
    //
    // SCOPE CHECKED, because this branch is `attach()` in a second door:
    // it names an existing instance and hands back its full
    // `AcquireResult`, so leaving it ungated would have made the check on
    // `attach()` itself pointless. Only this branch is gated, not
    // `acquire` as a whole: the launch path below produces a NEW instance
    // rather than reaching an existing one, so a narrowed token there is a
    // resource question that `instance.create` already gates, not an
    // instance boundary being crossed.
    if (req.instanceId) {
      const existing = await this.store.getInstance(principal.tenantId, req.instanceId);
      if (!existing)
        throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${req.instanceId} not found`);
      assertScopeAllowsInstance(principal.scope, req.instanceId, existing.poolId);
      if (existing.state === 'released' || existing.state === 'failed')
        throw routerErr('E_INSTANCE_GONE', `instance ${req.instanceId} is ${existing.state}`);
      if (existing.state !== 'ready' && existing.state !== 'degraded')
        throw routerErr('E_INSTANCE_NOT_READY', `instance ${req.instanceId} is ${existing.state}`, {
          retryAfterMs: 1000,
        });
      timings.totalMs = this.clock.now() - t0;
      return this.buildResult(existing, principal, {
        reused: true,
        reuseReason: null,
        rejectedOverrides: [],
        timings,
      });
    }

    // 2. resolve selection
    const pool = await this.resolvePool(principal.tenantId, req.pool, principal.appId);
    if (pool.state === 'paused')
      throw routerErr('E_POOL_PAUSED', `pool ${pool.name} is paused`, { retryAfterMs: 30_000 });
    // `AcquireRequest`'s own doc comment says "at most one of instanceId,
    // profile.key, sticky", and `profile.key` is the operative half: this
    // check used to count ANY `profile`, which made `{mode:'ephemeral'}`
    // a selector even though an ephemeral profile names nothing and
    // selects nothing (its key is synthesised per instance,
    // `ResolvedProfileSpec.key`'s own doc: `eph:<instanceId>`). So
    // "a throwaway browser, but the same one this user had a minute ago",
    // the single most obvious way to ask for stickiness, was rejected
    // outright.
    //
    // What genuinely conflicts with `sticky` is a request that already
    // names WHICH existing browser it wants: a persistent profile pinned
    // to a caller supplied key. That is the same discriminant
    // `findReusable` itself uses for the profile sharing branch below
    // (`profileSpec.mode === 'persistent' ? profileSpec.key : null`), so
    // the two now agree: a request whose profile can select an existing
    // instance may not also select one by subject. `instanceId` never
    // reaches here at all, having returned from the attach short circuit
    // above.
    const profileSelectsAnInstance = req.profile?.mode === 'persistent';
    if (profileSelectsAnInstance && req.sticky) {
      throw routerErr(
        'E_CONFLICTING_SELECTORS',
        'a persistent profile key and sticky both select an existing instance; set at most one of instanceId, profile.key, and sticky',
      );
    }

    // `req.metadata` is caller supplied and lands on a real store row (see
    // `instanceMetadata.ts`'s top comment for why that makes it a
    // denial-of-service surface if left uncapped); validated here, before
    // admission or spec resolution spend any work on a request that is
    // going to be rejected anyway.
    let metadata: Instance['metadata'];
    try {
      metadata = validateAcquireMetadata(req.metadata);
    } catch (e) {
      if (e instanceof MetadataValidationError) throw routerErr('E_SPEC_INVALID', e.message);
      throw e;
    }

    // 3. resolve specs
    const { spec, rejected } = resolveBrowserSpec(
      {
        defaults: DEFAULT_BROWSER_SPEC,
        tenant: tenant.defaults.browserSpec,
        pool: pool.template,
        ...(req.browser ? { request: req.browser } : {}),
      },
      this.overridePolicy,
    );
    const rejectedOverrides = rejected.map((r) => ({
      field: String(r.field),
      reason: r.reason,
      policy: 'default',
    }));
    const specRow = await this.store.upsertBrowserSpec(principal.tenantId, toStoredSpecInput(spec));
    const { resolved: profileSpec } = await this.profiles.resolve({
      tenantId: principal.tenantId,
      appId: principal.appId,
      spec: req.profile ?? pool.profileTemplate,
      dryRun: false,
    });

    // 4. reuse check, BEFORE admission (reuse consumes no new quota slot)
    const reuse = await findReusable({
      tenantId: principal.tenantId,
      appId: principal.appId,
      principal,
      resolvedSpec: spec,
      specId: specRow.id,
      poolId: pool.id,
      profileKey: profileSpec.mode === 'persistent' ? profileSpec.key : null,
      sticky: req.sticky ?? null,
      // Was a hardcoded `() => 0`, which made `canShare`'s viewer limit
      // check dead code: no candidate could ever be refused for
      // `viewer_limit`, however many people were already on it. See
      // `LiveViewerPort`'s own doc for why the count has to be injected
      // rather than kept here.
      liveViewerCountOf: (instanceId) => this.viewers.countFor(instanceId),
      shareCtx: {
        shareMinRemainingMs: this.config.shareMinRemainingMs,
        maxViewersPerStream: pool.limits.maxViewersPerStream,
        maxStreamsPerSession: pool.limits.maxStreamsPerSession,
        profiles: this.profiles,
      },
      clock: this.clock,
      store: this.store,
      ownerServable: (instance) => this.ownerServable(instance),
    });
    if (reuse.kind === 'found') {
      this.audit.emit({
        k: 'instance.acquired',
        tid: principal.tenantId,
        aid: principal.appId,
        iid: reuse.instance.id,
        nid: reuse.instance.nodeId ?? '',
        profileKey: profileSpec.key,
        reused: true,
        at: this.clock.now(),
      });
      timings.totalMs = this.clock.now() - t0;
      return this.buildResult(reuse.instance, principal, {
        reused: true,
        reuseReason: reuse.why,
        rejectedOverrides,
        timings,
      });
    }
    if (reuse.kind === 'busy')
      throw routerErr('E_PROFILE_BUSY', 'profile already leased', {
        details: { holderAppId: reuse.holderAppId },
      });

    // 5. admission
    const admissionStart = this.clock.now();
    const limits = await this.quotas.limits(principal.tenantId, principal.appId);
    const bucket = this.rateLimits.bucketFor(
      principal.tenantId,
      Math.max(1, limits.maxAcquiresPerMinute),
      Math.max(1, limits.maxAcquiresPerMinute),
    );
    if (!bucket.tryTake())
      throw routerErr('E_QUOTA_RATE', 'acquire rate limit exceeded', {
        retryAfterMs: bucket.retryAfterMs(),
      });

    // Non-atomic pre-check: a cheap, count based signal used only to
    // choose the `onFull` policy (reject/evict/queue) and to short circuit
    // an obviously over-limit request without attempting placement. The
    // real enforcement, immune to the race between this read and the
    // instance row insert, is `placeAndLaunch`'s own `reserveAdmission`
    // call around `store.createInstance` (below).
    const counts = await countLiveInstances(
      this.store,
      principal.tenantId,
      principal.appId,
      pool.id,
      req.subject ?? principal.sub,
    );
    const verdict = admit(counts, limits, pool.limits, req.onFull);
    if (verdict.kind === 'reject') {
      throw routerErr('E_QUOTA_INSTANCES', `quota exceeded at scope ${verdict.scope}`, {
        details: { scope: verdict.scope, limit: verdict.limit, current: verdict.current },
      });
    }
    timings.admissionMs = this.clock.now() - admissionStart;

    const launchArgs = {
      instanceId: newId('inst'),
      tenantId: principal.tenantId,
      appId: principal.appId,
      pool,
      principal,
      spec,
      specId: specRow.id,
      profileSpec,
      subject: req.subject ?? principal.sub,
      affinity: req.affinity ?? {},
      ttlMs: req.ttlMs,
      metadata,
      lifetime: req.lifetime ?? 'viewer-bound',
      rejectedOverrides,
      timings,
      t0,
      // A row left behind by a gateway that is gone still holds this
      // profile's lease. Reclaim it now instead of answering
      // E_PROFILE_BUSY until it expires; see `reclaimAbandonedHolder`.
      ...(reuse.abandonedHolder !== undefined && !this.reachesPeerNodes
        ? { reclaimFromHolder: reuse.abandonedHolder }
        : {}),
    };
    try {
      const result = await this.placeAndLaunch(launchArgs);
      this.warmPool.recordAcquireArrival({ tenantId: principal.tenantId, poolId: pool.id });
      if (launchArgs.reclaimFromHolder !== undefined) {
        await this.retireAbandonedHolder(launchArgs.reclaimFromHolder);
      }
      return result;
    } catch (e) {
      if (!isAdmissionRefusedError(e)) throw e;
      // The atomic reservation lost the race `admit()`'s advisory read
      // missed. Apply the pool's onFull policy against that hard result.
      if (verdict.kind === 'evict') {
        const victim = await this.findEvictable(principal.tenantId, pool.id);
        if (victim) {
          // Best effort, matching every other internal `release()` call in
          // this file: `release()` now throws `E_TERMINATE_FAILED` when
          // both terminate attempts fail (see `release()`'s own comment),
          // which previously could never happen here since the old code
          // always resolved. Swallow it so eviction still proceeds to the
          // relaunch attempt below exactly as it did before that change.
          await this.release(
            victim.id,
            { reason: 'evicted_for_capacity', gracefulMs: 1000, force: true },
            systemPrincipalFor(principal.tenantId, principal.appId),
          ).catch(() => undefined);
          try {
            const result = await this.placeAndLaunch({ ...launchArgs, instanceId: newId('inst') });
            this.warmPool.recordAcquireArrival({ tenantId: principal.tenantId, poolId: pool.id });
            return result;
          } catch (e2) {
            if (isAdmissionRefusedError(e2) && (req.onFull ?? pool.limits.onFull) === 'queue') {
              return this.enqueueAcquire(
                req,
                principal,
                pool,
                spec,
                specRow.id,
                profileSpec,
                rejectedOverrides,
                timings,
              );
            }
            throw e2;
          }
        }
      }
      if ((req.onFull ?? pool.limits.onFull) === 'queue') {
        return this.enqueueAcquire(
          req,
          principal,
          pool,
          spec,
          specRow.id,
          profileSpec,
          rejectedOverrides,
          timings,
        );
      }
      throw e;
    }
  }

  private async enqueueAcquire(
    req: AcquireRequest,
    principal: Principal,
    pool: Pool,
    spec: BrowserSpec,
    specId: string,
    profileSpec: ResolvedProfileSpec,
    rejectedOverrides: readonly { field: string; reason: string; policy: string }[],
    timings: AcquireResult['timings'],
  ): Promise<AcquireResult> {
    const deadlineMs = Math.min(
      req.maxWaitMs ?? pool.limits.queueMaxWaitMs,
      pool.limits.queueMaxWaitMs,
    );
    const row = await enqueuePlacement(
      this.store,
      this.queueDepth,
      {
        tenantId: principal.tenantId,
        appId: principal.appId,
        poolId: pool.id,
        specId,
        profileKey: profileSpec.mode === 'persistent' ? profileSpec.key : null,
        requestedBy: req.subject ?? principal.sub,
        deadlineAt: new Date(this.clock.now() + deadlineMs).toISOString(),
      },
      pool.limits.queueMaxDepth,
    );
    return {
      // `row.id` is a `placement_queue` row id (`plc_...`, minted by
      // `Store.enqueuePlacement`), not an `InstanceId`: no instance exists
      // yet. This used to be cast straight into `instanceId` (`as
      // InstanceId`), which is exactly the defect this fixes: a caller
      // had no field-level way to tell a queue ticket from a real
      // acquire, since both used the same field name and both looked like
      // a `200`/`201` success. `state: 'queued'` alone did not save a
      // caller who never inspected it, and `examples/nextjs-demo`'s
      // `/api/browser` route was exactly such a caller.
      instanceId: null,
      placementId: row.id,
      sessionId: '',
      state: 'queued',
      node: { nodeId: this.nodeRegistry.id(), region: this.nodeRegistry.region, labels: {} },
      profile: {
        profileId: null,
        key: profileSpec.key,
        mode: profileSpec.mode,
        created: false,
        sizeBytes: null,
      },
      reused: false,
      reuseReason: null,
      queue: {
        position: 0,
        ahead: 0,
        estimatedWaitMs: null,
        pollAfterMs: 1000,
        expiresAt: this.clock.now() + deadlineMs,
      },
      rejectedOverrides,
      effectiveSpec: spec,
      timings,
      expiresAt: this.clock.now() + deadlineMs,
      fence: 0,
    };
  }

  /**
   * Steps 6 through 8 of the nine step flow: creates the instance row
   * (point of no return, a later failure updates a `failed` row, never
   * nothing), computes placement candidates, then tries each candidate in
   * score order, classifying failures three ways.
   */
  private async placeAndLaunch(args: {
    instanceId: InstanceId;
    tenantId: TenantId;
    appId: AppId;
    pool: Pool;
    principal: Principal;
    spec: BrowserSpec;
    specId: string;
    profileSpec: ResolvedProfileSpec;
    subject: string | null;
    affinity: AffinityHints;
    ttlMs: number | undefined;
    metadata: Instance['metadata'];
    lifetime: Instance['lifetime'];
    rejectedOverrides: readonly { field: string; reason: string; policy: string }[];
    timings: AcquireResult['timings'];
    t0: number;
    /** See `doAcquire`: an abandoned holder whose profile lease this launch may take over. */
    reclaimFromHolder?: Instance;
  }): Promise<AcquireResult> {
    const sessionId = newId('sess');
    const nodeId = this.nodeRegistry.id();
    const maxDurationMs = this.config.maxDurationMs;
    const ttl = Math.min(args.ttlMs ?? maxDurationMs, maxDurationMs);

    // 6. create instance row, the point of no return. Wrapped in a narrowly
    // scoped, atomic admission reservation (`Store.reserveQuota`): held
    // only for the race window between "count looks fine" and "the row
    // now exists", then released immediately, since the row's own
    // existence is what every subsequent admission count sees. This is
    // the mechanism that makes "two concurrent acquires against a limit
    // of one admit exactly one" hold under real concurrency rather than
    // relying solely on the racy `admit()` read in `doAcquire`.
    const admissionLimits = await this.quotas.limits(args.tenantId, args.appId);
    const reservation = await reserveAdmission(
      this.store,
      args.tenantId,
      args.appId,
      args.pool.id,
      args.subject,
      admissionLimits,
      args.pool.limits,
    );
    if (reservation.kind === 'refused') {
      throw routerErr('E_QUOTA_INSTANCES', `quota exceeded at scope ${reservation.scope}`, {
        details: {
          scope: reservation.scope,
          limit: reservation.limit,
          current: reservation.current,
        },
      });
    }
    try {
      await this.store.createInstance({
        id: args.instanceId,
        tenantId: args.tenantId,
        appId: args.appId,
        poolId: args.pool.id,
        specId: args.specId,
        nodeId,
        // `args.subject` (`req.subject ?? principal.sub`), not
        // `principal.sub`. This row's `created_by_sub` column is what
        // `Instance.subject` reads back as, and `Instance.subject` is
        // exactly what `findReusable`'s sticky branch matches on and what
        // `countLiveInstances`/`reserveAdmission` already scope the per
        // user instance limit by (both using `args.subject`). Stamping
        // `principal.sub` here left the row disagreeing with the very
        // admission scope this call had just reserved against, and made
        // `sticky` unusable for its main case: an app that authenticates
        // its own end users holds ONE service principal and passes the
        // end user through as `req.subject`, so every instance was
        // stamped with that one service sub and `sticky.subject` could
        // never single out the caller's own browser.
        createdBySub: args.subject ?? args.principal.sub,
        // The fourth/fifth field this exact call site used to drop
        // silently (see `NewInstance.metadata`/`.lifetime`'s doc,
        // `packages/protocol/src/domain/store-types.ts`, for the first
        // three: `clientHints`, `initScripts`, `remoteEndpointName`, all
        // dropped one layer up in `toStoredSpecInput`). `NewInstance`
        // marking both required is what makes omitting either of these
        // two lines here, again, a compile error instead of a silent
        // data loss.
        metadata: args.metadata,
        lifetime: args.lifetime,
      });
    } finally {
      await releaseAdmission(this.store, reservation.reservation).catch(() => undefined);
    }

    try {
      // 7. placement
      const placementStart = this.clock.now();
      const profileHome = await this.profiles.homeOf(args.tenantId, args.profileSpec.key);
      // This process's own live snapshot ALWAYS comes from the in-memory
      // `NodeRegistry`, never a store round trip of its own write: see
      // `remoteNodeSnapshots`'s own doc for why a self read through the
      // store would be strictly worse (staler, and briefly wrong at
      // startup) than what this process already knows about itself.
      // `remoteNodeSnapshots` supplies every OTHER live node this store
      // knows about; on a single node deployment with no peer sharing this
      // store, that call returns `[]` and `candidates` is exactly
      // `[this.nodeRegistry.snapshot()]`, byte for byte what this line
      // produced before cross node placement existed. This is the one
      // line `docs/scaling.md`'s "what is still not supported" section
      // named as the actual ceiling on concurrent users: `placementCandidates`
      // and `ScoredPlacementPolicy` were already written to score MANY
      // candidates, and were being fed exactly one.
      const candidates = placementCandidates(
        [this.nodeRegistry.snapshot(), ...(await this.remoteNodeSnapshots())],
        {
          spec: args.spec,
          profile: args.profileSpec,
          affinity: args.affinity,
          nodeSelector: args.pool.nodeSelector,
          now: this.clock.now(),
          nodeStaleMs: this.config.nodeStaleMs,
        },
      );
      if (candidates.length === 0) {
        if (args.affinity.requireNodeId || args.affinity.requireLabels) {
          throw routerErr('E_AFFINITY_UNSATISFIABLE', 'no node satisfies the requested affinity');
        }
        throw routerErr('E_NO_CAPACITY', 'no placement candidate has headroom');
      }
      const decision = await this.placement.place({
        tenantId: args.tenantId,
        appId: args.appId,
        poolId: args.pool.id,
        spec: args.spec,
        profile: args.profileSpec,
        profileHome,
        affinity: args.affinity,
        candidates,
        now: this.clock.now(),
      });
      args.timings.placementMs = this.clock.now() - placementStart;
      if (decision.ordered.length === 0)
        throw routerErr('E_NO_CAPACITY', 'no node scored above the placement floor');

      // 8. try each candidate in score order
      const attempts: LaunchAttempt[] = [];
      for (const cand of decision.ordered.slice(0, this.config.maxPlacementAttempts)) {
        // Set the moment `this.nodes.launch()` below returns, and read
        // only by the catch block that closes this same try: a real
        // Chrome process exists on `cand.nodeId` from that point on, and
        // every one of the awaits still ahead in this try (createSession,
        // transitionInstance, `buildResult`'s (`:2035`) credential mint
        // via `mintAttachCredential` (`:2067`), which is where a real
        // `AttachCredentialIssuer`'s `E_NO_SIGNING_KEY` actually lives,
        // `@browserglass/server`'s `auth/tokens.ts:61`) can still throw. Before
        // this flag, a throw there fell straight to the catch below,
        // which released the profile lease and forgot the instance from
        // `liveRuntimeByInstance`, but never told the node to tear the
        // browser down, leaving a real Chrome process running with
        // nothing left anywhere that still pointed at it.
        let launchedOk = false;
        try {
          const profileStart = this.clock.now();
          const lease = await this.profiles.lease({
            tenantId: args.tenantId,
            appId: args.appId,
            spec: args.profileSpec,
            instanceId: args.instanceId,
            nodeId: cand.nodeId,
            ttlMs: this.config.profileLeaseTtlMs,
            ...(args.reclaimFromHolder !== undefined
              ? { reclaimFromHolderInstanceId: args.reclaimFromHolder.id }
              : {}),
          });
          args.timings.profileMs = this.clock.now() - profileStart;

          const launchStart = this.clock.now();
          const launched = await this.nodes.launch(cand.nodeId, {
            instanceId: args.instanceId,
            sessionId,
            spec: args.spec,
            profile: {
              storedKey: lease.storedKey,
              mode: args.profileSpec.mode,
              fence: lease.fence,
              source: lease.source,
              templateId: args.profileSpec.templateId,
              seed: args.profileSpec.seed,
            },
            limits: {},
            leaseMs: this.config.profileLeaseTtlMs,
            term: 0,
          });
          args.timings.launchMs = this.clock.now() - launchStart;
          launchedOk = true;
          // See `liveRuntimeByInstance`'s own comment: `describe()` needs
          // this real, live detail (`cdpWsUrl` especially) for any
          // instance this router process itself launched, and the store
          // has nowhere to persist it.
          this.liveRuntimeByInstance.set(args.instanceId, {
            kind: launched.runtimeKind,
            pid: launched.pid,
            containerId: launched.containerId,
            podName: launched.podName,
            cdpWsUrl: launched.cdpWsUrl,
            cdpPort: launched.transport.kind === 'http' ? launched.transport.port : null,
            chromeVersion: launched.engineVersion,
            profilePath: launched.profilePath,
            startedAt: launched.startedAt,
            // See `InstanceRuntimeInfo.stealthProfile`: metadata only, and
            // the gateway's one way of learning which stealth profile this
            // browser was launched under.
            stealthProfile: launched.stealthProfile ?? null,
          });

          await this.store.createSession({
            id: sessionId,
            tenantId: args.tenantId,
            instanceId: args.instanceId,
          });
          this.warmPool.recordColdLaunch(
            { tenantId: args.tenantId, poolId: args.pool.id },
            args.timings.launchMs / 1000,
          );

          await this.store.transitionInstance(
            args.tenantId,
            args.instanceId,
            ['launching'],
            'live',
            {
              // `args.instanceId`'s row was created above, at step 6, BEFORE
              // this candidate loop ran (`args.nodeId` there is always
              // `this.nodeRegistry.id()`, this process's OWN id: the nine
              // step flow's own comment on why the row exists before
              // placement, "a later failure updates a `failed` row, never
              // nothing"). With a
              // single candidate that was always harmlessly correct, since
              // the only candidate WAS this node. Now that `candidates` can
              // include another node's snapshot (`remoteNodeSnapshots`,
              // above) and `cand` here can be it, that row's `node_id` has
              // to be corrected to the node that ACTUALLY launched it, or
              // `Instance.nodeId` would keep pointing at this process even
              // though the browser is running somewhere else. This is not
              // cosmetic: the idle reaper and every drive/terminate call
              // trust `instances.node_id` to find the instance again
              // (`docs/scaling.md`'s "How an instance is placed" section),
              // and `orphanSweepScope`'s own reaping decision
              // (`@browserglass/server`'s `lifecycle/wiring.ts`) is scoped
              // to `instance.node_id === ourNodeId` specifically so it never
              // touches a healthy instance another node owns; leaving this
              // wrong would eventually retire a live browser out from under
              // whichever node actually launched it, or, on this node's own
              // sweep, silently exclude a foreign-owned instance's row from
              // ever being investigated by anyone. A no-op write when
              // `cand.nodeId === this.nodeRegistry.id()` (still the only
              // outcome possible on a single node deployment or when this
              // candidate wins), a real correction otherwise.
              nodeId: cand.nodeId,
              profileId: lease.profileId,
              sessionId,
              readyAt: this.clock.now(),
              fence: lease.fence,
              expiresAt: this.clock.now() + ttl,
            },
          );
          const instance = await this.store.getInstance(args.tenantId, args.instanceId);
          if (!instance)
            throw routerErr('E_LAUNCH_FAILED', 'instance vanished immediately after launch');
          this.audit.emit({
            k: 'instance.acquired',
            tid: args.tenantId,
            aid: args.appId,
            iid: args.instanceId,
            nid: cand.nodeId,
            profileKey: args.profileSpec.key,
            reused: false,
            at: this.clock.now(),
          });

          args.timings.totalMs = this.clock.now() - args.t0;
          const targets: readonly TargetSummary[] = [];
          const result = await this.buildResult(instance, args.principal, {
            reused: false,
            reuseReason: null,
            rejectedOverrides: args.rejectedOverrides,
            timings: args.timings,
            targets,
            profileSpecOverride: args.profileSpec,
          });
          this.settleReady(args.instanceId, result);
          return result;
        } catch (e) {
          attempts.push({ nodeId: cand.nodeId, error: toLaunchAttemptError(e) });
          this.liveRuntimeByInstance.delete(args.instanceId);
          await this.profiles.releaseLeaseQuietly(args.instanceId).catch(() => undefined);
          if (launchedOk) {
            // `this.nodes.launch()` above already spawned a real Chrome
            // process on `cand.nodeId` for `args.instanceId` (that is what
            // `launchedOk` records) before something later in this same
            // try failed: an injected `AttachCredentialIssuer` throwing
            // out of `buildResult`'s credential mint (`E_NO_SIGNING_KEY`
            // in production, `@browserglass/server`'s `auth/tokens.ts:61`)
            // is the real world case that surfaced this, but a
            // `createSession`/`transitionInstance`
            // throw here would leak the same way. Nothing else in this
            // catch, or in the outer catch below, ever calls
            // `terminate`/`teardown` on it: `liveRuntimeByInstance.delete`
            // just above only forgets the router's own bookkeeping, it
            // does not touch the process, so without this call the browser
            // was simply abandoned, held its profile lease's directory
            // forever, and was only ever reclaimed by
            // `HostRuntime.dispose()`'s `killOnShutdown` backstop on
            // process exit, which a long lived gateway never hits. `force`
            // matches `restart()`'s own fallback (`:1674`) and
            // `terminateGraceThenForce`'s escalation target: nothing was
            // ever attached to this browser, so there is no viewer to
            // drain gracefully, only a process to be sure is gone. Best
            // effort and swallowed exactly like that same `:1674` call:
            // `e` above is the real cause (the credential mint failure,
            // the placement failure) and must reach the caller unchanged;
            // a teardown that itself fails must never replace it or block
            // it, since the browser will still be swept by the shutdown
            // backstop even if this particular call fails.
            await this.nodes
              .terminate(cand.nodeId, args.instanceId, 'force')
              .catch(() => undefined);
          }
          if (isProfilePhaseError(e)) break; // fails everywhere, stop
          if (isCapacityError(e)) {
            this.nodeRegistry.recordLaunchFailure();
            continue; // capacity: brief penalty, try next candidate
          }
          this.nodeRegistry.recordLaunchFailure();
        }
      }
      throw routerErr('E_LAUNCH_FAILED', 'every placement candidate failed', {
        details: { attempts },
      });
    } catch (e) {
      this.liveRuntimeByInstance.delete(args.instanceId);
      await this.profiles.releaseLeaseQuietly(args.instanceId).catch(() => undefined);
      await this.store
        .transitionInstance(args.tenantId, args.instanceId, [...LIVE_INSTANCE_STATUSES], 'failed', {
          stateReason: errorCodeOf(e),
        })
        .catch(() => undefined);
      this.settleReady(args.instanceId, null, e);
      throw e;
    }
  }

  // ── attach ────────────────────────────────────────────────────────────

  /**
   * `attach` never launches, queues, or waits. If the instance is not
   * ready, it says so.
   *
   * SCOPE CHECKED, and this is the call site where that matters most in
   * this class. `attach` mints the ticket a viewer redeems to get onto an
   * instance (`server/src/ws/credentials.ts`'s `resolveTicket`, which reads
   * the instance id straight out of the redeemed record), so an
   * unenforced scope here is worse than an unenforced scope on
   * `driveInstance`: driving is one action against one instance, whereas a
   * ticket is a durable way onto it. Before this check a token minted
   * `{ kind: 'instance', instanceId: X }` could attach to any instance of
   * its tenant and be handed a working ticket for it.
   *
   * Placed before the state checks below for the same non-leaking reason
   * `driveInstance` places it there: `E_INSTANCE_GONE`/`E_INSTANCE_NOT_READY`
   * would otherwise tell an out-of-scope caller that the instance it may
   * not attach to nonetheless exists, and what it is doing.
   */
  async attach(req: AttachRequest, principal: Principal): Promise<AttachResult> {
    const instance = await this.store.getInstance(principal.tenantId, req.instanceId);
    if (!instance) throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${req.instanceId} not found`);
    assertScopeAllowsInstance(principal.scope, req.instanceId, instance.poolId);
    if (instance.state === 'released' || instance.state === 'failed')
      throw routerErr('E_INSTANCE_GONE', `instance ${req.instanceId} is ${instance.state}`);
    if (instance.state !== 'ready' && instance.state !== 'degraded')
      throw routerErr('E_INSTANCE_NOT_READY', `instance ${req.instanceId} is ${instance.state}`, {
        retryAfterMs: 1000,
      });
    const ticketTtlMs = Math.min(300_000, Math.max(10_000, req.ticketTtlMs ?? 60_000));
    // A viewer attaching is real use of the instance; see `recordActivity`'s
    // own comment for why this was previously the only thing missing.
    await this.recordActivity(req.instanceId, principal);
    const credential = await this.mintAttachCredential({
      tenantId: principal.tenantId,
      appId: principal.appId,
      instanceId: instance.id,
      sessionId: instance.sessionId ?? '',
      sub: principal.sub,
      capabilities: narrowCapabilities(principal.caps, req.capabilities),
      ttlMs: ticketTtlMs,
    });
    return {
      instanceId: instance.id,
      sessionId: instance.sessionId ?? '',
      attach: credential,
      node: { nodeId: instance.nodeId ?? this.nodeRegistry.id(), region: this.nodeRegistry.region },
      targets: [],
      viewers: [],
      fence: instance.fence,
    };
  }

  /**
   * The single call site both `attach()` and `buildResult()` (`acquire()`'s
   * own credential mint) route through, so the two never drift into minting
   * two different shapes of "the same kind of thing". Delegates to the
   * injected {@link AttachCredentialIssuer} when one was wired
   * (`BrowserRouterOptions.attachCredentials`); every production caller
   * supplies one (`@browserglass/server`'s `lifecycle/wiring.ts`, which
   * closes over its own `TokenApi` and `ResolvedConfig.publicUrl`/`.wsPath`).
   *
   * Falls back to a credential shaped to fail loudly, not to look real: an
   * `unwired://` URL a WebSocket client cannot even parse as `ws:`/`wss:`,
   * rather than the previous `ws://local/<nodeId>` placeholder, which
   * looked exactly like a working URL and was the whole reason this port
   * exists. This fallback exists for this package's own unit tests
   * (`test/support/createTestRouter.ts`), which assert on `AttachResult`'s
   * shape and refusal paths, never on redeeming a real socket.
   */
  private async mintAttachCredential(req: AttachCredentialRequest): Promise<AttachCredential> {
    if (this.attachCredentials) return this.attachCredentials.issue(req);
    return {
      ticket: newId('tkt'),
      wsUrl: `unwired://no-attach-credential-issuer-configured/${req.instanceId}`,
      expiresAt: this.clock.now() + req.ttlMs,
    };
  }

  /**
   * Advisory activity touch, `store.touchInstance` (`protocol/src/domain/store.ts`).
   * Nothing in this build called it until a fix landed: the
   * reaper's idle sweep (`reaperSweep`, below) compares
   * `now - instance.lastActivityAt` against the pool's `sessionIdleMs`
   * (`evaluateIdle`, `lifecycle.ts`), and with `lastActivityAt` frozen at
   * whatever `placeAndLaunch` set it to on acquire, every instance was
   * force released on a fixed clock (the demo pool's default, ~25 minutes
   * including grace) no matter how hard it was actually being driven.
   *
   * `attach()` is the one caller this file can wire without leaving its
   * own package (this package never imports `core`/`server`): it fires
   * once per viewer session start, which is a real, if coarse, activity
   * signal. The finer grained signals (per
   * input event, per target subscribe) live in `server/src/session/managed-session.ts`,
   * outside this package; this method is public and already throttled
   * specifically so that caller can wire it directly to every input event
   * without a second throttle layer on its side.
   *
   * Throttled to `config.activityTouchThrottleMs` (default 30s) per
   * instance so a caller driving input at mouse move frequency turns into
   * one SQLite write per throttle window, not one per event.
   */
  async recordActivity(instanceId: InstanceId, principal: Principal): Promise<void> {
    const now = this.clock.now();
    const last = this.lastActivityTouch.get(instanceId);
    if (last !== undefined && now - last < this.config.activityTouchThrottleMs) return;
    this.lastActivityTouch.set(instanceId, now);
    await this.store
      .touchInstance(principal.tenantId, instanceId, new Date(now).toISOString())
      .catch(() => undefined);
  }

  // ── drive (the authority gate) ──────────────────────────────────────

  /**
   * The router's authority gate: every driving
   * surface (REST, CLI, MCP, CDP passthrough, WS input) must pass through
   * this before acting on an instance, rather than reading
   * `store.getInstance` or scanning its own process local `SessionRegistry`
   * directly the way `server/src/rest/routes/targets.ts` and
   * `server/src/session/rest-driver.ts` used to.
   *
   * Resolves `instanceId` to its owning `nodeId` and live `sessionId`,
   * refuses an instance that is not in a drivable state, records activity,
   * and emits an audit event, in that order:
   *
   * 0. AUTHORIZATION, both halves of it, before anything else and on every
   *    call including a cache hit. The tenant half is the cache key itself
   *    ({@link driveCacheKey}): the only tenant check on this path is
   *    `store.getInstance(principal.tenantId, ...)`, and a cache hit
   *    returns before reaching it, so a cache keyed by `instanceId` alone
   *    handed any principal of any tenant a `DriveResolution` for an
   *    instance the owning tenant had already driven, with no tenant check
   *    performed at all. The scope half is {@link assertScopeAllowsInstance}:
   *    `principal.scope` was read nowhere in this file, so a token minted
   *    `{ kind: 'instance', instanceId: X }` could drive every other
   *    instance of its tenant, and scope was the only boundary there was
   *    between two instances of one tenant. Both refusals answer
   *    `E_INSTANCE_NOT_FOUND` so neither leaks whether the instance exists.
   * 1. Drivability mirrors `attach()`'s own three way check exactly, so a
   *    caller always gets a code distinct from "not found":
   *    `E_INSTANCE_NOT_FOUND` (never existed, a different tenant, or
   *    outside this token's scope),
   *    `E_INSTANCE_GONE` (released or failed, permanently unreachable),
   *    `E_INSTANCE_NOT_READY` (exists, mid launch, draining, or recovering:
   *    retryable, `retryAfterMs: 1000`, since it may become drivable
   *    shortly).
   * 2. `recordActivity` is called unconditionally, including on a cache
   *    hit: it is already throttled to `config.activityTouchThrottleMs`
   *    (default 30s, see that method's own comment), so calling it once
   *    per REST/CLI/CDP request here is what keeps an instance alive while
   *    it is driven (`onActivity` previously fired only from
   *    `ManagedSession.dispatchInput`, so an instance driven solely over
   *    REST, CLI, or CDP was force released by the idle reaper mid use)
   *    without adding a second throttle layer on top of that one.
   * 3. The audit emission follows `instance.acquired`'s own shape (the one
   *    event kind this method reuses rather than adding a new kind to
   *    `extension-points.ts`) with `reused: true`, exactly
   *    the value `doAcquire`'s reuse branch already emits for "this
   *    instance already existed, this call touched it rather than
   *    launching a fresh one". Emitted only on a cache miss: an instance is
   *    audited as touched once per fresh resolution, not once per drive
   *    call, the same way `instance.acquired` itself fires once per
   *    acquire, not once per frame.
   *
   * CACHED, since this sits on the hot path for REST driving (every
   * navigate/click/screenshot call would otherwise pay a
   * `store.getInstance` round trip on top of whatever the action itself
   * costs). INVALIDATED at `release()` and `restart()`, the only two
   * places in this file that move an already resolved instance out of
   * `ready`/`degraded`; see `driveCache`'s own comment.
   *
   * The cache is kept rather than removed, because the round trip it saves
   * is real, but its shape is now constrained so that it cannot outlive an
   * authorization decision: everything an authorization check reads is
   * either part of the key (the tenant) or carried in the entry (the
   * instance's `poolId`), and the scope predicate is pure in-memory work
   * over `principal.scope`, so it costs nothing to run on every call. What
   * the cache elides is the store I/O and the state check, never the
   * question of who is allowed to ask. The state check is the one thing
   * still allowed to go stale, and that is precisely what `release()` and
   * `restart()`'s invalidations exist to bound.
   */
  async driveInstance(instanceId: InstanceId, principal: Principal): Promise<DriveResolution> {
    const cacheKey = driveCacheKey(principal.tenantId, instanceId);
    const cached = this.driveCache.get(cacheKey);
    if (cached) {
      // Both authorization checks run on the cache hit path as well: the
      // tenant one structurally, since a foreign tenant computes a
      // different `cacheKey` and simply misses, and the scope one right
      // here, ahead of `recordActivity`. Order matters: `recordActivity`
      // writes `lastActivityAt` on the instance, and a refused caller must
      // not leave a mark on an instance it may not drive, nor learn
      // anything from how long the refusal took.
      assertScopeAllowsInstance(principal.scope, instanceId, cached.poolId);
      await this.recordActivity(instanceId, principal);
      return cached.resolution;
    }

    const instance = await this.store.getInstance(principal.tenantId, instanceId);
    if (!instance) throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${instanceId} not found`);
    // Before the state checks below, deliberately: an out-of-scope caller
    // gets the same bare `E_INSTANCE_NOT_FOUND` as a foreign tenant, rather
    // than `E_INSTANCE_GONE`/`E_INSTANCE_NOT_READY` telling it that the
    // instance it may not drive nonetheless exists and what it is doing.
    assertScopeAllowsInstance(principal.scope, instanceId, instance.poolId);
    if (instance.state === 'released' || instance.state === 'failed')
      throw routerErr('E_INSTANCE_GONE', `instance ${instanceId} is ${instance.state}`);
    if (instance.state !== 'ready' && instance.state !== 'degraded')
      throw routerErr('E_INSTANCE_NOT_READY', `instance ${instanceId} is ${instance.state}`, {
        retryAfterMs: 1000,
      });

    const nodeId = instance.nodeId ?? this.nodeRegistry.id();
    const resolution: DriveResolution = {
      instanceId,
      nodeId,
      sessionId: instance.sessionId ?? '',
      local: nodeId === this.nodeRegistry.id(),
    };
    this.driveCache.set(cacheKey, { resolution, poolId: instance.poolId });
    // `instance.drive`, not another `instance.acquired`. Driving is not
    // acquiring, and logging every REST call, CLI command and CDP
    // passthrough as an acquisition would leave anyone counting acquisitions
    // out of the audit log badly over-counting. Emitted on a fresh resolve
    // only, which is why it sits after the cache write rather than at the
    // top of the method.
    this.audit.emit({
      k: 'instance.drive',
      tid: principal.tenantId,
      aid: principal.appId,
      iid: instanceId,
      nid: nodeId,
      local: resolution.local,
      at: this.clock.now(),
    });
    await this.recordActivity(instanceId, principal);
    return resolution;
  }

  /**
   * Runs `req` against `instanceId` through the gate: `driveInstance`
   * resolves and authorises it, then `this.nodes.dispatch(...)` either
   * executes it in process (a local `nodeId`, `LocalNodeTransport`'s fast
   * path) or forwards it to the owning node. This is the method a driving
   * surface calls when it has no richer local execution path of its own
   * (no `SessionRegistry` entry for this instance, because this process is
   * not the one that launched it); a surface that already resolved
   * `driveInstance` and found `local: true` may instead drive the instance
   * directly through its own session machinery, skipping this method and
   * `NodeTransport.dispatch` entirely, which is the data path
   * that deliberately stays off the router.
   */
  async dispatchAction(
    instanceId: InstanceId,
    req: NodeActionRequest,
    principal: Principal,
  ): Promise<NodeActionResult> {
    const resolution = await this.driveInstance(instanceId, principal);
    return this.nodes.dispatch(resolution.nodeId, req);
  }

  // ── release ───────────────────────────────────────────────────────────

  /**
   * The live viewer count for `release()`'s viewer gate, given up to
   * `config.releaseViewerSettleMs` to reach zero. The count lags a closing
   * socket: the caller that just closed its own viewer connection and then
   * asked for a release is still counted until the server sees that
   * socket's close finish, and reading the count once at that instant
   * answered `detached` and left the browser running. A viewer somebody
   * else still holds does not go away inside the window, so the gate
   * still protects them; the cost is that a genuine `detached` answer
   * arrives `releaseViewerSettleMs` later.
   */
  private async settledViewerCount(instanceId: InstanceId): Promise<number> {
    let count = this.viewers.countFor(instanceId);
    const settleMs = this.config.releaseViewerSettleMs;
    if (count === 0 || settleMs <= 0) return count;
    const deadline = this.clock.now() + settleMs;
    while (count > 0 && this.clock.now() < deadline) {
      const stepMs = Math.min(RELEASE_VIEWER_POLL_MS, deadline - this.clock.now());
      await new Promise<void>((resolve) => {
        this.clock.setTimeout(resolve, stepMs);
      });
      count = this.viewers.countFor(instanceId);
    }
    return count;
  }

  /**
   * The nine step release sequence. Step 5 (kill the Chrome process group, not just the
   * parent pid) is `LocalNode`/the injected `BrowserRuntime`'s
   * responsibility via `LaunchedBrowser.teardown`; this method drives the
   * sequence around it.
   *
   * VIEWER AWARE. `sticky` reuse (see
   * `doAcquire`'s selector rule and `findReusable`'s sticky branch) is
   * built precisely so several viewers share one browser, and the whole
   * point collapses if the first of them to close its tab takes the
   * browser down with it while the others are still streaming. So a
   * release that is one viewer leaving (`opts.force` unset, the default)
   * terminates only when nobody else is attached, and otherwise reports
   * `outcome: 'detached'` with the count that stopped it. A release the
   * router or an operator initiates (`opts.force: true`: the reaper's
   * sweeps, `drainNode`, capacity eviction) terminates regardless, exactly
   * as every release did before this.
   *
   * Detaching the caller's own viewer is deliberately NOT done here: this
   * package holds no viewer sockets and no CDP connections, so
   * the viewer that is leaving has already dropped its own connection by
   * the time it asks for a release. `'detached'` is this method reporting
   * what it did (nothing to the browser) rather than claiming a teardown
   * that did not happen, which is the same honesty rule the
   * `E_TERMINATE_FAILED` path below follows.
   *
   * `opts.leaveBrowserRunning` is a third, unrelated shape of the same
   * question, and the two must not be confused. `opts.force` is about
   * OTHER VIEWERS: may this release end a browser somebody else is still
   * watching. `opts.leaveBrowserRunning` is about OWNERSHIP: did
   * BrowserGlass create this browser in the first place, and may it
   * therefore end it at all. An instance on a `runtime-remote` endpoint is
   * somebody's own signed in Chrome, and the ordinary graceful-then-force
   * ladder ends it by sending `Browser.close`, mid task, with whatever was
   * half filled in still on screen. `leaveBrowserRunning` is the caller
   * saying it knows the browser is not ours; the owning node still gets
   * the final word, and refuses for any runtime that launched the browser
   * itself (`LocalNode.terminate`'s ownership guard). Both answers are
   * reported through `ReleaseResult.outcome`.
   */
  async release(
    instanceId: InstanceId,
    opts: ReleaseOptions,
    principal: Principal,
  ): Promise<ReleaseResult> {
    const instance = await this.store.getInstance(principal.tenantId, instanceId);
    if (!instance) throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${instanceId} not found`);
    // SCOPE CHECKED, before the idempotent already-released answer below
    // and before anything this method does to the instance. Unenforced,
    // this was a denial of service against another user of the same
    // tenant: an instance scoped token could end any sibling instance's
    // browser, and `release` is the one verb here whose whole job is to
    // destroy something. The three internal callers that reach this line
    // with a synthetic principal (`reaperSweep`, `drainNode`, and
    // `doAcquire`'s capacity eviction) all use `systemPrincipalFor`, whose
    // scope is `{ kind: 'tenant' }` (see `types.ts`'s `SYSTEM_PRINCIPAL`),
    // so all three pass. That matters more than it looks: every one of
    // them swallows this method's errors with `.catch(() => undefined)`, so
    // a check that wrongly refused a system principal would disable the
    // idle reaper, the TTL sweep, and node drain silently.
    assertScopeAllowsInstance(principal.scope, instanceId, instance.poolId);
    if (instance.state === 'released' || instance.state === 'failed') {
      return { instanceId, outcome: 'already_released', remainingViewers: 0 }; // idempotent
    }

    // The viewer gate, before the `draining` transition below and before
    // the drive cache invalidation: an instance that is not being torn
    // down must stay drivable and stay reusable for everyone still on it,
    // so nothing observable may change on this path.
    if (opts.force !== true) {
      const remainingViewers = await this.settledViewerCount(instanceId);
      if (remainingViewers > 0) {
        // No audit event: the only kind that fits is `instance.released`
        // (`extension-points.ts`'s `AuditEvent` union), and this instance
        // was not released. Emitting it here would leave anyone counting
        // releases out of the audit log over-counting, the same argument
        // `driveInstance` makes for `instance.drive` being its own kind
        // rather than another `instance.acquired`.
        return { instanceId, outcome: 'detached', remainingViewers };
      }
    }

    // Invalidated here, before anything else observable: `driveInstance`'s
    // cache must stop resolving this instance the moment release begins,
    // not once the nine step sequence below finishes. A caller racing this
    // call sees, at worst, one more `dispatchAction` reach a node that is
    // already mid teardown (the node/session layer's own problem, not a
    // stale router cache), never a `driveInstance` call that keeps
    // resolving an instance this method has already committed to releasing.
    //
    // `principal.tenantId` is the right half of the key: the
    // `store.getInstance(principal.tenantId, ...)` above already refused
    // any principal whose tenant does not own this instance, so the owning
    // tenant is the only one that can reach this line, and it is the only
    // tenant that can ever have populated an entry for this instance.
    this.driveCache.delete(driveCacheKey(principal.tenantId, instanceId));

    // 1. instance -> 'draining', removed from placement/reuse eligibility immediately.
    await this.store.transitionInstance(
      principal.tenantId,
      instanceId,
      [...LIVE_INSTANCE_STATUSES],
      'draining',
      { stateReason: opts.reason ?? null },
    );

    // 2-5. node broadcasts, waits gracefulMs, closes remainder, stops
    // streams, detaches CDP, then kills the Chrome process group (step 5,
    // the process-group kill; a bare parent pid kill leaks renderer,
    // GPU, and network service children).
    //
    // `opts.gracefulMs` (default 3000, `ReleaseOptions`'s own doc) used to
    // be accepted and never read anywhere in this method: the eviction
    // call passed `gracefulMs:
    // 1000` believing it granted a one second grace, and actually got
    // whatever the owning node's static supervisor config said, with no
    // per call control at all. `terminateGraceThenForce` below both
    // forwards this value to `NodeTransport.terminate`'s new fourth
    // argument AND escalates to `'force'` when `gracefulMs` elapses with
    // no answer, not only when the graceful call itself throws: a node
    // that accepts the graceful request but never confirms it (hung,
    // partitioned mid-drain) used to leave `release()` waiting on that
    // call forever, since the old code had nothing else to escalate on.
    //
    // `opts.leaveBrowserRunning` takes a different door out of this same
    // step, and it is the reason `TerminateMode`'s `'detach'` finally has
    // a caller: `runtime-remote` has implemented that mode since it was
    // written, and until this branch existed `grep -rn "'detach'"` across
    // `router/src` and `server/src` found nothing at all, so every release
    // of an instance running on somebody's own signed in Chrome sent that
    // Chrome `Browser.close`. There is no graceful-then-force ladder on
    // this path because there is nothing to escalate to: a detach asks
    // nothing of the process, so it either happens or the node refuses it,
    // and neither answer can be improved by waiting `gracefulMs` and then
    // asking harder. `gracefulMs` is deliberately not forwarded for the
    // same reason.
    let browserLeftRunning = false;
    const terminateOn = this.terminateTargetFor(instance);
    try {
      if (opts.leaveBrowserRunning === true) {
        const detachResult = await this.nodes.terminate(terminateOn, instanceId, 'detach');
        // Earned, not assumed. `LocalNode.terminate` refuses a detach for
        // any runtime that launched the browser itself and runs a real
        // teardown instead, reporting that through `effective`. Reading
        // the flag we sent rather than the answer we got back would make
        // `outcome: 'browser_detached'` a claim about our own intent, and
        // the whole point of this field is that it is a claim about the
        // browser.
        browserLeftRunning = detachResult.effective === 'detach';
      } else {
        const gracefulMs = opts.gracefulMs ?? 3000;
        await this.terminateGraceThenForce(terminateOn, instanceId, gracefulMs);
      }
    } catch (forceErr) {
      // Both attempts failed: the browser is not confirmed dead. The
      // previous behaviour swallowed this silently and fell through to
      // step 9, marking the row `released` anyway. That made the row lie: the reaper, `bg.stop()`'s phase 5,
      // and every other `list({state: LIVE_STATES})` caller would never
      // see this instance again, while the Chrome process kept running.
      // Instead: undo the step 1 `draining` transition back to `live`
      // (still a `LIVE_STATES` status, so a later reaper sweep or
      // `stop()` retries the terminate) and throw, so the caller sees a
      // real failure rather than a silent success. Every internal caller
      // in this file already treats `release()` as best effort
      // (`.catch(() => undefined)`); this only changes what the DB row
      // says, not whether those callers still move on.
      //
      // A failed detach lands here too, and for the same reason: the node
      // did not answer, so nothing is known about the browser, and a row
      // that reads `released` on the strength of a call that threw is the
      // same lie whichever mode threw.
      await this.store
        .transitionInstance(principal.tenantId, instanceId, ['draining'], 'live', {
          stateReason: 'terminate_failed',
        })
        .catch(() => undefined);
      const what =
        opts.leaveBrowserRunning === true
          ? 'the detach terminate failed'
          : 'both graceful and force terminate failed';
      throw routerErr('E_TERMINATE_FAILED', `release(${instanceId}): ${what}`, {
        cause: forceErr,
      });
    }
    // This router process is no longer this browser's launcher, whether
    // because the browser is gone or because we just detached from one we
    // never launched. Either way the entry has to go: it is keyed on us
    // being the process that can still reach that browser, and after this
    // line we are not. See `liveRuntimeByInstance`'s own comment.
    this.liveRuntimeByInstance.delete(instanceId);

    // 6. profile action (one of four values), 7-8. release the lease.
    const action: ProfileAction =
      opts.profile ?? (instance.profileSpec.mode === 'persistent' ? 'keep' : 'destroy');
    if (instance.profileId) {
      // Still non fatal: refusing to mark an instance released because a
      // directory could not be deleted would strand the row in `draining`
      // and take the quota slot with it, which is a worse failure than
      // the leftover bytes. But it must never again be SILENT. The
      // previous `.catch(() => undefined)` here discarded the error with
      // no log line at all, so a teardown that had never once succeeded
      // in this deployment (every release either skipped this call
      // because `instances.profile_id` was NULL, or reached it and lost
      // the Windows rename race) was indistinguishable from one that
      // always worked. The only visible symptom was the profile root
      // growing to about 3 GB across 50 directories. A reclaim failure is
      // a resource leak; it gets a line naming the profile, the action
      // and the underlying error, so the next occurrence is diagnosable
      // in one glance instead of one investigation.
      await this.profiles
        .applyReleaseAction({
          instanceId,
          profileId: instance.profileId,
          action,
          tenantId: principal.tenantId,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            { instanceId, profileId: instance.profileId, action, ...errorLogFields(err) },
            'release: the profile release action failed; the profile directory was NOT reclaimed and is leaking until it is swept',
          );
        });
    }
    // 7-8. The lease itself. The identity is passed because the profile
    // service resolves this instance's lease through an in memory map that
    // is empty for anything granted before a restart, and a miss there
    // used to mean the store row was simply never closed: 48 of 50 rows on
    // the demo deployment still read as held by instances released hours
    // earlier, and a stranded row on a persistent key fails the next
    // acquire with `E_PROFILE_BUSY` against a holder that no longer exists.
    //
    // `browserConfirmedGone` is true here and nowhere else in this file,
    // and it is earned rather than assumed: control only reaches this line
    // when `terminateGraceThenForce` above confirmed the process is gone,
    // and the `catch` around it throws rather than falling through when it
    // could not. That matters because it is the difference between "this
    // lease is stale" and "something may still be renewing this lease" in
    // the window before the TTL expires, which is precisely the window a
    // restart followed by a release lands in.
    if (instance.profileId) {
      await this.profiles.releaseLeaseQuietly(instanceId, {
        tenantId: principal.tenantId,
        profileId: instance.profileId,
        // False on the detach path, and it has to be: a browser we
        // deliberately left running is the one case in this method where a
        // process may still be holding this profile directory open. Saying
        // `true` there would hand the next acquire a profile whose lock
        // files are live, which is exactly the `E_PROFILE_LOCKED` class of
        // failure this flag exists to keep honest.
        browserConfirmedGone: !browserLeftRunning,
      });
    } else {
      await this.profiles.releaseLeaseQuietly(instanceId);
    }

    // 9. instance -> released, audit, quota decrement, warm reconciler poked.
    //
    // `releaseReason` here is the same `opts.reason ?? 'requested'` the
    // audit event on the next line already used, now ALSO landed on the
    // row itself (`instances.release_reason`, `entities.ts`'s
    // `Instance.releaseReason` doc): before this, that column existed but
    // nothing ever wrote it, so `GET /v1/instances/:instanceId/history`
    // (`packages/server/src/rest/routes/inventory.ts`) had no durable
    // answer to "why did this browser close" for an instance whose audit
    // log had already been pruned or was never written (`audit_events`
    // has zero production writers as of this change, per that route's own
    // doc). Written exactly once, at this terminal transition, and never
    // again: see `Instance.releaseReason`'s doc for why that is
    // deliberately a different lifetime than `stateReason`.
    await this.store.transitionInstance(principal.tenantId, instanceId, ['draining'], 'released', {
      releaseReason: opts.reason ?? 'requested',
    });
    this.audit.emit({
      k: 'instance.released',
      iid: instanceId,
      reason: opts.reason ?? 'requested',
      durationMs: this.clock.now() - instance.acquiredAt,
      at: this.clock.now(),
    });
    // No admission reservation to release here: `placeAndLaunch` holds its
    // `reserveAdmission` reservation only for the race window around
    // `store.createInstance`, releasing it immediately once the row
    // exists (see `placeAndLaunch`'s top comment on step 6). From that
    // point on, the row's own `state` is what every subsequent admission
    // count sees; transitioning it to `released` above is what frees the
    // quota slot for a future acquire, not a separate reservation ledger.
    if (instance.poolId) {
      const pool = await this.store.getPool(principal.tenantId, instance.poolId);
      if (pool)
        await this.warmPool.preWarmOnRelease(
          { tenantId: principal.tenantId, poolId: pool.id },
          pool.warm,
        );
    }

    return {
      instanceId,
      outcome: browserLeftRunning ? 'browser_detached' : 'terminated',
      remainingViewers: 0,
    };
  }

  /**
   * `release()`'s graceful-then-force terminate: escalates to `'force'` when `gracefulMs`
   * elapses with NO answer, not only when the graceful call itself
   * throws. Before this, a node that accepted the graceful request but
   * never confirmed it (hung, or partitioned mid-drain) left `release()`
   * awaiting that call forever, since nothing else could trigger the
   * fallback to force.
   *
   * The graceful call is wrapped in `settle` up front, so a rejection
   * that arrives after this method has moved on is still observed (never
   * an unhandled rejection) and can still be read. There is no
   * cancellation for the terminate call itself (`NodeTransport` has no
   * such primitive): a graceful call that loses the race keeps running on
   * the node while `'force'` goes ahead.
   *
   * A failed force attempt is not taken as proof the browser survived.
   * The method first waits a bounded time for a graceful call that is
   * still running, then asks the node once more, and only throws when
   * that recheck fails as well. See the comments in the body for the
   * load pattern that made this necessary.
   */
  private async terminateGraceThenForce(
    nodeId: NodeId,
    instanceId: InstanceId,
    gracefulMs: number,
  ): Promise<TerminateResult> {
    const graceful = settle(this.nodes.terminate(nodeId, instanceId, 'graceful', gracefulMs));

    const first = await this.settleWithin(graceful, gracefulMs);
    if (first !== 'timeout' && first.ok) return first.value;

    // The graceful call threw, or it is still running past `gracefulMs`.
    const force = await settle(this.nodes.terminate(nodeId, instanceId, 'force'));
    if (force.ok) return force.value;

    // The force attempt failed, but that alone does not mean the browser
    // is alive. Under load the two attempts run side by side on the node,
    // and the force ladder can run out of its confirm budget while the
    // graceful one, started earlier, goes on to see Chrome exit. Reporting
    // E_TERMINATE_FAILED then was a false alarm: the caller got a 502 and
    // Chrome was gone a moment later. So give a graceful call that is
    // still running a bounded chance to finish first.
    const gracefulLate = await this.settleWithin(graceful, GRACEFUL_LATE_WAIT_MS);
    if (gracefulLate !== 'timeout' && gracefulLate.ok) {
      return {
        ...gracefulLate.value,
        warnings: [
          ...gracefulLate.value.warnings,
          'the force terminate failed, but the graceful terminate that was still running confirmed the browser exited',
        ],
      };
    }

    // Both attempts failed. Ask the node once more before reporting a
    // failure. A node that already tore the browser down answers at once
    // (`LocalNode` remembers what it terminated), and one that did not
    // reruns the ladder, whose step 5 rescans the profile directory: a
    // Chrome that exited on its own in the meantime is confirmed gone
    // there, and one that is really still running fails this call too.
    const recheck = await settle(this.nodes.terminate(nodeId, instanceId, 'force'));
    if (recheck.ok) {
      return {
        ...recheck.value,
        warnings: [
          ...recheck.value.warnings,
          'the graceful and force terminates both failed, and a recheck then confirmed the browser exited',
        ],
      };
    }
    throw force.error;
  }

  /** Waits for `outcome` up to `ms` on this router's clock; `'timeout'` when it is still pending. */
  private async settleWithin<T>(
    outcome: Promise<Settled<T>>,
    ms: number,
  ): Promise<Settled<T> | 'timeout'> {
    let timer: ClockTimer | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = this.clock.setTimeout(() => resolve('timeout'), ms);
    });
    try {
      return await Promise.race([outcome, timeout]);
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
  }

  // ── restart (manual only) ─────────────────────────────────────────────

  /**
   * Relaunches this instance's browser in place: terminates the existing browser process,
   * preserves (renews) or, when `opts.preserveProfile` is `false`, destroys
   * and freshly re-acquires the profile lease, relaunches via
   * `this.nodes.launch()` under the SAME `instanceId`, and returns the
   * fresh `cdpWsUrl` a caller (`core.Session`'s `restartInstanceExecutor`,
   * threaded through by `packages/server/src/session/factory.ts`) needs to
   * reconnect a new `CdpBridge`. Mirrors `release()`'s two step
   * graceful-then-force terminate and `placeAndLaunch`'s `liveRuntimeByInstance`
   * bookkeeping; unlike `release()`, the instance row is never transitioned
   * past `recovering`, so a concurrent `describe()`/`list()` sees the
   * instance mid-restart rather than briefly `released`.
   *
   * Throws on any failure (profile renew/reacquire, launch, or the instance
   * being in an unexpected state), transitioning the instance to `failed`
   * first, so the caller (ultimately `core.Session.restartInstance()`) gets
   * a real rejection to build a wire `error` from, rather than the silent
   * hang that existed before (`ws/connection.ts`'s `instance.restart` handler
   * calling this and never replying either way).
   */
  async restart(
    instanceId: InstanceId,
    principal: Principal,
    opts: RestartOptions = {},
  ): Promise<RestartResult> {
    const preserveProfile = opts.preserveProfile ?? true;
    const instance = await this.store.getInstance(principal.tenantId, instanceId);
    if (!instance) throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${instanceId} not found`);
    // SCOPE CHECKED, before the state check and before the `recovering`
    // transition below. A restart is a release plus a relaunch as far as
    // the viewers on the instance are concerned, so an instance scoped
    // token restarting a sibling is the same denial of service `release()`
    // now refuses, taken through a different door.
    assertScopeAllowsInstance(principal.scope, instanceId, instance.poolId);
    if (instance.state !== 'ready' && instance.state !== 'degraded')
      throw routerErr('E_INSTANCE_NOT_READY', `instance ${instanceId} is ${instance.state}`, {
        retryAfterMs: 1000,
      });

    const nodeId = instance.nodeId ?? this.nodeRegistry.id();
    // See `release()`'s identical invalidation for why this happens before
    // the transition it guards, not after: the instance stops being
    // `ready`/`degraded` right here, so a cached `driveInstance` resolution
    // must stop being handed out at the same point, not once the relaunch
    // below finishes. Keyed by the owning tenant for the same reason
    // `release()`'s own invalidation is: the `store.getInstance` above has
    // already established that `principal.tenantId` owns this instance.
    this.driveCache.delete(driveCacheKey(principal.tenantId, instanceId));
    await this.store.transitionInstance(principal.tenantId, instanceId, ['live'], 'recovering', {
      stateReason: opts.reason ?? 'manual_restart',
    });

    try {
      // 1. terminate the existing browser process, graceful then force,
      // exactly `release()`'s own two step pattern.
      try {
        await this.nodes.terminate(nodeId, instanceId, 'graceful');
      } catch {
        await this.nodes.terminate(nodeId, instanceId, 'force').catch(() => undefined);
      }
      this.liveRuntimeByInstance.delete(instanceId);

      // 2. the profile: renew the existing lease in place (default), or
      // destroy and freshly re-acquire it at the same identity.
      const profileGrant: ProfileLeaseGrant = preserveProfile
        ? await this.profiles.renewForRestart({ instanceId, ttlMs: this.config.profileLeaseTtlMs })
        : await this.reacquireProfileForRestart(instance, nodeId);

      // 3. relaunch under the SAME instanceId, same spec, same profile identity.
      const launched = await this.nodes.launch(nodeId, {
        instanceId,
        sessionId: instance.sessionId,
        spec: instance.spec,
        profile: {
          storedKey: profileGrant.storedKey,
          mode: instance.profileSpec.mode,
          fence: profileGrant.fence,
          source: profileGrant.source,
          templateId: instance.profileSpec.templateId,
          seed: instance.profileSpec.seed,
        },
        limits: {},
        leaseMs: this.config.profileLeaseTtlMs,
        term: 0,
      });

      this.liveRuntimeByInstance.set(instanceId, {
        kind: launched.runtimeKind,
        pid: launched.pid,
        containerId: launched.containerId,
        podName: launched.podName,
        cdpWsUrl: launched.cdpWsUrl,
        cdpPort: launched.transport.kind === 'http' ? launched.transport.port : null,
        chromeVersion: launched.engineVersion,
        profilePath: launched.profilePath,
        startedAt: launched.startedAt,
        // See `InstanceRuntimeInfo.stealthProfile`: metadata only, and the
        // gateway's one way of learning which stealth profile this browser
        // was launched under.
        stealthProfile: launched.stealthProfile ?? null,
      });

      await this.store.transitionInstance(principal.tenantId, instanceId, ['recovering'], 'live', {
        profileId: profileGrant.profileId as ProfileId,
        fence: profileGrant.fence,
        readyAt: this.clock.now(),
      });

      return {
        instanceId,
        cdpWsUrl: launched.cdpWsUrl,
        browserGuid: launched.browserGuid,
        pid: launched.pid,
        startedAt: launched.startedAt,
        profileId: profileGrant.profileId as ProfileId,
        fence: profileGrant.fence,
      };
    } catch (e) {
      this.liveRuntimeByInstance.delete(instanceId);
      await this.store
        .transitionInstance(principal.tenantId, instanceId, ['recovering'], 'failed', {
          stateReason: errorCodeOf(e),
        })
        .catch(() => undefined);
      throw e;
    }
  }

  /**
   * `restart()`'s `preserveProfile: false` path: releases the current
   * lease, destroys the profile directory (`ProfileAction` `'destroy'`,
   * exactly `release()`'s own step 6-8 ordering: `applyReleaseAction`
   * before `releaseLeaseQuietly`, since the latter clears the tracked lease
   * `applyReleaseAction` still needs), then resolves and leases a brand new
   * profile at the SAME identity (same persistent key, or the same
   * instance-derived ephemeral key, via `profileSpecFromResolved`), so the
   * relaunch gets a genuinely blank profile under an unchanged identity
   * rather than a random new one.
   */
  private async reacquireProfileForRestart(
    instance: Instance,
    nodeId: NodeId,
  ): Promise<ProfileLeaseGrant> {
    if (instance.profileId) {
      // Same reasoning as `release()` step 6: non fatal (the restart
      // should still get its blank profile even if the old directory
      // could not be reclaimed), but never silent, because this is the
      // same reclaim and leaks the same bytes when it fails.
      await this.profiles
        .applyReleaseAction({
          instanceId: instance.id,
          profileId: instance.profileId,
          action: 'destroy',
          tenantId: instance.tenantId,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            {
              instanceId: instance.id,
              profileId: instance.profileId,
              action: 'destroy',
              ...errorLogFields(err),
            },
            'restart: the profile release action failed; the old profile directory was NOT reclaimed and is leaking until it is swept',
          );
        });
    }
    // No `browserConfirmedGone` here, deliberately. `restart()`'s step 1
    // terminates graceful then force, but its force call is
    // `.catch(() => undefined)`, so unlike `release()` it can reach this
    // point without having confirmed anything. An unexpired lease is
    // therefore left alone rather than released on an assumption.
    if (instance.profileId) {
      await this.profiles.releaseLeaseQuietly(instance.id, {
        tenantId: instance.tenantId,
        profileId: instance.profileId,
      });
    } else {
      await this.profiles.releaseLeaseQuietly(instance.id);
    }
    const spec = profileSpecFromResolved(instance.profileSpec);
    const { resolved } = await this.profiles.resolve({
      tenantId: instance.tenantId,
      appId: instance.appId,
      spec,
      dryRun: false,
    });
    return this.profiles.lease({
      tenantId: instance.tenantId,
      appId: instance.appId,
      spec: resolved,
      instanceId: instance.id,
      nodeId,
      ttlMs: this.config.profileLeaseTtlMs,
    });
  }

  // ── describe / list / topology ──────────────────────────────────────

  /**
   * A read view of one instance. `instance.runtime` is filled back in from
   * `liveRuntimeByInstance` when this router process is the one that
   * launched it (the store itself always reports `null`); an
   * instance launched by a different process, or already released,
   * reports `null` here exactly as the store does.
   *
   * SCOPE CHECKED. Information disclosure rather than action, so lower
   * severity than `attach`/`release`, but it is a real disclosure: the
   * `Instance` row this returns carries `spec`, `profileSpec`, `metadata`,
   * `incidents`, the owning `nodeId`, and (for an instance this process
   * launched) the live `runtime` including its `cdpWsUrl`. That last field
   * is why `server/src/session/factory.ts` calls this method at all, and it
   * is a direct handle on the browser, so a narrowed token reading a
   * sibling's `describe` was one step from driving it regardless of the
   * gate on `driveInstance`.
   */
  async describe(instanceId: InstanceId, principal: Principal): Promise<InstanceView> {
    const instance = await this.store.getInstance(principal.tenantId, instanceId);
    if (!instance) throw routerErr('E_INSTANCE_NOT_FOUND', `instance ${instanceId} not found`);
    assertScopeAllowsInstance(principal.scope, instanceId, instance.poolId);
    const runtime = instance.runtime ?? this.liveRuntimeByInstance.get(instanceId) ?? null;
    return {
      instance: runtime === instance.runtime ? instance : { ...instance, runtime },
      live: null,
    };
  }

  /**
   * Every instance matching `filter`. `filter.state` used to be built into
   * nothing: `store.listInstances` only filters
   * on the DDL's `status` column, so every caller of `list({state: [...]})`
   * silently got back the tenant's entire instance history, capped at
   * `store-sqlite`'s default `LIMIT 200` (`InstanceFilter.limit` unset).
   * `bg.stop()` phase 5 (`server/src/lifecycle/stop.ts`) is the sharpest
   * example: it calls `list({state: LIVE_STATES})` expecting only live
   * instances back, so it ended up terminating long dead ones (bogus
   * `terminate_failed` entries) and, past 200 rows for a tenant with any
   * real history, could miss genuinely live ones outside the window
   * entirely. `statusesForStates` below does the widening this method was
   * skipping.
   *
   * SCOPE NARROWED, not scope refused, and this is the one instance-facing
   * verb in this class where {@link assertScopeAllowsInstance} is the wrong
   * tool. "List what I may see" has a correct, usually non-empty answer for
   * a narrowed token: one row for an instance scoped one, its own pool's
   * rows for a pool scoped one. Throwing `E_INSTANCE_NOT_FOUND` at the
   * whole call would refuse a question the caller was entitled to ask, so
   * this filters instead, through {@link scopeAllowsInstanceRow}, the same
   * predicate the refusing form is built on so the two cannot drift apart.
   *
   * The narrowing is applied AFTER the store read rather than pushed into
   * `InstanceFilter`, because `filter.limit` is a store level `LIMIT` and
   * narrowing underneath it would silently turn "the 50 rows you asked for"
   * into "however many of an already truncated 50 survived the filter". The
   * cost is reading rows this tenant owns and then dropping them, which is
   * the same work `statusesForStates` above already accepts.
   */
  async list(filter: InstanceListFilter, principal: Principal): Promise<InstanceView[]> {
    const states =
      filter.state === undefined
        ? undefined
        : Array.isArray(filter.state)
          ? filter.state
          : [filter.state];
    const rows = await this.store.listInstances(principal.tenantId, {
      ...(states !== undefined ? { status: statusesForStates(states) } : {}),
      ...(filter.poolId != null ? { poolId: filter.poolId } : {}),
      ...(filter.limit != null ? { limit: filter.limit } : {}),
    });
    return rows
      .filter((instance) => scopeAllowsInstanceRow(principal.scope, instance.id, instance.poolId))
      .map((instance) => ({ instance, live: null }));
  }

  /**
   * One row per node. Single node builds return exactly one.
   *
   * DELIBERATELY NOT SCOPE CHECKED, and `_principal` stays unread. Every
   * other verb in this class names an instance, so a narrowed token has
   * something concrete to be narrowed against; this one does not.
   * `TopologyView` is pure node infrastructure (node id, state, aggregate
   * load counters, last heartbeat, drain status) with no tenant and no
   * instance anywhere in it, so there is no `instanceId` to pass
   * {@link assertScopeAllowsInstance} and nothing for an instance or pool
   * scope to select. Adding a check here would be a check that pretends to
   * narrow something it cannot.
   *
   * What this DOES carry is cross-tenant aggregate load, since `load`
   * counts every instance on the node regardless of who owns it. The right
   * gate for that is a capability (`admin`), not a scope, and it belongs at
   * the surface that exposes the method rather than here. No surface does
   * today: `/v1/topology` is registered in `server/src/rest/router.ts`'s
   * `STUB_PATHS` with `capability: null` and a handler that returns
   * nothing, so this method is unreachable from any wire. If that route is
   * ever implemented, give it the `admin` capability rather than reaching
   * back into this method for a scope check that cannot express the rule.
   */
  topology(_principal: Principal): Promise<TopologyView> {
    return Promise.resolve({ nodes: [this.nodeRegistry.topologyRow()] });
  }

  /**
   * Reads the durable `Node` record for `nodeId` from the store, chiefly
   * for `dataPlaneUrl` (`protocol/domain/entities.ts`): the address a peer
   * `WebSocketNodeTransport`, or a viewer redirected to a foreign node
   * (`driveInstance`'s `local: false` case), should reach that node at.
   * Public, deliberately, rather than a private lookup only this router's
   * own transport can see: this is the same resolution a cross node viewer
   * handoff needs to turn "the instance is on node X" into "reconnect to
   * this URL", so both callers share one real path instead of each
   * re-deriving their own.
   *
   * READ ONLY: nothing in this class calls `store.registerNode` to
   * populate that row; `@browserglass/server`'s `lifecycle/wiring.ts` does,
   * once per process start, since a router-layer package cannot know its
   * own reachable address or hold an operator supplied peer secret
   * (this package depends on `@browserglass/protocol` only). `Store.registerNode` now upserts on `id` (`store-sqlite`'s own
   * change, `docs/scaling.md`), so a node CAN safely re-register itself
   * across a process restart, provided the caller passes the same `id`
   * every time (an operator configured `peer.nodeId`; left unset, a fresh
   * id is still minted every start, unchanged from before). This method
   * itself only ever reads whatever the caller's own registration put
   * there.
   */
  async resolveNode(nodeId: NodeId): Promise<Node | null> {
    return this.store.getNode(nodeId);
  }

  // ── drain ─────────────────────────────────────────────────────────────

  /**
   * Single node "drain" is a
   * graceful shutdown, never a relocation. Excludes the node from
   * placement immediately, then releases every live instance on this
   * node, waiting `gracefulMs` for a natural handoff before this method's
   * own bookkeeping considers the node drained.
   */
  async drainNode(nodeId: NodeId, opts: DrainOptions, principal: Principal): Promise<DrainHandle> {
    const mode = opts.mode ?? 'graceful';
    const deadlineMs = opts.deadlineMs ?? this.config.drainDefaultDeadlineMs;
    const deadlineAt = this.clock.now() + deadlineMs;
    this.nodeRegistry.markDraining(deadlineAt, mode);
    // `this.nodeRegistry.id()`, not the `nodeId` argument: `markDraining`
    // just above has exactly the same pre-existing single node assumption
    // (it always drains THIS process's own registry, whatever `nodeId` was
    // passed in; the only real caller, `stop()`, always passes
    // `this.nodeRegistry.id()`), and this write exists purely to keep the
    // durable row in step with the in-memory state `markDraining` just
    // set, not to add a remote-drain capability this method does not
    // otherwise have. Best effort and not awaited into a `.catch` that
    // blocks draining: `persistNodeState`'s own next tick (at most
    // `heartbeatIntervalMs` away) mirrors this same state again, so a
    // failure here only widens, briefly, the window in which another
    // node's placement could still pick this one; it does not leave this
    // node stuck looking `'ready'` forever the way never writing at all
    // would.
    void this.store.setNodeStatus(this.nodeRegistry.id(), 'draining').catch(() => undefined);

    for (const tenantId of await this.everyTenant()) {
      const rows = await this.store.listInstances(tenantId, {
        status: ['warm', 'live', 'recovering'],
      });
      for (const row of rows.filter((r) => (r.nodeId ?? this.nodeRegistry.id()) === nodeId)) {
        // `force: true`: draining a node is an operator decision that ends
        // every instance on it, attached viewers included. See
        // `ReleaseOptions.force`'s own doc for why the default is the
        // opposite.
        await this.release(
          row.id,
          { reason: 'node_draining', closeCode: 4401, force: true },
          principal,
        ).catch(() => undefined);
      }
    }
    this.nodeRegistry.markDrained();

    return {
      nodeId,
      deadlineAt,
      onEmpty: (cb) => cb(),
      relocate: () => Promise.resolve({ relocated: false }),
    };
  }

  // ── admission helpers ────────────────────────────────────────────────

  private async resolvePool(
    tenantId: TenantId,
    poolRef: string | undefined,
    appId: AppId,
  ): Promise<Pool> {
    if (poolRef) {
      const byId = await this.store.getPool(tenantId, poolRef).catch(() => null);
      if (byId) return byId;
      const byName = await this.store.getPoolByName(tenantId, poolRef);
      if (byName) return byName;
      throw routerErr('E_POOL_NOT_FOUND', `pool ${poolRef} not found`);
    }
    const app = await this.store.getApp(tenantId, appId);
    const defaultPoolId = app?.defaultPoolId ?? null;
    if (defaultPoolId) {
      const pool = await this.store.getPool(tenantId, defaultPoolId);
      if (pool) return pool;
    }
    const pool = await this.store.getPoolByName(tenantId, 'default');
    if (!pool)
      throw routerErr(
        'E_POOL_NOT_FOUND',
        'no pool named default and no app default pool configured',
      );
    return pool;
  }

  private async findEvictable(tenantId: TenantId, poolId: PoolId): Promise<Instance | null> {
    const rows = await this.store.listInstances(tenantId, { poolId, status: ['live', 'warm'] });
    const now = this.clock.now();
    const victims = rows
      .filter((r) => now - r.lastActivityAt > this.config.evictIdleMinAgeMs)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return victims[0] ?? null;
  }

  /**
   * `opts.profileSpecOverride` covers a real gap in `protocol`'s `Store`
   * interface: `NewInstance` (`store.createInstance`'s input) carries no
   * field for the resolved `ProfileSpec`, only an eventual `profileId`
   * once a lease exists, so `Instance.profileSpec` cannot round trip
   * through the store for an instance this same call just created. Within
   * one `acquire` call the resolved spec is already in scope (computed in
   * `doAcquire`, threaded through `placeAndLaunch`'s `args`), so it is
   * passed here directly rather than trusted from a fresh `getInstance`
   * read. A `describe`/`list` call in a later, separate request has no
   * such override and falls back to whatever the store round tripped,
   * which is the store's concern, not this method's.
   */
  private async buildResult(
    instance: Instance,
    principal: Principal,
    opts: {
      reused: boolean;
      reuseReason: AcquireResult['reuseReason'];
      rejectedOverrides: readonly { field: string; reason: string; policy: string }[];
      timings: AcquireResult['timings'];
      targets?: readonly TargetSummary[];
      profileSpecOverride?: ResolvedProfileSpec;
    },
  ): Promise<AcquireResult> {
    // `principal` here is `SYSTEM_PRINCIPAL`-derived exactly once: the
    // resolution of a QUEUED acquire, `processQueue`'s own
    // `placeAndLaunch` call, which has no real caller identity to hand
    // the launch (the `placement_queue` row, `Store.enqueuePlacement`,
    // carries `requestedBy: string` for audit purposes only, never the
    // original caller's capability set: threading that through would be
    // a `store-sqlite`/`protocol` schema change, not done yet). Minting a live credential off `SYSTEM_PRINCIPAL.caps`
    // (`['admin']`, `types.ts`) would hand whoever is awaiting
    // `AcquireHandle.ready` an admin-scoped credential regardless of what
    // THEY were actually authorised for, which is a privilege escalation
    // this fix must not introduce. Every other `buildResult` call site
    // passes the real caller's own `principal` (`doAcquire`'s attach-by-id
    // short circuit, the reuse branch, and the direct/evicted launch
    // paths), so this guard costs nothing there. The queued caller is not
    // left credential-less: `attach()` (`server/src/rest/routes/instances.ts`'s
    // `attachInstance`) mints one correctly scoped to whoever actually
    // calls it, once they have the real `instanceId` in hand.
    const attach =
      instance.state === 'ready' && principal.sub !== SYSTEM_PRINCIPAL.sub
        ? await this.mintAttachCredential({
            tenantId: principal.tenantId,
            appId: principal.appId,
            instanceId: instance.id,
            sessionId: instance.sessionId ?? '',
            sub: principal.sub,
            capabilities: principal.caps,
            ttlMs: 60_000,
          })
        : null;
    const profileSpec = opts.profileSpecOverride ?? instance.profileSpec;
    return {
      instanceId: instance.id,
      placementId: null,
      sessionId: instance.sessionId ?? '',
      state: instance.state === 'ready' || instance.state === 'degraded' ? 'ready' : 'launching',
      ...(attach ? { attach } : {}),
      node: {
        nodeId: instance.nodeId ?? this.nodeRegistry.id(),
        region: this.nodeRegistry.region,
        labels: {},
      },
      targets: opts.targets ?? [],
      profile: {
        profileId: instance.profileId,
        key: profileSpec.key,
        mode: profileSpec.mode,
        created: !opts.reused,
        sizeBytes: null,
      },
      reused: opts.reused,
      reuseReason: opts.reuseReason,
      rejectedOverrides: opts.rejectedOverrides,
      effectiveSpec: instance.spec,
      timings: opts.timings,
      expiresAt: instance.expiresAt,
      fence: instance.fence,
    };
  }

  // ── warm pool integration ────────────────────────────────────────────

  private async currentWarmCount(ref: PoolRef): Promise<number> {
    const rows = await this.store
      .listInstances(ref.tenantId, { poolId: ref.poolId, status: ['warm'] })
      .catch(() => [] as Instance[]);
    return rows.length;
  }

  private launchWarmInstance(ref: PoolRef): Promise<void> {
    // Pre-warmed instances are ephemeral, unowned (`subject: null`), and
    // launched through the same placement + profile lease + node launch
    // path as a real acquire. Left as a documented no-op hook point rather than a synthetic
    // `AcquireRequest` here: `desiredWarmCount`/`WarmPoolReconciler`
    // (`../pool`) are the tested, load bearing part of warm pool sizing;
    // wiring this hook to `doAcquire`/`placeAndLaunch` is mechanical once
    // a caller supplies the tenant/app context a warm launch runs under.
    void ref;
    return Promise.resolve();
  }

  // ── reaper ────────────────────────────────────────────────────────────

  /**
   * The five sweeps: idle,
   * duration, TTL, orphan, and stuck. Driven entirely by the injected
   * `Clock`, so a test can advance time without waiting on it.
   */
  async reaperSweep(): Promise<void> {
    const now = this.clock.now();
    for (const tenantId of await this.everyTenant()) {
      const live = await this.store
        .listInstances(tenantId, { status: ['live', 'warm', 'recovering'] })
        .catch(() => [] as Instance[]);
      // Every release below passes `force: true`: a lifecycle deadline
      // (TTL, max duration, idle) expiring is not one viewer leaving, and
      // must end the instance whether or not somebody is still attached,
      // exactly as these sweeps did before `ReleaseOptions.force` existed.
      for (const instance of live) {
        const principal = systemPrincipalFor(instance.tenantId, instance.appId);
        if (isTtlExpired(now, instance.expiresAt)) {
          await this.release(
            instance.id,
            { reason: 'ttl_expired', closeCode: 4001, force: true },
            principal,
          ).catch(() => undefined);
          continue;
        }
        if (isMaxDurationExceeded(now, instance.acquiredAt, this.config.maxDurationMs)) {
          await this.release(
            instance.id,
            { reason: 'max_duration', closeCode: 4002, force: true },
            principal,
          ).catch(() => undefined);
          continue;
        }
        if (instance.subject === null) continue; // warm instances: own shorter clock, never idle-timeout normally
        // See `./config.ts`'s `instanceLingerMs` doc:
        // `'explicit'` lives until released or `maxDurationMs`, never on
        // an idle timer. The `ttl_expired`/`max_duration` checks above
        // still bound it, since they run before this branch regardless of
        // `lifetime`; only THIS sweep, the viewer-bound idle release, is
        // what `'explicit'` opts out of.
        if (instance.lifetime === 'explicit') continue;
        const pool = instance.poolId
          ? await this.store.getPool(tenantId, instance.poolId).catch(() => null)
          : null;
        const idleMs = pool?.limits.sessionIdleMs ?? DEFAULT_IDLE_MS;
        const queued = instance.poolId ? this.queueDepth.depth(instance.poolId) : 0;
        const decision = evaluateIdle(
          now - instance.lastActivityAt,
          idleMs,
          IDLE_GRACE_MS_DEFAULT,
          this.config.idleGraceUnderPressureMs,
          queued > 0,
        );
        if (decision.phase === 'release') {
          await this.release(
            instance.id,
            { reason: 'idle_timeout', closeCode: 4001, force: true },
            principal,
          ).catch(() => undefined);
        }
      }

      const stuck = await this.store
        .listInstances(tenantId, { status: ['launching'] })
        .catch(() => [] as Instance[]);
      for (const instance of stuck) {
        if (
          STUCK_LAUNCH_STATES.includes(instance.state as (typeof STUCK_LAUNCH_STATES)[number]) &&
          isStuckLaunching(now, instance.stateChangedAt, instance.spec.launchTimeoutMs)
        ) {
          await this.store
            .transitionInstance(instance.tenantId, instance.id, ['launching'], 'failed', {
              stateReason: 'stuck',
            })
            .catch(() => undefined);
          // A launch that never finished: this reaper has no idea whether
          // a browser process exists, so it passes the identity (which is
          // what lets the store row be closed at all) but never claims
          // confirmation.
          await this.profiles
            .releaseLeaseQuietly(
              instance.id,
              instance.profileId
                ? { tenantId: instance.tenantId, profileId: instance.profileId }
                : undefined,
            )
            .catch(() => undefined);
        }
      }
    }

    const nodeSnapshot = this.nodeRegistry.snapshot();
    if (isOrphaned(now, nodeSnapshot.lastHeartbeatAt, this.config.nodeStaleMs)) {
      // Single node: the local heartbeat loop itself stalled (an event
      // loop stall). A safety net only; there is no second node to fail
      // over to, and node death detection across nodes is not
      // implemented.
    }
  }

  // ── queue processing ─────────────────────────────────────────────────

  /**
   * Claims and attempts every ready queued entry (claim, then place). `Store.claimPlacements` provides the
   * atomicity (a compare-and-set on `status`), so two concurrent calls to
   * this method never claim, and place, the same entry.
   */
  async processQueue(limit = 10): Promise<void> {
    await claimAndPlace(
      this.store,
      this.queueDepth,
      this.config.routerId,
      limit,
      this.config.queueMaxAttempts,
      new Date(this.clock.now()).toISOString(),
      async (entry): Promise<PlaceAttemptOutcome> => {
        try {
          const pool = await this.store.getPool(entry.tenantId, entry.poolId);
          if (!pool) return { kind: 'abandon', error: 'pool_not_found' };
          const { resolved: profileSpec } = await this.profiles.resolve({
            tenantId: entry.tenantId,
            appId: entry.appId,
            spec: pool.profileTemplate,
            dryRun: false,
          });
          const timings = { admissionMs: 0, placementMs: 0, profileMs: 0, launchMs: 0, totalMs: 0 };
          const result = await this.placeAndLaunch({
            instanceId: newId('inst'),
            tenantId: entry.tenantId,
            appId: entry.appId,
            pool,
            principal: systemPrincipalFor(entry.tenantId, entry.appId),
            spec: pool.template,
            specId: entry.specId,
            profileSpec,
            subject: entry.requestedBy,
            affinity: {},
            ttlMs: undefined,
            // KNOWN GAP, not fixed by this call: `placement_queue`
            // (`Store.enqueuePlacement`'s input) carries no `metadata` or
            // `lifetime` column, the same way it already carries no `ttlMs`
            // (see the hardcoded `undefined` immediately above). A caller
            // whose `acquire` is queued (`onFull: 'queue'`) and only placed
            // later, from here, loses `metadata`/`lifetime` exactly the way
            // it already loses `ttlMs`, because `enqueueAcquire` never
            // passes them into the queue row in the first place. Fixing
            // that is a `placement_queue` schema change (a new column, a
            // new `NewPlacement` field, `enqueueAcquire` threading the
            // original request through) not done yet; this
            // hardcodes the same default `doAcquire`'s non-queued path uses
            // for an unset `AcquireRequest.metadata`/`.lifetime`, so a
            // queued acquire's instance is never WORSE off than before this
            // task, only not yet BETTER for this one path.
            metadata: {},
            lifetime: 'viewer-bound',
            rejectedOverrides: [],
            timings,
            t0: this.clock.now(),
          });
          this.settleReady(entry.id, result);
          // `placeAndLaunch` above either returns a launched (never queued)
          // `AcquireResult`, whose `instanceId` `buildResult` always sets to
          // a real `instance.id`, or throws; the `null` branch of
          // `AcquireResult.instanceId` belongs to `enqueueAcquire` only,
          // which this call never reaches. Checked rather than asserted, so
          // a future change that makes this untrue fails loudly here
          // instead of silently completing the placement with a bogus id.
          if (!result.instanceId)
            throw routerErr('E_LAUNCH_FAILED', 'placeAndLaunch resolved without an instanceId');
          return { kind: 'placed', instanceId: result.instanceId };
        } catch (e) {
          if (isCapacityError(e)) return { kind: 'retry', error: (e as Error).message };
          this.settleReady(entry.id, null, e);
          return { kind: 'abandon', error: (e as Error).message };
        }
      },
    );
  }
}

function errorCodeOf(e: unknown): string {
  const code = (e as { code?: string } | undefined)?.code;
  return code ?? 'E_LAUNCH_FAILED';
}

function toLaunchAttemptError(e: unknown): {
  code: string;
  message: string;
  stderrTail: string | null;
} {
  if (e instanceof Error)
    return {
      code: (e as { code?: string }).code ?? 'E_LAUNCH_FAILED',
      message: e.message,
      stderrTail: null,
    };
  return { code: 'E_LAUNCH_FAILED', message: String(e), stderrTail: null };
}

/** Profile phase errors break the candidate loop immediately: they will fail on every node. */
function isProfilePhaseError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return (
    code === 'E_PROFILE_BUSY' ||
    code === 'E_PROFILE_QUARANTINED' ||
    code === 'E_PROFILE_STORAGE' ||
    code === 'E_PROFILE_EXPIRED'
  );
}

/** Capacity errors penalise briefly (30s) and continue to the next candidate. */
function isCapacityError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return code === 'E_LAUNCH_ADMISSION' || code === 'E_NO_CAPACITY';
}

/** Whether `e` is `placeAndLaunch`'s atomic admission reservation refusing, `doAcquire`'s signal to apply the pool's `onFull` policy. */
function isAdmissionRefusedError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return code === 'E_QUOTA_INSTANCES';
}

/**
 * The reverse of store-sqlite's `INSTANCE_STATUS_TO_STATE`
 * (`store-sqlite/src/mappers.ts`): `InstanceLifecycleState` (ten values,
 * `Instance.state`) is a finer read of `InstanceStatus` (the DDL's seven
 * value `instances.status` column), per `store-types.ts`'s top comment.
 * `BrowserRouter.list`'s `filter.state` is typed against the ten value
 * enum, but `Store.listInstances` only ever filters on the seven value
 * column, so a caller-requested state has to be widened back to every
 * status that could produce it: `ready` becomes both `warm` and `live`;
 * `requested`/`placing`/`launching` all collapse onto the one `launching`
 * status. `degraded` and `releasing` have no status the DDL enum can
 * represent at all (this store implementation never emits them), so they
 * intentionally map to nothing and match zero rows rather than throwing.
 */
function statusesForStates(states: readonly InstanceLifecycleState[]): InstanceStatus[] {
  const out = new Set<InstanceStatus>();
  for (const state of states) {
    switch (state) {
      case 'requested':
      case 'placing':
      case 'launching':
        out.add('launching');
        break;
      case 'ready':
        out.add('warm');
        out.add('live');
        break;
      case 'recovering':
        out.add('recovering');
        break;
      case 'draining':
        out.add('draining');
        break;
      case 'released':
        out.add('released');
        break;
      case 'failed':
        out.add('failed');
        break;
      case 'degraded':
      case 'releasing':
        // No backing status; see this function's TSDoc.
        break;
    }
  }
  return [...out];
}

/**
 * The reverse of store-sqlite's `NODE_STATUS_TO_STATE`
 * (`store-sqlite/src/mappers.ts`, the exact mirror of `statusesForStates`
 * above one enum pair over): `NodeState` (`Node.state`, and what
 * `NodeRegistry.snapshot()` reports) and `NodeStatus` (`nodes.status`, what
 * `Store.setNodeStatus` writes) are two distinct enums for the same
 * underlying idea, one entity level and one DDL column level, the same
 * split `store-types.ts`'s own top comment documents for instances.
 * `persistNodeState` needs to go the OTHER direction from `rowToNode`
 * (state, the thing this process already knows about itself, to status,
 * the thing it durably tells everyone else), and router cannot import
 * store-sqlite's mapping to invert it: `@browserglass/router` depends on
 * `@browserglass/protocol` only (this file's own top comment),
 * `store-sqlite` is a devDependency, test only. Written as an exhaustive
 * switch so a `NodeState` this package's own `NodeRegistry` can never
 * actually produce (`'degraded'`: no setter anywhere in that class today,
 * see `LocalNode`) still has to be given an honest answer rather than
 * silently falling through, the same discipline `INSTANCE_PATCH_RULES`
 * (`store-sqlite/src/store.ts`) applies to `Instance`'s own fields.
 */
function storeStatusFor(state: NodeState): NodeStatus {
  switch (state) {
    case 'registering':
      return 'joining';
    case 'ready':
      // `'degraded'` has no dedicated `NodeStatus`: a node this package's
      // own registry considers merely degraded (were anything to set it)
      // is still routable, just not preferentially, and `NodeStatus` draws
      // its line at "can this be placed on at all", not at score. Folded
      // onto `'ready'` rather than `'cordoned'`, which would wrongly
      // remove it from `placementCandidates` entirely.
      return 'ready';
    case 'degraded':
      return 'ready';
    case 'draining':
      return 'draining';
    case 'drained':
      return 'retired';
    case 'lost':
      return 'lost';
    case 'quarantined':
      return 'cordoned';
  }
}

/**
 * `Node` (the store's full domain entity, `registeredAt`/`agentVersion`/
 * `drain` and the rest included) down to `NodeSnapshot` (the narrow, read
 * only shape `placementCandidates`/`ScoredPlacementPolicy` actually
 * consult, `extension-points.ts`'s own doc: "as far as placement needs to
 * know"). A structural pick, not a cast, so a field later added to `Node`
 * that placement should NOT see (an operator secret, an internal id) has
 * to be deliberately added here rather than leaking through by default.
 */
function nodeToSnapshot(n: Node): NodeSnapshot {
  return {
    nodeId: n.id,
    labels: n.labels,
    state: n.state,
    capacity: n.capacity,
    load: n.load,
    lastHeartbeatAt: n.lastHeartbeatAt,
    hostsProfiles: n.hostsProfiles,
  };
}
