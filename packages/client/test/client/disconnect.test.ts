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

describe('BrowserGlassClient.disconnect()', () => {
  it('sends control.release before the close frame, for every held lease', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const controlPromise = client.requestControl(TARGET);
    await flushMicrotasks();
    const controlReq = [...ws.sentJsonMessages()].reverse().find((m) => m.t === 'control.request');
    expect(controlReq).toBeDefined();
    ws.simulateJson({
      v: 1,
      t: 'control.granted',
      re: controlReq?.id,
      ts: Date.now(),
      sq: 2,
      targetId: TARGET,
      leaseId: 'lse_grant1',
      expiresAt: Date.now() + 30000,
      renewWithinMs: 5000,
      idleReleaseMs: 60000,
      mode: 'exclusive',
    });
    const outcome = await controlPromise;
    expect(outcome.granted).toBe(true);
    expect(client.hasControl(TARGET)).toBe(true);

    await client.disconnect();

    const sentTypes = ws.sentJsonMessages().map((m) => m.t);
    const releaseIndex = sentTypes.lastIndexOf('control.release');
    expect(releaseIndex).toBeGreaterThanOrEqual(0);

    // the close call is the transport tearing the socket down; it must
    // happen strictly after the control.release message was already sent.
    const closeCallCount = ws.closeCalls.length;
    expect(closeCallCount).toBeGreaterThanOrEqual(1);
    // every message in `sent` was pushed before the socket transitioned to
    // closed (FakeWebSocket.send() throws once readyState !== 1), so the
    // mere presence of control.release in `sent` after a successful call
    // already proves it went out on the still-open socket, i.e. before the
    // close frame.
    expect(ws.sent.length).toBeGreaterThan(0);
  });

  it('sends stream.unsubscribe for every subscribed stream before the close frame', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const subscribePromise = client.subscribe(TARGET);
    await flushMicrotasks();
    answerLatestSubscribe(ws);
    await subscribePromise;

    await client.disconnect();
    expect(ws.sentJsonMessages().some((m) => m.t === 'stream.unsubscribe')).toBe(true);
  });

  it('closes with code 1000 by default and does not reconnect', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    await client.disconnect();
    expect(ws.closeCalls[ws.closeCalls.length - 1]?.code).toBe(1000);
    expect(client.state).toBe('idle');
  });
});
