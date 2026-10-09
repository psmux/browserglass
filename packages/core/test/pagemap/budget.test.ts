/**
 * `pagemap/budget.ts`.
 *
 * Pure function over a hand-built `PageMapCapture`: no CDP bridge needed.
 * Covers candidate selection (interactive AND positioned), the wire shape,
 * the priority order truncation drops from, and honest truncation
 * reporting by reason.
 */

import { describe, expect, it } from 'vitest';
import { buildPageMapBudget } from '../../src/pagemap/budget.js';
import type { PageMapCapture, PageMapNodeRecord } from '../../src/pagemap/types.js';

/** A minimal, otherwise-inert node record: not interactive, no rect, nothing set. Individual tests override just the fields they care about. */
function baseNode(
  overrides: Partial<PageMapNodeRecord> & { backendNodeId: number },
): PageMapNodeRecord {
  return {
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

/** A button: the cheapest way to make a node pass `interactivity.ts`'s cascade (native tag semantics). */
function button(
  backendNodeId: number,
  overrides: Partial<PageMapNodeRecord> = {},
): PageMapNodeRecord {
  return baseNode({ backendNodeId, tag: 'button', ...overrides });
}

function capture(
  nodes: readonly PageMapNodeRecord[],
  overrides: Partial<PageMapCapture> = {},
): PageMapCapture {
  return {
    epoch: 'epoch-1',
    nodes: new Map(nodes.map((n) => [n.backendNodeId, n])),
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
    failures: [],
    ...overrides,
  };
}

describe('buildPageMapBudget: candidate selection', () => {
  it('includes only nodes the interactivity cascade judges actionable', () => {
    const c = capture([
      button(1, { rect: { x: 10, y: 10, width: 20, height: 20 } }),
      baseNode({ backendNodeId: 2, tag: 'div', rect: { x: 40, y: 40, width: 20, height: 20 } }), // not interactive
    ]);
    const result = buildPageMapBudget(c);
    expect(result.nodes.map((n) => n.index)).toEqual([1]);
    expect(result.total).toBe(1);
  });

  it('excludes an interactive node with no rect from the wire, but REPORTS it under unpositioned rather than dropping it silently', () => {
    const c = capture([
      button(1, { rect: null }),
      button(2, { rect: { x: 0, y: 0, width: 10, height: 10 } }),
    ]);
    const result = buildPageMapBudget(c);
    expect(result.nodes.map((n) => n.index)).toEqual([2]);
    // `total` counts candidates, and a node with no rect never becomes one:
    // `PageMapNode` declares a non-null rect and there is nowhere to click.
    expect(result.total).toBe(1);
    // Not a budget casualty, so `truncated` stays false. The count is still
    // reported, because telling a caller the page has one actionable element
    // when the cascade found two is the exact lie this module inherited a
    // rule against from `a11y.ts`.
    expect(result.truncated).toBe(false);
    expect(result.truncatedByReason).toEqual({ offscreen: 0, onscreen: 0, unpositioned: 1 });
  });
});

describe('buildPageMapBudget: the wire shape', () => {
  it('carries tag/role/name/attributes, converts the rect to viewport space, and reports occlusion', () => {
    const c = capture(
      [
        button(1, {
          role: 'button',
          name: 'Submit',
          rect: { x: 110, y: 60, width: 40, height: 20 },
          attributes: new Map([
            ['id', 'submit-btn'],
            ['data-testid', 'ignored-not-in-wire-subset'],
          ]),
        }),
      ],
      { scrollX: 100, scrollY: 50 },
    );
    const result = buildPageMapBudget(c);
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node.tag).toBe('button');
    expect(node.role).toBe('button');
    expect(node.name).toBe('Submit');
    expect(node.rect).toEqual({ x: 10, y: 10, w: 40, h: 20 }); // document space (110,60) minus scroll (100,50)
    expect(node.attributes).toEqual({ id: 'submit-btn' }); // only the fixed wire subset
    expect(node.inViewport).toBe(true);
    expect(node.occluded).toBe(false); // nothing painted above it
  });

  it('reports inViewport: false for a node entirely outside the viewport, offscreen and occluded both null-safe', () => {
    const c = capture([button(1, { rect: { x: 5000, y: 5000, width: 10, height: 10 } })]);
    const result = buildPageMapBudget(c);
    expect(result.nodes[0]!.inViewport).toBe(false);
    expect(result.nodes[0]!.occluded).toBeNull(); // occlusion.ts never answers for an off-viewport node
  });
});

describe('buildPageMapBudget: truncation, honestly reported', () => {
  it('reports truncated: false and every reason at 0 when everything fits', () => {
    const c = capture([button(1, { rect: { x: 0, y: 0, width: 10, height: 10 } })]);
    const result = buildPageMapBudget(c, { maxResultBytes: 10_000 });
    expect(result.truncated).toBe(false);
    expect(result.truncatedByReason).toEqual({ offscreen: 0, onscreen: 0, unpositioned: 0 });
    expect(result.nodes).toHaveLength(result.total);
  });

  it('drops from the tail of the priority order once the byte ceiling is exceeded, and total still counts every candidate', () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      button(i, { rect: { x: i, y: 0, width: 10, height: 10 } }),
    );
    const c = capture(nodes);
    const full = buildPageMapBudget(c, { maxResultBytes: 1_000_000 });
    expect(full.total).toBe(20);
    expect(full.truncated).toBe(false);

    // A ceiling too small for all 20 but big enough for at least one.
    const oneNodeBytes = JSON.stringify(full.nodes[0]).length + 2;
    const tight = buildPageMapBudget(c, { maxResultBytes: oneNodeBytes });
    expect(tight.total).toBe(20); // total is honest regardless of what survived
    expect(tight.truncated).toBe(true);
    expect(tight.nodes.length).toBeLessThan(20);
    expect(
      tight.nodes.length + tight.truncatedByReason.offscreen + tight.truncatedByReason.onscreen,
    ).toBe(20);
  });

  it("distinguishes onscreen truncation from offscreen truncation by the DROPPED node's own viewport membership", () => {
    // One in-viewport candidate, one far offscreen candidate. A ceiling
    // that fits neither drops both; the one that was actually onscreen
    // must be counted under 'onscreen', not folded into 'offscreen'.
    const onscreenNode = button(1, { rect: { x: 10, y: 10, width: 10, height: 10 } });
    const offscreenNode = button(2, { rect: { x: 9000, y: 9000, width: 10, height: 10 } });
    const c = capture([onscreenNode, offscreenNode]);

    const result = buildPageMapBudget(c, { maxResultBytes: 2 }); // '[' + ']' only: nothing fits
    expect(result.nodes).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedByReason.onscreen).toBe(1);
    expect(result.truncatedByReason.offscreen).toBe(1);
  });

  it('priority order keeps in-viewport candidates over offscreen ones when the budget cannot hold both', () => {
    const onscreenNode = button(1, { rect: { x: 10, y: 10, width: 10, height: 10 } });
    const offscreenNode = button(2, { rect: { x: 9000, y: 9000, width: 10, height: 10 } });
    const c = capture([offscreenNode, onscreenNode]); // offscreen inserted first, to prove sort order (not insertion order) wins

    const full = buildPageMapBudget(c, { maxResultBytes: 1_000_000 });
    const onscreenWireBytes = JSON.stringify(full.nodes.find((n) => n.index === 1)).length;
    const budget = onscreenWireBytes + 3; // room for exactly one node

    const result = buildPageMapBudget(c, { maxResultBytes: budget });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.index).toBe(1); // the onscreen one survives, not the offscreen one
    expect(result.truncatedByReason.offscreen).toBe(1);
    expect(result.truncatedByReason.onscreen).toBe(0);
  });

  it('within the same viewport tier, prefers descending paint order, then document order', () => {
    const low = button(1, { rect: { x: 0, y: 0, width: 10, height: 10 }, paintOrder: 1 });
    const high = button(2, { rect: { x: 0, y: 0, width: 10, height: 10 }, paintOrder: 5 });
    const noPaintOrder = button(3, {
      rect: { x: 0, y: 0, width: 10, height: 10 },
      paintOrder: null,
    });
    const c = capture([low, high, noPaintOrder]);
    const result = buildPageMapBudget(c, { maxResultBytes: 1_000_000 });
    // Descending paint order first (5 before 1), missing paint order sorts last.
    expect(result.nodes.map((n) => n.index)).toEqual([2, 1, 3]);
  });
});
