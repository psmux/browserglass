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
    nodes.failNextTerminates(
      2,
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
});
