/**
 * `lifecycle/wiring.ts`'s orphan sweep, step 7 of `runStart`'s documented
 * start sequence.
 *
 * The defect the sweep exists for: nothing anywhere reconciled the
 * `instances` table against runtime reality. The demo gateway runs its host
 * runtime with `killOnShutdown: true`, so every gateway exit kills its
 * browsers, and on the next boot the previous boot's rows are still
 * `status='live'`. They count against `maxInstances`, they are handed back
 * by sticky reuse as though a browser were behind them, and their profile
 * leases are never released, so a later acquire naming the same key hits a
 * false `E_PROFILE_BUSY`.
 *
 * The defect the sweep ITSELF then had, found in live verification: it
 * decided "no other node shares this store" from configuration alone, which
 * is true of a distributed deployment and false of somebody starting the
 * dev server twice. The second process retired the first process's healthy
 * instances and then died on `EADDRINUSE`. The real store suites at the
 * bottom of this file are that scenario, against a real shared SQLite file,
 * run over both shapes an `instances` row can have.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserRuntime,
  Instance,
  NodeId,
  RuntimeInventoryEntry,
  Store,
} from '@browserglass/protocol';
import type { Clock, ClockTimer, LocalNode } from '@browserglass/router';
import { systemClock } from '@browserglass/router';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '../../src/config/logger.js';
import { resolveConfig } from '../../src/config/resolve.js';
import {
  ORPHANED_BY_RESTART,
  buildProfileLeaseIndex,
  liveOwnerVerdict,
  orphanSweepDelayMs,
  orphanSweepScope,
  reapOrphanedInstances,
  scheduleOrphanSweep,
} from '../../src/lifecycle/wiring.js';

const OUR_NODE = 'nod_ours' as NodeId;
const OTHER_NODE = 'nod_theirs' as NodeId;

/**
 * `reapOrphanedInstances`'s `notBefore`. Every fixture row below is stamped
 * `acquiredAt: 1000`, comfortably before this, so the "created after we
 * booted" guard never fires except in the test that is about it.
 */
const SWEEP_START = 5_000;

/**
 * One `instances` row, only the fields the sweep actually reads.
 *
 * `profileId` is NULL here on purpose, and the sweep must not care. Rows
 * written before `store-sqlite`'s `transitionInstance` started persisting
 * the field carry null forever, and an upgraded database is what this code
 * meets. The real store suite at the bottom of this file covers BOTH
 * shapes against a real SQLite file, which is where the independence is
 * actually pinned.
 *
 * Worth remembering why. An earlier version of this fixture set
 * `profileId` to a real value, which no production row had at the time,
 * and the sweep passed every test while being incapable of retiring
 * anything at all. A fixture more generous than reality proves nothing.
 * The correction after that overshot in the opposite direction, asserting
 * the column WAS null, which pinned a store defect as an invariant and
 * broke the moment somebody fixed it. Neither value is the invariant; the
 * independence from it is.
 */
function row(id: string, over?: Partial<Instance>): Instance {
  return {
    id,
    tenantId: 'ten_1',
    nodeId: OUR_NODE,
    profileId: null,
    acquiredAt: 1000,
    ...over,
  } as unknown as Instance;
}

/** One runtime inventory entry, only the fields the sweep and `adoptSurvivor` read. */
function entry(instanceId: string, status: RuntimeInventoryEntry['status']): RuntimeInventoryEntry {
  return {
    instanceId,
    status,
    pid: 4242,
    containerId: null,
    profilePath: `/tmp/${instanceId}`,
    cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
    engineVersion: '131.0.0.0',
    startedAt: 0,
  } as unknown as RuntimeInventoryEntry;
}

interface Recorded {
  readonly transitions: { id: string; to: string; reason: string | null }[];
  readonly leaseReleases: { leaseId: string; reason: string }[];
  readonly profileStates: { profileId: string; state: string }[];
}

type FakeLease = {
  id: string;
  holderInstanceId: string | null;
  releasedAt: number | null;
  expiresAt: number;
};

