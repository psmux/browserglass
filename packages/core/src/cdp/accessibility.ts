/**
 * `queryAccessibilityTree` / `stampAccessibilityNodes`: the CDP half of
 * `@browserglass/protocol`'s `page.a11y.get`, and the ONE place in this
 * build that ever sends an `Accessibility.*` command.
 *
 * Read this doc, and `@browserglass/protocol`'s `wire/messages/a11y.ts`
 * doc, before changing anything here. The short version of that longer
 * argument: `AutomationClient.a11y()` and the locator engine's `role=`
 * selector are the SAME question, "what is this element's role and
 * accessible name", asked with different filters, and this module is the
 * one function both answers come from, so there is exactly one place that
 * decides what Chrome thinks an element's role is rather than two that
 * could drift apart.
 *
 * ── Domain ownership: enabled and disabled WITHIN one call, never held ──
 *
 * `Accessibility` is a per CDP SESSION domain, like every other one
 * (`packages/core/src/diagnostics/target-diagnostics.ts`'s module doc is
 * the canonical statement of this, and `packages/core/src/cdp/target-registry.ts`'s
 * `installInitScripts` is the other place this exact trap has bitten:
 * a cross-origin navigation kills the CDP session outright, and Chrome
 * carries no domain-enable state across that swap). Both of those modules
 * answer the trap by OWNING a domain persistently and rebinding it after
 * every renderer swap.
 *
 * This module does not, on purpose, and the reason is that it never HOLDS
 * the domain in the first place: {@link queryAccessibilityTree} enables
 * `Accessibility`, sends exactly one `Accessibility.queryAXTree`, and
 * disables it again, all before returning, on the SAME session id its
 * caller resolved for THIS call. There is no state that outlives the
 * call, so there is nothing to rebind: a navigation that lands between two
 * separate calls simply means the next call resolves a fresh session (the
 * same `ensureAttached()` seam `packages/server/src/session/managed-session.ts`
 * already re-resolves for every `evaluate()`/`getResponseBody()` call,
 * never cached across them) and enables `Accessibility` on THAT one. A
 * navigation landing MID-call fails the in-flight `queryAXTree` the same
 * way any other CDP command fails mid-navigation (a detached-session
 * `CdpError`), which propagates to the caller exactly like an `evaluate()`
 * failure does; there is no special rebind path to get wrong because there
 * is no persisted enable to leave stale.
 *
 * `Accessibility.disable` runs in a `finally`, best-effort
 * (`.catch(() => {})`, mirroring `TargetDiagnostics.stop`'s own disable
 * loop): the session may already be gone by the time it runs, and a
 * disable that never reaches a dead browser leaves nothing to clean up on
 * this end either way.
 *
 * ── `DOM.*`, and why it is NOT bracketed with an enable/disable ─────────
 *
 * {@link stampAccessibilityNodes} sends `DOM.pushNodesByBackendIdsToFrontend`
 * and `DOM.setAttributeValue` with no `DOM.enable` around them. This is not
 * an oversight parallel to the `Accessibility` reasoning above; it is a
 * DIFFERENT, measured finding this codebase already recorded once:
 * `packages/core/src/cdp/hit-test.ts`'s own module doc says plainly that
 * `DOM.getNodeForLocation` "enables the DOM agent by itself (measured: it
 * answers with no `DOM.getDocument` ahead of it)". `DOM.*` node-id
 * commands are not gated behind an explicit `enable` the way `Runtime`,
 * `Log`, `Network` and `Accessibility` are; that file already uses `DOM.*`
 * commands in production with no enable/disable bracket anywhere in this
 * codebase. Following that precedent here means one fewer domain to own
 * and rebind, not a second one added on top of `Accessibility`.
 *
 * ── Never a live object handle ────────────────────────────────────────
 *
 * The obvious way to turn a `backendDOMNodeId` into something addressable
 * is `DOM.resolveNode`, which returns a `Runtime.RemoteObject` with an
 * `objectId`: a live handle, and exactly what `packages/core/src/cdp/evaluate.ts`'s
 * module doc calls "the escalation this module exists to not hand out".
 * This module never calls it. `stampAccessibilityNodes` instead writes a
 * plain DOM attribute directly, through `DOM.setAttributeValue` against a
 * `nodeId` `DOM.pushNodesByBackendIdsToFrontend` hands back: a mutation to
 * an element Chrome already tracks, not a JavaScript reference to it. No
 * `objectId` is ever created by this module, so there is nothing here for
 * a later change to accidentally start leaking.
 *
 * ── `fullAccessibilityTree`: the same parsing, a different question ─────
 *
 * {@link queryAccessibilityTree} answers "which nodes match this role and
 * name filter", and on the way there it drops every `ignored` node (that
 * pairing of question and behaviour is right for `page.a11y.get` and the
 * locator engine's `role=` selector, its only two callers). The page map
 * (`packages/core/src/pagemap/ax-merge.ts`) asks a different question,
 * "everything, for this one frame", and it needs `ignored` nodes KEPT: an
 * ignored AX node is exactly what tells an agent an element is hidden from
 * a screen reader, which is data a page map wants to carry forward as
 * `PageMapNodeRecord.axIgnored` rather than silently discard.
 *
 * That is a different filter, not a different parser, so
 * {@link fullAccessibilityTree} sends `Accessibility.getFullAXTree`
 * instead of `Accessibility.queryAXTree` and reuses {@link shapeNode} (and
 * everything it calls) unchanged: the tristate `checked`/`pressed`
 * handling, the absent-vs-false distinction on every other property, and
 * the "no `backendDOMNodeId` means unaddressable, drop it" rule all apply
 * exactly as they do above. Same enable/disable-within-one-call posture
 * too, for the identical reason: no session-scoped state outlives a call,
 * so a navigation between two frame reads needs no rebind.
 *
 * `Accessibility.getFullAXTree` has a `TIMEOUT_TABLE` entry in
 * `packages/core/src/cdp/timeouts.ts` at {@link FULL_AX_TREE_TIMEOUT_MS},
 * and this module also passes {@link FULL_AX_TREE_TIMEOUT_MS} as an
 * explicit `SendOptions.timeoutMs` override, the same pattern
 * `evaluate.ts`'s own `req.timeoutMs` uses.
 */

