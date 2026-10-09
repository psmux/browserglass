/**
 * The locator surface's public types.
 *
 * Nothing here is a handle, and nothing here is lazy. Every field is a
 * value read at a known instant, and `ResolveResult.resolvedAtMs` says
 * which instant. That is the difference between this and a port of
 * Playwright's `Locator`, and it is deliberate: see `./script.ts`'s module
 * doc for the round-trip arithmetic behind it.
 */

import type { EvaluateWorld } from '@browserglass/protocol';

/** Which matching engine a selector segment used. */
export type LocatorEngine =
  | 'css'
  | 'text'
  | 'xpath'
  | 'label'
  | 'ref'
  | 'visible'
  | 'role'
  | 'frame';

/** A rectangle in viewport CSS pixels, the same coordinate space every `AutomationClient` interaction method takes. */
export interface LocatorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One resolved element, measured at `ResolveResult.resolvedAtMs`.
 *
 * The five actionability answers (`attached`, `visible`, `enabled`,
 * `stable`, `hitTestOk`) are all pure DOM reads computed in the same
 * evaluation that produced the rect. That is the finding that made this
 * surface affordable: none of Playwright's actionability checks needs a
 * CDP domain the gateway does not already have, so there is no `DOM.*`
 * traffic and no accessibility tree behind any of it.
 */
export interface LocatorMatch {
  /** Position in the match list. Not a stable identity across calls; use {@link ref} for that, within the limits {@link LocatorMatch.ref} documents. */
  index: number;
  /**
   * The token this match was stamped with, addressable later as
   * `ref=<token>`, or `null` when `stamp: false` was asked for.
   *
   * NOT A HANDLE. A ref is an attribute written onto the element, and it
   * is valid exactly until that subtree re-renders. Nothing detects the
   * re-render; the only way to learn a ref has gone is to use it, and a
   * ref that no longer resolves fails as `DETACHED` with
   * `details.stale: true`, never as a silent no-op and never as a generic
   * timeout. Hand written automation code that invents the same mechanism
   * runs into the same limitation, so the contract is honest rather than
   * optimistic.
   */
  ref: string | null;
  tagName: string;
  /** The `type` attribute, for the input kinds that need it to be read back. */
  type: string | null;
  id: string | null;
  name: string | null;
  /**
   * The literal `role` HTML ATTRIBUTE, or `null` when the element has
   * none. NOT the element's computed accessible role: a `<button>` has no
   * `role` attribute at all and reports `null` here despite genuinely
   * being a button, and a `<div role="button">` reports `'button'` here
   * even on a page where nothing else about it behaves like one. This
   * field costs nothing (it rides along on the same DOM read every other
   * match field does) and stays for a caller who genuinely wants the
   * attribute, but it is NOT what `role=` selectors match against.
   *
   * For the real, Chrome-computed accessible role (the one a screen
   * reader sees, correctly handling the `<button>`-with-no-attribute and
   * `<a>`-without-`href` cases this field gets wrong), use the `role=`
   * selector engine or `AutomationClient.a11y()`, both built on
   * `Accessibility.queryAXTree` (`packages/core/src/cdp/accessibility.ts`)
   * rather than on this attribute. See `role=`'s own doc in
   * `AutomationClient.resolve()` for why matching stayed off this field:
   * an attribute read has no CDP round trip, and folding a
   * `queryAXTree` call into every ordinary `resolve()` for a field most
   * callers never read would tax the common case to serve the
   * uncommon one.
   */
  role: string | null;
  rect: LocatorRect;
  /** The rect's centre, in viewport CSS pixels: the point a coordinate click is dispatched at. */
  center: { x: number; y: number };
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  /** Why the element is not enabled: `element.disabled`, `aria-disabled="true"`, or an ancestor `fieldset[disabled]`. `null` when it is enabled. */
  disabledReason: string | null;
  editable: boolean;
  /**
   * Whether the rect was unchanged across two animation frames, or `null`
   * when the answer could not be determined because the tab never painted.
   * A backgrounded tab does not run `requestAnimationFrame`, and treating
   * "unknown" as "unstable" would refuse to act on exactly the tab an
   * unattended agent is most likely to be driving.
   */
  stable: boolean | null;
  /** Whether `document.elementsFromPoint` at {@link center} reaches this element. `null` when the check was not requested, or the centre is off-viewport. */
  hitTestOk: boolean | null;
  /** What would take a click aimed at {@link center}, described well enough to act on: `div[data-testid="click_filter"]`, not "an element". `null` when nothing is in the way. */
  occludedBy: string | null;
  /** Prose for `hitTestOk` being `false` or `null`. */
  hitReason: string | null;
  inViewport: boolean;
  /** Computed opacity. Not part of the visibility answer (Playwright does not count `opacity: 0` as invisible, and such an element does receive real clicks), but reported so a failure can mention it. */
  opacity: number | null;
  pointerEvents: string | null;
  /** Normalised `textContent`, truncated. */
  text: string | null;
  /** `element.value` for the elements that have one, truncated at 2000 characters. */
  value: string | null;
  /** `element.checked` for the elements that have one. */
  checked: boolean | null;
  /**
   * What {@link ResolveOptions.read} asked for, if anything: the rendered
   * `innerText`, one attribute, the checked state, the current value, or
   * (for a `<select>`) every offered option.
   *
   * It rides along on the resolver rather than costing a second call. The
   * read verbs in real scripts (`.inner_text(`, `.get_attribute(`,
   * `.is_checked(`) are nearly always preceded by a locate, so folding the
   * read into the locate halves the round trips for every one of those
   * call sites. `dropdownOptions()` is the same argument applied to a
   * fourth read.
   */
  readValue: string | boolean | DropdownOption[] | null;
  /** A short human-readable identification of this element, the same spelling used for {@link occludedBy}. */
  describe: string | null;
}

