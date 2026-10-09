/**
 * `pagemap/dom-tree.ts`: sends `DOM.getDocument({depth: -1, pierce: true})`
 * and walks the reply into a flat, parent-linked index keyed by
 * `backendNodeId`. Phase A; this file owns exactly one of the three phase A
 * commands (`DOMSnapshot.captureSnapshot` is `snapshot.ts`,
 * `Page.getFrameTree` is `frames.ts`, neither imported from here: see "One
 * call, one session" below).
 *
 * ── One call, one session, no frame-crossing ─────────────────────────────
 *
 * This module walks exactly the ONE reply from ONE `DOM.getDocument` call
 * on ONE CDP session. It does not know about `TargetRegistry`, does not
 * know how many frames a page has, and does not decide which session to
 * call on: `capture.ts` calls
 * {@link buildDomTree} once per session it needs a tree from, once for the
 * main session and once more for every out-of-process iframe session
 * `frames.ts` names. `packages/core/src/pagemap/text.ts`, a sibling module
 * that reads this shape, states the contract precisely in its own doc:
 * "`backendNodeId` spaces do not cross frame/session boundaries", so every
 * document root this walk produces (the call's own top root AND every
 * same-process `contentDocument` root reached while piercing) gets `parentBackendNodeId: null`, never linked
 * to the `<iframe>` element that owns it. `text.ts`'s own walk finds every
 * root by scanning for `parentBackendNodeId === null` rather than assuming
 * there is exactly one, and this module is what makes that assumption
 * true, for a same-process nested document exactly as much as for the
 * call's own top document.
 *
 * ── Degradation is the caller's decision, not this module's ──────────────
 *
 * A `DOM.getDocument` failure on the MAIN session is fatal to the whole capture, but a per-frame failure
 * (an out-of-process iframe session that dies mid-capture) only degrades
 * that one frame. This module cannot tell those two cases apart: it only
 * ever sees the one session it was asked to call. So it does neither
 * itself. A failed `DOM.getDocument` call propagates as the `CdpError` it
 * already is, and `capture.ts` decides fatal-vs-degrade from which session
 * it called this on, the same way `ax-merge.ts` already decides
 * per-frame-degrade for `Accessibility.getFullAXTree` failures one level
 * up from a single CDP call.
 *
 * ── Piercing: `shadowRoots` and `contentDocument`, one iterative walk ────
 *
 * `pierce: true` returns two things a non-piercing call does not: a
 * `shadowRoots` array on a shadow host, and a `contentDocument` node on a
 * same-process `<iframe>`/`<frame>` element (an out-of-process one has
 * neither: its content lives in a different renderer entirely, which is
 * exactly why `frames.ts` exists to name that session separately). Both
 * are walked here, alongside the ordinary `children` array, from one
 * explicit stack rather than recursion: a pathological page nesting shadow
 * roots hundreds of levels deep would risk this walk's OWN call stack
 * before it risks anything CDP-side, and an iterative worklist has no such
 * limit. Children are pushed in REVERSE array order so the stack (LIFO)
 * pops them back out in original left-to-right order; `text.ts`'s own
 * module doc depends on `nodes` being built in document order ("`ReadonlyMap`
 * iterates in insertion order and the tree walk that built it visits nodes
 * depth-first"), so this is not cosmetic, it is what keeps that assumption
 * true. `shadowRoots` and `contentDocument` are pushed onto the same
 * stack behind a node's own `children`, so a host's own light-DOM children
 * are visited before its shadow content or, for a frame owner, before its
 * nested document: document order for ordinary elements is exact, while
 * where shadow/frame content interleaves relative to sibling subtrees is
 * not a claim this module makes (there is no single "correct" document
 * order across a shadow boundary or a frame boundary to begin with).
 *
 * `shadowKind` (`PageMapNodeRecord.shadowKind`'s own doc: "Set when this
 * node is a shadow host") is recorded on the HOST element, read off the
 * shadow root node's own `shadowRootType`. CDP's `shadowRootType` can also
 * be `'user-agent'` (a browser-internal root, e.g. the one Chrome puts on
 * `<input type=range>`'s thumb/track or `<input type=date>`'s spinner):
 * this walk still descends into it exactly like an `'open'`/`'closed'` root
 * (an agent can still act on what is inside), and records `shadowKind:
 * 'user-agent'` on the host, distinct from `null` (no shadow root at all).
 * This was reported at first landing as a gap (`types.ts`'s
 * {@link PageMapShadowKind} had only two named members) and is now closed:
 * see that type's own doc for the third member.
 *
 * `interactivity.ts` gets no special treatment for a node reached only
 * through a user-agent root: it runs the exact same cascade over it as any
 * other node, no ancestry check for "is this inside a UA shadow root" is
 * added. Two reasons. First, the HOST of a user-agent root is always one
 * of a small, fixed set of native form-control elements
 * (`INTERACTIVE_TAGS` already includes every one this codebase has
 * observed getting one: `input`), so an agent acting on the host is never
 * blocked by anything this decision changes. Second, this module has no
 * measured basis for assuming a UA-internal part (a range thumb, a date
 * spinner button) never carries its own genuine native semantics across
 * every Chrome build this design targets; suppressing UA-shadow
 * descendants from candidacy on that unverified assumption would be
 * exactly the kind of unmeasured guess this module avoids. If UA-shadow descendants prove noisy in practice (a second,
 * redundant candidate for one control), gating them by `shadowKind`
 * ancestry is the natural follow-up; UNMEASURED and not implemented
 * speculatively here.
 *
 * ── Frame identity: ambient, not read per node ────────────────────────────
 *
 * `frameId` (`PageMapNodeRecord.frameId`'s own doc: "Null for the top
 * document") is threaded through the walk as ambient state rather than
 * read off every node, because CDP does not set it on every node: measured
 * precedent in this codebase (`packages/core/src/cdp/hit-test.ts:329`)
 * reads it off the `<html>` element specifically, and CDP's own frame-owner
 * convention puts it on the OWNER element too, naming the CHILD frame it
 * owns, not the frame the owner itself sits in. So: the call's own root
 * starts with `frameId: null` (the "null for the top document" rule,
 * applied literally at the call's own root, which is also correct for a
 * per-frame `buildDomTree` call made directly on an out-of-process
 * session: from THAT session's own point of view its document IS the top
 * of what it can see, and `capture.ts` already knows which physical frame
 * a given call's `null` really names, because it is the one that chose
 * which session to call this on). Descending through an `<iframe>`
 * element's `contentDocument` switches the ambient value to that
 * element's own `frameId` field for everything under it; descending
 * through `shadowRoots` or ordinary `children` never changes it.
 *
 * COMPLEXITY: one iterative pass over the reply, O(n) in the number of
 * nodes CDP returns (each node is pushed onto the work stack exactly once
 * and popped exactly once), O(n) auxiliary space for the index and the
 * stack. No node is visited twice.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId } from '../cdp/types.js';
import type { PageMapShadowKind } from './types.js';

/**
 * The DOM-sourced subset of `PageMapNodeRecord` (`./types.ts`) this module
 * can fill in on its own. `capture.ts` merges this with the snapshot,
 * accessibility and listener sources for the rest (`rect`, `scrollRect`,
 * `paintOrder`, `style`, `role`, `name`, `axIgnored`, `axProperties`,
 * `hasClickListener`).
 */
