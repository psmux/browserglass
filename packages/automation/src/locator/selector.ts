import { AutomationError } from '../errors.js';
import type { LocatorEngine, LocatorMatch, ResolveResult } from './types.js';

/**
 * The client-side half of selector handling: the same split and the same
 * prefix rules the page-side resolver applies, duplicated here so that a
 * selector that is wrong on its face fails locally, before a step is spent
 * and before a round trip.
 *
 * The duplication is not avoidable and it is small. The page script cannot
 * import from this module (it is text, evaluated in another process), and
 * pushing the validation into the page would mean paying a round trip to
 * be told a selector is malformed, which is the mistake a caller makes most
 * often. Both copies split on `>>` outside quotes and brackets, and both
 * read an `engine=` prefix before falling back to XPath-on-leading-slash
 * and then CSS. If one changes the other has to; the tests in
 * `test/client/locator.test.ts` cover the shared cases.
 */

/** How many milliseconds a measured rect is trusted for before an acting verb re-resolves it. */
export const STALE_RESOLVE_WINDOW_MS = 250;

/**
 * How many `frame=` segments one selector may carry. Matches browser-use's
 * own iframe-depth cap (`dom/service.py`), chosen for the same reason: a
 * selector that legitimately needs to cross this many frame boundaries does
 * not exist in any real page this surface has been measured against, and an
 * unbounded chain is a caller typo (`frame=` repeated by a bad string
 * builder) turned into an amplifying number of round trips, one per
 * cross-origin hop (`engine.ts`'s `enterFrame`). Checked once, here, before
 * any round trip is spent, rather than as a runtime recursion guard in
 * `LocatorEngine`: the bound is a property of the SELECTOR TEXT, not of
 * anything the page does, so it can be refused locally the same way an
 * absolute XPath as the first segment already is.
 */
export const MAX_FRAME_SEGMENTS = 5;

const ENGINE_PREFIX = /^(css|text|xpath|label|ref|visible|role|frame)=([\s\S]*)$/;

export interface SelectorSegment {
  engine: LocatorEngine;
  value: string;
  source: string;
}