/** What one `resolve()` saw. */
export interface ResolveResult {
  /** Every match, up to `limit`, in document order. Empty is an ordinary answer, never an error: a selector matching nothing is information, and it is the answer `.count() === 0` was asking for. */
  matches: LocatorMatch[];
  /** How many matched before `limit` was applied. */
  total: number;
  truncated: boolean;
  /** The engine of the LAST segment, which is the one that produced the matches. */
  engine: LocatorEngine;
  /** How many `>>` segments the selector had. */
  segments: number;
  /** The selector as given. */
  selector: string;
  /**
   * The client's clock when the reply arrived. Every acting verb compares
   * this against `Date.now()` before it dispatches input and re-resolves
   * when the gap exceeds `STALE_RESOLVE_WINDOW_MS`, because a rect measured
   * before a re-render points at whatever moved into that screen position
   * afterwards.
   */
  resolvedAtMs: number;
  url: string;
  title: string;
  viewport: { w: number; h: number; scrollX: number; scrollY: number };
  /** True when a `within` ref was given and no longer resolves. The matches are empty and the reason is staleness, not absence. */
  scopeMissing: boolean;
  /**
   * The BrowserGlass target id the matches actually live in: the id
   * `resolve()`/`waitFor()` was called with, unless the selector carried a
   * `frame=` segment that crossed into a cross-origin child frame, in which
   * case this names that frame's own CDP target.
   *
   * `LocatorMatch.rect`/`center` are ALWAYS in the TOP-LEVEL page's viewport
   * CSS px, translated across every frame boundary the selector crossed
   * (`engine.ts`'s `enterFrame`/`translateMatches`), because that is the
   * space real input dispatch (`clickAt`, and therefore every locator verb
   * that clicks) takes. This field is the other half of that split: a
   * follow-up call addressing the SAME element by its stamped `ref` (`fill`'s
   * `CLEAR_SCRIPT`/`READ_SCRIPT`, `select`'s `SELECT_SCRIPT`, `click`'s
   * `via: 'dispatch'`) has to run in the document the element is actually
   * IN, not in the top page, and this is how those calls know which target
   * that is.
   */
  resolvedTargetId: string;
}

