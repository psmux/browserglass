import type { Capability, Node, Principal, Store } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
/**
 * Cross node placement: `BrowserRouter.doAcquire`'s step 7 used to feed
 * `placementCandidates` exactly one snapshot, `this.nodeRegistry.snapshot()`,
 * this process's own. `docs/scaling.md` names that as the actual ceiling on
 * "massive concurrent users": `placementCandidates`/`ScoredPlacementPolicy`
 * were already written to score MANY candidates and were being fed one.
 *
 * These tests exercise the three pieces that had to move together for a
 * REMOTE node to become a real placement candidate without ever risking a
 * stranded browser (this file's own top-of-task brief: "a placement bug
 * does not throw, it strands a Chrome nobody will ever reap"):
 *
 *   1. `BrowserRouter.tickHeartbeat`/`persistNodeState` durably writing
 *      this node's live status and load into the shared store
 *      (`store.setNodeStatus`/`store.heartbeatNode`), the write side.
 *   2. `BrowserRouter.remoteNodeSnapshots` reading every OTHER live node
 *      back out and merging it with this process's own in-memory
 *      snapshot, the read side `doAcquire`'s placement step now consumes.
 *   3. The winning candidate's `nodeId` actually reaching
 *      `this.nodes.launch(...)` and `Instance.nodeId` being corrected to
 *      it, rather than staying stamped with this process's own id from
 *      before placement ran (step 6 of the nine step flow, "the instance
 *      row is inserted before placement").
 *
 * `MockStore`'s own `registerNode` marks a freshly registered node `'ready'`
 * with `lastHeartbeatAt` at registration time (`mockStore.ts`'s own
 * comment), unlike real `store-sqlite` (which starts every node at
 * `'joining'`/`'registering'` until a real `setNodeStatus('ready')` call).
 * That is deliberate fixture convenience, not a claim about production
 * behaviour: every test below that needs a node EXCLUDED drives it there
 * explicitly (`setNodeStatus('draining')`, or advancing the fake clock past
 * `nodeStaleMs` with no further heartbeat), rather than relying on a fresh
 * registration already being excluded the way a real deployment's would be.
 */
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

/**
 * `createTestRouter` builds a `NodeRegistry` (this process's own IN MEMORY
 * node identity) but, unlike real production wiring
 * (`@browserglass/server`'s `buildRouterWiring`, `lifecycle/wiring.ts`:
 * "Mints and persists this process's own router-scope `nodeId` BEFORE
 * building anything that references it"), never registers a matching row
 * in the store for it. That ordering is load bearing in production
 * (`node_heartbeats.node_id` and `instances.node_id` are both `REFERENCES
 * nodes(id)` in the DDL: a heartbeat for an unregistered id is a
 * foreign key violation, not a silent no-op), so any test that exercises
 * `persistNodeState`/`tickHeartbeat`/`drainNode`'s durable write has to
 * reproduce that same ordering explicitly, exactly as a real gateway
 * process's own startup does.
 */
