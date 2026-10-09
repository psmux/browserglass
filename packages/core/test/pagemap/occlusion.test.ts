/**
 * `pagemap/occlusion.ts`. Pure geometry over fixture `PageMapNodeRecord`s,
 * no CDP and no browser, matching `test/pagemap/rect-union.test.ts`'s own
 * approach one layer up: this file builds capture fixtures and checks the
 * paint-order walk that drives `RectUnion`, not the union itself.
 */

import { describe, expect, it } from 'vitest';
import { OCCLUSION_OPACITY_THRESHOLD, computeOcclusion } from '../../src/pagemap/occlusion.js';
import { MAX_RECTS } from '../../src/pagemap/rect-union.js';
import type {
  PageMapCapture,
  PageMapComputedStyle,
  PageMapDocumentRect,
  PageMapNodeRecord,
} from '../../src/pagemap/types.js';

function rect(x: number, y: number, width: number, height: number): PageMapDocumentRect {
  return { x, y, width, height };
}

/** A computed style carrying only the two fields this module reads, both left at CSS's own default unless overridden. */
function style(
  overrides: Partial<Pick<PageMapComputedStyle, 'opacity' | 'backgroundColor'>> = {},
): PageMapComputedStyle {
  return {
    display: null,
    visibility: null,
    opacity: overrides.opacity ?? null,
    overflow: null,
    overflowX: null,
    overflowY: null,
    cursor: null,
    pointerEvents: null,
    position: null,
    backgroundColor: overrides.backgroundColor ?? null,
  };
}

/** An opaque, fully covering style: `opacity: 1`, a solid background. What a real occluding layer (a modal, a menu) looks like on the wire. */
function opaqueStyle(): PageMapComputedStyle {
  return style({ opacity: '1', backgroundColor: 'rgb(255, 255, 255)' });
}

/** A minimal, otherwise-empty {@link PageMapNodeRecord}, matching `test/pagemap/ax-merge.test.ts`'s own `baseNode` shape plus the `nodeValue` field that shape predates. */
function baseNode(
  backendNodeId: number,
  overrides: Partial<PageMapNodeRecord> = {},
): PageMapNodeRecord {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    tag: 'div',
    nodeType: 1,
    nodeValue: null,
    attributes: new Map(),
    shadowKind: null,
    frameId: null,
    rect: null,
    scrollRect: null,
    paintOrder: null,
    style: null,
    role: null,
    name: null,
    axIgnored: false,
    axProperties: new Map(),
    hasClickListener: null,
    ...overrides,
  };
}

/** A capture with a 0,0 to 1000,1000 viewport unless overridden, over whatever nodes are given. */
function capture(
  nodes: readonly PageMapNodeRecord[],
  overrides: Partial<PageMapCapture> = {},
): PageMapCapture {
  const map = new Map(nodes.map((n) => [n.backendNodeId, n]));
  return {
    epoch: 'epoch-1',
    nodes: map,
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1000,
    viewportHeight: 1000,
    failures: [],
    ...overrides,
  };
}

describe('computeOcclusion: basic coverage', () => {
  it('a candidate fully covered by one opaque node painted above it is occluded', () => {
    const candidate = baseNode(1, { rect: rect(10, 10, 20, 20), paintOrder: 1 });
    const overlay = baseNode(2, {
      rect: rect(0, 0, 100, 100),
      paintOrder: 2,
      style: opaqueStyle(),
    });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(true);
  });

  it('a candidate covered by the union of several opaque nodes is occluded', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    // four strips, each higher paint order, together covering the full 100x100 region
    const top = baseNode(2, { rect: rect(0, 0, 100, 25), paintOrder: 2, style: opaqueStyle() });
    const midLeft = baseNode(3, { rect: rect(0, 25, 50, 50), paintOrder: 2, style: opaqueStyle() });
    const midRight = baseNode(4, {
      rect: rect(50, 25, 50, 50),
      paintOrder: 2,
      style: opaqueStyle(),
    });
    const bottom = baseNode(5, { rect: rect(0, 75, 100, 25), paintOrder: 2, style: opaqueStyle() });
    const cap = capture([candidate, top, midLeft, midRight, bottom]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(true);
  });

  it('a candidate only partly covered is not occluded', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    const overlay = baseNode(2, {
      rect: rect(50, 50, 100, 100),
      paintOrder: 2,
      style: opaqueStyle(),
    });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(false);
  });

  it('a candidate with nothing painted above it is not occluded', () => {
    const candidate = baseNode(1, { rect: rect(10, 10, 20, 20), paintOrder: 5 });
    const cap = capture([candidate]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(false);
  });
});

