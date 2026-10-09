/**
 * `pagemap/rect-union.ts`. Pure geometry, so every case here is exact
 * arithmetic with no fake bridge and no CDP involved.
 */

import { describe, expect, it } from 'vitest';
import { MAX_RECTS, type Rect, RectUnion } from '../../src/pagemap/rect-union.js';

/** A small, seeded PRNG so the property runs are deterministic and reproducible on failure, matching `test/input/coordinates.test.ts`. */
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

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

describe('RectUnion: basic coverage', () => {
  it('an empty union contains nothing', () => {
    const u = new RectUnion();
    expect(u.contains(rect(0, 0, 10, 10))).toBe(false);
  });

  it('full coverage: a rect exactly equal to an added one is contained', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 100, 100));
    expect(u.contains(rect(0, 0, 100, 100))).toBe(true);
  });

  it('containment: a smaller rect fully inside a larger added one is contained', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 100, 100));
    expect(u.contains(rect(10, 10, 20, 20))).toBe(true);
  });

  it('partial coverage: a rect only half inside an added one is not contained', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 100, 100));
    expect(u.contains(rect(50, 50, 100, 100))).toBe(false);
  });

  it('no overlap at all is not contained', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 10, 10));
    expect(u.contains(rect(100, 100, 10, 10))).toBe(false);
  });

  it('exact edge alignment: two adjacent rects together cover a candidate spanning both', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 50, 100));
    u.add(rect(50, 0, 50, 100));
    expect(u.contains(rect(0, 0, 100, 100))).toBe(true);
  });

  it('touching but not overlapping: a single added rect does not cover its neighbour', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 50, 100)); // right edge at x=50
    // candidate starts exactly where the added rect ends: shares an edge, no area overlap
    expect(u.contains(rect(50, 0, 50, 100))).toBe(false);
  });

  it('four-way fragmentation: a candidate straddling the middle of one added rect is left with the four surrounding strips uncovered', () => {
    const u = new RectUnion();
    u.add(rect(10, 10, 10, 10)); // a 10x10 hole in the middle of a 30x30 region, offset by (0,0)
    // the candidate is the full 30x30 region; the added rect covers only its centre
    expect(u.contains(rect(0, 0, 30, 30))).toBe(false);
  });

  it('a ring of rects around a hole covers everything except the hole', () => {
    const u = new RectUnion();
    // 30x30 region with a 10x10 hole in the centre, covered by four strips
    u.add(rect(0, 0, 30, 10)); // top strip
    u.add(rect(0, 20, 30, 10)); // bottom strip
    u.add(rect(0, 10, 10, 10)); // left strip
    u.add(rect(20, 10, 10, 10)); // right strip
    expect(u.contains(rect(0, 0, 30, 30))).toBe(false); // the centre hole is not covered
    expect(u.contains(rect(0, 0, 30, 10))).toBe(true); // but the top strip alone is
    u.add(rect(10, 10, 10, 10)); // fill the hole
    expect(u.contains(rect(0, 0, 30, 30))).toBe(true); // now the whole region is covered
  });

  it('add returns whether the union grew', () => {
    const u = new RectUnion();
    expect(u.add(rect(0, 0, 10, 10))).toBe(true);
    expect(u.add(rect(0, 0, 10, 10))).toBe(false); // already fully covered by the first add
    expect(u.add(rect(2, 2, 3, 3))).toBe(false); // fully inside the first add
  });

  it('size reports the number of disjoint rectangles held, which can exceed the number of adds after fragmentation', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 30, 30));
    expect(u.size).toBe(1);
    u.add(rect(10, 10, 10, 10)); // fully inside: rejected before fragmenting anything
    expect(u.size).toBe(1);
    const u2 = new RectUnion();
    u2.add(rect(10, 10, 10, 10)); // the hole, added first
    u2.add(rect(0, 0, 30, 30)); // then the surrounding region: fragments into up to 4 strips
    expect(u2.size).toBeGreaterThan(1);
  });
});

describe('RectUnion: the MAX_RECTS cap', () => {
  it('MAX_RECTS is 5000, matching the measured cap this design keeps from browser-use', () => {
    expect(MAX_RECTS).toBe(5000);
  });

  it('add stops growing the union past the cap, and contains under-filters (reads false) for anything not already proven covered', () => {
    const u = new RectUnion();
    // fill the union with MAX_RECTS disjoint 1x1 rects along a single row
    for (let i = 0; i < MAX_RECTS; i++) {
      expect(u.add(rect(i, 0, 1, 1))).toBe(true);
    }
    expect(u.size).toBe(MAX_RECTS);

    // the union is now full: a genuinely new rect is refused even though it does not overlap anything
    expect(u.add(rect(MAX_RECTS, 0, 1, 1))).toBe(false);
    expect(u.size).toBe(MAX_RECTS);

    // the safe direction: a candidate over the un-added area reads "not covered", never silently "covered"
    expect(u.contains(rect(MAX_RECTS, 0, 1, 1))).toBe(false);

    // area that WAS covered before the cap was reached is still reported as covered
    expect(u.contains(rect(0, 0, 1, 1))).toBe(true);
  });
});

