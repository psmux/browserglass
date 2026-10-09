/**
 * `BrowserRouter`'s own request, result, and view types, plus the small
 * ports (`ProfileServicePort`) it takes by injection so it never depends on
 * the packages that implement them.
 */

import type {
  AffinityHints,
  AppId,
  BrowserSpec,
  Capability,
  Instance,
  InstanceId,
  InstanceLifecycleState,
  NodeId,
  PoolId,
  Principal,
  ProfileAction,
  ProfileId,
  ProfileSpec,
  ResolvedProfileSpec,
  TargetSummary,
  TenantId,
} from '@browserglass/protocol';
/**
 * The system principal `BrowserRouter` uses for actions it takes on its
 * own initiative (the reaper releasing an idle instance, the warm pool
 * reconciler launching a replacement). Never derived from a real token.
 */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  tenantId: '',
  appId: '',
  sub: 'system',
  subKind: 'service',
  caps: Object.freeze(['admin']) as Capability[],
  scope: Object.freeze({ kind: 'tenant' }),
  jti: 'system',
  exp: Number.MAX_SAFE_INTEGER,
}) as Principal;

/**
 * A `Principal` scoped to one tenant, used by the reaper and the warm pool
 * reconciler when they act on that tenant's instances on the router's own
 * initiative.
 */
export function systemPrincipalFor(tenantId: string, appId: string): Principal {
  return { ...SYSTEM_PRINCIPAL, tenantId, appId };
}

// ── acquire ─────────────────────────────────────────────────────────────

/** `BrowserRouter.acquire`'s request shape. */
export interface AcquireRequest {
  /** Idempotency key; a repeat call within `idempotencyWindowMs` returns the identical result. */
  requestId?: string;

  // selection: at most one of instanceId, profile.key, sticky
  /** Attach to a known instance. Never launches. */
  instanceId?: InstanceId;
  pool?: string;
  profile?: ProfileSpec;
  sticky?: { subject: string; withinMs?: number };

  // shaping
  browser?: Partial<BrowserSpec>;
  affinity?: AffinityHints;

  // lifecycle
  ttlMs?: number;
  idleMs?: number;
  releasePolicy?: ProfileAction;
  /**
   * `'viewer-bound'` (default) releases once the last viewer leaves;
   * `'explicit'` lives until released or `maxDurationMs`, and is exempt
   * from `BrowserRouter.reaperSweep`'s idle sweep (see `./config.ts`'s
   * `instanceLingerMs` doc). This is the field that lets a caller ask for
   * "keep this browser open until I say so", the per-run close policy a
   * wall of panes needs so a human can inspect a failed run after the
   * worker that acquired it has already exited.
   */
  lifetime?: 'viewer-bound' | 'explicit';

  // admission
  onFull?: 'queue' | 'reject';
  maxWaitMs?: number;
  /** Default `false`: `acquire` blocks until ready or failed. */
  async?: boolean;

  // bookkeeping
  /**
   * Caller supplied, free form string-to-string pairs, carried onto
   * `Instance.metadata` so an operator or a REST caller can tell instances
   * apart before destroying or operating on one. Capped by
   * `validateAcquireMetadata` (`./instanceMetadata.ts`): 16 keys, 64
   * characters per key, 512 per value. Two conventional keys, `name` and
   * `description`, are what the REST inventory route displays; every other
   * key is free form.
   */
  metadata?: Readonly<Record<string, string>>;
  subject?: string;
}

/** One rejected request override, `AcquireResult.rejectedOverrides`. */
export interface RejectedOverrideView {
  field: string;
  reason: string;
  policy: string;
}

/** `BrowserRouter.acquire`'s success shape. */
export interface AcquireResult {
  /**
   * The launched instance's id. `null` exactly when `state === 'queued'`:
   * no instance exists yet, so there is nothing to name here. A `plc_`
   * placement_queue row id must never be written into this field (that
   * value belongs in `placementId` below); a caller that needs a real
   * instance must check `state` first, and either poll using `placementId`
   * or await `AcquireHandle.ready`, which resolves once the placement is
   * filled and a real instance exists.
   */
  instanceId: InstanceId | null;
  sessionId: string;
  state: 'ready' | 'launching' | 'queued';

