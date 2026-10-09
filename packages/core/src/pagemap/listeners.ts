/**
 * `clickListenerBackendNodeIds`: the CDP half of detecting JavaScript click
 * listeners. It answers one question, "which nodes carry a
 * click-like JavaScript listener", for `PageMapNodeRecord.hasClickListener`
 * to be filled in from, later, by `interactivity.ts`.
 *
 * ── THE FIRST MODULE IN `@browserglass/core` TO HOLD AN OBJECT ID ────────
 *
 * Read this before touching anything below. Every other module in `cdp/`
 * that could answer a question with a live `objectId` refuses to create
 * one at all: `evaluate.ts`'s own module doc calls returning one to a
 * caller "the escalation this module exists to not hand out", and
 * `accessibility.ts:63` states the stricter local rule that its module
 * "never calls [`DOM.resolveNode`] ... so there is nothing here for a
 * later change to accidentally start leaking". This module breaks that
 * pattern on purpose, because `DOMDebugger.getEventListeners` has no
 * `backendNodeId` form; it takes only an `objectId`, so answering the
 * question at all means minting one.
 *
 * The exception is paid for, not waved through. `mintClickListenerNodes`
 * below is the ONLY function in this module, and in this package, that
 * calls `DOM.resolveNode`. The `objectId` it gets back lives inside that
 * one function and nowhere else: it is minted, passed to
 * `DOMDebugger.getEventListeners` as the next command, and released. It is
 * never stored on `this`, never closed over by anything that outlives the
 * call, never attached to a `PageMapNodeRecord`, and never returned from
 * this function. The `finally` block that sends `Runtime.releaseObject` is
 * not an optional cleanup step; it is the other half of the reason this
 * exception is admissible at all, and it runs whether
 * `DOMDebugger.getEventListeners` succeeds or throws.
 *
 * `DOMDebugger.getEventListeners` hands back more live handles than the
 * one this module mints: each listener record's `handler` and
 * `originalHandler` fields are themselves `Runtime.RemoteObject`s with
 * their own `objectId`. This module reads neither field and discards both,
 * exactly the way `evaluate.ts` discards the `objectId` CDP offers it
 * (`evaluate.ts:411` through `:424`). Only `backendNodeId` and `type` are
 * read off each record.
 *
 * ── Why this needs no `DOMDebugger.enable`, and no `DOM.enable` ─────────
 *
 * Measured, not assumed, by `examples/nextjs-demo/pagemap-listeners-probe.mjs`:
 * `DOMDebugger`
 * has no `enable` method to send at all (Chrome answers
 * `'DOMDebugger.enable' wasn't found`), and `DOM.getDocument({depth: 0})`
 * plus `DOM.resolveNode` both succeed with `DOM.enable` never sent, on the
 * same precedent `hit-test.ts:73` and `accessibility.ts:48` already
 * established for other `DOM.*` node-id commands. The probe's own session
 * tally across the whole three-call sequence below was zero `DOM.*` events
 * and zero `Runtime.*` events of any kind. `Runtime.releaseObject` in
 * particular does not enable the `Runtime` domain either: the probe minted
 * and released five object ids via `DOM.resolveNode` (never via
 * `Runtime.evaluate`) on a session where `Runtime.enable` was never sent,
 * and saw zero `executionContextCreated` and zero `consoleAPICalled`,
 * against a positive control on the same session that produced both once
 * `Runtime.enable` actually went out. So no domain in this sequence is
 * bracketed with an enable/disable pair the way `Accessibility` is in
 * `accessibility.ts`; there is nothing to bracket.
 *
 * ── The sequence: three round trips, not two ─────────────────────────────
 *
 * A first draft assumed `DOM.resolveNode` on the document node
 * was a free-standing first step. The probe corrected that:
 * `DOM.resolveNode({})` with neither `nodeId` nor `backendNodeId` is
 * refused outright ("Either nodeId or backendNodeId must be specified"),
 * so a cheap `DOM.getDocument({depth: 0})` has to run first, purely to
 * learn the document's own `nodeId`, exactly the same shape
 * `queryAccessibilityTree` already needed `DOM.getDocument` for
 * (`accessibility.ts:213`). The real sequence:
 *
 *  1. `DOM.getDocument({depth: 0})`, for the document `nodeId`.
 *  2. `DOM.resolveNode({nodeId})`, for one `objectId` naming the document.
 *  3. `DOMDebugger.getEventListeners({objectId, depth: -1, pierce: true})`.
 *
 * `pierce: true` was measured to cross BOTH open and closed shadow roots:
 * the probe's fixture carried a button inside a closed shadow root whose
 * own reference lives nowhere but the page's `connectedCallback` closure,
 * and `getEventListeners` still found it. This is the same asymmetry
 * `hit-test.ts:63` already recorded between `DOM.getNodeForLocation` and
 * `document.elementFromPoint`, extended to a second CDP command.
 *
 * ── Why no `Runtime.evaluate` in the page's own world ────────────────────
 *
 * browser-use's equivalent (`browser_use/dom/service.py:466`) sends
 * `Runtime.evaluate` calling the DevTools command-line `getEventListeners`
 * on every element from `document.querySelectorAll('*')`. That runs in the
 * page's OWN world, which `hit-test.ts:1` through `:77` already measured
 * as attacker-observable and attacker-controllable: a page that patches
 * `Document.prototype.elementFromPoint` counts every call and can lie about
 * the result, and a `querySelectorAll` over every element is a louder
 * version of the same exposure. The `DOMDebugger.*` sequence above executes
 * no page script anywhere in it, so none of that applies: there is nothing
 * in the page's own reach to observe or to poison.
 *
 * ── The blind spot: delegated listeners ──────────────────────────────────
 *
 * `DOMDebugger.getEventListeners` reports a listener on the node
 * `addEventListener` was actually called on. A DELEGATED handler,
 * registered once on a container and left to bubble, is reported on that
 * CONTAINER, never on the child that visually looks clickable. The probe
 * confirmed this directly: its `delegated-child` fixture site carries no
 * listener of its own, while its container does. React 17 and later
 * attach exactly one delegated listener at the root container, so on a
 * modern React page this signal is close to blind: `hasClickListener` will
 * read `false` for nearly every element in the tree regardless of what is
 * actually wired up to react to a click. `interactivity.ts` must not read
 * a `false` here as proof that a node has no click behaviour; it is only
 * proof that no listener was attached to THAT node directly.
 *
 * ── Performance: one subtree call, not one per node ──────────────────────
 *
 * browser-use's path is one `Runtime.evaluate`, one `Runtime.getProperties`
 * on the returned array handle, and up to 100 `DOM.describeNode` calls in
 * batches (`service.py:515` through `:557`). The three round trips above
 * replace the entire thing: `depth: -1, pierce: true` walks the whole
 * pierced subtree in one `DOMDebugger.getEventListeners` call, and every
 * returned record already carries the `backendNodeId` of the node it
 * belongs to, so no `describeNode` batch is needed to resolve one.
 *
 * ── The cap ────────────────────────────────────────────────────────────
 *
 * {@link MAX_CLICK_LISTENER_NODES} bounds the returned set at 100, the same
 * number browser-use uses for its own overflow sentinel
 * (`_MAX_JS_CLICK_LISTENER_ELEMENTS`, `service.py:34`), chosen here for the
 * same reason: a page map node list this signal touches is already capped
 * by `budget.ts`, and 100 distinct listener-bearing nodes is far more than
 * a single page map reply has room to act on differently by having found
 * more of them. Past the cap, {@link ClickListenerOutcome.truncated} is
 * `true` and the caller is told the real total rather than a silently
 * short list, following the same "report it as data" rule
 * `a11y.ts:69` already set for `queryAccessibilityTree`'s own bound.
 *
 * ── Degradation ────────────────────────────────────────────────────────
 *
 * This is an OPTIONAL phase (phase C). Any failure anywhere in the three-call sequence degrades to
 * an empty set here; it is `capture.ts`'s job, not this module's, to turn
 * that into `hasClickListener: null` on every node and a
 * `PageMapPhaseFailure` with `phase: 'listeners'`. This module never
 * throws past its own boundary for a reason a caller could not have
 * predicted from the CDP replies it received; it reports failure as a
 * thrown error and leaves the degrade-to-null decision to `capture.ts`,
 * which is where every other phase's degradation policy already lives.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId } from '../cdp/types.js';

/**
 * The event types this signal treats as "click-like", matching browser-use's
 * own list (`service.py:485`): a listener on any of these is what
 * `PageMapNodeRecord.hasClickListener` reports as `true`.
 */
