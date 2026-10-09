import { describe, expect, it } from 'vitest';
import {
  isFiniteCoordinate,
  transformCoordinate,
  transformPoint,
} from '../../src/input/coordinates.js';

/** A small, seeded PRNG so the 10^6 property run is deterministic and reproducible on failure. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('transformCoordinate: CM1', () => {
  it('holds over 10^6 random inputs: always an integer in [0, viewportDim - 1]', () => {
    const rnd = mulberry32(0xc0ffee);
    for (let i = 0; i < 1_000_000; i++) {
      const value = (rnd() - 0.5) * 20000; // include negative and out-of-range values
      const frameDim = 1 + Math.floor(rnd() * 16384);
      const viewportDim = 1 + Math.floor(rnd() * 16384);
      const result = transformCoordinate(value, frameDim, viewportDim);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(viewportDim - 1);
    }
  });

  it('the right edge is one past the last pixel: value === frameDim maps to viewportDim - 1, not viewportDim', () => {
    expect(transformCoordinate(1280, 1280, 1280)).toBe(1279);
  });

  it('rounds before clamping: 1279.6 rounds to 1280 then clamps to 1279', () => {
    expect(transformCoordinate(1279.6, 1280, 1280)).toBe(1279);
  });

  it('a negative input clamps to 0', () => {
    expect(transformCoordinate(-37, 1280, 1280)).toBe(0);
  });

  it('worked example A: uniform downscale', () => {
    // bitmap 1280x720, viewport 1280x720 (scale 1.0). Client sends {x:640, y:275}.
    expect(transformCoordinate(640, 1280, 1280)).toBe(640);
    expect(transformCoordinate(275, 720, 720)).toBe(275);
  });

  it('worked example B: reduced tier, letterboxed', () => {
    // bitmap 960x540, viewport 1280x720. Client sends {x:600, y:270, fw:960, fh:540}.
    expect(transformCoordinate(600, 960, 1280)).toBe(800);
    expect(transformCoordinate(270, 540, 720)).toBe(360);
  });
});

describe('isFiniteCoordinate', () => {
  it('rejects NaN', () => {
    expect(isFiniteCoordinate(Number.NaN)).toBe(false);
  });
  it('rejects Infinity and -Infinity', () => {
    expect(isFiniteCoordinate(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteCoordinate(Number.NEGATIVE_INFINITY)).toBe(false);
  });
  it('accepts an ordinary finite number', () => {
    expect(isFiniteCoordinate(42)).toBe(true);
  });
});

describe('transformPoint', () => {
  it('rejects NaN before any arithmetic runs (never reaches the clamp)', () => {
    expect(transformPoint(Number.NaN, 10, 100, 100, 1280, 720)).toBeNull();
  });
  it('rejects Infinity before any arithmetic runs', () => {
    expect(transformPoint(Number.POSITIVE_INFINITY, 10, 100, 100, 1280, 720)).toBeNull();
    expect(transformPoint(10, Number.NEGATIVE_INFINITY, 100, 100, 1280, 720)).toBeNull();
  });
  it('produces the worked example B result exactly: x=800, y=360', () => {
    const result = transformPoint(600, 270, 960, 540, 1280, 720);
    expect(result).toEqual({ x: 800, y: 360 });
  });
  it('rejects a non-positive frame dimension defensively', () => {
    expect(transformPoint(10, 10, 0, 100, 1280, 720)).toBeNull();
  });
});