  /**
   * The `placement_queue` row id backing this ticket. Set only when
   * `state === 'queued'`, `null` otherwise. This is a queue ticket id, not
   * an `InstanceId`, and is kept in its own field so it can never be
   * mistaken for one (the bug this field's addition fixes: `instanceId`
   * used to carry this same value, disguised as a real instance).
   */
  placementId: string | null;

  attach?: {
    wsUrl: string;
    ticket: string;
    expiresAt: number;
    proxyWsUrl?: string;
  };

  node: { nodeId: NodeId; region: string | null; labels: Readonly<Record<string, string>> };

  targets?: readonly TargetSummary[];

  profile: {
    profileId: ProfileId | null;
    key: string;
    mode: 'ephemeral' | 'persistent' | 'template';
    created: boolean;
    sizeBytes: number | null;
  };

  reused: boolean;
  reuseReason: 'warm' | 'profile-shared' | 'sticky' | 'idempotent' | null;

  queue?: {
    position: number;
    ahead: number;
    estimatedWaitMs: number | null;
    pollAfterMs: number;
    expiresAt: number;
  };

  rejectedOverrides: readonly RejectedOverrideView[];
  effectiveSpec: BrowserSpec;

  timings: {
    admissionMs: number;
    placementMs: number;
    profileMs: number;
    launchMs: number;
    totalMs: number;
  };

  expiresAt: number;
  fence: number;
}

/**
 * `acquire()`'s return value. `acquire` itself
 * resolves once placement and profile leasing have succeeded, where the
 * interesting failures live; the handle's `ready` promise resolves at
 * first frame (in this build, once the node reports the instance `ready`
 * and its initial target list). `async: true` keeps its existing meaning
 * and never returns a handle, only an `AcquireResult` with
 * `state: 'launching'`.
 */
export interface AcquireHandle {
  result: AcquireResult;
  /** Resolves once the instance is fully ready (first frame, in a full build); rejects if launch fails after this point. */
  ready: Promise<AcquireResult>;
}

// ── restart (manual only) ───────────────────────────────────────────────

/** `BrowserRouter.restart`'s options. */
export interface RestartOptions {
  /** Capped at 200 bytes by the wire layer; stored as `Instance.stateReason` verbatim. */
  reason?: string;
  /** Default `true`. `false` destroys the profile directory and relaunches onto a fresh one at the same identity (same persistent key, or the same instance-derived ephemeral key); requires the caller to also hold `profile.write` (enforced at the wire layer, `@browserglass/protocol`'s `PARAMETER_DEPENDENT_CAPABILITY_RULES`). */
  preserveProfile?: boolean;
}

/** `BrowserRouter.restart`'s success shape: everything a caller needs to reconnect a fresh `CdpBridge` to the relaunched browser. */
export interface RestartResult {
  instanceId: InstanceId;
  cdpWsUrl: string;
  browserGuid: string;
  pid: number | null;
  startedAt: number;
  profileId: ProfileId | null;
  fence: number;
}

// ── drive (the authority gate) ─────────────────────────────────────────

/**
 * `BrowserRouter.driveInstance`'s result: the authority gate's answer to
 * "where does this instance live, and may this principal touch it right
 * now". Every driving surface (REST, CLI,
 * MCP, CDP passthrough, WS input) resolves through this before acting,
 * rather than reading `store.getInstance` or scanning its own process
 * local `SessionRegistry` directly.
 */
export interface DriveResolution {
  instanceId: InstanceId;
  nodeId: NodeId;
  sessionId: string;
  /**
   * True when `nodeId` is this router process's own node: the caller may
   * drive the instance directly through whatever local session machinery
   * it already has (a `ManagedSession` in `server`'s own `SessionRegistry`,
   * for instance), with no round trip through `BrowserRouter.dispatchAction`
   * or `NodeTransport.dispatch` at all, which is the "data path... run
   * direct" half of the router/data plane split. False: the
   * instance lives on another node and can only be reached by forwarding,
   * either through `dispatchAction` or a direct `nodes.dispatch(nodeId, ...)`
   * call.
   */
  local: boolean;
}

// ── attach credentials ──────────────────────────────────────────────────

