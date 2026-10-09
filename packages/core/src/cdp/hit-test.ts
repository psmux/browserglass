/**
 * `hitTestAtPoint`: "what is under this point", answered with `DOM.*`
 * commands only. This is the CDP half of `target.probe`, which is what
 * fires every time a person moves the mouse across a streamed pane;
 * `@browserglass/server`'s `ManagedSession.probe()` is its only production
 * caller and owns the wire shape, the capability gate and the sanitising.
 *
 * WHY NO `Runtime.evaluate`
 *
 * `ManagedSession.probe()` used to build an expression string around
 * `document.elementFromPoint(x, y)` and send it as a raw
 * `Runtime.evaluate` on every hover. It was reported as a stealth
 * regression on the grounds that the `Runtime` domain is the signal
 * patchright names as fingerprinted, so the exposure was measured against
 * a real Chrome before it was changed, because that reading and the fix it
 * implies are not the same thing.
 *
 * What the measurement found:
 *
 *  1. `Runtime.evaluate` does NOT enable the `Runtime` domain. Five
 *     `Runtime.evaluate` calls on a freshly attached session produced zero
 *     `Runtime.executionContextCreated` and zero `Runtime.consoleAPICalled`
 *     events, while the same session immediately after one
 *     `Runtime.enable` produced one context-created event and roughly 1500
 *     console events in under two seconds. So the domain-enable
 *     fingerprint that patchright documents (and that this build takes
 *     seriously enough that `diagnostics/target-diagnostics.ts` is the only
 *     module allowed to send `Runtime.enable` at all) was never tripped by
 *     the probe. Gating the probe on the `evaluate` capability would
 *     therefore have closed a hole that was not open, at the price of
 *     breaking hover for every existing viewer, since `evaluate` is off by
 *     default and is in no role bundle.
 *
 *  2. The real exposure is narrower in mechanism and worse in consequence.
 *     The expression ran in the page's OWN world, so everything it touched
 *     was the page's to redefine. A page that reassigns
 *     `Document.prototype.elementFromPoint` counted every hover exactly, in
 *     real time, with the coordinates, and no ordinary user interaction
 *     gives a page that stream of data. Traps on
 *     `Element.prototype.getBoundingClientRect`,
 *     `Element.prototype.getAttribute` and `Node.prototype.textContent`
 *     each fired once per probe too.
 *
 *  3. The same reassignment lets the page LIE. A page that returns a
 *     detached `<a href="https://attacker.example/paid">` from its own
 *     `elementFromPoint` made the probe report that href as the thing
 *     under the pointer. `target.probed.href` is what
 *     `@browserglass/react`'s `<ContextMenu/>` turns into "open link in new
 *     tab", so the page could choose the destination in a menu the viewer
 *     reasonably reads as the browser's own. A capability gate would not
 *     have touched this: it would still be there for every caller that
 *     holds `evaluate`.
 *
 * Every one of those three is closed by not running script. Under the same
 * traps, the `DOM.*` sequence below moved no counter at all: no
 * `elementFromPoint`, no `getBoundingClientRect`, no `getAttribute`, no
 * `textContent`, and no `Runtime` event. Chrome hit-tests in the renderer
 * and answers out of the DOM agent, so there is nothing in the page's
 * reach to observe or to poison. `cdp/file-input.ts` reached the same
 * conclusion for the same reason ("WHY NO `Runtime.evaluate`", there about
 * `DOM.querySelector`); this module is the hover-path version of it.
 *
 * The hit test is also strictly better than the one it replaces.
 * `document.elementFromPoint` stops at a closed shadow root and reports the
 * host; `DOM.getNodeForLocation` reports the real element inside it
 * (measured: the host `<div>` versus the `<button id="inner">` actually
 * under the pointer). It also descends into same-process iframes, which
 * `elementFromPoint` on the top document never did.
 *
 * WHAT IT COSTS
 *
 * Three CDP round trips for a hover over anything that is not a link, four
 * over a link, against the one the evaluate did. `DOM.getNodeForLocation`
 * enables the DOM agent by itself (measured: it answers with no
 * `DOM.getDocument` ahead of it), so the document fetch is deferred to the
 * only case that needs it, which is resolving a relative `href` against the
 * document's base URL.
 */

import type { CdpBridge } from './bridge.js';
import type { CdpSessionId } from './types.js';

/**
 * A hit element's box, in viewport CSS px, matching `ProbeRect` on the
 * wire. Derived from `DOM.getBoxModel`'s content quad rather than from
 * `getBoundingClientRect`, and verified to agree with it: an anchor laid
 * out at `left:50px;top:60px;width:120px;height:30px` produced the quad
 * `[50,60, 170,60, 170,90, 50,90]`. The quad is the axis-aligned bounding
 * box of the four corners, so a rotated or otherwise transformed element
 * yields its bounding box, which is what `getBoundingClientRect` gave too.
 */
