/**
 * The internal shapes of a page map capture.
 *
 * These are not the wire types. Those live in
 * `packages/protocol/src/wire/messages/pagemap.ts` and are deliberately
 * narrower: every field on `PageMapNode` is read by a language model on
 * every step, so it carries what an agent needs to act and nothing else.
 * The record here carries what the pipeline needs to DECIDE, which is a
 * good deal more, and most of it is discarded before anything is sent.
 *
 * The split matters because three of the four sources merged below answer
 * questions no caller ever asks directly. `paintOrder` exists so
 * `occlusion.ts` can walk highest first. The ten computed styles exist so
 * `interactivity.ts` can tell a `div` styled as a button from a `div`. The
 * scroll rects exist so a scrollable container can be reported as one.
 * None of those reach the wire.
 *
 * Coordinates here are DOCUMENT space, not viewport space, because a rect
 * stored in document space
 * survives a scroll, so a caller that scrolls and asks again costs zero
 * CDP round trips. The conversion to viewport space happens once, at
 * serialization, against the scroll offset recorded on the capture. Do not
 * store viewport coordinates in this record, and do not apply a device
 * pixel ratio anywhere: `packages/core/src/input/coordinates.ts:5` states
 * that there is no DPR multiplier in either direction, and a page map that
 * introduced one would hand `InputDispatcher` coordinates it would then
 * transform a second time.
 */

/** A rectangle in document space. Matches the shape `DOMSnapshot` returns. */
export interface PageMapDocumentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The ten computed styles taken from `DOMSnapshot.captureSnapshot`.
 *
 * The list is browser-use's, unchanged, and their comment names the reason
 * it is short: "Only styles actually accessed in the codebase (prevents
 * Chrome crashes on heavy sites)"
 * (`browser_use/dom/enhanced_snapshot.py:18`). Every entry feeds a rule in
 * `interactivity.ts` or `occlusion.ts`. Adding an eleventh means paying
 * for it on every node of every capture, so add one only with a rule that
 * needs it.
 */
export interface PageMapComputedStyle {
  readonly display: string | null;
  readonly visibility: string | null;
  readonly opacity: string | null;
  readonly overflow: string | null;
  readonly overflowX: string | null;
  readonly overflowY: string | null;
  readonly cursor: string | null;
  readonly pointerEvents: string | null;
  readonly position: string | null;
  readonly backgroundColor: string | null;
}

