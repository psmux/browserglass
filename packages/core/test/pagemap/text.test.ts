/**
 * `pagemap/text.ts`.
 *
 * Every fixture here is a hand-built `PageMapCapture`, no browser and no
 * CDP involved, which is the point of the split this module's own doc
 * argues for: text extraction is a pure function over the merged tree.
 * Fixtures include a `nodeValue` property on text nodes that
 * `PageMapNodeRecord` does not declare today (see `text.ts`'s own doc,
 * "The gap this module found"); `mkText` below is the one place that
 * property is attached, matching what `extractPageMapText`'s `textOf`
 * reads defensively.
 */

import { describe, expect, it } from 'vitest';
import { type PageMapTextBlock, extractPageMapText } from '../../src/pagemap/text.js';
import type {
  PageMapCapture,
  PageMapComputedStyle,
  PageMapNodeRecord,
} from '../../src/pagemap/types.js';

const BIG_BUDGET = 10_000_000;

function style(overrides: Partial<PageMapComputedStyle>): PageMapComputedStyle {
  return {
    display: null,
    visibility: null,
    opacity: null,
    overflow: null,
    overflowX: null,
    overflowY: null,
    cursor: null,
    pointerEvents: null,
    position: null,
    backgroundColor: null,
    ...overrides,
  };
}

/** An element (or document/document-fragment) node, with every field `PageMapNodeRecord` requires filled in with an inert default. */
function mkNode(
  backendNodeId: number,
  parentBackendNodeId: number | null,
  tag: string,
  nodeType: number,
  overrides: Partial<PageMapNodeRecord> = {},
): PageMapNodeRecord {
  return {
    backendNodeId,
    parentBackendNodeId,
    tag,
    nodeType,
    attributes: new Map<string, string>(),
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

function mkEl(
  backendNodeId: number,
  parentBackendNodeId: number | null,
  tag: string,
  overrides: Partial<PageMapNodeRecord> = {},
): PageMapNodeRecord {
  return mkNode(backendNodeId, parentBackendNodeId, tag, 1, overrides);
}

/** A `#text` node. `nodeValue` is not on `PageMapNodeRecord` (the gap `text.ts` documents); attached here as the extra property `textOf` reads. */
function mkText(
  backendNodeId: number,
  parentBackendNodeId: number,
  value: string,
): PageMapNodeRecord {
  const node = mkNode(backendNodeId, parentBackendNodeId, '#text', 3);
  return { ...node, nodeValue: value } as PageMapNodeRecord;
}

function mkCapture(nodes: readonly PageMapNodeRecord[]): PageMapCapture {
  const map = new Map<number, PageMapNodeRecord>();
  for (const n of nodes) map.set(n.backendNodeId, n);
  return {
    epoch: 'epoch-test',
    nodes: map,
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1280,
    viewportHeight: 800,
    failures: [],
  };
}

function withHref(node: PageMapNodeRecord, href: string): PageMapNodeRecord {
  return { ...node, attributes: new Map([['href', href]]) };
}

describe('extractPageMapText: structure', () => {
  it('extracts a heading, a paragraph and a two-item list in document order', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'html'),
      mkEl(3, 2, 'body'),
      mkEl(4, 3, 'h1'),
      mkText(5, 4, 'Title'),
      mkEl(6, 3, 'p'),
      mkText(7, 6, 'Hello world'),
      mkEl(8, 3, 'ul'),
      mkEl(9, 8, 'li'),
      mkText(10, 9, 'Item one'),
      mkEl(11, 8, 'li'),
      mkText(12, 11, 'Item two'),
    ]);

    const { blocks, total, truncated } = extractPageMapText(capture, {
      maxResultBytes: BIG_BUDGET,
    });

    expect(truncated).toBe(false);
    expect(total).toBe(4);
    expect(blocks).toEqual<PageMapTextBlock[]>([
      { kind: 'heading', text: 'Title', level: 1 },
      { kind: 'paragraph', text: 'Hello world' },
      { kind: 'listItem', text: 'Item one' },
      { kind: 'listItem', text: 'Item two' },
    ]);
  });

  it('reads a heading level from h1 through h6', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'h3'),
      mkText(3, 2, 'Section'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'heading', text: 'Section', level: 3 }]);
  });

  it('a table with no markdown rendering: each cell comes back as its own paragraph block, in document order, with tr/table/tbody passed through', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'table'),
      mkEl(3, 2, 'tbody'),
      mkEl(4, 3, 'tr'),
      mkEl(5, 4, 'td'),
      mkText(6, 5, 'A1'),
      mkEl(7, 4, 'th'),
      mkText(8, 7, 'B1'),
    ]);
    const { blocks, total } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(total).toBe(2);
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'A1' },
      { kind: 'paragraph', text: 'B1' },
    ]);
  });

  it('an anchor with an href becomes a link block carrying the href verbatim', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'p'),
      withHref(mkEl(3, 2, 'a'), '/docs/pagemap'),
      mkText(4, 3, 'Click here'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'link', text: 'Click here', href: '/docs/pagemap' }]);
  });

  it('an anchor with no href is not a link block, and its text is still not lost', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'p'),
      mkEl(3, 2, 'a'),
      mkText(4, 3, 'no href here'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'no href here' }]);
  });
});