/** One `profiles` row with its unreleased lease hanging off it, which is the only shape a `ProfileLease` ever reaches a caller in. */
function profileWithLease(profileId: string, lease: FakeLease | null) {
  return { id: profileId, lease };
}

function fakeStore(
  rows: readonly Instance[],
  recorded: Recorded,
  opts?: { readonly profiles?: readonly ReturnType<typeof profileWithLease>[] },
): Store {
  return {
    listTenants: async () => [{ id: 'ten_1' }],
    listInstances: async () => [...rows],
    transitionInstance: async (
      _tenantId: string,
      id: string,
      _from: string[],
      to: string,
      patch?: Partial<Instance>,
    ) => {
      recorded.transitions.push({ id, to, reason: patch?.stateReason ?? null });
      return true;
    },
    listProfiles: async () => [...(opts?.profiles ?? [])],
    releaseProfileLease: async (leaseId: string, reason: string) => {
      recorded.leaseReleases.push({ leaseId, reason });
    },
    setProfileState: async (_tenantId: string, profileId: string, state: string) => {
      recorded.profileStates.push({ profileId, state });
    },
  } as unknown as Store;
}

function fakeRuntime(
  inventory: readonly RuntimeInventoryEntry[],
  opts?: { readonly attachFails?: boolean },
): BrowserRuntime {
  return {
    list: async () => [...inventory],
    attach: async () => {
      if (opts?.attachFails === true) throw new Error('CDP probe timed out');
      return { teardown: async () => undefined } as unknown as never;
    },
  } as unknown as BrowserRuntime;
}

function fakeLocalNode(held: readonly string[]): { node: LocalNode; attached: string[] } {
  const attached: string[] = [];
  const handles = new Set(held);
  const node = {
    handleFor: (instanceId: string) => (handles.has(instanceId) ? ({} as never) : null),
    attach: async (instanceId: string) => {
      attached.push(instanceId);
      handles.add(instanceId);
    },
  } as unknown as LocalNode;
  return { node, attached };
}

function blank(): Recorded {
  return { transitions: [], leaseReleases: [], profileStates: [] };
}

/** Runs one sweep with the fixture defaults, so each test states only what it is actually varying. */
async function sweep(args: {
  store: Store;
  runtime?: BrowserRuntime;
  localNode?: LocalNode;
  scopedToOwnNodeId?: boolean;
  notBefore?: number;
  now?: number;
}) {
  return reapOrphanedInstances({
    store: args.store,
    runtime: args.runtime ?? fakeRuntime([]),
    localNode: args.localNode ?? fakeLocalNode([]).node,
    clock: { ...systemClock, now: () => args.now ?? SWEEP_START + 1000 },
    nodeId: OUR_NODE,
    scopedToOwnNodeId: args.scopedToOwnNodeId ?? false,
    notBefore: args.notBefore ?? SWEEP_START,
    logger: noopLogger,
  });
}

