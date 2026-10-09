/**
 * `useConsole()`/`useNetwork()`: per target opt in via
 * `diagnostics.subscribe`/`.unsubscribe` on mount/unmount, event filtering
 * by `targetId`, and the bounded ring buffer (a debugging panel must not
 * grow without limit on a page that logs in a loop).
 */
import { BrowserGlassClient } from '@browserglass/client';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConsole } from '../src/useConsole.js';
import { useNetwork } from '../src/useNetwork.js';
import { createFakeWebSocketHarness } from './support/fake-websocket.js';
import { completeHandshake, flushAsync } from './support/fixtures.js';

const TARGET = 'tgt_00000000000000000000000001';
const OTHER_TARGET = 'tgt_00000000000000000000000002';

/** Connects a real `BrowserGlassClient` over a fake socket, granted `devtools` (neither hook's subscribe path fires without it). Returns both. */
async function connectedClient() {
  const harness = createFakeWebSocketHarness();
  const client = new BrowserGlassClient({
    url: 'wss://example.test/browserglass/socket',
    ticket: 'tkt_initial',
    transport: { WebSocketImpl: harness.Impl },
  });
  const connectPromise = client.connect();
  await flushAsync();
  const ws = completeHandshake(harness, { granted: ['view', 'control', 'devtools'] as never });
  await connectPromise;
  return { client, ws };
}

describe('useConsole', () => {
  it('subscribes to console and errors on mount, filters by targetId, and unsubscribes on unmount', async () => {
    const { client, ws } = await connectedClient();

    const { result, unmount } = renderHook(() => useConsole(client, TARGET));
    await flushAsync();

    const sub = [...ws.sentJsonMessages()].reverse().find((m) => m.t === 'diagnostics.subscribe');
    expect(sub).toMatchObject({ targetId: TARGET, console: true, errors: true });

    ws.simulateJson({
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      sq: 2,
      targetId: TARGET,
      level: 'log',
      text: 'hello from the page',
    });
    // A different target's console output must not land in this hook.
    ws.simulateJson({
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      sq: 3,
      targetId: OTHER_TARGET,
      level: 'log',
      text: 'not mine',
    });
    ws.simulateJson({
      v: 1,
      t: 'page.error',
      ts: Date.now(),
      sq: 4,
      targetId: TARGET,
      name: 'TypeError',
      message: 'x is not a function',
    });
    await flushAsync();

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[0]).toMatchObject({
      kind: 'console',
      text: 'hello from the page',
    });
    expect(result.current.entries[1]).toMatchObject({
      kind: 'error',
      text: 'TypeError: x is not a function',
    });

    unmount();
    await flushAsync();
    expect(
      ws.sentJsonMessages().some((m) => m.t === 'diagnostics.unsubscribe' && m.targetId === TARGET),
    ).toBe(true);
  });

  it('bounds the ring buffer to opts.limit, dropping the oldest entries first', async () => {
    const { client, ws } = await connectedClient();
    const { result } = renderHook(() => useConsole(client, TARGET, { limit: 3 }));
    await flushAsync();

    for (let i = 0; i < 5; i++) {
      ws.simulateJson({
        v: 1,
        t: 'console.entry',
        ts: Date.now(),
        sq: 2 + i,
        targetId: TARGET,
        level: 'log',
        text: `line ${i}`,
      });
    }
    await flushAsync();

    expect(result.current.entries).toHaveLength(3);
    expect(result.current.entries.map((e) => e.text)).toEqual(['line 2', 'line 3', 'line 4']);
  });

  it('clear() empties the buffer without unsubscribing', async () => {
    const { client, ws } = await connectedClient();
    const { result } = renderHook(() => useConsole(client, TARGET));
    await flushAsync();

    ws.simulateJson({
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      sq: 2,
      targetId: TARGET,
      level: 'log',
      text: 'one',
    });
    await flushAsync();
    expect(result.current.entries).toHaveLength(1);

    result.current.clear();
    await flushAsync();
    expect(result.current.entries).toHaveLength(0);
    expect(ws.sentJsonMessages().some((m) => m.t === 'diagnostics.unsubscribe')).toBe(false);
  });
});

describe('useNetwork', () => {
  it('subscribes to network only (not console/errors) on mount and filters by targetId', async () => {
    const { client, ws } = await connectedClient();
    const { result } = renderHook(() => useNetwork(client, TARGET));
    await flushAsync();

    const sub = [...ws.sentJsonMessages()].reverse().find((m) => m.t === 'diagnostics.subscribe');
    expect(sub).toMatchObject({ targetId: TARGET, network: true });
    expect('console' in (sub as Record<string, unknown>)).toBe(false);
    expect('errors' in (sub as Record<string, unknown>)).toBe(false);

    ws.simulateJson({
      v: 1,
      t: 'network.request',
      ts: Date.now(),
      sq: 2,
      targetId: TARGET,
      requestId: 'req_1',
      method: 'GET',
      url: 'https://example.com/a.js',
      resourceType: 'script',
      status: 200,
      errorText: null,
      fromCache: false,
      durationMs: 12,
      encodedBytes: 512,
      startedAt: Date.now(),
    });
    ws.simulateJson({
      v: 1,
      t: 'network.request',
      ts: Date.now(),
      sq: 3,
      targetId: OTHER_TARGET,
      requestId: 'req_2',
      method: 'GET',
      url: 'https://example.com/not-mine.js',
      resourceType: 'script',
      status: 200,
      errorText: null,
      fromCache: false,
      durationMs: 5,
      encodedBytes: 100,
      startedAt: Date.now(),
    });
    await flushAsync();

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      requestId: 'req_1',
      url: 'https://example.com/a.js',
    });
  });

  it('bounds the ring buffer to opts.limit', async () => {
    const { client, ws } = await connectedClient();
    const { result } = renderHook(() => useNetwork(client, TARGET, { limit: 2 }));
    await flushAsync();

    for (let i = 0; i < 4; i++) {
      ws.simulateJson({
        v: 1,
        t: 'network.request',
        ts: Date.now(),
        sq: 2 + i,
        targetId: TARGET,
        requestId: `req_${i}`,
        method: 'GET',
        url: `https://example.com/${i}.js`,
        resourceType: 'script',
        status: 200,
        errorText: null,
        fromCache: false,
        durationMs: 1,
        encodedBytes: 1,
        startedAt: Date.now(),
      });
    }
    await flushAsync();

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((e) => e.requestId)).toEqual(['req_2', 'req_3']);
  });

  it('subscribe: false skips the diagnostics.subscribe/unsubscribe lifecycle entirely', async () => {
    const { client, ws } = await connectedClient();
    const { unmount } = renderHook(() => useNetwork(client, TARGET, { subscribe: false }));
    await flushAsync();
    expect(ws.sentJsonMessages().some((m) => m.t === 'diagnostics.subscribe')).toBe(false);
    unmount();
    await flushAsync();
    expect(ws.sentJsonMessages().some((m) => m.t === 'diagnostics.unsubscribe')).toBe(false);
  });
});
