/**
 * `pagemap/frames.ts`: sends `Page.getFrameTree`, names the CDP session
 * each frame is reachable on, and computes the coordinate offset that
 * lifts a frame's own document-space rects into the TOP document's
 * document space. Phase A; this file owns exactly one of the three phase A
 * commands (`DOMSnapshot.captureSnapshot` is `snapshot.ts`,
 * `DOM.getDocument` is `dom-tree.ts`, a sibling file this one does not
 * import from: this module needs no notion of "DOM node", only of
 * "frame").
 *
 * ── The contract `ax-merge.ts` depends on ─────────────────────────────────
 *
 * `ax-merge.ts` imports
 * {@link PageMapFrame} from this module and calls
 * `fullAccessibilityTree(bridge, frame.sessionId, frame.frameId)` once per
 * entry, with no null check on `sessionId`. That fixes two things about
 * this module's shape: `PageMapFrame` is
 * the flat, per-frame record this module returns (not a wrapped tree), and
 * `sessionId` on every entry is a SESSION THAT CAN ACTUALLY BE CALLED, not
 * merely "the frame's own session if it has one". For a same-process
 * frame, that means the session of whichever ancestor frame (up to and
 * including the main frame) actually renders it: `dom-tree.ts`'s own
 * `DOM.getDocument` pierces same-process children for free, so their
 * `Accessibility.getFullAXTree` read belongs on that same session too. A
 * frame this module cannot resolve a live session for (its own
 * out-of-process target died mid-enumeration, or its ancestor's did) is
 * left OUT of {@link CaptureFrameTreeOutcome.frames} entirely and reported
 * in {@link CaptureFrameTreeOutcome.failures} instead: an entry with no
 * session would violate the contract `ax-merge.ts` already depends on
 * rather than degrade gracefully within it.
 *
 * ── Bounds: a page can generate frames without limit ──────────────────────
 *
 * {@link PAGE_MAP_MAX_FRAME_DEPTH} and {@link PAGE_MAP_MAX_FRAME_COUNT}
 * cap the flatten below. Both values match browser-use's own precedent
 * (`browser_use/dom/service.py`'s `max_iframe_depth` default and its cross
 * origin iframe recursion guard), chosen for the same reason theirs are:
 * neither is measured against a real pathological page in this repo, but
 * "match a shipped system's already-chosen number" is a defensible
 * default where no measurement of our own exists, and is a documented
 * choice rather than an unstated one. Depth is checked
 * before a frame's children are enumerated (a frame AT the cap is kept,
 * its children are not); count is checked before a frame is added (once
 * {@link PAGE_MAP_MAX_FRAME_COUNT} frames are kept, enumeration stops
 * outright, mid-sibling-list if that is where the cap lands). Frames
 * dropped by either cap are silently absent from the result, not reported
 * per-frame: a page that floods frames should not flood the failure list
 * too. {@link CaptureFrameTreeOutcome.truncated} says only whether either
 * cap fired, not which, matching `queryAccessibilityTree`'s own single
 * `truncated` boolean for its own two-stage cap in `accessibility.ts`.
 *
 * ── The offset: document-space composition, no live-scroll dependency ────
 *
 * The page map's design already decided the representation this module's
 * offset feeds: `PageMapNodeRecord.rect` is stored in
 * DOCUMENT space, specifically so a scroll costs zero recapture. That
 * decision is why this module's offset math is NOT browser-use's. Their
 * `_construct_enhanced_node` (`browser_use/dom/service.py:880` onward)
 * SUBTRACTS each document's own current scroll while descending
 * (`total_frame_offset.x -= snapshot_data.scrollRects.x`, right after
 * appending an HTML frame node) and ADDS each iframe owner's bounds
 * (`total_frame_offset.x += snapshot_data.bounds.x`), because their final
 * `absolute_position` is deliberately the element's CURRENT on-screen
 * position relative to the top page's PRESENT scroll: they rebuild the
 * whole tree every step (one gather per call, no cache anywhere in the
 * path), so baking the
 * live scroll in costs them nothing extra and saves a later step. This
 * design caches, so baking live scroll into a stored offset would be
 * exactly wrong: it would go stale the instant either the top page or an
 * intermediate frame scrolled, silently, with nothing to invalidate it.
 *
 * The offset this module computes is instead purely ADDITIVE across
 * document-space quantities, with NO scroll subtraction at all for the
 * top frame and for every same-process descendant of it, matching the
 * "rects survive a scroll" guarantee the page map already promises for the
 * top document and extending it through the frame tree rather than
 * special-casing the top frame alone:
 *
 * ```
 * offset(mainFrame) = (0, 0)
 * offset(F) = offset(parent(F)) + ownerRect(F)
 * ```
 *
 * where `ownerRect(F)` is the position of `F`'s `<iframe>`/`<frame>` OWNER
 * element within its OWN parent document's document space (the top-left of
 * the iframe's content box, unaffected by any frame's current scroll).
 * `ownerRect(F)` is obtained from CDP commands this module owns outright
 * rather than borrowed from `snapshot.ts`'s decode (parallel build, no
 * shared code between the two yet): `DOM.getFrameOwner({frameId})` on
 * `F`'s PARENT's own resolved session names the owner element's
 * `backendNodeId`; `DOM.getBoxModel({backendNodeId})` on that SAME session
 * gives its content quad, which `hit-test.ts` already establishes is
 * VIEWPORT-relative CSS px within whatever session it is called on (that
 * module's own doc: "in viewport CSS px", derived from `getBoxModel`
 * exactly the way this module reuses it); `Page.getLayoutMetrics` on that
 * SAME session supplies the CURRENT scroll of the PARENT's own document
 * (`cssVisualViewport.pageX`/`pageY`, the CSS-pixel field, never the
 * device-pixel `visualViewport` one; mixing the two would smuggle in
 * exactly the DPR multiplier `packages/core/src/input/coordinates.ts:5`
 * and `types.ts` both forbid), which is what converts that viewport-relative
 * quad back into the PARENT's own document space: `ownerRect(F) =
 * getBoxModel(F's owner) + parentScrollAtCapture`. Composed one level at a
 * time up the chain, `parentScrollAtCapture` cancels out of the final sum
 * for any node that is not itself the LAST frame boundary crossed, which
 * is exactly why the top-level guarantee (a rect surviving a scroll) is
 * preserved: what is added is always "where the boundary sat in its own
 * parent's un-scrolled document", never "where it currently appears".
 *
 * ── MEASURED: an out-of-process frame's own scroll, as a PARENT ──────────
 *
 * This used to be unmeasured: an offset through a cross-origin iframe that
 * scrolled internally is correct only if the frame's own scroll position
 * is known. The question, precisely: does `Page.getLayoutMetrics`, called on an
 * OUT-OF-PROCESS iframe's OWN CDP session, report that frame's scroll the
 * same way it reports the main session's (trusted precedent already in
 * production: `packages/server/src/session/managed-session.ts`'s
 * `queryRealViewport` and `screenshotTarget` both already read
 * `Page.getLayoutMetrics` off an ordinary page session), or does an
 * OOPIF's own renderer report something that needs a DIFFERENT correction
 * this module does not apply. THIS IS NOW MEASURED. The probe this doc used
 * to describe is `examples/nextjs-demo/pagemap-frame-scroll-probe.mjs`: a
 * real cross-origin fixture (two loopback IPs, `--site-per-process` forced
 * on), a 400px `window.scrollTo` inside the child's own execution context,
 * and three independently-taken readings on the child's own session that
 * all agreed exactly, on every one of four consecutive runs: ground-truth
 * `window.scrollY`, a `DOM.getBoxModel` delta on an in-flow marker element,
 * and `Page.getLayoutMetrics`'s `cssVisualViewport.pageY` (the exact field
 * {@link currentScroll} reads below) alongside its `cssLayoutViewport.pageY`
 * sibling. The composed top-document pixel, built from the CDP-reported
 * scroll, landed on the identical value as the same pixel built from the
 * ground-truth scroll. Separately, the PARENT's own `DOM.getBoxModel` read
 * of the iframe OWNER element was unchanged before and after the child
 * scrolled internally, ruling out the double-counting failure mode in the
 * other direction. VERDICT: `Page.getLayoutMetrics` on an out-of-process
 * session reports that frame's own scroll correctly, and this module's
 * offset math, where it runs, is right as written for the out-of-process
 * case.
 *
 * What this measurement means for {@link PageMapFrame.scrollOffsetKnown}:
 * the code below used to compute it as `parentScrollKnown && !parentIsOop`,
 * conservatively `false` for any frame sitting inside an out-of-process
 * parent, purely because `currentScroll()` on an out-of-process session was
 * an unmeasured risk. It no longer is, so that carve-out is gone: the flag
 * is now exactly `parentScrollKnown`, tracking only whether every ancestor's
 * OFFSET computation actually succeeded, never whether an ancestor happens
 * to be out-of-process.
 *
 * Tracked through to its conclusion, that leaves no live path to `false`.
 * This module does not include a frame with a partially-trusted offset: a
 * frame whose own geometry read fails, or whose parent's did, is excluded
 * from {@link CaptureFrameTreeOutcome.frames} outright (a
 * {@link PageMapPhaseFailure} instead; see "Degradation" below), never
 * entered with the flag held down. So for every frame this module actually
 * returns, `parentScrollKnown` traces back to `mainFrameId`, seeded `true`,
 * with nothing left able to flip it along the way, and the field is `true`
 * on every entry. That makes it a flag nothing can currently act on: a
 * reasonable next step, for whoever owns the cross-package call (this
 * module's own {@link PageMapFrame} plus `capture.ts`'s `FrameOffset`, which
 * only reads the field, plus any protocol-level "position confidence"
 * decision `capture.ts`'s own doc already defers), is to delete it rather
 * than keep a boolean that can never observe a second value. That deletion
 * is not made here, the same "give it its own reviewed commit" reason the
 * measurement itself was kept separate from a code change.
 *
 * THE MORE URGENT PROBLEM THE SAME PROBE FOUND: the scroll question above
 * is correct but, for a genuinely cross-origin frame, may never be reached
 * at all. The same probe run measured, on every run, that the PARENT
 * session's own `Page.getFrameTree`
 * never lists the out-of-process child in `childFrames` at all, not as an
 * empty array, no entry whatsoever. {@link flattenFrameTree} walks exactly
 * that field, recursively, to build the list {@link captureFrameTree}'s own
 * pre-order pass then computes every offset against. An out-of-process
 * frame is invisible to that walk before this section's own scroll question
 * is ever reached: it is not entered with an unknown offset and it does not
 * get a {@link PageMapPhaseFailure} entry either, it is simply never
 * enumerated, which means a caller cannot even tell the frame was skipped.
 * `ax-merge.ts` and every other Phase B reader only ever sees what is
 * already in {@link CaptureFrameTreeOutcome.frames}, so today a cross-origin
 * iframe's content is likely ABSENT from a page map outright, not
 * mispositioned. This module already builds `oopSessionByFrameId` below
 * from `registry.all()` for a different reason (naming the session an
 * already-discovered frame's entry should use); the same map, keyed by
 * frame id, is also exactly what discovery is currently missing, and
 * splicing out-of-process children into the flattened list from that source
 * (rather than assuming `Page.getFrameTree` already nested them) is what a
 * fix needs to do. That fix is out of scope for this doc update as well,
 * for the same "give a coordinate-and-discovery change its own reviewed
 * commit" reason above, and is the more pressing of the two follow-ups.
 *
 * ── The epoch input ────────────────────────────────────────────────────
 *
 * `page.map.got`'s `epoch` is minted per capture from the CDP session id
 * and the `loaderId` of the main frame. Combining those two into the actual
 * epoch string is `index-assign.ts`'s job; this module's
 * job stops at exposing the main frame's `loaderId` cleanly, which
 * {@link CaptureFrameTreeOutcome.mainLoaderId} does, read straight off
 * `Page.getFrameTree`'s own reply with no further processing.
 *
 * ── Degradation: a frame that cannot be read degrades that frame ────────
 *
 * Every per-frame CDP read below (`DOM.getFrameOwner`, `DOM.getBoxModel`,
 * `Page.getLayoutMetrics`) is wrapped so a failure produces exactly one
 * `PageMapPhaseFailure` (`phase: 'frameTree'`, that frame's id) and skips
 * only that frame (and, necessarily, its descendants, since a
 * descendant's offset is defined in terms of its parent's: a frame whose
 * OWN offset failed to compute is not entered into `offsets`, so any child
 * of it fails the same "parent offset available" check and gets its own
 * failure entry rather than a silently wrong one built on a missing value).
 * `Page.getFrameTree` itself failing outright is fatal to this call (and
 * to the whole capture): with no
 * frame tree there is no frame list and no main frame `loaderId`, so
 * nothing below can run at all.
 *
 * ── Concurrency and complexity ────────────────────────────────────────────
 *
 * Deliberately sequential, in one pre-order pass over the flattened,
 * capped frame list: each frame's offset is defined in terms of its
 * parent's, already-computed value, a genuine dependency chain, not merely
 * an implementation choice, for every frame ON THE SAME ROOT-TO-LEAF PATH.
 * Sibling frames at the same depth ARE independent of each other and could
 * run concurrently (the way `ax-merge.ts`'s `PAGEMAP_AX_CONCURRENCY_CAP`
 * fans out per-frame accessibility reads), but this module does not,
 * because {@link PAGE_MAP_MAX_FRAME_COUNT} already bounds the total work
 * at 100 frames of three cheap commands each, and adding a bounded-fan-out
 * pool here would be exactly the kind of unmeasured complexity nobody has a
 * number to justify. One pass, O(frames) CDP round trips (three per
 * non-main frame), O(frames) space for the index and the offset map.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { TargetRegistry } from '../cdp/target-registry.js';
import type { CdpSessionId } from '../cdp/types.js';
import type { PageMapPhaseFailure } from './types.js';

/**
 * Depth cap on the frame tree flatten below. Matches browser-use's own
 * `max_iframe_depth` default (`browser_use/dom/service.py`); see this
 * module's own doc, "Bounds", for why that precedent rather than a number
 * measured in this repo.
 */
