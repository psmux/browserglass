import { createHmac, randomBytes } from 'node:crypto';
import {
  type AuditSink,
  type BrowserRuntime,
  type Instance,
  type MetricsSink,
  type NodeId,
  type NodeTransport,
  type ProfileId,
  type ProfileLease,
  type QuotaProvider,
  type RuntimeInventoryEntry,
  type Store,
  newId,
} from '@browserglass/protocol';
import {
  type AttachCredential,
  type AttachCredentialIssuer,
  type AttachCredentialRequest,
  BrowserRouter,
  type Clock,
  DEFAULT_PROFILE_SERVICE_CONFIG,
  DEFAULT_ROUTER_CONFIG,
  LIVE_INSTANCE_STATUSES,
  type LiveViewerPort,
  LocalNode,
  LocalNodeTransport,
  NULL_PLACEMENT_SIGNALS,
  type NodeActionExecutor,
  NodeRegistry,
  ProfileService,
  ProfileServicePortAdapter,
  ScoredPlacementPolicy,
  WebSocketNodeTransport,
  systemClock,
} from '@browserglass/router';
import type { TokenApi } from '../auth/types.js';
import { type Logger, noopLogger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import { compact } from '../util/compact.js';

/** Default concurrent Chrome launches this node permits when nothing more specific is known. */
const DEFAULT_LAUNCH_CONCURRENCY = 2;

/** `AuditSink` used when `observability.auditSink` is unset. Discards every event. */
export const noopAuditSink: AuditSink = Object.freeze({
  emit: () => undefined,
  flush: async () => undefined,
});

/** `MetricsSink` used when `observability.metricsSink` is unset. Discards every measurement. */
export const noopMetricsSink: MetricsSink = Object.freeze({
  counter: () => undefined,
  gauge: () => undefined,
  histogram: () => undefined,
});

/**
 * Builds a `QuotaProvider` from `ResolvedConfig.limits`, single tenant and
 * single app in embedded mode: `maxInstances` and `maxInstancesPerApp`
 * share one ceiling, because this build has exactly one app per gateway
 * process.
 */
export function quotaProviderFromLimits(config: ResolvedConfig): QuotaProvider {
  return {
    async limits() {
      return {
        maxInstances: config.limits.maxInstances,
        maxInstancesPerApp: config.limits.maxInstances,
        maxInstancesPerUser: config.limits.maxInstancesPerSubject,
        maxViewers: config.limits.maxViewersPerSession,
        maxProfiles: 100_000,
        maxProfileBytes: config.profiles.maxBytesPerProfile,
        maxSessionMinutesPerDay: 24 * 60 * 100,
        maxAcquiresPerMinute: config.limits.acquireRatePerMinute,
        maxFrameBytesPerMinute: 500 * 1024 * 1024,
      };
    },
  };
}

/**
 * The real `AttachCredentialIssuer` `BrowserRouter.attachCredentials`
 * takes: the router package cannot build one itself (see that port's own
 * doc in `@browserglass/router`'s `types.ts`), so this is the
 * one place a signing key and a public address actually come together.
 *
 * The ticket half reuses the SAME bearer JWT path
 * `ws/connection.ts`'s `buildWelcome` already mints a `sessionToken`
 * through (`this.deps.tokenApi.issueWithMeta({ scope: { kind: 'instance',
 * ... } })`) and `examples/nextjs-demo/app/api/browser/route.ts` mints
 * its own credential through by hand today: a signed, verifiable,
 * instance-scoped token `ws/credentials.ts`'s `resolveJwt` already
 * accepts over `hello.auth`. This is deliberately NOT `mintTicket`/
 * `TicketRegistry` (`auth/tickets.ts`)'s opaque `tkt_` mechanism: that
 * credential is redeemed over a `?ticket=` URL query carrier
 * (`ws/credentials.ts`'s four-carrier precedence, `extractPreUpgradeCarriers`),
 * and every client in this monorepo, including the one this fix's own
 * acceptance probe drives (`clients/python/src/browserglass/transport.py`'s
 * `hello.auth = {scheme:'bearer', token}`), sends whatever `attach.ticket`
 * contains over `hello.auth` instead. A `tkt_` string handed to
 * `resolveJwt`'s `AuthResolver.verify` would fail to parse as a JWT and
 * closes 4200 on every real client this build ships; a signed token
 * redeemed the way every existing caller already redeems one does not.
 *
 * `iUnderstandAdmin: true` unconditionally: `req.capabilities` is already
 * narrowed to (at most) what the requesting `principal.caps` held before
 * this issuer is ever called (`BrowserRouter.attach`'s `narrowCapabilities`
 * call, `buildResult`'s own direct pass-through), so acknowledging here
 * grants nothing new, it only lets `TokenApiImpl.issueWithMeta` re-issue a
 * credential for a capability set the caller already legitimately holds
 * without also making every attach caller pass its own acknowledgement
 * flag through two more layers of request shape it does not otherwise
 * need.
 *
 * The URL half prefers `config.publicUrl` (operator configured, correct
 * behind any proxy/load balancer) converted to a `ws`/`wss` origin plus
 * `config.wsPath`; with no `publicUrl` configured (this SDK's default,
 * and `examples/nextjs-demo/server.mjs`'s own setup before this fix) it
 * returns `config.wsPath` alone, exactly the value
 * `examples/nextjs-demo/app/api/browser/route.ts` already returns as
 * `wsPath` today for its own working credential. A bare path is not a
 * dialable URL by itself; `packages/server/src/rest/routes/instances.ts`'s
 * `resolveAttachUrl` is the other half of this fix, completing it against
 * the actual REST request's own Host header, the one piece of information
 * only a live request (not this construction-time closure) has.
 */
export function attachCredentialIssuerFor(
  config: ResolvedConfig,
  tokens: TokenApi,
): AttachCredentialIssuer {
  const wsUrl = wsUrlFor(config);
  return {
    async issue(req: AttachCredentialRequest): Promise<AttachCredential> {
      const ttlSeconds = Math.max(1, Math.round(req.ttlMs / 1000));
      const issued = await tokens.issueWithMeta({
        sub: req.sub,
        caps: [...req.capabilities],
        iUnderstandAdmin: true,
        scope: compact({
          kind: 'instance' as const,
          instanceId: req.instanceId,
          targets: '*' as const,
          sessionId: req.sessionId !== '' ? req.sessionId : undefined,
        }),
        tenantId: req.tenantId,
        appId: req.appId,
        ttlSeconds,
      });
      return { ticket: issued.token, wsUrl, expiresAt: issued.expiresAt };
    },
  };
}

/**
 * `config.publicUrl` (`https://gateway.example`) converted to the
 * `ws`/`wss` origin a socket actually dials, plus `config.wsPath`. Falls
 * back to `config.wsPath` alone when no `publicUrl` is configured: see
 * {@link attachCredentialIssuerFor}'s own doc for why a bare path is still
 * the right answer here rather than guessing at a host this closure, built
 * once at process construction time, has no request to read one from.
 */
function wsUrlFor(config: ResolvedConfig): string {
  if (config.publicUrl === null || config.publicUrl === '') return config.wsPath;
  try {
    const u = new URL(config.publicUrl);
    const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${u.host}${config.wsPath}`;
  } catch {
    return config.wsPath;
  }
}

/** Everything `start()` needs to drive the router and profile service, and `stop()` needs to unwind them in order. */
export interface RouterWiring {
  readonly router: BrowserRouter;
  readonly profileService: ProfileService;
  readonly nodeTransport: NodeTransport;
  readonly nodeRegistry: NodeRegistry;
  readonly nodeId: NodeId;
  /**
   * The pending orphan sweep this boot armed. Optional because a
   * `RouterWiring` assembled by hand
   * (conformance tests do this, and a future `mode: 'gateway'` path would)
   * never ran a sweep, and saying so by absence is more honest than
   * requiring every such caller to synthesise an empty handle.
   *
   * A HANDLE rather than a report, because the sweep has not run by the
   * time `start()` resolves and must not have: see
   * {@link scheduleOrphanSweep}. `stop()` cancels it through this field.
   */
  readonly orphanSweep?: OrphanSweepHandle;
  /**
   * The running profile trash sweep timer. Optional for the same reason as
   * `orphanSweep`: a `RouterWiring` assembled by hand never started one.
   * `stop()` cancels it through this field.
   */
  readonly profileMaintenance?: ProfileMaintenanceHandle;
}

/**
 * The `stateReason` every row this sweep retires carries, and the release
 * reason its profile lease carries. Deliberately one distinct string rather
 * than reusing `'terminate_failed'` or `'ttl_expired'`: those two mean
 * "something tried to release this and could not", and this one means
 * "nothing ever will, because the process that owned it is gone". An
 * operator reading `instances.status_detail` can tell the two apart, which
 * is the whole reason a past reaper stall took as long to diagnose as it
 * did.
 */
export const ORPHANED_BY_RESTART = 'orphaned_by_restart';

/** What one orphan sweep did. Every row this process examined lands in exactly one of the arrays below, or in none of them when the row was already accounted for by a live handle this node holds. */
export interface OrphanSweepReport {
  /** Rows moved to `'failed'` with `stateReason: 'orphaned_by_restart'`, and whose profile lease was released. */
  readonly reaped: readonly string[];
  /**
   * Rows the runtime still reports a LIVE browser for, which this sweep
   * adopted on a second attempt after `reattachSurvivors` had already
   * failed to. Not reaped: the browser is real.
   */
  readonly adopted: readonly string[];
  /**
   * Rows where a browser is still out there (`'live'`, `'orphan'`, or
   * `'foreign'` in the runtime inventory) and this node could not take a
   * handle on it. Deliberately left in a live status: marking a row
   * terminal while its Chrome keeps running is a bug of its own: it leaks the process forever because nothing is left to release
   * it against. These keep failing every reaper tick, so they are reported
   * rather than swallowed.
   */
  readonly unreachable: readonly string[];
  /**
   * Rows left alone because their profile lease is still being renewed, so
   * some OTHER live process owns them. This is the array that exists
   * because of a defect: the first version of this sweep had no such test,
   * and a second `node server.mjs` started by mistake retired a healthy
   * gateway's instances before dying on `EADDRINUSE`. See
   * {@link liveOwnerVerdict}.
   */
  readonly skippedLiveOwner: readonly string[];
  /**
   * Rows this sweep refused to judge, because it could not establish
   * either way whether a live process owns them (see
   * {@link liveOwnerVerdict}'s `'undecidable'` case). Left in a live
   * status on purpose. Leaving a phantom row costs a stale database entry
   * the router's own TTL reaper can still retire; wrongly reaping costs a
   * user their running browsers.
   */
  readonly skippedUndecidable: readonly string[];
  /** True when the sweep only considered rows carrying this node's own id. See {@link orphanSweepScope}. */
  readonly scopedToOwnNodeId: boolean;
  /** Set when the sweep could not run at all (the store threw). Nothing else changes; the rows simply stay as they are. */
  readonly failure: string | null;
  /** True when the sweep never ran because `stop()` cancelled it first. Every array is empty. */
  readonly cancelled: boolean;
}

/** An empty report, for `mode: 'gateway'`, for a sweep `stop()` cancelled, and for tests that never run one. */
const NO_ORPHAN_SWEEP: OrphanSweepReport = Object.freeze({
  reaped: Object.freeze([]) as readonly string[],
  adopted: Object.freeze([]) as readonly string[],
  unreachable: Object.freeze([]) as readonly string[],
  skippedLiveOwner: Object.freeze([]) as readonly string[],
  skippedUndecidable: Object.freeze([]) as readonly string[],
  scopedToOwnNodeId: true,
  failure: null,
  cancelled: false,
});

/**
 * `NewNode.registrationSecretEnc` is required by `store-sqlite`'s schema
 * (`nodes.registration_secret_enc TEXT NOT NULL`, that column's own DDL
 * comment: "used for attach ticket MACs"), but nothing in this build reads
 * it back for verification: no attach ticket MAC path exists yet
 * (`docs/scaling.md`). An earlier version refused to fake it with a
 * dummy string and left `resolveNode()` read only rather than invent one
 * (`BrowserRouter.resolveNode`'s own doc comment); this derives real key
 * material instead:
 *
 * - When `config.peer.sharedSecret` is set (the SAME secret
 *   `WebSocketNodeTransport`'s hello handshake actually authenticates a
 *   peer connection with, `nodeAuth.ts`), an HMAC of this node's own id
 *   under that secret ties the stored value to real, operator supplied
 *   key material. A future attach-ticket-MAC feature that starts reading
 *   this column back gets something genuine to build on, not a decorative
 *   default to retrofit; today, nothing reads it, so this derivation
 *   protects nothing by itself, it just avoids lying about what is
 *   stored there.
 * - When no peer secret is configured (a single node deployment with no
 *   cross node link intended), there is nothing meaningful to derive
 *   from, so this mints fresh random bytes instead: still real key
 *   material, simply not tied to anything else, which is honest because
 *   nothing in this build consults this column either way.
 */
function deriveRegistrationSecretEnc(nodeId: string, peerSharedSecret: string | null): string {
  if (peerSharedSecret !== null)
    return createHmac('sha256', peerSharedSecret).update(nodeId).digest('hex');
  return randomBytes(32).toString('hex');
}

/**
 * Reattaches `localNode` to every survivor `runtime` already adopted at
 * construction time, so a restarted gateway does not orphan them. Nothing in
 * `@browserglass/server` ever called `LocalNode.attach()` before this:
 * `HostRuntime.create()` (`runtime-host/src/runtime.ts`) runs the full
 * startup reattach algorithm and registers every confirmed survivor into
 * its own internal `live` map before this function ever sees the runtime,
 * but `LocalNode` keeps a second, independent handle map
 * (`LocalNode.handles`, see that class's own comment) because
 * `NodeTransport.terminate(nodeId, instanceId, mode)` carries only the
 * instance id, never a handle. With that second map empty,
 * `LocalNode.terminate()` threw `no launched handle for instance ...` for
 * every reattached survivor; the throw was swallowed by both
 * `BrowserRouter.release()`'s old terminate catch and `stop.ts`'s phase 5,
 * and the DB row flipped to `released` while the Chrome process kept
 * running, invisible to every later reaper/list sweep.
 *
 * `runtime.attach()` is idempotent for an instanceId the runtime already
 * has in its own `live` map (`HostRuntime.attach`'s `existingLive` fast
 * path), so this loop costs no relaunch and no fresh CDP round trip beyond
 * the `list()` call itself: it just hands `LocalNode` the handle the
 * runtime already built. Best effort per entry: a survivor this loop
 * cannot reattach is picked up by {@link reapOrphanedInstances} below,
 * which retries the adoption and, failing that, reports the instance as
 * unreachable rather than failing the whole boot here. That comment used
 * to name `router.start()`'s "startup reconcile" as the safety net.
 * `BrowserRouter.start()` performs no reconciliation of any kind, so
 * there was no safety net at all until the sweep existed.
 */
async function reattachSurvivors(
  runtime: BrowserRuntime,
  localNode: LocalNode,
  clock: Clock,
): Promise<string[]> {
  const adopted: string[] = [];
  for (const entry of await runtime.list()) {
    if (entry.status !== 'live') continue;
    if (await adoptSurvivor(runtime, localNode, entry, clock)) adopted.push(entry.instanceId);
  }
  return adopted;
}

/**
 * Points the store rows of browsers this process just adopted at this
 * process's own node id.
 *
 * Adoption gives `LocalNode` a handle, but the row still names the node of
 * the process that launched the browser. Without a configured
 * `peer.nodeId` every boot mints a fresh id, so after a crash and restart
 * the row named a node that no longer existed. Reuse by profile key then
 * handed that row out, and the attach failed with "driven by node X, not
 * this gateway" although this gateway was the one holding the browser.
 *
 * Only rows in `'live'` are moved, by a compare and set on that status,
 * so a row something else changed in the meantime is left alone. Returns
 * the ids it moved. Best effort per row: a failed write leaves the row as
 * it was, which acquire then treats as owned by an unreachable node.
 */
export async function rehomeAdoptedRows(
  store: Store,
  nodeId: NodeId,
  adoptedInstanceIds: readonly string[],
  logger: Logger,
): Promise<string[]> {
  const moved: string[] = [];
  if (adoptedInstanceIds.length === 0) return moved;
  const wanted = new Set(adoptedInstanceIds);
  for (const tenant of await store.listTenants().catch(() => [])) {
    for (const id of wanted) {
      const row = await store.getInstance(tenant.id, id).catch(() => null);
      if (row === null) continue;
      wanted.delete(id);
      if (row.nodeId === nodeId) continue;
      const ok = await store
        .transitionInstance(tenant.id, id, ['live'], 'live', { nodeId })
        .catch(() => false);
      if (ok) {
        moved.push(id);
        logger.info(
          { instanceId: id, fromNodeId: row.nodeId, nodeId },
          'reconcile: an adopted browser now belongs to this node',
        );
      }
    }
  }
  return moved;
}

/**
 * Hands `localNode` a handle for one browser the runtime reports as live,
 * returning whether it worked. Factored out of {@link reattachSurvivors}
 * because {@link reapOrphanedInstances} needs exactly the same operation
 * for a row it must NOT reap: a store row whose browser is still running
 * but which the first pass failed to adopt (a slow CDP round trip against
 * the 5 second deadline below is the realistic case) has to get a second
 * chance, because the alternative is a row that loops through the reaper
 * forever with nothing on this node able to terminate it.
 */
async function adoptSurvivor(
  runtime: BrowserRuntime,
  localNode: LocalNode,
  entry: RuntimeInventoryEntry,
  clock: Clock,
): Promise<boolean> {
  try {
    const handle = await runtime.attach({
      instanceId: entry.instanceId,
      endpoint: null,
      recovered: {
        pid: entry.pid,
        containerId: entry.containerId,
        profilePath: entry.profilePath,
        cdpUrl: entry.cdpUrl,
        chromeVersion: entry.engineVersion,
        startedAt: entry.startedAt,
      },
      deadlineAt: clock.now() + 5000,
      signal: { aborted: false },
    });
    await localNode.attach(entry.instanceId, handle);
    return true;
  } catch {
    // Best effort; see `reattachSurvivors`'s own comment.
    return false;
  }
}

/**
 * Decides how widely {@link reapOrphanedInstances} is allowed to look, and
 * this is the single most safety relevant decision in this file.
 *
 * The rule the sweep has to honour is "only retire rows THIS node owned".
 * A multi node deployment keeps every node's instances in one `instances`
 * table, and the other nodes' rows are alive, healthy, and none of this
 * process's business. Retiring one of those would mark a working browser
 * dead and free its profile lease out from under the node still using it.
 *
 * The obvious discriminator, `instance.node_id === ourNodeId`, is exactly
 * right whenever this process has a DURABLE identity, which is precisely
 * when `peer.nodeId` is configured (`PeerConfig.nodeId`'s own doc: "a node
 * that restarts then registers as a brand new node, orphaning
 * `Instance.nodeId` rows that pointed at its old id"). With that set,
 * `store.registerNode` upserts on the id, this boot inherits the previous
 * boot's rows, and the equality test finds them.
 *
 * With `peer.nodeId` unset, `buildRouterWiring` mints a fresh id every
 * boot, so the previous boot's rows carry an id this process has never
 * heard of and the equality test finds nothing. That is the exact
 * condition that produced the phantom rows in the first place. The sweep
 * therefore widens to every row, but ONLY when the configuration proves
 * no other node can be sharing this store: `peer.sharedSecret` is what
 * gates both halves of the cross gateway link (`PeerConfig.sharedSecret`:
 * "Required for this node to run a peer listener at all, or to dial
 * another node's peer listener"), and `peer.dataPlaneUrl` is how a peer
 * would be told where to dial. With all three of `nodeId`, `sharedSecret`,
 * and `dataPlaneUrl` unset, this process cannot reach a peer and cannot be
 * reached by one, so any row in this store is a row some earlier
 * incarnation of this same process wrote.
 *
 * The remaining combination, a peer link configured but no durable
 * `peer.nodeId`, stays narrow. It reaps this boot's own rows and nothing
 * else, which leaves last boot's phantoms behind. That is the honest
 * outcome: the deployment has not given this process a way to recognise
 * its own past, and guessing would risk another node's instances. The
 * warning this returns tells the operator to set `peer.nodeId`.
 *
 * Node heartbeat state is deliberately not consulted, in any branch.
 * Nothing in this build ever calls `Store.heartbeatNode` or
 * `Store.setNodeStatus`, so `node_heartbeats` is empty and every `nodes`
 * row sits at `'joining'` forever. A liveness test built on those columns
 * would report every node in the deployment, including this one, as dead.
 * The runtime inventory is the only trustworthy liveness signal at boot,
 * and it is what the sweep itself uses.
 */
export function orphanSweepScope(config: ResolvedConfig): {
  readonly scopedToOwnNodeId: boolean;
  readonly warning: string | null;
} {
  if (config.peer.nodeId !== null) return { scopedToOwnNodeId: true, warning: null };
  if (config.peer.sharedSecret === null && config.peer.dataPlaneUrl === null) {
    return { scopedToOwnNodeId: false, warning: null };
  }
  return {
    scopedToOwnNodeId: true,
    warning:
      'A peer link is configured but peer.nodeId is not, so this node registers under a fresh id every start and cannot recognise the instance rows its own previous boots left behind. Those rows stay in a live status, consume quota, and remain eligible for sticky reuse. Set peer.nodeId (or BGLS_NODE_ID) to the same value across restarts.',
  };
}

/**
 * How long after `start()` the destructive half of the sweep waits before
 * it runs, derived from the profile lease TTL rather than picked.
 *
 * Two separate jobs, both of which need exactly this number.
 *
 * FIRST, it is the only proof of commitment this SDK can actually produce
 * about itself. The coordinator hit the failure this delay exists for: a
 * second `node server.mjs` started by mistake ran `runStart`, retired the
 * FIRST process's healthy instances, and only then tried to bind port 3000,
 * got `EADDRINUSE`, and exited. A stray duplicate start silently killed a
 * working gateway's browsers. The honest fix is not to make the sweep wait
 * for the port bind: `server.listen` is application code outside this SDK,
 * it happens after `start()` resolves, and a library that has not been
 * told about it cannot observe it. What this process CAN observe is its
 * own continued existence. A process that dies during startup, for any
 * reason at all and not only `EADDRINUSE`, never reaches a deferred timer,
 * and `Clock.setTimeout` unrefs its handle so this timer never keeps a
 * process alive that would otherwise exit. Surviving the delay is a weaker
 * claim than "I am serving traffic", and it is stated as exactly that
 * rather than dressed up as more.
 *
 * SECOND, and this is what makes the number principled rather than a round
 * guess, the delay is what turns the profile lease from an ambiguous
 * signal into a decisive one (see {@link liveOwnerVerdict}). Write `T0`
 * for this process's start and `TTL` for the lease TTL. A lease last
 * renewed at `r` expires at `r + TTL`.
 *
 * - If the process that owned a row died at some `d < T0`, its last
 *   renewal was at `r <= d < T0`, so the lease has expired by `T0 + TTL`.
 *   Waiting at least `TTL` therefore guarantees that every lease belonging
 *   to an already dead owner reads as expired. No dead owner is ever
 *   mistaken for a live one.
 * - Conversely, a lease still unexpired at `T0 + TTL` must have been
 *   renewed after `T0`, which only a live process doing the renewing can
 *   have done. No live owner is ever mistaken for a dead one.
 *
 * The half TTL on top is margin for the renewal loop's own tick spacing
 * (`profileLeaseRenewIntervalMs`, one third of the TTL) and for the fact
 * that `expires_at` is stamped by the renewing process's clock rather than
 * the store's, which is exact for two processes on one host and only
 * approximate across hosts.
 */
export function orphanSweepDelayMs(): number {
  return (
    DEFAULT_ROUTER_CONFIG.profileLeaseTtlMs +
    Math.floor(DEFAULT_ROUTER_CONFIG.profileLeaseTtlMs / 2)
  );
}

/** {@link liveOwnerVerdict}'s three answers. `'undecidable'` is not a failure; it is the sweep declining to guess. */
export type LiveOwnerVerdict = 'live-owner' | 'no-live-owner' | 'undecidable';

/**
 * Answers the one question the sweep was originally missing: is some OTHER
 * live process still operating this instance?
 *
 * The first version of this sweep answered it from configuration alone.
 * `orphanSweepScope` reasoned that a process with no peer settings "runs no
 * peer listener and can dial no peer, so by the configuration contract no
 * other node shares this store". That reasoning is sound about NODES in a
 * distributed deployment and false about PROCESSES on one laptop, which is
 * the ordinary case: starting the dev server twice produces two processes
 * with identical configuration, no peer settings, one store, and no peer
 * link between them. The premise held for the exotic case and failed for
 * the everyday one.
 *
 * The replacement is a real liveness check, and it is per row rather than
 * per process, which is what makes it correct: the question is never "is
 * another gateway alive somewhere" but "is anything still operating THIS
 * instance". The signal is the profile lease.
 * `ProfileService.startLeaseRenewal` (armed by `buildRouterWiring` below,
 * on every embedded or supervised boot) renews every lease its process
 * tracks on `profileLeaseRenewIntervalMs`, a third of the TTL, through
 * `Store.heartbeatProfileLease`. So an unexpired, unreleased lease is a
 * store row that some process wrote recently and keeps writing. A dead
 * process stops renewing and its leases lapse within one TTL. Combined
 * with {@link orphanSweepDelayMs}'s wait, that is decisive in both
 * directions.
 *
 * Deliberately NOT built on node heartbeat state, which is the other
 * obvious candidate and does not work: `Store.heartbeatNode` and
 * `Store.setNodeStatus` have zero production callers in this repo, so
 * `node_heartbeats` is empty and every `nodes` row is frozen at
 * `'joining'`. A liveness test on those columns would report every node in
 * the deployment, including the one asking, as dead. The profile lease is
 * the one liveness signal in this store with real production writers.
 *
 * THE LOOKUP KEY IS `profile_leases.instance_id`, not `instances.profile_id`,
 * and it stays that way even though the latter now works.
 *
 * The first version of this function resolved the lease through
 * `instance.profileId`. That column was NULL on every row of every real
 * database at the time: the router does pass `profileId` in the patch that
 * lands an instance on `'live'` (`BrowserRouter.placeAndLaunch`), but
 * `store-sqlite`'s `transitionInstance` built its `UPDATE` from four
 * hardcoded patch fields and silently dropped that one, along with
 * `sessionId`, `fence`, and `readyAt`. So the column read as meaningful,
 * was always empty, and this function returned `'undecidable'` for every
 * row it would ever see: the sweep would have retired nothing, ever,
 * silently, while looking deliberate.
 *
 * That store defect has since been fixed (`transitionInstance` now applies
 * a total rule table keyed on `keyof Instance`, so every field either maps
 * to a column or is rejected by name), and `instances.profile_id` is
 * populated going forward. This function still does not read it, for two
 * reasons. Rows written before that fix keep their null forever, and an
 * upgraded database is exactly what this sweep runs against. And
 * `profile_leases.instance_id` is the column that actually carries the
 * association: it is written by the same statement that creates the lease,
 * rather than by a later patch that something in the chain might drop
 * again.
 *
 * `'undecidable'` now means only one thing: the profile scan behind the
 * index hit its ceiling, so a MISS carries no information (see
 * {@link buildProfileLeaseIndex}). The caller leaves such rows alone. They
 * still count against quota, and the router's own TTL reaper remains their
 * backstop. That is the cost of the safe direction, and it is the right
 * side to be wrong on: a stale row is a database entry, a wrongly reaped
 * row is a user's browser closing under them.
 *
 * A RELEASED instance cannot block a legitimate reap through this
 * function, which is worth stating because released instances really do
 * leave `profile_leases.released_at` null in the live database. Three
 * independent reasons: the sweep only ever asks about rows in
 * `LIVE_INSTANCE_STATUSES`, and `'released'`/`'failed'` are not among
 * them; the index is keyed by the holding instance id, so one instance
 * stale lease can never be mistaken for another instance evidence; and
 * renewal stops at release, so `expires_at` freezes and the lease reads
 * expired within one TTL, which is less than the sweep own delay.
 */
export function liveOwnerVerdict(
  index: ProfileLeaseIndex,
  instance: Instance,
  now: number,
): LiveOwnerVerdict {
  const held = index.byInstance.get(instance.id);
  if (held === undefined) {
    // A miss only means "no live owner" if the index is known to be
    // complete. Hitting the scan ceiling makes a miss meaningless, and
    // guessing in that state is how a live instance gets retired.
    return index.complete ? 'no-live-owner' : 'undecidable';
  }
  // `releasedAt` is belt and braces: `store-sqlite` already filters
  // released leases out of `Profile.lease`, but the `Store` contract does
  // not require that of every implementation.
  if (held.lease.releasedAt !== null) return 'no-live-owner';
  return held.lease.expiresAt > now ? 'live-owner' : 'no-live-owner';
}

/**
 * How many profiles one tenant scan will read. `Store.listProfiles`
 * defaults to 200 and its `cursor` field is not honoured by
 * `store-sqlite`, so this is a real ceiling rather than a page size. A
 * tenant with more profiles than this makes the index incomplete, which
 * {@link liveOwnerVerdict} answers with `'undecidable'` rather than a
 * guess: the sweep does less work, and does no damage.
 */
const PROFILE_SCAN_LIMIT = 10_000;

/**
 * Every unreleased profile lease in one tenant, keyed by the instance
 * holding it, plus whether the scan saw all of them.
 *
 * Built by listing profiles rather than leases because there is NO lookup
 * from an instance id to its lease anywhere on the `Store` port. The lease
 * methods are `acquireProfileLease`, `heartbeatProfileLease`,
 * `releaseProfileLease`, and `expireProfileLeases`, none of which reads
 * one back, and the only way a `ProfileLease` ever reaches a caller is
 * hanging off `Profile.lease`. So this walks profiles and inverts the
 * relation. `ProfileLease.holderInstanceId` is the `profile_leases.instance_id`
 * column, which is the key that actually carries the association.
 *
 * The proper fix is a `Store` method that does this lookup directly, not
 * raw SQL smuggled in behind the port. Until then this is correct, just heavier
 * than it needs to be: one query per tenant per sweep, and the sweep runs
 * once per process lifetime.
 */
export interface ProfileLeaseIndex {
  readonly byInstance: ReadonlyMap<
    string,
    { readonly lease: ProfileLease; readonly profileId: ProfileId }
  >;
  /** False when the scan hit {@link PROFILE_SCAN_LIMIT}, so a MISS proves nothing. */
  readonly complete: boolean;
}

/** Builds a {@link ProfileLeaseIndex} for one tenant. */
export async function buildProfileLeaseIndex(
  store: Store,
  tenantId: string,
): Promise<ProfileLeaseIndex> {
  const profiles = await store.listProfiles(tenantId, { limit: PROFILE_SCAN_LIMIT });
  const byInstance = new Map<string, { lease: ProfileLease; profileId: ProfileId }>();
  for (const profile of profiles) {
    const lease = profile.lease;
    if (lease === null || lease.holderInstanceId === null) continue;
    byInstance.set(lease.holderInstanceId, { lease, profileId: profile.id });
  }
  return { byInstance, complete: profiles.length < PROFILE_SCAN_LIMIT };
}

/**
 * Reconciles the `instances` table against what is actually running on
 * this node, at boot, and retires whatever the store still calls live but
 * nothing can back up. This is step 7 of `runStart`'s documented start
 * sequence. Until it existed, no component anywhere performed that
 * reconciliation: `router.start()` is `markReady()` plus three
 * `setInterval` calls and never reads the store, and
 * `reconcileOnStartup` (`@browserglass/runtime-host`) reconciles the
 * runtime's own state file against real processes with no `Store`
 * reference at all. A row written by a process that later died stayed
 * `'live'` forever, counted against `maxInstances`, and was handed back to
 * callers by sticky reuse as though a browser were behind it.
 *
 * MUST run after `reattachSurvivors`, and MUST NOT run during `start()`.
 * See the ordering comment at the call site in {@link buildRouterWiring}
 * for the first, and {@link scheduleOrphanSweep} for the second.
 *
 * For each row in a live status that this node is allowed to consider
 * (see {@link orphanSweepScope}) and holds no handle for, the runtime
 * inventory decides between two outcomes that are the opposite of one
 * another, and getting them backwards is a real defect in both directions:
 *
 * 1. The inventory has no entry for it, or has one whose `status` is
 *    `'unknown'`. `HostRuntime.list()` maps a state file entry whose pid
 *    is dead to `'unknown'` rather than dropping it, so absence and
 *    `'unknown'` mean the same thing here, and treating only absence as
 *    gone would leave half the phantoms looping. The browser is provably
 *    gone: move the row to `'failed'` and release its profile lease.
 * 2. The inventory reports `'live'`, `'orphan'`, or `'foreign'`. A real
 *    browser process is out there. Marking this row terminal would leak
 *    that Chrome permanently, because the row is the only thing anything
 *    could later release it against. Try to adopt it instead
 *    ({@link adoptSurvivor}), and if that fails leave the row exactly as
 *    it is and report it. This is the same three way verdict
 *    `LocalNode.terminate` now makes before deciding whether to throw;
 *    the two decision tables have to agree, or a row this sweep retires
 *    would be one `terminate` still refuses to give up on.
 *
 * `'failed'` rather than `'released'` is the honest terminal status: the
 * instance never completed a clean release, it was killed by a shutdown
 * (the demo gateway runs its host runtime with `killOnShutdown: true`, so
 * every gateway exit kills its browsers). Both are outside
 * `LIVE_INSTANCE_STATUSES`, so either frees the quota slot and hides the
 * row from reuse, and `'failed'` additionally tells an operator reading
 * the table that something went wrong rather than implying an orderly
 * teardown that never happened.
 *
 * Outcome 1 additionally requires {@link liveOwnerVerdict} to agree that
 * nothing else is operating the row. Everything the runtime inventory can
 * tell this process is about THIS host and THIS process; it says nothing
 * about a second gateway process against the same store, which is the
 * defect that reached live verification.
 */
export async function reapOrphanedInstances(args: {
  readonly store: Store;
  readonly runtime: BrowserRuntime;
  readonly localNode: LocalNode;
  readonly clock: Clock;
  readonly nodeId: NodeId;
  readonly scopedToOwnNodeId: boolean;
  /**
   * This process own start time. A row acquired at or after it was created
   * by something else WHILE this process was already running, which is
   * proof of a live owner on its own, so it is never a candidate. Without
   * this guard the sweep could race a launch another process began after
   * this one booted: that row has no handle here, no runtime entry here,
   * and for the few milliseconds between `createInstance` and the lease
   * being taken, no lease either.
   */
  readonly notBefore: number;
  readonly logger: Logger;
}): Promise<OrphanSweepReport> {
  const { store, runtime, localNode, clock, nodeId, scopedToOwnNodeId, notBefore, logger } = args;
  const reaped: string[] = [];
  const adopted: string[] = [];
  const unreachable: string[] = [];
  const skippedLiveOwner: string[] = [];
  const skippedUndecidable: string[] = [];

  try {
    const inventory = new Map<string, RuntimeInventoryEntry>();
    for (const entry of await runtime.list()) inventory.set(entry.instanceId, entry);

    for (const tenant of await store.listTenants()) {
      // One scan per tenant, before the row loop, because the answer for
      // every row comes out of the same table. See `buildProfileLeaseIndex`
      // for why this is a scan rather than a lookup.
      const leases = await buildProfileLeaseIndex(store, tenant.id);
      if (!leases.complete) {
        logger.warn(
          { nodeId, tenantId: tenant.id, scanned: leases.byInstance.size },
          'reconcile: this tenant has more profiles than one scan can read, so a missing lease no longer proves an instance is unowned; retiring nothing this pass',
        );
      }
      for (const row of await store.listInstances(tenant.id, { status: LIVE_INSTANCE_STATUSES })) {
        // Another node's row. Not this process's business, whatever the
        // runtime inventory says: this node's runtime would not know about
        // a browser on a different host anyway, so an "it is not running"
        // verdict here would be about the wrong machine entirely.
        if (scopedToOwnNodeId && row.nodeId !== nodeId) continue;
        // Already accounted for: either this process launched it moments
        // ago, or `reattachSurvivors` adopted it. Either way a handle
        // exists, `LocalNode.terminate` can reach it, and it is not an
        // orphan by any definition.
        if (localNode.handleFor(row.id) !== null) continue;
        // Created after this process was already up. See `notBefore`.
        if (row.acquiredAt >= notBefore) continue;

        const entry = inventory.get(row.id);
        if (entry !== undefined && entry.status !== 'unknown') {
          if (entry.status === 'live' && (await adoptSurvivor(runtime, localNode, entry, clock))) {
            adopted.push(row.id);
            logger.info(
              { instanceId: row.id, nodeId },
              'reconcile: adopted a browser that survived the last process',
            );
            continue;
          }
          unreachable.push(row.id);
          logger.warn(
            { instanceId: row.id, nodeId, runtimeStatus: entry.status },
            'reconcile: the runtime still reports a browser for this instance but this node could not take a handle on it; leaving the row live rather than marking a running Chrome dead',
          );
          continue;
        }

        // The last gate, and the one this sweep shipped without. Everything
        // above establishes only that THIS process cannot see the browser,
        // which is equally true of an instance a DIFFERENT live process
        // owns. See `liveOwnerVerdict`.
        const verdict = liveOwnerVerdict(leases, row, clock.now());
        if (verdict === 'live-owner') {
          skippedLiveOwner.push(row.id);
          logger.info(
            { instanceId: row.id, nodeId, tenantId: tenant.id },
            'reconcile: another live process is still renewing the profile lease of this instance; leaving it alone',
          );
          continue;
        }
        if (verdict === 'undecidable') {
          skippedUndecidable.push(row.id);
          logger.warn(
            { instanceId: row.id, nodeId, tenantId: tenant.id },
            'reconcile: cannot establish whether a live process owns this instance, because this tenant profile scan was incomplete; leaving it alone for the TTL reaper',
          );
          continue;
        }

        const moved = await store.transitionInstance(
          tenant.id,
          row.id,
          [...LIVE_INSTANCE_STATUSES],
          'failed',
          { stateReason: ORPHANED_BY_RESTART },
        );
        // A false here means something else moved the row between the list
        // and the transition. Whatever that was, it now owns the row.
        if (!moved) continue;
        await releaseOrphanedProfileLease(store, row, leases, logger);
        reaped.push(row.id);
        logger.info(
          { instanceId: row.id, nodeId, tenantId: tenant.id },
          'reconcile: retired an instance whose browser did not survive the last process',
        );
      }
    }
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    logger.error(
      { nodeId, failure },
      'reconcile: the orphan sweep failed; live instance rows were left as they are',
    );
    return {
      reaped,
      adopted,
      unreachable,
      skippedLiveOwner,
      skippedUndecidable,
      scopedToOwnNodeId,
      failure,
      cancelled: false,
    };
  }

  return {
    reaped,
    adopted,
    unreachable,
    skippedLiveOwner,
    skippedUndecidable,
    scopedToOwnNodeId,
    failure: null,
    cancelled: false,
  };
}

/** A scheduled, not yet executed sweep. `stop()` cancels it; a test awaits it. */
export interface OrphanSweepHandle {
  /** Cancels the pending sweep if it has not started. Idempotent. After this, {@link done} resolves with an empty, `cancelled: true` report. */
  cancel(): void;
  /** Resolves once the sweep has run, or immediately once cancelled. Never rejects: `reapOrphanedInstances` reports its own failures in the report. */
  readonly done: Promise<OrphanSweepReport>;
}

/**
 * Arms the destructive half of the reconcile to run once, later, and hands
 * back a handle to cancel it.
 *
 * Nothing destructive happens during `start()` any more. That is the point:
 * a process that runs `runStart` and then dies (the `EADDRINUSE` of a
 * duplicate `node server.mjs`, a config error, anything at all) must not
 * have retired another process instances on its way out. See
 * {@link orphanSweepDelayMs} for why the wait is the strongest commitment
 * proof this SDK can make about itself, and why its length is dictated by
 * the profile lease TTL rather than chosen.
 *
 * The ADOPTIVE half is not deferred and must not be. `reattachSurvivors`
 * runs synchronously during `buildRouterWiring`, before this is armed,
 * because adopting a browser this process is about to be responsible for
 * is both non destructive and urgent: until it has run, `LocalNode` holds
 * no handle for a survivor and `release()` cannot terminate it. Deferring
 * adoption would leave a window where the gateway is serving an instance
 * it cannot tear down.
 */
export function scheduleOrphanSweep(args: {
  readonly store: Store;
  readonly runtime: BrowserRuntime;
  readonly localNode: LocalNode;
  readonly clock: Clock;
  readonly nodeId: NodeId;
  readonly scopedToOwnNodeId: boolean;
  readonly notBefore: number;
  readonly delayMs: number;
  readonly logger: Logger;
}): OrphanSweepHandle {
  const { clock, logger, delayMs, nodeId, ...sweepArgs } = args;
  let cancelled = false;
  let settle: (report: OrphanSweepReport) => void = () => undefined;
  const done = new Promise<OrphanSweepReport>((resolve) => {
    settle = resolve;
  });

  const timer = clock.setTimeout(() => {
    if (cancelled) return;
    void reapOrphanedInstances({ ...sweepArgs, clock, nodeId, logger }).then(
      settle,
      (err: unknown) => {
        // `reapOrphanedInstances` catches its own failures, so reaching here
        // means something outside its try block threw. Report it the same
        // way rather than leaving an unhandled rejection on a timer.
        const failure = err instanceof Error ? err.message : String(err);
        logger.error(
          { nodeId, failure },
          'reconcile: the orphan sweep threw outside its own error handling',
        );
        settle({ ...NO_ORPHAN_SWEEP, scopedToOwnNodeId: args.scopedToOwnNodeId, failure });
      },
    );
  }, delayMs);
  // `systemClock` already unrefs, so this timer never keeps a process alive
  // that would otherwise exit. Stated again here because the whole design
  // depends on it: a gateway that fails to bind its port exits, and this
  // sweep must go with it.
  timer.unref?.();

  logger.info(
    { nodeId, delayMs },
    'reconcile: orphan sweep scheduled; nothing is retired unless this process is still running when it fires',
  );

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clock.clearTimeout(timer);
      settle({ ...NO_ORPHAN_SWEEP, scopedToOwnNodeId: args.scopedToOwnNodeId, cancelled: true });
    },
    done,
  };
}

/**
 * Releases the `profile_leases` row an orphaned instance still holds, and
 * puts its profile back to `'free'`.
 *
 * Deliberately goes to the store rather than through
 * `ProfileServicePort.releaseLeaseQuietly`, which every other release path
 * in the codebase uses. That method resolves the lease id through
 * `ProfileService.leaseIdForInstance`, an IN MEMORY map populated only by
 * leases this process itself granted. An orphan from a previous process is
 * by definition absent from it, so the call would return without doing
 * anything and the lease would leak: the next acquire naming the same
 * persistent profile key would fail `E_PROFILE_BUSY` against a holder that
 * no longer exists.
 *
 * `Store.getProfile` loads the profile's single unreleased lease
 * (`store-sqlite`: `SELECT * FROM profile_leases WHERE profile_id = ? AND
 * released_at IS NULL`), and the `holderInstanceId` check is what keeps
 * this honest: if some other instance has since taken the lease on the
 * same profile, this leaves it alone rather than yanking it away from a
 * live holder.
 *
 * The profile DIRECTORY is not touched. Reclaiming disk for an abandoned
 * ephemeral profile is `reconcileOnStartup`'s step 9 orphan scan, which
 * walks `profileDirsToScan` and already owns that job; doing it here would
 * mean this function deleting a directory whose Chrome it never confirmed
 * was gone. Hence `'free'` and not `'deleting'`: the row honestly says the
 * profile is unheld, not that something is mid delete.
 */
async function releaseOrphanedProfileLease(
  store: Store,
  instance: Instance,
  index: ProfileLeaseIndex,
  logger: Logger,
): Promise<void> {
  const held = index.byInstance.get(instance.id);
  if (held === undefined) return;
  if (held.lease.releasedAt !== null) return;
  try {
    await store.releaseProfileLease(held.lease.id, ORPHANED_BY_RESTART);
    await store.setProfileState(instance.tenantId, held.profileId, 'free');
  } catch (err) {
    // Best effort, and never fatal to the sweep: the instance row is
    // already terminal by this point, which is the part that frees the
    // quota slot and hides it from reuse. A lease this failed to release
    // still expires on its own TTL, since nothing renews it any more.
    logger.warn(
      { instanceId: instance.id, detail: err instanceof Error ? err.message : String(err) },
      'reconcile: could not release the profile lease of a retired instance',
    );
  }
}

// ── profile maintenance (emptying the trash) ───────────────────────────

/**
 * How often the profile trash sweep runs, derived from the retention table
 * rather than picked.
 *
 * `trashRetentionMsByKind` holds a different retention per trash kind, and
 * the sweep can only remove an entry once ITS kind's retention has
 * elapsed. So the only cadence that matters is the SHORTEST retention in
 * the table: sweeping at half of it bounds how long an eligible entry can
 * sit on disk after becoming eligible at worst one interval, so an entry
 * lives at most one and a half times its own retention. Sweeping slower
 * than the shortest retention would let ephemeral trash (15 minutes by
 * default) pile up for the whole gap; sweeping much faster only burns
 * `readdir` calls on directories that cannot have changed.
 *
 * The floor of one minute is a guard, not a tuning knob: a deployment that
 * configures a very short retention should not turn this into a spin loop.
 *
 * Read off `DEFAULT_PROFILE_SERVICE_CONFIG` because `buildRouterWiring`
 * constructs its `ProfileService` with no `config` override, so the
 * defaults ARE the values that service uses. If this file ever starts
 * passing a config, this derivation has to read from the same object or it
 * silently goes out of step with the retentions it is supposed to track.
 */
export function profileMaintenanceIntervalMs(): number {
  const retentions = Object.values(DEFAULT_PROFILE_SERVICE_CONFIG.trashRetentionMsByKind);
  const shortest = Math.min(...retentions);
  return Math.max(Math.floor(shortest / 2), 60_000);
}

/**
 * The most `sweepFilesystem()` calls one tick will make.
 *
 * `sweeperBatchLimit` (8) bounds how many directories ONE call unlinks,
 * which is there to keep a single pass from blocking on a huge burst of
 * `rmSync` calls. It is not a budget for how much a deployment is allowed
 * to reclaim per interval, and treating it as one caps throughput at 8 per
 * tick, which is below the rate a busy gateway creates ephemeral trash. So
 * a tick keeps calling until a pass comes back under the batch limit,
 * meaning it ran out of eligible entries, and this caps the total so one
 * tick cannot run unboundedly long on a very large backlog. Whatever is
 * left waits for the next interval.
 */
const PROFILE_SWEEP_MAX_PASSES = 32;

/** What one profile maintenance tick did. */
export interface ProfileMaintenanceReport {
  /** How many `sweepFilesystem()` calls this tick made. */
  readonly passes: number;
  /** Trash directories unlinked. */
  readonly unlinked: number;
  /** Bytes reclaimed, as measured just before each unlink. */
  readonly bytes: number;
  /**
   * `tmp/<opId>` staging directories left behind by a `materialise()` that
   * crashed before its final rename. Reported, never deleted: `ProfileFs`
   * exposes no method to remove them, and this package does not reach past
   * the port to do it by hand.
   */
  readonly orphanDirs: readonly string[];
  /** Set when the sweep threw. The timer keeps running; the next tick tries again. */
  readonly failure: string | null;
}

/** A running profile maintenance timer. `stop()` cancels it. */
export interface ProfileMaintenanceHandle {
  /** Stops the timer. Idempotent. A tick already in flight still finishes. */
  cancel(): void;
}

/**
 * Runs one profile maintenance tick: empties whatever trash is past its
 * retention, and reports what it could not deal with.
 *
 * Exported so a test can drive a tick without waiting on a timer, and so
 * an operator tool can do the same.
 *
 * WHY THIS EXISTS. `ProfileService.sweepFilesystem()` was written, tested,
 * and never called. `tenants/<t>/trash/` was a one way street: profile
 * directories arrived and nothing ever removed them. That went unnoticed
 * for the same reason the reaper stall did, which is worth stating since
 * this file now contains two fixes for it: a reclaim path that never once
 * ran looks exactly like one that always works, unless somebody checks.
 * Hence the logging below, which reports what was reclaimed and what
 * failed, rather than a silent best effort.
 *
 * QUARANTINE IS SAFE FROM THIS. The retention table is per kind and
 * `ProfileFs.sweep` reads the kind straight off each trash entry's own
 * name suffix (`<name>.<trashedAtMs>.<kind>`), so a directory trashed as
 * `quarantine` is held for its own 30 days while an `ephemeral` one goes
 * at 15 minutes. This function passes the configured table through
 * unchanged and applies no retention of its own, so there is no way for it
 * to shorten a quarantine. The test suite pins that.
 *
 * TWO GATEWAYS SHARING A PROFILE ROOT IS SAFE, and this is checked rather
 * than assumed, because assuming it is what broke the orphan sweep. Both
 * processes will sweep the same directories. `ProfileFs.sweep` unlinks
 * with `rmSync(path, { recursive: true, force: true })`, and `force`
 * makes an already removed path a success rather than an `ENOENT`, so the
 * loser of a race deletes nothing and does not throw. Its size measurement
 * is equally tolerant: `treeSize` wraps every `readdirSync` and `statSync`
 * in its own try/catch and skips what has vanished mid walk. The only
 * consequence of a race is that both processes may count the same entry in
 * their own `bytes` total, which makes the log line optimistic and nothing
 * else. Unlike the instance sweep, there is no liveness question here at
 * all: a trash entry is past its retention or it is not, and that is a
 * property of the entry rather than of whoever is looking at it.
 */
export async function runProfileMaintenance(
  profileService: Pick<ProfileService, 'sweepFilesystem'>,
  logger: Logger,
): Promise<ProfileMaintenanceReport> {
  let passes = 0;
  let unlinked = 0;
  let bytes = 0;
  let orphanDirs: readonly string[] = [];

  try {
    for (let pass = 0; pass < PROFILE_SWEEP_MAX_PASSES; pass += 1) {
      const result = await profileService.sweepFilesystem();
      passes += 1;
      unlinked += result.unlinked;
      bytes += result.bytes;
      orphanDirs = result.orphanDirs;
      // Under the batch limit means this pass ran out of eligible entries,
      // not that it ran out of budget.
      if (result.unlinked < DEFAULT_PROFILE_SERVICE_CONFIG.sweeperBatchLimit) break;
    }
  } catch (err) {
    // Never swallowed, and never fatal. `ProfileFs.sweep` reports a failure
    // by throwing rather than per entry, so the path that could not be
    // removed is whatever the underlying `fs` error names in its message;
    // there is no finer detail to log because the port does not expose
    // any. Widening `ProfileFs.sweep` to return per entry failures would
    // fix that.
    const failure = err instanceof Error ? err.message : String(err);
    logger.error(
      { failure, passes, unlinked, bytes },
      'profile maintenance: the trash sweep failed; disk was not fully reclaimed and the next tick will retry',
    );
    return { passes, unlinked, bytes, orphanDirs, failure };
  }

  if (unlinked > 0) {
    logger.info(
      { passes, unlinked, bytes },
      'profile maintenance: reclaimed expired profile trash',
    );
  }
  if (orphanDirs.length > 0) {
    logger.warn(
      { orphanDirs: orphanDirs.length },
      'profile maintenance: found tmp staging directories left by an interrupted profile materialise; nothing in this build removes them, so they are reported rather than reclaimed',
    );
  }
  return { passes, unlinked, bytes, orphanDirs, failure: null };
}

/**
 * Starts the profile maintenance timer.
 *
 * Deliberately runs ONLY the trash sweep, and not the other two
 * `ProfileService` maintenance entry points, which are also uncalled in
 * production but are not interchangeable with this one:
 *
 * - `reconcileMissingDirs()` quarantines profile rows whose directory has
 *   gone missing. It is fed from `ProfileFs.reconcile()`'s `missingDirs`,
 *   and the only implementation in this build
 *   (`runtime-host/src/profile-fs.ts`) returns `missingDirs: []`
 *   unconditionally, by design and with its own comment explaining that a
 *   filesystem-only view has no DB handle to compare against. Scheduling
 *   it would call it with an empty list forever. It needs the missing set
 *   computed first, which is a router-side job.
 * - `sweepExpiredLeases()` QUARANTINES the profile behind every lease that
 *   lapsed, which on a gateway running `killOnShutdown: true` means
 *   quarantining every profile it owned on every restart. That is a real
 *   behaviour change rather than a reclaim, and quarantine is the one
 *   state this codebase deliberately keeps for a human to inspect. It also
 *   releases expired leases across EVERY tenant (`Store.expireProfileLeases`
 *   takes no tenant) while only quarantining the one tenant it was passed.
 *   Both are written up rather than started on a timer here.
 *
 * Neither omission leaves the reported defect unfixed: the trash pile is
 * what the sweep on this timer empties.
 */
export function scheduleProfileMaintenance(args: {
  readonly profileService: Pick<ProfileService, 'sweepFilesystem'>;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly logger: Logger;
}): ProfileMaintenanceHandle {
  const { profileService, clock, intervalMs, logger } = args;
  let cancelled = false;

  const timer = clock.setInterval(() => {
    if (cancelled) return;
    void runProfileMaintenance(profileService, logger);
  }, intervalMs);
  // `systemClock` already unrefs; stated again because it matters. A
  // gateway that is otherwise finished must not be held open by a timer
  // whose whole job is housekeeping.
  timer.unref?.();

  logger.info({ intervalMs }, 'profile maintenance: trash sweep scheduled');

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clock.clearInterval(timer);
    },
  };
}

/**
 * Constructs `BrowserRouter` plus its `ProfileService` and `LocalNode`
 * dependencies from a `ResolvedConfig`. `LocalNode` translates the router's
 * launch payload into the runtime's `LaunchRequest`; `LocalNodeTransport`
 * implements `NodeTransport` by direct call, delivering the same
 * `NodeHeartbeatPayload`/`LaunchRequest` shapes a real WebSocket transport
 * would. Only called for `mode: 'embedded' | 'supervised'`;
 * `resolveConfig` already rejects `store`/`runtime`/`profiles.fs` being
 * unset in those modes, so every field this function needs is present.
 *
 * Mints and persists this process's own router-scope `nodeId` before
 * building anything that references it: `instances.node_id` and
 * `profile_leases.node_id` both carry `REFERENCES nodes(id)` under a real
 * `Store` (`PRAGMA foreign_keys = ON` for `store-sqlite`), so a `nodeId`
 * this function mints but never registers makes every subsequent
 * `router.acquire()` call fail `store.createInstance()` with a foreign key
 * violation.
 *
 * `config.peer.nodeId`, when the operator has set one, is used verbatim
 * instead of minting a fresh id: `store.registerNode` now upserts on `id`
 * (in `store-sqlite`), so a node restarting under
 * the SAME configured id keeps the durable identity `Instance.nodeId`
 * rows already point at, rather than orphaning them under a dead id and
 * registering a second, empty-handed node. Left unset, this function
 * still mints a fresh id every start exactly as it always has: a single
 * node deployment, or one that never restarts the same peer identity, has
 * nothing to gain from the upsert and nothing to lose by skipping it.
 *
 * `actions`, when supplied, is threaded onto `LocalNode` so `dispatch()`
 * (a peer's `NodeActionRequest`, `ws/peer-upgrade.ts`) can actually reach
 * real CDP execution instead of throwing "no NodeActionExecutor
 * configured". `index.ts` builds this from its own `SessionRegistry`
 * (`session/node-action-executor.ts`'s `createLocalNodeActionExecutor`)
 * and passes it down through `runStart`, since `SessionRegistry` is built
 * before `start()` is ever called and this function has no other way to
 * reach it (`LocalNode` has no setter for `opts.actions` after
 * construction).
 *
 * `deps.viewers` is the same story for a different port. `BrowserRouter`'s
 * viewer aware `release()` needs to know how many viewers are attached to
 * an instance right now, and `@browserglass/router` holds no viewer
 * sockets and no CDP connections, so it takes the count through
 * an injected `LiveViewerPort` that defaults to a constant zero. The real
 * count lives in this package's `SessionRegistry`, one layer up, which is
 * why this arrives as a parameter rather than being built here. See the
 * port's own doc for the contract an implementation has to honour.
 *
 * `deps.logger` exists so the startup orphan sweep below can report what
 * it retired. It defaults to `noopLogger`, which is what every existing
 * caller and test that does not pass one gets.
 *
 * `deps.tokens` is the same story again, for `BrowserRouter`'s
 * `attachCredentials` port (`@browserglass/router`'s `AttachCredentialIssuer`):
 * `attach()`/`acquire()` need to mint a real, redeemable WS credential, and
 * this package's `TokenApi` (EdDSA signing keys, `auth/tokens.ts`) is the
 * only thing in this process that can sign one. `attachCredentialIssuerFor`
 * below builds the actual `AttachCredentialIssuer` from it, over
 * `config.publicUrl`/`config.wsPath` for the URL half; see that function's
 * own doc. Left unsupplied, `BrowserRouter` falls back to a credential
 * shaped to fail loudly (its own `attachCredentials` doc), exactly the gap
 * this parameter closes for every real caller of `createBrowserGlass()`
 * (`index.ts` always passes its own `tokenApi`).
 */
export async function buildRouterWiring(
  config: ResolvedConfig,
  actions?: NodeActionExecutor,
  deps?: {
    readonly logger?: Logger;
    readonly viewers?: LiveViewerPort;
    readonly orphanSweepDelayMs?: number;
    readonly tokens?: TokenApi;
  },
): Promise<RouterWiring> {
  if (config.store === undefined) throw new Error('buildRouterWiring: config.store is required.');
  if (config.profiles.fs === undefined)
    throw new Error('buildRouterWiring: config.profiles.fs is required.');
  if (config.runtimes.length === 0)
    throw new Error('buildRouterWiring: at least one runtime is required.');

  const store = config.store;
  const clock = systemClock;
  const logger = deps?.logger ?? noopLogger;
  const nodeId = (config.peer.nodeId ?? newId('nod')) as NodeId;

  await store.registerNode({
    id: nodeId,
    name: config.instanceName,
    runtime: 'host',
    address: 'http://127.0.0.1:0',
    dataAddress: config.peer.dataPlaneUrl,
    registrationSecretEnc: deriveRegistrationSecretEnc(nodeId, config.peer.sharedSecret),
  });

  const nodeRegistry = new NodeRegistry(clock, {
    nodeId,
    capacity: {
      maxInstances: config.limits.maxInstances,
      maxMemoryMb: 64_000,
      cpuCores: 8,
      profileDiskMb:
        Math.floor(config.profiles.maxBytesPerProfile / (1024 * 1024)) * config.limits.maxInstances,
      maxConcurrentLaunches: DEFAULT_LAUNCH_CONCURRENCY,
    },
  });

  const profileService = new ProfileService({
    store,
    fs: config.profiles.fs,
    clock,
  });
  // The node holding a profile lease renews it
  // on `profileLeaseRenewIntervalMs`, one third of the TTL. Without this the
  // lease simply expires 30s after it is taken, and the instance holding it
  // can never be restarted again. `stop()` turns it back off.
  profileService.startLeaseRenewal();
  // The other half of profile upkeep, and the half that was missing
  // entirely: renewal keeps a held lease alive, and this empties the trash
  // that releasing one produces. `ProfileService.sweepFilesystem()` had no
  // production caller anywhere in the monorepo, so `tenants/<t>/trash/`
  // only ever grew. See `runProfileMaintenance`.
  const profileMaintenance = scheduleProfileMaintenance({
    profileService,
    clock,
    intervalMs: profileMaintenanceIntervalMs(),
    logger,
  });

  const profilesPort = new ProfileServicePortAdapter(profileService);

  const runtime = config.runtimes[0]!;
  const localNode = new LocalNode({
    runtime,
    profiles: profilesPort,
    clock,
    ...(actions !== undefined ? { actions } : {}),
  });
  // ORDERING, and it is the entire safety property of these two calls:
  // ADOPT FIRST, REAP SECOND.
  //
  // `reattachSurvivors` hands `localNode` a handle for every browser that
  // genuinely outlived the previous process. Once it has run, a survivor
  // is indistinguishable from an instance this process launched itself,
  // and `reapOrphanedInstances` skips it on the `handleFor` test without
  // ever having to reason about it. Run the other way round, the sweep
  // would see a store row with no handle, ask the runtime, and in a
  // deployment where `killOnShutdown` is false get told the browser is
  // live: it would then take the adopt path, so the immediate damage is
  // bounded, but the row would spend the window in between with nothing
  // holding it, and any adopt failure would be reported as unreachable for
  // a browser the very next call was about to reattach cleanly. Keeping
  // adoption first means the sweep only ever sees what adoption could not
  // account for, which is the only set it is entitled to judge.
  const adoptedIds = await reattachSurvivors(runtime, localNode, clock);
  await rehomeAdoptedRows(store, nodeId, adoptedIds, logger);
  const scope = orphanSweepScope(config);
  if (scope.warning !== null) logger.warn({ nodeId }, scope.warning);
  const orphanSweep = scheduleOrphanSweep({
    store,
    runtime,
    localNode,
    clock,
    nodeId,
    scopedToOwnNodeId: scope.scopedToOwnNodeId,
    notBefore: clock.now(),
    delayMs: deps?.orphanSweepDelayMs ?? orphanSweepDelayMs(),
    logger,
  });
  const localTransport = new LocalNodeTransport(localNode, nodeRegistry, clock);

  /**
   * The real multi node transport, but only when this deployment is
   * actually configured as a cluster.
   *
   * `config.peer.sharedSecret` is the same gate the peer LISTENER already
   * uses (`index.ts`), so the dial half and the accept half turn on
   * together. Without this, `buildRouterWiring` always built a bare
   * `LocalNodeTransport`, which meant cross node dispatch was a component
   * that existed, was tested, and was unreachable from the production
   * entrypoint: `docs/scaling.md` described a capability nothing could
   * actually use. Placement could name a remote candidate (it can, since
   * `remoteNodeSnapshots` feeds them in) and the launch would then be
   * refused by `LocalNodeTransport`'s foreign node guard. Correct, but
   * permanently local.
   *
   * `resolveEndpoint` reads the store DIRECTLY rather than going through
   * `BrowserRouter.resolveNode`, and that is the whole reason this is a
   * small change rather than a refactor. The obvious wiring is circular:
   * the transport needs `router.resolveNode`, the router needs a
   * `NodeTransport` at CONSTRUCTION (a constructor argument, not a
   * setter), so the router must exist before the transport and the
   * transport must exist before the router. The alternative was to
   * construct the transport with a dummy resolver and patch it once
   * `router` existed, which leaves a real window where a dial resolves
   * against a stub. `resolveNode` is itself a thin wrapper over exactly
   * this store read (its own doc says so), so going straight to the store
   * is the same answer with no window and no cycle.
   *
   * A node with no `dataPlaneUrl`, or no row at all, resolves to `null`,
   * which the transport turns into `E_NODE_LOST` rather than dialling
   * `undefined`. That is the correct answer for a stale placement
   * decision or a node that has since left the cluster.
   */
  // Read once into a local so the narrowing survives into the object
  // literal below: `ResolvedConfig.peer.sharedSecret` is `string | null`,
  // and a property access is re-widened at every use site.
  const peerSecret = config.peer?.sharedSecret ?? null;
  const nodeTransport: NodeTransport =
    peerSecret !== null && peerSecret !== ''
      ? new WebSocketNodeTransport({
          selfNodeId: nodeId,
          local: localTransport,
          sharedSecret: peerSecret,
          clock,
          resolveEndpoint: async (target) => {
            const node = await store.getNode(target).catch(() => null);
            const url = node?.dataPlaneUrl;
            return typeof url === 'string' && url !== '' ? { url } : null;
          },
        })
      : localTransport;

  const placement = new ScoredPlacementPolicy(
    DEFAULT_ROUTER_CONFIG.placementWeights,
    DEFAULT_ROUTER_CONFIG.targetUtilisation,
    DEFAULT_ROUTER_CONFIG.scoreFloor,
    NULL_PLACEMENT_SIGNALS,
  );

  const router = new BrowserRouter({
    store,
    nodes: nodeTransport,
    nodeRegistry,
    placement,
    profiles: profilesPort,
    quotas: quotaProviderFromLimits(config),
    audit: config.observability.auditSink ?? noopAuditSink,
    metrics: config.observability.metricsSink ?? noopMetricsSink,
    clock,
    // A standalone gateway reaches no other node, so a row naming another
    // node is never one it can hand out. See `BrowserRouterOptions`.
    reachesPeerNodes: nodeTransport !== localTransport,
    ...(deps?.viewers !== undefined ? { viewers: deps.viewers } : {}),
    ...(deps?.tokens !== undefined
      ? { attachCredentials: attachCredentialIssuerFor(config, deps.tokens) }
      : {}),
    config: {
      idempotencyWindowMs: config.router.idempotencyWindowMs,
      reaperIntervalMs: config.router.reaperIntervalMs,
      reconcileIntervalMs: config.router.reconcileIntervalMs,
      heartbeatIntervalMs: config.router.heartbeatIntervalMs,
      nodeStaleMs: config.router.nodeStaleMs,
      warmSafetyFactor: config.router.warmSafetyFactor,
      instanceLingerMs: config.sessionLimits.idleGraceMs,
      maxDurationMs: config.sessionLimits.maxDurationMs,
    },
  });

  return {
    router,
    profileService,
    nodeTransport,
    nodeRegistry,
    nodeId,
    orphanSweep,
    profileMaintenance,
  };
}

/** Re-exported so a caller building a `RouterWiring` by hand (tests, `mode: 'gateway'` paths) does not have to synthesise an empty sweep report. */
export { NO_ORPHAN_SWEEP };
