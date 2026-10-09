import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserRuntime, ProfileFs, Store } from '@browserglass/protocol';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '../../src/config/logger.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { runStop } from '../../src/lifecycle/stop.js';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';

/**
 * A `ResolvedConfig` in embedded mode with a store whose only real method
 * is the one phase 4 calls. `mode: 'gateway'` would be lighter but forbids
 * a locally owned store, and the whole point of the split below is that
 * phase 4 goes to the store rather than through `ProfileService`.
 */
function embeddedConfig(store: Store) {
  return resolveConfig({
    mode: 'embedded',
    store,
    // `dispose` too: a later backstop phase disposes every configured
    // runtime, and a fake without it would add an unrelated `forced` entry
    // that has nothing to do with the ordering under test.
    runtime: { list: async () => [], dispose: async () => undefined } as unknown as BrowserRuntime,
    profiles: { dir: '/tmp/bgls-stop-test', fs: {} as unknown as ProfileFs },
  });
}

describe('stop(): phase ordering', () => {
  it('releases every lease ROW before any terminate, and reclaims every DIRECTORY after every terminate', async () => {
    // The three way ordering, and the reason it is three rather than two.
    //
    // Shutdown must release the lease row
    // before any browser is killed, so that a process dying mid shutdown
    // does not leave a profile claimed by a holder that no longer exists.
    // That is a statement about the ROW. The DIRECTORY cannot be reclaimed
    // until after the kill, because `ProfileFs.trash()` refuses to reclaim
    // one a live Chrome still holds.
    //
    // These were one call until they could not be. `ProfileService.release()`
    // trashes first and releases the row second, so once `trash()` learned
    // to refuse, phase 4 threw before reaching the row release and the
    // lease stayed claimed: the exact failure C-SRV item 3 exists to
    // prevent, caused by the code meant to satisfy it.
    const events: string[] = [];

    const instances = [
      { instance: { id: 'inst_1', profileId: 'prf_1' } },
      { instance: { id: 'inst_2', profileId: 'prf_2' } },
    ];

    const fakeRouter = {
      list: async () => instances,
      stop: async () => {
        events.push('router.stop');
      },
    };

    const fakeStore = {
      releaseProfileLease: async (leaseId: string) => {
        events.push(`lease_row_release:${leaseId}`);
      },
      // A later phase flushes and closes the store; stubbed so this test
      // exercises the real `runStop` all the way through rather than
      // dying two phases after the one it is about.
      close: async () => undefined,
    } as unknown as Store;

    const fakeProfileService = {
      // `runStop` stands the lease renewal loop down before it releases
      // anything, so a shutdown does not keep renewing leases it is in the
      // middle of giving up. Recorded here so the ordering is asserted
      // below rather than merely tolerated.
      stopLeaseRenewal: () => {
        events.push('lease_renewal_stopped');
      },
      leaseIdForInstance: (instanceId: string) => `lse_${instanceId}`,
      release: async (req: { leaseId: string }) => {
        events.push(`dir_reclaim:${req.leaseId}`);
        return {
          releasedAt: Date.now(),
          snapshotId: null,
          destroyed: true,
          promotedToKey: null,
          finalSizeBytes: 1024,
          warnings: [],
        };
      },
    };

    const fakeNodeTransport = {
      terminate: async (_nodeId: string, instanceId: string) => {
        events.push(`terminate:${instanceId}`);
        return {
          mode: 'graceful',
          effective: 'graceful',
          exitCode: 0,
          signal: null,
          durationMs: 1,
          locksCleared: [],
          warnings: [],
        };
      },
    };

    const wiring = {
      router: fakeRouter,
      profileService: fakeProfileService,
      nodeTransport: fakeNodeTransport,
      nodeRegistry: {},
      nodeId: 'nod_local',
    } as unknown as RouterWiring;

    const report = await runStop(embeddedConfig(fakeStore), noopLogger, wiring, {
      deadlineMs: 5000,
      instances: 'release',
    });

    const rowEvents = events.filter((e) => e.startsWith('lease_row_release'));
    const terminateEvents = events.filter((e) => e.startsWith('terminate'));
    const reclaimEvents = events.filter((e) => e.startsWith('dir_reclaim'));
    expect(rowEvents).toHaveLength(2);
    expect(terminateEvents).toHaveLength(2);
    expect(reclaimEvents).toHaveLength(2);

    const lastRow = Math.max(...rowEvents.map((e) => events.indexOf(e)));
    const firstTerminate = Math.min(...terminateEvents.map((e) => events.indexOf(e)));
    const lastTerminate = Math.max(...terminateEvents.map((e) => events.indexOf(e)));
    const firstReclaim = Math.min(...reclaimEvents.map((e) => events.indexOf(e)));

    // C-SRV item 3: every row is released before anything is killed.
    expect(lastRow).toBeLessThan(firstTerminate);
    // And no directory is reclaimed until every browser is gone, which is
    // the half that could not work before.
    expect(lastTerminate).toBeLessThan(firstReclaim);

    // Renewal stops before the first release, so no tick can re-extend a
    // lease the shutdown has already decided to give up.
    expect(events.indexOf('lease_renewal_stopped')).toBe(0);

    expect(report.instancesReleased).toBe(2);
    expect(report.forced).toHaveLength(0);
  });

  it('still releases the lease row when the directory reclaim fails, and reports the failure per instance', async () => {
    // The regression that motivated the split. A reclaim that cannot
    // succeed must not take the row release down with it, and must be
    // reported rather than swallowed: a directory left behind and named is
    // acceptable, a silent one is not.
    const events: string[] = [];
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const capturing = {
      ...noopLogger,
      warn: (fields: Record<string, unknown>, message: string) => {
        warnings.push({ fields, message });
      },
    };

    const fakeStore = {
      releaseProfileLease: async (leaseId: string) => {
        events.push(`lease_row_release:${leaseId}`);
      },
      // A later phase flushes and closes the store; stubbed so this test
      // exercises the real `runStop` all the way through rather than
      // dying two phases after the one it is about.
      close: async () => undefined,
    } as unknown as Store;

    const wiring = {
      router: {
        list: async () => [{ instance: { id: 'inst_1', profileId: 'prf_1' } }],
        stop: async () => undefined,
      },
      profileService: {
        stopLeaseRenewal: () => undefined,
        leaseIdForInstance: () => 'lse_1',
        release: async () => {
          throw new Error(
            'refusing to reclaim profile directory "/p/tenants/t/profiles/prf_1/udd": Chrome pid 4242 still holds it',
          );
        },
      },
      nodeTransport: {
        terminate: async () => ({
          mode: 'graceful',
          effective: 'graceful',
          exitCode: 0,
          signal: null,
          durationMs: 1,
          locksCleared: [],
          warnings: [],
        }),
      },
      nodeRegistry: {},
      nodeId: 'nod_local',
    } as unknown as RouterWiring;

    const report = await runStop(embeddedConfig(fakeStore), capturing, wiring, {
      deadlineMs: 5000,
      instances: 'release',
    });

    // The row went, which is the property C-SRV item 3 actually cares
    // about, even though the bytes did not.
    expect(events).toEqual(['lease_row_release:lse_1']);
    expect(report.instancesReleased).toBe(1);

    expect(report.forced).toContainEqual({ what: 'profile_dir_reclaim_failed', id: 'inst_1' });
    const reported = warnings.find((w) =>
      w.message.startsWith('stop: profile directory reclaim failed'),
    );
    expect(reported).toBeDefined();
    expect(reported?.fields['instanceId']).toBe('inst_1');
    expect(reported?.fields['profileId']).toBe('prf_1');
    // The path comes through the filesystem error's own message.
    expect(String(reported?.fields['error'])).toContain('/p/tenants/t/profiles/prf_1/udd');
  });

  it('never throws even when a phase fails', async () => {
    const wiring = {
      router: {
        list: async () => {
          throw new Error('boom');
        },
        stop: async () => undefined,
      },
      profileService: { stopLeaseRenewal: () => undefined },
      nodeTransport: {},
      nodeRegistry: {},
      nodeId: 'nod_local',
    } as unknown as RouterWiring;

    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const report = await runStop(config, noopLogger, wiring, {
      deadlineMs: 2000,
      instances: 'release',
    });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/**
 * `runStop`'s phase 6 (this same file, "Phase 6: flush") already calls
 * `config.observability.auditSink.flush()` unconditionally whenever that
 * field is set, with no changes needed here: `config/resolve.ts` now wires
 * a store backed default into exactly that field whenever a `Store` is
 * configured (`observability/store-audit-sink.ts`). This is the "so the
 * last events before exit are not lost" requirement, proven end to end: an
 * event queued but never flushed, then a real `stop()`, then the row is
 * on disk.
 */
describe('stop(): flushes the default store backed audit sink before exit', () => {
  let dbPath: string | undefined;
  afterEach(() => {
    if (dbPath !== undefined) {
      try {
        rmSync(join(dbPath, '..'), { recursive: true, force: true });
      } catch {
        // Best effort; a leftover temp db is untidy, never wrong.
      }
    }
    dbPath = undefined;
  });

  it('a queued-but-unflushed audit event is persisted once runStop() completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-stop-audit-'));
    dbPath = join(dir, 'test.db');
    const store = await createSqliteStore(dbPath);
    await store.createTenant({ id: 'ten_1', name: 'Tenant One' });
    await store.createApp({ id: 'app_1', tenantId: 'ten_1', name: 'App One' });

    const config = resolveConfig({
      mode: 'embedded',
      tenantId: 'ten_1',
      appId: 'app_1',
      store,
      runtime: {
        list: async () => [],
        dispose: async () => undefined,
      } as unknown as BrowserRuntime,
      profiles: { dir: join(dir, 'profiles'), fs: {} as unknown as ProfileFs },
    });

    const sink = config.observability.auditSink;
    expect(sink).toBeDefined();
    // Emitted, never explicitly flushed: standing in for whatever
    // `BrowserRouter.release()`'s own `this.audit.emit(...)` call queued
    // right before a real shutdown began.
    sink?.emit({
      k: 'instance.released',
      iid: 'inst_1',
      reason: 'requested',
      durationMs: 1234,
      at: Date.now(),
    });

    // No `wiring`: this test is only about phase 6 (flush), which runs
    // unconditionally regardless of `wiring`; see `runStop`'s own body.
    const report = await runStop(config, noopLogger, undefined, {
      deadlineMs: 5000,
      instances: 'leave',
    });
    expect(report.auditFlushed).toBe(true);
    expect(report.storeFlushed).toBe(true);

    // `runStop` already closed `store` (phase 6's `config.store.close()`);
    // reopen the same file to prove the row actually reached disk, not
    // merely an in-memory queue that happened not to throw.
    const reopened = await createSqliteStore(dbPath, { migrate: 'off' });
    try {
      const page = await reopened.queryAudit('ten_1', {
        eventType: 'instance.released',
        limit: 10,
      });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]?.instanceId).toBe('inst_1');
    } finally {
      await reopened.close();
    }
  });
});
