import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

/**
 * Regression for the defect fixed by adding `AcquireResult.placementId`:
 * a queued acquire used to return `state: 'queued'` alongside
 * `instanceId: row.id`, a `placement_queue` row id minted by
 * `enqueuePlacement` and cast straight into the same field a real acquire
 * uses for a genuine instance id (`BrowserRouter.ts`'s old `enqueueAcquire`,
 * `instanceId: row.id as InstanceId`). A caller keyed on `instanceId`
 * alone (exactly what a curl against a live gateway sees, and exactly what
 * `examples/nextjs-demo`'s `/api/browser` route used to do) could not tell
 * a queue ticket from a browser: both arrived as an HTTP success with a
 * populated `instanceId`.
 */

function principalFor(tenantId: string, appId: string, sub: string): Principal {
  return {
    tenantId,
    appId,
    sub,
    subKind: 'user',
    caps: ['instance.create', 'view', 'control'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe('BrowserRouter.acquire, over capacity with onFull: "queue"', () => {
  it('never disguises a queued placement as an instance: instanceId and placementId are mutually exclusive, and no queue ticket reaches instanceId', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const poolCapacity = 3;
    const concurrentAcquires = 5; // over capacity, same shape as the reported 14-against-10 case
    const { tenantId, appId } = seedBasics(store, { maxInstances: poolCapacity, onFull: 'queue' });

    const handles = await Promise.all(
      Array.from({ length: concurrentAcquires }, (_, i) =>
        router.acquire({ subject: `user-${i}` }, principalFor(tenantId, appId, `user-${i}`)),
      ),
    );
    const results = handles.map((h) => h.result);

    const ready = results.filter((r) => r.state === 'ready');
    const queued = results.filter((r) => r.state === 'queued');

    // The pool admits exactly its capacity, never more: this is the
    // pre-existing admission guarantee (`acquire.test.ts`'s "admits
    // exactly one" test covers the reject policy version); asserting it
    // here too pins down that switching `onFull` to `'queue'` did not
    // change how many are admitted, only what happens to the overflow.
    expect(ready).toHaveLength(poolCapacity);
    expect(queued).toHaveLength(concurrentAcquires - poolCapacity);

    // The actual invariant this defect is about: for every result,
    // exactly one of `instanceId`/`placementId` is set, and which one
    // agrees with `state`. A queue ticket id must never appear in
    // `instanceId`, under any name.
    for (const r of ready) {
      expect(r.instanceId).not.toBeNull();
      expect(r.placementId).toBeNull();
    }
    for (const r of queued) {
      expect(r.instanceId).toBeNull();
      expect(r.placementId).not.toBeNull();
      // The queue ticket carries real queue metadata a caller can act on
      // (poll later, or name it in a support request), rather than
      // silently losing the request.
      expect(r.queue).toBeDefined();
    }

    // No id was reused across the two groups (the disguise this defect
    // caused would, in the worst case, have a queue ticket's id collide
    // with a real instance's, since both used to be minted into the same
    // field).
    const readyIds = new Set(ready.map((r) => r.instanceId));
    const placementIds = new Set(queued.map((r) => r.placementId));
    expect(readyIds.size).toBe(poolCapacity);
    expect(placementIds.size).toBe(concurrentAcquires - poolCapacity);
    for (const id of placementIds) expect(readyIds.has(id as never)).toBe(false);

    // Only the real instances exist as store rows; a placement ticket
    // never creates an `instances` row of its own.
    const rows = await store.listInstances(tenantId, {});
    expect(rows.filter((r) => r.state !== 'failed' && r.state !== 'released')).toHaveLength(
      poolCapacity,
    );
  });

  it("a queued acquire's handle.ready resolves to a real instance once capacity frees up, correlated by placementId", async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store, { maxInstances: 1, onFull: 'queue' });

    // Concurrent, like the reported defect: the atomic per-request
    // admission reservation (`reserveAdmission`) only ever guards the
    // race window around one `createInstance` call and is released right
    // after (`placeAndLaunch`'s own comment on why: "the row's own
    // existence is what every subsequent admission count sees"), so a
    // *sequential* second call would not exercise the queue path at all
    // here; two callers racing for the same one slot is what actually
    // sends the loser to `enqueueAcquire`.
    const [a, b] = await Promise.all([
      router.acquire({ subject: 'user-a' }, principalFor(tenantId, appId, 'user-a')),
      router.acquire({ subject: 'user-b' }, principalFor(tenantId, appId, 'user-b')),
    ]);
    const [readyHandle, queuedHandle] = a.result.state === 'ready' ? [a, b] : [b, a];
    expect(readyHandle.result.state).toBe('ready');
    expect(queuedHandle.result.state).toBe('queued');
    expect(queuedHandle.result.instanceId).toBeNull();
    expect(queuedHandle.result.placementId).not.toBeNull();

    // Free the one slot, then let the router place the queued request.
    await router.release(
      readyHandle.result.instanceId as never,
      {},
      principalFor(tenantId, appId, 'user-a'),
    );
    await router.processQueue();

    const settled = await queuedHandle.ready;
    expect(settled.state).toBe('ready');
    expect(settled.instanceId).not.toBeNull();
    expect(settled.instanceId).not.toBe(readyHandle.result.instanceId);
    expect(settled.placementId).toBeNull();

    const rows = await store.listInstances(tenantId, {});
    expect(rows.filter((r) => r.state !== 'failed' && r.state !== 'released')).toHaveLength(1);
  });
});
