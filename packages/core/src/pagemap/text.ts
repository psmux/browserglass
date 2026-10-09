/**
 * Text and markdown-adjacent extraction from a `PageMapCapture`: what
 * `bg_read_page` should become, in place of `document.body.innerText` truncated to 2000 characters over the
 * evaluate surface (`packages/automation/src/mcp/server.ts`, `bg_read_page`).
 *
 * ── Why this needs no HTML round trip ─────────────────────────────────────
 *
 * browser-use's `markdown_extractor.py` (548 lines) exists because their
 * pipeline reconstructs HTML from their own tree
 * (`serializer/html_serializer.py`) and then hands that string to
 * `markdownify`, a third party dependency, which re-parses it. This build
 * already holds the merged, pierced DOM tree in `PageMapCapture.nodes`
 * (shadow roots and iframe content included; see "Piercing" below), so
 * this module walks that structure directly and emits
 * {@link PageMapTextBlock} records. No HTML is built, no HTML is parsed,
 * and `packages/core` gains no new dependency: `@browserglass/protocol`
 * and `sharp` remain the only two (`packages/core/package.json`).
 *
 * ── What is preserved, and what is a known gap ───────────────────────────
 *
 * Headings (`h1`-`h6`, with level), list items, and links (with `href`)
 * each become their own block. Every other block-level container (`p`,
 * `div`, `td`/`th`, `blockquote`, `pre`, `section`, and so on) becomes a
 * `paragraph` block holding its own text. A small set of inline and
 * structural wrapper tags (`span`, `em`, `strong`, `code`, `label`,
 * `ul`/`ol`, `table`/`tbody`/`thead`/`tfoot`/`tr`, ...; see
 * {@link PASSTHROUGH_TAGS}) do not open a block of their own: their text
 * folds into whichever block encloses them. That is what makes a table
 * come back as its cells' text in document order rather than as a
 * markdown table (`<table>`/`<tr>` are passthrough, `<td>`/`<th>` are not,
 * so each cell is its own `paragraph` block). That is an accepted gap for
 * this version: worse than a real markdown extractor produces and better
 * than nothing. A block-level tag not in the
 * passthrough set and not one of the three named kinds (an unlisted inline
 * tag such as `<cite>` or `<kbd>`) simply becomes its own small `paragraph`
 * block rather than folding into its parent; that is a minor, harmless
 * over-fragmentation, not a correctness bug.
 *
 * ── Piercing: shadow roots and iframes need no special-casing ────────────
 *
 * `PageMapCapture.nodes` is already the result of a full-depth, piercing
 * `DOM.getDocument` walk merged across every attached frame (capture
 * phases A and B). A shadow host's content and an iframe's
 * content are therefore just more nodes in the same flat map, reachable by
 * ordinary parent/child links, which is strictly more than
 * `document.body.innerText` ever saw (it sees neither). Two things follow
 * from how frame merging works that this module relies on rather than
 * re-derives: (1) `parentBackendNodeId` is `null` not only for the top
 * document's own root but also for EVERY child frame's own document root,
 * because backend node id spaces do not cross frame/session boundaries; so
 * this module walks every `parentBackendNodeId === null` node as its own
 * root, not just the first one found, and that is what pulls iframe text
 * in for free. (2) a shadow root is just another non-element,
 * non-text node in the pierced tree (CDP's `#document-fragment`), so it is
 * covered by the same "anything that is not an element and not a text
 * node recurses into its children with no block of its own" rule used for
 * the document node itself; `PageMapNodeRecord.shadowKind` is not consulted
 * here at all (it exists for `interactivity.ts`/`occlusion.ts`, not this
 * module).
 *
 * ── Skipped tags and hidden nodes ─────────────────────────────────────────
 *
 * `script`, `style`, `head`, `meta`, `link` (the `<link>` element, not the
 * `'link'` block kind this module also emits for `<a href>`) and `title`
 * are dropped, matching `html_serializer.py`'s own skip list. A node whose
 * merged computed style (`PageMapNodeRecord.style`, from the same ten
 * style DOMSnapshot already reads for `interactivity.ts`) reports
 * `display: none` or `visibility: hidden` is dropped along with its whole
 * subtree; this module gets that information for free off the already
 * captured record; browser-use has to re-derive it. `style` is `null`
 * when the snapshot did not run for this node, which is treated as "not
 * hidden", i.e. never a reason to drop content that might be visible.
 *
 * ── The gap this module found in `PageMapNodeRecord` ──────────────────────
 *
 * `PageMapNodeRecord` (`./types.ts`) has no field carrying a `#text`
 * node's own character data. CDP supplies this either as `nodeValue` on
 * the raw `DOM.getDocument` node (the natural source for `dom-tree.ts`,
 * which already walks that command) or as the parallel `text` array on
 * `DOMSnapshot`'s layout tree (already read by `snapshot.ts`). Neither is
 * on the record today, which means every text node in a real capture
 * currently has no text to report. This module does NOT add the field
 * (out of scope: `types.ts` is owned by the pagemap lead); it reads a
 * `nodeValue: string | null` property defensively off each text node
 * through {@link textOf}, so the module type-checks and runs correctly
 * against fixtures that supply it (as this module's own tests do) and
 * degrades to empty text, not a crash, against a capture built before the
 * field lands. REPORT: `types.ts` needs a text-content field on
 * `PageMapNodeRecord` for `nodeType === TEXT_NODE` records.
 *
 * `PageMapTextBlock` itself is defined locally below rather than imported
 * from `@browserglass/protocol`, for the same reason
 * `packages/core/src/cdp/accessibility.ts` defines its own `AxTreeNode`
 * "already shaped for `@browserglass/protocol`'s `A11yNode`" instead of
 * importing it: `packages/protocol/src/wire/messages/pagemap.ts` exists
 * but is not yet re-exported from `packages/protocol/src/wire/messages/index.ts`
 * (that barrel currently stops at `./a11y.js`), so `@browserglass/protocol`
 * does not expose it yet. REPORT: once that barrel is wired, this local
 * type and the caller that builds `page.map.got.text` should both switch
 * to the real import; the shape below matches it field for field so that
 * swap is mechanical. The byte budget below is likewise a parameter
 * (`PageMapTextRequest.maxResultBytes`), never a value imported from
 * `@browserglass/protocol`, matching `queryAccessibilityTree`'s own
 * `AxQueryRequest.maxResultBytes` in `./cdp/accessibility.ts`: the actual
 * ceiling (`MAX_PAGEMAP_RESULT_BYTES`) is the caller's concern, not this
 * module's.
 *
 * ── Complexity ─────────────────────────────────────────────────────────
 *
 * One linear pass builds a child-id index from `capture.nodes` (already
 * grouped in document order, because `ReadonlyMap` iterates in insertion
 * order and the tree walk that built it visits nodes depth-first;
 * REPORT: nothing on `PageMapNodeRecord` states that ordering guarantee
 * explicitly, so this module depends on it as an assumption, not a
 * documented contract). One recursive depth-first walk over that index
 * then produces every block exactly once: O(n) time and O(n) auxiliary
 * space in the node count n, with no re-visiting and no HTML string built
 * and re-parsed anywhere in between. Recursion depth is bounded by DOM
 * nesting depth, not by node count, the same bound every other tree walk
 * in this package accepts. The budget pass below is a second, separate
 * O(b) scan over the produced blocks (b <= n), computing each block's own
 * JSON byte size once rather than re-stringifying the whole growing array
 * on every candidate the way `queryAccessibilityTree`'s truncation loop
 * does, since b can be in the thousands on a text-heavy page.
 */

