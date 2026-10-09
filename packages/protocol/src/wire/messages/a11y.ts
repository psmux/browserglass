import type { Envelope } from '../envelope.js';

/**
 * `page.a11y.get` / `page.a11y.got`: reads (and, optionally, stamps) nodes
 * from Chrome's OWN accessibility tree, gated on the `devtools` capability.
 *
 * ── Why this is ONE message pair, not two ────────────────────────────────
 *
 * This message pair is the sole caller of `Accessibility.queryAXTree`
 * (`packages/core/src/cdp/accessibility.ts`'s `queryAccessibilityTree`),
 * and it serves two different looking features that are, underneath, the
 * exact same question: "what is this element's role, and what is its
 * accessible name". `AutomationClient.a11y()` asks that question with no
 * filter, for a whole-page read an LLM agent can inspect. The locator
 * engine's `role=` selector (`packages/automation/src/locator/selector.ts`)
 * asks it WITH a role/name filter, to find elements to act on. Both go
 * through this one door, with `role`/`name` present or absent, rather than
 * `role=` re-implementing the WAI-ARIA role and accessible-name computation
 * by hand in page JavaScript. That distinction is not cosmetic:
 * `packages/automation/src/locator/engine.ts`'s module doc used to refuse
 * a `getByRole`-style verb on the grounds that hand rolled role
 * computations in real automation scripts had been seen failing three
 * separate times. Reading Chrome's own answer instead of re-deriving it
 * removes the class of bug that refusal was about, rather than working
 * around it.
 *
 * ── Why `queryAXTree`, not `getFullAXTree` or `getPartialAXTree` ─────────
 *
 * All three were considered.
 *
 *  * `Accessibility.getFullAXTree` returns the WHOLE tree with no filter
 *    at all: exactly what a caller wants for "give me the page", and
 *    exactly wrong for `role=`, which would then have to re-implement the
 *    role/name filtering that Chrome's own engine already does correctly.
 *    It also has no way to narrow the walk, so a large page pays its full
 *    cost even when the caller wants one button.
 *  * `Accessibility.getPartialAXTree` needs a starting node
 *    (`backendNodeId`/`objectId`), which is exactly what neither caller of
 *    this door has yet: `a11y()` wants the whole page, and `role=` wants
 *    to FIND a node, not walk from one it already knows about. Using it
 *    would mean a second round trip just to locate a root, for no benefit
 *    over the primitive below.
 *  * `Accessibility.queryAXTree` accepts OPTIONAL `role`/`accessibleName`
 *    parameters, searched from a starting node: the same one CDP call
 *    answers "give me everything under this root" (`a11y()`, rooted at
 *    the document) and "give me only this" (`role=`, filtered from the
 *    same root), which is what makes ONE core function able to serve both
 *    features honestly instead of two call sites drifting apart over time.
 *
 * A starting node is not optional in practice, even though the CDP spec's
 * own parameter table marks `nodeId`/`backendNodeId`/`objectId` as all
 * optional: measured directly against real Chrome, `queryAXTree` with none
 * of the three throws `"Either nodeId, backendNodeId or objectId must be
 * specified"`. `packages/core/src/cdp/accessibility.ts`'s `queryAccessibilityTree`
 * therefore runs one cheap `DOM.getDocument({depth: 0})` first, purely to
 * learn the document's own `nodeId` (`depth: 0` returns just the root
 * node, no children, so this is not a tree walk); an unfiltered `a11y()`
 * call is then "search from the root with no filter", not "search from
 * nowhere". An unfiltered call still walks Chrome's whole accessibility
 * tree internally; `queryAXTree` does not make that walk cheaper than
 * `getFullAXTree` would, it only adds the filter that makes the FILTERED
 * case (which `role=` always is) narrow. What this module controls is the
 * size of what comes BACK over the wire, per {@link MAX_A11Y_RESULT_BYTES},
 * and it is honest about that split: pass `role`/`name` when a caller
 * knows what they want, the same advice this codebase already gives about
 * narrowing an `evaluate()` expression rather than reading the whole page
 * and filtering client side.
 *
 * ── Bounded, and truncation reported as DATA, not refused ────────────────
 *
 * `nodes` is bounded, exactly `./evaluate.ts`'s own precedent
 * (`MAX_EVALUATE_RESULT_BYTES`): {@link MAX_A11Y_RESULT_BYTES} caps the
 * JSON size of the returned array. Unlike `page.evaluate`, going over that
 * cap is NOT an error: it is reported honestly as `truncated: true` with
 * the real `total`, the same idiom `resolve()`'s own `ResolveResult` uses
 * (`packages/automation/src/locator/types.ts`). The two surfaces made
 * opposite choices for a reason specific to each: an `evaluate()` result is
 * one caller-shaped value, and a truncated one is a DIFFERENT, potentially
 * misleading value, so evaluate refuses outright. An accessibility tree is
 * a LIST of independent nodes; dropping the tail of the list still leaves
 * every remaining node's role, name and properties exactly correct, which
 * is the same reasoning `ResolveResult.truncated` already rests on for
 * locator matches.
 *
 * ── Gated on `devtools`, not `evaluate` or a fresh capability ────────────
 *
 * `a11y()` runs no page script: `queryAXTree` and the DOM attribute write
 * `stamp: true` triggers are CDP domain calls, not `Runtime.evaluate`, so
 * gating this on `evaluate` would ask for a capability this feature does
 * not use. `devtools` already covers reading a target's structure and
 * content beyond literal console/network lines: `./response-body.ts`
 * extended it to response bodies on exactly this argument ("devtools...
 * already covers reading a target's structure and content"), and an
 * accessibility tree read is the same kind of read, one layer deeper into
 * the page than the DOM a viewer already sees rendered. `role=`, which layers
 * this door underneath an ordinary `resolve()` call, therefore needs BOTH
 * `devtools` (for this message) and `evaluate` (for the `page.evaluate`
 * call `resolve()` still makes afterwards to run the rewritten selector):
 * that is not an oversight, it is an honest account of the two distinct
 * things `role=` actually does, CDP domain reads and page script.
 *
 * ── `stamp`, and why it needs no capability beyond `devtools` ────────────
 *
 * `stamp: true` writes one DOM attribute per matched node, THROUGH
 * `DOM.setAttributeValue`, never through page script: see
 * `packages/core/src/cdp/accessibility.ts`'s module doc for why that
 * command needs no `DOM.enable` bracket here, mirroring
 * `packages/core/src/cdp/hit-test.ts`'s own measured finding for the same
 * domain. The mutation itself is a marker attribute with a random name and
 * no meaningful value, in the same risk class as the `data-bgls-ref` stamp
 * `resolve()` already writes under `evaluate` alone
 * (`packages/automation/src/locator/script.ts`): it carries no data out of
 * the page, changes no page behaviour, and a caller holding `devtools` but
 * not `evaluate` gains nothing actionable from writing it, since nothing
 * on this wire lets that caller read an element back by attribute without
 * `evaluate` too. Requiring a second capability here would be a partial,
 * confusing echo of a protection `evaluate` already provides properly.
 */

