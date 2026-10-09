/**
 * `WebSocketNodeTransport`, the multi node transport. Every
 * test here drives a scripted `FakeNodeSocket` (`test/support/fakeNodeSocket.ts`)
 * by hand: there is no real second process anywhere in this suite, and no
 * peer side listener exists in this repository for these frames to answer
 * against for real (`WebSocketNodeTransport.ts`'s own top comment).
 */

import { newId } from '@browserglass/protocol';
import type { NodeActionRequest, NodeLaunchRequest, NodeTransport } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { WebSocketNodeTransport } from '../../src/node/WebSocketNodeTransport.js';
import { type NodeAuthHello, verifyHello } from '../../src/node/nodeAuth.js';
import { createFakeClock } from '../support/fakeClock.js';
import { createFakeNodeSocketFactory } from '../support/fakeNodeSocket.js';

/** Yields until the microtask queue is fully drained (a macrotask boundary), so every pending `await` chain this class's own methods set up gets a chance to run before the test inspects state. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A `NodeTransport` whose every method throws if actually called: used as `local` in tests that must reach the peer path, never the local one, so an accidental fallthrough to `local` fails loudly instead of silently passing. */
function unusedLocalTransport(): NodeTransport {
  const fail = (name: string) => (): never => {
    throw new Error(`local.${name} must not be called in this test`);
  };
  return {
    heartbeat: fail('heartbeat'),
    launch: fail('launch'),
    terminate: fail('terminate'),
    list: fail('list'),
    dispatch: fail('dispatch'),
  } as unknown as NodeTransport;
}

const TARGET_LIST_REQUEST: NodeActionRequest = { kind: 'target.list', instanceId: 'inst_x' };

describe('WebSocketNodeTransport: local node id', () => {
  it('delegates to `local` directly for its own node id, opening no socket at all', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const selfNodeId = newId('nod');
    const localCalls: NodeActionRequest[] = [];
    function fail(): never {
      throw new Error('not used in this test');
    }
    const local: NodeTransport = {
      heartbeat: async (nodeId) => ({ nodeId, accepted: true, serverTime: 0, drain: null }),
      launch: fail,
      terminate: async (_nodeId, _instanceId, mode) => ({
        mode,
        effective: mode,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        locksCleared: [],
        warnings: [],
      }),
      list: async () => [],
      dispatch: async (_nodeId, req) => {
        localCalls.push(req);
        return { kind: 'target.list', targets: [] };
      },
    };

    const transport = new WebSocketNodeTransport({
      selfNodeId,
      local,
      resolveEndpoint: () => {
        throw new Error(
          'resolveEndpoint must not be called for the local node id: no serialisation means no address lookup either',
        );
      },
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
    });

    const result = await transport.dispatch(selfNodeId, TARGET_LIST_REQUEST);

    expect(result).toEqual({ kind: 'target.list', targets: [] });
    expect(localCalls).toEqual([TARGET_LIST_REQUEST]);
    expect(sockets).toHaveLength(0);
  });
});

describe('WebSocketNodeTransport: peer authentication', () => {
  it('sends a correctly signed hello frame before any request frame', async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const { factory, sockets } = createFakeNodeSocketFactory();
    const selfNodeId = newId('nod');
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId,
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'top-secret',
      clock,
      socketFactory: factory,
    });

    const callPromise = transport.dispatch(peerNodeId, TARGET_LIST_REQUEST);
    await tick();
    expect(sockets).toHaveLength(1);
    sockets[0]!.simulateOpen();
    await tick();

    const hello = sockets[0]!.firstFrame() as NodeAuthHello;
    expect(hello.t).toBe('hello');
    expect(hello.nodeId).toBe(selfNodeId);
    expect(verifyHello(hello, 'top-secret', clock.now())).toBe(true);
    expect(verifyHello(hello, 'wrong-secret', clock.now())).toBe(false);

    // Clean up the still pending call so it doesn't leak into the next test.
    const req = JSON.parse(sockets[0]!.sent[1]!) as { id: number };
    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req.id,
        ok: true,
        result: { kind: 'target.list', targets: [] },
      }),
    );
    await callPromise;
  });
});