import type { CdpBridge } from './bridge.js';
import type { CdpSessionId } from './types.js';

/** One accessibility node, already shaped for `@browserglass/protocol`'s `A11yNode`; see that type's own doc for what each field means to a caller. */
export interface AxTreeNode {
  role: string;
  name: string;
  backendNodeId: number;
  ignored: boolean;
  focusable: boolean | null;
  /**
   * CDP reports `editable` on a node whose content a user can type into,
   * which is not the same question as `focusable`: a `contenteditable`
   * div is editable, and a disabled input is focusable in some browsers
   * while not being editable at all.
   */
  editable: boolean | null;
  /**
   * CDP reports `settable` on a node whose value a user can change
   * without typing, which is how a range slider and a colour picker
   * announce themselves. Neither carries a click listener and neither is
   * in any tag allowlist, so without this property the interactivity
   * cascade cannot see them.
   */
  settable: boolean | null;
  disabled: boolean | null;
  hidden: boolean | null;
  expanded: boolean | null;
  checked: boolean | 'mixed' | null;
  pressed: boolean | 'mixed' | null;
  selected: boolean | null;
  required: boolean | null;
  readonly: boolean | null;
  invalid: boolean | string | null;
  level: number | null;
}

/** What {@link queryAccessibilityTree} was asked for. */
export interface AxQueryRequest {
  /** Exact match against Chrome's own computed role. Omit for every role. */
  readonly role?: string;
  /** Match against Chrome's own computed accessible name, exact after trimming and collapsing whitespace on both sides (see {@link normalizeAxName}). Omit for every name. */
  readonly name?: string;
  /** Cap on returned nodes, applied after {@link maxResultBytes}; see {@link AxQueryOutcome.truncated}. */
  readonly maxNodes: number;
  /** Byte ceiling on the JSON-encoded node array; nodes are dropped from the tail, never from the middle, until the remainder fits. */
  readonly maxResultBytes: number;
}

/** What {@link queryAccessibilityTree} found. */
export interface AxQueryOutcome {
  readonly nodes: AxTreeNode[];
  /** How many non-ignored nodes matched before either bound in {@link AxQueryRequest} was applied. */
  readonly total: number;
  /** True when either bound cut the reply short. */
  readonly truncated: boolean;
}

/** The subset of a raw CDP `AXValue` this module reads: `{type, value}`, where `value` carries the actual payload for the property/role/name in question. */
interface RawAxValue {
  value?: unknown;
}

/** The subset of a raw CDP `AXNode` this module reads. */
interface RawAxNode {
  ignored?: boolean;
  role?: RawAxValue;
  name?: RawAxValue;
  backendDOMNodeId?: number;
  properties?: Array<{ name?: string; value?: RawAxValue }>;
}

