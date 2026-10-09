/**
 * `sticky` reuse end to end through `BrowserRouter.acquire`, and the
 * viewer aware half of `BrowserRouter.release` that makes sharing one
 * browser between several viewers survivable.
 *
 * The defect these cover: the demo asked for
 * `profile: {mode:'ephemeral'}` and got a brand new Chrome on every visit,
 * because the one selector that would have said "the same browser as last
 * time" (`sticky`) was refused whenever a profile of ANY shape was also
 * named, ephemeral included. `test/router/reuse.test.ts` covers `canShare`
 * as a unit; this file drives the whole acquire path against the fakes, so
 * a regression in the selector rule, the store level subject filter, or
 * the expiry boundary shows up as "a second browser launched" rather than
 * as a changed verdict object.
 */

import type { Capability, InstanceId, Principal } from '@browserglass/protocol';
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

describe('BrowserRouter.acquire, sticky selection', () => {
  it('sticky alongside an ephemeral profile reuses the existing instance for that subject', async () => {
    // The primary defect. `{mode:'ephemeral'}` names no profile and
    // selects nothing, so it never conflicted with `sticky` in the
    // documented contract, only in the code.
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    const first = await router.acquire(
      { profile: { mode: 'ephemeral' }, sticky: { subject: 'user-1' } },
      principal,
    );
    expect(first.result.reused).toBe(false);
    expect(nodes.launchCount).toBe(1);

    const second = await router.acquire(
      { profile: { mode: 'ephemeral' }, sticky: { subject: 'user-1' } },
      principal,
    );
    expect(second.result.instanceId).toBe(first.result.instanceId);
    expect(second.result.reused).toBe(true);
    expect(second.result.reuseReason).toBe('sticky');
    expect(nodes.launchCount).toBe(1); // no second Chrome
  });

  it('sticky with no profile at all reuses too, the pool template being ephemeral', async () => {
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    await router.acquire({ sticky: { subject: 'user-1' } }, principal);
    const second = await router.acquire({ sticky: { subject: 'user-1' } }, principal);
    expect(second.result.reuseReason).toBe('sticky');
    expect(nodes.launchCount).toBe(1);
  });

  it('sticky alongside a keyed persistent profile still throws E_CONFLICTING_SELECTORS', async () => {
    // The half of the old rule that was right: a persistent key already
    // names WHICH browser the caller wants, so a second selector by
    // subject is a genuinely ambiguous request.
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    await expect(
      router.acquire(
        { profile: { mode: 'persistent', key: 'work' }, sticky: { subject: 'user-1' } },
        principal,
      ),
    ).rejects.toMatchObject({
      code: 'E_CONFLICTING_SELECTORS',
    });
  });

  it('sticky follows req.subject rather than the calling principal own sub', async () => {
    // The shape an app that authenticates its own end users actually
    // uses: one service principal, the end user passed through as
    // `req.subject`. The instance row's `created_by_sub` has to record
    // that subject, or every instance is stamped with the one service sub
    // and sticky can never single out a caller's own browser.
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const service = principalFor(tenantId, appId, 'svc-demo-app');

    const alice = await router.acquire(
      { subject: 'u-alice', sticky: { subject: 'u-alice' }, profile: { mode: 'ephemeral' } },
      service,
    );
    const rows = await store.listInstances(tenantId, { createdBySub: 'u-alice' });
    expect(rows.map((r) => r.id)).toEqual([alice.result.instanceId]);

    const aliceAgain = await router.acquire(
      { subject: 'u-alice', sticky: { subject: 'u-alice' }, profile: { mode: 'ephemeral' } },
      service,
    );
    expect(aliceAgain.result.instanceId).toBe(alice.result.instanceId);
    expect(aliceAgain.result.reuseReason).toBe('sticky');
    expect(nodes.launchCount).toBe(1);
  });

  it('sticky never crosses subjects: user B gets a browser of their own', async () => {
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const service = principalFor(tenantId, appId, 'svc-demo-app');

    const alice = await router.acquire(
      { subject: 'u-alice', sticky: { subject: 'u-alice' }, profile: { mode: 'ephemeral' } },
      service,
    );
    const bob = await router.acquire(
      { subject: 'u-bob', sticky: { subject: 'u-bob' }, profile: { mode: 'ephemeral' } },
      service,
    );

    expect(bob.result.instanceId).not.toBe(alice.result.instanceId);
    expect(bob.result.reused).toBe(false);
    expect(nodes.launchCount).toBe(2);
  });

  it('the subject filter reaches the store rather than being applied after the row cap', async () => {
    // `findReusable` used to list the
    // tenant's instances and match subjects in JS, so past
    // `store-sqlite`'s default `LIMIT 200` the caller's own instance fell
    // outside the window and sticky silently stopped working. Asserted
    // here by watching the filter the router hands the store, since the
    // mock has no row cap of its own to trip.
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const service = principalFor(tenantId, appId, 'svc-demo-app');

    const filters: unknown[] = [];
    const listInstances = store.listInstances.bind(store);
    store.listInstances = (tid, filter) => {
      filters.push(filter);
      return listInstances(tid, filter);
    };

    await router.acquire({ subject: 'u-alice', sticky: { subject: 'u-alice' } }, service);
    expect(filters).toContainEqual(expect.objectContaining({ createdBySub: 'u-alice' }));
  });

  it('sticky does not reuse an instance that expires sooner than shareMinRemainingMs', async () => {
    // `canShare`'s `expiring_soon` boundary. This is the difference
    // between "sticky works" and "sticky looks flaky": handing a caller a
    // browser that is about to be reaped is worse than launching a fresh
    // one, and a test that never crosses this boundary would not notice
    // the day it moves.
    const clock = createFakeClock();
    const { router, nodes, store, nodeRegistry } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');
    const shareMinRemainingMs = router.config.shareMinRemainingMs;
    const ttlMs = shareMinRemainingMs + 20_000;

    const first = await router.acquire({ ttlMs, sticky: { subject: 'user-1' } }, principal);
    expect(nodes.launchCount).toBe(1);

    // One second short of the boundary: 61000 left of a 60000 minimum,
    // still comfortably shareable.
    clock.advance(19_000);
    nodeRegistry.heartbeat({});
    const inside = await router.acquire({ ttlMs, sticky: { subject: 'user-1' } }, principal);
    expect(inside.result.instanceId).toBe(first.result.instanceId);
    expect(inside.result.reuseReason).toBe('sticky');
    expect(nodes.launchCount).toBe(1);

    // One second past it: 59000 left, so a fresh browser rather than one
    // about to be reaped out from under the caller.
    clock.advance(2_000);
    // The fake clock does not run the router's own heartbeat timer
    // (`start()` is never called here), and `config.nodeStaleMs` is
    // 12000, so the single test node has to be kept fresh by hand or
    // placement refuses this third acquire for staleness rather than for
    // anything this test is about.
    nodeRegistry.heartbeat({});
    const outside = await router.acquire({ ttlMs, sticky: { subject: 'user-1' } }, principal);
    expect(outside.result.instanceId).not.toBe(first.result.instanceId);
    expect(outside.result.reused).toBe(false);
    expect(nodes.launchCount).toBe(2);
  });
});