describe('extractPageMapText: piercing', () => {
  it("a shadow host's content appears, reached through a document-fragment node with no block of its own", () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'body'),
      mkEl(3, 2, 'div', { shadowKind: 'open' }),
      mkNode(4, 3, '#document-fragment', 11),
      mkEl(5, 4, 'p'),
      mkText(6, 5, 'Shadow content'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Shadow content' }]);
  });

  it("an iframe's own document, a second root with parentBackendNodeId null, contributes its text alongside the top document's", () => {
    const capture = mkCapture([
      // Top document.
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'body'),
      mkEl(3, 2, 'p'),
      mkText(4, 3, 'Main document text'),
      // Child frame's own document: a second, unrelated root, per this
      // module's own doc on why per-frame backend node id spaces do not
      // cross-reference the owning element.
      mkNode(100, null, '#document', 9, { frameId: 'child-frame-1' }),
      mkEl(101, 100, 'body', { frameId: 'child-frame-1' }),
      mkEl(102, 101, 'p', { frameId: 'child-frame-1' }),
      mkText(103, 102, 'Iframe text'),
    ]);
    const { blocks, total } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(total).toBe(2);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Main document text');
    expect(texts).toContain('Iframe text');
  });
});

describe('extractPageMapText: skipping and hiding', () => {
  it('script and style subtrees never contribute text', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'body'),
      mkEl(3, 2, 'script'),
      mkText(4, 3, "alert('should not appear')"),
      mkEl(5, 2, 'style'),
      mkText(6, 5, '.a { color: red }'),
      mkEl(7, 2, 'p'),
      mkText(8, 7, 'Real content'),
    ]);
    const { blocks, total } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(total).toBe(1);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Real content' }]);
  });

  it('head, meta, link and title subtrees never contribute text', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'head'),
      mkEl(3, 2, 'title'),
      mkText(4, 3, 'Page Title'),
      mkEl(5, 2, 'meta'),
      mkEl(6, 2, 'link'),
      mkEl(7, 1, 'body'),
      mkEl(8, 7, 'p'),
      mkText(9, 8, 'Body content'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Body content' }]);
  });

  it('display: none hides a node and its whole subtree', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'body'),
      mkEl(3, 2, 'div', { style: style({ display: 'none' }) }),
      mkText(4, 3, 'Hidden by display'),
      mkEl(5, 2, 'p'),
      mkText(6, 5, 'Visible content'),
    ]);
    const { blocks, total } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(total).toBe(1);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Visible content' }]);
  });

  it('visibility: hidden hides a node and its whole subtree', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'body'),
      mkEl(3, 2, 'p', { style: style({ visibility: 'hidden' }) }),
      mkText(4, 3, 'Hidden by visibility'),
      mkEl(5, 2, 'p'),
      mkText(6, 5, 'Visible content'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Visible content' }]);
  });

  it('a node with no computed style at all (snapshot did not cover it) is never treated as hidden', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'p'),
      mkText(3, 2, 'No style recorded'),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'No style recorded' }]);
  });
});

describe('extractPageMapText: whitespace', () => {
  it('collapses internal runs of whitespace, including newlines and tabs, to a single space, and trims the ends', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'p'),
      mkText(3, 2, '  Hello\n\n'),
      mkText(4, 2, '\t  World  '),
    ]);
    const { blocks } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Hello World' }]);
  });

  it('a block whose only content is whitespace produces no block at all', () => {
    const capture = mkCapture([
      mkNode(1, null, '#document', 9),
      mkEl(2, 1, 'p'),
      mkText(3, 2, '   \n\t  '),
      mkEl(4, 1, 'p'),
      mkText(5, 4, 'Real text'),
    ]);
    const { blocks, total } = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(total).toBe(1);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Real text' }]);
  });
});

describe('extractPageMapText: byte budget', () => {
  function manyItemsCapture(count: number): PageMapCapture {
    const nodes: PageMapNodeRecord[] = [mkNode(1, null, '#document', 9), mkEl(2, 1, 'ul')];
    let nextId = 3;
    for (let i = 0; i < count; i += 1) {
      const liId = nextId++;
      const textId = nextId++;
      nodes.push(mkEl(liId, 2, 'li'));
      nodes.push(mkText(textId, liId, `Item ${i}`));
    }
    return mkCapture(nodes);
  }

  it('reports the real total and truncated: true when the budget cuts the list short, keeping a document-order prefix', () => {
    const capture = manyItemsCapture(50);
    const full = extractPageMapText(capture, { maxResultBytes: BIG_BUDGET });
    expect(full.total).toBe(50);
    expect(full.truncated).toBe(false);
    expect(full.blocks).toHaveLength(50);

    const { blocks, total, truncated } = extractPageMapText(capture, { maxResultBytes: 200 });
    expect(total).toBe(50); // the real total, not the truncated count
    expect(truncated).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThan(50);
    // Kept blocks are exactly the document-order prefix of the untruncated run.
    expect(blocks).toEqual(full.blocks.slice(0, blocks.length));
  });

  it('does not truncate when everything fits comfortably', () => {
    const capture = manyItemsCapture(3);
    const { blocks, total, truncated } = extractPageMapText(capture, {
      maxResultBytes: BIG_BUDGET,
    });
    expect(truncated).toBe(false);
    expect(total).toBe(3);
    expect(blocks).toHaveLength(3);
  });

  it('an empty capture (nothing fits, or nothing to extract) reports zero, not truncated', () => {
    const capture = mkCapture([mkNode(1, null, '#document', 9)]);
    const { blocks, total, truncated } = extractPageMapText(capture, {
      maxResultBytes: BIG_BUDGET,
    });
    expect(blocks).toEqual([]);
    expect(total).toBe(0);
    expect(truncated).toBe(false);
  });
});
