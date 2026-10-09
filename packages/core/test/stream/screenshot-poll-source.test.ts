import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import {
  POLL_INTERVAL_STANDALONE_MS,
  POLL_INTERVAL_SUPPLEMENT_MS,
  ScreenshotPollSource,
  shouldRunSupplement,
} from '../../src/stream/screenshot-poll-source.js';

describe('shouldRunSupplement (gating expression)', () => {
  it('stops once the screencast resumes producing frames (frameSilence < 2000)', () => {
    expect(
      shouldRunSupplement({
        nowMs: 10000,
        lastInputAtMs: 9000,
        aiActiveUntilMs: 0,
        lastFrameAtMs: 9500,
        loading: false,
      }),
    ).toBe(false);
  });

  it('stops once input has gone stale (over 10s) with no AI activity and no navigation', () => {
    expect(
      shouldRunSupplement({
        nowMs: 20000,
        lastInputAtMs: 0,
        aiActiveUntilMs: 0,
        lastFrameAtMs: 0,
        loading: false,
      }),
    ).toBe(false);
  });

  it('keeps running while input is recent, even with frame silence', () => {
    expect(
      shouldRunSupplement({
        nowMs: 10000,
        lastInputAtMs: 9000,
        aiActiveUntilMs: 0,
        lastFrameAtMs: 0,
        loading: false,
      }),
    ).toBe(true);
  });

  it('keeps running while automation is active, regardless of input age', () => {
    expect(
      shouldRunSupplement({
        nowMs: 20000,
        lastInputAtMs: 0,
        aiActiveUntilMs: 25000,
        lastFrameAtMs: 0,
        loading: false,
      }),
    ).toBe(true);
  });

  it('keeps running while a navigation is in flight, regardless of input age', () => {
    expect(
      shouldRunSupplement({
        nowMs: 20000,
        lastInputAtMs: 0,
        aiActiveUntilMs: 0,
        lastFrameAtMs: 0,
        loading: true,
      }),
    ).toBe(true);
  });
});

describe('ScreenshotPollSource interval selection', () => {
  it("uses the 1500ms supplement interval for reason 'renderer-busy'", () => {
    const source = new ScreenshotPollSource({
      bridge: {} as CdpBridge,
      sessionId: 's1' as CdpSessionId,
      targetId: 'tgt_1',
      reason: 'renderer-busy',
    });
    expect(source.intervalMs).toBe(POLL_INTERVAL_SUPPLEMENT_MS);
  });

  it("uses the 50ms standalone interval for 'cdp-unavailable' and 'screencast-refused'", () => {
    const a = new ScreenshotPollSource({
      bridge: {} as CdpBridge,
      sessionId: 's1' as CdpSessionId,
      targetId: 'tgt_1',
      reason: 'cdp-unavailable',
    });
    const b = new ScreenshotPollSource({
      bridge: {} as CdpBridge,
      sessionId: 's1' as CdpSessionId,
      targetId: 'tgt_1',
      reason: 'screencast-refused',
    });
    expect(a.intervalMs).toBe(POLL_INTERVAL_STANDALONE_MS);
    expect(b.intervalMs).toBe(POLL_INTERVAL_STANDALONE_MS);
  });
});

describe('ScreenshotPollSource one-in-flight guard', () => {
  it("the poll loop's tick() never starts a second capture while one is still outstanding", async () => {
    let sendCount = 0;
    let resolveCapture: ((v: { data: string }) => void) | null = null;

    const bridge = {
      send: (method: string) => {
        if (method !== 'Page.captureScreenshot') {
          return Promise.resolve({});
        }
        sendCount += 1;
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      },
    } as unknown as CdpBridge;

    const source = new ScreenshotPollSource({
      bridge,
      sessionId: 's1' as CdpSessionId,
      targetId: 'tgt_1',
      reason: 'cdp-unavailable',
    });
    await source.start(
      { codec: 'jpeg', quality: 75, maxWidth: 100, maxHeight: 100, everyNthFrame: 1 },
      () => {},
    );

    // `start()` schedules the first tick on a real timer; drive the private
    // tick loop directly instead of waiting on it, so this test is
    // deterministic and does not depend on real time.
    const tick = (source as unknown as { tick: () => Promise<void> }).tick.bind(source);

    const firstTick = tick(); // begins a capture, leaves it unresolved
    await Promise.resolve(); // let captureOnce's send() call happen
    expect(sendCount).toBe(1);

    const secondTick = tick(); // must see inFlight and skip entirely
    await secondTick;
    expect(sendCount).toBe(1); // still just the one outstanding capture

    resolveCapture?.({ data: 'aGVsbG8=' });
    await firstTick;
    expect(sendCount).toBe(1);

    await source.stop();
  });
});
