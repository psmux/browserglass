/**
 * The byte budget, the priority order truncation drops from, and the
 * wire-shaped serialization of a finished {@link PageMapCapture}, with
 * truncation reported as data. It is also the one caller of the occlusion
 * pass (`occlusion.ts`).
 *
 * ── Where this sits in the pipeline ───────────────────────────────────────
 *
 * `capture.ts` owns phases A through C and
 * the merge that produces one `PageMapCapture`: CDP dispatch, degradation
 * policy, epoch minting, nothing else. This module is the rest of Phase D
 * (cascade, occlusion, index assignment, budget, serialize): everything from here
 * down is pure CPU over a `PageMapCapture` already in hand, no CDP, safe to
 * call twice on the same capture with two different byte ceilings (which is
 * exactly what `cache.ts` existing is FOR: a cached capture can be
 * re-budgeted for a second request with no recapture). {@link
 * buildPageMapBudget} is the one exported entry point; everything above it
 * (`computeInteractivity`, `computeOcclusion`) is called internally rather
 * than pushed onto `capture.ts`, because both are cheap, pure, and only
 * this module needs their output to decide what survives the budget.
 *
 * ── Candidate selection: interactive AND positioned ───────────────────────
 *
 * A candidate is a node `interactivity.ts` judged actionable AND carrying a
 * non-null `rect`. The second half of that is a real gap this module
 * REPORTS rather than papers over: `@browserglass/protocol`'s `PageMapNode`
 * declares `rect: PageMapRect`, not `PageMapRect | null` (unlike the
 * internal `PageMapNodeRecord.rect`, which is nullable for exactly the
 * unlaid-out case `types.ts`'s own doc names: "nodes that are not laid out
 * at all and, notably, ... shadow DOM form controls"). An interactive node
 * with no computed layout (most commonly `display: none`, but also a form
 * control inside certain shadow configurations) therefore cannot be placed
 * on this wire at all, and this module drops it from candidacy entirely
 * rather than inventing a zero rect that would misreport where it is. It
 * is not counted in {@link PageMapBudgetResult.total}, and it is not
 * counted under either {@link PageMapTruncationReason}: it was never a
 * candidate that competed for budget, so folding it into "onscreen" or
 * "offscreen" would misreport WHY it is missing (scrolling cannot surface a
 * `display: none` node the way it can an off-screen one). REPORTED to the
 * pagemap lead: a caller currently has no signal at all that such a node
 * exists and is interactive; closing that gap would need either a nullable
 * wire `rect` or a third {@link PageMapTruncationReason} value, both
 * `@browserglass/protocol` decisions, not this module's.
 *
 * ── The priority order ─────────────────────────────────────────────────
 *
 * In-viewport first, then descending paint order, then document order.
 * Implemented as one `Array.prototype.sort`
 * comparator with three tiers, applied to the candidate list before the
 * byte walk below, so "drop from the tail" and "drop the lowest priority
 * nodes" are the same operation. `inViewport` here is computed against the
 * node's own UNCLIPPED rect (unlike `occlusion.ts`'s clipped rect, which
 * exists only to keep that module's union small): this module needs a
 * yes/no answer for sorting and for {@link PageMapTruncationReason}, not a
 * clipped area to accumulate. A node with no `paintOrder` (the snapshot
 * omitted it for that layout entry) sorts as if painted first, i.e. lowest
 * priority within its viewport tier, matching `occlusion.ts`'s own
 * "furthest from the viewer" convention for the identical missing-value
 * case, kept for consistency between the two modules that both rank by
 * paint order. Document order is the candidate's position in
 * `capture.nodes`'s own iteration order, computed once in a single O(N)
 * pass ahead of the sort rather than re-derived per comparison.
 *
 * ── The byte walk: drop from the tail, report by tier ─────────────────────
 *
 * One linear pass over the already-sorted candidate list, in the same
 * "compute each candidate's own encoded size once, accumulate a running
 * total, stop and drop everything from here on" shape `text.ts`'s own
 * `truncateToBudget` uses, over
 * {@link MAX_PAGEMAP_RESULT_BYTES}/{@link PageMapBudgetRequest.maxResultBytes}
 * rather than re-stringifying the whole growing array per candidate.
 * Everything past the point the budget is exhausted is counted into
 * {@link PageMapBudgetResult.truncatedByReason} by ITS OWN `inViewport`
 * value, not by the reason the cut point itself was in-viewport or not:
 * an onscreen node cut for want of bytes and an offscreen node further
 * down the same list that never had a chance are both real, and both are
 * reported under the tier they actually belong to, matching
 * `PageMapTruncationReason`'s own doc ("'onscreen': dropped even though it
 * was in the viewport ... 'offscreen': ... scrolling and re-capturing is
 * likely to surface it").
 *
 * The byte counter is the non-allocating `utf8ByteLength`, duplicated
 * rather than imported, mirroring `text.ts`'s own choice at this same
 * budget class, for the same reason: at 512 KiB the `TextEncoder` allocation
 * `accessibility.ts` uses at the smaller 256 KiB a11y ceiling is not
 * affordable to repeat per candidate.
 *
 * ── Coordinate conversion: document space to viewport space, once ────────
 *
 * `PageMapNodeRecord.rect` is DOCUMENT space (`types.ts`'s own doc: "so a
 * caller that scrolls and asks again costs zero CDP round trips").
 * `PageMapRect` on the wire is viewport CSS px, the same space every
 * `AutomationClient` interaction method already takes
 * (`@browserglass/protocol`'s own doc on the type). The subtraction
 * (`rect.x - capture.scrollX`, `rect.y - capture.scrollY`) happens exactly
 * ONCE per surviving node, here, at serialization time, against the scroll
 * offset `capture.ts` recorded at capture time: not per candidate before
 * the sort, not per byte-walk iteration, and never applied to a node that
 * does not survive the budget. No device pixel ratio is applied anywhere
 * in this conversion, per the project-wide rule `types.ts`'s own module
 * doc states and `packages/core/src/input/coordinates.ts:5` sets.
 *
 * ── Attributes: the fixed wire subset, applied here and only here ────────
 *
 * `PageMapNodeRecord.attributes` (`types.ts`) is "every attribute the DOM
 * walk returned, unfiltered. The wire subset is applied later, in
 * `budget.ts`", that promise is this module's to keep.
 * {@link PAGE_MAP_ATTRIBUTES} (`@browserglass/protocol`) names the fixed,
 * LLM-priced subset; a node's own attribute map is read against it once per
 * surviving OR candidate node (the read happens before the byte walk since
 * the encoded size has to include it), never against every attribute the
 * DOM actually carries.
 *
 * ── Complexity ────────────────────────────────────────────────────────
 *
 * One O(N) pass to build the document-order index, one O(N) pass through
 * `computeInteractivity` (`interactivity.ts`'s own stated O(N)), one
 * `computeOcclusion` call bounded by `occlusion.ts`'s own stated
 * complexity for C candidates against a union capped at `MAX_RECTS`, one
 * O(C log C) sort of the candidate list, one O(C) byte walk. N is the node
 * count, C the candidate count, C generally one to two orders of magnitude
 * smaller than N on real pages.
 */

