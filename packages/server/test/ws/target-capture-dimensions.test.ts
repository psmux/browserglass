import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `target.capture`'s reply used to hardcode `width: 0, height: 0, dpr: 1`
 * regardless of what was actually captured (`packages/server/src/ws/connection.ts`,
 * found while building the CLI). `ManagedSession.capture()`
 * now reads the real dimensions back out of the encoded bytes with
 * `readFrameDimensions` (`packages/core/src/stream/frame-dimensions.ts`,
 * the same decoder the screencast and poll frame sources already use for
 * the identical problem) and derives `dpr` by comparing the captured
 * device-pixel size against the CSS viewport `Page.getLayoutMetrics`
 * reports, since no CDP field carries the device scale factor directly and
 * `Runtime.evaluate` is off limits (`packages/server/src/rest/cdp-passthrough-allowlist.ts`
 * refuses the whole `Runtime` domain).
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

function hello(): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg', 'png'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
  };
}

/**
 * Connects and returns the target id the registry actually assigned. That
 * is NOT the fake Chrome `cdpTargetId` (`'cdp-a'`) passed to `addTarget`:
 * `TargetRegistry.start()` mints its own `targetId` per discovered target,
 * so a caller of `target.capture` (or anything else keyed by target id)
 * has to read it back off `welcome.targets`, exactly as `hello.ts`'s reply
 * reports it, rather than assuming the fake's raw id round-trips.
 */
async function connectViewer(gw: TestGateway): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

/** A minimal, valid PNG carrying only a correct IHDR chunk; `readFrameDimensions` never looks past it. Mirrors `packages/core/test/stream/frame-dimensions.test.ts`'s `buildMinimalPng`. */
function buildMinimalPng(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  dv.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return Buffer.from(bytes).toString('base64');
}

describe('target.capture dimensions', () => {
  it('reports the real width and height read from the captured bytes, not 0', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setCaptureScreenshot(buildMinimalPng(200, 100));
    try {
      const { ws, targetId } = await connectViewer(gw);
      ws.send(
        JSON.stringify({ v: 1, t: 'target.capture', ts: Date.now(), targetId, format: 'png' }),
      );
      const captured = await nextMessageSkipping(ws, UNSOLICITED);
      expect(captured['t']).toBe('target.captured');
      expect(captured['width']).toBe(200);
      expect(captured['height']).toBe(100);
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('derives dpr from the captured pixel size against the CSS viewport', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    // A 2x-scaled capture: 200x100 device pixels over a 100x50 CSS viewport.
    gw.chrome.setCaptureScreenshot(buildMinimalPng(200, 100));
    gw.chrome.setLayoutViewport(100, 50);
    try {
      const { ws, targetId } = await connectViewer(gw);
      ws.send(
        JSON.stringify({ v: 1, t: 'target.capture', ts: Date.now(), targetId, format: 'png' }),
      );
      const captured = await nextMessageSkipping(ws, UNSOLICITED);
      expect(captured['dpr']).toBe(2);
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('falls back to dpr 1 when the CSS viewport cannot be read', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setCaptureScreenshot(buildMinimalPng(200, 100));
    // No setLayoutViewport call: `Page.getLayoutMetrics` falls through to
    // the fake server's catch-all `reply({})`, matching a real target whose
    // metrics were never resolvable.
    try {
      const { ws, targetId } = await connectViewer(gw);
      ws.send(
        JSON.stringify({ v: 1, t: 'target.capture', ts: Date.now(), targetId, format: 'png' }),
      );
      const captured = await nextMessageSkipping(ws, UNSOLICITED);
      expect(captured['dpr']).toBe(1);
      ws.close();
    } finally {
      await gw.close();
    }
  });
});