describe('orphan sweep: what it retires', () => {
  it('retires a row the runtime has no entry for at all, with stateReason orphaned_by_restart', async () => {
    const recorded = blank();
    const report = await sweep({ store: fakeStore([row('inst_phantom')], recorded) });

    expect(report.reaped).toEqual(['inst_phantom']);
    expect(recorded.transitions).toEqual([
      { id: 'inst_phantom', to: 'failed', reason: ORPHANED_BY_RESTART },
    ]);
  });

  it("retires a row the runtime reports with status 'unknown', which is how a dead pid comes back", async () => {
    // `HostRuntime.list()` maps `pidAlive(e.pid) ? 'live' : 'unknown'`, so a
    // browser killed at the last shutdown is an ENTRY with a dead process,
    // not an absence. Treating only absence as gone would leave half the
    // phantoms looping through the reaper forever.
    const recorded = blank();
    const report = await sweep({
      store: fakeStore([row('inst_dead')], recorded),
      runtime: fakeRuntime([entry('inst_dead', 'unknown')]),
    });

    expect(report.reaped).toEqual(['inst_dead']);
    expect(recorded.transitions[0]?.to).toBe('failed');
  });

  it('releases the retired row profile lease and puts the profile back to free', async () => {
    const recorded = blank();
    const store = fakeStore([row('inst_phantom')], recorded, {
      profiles: [
        profileWithLease('prf_1', {
          id: 'plse_1',
          holderInstanceId: 'inst_phantom',
          releasedAt: null,
          expiresAt: 0,
        }),
      ],
    });

    await sweep({ store });

    expect(recorded.leaseReleases).toEqual([{ leaseId: 'plse_1', reason: ORPHANED_BY_RESTART }]);
    expect(recorded.profileStates).toEqual([{ profileId: 'prf_1', state: 'free' }]);
  });

  it('leaves a lease alone when some other instance holds it', async () => {
    const recorded = blank();
    const store = fakeStore([row('inst_phantom')], recorded, {
      profiles: [
        profileWithLease('prf_1', {
          id: 'plse_2',
          holderInstanceId: 'inst_someone_else',
          releasedAt: null,
          expiresAt: Number.MAX_SAFE_INTEGER,
        }),
      ],
    });

    const report = await sweep({ store });

    // The row is still retired: a lease held by a different instance is no
    // evidence about THIS one, so it neither vetoes the reap nor gets
    // touched by it.
    expect(report.reaped).toEqual(['inst_phantom']);
    expect(recorded.leaseReleases).toEqual([]);
    expect(recorded.profileStates).toEqual([]);
  });

  it('retires a row with a lapsed lease even though instances.profile_id is null, which is every row in production', async () => {
    // THE regression test for the lookup key. Resolved through
    // `instance.profileId` this row is unjudgeable, so the sweep skips it
    // and retires nothing, forever, in silence. Resolved through
    // `profile_leases.instance_id` it is exactly what it looks like.
    const recorded = blank();
    const store = fakeStore([row('inst_phantom')], recorded, {
      profiles: [
        profileWithLease('prf_1', {
          id: 'plse_1',
          holderInstanceId: 'inst_phantom',
          releasedAt: null,
          expiresAt: SWEEP_START - 1,
        }),
      ],
    });

    const report = await sweep({ store, now: SWEEP_START + 1000 });

    expect(report.skippedUndecidable).toEqual([]);
    expect(report.reaped).toEqual(['inst_phantom']);
    expect(recorded.leaseReleases).toEqual([{ leaseId: 'plse_1', reason: ORPHANED_BY_RESTART }]);
  });
});

