/**
 * `QUALITY_LADDER`: the 8-level (`L0` to `L7`) codec quality, scale, and
 * frame-skip table live streams adapt across, plus the wire
 * `QualityProfile` to ladder seed-and-clamp mapping.
 * The ladder itself never appears on the wire: only a level index (an
 * internal, per-`Attachment` number) drives encode parameters.
 */

import type { QualityProfile } from '@browserglass/protocol';

/** A quality ladder level, `0` (best) through `7` (worst). */
export type LadderLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One row of {@link QUALITY_LADDER}. */
export interface LadderEntry {
  level: LadderLevel;
  /** JPEG quality, 1 to 100. */
  quality: number;
  /** Multiplies the viewport owner's emulated viewport to produce `maxWidth`/`maxHeight`. */
  scale: number;
  emitEveryNth: number;
}

/**
 * The 8 discrete quality levels. Exported for tests. Never sent on the
 * wire.
 */
export const QUALITY_LADDER: readonly LadderEntry[] = Object.freeze([
  Object.freeze({ level: 0, quality: 90, scale: 1.0, emitEveryNth: 1 }),
  Object.freeze({ level: 1, quality: 82, scale: 1.0, emitEveryNth: 1 }),
  Object.freeze({ level: 2, quality: 75, scale: 1.0, emitEveryNth: 1 }),
  Object.freeze({ level: 3, quality: 68, scale: 0.85, emitEveryNth: 1 }),
  Object.freeze({ level: 4, quality: 60, scale: 0.75, emitEveryNth: 2 }),
  Object.freeze({ level: 5, quality: 52, scale: 0.6, emitEveryNth: 2 }),
  Object.freeze({ level: 6, quality: 45, scale: 0.5, emitEveryNth: 3 }),
  Object.freeze({ level: 7, quality: 38, scale: 0.4, emitEveryNth: 4 }),
]) as readonly LadderEntry[];

/** `L2`, the default starting level for an interactive live stream. */
export const DEFAULT_LADDER_LEVEL: LadderLevel = 2;

/** Looks up one {@link LadderEntry} by level, throwing on an out-of-range value. */
export function ladderEntry(level: LadderLevel): LadderEntry {
  const entry = QUALITY_LADDER[level];
  if (!entry) {
    throw new RangeError(`invalid ladder level ${level}`);
  }
  return entry;
}

/** Clamps a raw number to the `[0, 7]` ladder range, rounding to the nearest integer level. */
export function clampLadderLevel(level: number): LadderLevel {
  const rounded = Math.round(level);
  return Math.min(7, Math.max(0, rounded)) as LadderLevel;
}

/**
 * Rounds a dimension to the nearest even number, never zero. Odd-width JPEG
 * chroma subsampling produces edge artifacts.
 */
export function roundToEven(px: number): number {
  const rounded = Math.round(px);
  const even = rounded % 2 === 0 ? rounded : rounded + 1;
  return Math.max(2, even);
}

/**
 * The wire `QualityProfile` to ladder seed-and-clamp mapping.
 * `QualityProfile` is not a stream identity
 * key; it seeds and clamps one `Attachment`'s ladder level.
 */
export interface QualityProfileMapping {
  seed: LadderLevel;
  /** Best (lowest number) level this profile permits. */
  ceiling: LadderLevel;
  /** Worst (highest number) level this profile permits. */
  floor: LadderLevel;
}

/** The four wire `QualityProfile` values mapped to a ladder seed and clamp. */
export const QUALITY_PROFILE_MAP: Readonly<Record<QualityProfile, QualityProfileMapping>> =
  Object.freeze({
    auto: Object.freeze({ seed: 2, ceiling: 0, floor: 7 }),
    high: Object.freeze({ seed: 0, ceiling: 0, floor: 2 }),
    medium: Object.freeze({ seed: 2, ceiling: 2, floor: 5 }),
    low: Object.freeze({ seed: 5, ceiling: 5, floor: 7 }),
  });

/** Clamps `level` into `[ceiling, floor]` (lower number is better quality). */
export function clampToProfile(level: LadderLevel, mapping: QualityProfileMapping): LadderLevel {
  if (level < mapping.ceiling) {
    return mapping.ceiling;
  }
  if (level > mapping.floor) {
    return mapping.floor;
  }
  return level;
}

/**
 * Resolves one ladder level plus an owner viewport into the concrete
 * `{quality, maxWidth, maxHeight, emitEveryNth}` an encoder needs,
 * rounding both dimensions to even numbers.
 */
export function resolveLadderSpec(
  level: LadderLevel,
  ownerViewport: { width: number; height: number },
): { quality: number; maxWidth: number; maxHeight: number; emitEveryNth: number } {
  const entry = ladderEntry(level);
  return {
    quality: entry.quality,
    maxWidth: roundToEven(ownerViewport.width * entry.scale),
    maxHeight: roundToEven(ownerViewport.height * entry.scale),
    emitEveryNth: entry.emitEveryNth,
  };
}

/**
 * The client-reported-viewport resolution cap:
 * `ceil(viewportCssW * min(dpr, 2))`, `min(dpr, 2)` caps the retina
 * multiplier since a 3x DPR profile costs 2.25x the bandwidth of a 2x one
 * for no visible gain.
 */
export function usefulResolution(
  viewportCssW: number,
  viewportCssH: number,
  dpr: number,
): { usefulW: number; usefulH: number } {
  const cappedDpr = Math.min(dpr, 2);
  return {
    usefulW: Math.ceil(viewportCssW * cappedDpr),
    usefulH: Math.ceil(viewportCssH * cappedDpr),
  };
}

/** The bucket widths `roundToBucket` snaps to. */
const RESOLUTION_BUCKETS: readonly number[] = [640, 960, 1280, 1600, 1920, 2560];

/** Snaps `width` up to the nearest {@link RESOLUTION_BUCKETS} entry, or the largest one if `width` exceeds it. */
export function roundToBucket(width: number): number {
  for (const bucket of RESOLUTION_BUCKETS) {
    if (width <= bucket) {
      return bucket;
    }
  }
  return RESOLUTION_BUCKETS[RESOLUTION_BUCKETS.length - 1] as number;
}
