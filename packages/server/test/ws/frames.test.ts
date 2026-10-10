import { setTier1EncoderFactory } from '@browserglass/core';
import { HEADER_BYTES, decodeBinaryHeader } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestGateway,
  nextBinary,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

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

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

describe('frame emission', () => {
  it('subscribing to a target delivers a real binary frame, header-decodable, with a matching streamId and gen16', async () => {
    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome = await nextMessage(ws);
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
    const subscribed = await nextMessageSkipping(ws, ['presence.state']);
    expect(subscribed['t']).toBe('stream.subscribed');
    const streamId = subscribed['streamId'] as number;
    const gen = subscribed['gen'] as number;

    // The gateway forces one frame right after the reply (a static page
    // emits nothing on its own); this is that forced frame arriving as a
    // real binary WS message, not a mocked call.
    const frame = await nextBinary(ws);
    expect(frame.byteLength).toBeGreaterThan(HEADER_BYTES);
    const decoded = decodeBinaryHeader(frame);
    expect(decoded.streamId).toBe(streamId);
    expect(decoded.gen16).toBe(gen & 0xffff);
    expect(decoded.seq).toBeGreaterThan(0);
    expect(decoded.payload.byteLength).toBeGreaterThan(0);

    ws.close();
  });

  /**
   * Records every message `ws` receives, text and binary, in arrival order.
   * The shared queue helpers keep text and binary apart, which hides
   * exactly the ordering these tests care about.
   */
  function recordOrder(
    ws: import('ws').WebSocket,
  ): Array<{ kind: 'text'; t: string } | { kind: 'binary'; streamId: number; seq: number }> {
    const log: Array<
      { kind: 'text'; t: string } | { kind: 'binary'; streamId: number; seq: number }
    > = [];
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const h = decodeBinaryHeader(new Uint8Array(data).buffer);
        log.push({ kind: 'binary', streamId: h.streamId, seq: h.seq });
      } else {
        log.push({ kind: 'text', t: String(JSON.parse(data.toString('utf8'))['t']) });
      }
    });
    return log;
  }

  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async function joinAndSubscribe(viewerId: string): Promise<{
    ws: import('ws').WebSocket;
    log: ReturnType<typeof recordOrder>;
    streamId: number;
    targetId: string;
  }> {
    const token = await gw.issueToken({ viewerId });
    const ws = gw.connect();
    await waitOpen(ws);
    const log = recordOrder(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome = await nextMessage(ws);
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
    const subscribed = await nextMessageSkipping(ws, ['presence.state', 'target.updated']);
    expect(subscribed['t']).toBe('stream.subscribed');
    return { ws, log, streamId: subscribed['streamId'] as number, targetId };
  }

  it('the first frame of a page that never repaints arrives after stream.subscribed, never before it', async () => {
    // No screencast frame is ever emitted here: the fake page is static,
    // the case where a pane used to sit black. The only frame the viewer
    // can get is the one the gateway forces for it.
    const { ws, log, streamId } = await joinAndSubscribe('viewer-a');
    await waitFor(() => log.some((m) => m.kind === 'binary'));
    const replyAt = log.findIndex((m) => m.kind === 'text' && m.t === 'stream.subscribed');
    const firstFrameAt = log.findIndex((m) => m.kind === 'binary');
    expect(replyAt).toBeGreaterThanOrEqual(0);
    expect(firstFrameAt).toBeGreaterThan(replyAt);
    const first = log[firstFrameAt] as { streamId: number; seq: number };
    expect(first.streamId).toBe(streamId);
    expect(first.seq).toBeGreaterThan(0);
    ws.close();
  });

  it('every viewer of the same static target gets its own first frame, each after its own reply', async () => {
    const a = await joinAndSubscribe('viewer-a');
    await waitFor(() => a.log.some((m) => m.kind === 'binary'));
    const b = await joinAndSubscribe('viewer-b');
    await waitFor(() => b.log.some((m) => m.kind === 'binary'));
    for (const v of [a, b]) {
      const replyAt = v.log.findIndex((m) => m.kind === 'text' && m.t === 'stream.subscribed');
      const firstFrameAt = v.log.findIndex((m) => m.kind === 'binary');
      expect(firstFrameAt).toBeGreaterThan(replyAt);
      expect((v.log[firstFrameAt] as { streamId: number }).streamId).toBe(v.streamId);
    }
    // Both viewers share one stream, so seq keeps counting across them.
    const aSeqs = a.log.filter((m) => m.kind === 'binary').map((m) => (m as { seq: number }).seq);
    const bFirst = b.log.find((m) => m.kind === 'binary') as { seq: number };
    expect(bFirst.seq).toBeGreaterThan(aSeqs[0]!);
    a.ws.close();
    b.ws.close();
  });

  it('re-subscribing after an unsubscribe gets a fresh first frame without any page activity', async () => {
    const a = await joinAndSubscribe('viewer-a');
    await waitFor(() => a.log.some((m) => m.kind === 'binary'));
    a.ws.send(
      JSON.stringify({ v: 1, t: 'stream.unsubscribe', ts: Date.now(), streamId: a.streamId }),
    );
    const before = a.log.length;
    a.ws.send(
      JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId: a.targetId }),
    );
    await waitFor(() => a.log.slice(before).some((m) => m.kind === 'binary'));
    const tail = a.log.slice(before);
    const replyAt = tail.findIndex((m) => m.kind === 'text' && m.t === 'stream.subscribed');
    const frameAt = tail.findIndex((m) => m.kind === 'binary');
    expect(replyAt).toBeGreaterThanOrEqual(0);
    expect(frameAt).toBeGreaterThan(replyAt);
    a.ws.close();
  });
});
