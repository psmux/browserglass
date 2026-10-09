import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../../src/cdp/types.js';
import { CdpScreencastSource } from '../../src/stream/cdp-screencast-source.js';

// "hi" base64-encoded, as a stand-in "frame" payload; dimension parsing
// falls back to the requested spec for bytes that are not a real JPEG/PNG,
// which is exactly the fallback path being exercised here.
const FAKE_FRAME_B64 = 'aGk=';

function fakeBridge(
  opts: {
    onFrame?: (data: string, metadata: unknown, castFrameId: number) => void;
    captureScreenshot?: () => { data: string };
  } = {},
) {
  const sentCalls: { method: string; params: unknown; sessionId: unknown }[] = [];
  let screencastHandler: ((data: string, metadata: unknown, castFrameId: number) => void) | null =
    null;
  const bridge = {
    onScreencastFrame: (
      _sessionId: CdpSessionId,
      handler: (data: string, metadata: unknown, castFrameId: number) => void,
    ): Unsubscribe => {
      screencastHandler = handler;
      return () => {
        screencastHandler = null;
      };
    },
    send: (method: string, params: unknown, sessionId: unknown) => {
      sentCalls.push({ method, params, sessionId });
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve(
          opts.captureScreenshot ? opts.captureScreenshot() : { data: FAKE_FRAME_B64 },
        );
      }
      return Promise.resolve({});
    },
  } as unknown as CdpBridge;
  return {
    bridge,
    sentCalls,
    fireFrame: (data: string, metadata: unknown = {}, castFrameId = 1) =>
      screencastHandler?.(data, metadata, castFrameId),
  };
}

describe('CdpScreencastSource', () => {
  it('start() calls Page.startScreencast with the requested spec, and format follows codec', async () => {
    const { bridge, sentCalls } = fakeBridge();
    const source = new CdpScreencastSource({ bridge, sessionId: 's1' as CdpSessionId });
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
      () => {},
    );
    const startCall = sentCalls.find((c) => c.method === 'Page.startScreencast');
    expect(startCall?.params).toMatchObject({
      format: 'jpeg',
      quality: 75,
      maxWidth: 1280,
      maxHeight: 720,
    });
  });

  it('decodes base64 exactly once at the source boundary: onFrame receives real bytes, never a base64 string', async () => {
    const { bridge, fireFrame } = fakeBridge();
    const source = new CdpScreencastSource({ bridge, sessionId: 's1' as CdpSessionId });
    let received: Uint8Array | null = null;
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 100, maxHeight: 100, everyNthFrame: 1 },
      (f) => {
        received = f.bytes;
      },
    );
    fireFrame(FAKE_FRAME_B64);
    expect(received).not.toBeNull();
    expect(received).toBeInstanceOf(Uint8Array);
    expect([...(received as unknown as Uint8Array)]).toEqual([104, 105]); // "hi"
  });

  it('is change driven: zero frames fired means zero onFrame calls (a static page is correct, not a fault)', async () => {
    const { bridge } = fakeBridge();
    const source = new CdpScreencastSource({ bridge, sessionId: 's1' as CdpSessionId });
    let calls = 0;
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 100, maxHeight: 100, everyNthFrame: 1 },
      () => {
        calls += 1;
      },
    );
    expect(calls).toBe(0);
    expect(source.lastFrameAtMs).toBe(0);
  });

  it('reads RawFrame.width/height from the bytes, never assumed from the requested spec, falling back only when unparseable', async () => {
    const { bridge, fireFrame } = fakeBridge();
    const source = new CdpScreencastSource({ bridge, sessionId: 's1' as CdpSessionId });
    let width = -1;
    let height = -1;
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 999, maxHeight: 999, everyNthFrame: 1 },
      (f) => {
        width = f.width;
        height = f.height;
      },
    );
    fireFrame(FAKE_FRAME_B64); // not a real JPEG: dimension parse fails, falls back to spec
    expect(width).toBe(999);
    expect(height).toBe(999);
  });

  it("forceFrame() passes scale:'css' to Page.captureScreenshot (mandatory, or HiDPI frames come back at device pixel size)", async () => {
    const { bridge, sentCalls } = fakeBridge();
    const source = new CdpScreencastSource({ bridge, sessionId: 's1' as CdpSessionId });
    let forced = false;
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 100, maxHeight: 100, everyNthFrame: 1 },
      (f) => {
        forced = f.forced === true;
      },
    );
    const ok = await source.forceFrame();
    expect(ok).toBe(true);
    expect(forced).toBe(true);
    const captureCall = sentCalls.find((c) => c.method === 'Page.captureScreenshot');
    expect(captureCall?.params).toMatchObject({ scale: 'css' });
  });

  it('stop() calls Page.stopScreencast and unsubscribes the frame handler', async () => {
    const { bridge, sentCalls, fireFrame } = fakeBridge();
    const source = new CdpScreencastSource({ bridge, sessionId: 's1' as CdpSessionId });
    let calls = 0;
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 100, maxHeight: 100, everyNthFrame: 1 },
      () => {
        calls += 1;
      },
    );
    await source.stop();
    expect(sentCalls.some((c) => c.method === 'Page.stopScreencast')).toBe(true);
    fireFrame(FAKE_FRAME_B64); // handler was unsubscribed; must not be delivered
    expect(calls).toBe(0);
    expect(source.healthy).toBe(false);
  });
});
