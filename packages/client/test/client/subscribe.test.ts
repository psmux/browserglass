import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import {
  answerLatestSubscribe,
  connectClientToLive,
  fixtureClientOptions,
  flushMicrotasks,
} from './helpers.js';

const TARGET = 'tgt_00000000000000000000000001';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserGlassClient.subscribe() idempotency', () => {
  it('two concurrent identical subscribe() calls produce exactly one stream.subscribe on the wire', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const p1 = client.subscribe(TARGET);
    const p2 = client.subscribe(TARGET);
    await flushMicrotasks();

    const subscribeCalls = ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe');
    expect(subscribeCalls.length).toBe(1);

    answerLatestSubscribe(ws);
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toBe(h2);
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe').length).toBe(1);
  });

  it('a second subscribe() with identical options, after the first resolved, sends no second stream.subscribe', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const p1 = client.subscribe(TARGET, { quality: 'high' });
    await flushMicrotasks();
    answerLatestSubscribe(ws, { quality: 'high' });
    const h1 = await p1;

    const h2 = await client.subscribe(TARGET, { quality: 'high' });
    expect(h2).toBe(h1);
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe').length).toBe(1);
  });

  it('a second subscribe() with different options reconfigures via stream.quality, not a second stream.subscribe', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const p1 = client.subscribe(TARGET, { quality: 'low' });
    await flushMicrotasks();
    answerLatestSubscribe(ws, { quality: 'low' });
    await p1;

    const p2 = client.subscribe(TARGET, { quality: 'high' });
    await flushMicrotasks();
    expect(ws.sentJsonMessages().some((m) => m.t === 'stream.quality')).toBe(true);
    answerLatestSubscribe(ws, { quality: 'high', sidEpoch: 2 });
    const h2 = await p2;

    expect(h2.quality).toBe('high');
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe').length).toBe(1);
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.quality').length).toBe(1);
  });

  it('unsubscribe() sends stream.unsubscribe and a fresh subscribe() for the same target subscribes again', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const p1 = client.subscribe(TARGET);
    await flushMicrotasks();
    answerLatestSubscribe(ws);
    const h1 = await p1;

    await h1.unsubscribe();
    expect(
      ws.sentJsonMessages().some((m) => m.t === 'stream.unsubscribe' && m.streamId === h1.streamId),
    ).toBe(true);

    const p2 = client.subscribe(TARGET);
    await flushMicrotasks();
    answerLatestSubscribe(ws);
    await p2;
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe').length).toBe(2);
  });
});
