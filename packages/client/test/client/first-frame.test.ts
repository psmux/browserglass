import { PayloadCodec, encodeBinaryHeader } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import { stubRect } from '../render/testHelpers.js';
import { fakeFramePayload } from '../setup.js';
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

/** One wire binary frame: a real header followed by a payload the test `createImageBitmap` decodes to `width` by `height`. */
function wireFrame(opts: {
  streamId: number;
  seq: number;
  gen16: number;
  width: number;
  height: number;
}): Uint8Array {
  const header = encodeBinaryHeader({
    version: 1,
    msgType: 1,
    streamId: opts.streamId,
    seq: opts.seq,
    tsDeltaMs: 0,
    payloadCodec: PayloadCodec.JPEG,
    flags: 1,
    gen16: opts.gen16,
  });
  const payload = fakeFramePayload({ width: opts.width, height: opts.height });
  const out = new Uint8Array(header.byteLength + payload.byteLength);
  out.set(header, 0);
  out.set(payload, header.byteLength);
  return out;
}

function canvasPair(): { canvas: HTMLCanvasElement; container: HTMLElement } {
  const canvas = document.createElement('canvas');
  const container = document.createElement('div');
  container.appendChild(canvas);
  document.body.appendChild(container);
  stubRect(canvas, { left: 0, top: 0, width: 100, height: 100 });
  stubRect(container, { left: 0, top: 0, width: 100, height: 100 });
  return { canvas, container };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(1);
}

describe('a renderer attached after the first frame arrived', () => {
  it('paints that frame straight away instead of waiting for the page to repaint', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const p = client.subscribe(TARGET);
    await flushMicrotasks();
    answerLatestSubscribe(ws, { streamId: 1, gen: 1 });
    const handle = await p;

    // The one forced frame the gateway sends after `stream.subscribed`.
    // A static page sends nothing after it.
    ws.simulateBinary(wireFrame({ streamId: 1, seq: 1, gen16: 1, width: 640, height: 360 }));
    await settle();
    // Acked on receipt even with no renderer, so the server's backlog
    // never fills up behind a pane that has not attached yet.
    expect(ws.sentJsonMessages().filter((m) => m.t === 'ack' && m.seq === 1).length).toBe(1);

    // The app attaches its canvas a tick later, the way a React effect does.
    const { canvas, container } = canvasPair();
    const renderer = handle.attach(canvas, container);
    await settle();
    expect(renderer.stats.framesPainted).toBe(1);
    expect(renderer.stats.lastPaintedSeq).toBe(1);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
  });

  it('repaints the newest frame on a fresh canvas after a detach and reattach', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const first = canvasPair();
    const p = client.subscribe(TARGET);
    await flushMicrotasks();
    answerLatestSubscribe(ws, { streamId: 1, gen: 1 });
    const handle = await p;
    handle.attach(first.canvas, first.container);

    ws.simulateBinary(wireFrame({ streamId: 1, seq: 1, gen16: 1, width: 300, height: 200 }));
    ws.simulateBinary(wireFrame({ streamId: 1, seq: 2, gen16: 1, width: 320, height: 240 }));
    await settle();

    handle.detach();
    const second = canvasPair();
    const renderer = handle.attach(second.canvas, second.container);
    await settle();
    expect(renderer.stats.lastPaintedSeq).toBe(2);
    expect(second.canvas.width).toBe(320);
  });

  it('does not paint a kept frame from an older generation', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const p = client.subscribe(TARGET);
    await flushMicrotasks();
    answerLatestSubscribe(ws, { streamId: 1, gen: 2 });
    const handle = await p;

    // A frame stamped with gen 1 reaching a stream now on gen 2.
    ws.simulateBinary(wireFrame({ streamId: 1, seq: 7, gen16: 1, width: 300, height: 200 }));
    await settle();

    const { canvas, container } = canvasPair();
    const renderer = handle.attach(canvas, container);
    await settle();
    expect(renderer.stats.framesPainted).toBe(0);
    expect(renderer.stats.droppedStaleGen).toBe(1);
  });
});
