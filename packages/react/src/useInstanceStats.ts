'use client';

import type { BrowserGlassClient, Codec, QualityProfile, StreamStats } from '@browserglass/client';
import { useEffect, useRef, useState } from 'react';

/** Options for {@link useInstanceStats}. */
export interface UseInstanceStatsOptions {
  /** Sampling interval, ms. Default `1000`. */
  intervalMs?: number;
}

/** Return shape of {@link useInstanceStats}. */
export interface UseInstanceStatsResult {
  fps: number;
  rttMs: number;
  backlog: number;
  droppedFrames: number;
  bytesPerSec: number;
  avgFrameBytes: number;
  decodeMsP50: number;
  decodeMsP95: number;
  codec: Codec | null;
  quality: QualityProfile | null;
  adaptedReason: string | null;
  streams: StreamStats[];
}

const EMPTY_STREAMS: StreamStats[] = [];
const DECODE_WINDOW = 64;

/** One stream's `framesPainted` reading, timestamped, so the next tick can turn it into a rate. Exported only so `computePaintedFps` is unit-testable without a real `BrowserGlassClient`. */
export interface PaintSample {
  mono: number;
  framesPainted: number;
}

function emptyResult(): UseInstanceStatsResult {
  return {
    fps: 0,
    rttMs: 0,
    backlog: 0,
    droppedFrames: 0,
    bytesPerSec: 0,
    avgFrameBytes: 0,
    decodeMsP50: 0,
    decodeMsP95: 0,
    codec: null,
    quality: null,
    adaptedReason: null,
    streams: EMPTY_STREAMS,
  };
}

function sameStreamStats(a: StreamStats, b: StreamStats): boolean {
  return (
    a.streamId === b.streamId &&
    a.fpsSent === b.fpsSent &&
    a.fpsDropped === b.fpsDropped &&
    a.rttMs === b.rttMs &&
    a.backlog === b.backlog &&
    a.bytesPerSec === b.bytesPerSec &&
    a.quality === b.quality &&
    a.codec === b.codec &&
    a.paused === b.paused &&
    a.adaptedReason === b.adaptedReason
  );
}

function sameStreamsList(a: StreamStats[], b: StreamStats[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || !sameStreamStats(x, y)) return false;
  }
  return true;
}