export interface DomTreeNode {
  readonly backendNodeId: number;
  /** `null` at every document root this walk produces, not only the call's own top root. See this module's own doc, "One call, one session, no frame-crossing". */
  readonly parentBackendNodeId: number | null;
  /** Lowercased tag name. `#document`, `#document-fragment` and `#text` appear here too, exactly as CDP's own `nodeName` spells them. */
  readonly tag: string;
  readonly nodeType: number;
  readonly attributes: ReadonlyMap<string, string>;
  readonly shadowKind: PageMapShadowKind;
  readonly frameId: string | null;
  /**
   * A `#text` node's own character data; `null` for every other node kind.
   * `PageMapNodeRecord.nodeValue`'s own doc names `DOM.getDocument`'s
   * `nodeValue` field as its source, "which the tree walk already
   * receives": this is that field, carried through unmodified rather
   * than discarded, the gap `text.ts`'s own module doc reported before
   * this field existed on the shared record at all.
   */
  readonly nodeValue: string | null;
}

/** What {@link buildDomTree} returns. */
export interface DomTreeResult {
  readonly nodes: ReadonlyMap<number, DomTreeNode>;
  /** `backendNodeId` of the call's own top root (its `#document` node). Always present, even though `nodes.get(rootBackendNodeId)!.parentBackendNodeId` is `null` like every other root this walk finds. */
  readonly rootBackendNodeId: number;
}

const TEXT_NODE = 3;

/** Raw shape of one `DOM.getDocument({depth: -1, pierce: true})` node. Every field this module reads; CDP sends more (`documentURL`, `baseURL`, ...) that no field on {@link DomTreeNode} needs yet. */
interface RawDomNode {
  readonly backendNodeId: number;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly localName?: string;
  readonly nodeValue?: string;
  readonly attributes?: readonly string[];
  readonly frameId?: string;
  readonly shadowRootType?: string;
  readonly contentDocument?: RawDomNode;
  readonly shadowRoots?: readonly RawDomNode[];
  readonly children?: readonly RawDomNode[];
}

/** `node.nodeValue` for a `#text` node, `null` for everything else. CDP sends `nodeValue` as `''` (not absent) for every non-text node too, so the node TYPE decides this, not whether the field is present. */
function nodeValueOf(node: RawDomNode): string | null {
  return node.nodeType === TEXT_NODE ? (node.nodeValue ?? '') : null;
}

/** Flat `[name, value, name, value, ...]` -> a map, CDP's own encoding for element attributes. Absent (comment, text, document nodes never carry it) reads as empty, not missing. */
function attributesOf(node: RawDomNode): ReadonlyMap<string, string> {
  const raw = node.attributes;
  if (raw === undefined || raw.length === 0) return new Map();
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    out.set(raw[i] as string, raw[i + 1] as string);
  }
  return out;
}