describe('orphan sweep: what it must NOT retire', () => {
  it('adopts, rather than retires, a row whose browser the runtime still reports live', async () => {
    const recorded = blank();
    const { node, attached } = fakeLocalNode([]);
    const report = await sweep({
      store: fakeStore([row('inst_survivor')], recorded),
      runtime: fakeRuntime([entry('inst_survivor', 'live')]),
      localNode: node,
    });

    expect(report.reaped).toEqual([]);
    expect(report.adopted).toEqual(['inst_survivor']);
    expect(attached).toEqual(['inst_survivor']);
    expect(recorded.transitions).toEqual([]);
  });

  it('leaves a row live when a browser is out there and adoption fails, rather than marking a running Chrome dead', async () => {
    const recorded = blank();
    const report = await sweep({
      store: fakeStore([row('inst_stuck')], recorded),
      runtime: fakeRuntime([entry('inst_stuck', 'live')], { attachFails: true }),
    });

    expect(report.reaped).toEqual([]);
    expect(report.unreachable).toEqual(['inst_stuck']);
    expect(recorded.transitions).toEqual([]);
  });

  it("never retires a row the runtime calls 'orphan' or 'foreign'", async () => {
    for (const status of ['orphan', 'foreign'] as const) {
      const recorded = blank();
      const report = await sweep({
        store: fakeStore([row('inst_x')], recorded),
        runtime: fakeRuntime([entry('inst_x', status)]),
      });

      expect(report.reaped).toEqual([]);
      expect(report.unreachable).toEqual(['inst_x']);
      expect(recorded.transitions).toEqual([]);
    }
  });

  it('skips a row this node already holds a handle for, which is the adopt-before-reap guarantee', async () => {
    // This is `reattachSurvivors` having already run: it hands `localNode` a
    // handle for every browser that outlived the last process, so by the
    // time the sweep looks, a survivor is indistinguishable from an instance
    // this process launched itself. Run the two the other way round and this
    // row has no handle yet, which is the whole reason the ordering in
    // `buildRouterWiring` is load bearing rather than incidental.
    const recorded = blank();
    const { node } = fakeLocalNode(['inst_adopted']);
    const report = await sweep({
      // Deliberately an empty inventory: even with the runtime saying
      // nothing at all, a held handle is enough to keep the row.
      store: fakeStore([row('inst_adopted')], recorded),
      localNode: node,
    });

    expect(report.reaped).toEqual([]);
    expect(report.adopted).toEqual([]);
    expect(recorded.transitions).toEqual([]);
  });

  it('skips a row whose profile lease is still being renewed, because a live process owns it', async () => {
    // The gate the first version of this sweep did not have. Everything the
    // runtime inventory can tell this process is about THIS process; an
    // instance another live gateway owns looks identical from here. Note
    // the row carries no `profileId`, as production rows do not: the lease
    // is found by `profile_leases.instance_id`.
    const recorded = blank();
    const store = fakeStore([row('inst_theirs')], recorded, {
      profiles: [
        profileWithLease('prf_9', {
          id: 'plse_9',
          holderInstanceId: 'inst_theirs',
          releasedAt: null,
          expiresAt: SWEEP_START + 30_000,
        }),
      ],
    });

    const report = await sweep({ store, now: SWEEP_START + 1000 });

    expect(report.reaped).toEqual([]);
    expect(report.skippedLiveOwner).toEqual(['inst_theirs']);
    expect(recorded.transitions).toEqual([]);
    expect(recorded.leaseReleases).toEqual([]);
  });

  it('retires a row with no lease row at all, once the scan is known to be complete', async () => {
    const recorded = blank();
    const report = await sweep({
      store: fakeStore([row('inst_leaseless')], recorded, { profiles: [] }),
    });

    expect(report.reaped).toEqual(['inst_leaseless']);
  });

  it('refuses to judge anything when the profile scan was incomplete', async () => {
    // The only remaining meaning of `undecidable`: the tenant has more
    // profiles than one scan reads, so a MISS in the index carries no
    // information at all and a reap would be a guess.
    const recorded = blank();
    const many = Array.from({ length: 10_000 }, (_unused, i) =>
      profileWithLease(`prf_${String(i)}`, null),
    );
    const report = await sweep({
      store: fakeStore([row('inst_unknown')], recorded, { profiles: many }),
    });

    expect(report.reaped).toEqual([]);
    expect(report.skippedUndecidable).toEqual(['inst_unknown']);
    expect(recorded.transitions).toEqual([]);
  });

  it('never touches a row created after this process was already running', async () => {
    const recorded = blank();
    const report = await sweep({
      store: fakeStore([row('inst_newer', { acquiredAt: SWEEP_START + 1 })], recorded),
      notBefore: SWEEP_START,
    });

    expect(report.reaped).toEqual([]);
    expect(recorded.transitions).toEqual([]);
  });
});

describe('orphan sweep: node scoping', () => {
  it('leaves another node rows alone when scoped to this node own id', async () => {
    const recorded = blank();
    const report = await sweep({
      store: fakeStore([row('inst_ours'), row('inst_theirs', { nodeId: OTHER_NODE })], recorded),
      scopedToOwnNodeId: true,
    });

    expect(report.reaped).toEqual(['inst_ours']);
    expect(recorded.transitions.map((t) => t.id)).toEqual(['inst_ours']);
  });

  it('reaps regardless of the node id column when the sweep is unscoped', async () => {
    const recorded = blank();
    const report = await sweep({
      store: fakeStore([row('inst_ours'), row('inst_last_boot', { nodeId: OTHER_NODE })], recorded),
      scopedToOwnNodeId: false,
    });

    expect(report.reaped).toEqual(['inst_ours', 'inst_last_boot']);
  });

  it('reports a store failure instead of failing the boot', async () => {
    const broken = {
      listTenants: async () => {
        throw new Error('database is locked');
      },
    } as unknown as Store;

    const report = await sweep({ store: broken });

    expect(report.failure).toBe('database is locked');
    expect(report.reaped).toEqual([]);
  });
});