export const PAGE_MAP_MAX_FRAME_DEPTH = 5;

/**
 * Total frame count cap across the whole flatten, main frame included.
 * Matches browser-use's own cross-origin iframe recursion guard
 * precedent; see this module's own doc, "Bounds".
 */
export const PAGE_MAP_MAX_FRAME_COUNT = 100;

/**
 * One frame this capture can act on: exactly the shape `ax-merge.ts`
 * already imports and calls `fullAccessibilityTree(bridge, frame.sessionId,
 * frame.frameId)` against with no null check, plus the offset fields
 * `capture.ts` needs to place that frame's own rects in the top document's
 * space. See this module's own doc, "The contract `ax-merge.ts` depends
 * on".
 */
export interface PageMapFrame {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  /** Chrome's own frame-navigation id, `null` only if `Page.getFrameTree` omitted it (never observed, tolerated defensively). */
  readonly loaderId: string | null;
  readonly url: string;
  /** 0 for the main frame, incrementing per nesting level, capped at {@link PAGE_MAP_MAX_FRAME_DEPTH}. */
  readonly depth: number;
  /** `true` when this frame has its own out-of-process CDP target (`TargetRegistry`, `type: 'iframe'`). `false` for the main frame and for a same-process child, which is reachable instead through `dom-tree.ts`'s `contentDocument` walk on an ancestor's session. */
  readonly outOfProcess: boolean;
  /**
   * A session THIS frame's own content, and any accessibility read scoped
   * to `frameId`, can actually be sent on: this frame's own session if
   * {@link outOfProcess}, otherwise the nearest out-of-process ancestor's
   * session, otherwise the main session. Never `null`: a frame this
   * module cannot resolve a live session for is left out of the result
   * entirely (see this module's own doc).
   */
  readonly sessionId: CdpSessionId;
  /** Cumulative document-space offset to ADD to one of this frame's own document-space rects to place it in the TOP document's document space. `(0, 0)` for the main frame. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Whether every ancestor's own offset computation, up to the main frame, actually succeeded. Currently `true` for every frame this module returns: see this module's own doc, "MEASURED: an out-of-process frame's own scroll, as a PARENT", for what changed and why nothing left in this module sets it `false` for an entry that is actually present. */
  readonly scrollOffsetKnown: boolean;
}

