/**
 * The capture orchestrator: phase order, the deadline, the concurrency cap (owned by
 * `ax-merge.ts`, not repeated here) and the degradation policy. This module
 * sends no CDP command of its own beyond the one exception documented
 * below ("The fourth call"); everything else is dispatch to the seven
 * phase modules plus the epoch mint from `index-assign.ts`.
 *
 * ── Phase order, as this file actually runs it ────────────────────────────
 *
 * Phase A, four commands in parallel under one shared deadline
 * (`req.timeoutMs`, default {@link DEFAULT_PAGEMAP_TIMEOUT_MS}):
 * `DOMSnapshot.captureSnapshot` (`snapshot.ts`, skipped when the request
 * did not ask for `'nodes'`; see "Text-only skips more than Phase B/C"
 * below), `DOM.getDocument` on the caller's own session (`dom-tree.ts`),
 * `Page.getFrameTree` (`frames.ts`), and `Page.getLayoutMetrics`
 * (`mainViewport` below, this file's one CDP call). All four are FATAL.
 * The first three are fatal because nothing downstream can work without
 * them (a snapshot, a DOM tree, a frame tree). The fourth is not one of the
 * three core phase-A commands (see "The fourth call" below), but the same
 * argument applies transitively: without a viewport, `occlusion.ts`
 * cannot answer anything and `budget.ts` cannot compute `inViewport` for a
 * single node, so a capture that "succeeded" without one would hand every
 * later stage silently wrong input rather than an honest failure.
 *
 * Then, still needing a live CDP session per additional frame: `dom-tree.ts`
 * AND `snapshot.ts` (`DOMSnapshot.captureSnapshot`, since GAP 1 closed; see
 * "Multi-session DOM tree AND snapshot merge" below) run again once per
 * DISTINCT out-of-process session `frames.ts` named, this is NOT one of
 * the three parallel phase-A commands; it depends on phase A's own frame
 * tree result to know which sessions exist, so it cannot start before
 * phase A finishes. A per-session failure here DEGRADES (drops that
 * session's nodes, records one `PageMapPhaseFailure`), unlike the main
 * session's `DOM.getDocument`/`DOMSnapshot.captureSnapshot` calls above:
 * `dom-tree.ts`'s own module doc states plainly that this fatal-vs-degrade
 * split is "the caller's decision, not this module's", and this is that
 * decision, made once, in one place.
 *
 * Phase B: `mergeAccessibility` (`ax-merge.ts`), fanning out one
 * `Accessibility.getFullAXTree` per frame at its own concurrency cap.
 * Skipped entirely when the request did not ask for `'nodes'`.
 *
 * Phase C: `mintClickListenerNodes` (`listeners.ts`), ONE call on the
 * caller's own main session. See "Listeners: one call, main session only"
 * below for why this phase does not fan out across frames the way Phase B
 * does. Skipped when the request did not ask for `'nodes'`, or when
 * `req.listeners` is explicitly `false`.
 *
 * Phase D, the merge only: joins the DOM tree(s), the snapshot, the
 * accessibility read and the listener signal into one flat
 * `PageMapNodeRecord` map and returns the finished {@link PageMapCapture}.
 * The REST of Phase D ("cascade, occlusion, index assignment, budget,
 * serialize") is
 * deliberately NOT done here: `budget.ts` does it, as a separate, pure,
 * CDP-free call over the `PageMapCapture` this function returns, precisely
 * so a cached capture (`cache.ts`) can be re-budgeted for a second request
 * with a different byte ceiling and no recapture. `PageMapCapture` is "the
 * capture outcome" (`types.ts`), and this function returns exactly that.
 *
 * ── No retry, ever ────────────────────────────────────────────────────
 *
 * This is deliberate. browser-use cancels pending tasks on its own ten
 * second deadline and retries them, spending a further two seconds on the
 * assumption that the first failure was transient, which is an assumption
 * this module has no evidence for.
 * Nothing in this file retries anything. Every phase either succeeds once,
 * degrades once (recording exactly one `PageMapPhaseFailure`), or is fatal
 * once. A caller that wants a second attempt sends a second `page.map.get`
 * with its own fresh deadline, spending its own budget on its own decision
 * to retry, not one this module makes for it.
 *
 * ── The fourth call ────────────────────────────────────────────────────
 *
 * `Page.getLayoutMetrics` is not new (`frames.ts`'s own module doc cites
 * `managed-session.ts`'s `queryRealViewport`/`screenshotTarget` as existing
 * production callers) and it is not one of the three core phase-A
 * commands, because none of the seven phase modules read the MAIN session's own current
 * scroll/viewport size, and `PageMapCapture.scrollX`/`scrollY`/
 * `viewportWidth`/`viewportHeight` (`types.ts`) are required fields, not
 * optional ones: `occlusion.ts`'s `viewportRect` and `budget.ts`'s own
 * in-viewport test both need a real value, unconditionally, for every
 * capture that requests `'nodes'`. `frames.ts` reads
 * `Page.getLayoutMetrics` too, but only on a PARENT frame's session while
 * computing a CHILD frame's offset (`currentScroll`, private, not
 * exported), never on the caller's own top-level session for the
 * capture's own viewport, which is a different call this file must make on
 * its own. `mainViewport` below is a small, duplicated read of the exact
 * same `cssVisualViewport.pageX`/`pageY` fields (never the device-pixel
 * `visualViewport` sibling, per the project-wide DPR rule `types.ts` and
 * `frames.ts` both state), plus `clientWidth`/`clientHeight` for the
 * viewport SIZE, which `frames.ts`'s own `currentScroll` has no need of and
 * does not read. On failure it is tagged `phase: 'frameTree'`: `types.ts`'s
 * `PageMapPhase` union has no member for "viewport/layout metrics",
 * because no phase module owns this call. REPORTED to the pagemap lead: a
 * dedicated phase value (or folding this call into `frames.ts` outright,
 * since it already owns `Page.getLayoutMetrics` for a closely related
 * purpose) would let this failure carry an honest label instead of
 * borrowing the nearest available one.
 *
 * ── Multi-session DOM tree AND snapshot merge ─────────────────────────────
 *
 * `frames.ts`'s own module doc states the DOM-tree half of this precisely,
 * ahead of anything written here: "`capture.ts` ... calls `buildDomTree`
 * once per session it needs a tree from, once for the main session and
 * once more for every out-of-process iframe session `frames.ts` names."
 * `collectExtraSessions` below does exactly that, and, since closing GAP 1
 * (a cross-origin iframe's content previously had no layout), ALSO calls
 * `DOMSnapshot.captureSnapshot` once per the same distinct session, the
 * identical command `snapshot.ts` already sends for the main session in
 * phase A. `dom-tree.ts` pierces SAME-PROCESS `contentDocument` boundaries
 * for free (one call already covers the main session and every
 * same-process descendant frame; `DOMSnapshot.captureSnapshot` does the
 * same for its own `documents` array), so both calls run exactly ONCE MORE
 * per DISTINCT session among {@link PageMapFrame} entries with
 * `outOfProcess: true` (deduplicated by `sessionId`, since a same-process
 * frame nested inside an out-of-process one shares that frame's session
 * and is already covered by the single pair of calls on it). Every node
 * `dom-tree.ts` returns with `frameId: null` from one of these EXTRA calls
 * is, by that module's own doc, a node belonging to the call's own top
 * document, which, for one of these extra calls, is the out-of-process
 * frame itself, not "the top document" in the project-wide sense
 * `PageMapNodeRecord.frameId`'s doc means. Those nodes are rewritten to
 * carry that frame's real `frameId` before merging, so the flat,
 * cross-session `PageMapCapture.nodes` map never contains a `frameId:
 * null` node that is not actually the main document's own. Snapshot nodes
 * need no equivalent rewrite: they are never turned into a
 * `PageMapNodeRecord` by their own `frameId` (`snapshot.ts`'s own decode
 * resolves that field through a `DOMSnapshot`-specific string table that
 * this file has no other reason to trust); they are looked up by
 * `backendNodeId` against the DOM node that already carries the
 * authoritative `frameId`, in `buildBaseNodeRecords` below.
 *
 * Per session, the DOM-tree call and the snapshot call run CONCURRENTLY
 * with each other (`Promise.allSettled` on the pair): neither depends on
 * the other's result, so pairing them roughly halves the added per-session
 * latency GAP 1 introduces, versus running every session's DOM tree first
 * and every session's snapshot after. Sessions themselves are still
 * visited one after another, never fanned out across each other, the
 * identical "sequential, not fanned out" choice `frames.ts`'s own module
 * doc makes for its own per-frame offset pass, for the identical reason
 * (avoiding the unmeasured complexity of a concurrency pool nobody has a
 * number to justify), so at most 2 of this pass's own CDP calls are ever
 * in flight at once, never more, keeping this pass inside the same
 * "small, bounded, still competes fairly with screencast frames on
 * `CdpBridge`'s one multiplexed socket" envelope `ax-merge.ts`'s own doc
 * describes for `PAGEMAP_AX_CONCURRENCY_CAP`. `PAGE_MAP_MAX_FRAME_COUNT`
 * still bounds the total session count; see this module's own doc,
 * "Complexity", for the resulting big-O.
 *
 * A `DOM.getDocument` or `DOMSnapshot.captureSnapshot` failure on one of
 * these EXTRA sessions degrades that session only (`phase: 'domTree'` or
 * `phase: 'snapshot'` respectively, that frame's id): only the MAIN
 * session's own calls, in phase A, are fatal. See `dom-tree.ts`'s own
 * module doc for why that split is this file's call to make, not that
 * module's; `snapshot.ts`'s own doc makes the parallel statement for its
 * command ("a snapshot failure is fatal" describes the phase-A call on the
 * main session, not every call this file happens to route through the
 * same function).
 *
 * GAP 1 CLOSED: an out-of-process iframe's own content now merges into
 * `PageMapCapture.nodes` with a real `rect`/`scrollRect`/`paintOrder`/
 * `style`, composed into TOP-document space by `buildFrameOffsetIndex` /
 * `offsetRect` below, using the additive offset `frames.ts` already
 * computes (`PageMapFrame.offsetX`/`offsetY`), this file adds no new
 * offset math of its own, it only applies the existing one to a rect. This
 * file also carries {@link PageMapFrame.scrollOffsetKnown} through into
 * {@link FrameOffset}, reading it rather than recomputing it, and does not
 * gate composition on it: a node inside a doubly (or deeper) nested frame
 * still gets a composed rect, not `null`. That used to matter more than it
 * does now: `frames.ts`'s own module doc used to name the field `false` for
 * a frame nested INSIDE an out-of-process frame, because the OOP parent's
 * own `Page.getLayoutMetrics` scroll read was unmeasured. That has since
 * been measured trustworthy and the code loosened to match (see that
 * module's doc, "MEASURED: an out-of-process frame's own scroll, as a
 * PARENT"), so as of that change the field is `true` for every frame
 * `frames.ts` actually returns, which makes it `true` for every
 * {@link FrameOffset} this file builds too. `PageMapNodeRecord`/`PageMapNode`
 * still carry no per-node "position confidence" field a caller could
 * branch on either way; that is a `types.ts` AND `@browserglass/protocol`
 * decision, not made here.
 *
 * ── Cross-session `backendNodeId` collisions ──────────────────────────────
 *
 * GAP 2 CLOSED. `index-assign.ts`'s own module doc has the full argument,
 * including what this build established about CDP's actual guarantee and
 * how; the short version: `backendNodeId` is unique only within the
 * renderer process (CDP session) that minted it, confirmed by reading
 * Chromium's own counter implementation, not merely assumed. Once this
 * file merges more than one session's nodes into one flat map, which
 * closing GAP 1 makes the ordinary case for any page with a cross-origin
 * iframe, not a rare one, `collectExtraSessions` tracks, per
 * `backendNodeId`, which session's DOM tree first claimed it (`sessionOf`
 * below). A second session reporting the SAME id is a collision: it is
 * DROPPED (the first session's node and its snapshot data both stand,
 * unmodified) and reported as one {@link PageMapPhaseFailure}
 * (`phase: 'domTree'`, the LOSING frame's id, a reason naming the numeric
 * id and both sessions), rather than silently overwritten the way a bare
 * `Map.set` would. A colliding snapshot node is dropped the same way,
 * silently from this file's own point of view: the collision itself was
 * already reported once, by the DOM-tree half of the same per-session
 * pass, and reporting the identical conflict a second time (once per
 * source that happened to mention the id) would double-count one incident
 * as two failures. The same `sessionOf` map is also handed to
 * `mergeAccessibility` (Phase B, below) so its own independent join by
 * `backendNodeId` cannot re-open the identical hole by attaching a losing
 * session's role/name onto the winning node: see `ax-merge.ts`'s own doc
 * for that guard.
 *
 * ── Listeners: one call, main session only ────────────────────────────────
 *
 * `listeners.ts`'s own module doc never describes being invoked more than
 * once per capture, unlike `ax-merge.ts`, which explicitly documents a
 * per-frame fan-out with its own named concurrency cap
 * (`PAGEMAP_AX_CONCURRENCY_CAP`). This file follows that asymmetry as
 * written: `mintClickListenerNodes` runs exactly once, on the capture's own
 * MAIN session. `DOMDebugger.getEventListeners` is called with
 * `depth: -1, pierce: true` on the MAIN document's own resolved object,
 * which the measured probe confirmed crosses shadow boundaries; whether it also crosses a SAME-PROCESS
 * `contentDocument` boundary the way `DOM.getDocument`'s own `pierce: true`
 * does was not part of what the probe measured (its fixture carried shadow
 * roots, not nested iframes), so that is UNMEASURED, not assumed true.
 * What is certain either way: an OUT-OF-PROCESS iframe's listeners are
 * never reached by one call on the main session's `objectId`, because that
 * object id names a node in a different renderer process's DOM entirely.
 * This is a documented, accepted gap for this version, matching the class
 * of gap the page map already accepts for a table rendered as cell text
 * rather than markdown: real, narrower than it
 * sounds, and honestly stated rather than silently absorbed. When this
 * call fails or is skipped, `hasClickListener` reads `null` for EVERY node
 * in the whole capture, including nodes from a same-process frame the call
 * COULD have reached had it succeeded: the signal is all-or-nothing per
 * capture, one call, one failure record, exactly matching `listeners.ts`'s
 * own doc, "That null fill is explicitly YOUR job" (this file's), stated
 * in the singular.
 *
 * ── Complexity ────────────────────────────────────────────────────────
 *
 * Phase A: O(1) round trips, run concurrently, bounded by one shared
 * deadline value. The extra per-session pass (`collectExtraSessions`): O(F)
 * round trips for F out-of-process sessions, F <= `PAGE_MAP_MAX_FRAME_COUNT`,
 * with TWO calls per session (`DOM.getDocument` and `DOMSnapshot.captureSnapshot`,
 * paired concurrently within one session, sessions still visited one after
 * another) since GAP 1 closed, where it was one call per session before;
 * same O(F) order, doubled constant factor, still bounded by the identical
 * cap, never fanned out across sessions. Phase B: `ax-merge.ts`'s own
 * stated O(N + A) at concurrency `PAGEMAP_AX_CONCURRENCY_CAP`. Phase C: one
 * call. The merge itself: one O(N) pass to build the frame-offset index
 * (`buildFrameOffsetIndex`, N here bounded by frame count, not node count),
 * one O(N) pass per DOM tree merged (each backend id a single `Map.get`
 * collision check plus a `Map.set`, both O(1)), one O(N) pass to attach
 * snapshot data and compose its rect against the frame-offset index (one
 * O(1) lookup and a handful of additions per node, not a second geometry
 * computation), one O(N) pass to attach listener flags when Phase C ran. No
 * pass here is quadratic in node count or frame count.
 */

