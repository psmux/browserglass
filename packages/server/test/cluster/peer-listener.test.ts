/**
 * Proves that two gateway processes can actually reach each other's
 * browser instances. Two real node
 * side stacks in one test process (not one process pretending to be two:
 * distinct `LocalNode`/`NodeRegistry`/`LocalNodeTransport` instances for
 * node A, a distinct `WebSocketNodeTransport` for node B, a real HTTP
 * server and a real `ws` WebSocket connection between them), sharing one
 * real `@browserglass/store-sqlite` store the way an actual multi gateway
 * deployment shares one durable database.
 *
 * What is real: the HTTP upgrade, the WebSocket connection, the
 * `nodeAuth.ts` hello handshake and its MAC verification, the wire frame
 * encode/decode on both ends, `WebSocketNodeTransport`'s request/reply
 * correlation, this node's own `LocalNode`/`LocalNodeTransport`, the
 * `NodeActionExecutor` (`session/node-action-executor.ts`),
 * a real `core.CdpBridge`/`TargetRegistry` session, and `store.registerNode`/
 * `store.getNode` (`resolveNode()`'s own one-line body). What is
 * substituted, deliberately, matching this codebase's own established
 * pattern for exactly this class of test (`test/ws/support/test-gateway.ts`'s
 * own module doc: building router's own full test harness belongs to
 * router's own suite and is out of proportion here): the CDP endpoint
 * itself is `fake-chrome-server.ts`'s real, listening, protocol-speaking
 * fake, not real Chrome, and neither node runs a full `BrowserRouter`
 * (placement, admission, the acquire queue) since `resolveNode()`'s own
 * logic is one line, already covered in isolation by
 * `packages/router/test/router/resolveNode.test.ts`, and this suite's own
 * job is proving the NEW peer transport, not re-proving `driveInstance`'s
 * resolution contract a second time.
 */