import {
  MAX_PAGEMAP_RESULT_BYTES,
  PAGE_MAP_ATTRIBUTES,
  type PageMapAttributes,
  type PageMapNode,
  type PageMapRect,
  type PageMapTruncationReason,
} from '@browserglass/protocol';
import { pageMapIndexOf } from './index-assign.js';
import { computeInteractivity } from './interactivity.js';
import { computeOcclusion } from './occlusion.js';
import type { PageMapCapture, PageMapDocumentRect, PageMapNodeRecord } from './types.js';

/** What one {@link buildPageMapBudget} call was asked for. */
export interface PageMapBudgetRequest {
  /** Byte ceiling on the JSON-encoded node array. Defaults to {@link MAX_PAGEMAP_RESULT_BYTES}; the caller's concern to override, matching `text.ts`'s own `PageMapTextRequest.maxResultBytes` precedent. */
  readonly maxResultBytes?: number;
}

/** What one {@link buildPageMapBudget} call produced, shaped to drop straight into `page.map.got`. */
export interface PageMapBudgetResult {
  readonly nodes: PageMapNode[];
  /** How many candidates existed before the byte ceiling was applied. Excludes every node this module's own doc names as never a candidate at all (not interactive, or interactive with no rect); see "Candidate selection" above. */
  readonly total: number;
  /** `true` when `nodes.length < total`. */
  readonly truncated: boolean;
  /** Counts of dropped candidates by {@link PageMapTruncationReason}. Both `0` when {@link truncated} is `false`. */
  readonly truncatedByReason: Record<PageMapTruncationReason, number>;
}

/** UTF-8 byte length, non-allocating. Duplicated rather than imported; see this module's own doc. */
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

/** Open-interval intersection against the capture's own viewport rectangle, in document space. Touching edges do not count, matching `rect-union.ts`'s own rule and `occlusion.ts`'s private `intersectRect`, duplicated here rather than imported for the same "not exported for reuse" reason every other pair of pagemap files gives. */
function intersectsViewport(rect: PageMapDocumentRect, capture: PageMapCapture): boolean {
  const { scrollX, scrollY, viewportWidth, viewportHeight } = capture;
  return (
    rect.x < scrollX + viewportWidth &&
    rect.x + rect.width > scrollX &&
    rect.y < scrollY + viewportHeight &&
    rect.y + rect.height > scrollY
  );
}

/** Document space to viewport space, once. See this module's own doc, "Coordinate conversion". */
function toViewportRect(rect: PageMapDocumentRect, capture: PageMapCapture): PageMapRect {
  return {
    x: rect.x - capture.scrollX,
    y: rect.y - capture.scrollY,
    w: rect.width,
    h: rect.height,
  };
}