/**
 * The largest `page.a11y.got` node list, in UTF-8 bytes of its JSON
 * encoding, the server will put on the wire. 256 KiB: a quarter of
 * `./evaluate.ts`'s `MAX_EVALUATE_RESULT_BYTES`. An accessibility node is a
 * small, uniform, self-describing record (a role token, a short name, a
 * handful of booleans), nothing like the arbitrary caller-shaped value
 * `evaluate()` has to budget for, so a materially smaller ceiling still
 * comfortably covers a real page's interactive surface while keeping a
 * whole-tree `a11y()` read on a very large page from dominating a control
 * socket also carrying video frames.
 */
export const MAX_A11Y_RESULT_BYTES = 262144;

/** The default {@link PageA11yGet.maxNodes} when omitted. */
export const DEFAULT_A11Y_MAX_NODES = 200;

/**
 * The largest {@link PageA11yGet.maxNodes} a caller may ask for. Bounds the
 * number of individual `DOM.setAttributeValue` round trips one `stamp:
 * true` request can cause (one per matched node), not merely the reply
 * size {@link MAX_A11Y_RESULT_BYTES} already bounds independently.
 */
export const MAX_A11Y_MAX_NODES = 1000;

/**
 * C to S: reads Chrome's own accessibility tree for one target, optionally
 * filtered by role and/or accessible name, optionally stamping every
 * returned node with a DOM attribute a subsequent `resolve()` can address.
 * Requires `devtools`; see this module's doc for the full scoping
 * argument.
 */