describe('WebSocketNodeTransport: request/reply correlation', () => {
  it('correlates concurrent requests to one peer, even when replies arrive out of order', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
    });

    const p1 = transport.dispatch(peerNodeId, { kind: 'target.list', instanceId: 'inst_1' });
    const p2 = transport.dispatch(peerNodeId, { kind: 'target.list', instanceId: 'inst_2' });

    await tick();
    expect(sockets).toHaveLength(1); // one connection shared by both concurrent calls
    sockets[0]!.simulateOpen();
    await tick();
    expect(sockets[0]!.sent).toHaveLength(3); // hello + 2 requests

    const req1 = JSON.parse(sockets[0]!.sent[1]!) as { id: number };
    const req2 = JSON.parse(sockets[0]!.sent[2]!) as { id: number };
    expect(req1.id).not.toBe(req2.id);

    // Reply out of order: req2's answer arrives first.
    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req2.id,
        ok: true,
        result: {
          kind: 'target.list',
          targets: [{ targetId: 'from-2', url: 'about:blank', title: '' }],
        },
      }),
    );
    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req1.id,
        ok: true,
        result: {
          kind: 'target.list',
          targets: [{ targetId: 'from-1', url: 'about:blank', title: '' }],
        },
      }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({
      kind: 'target.list',
      targets: [{ targetId: 'from-1', url: 'about:blank', title: '' }],
    });
    expect(r2).toEqual({
      kind: 'target.list',
      targets: [{ targetId: 'from-2', url: 'about:blank', title: '' }],
    });
  });

  it('never throws out of socket message handling on a malformed or unexpected frame, and a later valid frame still resolves correctly', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
    });

    const promise = transport.dispatch(peerNodeId, TARGET_LIST_REQUEST);
    await tick();
    sockets[0]!.simulateOpen();
    await tick();

    expect(() => sockets[0]!.simulateMessage('not json{{{')).not.toThrow();
    expect(() =>
      sockets[0]!.simulateMessage(JSON.stringify({ t: 'something-else', foo: 'bar' })),
    ).not.toThrow();
    expect(() =>
      sockets[0]!.simulateMessage(JSON.stringify({ t: 'res', id: 999_999, ok: true, result: {} })),
    ).not.toThrow(); // unknown request id
    expect(() => sockets[0]!.simulateMessage(JSON.stringify(null))).not.toThrow();
    expect(() => sockets[0]!.simulateMessage('42')).not.toThrow();

    const req = JSON.parse(sockets[0]!.sent[1]!) as { id: number };
    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req.id,
        ok: true,
        result: { kind: 'target.list', targets: [] },
      }),
    );

    await expect(promise).resolves.toEqual({ kind: 'target.list', targets: [] });
  });
});

describe('WebSocketNodeTransport: timeout', () => {
  it('rejects with a retryable E_NODE_LOST when a peer never replies within requestTimeoutMs', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
      requestTimeoutMs: 5_000,
    });

    const promise = transport.dispatch(peerNodeId, TARGET_LIST_REQUEST);
    await tick();
    sockets[0]!.simulateOpen();
    await tick();

    clock.advance(5_000);

    await expect(promise).rejects.toMatchObject({ code: 'E_NODE_LOST', retryable: true });
  });
});

describe('WebSocketNodeTransport: reconnect with backoff', () => {
  it('rejects an immediate retry after a drop without dialing again, then reconnects once the backoff window passes', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
      reconnectBackoffMs: [1_000],
    });

    const p1 = transport.dispatch(peerNodeId, { kind: 'target.list', instanceId: 'a' });
    await tick();
    sockets[0]!.simulateOpen();
    await tick();
    const req1 = JSON.parse(sockets[0]!.sent[1]!) as { id: number };
    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req1.id,
        ok: true,
        result: { kind: 'target.list', targets: [] },
      }),
    );
    await p1;

    // The node restarts, or the network blips: the connection drops.
    sockets[0]!.simulateClose();

    // A call issued immediately after is refused on the backoff floor,
    // without this transport ever dialing a second socket: "a node
    // restart must not permanently poison the transport" does not mean
    // "hammer a dead peer with a fresh dial on every call".
    await expect(
      transport.dispatch(peerNodeId, { kind: 'target.list', instanceId: 'b' }),
    ).rejects.toMatchObject({ code: 'E_NODE_LOST' });
    expect(sockets).toHaveLength(1);

    // Past the backoff window, the next call tries again for real.
    clock.advance(1_000);
    const p2 = transport.dispatch(peerNodeId, { kind: 'target.list', instanceId: 'c' });
    await tick();
    expect(sockets).toHaveLength(2);
    sockets[1]!.simulateOpen();
    await tick();
    const req2 = JSON.parse(sockets[1]!.sent[1]!) as { id: number };
    sockets[1]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req2.id,
        ok: true,
        result: { kind: 'target.list', targets: [] },
      }),
    );

    await expect(p2).resolves.toEqual({ kind: 'target.list', targets: [] });
  });

  it("rejects every in flight request immediately when the connection drops mid call, rather than waiting out each one's own timeout", async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
      requestTimeoutMs: 60_000,
    });

    const promise = transport.dispatch(peerNodeId, TARGET_LIST_REQUEST);
    await tick();
    sockets[0]!.simulateOpen();
    await tick();

    sockets[0]!.simulateClose();

    await expect(promise).rejects.toMatchObject({ code: 'E_NODE_LOST' });
  });
});

describe('WebSocketNodeTransport: no known endpoint', () => {
  it('rejects with E_NODE_LOST and never dials when resolveEndpoint has no known address for the node', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => null,
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
    });

    await expect(transport.dispatch(newId('nod'), TARGET_LIST_REQUEST)).rejects.toMatchObject({
      code: 'E_NODE_LOST',
    });
    expect(sockets).toHaveLength(0);
  });
});