describe('orphanSweepScope', () => {
  it('scopes to this node own id when peer.nodeId gives the process a durable identity', () => {
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://r.example.com' },
      peer: { nodeId: 'nod_fixed' },
    });
    expect(orphanSweepScope(config)).toEqual({ scopedToOwnNodeId: true, warning: null });
  });

  it('widens past the node id column only when no peer link is configured at all', () => {
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://r.example.com' },
    });
    expect(orphanSweepScope(config).scopedToOwnNodeId).toBe(false);
    expect(orphanSweepScope(config).warning).toBeNull();
  });

  it('stays scoped, and warns, when a peer link exists but peer.nodeId does not', () => {
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://r.example.com' },
      peer: { sharedSecret: 'a'.repeat(32) },
    });
    const scope = orphanSweepScope(config);
    expect(scope.scopedToOwnNodeId).toBe(true);
    expect(scope.warning).toContain('peer.nodeId');
  });
});

/** A `Clock` whose timers fire only when the test says so. */
function manualClock(): Clock & { fire(): Promise<void>; pending(): number } {
  let queue: (() => void)[] = [];
  return {
    now: () => SWEEP_START,
    setTimeout: (fn: () => void) => {
      queue.push(fn);
      return { unref: () => undefined } as ClockTimer;
    },
    setInterval: () => ({ unref: () => undefined }) as ClockTimer,
    clearTimeout: () => {
      queue = [];
    },
    clearInterval: () => undefined,
    async fire() {
      const due = queue;
      queue = [];
      for (const fn of due) fn();
      await new Promise((r) => setImmediate(r));
    },
    pending: () => queue.length,
  };
}

describe('the sweep is armed, not run, during start()', () => {
  it('touches nothing until its timer fires', async () => {
    // The `EADDRINUSE` case, reduced to its essential shape: a process that
    // completes `start()` and then dies never gets here. `Clock.setTimeout`
    // unrefs, so the pending sweep cannot keep such a process alive either.
    const recorded = blank();
    const clock = manualClock();
    const handle = scheduleOrphanSweep({
      store: fakeStore([row('inst_phantom')], recorded),
      runtime: fakeRuntime([]),
      localNode: fakeLocalNode([]).node,
      clock,
      nodeId: OUR_NODE,
      scopedToOwnNodeId: false,
      notBefore: SWEEP_START,
      delayMs: orphanSweepDelayMs(),
      logger: noopLogger,
    });

    expect(recorded.transitions).toEqual([]);
    expect(clock.pending()).toBe(1);

    await clock.fire();
    const report = await handle.done;
    expect(report.reaped).toEqual(['inst_phantom']);
  });

  it('cancel() stops it from ever running, and runStop calls that', async () => {
    const recorded = blank();
    const clock = manualClock();
    const handle = scheduleOrphanSweep({
      store: fakeStore([row('inst_phantom')], recorded),
      runtime: fakeRuntime([]),
      localNode: fakeLocalNode([]).node,
      clock,
      nodeId: OUR_NODE,
      scopedToOwnNodeId: false,
      notBefore: SWEEP_START,
      delayMs: orphanSweepDelayMs(),
      logger: noopLogger,
    });

    handle.cancel();
    handle.cancel(); // idempotent
    await clock.fire();

    const report = await handle.done;
    expect(report.cancelled).toBe(true);
    expect(report.reaped).toEqual([]);
    expect(recorded.transitions).toEqual([]);
  });

  it('waits longer than a profile lease can outlive the process that stopped renewing it', () => {
    // This is the property the whole liveness argument rests on. A lease
    // belonging to an owner that died before this process started expires no
    // later than one TTL after that death, so a wait of at least one TTL
    // makes "still unexpired" mean "still being renewed by something alive".
    expect(orphanSweepDelayMs()).toBeGreaterThan(30_000);
  });
});