/**
 * Mints the real, redeemable WS credential `attach()`/`acquire()` hand
 * back once an instance is ready: a bearer credential
 * (`AttachCredential.token`) plus the URL a client can actually dial
 * (`AttachCredential.wsUrl`). Injected by the server layer at
 * construction (`BrowserRouterOptions.attachCredentials`), never built
 * here: this package never imports `@browserglass/server`
 * or `@browserglass/core`, and only the server holds a JWT signing key
 * (`TokenApi`) and knows its own public address (`ResolvedConfig.publicUrl`/
 * `.wsPath`). Before this port existed, `attach()`/`buildResult()` faked
 * both fields directly (`newId('tkt')` for the token, the literal string
 * `ws://local/<nodeId>` for the URL), which no client could ever redeem:
 * `mintTicket`/`TicketRegistry` (`@browserglass/server`'s own real,
 * atomic, single-use mechanism) was reachable from nothing that produced
 * an `AcquireResult`/`AttachResult`. See `BrowserRouter`'s constructor
 * comment on `attachCredentials` for the fallback this package uses when
 * nothing is injected.
 */
export interface AttachCredentialIssuer {
  issue(req: AttachCredentialRequest): Promise<AttachCredential>;
}

/** Input to {@link AttachCredentialIssuer.issue}. */
export interface AttachCredentialRequest {
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly instanceId: InstanceId;
  readonly sessionId: string;
  /**
   * The caller this credential is minted for, carried as the token's
   * `sub`. Not itself an authorization decision: `attach()`/`buildResult()`
   * have already run `assertScopeAllowsInstance` on `principal` by the
   * time this is called.
   */
  readonly sub: string;
  /**
   * Already narrowed against `AttachRequest.capabilities`'s "narrow only,
   * never widen" contract (`narrowCapabilities`, below): never wider than
   * what the caller's own `principal.caps` already holds.
   */
  readonly capabilities: readonly Capability[];
  readonly ttlMs: number;
}

/**
 * Result of {@link AttachCredentialIssuer.issue}. Field names match
 * `AttachResult.attach`/`AcquireResult.attach` exactly (`ticket`, not
 * `token`): this IS that wire shape, not an internal one translated later.
 */
export interface AttachCredential {
  readonly ticket: string;
  readonly wsUrl: string;
  readonly expiresAt: number;
}

/**
 * `AttachRequest.capabilities`'s "narrow only, never widen" contract,
 * applied once, here, so `attach()` and `buildResult()` (`acquire()`'s
 * own credential mint) agree on what it means: everything in `held` that
 * `requested` also names, or all of `held` when nothing was requested.
 * `requested` naming a capability `held` does not have is silently
 * dropped, never granted: this is a narrowing filter, not a request for
 * more.
 */
export function narrowCapabilities(
  held: readonly Capability[],
  requested: readonly Capability[] | undefined,
): readonly Capability[] {
  if (requested === undefined) return held;
  const wanted = new Set(requested);
  return held.filter((c) => wanted.has(c));
}

// ── attach / release ────────────────────────────────────────────────────

/** `BrowserRouter.attach`'s request shape. */
export interface AttachRequest {
  instanceId: InstanceId;
  /** Narrow only, never widen. */
  capabilities?: readonly Capability[];
  ticketTtlMs?: number;
  subject?: string;
}

/** `BrowserRouter.attach`'s success shape. `attach` never launches, queues, or waits. */
export interface AttachResult {
  instanceId: InstanceId;
  sessionId: string;
  attach: { wsUrl: string; ticket: string; expiresAt: number; proxyWsUrl?: string };
  node: { nodeId: NodeId; region: string | null };
  targets: readonly TargetSummary[];
  viewers: readonly {
    viewerId: string;
    displayName: string | null;
    controlOf: readonly string[];
  }[];
  fence: number;
}