/** `true` when every displayed field of `a` and `b` is identical: the gate that keeps `useInstanceStats` from re-rendering its caller on a tick where nothing visible changed. */
function sameResult(a: UseInstanceStatsResult, b: UseInstanceStatsResult): boolean {
  return (
    a.fps === b.fps &&
    a.rttMs === b.rttMs &&
    a.backlog === b.backlog &&
    a.droppedFrames === b.droppedFrames &&
    a.bytesPerSec === b.bytesPerSec &&
    a.avgFrameBytes === b.avgFrameBytes &&
    a.decodeMsP50 === b.decodeMsP50 &&
    a.decodeMsP95 === b.decodeMsP95 &&
    a.codec === b.codec &&
    a.quality === b.quality &&
    a.adaptedReason === b.adaptedReason &&
    sameStreamsList(a.streams, b.streams)
  );
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

/**
 * Turns each stream's cumulative `RendererStats.framesPainted` into a rate,
 * by diffing against the previous tick's reading for that same
 * `streamId`, and sums the per-stream rates.
 *
 * This is what actually reached the screen, which is the number
 * `DebugOverlay`'s own doc comment promises ("fps (painted, not
 * received)"). Summing `StreamStats.fpsSent` instead, as this used to,
 * reports the *server's* view of how many encoded frames it sent this
 * viewer over the last `statsIntervalMs` window (2000ms default,
 * `emitStreamStats`, `packages/server/src/session/managed-session.ts`):
 * real, but the wrong number for a widget documented as showing paint
 * rate, and it reads near zero for up to two seconds after every
 * subscribe (a fresh `Attachment` has no `statsPrev` baseline yet, so its
 * first reported `sentCount` delta is measured against a window with no
 * prior sample) even while the canvas is visibly repainting every CDP
 * screencast frame. `framesPainted` has no such warm-up: a stream with no
 * prior sample here simply contributes nothing until its second tick,
 * exactly as long as it takes this hook's own `intervalMs` to observe one
 * elapsed window, not two seconds of server-side bucketing.
 *
 * Streams no longer present are dropped from `prevSamples` so a stream id
 * Chrome eventually reuses (`streamId` is a small per-connection counter,
 * not a global unique id) never diffs against a baseline left over from an
 * unrelated earlier subscription.
 */
export function computePaintedFps(
  streams: StreamStats[],
  prevSamples: Map<number, PaintSample>,
  nowMono: number,
): number {
  let fps = 0;
  const seen = new Set<number>();
  for (const s of streams) {
    seen.add(s.streamId);
    const framesPainted = s.renderer?.framesPainted ?? 0;
    const prev = prevSamples.get(s.streamId);
    prevSamples.set(s.streamId, { mono: nowMono, framesPainted });
    if (!prev) continue; // no prior reading for this stream yet: no elapsed window to rate against.
    const elapsedSec = (nowMono - prev.mono) / 1000;
    if (elapsedSec <= 0) continue;
    fps += Math.max(0, framesPainted - prev.framesPainted) / elapsedSec;
  }
  for (const id of prevSamples.keys()) {
    if (!seen.has(id)) prevSamples.delete(id);
  }
  return fps;
}

/**
 * Reads every live stream's current `stats()` (already a plain snapshot,
 * no event subscription needed) and folds `decodeMs` samples into a
 * rolling window so `decodeMsP50`/`decodeMsP95` (not tracked as
 * percentiles anywhere server- or client-side) can be derived locally.
 */
function computeSnapshot(
  client: BrowserGlassClient,
  decodeSamples: number[],
  paintSamples: Map<number, PaintSample>,
  nowMono: number,
): UseInstanceStatsResult {
  const streams = client.streams.map((h) => h.stats());
  if (streams.length === 0) return emptyResult();

  let dropped = 0;
  let bytesPerSec = 0;
  let rttMs = 0;
  let backlog = 0;
  let codec: Codec | null = null;
  let quality: QualityProfile | null = null;
  let adaptedReason: string | null = null;
  let maxDecodeMs = 0;

  for (const s of streams) {
    dropped += s.fpsDropped;
    bytesPerSec += s.bytesPerSec;
    if (s.rttMs > rttMs) rttMs = s.rttMs;
    backlog += s.backlog;
    if (codec === null) codec = s.codec;
    if (quality === null) quality = s.quality;
    if (adaptedReason === null && s.adaptedReason) adaptedReason = s.adaptedReason;
    const last = s.renderer?.lastDecodeMs ?? 0;
    if (last > maxDecodeMs) maxDecodeMs = last;
  }

  const fps = computePaintedFps(streams, paintSamples, nowMono);

  decodeSamples.push(maxDecodeMs);
  if (decodeSamples.length > DECODE_WINDOW) decodeSamples.shift();

  return {
    fps,
    rttMs,
    backlog,
    droppedFrames: dropped,
    bytesPerSec,
    avgFrameBytes: fps > 0 ? bytesPerSec / fps : 0,
    decodeMsP50: percentile(decodeSamples, 50),
    decodeMsP95: percentile(decodeSamples, 95),
    codec,
    quality,
    adaptedReason,
    streams,
  };
}

/**
 * Debug overlay / health widget numbers. Samples on a timer into a ref and
 * calls `setState` only when a displayed value actually changed: must
 * not re-render the caller at 30 to 60Hz because a frame counter
 * incremented anywhere underneath. An earlier design had exactly this bug
 * (it froze a chat input while typing); the fix here is structural rather than a debounce: the hook
 * never subscribes to per-frame events at all, it polls
 * `client.streams[].stats()` (already a synchronous snapshot) once per
 * `intervalMs` and only commits state when the computed snapshot differs
 * field-by-field from the last one committed.
 */
export function useInstanceStats(
  client: BrowserGlassClient | null,
  opts?: UseInstanceStatsOptions,
): UseInstanceStatsResult {
  const intervalMs = opts?.intervalMs ?? 1000;
  const [result, setResult] = useState<UseInstanceStatsResult>(emptyResult);
  const resultRef = useRef(result);
  resultRef.current = result;
  const decodeSamplesRef = useRef<number[]>([]);
  const paintSamplesRef = useRef<Map<number, PaintSample>>(new Map());

  useEffect(() => {
    decodeSamplesRef.current = [];
    paintSamplesRef.current = new Map();
    if (!client) {
      const empty = emptyResult();
      setResult(empty);
      resultRef.current = empty;
      return;
    }

    const tick = (): void => {
      const next = computeSnapshot(
        client,
        decodeSamplesRef.current,
        paintSamplesRef.current,
        performance.now(),
      );
      if (!sameResult(resultRef.current, next)) {
        resultRef.current = next;
        setResult(next);
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [client, intervalMs]);

  return result;
}
