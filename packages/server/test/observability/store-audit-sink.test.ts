import type { AuditSinkEvent, Store } from '@browserglass/protocol';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStoreAuditSink } from '../../src/observability/store-audit-sink.js';

/**
 * Exercises the exact three `AuditSinkEvent` shapes `BrowserRouter` emits
 * today (`packages/router/src/router/BrowserRouter.ts`): `instance.acquired`
 * (line ~714/~1058), `instance.drive` (line ~1337), `instance.released`
 * (line ~1597). Feeding the sink these shapes directly, against a real
 * `@browserglass/store-sqlite` store, is what actually proves the thing
 * this file exists for: that an acquire-then-release now produces
 * persisted `audit_events` rows, not a mock recording that it would have.
 */
function acquireEvent(
  over?: Partial<Extract<AuditSinkEvent, { k: 'instance.acquired' }>>,
): AuditSinkEvent {
  return {
    k: 'instance.acquired',
    tid: 'ten_1',
    aid: 'app_1',
    iid: 'inst_1',
    nid: 'nod_1',
    profileKey: 'ephemeral:1',
    reused: false,
    at: 1000,
    ...over,
  };
}
function driveEvent(
  over?: Partial<Extract<AuditSinkEvent, { k: 'instance.drive' }>>,
): AuditSinkEvent {
  return {
    k: 'instance.drive',
    tid: 'ten_1',
    aid: 'app_1',
    iid: 'inst_1',
    nid: 'nod_1',
    local: true,
    at: 1500,
    ...over,
  };
}
function releaseEvent(
  over?: Partial<Extract<AuditSinkEvent, { k: 'instance.released' }>>,
): AuditSinkEvent {
  // No `tid`/`aid` on this variant at all: see `mapAuditSinkEvent`'s own
  // comment on `instance.released` in `store-audit-sink.ts`.
  return {
    k: 'instance.released',
    iid: 'inst_1',
    reason: 'requested',
    durationMs: 2000,
    at: 3000,
    ...over,
  };
}