const CLICK_LIKE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'click',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
]);

/**
 * Cap on the number of distinct listener-bearing nodes this module
 * returns. See this module's doc, "The cap".
 */
export const MAX_CLICK_LISTENER_NODES = 100;

/** The per-call `SendOptions.timeoutMs` override for `DOMDebugger.getEventListeners`, mirroring `accessibility.ts`'s own `FULL_AX_TREE_TIMEOUT_MS`: a whole-subtree, `depth: -1, pierce: true` walk is the one call in this sequence that can genuinely take a while on a large page, so it gets the same 20000ms allowance as `DOMSnapshot.captureSnapshot` and `Accessibility.getFullAXTree` in `packages/core/src/cdp/timeouts.ts`. It is passed as a per-call override rather than a `TIMEOUT_TABLE` entry. */
export const GET_EVENT_LISTENERS_TIMEOUT_MS = 20000;

/** The subset of one `DOMDebugger.getEventListeners` array entry this module reads. Every other field (`handler`, `originalHandler`, `useCapture`, `passive`, `once`, `scriptId`, `lineNumber`, `columnNumber`) is read for nothing and discarded; see this module's doc. */
interface RawEventListener {
  type?: string;
  backendNodeId?: number;
}

/** What {@link mintClickListenerNodes} found. */
export interface ClickListenerOutcome {
  /** Every distinct `backendNodeId` carrying at least one click-like listener, up to {@link MAX_CLICK_LISTENER_NODES}. */
  readonly backendNodeIds: ReadonlySet<number>;
  /** How many distinct listener-bearing nodes existed before the cap was applied. */
  readonly total: number;
  /** `true` when the cap cut the set short. */
  readonly truncated: boolean;
}