import type { PageMapCapture, PageMapNodeRecord } from './types.js';

/** DOM node type constants this module cares about. Everything else (comment, doctype, document, document-fragment/shadow-root) is treated as a transparent container: no block of its own, recurse into its children. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Elements dropped along with their whole subtree. Matches browser-use's `html_serializer.py` list (see the module doc above). */
const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'title',
]);

/**
 * Elements that do not open a block of their own: their text folds into
 * whichever enclosing block is currently open. List and table wrapper
 * tags are here because their own text (if any) is whitespace between
 * cells/items, and common inline formatting tags are here so
 * "<p>plain <strong>bold</strong> text</p>" reads as one paragraph rather
 * than three. Not exhaustive; see this module's own doc for what an
 * unlisted inline tag does instead.
 */
const PASSTHROUGH_TAGS: ReadonlySet<string> = new Set([
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'span',
  'b',
  'i',
  'em',
  'strong',
  'small',
  'sub',
  'sup',
  'abbr',
  'mark',
  'u',
  's',
  'code',
  'label',
  'cite',
  'q',
  'kbd',
  'var',
  'samp',
  'dfn',
  'time',
  'data',
  'bdi',
  'bdo',
]);

/**
 * One extracted text unit, shaped for `@browserglass/protocol`'s
 * `PageMapTextBlock` (`wire/messages/pagemap.ts`); see this module's own
 * doc for why it is defined here rather than imported.
 */
