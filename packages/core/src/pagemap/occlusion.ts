/**
 * The paint-order occlusion pass: for each candidate node (an element
 * `interactivity.ts` judged actionable), answer whether it is entirely
 * hidden behind something painted on top of it, while testing far fewer
 * rectangles than a naive pass.
 *
 * Geometry only. The disjoint covering set is `rect-union.ts`, already
 * built and tested; this module is the walk that drives it and decides,
 * per node, whether it belongs in that set at all.
 *
 * ── The algorithm ─────────────────────────────────────────────────────────
 *
 * Walk every painted node in DESCENDING paint order (nearest the viewer
 * first). At each node: if it is a requested candidate, ask the union
 * built so far (everything nearer the viewer already visited) whether it
 * already fully covers this node's rect. Then, if the node is opaque
 * enough to paint over what is behind it, add its rect to the union so it
 * can occlude nodes visited later in the walk. A candidate is therefore
 * always tested against exactly the set of things that paint above it,
 * never against itself or against anything below it.
 *
 * ── Candidates only ─────────────────────────────────────────────────────
 *
 * The numbers: testing every painted node
 * against a full union costs roughly 25 million intersection tests in the
 * worst case (5000 painted nodes, each tested against a union of size up
 * to 5000); testing candidates only, with viewport clipping, drops that to
 * roughly 1.5 million (300 candidates against the same capped union). This
 * module hits that by construction: `RectUnion.contains` (the O(m) test)
 * is called only for ids present in `candidateIds`, never for every
 * painted node. Complexity achieved: building the union is O(P) `add`
 * calls each O(m) against a union capped at `MAX_RECTS` (`rect-union.ts`),
 * so O(P * m) worst case; testing is O(C * m) for C candidates. At the cap
 * (m = 5000) with a typical few thousand painted nodes and a few hundred
 * candidates, the dominant cost is the union build, not the candidate
 * test, and both are the same order `rect-union.ts` itself documents:
 * "each visit multiplying the pending piece count by up to 4" per `add` or
 * `contains` call. This is the same asymptotic shape as browser-use's
 * `RectUnionPure`; the win here is entirely in NOT
 * calling `contains` for the ~4700 non-candidate painted nodes their loop
 * tests and this one does not.
 *
 * ── Viewport clipping ─────────────────────────────────────────────────────
 *
 * `PageMapNodeRecord.rect` is document space (`types.ts`), so a node whose
 * rect never reaches the viewport rectangle (`scrollX`/`scrollY` to
 * `scrollX + viewportWidth`/`scrollY + viewportHeight`, from
 * `PageMapCapture`) cannot occlude anything on screen and cannot itself be
 * seen, and is dropped before it reaches the union or a candidate test.
 * A node whose rect only partly reaches the viewport is clipped to the
 * visible portion before either use, so the union never grows on area
 * nobody can see and a candidate's containment test is answered for the
 * part of it that could actually be clicked.
 *
 * ── Two rules carried over from browser-use, both about what "opaque
 *    enough to occlude" means ───────────────────────────────────────────
 *
 * `dom/serializer/paint_order.py` (reference, not imported) excludes a
 * node from the union on two conditions: an exactly transparent
 * `background-color` (`rgba(0, 0, 0, 0)`), and an `opacity` computed style
 * below a threshold. Both carry over here, generalised from their literal
 * string match to an actual alpha-channel read (`backgroundAlphaOf`) so a
 * differently-formatted but still-transparent colour (e.g. an explicit
 * zero alpha with different rgb channels, or CSS Color 4's slash syntax)
 * is caught too, not just their one canonical serialisation.
 *
 * Both functions below default a MISSING style value to that property's
 * real CSS initial value rather than to "unknown, therefore excluded":
 * `opacity`'s initial value is `1` (fully opaque) and `background-color`'s
 * initial value is transparent. This is not a guess about the safe
 * direction, it is what the property actually computes to when nothing
 * sets it, and it is the same default browser-use's own reference reads
 * (`computed_styles.get('opacity', '1')` and
 * `computed_styles.get('background-color', 'rgba(0, 0, 0, 0)')`). Only a
 * PRESENT but unparseable string (which should not happen: CDP's computed
 * style read always serialises `opacity` to a plain number and
 * `background-color` to a resolvable colour) falls back to "does not
 * contribute", the direction that cannot manufacture a false occlusion.
 *
 * `OCCLUSION_OPACITY_THRESHOLD` is UNMEASURED. browser-use's own comment
 * on the equivalent constant calls it "highly vibes based", and this module
 * does not import a constant on that basis alone. The
 * value below (0.8, the same number) is kept only as a starting point, not
 * a derivation, because this module has no better one yet. What would
 * settle it: capture real overlays used for scrims and tooltips (a modal
 * backdrop is typically 0.4-0.6 opacity and is meant to let content show
 * through; a solid card or menu is typically 0.95-1) and check which side
 * of a candidate threshold they fall on against how an agent should treat
 * "is this covered".
 *
 * ── What this does and does not model ───────────────────────────────────
 *
 * Real occlusion is scoped per stacking context: a `z-index` only orders
 * elements against siblings of the same stacking context, and an element
 * in an entirely different one (a different iframe's document, or a
 * separate compositing layer) is not ordered against it by that number at
 * all. This pass uses CDP's own `paintOrder`, a single global integer
 * DevTools already assigns across the whole painted tree, as one flat
 * total order and does not attempt to model stacking contexts, frame
 * boundaries or compositing layers on top of it. That is an approximation,
 * not an exact per-context answer, and it is the same approximation the
 * browser-use's own pass makes.
 *
 * ── `null`: three distinct cases, none of them "visible" ────────────────
 *
 * `PageMapNode.occluded` is tristate (`packages/protocol/src/wire/messages/pagemap.ts`)
 * specifically so "not occluded" and "no answer" are never conflated. This
 * module answers `null`, never `false`, in exactly these cases:
 *
 * 1. The candidate has no rect at all (`PageMapNodeRecord.rect === null`).
 *    An unpositioned node cannot be tested for coverage.
 * 2. The candidate's rect does not reach the viewport (after clipping,
 *    nothing of it remains). It needs no occlusion answer because it is
 *    not visible on screen regardless of what paints above it.
 * 3. The union had already reached `MAX_RECTS` by the time this candidate
 *    was tested. Past the cap, `RectUnion.contains` itself already answers
 *    conservatively (`false`, never a wrongly-`true` cap-induced answer),
 *    but silently returning that `false` here would misreport "definitely
 *    not covered" as the reason, when the true reason is "some of the
 *    covering area could not be represented". This module checks the
 *    union's `size` before calling `contains` and reports `null` instead,
 *    so a caller can tell "provably visible" from "we ran out of budget to
 *    tell". Never the reverse: a saturated union never causes a `true`.
 *
 * Every other painted node, and every candidate not listed in
 * `candidateIds`, is absent from the returned map rather than forced to a
 * value; `capture.ts` is expected to only ask for candidates it wants an
 * answer for.
 */