describe('RectUnion: degenerate input', () => {
  const degenerate: ReadonlyArray<[string, Rect]> = [
    ['NaN x', rect(Number.NaN, 0, 10, 10)],
    ['NaN y', rect(0, Number.NaN, 10, 10)],
    ['NaN width', rect(0, 0, Number.NaN, 10)],
    ['NaN height', rect(0, 0, 10, Number.NaN)],
    ['+Infinity width', rect(0, 0, Number.POSITIVE_INFINITY, 10)],
    ['-Infinity y', rect(0, Number.NEGATIVE_INFINITY, 10, 10)],
    ['zero width', rect(0, 0, 0, 10)],
    ['zero height', rect(0, 0, 10, 0)],
    ['zero area (both zero)', rect(0, 0, 0, 0)],
    ['negative width', rect(0, 0, -10, 10)],
    ['negative height', rect(0, 0, 10, -10)],
  ];

  for (const [label, r] of degenerate) {
    it(`add(${label}) does not throw, does not change the union, and returns false`, () => {
      const u = new RectUnion();
      expect(() => u.add(r)).not.toThrow();
      expect(u.add(r)).toBe(false);
      expect(u.size).toBe(0);
    });

    it(`contains(${label}) does not throw and answers false (not proven covered), even against a union that would otherwise cover it`, () => {
      const u = new RectUnion();
      u.add(rect(-1000, -1000, 5000, 5000)); // a huge covering rect
      expect(() => u.contains(r)).not.toThrow();
      expect(u.contains(r)).toBe(false);
    });
  }

  it('a degenerate rect passed to add never corrupts a union that already holds valid rects', () => {
    const u = new RectUnion();
    u.add(rect(0, 0, 10, 10));
    for (const [, r] of degenerate) {
      u.add(r);
    }
    expect(u.size).toBe(1);
    expect(u.contains(rect(0, 0, 10, 10))).toBe(true);
  });
});

describe('RectUnion: property tests', () => {
  it('a grid of unit cells added in random order always ends up covering the full grid, regardless of order or fragmentation path', () => {
    const rnd = mulberry32(0x9e3779b9);
    for (let trial = 0; trial < 200; trial++) {
      const gridSize = 1 + Math.floor(rnd() * 8); // up to 8x8 cells
      const cells: Rect[] = [];
      for (let gx = 0; gx < gridSize; gx++) {
        for (let gy = 0; gy < gridSize; gy++) {
          cells.push(rect(gx, gy, 1, 1));
        }
      }
      // shuffle
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [cells[i], cells[j]] = [cells[j], cells[i]];
      }
      const u = new RectUnion();
      for (const c of cells) {
        u.add(c);
      }
      expect(u.contains(rect(0, 0, gridSize, gridSize))).toBe(true);
    }
  });

  it('any random sub-rect of a single added rect is always contained, over many random inputs', () => {
    const rnd = mulberry32(0xdeadbeef);
    for (let i = 0; i < 100_000; i++) {
      const outer = rect(rnd() * 1000 - 500, rnd() * 1000 - 500, 1 + rnd() * 500, 1 + rnd() * 500);
      const u = new RectUnion();
      u.add(outer);

      const innerX = outer.x + rnd() * outer.width;
      const innerY = outer.y + rnd() * outer.height;
      const inner = rect(
        innerX,
        innerY,
        rnd() * (outer.x + outer.width - innerX),
        rnd() * (outer.y + outer.height - innerY),
      );
      if (inner.width <= 0 || inner.height <= 0) continue; // isUsableRect would reject it; not what this property tests

      expect(u.contains(inner)).toBe(true);
    }
  });

  it('a random rect entirely outside every added rect is never contained, over many random inputs', () => {
    const rnd = mulberry32(0x1234567);
    for (let i = 0; i < 50_000; i++) {
      const u = new RectUnion();
      u.add(rect(0, 0, 100, 100));
      // candidates placed strictly to the right of the added rect: never overlap it
      const candidate = rect(
        100 + rnd() * 1000,
        rnd() * 1000 - 500,
        1 + rnd() * 50,
        1 + rnd() * 50,
      );
      expect(u.contains(candidate)).toBe(false);
    }
  });
});
