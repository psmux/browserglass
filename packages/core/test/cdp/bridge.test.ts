import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { CdpBridgeImpl } from '../../src/cdp/bridge.js';
import { type FakeCdpWebSocket, installDefaultResponder } from './fake-cdp-endpoint.js';
import { connectFakeBridge, connectFakeBridgeReconnectable } from './test-helpers.js';

describe('CdpBridge.connect', () => {
  it('resolves BrowserVersion parsed from Browser.getVersion, with feature probes populated', async () => {
    const { version, socket } = await connectFakeBridge();
    expect(version.major).toBe(131);
    expect(version.protocolVersion).toBe('1.3');
    expect(socket.lastSent('Browser.getVersion')).toBeDefined();
    expect(version.supports['webLifecycle']).toBe(true);
  });
});

describe('CdpBridge.sessionFor concurrency guard', () => {
  it('two concurrent sessionFor calls for one target produce exactly one Target.attachToTarget', async () => {
    const { bridge, socket, world } = await connectFakeBridge();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });

    const [h1, h2] = await Promise.all([bridge.sessionFor('T1'), bridge.sessionFor('T1')]);

    expect(h1).toBe(h2);
    expect(socket.allSent('Target.attachToTarget')).toHaveLength(1);
  });

  it('a second sessionFor after the first resolves reuses the live handle, still one attach', async () => {
    const { bridge, socket, world } = await connectFakeBridge();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });

    const h1 = await bridge.sessionFor('T1');
    const h2 = await bridge.sessionFor('T1');

    expect(h1).toBe(h2);
    expect(socket.allSent('Target.attachToTarget')).toHaveLength(1);
  });
});

describe('CdpBridge.close', () => {
  it('rejects every in-flight command with E_CDP_CLOSED and leaves the pending map empty', async () => {
    const { bridge, socket } = await connectFakeBridge();
    socket.autoRespond = () => {
      // Stop answering: everything sent from here on stays pending.
    };

    const p1 = bridge.send('Page.enable');
    const p2 = bridge.send('Runtime.enable');
    expect(bridge.stats().inFlight).toBe(2);

    await bridge.close('test shutdown');

    await expect(p1).rejects.toMatchObject({ code: 'E_CDP_CLOSED' });
    await expect(p2).rejects.toMatchObject({ code: 'E_CDP_CLOSED' });
    expect(bridge.stats().inFlight).toBe(0);
    expect(bridge.state).toBe('closed');
  });

  it('an unexpected socket close (Chrome side) does the same rejection and cleanup', async () => {
    const { bridge, socket } = await connectFakeBridge();
    socket.autoRespond = () => {};
    const p1 = bridge.send('Page.enable');

    socket.simulateClose(1006, 'abnormal', false);

    await expect(p1).rejects.toMatchObject({ code: 'E_CDP_CLOSED' });
    expect(bridge.stats().inFlight).toBe(0);
  });
});

describe('CdpBridge session detach', () => {
  it('Target.detachedFromTarget rejects only that sessions in-flight commands', async () => {
    const { bridge, socket, world } = await connectFakeBridge();
    world.targetInfos.push(
      { targetId: 'T1', type: 'page', title: 'a', url: 'https://a.example', attached: false },
      { targetId: 'T2', type: 'page', title: 'b', url: 'https://b.example', attached: false },
    );
    const h1 = await bridge.sessionFor('T1');
    const h2 = await bridge.sessionFor('T2');

    socket.autoRespond = () => {};
    const p1 = bridge.send('Page.enable', undefined, h1.id);
    const p2 = bridge.send('Page.enable', undefined, h2.id);
    expect(bridge.stats().inFlight).toBe(2);

    socket.emitEvent('Target.detachedFromTarget', { sessionId: h1.id, targetId: 'T1' });

    await expect(p1).rejects.toMatchObject({ code: 'E_CDP_DETACHED' });
    expect(bridge.stats().inFlight).toBe(1);

    await bridge.close();
    await expect(p2).rejects.toMatchObject({ code: 'E_CDP_CLOSED' });
  });

  it('a stale detach for an already-superseded session does not clear the new handle', async () => {
    const { bridge, socket, world } = await connectFakeBridge();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });

    const h1 = await bridge.sessionFor('T1');
    expect(bridge.sessionHealth('T1')?.generation).toBe(1);

    // Detach h1 for real, then reattach: this produces a fresh handle at a new generation.
    await bridge.detach(h1.id);
    expect(bridge.sessionHealth('T1')?.attached).toBe(false);

    const h2 = await bridge.sessionFor('T1');
    expect(h2).not.toBe(h1);
    expect(bridge.sessionHealth('T1')?.generation).toBe(2);

    // A late duplicate of the ORIGINAL detach event (Chrome documents that
    // Target.targetDestroyed and Target.detachedFromTarget both fire on tab
    // close with no ordering guarantee, and either can arrive again as a
    // duplicate) arrives for h1's now-retired session id.
    socket.emitEvent('Target.detachedFromTarget', { sessionId: h1.id, targetId: 'T1' });

    const health = bridge.sessionHealth('T1');
    expect(health?.attached).toBe(true);
    expect(health?.generation).toBe(2);
  });
});

