import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import {
  answerLatestSubscribe,
  connectClientToLive,
  fixtureClientOptions,
  fixtureWelcome,
  flushMicrotasks,
} from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserGlassClient.connect()', () => {
  it('a double connect() produces exactly one socket (StrictMode double-mount safe)', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);

    const p1 = client.connect();
    const p2 = client.connect();
    expect(p1).toBe(p2);

    await flushMicrotasks();
    expect(harness.instances.length).toBe(1);

    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    ws.simulateJson(fixtureWelcome({}, hello.id as string));
    await p1;
    await p2;

    expect(harness.instances.length).toBe(1);
    expect(client.state).toBe('live');
  });

  it('connect() while already live resolves immediately without a new socket', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    expect(harness.instances.length).toBe(1);

    await expect(client.connect()).resolves.toBeUndefined();
    expect(harness.instances.length).toBe(1);
  });

  it('resolves welcome-only connects with no subscribe option immediately', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    expect(client.viewerId).toBe('vwr_00000000000000000000000001');
    expect(client.granted.has('view')).toBe(true);
  });

  it('waits for every folded subscribe option to produce its stream.subscribed before resolving', async () => {
    const { options, harness } = fixtureClientOptions({
      subscribe: [{ targetId: 'tgt_00000000000000000000000001' }],
    });
    const client = new BrowserGlassClient(options);

    const connectPromise = client.connect();
    await flushMicrotasks();
    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    expect(hello.subscribe).toEqual([{ targetId: 'tgt_00000000000000000000000001' }]);
    ws.simulateJson(fixtureWelcome({}, hello.id as string));

    // welcome alone must not resolve BrowserGlassClient.connect(): it additionally
    // waits for stream.subscribed, unlike transport.connect().
    let settled = false;
    void connectPromise.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    ws.simulateJson({
      v: 1,
      t: 'stream.subscribed',
      sq: 2,
      ts: Date.now(),
      streamId: 1,
      targetId: 'tgt_00000000000000000000000001',
      quality: 'auto',
      codec: 'jpeg',
      fps: 15,
      width: 800,
      height: 600,
      dpr: 1,
      paused: false,
      sidEpoch: 1,
      gen: 1,
    });
    await connectPromise;
    expect(settled).toBe(true);
  });

  it('a Node-style injected WebSocketImpl (not a global WebSocket) drives the same handshake', async () => {
    const { options, harness } = fixtureClientOptions();
    // fixtureClientOptions already injects transport.WebSocketImpl explicitly,
    // exactly the way a Node caller passes the `ws` package: this test only
    // asserts no global `WebSocket` is required for the injected path to work.
    const globalWs = (globalThis as { WebSocket?: unknown }).WebSocket;
    // biome-ignore lint/performance/noDelete: the test needs the global absent, not present with the value undefined.
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const client = new BrowserGlassClient(options);
      await connectClientToLive(client, harness);
      expect(client.state).toBe('live');
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = globalWs;
    }
  });

  it('answerLatestSubscribe helper answers a real stream.subscribe request', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const subscribePromise = client.subscribe('tgt_00000000000000000000000001');
    await flushMicrotasks();
    answerLatestSubscribe(ws);
    const handle = await subscribePromise;
    expect(handle.targetId).toBe('tgt_00000000000000000000000001');
  });
});