/** `BrowserRouter.release`'s options. */
export interface ReleaseOptions {
  reason?: string;
  profile?: ProfileAction;
  /** Default 3000. */
  gracefulMs?: number;
  /** Default 4006, `InstanceReleased`. */
  closeCode?: number;
  /**
   * Terminate the browser even when other viewers are still attached to
   * it. Default `false`.
   *
   * Release is viewer-aware: once `sticky` reuse
   * hands the same instance to several viewers (two tabs of the same user,
   * or a shared workspace), one viewer's `pagehide` releasing that
   * instance tears the browser out from under everybody else still
   * watching it. A caller who is one of those viewers leaves this unset,
   * and `release()` terminates only when it is the last one out.
   *
   * Set `true` by every release this router takes on its own initiative
   * (the reaper's TTL/duration/idle sweeps, `drainNode`, capacity
   * eviction): those are operator or lifecycle decisions that must end the
   * instance whether or not somebody is still watching, exactly as they
   * did before this option existed.
   */
  force?: boolean;

  /**
   * End BrowserGlass's involvement with this instance but LEAVE THE
   * BROWSER RUNNING, by asking the owning node for `TerminateMode`'s
   * `'detach'` instead of the graceful-then-force ladder. Absent by
   * default, and absent is the only safe default.
   *
   * This is here for the case where the browser was never ours. Point
   * BrowserGlass at a `runtime-remote` endpoint (an operator registered
   * CDP port, which in practice is a person's own signed in Chrome) and a
   * plain release sends that browser `Browser.close`. If the person was
   * halfway through a long checkout form in it, the browser closes under
   * them mid task, and the one outcome nobody can undo is the one where
   * the form MIGHT already have been submitted.
   *
   * Typed `true` rather than `boolean` deliberately. Under this repo's
   * `exactOptionalPropertyTypes`, that makes `leaveBrowserRunning: false`
   * and `leaveBrowserRunning: someFlag` both compile errors, so the only
   * spelling that type checks is the literal, deliberate one. A mode that
   * leaves a browser running should not be reachable by threading a
   * variable that happened to be true, and it should never appear in an
   * options object that was built by spreading somebody else's defaults.
   *
   * Asking is not the same as getting it. The owning node refuses a
   * detach for any runtime that launched the browser itself
   * (`LocalNode.terminate`'s ownership guard), because detaching from a
   * browser BrowserGlass spawned leaks the process rather than protecting
   * anybody's work. `ReleaseResult.outcome` reports which of the two
   * actually happened; do not assume.
   */
  leaveBrowserRunning?: true;
}

/**
 * `BrowserRouter.release`'s result, added with `ReleaseOptions.force` so a
 * caller can tell the two outcomes apart rather than assuming the browser
 * is gone the moment the call resolves. `release()` returned `void` before
 * this, which is why the viewer-aware path needed a result at all: "we did
 * not terminate, because N other viewers are still attached" has to be
 * reported honestly, not signalled by silence.
 */
export interface ReleaseResult {
  instanceId: InstanceId;
  /**
   * `terminated`: the browser was killed and the instance row is
   * `released`. `detached`: other viewers are still attached, so this
   * caller's own hold was dropped and the instance was left running (see
   * `remainingViewers`). `already_released`: the instance was already
   * `released` or `failed`, the idempotent no-op this method has always
   * performed. `browser_detached`: the caller asked for
   * `ReleaseOptions.leaveBrowserRunning` and the owning node confirmed it
   * honoured that, so the instance row is `released` and the browser
   * itself is still open, still signed in, and no longer BrowserGlass's
   * business.
   *
   * `detached` and `browser_detached` are genuinely different answers and
   * a caller that conflates them will be wrong about the browser half the
   * time. `detached` means this release did nothing at all because
   * somebody else is still watching; the instance stays live and
   * reusable. `browser_detached` means this release finished the instance
   * and deliberately left the browser process alone.
   *
   * `browser_detached` is earned rather than assumed: `release()` reports
   * it only when the node's own `TerminateResult.effective` came back
   * `'detach'`, which it does not when the node refused the detach
   * because the runtime had launched that browser itself. Asking for a
   * detach and getting `terminated` back is a normal, correct answer.
   */
  outcome: 'terminated' | 'detached' | 'already_released' | 'browser_detached';
  /** Live viewers still attached, as reported by `LiveViewerPort`. Always 0 on a `terminated` outcome. */
  remainingViewers: number;
}