/** `localName` is CDP's already-lowercase tag for an element; every other node kind (`#document`, `#text`, ...) has no `localName` and `nodeName` is used as-is, matching `PageMapNodeRecord.tag`'s own doc: "`#document` and `#text` appear here too." */
function tagOf(node: RawDomNode): string {
  const name =
    node.localName !== undefined && node.localName.length > 0 ? node.localName : node.nodeName;
  return name.toLowerCase();
}

/** `'open'`, `'closed'` and `'user-agent'` pass through; anything else (an absent field, or a value this build has never observed) reads as `null`. See this module's own doc, and `types.ts`'s {@link PageMapShadowKind} doc, for why `'user-agent'` is a distinct value from `null` rather than folded into it. */
function shadowKindOf(shadowRoot: RawDomNode): PageMapShadowKind {
  return shadowRoot.shadowRootType === 'open' ||
    shadowRoot.shadowRootType === 'closed' ||
    shadowRoot.shadowRootType === 'user-agent'
    ? shadowRoot.shadowRootType
    : null;
}

/** One pending stack entry: a raw node still to be recorded, the parent id its own record should carry, and the frame id ambient at this point in the walk. */
interface WorkItem {
  readonly node: RawDomNode;
  readonly parentBackendNodeId: number | null;
  readonly frameId: string | null;
}

/**
 * Sends `DOM.getDocument({depth: -1, pierce: true})` on `sessionId` and
 * walks the reply into a flat, parent-linked index. See this module's own
 * doc for the "one call, one session" scope, why every document root gets
 * `parentBackendNodeId: null`, and why frame identity is threaded
 * ambiently rather than read per node.
 *
 * `timeoutMs` is a REQUIRED, explicit parameter rather than left to
 * `TIMEOUT_TABLE`, deliberately: `DOM.getDocument` must never gain a table
 * entry there, because that table is shared with `hit-test.ts`'s
 * `depth: 1` call and `accessibility.ts`'s `depth: 0` call, both of which
 * should answer in milliseconds; an entry sized for THIS call's full-depth
 * piercing walk would hand those two calls a budget many times too
 * generous. Passing the override explicitly, the way `evaluate.ts:360`
 * already does for its own per-call timeout, is what keeps this call's
 * cost out of that shared table entirely.
 */
export async function buildDomTree(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  timeoutMs: number,
): Promise<DomTreeResult> {
  const raw = (await bridge.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId, {
    timeoutMs,
  })) as { root?: RawDomNode };
  const root = raw.root;
  if (root === undefined) {
    throw new Error('DOM.getDocument returned no root node');
  }

  const nodes = new Map<number, DomTreeNode>();
  const stack: WorkItem[] = [{ node: root, parentBackendNodeId: null, frameId: null }];

  while (stack.length > 0) {
    // `as WorkItem`: the `stack.length > 0` guard above already proves this
    // `pop()` cannot return `undefined`; TypeScript's array typings do not
    // encode that themselves.
    const item = stack.pop() as WorkItem;
    const node = item.node;

    nodes.set(node.backendNodeId, {
      backendNodeId: node.backendNodeId,
      parentBackendNodeId: item.parentBackendNodeId,
      tag: tagOf(node),
      nodeType: node.nodeType,
      attributes: attributesOf(node),
      shadowKind: null,
      frameId: item.frameId,
      nodeValue: nodeValueOf(node),
    });

    // Pushed BEFORE `children` (see this module's own doc on push order):
    // popped after every ordinary child of this node, so a host's own
    // light-DOM children read out in document order ahead of its shadow
    // content or nested document.
    if (node.contentDocument !== undefined) {
      // The CHILD frame's own id, per CDP's frame-owner convention: this
      // field on the OWNER element names the frame it owns, not the frame
      // the owner itself lives in (that stays `item.frameId`, already
      // recorded on the owner's own entry above).
      const childFrameId = node.frameId ?? null;
      stack.push({ node: node.contentDocument, parentBackendNodeId: null, frameId: childFrameId });
    }

    if (node.shadowRoots !== undefined && node.shadowRoots.length > 0) {
      // A host carries at most one shadow root in every Chrome build this
      // design targets, but the array shape is CDP's, not an invariant
      // this walk enforces: if a build ever returned more than one, the
      // LAST one recorded here wins the host's `shadowKind`, matching
      // ordinary "last write wins" rather than silently picking the first.
      for (let i = node.shadowRoots.length - 1; i >= 0; i -= 1) {
        const shadowRoot = node.shadowRoots[i] as RawDomNode;
        const host = nodes.get(node.backendNodeId);
        if (host !== undefined) {
          nodes.set(node.backendNodeId, { ...host, shadowKind: shadowKindOf(shadowRoot) });
        }
        stack.push({
          node: shadowRoot,
          parentBackendNodeId: node.backendNodeId,
          frameId: item.frameId,
        });
      }
    }

    if (node.children !== undefined) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i] as RawDomNode;
        stack.push({ node: child, parentBackendNodeId: node.backendNodeId, frameId: item.frameId });
      }
    }
  }

  return { nodes, rootBackendNodeId: root.backendNodeId };
}