/** The fixed wire attribute subset off one node's own unfiltered attribute map. See this module's own doc, "Attributes". */
function wireAttributesOf(node: PageMapNodeRecord): PageMapAttributes {
  const out: Record<string, string> = {};
  for (const name of PAGE_MAP_ATTRIBUTES) {
    const value = node.attributes.get(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** One candidate, prepared once (rect resolved, viewport and occlusion answers attached) so the sort and the byte walk below never recompute either. */
interface Candidate {
  readonly node: PageMapNodeRecord;
  readonly rect: PageMapDocumentRect;
  readonly inViewport: boolean;
  readonly occluded: boolean | null;
  readonly docOrder: number;
}

function toWireNode(candidate: Candidate, capture: PageMapCapture): PageMapNode {
  return {
    index: pageMapIndexOf(candidate.node.backendNodeId),
    tag: candidate.node.tag,
    role: candidate.node.role,
    name: candidate.node.name,
    rect: toViewportRect(candidate.rect, capture),
    inViewport: candidate.inViewport,
    occluded: candidate.occluded,
    attributes: wireAttributesOf(candidate.node),
  };
}

/**
 * Runs the interactivity cascade and the occlusion pass over `capture`,
 * orders the result by the priority order this module's own doc describes,
 * and serializes the surviving prefix into the wire shape, dropping from
 * the tail until it fits `req.maxResultBytes`. Pure: no CDP, no I/O, safe
 * to call more than once against the same `capture` (see this module's own
 * doc, "Where this sits in the pipeline", on why that matters for
 * `cache.ts`).
 */
export function buildPageMapBudget(
  capture: PageMapCapture,
  req: PageMapBudgetRequest = {},
): PageMapBudgetResult {
  const maxResultBytes = req.maxResultBytes ?? MAX_PAGEMAP_RESULT_BYTES;

  const interactive = computeInteractivity(capture.nodes);

  // Document order index: one O(N) pass, since `capture.nodes` iterates in
  // the tree walk's own insertion order (the same assumption `text.ts`
  // relies on and REPORTS as an undocumented contract; see that module's
  // own doc).
  const docOrder = new Map<number, number>();
  let order = 0;
  for (const node of capture.nodes.values()) {
    docOrder.set(node.backendNodeId, order);
    order += 1;
  }

  // Candidate selection: interactive AND positioned. See this module's own
  // doc, "Candidate selection", for why a rect-less interactive node is
  // excluded here rather than carried through with an invented rect.
  const candidateIds = new Set<number>();
  // Counted, not merely excluded. A node the cascade judged actionable and
  // the snapshot gave no layout cannot go on this wire, since `PageMapNode`
  // declares a non-null rect and there is nowhere to click. Dropping it
  // silently would tell a caller the page has fewer actionable elements
  // than it does, which is the failure mode this whole module inherited a
  // rule against from `a11y.ts`. So it is reported under the
  // `unpositioned` reason instead, which is deliberately not a budget
  // decision: re-capturing will not bring these back.
  let unpositioned = 0;
  for (const node of capture.nodes.values()) {
    if (interactive.get(node.backendNodeId) !== true) continue;
    if (node.rect === null) {
      unpositioned += 1;
      continue;
    }
    candidateIds.add(node.backendNodeId);
  }

  const occludedById = computeOcclusion(capture, candidateIds);

  const candidates: Candidate[] = [];
  for (const id of candidateIds) {
    const node = capture.nodes.get(id);
    if (node === undefined || node.rect === null) continue; // defensive; candidateIds is already filtered to this shape.
    candidates.push({
      node,
      rect: node.rect,
      inViewport: intersectsViewport(node.rect, capture),
      occluded: occludedById.get(id) ?? null,
      docOrder: docOrder.get(id) ?? 0,
    });
  }

  const total = candidates.length;

  // The priority order: in-viewport first, then descending paint order
  // (missing paint order sorts as lowest priority, matching
  // `occlusion.ts`'s own convention for the same missing value), then
  // document order.
  candidates.sort((a, b) => {
    if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
    const pa = a.node.paintOrder ?? Number.NEGATIVE_INFINITY;
    const pb = b.node.paintOrder ?? Number.NEGATIVE_INFINITY;
    if (pa !== pb) return pb - pa;
    return a.docOrder - b.docOrder;
  });

  const nodes: PageMapNode[] = [];
  // `unpositioned` is seeded from candidate selection above rather than
  // starting at zero. Those nodes are dropped before the byte ceiling is
  // ever consulted, so they are not a budget casualty, but they ARE a drop
  // and the caller is entitled to know the count.
  const truncatedByReason: Record<PageMapTruncationReason, number> = {
    offscreen: 0,
    onscreen: 0,
    unpositioned,
  };
  let bytes = 2; // '[' + ']'
  let truncated = false;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as Candidate;
    if (truncated) {
      truncatedByReason[candidate.inViewport ? 'onscreen' : 'offscreen'] += 1;
      continue;
    }
    const wireNode = toWireNode(candidate, capture);
    const size = utf8ByteLength(JSON.stringify(wireNode)) + (i > 0 ? 1 : 0);
    if (bytes + size > maxResultBytes) {
      truncated = true;
      truncatedByReason[candidate.inViewport ? 'onscreen' : 'offscreen'] += 1;
      continue;
    }
    bytes += size;
    nodes.push(wireNode);
  }

  return { nodes, total, truncated, truncatedByReason };
}
