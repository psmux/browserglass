import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LADDER_LEVEL,
  QUALITY_LADDER,
  QUALITY_PROFILE_MAP,
  clampLadderLevel,
  clampToProfile,
  resolveLadderSpec,
  roundToBucket,
  roundToEven,
  usefulResolution,
} from '../../src/stream/quality-ladder.js';

describe('QUALITY_LADDER', () => {
  it('has exactly 8 levels, L0 through L7, verbatim from the source table', () => {
    expect(QUALITY_LADDER).toHaveLength(8);
    expect(QUALITY_LADDER.map((e) => [e.level, e.quality, e.scale, e.emitEveryNth])).toEqual([
      [0, 90, 1.0, 1],
      [1, 82, 1.0, 1],
      [2, 75, 1.0, 1],
      [3, 68, 0.85, 1],
      [4, 60, 0.75, 2],
      [5, 52, 0.6, 2],
      [6, 45, 0.5, 3],
      [7, 38, 0.4, 4],
    ]);
  });

  it('L2 is the default starting level', () => {
    expect(DEFAULT_LADDER_LEVEL).toBe(2);
  });
});

describe('clampLadderLevel', () => {
  it('clamps below 0 and above 7', () => {
    expect(clampLadderLevel(-3)).toBe(0);
    expect(clampLadderLevel(11)).toBe(7);
    expect(clampLadderLevel(4)).toBe(4);
  });
});

describe('roundToEven', () => {
  it('rounds odd widths up to the next even number, never down to zero', () => {
    expect(roundToEven(801)).toBe(802);
    expect(roundToEven(800)).toBe(800);
    expect(roundToEven(0.4)).toBe(2);
  });
});

describe('QUALITY_PROFILE_MAP', () => {
  it('maps every wire QualityProfile to the documented seed and clamp', () => {
    expect(QUALITY_PROFILE_MAP.auto).toEqual({ seed: 2, ceiling: 0, floor: 7 });
    expect(QUALITY_PROFILE_MAP.high).toEqual({ seed: 0, ceiling: 0, floor: 2 });
    expect(QUALITY_PROFILE_MAP.medium).toEqual({ seed: 2, ceiling: 2, floor: 5 });
    expect(QUALITY_PROFILE_MAP.low).toEqual({ seed: 5, ceiling: 5, floor: 7 });
  });

  it('clampToProfile keeps a level inside [ceiling, floor]', () => {
    const mapping = QUALITY_PROFILE_MAP.high; // ceiling 0, floor 2
    expect(clampToProfile(0, mapping)).toBe(0);
    expect(clampToProfile(5, mapping)).toBe(2);
    // ceiling can never be violated even by a request for "better than allowed"
    expect(clampToProfile(0, mapping)).toBeGreaterThanOrEqual(mapping.ceiling);
  });
});

describe('resolveLadderSpec', () => {
  it('scales the owner viewport and rounds to even numbers', () => {
    const spec = resolveLadderSpec(4, { width: 1281, height: 721 }); // scale 0.75
    expect(spec.quality).toBe(60);
    expect(spec.emitEveryNth).toBe(2);
    expect(spec.maxWidth % 2).toBe(0);
    expect(spec.maxHeight % 2).toBe(0);
  });
});

describe('usefulResolution / roundToBucket', () => {
  it('caps the DPR multiplier at 2', () => {
    const { usefulW } = usefulResolution(1000, 800, 3);
    expect(usefulW).toBe(2000); // min(dpr,2) = 2, not 3
  });

  it('snaps up to the nearest bucket', () => {
    expect(roundToBucket(700)).toBe(960);
    expect(roundToBucket(1920)).toBe(1920);
    expect(roundToBucket(3000)).toBe(2560);
  });
});