/** What {@link captureFrameTree} returns. */
export interface CaptureFrameTreeOutcome {
  readonly mainFrameId: string;
  /** The main frame's own `loaderId`, exposed cleanly for `index-assign.ts` to mint the capture epoch from. See this module's own doc, "The epoch input". */
  readonly mainLoaderId: string | null;
  /** Every frame this module could resolve BOTH a session and an offset for, main frame first, otherwise in the order `Page.getFrameTree` returned them (a valid pre-order: a parent is always listed before its children). */
  readonly frames: readonly PageMapFrame[];
  /** One entry per frame that could not be read: an out-of-process session that died, or a `DOM.getFrameOwner`/`DOM.getBoxModel`/`Page.getLayoutMetrics` failure while computing that frame's offset. */
  readonly failures: readonly PageMapPhaseFailure[];
  /** `true` when {@link PAGE_MAP_MAX_FRAME_DEPTH} or {@link PAGE_MAP_MAX_FRAME_COUNT} cut the enumeration short. See this module's own doc, "Bounds". */
  readonly truncated: boolean;
}

/** Raw shape of one `Page.getFrameTree` node. */
interface RawFrameTreeNode {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly loaderId?: string;
    readonly url: string;
  };
  readonly childFrames?: readonly RawFrameTreeNode[];
}

