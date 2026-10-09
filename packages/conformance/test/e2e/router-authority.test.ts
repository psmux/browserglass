/**
 * `BrowserRouter` is the strict authority
 * for resolution, admission, activity, and audit; every driving surface
 * must pass through it rather than reading `store.getInstance()` or
 * scanning its own process local `SessionRegistry` directly. This suite
 * proves two properties:
 *
 * 1. An instance whose owning node is not this process is FORWARDED
 *    through `NodeTransport.dispatch`, not refused. Before this work, a
 *    REST/CLI/CDP call for such an instance returned 409
 *    `E_SESSION_NOT_LIVE` even though the instance was alive and well,
 *    because nothing could carry the action past this process's own
 *    `SessionRegistry` (`packages/server/src/session/rest-driver.ts`'s own
 *    doc comment named this precisely). That is the wall anyone hits the
 *    day they scale past one node.
 * 2. An instance driven only over REST or CLI, never over the WebSocket
 *    input path, is not force released by the idle reaper mid use. Before
 *    this work, `onActivity` fired only from
 *    `server/src/session/managed-session.ts`'s `dispatchInput`, so a
 *    REST-only driven instance went idle from the reaper's point of view
 *    no matter how hard it was actually being used.
 *
 * Both fixes landed in `BrowserRouter` (`packages/router`) and
 * `NodeTransport` (`packages/protocol`) while this suite was being
 * written: `BrowserRouter.driveInstance()` is the one gate (resolve,
 * check drivable, record activity, audit, return where to execute) and
 * `BrowserRouter.dispatchAction()` is what forwards through
 * `NodeTransport.dispatch(nodeId, req)` when the resolved `nodeId` is not
 * this process's own. `packages/server`'s own wiring of REST/CLI onto that
 * gate was being rewritten at the same time, so both suites below test
 * against the STABLE layer underneath it: `BrowserRouter` directly
 * for the forwarding proof (test 1), and `ManagedSession` (the actual
 * driving primitive both REST and CLI ultimately call into, unaffected by
 * the `RestSessionDriver`/`DrivingContext` churn) plus `BrowserRouter.driveInstance()`
 * for the activity proof (test 2), rather than coupling either guard to the
 * REST route layer.
 *
 * Neither test uses `startRealGateway()` (`./support/real-gateway.ts`):
 * that harness builds its router through `createBrowserGlass()`, which
 * hardcodes the real wall clock (`packages/server/src/lifecycle/wiring.ts`'s
 * `const clock = systemClock;`, no injection seam), and test 2 needs to
 * drive the router's idle reaper across many minutes of simulated time
 * without a real wait. Both suites instead build a `BrowserRouter`
 * directly, the same public `@browserglass/router` composition
 * `wiring.ts` itself uses (`BrowserRouter`, `NodeRegistry`, `LocalNode`,
 * `LocalNodeTransport`, `ProfileService`, `ScoredPlacementPolicy`, all
 * public exports), with an injected `FakeClock` in place of `systemClock`.
 * This is a legitimate, supported seam: `Clock` is `BrowserRouter`'s own
 * documented "drive the router's lifecycle logic... without waiting on
 * real wall clock time" extension point (`packages/router/src/router/clock.ts`),
 * not an internal we are reaching around.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppId,
  CAPABILITIES,
  type Capability,
  type InstanceId,
  type NodeActionRequest,
  type NodeActionResult,
  type NodeHeartbeatAck,
  type NodeHeartbeatPayload,
  type NodeId,
  type NodeTransport,
  type Principal,
  type QuotaProvider,
  type Scope,
  type Store,
  type TenantId,
  newId,
} from '@browserglass/protocol';
import {
  BrowserRouter,
  type Clock,
  type ClockTimer,
  DEFAULT_ROUTER_CONFIG,
  LocalNode,
  LocalNodeTransport,
  NULL_PLACEMENT_SIGNALS,
  NodeRegistry,
  ProfileService,
  type ProfileServicePort,
  ProfileServicePortAdapter,
  ScoredPlacementPolicy,
} from '@browserglass/router';
import {
  type HostRuntime,
  chromeProcsForDataDir,
  createHostRuntime,
  createProfileFs,
  killProcessTree,
} from '@browserglass/runtime-host';
import {
  type RouterWiring,
  SessionRegistry,
  createManagedSessionFactory,
  noopAuditSink,
  noopMetricsSink,
} from '@browserglass/server';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { shortTempRoot } from './support/real-gateway.js';

/** A principal with every capability, used only to drive `router.acquire()`/`dispatchAction()` from this test harness. Never sent over any wire. */
function testPrincipal(tenantId: TenantId, appId: AppId): Principal {
  const scope: Scope = { kind: 'tenant' };
  return {
    tenantId,
    appId,
    sub: 'router-authority-test:driver',
    subKind: 'service',
    caps: [...CAPABILITIES] as Capability[],
    scope,
    jti: 'router-authority-test',
    exp: Number.MAX_SAFE_INTEGER,
  };
}