export interface PageMapTextBlock {
  kind: 'heading' | 'paragraph' | 'listItem' | 'link';
  /** Normalised, visible text content of this block. Never empty: an element whose collapsed text is empty produces no block at all. */
  text: string;
  /** Heading level 1 to 6. Present only when {@link kind} is `'heading'`. */
  level?: number;
  /** The link target, exactly as the `href` attribute reads, unresolved. Present only when {@link kind} is `'link'`. */
  href?: string;
}

/** What one {@link extractPageMapText} call was asked for. */
export interface PageMapTextRequest {
  /** Byte ceiling on the JSON-encoded block array; blocks are dropped from the tail, in document order, never from the middle, until the remainder fits. The caller's concern: see this module's own doc on why this is a parameter rather than an import. */
  readonly maxResultBytes: number;
}

/** What one {@link extractPageMapText} call found. */
export interface PageMapTextOutcome {
  readonly blocks: PageMapTextBlock[];
  /** How many blocks existed before the byte ceiling was applied. Reported honestly: truncation is data, never a silent cut. */
  readonly total: number;
  /** True when {@link maxResultBytes} cut the reply short. */
  readonly truncated: boolean;
}

/** UTF-8 byte length, non-allocating; duplicated rather than shared, mirroring `packages/core/src/cdp/evaluate.ts`'s own `utf8ByteLength` (that module does not export it for reuse), preferred at this size over the allocating `TextEncoder` one `accessibility.ts` uses at the smaller a11y ceiling. */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Collapses any run of whitespace (including newlines and tabs) to one space and trims the ends, the same normalisation `innerText` performs implicitly and this module must do explicitly since it reads raw text node data. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `'h1'`..`'h6'` -> 1..6, else `null`. Relies on `PageMapNodeRecord.tag`'s documented invariant that tags arrive already lowercased. */
function headingLevel(tag: string): number | null {
  if (tag.length === 2 && tag.charCodeAt(0) === 104 /* 'h' */) {
    const n = tag.charCodeAt(1) - 48;
    if (n >= 1 && n <= 6) return n;
  }
  return null;
}

/**
 * Reads a text node's own character data. See this module's own doc,
 * "The gap this module found in `PageMapNodeRecord`": the field does not
 * exist on the type yet, so this reads it defensively off a value that,
 * today, is not there, and returns `''` rather than throwing when it is
 * absent.
 */
function textOf(node: PageMapNodeRecord): string {
  const withText = node as PageMapNodeRecord & { readonly nodeValue?: unknown };
  return typeof withText.nodeValue === 'string' ? withText.nodeValue : '';
}

type BlockRole = 'heading' | 'listItem' | 'link' | 'paragraph' | 'passthrough';

function roleOf(node: PageMapNodeRecord): BlockRole {
  if (headingLevel(node.tag) !== null) return 'heading';
  if (node.tag === 'li') return 'listItem';
  if (node.tag === 'a' && node.attributes.has('href')) return 'link';
  if (PASSTHROUGH_TAGS.has(node.tag)) return 'passthrough';
  return 'paragraph';
}

function isHiddenByStyle(node: PageMapNodeRecord): boolean {
  const style = node.style;
  return style !== null && (style.display === 'none' || style.visibility === 'hidden');
}

function makeBlock(
  role: Exclude<BlockRole, 'passthrough'>,
  text: string,
  node: PageMapNodeRecord,
): PageMapTextBlock {
  if (role === 'heading') return { kind: 'heading', text, level: headingLevel(node.tag) ?? 1 };
  if (role === 'link') return { kind: 'link', text, href: node.attributes.get('href') ?? '' };
  if (role === 'listItem') return { kind: 'listItem', text };
  return { kind: 'paragraph', text };
}