/** One flattened frame, before a session or an offset has been resolved for it. */
interface FlatFrame {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly loaderId: string | null;
  readonly url: string;
  readonly depth: number;
}

/**
 * Pre-order flatten of `Page.getFrameTree`'s reply, capped by
 * {@link PAGE_MAP_MAX_FRAME_DEPTH} and {@link PAGE_MAP_MAX_FRAME_COUNT}.
 * Iterative (an explicit stack, children pushed in reverse so they pop
 * back out left-to-right) for the same reason `dom-tree.ts` walks
 * iteratively: an attacker-controlled page nests things, and this walk's
 * own call stack should never be what gives first.
 */
function flattenFrameTree(
  root: RawFrameTreeNode,
  rootParentFrameId: string | null = null,
  rootDepth = 0,
): { frames: FlatFrame[]; truncated: boolean } {
  const frames: FlatFrame[] = [];
  let truncated = false;
  // The two parameters default to the main frame's case, a root with no
  // parent at depth 0. They are passed explicitly when splicing an out of
  // process subtree, whose root DOES have a parent and sits at whatever
  // depth that parent reached. See `captureFrameTree`.
  const stack: Array<{ node: RawFrameTreeNode; parentFrameId: string | null; depth: number }> = [
    { node: root, parentFrameId: rootParentFrameId, depth: rootDepth },
  ];

  while (stack.length > 0) {
    const item = stack.pop() as {
      node: RawFrameTreeNode;
      parentFrameId: string | null;
      depth: number;
    };
    if (frames.length >= PAGE_MAP_MAX_FRAME_COUNT) {
      truncated = true;
      break;
    }
    frames.push({
      frameId: item.node.frame.id,
      parentFrameId: item.parentFrameId,
      loaderId: item.node.frame.loaderId ?? null,
      url: item.node.frame.url,
      depth: item.depth,
    });

    if (item.depth >= PAGE_MAP_MAX_FRAME_DEPTH) {
      if (item.node.childFrames !== undefined && item.node.childFrames.length > 0) truncated = true;
      continue;
    }
    const children = item.node.childFrames;
    if (children !== undefined) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({
          node: children[i] as RawFrameTreeNode,
          parentFrameId: item.node.frame.id,
          depth: item.depth + 1,
        });
      }
    }
  }

  return { frames, truncated };
}