async function registerSelf(store: Store, nodeId: string): Promise<Node> {
  return store.registerNode({
    id: nodeId as never,
    name: 'self',
    runtime: 'host',
    address: 'http://127.0.0.1:0',
    registrationSecretEnc: 'unused-in-this-test',
  });
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

describe('BrowserRouter.acquire, cross node placement', () => {
  it('places a fresh instance on a registered, ready, freshly heartbeated remote node once the local node has no capacity left', async () => {
    const clock = createFakeClock();
    const { router, store, nodes, nodeRegistry } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    // Local node is full: `placementCandidates`'s own headroom check
    // (`n.load.liveInstances + n.load.launchingInstances >= n.capacity.maxInstances`)
    // must now exclude it, the same check that already ran when this node
    // was the only candidate; nothing about that check changes here.
    nodeRegistry.heartbeat({ liveInstances: 100 });

    const remote = await store.registerNode({
      name: 'gateway-b',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      dataAddress: 'ws://gateway-b.internal:5001/browserglass/node',
      registrationSecretEnc: 'unused-in-this-test',
    });
    await store.heartbeatNode({
      nodeId: remote.id,
      beatAt: new Date(clock.now()).toISOString(),
      seq: 1,
      liveInstances: 0,
      memFreeMib: 32_000,
      diskFreeMib: 500_000,
      cpuLoadPct: 5,
    });

    const handle = await router.acquire({}, principal);
    expect(handle.result.state).toBe('ready');

    // Reached the winning candidate, not silently launched locally
    // (`LocalNodeTransport.launch`'s own foreign nodeId guard is what
    // makes a wrong answer here throw instead of stranding a browser on
    // the wrong node; this fake transport instead just records it).
    expect(nodes.launchCalls).toHaveLength(1);
    expect(nodes.launchCalls[0]?.nodeId).toBe(remote.id);

    // `Instance.nodeId` corrected to the ACTUAL launching node, not left
    // at `this.nodeRegistry.id()` from step 6's pre-placement row insert.
    const instance = await store.getInstance(tenantId, handle.result.instanceId);
    expect(instance?.nodeId).toBe(remote.id);
  });

  it('a registered remote node whose heartbeat has gone stale is not a placement candidate: acquire fails with E_NO_CAPACITY, not a launch on the wrong node', async () => {
    const clock = createFakeClock();
    const { router, store, nodes, nodeRegistry } = createTestRouter(clock, {
      config: { nodeStaleMs: 12_000 },
    });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    nodeRegistry.heartbeat({ liveInstances: 100 }); // local full, same as above

    const remote = await store.registerNode({
      name: 'gateway-c',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'unused-in-this-test',
    });
    await store.heartbeatNode({
      nodeId: remote.id,
      beatAt: new Date(clock.now()).toISOString(),
      seq: 1,
      liveInstances: 0,
    });

    // Past nodeStaleMs with no further heartbeat: `placementCandidates`'s
    // `req.now - n.lastHeartbeatAt >= req.nodeStaleMs` now excludes it,
    // the same fate a genuinely dead node gets.
    clock.advance(12_001);

    await expect(router.acquire({}, principal)).rejects.toMatchObject({ code: 'E_NO_CAPACITY' });
    expect(nodes.launchCalls).toHaveLength(0);
  });

  it('a registered remote node marked draining is not a placement candidate', async () => {
    const clock = createFakeClock();
    const { router, store, nodes, nodeRegistry } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    nodeRegistry.heartbeat({ liveInstances: 100 }); // local full, same as above

    const remote = await store.registerNode({
      name: 'gateway-d',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'unused-in-this-test',
    });
    await store.heartbeatNode({
      nodeId: remote.id,
      beatAt: new Date(clock.now()).toISOString(),
      seq: 1,
      liveInstances: 0,
    });
    await store.setNodeStatus(remote.id, 'draining');

    await expect(router.acquire({}, principal)).rejects.toMatchObject({ code: 'E_NO_CAPACITY' });
    expect(nodes.launchCalls).toHaveLength(0);
  });

  it('a single node deployment (no other node ever registered) behaves exactly as before: candidates is just this node', async () => {
    // Regression guard for the "every increment must leave the system
    // correct" requirement: with nothing else registered in the shared
    // store, `remoteNodeSnapshots()` must contribute nothing, and this is
    // exactly the pre-existing behaviour every other test in this
    // package's own suite already exercises without knowing it.
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    expect(handle.result.state).toBe('ready');
    expect(nodes.launchCalls).toHaveLength(1);
    const instance = await store.getInstance(tenantId, handle.result.instanceId);
    expect(instance?.nodeId).toBeTruthy();
  });
});

describe('BrowserRouter.tickHeartbeat, the durable half', () => {
  it('persists this node as ready, with fresh load, into the shared store on every tick', async () => {
    const clock = createFakeClock();
    const { router, store, nodeRegistry } = createTestRouter(clock);
    await registerSelf(store, nodeRegistry.id());
    await router.start();

    nodeRegistry.heartbeat({ liveInstances: 3, cpuPercent: 40 });
    await router.tickHeartbeat();

    const node = await store.getNode(nodeRegistry.id());
    expect(node?.state).toBe('ready');
    expect(node?.load.liveInstances).toBe(3);
    expect(node?.lastHeartbeatAt).toBe(clock.now());

    await router.stop({ drainMs: 0 });
  });

  it('a store failure on one tick does not throw, and heals on the next successful tick', async () => {
    const clock = createFakeClock();
    const { router, store, nodeRegistry } = createTestRouter(clock);
    await registerSelf(store, nodeRegistry.id());
    await router.start();

    const realHeartbeatNode = store.heartbeatNode.bind(store);
    let failNext = true;
    store.heartbeatNode = (h) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('simulated store outage'));
      }
      return realHeartbeatNode(h);
    };

    await expect(router.tickHeartbeat()).resolves.toBeUndefined(); // does not throw
    await router.tickHeartbeat(); // heals
    const node = await store.getNode(nodeRegistry.id());
    expect(node?.state).toBe('ready');

    await router.stop({ drainMs: 0 });
  });
});

describe('BrowserRouter.drainNode, durable status', () => {
  it('marks this node draining in the shared store immediately, not only on the next heartbeat tick', async () => {
    const clock = createFakeClock();
    const { router, store, nodeRegistry } = createTestRouter(clock);
    await registerSelf(store, nodeRegistry.id());
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    await router.drainNode(nodeRegistry.id(), { mode: 'graceful' }, principal);

    const node = await store.getNode(nodeRegistry.id());
    expect(node?.state).toBe('draining');
  });
});