import { DEFAULT_PAGEMAP_TIMEOUT_MS, type PageMapInclude } from '@browserglass/protocol';
import type { CdpBridge } from '../cdp/bridge.js';
import type { TargetRegistry } from '../cdp/target-registry.js';
import type { CdpSessionId } from '../cdp/types.js';
import { mergeAccessibility } from './ax-merge.js';
import { type DomTreeNode, buildDomTree } from './dom-tree.js';
import { type PageMapFrame, captureFrameTree } from './frames.js';
import { mintPageMapEpoch } from './index-assign.js';
import { mintClickListenerNodes } from './listeners.js';
import {
  PageMapSnapshotError,
  type PageMapSnapshotNode,
  type PageMapSnapshotResult,
  captureDomSnapshot,
} from './snapshot.js';
import type {
  PageMapCapture,
  PageMapDocumentRect,
  PageMapNodeRecord,
  PageMapPhase,
  PageMapPhaseFailure,
} from './types.js';

/** What one {@link capturePageMap} call was asked for. */
export interface PageMapCaptureRequest {
  /** What to capture. Default `['nodes']`. See `@browserglass/protocol`'s `PageMapInclude` for what `'text'` alone skips. */
  readonly include?: readonly PageMapInclude[];
  /** Default `true`. See this module's own doc, "Listeners: one call, main session only". */
  readonly listeners?: boolean;
  /** The one deadline for phase A. Default {@link DEFAULT_PAGEMAP_TIMEOUT_MS}. This layer does not clamp an over-large value; that is the server's job (it clamps at 60000). */
  readonly timeoutMs?: number;
}