export interface HitTestRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What {@link hitTestAtPoint} found under the point. */
export interface HitTestResult {
  /** Lower case, from `DOM.describeNode`'s `localName`. */
  readonly tagName: string;
  /**
   * The element's `aria-label` when it has a non-empty one, otherwise
   * `'tag#id.class.class'`. Capped at 80 bytes. UNTRUSTED: every part of
   * it is page-authored.
   *
   * The evaluate-based probe sent `aria-label || textContent || ''`. The
   * first of those is an attribute, so `DOM.describeNode` hands it over at
   * no extra cost and the precedence is kept exactly, which matters: the
   * conformance suite's collaboration fixture publishes its whole state
   * into `aria-label` and reads it back through this field
   * (`packages/conformance/test/e2e/support/fixture-server.ts`), so it is
   * a live consumer and not a hypothetical one.
   *
   * `textContent` is not reachable without executing script
   * (`DOM.getOuterHTML` would mean pulling back markup to strip, on every
   * hover, for an element of any size), so that fallback is gone. What
   * replaces it is not an invention: `'tag#id.class.class'` is the value
   * `TargetProbed.label` has been specified as all along
   * (`@browserglass/protocol`'s `wire/messages/probe.ts`, and the same
   * wording on the client's `ProbeResult`). The fallback therefore moves
   * from arbitrary page prose the contract never promised to the string it
   * did.
   */
  readonly label: string;
  /**
   * `null` when Chrome refuses a box model, which it does for an element
   * with no layout: `DOM.getBoxModel` answers `-32000 "Could not compute
   * box model."` for `display: none`. The evaluate path reported `0,0,0,0`
   * in that case, which a viewer draws as a highlight of nothing at the
   * top left corner; saying "no rect" is the honest version.
   */
  readonly rect: HitTestRect | null;
  /**
   * Absolute href of the hit element when it is an `<a>` or `<area>`,
   * otherwise `null`. UNTRUSTED.
   *
   * The anchor has to be the hit element itself, exactly as before: the
   * evaluate path tested `el instanceof HTMLAnchorElement` on the hit
   * element and never walked up either, so hovering a `<span>` inside a
   * link reported no href then and reports none now.
   * `TargetProbed.hrefFromAncestor` stays unimplemented, and stays unsent,
   * because `DOM.describeNode` gives no parent chain for a
   * `backendNodeId` and the calls that would (a full
   * `DOM.getDocument({depth: -1})` per hover) are not affordable on this
   * path.
   */
  readonly href: string | null;
}

/** `TargetProbed.label` is specified as capped at 80 bytes. */
const MAX_LABEL_BYTES = 80;

/** The two elements whose `href` attribute is a navigable link. `<link>` and `<base>` also carry one but are never hit-testable, being unrendered. */
const LINK_TAGS = new Set(['a', 'area']);

/** `DOM.describeNode`'s reply, narrowed to the fields this module reads. */
interface DescribeNodeReply {
  readonly node?: {
    readonly localName?: string;
    readonly nodeName?: string;
    /** Flat `[name, value, name, value, ...]` list, CDP's own shape. */
    readonly attributes?: readonly string[];
  };
}

/** Turns `DOM.describeNode`'s flat attribute list into a map. Attribute names arrive already lower cased for HTML elements. */
function attributeMap(flat: readonly string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = flat[i];
    if (name !== undefined && !out.has(name)) out.set(name, flat[i + 1] ?? '');
  }
  return out;
}

/** Truncates to at most `max` UTF-8 bytes, never splitting a code point (the cap is specified in bytes, and a page can put astral characters in a class name). */
function capBytes(value: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= max) return value;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const size = encoder.encode(ch).length;
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

/** `aria-label`, else `'tag#id.class.class'`. See {@link HitTestResult.label}. */
function buildLabel(tagName: string, attrs: Map<string, string>): string {
  const aria = attrs.get('aria-label');
  if (aria !== undefined && aria !== '') return capBytes(aria, MAX_LABEL_BYTES);
  const id = attrs.get('id');
  const classNames = (attrs.get('class') ?? '').split(/\s+/).filter((c) => c.length > 0);
  const label = `${tagName}${id ? `#${id}` : ''}${classNames.map((c) => `.${c}`).join('')}`;
  return capBytes(label, MAX_LABEL_BYTES);
}

