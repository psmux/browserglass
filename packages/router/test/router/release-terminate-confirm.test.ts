/**
 * Regression coverage for the browser-process leak reported against the
 * nextjs-demo gateway: releasing an instance under concurrent load
 * reliably returned `{ outcome: 'terminated' }` while the Chrome process
 * it launched kept running forever, because `packages/runtime-host/src/
 * terminate.ts`'s terminate ladder resolved normally (with a `warnings`
 * entry nobody read) even when its own final liveness check found the
 * process still alive.
 *
 * That is now fixed at the source: a terminate call whose process is not
 * confirmed dead REJECTS instead of resolving (see `terminate.ts`'s own
 * regression tests, `packages/runtime-host/test/terminate-confirm.test.ts`).
 * This file proves `BrowserRouter.release()` was already built to handle
 * that correctly and stays that way: a
 * rejected `NodeTransport.terminate()`, whatever the underlying reason,
 * must never be reported as `outcome: 'terminated'`, must revert the
 * instance out of `draining` rather than leaving it `released`, and must
 * surface as a real, retryable failure.
 */

import type { Capability, Principal, TerminateResult } from '@browserglass/protocol';
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

describe('BrowserRouter.release: a terminate that cannot confirm the browser is dead must never report success', () => {
  it('propagates the failure, reverts the instance to a live state, and never returns outcome: terminated', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // Both the graceful call AND its force escalation fail to confirm
    // death, exactly what a taskkill that never got to run under
    // concurrent load produces once `terminate.ts` refuses to lie about
    // it (see this file's own module doc).
    // A third call is the router's recheck before it reports failure
    // (see `terminateGraceThenForce`); a browser that is really still
    // alive fails that one too.
    nodes.failNextTerminates(
      3,
      Object.assign(
        new Error('pid 33464 still reports alive after the terminate ladder completed'),
        { code: 'E_STILL_ALIVE' },
      ),
    );

    await expect(router.release(instanceId, {}, principal)).rejects.toMatchObject({
      code: 'E_TERMINATE_FAILED',
    });

    // The row must not be stranded in `draining` (which would take its
    // quota slot with it forever) and must not read `released`: the
    // browser was never confirmed gone.
    const afterFailedRelease = await store.getInstance(tenantId, instanceId);
    expect(afterFailedRelease?.state).not.toBe('released');
    expect(afterFailedRelease?.state).not.toBe('draining');

    // A later release (the reaper's retry, or the caller trying again)
    // must actually be able to terminate the instance once the underlying
    // problem clears, proving the failed attempt above did not leave
    // anything permanently stuck.
    const result = await router.release(instanceId, {}, principal);
    expect(result.outcome).toBe('terminated');
    const afterRetry = await store.getInstance(tenantId, instanceId);
    expect(afterRetry?.state).toBe('released');
  });

  it('escalates a graceful terminate that fails to confirm death to force, rather than accepting the graceful result as success', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // Only the FIRST terminate call (the graceful one) fails to confirm
    // death; the escalated force call behind it succeeds normally.
    nodes.failNextTerminate = Object.assign(
      new Error('pid 33464 still reports alive after the terminate ladder completed'),
      { code: 'E_STILL_ALIVE' },
    );

    const result = await router.release(instanceId, {}, principal);

    expect(result.outcome).toBe('terminated');
    expect(nodes.terminateCalls.some((c) => c.mode === 'graceful')).toBe(true);
    expect(nodes.terminateCalls.some((c) => c.mode === 'force')).toBe(true);
    const released = await store.getInstance(tenantId, instanceId);
    expect(released?.state).toBe('released');
  });

  it('a force attempt that fails while the graceful one later confirms exit is reported as terminated, not E_TERMINATE_FAILED', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // The load pattern seen live: the graceful ladder is still waiting on
    // a slow process scan when the router's deadline fires, the force
    // ladder started beside it runs out of its own confirm budget and
    // rejects, and then the graceful one sees Chrome gone and resolves.
    let resolveGraceful: ((r: TerminateResult) => void) | null = null;
    nodes.terminateHook = (mode) => {
      if (mode === 'graceful') {
        return new Promise<TerminateResult>((resolve) => {
          resolveGraceful = resolve;
        });
      }
      return Promise.reject(
        new Error('a chrome process still holds profile; confirm budget ran out'),
      );
    };

    const releasePromise = router.release(instanceId, { gracefulMs: 2_000 }, principal);
    await flushMicrotasks();
    clock.advance(2_000);
    await flushMicrotasks();
    expect(nodes.terminateCalls.map((c) => c.mode)).toEqual(['graceful', 'force']);
    resolveGraceful?.(okResult('graceful'));

    const result = await releasePromise;
    expect(result.outcome).toBe('terminated');
    expect((await store.getInstance(tenantId, instanceId))?.state).toBe('released');
    // No recheck was needed: the graceful answer was enough.
    expect(nodes.terminateCalls.map((c) => c.mode)).toEqual(['graceful', 'force']);
  });

  it('when both attempts fail but a recheck finds the browser gone, the release succeeds', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // Chrome exits on its own just after both ladders gave up.
    nodes.failNextTerminates(2, new Error('confirm budget ran out'));

    const result = await router.release(instanceId, {}, principal);
    expect(result.outcome).toBe('terminated');
    expect(nodes.terminateCalls.map((c) => c.mode)).toEqual(['graceful', 'force', 'force']);
    expect((await store.getInstance(tenantId, instanceId))?.state).toBe('released');
  });

  it('a graceful call that never settles does not hang the release once force and the recheck both fail', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    nodes.terminateHook = (mode) =>
      mode === 'graceful'
        ? new Promise<TerminateResult>(() => undefined)
        : Promise.reject(new Error('still holds profile'));

    const releasePromise = router.release(instanceId, { gracefulMs: 1_000 }, principal);
    const assertion = expect(releasePromise).rejects.toMatchObject({ code: 'E_TERMINATE_FAILED' });
    await flushMicrotasks();
    clock.advance(1_000);
    await flushMicrotasks();
    clock.advance(60_000);
    await assertion;
    expect(nodes.terminateCalls.map((c) => c.mode)).toEqual(['graceful', 'force', 'force']);
    const after = await store.getInstance(tenantId, instanceId);
    expect(after?.state).not.toBe('released');
    expect(after?.state).not.toBe('draining');
  });
});

function okResult(mode: TerminateResult['mode']): TerminateResult {
  return {
    mode,
    effective: mode,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    locksCleared: [],
    warnings: [],
  };
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
