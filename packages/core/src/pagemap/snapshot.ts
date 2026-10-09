/**
 * `pagemap/snapshot.ts`: sends `DOMSnapshot.captureSnapshot` and decodes its
 * reply. Phase A; this file owns exactly one of the three phase A commands
 * (`DOM.getDocument` is `dom-tree.ts`, `Page.getFrameTree` is
 * `frames.ts`).
 *
 * ── The encoding, and why the decode looks the way it does ──────────────
 *
 * `DOMSnapshot.captureSnapshot` does not return a tree. It returns
 * `{ documents: DocumentSnapshot[], strings: string[] }`. Every place a
 * `DocumentSnapshot` would otherwise carry a string, it carries a
 * `StringIndex` (a plain integer) into that one shared `strings` table
 * instead, `documentSnapshot.frameId` included: `frameId` on the wire is a
 * `StringIndex`, not a `Page.FrameId` string directly, which is easy to get
 * wrong silently because both are "just a number-ish thing" until you
 * print one and it is `"7"` instead of `"7F1234...`" (confirmed against
 * `chromedp/cdproto`'s generated Go bindings, which mirror the protocol
 * schema field-for-field: `DocumentSnapshot.FrameID StringIndex`, not
 * `cdp.FrameID`).
 *
 * Below that, each `DocumentSnapshot` carries two more parallel-array
 * structures:
 *
 * - `nodes: NodeTreeSnapshot`. One entry per DOM node in that document
 *   (element, text, comment, everything), dense: `nodes.backendNodeId[i]`
 *   is node `i`'s backend id.
 * - `layout: LayoutTreeSnapshot`. One entry per node that actually HAS a
 *   layout object, which is a strict subset (a `display:none` element, a
 *   node inside a closed shadow tree in some configurations, and most text
 *   nodes never get one). `layout.nodeIndex[j]` names WHICH node (by
 *   position in the `nodes` arrays) layout entry `j` belongs to. Every
 *   other `layout.*` array (`bounds`, `styles`, `paintOrders`,
 *   `scrollRects`, `clientRects`) is parallel to `layout.nodeIndex`, not to
 *   `nodes`: position `j` in `bounds` describes the node named by
 *   `nodeIndex[j]`, not node `j`.
 *
 * That `nodeIndex` indirection is the "sparse field as an (index, value)
 * pair rather than a dense array" shape this module is named for: `layout`
 * as a whole is a sidecar keyed by node position, present only for the
 * nodes that have something to say, exactly the pattern CDP's own
 * `RareBooleanData`/`RareStringData`/`RareIntegerData` types use elsewhere
 * in this same reply (`nodes.isClickable`, `nodes.shadowRootType`, and
 * friends) for fields with an even sparser hit rate. This module does not
 * decode any of those `RareXxxData` fields: every one of them belongs to a
 * question `dom-tree.ts` or a later stage answers (`isClickable` in
 * particular is superseded by the measured `DOMDebugger.getEventListeners`
 * signal `listeners.ts` carries), so there is
 * nothing here that needs that shape. If a future need arises for one, the
 * decode is: `{ index: number[] }` for boolean ("true at these positions,
 * false or absent elsewhere") and `{ index: number[], value: T[] }` for
 * string/integer (parallel `index[i]`/`value[i]` pairs), never a dense
 * array the length of `nodes`.
 *
 * Getting any of this wrong produces a value for every node, just the
 * WRONG one (a rect from a different element, a style from a different
 * layout entry), not an exception. There is no such thing as "the decode
 * throws when the offsets are misaligned"; alignment errors are silent by
 * construction. That is why every helper below is defensive (bounds
 * checks, `null` on anything unexpected) rather than trusting array shape,
 * and why the test file builds hand written fixtures that pin down the
 * exact array shapes above rather than trusting a live capture to catch a
 * regression here.
 *
 * ── Coordinate space ──────────────────────────────────────────────────
 *
 * `bounds`/`scrollRects`/`clientRects` are CDP's own "absolute position"
 * rectangles: DOCUMENT space, already accounting for the document's own
 * scroll, not viewport space and not multiplied by any device pixel ratio
 * (`packages/core/src/pagemap/types.ts`'s module doc states the project
 * wide rule this file follows: no DPR multiplier anywhere in this
 * pipeline). A rect from THIS document's own snapshot is correct as-is
 * within that document; offsetting a child frame's rect into the top
 * document's space is `frames.ts`'s job, done after this module returns,
 * not this module's. This module hands back one rect per node in the
 * space CDP gave it, tagged with the frame it came from.
 *
 * `PageMapNodeRecord.rect` (`types.ts`) declares exactly one rect field,
 * not a separate one for `bounds` and `clientRects`. `bounds` ("the
 * absolute position bounding box", CDP's own doc string) is read as the
 * primary source, since it is unconditionally present whenever a node has
 * ANY layout entry. `clientRects` ("the client rect of nodes") is read
 * only as a fallback for the rare case `bounds` is itself absent from an
 * otherwise-present layout entry, so a caller does not see `rect: null`
 * for a node the snapshot in fact reported some box for. REPORTED to the
 * lead: a distinct `clientRect` field on `PageMapNodeRecord` was not
 * available to fold this into more precisely; this module folds both into
 * the one `rect` field it has, with `bounds` preferred, rather than adding
 * one.
 *
 * ── Performance ───────────────────────────────────────────────────────
 *
 * One pass to index `layout.nodeIndex` (`Map<node position, layout
 * position>`, first occurrence wins on a duplicate, matching the only
 * documented precedent for handling one: browser-use's own
 * `enhanced_snapshot.py` comment on the identical structure), one pass
 * over `nodes.backendNodeId` doing an O(1) map lookup per node. No
 * `.indexOf`/`.includes`/nested loop anywhere in this file: browser-use's
 * own measured finding on this exact reply shape is the reason, recorded
 * in their code as a comment ("At 20k elements: 5,925ms (list) -> 2ms
 * (set) = 3,000x speedup" switching one lookup from a list scan to a set).
 * Total cost per document is O(nodeCount + layoutCount); across the whole
 * reply, O(N + L) where N and L sum those counts over every document
 * (main frame plus any same-process iframe documents the snapshot
 * included). Nothing here allocates per node beyond the one output record
 * each node produces; the two lookup maps are built once per document, not
 * once per node.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId } from '../cdp/types.js';
import {
  PAGE_MAP_COMPUTED_STYLES,
  type PageMapComputedStyle,
  type PageMapDocumentRect,
  type PageMapPhaseFailure,
} from './types.js';

/**
 * Guards the positional style decode below against `types.ts` ever
 * reordering `PAGE_MAP_COMPUTED_STYLES` without this file changing to
 * match. CDP echoes each requested computed style back at the SAME
 * position it was requested at, never by name (`layout.styles[j][k]` is
 * the value for whatever property `computedStyles[k]` named when this
 * module sent the request), so {@link styleAt} below reads `indices[0]`
 * through `indices[9]` by position and assumes they line up with
 * `PageMapComputedStyle`'s own field order. A silent reorder there would
 * not throw; it would mislabel every style on every node. This throws at
 * module load instead, once, rather than ever letting that happen quietly.
 */