/** The axis-aligned bounding box of `DOM.getBoxModel`'s eight-number content quad. */
function rectFromQuad(quad: unknown): HitTestRect | null {
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
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Hit-tests one point in the page behind `sessionId` and describes what is
 * there, without executing any script in it. Returns `null` for "nothing
 * under that point", which is what the caller turns into `hit: false`.
 *
 * `x` and `y` are viewport CSS px, the same basis
 * `document.elementFromPoint` took and the same basis the returned
 * {@link HitTestRect} is in.
 *
 * The sequence, and why each call is there:
 *
 * 1. `DOM.getNodeForLocation`. Chrome's own renderer hit test. It climbs
 *    text nodes to their containing element, so the result is an element
 *    exactly as `elementFromPoint` gave one, and it pierces closed shadow
 *    roots and same-process iframes, which `elementFromPoint` did not.
 *    `includeUserAgentShadowDOM: false` keeps the answer to nodes the page
 *    itself authored rather than the internals of a `<video>` control or a
 *    date picker, which is what a hover highlight should outline.
 *    A point with nothing under it (past the bottom of the viewport, for
 *    instance) is a CDP error, `-32000 "No node found at given location"`,
 *    not an empty reply, so it is caught here and reported as no hit.
 *    Note that only `backendNodeId` is guaranteed: `nodeId` comes back
 *    only for a node already pushed to the frontend, so every call below
 *    addresses the node by `backendNodeId`.
 * 2. `DOM.describeNode`, for the tag name and the attributes the label and
 *    the href are built from.
 * 3. `DOM.getBoxModel`, for the rect. Tolerated failing: see
 *    {@link HitTestResult.rect}.
 * 4. `DOM.getDocument` with `depth: 1`, ONLY when the element is a link,
 *    to absolutise its `href` the way `HTMLAnchorElement.href` used to.
 *    `depth: 1` rather than `0` because the root document node carries the
 *    `baseURL` (`<base href>` included, verified) but NOT a frame id,
 *    while its element child carries the main frame's id. Both are needed:
 *    a node inside a subframe resolves its relative hrefs against THAT
 *    frame's base URL, which this call has not read, so when the frame ids
 *    differ a relative href is reported as no href rather than as a URL on
 *    the wrong origin. Guessing there would put a link the viewer never
 *    visits into a context menu that offers to open it.
 */
export async function hitTestAtPoint(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  point: { readonly x: number; readonly y: number },
): Promise<HitTestResult | null> {
  let located: { backendNodeId?: number; frameId?: string };
  try {
    located = (await bridge.send(
      'DOM.getNodeForLocation',
      { x: point.x, y: point.y, includeUserAgentShadowDOM: false },
      sessionId,
    )) as { backendNodeId?: number; frameId?: string };
  } catch {
    // "No node found at given location" is the normal answer for a point
    // over nothing, and it arrives as a protocol error. A dead session
    // lands here too and is reported the same way, which matches the
    // evaluate path: it could not tell those apart either.
    return null;
  }

  const backendNodeId = located.backendNodeId;
  if (typeof backendNodeId !== 'number') return null;

  const described = (await bridge.send(
    'DOM.describeNode',
    { backendNodeId },
    sessionId,
  )) as DescribeNodeReply;
  const tagName = (described.node?.localName ?? described.node?.nodeName ?? '').toLowerCase();
  if (tagName === '') return null;
  const attrs = attributeMap(described.node?.attributes);

  let rect: HitTestRect | null = null;
  try {
    const box = (await bridge.send('DOM.getBoxModel', { backendNodeId }, sessionId)) as {
      model?: { content?: unknown };
    };
    rect = rectFromQuad(box.model?.content);
  } catch {
    rect = null;
  }

  return {
    tagName,
    label: buildLabel(tagName, attrs),
    rect,
    href: await resolveHref(bridge, sessionId, tagName, attrs, located.frameId),
  };
}

/** Step 4 of {@link hitTestAtPoint}'s sequence. Skipped entirely, and so costing no round trip, for the overwhelmingly common hover over something that is not a link. */
async function resolveHref(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  tagName: string,
  attrs: Map<string, string>,
  nodeFrameId: string | undefined,
): Promise<string | null> {
  if (!LINK_TAGS.has(tagName)) return null;
  const raw = attrs.get('href');
  if (raw === undefined) return null;

  let baseURL: string | undefined;
  let mainFrameId: string | undefined;
  try {
    const doc = (await bridge.send('DOM.getDocument', { depth: 1 }, sessionId)) as {
      root?: {
        baseURL?: string;
        documentURL?: string;
        children?: ReadonlyArray<{ nodeType?: number; frameId?: string }>;
      };
    };
    baseURL = doc.root?.baseURL ?? doc.root?.documentURL;
    mainFrameId = doc.root?.children?.find((c) => c.nodeType === 1)?.frameId;
  } catch {
    // Fall through with no base: an already-absolute href is still
    // reportable, and a relative one is dropped rather than guessed at.
  }

  const inAnotherFrame =
    nodeFrameId !== undefined && mainFrameId !== undefined && nodeFrameId !== mainFrameId;
  try {
    return new URL(raw, inAnotherFrame ? undefined : baseURL).href;
  } catch {
    // Either a relative href with no usable base (the subframe case above,
    // or a failed document fetch), or something that is not a URL at all.
    return null;
  }
}