/** Reads one named AX property's value off a node's `properties` array, or `undefined` if the node carries no such property at all (which {@link AxTreeNode} reports as `null`, distinct from Chrome asserting a false/empty value). */
function axProp(node: RawAxNode, name: string): unknown {
  const found = node.properties?.find((p) => p.name === name);
  return found?.value?.value;
}

function boolProp(node: RawAxNode, name: string): boolean | null {
  const v = axProp(node, name);
  return typeof v === 'boolean' ? v : null;
}

/** `checked`/`pressed`: CDP's own tristate, `true | false | 'mixed'`, passed through rather than collapsed. */
function triProp(node: RawAxNode, name: string): boolean | 'mixed' | null {
  const v = axProp(node, name);
  if (typeof v === 'boolean') return v;
  if (v === 'mixed' || v === 'true' || v === 'false') return v === 'mixed' ? 'mixed' : v === 'true';
  return null;
}

/** `invalid`: a boolean OR a reason string (`'spelling'`, `'grammar'`), CDP's own value. */
function invalidProp(node: RawAxNode): boolean | string | null {
  const v = axProp(node, 'invalid');
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  return null;
}

function numberProp(node: RawAxNode, name: string): number | null {
  const v = axProp(node, name);
  return typeof v === 'number' ? v : null;
}

/** Maps one raw CDP `AXNode` to the shaped {@link AxTreeNode} this module hands its caller. */
function shapeNode(raw: RawAxNode): AxTreeNode | null {
  const backendNodeId = raw.backendDOMNodeId;
  if (typeof backendNodeId !== 'number') return null; // a node with no backing DOM element (rare: some virtual AX nodes) is not addressable by either caller, so it is not reportable here.
  const role = typeof raw.role?.value === 'string' ? raw.role.value : '';
  const name = typeof raw.name?.value === 'string' ? raw.name.value : '';
  return {
    role,
    name,
    backendNodeId,
    ignored: raw.ignored === true,
    focusable: boolProp(raw, 'focusable'),
    editable: boolProp(raw, 'editable'),
    settable: boolProp(raw, 'settable'),
    disabled: boolProp(raw, 'disabled'),
    hidden: boolProp(raw, 'hidden'),
    expanded: boolProp(raw, 'expanded'),
    checked: triProp(raw, 'checked'),
    pressed: triProp(raw, 'pressed'),
    selected: boolProp(raw, 'selected'),
    required: boolProp(raw, 'required'),
    readonly: boolProp(raw, 'readonly'),
    invalid: invalidProp(raw),
    level: numberProp(raw, 'level'),
  };
}

/** UTF-8 byte length, mirroring `packages/core/src/cdp/evaluate.ts`'s own `utf8ByteLength` (duplicated rather than shared: that module is not exported for reuse, and the two have no other reason to depend on each other). */
/**
 * Trims and collapses every run of whitespace to one space, the same
 * normalisation Playwright applies to accessible names before comparing
 * them. Applied to both the requested name and Chrome's computed one.
 */
export function normalizeAxName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Chrome's answer when a `nodeId` or `backendNodeId` no longer names a node in the current document. */
function isStaleNodeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Could not find node with given id|No node with given id|No node found/i.test(message);
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Runs `Accessibility.queryAXTree` on `sessionId`, bracketed by
 * `Accessibility.enable`/`disable` within this one call (see this module's
 * doc, "domain ownership"). Filters out every `ignored` node (an ignored
 * AX node is excluded from what a screen reader announces, and is never
 * something either caller of this function should be able to treat as an
 * accessible element), then bounds the remainder first by
 * {@link AxQueryRequest.maxNodes}, then by the JSON byte size of what
 * remains, dropping trailing nodes until it fits
 * {@link AxQueryRequest.maxResultBytes}. Either bound sets
 * {@link AxQueryOutcome.truncated}.
 *
 * `nodeId` is ALWAYS sent, even for an unfiltered whole-page query. The
 * CDP spec's own parameter table marks `nodeId`/`backendNodeId`/`objectId`
 * as all optional, and that is what the module doc above assumed when it
 * argued `queryAXTree` needs no starting node the way `getPartialAXTree`
 * does; measured directly against real Chrome, calling it with none of the
 * three throws `"Either nodeId, backendNodeId or objectId must be
 * specified"`. So a cheap `DOM.getDocument({depth: 0})` runs first, purely
 * to learn the document's own `nodeId`, and that is what "unfiltered"
 * actually means here: the ROOT node, not a filtered node. This costs one
 * extra CDP round trip per call, not a walk of the tree (`depth: 0`
 * returns just the root node itself, no children), and it does not change
 * the "why `queryAXTree`" argument at all: the FILTER (`role`/`accessibleName`)
 * is still what narrows the search from that root, exactly as documented.
 */