/** Groups `capture.nodes` by `parentBackendNodeId`, preserving the map's own (document) iteration order within each group. */
function buildChildren(nodes: ReadonlyMap<number, PageMapNodeRecord>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const node of nodes.values()) {
    if (node.parentBackendNodeId === null) continue;
    const list = children.get(node.parentBackendNodeId);
    if (list) list.push(node.backendNodeId);
    else children.set(node.parentBackendNodeId, [node.backendNodeId]);
  }
  return children;
}

/**
 * Depth-first walk. `ambient` is the text buffer of the nearest enclosing
 * block; a node that opens its own block (heading/listItem/link/paragraph)
 * gets a fresh buffer for its own subtree, so nested block-worthy content
 * (a nested `<li>`, a link inside a paragraph) contributes to ITS OWN
 * block and never leaks into the ancestor's, with no special-casing
 * needed for either case: it falls out of every block-opening element
 * starting a buffer nothing else writes into.
 */
function walk(
  id: number,
  nodes: ReadonlyMap<number, PageMapNodeRecord>,
  children: ReadonlyMap<number, number[]>,
  ambient: string[],
  blocks: PageMapTextBlock[],
): void {
  const node = nodes.get(id);
  if (!node) return;

  if (node.nodeType === TEXT_NODE) {
    const text = textOf(node);
    if (text) ambient.push(text);
    return;
  }

  const kids = children.get(id);

  if (node.nodeType !== ELEMENT_NODE) {
    // Document root, document-fragment (shadow root), comment, doctype:
    // no text and no block of their own, just recurse transparently.
    if (kids) for (const childId of kids) walk(childId, nodes, children, ambient, blocks);
    return;
  }

  if (SKIP_TAGS.has(node.tag) || isHiddenByStyle(node)) return;

  const role = roleOf(node);
  if (role === 'passthrough') {
    if (kids) for (const childId of kids) walk(childId, nodes, children, ambient, blocks);
    return;
  }

  const own: string[] = [];
  if (kids) for (const childId of kids) walk(childId, nodes, children, own, blocks);
  const text = normalizeWhitespace(own.join(''));
  if (text) blocks.push(makeBlock(role, text, node));
}

/** One block's own contribution to the JSON array's byte size: its own encoding, plus the separating comma for every entry but the first. */
function blockSizeInArray(block: PageMapTextBlock, index: number): number {
  return utf8ByteLength(JSON.stringify(block)) + (index > 0 ? 1 : 0);
}

/**
 * Drops from the tail, in document order, until `blocks` fits
 * `maxResultBytes` (accounting for the array's own `[`/`]`), the same
 * "a list of independent records can lose its tail and leave every
 * surviving record exactly correct" idiom `evaluate.ts` and
 * `accessibility.ts` already use, computed in one
 * linear pass rather than by re-stringifying the whole array per
 * candidate.
 */
function truncateToBudget(
  blocks: PageMapTextBlock[],
  maxResultBytes: number,
): { kept: PageMapTextBlock[]; truncated: boolean } {
  let total = 2; // '[' + ']'
  for (const [i, block] of blocks.entries()) {
    total += blockSizeInArray(block, i);
    if (total > maxResultBytes) return { kept: blocks.slice(0, i), truncated: true };
  }
  return { kept: blocks, truncated: false };
}

/**
 * Extracts headings, paragraphs, list items and links from a captured
 * page map's DOM tree. Pure: no CDP, no I/O, safe to run against a
 * hand-built fixture. See this module's own doc for structure, skip
 * rules, piercing, the `PageMapNodeRecord` gap this module works around,
 * and complexity.
 */
export function extractPageMapText(
  capture: PageMapCapture,
  req: PageMapTextRequest,
): PageMapTextOutcome {
  const children = buildChildren(capture.nodes);
  const blocks: PageMapTextBlock[] = [];
  for (const node of capture.nodes.values()) {
    if (node.parentBackendNodeId === null) {
      walk(node.backendNodeId, capture.nodes, children, [], blocks);
    }
  }
  const { kept, truncated } = truncateToBudget(blocks, req.maxResultBytes);
  return { blocks: kept, total: blocks.length, truncated };
}