/** The axis-aligned bounding box of `DOM.getBoxModel`'s eight-number content quad, in whatever session it was called on. Duplicated from `hit-test.ts` rather than imported: that module does not export it, matching the precedent `accessibility.ts` already states for its own `utf8ByteLength` ("duplicated rather than shared: that module is not exported for reuse"). */
function rectFromQuad(quad: unknown): { x: number; y: number } | null {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < 8; i += 2) {
    const x = quad[i] as unknown;
    const y = quad[i + 1] as unknown;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return null;
    xs.push(x);
    ys.push(y);
  }
  return { x: Math.min(...xs), y: Math.min(...ys) };
}

/**
 * `Page.getLayoutMetrics` on `sessionId`, read for the CSS-pixel scroll
 * position of the document that session renders. `cssVisualViewport` only
 * (never the device-pixel `visualViewport` sibling field), per this
 * module's own doc on why mixing the two would smuggle in a DPR
 * multiplier this codebase forbids everywhere in the pagemap coordinate
 * chain. Throws (propagates the CDP failure or a "no field" `Error`)
 * rather than defaulting to `(0, 0)`: a caller silently getting `(0, 0)`
 * for a document that is actually scrolled would be exactly the invented,
 * unverified offset this module's own doc says not to produce.
 */
async function currentScroll(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  timeoutMs: number,
): Promise<{ x: number; y: number }> {
  const metrics = (await bridge.send('Page.getLayoutMetrics', undefined, sessionId, {
    timeoutMs,
  })) as {
    cssVisualViewport?: { pageX?: number; pageY?: number };
  };
  const vp = metrics.cssVisualViewport;
  if (vp === undefined || typeof vp.pageX !== 'number' || typeof vp.pageY !== 'number') {
    throw new Error('Page.getLayoutMetrics returned no cssVisualViewport scroll position');
  }
  return { x: vp.pageX, y: vp.pageY };
}