export async function queryAccessibilityTree(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  req: AxQueryRequest,
): Promise<AxQueryOutcome> {
  await bridge.send('Accessibility.enable', undefined, sessionId);
  try {
    // The root is addressed by `backendNodeId` when Chrome reports one. A
    // `nodeId` is only valid until the document is replaced or anything
    // else on the session calls `DOM.getDocument` again, and right after a
    // navigation that window is real: a live `role=searchbox` on Wikipedia
    // failed with "Could not find node with given id" this way. A
    // `backendNodeId` does not have that lifetime problem. One retry still
    // covers the case where the document itself was swapped between the
    // two calls.
    const queryOnce = async (): Promise<{ nodes?: RawAxNode[] }> => {
      const doc = (await bridge.send('DOM.getDocument', { depth: 0 }, sessionId)) as {
        root?: { nodeId?: number; backendNodeId?: number };
      };
      const params: Record<string, unknown> = {};
      if (typeof doc.root?.backendNodeId === 'number')
        params['backendNodeId'] = doc.root.backendNodeId;
      else if (typeof doc.root?.nodeId === 'number') params['nodeId'] = doc.root.nodeId;
      if (req.role !== undefined) params['role'] = req.role;
      // No `accessibleName` here: Chrome matches it byte for byte, and the
      // names it computes keep stray whitespace (the-internet's Login button
      // is " Login", from an icon element and a space before the word). The
      // name is matched below instead, whitespace normalised on both sides.
      return (await bridge.send('Accessibility.queryAXTree', params, sessionId)) as {
        nodes?: RawAxNode[];
      };
    };
    let raw: { nodes?: RawAxNode[] };
    try {
      raw = await queryOnce();
    } catch (err) {
      if (!isStaleNodeError(err)) throw err;
      raw = await queryOnce();
    }
    const wantName = req.name !== undefined ? normalizeAxName(req.name) : undefined;
    const shaped: AxTreeNode[] = [];
    for (const n of raw.nodes ?? []) {
      if (n.ignored === true) continue;
      const node = shapeNode(n);
      if (node === null) continue;
      if (wantName !== undefined && normalizeAxName(node.name) !== wantName) continue;
      shaped.push(node);
    }
    const total = shaped.length;

    let kept = shaped.slice(0, Math.max(0, req.maxNodes));
    let truncated = kept.length < total;

    // Byte bound, mirroring `evaluate.ts`'s own precedent: drop from the
    // tail, never truncate a node's OWN fields, so every node that survives
    // is exactly correct rather than a partially-cut record.
    while (kept.length > 0 && utf8ByteLength(JSON.stringify(kept)) > req.maxResultBytes) {
      kept = kept.slice(0, -1);
      truncated = true;
    }

    return { nodes: kept, total, truncated };
  } finally {
    await bridge.send('Accessibility.disable', undefined, sessionId).catch(() => {
      // See this module's doc: the session may already be gone, and a
      // disable that never reaches a dead browser leaves nothing to clean
      // up either way.
    });
  }
}

/**
 * The `SendOptions.timeoutMs` override {@link fullAccessibilityTree} passes
 * on every `Accessibility.getFullAXTree` call. See this module's own doc,
 * "`fullAccessibilityTree`: the same parsing, a different question". The
 * same value sits in `packages/core/src/cdp/timeouts.ts`'s `TIMEOUT_TABLE`,
 * alongside the `Accessibility.queryAXTree` entry at 30000.
 */
export const FULL_AX_TREE_TIMEOUT_MS = 20000;

