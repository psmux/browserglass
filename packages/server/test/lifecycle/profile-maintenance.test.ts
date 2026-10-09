/**
 * The profile trash sweep timer in `lifecycle/wiring.ts`.
 *
 * The defect: `ProfileService.sweepFilesystem()` was written and tested and
 * had no production caller anywhere in the monorepo. Neither did
 * `sweepExpiredLeases()`, `reconcileMissingDirs()`, or `gc()`.
 * `BrowserRouter`'s reaper tick does not touch profiles, and
 * `trashRetentionMsByKind` was configured and never read outside a test. So
 * `tenants/<t>/trash/` only ever grew: profile directories arrived and
 * nothing removed them.
 *
 * This is the third defect in this package with the same shape, and the
 * shape is worth naming: a reclaim path that never once ran looks exactly
 * like one that always works. The reaper stall looked healthy, the orphan
 * sweep looked deliberate, and the trash pile looked like retention. None
 * of them were doing anything.
 *
 * The filesystem tests below use the real `ProfileFs` against real
 * directories, because the whole question is whether files actually leave
 * the disk.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserRuntime, ProfileFs, Store } from '@browserglass/protocol';
import type { Clock, ClockTimer } from '@browserglass/router';
import { DEFAULT_PROFILE_SERVICE_CONFIG, ProfileService, systemClock } from '@browserglass/router';
import { createProfileFs } from '@browserglass/runtime-host';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '../../src/config/logger.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { runStop } from '../../src/lifecycle/stop.js';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';
import {
  buildRouterWiring,
  profileMaintenanceIntervalMs,
  runProfileMaintenance,
  scheduleProfileMaintenance,
} from '../../src/lifecycle/wiring.js';

const TENANT = 'ten_1';
const RETENTIONS = DEFAULT_PROFILE_SERVICE_CONFIG.trashRetentionMsByKind;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A profile root with a real `ProfileFs` over it, plus a real `ProfileService` driving that fs. */
function realProfileRoot() {
  const root = mkdtempSync(join(tmpdir(), 'bgls-profiles-'));
  tempDirs.push(root);
  const fs: ProfileFs = createProfileFs({ root });
  // `sweepFilesystem()` only ever reaches `this.fs`, so the store below is
  // never consulted. Using the real `ProfileService` rather than a stub is
  // the point: what is under test includes that it passes the configured
  // retention table through unchanged.
  const service = new ProfileService({ store: {} as unknown as Store, fs, clock: systemClock });
  return { root, service };
}

/**
 * Writes one trash entry the way `ProfileFs.trash()` names them,
 * `<profileId>.<trashedAtMs>.<kind>`, aged `ageMs` into the past.
 */