describe('CdpBridge.onScreencastFrame ack rule', () => {
  it('sends Page.screencastFrameAck as the first statement, unawaited, before the handler runs', async () => {
    const { bridge, socket, world } = await connectFakeBridge();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });
    const handle = await bridge.sessionFor('T1');

    const events: string[] = [];
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string) => {
      const msg = JSON.parse(data) as { method: string };
      events.push(`send:${msg.method}`);
      originalSend(data);
    };

    let observedCastFrameId: number | null = null;
    bridge.onScreencastFrame(handle.id, (_data, _metadata, castFrameId) => {
      events.push('handler');
      observedCastFrameId = castFrameId;
    });

    socket.emitEvent(
      'Page.screencastFrame',
      {
        data: 'YWJj',
        metadata: {
          deviceWidth: 100,
          deviceHeight: 100,
          pageScaleFactor: 1,
          offsetTop: 0,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 0,
        },
        sessionId: 99,
      },
      handle.id,
    );

    expect(events).toEqual(['send:Page.screencastFrameAck', 'handler']);
    expect(observedCastFrameId).toBe(99);

    const ack = socket.lastSent('Page.screencastFrameAck');
    expect(ack?.params?.['sessionId']).toBe(99);
    expect(ack?.sessionId).toBe(handle.id);
  });

  it('the ack never appears in the pending map: sendNoReply arms no timer and consumes no request id', async () => {
    const { bridge, socket, world } = await connectFakeBridge();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });
    const handle = await bridge.sessionFor('T1');

    const statsBefore = bridge.stats();
    bridge.onScreencastFrame(handle.id, () => {});
    socket.emitEvent('Page.screencastFrame', { data: 'x', metadata: {}, sessionId: 1 }, handle.id);

    expect(bridge.stats().inFlight).toBe(statsBefore.inFlight);
    const ack = socket.lastSent('Page.screencastFrameAck');
    expect(ack?.id).toBe(0);
  });
});

describe('CdpBridge.send timeout semantics', () => {
  it('fireAndForget resolves undefined on timeout instead of rejecting', async () => {
    const { bridge, socket } = await connectFakeBridge();
    socket.autoRespond = () => {};
    const result = await bridge.send('Page.enable', undefined, undefined, {
      timeoutMs: 5,
      fireAndForget: true,
    });
    expect(result).toBeUndefined();
  });

  it('a normal command rejects with E_CDP_TIMEOUT on timeout', async () => {
    const { bridge, socket } = await connectFakeBridge();
    socket.autoRespond = () => {};
    await expect(
      bridge.send('Page.enable', undefined, undefined, { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'E_CDP_TIMEOUT' });
  });

  it('priority high delegates to sendNoReply and never rejects', async () => {
    const { bridge, socket } = await connectFakeBridge();
    const result = await bridge.send('Page.screencastFrameAck', { sessionId: 1 }, undefined, {
      priority: 'high',
    });
    expect(result).toBeUndefined();
    expect(socket.lastSent('Page.screencastFrameAck')?.id).toBe(0);
  });
});

describe('CdpBridge instance identity', () => {
  it('carries the instanceId it was constructed with', () => {
    const instanceId = newId('inst');
    const bridge = new CdpBridgeImpl(instanceId);
    expect(bridge.instanceId).toBe(instanceId);
    expect(bridge.state).toBe('idle');
  });
});

// ── unexpected-close reconnect (../../src/cdp/reconnect.ts) ────────────────
//
// `connectFakeBridgeReconnectable` (`./test-helpers.js`) backs the bridge
// with a `wsFactory` that hands out a fresh `FakeCdpWebSocket` per call, so
// these tests can drive the initial connection (`sockets[0]`) and every
// subsequent redial (`sockets[1]`, `sockets[2]`, ...) independently.
// `backoffMs`/`dialTimeoutMs` are shrunk in every test below so none of them
// depends on production's 1s/2s/4s backoff or 8s dial timeout.

/** Flushes the microtask queue: a `setTimeout` callback always runs after every currently queued microtask has drained, regardless of how many `await` hops separate a driven socket event from the bridge code that reacts to it. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Polls `predicate` on a short real interval until it passes or `timeoutMs` elapses. Used only where a real (if tiny, per this suite's shrunk `backoffMs`) timer genuinely needs to fire between two socket events, which a microtask flush alone cannot wait out. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drives `bridge`'s reconnect loop to budget exhaustion: fails every redial attempt (`sockets[1]`, `sockets[2]`, `sockets[3]`) as soon as it exists, matching a browser process that is genuinely gone (every dial is refused, not merely slow). Returns once `bridge.state` is `'closed'`. */
async function exhaustReconnectBudget(
  bridge: CdpBridgeImpl,
  sockets: FakeCdpWebSocket[],
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitFor(() => sockets.length > attempt);
    sockets[attempt]?.failToOpen();
  }
  await waitFor(() => bridge.state === 'closed');
}

