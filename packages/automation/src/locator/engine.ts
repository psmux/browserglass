import { MAX_EVALUATE_TIMEOUT_MS } from '@browserglass/protocol';
import type { EvaluateWorld } from '@browserglass/protocol';
import { AutomationError } from '../errors.js';
import {
  CLEAR_SCRIPT,
  DISPATCH_CLICK_SCRIPT,
  FIND_IN_PAGE_SCRIPT,
  READ_SCRIPT,
  RESOLVE_SCRIPT,
  SELECT_SCRIPT,
  WAIT_SCRIPT,
} from './script.js';
import {
  STALE_RESOLVE_WINDOW_MS,
  actionabilityError,
  parseRoleValue,
  parseSelector,
  splitSegments,
  terminalEngine,
} from './selector.js';
import type { SelectorSegment } from './selector.js';
import type {
  ClickResult,
  DropdownOption,
  FillResult,
  FindInPageMatch,
  FindInPageOptions,
  FindInPageResult,
  HoverResult,
  LocatorClickOptions,
  LocatorFillOptions,
  LocatorHoverOptions,
  LocatorMatch,
  LocatorScrollContainerOptions,
  LocatorSelectOptions,
  LocatorState,
  ResolveOptions,
  ResolveResult,
  ScrollContainerResult,
  SelectOptionSpec,
  SelectResult,
  WaitForOptions,
  WaitForResult,
} from './types.js';

/**
 * How much longer the transport and server deadline is than the in-page
 * wait's own deadline. The page must be the one that gives up, because only
 * the page can say what the element looked like when it did; a server-side
 * evaluate timeout arriving first would replace a report naming the failed
 * actionability check with a bare `bgls.error.evaluate.timeout`.
 */
const WAIT_EVALUATE_MARGIN_MS = 2000;

/**
 * How long one in-page wait slice runs when the selector has a `role=`
 * segment, before the accessibility query is repeated. See `waitForHop`.
 */
const ROLE_REQUERY_MS = 1000;

/**
 * Whether `err` is the page changing under a query rather than an answer
 * about it: a navigation replaced the document, or the execution context the
 * evaluate ran in was torn down. A wait keeps polling through these; every
 * other error still ends it.
 */
export function isTransientNavigationError(err: unknown): boolean {
  if (err instanceof AutomationError) {
    if (
      err.code === 'TARGET_CLOSED' ||
      err.code === 'INSTANCE_GONE' ||
      err.code === 'LEASE_REVOKED' ||
      err.code === 'POLICY_DENIED' ||
      err.code === 'INVALID_ARGUMENT'
    )
      return false;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id|Cannot find default execution context|Could not find node with given id|No frame with given id|frame (was )?detached/i.test(
    message,
  );
}

/** Whether a `role=` segment sits before the first `frame=` segment, i.e. one this hop resolves itself. */
function selectorHasLiveRole(segments: SelectorSegment[]): boolean {
  for (const seg of segments) {
    if (seg.engine === 'frame') return false;
    if (seg.engine === 'role') return true;
  }
  return false;
}

/**
 * The world every one of this engine's own six fixed scripts runs in.
 *
 * `'isolated'`, and this is the single most consequential default in the
 * locator surface. Three separate reasons.
 *
 * 1. PARITY. patchright's Python client declares `isolatedContext:
 *    Optional[bool] = True` on `page.evaluate`, `frame.evaluate`,
 *    `locator.evaluate` and `handle.evaluate` (`patchright/_impl/_page.py:452`,
 *    `_frame.py:313`, `_locator.py:168`, `_js_handle.py:58`), which its
 *    server side maps to `world: 'utility'`. So every read an automation
 *    script written against patchright takes comes from an isolated world.
 *    A main world default here is not a neutral choice; it is a behaviour
 *    change for anybody porting such a script.
 *
 * 2. THE PAGE CANNOT WATCH. An isolated world shares the DOM and nothing
 *    else. A page cannot hook the functions these scripts call, cannot see
 *    the globals they define, and cannot tamper with what they return.
 *    That is the whole point on a site that is looking for automation.
 *
 * 3. THE BOUNDARY IS LOAD BEARING FOR CODE THAT IS NOT OURS. Automation
 *    scripts written against patchright often carry callback branches that
 *    reach for `window.hcaptcha`, `window.hcaptchaOnLoad` and other named
 *    page callbacks, each wrapped in an empty catch. That code is dead
 *    under an isolated world, precisely because the isolated world makes
 *    those globals `undefined`. Run the same evaluate in the main world and
 *    it comes back to life, silently, on every page whose hCaptcha
 *    challenge was already solved. The rule also holds the other way
 *    round: after the hCaptcha frames are removed, calling into
 *    `window.hcaptcha` crashes the renderer, and the world boundary is what
 *    enforces that for free. A submit blocker that monkeypatches
 *    `HTMLFormElement.prototype.submit` is page-visible from the main world
 *    and invisible from here.
 *
 * The cost is real and is stated here so nobody has to rediscover it: a
 * script running in this world reading `window.somethingThePageSet` gets
 * `undefined`, every time, and that is indistinguishable from the value not
 * existing. None of the six scripts below reads a page global. They read
 * and write the DOM, which is shared, and that is all an isolated world
 * needs to be able to do.
 *
 * A caller who genuinely needs a page global has one door, and it is
 * explicit: `LocatorClickOptions.verifyWorld`. See its own doc.
 */
export const ENGINE_WORLD: EvaluateWorld = 'isolated';

/** Default overall deadline for `click`/`fill`. Most real click sites pass an explicit timeout, so this is only the value for callers that do not. */
const DEFAULT_ACT_TIMEOUT_MS = 8000;

/**
 * A runtime backstop on how many cross-origin frame hops one `resolve()`/
 * `waitFor()` call will follow, on top of `selector.ts`'s own
 * `MAX_FRAME_SEGMENTS` (a selector-text bound, checked once, before any
 * round trip). This one guards the RECURSION rather than the text: every
 * hop strictly consumes at least one `frame=` segment from the remaining
 * selector (`enterFrame`'s `remaining` is always shorter than what it was
 * given), so `MAX_FRAME_SEGMENTS` already makes this loop terminate; this
 * constant exists purely as defence in depth against that invariant ever
 * being violated by a future edit, cheap insurance against turning a bug
 * into a hang.
 */
const MAX_FRAME_HOPS = 5;

/**
 * How many attached `iframe`-kind CDP targets `enterFrame` will compare a
 * cross-origin frame's `src` against before giving up and reporting
 * `AMBIGUOUS`. Mirrors browser-use's own page-wide iframe count cap
 * (`dom/service.py`): unlike that design, this surface never scans every
 * iframe on a page (it only ever looks at the ONE the caller's `frame=`
 * segment named), so this bound is defence in depth against a pathological
 * target list, not a load-bearing limit on ordinary use.
 */
const MAX_FRAME_TARGET_CANDIDATES = 100;

/**
 * Everything `AutomationClient` needs from its own internals to drive the
 * locator surface, passed in rather than reached for.
 *
 * Every one of these is the RAW form of a method `AutomationClient`
 * already has: no `run()` wrapper, so one locator verb costs one step
 * rather than one per composed sub-action, and no second input path. In
 * particular `clickPoint` is literally the body `clickAt()` runs, which
 * means a locator click inherits the generation stamp, the stand-down
 * gate, the lease id and the fencing exactly as a human's click does.
 * Adding a second way into `InputDispatcher` would have thrown away the
 * one thing this surface has that a Playwright port cannot: the shared
 * control model.
 */
export interface LocatorRuntime {
  /**
   * Runs a `functionDeclaration` with JSON args, returning by value, in the
   * named world.
   *
   * `world` is REQUIRED, and it is required on purpose. It was added as an
   * optional trailing parameter first, and an optional parameter here is a
   * parameter a future call site forgets: the failure mode is silent, the
   * script runs in the main world, and the page can see everything the
   * locator surface does. Making it required turns "which world does this
   * script want" into a decision the compiler forces at every call site.
   * See {@link ENGINE_WORLD} for what the engine's own scripts pass and
   * why.
   */
  evaluateFunction<T>(
    targetId: string,
    source: string,
    args: readonly unknown[],
    timeoutMs: number,
    world: EvaluateWorld,
  ): Promise<T>;
  /** Runs a bare expression, for the caller-supplied `verify` predicate. Same required `world` as {@link evaluateFunction}. */
  evaluateExpression<T>(
    targetId: string,
    expression: string,
    timeoutMs: number,
    world: EvaluateWorld,
  ): Promise<T>;
  /**
   * Everything the input path has to do BEFORE it can send a frame, done
   * as its own step so the staleness window can be checked after it rather
   * than before it.
   *
   * On this client that is `ensureGen()`, which is a real round trip the
   * first time it runs on a target, and lease and generation work is the
   * thing most likely to consume the window between
   * a measurement and the dispatch it feeds. A staleness check placed
   * before this would be checking a gap that is always zero, which is a
   * guard that looks like a guard and is not one.
   */
  prepareDispatch(targetId: string): Promise<void>;
  /** One `down`/`up` pair at a viewport CSS pixel, through the held lease. */
  clickPoint(
    targetId: string,
    x: number,
    y: number,
    opts: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    },
  ): Promise<void>;
  /** One pointer move to a viewport CSS pixel, through the held lease. What {@link hover} drives; the raw body `AutomationClient.moveTo()` runs. */
  movePoint(targetId: string, x: number, y: number): Promise<void>;
  /** One wheel event at a viewport CSS pixel, through the held lease. What {@link scrollContainer} drives; the raw body `AutomationClient.scroll()` runs. */
  wheelAt(targetId: string, x: number, y: number, dx: number, dy: number): Promise<void>;
  /** Per-character `keydown`/`keyup` pairs, checking for a takeover between every character. */
  typeChars(targetId: string, text: string, delayMs: number): Promise<void>;
  /** One `Input.insertText`, no key events. */
  insertText(targetId: string, text: string): Promise<void>;
  /** Sleeps, without pinning a timer that would keep a Node process alive. */
  sleep(ms: number): Promise<void>;
  readonly defaultTimeoutMs: number;
  /**
   * Resolves a `role=` segment's role/name filter through
   * `Accessibility.queryAXTree` and stamps every match with a fresh DOM
   * attribute, so the segment can be rewritten into an ordinary `css=`
   * selector before it ever reaches {@link RESOLVE_SCRIPT}. Returns the
   * stamped attribute NAME (addressable as `[<attr>]`, a presence
   * selector, no value to escape), or `null` when nothing matched, in
   * which case the caller should short-circuit to an empty result rather
   * than running a doomed round trip through the page's own resolver.
   *
   * This is the ONE place a `resolve()` call reaches outside
   * {@link RESOLVE_SCRIPT}/`Runtime.evaluate`: see `AutomationClient.a11y()`'s
   * own doc, and `@browserglass/protocol`'s `wire/messages/a11y.ts`, for
   * why `role=` is built on the SAME CDP call `a11y()` is, rather than a
   * second, hand rolled implementation of "what is this element's role".
   */
  queryAndStampByRole(
    targetId: string,
    role: string | undefined,
    name: string | undefined,
    timeoutMs: number,
  ): Promise<{ attr: string | null }>;
  /**
   * Every currently attached CDP target of kind `'iframe'`, a plain,
   * synchronous read of a list the client already keeps in sync from
   * `welcome.targets` plus every `target.*` broadcast since (no round trip,
   * no capability check: see `AutomationClient`'s own `targets` getter,
   * which reads the identical cache).
   *
   * This is `enterFrame`'s one and only way to turn "an iframe element with
   * this `src`" into a BrowserGlass target id, and it is a heuristic, not a
   * guarantee: `TargetSummary` (`@browserglass/protocol`'s
   * `wire/messages/targets.ts`) carries no `parentTargetId`, so there is no
   * wire-level fact saying which target owns which iframe ELEMENT, only
   * which targets exist and what they are currently showing. Matching
   * therefore proceeds by URL, which is precise for the ordinary case (one
   * page, one iframe at that `src`) and can be genuinely ambiguous for the
   * degenerate one (two different tabs each showing the same third-party
   * widget at the same URL); `enterFrame` reports that ambiguity as
   * `AMBIGUOUS` rather than guessing. A future `TargetSummary.parentTargetId`
   * (populated from `Page.frameAttached`'s `parentFrameId`, which
   * `packages/core`'s `TargetRegistry` already has available) would remove
   * the heuristic entirely; adding it is outside this surface's owned files.
   */
  listFrameTargets(): readonly { targetId: string; url: string }[];
}