describe('BrowserRouter.release, viewer aware', () => {
  /** A `LiveViewerPort` a test drives directly, standing in for the session layer's real viewer set. */
  function viewerPort(counts: Map<string, number>): { countFor: (id: InstanceId) => number } {
    return { countFor: (id: InstanceId) => counts.get(id) ?? 0 };
  }

  it('does not terminate a browser another viewer is still attached to', async () => {
    // The failure sticky reuse creates: two tabs share one instance, the
    // first tab closes, and its `pagehide` release used to take the
    // browser down under the tab still streaming.
    const clock = createFakeClock();
    const counts = new Map<string, number>();
    const { router, nodes, store } = createTestRouter(clock, { viewers: viewerPort(counts) });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    const first = await router.acquire({ sticky: { subject: 'user-1' } }, principal);
    const second = await router.acquire({ sticky: { subject: 'user-1' } }, principal);
    expect(second.result.instanceId).toBe(first.result.instanceId);

    // Tab A has gone away; tab B is still attached.
    counts.set(first.result.instanceId, 1);

    const outcome = await router.release(
      first.result.instanceId,
      { reason: 'user_closed', profile: 'destroy' },
      principal,
    );
    expect(outcome).toEqual({
      instanceId: first.result.instanceId,
      outcome: 'detached',
      remainingViewers: 1,
    });
    expect(nodes.terminateCount).toBe(0);

    // Still live, still drivable, still reusable for the viewer that stayed.
    const view = await router.describe(first.result.instanceId, principal);
    expect(view.instance.state).toBe('ready');
    const third = await router.acquire({ sticky: { subject: 'user-1' } }, principal);
    expect(third.result.instanceId).toBe(first.result.instanceId);
  });

  it('terminates once the last viewer has gone', async () => {
    const clock = createFakeClock();
    const counts = new Map<string, number>();
    const { router, nodes, store } = createTestRouter(clock, { viewers: viewerPort(counts) });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    const handle = await router.acquire({ sticky: { subject: 'user-1' } }, principal);
    counts.set(handle.result.instanceId, 1);
    await router.release(handle.result.instanceId, { reason: 'user_closed' }, principal);
    expect(nodes.terminateCount).toBe(0);

    counts.set(handle.result.instanceId, 0);
    const outcome = await router.release(
      handle.result.instanceId,
      { reason: 'user_closed' },
      principal,
    );
    expect(outcome.outcome).toBe('terminated');
    expect(nodes.terminateCount).toBeGreaterThan(0);
    const view = await router.describe(handle.result.instanceId, principal);
    expect(view.instance.state).toBe('released');
  });

  it('force: true terminates regardless, the path the reaper and drainNode take', async () => {
    const clock = createFakeClock();
    const counts = new Map<string, number>();
    const { router, nodes, store } = createTestRouter(clock, { viewers: viewerPort(counts) });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    const handle = await router.acquire({}, principal);
    counts.set(handle.result.instanceId, 3);

    const outcome = await router.release(
      handle.result.instanceId,
      { reason: 'ttl_expired', force: true },
      principal,
    );
    expect(outcome).toEqual({
      instanceId: handle.result.instanceId,
      outcome: 'terminated',
      remainingViewers: 0,
    });
    expect(nodes.terminateCount).toBeGreaterThan(0);
  });

  it('an uninjected LiveViewerPort leaves release exactly as it was: always terminates', async () => {
    const clock = createFakeClock();
    const { router, nodes, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId, 'user-1');

    const handle = await router.acquire({}, principal);
    const outcome = await router.release(
      handle.result.instanceId,
      { reason: 'user_closed' },
      principal,
    );
    expect(outcome.outcome).toBe('terminated');
    expect(nodes.terminateCount).toBeGreaterThan(0);
  });
});