/** Splits on the `>>` chain combinator, ignoring one inside a quoted string or inside brackets. */
export function splitSegments(selector: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector.charAt(i);
    if (quote !== null) {
      buf += c;
      if (c === quote && selector.charAt(i - 1) !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (depth <= 0 && c === '>' && selector.charAt(i + 1) === '>') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseOne(source: string): SelectorSegment {
  const m = ENGINE_PREFIX.exec(source);
  if (m) return { engine: m[1] as LocatorEngine, value: m[2] ?? '', source };
  const c0 = source.charAt(0);
  if (c0 === '/' || c0 === '(') return { engine: 'xpath', value: source, source };
  return { engine: 'css', value: source, source };
}

/**
 * Parses and validates a selector, throwing `INVALID_ARGUMENT` on the two
 * shapes that are wrong rather than merely unmatched.
 */
export function parseSelector(selector: string): SelectorSegment[] {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    throw new AutomationError('INVALID_ARGUMENT', 'a locator selector must be a non-empty string');
  }
  const segments = splitSegments(selector).map(parseOne);
  if (segments.length === 0) {
    throw new AutomationError('INVALID_ARGUMENT', `selector '${selector}' has no segments`);
  }

  const first = segments[0];
  if (first !== undefined && first.engine === 'xpath') {
    // A policy choice rather than a capability gap: the engine below
    // handles XPath identically wherever it appears. The XPath real scripts
    // need is a relative walk off an element CSS already found
    // ('ancestor::label[1]', '..'), which is
    // the case CSS genuinely cannot express. An absolute XPath as the
    // primary selector is the form that is unreadable in a log and that
    // breaks first when a page's markup shifts by one wrapper div. Lifting
    // this is deleting this branch, if evidence ever says to.
    throw new AutomationError(
      'INVALID_ARGUMENT',
      `selector '${selector}' starts with XPath. XPath is supported only as a chained segment, evaluated against an element another engine already found: write 'input#name >> xpath=ancestor::label[1]'. An absolute XPath as the primary selector is refused because it is the selector form that breaks first when markup shifts, and it reads as noise in a failure log.`,
      { selector, engine: 'xpath', position: 'first' },
    );
  }

  const firstVisible = segments[0];
  if (firstVisible !== undefined && firstVisible.engine === 'visible') {
    throw new AutomationError(
      'INVALID_ARGUMENT',
      `selector '${selector}' starts with 'visible='. It is a filter, not a matcher: chain it after something that selects, as 'button >> visible=true'.`,
      { selector, engine: 'visible', position: 'first' },
    );
  }

  // `frame=` is a scope-entering segment, not a matcher: everything AFTER
  // it in the chain resolves against the entered frame's document, not the
  // one the previous segment matched in. Ending a selector on it therefore
  // has nothing to run against, and it produces a page-side Document where
  // the resolver's own measurement step expects an Element
  // (`getBoundingClientRect` does not exist on a `Document`). Refused here,
  // before any round trip, for the identical reason the xpath-first and
  // visible-first checks above are: it is wrong on the selector's face.
  const last = segments[segments.length - 1];
  if (last !== undefined && last.engine === 'frame') {
    throw new AutomationError(
      'INVALID_ARGUMENT',
      `selector '${selector}' ends with 'frame=...'. Entering a frame needs something to look for inside it: chain a matcher after it, as 'frame=#billing >> button.pay'.`,
      { selector, engine: 'frame', position: 'last' },
    );
  }

  const frameCount = segments.filter((s) => s.engine === 'frame').length;
  if (frameCount > MAX_FRAME_SEGMENTS) {
    throw new AutomationError(
      'INVALID_ARGUMENT',
      `selector '${selector}' has ${frameCount} 'frame=' segments, more than the ${MAX_FRAME_SEGMENTS} this surface allows. See MAX_FRAME_SEGMENTS's own doc for why.`,
      { selector, frameCount, max: MAX_FRAME_SEGMENTS },
    );
  }

  // Every `role=` segment's value is validated here, eagerly, for the same
  // reason the xpath/visible checks above run before any round trip: a
  // malformed filter is wrong on its face and the caller should not pay a
  // CDP round trip (`AutomationClient`'s `queryAndStampByRole`, layered
  // underneath `resolve()`) to be told so. Every occurrence is checked, not
  // just the first, because a later segment in a chain is validated no less
  // than the first one is anywhere else in this function.
  for (const seg of segments) {
    if (seg.engine === 'role') parseRoleValue(seg.value, selector);
  }

  return segments;
}

/** One `role=` segment's filter: an exact role, and an optional exact accessible name. */
export interface RoleFilter {
  role: string;
  name: string | null;
}

/**
 * `role=<role>` or `role=<role>[name="<exact name>"]`, mirroring the
 * string shape Playwright's OWN `role=` selector engine uses (its docs'
 * "other locators" page), chosen deliberately: a caller already fluent in
 * Playwright's own role syntax reads this one for free, rather than
 * learning a third spelling for the same idea `get_by_role(role,
 * name=...)` already gave them.
 *
 * The quoted name is taken literally between the first and last `"`, with
 * no escape processing, the same convention `bglsMatchesNeedle`'s own
 * `text="exact phrase"` form already uses in `./script.ts`
 * (`/^"([\s\S]*)"$/`): one quoting rule for an exact-match value, used
 * everywhere this engine has one, rather than two conventions a caller has
 * to remember apart.
 *
 * Both `role` and `name`, when matched, are handed to
 * `Accessibility.queryAXTree` UNCHANGED: this function does not validate
 * `role` against a table of known ARIA roles, on purpose. `LocatorEngine`'s
 * own module doc records why a hand rolled role vocabulary was refused
 * once already (hand rolled role matching is known to fail in practice);
 * keeping no such table here means
 * Chrome's own answer, not a copy of the spec this codebase would have to
 * keep in sync by hand, is the only thing that ever decides whether a role
 * string is valid. A misspelled role matches nothing and is reported
 * exactly like any other selector that matches nothing: `total: 0`, no
 * throw.
 */
export function parseRoleValue(value: string, selector: string): RoleFilter {
  const m = /^([^[\s]+)(?:\[name="([\s\S]*)"\])?$/.exec(value.trim());
  const role = m?.[1];
  if (!m || role === undefined || role.length === 0) {
    throw new AutomationError(
      'INVALID_ARGUMENT',
      `selector '${selector}': 'role=${value}' is not a role filter. Write 'role=button' or 'role=button[name="Submit"]'.`,
      { selector, engine: 'role', value },
    );
  }
  return { role, name: m[2] ?? null };
}

/** The engine of the last segment, which is the one that produced the matches. */
export function terminalEngine(segments: SelectorSegment[]): LocatorEngine {
  return segments[segments.length - 1]?.engine ?? 'css';
}

/** The `ref=` spelling for a stamp, for a caller threading one match into the next call. */
export function refSelector(ref: string): string {
  return `ref=${ref}`;
}

/**
 * The one place a locator failure becomes an error, so that every verb
 * fails the same way and says the same amount.
 *
 * "Element not actionable" with no detail is the thing everyone hates
 * about this class of library, so the contract here is: name the check
 * that failed, name what the element looked like when it failed, and when
 * the failure is occlusion, name what took the click. The taxonomy already
 * carried the right words for all of it (`NOT_FOUND`, `NOT_VISIBLE`,
 * `OCCLUDED`, `DISABLED`, `NOT_STABLE`, `DETACHED`), so no new error code
 * was needed.
 */
export function actionabilityError(
  verb: string,
  selector: string,
  result: ResolveResult,
  chosen: LocatorMatch | undefined,
  elapsedMs: number,
): AutomationError {
  const base: Record<string, unknown> = {
    verb,
    selector,
    engine: result.engine,
    matchCount: result.total,
    elapsedMs,
    url: result.url,
  };

  if (result.scopeMissing) {
    return new AutomationError(
      'DETACHED',
      `${verb}('${selector}'): the 'within' element is gone from the page. A ref is valid until its subtree re-renders and no longer; re-resolve the container and try again.`,
      { ...base, stale: true },
    );
  }

  if (chosen === undefined) {
    return new AutomationError(
      'NOT_FOUND',
      `${verb}('${selector}'): nothing matched after ${elapsedMs}ms. The page is at ${result.url}.`,
      base,
    );
  }

  const state = {
    index: chosen.index,
    ref: chosen.ref,
    describe: chosen.describe,
    rect: chosen.rect,
    attached: chosen.attached,
    visible: chosen.visible,
    enabled: chosen.enabled,
    disabledReason: chosen.disabledReason,
    editable: chosen.editable,
    stable: chosen.stable,
    hitTestOk: chosen.hitTestOk,
    occludedBy: chosen.occludedBy,
    inViewport: chosen.inViewport,
    opacity: chosen.opacity,
    pointerEvents: chosen.pointerEvents,
  };
  const where = `matched ${result.total} element${result.total === 1 ? '' : 's'}; acted on index ${chosen.index} (${chosen.describe ?? chosen.tagName})`;

  if (!chosen.attached) {
    return new AutomationError(
      'DETACHED',
      `${verb}('${selector}'): the element left the document before it could be acted on. ${where}.`,
      { ...base, check: 'attached', state, stale: true },
    );
  }
  if (!chosen.visible) {
    const why =
      chosen.rect.w <= 0 || chosen.rect.h <= 0
        ? `its rect is ${chosen.rect.w}x${chosen.rect.h}`
        : 'computed visibility hides it';
    return new AutomationError(
      'NOT_VISIBLE',
      `${verb}('${selector}'): the element is not visible after ${elapsedMs}ms (${why}). ${where}.`,
      { ...base, check: 'visible', state },
    );
  }
  if (!chosen.enabled) {
    return new AutomationError(
      'DISABLED',
      `${verb}('${selector}'): the element is disabled (${chosen.disabledReason ?? 'reason unknown'}) after ${elapsedMs}ms. ${where}.`,
      { ...base, check: 'enabled', state },
    );
  }
  if (chosen.hitTestOk === false) {
    const by = chosen.occludedBy ?? chosen.hitReason ?? 'something';
    return new AutomationError(
      'OCCLUDED',
      `${verb}('${selector}'): a click at (${Math.round(chosen.center.x)}, ${Math.round(chosen.center.y)}) would land on ${by}, not on the element. ${where}.`,
      { ...base, check: 'receivesEvents', state, occludedBy: chosen.occludedBy },
    );
  }
  if (chosen.stable === false) {
    return new AutomationError(
      'NOT_STABLE',
      `${verb}('${selector}'): the element was still moving after ${elapsedMs}ms (its rect changed between two animation frames). ${where}.`,
      { ...base, check: 'stable', state },
    );
  }

  return new AutomationError(
    'TIMEOUT',
    `${verb}('${selector}'): gave up after ${elapsedMs}ms. Every actionability check passed, so the failure is elsewhere in the verb; the element's state is in details.state. ${where}.`,
    { ...base, check: null, state },
  );
}
