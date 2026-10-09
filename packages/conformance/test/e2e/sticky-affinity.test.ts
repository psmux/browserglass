/**
 * The acceptance gate for browser affinity: the same user coming back gets
 * the browsers they already had, instead of a fresh set of Chrome windows.
 *
 * The user visible bug this exists for: every fresh visit to the demo's
 * `/browser` page opened a brand new set of Chrome windows. Nothing in the
 * acquire path carried any notion of "whose browser this is". The demo's
 * only reuse mechanism was a ten second idempotency bucket keyed on
 * `open:demo-user:<floor(now/10s)>`, so a visit eleven seconds later
 * missed the bucket, `findReusable` returned `none` (an ephemeral profile
 * carries no `profileKey`, no `sticky` was ever sent, and the warm pool
 * was empty), and a cold launch ran.
 *
 * The fix has three layers. This file is the proof for the router half of the fix and the two properties that hang
 * off it.
 *
 * Why this suite builds its own `BrowserRouter` rather than using
 * `startRealGateway()`
 * -------------------------------------------------------------------
 * The expiry boundary below (`canShare`'s `expiring_soon` deny) is the
 * difference between "sticky works" and "sticky is flaky", and it is
 * defined purely in terms of `expiresAt - now` against
 * `shareMinRemainingMs`. Proving it by waiting would mean either a real
 * multi minute sleep or a tiny, racy TTL. `startRealGateway()` builds its
 * router through `createBrowserGlass()`, which hardcodes the wall clock
 * (`packages/server/src/lifecycle/wiring.ts`: `const clock = systemClock;`,
 * no injection seam), so this file composes the same public
 * `@browserglass/router` pieces `wiring.ts` itself composes, with an
 * injected `Clock`. That is `Clock`'s own documented purpose
 * (`packages/router/src/router/clock.ts`), and it is the same seam
 * `router-authority.test.ts` in this directory already uses, for the same
 * reason. Everything else here is real: a real `store-sqlite` on a real
 * temp file, a real `HostRuntime`, and real Chrome processes on this
 * machine.
 *
 * What "reused" is and is not allowed to mean here
 * ------------------------------------------------
 * `AcquireResult.reused` is the router's own claim about what it did. It
 * is not, on its own, evidence that a second Chrome did not launch. Every
 * reuse assertion below is therefore paired with the set of real Chrome
 * browser-main process ids on this machine under this run's own profile
 * root, read from the operating system's process table
 * (`chromeMainProcessesUnder`, `support/real-gateway.ts`), and with the
 * `HostRuntime`'s own durable inventory of what it launched. Those two
 * disagree with the router only if the router is lying.
 *
 * No test in this file sends a `requestId`. `IdempotencyTable.withIdempotency`
 * returns `run()` immediately when `requestId` is unset, so no result here
 * can come from idempotent replay; a `reused: true` in this file always
 * came from `findReusable`. The assertions name `reuseReason: 'sticky'`
 * explicitly on top of that, so even a future durable idempotency table
 * could not satisfy them by accident.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppId,
  CAPABILITIES,
  type Capability,
  type InstanceId,
  type NodeId,
  type Principal,
  type QuotaProvider,
  type Scope,
  type Store,
  type TenantId,
  newId,
} from '@browserglass/protocol';
import {
  type AcquireResult,
  BrowserRouter,
  type Clock,
  type ClockTimer,
  DEFAULT_ROUTER_CONFIG,
  LocalNode,
  LocalNodeTransport,
  NULL_PLACEMENT_SIGNALS,
  NodeRegistry,
  ProfileService,
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
import { noopAuditSink, noopMetricsSink } from '@browserglass/server';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeMainProcessesUnder, shortTempRoot } from './support/real-gateway.js';

/** A principal with every capability, used only to drive `router.acquire()` from this harness. Never sent over any wire. Its `sub` is deliberately a constant, exactly as a service account or a demo's shared launcher identity would be: the whole point of `AcquireRequest.subject` is that a single launching principal serves many end users. */
const LAUNCHER_SUB = 'sticky-affinity-test:launcher';