const EXPECTED_STYLE_ORDER = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  'background-color',
] as const;
if (
  PAGE_MAP_COMPUTED_STYLES.length !== EXPECTED_STYLE_ORDER.length ||
  EXPECTED_STYLE_ORDER.some((name, i) => PAGE_MAP_COMPUTED_STYLES[i] !== name)
) {
  throw new Error(
    "pagemap/snapshot.ts: PAGE_MAP_COMPUTED_STYLES no longer matches the order this module's positional decode was written against. Update styleAt() in snapshot.ts to match types.ts before this can run.",
  );
}

/**
 * The timeout for `DOMSnapshot.captureSnapshot`. It matches the
 * `TIMEOUT_TABLE` entry in `packages/core/src/cdp/timeouts.ts`, and this
 * module also passes it as an explicit `SendOptions.timeoutMs` override,
 * the pattern `evaluate.ts` already uses, so the value is visible at the
 * call site.
 */
const CAPTURE_SNAPSHOT_TIMEOUT_MS = 20000;

/** One decoded node from the snapshot, keyed by `backendNodeId` by the caller. Not {@link PageMapNodeRecord}: that record also carries fields (`tag`, `attributes`, `role`, ...) this module never reads, supplied by `dom-tree.ts` and `ax-merge.ts` and merged by `capture.ts`. */
export interface PageMapSnapshotNode {
  readonly backendNodeId: number;
  /** The frame this node's document belongs to, resolved through the string table. Empty string only if the reply itself could not name it; see {@link decodeDocument}. */
  readonly frameId: string;
  /** DOCUMENT space, this document's own coordinate system. See this module's doc. */
  readonly rect: PageMapDocumentRect | null;
  readonly scrollRect: PageMapDocumentRect | null;
  /** Higher paints later (nearer the viewer). `null` only when the snapshot omitted paint order entirely for this node's layout entry. */
  readonly paintOrder: number | null;
  readonly style: PageMapComputedStyle | null;
}