function trashEntry(root: string, name: string, kind: string, ageMs: number): string {
  const dir = join(root, 'tenants', TENANT, 'trash', `${name}.${Date.now() - ageMs}.${kind}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CURRENT'), 'x'.repeat(1024));
  return dir;
}

/** The trash entry names currently on disk. */
function trashContents(root: string): string[] {
  try {
    return readdirSync(join(root, 'tenants', TENANT, 'trash')).sort();
  } catch {
    return [];
  }
}

describe('the trash sweep actually reclaims disk', () => {
  it('unlinks an entry past its retention and leaves an unexpired one alone', async () => {
    const { root, service } = realProfileRoot();
    trashEntry(root, 'prf_old', 'ephemeral', RETENTIONS.ephemeral + 60_000);
    trashEntry(root, 'prf_young', 'ephemeral', Math.floor(RETENTIONS.ephemeral / 2));
    expect(trashContents(root)).toHaveLength(2);

    const report = await runProfileMaintenance(service, noopLogger);

    expect(report.failure).toBeNull();
    expect(report.unlinked).toBe(1);
    expect(report.bytes).toBeGreaterThan(0);
    const left = trashContents(root);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^prf_young\./);
  });

  it('holds quarantine trash for its own retention while ephemeral trash of the same age goes', async () => {
    // Quarantine is not garbage: a quarantined profile is kept so a human
    // can inspect what corrupted it. The two entries here are the SAME age,
    // an hour old, which is well past the 15 minute ephemeral retention and
    // nowhere near the 30 day quarantine one. A sweep that applied one
    // blanket retention would eat both.
    const { root, service } = realProfileRoot();
    const anHour = 3_600_000;
    expect(anHour).toBeGreaterThan(RETENTIONS.ephemeral);
    expect(anHour).toBeLessThan(RETENTIONS.quarantine);
    trashEntry(root, 'prf_eph', 'ephemeral', anHour);
    trashEntry(root, 'prf_quar', 'quarantine', anHour);

    const report = await runProfileMaintenance(service, noopLogger);

    expect(report.unlinked).toBe(1);
    const left = trashContents(root);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^prf_quar\./);
  });

  it('drains a backlog larger than one batch limit in a single tick', async () => {
    // `sweeperBatchLimit` bounds one `sweepFilesystem()` call, not how much
    // a deployment may reclaim per interval. Treating it as a per tick
    // budget caps throughput below the rate a busy gateway produces
    // ephemeral trash, so a tick keeps calling until a pass comes back
    // under the limit.
    const { root, service } = realProfileRoot();
    const backlog = DEFAULT_PROFILE_SERVICE_CONFIG.sweeperBatchLimit * 3;
    for (let i = 0; i < backlog; i += 1) {
      trashEntry(root, `prf_${i}`, 'ephemeral', RETENTIONS.ephemeral + 60_000);
    }

    const report = await runProfileMaintenance(service, noopLogger);

    expect(report.unlinked).toBe(backlog);
    expect(report.passes).toBeGreaterThan(1);
    expect(trashContents(root)).toEqual([]);
  });

  it('is safe to run twice over the same root, which is what two gateways sharing a profile root do', async () => {
    // Checked rather than assumed, because assuming a single process is
    // what broke the orphan sweep. `ProfileFs.sweep` unlinks with
    // `rmSync(..., { force: true })`, so an already removed path is a
    // success rather than an ENOENT, and `treeSize` skips what vanishes
    // mid walk.
    const { root, service } = realProfileRoot();
    trashEntry(root, 'prf_old', 'ephemeral', RETENTIONS.ephemeral + 60_000);

    const first = await runProfileMaintenance(service, noopLogger);
    const second = await runProfileMaintenance(service, noopLogger);

    expect(first.unlinked).toBe(1);
    expect(second.unlinked).toBe(0);
    expect(second.failure).toBeNull();
    expect(trashContents(root)).toEqual([]);
  });

  it('reports a sweep failure instead of throwing, and says what went wrong', async () => {
    // The rule this whole defect class comes from: a reclaim that cannot
    // work must not be indistinguishable from one that always works. A
    // `.catch(() => undefined)` here would recreate exactly the silence
    // that hid the reaper stall.
    const logged: { fields: Record<string, unknown>; message: string }[] = [];
    const capturing = {
      ...noopLogger,
      error: (fields: Record<string, unknown>, message: string) => {
        logged.push({ fields, message });
      },
    };
    const broken = {
      sweepFilesystem: async () => {
        throw new Error(
          "EACCES: permission denied, rmdir '/profiles/tenants/ten_1/trash/prf_x.1.ephemeral'",
        );
      },
    };

    const report = await runProfileMaintenance(broken, capturing);

    expect(report.failure).toContain('EACCES');
    expect(report.unlinked).toBe(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields['failure']).toContain('prf_x.1.ephemeral');
  });
});

/** A `Clock` whose intervals fire only when the test says so. */
function manualClock(): Clock & { fire(): Promise<void>; intervals(): number } {
  let scheduled: (() => void)[] = [];
  return {
    now: () => 0,
    setTimeout: () => ({ unref: () => undefined }) as ClockTimer,
    setInterval: (fn: () => void) => {
      scheduled.push(fn);
      return { unref: () => undefined, fn } as unknown as ClockTimer;
    },
    clearTimeout: () => undefined,
    clearInterval: (timer: ClockTimer) => {
      const fn = (timer as unknown as { fn: () => void }).fn;
      scheduled = scheduled.filter((s) => s !== fn);
    },
    async fire() {
      for (const fn of [...scheduled]) fn();
      await new Promise((r) => setImmediate(r));
    },
    intervals: () => scheduled.length,
  };
}

describe('the sweep is scheduled, and cancelled on stop', () => {
  it('runs on the interval once scheduled', async () => {
    const { root, service } = realProfileRoot();
    trashEntry(root, 'prf_old', 'ephemeral', RETENTIONS.ephemeral + 60_000);
    const clock = manualClock();

    scheduleProfileMaintenance({
      profileService: service,
      clock,
      intervalMs: 1000,
      logger: noopLogger,
    });

    // Nothing runs at schedule time; the first pass is one interval away.
    expect(trashContents(root)).toHaveLength(1);
    expect(clock.intervals()).toBe(1);

    await clock.fire();
    expect(trashContents(root)).toEqual([]);
  });

  it('cancel() stops it firing again, and is idempotent', async () => {
    const { root, service } = realProfileRoot();
    const clock = manualClock();
    const handle = scheduleProfileMaintenance({
      profileService: service,
      clock,
      intervalMs: 1000,
      logger: noopLogger,
    });

    handle.cancel();
    handle.cancel();
    expect(clock.intervals()).toBe(0);

    trashEntry(root, 'prf_old', 'ephemeral', RETENTIONS.ephemeral + 60_000);
    await clock.fire();

    // Still there: a cancelled timer does not fire, so a gateway that has
    // stopped is not still sweeping a directory it no longer owns.
    expect(trashContents(root)).toHaveLength(1);
  });

  it('buildRouterWiring actually starts it, which is the link the unit tests above cannot reach', async () => {
    // The tests above prove `scheduleProfileMaintenance` works. This proves
    // it is wired, which is the half that was missing for
    // `sweepFilesystem()` all along: the function was correct and tested
    // and simply never called. A test of the scheduler alone would have
    // passed just as happily against a gateway that never started it.
    const { root } = realProfileRoot();
    const config = resolveConfig({
      mode: 'embedded',
      store: {
        registerNode: async (n: { id?: string }) => ({ id: n.id ?? 'nod_fake' }),
      } as unknown as Store,
      runtime: { list: async () => [] } as unknown as BrowserRuntime,
      profiles: { dir: root, fs: createProfileFs({ root }) },
    });

    const wiring = await buildRouterWiring(config);
    try {
      expect(wiring.profileMaintenance).toBeDefined();
      // The orphan sweep is armed by the same function; asserted together
      // so a refactor cannot quietly drop one of the two.
      expect(wiring.orphanSweep).toBeDefined();
    } finally {
      wiring.profileMaintenance?.cancel();
      wiring.orphanSweep?.cancel();
      wiring.profileService.stopLeaseRenewal();
    }
  });

  it('runStop cancels it, so a stopped gateway is not still sweeping', async () => {
    // Against the real `runStop`, not a reimplementation of it. An interval
    // that outlives the gateway would keep deleting under a profile root
    // this process no longer owns, and would race `stop()`'s own profile
    // lease releases.
    const cancelled: string[] = [];
    const wiring = {
      router: { list: async () => [], stop: async () => undefined },
      profileService: { stopLeaseRenewal: () => undefined, leaseIdForInstance: () => null },
      nodeTransport: { terminate: async () => undefined },
      nodeRegistry: {},
      nodeId: 'nod_local',
      profileMaintenance: { cancel: () => cancelled.push('profileMaintenance') },
      orphanSweep: { cancel: () => cancelled.push('orphanSweep'), done: Promise.resolve(null) },
    } as unknown as RouterWiring;

    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://r.example.com' },
    });
    await runStop(config, noopLogger, wiring, { deadlineMs: 5000, instances: 'leave' });

    expect(cancelled).toContain('profileMaintenance');
    expect(cancelled).toContain('orphanSweep');
  });

  it('derives its interval from the shortest retention rather than a round number', () => {
    const shortest = Math.min(...Object.values(RETENTIONS));
    expect(shortest).toBe(RETENTIONS.ephemeral);
    // Half the shortest retention, so an eligible entry waits at most one
    // interval past becoming eligible and never lives longer than one and a
    // half times its own retention.
    expect(profileMaintenanceIntervalMs()).toBe(Math.floor(shortest / 2));
    expect(profileMaintenanceIntervalMs()).toBeGreaterThanOrEqual(60_000);
  });
});