describe('createStoreAuditSink', () => {
  let stores: Store[] = [];
  afterEach(async () => {
    for (const s of stores) await s.close();
    stores = [];
  });

  async function freshStore(): Promise<Store> {
    const store = await createSqliteStore(':memory:', { memory: true });
    stores.push(store);
    await store.createTenant({ id: 'ten_1', name: 'Tenant One' });
    await store.createApp({ id: 'app_1', tenantId: 'ten_1', name: 'App One' });
    return store;
  }

  it('an acquire-then-drive-then-release batch persists three rows with the right event types and an intact hash chain', async () => {
    const store = await freshStore();
    const sink = createStoreAuditSink({ store, tenantId: 'ten_1', appId: 'app_1' });

    sink.emit(acquireEvent());
    sink.emit(driveEvent());
    sink.emit(releaseEvent());
    await sink.flush();

    const page = await store.queryAudit('ten_1', { instanceId: 'inst_1', limit: 10 });
    // `queryAudit` orders `occurred_at DESC`; oldest last.
    const rows = [...page.events].reverse();
    expect(rows.map((r) => r.eventType)).toEqual([
      'instance.acquired',
      'instance.drive',
      'instance.released',
    ]);

    // The fallback tenant applies to `instance.released`, which carries no
    // `tid` of its own.
    for (const row of rows) expect(row.tenantId).toBe('ten_1');

    // The hash chain: first row has no predecessor, every later row's
    // `prevHash` is exactly the previous row's `hash`, and every `hash` is
    // a distinct, non-null string (a constant hash would silently defeat
    // tamper evidence).
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[0]?.hash).toBeTruthy();
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[1]?.hash).toBeTruthy();
    expect(rows[1]?.hash).not.toBe(rows[0]?.hash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
    expect(rows[2]?.hash).toBeTruthy();
    expect(rows[2]?.hash).not.toBe(rows[1]?.hash);
  });

  it('chains correctly across two separate flushes, not just within one batch', async () => {
    const store = await freshStore();
    const sink = createStoreAuditSink({ store, tenantId: 'ten_1', appId: 'app_1' });

    sink.emit(acquireEvent());
    await sink.flush();
    sink.emit(releaseEvent());
    await sink.flush();

    const page = await store.queryAudit('ten_1', { instanceId: 'inst_1', limit: 10 });
    const rows = [...page.events].reverse();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
  });

  it('events sharing the same millisecond still chain correctly (occurred_at is bumped to stay strictly increasing)', async () => {
    const store = await freshStore();
    const sink = createStoreAuditSink({ store, tenantId: 'ten_1', appId: 'app_1' });

    // Same `at`, matching a real `acquire()` call where `instance.acquired`
    // and, moments later, `instance.drive` can share a millisecond.
    sink.emit(acquireEvent({ at: 5000 }));
    sink.emit(driveEvent({ at: 5000 }));
    sink.emit(releaseEvent({ at: 5000 }));
    await sink.flush();

    const page = await store.queryAudit('ten_1', { instanceId: 'inst_1', limit: 10 });
    expect(page.events).toHaveLength(3);
    const rows = [...page.events].reverse();
    const occurredAts = rows.map((r) => r.occurredAt);
    expect(new Set(occurredAts).size).toBe(3); // strictly distinct, so ORDER BY occurred_at is unambiguous
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
  });

  it('flushes automatically once the queue reaches maxBatchSize, without waiting for the timer', async () => {
    const store = await freshStore();
    const sink = createStoreAuditSink({
      store,
      tenantId: 'ten_1',
      appId: 'app_1',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
    });

    sink.emit(acquireEvent({ at: 1 }));
    sink.emit(driveEvent({ at: 2 })); // crosses maxBatchSize: 2, triggers an async flush
    // Give the fire-and-forget flush a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    const page = await store.queryAudit('ten_1', { instanceId: 'inst_1', limit: 10 });
    expect(page.events.length).toBeGreaterThanOrEqual(2);
  });

  it('flush() is a no-op that resolves cleanly when nothing was ever emitted', async () => {
    const store = await freshStore();
    const sink = createStoreAuditSink({ store, tenantId: 'ten_1' });
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('a flush failure is swallowed, logged, and drops the failed batch, matching the AuditSink "must never throw" contract', async () => {
    const store = await freshStore();
    const warn = vi.fn();
    const failingStore: Store = {
      ...store,
      transaction: async () => {
        throw new Error('simulated store outage');
      },
    };
    const sink = createStoreAuditSink({
      store: failingStore,
      tenantId: 'ten_1',
      logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    sink.emit(acquireEvent());
    await expect(sink.flush()).resolves.toBeUndefined(); // never throws, per AuditSink's own doc contract
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/flush failed/i);

    // The failed batch was dropped, not retried forever: a second flush
    // against the (still failing) store sees nothing queued.
    const secondWarnCountBefore = warn.mock.calls.length;
    await sink.flush();
    expect(warn.mock.calls.length).toBe(secondWarnCountBefore);
  });

  it('drops the oldest queued event once maxQueueSize is exceeded, keeping the newest', async () => {
    const store = await freshStore();
    const sink = createStoreAuditSink({
      store,
      tenantId: 'ten_1',
      appId: 'app_1',
      maxQueueSize: 2,
      maxBatchSize: 1000,
      flushIntervalMs: 60_000,
    });

    sink.emit(acquireEvent({ iid: 'inst_a', at: 1 }));
    sink.emit(acquireEvent({ iid: 'inst_b', at: 2 }));
    sink.emit(acquireEvent({ iid: 'inst_c', at: 3 })); // queue is now over capacity; inst_a should be dropped

    await sink.flush();
    const page = await store.queryAudit('ten_1', { limit: 10 });
    const instanceIds = page.events.map((r) => r.instanceId).sort();
    expect(instanceIds).toEqual(['inst_b', 'inst_c']);
  });
});