/**
 * What `bglsEnterFrame` (`script.ts`) reports when a `frame=` segment
 * cannot be finished in the current evaluation. `atSegment` indexes into
 * the CLIENT's own `parseSelector(selector)` array, never re-derived from
 * the page's own parse: both sides split identically (`selector.ts`'s
 * module doc), so the client already has, at `segments[atSegment]`, every
 * segment before and after this one, including each one's original
 * `source` text needed to rebuild the selector for the next hop.
 */
interface WireFrameBoundary {
  atSegment: number;
  reason: 'ambiguous' | 'not_a_frame' | 'too_small' | 'cross_origin';
  matchCount: number;
  /** Set only for `reason: 'cross_origin'`: the matched iframe's `src` attribute, for correlating it to an attached CDP target. `null` when the iframe has none. */
  candidateSrc?: string | null;
  /** Set only for `reason: 'cross_origin'`: this frame's own top-document offset, in CSS px, to add to whatever the next hop measures locally. */
  offsetX?: number;
  offsetY?: number;
}

/** The shape `RESOLVE_SCRIPT` returns. Kept separate from `ResolveResult` because the page cannot know the client's clock or the selector's original text. */
interface WireResolveResult {
  matches: LocatorMatch[];
  total: number;
  truncated: boolean;
  engine: ResolveResult['engine'];
  segments: number;
  scopeMissing: boolean;
  /** Set when the page's own selector engine refused the selector. Reported as data rather than thrown, for the reason `bglsResolve` gives. */
  selectorError: string | null;
  url: string;
  title: string;
  viewport: { w: number; h: number; scrollX: number; scrollY: number };
  /** Set when a `frame=` segment stopped the chain short of a full resolve. See {@link WireFrameBoundary}. */
  frameBoundary?: WireFrameBoundary | null;
}

/** The shape `WAIT_SCRIPT` returns. */
interface WireWaitResult {
  timedOut: boolean;
  result: WireResolveResult | null;
  waitedMs: number;
  checks: number;
  wakes: number;
  failed?: boolean;
  error?: string;
  stampError?: string;
  /** Set when the wait's own `bglsResolve` hit a frame boundary, decided on its first check rather than polled for. See {@link WireFrameBoundary}. */
  frameBoundary?: WireFrameBoundary;
}

/** The shape `SELECT_SCRIPT` returns. */
interface WireSelectResult {
  found: boolean;
  /** Set when more than one option was asked for on a `<select>` with no `multiple` attribute; nothing was mutated. */
  notMultiple?: boolean;
  /** The requested specs that matched no `<option>`; nothing was mutated when this is non-empty. */
  missing?: Array<{ value?: string; label?: string; index?: number }>;
  /** Every `<option>` the `<select>` actually offers, present only alongside {@link missing}: what the option-not-found error names. */
  available?: Array<{ value: string; label: string; index: number }>;
  values?: string[];
  labels?: string[];
}

/** The page-side option spec `SELECT_SCRIPT` matches against: exactly one of `value`, `label` or `index`. */
type WireSelectOption = { value: string } | { label: string } | { index: number };

/** The shape `FIND_IN_PAGE_SCRIPT` returns. */
interface WireFindInPageResult {
  matches: FindInPageMatch[];
  total: number;
  truncated: boolean;
  /** Set when `spec.scope` was given and matched nothing. */
  scopeMissing: boolean;
  /** Set when the page's own `new RegExp(pattern, flags)` refused the pattern. Reported as data, the same reason `bglsResolve`'s own selector failures are (see `script.ts`'s module doc). */
  patternError: string | null;
  url: string;
  title: string;
}

/** A bare `string` means `{ value }`, matching Playwright's own `select_option(selector, "value")` shorthand. */
function normalizeSelectOption(spec: SelectOptionSpec): WireSelectOption {
  return typeof spec === 'string' ? { value: spec } : spec;
}