/** One `DocumentSnapshot`'s own metadata, for `frames.ts` to consume: the scroll offset a cross-origin child frame's own document reports for itself. This module supplies the raw values either way. */
export interface PageMapSnapshotDocument {
  readonly frameId: string;
  readonly scrollOffsetX: number | null;
  readonly scrollOffsetY: number | null;
}

/** What {@link captureDomSnapshot} returns. */
export interface PageMapSnapshotResult {
  /** Every node the snapshot named, across every document, keyed by `backendNodeId`. */
  readonly nodes: ReadonlyMap<number, PageMapSnapshotNode>;
  /** One entry per document in the reply, main frame first, in the order CDP returned them. */
  readonly documents: readonly PageMapSnapshotDocument[];
}

/**
 * Thrown by {@link captureDomSnapshot} on any failure: the CDP command
 * itself failing, or the reply not matching the shape this decoder was
 * written against closely enough to trust. A snapshot failure is fatal to
 * the whole capture (without it every element is unpositioned,
 * unoccludable, and its visibility is unknown), so this is never caught and retried inside this module; it
 * carries a ready made {@link PageMapPhaseFailure} so `capture.ts` can
 * report it as data rather than re-deriving one from a bare `CdpError`.
 */
export class PageMapSnapshotError extends Error {
  readonly failure: PageMapPhaseFailure;