/**
 * Sends `Page.getFrameTree` on `sessionId` (the caller's main session),
 * then names a live CDP session and a document-space offset for every
 * frame the flatten keeps. See this module's own doc for the offset math,
 * the out-of-process scroll caveat, and the degradation policy.
 *
 * `timeoutMs` bounds EVERY CDP call this function makes (`Page.getFrameTree`
 * plus, per non-main frame, `DOM.getFrameOwner`, `DOM.getBoxModel` and
 * `Page.getLayoutMetrics`), passed as an explicit `SendOptions.timeoutMs`
 * override on each one, the same "do not add a `TIMEOUT_TABLE` entry"
 * discipline `dom-tree.ts` follows for `DOM.getDocument`: none of these
 * four methods has another caller in this codebase that a shared table
 * entry could accidentally over- or under-budget.
 */
export async function captureFrameTree(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  registry: TargetRegistry,
  timeoutMs: number,
): Promise<CaptureFrameTreeOutcome> {
  const raw = (await bridge.send('Page.getFrameTree', undefined, sessionId, { timeoutMs })) as {
    frameTree?: RawFrameTreeNode;
  };
  const tree = raw.frameTree;
  if (tree === undefined) {
    throw new Error('Page.getFrameTree returned no frameTree');
  }

  const { frames: flat, truncated: flattenTruncated } = flattenFrameTree(tree);
  let truncated = flattenTruncated;
  const mainFrameId = tree.frame.id;
  const mainLoaderId = tree.frame.loaderId ?? null;
  // Declared here rather than below the index maps, because the out of
  // process splice further down records degradations into it.
  const failures: PageMapPhaseFailure[] = [];

  // Out-of-process session lookup, one pass over the registry rather than
  // one `TargetRegistry.get`-shaped call per frame: `TargetRegistry` has
  // no "find by mainFrameId" accessor, so this module builds its own
  // one-shot index instead of scanning `registry.all()` once per frame
  // (which would make frame enumeration O(frames * targets) for no
  // reason).
  const oopSessionByFrameId = new Map<string, CdpSessionId>();
  for (const target of registry.all()) {
    if (target.type === 'iframe' && target.mainFrameId !== null && target.cdpSessionId !== null) {
      oopSessionByFrameId.set(target.mainFrameId, target.cdpSessionId as CdpSessionId);
    }
  }

  // Splice in the out-of-process subtrees, because the parent's own tree
  // does not contain them.
  //
  // Measured, by `examples/nextjs-demo/pagemap-frame-scroll-probe.mjs`:
  // the parent session's `Page.getFrameTree` does NOT list an out of
  // process child in `childFrames`, on every run. `flattenFrameTree` walks
  // exactly that field, so before this loop an out of process frame was
  // never enumerated at all, and not as a failure either, it was simply
  // absent. Everything downstream that keys off a frame, the per session
  // snapshot and the per frame accessibility read included, therefore had
  // nothing to act on for cross origin content.
  //
  // The linkage the parent's tree omits is carried by the child itself: an
  // out of process frame's OWN session answers `Page.getFrameTree` with a
  // root whose `parentId` names the frame that owns it. So one call per
  // out of process session recovers both the subtree and where it belongs.
  //
  // The loop repeats to a fixpoint rather than running once, because an
  // out of process frame can itself contain another one, and a child's
  // depth is only computable once its parent has been placed. It is
  // bounded three ways: at most one CDP call per registered out of process
  // target, at most that many passes, and the same
  // {@link PAGE_MAP_MAX_FRAME_COUNT} and {@link PAGE_MAP_MAX_FRAME_DEPTH}
  // caps the main flatten already enforces.
  const pendingOop = new Map<string, RawFrameTreeNode>();
  for (const [oopFrameId, oopSession] of oopSessionByFrameId) {
    if (flat.some((f) => f.frameId === oopFrameId)) continue;
    try {
      const rawOop = (await bridge.send('Page.getFrameTree', undefined, oopSession, {
        timeoutMs,
      })) as {
        frameTree?: RawFrameTreeNode;
      };
      if (rawOop.frameTree !== undefined) pendingOop.set(oopFrameId, rawOop.frameTree);
    } catch (err) {
      // One unreachable out of process frame degrades that frame only. It
      // must not fail the capture, and it must not vanish silently either,
      // which is the whole failure mode this module inherited a rule
      // against.
      failures.push({
        phase: 'frameTree',
        reason: err instanceof Error ? err.message : String(err),
        frameId: oopFrameId,
      });
    }
  }

  for (let pass = 0; pass < pendingOop.size && pendingOop.size > 0; pass += 1) {
    let placedThisPass = false;
    for (const [oopFrameId, subtree] of [...pendingOop]) {
      const parentId = subtree.frame.parentId;
      const parent = parentId === undefined ? undefined : flat.find((f) => f.frameId === parentId);
      if (parent === undefined) continue;
      pendingOop.delete(oopFrameId);
      placedThisPass = true;
      if (parent.depth >= PAGE_MAP_MAX_FRAME_DEPTH || flat.length >= PAGE_MAP_MAX_FRAME_COUNT) {
        truncated = true;
        continue;
      }
      const sub = flattenFrameTree(subtree, parentId, parent.depth + 1);
      if (sub.truncated) truncated = true;
      for (const f of sub.frames) {
        if (flat.length >= PAGE_MAP_MAX_FRAME_COUNT) {
          truncated = true;
          break;
        }
        flat.push(f);
      }
    }
    if (!placedThisPass) break;
  }
  // Anything still pending has a parent that was never enumerated, which
  // means its own parent chain is broken or was truncated. Reported, not
  // dropped in silence.
  for (const [oopFrameId] of pendingOop) {
    failures.push({
      phase: 'frameTree',
      reason: 'out of process frame has no enumerated parent frame',
      frameId: oopFrameId,
    });
  }

  // `sessionOf`/`scrollKnownOf` are filled in alongside `offsets` below, in
  // the same pre-order pass: a frame's session and its ancestors' offset
  // trust are both resolved before any of its children are visited,
  // because `flat` is already a valid pre-order (parents before children;
  // see {@link flattenFrameTree}).
  const sessionOf = new Map<string, CdpSessionId>([[mainFrameId, sessionId]]);
  const scrollKnownOf = new Map<string, boolean>([[mainFrameId, true]]);
  const offsets = new Map<string, { x: number; y: number }>([[mainFrameId, { x: 0, y: 0 }]]);
  const frames: PageMapFrame[] = [];

  for (const f of flat) {
    if (f.frameId === mainFrameId) {
      frames.push({
        frameId: mainFrameId,
        parentFrameId: null,
        loaderId: mainLoaderId,
        url: f.url,
        depth: 0,
        outOfProcess: false,
        sessionId,
        offsetX: 0,
        offsetY: 0,
        scrollOffsetKnown: true,
      });
      continue;
    }

    const parentId = f.parentFrameId as string; // every non-main frame has a parent, by construction of the flatten
    const parentSessionId = sessionOf.get(parentId);
    const parentOffset = offsets.get(parentId);
    const parentScrollKnown = scrollKnownOf.get(parentId);
    if (
      parentSessionId === undefined ||
      parentOffset === undefined ||
      parentScrollKnown === undefined
    ) {
      // The parent itself failed (session or offset), so nothing here can
      // be trusted either; one failure entry per unreachable frame, not a
      // cascade of misleading detail about which upstream step caused it.
      failures.push({
        phase: 'frameTree',
        reason: 'ancestor frame session or offset unavailable',
        frameId: f.frameId,
      });
      continue;
    }

    const oopSessionId = oopSessionByFrameId.get(f.frameId);
    const outOfProcess = oopSessionId !== undefined;
    const frameSessionId = outOfProcess ? oopSessionId : parentSessionId;

    try {
      const owner = (await bridge.send(
        'DOM.getFrameOwner',
        { frameId: f.frameId },
        parentSessionId,
        {
          timeoutMs,
        },
      )) as { backendNodeId?: number };
      if (owner.backendNodeId === undefined) {
        throw new Error('DOM.getFrameOwner returned no backendNodeId');
      }
      const box = (await bridge.send(
        'DOM.getBoxModel',
        { backendNodeId: owner.backendNodeId },
        parentSessionId,
        {
          timeoutMs,
        },
      )) as { model?: { content?: unknown } };
      const quad = rectFromQuad(box.model?.content);
      if (quad === null) {
        throw new Error('DOM.getBoxModel returned no content quad (frame owner has no layout)');
      }
      const scroll = await currentScroll(bridge, parentSessionId, timeoutMs);

      const offsetX = parentOffset.x + quad.x + scroll.x;
      const offsetY = parentOffset.y + quad.y + scroll.y;
      // Whether every ancestor's own offset computation succeeded, this
      // frame's included. An out-of-process PARENT's own `currentScroll`
      // read used to be excluded from that trust (forced `false` here
      // regardless of `parentScrollKnown`) because it was unmeasured; see
      // this module's own doc, "MEASURED: an out-of-process frame's own
      // scroll, as a PARENT", for why that carve-out is gone. Nothing else
      // in this function currently sets this `false` for a frame that
      // reaches `frames`: a frame whose OWN geometry read fails is excluded
      // entirely (the `catch` below), not included with the flag down, so
      // `parentScrollKnown` is `true` all the way from `mainFrameId` for
      // every entry this loop actually pushes.
      const scrollOffsetKnown = parentScrollKnown;

      sessionOf.set(f.frameId, frameSessionId);
      scrollKnownOf.set(f.frameId, scrollOffsetKnown);
      offsets.set(f.frameId, { x: offsetX, y: offsetY });

      frames.push({
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        loaderId: f.loaderId,
        url: f.url,
        depth: f.depth,
        outOfProcess,
        sessionId: frameSessionId,
        offsetX,
        offsetY,
        scrollOffsetKnown,
      });
    } catch (err) {
      failures.push({
        phase: 'frameTree',
        reason: err instanceof Error ? err.message : String(err),
        frameId: f.frameId,
      });
    }
  }

  return { mainFrameId, mainLoaderId, frames, failures, truncated };
}
