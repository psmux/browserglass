/**
 * `nav.goto`'s `waitUntil`. `'commit'` (the wire default) answers as soon
 * as `Page.navigate` returns, with the page still loading. `'load'` waits
 * for the new document's `Page.loadEventFired`, so the reply carries the
 * loaded page's title. Found by running a recipe against a real gateway:
 * `await navigate(url)` followed by reading the page saw `title: ''` and
 * `loading: true`, because the field was declared on the wire and then
 * ignored by the server.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessage,
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

async function connect(gw: TestGateway): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello(token)));
  const welcome = await nextMessage(ws);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

/** The reply correlated to `id`, skipping broadcasts (including the uncorrelated `nav.state` copy every viewer gets). */
async function replyTo(ws: WebSocket, id: string): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = await nextMessage(ws);
    if (msg['re'] === id) return msg;
  }
}

function goto(ws: WebSocket, targetId: string, extra: Record<string, unknown>): void {
  ws.send(
    JSON.stringify({
      v: 1,
      t: 'nav.goto',
      id: 'n1',
      ts: Date.now(),
      targetId,
      url: 'https://b.example/',
      ...extra,
    }),
  );
}

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
});

afterEach(async () => {
  await gw.close();
});

describe("nav.goto waitUntil: 'load'", () => {
  it('answers after the load event, with the loaded title and loading:false', async () => {
    gw.chrome.setNavigate({ loaderId: 'L1', loadEventDelayMs: 150, title: 'Example B' });
    const { ws, targetId } = await connect(gw);
    goto(ws, targetId, { waitUntil: 'load' });
    const reply = await replyTo(ws, 'n1');
    expect(reply['t']).toBe('nav.state');
    expect(reply['url']).toBe('https://b.example/');
    expect(reply['title']).toBe('Example B');
    expect(reply['loading']).toBe(false);
    ws.close();
  });

  it('ignores a load event from the previous document that lands before Page.navigate answers', async () => {
    gw.chrome.setNavigate({
      loaderId: 'L1',
      loadEventDelayMs: 200,
      title: 'Example B',
      staleLoadFirst: true,
    });
    const { ws, targetId } = await connect(gw);
    goto(ws, targetId, { waitUntil: 'load' });
    const reply = await replyTo(ws, 'n1');
    expect(reply['title']).toBe('Example B');
    expect(reply['loading']).toBe(false);
    ws.close();
  });

  it('answers at once for a same-document navigation (no loaderId)', async () => {
    gw.chrome.setNavigate({ loadEventDelayMs: null, title: 'never' });
    const { ws, targetId } = await connect(gw);
    const started = Date.now();
    goto(ws, targetId, { waitUntil: 'load', timeoutMs: 5000 });
    const reply = await replyTo(ws, 'n1');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reply['loading']).toBe(false);
    ws.close();
  });

  it('answers with loading:true, not an error, when load never fires within timeoutMs', async () => {
    gw.chrome.setNavigate({ loaderId: 'L1', loadEventDelayMs: null, title: 'never' });
    const { ws, targetId } = await connect(gw);
    goto(ws, targetId, { waitUntil: 'load', timeoutMs: 300 });
    const reply = await replyTo(ws, 'n1');
    expect(reply['t']).toBe('nav.state');
    expect(reply['loading']).toBe(true);
    ws.close();
  });
});

describe("nav.goto waitUntil: 'commit' and the default", () => {
  it('answers right after Page.navigate, still loading, when waitUntil is omitted', async () => {
    gw.chrome.setNavigate({ loaderId: 'L1', loadEventDelayMs: 1000, title: 'Example B' });
    const { ws, targetId } = await connect(gw);
    goto(ws, targetId, {});
    const reply = await replyTo(ws, 'n1');
    expect(reply['loading']).toBe(true);
    expect(reply['title']).toBe('');
    ws.close();
  });
});

describe('nav.goto waitUntil validation', () => {
  it("refuses 'networkidle' by name instead of silently treating it as something else", async () => {
    const { ws, targetId } = await connect(gw);
    goto(ws, targetId, { waitUntil: 'networkidle' });
    const reply = await replyTo(ws, 'n1');
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.protocol.bad_envelope');
    expect(reply['message']).toContain('networkidle');
    expect(gw.chrome.cdpCalls.some((c) => c.method === 'Page.navigate')).toBe(false);
    ws.close();
  });
});