/** A random per-call prefix, so two concurrent resolves on one page cannot mint the same ref. Short on purpose: it ends up in the DOM and in every log line that mentions the match. */
function mintRefPrefix(): string {
  return `bg${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Escapes every regex metacharacter in `s`, so a literal `findInPage`
 * pattern behaves as `String.prototype.includes` would rather than as a
 * regex a caller did not ask to write.
 *
 * Real TypeScript, on purpose: see {@link FIND_IN_PAGE_SCRIPT}'s own doc
 * for why this escaping happens here and never inside the page script
 * text.
 */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every actionability check that has an answer, passing.
 *
 * `stable` and `hitTestOk` of `null` mean "could not be determined" (a tab
 * that never painted, or the check was not asked for) and do NOT
 * disqualify a match. Refusing to act on a backgrounded tab would be
 * strictly worse than acting on it, and a backgrounded tab is the one an
 * unattended agent is most likely to be driving.
 */
function isActionable(m: LocatorMatch): boolean {
  return m.attached && m.visible && m.enabled && m.hitTestOk !== false && m.stable !== false;
}

/** An empty result, for the failure paths that have to build an error before any observation arrived. */
function emptyResult(selector: string, resolvedTargetId: string): ResolveResult {
  return {
    matches: [],
    total: 0,
    truncated: false,
    engine: 'css',
    segments: 1,
    selector,
    resolvedAtMs: Date.now(),
    url: '',
    title: '',
    viewport: { w: 0, h: 0, scrollX: 0, scrollY: 0 },
    scopeMissing: false,
    resolvedTargetId,
  };
}

/**
 * Adds a top-document offset to every match's `rect`/`center`. A no-op copy
 * when `offset` is `{0, 0}` (every selector with no `frame=` segment, the
 * overwhelmingly common case): still a new array/objects, never the
 * original references, because a `LocatorMatch` is documented as a value
 * read at one instant and a caller mutating one should not be able to
 * corrupt what another part of this engine still holds.
 */
function translateMatches(
  matches: readonly LocatorMatch[],
  offset: { x: number; y: number },
): LocatorMatch[] {
  if (offset.x === 0 && offset.y === 0) return matches.map((m) => ({ ...m }));
  return matches.map((m) => ({
    ...m,
    rect: { ...m.rect, x: m.rect.x + offset.x, y: m.rect.y + offset.y },
    center: { x: m.center.x + offset.x, y: m.center.y + offset.y },
  }));
}

/**
 * Picks the one attached `iframe`-kind CDP target a cross-origin frame's
 * `src` correlates to, out of `candidates`. See
 * `LocatorRuntime.listFrameTargets`'s own doc for what this heuristic is
 * and is not: an EXACT url match is tried first (precise whenever a page
 * has at most one iframe currently showing that exact URL), and only when
 * that finds nothing does an ORIGIN match run (forgiving of an iframe that
 * navigated client-side since its initial `src`, at the cost of matching
 * every OTHER iframe from that origin too). Returns every match at
 * whichever tier found one, so the caller can tell "found none" from
 * "found more than one" and report each honestly.
 */
function matchFrameTarget(
  candidates: readonly { targetId: string; url: string }[],
  src: string | null,
): readonly { targetId: string; url: string }[] {
  if (src === null) return [];
  let srcUrl: URL | null = null;
  try {
    srcUrl = new URL(src);
  } catch {
    srcUrl = null;
  }
  if (srcUrl === null) return [];
  const exact = candidates.filter((c) => c.url === srcUrl.href);
  if (exact.length > 0) return exact;
  return candidates.filter((c) => {
    try {
      return new URL(c.url).origin === srcUrl.origin;
    } catch {
      return false;
    }
  });
}

/**
 * The locator verbs, composed from one resolver script and the client's
 * existing input path.
 *
 * The verb list is short and every entry earned its place against measured
 * call counts in real automation scripts rather than against Playwright's
 * surface. What is deliberately absent is as much of the design as what is
 * present: no `count()`, no `first`, no `nth()`, no `isVisible()`, because
 * `resolve` already answered all four and shipping them as aliases would
 * guarantee ported code kept its four-round-trip shape; no frame locators,
 * because real scripts rarely need them; and no strict mode, because a page
 * matching a selector twice is a fact about the page.
 *
 * `role=` IS here, on top of `resolve` rather than as a fourth thing to
 * keep in sync with it. An earlier pass over this file refused a
 * `getByRole`-style verb on the grounds that it is an ARIA specification
 * rather than a function, and that hand rolled role computations are known
 * to fail in practice. Both
 * objections were really about ONE mistake, reimplementing WAI-ARIA role
 * and accessible-name computation in page JavaScript by hand, and `role=`
 * does not make it: it asks Chrome's OWN accessibility engine, through
 * `Accessibility.queryAXTree` (`packages/core/src/cdp/accessibility.ts`),
 * for the same answer `AutomationClient.a11y()` reads, then stamps the
 * matches with a DOM attribute and rewrites the segment to an ordinary
 * `css=[...]` selector before {@link RESOLVE_SCRIPT} ever sees it. See
 * this class's own `prepareSelector` for the mechanics, and
 * `@browserglass/protocol`'s `wire/messages/a11y.ts` for the full "why one
 * source of truth" argument. `page.get_by_role(` is common in real
 * Playwright scripts and was the one selector form this surface did not
 * already cover. A `<button>` with no
 * `role` attribute or an `<a>` with no `href` are exactly the markup a
 * `[role="x"]` CSS lookalike would have gotten wrong.
 */
export class LocatorEngine {
  constructor(private readonly rt: LocatorRuntime) {}

  // ==================================================================
  // resolve: the primitive
  // ==================================================================

  async resolve(targetId: string, selector: string, opts?: ResolveOptions): Promise<ResolveResult> {
    return this.resolveHop(targetId, selector, opts, { x: 0, y: 0 }, 0);
  }

  /**
   * `resolve()`'s real body, factored out so it can recurse across a
   * `frame=` boundary without `resolve()`'s own public signature carrying
   * hop bookkeeping (`offset`, `hopDepth`) no caller outside this class
   * needs to see. A selector with no `frame=` segment takes the `hopDepth
   * === 0` branch once and returns: one round trip, `offset` a no-op,
   * `resolvedTargetId` equal to `targetId`, identical to this method before
   * frame traversal existed. See this file's module doc on round-trip
   * economics for why that has to stay true.
   */
  private async resolveHop(
    targetId: string,
    selector: string,
    opts: ResolveOptions | undefined,
    offset: { x: number; y: number },
    hopDepth: number,
  ): Promise<ResolveResult> {
    const segments = parseSelector(selector);
    const timeoutMs = opts?.timeoutMs ?? this.rt.defaultTimeoutMs;
    const effective = await this.prepareSelector(targetId, selector, segments, timeoutMs);
    if (effective === null) {
      // A `role=` segment matched nothing: nothing downstream of an empty
      // segment can ever match either, the same short-circuit the page's
      // own `bglsResolve` loop already applies to an ordinary CSS segment
      // matching nothing (`if (current.length === 0) break`). Reported
      // without spending the round trip to `RESOLVE_SCRIPT` to prove it
      // again.
      return {
        ...emptyResult(selector, targetId),
        engine: terminalEngine(segments),
        segments: segments.length,
      };
    }
    const spec = this.buildResolveSpec(effective, opts);
    const wire = await this.rt.evaluateFunction<WireResolveResult>(
      targetId,
      RESOLVE_SCRIPT,
      [spec],
      timeoutMs,
      ENGINE_WORLD,
    );
    // Local validation catches the shapes that are wrong on their face; the
    // page's own selector engine is the authority on the rest, and its
    // refusal comes back as data so that both `resolve` and the wait loop
    // can report it as INVALID_ARGUMENT rather than as a page exception a
    // caller has to read a stack to understand.
    if (wire.selectorError) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `resolve('${selector}'): the page could not evaluate the selector: ${wire.selectorError}`,
        { selector, pageError: wire.selectorError },
      );
    }
    if (wire.frameBoundary) {
      const hop = await this.enterFrame(
        targetId,
        selector,
        segments,
        wire.frameBoundary,
        offset,
        hopDepth,
      );
      return this.resolveHop(hop.targetId, hop.selector, opts, hop.offset, hopDepth + 1);
    }
    return {
      ...wire,
      matches: translateMatches(wire.matches, offset),
      // The page reports the engine it actually used; the client-side parse
      // is the cross-check. They agree or one of the two split rules has
      // drifted, and the tests assert on the client-side answer so that
      // drift shows up as a test failure rather than as a confusing log.
      engine: wire.engine ?? terminalEngine(segments),
      selector,
      resolvedAtMs: Date.now(),
      resolvedTargetId: targetId,
    };
  }

  /**
   * Turns one `WireFrameBoundary` into either the next hop's
   * `{targetId, selector, offset}` (only for `reason: 'cross_origin'`, the
   * one outcome that HAS a next hop) or a thrown `AutomationError` in the
   * existing taxonomy, per this feature's own hard requirement: a frame
   * that cannot be entered fails honestly rather than reading as "nothing
   * matched".
   */
  private async enterFrame(
    targetId: string,
    selector: string,
    segments: SelectorSegment[],
    boundary: WireFrameBoundary,
    offset: { x: number; y: number },
    hopDepth: number,
  ): Promise<{ targetId: string; selector: string; offset: { x: number; y: number } }> {
    if (hopDepth >= MAX_FRAME_HOPS) {
      throw new AutomationError(
        'FRAME_DETACHED',
        `resolve('${selector}'): crossed ${hopDepth} cross-origin frame boundaries, past MAX_FRAME_HOPS (${MAX_FRAME_HOPS}). Refused as a bound against runaway recursion; see MAX_FRAME_HOPS's own doc.`,
        { selector, hopDepth },
      );
    }
    if (boundary.reason === 'ambiguous') {
      throw new AutomationError(
        'AMBIGUOUS',
        `resolve('${selector}'): the 'frame=' segment at position ${boundary.atSegment} matched ${boundary.matchCount} elements. Entering a frame needs exactly one; narrow the selector.`,
        { selector, atSegment: boundary.atSegment, matchCount: boundary.matchCount },
      );
    }
    if (boundary.reason === 'not_a_frame') {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `resolve('${selector}'): the 'frame=' segment at position ${boundary.atSegment} matched an element that is not an <iframe> or <frame>.`,
        { selector, atSegment: boundary.atSegment },
      );
    }
    if (boundary.reason === 'too_small') {
      throw new AutomationError(
        'NOT_VISIBLE',
        `resolve('${selector}'): the frame at position ${boundary.atSegment} is too small to be meaningfully entered.`,
        { selector, atSegment: boundary.atSegment },
      );
    }
    // 'cross_origin': the one outcome the client can act on, given
    // `LocatorRuntime.listFrameTargets`'s own limits.
    const remaining = segments
      .slice(boundary.atSegment + 1)
      .map((s) => s.source)
      .join(' >> ');
    const hopOffset = {
      x: offset.x + (boundary.offsetX ?? 0),
      y: offset.y + (boundary.offsetY ?? 0),
    };
    const candidates = this.rt.listFrameTargets().slice(0, MAX_FRAME_TARGET_CANDIDATES);
    const matched = matchFrameTarget(candidates, boundary.candidateSrc ?? null);
    if (matched.length === 0) {
      throw new AutomationError(
        'FRAME_DETACHED',
        `resolve('${selector}'): the frame at position ${boundary.atSegment} (src ${JSON.stringify(boundary.candidateSrc)}) is cross-origin, and no attached CDP target correlates to it. It may not have finished attaching, or it is sandboxed without 'allow-same-origin'.`,
        { selector, atSegment: boundary.atSegment, candidateSrc: boundary.candidateSrc },
      );
    }
    if (matched.length > 1) {
      throw new AutomationError(
        'AMBIGUOUS',
        `resolve('${selector}'): the frame at position ${boundary.atSegment} (src ${JSON.stringify(boundary.candidateSrc)}) correlates to ${matched.length} attached CDP targets. This is a known limit of src-based frame correlation (see LocatorRuntime.listFrameTargets's own doc), not a mistake in the selector.`,
        {
          selector,
          atSegment: boundary.atSegment,
          candidateSrc: boundary.candidateSrc,
          candidates: matched.map((m) => m.targetId),
        },
      );
    }
    return { targetId: matched[0]!.targetId, selector: remaining, offset: hopOffset };
  }

  private buildResolveSpec(selector: string, opts?: ResolveOptions): Record<string, unknown> {
    return {
      selector,
      limit: opts?.limit ?? 50,
      stamp: opts?.stamp !== false,
      stable: opts?.stable !== false,
      hitTest: opts?.hitTest !== false,
      scroll: opts?.scroll === true,
      scrollIndex: opts?.scrollIndex ?? 0,
      refPrefix: mintRefPrefix(),
      textLimit: opts?.textLimit ?? 200,
      ...(opts?.within !== undefined ? { withinRef: opts.within } : {}),
      ...(opts?.read !== undefined ? { read: opts.read } : {}),
    };
  }

  /**
   * Resolves every `role=` segment in `selector` (there may be more than
   * one, and each may be anywhere in a `>>` chain) and returns the
   * selector a page-side round trip should actually run: `selector`
   * unchanged when it has no `role=` segment, or a rewritten copy with
   * each `role=...` replaced by `css=[<marker>]`, a plain presence
   * selector addressing exactly the elements
   * {@link LocatorRuntime.queryAndStampByRole} just stamped. `null` when
   * ANY role= segment matched nothing, which the caller should treat as
   * "short-circuit to an empty result" rather than run a round trip that
   * cannot produce one.
   *
   * Every role= segment is resolved through the SAME whole-document
   * `Accessibility.queryAXTree` call regardless of where it sits in the
   * chain: `queryAndStampByRole` has no notion of "scoped to the previous
   * segment's matches", only `role=` matching them does. That still
   * produces the right answer for a chain like `'div.form >> role=button'`,
   * because the REWRITE turns `role=button` into `css=[<marker>]`, and the
   * page's own chaining rule for a CSS segment (`root.querySelectorAll(css)`,
   * scoped to the previous segment's matches) is what actually narrows it
   * to descendants of `div.form`. What is unscoped is only the CANDIDATE
   * search on the CDP side, which only matters for a page so large that
   * `maxNodes`/`MAX_A11Y_RESULT_BYTES` cut off the marked candidates
   * before this particular chained subtree's matches were reached; that is
   * the same honest bound `AutomationClient.a11y()` already documents for
   * itself.
   *
   * Independent role= segments are resolved CONCURRENTLY (`Promise.all`):
   * none of them depends on another's answer, for the identical reason.
   */
  private async prepareSelector(
    targetId: string,
    selector: string,
    segments: SelectorSegment[],
    timeoutMs: number,
  ): Promise<string | null> {
    const roleIndexes: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      // Stop at the first 'frame=' segment. A 'role=' AFTER it belongs to
      // the entered frame's own accessibility tree, which does not exist
      // from HERE: `queryAndStampByRole` asks `targetId`'s whole-document
      // `Accessibility.queryAXTree`, and `targetId` at this point is still
      // the PRE-hop target. Resolving it now would stamp an element in the
      // wrong document (or in none). Left unresolved, it flows through as
      // an ordinary 'role=' segment in `enterFrame`'s `remaining` selector,
      // and gets a fresh `prepareSelector` call, scoped correctly, once
      // `resolveHop`/`waitForHop` actually lands on the entered target.
      if (segments[i]?.engine === 'frame') break;
      if (segments[i]?.engine === 'role') roleIndexes.push(i);
    }
    if (roleIndexes.length === 0) return selector;

    const results = await Promise.all(
      roleIndexes.map((i) => {
        const seg = segments[i] as SelectorSegment;
        const filter = parseRoleValue(seg.value, selector);
        return this.rt.queryAndStampByRole(
          targetId,
          filter.role,
          filter.name ?? undefined,
          timeoutMs,
        );
      }),
    );

    const raw = splitSegments(selector);
    for (let k = 0; k < roleIndexes.length; k++) {
      const attr = results[k]?.attr ?? null;
      if (attr === null) return null;
      raw[roleIndexes[k] as number] = `css=[${attr}]`;
    }
    return raw.join(' >> ');
  }

  // ==================================================================
  // waitFor: one evaluate, held in the page
  // ==================================================================

  async waitFor(targetId: string, selector: string, opts?: WaitForOptions): Promise<WaitForResult> {
    const state: LocatorState = opts?.state ?? 'visible';
    const askedMs = opts?.timeoutMs ?? this.rt.defaultTimeoutMs;
    // The in-page deadline plus its margin has to fit inside the server's
    // hard cap, so a caller asking for the maximum gets the maximum wait
    // rather than an `invalid_request`. Computed ONCE, as an absolute clock
    // time, so a frame hop (below) spends what is left of the CALLER's
    // budget rather than restarting a fresh `askedMs` on every boundary it
    // crosses.
    const overallDeadline =
      Date.now() +
      Math.max(0, Math.min(askedMs, MAX_EVALUATE_TIMEOUT_MS - WAIT_EVALUATE_MARGIN_MS));
    return this.waitForHop(targetId, selector, opts, state, overallDeadline, { x: 0, y: 0 }, 0);
  }

  /**
   * `waitFor()`'s real body, split out for the identical reason
   * `resolveHop` is: hop bookkeeping (`offset`, `hopDepth`) is internal.
   *
   * A `frame=` boundary is detected on the WAIT's very first in-page check
   * (`WAIT_SCRIPT`'s own fast-exit, mirroring `selectorError`), never
   * polled for: nothing that happens later in the pre-hop document changes
   * whether the next hop is cross-origin. So crossing N cross-origin
   * boundaries costs N fast round trips plus however long the wait itself
   * takes once it is actually running inside the frame that has the
   * element, not N times the caller's whole deadline.
   */
  private async waitForHop(
    targetId: string,
    selector: string,
    opts: WaitForOptions | undefined,
    state: LocatorState,
    overallDeadline: number,
    offset: { x: number; y: number },
    hopDepth: number,
  ): Promise<WaitForResult> {
    const segments = parseSelector(selector);
    const started = Date.now();
    const pollMs = opts?.pollMs ?? 100;
    // A `role=` segment is resolved by an accessibility query BEFORE the
    // in-page wait starts, and the wait then watches the elements that
    // query stamped. A matching element that appears later carries no
    // stamp, so the in-page wait could never see it. With a role segment
    // in play the in-page wait therefore runs in slices, and every slice
    // starts with a fresh accessibility query.
    const hasRole = selectorHasLiveRole(segments);
    const sliceMs = hasRole ? ROLE_REQUERY_MS : Number.POSITIVE_INFINITY;
    // Bounded by a count as well as by the clock: the unit tests drive this
    // with fake clocks that do not always move, and a deadline-only loop
    // spins forever there (the same trap `fill`'s read-back hit).
    const maxRounds = Math.ceil(Math.max(0, overallDeadline - started) / Math.min(pollMs, 250)) + 2;
    let checks = 0;
    let wakes = 0;
    let lastObserved: ResolveResult | null = null;

    for (let round = 0; ; round++) {
      const deadlineMs = Math.max(0, overallDeadline - Date.now());
      const outOfTime = deadlineMs <= 0 || round >= maxRounds;

      let effective: string | null;
      try {
        effective = await this.prepareSelector(targetId, selector, segments, deadlineMs);
      } catch (err) {
        // A navigation landing mid-query is not an answer about the page,
        // it is the page changing under the question. Ask again.
        if (!outOfTime && isTransientNavigationError(err)) {
          await this.rt.sleep(Math.min(pollMs, deadlineMs));
          continue;
        }
        throw err;
      }

      if (effective === null) {
        // A `role=` segment matched nothing. `detached` and `hidden` are
        // satisfied by an empty match set (mirroring `bglsSatisfied`'s own
        // rule for `res.total === 0`) and succeed immediately. Every other
        // state keeps polling until the deadline, the same as a CSS
        // selector that matches nothing yet: the element may still be on
        // its way.
        checks += 1;
        const observed: ResolveResult = {
          ...emptyResult(selector, targetId),
          engine: terminalEngine(segments),
          segments: segments.length,
        };
        if (state === 'detached' || state === 'hidden') {
          return { ...observed, waitedMs: Date.now() - started, checks, wakes };
        }
        if (outOfTime) {
          throw this.waitTimeoutError(
            selector,
            state,
            lastObserved ?? observed,
            { timedOut: true, result: null, waitedMs: Date.now() - started, checks, wakes },
            Date.now() - started,
          );
        }
        // An accessibility query is far heavier than an in-page check, so
        // it is not repeated at the in-page poll rate.
        await this.rt.sleep(Math.min(Math.max(pollMs, 250), deadlineMs));
        continue;
      }

      // The polling passes deliberately measure less than the final one:
      // 'attached', 'detached', 'visible' and 'hidden' do not depend on rect
      // stability or on the hit test, and paying two animation frames plus a
      // hit test ten times a second for an answer that does not use them is
      // waste inside the page even when it costs nothing on the socket.
      const wantsFullMeasure = state === 'actionable';
      const check = this.buildResolveSpec(effective, {
        ...opts,
        stamp: false,
        stable: wantsFullMeasure && opts?.stable !== false,
        hitTest: wantsFullMeasure && opts?.hitTest !== false,
      });
      const stampSpec =
        opts?.stamp === false ? null : this.buildResolveSpec(effective, { ...opts, stamp: true });

      const sliceDeadlineMs = Math.min(deadlineMs, sliceMs);
      let wire: WireWaitResult;
      try {
        wire = await this.rt.evaluateFunction<WireWaitResult>(
          targetId,
          WAIT_SCRIPT,
          // `index` goes to the page, not just to the client, and it changes
          // what the wait is waiting FOR. Without it the wait is satisfied the
          // moment ANY match is actionable, so a caller who named index 0
          // would be released by index 1 becoming ready and would then have to
          // fail on its own element. Waiting for the right one is both more
          // correct and, on a page that renders its fields in order, faster.
          [
            {
              check,
              stamp: stampSpec,
              state,
              deadlineMs: sliceDeadlineMs,
              pollMs,
              index: opts?.index ?? null,
            },
          ],
          sliceDeadlineMs + WAIT_EVALUATE_MARGIN_MS,
          ENGINE_WORLD,
        );
      } catch (err) {
        // "Inspected target navigated or closed" and friends: the document
        // the wait was running in went away, which is exactly what a wait
        // straight after a click that submits a form has to sit through.
        // The deadline is the caller's, so keep polling the new document.
        if (!outOfTime && Date.now() < overallDeadline && isTransientNavigationError(err)) {
          await this.rt.sleep(Math.min(pollMs, Math.max(0, overallDeadline - Date.now())));
          continue;
        }
        throw err;
      }

      if (wire.failed === true) {
        throw new AutomationError(
          'INVALID_ARGUMENT',
          `waitFor('${selector}'): the page could not evaluate the selector: ${wire.error ?? 'unknown'}`,
          { selector, state, pageError: wire.error },
        );
      }

      if (wire.frameBoundary) {
        const hop = await this.enterFrame(
          targetId,
          selector,
          segments,
          wire.frameBoundary,
          offset,
          hopDepth,
        );
        return this.waitForHop(
          hop.targetId,
          hop.selector,
          opts,
          state,
          overallDeadline,
          hop.offset,
          hopDepth + 1,
        );
      }

      checks += wire.checks;
      wakes += wire.wakes;
      const observed: ResolveResult = wire.result
        ? {
            ...wire.result,
            matches: translateMatches(wire.result.matches, offset),
            selector,
            resolvedAtMs: Date.now(),
            resolvedTargetId: targetId,
          }
        : emptyResult(selector, targetId);
      lastObserved = observed;

      if (wire.timedOut) {
        if (!outOfTime && hasRole && Date.now() < overallDeadline) continue;
        throw this.waitTimeoutError(
          selector,
          state,
          observed,
          { ...wire, checks, wakes },
          Date.now() - started,
        );
      }

      return {
        ...observed,
        waitedMs: round === 0 ? wire.waitedMs : Date.now() - started,
        checks,
        wakes,
      };
    }
  }

  /**
   * A timed-out wait becomes an error that names what was actually
   * observed. `detached` and `hidden` get their own wording because for
   * them the FAILURE is that a match is still there, so running them
   * through the actionability report would produce the nonsense of
   * complaining that a visible element is visible.
   */
  private waitTimeoutError(
    selector: string,
    state: LocatorState,
    observed: ResolveResult,
    wire: WireWaitResult,
    elapsedMs: number,
  ): AutomationError {
    const base = {
      selector,
      state,
      matchCount: observed.total,
      checks: wire.checks,
      wakes: wire.wakes,
      elapsedMs,
      url: observed.url,
    };
    if (state === 'detached') {
      return new AutomationError(
        'TIMEOUT',
        `waitFor('${selector}', 'detached'): ${observed.total} element(s) were still in the document after ${elapsedMs}ms.`,
        { ...base, state: 'detached' },
      );
    }
    if (state === 'hidden') {
      const visible = observed.matches.filter((m) => m.visible);
      return new AutomationError(
        'TIMEOUT',
        `waitFor('${selector}', 'hidden'): ${visible.length} of ${observed.total} match(es) were still visible after ${elapsedMs}ms.`,
        { ...base, stillVisible: visible.length },
      );
    }
    if (observed.total === 0) {
      return new AutomationError(
        'NOT_FOUND',
        `waitFor('${selector}', '${state}'): nothing matched in ${elapsedMs}ms (${wire.checks} checks, ${wire.wakes} DOM mutations). The page is at ${observed.url}.`,
        base,
      );
    }
    return actionabilityError(
      `waitFor(..., '${state}')`,
      selector,
      observed,
      observed.matches[0],
      elapsedMs,
    );
  }

  // ==================================================================
  // The choosing rule, shared by every acting verb
  // ==================================================================

  /**
   * Picks the match to act on.
   *
   * With no explicit index, the first match that passes every check that
   * has an answer, which is exactly what callers otherwise hand-roll in
   * four round trips (count, re-locate with `>> visible=true`, count again,
   * take first). An undetermined check (`stable`/`hitTestOk` of `null`, on
   * a tab that never painted) does not disqualify a candidate: refusing to
   * act on a backgrounded tab would be strictly worse than acting.
   *
   * With an explicit index, exactly that one, whatever state it is in, so
   * that the failure report is about the element the caller meant rather
   * than about a different one the verb wandered to.
   */
  private pick(result: ResolveResult, index: number | undefined): LocatorMatch | undefined {
    if (index !== undefined) return result.matches[index];
    return result.matches.find(isActionable);
  }

  /**
   * The three ways choosing a match can fail, each with its own answer.
   *
   * The middle one is the case a wait alone does not cover and which is
   * easy to get wrong: `waitFor(state: 'actionable')` is satisfied when
   * SOME match is actionable, so a caller who named index 0 while index 1
   * is the actionable one would otherwise have its click delivered to a
   * disabled element with no complaint. The chosen match is therefore
   * checked in its own right, whatever the wait said.
   */
  private requireActionable(
    verb: string,
    selector: string,
    result: ResolveResult,
    index: number | undefined,
    elapsedMs: number,
  ): LocatorMatch {
    if (index !== undefined && result.matches[index] === undefined) {
      throw new AutomationError(
        'NOT_FOUND',
        `${verb}('${selector}'): index ${index} was asked for and ${result.total === 0 ? 'nothing matched' : `only ${result.total} element(s) matched`}. The page is at ${result.url}.`,
        { verb, selector, index, matchCount: result.total, engine: result.engine, url: result.url },
      );
    }
    const chosen = this.pick(result, index);
    if (chosen === undefined || !isActionable(chosen)) {
      throw actionabilityError(
        verb,
        selector,
        result,
        chosen ?? this.best(result, index),
        elapsedMs,
      );
    }
    return chosen;
  }

  /** The match a failure report should describe: the one asked for, or failing that the first one found, because "nothing was actionable" is less useful than "the one at index 0 was covered by X". */
  private best(result: ResolveResult, index: number | undefined): LocatorMatch | undefined {
    return (index !== undefined ? result.matches[index] : undefined) ?? result.matches[0];
  }

  // ==================================================================
  // click
  // ==================================================================

  async click(
    targetId: string,
    selector: string,
    opts?: LocatorClickOptions,
  ): Promise<ClickResult> {
    parseSelector(selector);
    const started = Date.now();
    const deadline = started + (opts?.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS);
    const via = opts?.via ?? 'coordinates';
    const retries = opts?.verify === undefined ? 0 : (opts.retries ?? 2);
    const stamp = opts?.stamp !== false;
    let attempts = 0;
    let reResolved = false;

    for (;;) {
      attempts += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw actionabilityError(
          'click',
          selector,
          emptyResult(selector, targetId),
          undefined,
          Date.now() - started,
        );
      }

      let result: ResolveResult = await this.waitFor(targetId, selector, {
        state: 'actionable',
        timeoutMs: remaining,
        scroll: opts?.scroll !== false,
        scrollIndex: opts?.index ?? 0,
        stamp,
        ...(opts?.index !== undefined
          ? { index: opts.index, limit: Math.max(50, opts.index + 1) }
          : {}),
      });
      // The target the CHOSEN element actually lives in: `targetId` unless
      // the selector crossed a `frame=` boundary, in which case
      // `result.resolvedTargetId` names the frame's own CDP target. Real
      // input (below, `clickPoint`/`prepareDispatch`) always goes through
      // `targetId`, the ORIGINAL argument, because that is the target
      // Chrome's own input routing forwards a top-document-coordinate
      // click into the right (possibly cross-process) frame from; a
      // follow-up call addressing the element by its stamped ref
      // (`via: 'dispatch'`'s `DISPATCH_CLICK_SCRIPT`, below) has to run
      // where the element actually is, which is `resolveTargetId`.
      let resolveTargetId = result.resolvedTargetId;
      let chosen = this.requireActionable(
        'click',
        selector,
        result,
        opts?.index,
        Date.now() - started,
      );

      // Do the input path's own preparation FIRST, then check the
      // measurement is still fresh. That order is the whole guard: the
      // preparation is a round trip and it is exactly what puts real time
      // between the rect and the frame that uses it.
      await this.rt.prepareDispatch(targetId);

      // The sequence this prevents: resolve returns a rect, the element
      // detaches, something else moves into that screen position, and the
      // click lands on it. This happens in production. Re-resolving costs
      // one round trip and only happens
      // when the gap says it might matter.
      if (Date.now() - result.resolvedAtMs > STALE_RESOLVE_WINDOW_MS) {
        result = await this.resolve(targetId, selector, {
          scroll: opts?.scroll !== false,
          scrollIndex: opts?.index ?? 0,
          stamp,
        });
        reResolved = true;
        resolveTargetId = result.resolvedTargetId;
        chosen = this.requireActionable(
          'click',
          selector,
          result,
          opts?.index,
          Date.now() - started,
        );
      }

      let point: { x: number; y: number } | null = null;
      if (via === 'dispatch') {
        if (chosen.ref === null) {
          throw new AutomationError(
            'INVALID_ARGUMENT',
            "click(via: 'dispatch') needs a stamp to address the element by; it cannot be combined with stamp: false",
            { selector },
          );
        }
        const res = await this.rt.evaluateFunction<{ found: boolean }>(
          resolveTargetId,
          DISPATCH_CLICK_SCRIPT,
          [{ ref: chosen.ref }],
          this.rt.defaultTimeoutMs,
          ENGINE_WORLD,
        );
        if (!res.found) throw this.staleRefError('click', selector, chosen.ref);
      } else {
        point = { x: chosen.center.x, y: chosen.center.y };
        await this.rt.clickPoint(targetId, point.x, point.y, {
          ...(opts?.button !== undefined ? { button: opts.button } : {}),
          ...(opts?.clickCount !== undefined ? { clickCount: opts.clickCount } : {}),
          ...(opts?.modifiers !== undefined ? { modifiers: opts.modifiers } : {}),
        });
      }

      if (opts?.verify === undefined) {
        return {
          ok: true,
          via,
          ref: chosen.ref,
          point,
          matchCount: result.total,
          index: chosen.index,
          verified: null,
          attempts,
          elapsedMs: Date.now() - started,
          reResolved,
        };
      }

      await this.rt.sleep(opts.verifyDelayMs ?? 250);
      // The one caller-authored script the locator surface runs, and the
      // one place a caller can move off {@link ENGINE_WORLD}. It still
      // DEFAULTS to the isolated world: a predicate is almost always a DOM
      // read ("did the button go away", "is the error box showing"), the
      // safe world does that perfectly, and a script ported from
      // patchright already ran every one of its predicates in an isolated
      // world. `verifyWorld: 'main'` is the explicit opt out,
      // for a predicate that genuinely has to read a page global.
      const passed = await this.rt.evaluateExpression<unknown>(
        targetId,
        opts.verify,
        this.rt.defaultTimeoutMs,
        opts.verifyWorld ?? ENGINE_WORLD,
      );
      if (passed) {
        return {
          ok: true,
          via,
          ref: chosen.ref,
          point,
          matchCount: result.total,
          index: chosen.index,
          verified: true,
          attempts,
          elapsedMs: Date.now() - started,
          reResolved,
        };
      }

      if (attempts > retries || Date.now() >= deadline) {
        throw this.unverifiedClickError(
          selector,
          chosen,
          result,
          opts.verify,
          attempts,
          Date.now() - started,
        );
      }
    }
  }

  /**
   * The click was delivered and the page did not agree that anything
   * happened. Reported as `OCCLUDED` when the hit test can name what took
   * it, and as `TIMEOUT` otherwise, and in both cases carrying the
   * predicate that failed.
   *
   * This distinction is the entire value of the `verify` option: without
   * it the verb can only claim a click was delivered, and what that costs
   * in practice is a reported success on a click that landed on a
   * transparent overlay with the menu never having opened.
   */
  private unverifiedClickError(
    selector: string,
    chosen: LocatorMatch,
    result: ResolveResult,
    verify: string,
    attempts: number,
    elapsedMs: number,
  ): AutomationError {
    const detail = {
      selector,
      verify,
      attempts,
      elapsedMs,
      delivered: true,
      verified: false,
      matchCount: result.total,
      index: chosen.index,
      point: chosen.center,
      occludedBy: chosen.occludedBy,
      describe: chosen.describe,
      url: result.url,
    };
    if (chosen.occludedBy !== null) {
      return new AutomationError(
        'OCCLUDED',
        `click('${selector}'): ${attempts} click(s) were delivered at (${Math.round(chosen.center.x)}, ${Math.round(chosen.center.y)}) and the verify predicate never passed; ${chosen.occludedBy} is on top of the element at that point.`,
        detail,
      );
    }
    return new AutomationError(
      'TIMEOUT',
      `click('${selector}'): ${attempts} click(s) were delivered at (${Math.round(chosen.center.x)}, ${Math.round(chosen.center.y)}) in ${elapsedMs}ms and the verify predicate '${verify}' never passed. The click reached the element; the page did not do what was expected of it.`,
      detail,
    );
  }

  private staleRefError(verb: string, selector: string, ref: string): AutomationError {
    return new AutomationError(
      'DETACHED',
      `${verb}('${selector}'): the element stamped ${ref} is gone. A ref is valid until its subtree re-renders and no longer, so this is a re-render, not a missing element: resolve again.`,
      { verb, selector, ref, stale: true },
    );
  }

  // ==================================================================
  // hover
  // ==================================================================

  /**
   * Moves the pointer to the centre of the element a selector resolves to,
   * through the same real CDP input path a person's mouse move takes.
   *
   * Same actionability contract `click` uses, and for the same reason: a
   * hover that silently landed on a covered or disabled element would be
   * strictly less honest than `click`'s own contract, for no reason a
   * caller could see. Waits for `'actionable'`, re-resolves under the same
   * staleness guard if the measurement goes stale before the move is
   * dispatched (a rect measured before a re-render points at whatever
   * moved into that screen position afterwards, `click`'s own reasoning),
   * and fails with the same named taxonomy
   * (`NOT_FOUND`/`NOT_VISIBLE`/`DISABLED`/`OCCLUDED`/`NOT_STABLE`/`DETACHED`)
   * when it cannot be reached. For the menus and tooltips that open only on
   * `:hover`, with nothing to click.
   */
  async hover(
    targetId: string,
    selector: string,
    opts?: LocatorHoverOptions,
  ): Promise<HoverResult> {
    parseSelector(selector);
    const started = Date.now();
    const deadline = started + (opts?.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS);
    const stamp = opts?.stamp !== false;

    let result: ResolveResult = await this.waitFor(targetId, selector, {
      state: 'actionable',
      timeoutMs: Math.max(0, deadline - Date.now()),
      scroll: opts?.scroll !== false,
      scrollIndex: opts?.index ?? 0,
      stamp,
      ...(opts?.index !== undefined
        ? { index: opts.index, limit: Math.max(50, opts.index + 1) }
        : {}),
    });
    let chosen = this.requireActionable(
      'hover',
      selector,
      result,
      opts?.index,
      Date.now() - started,
    );
    let reResolved = false;

    // Same order and same guard as click/fill/select: prepare the input
    // path first, then check whether the measurement is still worth
    // trusting.
    await this.rt.prepareDispatch(targetId);
    if (Date.now() - result.resolvedAtMs > STALE_RESOLVE_WINDOW_MS) {
      result = await this.resolve(targetId, selector, {
        scroll: opts?.scroll !== false,
        scrollIndex: opts?.index ?? 0,
        stamp,
      });
      reResolved = true;
      chosen = this.requireActionable('hover', selector, result, opts?.index, Date.now() - started);
    }

    await this.rt.movePoint(targetId, chosen.center.x, chosen.center.y);

    return {
      ok: true,
      ref: chosen.ref,
      point: chosen.center,
      matchCount: result.total,
      index: chosen.index,
      elapsedMs: Date.now() - started,
      reResolved,
    };
  }

  // ==================================================================
  // scrollContainer: a real wheel event aimed inside a resolved element,
  // rather than at a caller-chosen page point.
  // ==================================================================

  /**
   * Scrolls INSIDE the element a selector resolves to, by dispatching a
   * real wheel event at its centre rather than at a caller-named page
   * point.
   *
   * `AutomationClient.scroll()` already dispatches a wheel event through
   * the held lease; what it cannot do is find a point inside a particular
   * scroll region. A page's own scroll container (a virtualised list, a
   * modal body, any element with its own `overflow: auto`) is not the
   * viewport, and a caller wanting to scroll ONE of several nested
   * scrollable regions has had no way to name which one. This resolves the
   * container, takes the same actionability check every other acting verb
   * takes, and aims the same wheel dispatch at its centre: a real
   * synthetic wheel event scrolls whichever scrollable ancestor sits under
   * the point it lands on, which is what a person's mouse wheel would do
   * positioned over that element.
   */
  async scrollContainer(
    targetId: string,
    selector: string,
    delta: { dx?: number; dy?: number },
    opts?: LocatorScrollContainerOptions,
  ): Promise<ScrollContainerResult> {
    parseSelector(selector);
    const started = Date.now();
    const index = opts?.index ?? 0;

    let result: ResolveResult = await this.resolve(targetId, selector, {
      limit: Math.max(1, index + 1),
      scroll: opts?.scroll !== false,
      scrollIndex: index,
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    let chosen = this.requireActionable(
      'scrollContainer',
      selector,
      result,
      opts?.index,
      Date.now() - started,
    );

    await this.rt.prepareDispatch(targetId);
    if (Date.now() - result.resolvedAtMs > STALE_RESOLVE_WINDOW_MS) {
      result = await this.resolve(targetId, selector, {
        scroll: opts?.scroll !== false,
        scrollIndex: index,
      });
      chosen = this.requireActionable(
        'scrollContainer',
        selector,
        result,
        opts?.index,
        Date.now() - started,
      );
    }

    await this.rt.wheelAt(targetId, chosen.center.x, chosen.center.y, delta.dx ?? 0, delta.dy ?? 0);

    return {
      ok: true,
      ref: chosen.ref,
      point: chosen.center,
      matchCount: result.total,
      index: chosen.index,
      elapsedMs: Date.now() - started,
    };
  }

  // ==================================================================
  // fill
  // ==================================================================

  async fill(
    targetId: string,
    selector: string,
    value: string,
    opts?: LocatorFillOptions,
  ): Promise<FillResult> {
    parseSelector(selector);
    const started = Date.now();
    const deadline = started + (opts?.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS);
    const mode = opts?.mode ?? 'keys';

    let result: ResolveResult = await this.waitFor(targetId, selector, {
      state: 'actionable',
      timeoutMs: Math.max(0, deadline - Date.now()),
      scroll: opts?.scroll !== false,
      scrollIndex: opts?.index ?? 0,
      stamp: true,
      ...(opts?.index !== undefined
        ? { index: opts.index, limit: Math.max(50, opts.index + 1) }
        : {}),
    });
    // The target the CHOSEN element actually lives in. See `click()`'s own
    // comment on the identical variable: dispatch (`clickPoint`,
    // `typeChars`, `insertText`, below) always stays on `targetId`, the
    // ORIGINAL argument, because Chrome routes a top-document-coordinate
    // click AND the keyboard focus it leaves behind through that target
    // regardless of which frame the focused element is actually in; the
    // ref-addressed calls (`CLEAR_SCRIPT`, `READ_SCRIPT`, below) have to
    // run where the element itself lives, which is `resolveTargetId`.
    let resolveTargetId = result.resolvedTargetId;
    let chosen = this.requireActionable(
      'fill',
      selector,
      result,
      opts?.index,
      Date.now() - started,
    );
    if (!chosen.editable) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `fill('${selector}'): <${chosen.tagName}> is not editable (it is neither an input, a textarea, nor contenteditable, or it is readOnly). Matched ${result.total} element(s); acted on index ${chosen.index} (${chosen.describe ?? chosen.tagName}).`,
        {
          selector,
          index: chosen.index,
          tagName: chosen.tagName,
          describe: chosen.describe,
          matchCount: result.total,
        },
      );
    }
    if (chosen.ref === null) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        'fill() addresses the field by stamp between its click and its read-back, so it cannot run with stamp: false. Use resolve() plus clickAt()/type() to drive an unstamped field by coordinates.',
        { selector },
      );
    }

    // Same order and same guard as `click`: prepare the input path, which
    // is where the time goes, and only then ask whether the measurement is
    // still worth trusting.
    await this.rt.prepareDispatch(targetId);
    if (Date.now() - result.resolvedAtMs > STALE_RESOLVE_WINDOW_MS) {
      result = await this.resolve(targetId, selector, {
        scroll: opts?.scroll !== false,
        scrollIndex: opts?.index ?? 0,
        stamp: true,
      });
      resolveTargetId = result.resolvedTargetId;
      chosen = this.requireActionable('fill', selector, result, opts?.index, Date.now() - started);
      if (chosen.ref === null) {
        throw actionabilityError('fill', selector, result, chosen, Date.now() - started);
      }
    }
    const ref = chosen.ref;

    // Focus with a real click rather than with `element.focus()`. The
    // click is the route that also proves the field is not covered, and on
    // the combobox widgets real forms use it is the mousedown that
    // opens the list in the first place.
    if (opts?.click !== false) {
      await this.rt.clickPoint(targetId, chosen.center.x, chosen.center.y, {});
    }

    if (opts?.clear !== false && (chosen.value ?? '') !== '') {
      const cleared = await this.rt.evaluateFunction<{ found: boolean; cleared?: boolean }>(
        resolveTargetId,
        CLEAR_SCRIPT,
        [{ ref }],
        this.rt.defaultTimeoutMs,
        ENGINE_WORLD,
      );
      if (!cleared.found) throw this.staleRefError('fill', selector, ref);
    }

    if (mode === 'insert') {
      await this.rt.insertText(targetId, value);
    } else {
      // The default, and it is the one that works. `Input.insertText`
      // fires `beforeinput` and `input` and no `keydown` at all, and the
      // filtering comboboxes on real world forms (react-select style
      // widgets, some enterprise form widgets) open and filter on
      // `keydown`. Real per-character keys also give
      // the takeover check somewhere to run: `typeChars` stands down
      // mid-word when a person takes the browser, which is the multi-user
      // model expressed as an API and which Playwright has no way to do,
      // having no concept of a second driver.
      await this.rt.typeChars(targetId, value, opts?.delayMs ?? 0);
    }

    let actual: string | null = null;
    let verified: boolean | null = null;
    if (opts?.verify !== false) {
      // Poll the read-back until it matches, rather than reading once and
      // reporting whatever happened to be there.
      //
      // `typeChars` cannot tell the caller when the field is finished.
      // Input messages are fire and forget: `input.key` is `send`, not
      // `request`, so there is no reply to await and the last character
      // is still in flight to Chrome when the loop that sent it returns.
      // Reading immediately therefore samples a field mid-word. Measured
      // against a real gateway, `fill('#name', 'Ada Lovelace')` resolved
      // and a read 600ms later returned "Ad", while the same field held
      // the whole string by the time anything else looked at it.
      //
      // The previous shape of this code did the single read and then
      // returned `ok: true` with `verified: false` alongside it, which is
      // the worst of the options: a caller doing the obvious thing
      // (awaiting `fill`, then submitting) got a partially typed form and
      // no exception, and a caller checking `ok` was told the fill
      // succeeded. Playwright's `fill` is atomic, and any caller porting
      // to this SDK is entitled to assume the await means something.
      const read = await this.rt.evaluateFunction<{ found: boolean; value?: string | null }>(
        resolveTargetId,
        READ_SCRIPT,
        [{ ref, what: 'value' }],
        this.rt.defaultTimeoutMs,
        ENGINE_WORLD,
      );
      if (!read.found) throw this.staleRefError('fill', selector, ref);
      actual = read.value ?? null;
      verified = actual === value;

      // Only if the first read disagrees. A field that already holds the
      // value costs exactly the one read it always did.
      //
      // `verified: false` is NOT re-raised as an error here, deliberately:
      // a masked or reformatting input (a phone field turning
      // "5550109999" into "(555) 010-9999") is a legitimate outcome the
      // caller is meant to inspect, and there is a test asserting exactly
      // that. What the retry distinguishes is the OTHER reason the read
      // disagreed, which is that it was taken too early.
      //
      // Bounded by an attempt count as well as by the clock, because the
      // clock cannot be relied on to move: the unit tests drive this with
      // `vi.setSystemTime`, so a deadline-only loop spins forever there
      // and takes the worker process with it (observed). A read that
      // cannot be taken at all during the retry (the element went away, a
      // scripted fake ran out of replies) ends the retry and keeps the
      // last real answer rather than turning a value mismatch into a
      // different error.
      // Backed off, not a tight poll. Each of these is a real
      // `page.evaluate`, which is rate limited per connection, and a
      // 25ms loop burned enough of that budget during one `fill` that the
      // NEXT verb on the same client came back `POLICY_DENIED Rate limit
      // exceeded for page.evaluate` (observed, and it is a nastier failure
      // than the one being fixed because it lands on unrelated code).
      // Six reads over about 1.5 seconds covers the in-flight window that
      // caused the miss while spending a fraction of the budget.
      const VERIFY_BACKOFF_MS = [25, 50, 100, 200, 400, 800];
      const verifyDeadline = Date.now() + 2000;
      for (
        let poll = 0;
        !verified && poll < VERIFY_BACKOFF_MS.length && Date.now() < verifyDeadline;
        poll += 1
      ) {
        await this.rt.sleep(VERIFY_BACKOFF_MS[poll] as number);
        let next: { found: boolean; value?: string | null };
        try {
          next = await this.rt.evaluateFunction<{ found: boolean; value?: string | null }>(
            resolveTargetId,
            READ_SCRIPT,
            [{ ref, what: 'value' }],
            this.rt.defaultTimeoutMs,
            ENGINE_WORLD,
          );
        } catch {
          break;
        }
        if (next === undefined || next === null || !next.found) break;
        actual = next.value ?? null;
        verified = actual === value;
      }

      if (verified === false && opts?.strict === true) {
        // The values themselves stay out of the error: this is the path a
        // password takes. Lengths and the first differing position are
        // enough to tell a dropped character from a reformatted field.
        const got = actual ?? '';
        let firstMismatchAt = 0;
        while (
          firstMismatchAt < got.length &&
          firstMismatchAt < value.length &&
          got[firstMismatchAt] === value[firstMismatchAt]
        )
          firstMismatchAt += 1;
        throw new AutomationError(
          'TIMEOUT',
          `fill('${selector}', strict): the field holds ${got.length} character(s) after typing, expected ${value.length}, first difference at index ${firstMismatchAt}. The keys were delivered; the page did not end up with the value.`,
          {
            selector,
            index: chosen.index,
            delivered: true,
            verified: false,
            expectedLength: value.length,
            actualLength: got.length,
            firstMismatchAt,
          },
        );
      }
    }

    return {
      ok: true,
      ref,
      matchCount: result.total,
      index: chosen.index,
      mode,
      actual,
      verified,
      elapsedMs: Date.now() - started,
    };
  }

  // ==================================================================
  // select
  // ==================================================================

  /**
   * Selects one or more `<option>`s on the `<select>` a selector resolves
   * to. See `AutomationClient.select`'s own doc for the semantics this
   * replaces a plain `evaluate` for; this is the composition.
   *
   * Same shape as `fill`: wait for the `<select>` to be actionable (so a
   * still-rendering or modal-covered `<select>` is not acted on), re-resolve
   * if the measurement went stale before the mutation runs (a `<select>`
   * populated by an async request can re-render its option list between
   * the resolve and the write, same as any other field), then run
   * `SELECT_SCRIPT` once against the chosen match's ref.
   */
  async select(
    targetId: string,
    selector: string,
    options: SelectOptionSpec | readonly SelectOptionSpec[],
    opts?: LocatorSelectOptions,
  ): Promise<SelectResult> {
    parseSelector(selector);
    const wanted = (Array.isArray(options) ? options : [options]).map(normalizeSelectOption);
    if (wanted.length === 0) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `select('${selector}') needs at least one option to select`,
        { selector },
      );
    }
    const started = Date.now();
    const deadline = started + (opts?.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS);

    let result: ResolveResult = await this.waitFor(targetId, selector, {
      state: 'actionable',
      timeoutMs: Math.max(0, deadline - Date.now()),
      scroll: opts?.scroll !== false,
      scrollIndex: opts?.index ?? 0,
      stamp: true,
      ...(opts?.index !== undefined
        ? { index: opts.index, limit: Math.max(50, opts.index + 1) }
        : {}),
    });
    // The target the CHOSEN <select> actually lives in. See `click()`'s own
    // comment on the identical variable.
    let resolveTargetId = result.resolvedTargetId;
    let chosen = this.requireActionable(
      'select',
      selector,
      result,
      opts?.index,
      Date.now() - started,
    );
    this.requireSelectElement(selector, result, chosen);

    // Same order and same guard as `click`/`fill`: prepare the input path
    // (which is where the time goes, even though `select` itself dispatches
    // no `input.*` frame of its own), and only then ask whether the
    // measurement is still worth trusting.
    await this.rt.prepareDispatch(targetId);
    if (Date.now() - result.resolvedAtMs > STALE_RESOLVE_WINDOW_MS) {
      result = await this.resolve(targetId, selector, {
        scroll: opts?.scroll !== false,
        scrollIndex: opts?.index ?? 0,
        stamp: true,
      });
      resolveTargetId = result.resolvedTargetId;
      chosen = this.requireActionable(
        'select',
        selector,
        result,
        opts?.index,
        Date.now() - started,
      );
      this.requireSelectElement(selector, result, chosen);
    }
    // `requireSelectElement` is an assertion function (`asserts chosen is
    // LocatorMatch & { ref: string }`), so `chosen.ref` is typed as
    // `string` from here on, with no runtime-dead null check or non-null
    // assertion needed to satisfy the compiler.
    const ref = chosen.ref;

    const wire = await this.rt.evaluateFunction<WireSelectResult>(
      resolveTargetId,
      SELECT_SCRIPT,
      [{ ref, options: wanted }],
      this.rt.defaultTimeoutMs,
      ENGINE_WORLD,
    );
    if (!wire.found) throw this.staleRefError('select', selector, ref);
    if (wire.notMultiple === true) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `select('${selector}'): ${wanted.length} options were asked for but the <select> at index ${chosen.index} has no 'multiple' attribute, so it can hold only one selection.`,
        { selector, index: chosen.index, requested: wanted.length },
      );
    }
    if (wire.missing !== undefined && wire.missing.length > 0) {
      throw this.optionNotFoundError(selector, chosen, wire.missing, wire.available ?? []);
    }

    return {
      ok: true,
      ref,
      matchCount: result.total,
      index: chosen.index,
      values: wire.values ?? [],
      labels: wire.labels ?? [],
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Throws `INVALID_ARGUMENT` unless `chosen` is a stamped `<select>`,
   * naming what was found instead. Shared by `select`'s initial choice and
   * its post-restale re-check, so the two paths cannot drift apart on what
   * counts as acceptable.
   *
   * Typed as a TypeScript assertion function (`asserts chosen is ... {
   * ref: string }`) rather than returning `boolean`, so `chosen.ref` reads
   * as `string` at every call site after this returns, with no repeated
   * null check or non-null assertion needed to satisfy the compiler about
   * something this method already guarantees at runtime.
   */
  private requireSelectElement(
    selector: string,
    result: ResolveResult,
    chosen: LocatorMatch,
  ): asserts chosen is LocatorMatch & { ref: string } {
    if (chosen.tagName !== 'select') {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `select('${selector}'): <${chosen.tagName}> is not a <select>. Matched ${result.total} element(s); acted on index ${chosen.index} (${chosen.describe ?? chosen.tagName}).`,
        {
          selector,
          index: chosen.index,
          tagName: chosen.tagName,
          describe: chosen.describe,
          matchCount: result.total,
        },
      );
    }
    if (chosen.ref === null) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        'select() addresses the element by stamp between its resolve and its mutation, so it cannot run with stamp: false.',
        { selector },
      );
    }
  }

  /**
   * The option-not-found error, and the whole reason `select()` earns its
   * place as a library verb rather than a one-line `evaluate`: naming
   * which requested option(s) did not match AND what the `<select>`
   * actually offers, so a caller sees "no option matched value 'CA';
   * available: 'US', 'MX', ..." rather than a silently wrong selection or
   * a bare exception from deep inside a hand-rolled loop, which is exactly
   * the failure mode forty independent `evaluate` call sites would each
   * have had to get right on their own.
   */
  private optionNotFoundError(
    selector: string,
    chosen: LocatorMatch,
    missing: Array<{ value?: string; label?: string; index?: number }>,
    available: Array<{ value: string; label: string; index: number }>,
  ): AutomationError {
    const describeSpec = (m: { value?: string; label?: string; index?: number }): string => {
      if (m.value !== undefined) return `value '${m.value}'`;
      if (m.label !== undefined) return `label '${m.label}'`;
      return `index ${m.index}`;
    };
    // Capped at 20: a <select> populated from a country or currency list
    // can run past a hundred entries, and the point of listing what IS
    // there is to let a human eyeball the mismatch (a typo, a stale code),
    // not to reproduce the whole option list inside an error message.
    const shown = available.slice(0, 20);
    const optionsDesc = shown
      .map((o) => `'${o.value}'${o.label && o.label !== o.value ? ` (${o.label})` : ''}`)
      .join(', ');
    const suffix =
      available.length > shown.length ? `, ... ${available.length - shown.length} more` : '';
    return new AutomationError(
      'NOT_FOUND',
      `select('${selector}'): no option matched ${missing.map(describeSpec).join(', ')} on the <select> at index ${chosen.index}. Available: ${optionsDesc || '(none)'}${suffix}.`,
      { selector, index: chosen.index, missing, available },
    );
  }

  // ==================================================================
  // The read verbs. One round trip each: the read rides on the resolver.
  // ==================================================================

  async innerText(
    targetId: string,
    selector: string,
    opts?: { index?: number; timeoutMs?: number; limit?: number },
  ): Promise<string> {
    const v = await this.readOne(
      targetId,
      'innerText',
      selector,
      { what: 'innerText', ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      opts,
    );
    return typeof v === 'string' ? v : '';
  }

  async getAttribute(
    targetId: string,
    selector: string,
    name: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<string | null> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AutomationError('INVALID_ARGUMENT', 'getAttribute() needs an attribute name');
    }
    const v = await this.readOne(
      targetId,
      'getAttribute',
      selector,
      { what: 'attribute', name },
      opts,
    );
    return typeof v === 'string' ? v : null;
  }

  async isChecked(
    targetId: string,
    selector: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<boolean> {
    const v = await this.readOne(targetId, 'isChecked', selector, { what: 'checked' }, opts);
    return v === true;
  }

  /**
   * The shared body of the three read verbs.
   *
   * `stable: false` and `hitTest: false` are not an optimisation detail
   * worth hiding: reading an attribute does not need two animation frames
   * or a hit test, and a read verb that paid for them would be slower than
   * the `evaluate` call it replaces, which would be an argument for not
   * using it.
   */
  private async readOne(
    targetId: string,
    verb: string,
    selector: string,
    read: { what: 'innerText' | 'attribute' | 'checked' | 'value'; name?: string; limit?: number },
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<string | boolean | null> {
    const index = opts?.index ?? 0;
    const result = await this.resolve(targetId, selector, {
      limit: Math.max(1, index + 1),
      stamp: false,
      stable: false,
      hitTest: false,
      read,
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const match = result.matches[index];
    if (match === undefined) {
      throw new AutomationError(
        'NOT_FOUND',
        `${verb}('${selector}'): ${result.total === 0 ? 'nothing matched' : `only ${result.total} element(s) matched, so there is no index ${index}`}. The page is at ${result.url}.`,
        { verb, selector, index, matchCount: result.total, engine: result.engine, url: result.url },
      );
    }
    // `read.what` is narrowed to the four scalar reads above, so
    // `readValue` is never the `DropdownOption[]` shape `dropdownOptions()`
    // asks for; the cast says only that, not anything the runtime has to
    // check.
    return match.readValue as string | boolean | null;
  }

  /**
   * Every `<option>` on the `<select>` a selector resolves to: value,
   * visible label, position, and whether each is selected or disabled.
   * Read-only, and ONE round trip: it rides `read: { what: 'options' }`
   * on the resolver rather than a second evaluate, the same argument
   * {@link readOne} already makes for `innerText`/`getAttribute`/
   * `isChecked`.
   *
   * `select()`'s own option-not-found error already had to enumerate a
   * `<select>`'s options; this and that error read off the SAME page-side
   * function (`script.ts`'s `bglsListOptions`), so there is one place that
   * decides what "the options" means, not two that could drift apart.
   */
  async dropdownOptions(
    targetId: string,
    selector: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<DropdownOption[]> {
    const index = opts?.index ?? 0;
    const result = await this.resolve(targetId, selector, {
      limit: Math.max(1, index + 1),
      stamp: false,
      stable: false,
      hitTest: false,
      read: { what: 'options' },
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const match = result.matches[index];
    if (match === undefined) {
      throw new AutomationError(
        'NOT_FOUND',
        `dropdownOptions('${selector}'): ${result.total === 0 ? 'nothing matched' : `only ${result.total} element(s) matched, so there is no index ${index}`}. The page is at ${result.url}.`,
        { selector, index, matchCount: result.total, engine: result.engine, url: result.url },
      );
    }
    if (match.tagName !== 'select') {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `dropdownOptions('${selector}'): <${match.tagName}> is not a <select>. Matched ${result.total} element(s); read index ${match.index} (${match.describe ?? match.tagName}).`,
        {
          selector,
          index: match.index,
          tagName: match.tagName,
          describe: match.describe,
          matchCount: result.total,
        },
      );
    }
    // `match.tagName === 'select'` guarantees the page set `readValue` to
    // `bglsListOptions(el)`, never `null` (`script.ts`'s own `what ===
    // 'options'` branch reads `null` only for a non-`<select>` tag).
    return match.readValue as DropdownOption[];
  }

  // ==================================================================
  // scrollIntoView
  // ==================================================================

  /**
   * Scrolls the match into view and returns it as measured AFTER the
   * scroll, in the same evaluation. Ported scripts call
   * `scroll_into_view_if_needed` before nearly every click, and
   * the click verb does it internally for exactly that reason; this exists
   * for the caller that wants the post-scroll rect without clicking.
   */
  async scrollIntoView(
    targetId: string,
    selector: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<LocatorMatch> {
    const index = opts?.index ?? 0;
    const result = await this.resolve(targetId, selector, {
      limit: Math.max(1, index + 1),
      scroll: true,
      scrollIndex: index,
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const match = result.matches[index];
    if (match === undefined) {
      throw actionabilityError(
        'scrollIntoView',
        selector,
        result,
        this.best(result, opts?.index),
        0,
      );
    }
    return match;
  }

  // ==================================================================
  // scrollToText: scrollIntoView, addressed by rendered text instead of a
  // selector, composed over the existing `text=` engine rather than a new
  // matcher.
  // ==================================================================

  /**
   * Scrolls the element whose normalised text contains (or, with `exact`,
   * equals) `text` into view, and returns it as measured after the scroll.
   *
   * The whole implementation is "build a `text=` selector and call
   * {@link scrollIntoView}": `text=`'s own matching rules (normalised,
   * case-insensitive substring by default, `text="exact phrase"` for a
   * whole-string match) are exactly what this needs, and writing a second
   * text matcher here would be two implementations of "does this text
   * match" free to disagree.
   */
  async scrollToText(
    targetId: string,
    text: string,
    opts?: { exact?: boolean; index?: number; timeoutMs?: number },
  ): Promise<LocatorMatch> {
    const selector = opts?.exact === true ? `text="${text}"` : `text=${text}`;
    return this.scrollIntoView(targetId, selector, opts);
  }

  // ==================================================================
  // findInPage: full text search over the page's own VISIBLE text.
  // ==================================================================

  /**
   * Searches the page's VISIBLE rendered text for `pattern`, literal or
   * regex, and returns every match with a window of surrounding text.
   * Browser-use's `search_page`: the tool for the caller that knows what a
   * page SAYS ("the confirmation number", "Out of stock") but not which
   * element says it, as distinct from `resolve`'s `text=` engine, which
   * needs the caller to already know that.
   *
   * ONE evaluate: `FIND_IN_PAGE_SCRIPT` walks the DOM's own text nodes
   * itself, filtering on the SAME `bglsIsVisible` test `resolve()` uses, so
   * a match hidden by CSS is not reported as one, matching every other
   * verb's treatment of visibility.
   *
   * A literal `pattern` is escaped into a regex HERE, in real TypeScript
   * (see {@link escapeRegExpLiteral}), rather than in the page script: see
   * `FIND_IN_PAGE_SCRIPT`'s own doc for why.
   */
  async findInPage(
    targetId: string,
    pattern: string | RegExp,
    opts?: FindInPageOptions,
  ): Promise<FindInPageResult> {
    const isRegex = pattern instanceof RegExp;
    const source = isRegex ? pattern.source : escapeRegExpLiteral(pattern);
    const callerFlags = isRegex ? pattern.flags : 'i';
    const flags = callerFlags.includes('g') ? callerFlags : `${callerFlags}g`;
    const timeoutMs = opts?.timeoutMs ?? this.rt.defaultTimeoutMs;

    const wire = await this.rt.evaluateFunction<WireFindInPageResult>(
      targetId,
      FIND_IN_PAGE_SCRIPT,
      [
        {
          pattern: source,
          flags,
          contextChars: opts?.contextChars ?? 60,
          limit: opts?.limit ?? 50,
          stamp: opts?.stamp !== false,
          refPrefix: mintRefPrefix(),
          ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
        },
      ],
      timeoutMs,
      ENGINE_WORLD,
    );

    if (wire.patternError !== null) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `findInPage(): the page could not evaluate the pattern: ${wire.patternError}`,
        { pattern: source, flags, pageError: wire.patternError },
      );
    }
    if (wire.scopeMissing) {
      throw new AutomationError(
        'NOT_FOUND',
        `findInPage(): the scope '${opts?.scope ?? ''}' matched nothing.`,
        { scope: opts?.scope },
      );
    }

    return {
      matches: wire.matches,
      total: wire.total,
      truncated: wire.truncated,
      url: wire.url,
      title: wire.title,
    };
  }
}