// ── the duplicate start, against a real shared database ────────────────

const tempDirs: string[] = [];
const openStores: Store[] = [];

/** Opens a store on `path` and registers it for close in `afterEach`. Windows refuses to unlink a SQLite file whose handle is still open, so every store this suite opens has to be closed before the temp directory goes. */
async function openStore(path: string): Promise<Store> {
  const store = await createSqliteStore(path);
  openStores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Opens a real SQLite store on a fresh temp file and seeds the row graph an instance needs. */
async function realStore() {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-reconcile-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'control.db');
  const store = await openStore(dbPath);
  const tenant = await store.createTenant({ name: 'Acme' });
  const app = await store.createApp({ tenantId: tenant.id, name: 'demo' });
  const node = await store.registerNode({
    name: 'gateway-a',
    runtime: 'host',
    address: 'http://127.0.0.1:0',
    registrationSecretEnc: 'enc',
  });
  const spec = await store.upsertBrowserSpec(tenant.id, {
    engine: 'chromium',
    channel: 'chrome',
    headless: 'new',
    viewportW: 1920,
    viewportH: 1080,
    dpr: 1,
    locale: null,
    timezone: null,
    userAgent: null,
    proxy: null,
    args: [],
    extensions: [],
    stealth: 'off',
    limits: {},
  });
  const pool = await store.createPool({ tenantId: tenant.id, name: 'demo', specId: spec.id });
  const profile = await store.createProfile({
    tenantId: tenant.id,
    appId: app.id,
    key: 'user:1',
    mode: 'persistent',
    storagePath: 'profiles/user-1',
  });
  return { dbPath, store, tenant, app, node, spec, pool, profile };
}

/**
 * The two shapes an `instances` row can have in a real database, both of
 * which the sweep will meet on an upgraded one.
 *
 * `store-sqlite`'s `transitionInstance` used to build its `UPDATE` from
 * four hardcoded patch fields and silently drop the rest, `profileId`
 * among them, so `instances.profile_id` was null on every row ever
 * written. It now applies a total rule table keyed on `keyof Instance`, so
 * the column is populated going forward. Rows written before that fix keep
 * their null forever.
 *
 * `liveOwnerVerdict` must not care either way. It resolves the lease
 * through `profile_leases.instance_id`, never through
 * `instances.profile_id`, and these two shapes are what pins that: the
 * verdict, the reap decision, and the lease release all have to come out
 * identical. This started as a single assertion that the column WAS null,
 * which pinned a store defect as an invariant and broke the moment the
 * defect was fixed. Pinning the independence is the property that was
 * actually wanted.
 */
const ROW_SHAPES = [
  { name: 'profile_id recorded', recordProfileId: true },
  {
    name: 'profile_id null, as every row written before the store fix still is',
    recordProfileId: false,
  },
] as const;

/**
 * Launches an instance the way `BrowserRouter.placeAndLaunch` does:
 * `createInstance` with no `profileId` (the profile is not leased yet at
 * that point), then a transition to `'live'`. Whether that transition
 * carries `profileId` is what produces the two {@link ROW_SHAPES}, and the
 * resulting column is asserted either way so neither shape can silently
 * stop being the shape it claims to be.
 */
async function launchInstance(a: Awaited<ReturnType<typeof realStore>>, recordProfileId: boolean) {
  const instance = await a.store.createInstance({
    tenantId: a.tenant.id,
    appId: a.app.id,
    poolId: a.pool.id,
    specId: a.spec.id,
    nodeId: a.node.id,
    metadata: {},
    lifetime: 'viewer-bound',
  });
  await a.store.transitionInstance(
    a.tenant.id,
    instance.id,
    ['launching'],
    'live',
    recordProfileId ? { profileId: a.profile.id } : {},
  );
  const stored = await a.store.getInstance(a.tenant.id, instance.id);
  expect(stored?.profileId ?? null).toBe(recordProfileId ? a.profile.id : null);
  return instance;
}

