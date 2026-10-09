import type { Envelope } from '../envelope.js';
import { MAX_A11Y_RESULT_BYTES } from './a11y.js';
import { MAX_EVALUATE_RESULT_BYTES } from './evaluate.js';

/**
 * `page.map.get` / `page.map.got`, plus `page.map.stamp` / `page.map.stamped`
 * for the act-on-an-index path: an indexed, whole-page representation of
 * what an agent can act on, gated on `devtools`, with its own rate bucket
 * (`pagemap`, not `evaluate`, because the two round-trip-cost classes do
 * not belong on one meter). `docs/page-map.md` is the user facing guide.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `page.a11y.get` (`./a11y.ts`) returns role and name with no geometry, no
 * occlusion answer, no tag, and no attributes, so an agent that has never
 * seen the page still cannot form a selector from it. This message pair is
 * its bigger sibling: same house
 * style (a tree shaped for an LLM reader, caps, HONEST truncation
 * reporting, never a raw dump), wider payload.
 *
 * ── Gated on `devtools`, not `evaluate` ───────────────────────────────────
 *
 * The capture behind this reply runs no page script. Every command it
 * sends (`DOMSnapshot.captureSnapshot`, `DOM.getDocument`,
 * `Page.getFrameTree`, `Accessibility.getFullAXTree`, and
 * `DOMDebugger.getEventListeners` for {@link PageMapGet.listeners}) is a
 * CDP domain read, the identical argument `./a11y.ts`'s own doc makes for
 * `page.a11y.get`. Gating this on `evaluate` would ask for a capability
 * this feature does not use.
 *
 * ── Index identity: the `backendNodeId`, plus a per-capture epoch ────────
 *
 * {@link PageMapNode.index} is Chrome's own `backendNodeId` (falling back
 * to a synthetic id above every reserved backend id on the rare collision,
 * same as browser-use's `_allocate_selector_index`). It costs no DOM
 * mutation to assign, unlike the locator engine's `data-bgls-ref` stamp,
 * and it is already public on this wire as `A11yNode.backendNodeId`
 * in `./a11y.ts`.
 *
 * A `backendNodeId` is exact for the life of the node and stable across a
 * capture-then-act step if the node survives, but a fresh navigation
 * reuses the id space silently: after a navigation a raw `backendNodeId`
 * does not fail on use, it names a DIFFERENT element. That is strictly
 * worse than the locator engine's own `LocatorMatch.ref`, whose documented
 * limitation is that staleness is only ever discovered on use. This design
 * closes that specific gap: {@link PageMapGot.epoch} is minted per capture
 * from the CDP session id and the main frame's `loaderId`
 * (`Page.getFrameTree`, already read in phase A of the capture), and every
 * message that acts on an index (currently only {@link PageMapStamp})
 * must echo it back. A mismatch is refused with
 * `bgls.error.pagemap.stale_epoch` before any CDP command goes out, which
 * is the difference between "the click failed" and "the click landed on
 * something else". The epoch does NOT cover a same-document re-render
 * (same `loaderId`, different backend node ids); that case still fails on
 * use, reported per node rather than failing the whole {@link PageMapStamp}
 * batch, exactly as `stampAccessibilityNodes`
 * (`packages/core/src/cdp/accessibility.ts`) already does.
 *
 * ── Acting on an index: stamp it, then the ordinary locator ─────────────
 *
 * There is no index-addressed input message, and there will not be one:
 * `packages/automation/src/locator/engine.ts`'s `LocatorRuntime` doc
 * already makes the case that a second way into `InputDispatcher` would
 * throw away the one thing this surface has that a Playwright port cannot,
 * the shared control model (lease, generation stamp, fencing). Instead
 * {@link PageMapStamp} calls `stampAccessibilityNodes` with the requested
 * indices, exactly the function `role=` stamping already uses with
 * different arguments, and the caller addresses the result through the
 * existing `resolve()`/`click()` path so the actual input goes through the
 * one control model every other click on this wire does.
 *
 * A `backendNodeId` is never a handle: it names a slot in Chrome's own DOM
 * bookkeeping, not a live JavaScript reference, and nothing on this wire
 * can turn it into one (`./a11y.ts`'s own note on
 * `A11yNode.backendNodeId`). It is also scoped to one CDP session,
 * resolved from `targetId` through the caller's own session registry, so a
 * caller guessing an id names a node in their own page or nothing at all,
 * the same argument `page.evaluate` already makes about never accepting a
 * context id from the wire.
 *
 * ── Truncation and degradation, both reported as DATA ────────────────────
 *
 * Same rule `./a11y.ts` already sets and this module carries forward
 * unchanged: a bound going over is never silently a smaller, misleading
 * answer. {@link PageMapGot.truncated}/{@link PageMapGot.total}/
 * {@link PageMapGot.truncatedByReason} report exactly what was cut and
 * why (see {@link PageMapTruncationReason}); {@link PageMapGot.degraded}
 * reports exactly which per-frame accessibility reads failed, even when
 * the reply otherwise looks complete.
 */