function testPrincipal(tenantId: TenantId, appId: AppId): Principal {
  const scope: Scope = { kind: 'tenant' };
  return {
    tenantId,
    appId,
    sub: LAUNCHER_SUB,
    subKind: 'service',
    caps: [...CAPABILITIES] as Capability[],
    scope,
    jti: 'sticky-affinity-test',
    exp: Number.MAX_SAFE_INTEGER,
  };
}

/** The `BrowserSpec` this file's pool is registered against. Headless, so the suite runs unattended. */
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

/** `BrowserRouter`'s injectable `Clock`, driven entirely by hand. `router.start()` is never called, so no real timer is ever armed and advancing `now()` is inert except for the comparisons under test. */
class FakeClock implements Clock {
  private currentMs: number;
  constructor(startMs: number) {
    this.currentMs = startMs;
  }
  now(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
  /** Jumps straight to an absolute instant, for a boundary this suite needs to land on exactly rather than approximately. */
  set(ms: number): void {
    this.currentMs = ms;
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

/** Generous, never-the-limiting-factor `QuotaProvider`: nothing here tests quota. */
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

/**
 * `RouterConfig.shareMinRemainingMs`, passed explicitly rather than left
 * to `DEFAULT_ROUTER_CONFIG` (where it is the same 60000) so the boundary
 * arithmetic below reads against a number this file states out loud. An
 * instance is refused for sharing when `expiresAt - now < shareMinRemainingMs`
 * (`canShare`, `packages/router/src/router/reuse.ts`), so at exactly
 * `shareMinRemainingMs` remaining it is still shareable and one
 * millisecond later it is not.
 */
const SHARE_MIN_REMAINING_MS = 60_000;

/** Every instance this file acquires gets an hour, comfortably clear of the boundary until a test deliberately walks the clock up to it. */
const TTL_MS = 3_600_000;

/** A day. `findReusable`'s sticky branch also filters on `now - lastActivityAt <= withinMs`; this is set far beyond anything these tests advance the clock by, so the recency window is never the reason a reuse succeeds or fails here. The expiry boundary tests below would otherwise be unable to tell the two refusals apart. */
const STICKY_WITHIN_MS = 86_400_000;

let workDir: string;
let profileRoot: string;
let store: Store;
let runtime: HostRuntime;
let tenantId: TenantId;
let appId: AppId;
let principal: Principal;
let clock: FakeClock;
let nodeRegistry: NodeRegistry;
let router: BrowserRouter;

const acquiredInstanceIds = new Set<InstanceId>();

/**
 * One acquire, with the affinity pair spelled out.
 *
 * `subject` and `sticky.subject` are passed as separate fields because the
 * router treats them as separate things: `doAcquire` stamps
 * `subject: req.subject ?? principal.sub` onto the new instance row, and
 * `findReusable` later matches `instance.subject` against
 * `sticky.subject`. A caller that sends only `sticky` gets rows stamped
 * with the launching principal's sub and never matches anything, which
 * this file proves directly in its own test for it.
 *
 * The `profile` field is OMITTED by default, and `withEphemeralProfile`
 * adds it back as `{ mode: 'ephemeral' }`. The two forms are identical in
 * everything that reaches the reuse machinery: `doAcquire` resolves the
 * profile as `req.profile ?? pool.profileTemplate`, and a pool's
 * `profileTemplate` defaults to `{ mode: 'ephemeral' }`
 * (`store-sqlite/src/mappers.ts`), so both produce the same resolved
 * ephemeral profile and the same `profileKey: null` for `findReusable`.
 * They differ in exactly one place, `doAcquire`'s selector count, and that
 * one difference is the bug. Splitting them this way lets every reuse,
 * isolation and expiry property below be proved for real, today, against
 * real Chrome, while the selector gate itself is isolated into its own
 * describe at the foot of this file where its current failure is the whole
 * point.
 */
async function acquire(opts: {
  subject: string;
  sticky?: boolean;
  withinMs?: number;
  /** Send `profile: { mode: 'ephemeral' }` alongside `sticky`: the demo's own request shape, and the one `doAcquire` currently refuses. */
  withEphemeralProfile?: boolean;
  /** Send `sticky` but NOT `subject`, the trap documented below. */
  stickyWithoutSubject?: boolean;
}): Promise<AcquireResult> {
  // `placementCandidates` excludes a node whose last heartbeat is older
  // than `config.nodeStaleMs` (12000ms by default), and this file's clock
  // is shared across every test and jumps by whole minutes. Without this,
  // a test that advanced the clock would fail on placement rather than on
  // the thing it means to assert.
  nodeRegistry.heartbeat({}, []);
  const handle = await router.acquire(
    {
      ...(opts.withEphemeralProfile ? { profile: { mode: 'ephemeral' as const } } : {}),
      ...(opts.stickyWithoutSubject ? {} : { subject: opts.subject }),
      ...(opts.sticky === false
        ? {}
        : { sticky: { subject: opts.subject, withinMs: opts.withinMs ?? STICKY_WITHIN_MS } }),
      ttlMs: TTL_MS,
    },
    principal,
  );
  const result = await handle.ready;
  acquiredInstanceIds.add(result.instanceId);
  return result;
}

/** Real Chrome browser-main processes on this machine belonging to this run. The operating system's answer, not the router's. */
function realChromeCount(): number {
  return chromeMainProcessesUnder(profileRoot).length;
}

/** The pids of those processes. */
function chromePids(): Set<number> {
  return new Set(chromeMainProcessesUnder(profileRoot).map((p) => p.pid));
}

/**
 * Which Chrome browser-main pids appeared since `before` was taken.
 *
 * Every "did a browser launch" assertion in this file is written against
 * this rather than against a raw count, because a raw count can also move
 * DOWN: a `release()` in an earlier test hands Chrome a termination that
 * completes on its own schedule, so a straggler dying in the middle of a
 * later test would change a count without anything having launched. A set
 * difference measures the launch specifically, which is the property, and
 * is indifferent to deaths.
 */
function pidsAppearedSince(before: ReadonlySet<number>): number[] {
  return [...chromePids()].filter((pid) => !before.has(pid));
}

/** The `HostRuntime`'s own durable record of every browser it launched and still believes alive. A second, independent cross check on `realChromeCount()`. */
async function runtimeLiveCount(): Promise<number> {
  const inventory = await runtime.list();
  return inventory.filter((e) => e.status === 'live').length;
}

/** Every instance row this tenant currently has in a status `findReusable` would consider. */
async function liveInstanceIds(): Promise<InstanceId[]> {
  const rows = await store.listInstances(tenantId, { status: ['live', 'warm', 'recovering'] });
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  workDir = shortTempRoot('sa-');
  profileRoot = join(workDir, 'p');
  mkdirSync(profileRoot, { recursive: true });
  const stateDir = join(workDir, 's');

  store = await createSqliteStore(join(workDir, 'control.db'), { migrate: 'auto' });
  tenantId = newId('ten') as TenantId;
  appId = newId('app') as AppId;
  await store.createTenant({ id: tenantId, name: 'sticky affinity test tenant' });
  await store.createApp({ id: appId, tenantId, name: 'sticky affinity test app' });
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
      maxInstances: 20,
      maxMemoryMb: 16_000,
      cpuCores: 8,
      profileDiskMb: 40_000,
      maxConcurrentLaunches: 4,
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
    placement: new ScoredPlacementPolicy(
      DEFAULT_ROUTER_CONFIG.placementWeights,
      DEFAULT_ROUTER_CONFIG.targetUtilisation,
      DEFAULT_ROUTER_CONFIG.scoreFloor,
      NULL_PLACEMENT_SIGNALS,
    ),
    profiles: profilesPort,
    quotas: generousQuotaProvider(),
    audit: noopAuditSink,
    metrics: noopMetricsSink,
    clock,
    config: {
      shareMinRemainingMs: SHARE_MIN_REMAINING_MS,
      // Nothing here should ever be released by a sweep: `reaperSweep()` is
      // never called in this file, and these keep even an accidental one
      // from turning a clock advance into an unrelated release.
      maxDurationMs: 999_999_999,
    },
  });

  const spec = await store.upsertBrowserSpec(tenantId, TEST_SPEC_INPUT);
  // `placeAndLaunch` clamps the request's `ttlMs` to the pool's own
  // `maxDurationMs` (`const ttl = Math.min(args.ttlMs ?? maxDurationMs, maxDurationMs)`),
  // so the pool has to allow at least `TTL_MS` or the boundary arithmetic
  // below would be computed against a number the pool silently overrode.
  await store.createPool({
    tenantId,
    name: 'default',
    specId: spec.id,
    maxDurationMs: 999_999_999,
    idleTimeoutMs: 999_999_999,
  });
}, 120_000);