export interface PageA11yGet extends Envelope {
  t: 'page.a11y.get';
  /** The BrowserGlass target id (`tgt_*`) to read. Resolved only within the caller's own session registry, the identical seam `page.evaluate` uses. */
  targetId: string;
  /** Restrict to nodes whose computed role EXACTLY equals this (Chrome's own AX role vocabulary, which matches WAI-ARIA role names for the common interactive roles). Omit for every role. */
  role?: string;
  /** Restrict to nodes whose computed accessible name equals this once whitespace is trimmed and collapsed on both sides (Chrome reports names like " Login" for a button with an icon before its label). A whole-name, case sensitive match, not a substring; the same rule as Playwright's `get_by_role(name=..., exact=True)`. */
  name?: string;
  /** Cap on returned nodes, before the {@link MAX_A11Y_RESULT_BYTES} byte ceiling is also applied. Default {@link DEFAULT_A11Y_MAX_NODES}, capped server side at {@link MAX_A11Y_MAX_NODES}. `PageA11yGot.total` still reports the real match count. */
  maxNodes?: number;
  /**
   * Default false. When true, every node actually returned (after both
   * bounds above) is stamped with a fresh, per-request DOM attribute
   * through `DOM.setAttributeValue`, and {@link PageA11yGot.marker} carries
   * the attribute name a `css=[...]` selector can address it by. This is
   * what turns a role/name filter into an ordinary, chainable locator
   * selector: see this module's doc, "why this is ONE message pair".
   */
  stamp?: boolean;
}

/** One accessibility node, shaped for an LLM reader rather than a raw `AXNode` dump: role, name, and only the properties that decide whether it is actionable. See `packages/core/src/cdp/accessibility.ts`'s `AxTreeNode` for the server-side source of this shape. */
export interface A11yNode {
  /** Chrome's own computed role string (`'button'`, `'link'`, `'textbox'`, ...). Never the literal `role` HTML attribute; see `LocatorMatch.role`'s own doc for that distinction. */
  role: string;
  /** Chrome's own computed accessible name, already resolved through `aria-label`/`aria-labelledby`/native labelling/text content, in that priority order, by Chrome's engine rather than by this codebase's own `label=` four-rule approximation. */
  name: string;
  /**
   * CDP's own `backendDOMNodeId`. Meaningful only for correlating within
   * one `page.a11y.got` reply (never sent back to the server as an
   * argument to anything) and specifically NOT a handle: it names a slot
   * in Chrome's own DOM bookkeeping, not a live JavaScript reference, and
   * nothing on this wire can turn it into one.
   */
  backendNodeId: number;
  /** Whether Chrome's accessibility engine excludes this node from what a screen reader would announce (a decorative wrapper, a `display:none` subtree, `aria-hidden="true"`). `role=` matching never returns an ignored node; a raw `a11y()` read does, so a caller doing whole-page inspection can still see it. */
  ignored: boolean;
  /** `null` when Chrome's AX tree carries no `focusable` property for this node at all, which is a different answer from Chrome asserting it is `false`. */
  focusable: boolean | null;
  disabled: boolean | null;
  hidden: boolean | null;
  expanded: boolean | null;
  /** `'mixed'` for a tri-state checkbox in its indeterminate state; CDP's own third value here, kept rather than collapsed to `true`/`false`/`null`. */
  checked: boolean | 'mixed' | null;
  pressed: boolean | 'mixed' | null;
  selected: boolean | null;
  required: boolean | null;
  readonly: boolean | null;
  /** `true`/`false`, or a string reason such as `'spelling'`/`'grammar'` when Chrome's AX tree names one; CDP's own value, passed through rather than collapsed. */
  invalid: boolean | string | null;
  /** Heading/tree-item nesting level, when the role has one. */
  level: number | null;
}

/**
 * S to C, addressed to the requesting viewer ONLY, never broadcast, for the
 * identical reason `page.evaluated` and `page.responsebody.got` are: an
 * accessibility tree is page content, so fanning it out to every viewer of
 * the session would be a data leak in the same class as broadcasting a
 * `clipboard.data` reply. Answers {@link PageA11yGet}.
 */
export interface PageA11yGot extends Envelope {
  t: 'page.a11y.got';
  targetId: string;
  nodes: A11yNode[];
  /** How many nodes matched before {@link maxNodes}/{@link MAX_A11Y_RESULT_BYTES} were applied. */
  total: number;
  /** True when `nodes.length < total`: either bound cut the reply short. See this module's doc, "bounded, and truncation reported as data". */
  truncated: boolean;
  /**
   * The DOM attribute name every node in {@link nodes} was actually
   * stamped with, addressable as `css=[<marker>]`. Present only when
   * {@link PageA11yGet.stamp} was true AND at least one node was actually
   * stamped; `null` when `stamp` was not asked for, or asked for but
   * nothing matched, or every stamp attempt failed (a node detached
   * between the query and the write, which `DOM.setAttributeValue` reports
   * per node rather than failing the whole request over).
   */
  marker: string | null;
}