  constructor(failure: PageMapPhaseFailure, options?: { readonly cause?: unknown }) {
    super(failure.reason, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PageMapSnapshotError';
    this.failure = failure;
  }
}

/** The subset of a raw `LayoutTreeSnapshot` this module reads. */
interface RawLayoutTreeSnapshot {
  readonly nodeIndex?: readonly number[];
  readonly styles?: readonly (readonly number[])[];
  readonly bounds?: readonly (readonly number[])[];
  readonly paintOrders?: readonly number[];
  readonly scrollRects?: readonly (readonly number[])[];
  readonly clientRects?: readonly (readonly number[])[];
}

/** The subset of a raw `NodeTreeSnapshot` this module reads. */
interface RawNodeTreeSnapshot {
  readonly backendNodeId?: readonly number[];
}

/** The subset of a raw `DocumentSnapshot` this module reads. `frameId` is a `StringIndex`, per this module's doc. */
interface RawDocumentSnapshot {
  readonly frameId?: number;
  readonly nodes?: RawNodeTreeSnapshot;
  readonly layout?: RawLayoutTreeSnapshot;
  readonly scrollOffsetX?: number;
  readonly scrollOffsetY?: number;
}

/** The raw `DOMSnapshot.captureSnapshot` reply. */
interface RawCaptureSnapshotResult {
  readonly documents?: readonly RawDocumentSnapshot[];
  readonly strings?: readonly string[];
}

/**
 * Resolves one `StringIndex` against the shared string table. CDP's own
 * sentinel for "no value at this position" is a negative index (`-1` in
 * practice); this also refuses an out of range index defensively, since a
 * misaligned decode elsewhere in this file would otherwise surface here as
 * an `undefined` read rather than a caught mistake.
 */
function stringAt(strings: readonly string[], index: number | undefined): string | null {
  if (typeof index !== 'number' || index < 0 || index >= strings.length) return null;
  const value = strings[index];
  return typeof value === 'string' ? value : null;
}

/** Reads one `Rectangle` (`[x, y, width, height]`) out of a layout rect array at `layoutIdx`, or `null` if that array is absent, short, or the entry itself is malformed. */
function rectAt(
  rects: readonly (readonly number[])[] | undefined,
  layoutIdx: number,
): PageMapDocumentRect | null {
  const r = rects?.[layoutIdx];
  if (r === undefined || r.length < 4) return null;
  const [x, y, width, height] = r;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Builds the ten {@link PageMapComputedStyle} fields from one layout
 * entry's style index array, positionally, per this module's doc and the
 * `EXPECTED_STYLE_ORDER` guard above. `indices` may be shorter than ten
 * (CDP omits nothing observed in practice, but this module trusts nothing
 * about the reply shape it did not itself request); `stringAt` already
 * treats a missing or negative index as `null`.
 */
function styleAt(
  strings: readonly string[],
  stylesByLayoutIdx: readonly (readonly number[])[] | undefined,
  layoutIdx: number,
): PageMapComputedStyle | null {
  const indices = stylesByLayoutIdx?.[layoutIdx];
  if (indices === undefined) return null;
  return {
    display: stringAt(strings, indices[0]),
    visibility: stringAt(strings, indices[1]),
    opacity: stringAt(strings, indices[2]),
    overflow: stringAt(strings, indices[3]),
    overflowX: stringAt(strings, indices[4]),
    overflowY: stringAt(strings, indices[5]),
    cursor: stringAt(strings, indices[6]),
    pointerEvents: stringAt(strings, indices[7]),
    position: stringAt(strings, indices[8]),
    backgroundColor: stringAt(strings, indices[9]),
  };
}

/**
 * Indexes `layout.nodeIndex` once: node position (an index into the
 * document's `nodes.*` arrays) -> layout position (an index into
 * `layout.bounds`/`styles`/etc). First occurrence wins on a duplicate node
 * position, matching the only documented precedent for one (browser-use's
 * `enhanced_snapshot.py`, same structure, same comment). A `Map`, not a
 * linear scan, is the whole performance point of this file; see the
 * module doc's measured citation.
 */
function buildLayoutIndex(nodeIndex: readonly number[] | undefined): ReadonlyMap<number, number> {
  const byNodePosition = new Map<number, number>();
  if (nodeIndex === undefined) return byNodePosition;
  for (let layoutIdx = 0; layoutIdx < nodeIndex.length; layoutIdx++) {
    const nodePosition = nodeIndex[layoutIdx];
    if (typeof nodePosition !== 'number') continue;
    if (!byNodePosition.has(nodePosition)) byNodePosition.set(nodePosition, layoutIdx);
  }
  return byNodePosition;
}

/**
 * Decodes one `DocumentSnapshot`, writing every node it names into the
 * shared `out` map (shared across documents so a page with iframes ends up
 * with one flat map, since `backendNodeId` is unique across the whole CDP
 * session this snapshot was captured on, not just within one document).
 */
function decodeDocument(
  strings: readonly string[],
  doc: RawDocumentSnapshot,
  out: Map<number, PageMapSnapshotNode>,
): PageMapSnapshotDocument {
  // See this module's doc: `frameId` on the wire is a StringIndex, not a
  // frame id string directly. `''` rather than `null` on failure to
  // resolve it: a malformed SINGLE document should not fail the whole
  // capture (only the whole-reply failures below do that), and every
  // consumer of `frameId` treats the empty string as "unknown frame"
  // rather than crashing on a missing value.
  const frameId = stringAt(strings, doc.frameId) ?? '';

  const backendNodeIds = doc.nodes?.backendNodeId ?? [];
  const layoutIndexByNodePosition = buildLayoutIndex(doc.layout?.nodeIndex);

  for (let nodePosition = 0; nodePosition < backendNodeIds.length; nodePosition++) {
    const backendNodeId = backendNodeIds[nodePosition];
    if (typeof backendNodeId !== 'number') continue;

    const layoutIdx = layoutIndexByNodePosition.get(nodePosition);
    let rect: PageMapDocumentRect | null = null;
    let scrollRect: PageMapDocumentRect | null = null;
    let paintOrder: number | null = null;
    let style: PageMapComputedStyle | null = null;

    if (layoutIdx !== undefined) {
      // `bounds` preferred, `clientRects` as fallback; see this module's doc.
      rect = rectAt(doc.layout?.bounds, layoutIdx) ?? rectAt(doc.layout?.clientRects, layoutIdx);
      scrollRect = rectAt(doc.layout?.scrollRects, layoutIdx);
      const rawPaintOrder = doc.layout?.paintOrders?.[layoutIdx];
      paintOrder = typeof rawPaintOrder === 'number' ? rawPaintOrder : null;
      style = styleAt(strings, doc.layout?.styles, layoutIdx);
    }

    out.set(backendNodeId, { backendNodeId, frameId, rect, scrollRect, paintOrder, style });
  }

  return {
    frameId,
    scrollOffsetX: typeof doc.scrollOffsetX === 'number' ? doc.scrollOffsetX : null,
    scrollOffsetY: typeof doc.scrollOffsetY === 'number' ? doc.scrollOffsetY : null,
  };
}

/**
 * Sends `DOMSnapshot.captureSnapshot` on `sessionId` with the capture
 * flags below, and decodes the reply per
 * this module's doc. `computedStyles` is sent as `PAGE_MAP_COMPUTED_STYLES`
 * verbatim (a plain array of CSS property name strings; CDP's own
 * parameter type for it is `array of string`, not an array of `{name}`
 * objects, confirmed against `chromedp/cdproto`'s generated bindings).
 *
 * Any failure, CDP rejecting the command or the reply not carrying a
 * `documents`/`strings` pair this decoder can trust, is fatal: this throws
 * {@link PageMapSnapshotError} rather than returning a partial or empty
 * result, per the capture's degradation policy for this phase (unlike a
 * per-frame accessibility failure, which degrades).
 */
export async function captureDomSnapshot(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  opts: { readonly timeoutMs?: number } = {},
): Promise<PageMapSnapshotResult> {
  let raw: RawCaptureSnapshotResult;
  try {
    raw = (await bridge.send(
      'DOMSnapshot.captureSnapshot',
      {
        computedStyles: [...PAGE_MAP_COMPUTED_STYLES],
        includePaintOrder: true,
        includeDOMRects: true,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      },
      sessionId,
      { timeoutMs: opts.timeoutMs ?? CAPTURE_SNAPSHOT_TIMEOUT_MS },
    )) as RawCaptureSnapshotResult;
  } catch (err) {
    throw new PageMapSnapshotError(
      {
        phase: 'snapshot',
        reason: `DOMSnapshot.captureSnapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { cause: err },
    );
  }

  const documents = raw.documents;
  const strings = raw.strings;
  if (documents === undefined || strings === undefined) {
    throw new PageMapSnapshotError({
      phase: 'snapshot',
      reason:
        'DOMSnapshot.captureSnapshot reply carried no documents/strings table; nothing here can be decoded.',
    });
  }

  const nodes = new Map<number, PageMapSnapshotNode>();
  const outDocuments: PageMapSnapshotDocument[] = new Array(documents.length);
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    outDocuments[i] = decodeDocument(strings, doc ?? {}, nodes);
  }

  return { nodes, documents: outDocuments };
}
