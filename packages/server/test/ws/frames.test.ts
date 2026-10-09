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

    // `subscribe()` already forces one frame (a static page emits nothing
    // on its own); this is that forced frame arriving as a real binary
    // WS message, not a mocked call.
    const frame = await nextBinary(ws);
    expect(frame.byteLength).toBeGreaterThan(HEADER_BYTES);
    const decoded = decodeBinaryHeader(frame);
    expect(decoded.streamId).toBe(streamId);
    expect(decoded.gen16).toBe(gen & 0xffff);
    expect(decoded.seq).toBeGreaterThan(0);
    expect(decoded.payload.byteLength).toBeGreaterThan(0);

    ws.close();
  });
});
