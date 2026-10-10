/**
 * A navigation sent right after `stream.subscribed` waits for the forced
 * first frame capture of that subscribe.
 *
 * The first frame is captured after the reply, so a client that
 * subscribes and then navigates at once used to have its `Page.navigate`
 * reach Chrome while that `Page.captureScreenshot` was still running. On
 * a hidden tab Chrome held the navigation until the capture finished, and
 * the navigation could replace the current history entry instead of
 * adding one: on the macOS and Windows CI runners a second page in the
 * same tab never made back available.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { FORCED_FRAME_NAV_WAIT_MS } from '../../src/session/managed-session.js';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

function hello(token: string): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    auth: { scheme: 'bearer', token },
  };
}

/** Connects, subscribes to the only target, and returns once `stream.subscribed` is in. */
async function connectAndSubscribe(gw: TestGateway): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello(token)));
  const welcome = await nextMessage(ws);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', id: 's1', ts: Date.now(), targetId }));
  const subscribed = await nextMessageSkipping(ws, ['presence.state', 'target.updated']);
  expect(subscribed['t']).toBe('stream.subscribed');
  return { ws, targetId };
}

/** Resolves with the reply correlated to `id`, skipping broadcasts. */
async function replyTo(ws: WebSocket, id: string): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = await nextMessage(ws);
    if (msg['re'] === id) return msg;
  }
}

function goto(ws: WebSocket, targetId: string): void {
  ws.send(
    JSON.stringify({
      v: 1,
      t: 'nav.goto',
      id: 'n1',
      ts: Date.now(),
      targetId,
      url: 'https://b.example/',
    }),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
  gw.addTarget({
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
  });
  gw.chrome.setNavigate({ loaderId: 'L1', loadEventDelayMs: null, title: 'B' });
});

afterEach(async () => {
  await gw.close();
});

const navigateCalls = (): number =>
  gw.chrome.cdpCalls.filter((c) => c.method === 'Page.navigate').length;

describe('a navigation right after subscribe and the forced first frame', () => {
  it('Page.navigate is not sent until the first frame capture has answered', async () => {
    const release = gw.chrome.holdCaptureScreenshots();
    const { ws, targetId } = await connectAndSubscribe(gw);
    // The first frame capture goes out right after the reply.
    for (let i = 0; i < 100 && gw.chrome.captureScreenshotCalls === 0; i += 1) await sleep(10);
    expect(gw.chrome.captureScreenshotCalls).toBeGreaterThan(0);

    const reply = replyTo(ws, 'n1');
    goto(ws, targetId);
    await sleep(300);
    expect(navigateCalls()).toBe(0);

    release();
    expect((await reply)['t']).toBe('nav.state');
    expect(navigateCalls()).toBe(1);
    ws.close();
  });

  it('a capture Chrome never answers delays the navigation by a bounded wait, not forever', async () => {
    const release = gw.chrome.holdCaptureScreenshots();
    try {
      const { ws, targetId } = await connectAndSubscribe(gw);
      const sentAt = Date.now();
      goto(ws, targetId);
      expect((await replyTo(ws, 'n1'))['t']).toBe('nav.state');
      const waited = Date.now() - sentAt;
      expect(waited).toBeGreaterThanOrEqual(FORCED_FRAME_NAV_WAIT_MS - 100);
      expect(waited).toBeLessThan(FORCED_FRAME_NAV_WAIT_MS + 2000);
      ws.close();
    } finally {
      release();
    }
  }, 15_000);
});