/**
 * The largest `page.map.got` node list, in UTF-8 bytes of its JSON
 * encoding, the server will put on the wire.
 *
 * Double {@link MAX_A11Y_RESULT_BYTES}, because a page map node carries
 * strictly more than an accessibility node does: a rect, a tag, an
 * attribute subset and (when requested) text, on top of role and name.
 * Half {@link MAX_EVALUATE_RESULT_BYTES}, because unlike an arbitrary
 * caller-shaped value this payload is a list of small uniform records, and
 * the whole point of the call is that it replaces many `resolve()` calls
 * rather than becoming the largest thing on a socket also carrying video
 * frames.
 */
export const MAX_PAGEMAP_RESULT_BYTES = MAX_A11Y_RESULT_BYTES * 2;

/** The default {@link PageMapGet.timeoutMs} when omitted. */
export const DEFAULT_PAGEMAP_TIMEOUT_MS = 15000;

/**
 * The largest {@link PageMapGet.timeoutMs} a caller may ask for, server
 * side. Following the practice `page.evaluate` already set: an over-large
 * ask is clamped rather than refused, "optimism, not a typo"
 * (`packages/server/src/ws/connection.ts`'s handler doc for `maxNodes`).
 */
export const MAX_PAGEMAP_TIMEOUT_MS = 60000;

/**
 * The largest {@link PageMapStamp.indices} a caller may send in one
 * request. Bounds the number of individual `DOM.setAttributeValue` round
 * trips one stamp request can cause (one per index), the same reasoning
 * {@link MAX_A11Y_MAX_NODES} in `./a11y.ts` already gives for its own
 * `stamp: true` path.
 */
export const MAX_PAGEMAP_STAMP_INDICES = 1000;

/**
 * The DOM attributes copied onto {@link PageMapNode.attributes} when the
 * element carries them. Fixed and deliberately small: this is read by a
 * language model and every field costs tokens on every step, so this is not "every
 * attribute a node has", it is the subset that helps identify or act on
 * an interactive element, mirroring the named fields
 * `packages/automation/src/locator/types.ts`'s `LocatorMatch` already
 * reads off a resolved element (`id`, `name`, `type`) plus the handful an
 * LLM needs to describe a control it cannot see rendered (`href`,
 * `placeholder`, `aria-label`, `role`, and the tri-state-by-presence
 * `checked`/`disabled`/`readonly`/`required`).
 */
export const PAGE_MAP_ATTRIBUTES = [
  'id',
  'name',
  'type',
  'href',
  'value',
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'role',
  'checked',
  'disabled',
  'readonly',
  'required',
  'tabindex',
] as const;

/** One key of {@link PAGE_MAP_ATTRIBUTES}. */
export type PageMapAttributeName = (typeof PAGE_MAP_ATTRIBUTES)[number];

/**
 * The literal DOM attribute values for the fixed set in
 * {@link PAGE_MAP_ATTRIBUTES}, present only for the ones the element
 * actually carries. Values are the raw attribute strings, not parsed:
 * `checked` here is the literal `checked=""` presence, distinct from the
 * AX-computed tri-state `A11yNode.checked` in `./a11y.ts`, which this
 * module does not repeat per node (an agent wanting the AX-computed
 * answer for one index already has `page.a11y.get`).
 */