afterAll(async () => {
  for (const instanceId of acquiredInstanceIds) {
    await router.release(instanceId, { reason: 'test_teardown' }, principal).catch(() => undefined);
  }
  await runtime.dispose();
  for (const proc of chromeMainProcessesUnder(profileRoot)) {
    try {
      killProcessTree(proc.pid, 'SIGKILL');
    } catch {
      // best effort, matching `real-gateway.ts`'s own close() pattern
    }
  }
  // Belt and braces: the exact-data-dir sweep the rest of the package uses.
  for (const proc of chromeProcsForDataDir(profileRoot)) {
    try {
      killProcessTree(proc.pid, 'SIGKILL');
    } catch {
      // best effort
    }
  }
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════
// Property 1: reattach, do not relaunch.
// ═══════════════════════════════════════════════════════════════════════

describe('the same subject reattaches to its existing browser instead of launching a new one', () => {
  let first: AcquireResult;

  it('the process-table probe this suite measures with actually sees the browser it just launched', async () => {
    // Guard on the fixture itself, first, before anything is asserted
    // THROUGH it. A count of real Chromes is only evidence if it can read
    // a real Chrome; a probe that always answers zero would make every
    // "no second browser launched" assertion below pass for free. An
    // earlier attempt at this used `chromeProcsForDataDir(profileRoot)`,
    // which demands an exact `--user-data-dir=` match and therefore
    // answers zero for a healthy run, because the real value sits four
    // levels below the root.
    expect(realChromeCount()).toBe(0);
    first = await acquire({ subject: 'alice' });
    expect(first.reused).toBe(false);
    expect(
      realChromeCount(),
      'the probe read zero real Chrome processes immediately after a successful launch, so the probe is broken, not the product',
    ).toBe(1);
    expect(await runtimeLiveCount()).toBe(1);
  }, 180_000);

  it('a second acquire for the same subject returns the SAME instanceId, reused, with reuseReason sticky', async () => {
    const second = await acquire({ subject: 'alice' });
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.reused).toBe(true);
    // Named explicitly rather than just `reused`. `reused` is also true for
    // an idempotent replay and for a warm adoption; only `'sticky'` says
    // the subject match is what did it. No `requestId` is sent from this
    // file at all, so idempotent replay is not even reachable, but the
    // assertion says which mechanism is under test regardless.
    expect(second.reuseReason).toBe('sticky');
  }, 180_000);

  it('exactly ONE real Chrome browser process exists after both acquires', async () => {
    // The assertion the whole task turns on. `reused: true` above is the
    // router's own account of itself; this is the operating system's.
    // Before the fix the demo produced a fresh set of windows on every
    // visit, which is precisely this number climbing.
    expect(realChromeCount()).toBe(1);
    expect(await runtimeLiveCount()).toBe(1);
    expect(await liveInstanceIds()).toEqual([first.instanceId]);
  }, 60_000);

  it('a third and fourth acquire still land on that one browser', async () => {
    // Three visits in a row is what the demo actually did. One extra
    // reuse would be indistinguishable from a lucky idempotency bucket;
    // several in a row, with the clock advanced between them past any
    // plausible bucket, is not.
    clock.advance(30_000);
    const third = await acquire({ subject: 'alice' });
    clock.advance(30_000);
    const fourth = await acquire({ subject: 'alice' });
    expect([third.instanceId, fourth.instanceId]).toEqual([first.instanceId, first.instanceId]);
    expect([third.reuseReason, fourth.reuseReason]).toEqual(['sticky', 'sticky']);
    expect(realChromeCount()).toBe(1);
    expect(await runtimeLiveCount()).toBe(1);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════
// Property 2: different subjects stay isolated.
// ═══════════════════════════════════════════════════════════════════════

describe('two different subjects never share a browser', () => {
  let alice: InstanceId;
  let bob: InstanceId;

  it('subject bob gets a different instanceId from subject alice, and a second real browser launches for him', async () => {
    const before = chromePids();
    const aliceResult = await acquire({ subject: 'alice' });
    alice = aliceResult.instanceId;
    expect(
      aliceResult.reuseReason,
      'alice should still be reattaching to her own browser at this point',
    ).toBe('sticky');
    expect(pidsAppearedSince(before), 'alice reattaching must not have launched anything').toEqual(
      [],
    );

    const bobResult = await acquire({ subject: 'bob' });
    bob = bobResult.instanceId;
    // The isolation assertion. A router that matched sticky on the
    // LAUNCHING principal rather than on the request's subject would hand
    // bob alice's browser here, which is not a performance problem, it is
    // one user driving another user's session.
    expect(bob).not.toBe(alice);
    expect(bobResult.reused).toBe(false);
    expect(bobResult.reuseReason).toBeNull();
    expect(
      pidsAppearedSince(before),
      'bob must get his own real browser, and exactly one',
    ).toHaveLength(1);
  }, 240_000);

  it("alice re-acquiring after bob still gets alice's own browser, not the most recent one", async () => {
    // `findReusable`'s sticky branch sorts candidates by `lastActivityAt`
    // descending and takes the first. Bob's instance is the most recently
    // touched row in the table at this point, so a subject filter that was
    // dropped, widened, or applied after the sort would hand alice bob's
    // browser. This is the assertion that catches that.
    const again = await acquire({ subject: 'alice' });
    expect(again.instanceId).toBe(alice);
    expect(again.instanceId).not.toBe(bob);
    expect(again.reuseReason).toBe('sticky');
  }, 180_000);

  it("each subject's instance row carries that subject, which is what makes the isolation durable", async () => {
    const aliceRow = await store.getInstance(tenantId, alice);
    const bobRow = await store.getInstance(tenantId, bob);
    expect(aliceRow?.subject).toBe('alice');
    expect(bobRow?.subject).toBe('bob');
    // Neither row is stamped with the launching principal. Both users came
    // in through the SAME service principal (`LAUNCHER_SUB`), exactly as a
    // demo or a REST on-ramp does; if the router had stamped that instead,
    // both rows would read `sticky-affinity-test:launcher` and every user
    // would share one browser.
    expect(aliceRow?.subject).not.toBe(LAUNCHER_SUB);
    expect(bobRow?.subject).not.toBe(LAUNCHER_SUB);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════
// The trap that makes all of the above conditional.
// ═══════════════════════════════════════════════════════════════════════

describe('sticky.subject on its own, with no AcquireRequest.subject beside it, silently never reattaches', () => {
  it('two acquires sending only sticky launch two separate browsers', async () => {
    // This is not a wish list item, it is a live trap in the contract, and
    // it is pinned here because every caller wiring up affinity will hit
    // it. `doAcquire` stamps `subject: req.subject ?? principal.sub` onto
    // the new instance row, while `findReusable` matches
    // `instance.subject === sticky.subject`. Send only `sticky` and the
    // row is stamped with the LAUNCHING principal's sub, so the very next
    // request for the same sticky subject matches nothing and launches
    // again. There is no error and no warning: affinity simply does not
    // happen.
    //
    // Worse, in the shape a demo actually deploys (one service principal
    // for every visitor), every instance row ends up carrying that one
    // shared sub, so a router that DID fall back to matching on it would
    // hand every visitor the first visitor's browser.
    //
    // If the router is later changed to default `subject` from
    // `sticky.subject`, this test fails, which is the intended outcome:
    // that is a deliberate contract change and it should not pass
    // silently.
    const before = chromePids();
    const one = await acquire({ subject: 'carol', stickyWithoutSubject: true });
    const two = await acquire({ subject: 'carol', stickyWithoutSubject: true });
    expect(one.instanceId).not.toBe(two.instanceId);
    expect(two.reused).toBe(false);
    expect(
      pidsAppearedSince(before),
      'sticky without subject launched fewer browsers than expected, so the contract has changed',
    ).toHaveLength(2);

    const row = await store.getInstance(tenantId, one.instanceId);
    expect(
      row?.subject,
      'the row was stamped with the launching principal, which is why nothing matched',
    ).toBe(LAUNCHER_SUB);

    await router
      .release(one.instanceId, { reason: 'test_teardown' }, principal)
      .catch(() => undefined);
    await router
      .release(two.instanceId, { reason: 'test_teardown' }, principal)
      .catch(() => undefined);
    acquiredInstanceIds.delete(one.instanceId);
    acquiredInstanceIds.delete(two.instanceId);
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════
// Property 4: the expiry boundary.
// ═══════════════════════════════════════════════════════════════════════

describe('an instance too close to its own expiry is not reused, a fresh one launches', () => {
  let dave: AcquireResult;
  let daveExpiresAt: number;

  beforeAll(async () => {
    dave = await acquire({ subject: 'dave' });
    const row = await store.getInstance(tenantId, dave.instanceId);
    if (!row) throw new Error("dave's instance vanished immediately after acquire");
    daveExpiresAt = row.expiresAt;
    // `placeAndLaunch` writes `expiresAt: clock.now() + ttl` on the
    // transition to `live`, and this file's clock only moves when a test
    // moves it, so this is an exact number rather than an approximate one.
    // Everything below lands on it to the millisecond.
    expect(daveExpiresAt - clock.now()).toBe(TTL_MS);
  }, 180_000);

  it('with exactly shareMinRemainingMs left on the clock, the instance is still reused', async () => {
    // The refusal in `canShare` is `expiresAt - now < shareMinRemainingMs`,
    // a strict less-than, so exactly `shareMinRemainingMs` remaining is
    // still shareable. Landing on the boundary from the allowed side first
    // is what makes the next test meaningful: the two differ by one
    // millisecond of simulated time and by nothing else at all, which is a
    // sharper control than stashing a fix could give.
    clock.set(daveExpiresAt - SHARE_MIN_REMAINING_MS);
    expect(daveExpiresAt - clock.now()).toBe(SHARE_MIN_REMAINING_MS);
    const before = chromePids();

    const again = await acquire({ subject: 'dave' });
    expect(again.instanceId).toBe(dave.instanceId);
    expect(again.reuseReason).toBe('sticky');
    expect(
      pidsAppearedSince(before),
      'a browser launched on the shareable side of the boundary',
    ).toEqual([]);
  }, 180_000);

  it('one millisecond further in, the instance is NOT reused and a fresh browser launches', async () => {
    clock.advance(1);
    expect(daveExpiresAt - clock.now()).toBe(SHARE_MIN_REMAINING_MS - 1);
    const before = chromePids();

    const fresh = await acquire({ subject: 'dave' });
    // Not reused, and specifically not reused for a REUSE reason: a null
    // `reuseReason` with `reused: false` is a cold launch.
    expect(fresh.instanceId).not.toBe(dave.instanceId);
    expect(fresh.reused).toBe(false);
    expect(fresh.reuseReason).toBeNull();
    // And it really did launch: this is the half that distinguishes "the
    // router declined to reuse" from "the router declined to do anything".
    expect(
      pidsAppearedSince(before),
      'the router refused the reuse but never launched the replacement',
    ).toHaveLength(1);

    // The old instance is still alive and still dave's; it was passed over
    // for being close to expiry, not released. A test that asserted only
    // "a different id came back" would also pass if the router had
    // destroyed the first browser, which is a different behaviour with a
    // different bug attached to it.
    const oldRow = await store.getInstance(tenantId, dave.instanceId);
    expect(oldRow?.state).toBe('ready');
    expect(oldRow?.subject).toBe('dave');

    // The recency window is not what refused it: `withinMs` is a day and
    // the clock has moved by under an hour, so the only clause that can
    // have fired is `expiring_soon`.
    expect(clock.now() - (oldRow?.lastActivityAt ?? 0)).toBeLessThan(STICKY_WITHIN_MS);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════
// The demo's own request shape: sticky ALONGSIDE an ephemeral profile.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Everything above sends `sticky` with the `profile` field omitted, which
 * resolves through the pool's `profileTemplate` to the same ephemeral
 * profile and is accepted today. This describe sends the one extra field
 * the demo actually sends, `profile: { mode: 'ephemeral' }`, and asserts
 * the outcome is identical.
 *
 * `doAcquire` currently computes
 *
 *     const selectorCount = (req.profile ? 1 : 0) + (req.sticky ? 1 : 0);
 *     if (selectorCount > 1) throw routerErr('E_CONFLICTING_SELECTORS', ...)
 *
 * which counts ANY `profile`, including `{ mode: 'ephemeral' }`, a value
 * that names no key and therefore selects nothing at all.
 * `AcquireRequest`'s own doc comment says "at most one of instanceId,
 * profile.key, sticky", so the code is stricter than the contract it
 * documents, and "an ephemeral browser, sticky to this user", the single
 * most obvious way to ask for what the demo needs, is refused.
 *
 * The two tests here are the acceptance gate for that one line.
 */
describe('sticky alongside an ephemeral profile, the shape the demo actually sends', () => {
  it('is accepted rather than refused as conflicting selectors', async () => {
    // An ephemeral profile carries no key, so it selects nothing and
    // cannot conflict with anything. Only `profile.key` is a selector.
    const eve = await acquire({ subject: 'eve', withEphemeralProfile: true });
    expect(eve.instanceId).toBeTruthy();
    expect(eve.profile.mode).toBe('ephemeral');
  }, 180_000);

  it('reattaches the same subject to the same browser, with no second Chrome, exactly as the profile-less form does', async () => {
    const before = chromePids();
    const firstVisit = await acquire({ subject: 'frank', withEphemeralProfile: true });
    expect(firstVisit.reused).toBe(false);
    expect(pidsAppearedSince(before)).toHaveLength(1);

    // The demo's second page load. Clock advanced well past any
    // idempotency bucket, and no `requestId` is sent at all, so the only
    // mechanism that can return the same instance is sticky reuse.
    clock.advance(60_000);
    const secondVisit = await acquire({ subject: 'frank', withEphemeralProfile: true });
    expect(secondVisit.instanceId).toBe(firstVisit.instanceId);
    expect(secondVisit.reuseReason).toBe('sticky');
    expect(
      pidsAppearedSince(before),
      'the second visit launched another Chrome, which is the original bug',
    ).toHaveLength(1);

    // And a different subject sending the same shape still gets his own.
    const grace = await acquire({ subject: 'grace', withEphemeralProfile: true });
    expect(grace.instanceId).not.toBe(firstVisit.instanceId);
    expect(pidsAppearedSince(before)).toHaveLength(2);

    // The persistent selector really is still a selector: naming a
    // profile KEY alongside sticky is a genuine conflict and must stay
    // refused, or this fix has widened the gate instead of correcting it.
    nodeRegistry.heartbeat({}, []);
    await expect(
      router.acquire(
        {
          profile: { mode: 'persistent', key: 'a-real-key' },
          sticky: { subject: 'frank' },
          subject: 'frank',
        },
        principal,
      ),
    ).rejects.toMatchObject({ code: 'E_CONFLICTING_SELECTORS' });
  }, 300_000);
});
