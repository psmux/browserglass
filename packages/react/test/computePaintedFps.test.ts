import type { StreamStats } from '@browserglass/client';
import { describe, expect, it } from 'vitest';
import { type PaintSample, computePaintedFps } from '../src/useInstanceStats.js';

/** A minimal, otherwise-inert `StreamStats` with just `streamId` and `renderer.framesPainted` set; every other field is a fixed placeholder `computePaintedFps` never reads. */
function stream(streamId: number, framesPainted: number | null): StreamStats {
  return {
    streamId,
    targetId: `tgt_${streamId}`,
    quality: 'auto',
    codec: 'jpeg',
    paused: false,
    fpsSent: 0,
    fpsDropped: 0,
    bytesPerSec: 0,
    backlog: 0,
    bufferedBytes: 0,
    encodeMsP50: 0,
    encodeMsP95: 0,
    rttMs: 0,
    renderer:
      framesPainted === null
        ? null
        : {
            droppedStaleGen: 0,
            droppedOutOfOrder: 0,
            droppedCoalesced: 0,
            droppedStalePostDecode: 0,
            decodeErrors: 0,
            decodeStuck: 0,
            framesPainted,
            lastDecodeMs: 0,
            lastPaintedSeq: 0,
          },
  };
}

/**
 * `computePaintedFps` is what `useInstanceStats.ts` uses to answer
 * `DebugOverlay`'s documented "fps (painted, not received)" contract: a
 * rate derived from `RendererStats.framesPainted` (frames actually drawn
 * to the canvas), not from the server's `StreamStats.fpsSent` telemetry.
 * Summing `fpsSent` instead (the previous implementation) read near zero
 * for up to two seconds after every subscribe, since a fresh server-side
 * `Attachment` has no `statsPrev` baseline to diff its first `sentCount`
 * against, even on a target that is visibly, continuously repainting.
 */
describe('computePaintedFps', () => {
  it("contributes nothing on a stream's first observed tick: there is no elapsed window yet to rate against", () => {
    const prev = new Map<number, PaintSample>();
    const fps = computePaintedFps([stream(1, 40)], prev, 1000);
    expect(fps).toBe(0);
    expect(prev.get(1)).toEqual({ mono: 1000, framesPainted: 40 });
  });

  it('reports a real painted-frame rate on the second tick, from the framesPainted delta over elapsed time', () => {
    const prev = new Map<number, PaintSample>();
    computePaintedFps([stream(1, 0)], prev, 0);
    // 82 frames painted over the next 1000ms: matches the spike's ~82fps window-isolation measurement.
    const fps = computePaintedFps([stream(1, 82)], prev, 1000);
    expect(fps).toBe(82);
  });

  it('sums per-stream rates across every currently subscribed stream', () => {
    const prev = new Map<number, PaintSample>();
    computePaintedFps([stream(1, 0), stream(2, 0)], prev, 0);
    const fps = computePaintedFps([stream(1, 30), stream(2, 50)], prev, 1000);
    expect(fps).toBe(80);
  });

  it('never goes negative on a renderer reset (framesPainted dropping below its previous reading)', () => {
    const prev = new Map<number, PaintSample>();
    computePaintedFps([stream(1, 100)], prev, 0);
    const fps = computePaintedFps([stream(1, 5)], prev, 1000);
    expect(fps).toBe(0);
  });

  it('drops a stream that is no longer subscribed, so a later reused streamId never diffs against a stale baseline', () => {
    const prev = new Map<number, PaintSample>();
    computePaintedFps([stream(1, 0)], prev, 0);
    computePaintedFps([], prev, 1000); // stream 1 unsubscribed between ticks
    expect(prev.has(1)).toBe(false);
    // A later stream reusing id 1 starts its own fresh baseline, not a diff against the old one.
    const fps = computePaintedFps([stream(1, 9999)], prev, 2000);
    expect(fps).toBe(0);
  });

  it('a stream with no renderer attached yet (not attach()-ed to a canvas) contributes zero, not NaN', () => {
    const prev = new Map<number, PaintSample>();
    computePaintedFps([stream(1, null)], prev, 0);
    const fps = computePaintedFps([stream(1, null)], prev, 1000);
    expect(fps).toBe(0);
  });
});