/**
 * How many live viewers are attached to an instance right now, injected
 * into `BrowserRouter` by whichever process owns the data plane.
 *
 * This package cannot count viewers itself and must not pretend to: it
 * never holds a CDP connection or a viewer socket (it depends on
 * `@browserglass/protocol` only), the node heartbeat carries
 * node-wide `NodeLoad` with no per instance viewer figure, and while
 * `Store.listViewers` exists, nothing in this build ever calls
 * `Store.createViewer`, so that table is empty for every live session. The
 * real viewer set lives in `@browserglass/server`'s session layer, one
 * layer above this one, which is why this is a port rather than a counter
 * kept here.
 *
 * Left uninjected, `BrowserRouter` uses a constant 0, which is exactly the
 * value `doAcquire` hardcoded for `canShare`'s viewer limit check before
 * this port existed: an uninjected router behaves precisely as it did
 * before, and a wired one starts enforcing both the share viewer limit and
 * viewer-aware release.
 *
 * CONTRACT for an implementation: report the viewers attached at the
 * moment of the call. A viewer that is going away is expected to have
 * dropped its own connection before it asks the router to release (a
 * browser tab's socket closes on `pagehide` before its release beacon
 * lands), so a non-zero count here means somebody OTHER than the caller is
 * still watching.
 */
export interface LiveViewerPort {
  countFor(instanceId: InstanceId): number;
}

// ── describe / list / topology ─────────────────────────────────────────

/** A read view of one `Instance`, `BrowserRouter.describe`/`list`'s result element. */
export interface InstanceView {
  instance: Instance;
  live: { viewers: number; streams: number; lastActivityAt: number } | null;
}

/** Filter accepted by `BrowserRouter.list`. */
export interface InstanceListFilter {
  state?: InstanceLifecycleState | readonly InstanceLifecycleState[];
  poolId?: PoolId;
  subject?: string;
  limit?: number;
}

/** `BrowserRouter.topology`'s result: one row per node, single node builds return exactly one. */
export interface TopologyView {
  nodes: readonly {
    nodeId: NodeId;
    state: string;
    load: { liveInstances: number; warmInstances: number; launchingInstances: number };
    lastHeartbeatAt: number;
    drain: { deadlineAt: number; mode: 'graceful' | 'force' } | null;
  }[];
}

/** `BrowserRouter.drainNode`'s options. */
export interface DrainOptions {
  mode?: 'graceful' | 'force';
  /** Default `config.drainDefaultDeadlineMs` (900000). */
  deadlineMs?: number;
  /** Default `config.drainForceGraceMs` (300000). */
  forceAfterMs?: number;
  reason?: string;
}

/**
 * `BrowserRouter.drainNode`'s result. Single node builds have no
 * relocation target: `relocate()` always resolves `{ relocated: false }`
 * and falls through to release in place. The interface shape is kept so a
 * future multi node build slots a real relocation target in without an
 * API change.
 */
export interface DrainHandle {
  nodeId: NodeId;
  deadlineAt: number;
  /** Registers a callback fired once every instance on the draining node has released. */
  onEmpty(cb: () => void): void;
  /** Single node: never relocates, always resolves `{ relocated: false }`. */
  relocate(instanceId: InstanceId): Promise<{ relocated: false }>;
}

// ── the profile service seam ────────────────────────────────────────────

/**
 * The slice of the Profile Service `BrowserRouter` and `LocalNode` depend
 * on. `packages/router/src/profiles/**` implements it (through
 * `ProfileServicePortAdapter`); this interface is the injection seam so
 * `BrowserRouter` can be built and tested against a fake without either
 * side changing shape.
 */
export interface ProfileServicePort {
  /** Resolves a `ProfileSpec` request into a `ResolvedProfileSpec`, optionally creating a `creating` row. `dryRun` defaults to `true`. */
  resolve(req: {
    tenantId: string;
    appId: string;
    spec: ProfileSpec;
    dryRun?: boolean;
  }): Promise<ResolvedProfileSpecResult>;

  /** The atomic, fenced lease grant. Throws `E_PROFILE_BUSY` on contention. */
  lease(req: {
    tenantId: string;
    appId: string;
    spec: ResolvedProfileSpec;
    instanceId: string;
    nodeId: string;
    ttlMs: number;
    /** See `ProfileAcquireRequest.reclaimFromHolderInstanceId`. */
    reclaimFromHolderInstanceId?: string;
  }): Promise<ProfileLeaseGrant>;