/** The `BrowserSpec` content every test in this file registers a pool against. Headless, minimal, nothing test 1 ever launches for real. */
const TEST_SPEC_INPUT = {
  engine: 'chromium' as const,
  channel: 'chrome' as const,
  headless: 'new' as const,
  viewportW: 1024,
  viewportH: 768,
  dpr: 1,
  locale: null,
  timezone: null,
  userAgent: null,
  proxy: null,
  args: [],
  extensions: [],
  stealth: 'off' as const,
  isolation: 'tab' as const,
  limits: {},
};

/**
 * `BrowserRouter`'s injectable `Clock`, driven entirely by hand: `now()`
 * returns a counter this test advances directly, and every timer method is
 * a no-op handle. Neither suite below ever calls `router.start()` (which
 * would arm real `setInterval` heartbeat/reaper timers this fake clock
 * never fires), so nothing here needs to actually schedule anything;
 * `reaperSweep()` is called directly, and the interval it would otherwise
 * run on is simulated by advancing `now()` between calls, `packages/router/src/router/clock.ts`'s
 * own documented purpose for this seam.
 */
class FakeClock implements Clock {
  private currentMs: number;
  constructor(startMs: number) {
    this.currentMs = startMs;
  }
  now(): number {
    return this.currentMs;
  }
  /** Advances simulated time. Costs nothing in real wall clock time: this is the whole point of driving the clock instead of sleeping. */
  advance(ms: number): void {
    this.currentMs += ms;
  }
  setTimeout(): ClockTimer {
    return {};
  }
  setInterval(): ClockTimer {
    return {};
  }
  clearTimeout(): void {}
  clearInterval(): void {}
}

/** Generous, never-the-limiting-factor `QuotaProvider`: neither suite below tests quota behaviour. */
function generousQuotaProvider(): QuotaProvider {
  return {
    async limits() {
      return {
        maxInstances: 100,
        maxInstancesPerApp: 100,
        maxInstancesPerUser: 100,
        maxViewers: 100,
        maxProfiles: 1000,
        maxProfileBytes: 10_000_000_000,
        maxSessionMinutesPerDay: 100_000,
        maxAcquiresPerMinute: 1000,
        maxFrameBytesPerMinute: 1_000_000_000,
      };
    },
  };
}