import { MAX_RECTS, type Rect, RectUnion } from './rect-union.js';
import type { PageMapCapture, PageMapComputedStyle, PageMapNodeRecord } from './types.js';

/**
 * UNMEASURED starting value, not a derivation. See the module doc's
 * section on the two rules carried over from browser-use for what would
 * settle it. A node whose computed `opacity` is below this does not
 * contribute to the covering union, matching the sense (if not the exact
 * number) of a scrim that is meant to let content show through.
 */
export const OCCLUSION_OPACITY_THRESHOLD = 0.8;

/** One painted node prepared for the walk: its viewport-clipped rect, its walk position, and whether it is opaque enough to occlude. */
interface PaintedNode {
  readonly backendNodeId: number;
  readonly order: number;
  readonly clippedRect: Rect;
  readonly contributes: boolean;
}

/** The document-space viewport rectangle for this capture, or `null` if the capture carries no usable viewport (defensive: `capture.ts` always supplies one on a successful capture). */
function viewportRect(capture: PageMapCapture): Rect | null {
  const { scrollX, scrollY, viewportWidth, viewportHeight } = capture;
  if (
    !Number.isFinite(scrollX) ||
    !Number.isFinite(scrollY) ||
    !(viewportWidth > 0) ||
    !(viewportHeight > 0)
  ) {
    return null;
  }
  return { x: scrollX, y: scrollY, width: viewportWidth, height: viewportHeight };
}

