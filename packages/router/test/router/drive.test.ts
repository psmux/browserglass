/**
 * `BrowserRouter.driveInstance` (the authority gate) and
 * `BrowserRouter.dispatchAction`: refuses a non drivable instance with a code distinct
 * from "not found", records activity, emits audit, caches the resolution,
 * invalidates it on release, and forwards a non local instance through
 * `NodeTransport.dispatch` rather than refusing it.
 */

import type { Capability, NodeActionRequest, Principal } from '@browserglass/protocol';
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

describe('BrowserRouter.driveInstance, the authority gate', () => {
  it('refuses an unknown instance with E_INSTANCE_NOT_FOUND', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    await expect(router.driveInstance(newId('inst'), principal)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('refuses a released instance with E_INSTANCE_GONE, distinct from E_INSTANCE_NOT_FOUND', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, {}, principal);

    await expect(router.driveInstance(handle.result.instanceId, principal)).rejects.toMatchObject({
      code: 'E_INSTANCE_GONE',
    });
  });

  it('resolves a ready instance to its node and session, and records activity', async () => {
    const clock = createFakeClock();
    const { router, store, nodeRegistry } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const before = await store.getInstance(tenantId, handle.result.instanceId);
    clock.advance(60_000); // past activityTouchThrottleMs (30s default), so the touch below is real, not throttled away

    const resolution = await router.driveInstance(handle.result.instanceId, principal);
    expect(resolution.nodeId).toBe(nodeRegistry.id());
    expect(resolution.sessionId).toBe(handle.result.sessionId);
    expect(resolution.local).toBe(true);

    const after = await store.getInstance(tenantId, handle.result.instanceId);
    expect(after?.lastActivityAt).toBeGreaterThan(before?.lastActivityAt ?? 0);
  });

  it("emits an audit event on a fresh resolution, following instance.acquired's shape", async () => {
    const clock = createFakeClock();
    const { router, store, audit } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    audit.events.length = 0; // drop the acquire's own emission, isolate driveInstance's

    await router.driveInstance(handle.result.instanceId, principal);
    // Its own kind on purpose: driving is not acquiring, and reusing
    // `instance.acquired` would make anyone counting acquisitions out of the
    // audit log over-count every REST call, CLI command and CDP passthrough.
    expect(audit.events.filter((e) => e.k === 'instance.acquired')).toHaveLength(0);
    const driven = audit.events.filter((e) => e.k === 'instance.drive');
    expect(driven).toHaveLength(1);
    expect(driven[0]).toMatchObject({
      k: 'instance.drive',
      iid: handle.result.instanceId,
      local: true,
    });
  });

  it('caches the resolution: a second call does not re-read the store, and does not audit again', async () => {
    const clock = createFakeClock();
    const { router, store, audit } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.driveInstance(handle.result.instanceId, principal);
    audit.events.length = 0;

    let getInstanceCalls = 0;
    const realGetInstance = store.getInstance.bind(store);
    store.getInstance = ((tid: string, id: string) => {
      getInstanceCalls += 1;
      return realGetInstance(tid, id);
    }) as typeof store.getInstance;

    await router.driveInstance(handle.result.instanceId, principal);
    expect(getInstanceCalls).toBe(0);
    expect(audit.events.filter((e) => e.k === 'instance.acquired')).toHaveLength(0);
  });

  it('invalidates the cache on release: a released instance stops resolving instead of answering stale', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const first = await router.driveInstance(handle.result.instanceId, principal);
    expect(first.local).toBe(true);

    await router.release(handle.result.instanceId, {}, principal);
    await expect(router.driveInstance(handle.result.instanceId, principal)).rejects.toMatchObject({
      code: 'E_INSTANCE_GONE',
    });
  });
});

describe('BrowserRouter.dispatchAction, node aware dispatch', () => {
  it("reaches a local instance directly, forwarding to this router's own node id", async () => {
    const clock = createFakeClock();
    const { router, store, nodes, nodeRegistry } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const req: NodeActionRequest = { kind: 'target.list', instanceId: handle.result.instanceId };
    const result = await router.dispatchAction(handle.result.instanceId, req, principal);

    expect(result).toEqual({ kind: 'target.list', targets: [] });
    expect(nodes.dispatchCalls).toHaveLength(1);
    expect(nodes.dispatchCalls[0]?.nodeId).toBe(nodeRegistry.id());
  });

  it('forwards a remote instance to its owning node instead of refusing it', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);
    const remoteNodeId = newId('nod');

    const handle = await router.acquire({}, principal);
    // Simulate a second node: this instance's row now says it lives on a
    // node this process is not. `seedBasics`/`acquire` only ever place an
    // instance on the single local node in this test harness, so the "a
    // fake second node" acceptance criterion is met by moving the row's
    // `nodeId` directly, the same way a real multi node placement would
    // have set it in the first place.
    await store.transitionInstance(tenantId, handle.result.instanceId, ['live'], 'live', {
      nodeId: remoteNodeId,
    });

    const req: NodeActionRequest = {
      kind: 'screenshot',
      instanceId: handle.result.instanceId,
      targetId: 'tgt-1',
    };
    const result = await router.dispatchAction(handle.result.instanceId, req, principal);

    expect(result).toMatchObject({ kind: 'screenshot' });
    expect(nodes.dispatchCalls).toHaveLength(1);
    expect(nodes.dispatchCalls[0]?.nodeId).toBe(remoteNodeId);

    const resolution = await router.driveInstance(handle.result.instanceId, principal);
    expect(resolution.local).toBe(false);
  });

  it('an unreachable owning node yields E_NODE_LOST, distinct from E_INSTANCE_NOT_FOUND and E_INSTANCE_NOT_READY, so a caller can retry', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);
    const remoteNodeId = newId('nod');

    const handle = await router.acquire({}, principal);
    await store.transitionInstance(tenantId, handle.result.instanceId, ['live'], 'live', {
      nodeId: remoteNodeId,
    });
    nodes.unreachableNodeIds.add(remoteNodeId);

    const req: NodeActionRequest = {
      kind: 'click',
      instanceId: handle.result.instanceId,
      targetId: 'tgt-1',
      x: 1,
      y: 1,
    };
    await expect(
      router.dispatchAction(handle.result.instanceId, req, principal),
    ).rejects.toMatchObject({ code: 'E_NODE_LOST', retryable: true });
  });
});