describe('WebSocketNodeTransport: terminate gracePeriodMs', () => {
  it('threads gracePeriodMs into the wire terminate() args', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
    });

    const promise = transport.terminate(peerNodeId, 'inst_x', 'graceful', 9_999);
    await tick();
    sockets[0]!.simulateOpen();
    await tick();

    const req = JSON.parse(sockets[0]!.sent[1]!) as {
      id: number;
      method: string;
      args: { instanceId: string; mode: string; gracePeriodMs: number };
    };
    expect(req.method).toBe('terminate');
    expect(req.args).toEqual({ instanceId: 'inst_x', mode: 'graceful', gracePeriodMs: 9_999 });

    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req.id,
        ok: true,
        result: {
          mode: 'graceful',
          effective: 'graceful',
          exitCode: 0,
          signal: null,
          durationMs: 1,
          locksCleared: [],
          warnings: [],
        },
      }),
    );
    await expect(promise).resolves.toMatchObject({ effective: 'graceful' });
  });
});

describe('WebSocketNodeTransport: launch() over the wire', () => {
  it('returns a LaunchedBrowser whose teardown genuinely routes back over the wire, and an honestly no-op onUnexpectedExit', async () => {
    const clock = createFakeClock();
    const { factory, sockets } = createFakeNodeSocketFactory();
    const peerNodeId = newId('nod');
    const transport = new WebSocketNodeTransport({
      selfNodeId: newId('nod'),
      local: unusedLocalTransport(),
      resolveEndpoint: async () => ({ url: 'ws://peer/x' }),
      sharedSecret: 'shh',
      clock,
      socketFactory: factory,
    });

    const launchReq = {
      instanceId: 'inst_x',
      sessionId: null,
      spec: {},
      profile: {
        storedKey: 'k',
        mode: 'ephemeral',
        fence: 0,
        source: 'empty',
        templateId: null,
        seed: null,
      },
      limits: {},
      leaseMs: 30_000,
      term: 0,
    } as unknown as NodeLaunchRequest;

    const wireHandle = {
      instanceId: 'inst_x',
      runtimeKind: 'host',
      transport: { kind: 'http', cdpUrl: 'http://127.0.0.1:9222', host: '127.0.0.1', port: 9222 },
      cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake',
      browserGuid: 'guid-1',
      pid: 4321,
      containerId: null,
      podName: null,
      profilePath: '/tmp/profile',
      containerProfilePath: null,
      engineVersion: 'Chrome/999.0.0.0',
      protocolVersion: '1.3',
      nativeUserAgent: 'fake-ua',
      launchDurationMs: 5,
      launchPhases: { preflight: 0, reconcile: 0, spawn: 5, cdpWait: 0, postLaunch: 0 },
      startedAt: 1_000,
      adopted: false,
    };

    const launchPromise = transport.launch(peerNodeId, launchReq);
    await tick();
    sockets[0]!.simulateOpen();
    await tick();

    const req1 = JSON.parse(sockets[0]!.sent[1]!) as { id: number; method: string };
    expect(req1.method).toBe('launch');
    sockets[0]!.simulateMessage(
      JSON.stringify({ t: 'res', id: req1.id, ok: true, result: wireHandle }),
    );

    const handle = await launchPromise;
    expect(handle.cdpWsUrl).toBe(wireHandle.cdpWsUrl);
    expect(handle.browserGuid).toBe(wireHandle.browserGuid);
    expect(typeof handle.teardown).toBe('function');

    // teardown() is a REAL call, not a stub: it goes back over the same
    // wire as a 'terminate' request against the same instance.
    const teardownPromise = handle.teardown('graceful');
    await tick();
    const req2 = JSON.parse(sockets[0]!.sent[2]!) as {
      id: number;
      method: string;
      args: { instanceId: string; mode: string };
    };
    expect(req2.method).toBe('terminate');
    expect(req2.args).toMatchObject({ instanceId: 'inst_x', mode: 'graceful' });
    sockets[0]!.simulateMessage(
      JSON.stringify({
        t: 'res',
        id: req2.id,
        ok: true,
        result: {
          mode: 'graceful',
          effective: 'graceful',
          exitCode: 0,
          signal: null,
          durationMs: 1,
          locksCleared: [],
          warnings: [],
        },
      }),
    );
    await expect(teardownPromise).resolves.toMatchObject({ effective: 'graceful' });

    // onUnexpectedExit is documented, honest, unimplementable-here no-op:
    // this class has no push channel for a peer to proactively report an
    // exit it did not cause. A caller gets a real unsubscribe function,
    // but the callback is never invoked.
    const unsubscribe = handle.onUnexpectedExit(() => {
      throw new Error('onUnexpectedExit must never fire for a remote launch in this build');
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