/** Takes a profile lease and fails loudly if the store refused it, since `acquireProfileLease` reports a refusal by returning null rather than throwing. */
async function takeLease(
  a: Awaited<ReturnType<typeof realStore>>,
  profileId: string,
  instanceId: string,
  ttlMs: number,
) {
  const lease = await a.store.acquireProfileLease({
    tenantId: a.tenant.id,
    profileId,
    nodeId: a.node.id,
    instanceId,
    ttlMs,
  });
  expect(lease).not.toBeNull();
  return lease as NonNullable<typeof lease>;
}

/** Opens a second `Store` handle onto the same file and registers a fresh node for it, which is what a second gateway process does. */
async function secondProcess(a: Awaited<ReturnType<typeof realStore>>) {
  const b = await openStore(a.dbPath);
  const node = await b.registerNode({
    name: 'gateway-b',
    runtime: 'host',
    address: 'http://127.0.0.1:0',
    registrationSecretEnc: 'enc',
  });
  return { store: b, nodeId: node.id };
}

/** Runs the sweep as a second process would: no handles, empty runtime inventory, widest scope, and nothing it could have created itself. */
async function sweepAsSecondProcess(b: { store: Store; nodeId: NodeId }) {
  return reapOrphanedInstances({
    store: b.store,
    runtime: fakeRuntime([]),
    localNode: fakeLocalNode([]).node,
    clock: systemClock,
    nodeId: b.nodeId,
    // The widest possible scope, which is what the demo's own
    // configuration produces: no `peer.nodeId`, no peer link.
    scopedToOwnNodeId: false,
    notBefore: Date.now() + 60_000,
    logger: noopLogger,
  });
}

describe.each(ROW_SHAPES)(
  'a second gateway process against the same store ($name)',
  ({ recordProfileId }) => {
    it('does not retire the live instances the first process is still holding', async () => {
      // The coordinator's reproduction. One `node server.mjs` is already
      // running and healthy. A second is started by mistake: it runs
      // `runStart` against the SAME store, sees the first process's rows,
      // holds no handle for any of them (correct, it launched none), and its
      // own runtime inventory is empty (also correct, they are not its
      // browsers). Everything up to the liveness gate says "orphan".
      const a = await realStore();
      const instance = await launchInstance(a, recordProfileId);

      // Process A holds the profile lease, which its
      // `ProfileService.startLeaseRenewal` loop keeps refreshing on a third
      // of the TTL. The unexpired lease IS the liveness signal.
      const lease = await a.store.acquireProfileLease({
        tenantId: a.tenant.id,
        profileId: a.profile.id,
        nodeId: a.node.id,
        instanceId: instance.id,
        ttlMs: 30_000,
      });
      expect(lease).not.toBeNull();

      const report = await sweepAsSecondProcess(await secondProcess(a));

      expect(report.reaped).toEqual([]);
      expect(report.skippedLiveOwner).toEqual([instance.id]);
      expect(report.skippedUndecidable).toEqual([]);

      const after = await a.store.getInstance(a.tenant.id, instance.id);
      expect(after?.state).toBe('ready');
      expect(after?.stateReason).not.toBe(ORPHANED_BY_RESTART);

      // And the lease process A depends on is untouched, so A keeps renewing
      // it and its profile never becomes leasable by anyone else.
      const profileAfter = await a.store.getProfile(a.tenant.id, a.profile.id);
      expect(profileAfter?.lease?.releasedAt ?? null).toBeNull();
    });

    it('does retire that same instance once the first process has died and its lease has lapsed', async () => {
      // The other half, and the reason the check is a lease rather than a
      // blanket refusal to touch foreign rows: once the owner stops renewing,
      // the phantom is drainable again, with no hand edited database.
      const a = await realStore();
      const instance = await launchInstance(a, recordProfileId);
      // A TTL of zero is the state a lease reaches one TTL after the process
      // renewing it died, which is exactly what `orphanSweepDelayMs()`'s wait
      // guarantees has happened by the time the sweep runs.
      await a.store.acquireProfileLease({
        tenantId: a.tenant.id,
        profileId: a.profile.id,
        nodeId: a.node.id,
        instanceId: instance.id,
        ttlMs: 0,
      });

      const report = await sweepAsSecondProcess(await secondProcess(a));

      expect(report.reaped).toEqual([instance.id]);
      const after = await a.store.getInstance(a.tenant.id, instance.id);
      expect(after?.state).toBe('failed');
      expect(after?.stateReason).toBe(ORPHANED_BY_RESTART);

      // The lease is released through `profile_leases.instance_id` too, so a
      // row whose `profile_id` is null still gets its profile freed rather
      // than leaking it into a false `E_PROFILE_BUSY` later.
      const profileAfter = await a.store.getProfile(a.tenant.id, a.profile.id);
      expect(profileAfter?.lease).toBeNull();
      expect(profileAfter?.state).toBe('free');
    });
  },
);

