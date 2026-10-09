/**
 * A disjoint set of axis-aligned rectangles in document space (rects are
 * stored in document space so a scroll costs zero round trips). Answers one question,
 * `contains(rect)`: is `rect` fully covered by everything already added.
 *
 * Pure geometry. No CDP, no imports from anywhere else in this repo, no
 * I/O. `occlusion.ts` is the caller: it walks painted nodes highest paint order first, adds each
 * opaque one here, and asks whether a lower candidate is entirely
 * underneath what has already been added.
 *
 * ALGORITHM AND COMPLEXITY: subtract and fragment, the same shape as
 * browser-use's `RectUnionPure` (`dom/serializer/paint_order.py`), kept
 * because its containment test, its cap and the cap's degradation are all
 * correct. `add(r)` walks the existing rects; for each one that overlaps
 * the candidate, the candidate is replaced by what remains outside that
 * rect, at most four pieces (a strip above, below, left and right of the
 * overlap). Whatever survives every existing rect is new, disjoint area
 * and is appended. `contains(r)` runs the identical subtraction without
 * appending, answering true only when nothing of `r` survives. Both are
 * therefore O(m) against a union of size m (each existing rect visited
 * once, each visit multiplying the pending piece count by up to 4), m
 * capped at `MAX_RECTS`: building a union from P painted rects is O(P)
 * calls each O(m); testing C candidates against the finished union is
 * O(C * m).
 *
 * OVERFLOW: past `MAX_RECTS` rectangles, `add` stops accepting new area
 * and `contains` can answer `true` only for area it proved covered before
 * the cap; anything else reads `false`. That is the safe direction:
 * `false` means "not proven hidden", never "visible", so the worst
 * outcome of hitting the cap is a covered element reported as visible,
 * never the reverse. Under-filtering is what a caller about to click
 * something can afford; over-filtering is not.
 */

/**
 * A rectangle in document space: `x`, `y` are the top-left corner,
 * `width` and `height` extend right and down. Matches the shape
 * `DOMSnapshot.captureSnapshot`'s `bounds` field reports, so a caller building this from a snapshot node need not
 * transform anything.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Internal form: two corners, which the subtraction math wants and `Rect`'s x/y/width/height form does not give directly. */
interface Corners {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * True iff every field of `r` is finite (never NaN or +/-Infinity,
 * rejected before any arithmetic runs, matching the discipline
 * `input/coordinates.ts` sets for the same class of input) and both
 * dimensions are strictly positive. A zero-width or zero-height rect
 * covers no area and is rejected outright rather than silently accepted
 * as a no-op, so a caller cannot mistake "your rect is degenerate" for
 * "your rect is fully covered".
 */
function isUsableRect(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

function toCorners(r: Rect): Corners {
  return { x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
}

/** Open-interval overlap: two rects that only touch along an edge do not intersect. */
function intersects(a: Corners, b: Corners): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function rectContains(outer: Corners, inner: Corners): boolean {
  return (
    outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2
  );
}

/** `a` minus `b`, as up to four disjoint rectangles. Assumes `a` and `b` intersect; every caller checks that first. */
function subtract(a: Corners, b: Corners): Corners[] {
  const pieces: Corners[] = [];
  if (a.y1 < b.y1) pieces.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 }); // strip above the overlap
  if (b.y2 < a.y2) pieces.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 }); // strip below the overlap
  const y1 = Math.max(a.y1, b.y1);
  const y2 = Math.min(a.y2, b.y2);
  if (a.x1 < b.x1) pieces.push({ x1: a.x1, y1, x2: b.x1, y2 }); // strip left of the overlap
  if (b.x2 < a.x2) pieces.push({ x1: b.x2, y1, x2: a.x2, y2 }); // strip right of the overlap
  return pieces;
}

/**
 * Past this many disjoint rectangles, `add` stops growing the union and
 * `contains` degrades to "not proven covered" for anything not already
 * proved. Matches browser-use's measured `RectUnionPure._MAX_RECTS`, kept
 * rather than re-derived because it is the one constant in that module
 * with a stated reason ("prevents runaway memory/CPU" on pages with many
 * overlapping translucent layers), not the "highly vibes based" kind this
 * design otherwise refuses to copy.
 */
export const MAX_RECTS = 5000;

export class RectUnion {
  private readonly rects: Corners[] = [];

  /** Number of disjoint rectangles currently held, capped at `MAX_RECTS`. */
  get size(): number {
    return this.rects.length;
  }

  /**
   * True iff `rect` is entirely covered by the rectangles already added.
   * A degenerate `rect` (see `isUsableRect`) answers `false`: not proven
   * covered, the safe direction the module doc above argues for.
   */
  contains(rect: Rect): boolean {
    if (!isUsableRect(rect)) {
      return false;
    }
    let pending: Corners[] = [toCorners(rect)];
    for (const existing of this.rects) {
      const next: Corners[] = [];
      for (const piece of pending) {
        if (rectContains(existing, piece)) {
          continue; // piece fully eaten by this one rect
        }
        if (intersects(piece, existing)) {
          next.push(...subtract(piece, existing));
        } else {
          next.push(piece);
        }
      }
      pending = next;
      if (pending.length === 0) {
        return true; // nothing of rect survived: fully covered
      }
    }
    return false;
  }

  /**
   * Adds `rect` to the union unless it is already fully covered or the
   * union already holds `MAX_RECTS` rectangles. Returns whether the union
   * grew. A degenerate `rect` is rejected the same way `contains` rejects
   * one: no throw, no state change.
   */
  add(rect: Rect): boolean {
    if (!isUsableRect(rect) || this.rects.length >= MAX_RECTS) {
      return false;
    }
    if (this.contains(rect)) {
      return false;
    }
    let pending: Corners[] = [toCorners(rect)];
    for (const existing of this.rects) {
      const next: Corners[] = [];
      for (const piece of pending) {
        if (intersects(piece, existing)) {
          next.push(...subtract(piece, existing));
        } else {
          next.push(piece);
        }
      }
      pending = next;
    }
    this.rects.push(...pending);
    return true;
  }
}