/**
 * Thrown by {@link capturePageMap} when a FATAL phase fails: the snapshot,
 * either `DOM.getDocument` call phase A itself makes, `Page.getFrameTree`,
 * or the viewport read. Carries a ready-made {@link PageMapPhaseFailure} so
 * a caller (the server handler for `page.map.get`, a different build
 * stage) can report it without re-deriving one, matching
 * `PageMapSnapshotError`'s own precedent in `snapshot.ts`.
 */
export class PageMapCaptureError extends Error {
  readonly failure: PageMapPhaseFailure;

  constructor(failure: PageMapPhaseFailure, options?: { readonly cause?: unknown }) {
    super(failure.reason, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PageMapCaptureError';
    this.failure = failure;
  }
}

/** Wraps any phase-A rejection into a {@link PageMapCaptureError}, preserving `snapshot.ts`'s own ready-made failure rather than re-deriving one. */
function toCaptureError(err: unknown, phase: PageMapPhase): PageMapCaptureError {
  if (err instanceof PageMapSnapshotError) {
    return new PageMapCaptureError(err.failure, { cause: err });
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new PageMapCaptureError({ phase, reason }, { cause: err });
}

/**
 * `Page.getLayoutMetrics` on the capture's own main session, for the
 * viewport this file's callers all need. See this module's own doc, "The
 * fourth call". Duplicated from `frames.ts`'s private `currentScroll`
 * rather than imported (that function is not exported, and reads only
 * scroll, not size), following the same "duplicated rather than shared"
 * precedent every other small helper in `pagemap/` already sets.
 */
async function mainViewport(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  timeoutMs: number,
): Promise<{ scrollX: number; scrollY: number; viewportWidth: number; viewportHeight: number }> {
  const metrics = (await bridge.send('Page.getLayoutMetrics', undefined, sessionId, {
    timeoutMs,
  })) as {
    cssVisualViewport?: {
      pageX?: number;
      pageY?: number;
      clientWidth?: number;
      clientHeight?: number;
    };
  };
  const vp = metrics.cssVisualViewport;
  if (
    vp === undefined ||
    typeof vp.pageX !== 'number' ||
    typeof vp.pageY !== 'number' ||
    typeof vp.clientWidth !== 'number' ||
    typeof vp.clientHeight !== 'number'
  ) {
    throw new Error('Page.getLayoutMetrics returned no cssVisualViewport');
  }
  return {
    scrollX: vp.pageX,
    scrollY: vp.pageY,
    viewportWidth: vp.clientWidth,
    viewportHeight: vp.clientHeight,
  };
}

/** The two numbers `buildFrameOffsetIndex` needs per frame to compose a node's rect into top-document space, plus the trust flag this file reads but never recomputes. See this module's own doc, "GAP 1 CLOSED". */
interface FrameOffset {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scrollOffsetKnown: boolean;
}

/** The main frame's own offset: zero by definition (`frames.ts`'s own doc: "`(0, 0)` for the main frame"), always trusted. A named constant rather than a magic `{ offsetX: 0, offsetY: 0, scrollOffsetKnown: true }` literal at every use site. */
const MAIN_FRAME_OFFSET: FrameOffset = { offsetX: 0, offsetY: 0, scrollOffsetKnown: true };

/**
 * `PageMapFrame.frameId -> FrameOffset`, built once per capture so
 * `buildBaseNodeRecords` never re-scans `frames` per node (that would make
 * the merge O(N * F) instead of O(N + F)). The main frame is deliberately
 * NOT looked up through this map: `dom-tree.ts` records `frameId: null` for
 * the main document (its own doc, "Frame identity: ambient, not read per
 * node"), a value that can never equal a real `PageMapFrame.frameId`
 * string, so {@link MAIN_FRAME_OFFSET} is used directly by the caller for
 * that case instead.
 */
function buildFrameOffsetIndex(frames: readonly PageMapFrame[]): ReadonlyMap<string, FrameOffset> {
  const byFrameId = new Map<string, FrameOffset>();
  for (const frame of frames) {
    byFrameId.set(frame.frameId, {
      offsetX: frame.offsetX,
      offsetY: frame.offsetY,
      scrollOffsetKnown: frame.scrollOffsetKnown,
    });
  }
  return byFrameId;
}

/** Adds a document-space offset to a document-space rect. Duplicated rather than imported: `frames.ts` computes offsets, it does not shape rects, matching the "no shared code between the phase modules" precedent that module's own doc states for its own offset math. */
function offsetRect(
  rect: PageMapDocumentRect,
  offsetX: number,
  offsetY: number,
): PageMapDocumentRect {
  return { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height };
}

/**
 * One merged {@link PageMapNodeRecord} per DOM node, before accessibility or
 * listeners have run. Every accessibility/listener field starts at its
 * documented "source did not run yet" default (matching `ax-merge.test.ts`'s
 * own `baseNode` fixture).
 *
 * `rect`/`scrollRect` are composed into TOP-document space here, closing
 * GAP 1 (see this module's own doc): a node's own `frameId` (the
 * authoritative one `dom-tree.ts` recorded, not the snapshot's own,
 * possibly-unresolved one) selects its {@link FrameOffset} from
 * `frameOffsets`, and that offset is added to whatever document-space rect
 * `snapshotNodes` supplied for it. A node whose `frameId` names a frame
 * `frameOffsets` has no entry for, that frame's own session or offset
 * failed to resolve in `frames.ts`, or it was dropped by
 * `PAGE_MAP_MAX_FRAME_COUNT`/`PAGE_MAP_MAX_FRAME_DEPTH`, gets `rect: null`
 * and `scrollRect: null` regardless of what the snapshot reported: composing
 * against a MISSING offset would invent a placement this file cannot stand
 * behind, which is worse than reporting none at all (the same node shows up
 * downstream as `unpositioned`, `budget.ts`'s own honest bucket for exactly
 * this shape of gap, rather than silently landing at the wrong pixel).
 */
function buildBaseNodeRecords(
  domNodes: ReadonlyMap<number, DomTreeNode>,
  snapshotNodes: ReadonlyMap<number, PageMapSnapshotNode>,
  frameOffsets: ReadonlyMap<string, FrameOffset>,
): Map<number, PageMapNodeRecord> {
  const out = new Map<number, PageMapNodeRecord>();
  for (const domNode of domNodes.values()) {
    const snap = snapshotNodes.get(domNode.backendNodeId);
    const offset = domNode.frameId === null ? MAIN_FRAME_OFFSET : frameOffsets.get(domNode.frameId);
    const rect =
      offset !== undefined && snap?.rect
        ? offsetRect(snap.rect, offset.offsetX, offset.offsetY)
        : null;
    const scrollRect =
      offset !== undefined && snap?.scrollRect
        ? offsetRect(snap.scrollRect, offset.offsetX, offset.offsetY)
        : null;
    out.set(domNode.backendNodeId, {
      backendNodeId: domNode.backendNodeId,
      parentBackendNodeId: domNode.parentBackendNodeId,
      tag: domNode.tag,
      nodeType: domNode.nodeType,
      nodeValue: domNode.nodeValue,
      attributes: domNode.attributes,
      shadowKind: domNode.shadowKind,
      frameId: domNode.frameId,
      rect,
      scrollRect,
      paintOrder: snap?.paintOrder ?? null,
      style: snap?.style ?? null,
      role: null,
      name: null,
      axIgnored: false,
      axProperties: new Map(),
      hasClickListener: null,
    });
  }
  return out;
}

/** What {@link collectExtraSessions} returns. */
interface ExtraSessionsOutcome {
  readonly domNodes: Map<number, DomTreeNode>;
  readonly snapshotNodes: Map<number, PageMapSnapshotNode>;
  readonly failures: PageMapPhaseFailure[];
  /** `backendNodeId -> the session whose DOM tree first claimed it`. Passed on to `mergeAccessibility` too, so the SAME collision guard covers Phase B's own join, not only this file's own DOM/snapshot merge; see this module's own doc, "Cross-session `backendNodeId` collisions". */
  readonly sessionOf: ReadonlyMap<number, CdpSessionId>;
}

/** `err instanceof PageMapSnapshotError` unwraps to its own ready-made reason (matching `toCaptureError`'s identical unwrap above); anything else falls back to `Error.message` or `String(err)`, the pattern every other degrade-site in this file already uses. */
function reasonOf(err: unknown): string {
  if (err instanceof PageMapSnapshotError) return err.failure.reason;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `buildDomTree` AND, when `captureSnapshots`, `captureDomSnapshot`
 * once more per DISTINCT out-of-process session `frames` names, merging
 * every result into `mainDomNodes`/`mainSnapshotNodes`. See this module's
 * own doc, "Multi-session DOM tree AND snapshot merge" and "Cross-session
 * `backendNodeId` collisions", for the full argument behind the shape
 * below; this doc comment states only what a reader of the code needs
 * that the module doc does not already cover in more depth.
 *
 * `captureSnapshots` is `needsNodes` at the one call site: a `'text'`-only
 * request still needs every session's DOM tree (`text.ts` reads it) but
 * never needs geometry, so the snapshot half of each pair is skipped
 * entirely rather than fetched and discarded.
 */
async function collectExtraSessions(
  bridge: CdpBridge,
  mainSessionId: CdpSessionId,
  mainDomNodes: ReadonlyMap<number, DomTreeNode>,
  mainSnapshotNodes: ReadonlyMap<number, PageMapSnapshotNode>,
  frames: readonly PageMapFrame[],
  captureSnapshots: boolean,
  timeoutMs: number,
): Promise<ExtraSessionsOutcome> {
  const domNodes = new Map<number, DomTreeNode>(mainDomNodes);
  const snapshotNodes = new Map<number, PageMapSnapshotNode>(mainSnapshotNodes);
  const failures: PageMapPhaseFailure[] = [];

  // Provenance: which session's DOM tree first claimed a given
  // `backendNodeId`. Seeded from the main session's own tree, since it is
  // the first (and, for a single-frame page, only) contributor. See this
  // module's own doc, "Cross-session `backendNodeId` collisions", for why
  // this exists and what it guards against.
  const sessionOf = new Map<number, CdpSessionId>();
  for (const id of mainDomNodes.keys()) sessionOf.set(id, mainSessionId);

  const seenSessions = new Set<CdpSessionId>([mainSessionId]);

  for (const frame of frames) {
    if (!frame.outOfProcess) continue; // reachable through an ancestor's own pierced walk already.
    if (seenSessions.has(frame.sessionId)) continue;
    seenSessions.add(frame.sessionId);

    // The two calls for ONE session run concurrently with each other
    // (neither depends on the other's result); sessions are still visited
    // one after another. See this module's own doc for why that pairing,
    // not a broader fan-out, is the chosen shape.
    const [domSettled, snapSettled] = await Promise.allSettled([
      buildDomTree(bridge, frame.sessionId, timeoutMs),
      captureSnapshots
        ? captureDomSnapshot(bridge, frame.sessionId, { timeoutMs })
        : Promise.resolve<PageMapSnapshotResult | null>(null),
    ]);

    if (domSettled.status === 'rejected') {
      failures.push({
        phase: 'domTree',
        reason: reasonOf(domSettled.reason),
        frameId: frame.frameId,
      });
    } else {
      for (const node of domSettled.value.nodes.values()) {
        // `frameId: null` from a per-frame call names THAT frame's own top
        // document, not the project-wide "top document" meaning; see this
        // module's own doc.
        const placed = node.frameId === null ? { ...node, frameId: frame.frameId } : node;
        const owner = sessionOf.get(placed.backendNodeId);
        if (owner !== undefined && owner !== frame.sessionId) {
          // Collision: a DIFFERENT session already claimed this numeric id.
          // First writer wins; this report is dropped, not merged over the
          // existing node, and the conflict is recorded as data.
          failures.push({
            phase: 'domTree',
            reason: `backendNodeId ${placed.backendNodeId} was reported by two different CDP sessions (kept the node session ${owner} reported first; dropped this one from session ${frame.sessionId}). backendNodeId is unique only within the session that minted it; see index-assign.ts.`,
            frameId: frame.frameId,
          });
          continue;
        }
        domNodes.set(placed.backendNodeId, placed);
        sessionOf.set(placed.backendNodeId, frame.sessionId);
      }
    }

    if (!captureSnapshots) continue;
    if (snapSettled.status === 'rejected') {
      failures.push({
        phase: 'snapshot',
        reason: reasonOf(snapSettled.reason),
        frameId: frame.frameId,
      });
      continue;
    }
    const snapResult = snapSettled.value;
    if (snapResult === null) continue; // unreachable when captureSnapshots is true; satisfies the type.
    for (const node of snapResult.nodes.values()) {
      // Gated by the SAME provenance map the DOM-tree half just updated: a
      // snapshot node whose id was already claimed by a different session
      // (a collision reported above, or a DOM tree that never indexed this
      // id at all) is dropped here too, without a second failure entry for
      // the identical conflict.
      if (sessionOf.get(node.backendNodeId) !== frame.sessionId) continue;
      snapshotNodes.set(node.backendNodeId, node);
    }
  }

  return { domNodes, snapshotNodes, failures, sessionOf };
}

/** Sets `hasClickListener` on every node: `true` for a backend id the listener signal named, `false` for one it did not. Called only when the signal actually ran; see this module's own doc for the all-or-nothing `null` fill when it did not. */
function withClickListenerFlags(
  nodes: ReadonlyMap<number, PageMapNodeRecord>,
  backendNodeIds: ReadonlySet<number>,
): Map<number, PageMapNodeRecord> {
  const out = new Map<number, PageMapNodeRecord>();
  for (const node of nodes.values()) {
    out.set(node.backendNodeId, {
      ...node,
      hasClickListener: backendNodeIds.has(node.backendNodeId),
    });
  }
  return out;
}

/**
 * Captures one page map: dispatches every phase this module's own doc
 * describes, merges the results, mints the epoch, and returns the finished
 * {@link PageMapCapture}. Throws {@link PageMapCaptureError} on any fatal
 * phase failure (see this module's own doc for exactly which phases are
 * fatal); every other failure degrades and is recorded in the returned
 * capture's own `failures` list, never thrown.
 */
export async function capturePageMap(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  registry: TargetRegistry,
  req: PageMapCaptureRequest = {},
): Promise<PageMapCapture> {
  const include = req.include ?? ['nodes'];
  const needsNodes = include.includes('nodes');
  const timeoutMs = req.timeoutMs ?? DEFAULT_PAGEMAP_TIMEOUT_MS;

  // Phase A: four commands in parallel, one shared deadline. See this
  // module's own doc for why all four are fatal and why the snapshot alone
  // is conditional on `needsNodes` ("Text-only skips more than Phase B/C").
  const snapshotPromise = needsNodes
    ? captureDomSnapshot(bridge, sessionId, { timeoutMs }).catch((err) => {
        throw toCaptureError(err, 'snapshot');
      })
    : Promise.resolve(null);
  const domTreePromise = buildDomTree(bridge, sessionId, timeoutMs).catch((err) => {
    throw toCaptureError(err, 'domTree');
  });
  const frameTreePromise = captureFrameTree(bridge, sessionId, registry, timeoutMs).catch((err) => {
    throw toCaptureError(err, 'frameTree');
  });
  const viewportPromise = mainViewport(bridge, sessionId, timeoutMs).catch((err) => {
    throw toCaptureError(err, 'frameTree'); // see this module's own doc, "The fourth call", for why this borrows frameTree's phase tag.
  });

  const [snapshotResult, mainDomTree, frameTreeOutcome, viewport] = await Promise.all([
    snapshotPromise,
    domTreePromise,
    frameTreePromise,
    viewportPromise,
  ]);

  const failures: PageMapPhaseFailure[] = [...frameTreeOutcome.failures];
  const epoch = mintPageMapEpoch(sessionId, frameTreeOutcome.mainLoaderId);

  // Every out-of-process session's own DOM tree AND, when nodes were
  // requested, its own snapshot too. See this module's own doc,
  // "Multi-session DOM tree AND snapshot merge".
  const {
    domNodes,
    snapshotNodes,
    failures: extraSessionFailures,
    sessionOf,
  } = await collectExtraSessions(
    bridge,
    sessionId,
    mainDomTree.nodes,
    snapshotResult?.nodes ?? new Map(),
    frameTreeOutcome.frames,
    needsNodes,
    timeoutMs,
  );
  failures.push(...extraSessionFailures);

  const frameOffsets = buildFrameOffsetIndex(frameTreeOutcome.frames);
  let nodes: ReadonlyMap<number, PageMapNodeRecord> = buildBaseNodeRecords(
    domNodes,
    snapshotNodes,
    frameOffsets,
  );

  if (needsNodes) {
    // Phase B.
    const axOutcome = await mergeAccessibility(bridge, frameTreeOutcome.frames, nodes, sessionOf);
    nodes = axOutcome.nodes;
    failures.push(...axOutcome.failures);

    // Phase C, optional. See this module's own doc, "Listeners: one call,
    // main session only".
    const listenersEnabled = req.listeners ?? true;
    if (listenersEnabled) {
      try {
        const listenerOutcome = await mintClickListenerNodes(bridge, sessionId);
        nodes = withClickListenerFlags(nodes, listenerOutcome.backendNodeIds);
      } catch (err) {
        failures.push({
          phase: 'listeners',
          reason: err instanceof Error ? err.message : String(err),
        });
        // `hasClickListener` is left at `null` on every node
        // (`buildBaseNodeRecords`'s own default): the all-or-nothing fill
        // this module's own doc describes.
      }
    }
  }

  return {
    epoch,
    nodes,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    viewportWidth: viewport.viewportWidth,
    viewportHeight: viewport.viewportHeight,
    failures,
  };
}