describe('liveOwnerVerdict', () => {
  it('gives the same answer whether or not instances.profile_id is populated', async () => {
    // The invariance property, stated directly rather than inferred from
    // the two suites above. Two instances in one database, identical in
    // every respect except that column, must be judged identically at
    // every stage: no lease, live lease, lapsed lease.
    const a = await realStore();
    const recorded = await launchInstance(a, true);
    const other = await a.store.createProfile({
      tenantId: a.tenant.id,
      appId: a.app.id,
      key: 'user:2',
      mode: 'persistent',
      storagePath: 'profiles/user-2',
    });
    const nulled = await a.store.createInstance({
      tenantId: a.tenant.id,
      appId: a.app.id,
      poolId: a.pool.id,
      specId: a.spec.id,
      nodeId: a.node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });
    await a.store.transitionInstance(a.tenant.id, nulled.id, ['launching'], 'live', {});
    expect((await a.store.getInstance(a.tenant.id, recorded.id))?.profileId).toBe(a.profile.id);
    expect((await a.store.getInstance(a.tenant.id, nulled.id))?.profileId ?? null).toBeNull();

    const b = await openStore(a.dbPath);
    const verdicts = async () => {
      const index = await buildProfileLeaseIndex(b, a.tenant.id);
      const rowFor = async (id: string) => (await b.getInstance(a.tenant.id, id)) as Instance;
      return {
        recorded: liveOwnerVerdict(index, await rowFor(recorded.id), Date.now()),
        nulled: liveOwnerVerdict(index, await rowFor(nulled.id), Date.now()),
      };
    };

    // Neither holds a lease yet.
    expect(await verdicts()).toEqual({ recorded: 'no-live-owner', nulled: 'no-live-owner' });

    // Both hold a live one. `ProfileServicePort.releaseLeaseQuietly` and
    // `ProfileService.leaseIdForInstance` resolve leases through a map only
    // the granting process has, so this also pins that the verdict comes
    // from the store rather than from process local state: `b` granted
    // nothing.
    const live = await takeLease(a, a.profile.id, recorded.id, 30_000);
    const liveOther = await takeLease(a, other.id, nulled.id, 30_000);
    expect(await verdicts()).toEqual({ recorded: 'live-owner', nulled: 'live-owner' });

    // Both lapsed. The existing lease has to be released first:
    // `acquireProfileLease` is the one method the whole profile system
    // rests on being atomic, so it returns null rather than replacing a
    // live lease, and a re-acquire on top of one would silently leave the
    // 30 second lease in place and prove nothing. `takeLease` asserts the
    // grant it got back was real.
    await a.store.releaseProfileLease(live.id, 'test');
    await a.store.releaseProfileLease(liveOther.id, 'test');
    await takeLease(a, a.profile.id, recorded.id, 0);
    await takeLease(a, other.id, nulled.id, 0);
    expect(await verdicts()).toEqual({ recorded: 'no-live-owner', nulled: 'no-live-owner' });
  });
});