export type PageMapAttributes = Partial<Record<PageMapAttributeName, string>>;

/**
 * What a `page.map.get` capture returns. Defaults to `['nodes']` when
 * omitted: the indexed, interactive-element map is the primary feature
 * this message pair exists for. `'text'` runs the separate, much cheaper
 * text extraction (shares the DOM
 * tree walk and nothing else; a request naming `'text'` alone skips the
 * snapshot, the per-frame accessibility reads, the listener signal and
 * most of the merge/cascade/occlusion work). A caller wanting both sends
 * `['nodes', 'text']` in one request rather than paying for two
 * `DOM.getDocument` walks on the same document with two requests.
 */
export type PageMapInclude = 'nodes' | 'text';

/**
 * C to S: capture an indexed page map for one target. Requires `devtools`.
 * See this module's own doc for the full scoping argument.
 */
export interface PageMapGet extends Envelope {
  t: 'page.map.get';
  /** The BrowserGlass target id (`tgt_*`) to capture. Resolved only within the caller's own session registry, the identical seam `page.evaluate` and `page.a11y.get` use. */
  targetId: string;
  /** What to capture. Default `['nodes']`. See {@link PageMapInclude}. */
  include?: PageMapInclude[];
  /**
   * Default true. Adds the `DOMDebugger.getEventListeners` click-listener
   * signal to the interactivity cascade, catching an element whose only
   * actionability signal is a JavaScript handler with no ARIA role, no
   * `tabindex` and no pointer cursor. Runs no script (`DOM.resolveNode`
   * plus `DOMDebugger.getEventListeners`, both CDP domain reads), so it
   * stays gated on `devtools` alone. It is used instead of the main-world
   * `getEventListeners()` alternative (see "The listener signal" in
   * `docs/page-map.md`). One thing is still UNMEASURED before this default
   * is safe to ship as true (whether the two commands above enable an
   * observable CDP domain the way `DOM.getNodeForLocation` was measured
   * to). If that measurement comes back badly the default flips to false
   * server side; the field itself does not change.
   */
  listeners?: boolean;
  /**
   * Capture deadline in milliseconds. Default {@link DEFAULT_PAGEMAP_TIMEOUT_MS},
   * clamped server side at {@link MAX_PAGEMAP_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/** Viewport CSS px, the same coordinate space every `AutomationClient` interaction method takes. Captured in document space internally and offset by the current scroll position at reply time, so a scroll between two captures changes nothing about which CDP commands were needed; what crosses the wire is always this, never the document-space form. */
export interface PageMapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One node in a captured page map: an element the interactivity cascade
 * (`packages/core/src/pagemap/interactivity.ts`) judged actionable. Unlike
 * `A11yNode` in `./a11y.ts`, which can describe every node in the tree,
 * `nodes` here is the curated, indexed subset an agent can act on, which
 * is the entire reason to prefer this call over a whole-tree `a11y()` read
 * followed by client-side filtering.
 */
export interface PageMapNode {
  /**
   * The identity used to act on this node later, through
   * {@link PageMapStamp}. Chrome's own `backendNodeId`; see this module's
   * own doc, "Index identity", for what is and is not stable about it.
   */
  index: number;
  /** Lowercase HTML tag name (`'button'`, `'a'`, `'input'`). Never absent: read straight off the DOM tree, independent of the accessibility read that can degrade. */
  tag: string;
  /** Chrome's own computed accessible role, the identical vocabulary `A11yNode.role` in `./a11y.ts` uses. `null` when this node's frame lost its accessibility read; see {@link PageMapGot.degraded}. */
  role: string | null;
  /** Chrome's own computed accessible name, same provenance as `A11yNode.name`. `null` under the same degradation as {@link role}. */
  name: string | null;
  rect: PageMapRect;
  /** Whether {@link rect} intersects the viewport at capture time. An element outside it is never occluded-tested and is the lowest priority for {@link PageMapGot.truncated} to drop. */
  inViewport: boolean;
  /**
   * Whether the paint-order occlusion pass found this node's rect fully
   * covered by something painted above it. `null` when the answer was
   * never computed: {@link inViewport} is false, or the disjoint-rectangle
   * union this test runs against had already hit its cap (past which the
   * pass under-reports rather than risks hiding a real, clickable
   * element). `null` is therefore
   * "no answer", never a claim that the node is visible.
   */
  occluded: boolean | null;
  /** The fixed, LLM-priced attribute subset. See {@link PAGE_MAP_ATTRIBUTES}. Never degrades with {@link role}/{@link name}: it comes from the same DOM tree read that supplies {@link tag}. */
  attributes: PageMapAttributes;
}

/** Why one node was dropped by {@link PageMapGot.truncatedByReason}. `'offscreen'`: outside the viewport at capture time, the lowest tier of the priority order this module's own doc names (in-viewport first, then descending paint order, then document order); scrolling and re-capturing is likely to surface it. `'onscreen'`: dropped even though it was in the viewport, meaning the byte budget was exhausted by in-viewport content alone; scrolling will not help. `'unpositioned'`: the capture judged this node interactive but the snapshot supplied it no layout, so it has no {@link PageMapNode.rect} and there is nowhere to click; this is not a budget decision and re-capturing will not change it. Two real shapes produce it: a shadow DOM form control the snapshot passed over, and any node inside an out-of-process iframe, whose layout the main session's snapshot never sees. */
export type PageMapTruncationReason = 'offscreen' | 'onscreen' | 'unpositioned';

/** One frame whose `Accessibility.getFullAXTree` read failed during a capture. Every node from this frame kept its {@link PageMapNode.tag}, {@link PageMapNode.rect} and {@link PageMapNode.attributes}, and lost {@link PageMapNode.role}/{@link PageMapNode.name} to `null`. */
export interface PageMapFrameFailure {
  /** The CDP frame id, from `Page.getFrameTree`. */
  frameId: string;
  /** Why the read failed: a timeout, a detached session, or another CDP-reported reason. Developer detail, not necessarily safe to show a user verbatim. */
  reason: string;
}

/**
 * How much of the capture's accessibility pass succeeded, reported even
 * when the reply otherwise looks complete. A per-frame accessibility failure degrades
 * that one frame rather than failing the whole capture, and this is what
 * keeps that degradation from being silent. A snapshot, DOM tree or frame
 * tree failure is NOT reported here: any of those three fails the whole
 * `page.map.get` request instead, because without them every node would
 * be unpositioned, unoccludable, and of unknown visibility.
 */
export interface PageMapDegradation {
  /** Per-frame accessibility reads attempted: the main frame plus every attached out-of-process iframe session. */
  framesAttempted: number;
  /** How many of those degraded. Zero is an ordinary, common answer. */
  framesFailed: number;
  /** One entry per degraded frame. Empty when {@link framesFailed} is 0. */
  failures: PageMapFrameFailure[];
  /**
   * What happened to the event-listener signal, which is its own optional
   * phase and degrades independently of any frame.
   *
   * `'ok'`: the signal ran, so a `false` on a node means no listener was
   * found directly on it. `'skipped'`: the caller passed
   * `listeners: false`. `'failed'`: the signal was asked for and could not
   * run, so every node reports `null`.
   *
   * This exists because the alternative is a lie by omission. A capture
   * where the signal failed and one where every node genuinely has no
   * listener are indistinguishable from the nodes alone, and a caller that
   * cannot tell them apart will read a silent failure as evidence the page
   * has nothing clickable on it.
   */
  listeners: 'ok' | 'skipped' | 'failed';
  /** Why the listener signal failed. Present only when {@link listeners} is `'failed'`. Developer detail, not necessarily safe to show a user verbatim. */
  listenersReason?: string;
}

/** One extracted text unit from `include: ['text']`: headings, paragraphs, list items and link text with its href, nothing else in this version (a table's cells come back as {@link PageMapTextBlock} entries in document order, not as a markdown table). */
export interface PageMapTextBlock {
  kind: 'heading' | 'paragraph' | 'listItem' | 'link';
  /** Normalised, visible text content of this block. */
  text: string;
  /** Heading level 1 to 6. Present only when {@link kind} is `'heading'`. */
  level?: number;
  /** The link target, exactly as the `href` attribute reads (not resolved against the base URL). Present only when {@link kind} is `'link'`. */
  href?: string;
}

/**
 * Opaque; never parse it. Minted per capture from the CDP session id and
 * the main frame's `loaderId`. Two captures of the same navigated document
 * share an epoch; a navigation mints a new one. See this module's own doc,
 * "Index identity".
 */
export type PageMapEpoch = string;

/**
 * S to C, addressed to the requesting viewer ONLY, never broadcast: a page
 * map is page content, the identical reasoning `page.evaluated` and
 * `page.a11y.got` already carry for themselves. Answers {@link PageMapGet}.
 */
export interface PageMapGot extends Envelope {
  t: 'page.map.got';
  targetId: string;
  /** Mint id for this capture's index space. Echo it back on {@link PageMapStamp}. */
  epoch: PageMapEpoch;
  /** Present when {@link PageMapGet.include} asked for `'nodes'` (the default). Absent, not empty, when it was not asked for: an agent that asked for `'text'` alone should not read a false "zero interactive elements" out of an omitted capture. */
  nodes?: PageMapNode[];
  /** Present exactly when {@link nodes} is. How many candidate nodes existed before {@link MAX_PAGEMAP_RESULT_BYTES} truncation, independent of how many are actually in {@link nodes}. */
  total?: number;
  /** True when `nodes.length < total`. */
  truncated?: boolean;
  /** Counts of dropped nodes by {@link PageMapTruncationReason}, so a caller can tell "more below the fold" from "more everywhere, scrolling will not help". Present exactly when {@link nodes} is; both counts are 0 when {@link truncated} is false. */
  truncatedByReason?: Record<PageMapTruncationReason, number>;
  /** Present exactly when {@link nodes} is. See {@link PageMapDegradation}. */
  degraded?: PageMapDegradation;
  /** Present when {@link PageMapGet.include} asked for `'text'`. */
  text?: PageMapTextBlock[];
  re?: string;
}

/**
 * C to S: stamp the given indices with a fresh, per-request DOM attribute
 * through `stampAccessibilityNodes` (`packages/core/src/cdp/accessibility.ts`),
 * so an ordinary `resolve()`/`click()` selector can address them
 * afterward. See this module's own doc, "Acting on an index". Requires
 * `devtools`, the same gate as {@link PageMapGet}: the write goes through
 * `DOM.setAttributeValue`, never through page script.
 */
export interface PageMapStamp extends Envelope {
  t: 'page.map.stamp';
  targetId: string;
  /** Must equal the {@link PageMapGot.epoch} the indices were read from. A mismatch is refused with `bgls.error.pagemap.stale_epoch` before any CDP command goes out. */
  epoch: PageMapEpoch;
  /** {@link PageMapNode.index} values to stamp, at most {@link MAX_PAGEMAP_STAMP_INDICES}. */
  indices: number[];
}

/** Whether one requested index was actually stamped, and why not when it was not. */
export interface PageMapStampResult {
  index: number;
  stamped: boolean;
  /** Set when {@link stamped} is false: the node detached between the capture and this call, or another per-node `DOM.setAttributeValue` failure. `stampAccessibilityNodes` reports these per node rather than failing the whole batch over one detached element. */
  reason?: string;
}

/**
 * S to C, addressed to the requesting viewer ONLY, same reasoning as
 * {@link PageMapGot}. Answers {@link PageMapStamp}.
 */
export interface PageMapStamped extends Envelope {
  t: 'page.map.stamped';
  targetId: string;
  /** One entry per requested index, same order as {@link PageMapStamp.indices}. */
  results: PageMapStampResult[];
  /** The DOM attribute name every succeeded entry in {@link results} was stamped with, addressable as `css=[<marker>]`, exactly as `PageA11yGot.marker` in `./a11y.ts` works. `null` when nothing was actually stamped (every requested index failed). */
  marker: string | null;
  re?: string;
}