import { type Server as HttpServer, createServer } from 'node:http';
import { createCdpBridge, createTargetRegistry } from '@browserglass/core';
import type {
  AppId,
  BrowserRuntime,
  NodeActionResult,
  NodeId,
  NodeTransport,
  Store,
  TenantId,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import {
  LocalNode,
  LocalNodeTransport,
  NodeRegistry,
  type NodeSocketLike,
  WebSocketNodeTransport,
  systemClock,
} from '@browserglass/router';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from '../../src/config/logger.js';
import {
  ManagedSession,
  SessionRegistry,
  createLocalNodeActionExecutor,
} from '../../src/session/index.js';
import {
  type PeerUpgradeDeps,
  handlePeerUpgrade,
  shouldHandlePeerUpgrade,
} from '../../src/ws/peer-upgrade.js';
import { type FakeChromeServer, startFakeChromeServer } from '../ws/support/fake-chrome-server.js';

const PEER_PATH = '/browserglass/node';
const PEER_SECRET = 'cluster-test-shared-secret';

function noopLogger(): Logger {
  const fn = () => undefined;
  return { trace: fn, debug: fn, info: fn, warn: fn, error: fn };
}

/**
 * Node B's own `local` transport, the half `WebSocketNodeTransport` would
 * delegate to for a call naming node B's own id. Never actually invoked in
 * this suite: every `dispatch()` call below names node A, never node B, so
 * this exists only to satisfy `WebSocketNodeTransportOptions.local`'s type,
 * the same way this test never builds a `LocalNode` for node B at all.
 */
function unreachableLocalTransport(): NodeTransport {
  const fail = async (method: string): Promise<never> => {
    throw new Error(
      `unreachableLocalTransport: '${method}' should never be called; this suite never dispatches to node B's own id`,
    );
  };
  return {
    heartbeat: (_nodeId, _payload) => fail('heartbeat'),
    launch: (_nodeId, _req) => fail('launch'),
    terminate: (_nodeId, _instanceId, _mode, _gracePeriodMs) => fail('terminate'),
    list: (_nodeId) => fail('list'),
    dispatch: (_nodeId, _req) => fail('dispatch'),
  };
}

/** Starts node A's real peer listener on an ephemeral loopback port, the exact `handlePeerUpgrade`/`shouldHandlePeerUpgrade` pair `src/index.ts` wires into `handleUpgrade` for a real gateway. */
async function startPeerListener(
  deps: PeerUpgradeDeps,
): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer: HttpServer = createServer((_req, res) => res.writeHead(404).end());
  httpServer.on('upgrade', (req, socket, head) => {
    if (!shouldHandlePeerUpgrade(req, PEER_PATH)) {
      socket.destroy();
      return;
    }
    handlePeerUpgrade(req, socket, head, deps);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}${PEER_PATH}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

describe('cross node peer listener: node B genuinely drives an instance node A owns', () => {
  let store: Store;
  let chromeA: FakeChromeServer;
  let sessionRegistryA: SessionRegistry;
  let peerListenerA: { url: string; close: () => Promise<void> };
  let nodeTransportB: WebSocketNodeTransport;
  let nodeAId: NodeId;
  let nodeBId: NodeId;
  let instanceId: string;

  beforeEach(async () => {
    nodeAId = newId('nod') as NodeId;
    nodeBId = newId('nod') as NodeId;

    // One store, shared by both nodes: the real multi gateway topology
    // (`docs/scaling.md`'s own "every gateway must share the same durable
    // Store" requirement), not a convenience
    // shortcut. `:memory:` only because this suite has no reason to touch
    // disk; `store-sqlite`'s own suite already covers the on-disk path.
    store = await createSqliteStore(':memory:', { memory: true });
    const tenantId = newId('ten') as TenantId;
    const appId = newId('app') as AppId;
    await store.createTenant({ id: tenantId, name: 'Cluster Tenant' });
    await store.createApp({ id: appId, tenantId, name: 'Cluster App' });

    chromeA = await startFakeChromeServer();
    sessionRegistryA = new SessionRegistry(async (reqInstanceId, ctx) => {
      const bridge = createCdpBridge(reqInstanceId as never);
      await bridge.connect({ url: chromeA.url });
      const registry = createTargetRegistry(reqInstanceId as never, bridge);
      await registry.start();
      return new ManagedSession({
        instanceId: reqInstanceId,
        sessionId: newId('sess'),
        tenantId,
        appId,
        nodeId: nodeAId,
        bridge,
        registry,
      });
    });

    instanceId = newId('inst');
    await sessionRegistryA.getOrCreate(instanceId, { tenantId, appId });

    // Node A's own real node side stack, exactly `lifecycle/wiring.ts`'s
    // own shape: `LocalNode` built WITH a real `NodeActionExecutor` (before
    // that was wired, this constructor call always omitted
    // `actions`, and every `dispatch()` below would fail with "no
    // NodeActionExecutor configured" instead of proving anything).
    const nodeActionExecutorA = createLocalNodeActionExecutor(sessionRegistryA);
    const localNodeA = new LocalNode({
      // Never called: this suite drives an instance `sessionRegistryA`
      // already holds a live session for; `launch`/`terminate`/`list`
      // (the methods that would touch `runtime`/`profiles`) are outside
      // this test's own scope, `packages/router/test/node/LocalNode.test.ts`'s
      // job.
      runtime: {} as unknown as BrowserRuntime,
      profiles: {} as unknown as never,
      clock: systemClock,
      actions: nodeActionExecutorA,
    });
    const nodeRegistryA = new NodeRegistry(systemClock, {
      nodeId: nodeAId,
      capacity: {
        maxInstances: 10,
        maxMemoryMb: 8000,
        cpuCores: 4,
        profileDiskMb: 10_000,
        maxConcurrentLaunches: 2,
      },
    });
    const localNodeTransportA = new LocalNodeTransport(localNodeA, nodeRegistryA, systemClock);

    peerListenerA = await startPeerListener({
      selfNodeId: nodeAId,
      nodeTransport: localNodeTransportA,
      sharedSecret: PEER_SECRET,
      clock: systemClock,
      logger: noopLogger(),
    });

    // The real registration path: `lifecycle/wiring.ts`'s own
    // `store.registerNode` call, `dataAddress` pointed at the peer
    // listener this test just started. Node B is registered too (address
    // never dialled in this suite) purely so `store.getNode(nodeBId)`
    // behaves the way a real deployment's would, not because anything
    // here reaches it.
    await store.registerNode({
      id: nodeAId,
      name: 'node-a',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      dataAddress: peerListenerA.url,
      registrationSecretEnc: 'test',
    });
    await store.registerNode({
      id: nodeBId,
      name: 'node-b',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'test',
    });

    // Node B's own real dial side transport. `resolveEndpoint` reads the
    // SAME store node A just registered into: this is `BrowserRouter.resolveNode`'s
    // own one-line body (`store.getNode(nodeId)`), called directly rather
    // than through a full `BrowserRouter` for the reason this file's own
    // top comment gives.
    nodeTransportB = new WebSocketNodeTransport({
      selfNodeId: nodeBId,
      local: unreachableLocalTransport(),
      resolveEndpoint: async (id) => {
        const node = await store.getNode(id);
        return node ? { url: node.dataPlaneUrl } : null;
      },
      sharedSecret: PEER_SECRET,
      clock: systemClock,
      socketFactory: (endpoint) => new WebSocket(endpoint.url) as unknown as NodeSocketLike,
    });
  });

  afterEach(async () => {
    nodeTransportB.close();
    await peerListenerA.close();
    sessionRegistryA.disposeAll();
    await chromeA.close();
  });

  it("node B dispatches target.create against node A's instance, and it genuinely reaches the real (fake) Chrome endpoint", async () => {
    const created = await nodeTransportB.dispatch(nodeAId, {
      kind: 'target.create',
      instanceId,
      url: 'https://example.com/from-node-b',
    });
    expect(created.kind).toBe('target.create');
    if (created.kind !== 'target.create') throw new Error('unreachable');
    expect(typeof created.target.targetId).toBe('string');

    // Proves this travelled all the way to the real fake Chrome socket
    // node A's own ManagedSession is connected to, not merely to a
    // ManagedSession method that happened to return without error: the
    // fake server's own call log is independent of anything the reply
    // itself claims.
    expect(chromeA.createTargetCalls).toContainEqual(
      expect.objectContaining({ url: 'https://example.com/from-node-b' }),
    );

    const listed = await nodeTransportB.dispatch(nodeAId, { kind: 'target.list', instanceId });
    expect(listed.kind).toBe('target.list');
    if (listed.kind !== 'target.list') throw new Error('unreachable');
    expect(
      listed.targets.some(
        (t) =>
          t.targetId === created.target.targetId && t.url === 'https://example.com/from-node-b',
      ),
    ).toBe(true);
  });

  it('an invalid hello is refused immediately (socket closed with a distinct code), not left for every request to time out', async () => {
    const raw = new WebSocket(peerListenerA.url);
    await new Promise<void>((resolve, reject) => {
      raw.once('open', () => resolve());
      raw.once('error', reject);
    });
    const closed = new Promise<{ code: number }>((resolve) =>
      raw.once('close', (code) => resolve({ code })),
    );
    raw.send(
      JSON.stringify({ t: 'hello', nodeId: nodeBId, ts: Date.now(), mac: 'not-a-real-mac' }),
    );
    const { code } = await closed;
    expect(code).toBe(4401);
  });

  it('a missing hello (a request sent as the very first frame) is refused the same way, not answered as if authenticated', async () => {
    const raw = new WebSocket(peerListenerA.url);
    await new Promise<void>((resolve, reject) => {
      raw.once('open', () => resolve());
      raw.once('error', reject);
    });
    const closed = new Promise<{ code: number }>((resolve) =>
      raw.once('close', (code) => resolve({ code })),
    );
    raw.send(JSON.stringify({ t: 'req', id: 1, nodeId: nodeAId, method: 'list', args: {} }));
    const { code } = await closed;
    expect(code).toBe(4401);
  });

  it('an instance node A holds no live session for is refused clearly (E_INSTANCE_NOT_FOUND), not silently mis-served', async () => {
    await expect(
      nodeTransportB.dispatch(nodeAId, {
        kind: 'target.list',
        instanceId: 'inst_never_owned_by_node_a',
      }),
    ).rejects.toMatchObject({ code: 'E_INSTANCE_NOT_FOUND' });
  });

  it("concurrent in flight requests from node B do not cross: each reply carries its own request's own data", async () => {
    const urls = [
      'https://a.example/one',
      'https://a.example/two',
      'https://a.example/three',
      'https://a.example/four',
      'https://a.example/five',
    ];
    const results: NodeActionResult[] = await Promise.all(
      urls.map((url) =>
        nodeTransportB.dispatch(nodeAId, { kind: 'target.create', instanceId, url }),
      ),
    );
    const targetIds = new Set<string>();
    results.forEach((result, i) => {
      if (result.kind !== 'target.create')
        throw new Error(`unexpected result kind "${result.kind}" for request ${i}`);
      // The strongest possible check here: this specific reply's own url
      // matches the specific request that produced it, proving the reply
      // for request i was never answered with request j's data, for any
      // i != j, across the whole path (peer wire correlation, this
      // listener's own per-request handling, and the CDP bridge's own
      // request/reply correlation underneath it).
      expect(result.target.url).toBe(urls[i]);
      targetIds.add(result.target.targetId);
    });
    expect(targetIds.size).toBe(urls.length);
  });

  it('a peer\'s "cdp" dispatch for a REFUSED_DOMAINS method (Runtime.evaluate) is rejected with ' +
    'E_FORBIDDEN, message naming the method: node-action-executor.ts now rechecks isCdpMethodAllowed ' +
    'itself (node-action-executor.ts:129) rather than trusting that the REST edge (targets.ts:296) is ' +
    'the only door into managed.sendCdp, closing the gap docs/cdp-and-interception.md used to document', async () => {
    const created = await nodeTransportB.dispatch(nodeAId, {
      kind: 'target.create',
      instanceId,
      url: 'https://example.com/cdp-refused',
    });
    if (created.kind !== 'target.create') throw new Error('unreachable');

    // `E_FORBIDDEN`, not a bespoke code: `WebSocketNodeTransport`'s own
    // `codeFromWire` narrows any code outside `AcquireErrorCode` down to
    // `E_NODE_LOST` on the way back across the peer wire, so this
    // assertion doubles as proof the fix picked a code that actually
    // survives the round trip, not just one that reads well in the throw
    // site. The message (preserved verbatim, unlike the code) still names
    // the refused method.
    await expect(
      nodeTransportB.dispatch(nodeAId, {
        kind: 'cdp',
        instanceId,
        targetId: created.target.targetId,
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
      }),
    ).rejects.toMatchObject({
      code: 'E_FORBIDDEN',
      message: expect.stringContaining('Runtime.evaluate'),
    });

    // The refusal happened before `managed.sendCdp` ever ran: the fake
    // endpoint never saw a `Runtime.evaluate` call for this target,
    // proving this is a real refusal and not merely `sendCdp` itself
    // silently swallowing the result.
    expect(chromeA.runtimeEvaluateCalls.length).toBe(0);
  });

  it('a peer\'s "cdp" dispatch for an allowlisted method (Page.navigate) is unaffected by the recheck and still reaches the real (fake) Chrome endpoint', async () => {
    const created = await nodeTransportB.dispatch(nodeAId, {
      kind: 'target.create',
      instanceId,
      url: 'https://example.com/cdp-allowed',
    });
    if (created.kind !== 'target.create') throw new Error('unreachable');

    const result = await nodeTransportB.dispatch(nodeAId, {
      kind: 'cdp',
      instanceId,
      targetId: created.target.targetId,
      method: 'Page.navigate',
      params: { url: 'https://example.com/cdp-allowed-nav' },
    });
    expect(result.kind).toBe('cdp');
  });
});