/** Options for {@link AutomationClient.resolve}. */
export interface ResolveOptions {
  /** Cap on returned matches. Default 50. `total` still reports the real count. */
  limit?: number;
  /** Write a `data-bgls-ref` stamp onto each match so later calls can address it. Default true. Set false on a page whose scripts read attribute mutations; the rects and indices still come back and the caller drives by coordinates. */
  stamp?: boolean;
  /** Measure rect stability across two animation frames. Default true. Set false for a pure count or existence check, which does not need it and should not pay two frames for it. */
  stable?: boolean;
  /** Hit-test each match at its centre. Default true. */
  hitTest?: boolean;
  /** `scrollIntoView({block: 'center'})` the match at `scrollIndex` before measuring, in the same evaluation. Default false for `resolve` and true for every acting verb. */
  scroll?: boolean;
  /** Which match to scroll to when `scroll` is set. Default 0. */
  scrollIndex?: number;
  /** Resolve within an already-stamped element rather than the document. */
  within?: string;
  /** Truncate each match's `text` at this many characters. Default 200. */
  textLimit?: number;
  /** Read one extra thing off every match in the same evaluation, into {@link LocatorMatch.readValue}. This is how `innerText()`, `getAttribute()`, `isChecked()` and `dropdownOptions()` cost one round trip instead of two. */
  read?: {
    what: 'innerText' | 'attribute' | 'checked' | 'value' | 'options';
    name?: string;
    limit?: number;
  };
  /** Evaluation deadline. Default `DEFAULT_EVALUATE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** What {@link AutomationClient.waitFor} is waiting for. */
export type LocatorState = 'attached' | 'detached' | 'visible' | 'hidden' | 'actionable';

/** Options for {@link AutomationClient.waitFor}. */
export interface WaitForOptions extends ResolveOptions {
  /** Default `'visible'`. `'actionable'` additionally requires enabled, stable and not occluded, and is what the acting verbs wait for. */
  state?: LocatorState;
  /** How long to hold, milliseconds. Default `defaultTimeoutMs`. Held inside the page, not polled from here. Capped so that the wait plus its margin fits `MAX_EVALUATE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** The in-page backstop interval, milliseconds. Default 100. This costs nothing on the socket; the MutationObserver is what actually wakes the check. */
  pollMs?: number;
  /**
   * Wait for THIS match to reach the state rather than for any of them.
   *
   * Without it the wait is satisfied the moment some match qualifies,
   * which is right when the caller has not named one and wrong when it
   * has: a caller that named index 0 would be released by index 1
   * becoming ready and would then fail on its own element for no reason
   * it could see.
   */
  index?: number;
}

/** What {@link AutomationClient.waitFor} resolved with. */
export interface WaitForResult extends ResolveResult {
  /** Milliseconds spent waiting in the page. */
  waitedMs: number;
  /** How many times the predicate was evaluated. */
  checks: number;
  /** How many times a DOM mutation woke the check. Zero with a high `checks` means the page was static and the interval did all the work. */
  wakes: number;
}

/** How a locator click reaches the page. */
export type ClickVia = 'coordinates' | 'dispatch';

/** Options for {@link AutomationClient.click}. */
export interface LocatorClickOptions {
  /**
   * Act on this match rather than choosing one.
   *
   * Omitted, the verb takes the first match that passes every actionability
   * check, which is what callers otherwise hand-roll: count, re-locate
   * with `>> visible=true`, count again, take first. Given, the verb uses
   * exactly that index and reports its state on failure rather than
   * silently moving to a different element.
   *
   * There is no strict mode here and there will not be one. Playwright
   * throws when a selector matches more than one node, and automation code
   * fights that constantly, because real pages ship duplicate ids and
   * repeated names. Matching many is a fact about the page, not an error.
   */
  index?: number;
  /** Overall deadline covering the wait, the resolve and the retries. Default 8000. */
  timeoutMs?: number;
  /** `'coordinates'` (default) drives real CDP input through the held lease. `'dispatch'` calls `element.click()` in the page, which produces `isTrusted: false` and which some widgets ignore. */
  via?: ClickVia;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  /** Scroll the chosen match into view before measuring. Default true, and it happens inside the measuring evaluation, never as a separate round trip. */
  scroll?: boolean;
  /**
   * A page expression re-evaluated after the click; the click counts as
   * having WORKED only when it returns truthy.
   *
   * Playwright has no equivalent, and its absence has a real cost: a click
   * helper without it reports success on a click that landed on a
   * transparent overlay, and the menu never opened. "A click was delivered" and
   * "a click worked" are different claims and only one of them is useful.
   */
  verify?: string;
  /** How many times to re-resolve and click again when `verify` does not pass. Default 2. Ignored without `verify`: without a predicate there is nothing to retry on. */
  retries?: number;
  /** Milliseconds to wait after dispatching before evaluating `verify`. Default 250. */
  verifyDelayMs?: number;
  /**
   * Which JavaScript world {@link verify} runs in. Default `'isolated'`,
   * the same world every one of the locator engine's own scripts uses
   * (`locator/engine.ts`'s `ENGINE_WORLD`, which carries the full
   * argument).
   *
   * Set `'main'` ONLY for a predicate that has to read a global the page
   * itself defined. In the isolated world `window.somethingThePageSet` is
   * `undefined`, and `undefined` is indistinguishable from "the value is
   * not set yet", so such a predicate would quietly never pass rather than
   * failing loudly.
   *
   * It is spelled out rather than defaulted the other way because the main
   * world is observable: a page can hook what the predicate calls, and a
   * predicate is the one script here whose text the page's operator did
   * not write but whose effects they can watch.
   */
  verifyWorld?: EvaluateWorld;
  /** Write stamps while resolving. Default true. */
  stamp?: boolean;
}

/** What a locator click did. */
export interface ClickResult {
  ok: true;
  via: ClickVia;
  /** The stamp on the element that was clicked, or `null` when `stamp: false`. */
  ref: string | null;
  /** Where the click was dispatched, in viewport CSS pixels. `null` for `via: 'dispatch'`, which uses no coordinates. */
  point: { x: number; y: number } | null;
  /** How many elements the selector matched. Reported because a caller acting on match 0 of 7 usually wants to know that. */
  matchCount: number;
  index: number;
  /** `true`/`false` when `verify` was given, `null` when it was not. A `null` here means delivered, not verified. */
  verified: boolean | null;
  attempts: number;
  elapsedMs: number;
  /** Whether the chosen match had to be re-resolved because the first measurement went stale before dispatch. */
  reResolved: boolean;
}

/** How {@link AutomationClient.fill} puts characters into the page. */
export type FillMode = 'keys' | 'insert';

/** Options for {@link AutomationClient.fill}. */
export interface LocatorFillOptions {
  index?: number;
  timeoutMs?: number;
  /**
   * `'keys'` (default) sends real per-character `keydown`/`keyup` pairs
   * through the input path. `'insert'` sends one `Input.insertText`.
   *
   * The default is not a style preference. `insertText` fires
   * `beforeinput` and `input` and no `keydown` at all, and react-select
   * style comboboxes (and some enterprise form widgets) open and filter on
   * `keydown`. The usual workaround is real per-character keys at a 40ms
   * delay. A `fill` that defaulted to `insert` would look correct in a
   * test against a plain `<input>` and fail on the real world forms that
   * matter.
   */
  mode?: FillMode;
  /** Inter-character delay for `mode: 'keys'`, milliseconds. Default 0. Set it (40 is a reasonable value) when a widget debounces its filtering. */
  delayMs?: number;
  /** Clear the field first. Default true. */
  clear?: boolean;
  /** Click the element before typing, which focuses it with a real gesture and proves it is not covered. Default true. */
  click?: boolean;
  /** Read the value back after typing and report whether it matches. Default true; the read is one evaluate and is worth it for the same reason `click`'s `verify` is. */
  verify?: boolean;
  /**
   * Throw `TIMEOUT` when the read back value does not equal `value`,
   * instead of returning `verified: false`. Default false, because a masked
   * or reformatting field legitimately changes what was typed. Turn it on
   * for passwords and for any field the page should not rewrite: without it
   * a dropped character is only visible in `verified`. Ignored when
   * `verify: false`.
   */
  strict?: boolean;
  scroll?: boolean;
}

/** What a locator fill did. */
export interface FillResult {
  ok: true;
  ref: string | null;
  matchCount: number;
  index: number;
  mode: FillMode;
  /** What the field held when it was read back, or `null` when `verify: false`. */
  actual: string | null;
  /**
   * Whether `actual` equals the value asked for. `null` when `verify: false`.
   * `false` is NOT an exception unless `strict: true` was passed, so check
   * it: `ok` only says the keys were delivered.
   */
  verified: boolean | null;
  elapsedMs: number;
}

// ==================================================================
// select: Playwright's `select_option` semantics on top of `resolve` and
// `evaluate`, addressed by exactly one of value, label or index rather
// than by a bare string whose meaning would otherwise have to be guessed
// at runtime. See `AutomationClient.select`'s own doc for why this exists
// after an earlier pass refused it.
// ==================================================================

/**
 * One requested `<option>`, addressed by exactly one of its `value`
 * attribute, its visible label (normalised `textContent`, exact match),
 * or its position. A bare `string` is shorthand for `{ value }`, matching
 * Playwright's own `select_option(selector, "value")` convention: the
 * overwhelmingly common case is a value known ahead of time (a country
 * code, an enum), and typing `{ value: 'US' }` at forty call sites for
 * that case would be exactly the kind of ceremony this surface exists to
 * remove.
 */
export type SelectOptionSpec = string | { value: string } | { label: string } | { index: number };

/** Options for {@link AutomationClient.select}. */
export interface LocatorSelectOptions {
  /** Which `<select>` match to act on, when the selector matches more than one. Default: the first actionable match, the same rule every other acting verb uses. */
  index?: number;
  /** Overall deadline covering the wait and the resolve. Default 8000, the same default `click`/`fill` use. */
  timeoutMs?: number;
  /** Scroll the chosen match into view before measuring. Default true. */
  scroll?: boolean;
}

/** What a locator select did. */
export interface SelectResult {
  ok: true;
  /** The stamp on the `<select>` that was acted on. */
  ref: string | null;
  /** How many elements the selector matched. */
  matchCount: number;
  index: number;
  /** Every `<option>` left selected afterward, in document order: its `value`. */
  values: string[];
  /** Every `<option>` left selected afterward, in document order: its visible label (normalised `textContent`), parallel to {@link values}. */
  labels: string[];
  elapsedMs: number;
}

// ==================================================================
// dropdownOptions: reads a <select>'s offered options, without acting on
// it. The same enumeration `select()`'s own option-not-found error already
// builds (`script.ts`'s shared `bglsListOptions`), reused rather than
// duplicated, and read off the resolver in ONE round trip via
// `read: { what: 'options' }` exactly like `innerText`/`getAttribute`/
// `isChecked` already are.
// ==================================================================

/** One `<option>` on a `<select>`, as read by {@link AutomationClient.dropdownOptions}. */
export interface DropdownOption {
  value: string;
  /** Visible text, normalised (whitespace collapsed, trimmed). */
  label: string;
  /** Position within the `<select>`. */
  index: number;
  selected: boolean;
  disabled: boolean;
}

// ==================================================================
// hover: moves the pointer to a resolved element's centre, through the
// same input path and the same actionability contract `click` uses, for
// the menus and tooltips that open only on `:hover`.
// ==================================================================

/** Options for {@link AutomationClient.hover}. */
export interface LocatorHoverOptions {
  /** Act on this match rather than choosing one. Same rule as {@link LocatorClickOptions.index}. */
  index?: number;
  /** Overall deadline covering the wait and the resolve. Default 8000, the same default `click`/`fill`/`select` use. */
  timeoutMs?: number;
  /** Scroll the chosen match into view before measuring. Default true. */
  scroll?: boolean;
  /** Write stamps while resolving. Default true. */
  stamp?: boolean;
}

/** What a locator hover did. */
export interface HoverResult {
  ok: true;
  /** The stamp on the element that was hovered, or `null` when `stamp: false`. */
  ref: string | null;
  /** Where the pointer was moved to, in viewport CSS pixels. */
  point: { x: number; y: number };
  matchCount: number;
  index: number;
  elapsedMs: number;
  /** Whether the chosen match had to be re-resolved because the first measurement went stale before dispatch. */
  reResolved: boolean;
}

// ==================================================================
// scrollToText: scrollIntoView, addressed by rendered text instead of a
// selector, composed over the existing `text=` engine rather than a new
// matcher.
// ==================================================================

/** Options for {@link AutomationClient.scrollToText}. */
export interface ScrollToTextOptions {
  /** Match the whole normalised text exactly rather than as a substring, `text=`'s own `"exact phrase"` convention. Default false. */
  exact?: boolean;
  index?: number;
  timeoutMs?: number;
}

// ==================================================================
// scrollContainer: a real wheel event aimed inside a resolved element,
// rather than at a caller-chosen page point, for the scroll region that is
// not the viewport (a virtualised list, a modal body, any element with its
// own `overflow: auto`).
// ==================================================================

/** Options for {@link AutomationClient.scrollContainer}. */
export interface LocatorScrollContainerOptions {
  index?: number;
  timeoutMs?: number;
  /** Scroll the chosen match into view before measuring. Default true. */
  scroll?: boolean;
}

/** What a locator scrollContainer did. */
export interface ScrollContainerResult {
  ok: true;
  ref: string | null;
  /** Where the wheel event was dispatched, in viewport CSS pixels: the chosen match's centre. */
  point: { x: number; y: number };
  matchCount: number;
  index: number;
  elapsedMs: number;
}

// ==================================================================
// findInPage: full text search over the page's own VISIBLE text
// (browser-use's `search_page`), as distinct from the `text=` selector
// engine, which needs the caller to already know which element says it.
// ==================================================================

/** Options for {@link AutomationClient.findInPage}. */
export interface FindInPageOptions {
  /** Restrict the search to the first element a CSS selector matches. Matching nothing throws `NOT_FOUND`. Default: the whole page. */
  scope?: string;
  /** Characters of surrounding text kept on each side of a match, for telling "$45.00 shipping" from "$45.00 total" without a second round trip. Default 60. */
  contextChars?: number;
  /** Cap on returned matches. Default 50. `total` still reports the real count. */
  limit?: number;
  /** Stamp each match's containing element so it can be addressed afterward as `ref=<token>`. Default true. */
  stamp?: boolean;
  timeoutMs?: number;
}

/** One text match {@link AutomationClient.findInPage} found. */
export interface FindInPageMatch {
  /** The matched substring. */
  text: string;
  /** A window of {@link FindInPageOptions.contextChars} characters on either side of {@link text}, normalised whitespace. */
  context: string;
  /** The tag name of the element the matching text node belongs to. */
  tagName: string;
  /** The stamp on that element, addressable as `ref=<token>`, or `null` when `stamp: false`. */
  ref: string | null;
}

/** What {@link AutomationClient.findInPage} found. */
export interface FindInPageResult {
  matches: FindInPageMatch[];
  /** How many matched before `limit` was applied. */
  total: number;
  truncated: boolean;
  url: string;
  title: string;
}
