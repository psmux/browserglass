/**
 * `client.diagnostics.subscribe()`/`.unsubscribe()` plus the
 * `network`/`networksummary` client events fed by the wire's
 * `network.request`/`network.summary` messages. `console`/`pageerror` are
 * covered by `BrowserGlassClient.ts`'s `console.entry`/`page.error` cases
 * and their own tests; this file covers only the diagnostics subscription
 * and the network feeds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import { BrowserGlassError } from '../../src/client/errors.js';
import type { FakeWebSocketHarness } from '../transport/fake-websocket.js';
import { fixtureClientOptions, fixtureWelcome, flushMicrotasks, nextSq } from './helpers.js';

const TARGET = 'tgt_00000000000000000000000001';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Like `helpers.ts`'s `connectClientToLive`, but lets a test control `welcome.granted` (that helper always grants the same fixed capability set, which does not include `devtools`). */
async function connectWithGranted(
  client: BrowserGlassClient,
  harness: FakeWebSocketHarness,
  granted: string[],
) {
  const connectPromise = client.connect();
  await flushMicrotasks();
  const ws = harness.latest();
  ws.simulateOpen();
  const hello = ws.lastSentJson();
  ws.simulateJson(fixtureWelcome({ granted: granted as never }, hello.id as string));
  await connectPromise;
  return ws;
}

describe('client.diagnostics', () => {
  it('subscribe() rejects locally without a round trip when devtools is not granted', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectWithGranted(client, harness, ['view', 'control']);
    const ws = harness.latest();

    await expect(client.diagnostics.subscribe(TARGET)).rejects.toThrow(BrowserGlassError);
    await expect(client.diagnostics.subscribe(TARGET)).rejects.toMatchObject({
      code: 'bgls.error.cap.missing',
    });
    expect(ws.sentJsonMessages().some((m) => m.t === 'diagnostics.subscribe')).toBe(false);
  });

  it('subscribe() sends diagnostics.subscribe and resolves with the echoed feeds', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectWithGranted(client, harness, ['view', 'control', 'devtools']);
    const ws = harness.latest();

    const subPromise = client.diagnostics.subscribe(TARGET, { network: true });
    await flushMicrotasks();
    const req = [...ws.sentJsonMessages()].reverse().find((m) => m.t === 'diagnostics.subscribe');
    expect(req).toBeDefined();
    expect(req?.targetId).toBe(TARGET);
    expect(req?.network).toBe(true);
    // console/errors were left undefined by the caller, so they must reach
    // the wire as omitted fields, not `undefined` values, matching every
    // other optional field in this client (see tabs-new.test.ts's identical
    // assertion for `newWindow`).
    expect('console' in (req as Record<string, unknown>)).toBe(false);
    expect('errors' in (req as Record<string, unknown>)).toBe(false);

    ws.simulateJson({
      v: 1,
      t: 'diagnostics.subscribed',
      re: req?.id as string,
      ts: Date.now(),
      sq: nextSq(ws),
      targetId: TARGET,
      console: true,
      errors: true,
      network: true,
    });
    const result = await subPromise;
    expect(result).toEqual({ targetId: TARGET, console: true, errors: true, network: true });
  });

  it('unsubscribe() sends diagnostics.unsubscribe for the given target', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectWithGranted(client, harness, ['view', 'control', 'devtools']);
    const ws = harness.latest();

    await client.diagnostics.unsubscribe(TARGET);
    const sent = ws.sentJsonMessages().find((m) => m.t === 'diagnostics.unsubscribe');
    expect(sent?.targetId).toBe(TARGET);
  });
});

describe('client network events', () => {
  it('emits a network event carrying the network.request payload', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectWithGranted(client, harness, ['view', 'control', 'devtools']);
    const ws = harness.latest();

    const events: unknown[] = [];
    client.on('network', (ev) => events.push(ev));

    ws.simulateJson({
      v: 1,
      t: 'network.request',
      ts: Date.now(),
      sq: nextSq(ws),
      targetId: TARGET,
      requestId: 'req_1',
      method: 'GET',
      url: 'https://example.com/style.css',
      resourceType: 'stylesheet',
      status: 200,
      errorText: null,
      fromCache: false,
      durationMs: 42,
      encodedBytes: 1024,
      startedAt: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: TARGET,
      requestId: 'req_1',
      method: 'GET',
      url: 'https://example.com/style.css',
      status: 200,
    });
  });

  it('emits a networksummary event carrying the network.summary payload', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectWithGranted(client, harness, ['view', 'control', 'devtools']);
    const ws = harness.latest();

    const events: unknown[] = [];
    client.on('networksummary', (ev) => events.push(ev));

    ws.simulateJson({
      v: 1,
      t: 'network.summary',
      ts: Date.now(),
      sq: nextSq(ws),
      targetId: TARGET,
      windowMs: 2000,
      requests: 5,
      failed: 1,
      bytesIn: 2048,
      bytesOut: 512,
      slowest: [{ url: 'https://example.com/slow', ms: 900, status: 200 }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetId: TARGET, requests: 5, failed: 1 });
  });
});