/**
 * Runs `Accessibility.getFullAXTree` on `sessionId`, scoped to `frameId`
 * when given (omitted for the session's own root frame), bracketed by
 * `Accessibility.enable`/`disable` within this one call exactly as
 * {@link queryAccessibilityTree} is. Unlike that function, this one keeps
 * every `ignored` node rather than dropping it: see this module's own doc
 * for why the page map wants that data kept, not discarded.
 *
 * No `DOM.getDocument` call precedes this one. That call exists in
 * {@link queryAccessibilityTree} only because `Accessibility.queryAXTree`
 * was measured to refuse a request naming none of `nodeId`,
 * `backendNodeId` or `objectId`; `Accessibility.getFullAXTree` carries no
 * such requirement; its own `frameId` parameter is what scopes the walk,
 * and omitting it walks the session's own root frame by CDP's documented
 * default.
 *
 * Returns every addressable node found (nodes with no `backendDOMNodeId`
 * are dropped by {@link shapeNode}, same rule as above), unbounded: this
 * module applies no `maxNodes`/`maxResultBytes` cap here, because the page
 * map's own budget pass (`packages/core/src/pagemap/budget.ts`) is what
 * decides what survives, over the WHOLE merged node record rather than
 * over an accessibility node in isolation.
 */
export async function fullAccessibilityTree(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  frameId?: string,
): Promise<AxTreeNode[]> {
  await bridge.send('Accessibility.enable', undefined, sessionId);
  try {
    const params: Record<string, unknown> = {};
    if (frameId !== undefined) params['frameId'] = frameId;
    const raw = (await bridge.send('Accessibility.getFullAXTree', params, sessionId, {
      timeoutMs: FULL_AX_TREE_TIMEOUT_MS,
    })) as { nodes?: RawAxNode[] };
    const shaped: AxTreeNode[] = [];
    for (const n of raw.nodes ?? []) {
      const node = shapeNode(n);
      if (node !== null) shaped.push(node); // ignored nodes are kept here; only an unaddressable node (no backendDOMNodeId) is dropped.
    }
    return shaped;
  } finally {
    await bridge.send('Accessibility.disable', undefined, sessionId).catch(() => {
      // Same tolerance as queryAccessibilityTree's own disable: the
      // session may already be gone, and a disable that never reaches a
      // dead browser leaves nothing to clean up either way.
    });
  }
}

/**
 * A fresh, per-request DOM attribute name for {@link stampAccessibilityNodes}
 * to write, and for a caller to build a `css=[<marker>]` selector from
 * afterward. Random rather than content-addressed, for the same reason
 * `packages/automation/src/locator/engine.ts`'s own `mintRefPrefix` is: it
 * only has to be unique enough that two concurrent stamps on the same page
 * do not collide, never a secret, so `Math.random()` is the right tool and
 * not a cut corner.
 */
export function mintAxMarkerAttr(): string {
  return `data-bgls-ax-${Math.random().toString(36).slice(2, 10)}`;
}

/** One {@link stampAccessibilityNodes} outcome, parallel to its `backendNodeIds` input. */
export interface AxStampOutcome {
  /** `true` at index `i` when `backendNodeIds[i]` actually received the attribute write. */
  readonly stamped: readonly boolean[];
}

/**
 * Writes `attrName="1"` onto every DOM element named by `backendNodeIds`,
 * through `DOM.pushNodesByBackendIdsToFrontend` then one
 * `DOM.setAttributeValue` per resolved node, addressed by `nodeId` rather
 * than by any live object handle (see this module's doc, "never a live
 * object handle"). A `backendNodeId` that no longer resolves (the element
 * detached between the query and this call) is reported as `false` at its
 * index rather than failing the whole batch: a caller acting on N matched
 * elements is better served by "N minus one landed" than by losing every
 * one of them because one went stale.
 */
export async function stampAccessibilityNodes(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  backendNodeIds: readonly number[],
  attrName: string,
): Promise<AxStampOutcome> {
  if (backendNodeIds.length === 0) return { stamped: [] };

  let nodeIds: Array<number | undefined>;
  try {
    const pushed = (await bridge.send(
      'DOM.pushNodesByBackendIdsToFrontend',
      { backendNodeIds },
      sessionId,
    )) as { nodeIds?: number[] };
    nodeIds = pushed.nodeIds ?? [];
  } catch {
    // The whole batch failed to resolve (a detached document, a dead
    // session between the AX query and this call): every index is
    // honestly reported as not stamped rather than guessed at.
    return { stamped: backendNodeIds.map(() => false) };
  }

  const stamped = await Promise.all(
    backendNodeIds.map(async (_backendNodeId, i) => {
      const nodeId = nodeIds[i];
      // `0` is CDP's own "could not resolve this one" answer within an
      // otherwise-successful batch; `undefined` covers a reply shorter than
      // the request, which should not happen but is not trusted to.
      if (typeof nodeId !== 'number' || nodeId === 0) return false;
      try {
        await bridge.send(
          'DOM.setAttributeValue',
          { nodeId, name: attrName, value: '1' },
          sessionId,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );

  return { stamped };
}