  /**
   * Renews `req.instanceId`'s already-held profile lease in place (a TTL
   * heartbeat, same fence, same materialised directory) instead of
   * releasing and re-acquiring it. `BrowserRouter.restart()`'s
   * `preserveProfile: true` path (the common case, and the default) uses
   * this rather than `lease()`, since the relaunch reuses the exact same
   * profile the terminated browser was already, uninterruptedly, leasing.
   * Throws `E_PROFILE_NOT_FOUND` if `instanceId` holds no tracked lease.
   */
  renewForRestart(req: { instanceId: string; ttlMs: number }): Promise<ProfileLeaseGrant>;

  /**
   * Releases a lease without throwing, used on every acquire failure path
   * after a lease was granted.
   *
   * `identity` exists because an implementation backed by an in memory
   * lease map (which the real one is) has no record of a lease granted
   * before a restart, and used to return silently for exactly that case.
   * The store row then stayed open forever, and since a profile's single
   * unreleased lease is what `Store.getProfile` reports, the next acquire
   * on the same persistent key failed `E_PROFILE_BUSY` against a holder
   * that no longer existed. Passing the profile this lease is on lets the
   * implementation go to the store instead of guessing. Optional, so a
   * caller that genuinely does not know the profile (there is one: the
   * acquire path's failure branch, where the lease may not have been
   * granted yet) is unchanged.
   *
   * `browserConfirmedGone` must only be set by a caller that has
   * positively confirmed the browser process is dead. It is what
   * distinguishes a stale lease from one something may still be renewing,
   * in the window before the TTL expires.
   */
  releaseLeaseQuietly(
    instanceId: string,
    identity?: { tenantId: string; profileId: string; browserConfirmedGone?: boolean },
  ): Promise<void>;

  /** The node currently holding this profile's authoritative copy, if any. */
  homeOf(
    tenantId: string,
    key: string,
  ): Promise<{ nodeId: string; replicas: readonly string[] } | null>;

  /** The materialised, node local directory for an already leased profile, keyed by its prefixed `storedKey`, for `LocalNode` to build a runtime `LaunchRequest`. */
  materialisedPathFor(storedKey: string): Promise<{ path: string; containerPath: string | null }>;

  /**
   * Executes `profileAction` against a leased profile at release time
   * (one of the four `ProfileAction` values).
   *
   * `tenantId` is the same fix as `releaseLeaseQuietly`'s `identity`, on
   * the other half of the teardown. The real implementation recovered the
   * tenant from its in memory lease map, which is empty for any lease
   * granted before a restart, and returned silently when it came up empty.
   * That silence is the disk half of the leak the lease fix addresses in
   * the database: a profile released after a restart never had its
   * directory trashed at all. Optional so the field can be omitted by a
   * caller that does not have it, but `BrowserRouter.release()` always
   * does, since it holds the principal.
   */
  applyReleaseAction(req: {
    instanceId: string;
    profileId: string;
    action: ProfileAction;
    tenantId?: string;
  }): Promise<void>;

  /**
   * Whether `granteeAppId` holds a cross app share grant on `profileId` at
   * `level` or above (a per profile grant row, never a pool level
   * boolean). `protocol`'s `Store` has no dedicated query for
   * `profile_share_grants`; this method is the seam an implementation
   * fills with one.
   */
  hasShareGrant(profileId: string, granteeAppId: string, level: 'read' | 'write'): Promise<boolean>;
}

/** `ProfileServicePort.resolve`'s result. */
export interface ResolvedProfileSpecResult {
  resolved: ResolvedProfileSpec;
  /** Set when `dryRun` is `false` and this call created the profile row. */
  created: boolean;
}

/** `ProfileServicePort.lease`'s result. */
export interface ProfileLeaseGrant {
  profileId: string;
  storedKey: string;
  fence: number;
  source: 'empty' | 'template' | 'restore' | 'import';
  expiresAt: number;
}

// ── launch attempt bookkeeping ─────────────────────────────────────────

/** One entry in `E_LAUNCH_FAILED.details.attempts[]`. */
export interface LaunchAttempt {
  nodeId: NodeId;
  error: { code: string; message: string; stderrTail: string | null };
}