/** `PlacementPolicy` every `BrowserRouter` in this file is constructed with, identical to `wiring.ts`'s own construction. Required by the constructor; test 1 never actually exercises placement (it fabricates instance rows directly, see that suite's own comment), test 2 exercises it once per `acquire()`. */
function defaultPlacementPolicy(): ScoredPlacementPolicy {
  return new ScoredPlacementPolicy(
    DEFAULT_ROUTER_CONFIG.placementWeights,
    DEFAULT_ROUTER_CONFIG.targetUtilisation,
    DEFAULT_ROUTER_CONFIG.scoreFloor,
    NULL_PLACEMENT_SIGNALS,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Test 1: an instance on another node is forwarded, not refused.
// ═══════════════════════════════════════════════════════════════════════

/**
 * A `ProfileServicePort` that throws if any of its methods are ever
 * called. Correct for this suite: test 1 never calls `router.acquire()`
 * (it fabricates instance rows directly via `store.createInstance`, see
 * below), so nothing here should ever touch the profile lease machinery.
 * A call reaching this would mean the test accidentally exercised the
 * acquire/launch path instead of the direct-store path it means to.
 */
function unusedProfileServicePort(): ProfileServicePort {
  const boom = (name: string): never => {
    throw new Error(
      `unexpected ProfileServicePort.${name} call: test 1 never acquires/launches, it only fabricates store rows directly.`,
    );
  };
  return {
    resolve: async () => boom('resolve'),
    lease: async () => boom('lease'),
    renewForRestart: async () => boom('renewForRestart'),
    releaseLeaseQuietly: async () => boom('releaseLeaseQuietly'),
    homeOf: async () => boom('homeOf'),
    materialisedPathFor: async () => boom('materialisedPathFor'),
    applyReleaseAction: async () => boom('applyReleaseAction'),
    hasShareGrant: async () => boom('hasShareGrant'),
  };
}

/** One recorded `dispatch()` call, so a test can assert not just the result but which `nodeId` the router actually reached for. */
interface FakeDispatchCall {
  readonly nodeId: NodeId;
  readonly req: NodeActionRequest;
}

/**
 * A fake `NodeTransport`, because the thing under test is the routing
 * decision, not the transport's wire format. `LocalNodeTransport`
 * (the only real implementation on disk; a `WebSocketNodeTransport` for an
 * actually networked multi node deployment is explicitly out of scope,
 * `NodeTransport`'s own doc comment says so) executes a local `nodeId` by
 * direct in process call; a real remote node's transport would encode
 * `req` and send it over a socket. Neither of those wire formats is what
 * `BrowserRouter.dispatchAction`/`driveInstance` decide between: they
 * decide WHICH `nodeId` to call `dispatch` on, based on the instance's own
 * durable `nodeId` in the store. This fake proves exactly that decision:
 * it answers `dispatch` identically regardless of which `nodeId` it is
 * called for (recording every call), so the only way this test's
 * "dispatched to the foreign node" assertion can pass is if the router
 * genuinely looked up the instance's OWN recorded owner and called
 * `dispatch` with THAT node id, rather than defaulting to its own local
 * node id or refusing outright. A stub that silently redirected every
 * call to the local node, or that never reached `dispatch` at all for a
 * foreign instance, would fail this test's `calls` assertions even though
 * `dispatch()` itself never throws.
 */
function createFakeNodeTransport(): NodeTransport & { readonly calls: FakeDispatchCall[] } {
  const calls: FakeDispatchCall[] = [];
  return {
    calls,
    async heartbeat(nodeId: NodeId, _payload: NodeHeartbeatPayload): Promise<NodeHeartbeatAck> {
      return { nodeId, accepted: true, serverTime: Date.now(), drain: null };
    },
    async launch(): Promise<never> {
      throw new Error(
        'unexpected NodeTransport.launch call: test 1 never acquires, it fabricates instance rows directly.',
      );
    },
    async terminate(): Promise<never> {
      throw new Error('unexpected NodeTransport.terminate call: test 1 never releases.');
    },
    async list() {
      return [];
    },
    async dispatch(nodeId: NodeId, req: NodeActionRequest): Promise<NodeActionResult> {
      calls.push({ nodeId, req });
      if (req.kind === 'target.list') {
        return {
          kind: 'target.list',
          targets: [{ targetId: 'tgt_fake', url: 'https://example.com/', title: 'Fake Target' }],
        };
      }
      throw new Error(`fake transport: this test only drives 'target.list', got '${req.kind}'`);
    },
  };
}

describe("BrowserRouter forwards a driving action to an instance's owning node instead of refusing it", () => {
  let store: Store;
  let workDir: string;
  let tenantId: TenantId;
  let appId: AppId;
  let principal: Principal;
  let localNodeId: NodeId;
  let remoteNodeId: NodeId;
  let transport: ReturnType<typeof createFakeNodeTransport>;
  let router: BrowserRouter;
  let localInstanceId: InstanceId;
  let remoteInstanceId: InstanceId;

  beforeAll(async () => {
    workDir = shortTempRoot('rt-');
    store = await createSqliteStore(join(workDir, 'control.db'), { migrate: 'auto' });

    tenantId = newId('ten') as TenantId;
    appId = newId('app') as AppId;
    await store.createTenant({ id: tenantId, name: 'router-authority test tenant' });
    await store.createApp({ id: appId, tenantId, name: 'router-authority test app' });
    principal = testPrincipal(tenantId, appId);

    localNodeId = newId('nod') as NodeId;
    remoteNodeId = newId('nod') as NodeId;
    // Both nodes are registered in the SAME shared store, exactly the way
    // two real router processes in a real multi node deployment would
    // each register themselves: `instances.node_id` carries
    // `REFERENCES nodes(id)`, so an instance claiming `remoteNodeId` as
    // its owner needs that row to exist even though no second router
    // process is actually running here (`wiring.ts`'s own comment on
    // `buildRouterWiring` explains the same FK requirement for the local
    // node).
    await store.registerNode({
      id: localNodeId,
      name: 'local',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'test',
    });
    await store.registerNode({
      id: remoteNodeId,
      name: 'remote',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'test',
    });

    const clock = new FakeClock(Date.now());
    const nodeRegistry = new NodeRegistry(clock, {
      nodeId: localNodeId,
      capacity: {
        maxInstances: 10,
        maxMemoryMb: 8000,
        cpuCores: 4,
        profileDiskMb: 10_000,
        maxConcurrentLaunches: 2,
      },
    });
    nodeRegistry.markReady();

    transport = createFakeNodeTransport();
    router = new BrowserRouter({
      store,
      nodes: transport,
      nodeRegistry,
      placement: defaultPlacementPolicy(),
      profiles: unusedProfileServicePort(),
      quotas: generousQuotaProvider(),
      audit: noopAuditSink,
      metrics: noopMetricsSink,
      clock,
    });

    const spec = await store.upsertBrowserSpec(tenantId, TEST_SPEC_INPUT);
    const pool = await store.createPool({ tenantId, name: 'default', specId: spec.id });

    // Two instance rows, created directly via the store rather than
    // through `router.acquire()`: `acquire()`'s own placement logic only
    // ever considers THIS router's own `NodeRegistry` (confirmed by
    // reading `NodeRegistry`'s own doc comment: "the single node registry
    // for an embedded, single node build"), so it has no way to place
    // anything on a second node even now that forwarding exists. A real
    // multi node deployment's second node id comes from a DIFFERENT
    // router process's OWN `acquire()` call, writing the exact same
    // `createInstance`/`createSession`/`transitionInstance` sequence
    // `BrowserRouter.placeAndLaunch` runs internally (see that method for
    // the sequence this mirrors). Writing it directly here is therefore
    // not a shortcut around the real mechanism, it is the real mechanism,
    // just performed by this test standing in for that second process.
    localInstanceId = newId('inst') as InstanceId;
    await store.createInstance({
      id: localInstanceId,
      tenantId,
      appId,
      poolId: pool.id,
      specId: spec.id,
      nodeId: localNodeId,
      createdBySub: principal.sub,
      metadata: {},
      lifetime: 'viewer-bound',
    });
    await store.createSession({ id: newId('sess'), tenantId, instanceId: localInstanceId });
    await store.transitionInstance(tenantId, localInstanceId, ['launching'], 'live', {});

    remoteInstanceId = newId('inst') as InstanceId;
    await store.createInstance({
      id: remoteInstanceId,
      tenantId,
      appId,
      poolId: pool.id,
      specId: spec.id,
      nodeId: remoteNodeId,
      createdBySub: principal.sub,
      metadata: {},
      lifetime: 'viewer-bound',
    });
    await store.createSession({ id: newId('sess'), tenantId, instanceId: remoteInstanceId });
    await store.transitionInstance(tenantId, remoteInstanceId, ['launching'], 'live', {});
  }, 60_000);

  afterAll(async () => {
    await store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('driveInstance resolves a foreign-node instance as non-local, pointed at its real owning node', async () => {
    const local = await router.driveInstance(localInstanceId, principal);
    expect(local.local).toBe(true);
    expect(local.nodeId).toBe(localNodeId);

    const remote = await router.driveInstance(remoteInstanceId, principal);
    // This is the resolution half of the property: the router
    // does not collapse "not this process" into "not live". It reports,
    // honestly, that the instance is alive and reachable, just not here.
    expect(remote.local).toBe(false);
    expect(remote.nodeId).toBe(remoteNodeId);
  });

  it('dispatchAction on the local instance reaches the local node, not the foreign one', async () => {
    const before = transport.calls.length;
    const result = await router.dispatchAction(
      localInstanceId,
      { kind: 'target.list', instanceId: localInstanceId },
      principal,
    );
    expect(result).toEqual({
      kind: 'target.list',
      targets: [{ targetId: 'tgt_fake', url: 'https://example.com/', title: 'Fake Target' }],
    });
    const newCalls = transport.calls.slice(before);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]?.nodeId).toBe(localNodeId);
  });

  it('dispatchAction on the foreign-node instance is FORWARDED to that node via NodeTransport.dispatch, never refused with E_SESSION_NOT_LIVE', async () => {
    const before = transport.calls.length;
    // Before this fix: a driving surface reading this instance's owner
    // from its own process-local `SessionRegistry` (or, per this file's
    // own top comment, from `store.getInstance()` directly with no router
    // in the loop at all) had no path to a node it did not itself launch
    // on, and answered 409 `E_SESSION_NOT_LIVE` even though, as the
    // previous `it()` in this suite just proved, the instance is
    // genuinely alive. This call succeeding, and reaching the FOREIGN
    // node id specifically, is that wall coming down.
    const result = await router.dispatchAction(
      remoteInstanceId,
      { kind: 'target.list', instanceId: remoteInstanceId },
      principal,
    );
    expect(result).toEqual({
      kind: 'target.list',
      targets: [{ targetId: 'tgt_fake', url: 'https://example.com/', title: 'Fake Target' }],
    });
    const newCalls = transport.calls.slice(before);
    expect(newCalls).toHaveLength(1);
    // The load bearing assertion: the router reached for the instance's
    // OWN recorded node, not this process's own local node id. A
    // regression that silently dispatched everything locally (or that
    // dropped the forward and refused) would fail exactly this line.
    expect(newCalls[0]?.nodeId).toBe(remoteNodeId);
    expect(newCalls[0]?.nodeId).not.toBe(localNodeId);
  });

  it('a genuinely unknown instance is still refused with E_INSTANCE_NOT_FOUND, proving the gate did not simply start accepting everything', async () => {
    await expect(
      router.dispatchAction(
        newId('inst') as InstanceId,
        { kind: 'target.list', instanceId: 'nope' },
        principal,
      ),
    ).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test 2: REST/CLI-only activity is not invisible to the idle reaper.
// ═══════════════════════════════════════════════════════════════════════

/**
 * `BrowserRouter.reaperSweep()`'s idle sweep grace period,
 * `IDLE_GRACE_MS_DEFAULT` in `packages/router/src/router/BrowserRouter.ts`:
 * a private, unexported constant (600000ms, 10 minutes), applied on top of
 * the pool's own `sessionIdleMs` before an idle instance actually
 * releases (`evaluateIdle`, `packages/router/src/router/lifecycle.ts`:
 * `ready --idleMs--> idle --idleGraceMs--> releasing`). Not configurable
 * per pool; reproduced here, with a citation, only so this suite's clock
 * math is honest about where the number comes from and does not silently
 * drift from the real one.
 */
const IDLE_GRACE_MS = 600_000;

describe('an instance driven only over REST/CLI-style calls, never WebSocket input, is not force released by the idle reaper', () => {
  let workDir: string;
  let store: Store;
  let runtime: HostRuntime;
  let profileRoot: string;
  let tenantId: TenantId;
  let appId: AppId;
  let principal: Principal;
  let clock: FakeClock;
  let nodeRegistry: NodeRegistry;
  let router: BrowserRouter;
  let sessionRegistry: SessionRegistry;
  const acquiredInstanceIds: InstanceId[] = [];

  /** `Pool.limits.sessionIdleMs`, deliberately small: real numbers would need this suite to either sleep for real (too slow for a unit suite) or advance the fake clock by the same real magnitude, which this does anyway once, at the very end of each test, in one jump. A small idleMs lets every "still alive" check in between happen on a clock that has already, on paper, blown past it. */
  const IDLE_MS = 2_000;

  beforeAll(async () => {
    workDir = shortTempRoot('rt2-');
    profileRoot = join(workDir, 'p');
    mkdirSync(profileRoot, { recursive: true });
    const stateDir = join(workDir, 's');

    store = await createSqliteStore(join(workDir, 'control.db'), { migrate: 'auto' });
    tenantId = newId('ten') as TenantId;
    appId = newId('app') as AppId;
    await store.createTenant({ id: tenantId, name: 'router-authority activity test tenant' });
    await store.createApp({ id: appId, tenantId, name: 'router-authority activity test app' });
    principal = testPrincipal(tenantId, appId);

    const nodeId = newId('nod') as NodeId;
    await store.registerNode({
      id: nodeId,
      name: 'local',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'test',
    });

    clock = new FakeClock(Date.now());
    nodeRegistry = new NodeRegistry(clock, {
      nodeId,
      capacity: {
        maxInstances: 10,
        maxMemoryMb: 8000,
        cpuCores: 4,
        profileDiskMb: 10_000,
        maxConcurrentLaunches: 2,
      },
    });
    nodeRegistry.markReady();

    const { runtime: hostRuntime } = await createHostRuntime({
      nodeId,
      stateDir,
      profileRoot,
      killOnShutdown: true,
    });
    runtime = hostRuntime;
    const fs = createProfileFs({ root: profileRoot });
    const profileService = new ProfileService({ store, fs, clock });
    const profilesPort = new ProfileServicePortAdapter(profileService);
    const localNode = new LocalNode({ runtime, profiles: profilesPort, clock });
    const nodeTransport = new LocalNodeTransport(localNode, nodeRegistry, clock);

    router = new BrowserRouter({
      store,
      nodes: nodeTransport,
      nodeRegistry,
      placement: defaultPlacementPolicy(),
      profiles: profilesPort,
      quotas: generousQuotaProvider(),
      audit: noopAuditSink,
      metrics: noopMetricsSink,
      clock,
      config: {
        // Well under `IDLE_MS`, so every drive call in the loops below is
        // a genuine, unthrottled touch, never silently absorbed by the
        // throttle window `recordActivity` itself documents.
        activityTouchThrottleMs: 100,
        // Large enough that neither the TTL nor max-duration sweep ever
        // fires across this suite's own clock advances (which reach past
        // `IDLE_MS + IDLE_GRACE_MS`, roughly ten real minutes of simulated
        // time): this suite is proving the IDLE sweep specifically, not
        // racing it against an unrelated one.
        maxDurationMs: 999_999_999,
      },
    });

    const spec = await store.upsertBrowserSpec(tenantId, TEST_SPEC_INPUT);
    await store.createPool({
      tenantId,
      name: 'default',
      specId: spec.id,
      idleTimeoutMs: IDLE_MS,
      maxDurationMs: 999_999_999,
    });

    const wiring: RouterWiring = { router, profileService, nodeTransport, nodeRegistry, nodeId };
    sessionRegistry = new SessionRegistry(createManagedSessionFactory(() => wiring));
  }, 120_000);

  afterEach(() => {
    sessionRegistry.disposeAll();
  });

  afterAll(async () => {
    for (const instanceId of acquiredInstanceIds) {
      await router
        .release(instanceId, { reason: 'test_teardown' }, principal)
        .catch(() => undefined);
    }
    await runtime.dispose();
    const stragglers = chromeProcsForDataDir(profileRoot);
    for (const proc of stragglers) {
      try {
        killProcessTree(proc.pid, 'SIGKILL');
      } catch {
        // best effort, matching `real-gateway.ts`'s own close() pattern
      }
    }
    await store.close();
    rmSync(workDir, { recursive: true, force: true });
  }, 60_000);

  it('driving through router.driveInstance() plus real navigate/screenshot calls, never dispatchInput, keeps an instance alive well past its idle threshold', async () => {
    // Refreshes the node's heartbeat before acquiring: `placementCandidates`
    // excludes a node whose last heartbeat is older than
    // `config.nodeStaleMs` (default 12000ms), and this describe block's
    // `clock` is shared and only ever advances, never resets, across every
    // `it()` in this file, including whichever ran before this one.
    nodeRegistry.heartbeat({}, []);
    const handle = await router.acquire(
      { profile: { mode: 'ephemeral' }, ttlMs: 999_999_999 },
      principal,
    );
    const acquired = await handle.ready;
    acquiredInstanceIds.push(acquired.instanceId);

    const managed = await sessionRegistry.getOrCreate(acquired.instanceId, { tenantId, appId });
    const target = await managed.newTarget('about:blank', undefined, undefined);

    // Six rounds, each advancing the clock by more than half of `IDLE_MS`:
    // by the last round, total elapsed simulated time is 9000ms against a
    // 2000ms `idleMs`, well past what the idle sweep alone would allow.
    // Each round calls `router.driveInstance()` (the gate every REST/CLI
    // route now resolves through, per `BrowserRouter.ts`'s own doc on that
    // method) immediately before a REAL driving action against the REAL
    // Chrome target (`navigate`/`screenshotTarget`, `ManagedSession`'s own
    // methods, the ones REST and CLI both call into), and NEVER calls
    // `dispatchInput` (the WS input path, the one path `onActivity` always
    // already covered even before this fix). The instance must still be `ready` after every round.
    for (let round = 0; round < 6; round += 1) {
      clock.advance(1_500);
      const resolution = await router.driveInstance(acquired.instanceId, principal);
      expect(resolution.local).toBe(true);
      if (round % 2 === 0) {
        await managed.navigate(target.targetId, 'goto', { url: 'about:blank' });
      } else {
        await managed.screenshotTarget(target.targetId, {});
      }
      await router.reaperSweep();
      const row = await store.getInstance(tenantId, acquired.instanceId);
      expect(
        row?.state,
        `instance released after round ${round}, total simulated idle time ${(round + 1) * 1_500}ms against idleMs=${IDLE_MS}ms`,
      ).not.toBe('released');
    }

    // Now prove the reaper genuinely still works, so the six rounds above
    // are not passing merely because the reaper is disabled or broken:
    // stop driving entirely, jump the clock past idleMs + the reaper's own
    // fixed grace period in one advance (no real waiting), sweep once
    // more, and the instance MUST now be released for real.
    clock.advance(IDLE_MS + IDLE_GRACE_MS + 5_000);
    await router.reaperSweep();
    const finalRow = await store.getInstance(tenantId, acquired.instanceId);
    expect(finalRow?.state).toBe('released');
    expect(finalRow?.stateReason).toBe('idle_timeout');
  }, 120_000);

  it('negative control: driving ManagedSession directly WITHOUT ever calling router.driveInstance does not, by itself, protect an instance from the idle reaper', async () => {
    // Proves the positive test above is not vacuous: if `ManagedSession`'s
    // own `navigate`/`screenshotTarget` methods secretly kept the instance
    // alive on their own (they do not; `onActivity` still fires only from
    // `dispatchInput`, unchanged by this fix, see this file's own top
    // comment), the positive test would pass for the wrong reason. This
    // confirms it is specifically `router.driveInstance()` doing the work.
    nodeRegistry.heartbeat({}, []);
    const handle = await router.acquire(
      { profile: { mode: 'ephemeral' }, ttlMs: 999_999_999 },
      principal,
    );
    const acquired = await handle.ready;
    acquiredInstanceIds.push(acquired.instanceId);

    const managed = await sessionRegistry.getOrCreate(acquired.instanceId, { tenantId, appId });
    const target = await managed.newTarget('about:blank', undefined, undefined);

    for (let round = 0; round < 3; round += 1) {
      clock.advance(1_500);
      // Deliberately no `router.driveInstance()` call in this loop.
      await managed.navigate(target.targetId, 'goto', { url: 'about:blank' });
    }

    clock.advance(IDLE_MS + IDLE_GRACE_MS + 5_000);
    await router.reaperSweep();
    const row = await store.getInstance(tenantId, acquired.instanceId);
    expect(row?.state).toBe('released');
    expect(row?.stateReason).toBe('idle_timeout');
  }, 120_000);
});