describe('CdpBridge reconnect after an unexpected socket drop', () => {
  it('a socket drop reconnects: the bridge returns to open on a fresh socket, and every previously attached session is invalidated via a synthesized Target.detachedFromTarget (feeding the existing cdp_detached path, not a new one)', async () => {
    const { bridge, sockets, world } = await connectFakeBridgeReconnectable({
      backoffMs: [5, 5, 5],
      dialTimeoutMs: 200,
    });
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });
    const h1 = await bridge.sessionFor('T1');

    const detachedEvents: Array<Record<string, unknown>> = [];
    bridge.on('Target.detachedFromTarget', (params) => {
      detachedEvents.push(params);
    });

    sockets[0]?.simulateClose(1006, 'abnormal', false);

    // The session dying is synchronous fallout from the drop, so a caller
    // holding a stale session id fails fast rather than waiting out a redial.
    expect(bridge.state).toBe('reconnecting');
    expect(h1.alive).toBe(false);
    // The DETACH announcement is deliberately NOT synchronous, and this
    // assertion is the whole reason. `cdp_detached` is a per target,
    // recoverable signal; `browser_dead` is a different one. Announcing a
    // detach before knowing whether the browser is even alive turns a
    // `kill -9` into one unrecoverable per target recovery each, and
    // viewers get torn down on the way. `chaos-1-kill-browser` asserts no
    // viewer socket ever closes as a side effect of the browser dying, and
    // it went red the day this was announced up front.
    expect(detachedEvents).toEqual([]);
    // The redial itself already started (`wsFactory` is called synchronously
    // inside the dial's own promise constructor), one socket beyond the
    // initial connection.
    expect(sockets).toHaveLength(2);

    const world2 = installDefaultResponder(sockets[1] as FakeCdpWebSocket);
    (sockets[1] as FakeCdpWebSocket).open();
    await flushMicrotasks();

    expect(bridge.state).toBe('open');
    // Now it is announced: the browser answered, so every session id minted
    // before the drop really is stale, which is what a detach means.
    expect(detachedEvents).toEqual([{ sessionId: h1.id, targetId: 'T1' }]);

    // A fresh attach works again, through the new socket.
    world2.targetInfos.push({
      targetId: 'T2',
      type: 'page',
      title: 'b',
      url: 'https://b.example',
      attached: false,
    });
    const h2 = await bridge.sessionFor('T2');
    expect(h2.alive).toBe(true);
  });

  it('a drop rejects every in-flight call immediately, independent of whether the reconnect it triggers ever resolves', async () => {
    const { bridge, sockets } = await connectFakeBridgeReconnectable({
      backoffMs: [5, 5, 5],
      dialTimeoutMs: 200,
    });
    (sockets[0] as FakeCdpWebSocket).autoRespond = () => {
      // Stop answering: everything sent from here on stays pending.
    };
    const p1 = bridge.send('Page.enable');
    expect(bridge.stats().inFlight).toBe(1);

    sockets[0]?.simulateClose(1006, 'abnormal', false);

    await expect(p1).rejects.toMatchObject({ code: 'E_CDP_CLOSED' });
    expect(bridge.stats().inFlight).toBe(0);
    // The rejection above did not wait for the reconnect attempt this same
    // drop kicked off; that attempt is still outstanding.
    expect(bridge.state).toBe('reconnecting');
  });

  it('concurrent callers against a reconnecting bridge all fail cleanly without starting a second dial attempt, and a fresh call succeeds once the reconnect completes', async () => {
    const { bridge, sockets, world } = await connectFakeBridgeReconnectable({
      backoffMs: [5, 5, 5],
      dialTimeoutMs: 200,
    });
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });

    sockets[0]?.simulateClose(1006, 'abnormal', false);
    expect(bridge.state).toBe('reconnecting');
    expect(sockets).toHaveLength(2);

    // Three concurrent callers hit the down transport while the one
    // in-flight redial (`sockets[1]`) has not yet opened.
    const results = await Promise.allSettled([
      bridge.send('Page.enable'),
      bridge.send('Runtime.enable'),
      bridge.sessionFor('T1'),
    ]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
    }
    // None of the three concurrent callers started a dial of their own:
    // `send`/`sessionFor` never touch the reconnect loop, only the socket's
    // own `close` handler does, and it already ran once.
    expect(sockets).toHaveLength(2);

    const world2 = installDefaultResponder(sockets[1] as FakeCdpWebSocket);
    (sockets[1] as FakeCdpWebSocket).open();
    await flushMicrotasks();
    expect(bridge.state).toBe('open');

    world2.targetInfos.push({
      targetId: 'T2',
      type: 'page',
      title: 'b',
      url: 'https://b.example',
      attached: false,
    });
    const h = await bridge.sessionFor('T2');
    expect(h.alive).toBe(true);
  });

  it('reconnect budget exhaustion (three failed redials) finalizes the bridge cleanly: state settles at closed and every future call is rejected honestly', async () => {
    const { bridge, sockets } = await connectFakeBridgeReconnectable({
      backoffMs: [1, 1, 1],
      dialTimeoutMs: 200,
    });
    let closeEvents = 0;
    bridge.onBridge('bridge.close', () => {
      closeEvents += 1;
    });

    sockets[0]?.simulateClose(1006, 'abnormal', false);
    await exhaustReconnectBudget(bridge, sockets);

    expect(bridge.state).toBe('closed');
    expect(closeEvents).toBe(1);
    await expect(bridge.send('Page.enable')).rejects.toMatchObject({ code: 'E_CDP_CLOSED' });
    await expect(bridge.sessionFor('T1')).rejects.toBeTruthy();
  });

  it('a browser that is genuinely gone (every redial refused) does not reconnect forever: exactly three attempts run, never a fourth', async () => {
    const { bridge, sockets } = await connectFakeBridgeReconnectable({
      backoffMs: [1, 1, 1],
      dialTimeoutMs: 200,
    });

    sockets[0]?.simulateClose(1006, 'abnormal', false);
    await exhaustReconnectBudget(bridge, sockets);

    // sockets[0] (the original connection) plus exactly three redial
    // attempts: the initial drop's own three-attempt budget, and nothing
    // beyond it. That is the "three restarts, then stop" shape, rather
    // than browser-use's per-disconnect-event budget that can
    // requeue itself forever against a socket that keeps dying.
    expect(sockets).toHaveLength(4);
    expect(bridge.state).toBe('closed');

    // Waiting past every attempt's backoff again confirms nothing further
    // is scheduled: a fifth or sixth socket never appears.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets).toHaveLength(4);
  });

  it('an explicit close() during an in-flight reconnect wins: the bridge stays closed even if the reconnect it preempted would have succeeded', async () => {
    const { bridge, sockets } = await connectFakeBridgeReconnectable({
      backoffMs: [5, 5, 5],
      dialTimeoutMs: 200,
    });

    sockets[0]?.simulateClose(1006, 'abnormal', false);
    expect(bridge.state).toBe('reconnecting');
    expect(sockets).toHaveLength(2);

    await bridge.close('shutting down');
    expect(bridge.state).toBe('closed');

    // The in-flight redial now succeeds anyway; the bridge must not reopen.
    installDefaultResponder(sockets[1] as FakeCdpWebSocket);
    (sockets[1] as FakeCdpWebSocket).open();
    await flushMicrotasks();

    expect(bridge.state).toBe('closed');
  });
});
