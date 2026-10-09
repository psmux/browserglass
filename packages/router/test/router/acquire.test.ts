import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

function principalFor(tenantId: string, appId: string, sub = 'user-1'): Principal {
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

describe('BrowserRouter.acquire, idempotency and join-in-flight', () => {
  it('two concurrent acquire calls with the same requestId produce one instance and two identical results', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);
    const requestId = 'req-123';

    const [a, b] = await Promise.all([
      router.acquire({ requestId }, principal),
      router.acquire({ requestId }, principal),
    ]);

    expect(a.result.instanceId).toBe(b.result.instanceId);
    expect(a.result).toEqual(b.result);

    const rows = await store.listInstances(tenantId, {});
    expect(rows).toHaveLength(1);
  });

  it('a repeat call after the first settles returns the same cached result without launching again', async () => {
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);
    const requestId = 'req-456';

    const first = await router.acquire({ requestId }, principal);
    expect(nodes.launchCount).toBe(1);

    const second = await router.acquire({ requestId }, principal);
    expect(second.result.instanceId).toBe(first.result.instanceId);
    expect(nodes.launchCount).toBe(1); // no second launch
  });

  it('the same requestId reused with a materially different request throws E_IDEMPOTENCY_CONFLICT', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);
    const requestId = 'req-789';

    await router.acquire({ requestId, ttlMs: 60_000 }, principal);
    await expect(router.acquire({ requestId, ttlMs: 120_000 }, principal)).rejects.toMatchObject({
      code: 'E_IDEMPOTENCY_CONFLICT',
    });
  });

  it('a fresh acquire launches through the node transport and returns a ready result', async () => {
    const clock = createFakeClock();
    const { router, nodes, store, audit } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    expect(handle.result.state).toBe('ready');
    expect(handle.result.reused).toBe(false);
    expect(nodes.launchCount).toBe(1);

    const ready = await handle.ready;
    expect(ready.instanceId).toBe(handle.result.instanceId);
    expect(audit.events.some((e) => e.k === 'instance.acquired')).toBe(true);
  });

  it('a pool template with isolation: "window" round trips through acquire onto the stored spec', async () => {
    // Regression for the gap `toStoredSpecInput` (specMapping.ts) left:
    // without `isolation: spec.isolation` in the object literal it builds,
    // every spec created through this real acquire path silently persisted
    // as 'tab' no matter what the pool template asked for, and the demo's
    // window isolation would have kept working only by accident (its
    // server.mjs writes specs through `store.upsertBrowserSpec` directly,
    // bypassing the router).
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store, { isolation: 'window' });
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    expect(handle.result.effectiveSpec.isolation).toBe('window');
  });
});

describe('BrowserRouter.acquire, admission under real concurrency', () => {
  it('a pool limit of one instance admits exactly one of two simultaneous acquires', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store, { maxInstances: 1, onFull: 'reject' });
    const principalA = principalFor(tenantId, appId, 'user-a');
    const principalB = principalFor(tenantId, appId, 'user-b');

    const results = await Promise.allSettled([
      router.acquire({}, principalA),
      router.acquire({}, principalB),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === 'rejected') {
      expect((rejected[0].reason as { code?: string }).code).toBe('E_QUOTA_INSTANCES');
    }

    const rows = await store.listInstances(tenantId, {});
    const live = rows.filter((r) => r.state !== 'failed' && r.state !== 'released');
    expect(live).toHaveLength(1);
  });

  it('releasing the instance frees the slot for a subsequent acquire', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store, { maxInstances: 1, onFull: 'reject' });
    const principal = principalFor(tenantId, appId);

    const first = await router.acquire({}, principal);
    await expect(router.acquire({}, principalFor(tenantId, appId, 'user-2'))).rejects.toMatchObject(
      { code: 'E_QUOTA_INSTANCES' },
    );

    await router.release(first.result.instanceId, {}, principal);

    const second = await router.acquire({}, principalFor(tenantId, appId, 'user-3'));
    expect(second.result.state).toBe('ready');
  });
});

describe('BrowserRouter.release', () => {
  it('is idempotent: releasing an already released instance does not throw', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, {}, principal);
    // Was `resolves.toBeUndefined()`, which only ever mirrored `release()`
    // returning `void`; the contract this test names is "does not throw".
    // Now that the method reports its outcome (`ReleaseResult`, added with
    // the viewer aware release), the same idempotent no-op says so.
    await expect(router.release(handle.result.instanceId, {}, principal)).resolves.toMatchObject({
      outcome: 'already_released',
    });
  });

  it('kills the process (calls terminate on the node transport)', async () => {
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, {}, principal);
    expect(nodes.terminateCount).toBeGreaterThan(0);
  });
});