/** The intersection of two rects, or `null` when they do not overlap (touching edges, per `rect-union.ts`'s own open-interval rule, do not count as overlap). */
function intersectRect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** `style.opacity`, defaulting to `1` (CSS's own initial value) when the style is missing entirely or the field itself is null. A present-but-unparseable string, which CDP should never produce, falls back to the same default. */
function opacityOf(style: PageMapComputedStyle | null): number {
  const raw = style?.opacity;
  if (raw == null) {
    return 1;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 1;
}

/**
 * The alpha channel (0 to 1) of `style.backgroundColor`, defaulting to `0`
 * (CSS's own initial value for `background-color` is transparent) when
 * the style is missing entirely or the field itself is null. A
 * present-but-unparseable string, which CDP should never produce for a
 * resolvable computed colour, also falls back to `0`: the safe direction
 * here is "not proven to paint anything", the same direction
 * `rect-union.ts` takes on a degenerate rect.
 */
function backgroundAlphaOf(style: PageMapComputedStyle | null): number {
  const raw = style?.backgroundColor;
  if (raw == null) {
    return 0;
  }
  const alpha = parseCssColorAlpha(raw);
  return alpha ?? 0;
}

/** Reads the alpha channel out of an `rgb(...)`/`rgba(...)` computed colour string, accepting comma or space/slash separated channels. `null` on anything unrecognised. */
function parseCssColorAlpha(color: string): number | null {
  const match = /^rgba?\(([^)]*)\)$/i.exec(color.trim());
  if (!match) {
    return null;
  }
  // `match[1]` and `channels[3]` are both indexed reads, and this package
  // compiles under `noUncheckedIndexedAccess`, so neither is narrowed by
  // the length checks around it. Bind them and test them rather than
  // asserting: an unparseable colour has to answer null, and a non null
  // assertion here would turn that into a crash on a page that ships a
  // colour string this regex did not anticipate.
  const body = match[1];
  if (body === undefined) {
    return null;
  }
  const channels = body.split(/[,\s/]+/).filter((part) => part.length > 0);
  if (channels.length === 3) {
    return 1; // rgb(): no alpha channel present, i.e. fully opaque
  }
  const raw = channels[3];
  if (raw === undefined) {
    return null;
  }
  const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** Whether `node` is opaque enough to occlude whatever is painted beneath it: both its own `opacity` and its background's alpha channel must clear their thresholds. */
function contributesToUnion(node: PageMapNodeRecord): boolean {
  if (opacityOf(node.style) < OCCLUSION_OPACITY_THRESHOLD) {
    return false;
  }
  return backgroundAlphaOf(node.style) > 0;
}

/**
 * Answers, for every id in `candidateIds`, whether that node is entirely
 * covered by something painted on top of it. See the module doc for the
 * algorithm, the viewport clipping, the two opacity/transparency rules,
 * and the three cases that produce `null` rather than `false`.
 *
 * Every requested id is present in the returned map. An id with no
 * matching node, no rect, or a rect the viewport never reaches answers
 * `null`, the same as the cap case: this module never has to choose
 * between silently dropping a candidate and guessing an answer for it.
 */
export function computeOcclusion(
  capture: PageMapCapture,
  candidateIds: ReadonlySet<number>,
): ReadonlyMap<number, boolean | null> {
  const result = new Map<number, boolean | null>();
  for (const id of candidateIds) {
    result.set(id, null);
  }

  const viewport = viewportRect(capture);
  if (viewport === null) {
    return result;
  }

  // A node with no `paintOrder` is placed as if painted first, i.e.
  // furthest from the viewer (`Number.NEGATIVE_INFINITY` sorts last in the
  // DESCENDING walk below). That is a deliberate choice, not an arbitrary
  // one: it means every node with a KNOWN paint order is already in the
  // union by the time an order-less node is tested, so its own occlusion
  // answer is the most complete one available, and it never gets to paint
  // over a node whose position is actually known and trusted.
  const painted: PaintedNode[] = [];
  for (const node of capture.nodes.values()) {
    if (node.rect === null) {
      continue; // no rect: cannot occlude, cannot be occluded
    }
    const clippedRect = intersectRect(node.rect, viewport);
    if (clippedRect === null) {
      continue; // entirely outside the viewport
    }
    const order = node.paintOrder ?? Number.NEGATIVE_INFINITY;
    painted.push({
      backendNodeId: node.backendNodeId,
      order,
      clippedRect,
      contributes: contributesToUnion(node),
    });
  }

  // Descending paint order: nearest the viewer first. `Array.prototype.sort`
  // is a stable sort in every engine this build targets, so nodes sharing
  // one paint order (including every order-less node, all pinned to
  // `-Infinity` above) keep their `capture.nodes` iteration order among
  // themselves; that order is not a claim about their real stacking
  // relationship, only a deterministic tie-break.
  painted.sort((a, b) => b.order - a.order);

  const union = new RectUnion();
  for (const node of painted) {
    if (candidateIds.has(node.backendNodeId)) {
      const occluded = union.size >= MAX_RECTS ? null : union.contains(node.clippedRect);
      result.set(node.backendNodeId, occluded);
    }
    if (node.contributes) {
      union.add(node.clippedRect);
    }
  }

  return result;
}