/**
 * Maps one `DOMDebugger.getEventListeners` reply's raw `listeners` array to
 * the set of distinct `backendNodeId`s carrying a click-like listener,
 * applying {@link MAX_CLICK_LISTENER_NODES}. Split out from
 * {@link mintClickListenerNodes} so the filter and the cap are unit
 * testable against a fixture reply with no CDP bridge involved at all; see
 * this module's test.
 */
function clickListenerNodesFromReply(listeners: readonly RawEventListener[]): ClickListenerOutcome {
  const all = new Set<number>();
  for (const listener of listeners) {
    if (typeof listener.type !== 'string' || !CLICK_LIKE_EVENT_TYPES.has(listener.type)) continue;
    if (typeof listener.backendNodeId !== 'number') continue; // unaddressable; nothing later can key on it.
    all.add(listener.backendNodeId);
  }
  const total = all.size;
  if (total <= MAX_CLICK_LISTENER_NODES) {
    return { backendNodeIds: all, total, truncated: false };
  }
  // Drop from whatever iteration order `Set` gives, the same "some subset
  // survives exactly correct" rule `evaluate.ts`/`accessibility.ts` apply
  // to their own bounds; there is no priority order to prefer here because
  // this module has no rect, no paint order and no document position to
  // rank by; that ranking, if any, is `budget.ts`'s job over the merged
  // record, not this signal's.
  const capped = new Set<number>();
  for (const id of all) {
    if (capped.size >= MAX_CLICK_LISTENER_NODES) break;
    capped.add(id);
  }
  return { backendNodeIds: capped, total, truncated: true };
}

/**
 * Runs the three-call sequence documented at the top of this module
 * (`DOM.getDocument` at `depth: 0`, `DOM.resolveNode`,
 * `DOMDebugger.getEventListeners` at `depth: -1, pierce: true`) on
 * `sessionId`, and returns the distinct `backendNodeId`s carrying a
 * click-like listener.
 *
 * The `objectId` `DOM.resolveNode` returns lives only inside this
 * function's own stack: it is read into a local, used exactly once as the
 * `objectId` argument to `DOMDebugger.getEventListeners`, and released in
 * the `finally` below whether that call succeeds or throws. It is never
 * assigned to anything this function does not itself own, and it is never
 * part of what this function returns. See this module's doc for why that
 * matters and why it is the only place in `@browserglass/core` this is
 * true.
 *
 * Throws on any failure in the sequence; the caller (`capture.ts`) decides
 * how an optional phase degrades, per this module's doc.
 */
export async function mintClickListenerNodes(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
): Promise<ClickListenerOutcome> {
  const doc = (await bridge.send('DOM.getDocument', { depth: 0 }, sessionId)) as {
    root?: { nodeId?: number };
  };
  const documentNodeId = doc.root?.nodeId;
  if (typeof documentNodeId !== 'number') {
    throw new Error('DOM.getDocument returned no root nodeId');
  }

  const resolved = (await bridge.send(
    'DOM.resolveNode',
    { nodeId: documentNodeId },
    sessionId,
  )) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== 'string') {
    throw new Error('DOM.resolveNode returned no objectId');
  }

  try {
    const raw = (await bridge.send(
      'DOMDebugger.getEventListeners',
      { objectId, depth: -1, pierce: true },
      sessionId,
      { timeoutMs: GET_EVENT_LISTENERS_TIMEOUT_MS },
    )) as { listeners?: RawEventListener[] };
    // `listener.handler`/`listener.originalHandler` are themselves
    // `Runtime.RemoteObject`s with their own `objectId`; they are never
    // read off `raw.listeners` anywhere in this module, on purpose.
    return clickListenerNodesFromReply(raw.listeners ?? []);
  } finally {
    // Not optional. See this module's doc, "THE FIRST MODULE ... TO HOLD
    // AN OBJECT ID". Best-effort, mirroring `accessibility.ts`'s own
    // `Accessibility.disable` tolerance: the session may already be gone
    // by the time this runs, and a release that never reaches a dead
    // browser leaves nothing to clean up either way.
    await bridge.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
  }
}

// Exported for `listeners.test.ts` only: the record-to-set mapping and the
// click-like filter are what this module can honestly unit test without a
// browser (see this module's doc, "Degradation", and the listeners probe
// for the CDP sequence itself, which is proven by the probe and not
// re-proven here).
export { clickListenerNodesFromReply as __testOnly_clickListenerNodesFromReply };
