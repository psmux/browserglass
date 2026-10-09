/**
 * `BrowserRouter.release()`'s `gracefulMs` plumbing. Before a fix, `ReleaseOptions.gracefulMs` was accepted and never read
 * anywhere in `release()`'s body, and the fallback to `'force'` only ever
 * happened when the graceful `terminate()` call itself threw, never on a
 * deadline. The router's own eviction call has always passed
 * `gracefulMs: 1000` believing it granted a one second grace; these two
 * tests cover both halves: one proving the value
 * now genuinely reaches `NodeTransport.terminate`, one proving escalation
 * to `'force'` happens on that deadline rather than only on a thrown
 * error.
 */

import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

/**
 * Drains pending microtasks without advancing any clock: `release()` awaits
 * a couple of the mock store's own `async () => value` methods (each a one
 * microtask hop, not a real timer) before it reaches `terminateGraceThenForce`
 * and arms the fake clock's deadline timer. A test that calls `release()`
 * without awaiting it, then immediately calls `clock.advance()`, would
 * advance the clock before that timer is even registered; this lets those
 * store awaits actually resolve first, deterministically, with no real
 * time elapsed.
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

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

describe('BrowserRouter.release: gracefulMs', () => {
  it("reaches NodeTransport.terminate as the graceful call's own gracePeriodMs, not just internal bookkeeping", async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    await router.release(instanceId, { gracefulMs: 4_242 }, principal);

    const gracefulCall = nodes.terminateCalls.find((c) => c.mode === 'graceful');
    expect(gracefulCall).toBeDefined();
    expect(gracefulCall?.gracePeriodMs).toBe(4_242);
    // Terminate succeeded gracefully; no force escalation was needed.
    expect(nodes.terminateCalls.some((c) => c.mode === 'force')).toBe(false);

    const released = await store.getInstance(tenantId, instanceId);
    expect(released?.state).toBe('released');
  });

  it("defaults gracePeriodMs to 3000 when the caller supplies none, per ReleaseOptions' own doc", async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, {}, principal);

    const gracefulCall = nodes.terminateCalls.find((c) => c.mode === 'graceful');
    expect(gracefulCall?.gracePeriodMs).toBe(3_000);
  });

  it('escalates to force on the gracefulMs deadline, not only when the graceful call throws', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // The node accepts the graceful request but never confirms it: this
    // is exactly the case the old code (fallback only on a thrown error)
    // could not handle, since a hung promise never throws.
    nodes.hangGracefulTerminate = true;

    const releasePromise = router.release(instanceId, { gracefulMs: 2_000 }, principal);

    // Let `release()` run up to the point of arming the deadline timer
    // (see `flushMicrotasks`'s own comment), then advance the fake clock
    // past it. The graceful call itself is still pending (it never
    // settles), so only the deadline timer can be what unblocks
    // `release()` here.
    await flushMicrotasks();
    clock.advance(2_000);
    await releasePromise;

    const forceCall = nodes.terminateCalls.find((c) => c.mode === 'force');
    expect(forceCall).toBeDefined();
    expect(forceCall?.instanceId).toBe(instanceId);

    const released = await store.getInstance(tenantId, instanceId);
    expect(released?.state).toBe('released');
  });

  it('does not escalate before the deadline: a graceful call that resolves first is used as is', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, { gracefulMs: 60_000 }, principal);

    // The fake transport's graceful terminate resolves immediately by
    // default (no hang configured), so no amount of the 60s deadline
    // should ever be needed; asserting zero force calls proves the
    // deadline timer, though armed, never fired.
    expect(nodes.terminateCalls.some((c) => c.mode === 'force')).toBe(false);
  });
});
