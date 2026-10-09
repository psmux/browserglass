/**
 * The server-side half of the coordinate transform chain:
 * `frame space -> (multiply by viewport.width / fw) -> emulated viewport CSS
 * px -> (round, clamp) -> CDP`. Two multiplications (client side) plus one
 * multiplication, one round, and one clamp (this module). No DPR multiplier
 * anywhere, in either direction.
 *
 * NaN and Infinity are rejected before the transform, never clamped: a
 * clamp-only implementation lets `Math.round(NaN)` (itself `NaN`) sail
 * straight through `Math.max(0, Math.min(w - 1, NaN))`, which is also `NaN`,
 * and that value would otherwise reach `Input.dispatchMouseEvent`.
 */

/** Whether `value` is a finite, non-NaN number. Used to reject the transform's input before any arithmetic runs. */
export function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The one clamp-and-round step, applied identically to `x` and `y`. Round
 * first, then clamp
 * (an input of exactly `viewportDim` rounds to `viewportDim`, then clamps
 * down to `viewportDim - 1`, the right edge being one past the last pixel).
 *
 * **Guarantee CM1**: for any finite `value`, any `frameDim > 0`, and any
 * `viewportDim >= 1`, the result is an integer in `[0, viewportDim - 1]`.
 * Property-tested over 10^6 random inputs in `test/input/coordinates.test.ts`.
 */
export function transformCoordinate(value: number, frameDim: number, viewportDim: number): number {
  const scale = viewportDim / frameDim;
  const scaled = value * scale;
  const rounded = Math.round(scaled);
  return Math.max(0, Math.min(viewportDim - 1, rounded));
}

/** A point in CDP-ready, clamped emulated-viewport CSS pixel space. */
export interface TransformedPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Transforms one frame-space point (`x`, `y` measured against `fw`/`fh`)
 * into emulated-viewport CDP coordinates, or returns `null` when the input
 * cannot be transformed safely: a non-finite `x`/`y` (NaN or Infinity,
 * rejected before any arithmetic), or a non-positive `fw`/`fh`/viewport
 * dimension (which the validator in `validation.ts` should already have
 * excluded, checked again here as defence in depth against a div-by-zero).
 */
export function transformPoint(
  x: number,
  y: number,
  fw: number,
  fh: number,
  viewportWidth: number,
  viewportHeight: number,
): TransformedPoint | null {
  if (!isFiniteCoordinate(x) || !isFiniteCoordinate(y)) {
    return null;
  }
  if (!(fw > 0) || !(fh > 0) || !(viewportWidth >= 1) || !(viewportHeight >= 1)) {
    return null;
  }
  return {
    x: transformCoordinate(x, fw, viewportWidth),
    y: transformCoordinate(y, fh, viewportHeight),
  };
}