describe('computeOcclusion: what does not contribute to the covering union', () => {
  it('a fully transparent background does not occlude, even at full opacity and full geometric coverage', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    const overlay = baseNode(2, {
      rect: rect(0, 0, 100, 100),
      paintOrder: 2,
      style: style({ opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)' }),
    });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(false);
  });

  it('an opaque background below the opacity threshold does not occlude', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    const overlay = baseNode(2, {
      rect: rect(0, 0, 100, 100),
      paintOrder: 2,
      style: style({
        opacity: String(OCCLUSION_OPACITY_THRESHOLD - 0.1),
        backgroundColor: 'rgb(0, 0, 0)',
      }),
    });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(false);
  });

  it('an opacity right at the threshold does occlude (the excluded side is strictly below)', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    const overlay = baseNode(2, {
      rect: rect(0, 0, 100, 100),
      paintOrder: 2,
      style: style({
        opacity: String(OCCLUSION_OPACITY_THRESHOLD),
        backgroundColor: 'rgb(0, 0, 0)',
      }),
    });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(true);
  });

  it('a missing style (no computed style read at all) does not occlude: background-color initial value is transparent', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    const overlay = baseNode(2, { rect: rect(0, 0, 100, 100), paintOrder: 2, style: null });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(false);
  });
});

describe('computeOcclusion: null answers, not false, when there is no answer', () => {
  it('a candidate with no rect is null', () => {
    const candidate = baseNode(1, { rect: null, paintOrder: 1 });
    const cap = capture([candidate]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBeNull();
  });

  it('a candidate entirely outside the viewport is null, not false', () => {
    const candidate = baseNode(1, { rect: rect(5000, 5000, 10, 10), paintOrder: 1 });
    const cap = capture([candidate], { viewportWidth: 1000, viewportHeight: 1000 });
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBeNull();
  });

  it('a candidate only partly outside the viewport is tested against its visible portion', () => {
    // candidate straddles the right edge of the viewport (x: 950-1050 against a 1000-wide viewport);
    // an overlay exactly covering the visible 950-1000 sliver occludes it even though it does not
    // cover the part that never reaches the viewport at all.
    const candidate = baseNode(1, { rect: rect(950, 0, 100, 10), paintOrder: 1 });
    const overlay = baseNode(2, {
      rect: rect(950, 0, 50, 10),
      paintOrder: 2,
      style: opaqueStyle(),
    });
    const cap = capture([candidate, overlay], { viewportWidth: 1000, viewportHeight: 1000 });
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(true);
  });

  it('a candidate not requested is absent from every case above, never forced to a value', () => {
    const candidate = baseNode(1, { rect: rect(0, 0, 10, 10), paintOrder: 1 });
    const other = baseNode(2, { rect: rect(0, 0, 10, 10), paintOrder: 1 });
    const cap = capture([candidate, other]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.has(2)).toBe(false);
  });

  it('the union saturating at MAX_RECTS forces a null answer, even for a candidate that is not actually covered', () => {
    const cells: PageMapNodeRecord[] = [];
    for (let i = 0; i < MAX_RECTS; i += 1) {
      cells.push(
        baseNode(1000 + i, {
          rect: rect(i, 0, 1, 1),
          paintOrder: 10, // higher than the candidate: painted above it, visited first in the descending walk
          style: opaqueStyle(),
        }),
      );
    }
    // Well clear of every cell above (cells occupy x in [0, MAX_RECTS)); genuinely uncovered.
    const candidate = baseNode(1, { rect: rect(MAX_RECTS + 100, 0, 1, 1), paintOrder: 1 });
    const cap = capture([candidate, ...cells], {
      viewportWidth: MAX_RECTS + 200,
      viewportHeight: 10,
    });
    const result = computeOcclusion(cap, new Set([1]));
    // Not `false`: the union hit its cap before this candidate was tested, so the honest answer
    // is "we could not tell", not "we proved it is visible".
    expect(result.get(1)).toBeNull();
  });
});

describe('computeOcclusion: paint order edge cases', () => {
  it('a candidate with no paintOrder is still tested, against every node whose paint order IS known', () => {
    // The candidate has no paint order at all, so it is placed as if painted first (furthest back):
    // by the time it is tested, everything with a known paint order is already in the union.
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: null });
    const overlay = baseNode(2, {
      rect: rect(0, 0, 100, 100),
      paintOrder: 1,
      style: opaqueStyle(),
    });
    const cap = capture([candidate, overlay]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(true);
  });

  it('an order-less node never occludes a node with a known paint order: it is placed as painted first, so it has not been added to the union yet when a known-order candidate is tested', () => {
    const orderless = baseNode(2, {
      rect: rect(0, 0, 100, 100),
      paintOrder: null,
      style: opaqueStyle(),
    });
    const candidate = baseNode(1, { rect: rect(0, 0, 100, 100), paintOrder: 1 });
    const cap = capture([candidate, orderless]);
    const result = computeOcclusion(cap, new Set([1]));
    expect(result.get(1)).toBe(false);
  });
});
