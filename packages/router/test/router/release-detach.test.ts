/**
 * `BrowserRouter.release()`'s detach path: the caller-side half of
 * `TerminateMode`'s `'detach'`, which `runtime-remote` has implemented
 * since it was written and which, until this file existed, no caller in
 * this repository could ever select. `grep -rn "'detach'"` across
 * `packages/router/src` and `packages/server/src` returned nothing, so
 * every release of a `runtime-remote` instance sent `Browser.close`,
 * including releases of a browser BrowserGlass merely attached to.
 *
 * The rule these tests pin down is the one thing that makes a mode that
 * deliberately leaves a browser running safe to have at all: it is opt in,
 * it is never the default, and every existing caller keeps killing.
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

describe('BrowserRouter.release: leaveBrowserRunning', () => {
  it('asks the node for a detach terminate, and never for graceful or force', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    const result = await router.release(instanceId, { leaveBrowserRunning: true }, principal);

    const modes = nodes.terminateCalls.map((c) => c.mode);
    expect(modes).toEqual(['detach']);
    expect(result.outcome).toBe('browser_detached');

    // The instance row is still finished: BrowserGlass is done with it,
    // it is just not the thing that ended the browser.
    const released = await store.getInstance(tenantId, instanceId);
    expect(released?.state).toBe('released');
  });

  it('is off by default: a plain release still runs the graceful-then-force ladder', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, {}, principal);

    expect(nodes.terminateCalls.map((c) => c.mode)).toContain('graceful');
    expect(nodes.terminateCalls.some((c) => c.mode === 'detach')).toBe(false);
  });

  it('reports terminated, not browser_detached, when the node refused the detach and killed the browser anyway', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);

    // A node whose runtime creates its own browsers refuses to leave one
    // running: it downgrades to a real teardown and says so in
    // `effective`. `release()` must report what actually happened rather
    // than what it asked for.
    nodes.refuseDetach = true;

    const result = await router.release(
      handle.result.instanceId,
      { leaveBrowserRunning: true },
      principal,
    );
    expect(result.outcome).toBe('terminated');
  });
});