/** The computed style names requested from CDP, in the order they are requested. */
export const PAGE_MAP_COMPUTED_STYLES = [
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

/**
 * How a node sits relative to a shadow boundary, if it sits on one at all.
 *
 * `'user-agent'` is CDP's own third `shadowRootType`, for a browser-internal
 * root Chrome attaches with no author markup at all: `<input type=range>`'s
 * thumb/track, `<input type=date>`'s spinner, `<video>`'s default controls,
 * and similar built-in widgets. This member was added closing a gap
 * `dom-tree.ts` reported at first landing: without it, a user-agent shadow
 * host and a plain element with no shadow root at all were both recorded as
 * `shadowKind: null`, so a consumer had no way to ask "does this control
 * have hidden native internals" at all. See `dom-tree.ts`'s own doc,
 * `shadowKindOf`, for how this is populated.
 */
export type PageMapShadowKind = 'open' | 'closed' | 'user-agent' | null;

/**
 * One merged node.
 *
 * Assembled by joining four sources on `backendNodeId`: the DOM tree walk
 * (`dom-tree.ts`), the snapshot decode (`snapshot.ts`), the per frame
 * accessibility trees (`ax-merge.ts`), and optionally the event listener
 * signal (`listeners.ts`). Every field a source did not supply is null
 * rather than absent, so a consumer never has to distinguish "this source
 * did not run" from "this source ran and said nothing" by checking for
 * `undefined`. The capture's `degraded` report says which sources ran.
 */
export interface PageMapNodeRecord {
  /**
   * CDP's own `backendNodeId`, which is also the index a caller acts on.
   * Stable for the lifetime of the node, which is what makes it a better
   * identity than the per call random `ref` the locator engine stamps
   * (`packages/automation/src/locator/types.ts:37` documents that
   * limitation as permanent and accepted).
   */
  readonly backendNodeId: number;

  /** Parent in the pierced tree, or null at the document root. */
  readonly parentBackendNodeId: number | null;

  /** Lowercased tag name. `#document` and `#text` appear here too. */
  readonly tag: string;

  /** DOM node type, so a consumer can tell an element from a text node without parsing `tag`. */
  readonly nodeType: number;

  /**
   * The node's own character data, for text nodes. Null on elements.
   *
   * This field was missing from the first cut of this record, and `text.ts`
   * caught it: without it every text node is empty, so a capture that ran
   * perfectly would still extract no text at all. Source it from
   * `DOM.getDocument`'s `nodeValue`, which the tree walk already receives
   * and would otherwise discard.
   */
  readonly nodeValue: string | null;

  /** Every attribute the DOM walk returned, unfiltered. The wire subset is applied later, in `budget.ts`. */
  readonly attributes: ReadonlyMap<string, string>;

  /** Set when this node is a shadow host, naming the kind of root it hosts. */
  readonly shadowKind: PageMapShadowKind;

  /** The frame this node belongs to. Null for the top document. */
  readonly frameId: string | null;

  /**
   * Rect in DOCUMENT space, with every ancestor frame offset already
   * accumulated by `frames.ts`. Null when the snapshot supplied no layout
   * for this node, which happens for nodes that are not laid out at all
   * and, notably, for shadow DOM form controls: browser-use carries an
   * explicit carve out for exactly that case
   * (`dom/serializer/serializer.py:704`).
   */
  readonly rect: PageMapDocumentRect | null;

  /** The node's own scrollable extent, when it has one. Drives the scroll container rule. */
  readonly scrollRect: PageMapDocumentRect | null;

  /** CDP paint order. Higher paints later, so higher is nearer the viewer. Null when the snapshot omitted it. */
  readonly paintOrder: number | null;

  /** The ten styles above, or null when the snapshot supplied none for this node. */
  readonly style: PageMapComputedStyle | null;

  /** Computed accessibility role, from the frame's AX tree. */
  readonly role: string | null;

  /** Computed accessible name. */
  readonly name: string | null;

  /**
   * True when the AX tree marked this node ignored.
   *
   * We drop ignored nodes, which `packages/core/src/cdp/accessibility.ts:236`
   * already does for `queryAXTree`. browser-use has this check commented
   * out (`dom/serializer/clickable_elements.py:31`), so their tree carries
   * nodes the platform itself considers invisible to assistive tech.
   */
  readonly axIgnored: boolean;

  /**
   * AX properties that decide interactivity, kept tristate where CDP is
   * tristate. `accessibility.ts:146` passes `checked` and `pressed`
   * through rather than collapsing them, and distinguishes "property
   * absent" from "property false". Same rule here.
   */
  readonly axProperties: ReadonlyMap<string, string | boolean | null>;

  /**
   * True when `DOMDebugger.getEventListeners` reported a click-like
   * listener on this node. Null when the signal did not run.
   *
   * Measured, not assumed: the probe at
   * `examples/nextjs-demo/pagemap-listeners-probe.mjs` established that
   * this signal costs zero `DOM.*` events, zero `Runtime.*` events, and
   * zero page-visible side effects, and that it crosses closed shadow
   * roots. It also established the limit: a delegated handler is reported
   * on the CONTAINER, not on the child that appears to be clickable, so
   * this is not a complete answer on a React 17+ page and
   * `interactivity.ts` must not treat a false here as proof of anything.
   */
  readonly hasClickListener: boolean | null;
}

/** Which capture phase a degradation happened in. */
export type PageMapPhase = 'snapshot' | 'domTree' | 'frameTree' | 'accessibility' | 'listeners';

/** One phase that did not fully succeed, and why. */
export interface PageMapPhaseFailure {
  readonly phase: PageMapPhase;
  readonly reason: string;
  /** Set when the failure was scoped to one frame rather than the whole capture. */
  readonly frameId?: string;
}

/**
 * The outcome of one capture, before budget and serialization.
 *
 * `nodes` is keyed by `backendNodeId` because every later stage joins on
 * it and nothing iterates in insertion order.
 */
export interface PageMapCapture {
  /** Minted from the session id and the main frame `loaderId` (see `index-assign.ts`). */
  readonly epoch: string;

  /** Every merged node, keyed by `backendNodeId`. */
  readonly nodes: ReadonlyMap<number, PageMapNodeRecord>;

  /** The main frame's scroll offset at capture time, used to convert document rects to viewport rects once, at the end. */
  readonly scrollX: number;
  readonly scrollY: number;

  /** Viewport size in CSS pixels, for the in-viewport test. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;

  /**
   * Phases that failed or partially failed. Empty on a clean capture.
   *
   * A capture with an empty accessibility tree and no entry here would be
   * a lie, which is the failure mode `packages/protocol/src/wire/messages/a11y.ts`
   * already guards against by reporting truncation as data rather than
   * silently cutting.
   */
  readonly failures: readonly PageMapPhaseFailure[];
}
