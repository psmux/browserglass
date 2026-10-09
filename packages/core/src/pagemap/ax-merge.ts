/**
 * Joins per-frame `Accessibility.getFullAXTree` reads onto the merged node
 * index, filling `role`, `name`, `axIgnored` and `axProperties` on
 * {@link PageMapNodeRecord}. Phase B: per-frame accessibility, concurrency
 * capped at 4.
 *
 * ── Why a cap, and why 4 ──────────────────────────────────────────────────
 *
 * `CdpBridge` multiplexes ONE WebSocket per `Instance`
 * (`packages/core/src/cdp/bridge.ts:466`), and on a live target that same
 * socket is simultaneously carrying `Page.screencastFrame` events for
 * every viewer watching this session. An unbounded fan-out of
 * `Accessibility.getFullAXTree` calls across a frame-heavy page (one call
 * per frame, all in flight at once) competes for that socket's write
 * queue and the renderer's own CDP handling loop with video, which is a
 * user-visible stutter in the product's core feature, not an abstract
 * cost. browser-use's own code carries the matching finding for a
 * different call on the same class of problem: "Each describeNode call
 * can trigger target/session bookkeeping, so even a few dozen simultaneous
 * calls can starve screenshots and the other CDP requests needed to build
 * browser state" (`browser_use/dom/service.py:546`). {@link
 * PAGEMAP_AX_CONCURRENCY_CAP} is this module's answer to the identical
 * problem, not a different one: bound how many `Accessibility.getFullAXTree`
 * calls this module ever has in flight at once, so a page with fifty
 * frames still leaves room for screencast frames to get a turn.
 *
 * ── Degradation, not failure ──────────────────────────────────────────────
 *
 * A frame whose `Accessibility.getFullAXTree` read fails (timeout,
 * detached session, any other CDP-reported reason) does NOT fail this
 * function or the capture it is part of. It degrades: every node already
 * indexed for that frame keeps its tag, its rect and its attributes
 * (nothing here touches them) and simply never receives `role`/`name`/
 * `axIgnored`/`axProperties`, and one {@link PageMapPhaseFailure} with
 * `phase: 'accessibility'` and that frame's id is appended to the
 * returned list. A capture that silently returned no roles and no
 * failure entry would be a lie the caller has no way to detect, which is
 * exactly what `packages/protocol/src/wire/messages/pagemap.ts`'s
 * `PageMapDegradation` exists to make impossible: it is populated even
 * when the reply otherwise looks complete, the same rule
 * `packages/protocol/src/wire/messages/a11y.ts` already set for
 * truncation. browser-use's own policy degrades an AX failure to
 * `{'nodes': []}` (`browser_use/dom/service.py:637`); the node shape is
 * the same idea, reporting it honestly is what this module adds.
 *
 * ── The join: by `backendNodeId`, one map, no scans ───────────────────────
 *
 * The input node index and every per-frame AX node both carry
 * `backendNodeId` as their natural key, so the merge is: copy the input
 * map once (O(N) for N indexed nodes, references only, nothing deep
 * cloned), then for every AX node returned by every frame (A nodes total
 * across every frame in this capture), do one `Map.get` to find its
 * record and one `Map.set` to write the merged copy back, both O(1).
 * Total cost is O(N + A). Nothing here walks the node index per AX node,
 * and nothing walks the AX results per indexed node: nothing here is
 * O(N * A).
 */

import { type AxTreeNode, fullAccessibilityTree } from '../cdp/accessibility.js';
import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId } from '../cdp/types.js';
// `frames.ts` owns `Page.getFrameTree`, the out-of-process iframe session
// list read off `TargetRegistry`, and the coordinate offsetting for a child
// frame's rects. This module imports its output type rather than
// re-deriving a frame list of its own. The two fields this module actually
// reads off it are documented on {@link PageMapFrame}.
import type { PageMapFrame } from './frames.js';
import type { PageMapNodeRecord, PageMapPhaseFailure } from './types.js';

/**
 * How many `Accessibility.getFullAXTree` calls this module holds in
 * flight at once, across every frame in the capture. See this module's
 * own doc, "Why a cap, and why 4", for the full argument: it is not
 * caution for its own sake, it is a bound on how much this module can
 * ever compete with `Page.screencastFrame` traffic on the one socket
 * `CdpBridge` multiplexes per `Instance`.
 */
export const PAGEMAP_AX_CONCURRENCY_CAP = 4;

/**
 * Runs `fn` once per item in `items`, holding at most `limit` calls in
 * flight at any moment, and returns the results in the SAME order as
 * `items` regardless of which call finishes first (each worker below
 * claims the next unclaimed index and writes its result to that exact
 * slot, so completion order never reorders the output). A fixed-size pool
 * of `min(limit, items.length)` workers pulls from one shared cursor
 * rather than chunking `items` into `ceil(items.length / limit)` batches,
 * so one slow frame's accessibility read never blocks a fast frame behind
 * it in the same batch from starting.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

/**
 * Reshapes one {@link AxTreeNode}'s actionability properties into
 * {@link PageMapNodeRecord.axProperties}'s tristate map, unchanged from
 * how `accessibility.ts`'s own `shapeNode` already computed them:
 * `focusable`/`disabled`/`hidden`/`expanded`/`selected`/`required`/
 * `readonly` stay `boolean | null`, `checked`/`pressed` stay their CDP
 * tristate (`boolean | 'mixed' | null`) and `invalid` stays
 * `boolean | string | null`, all fitting {@link PageMapNodeRecord.axProperties}'s
 * `string | boolean | null` value type directly. `level` is CDP's one
 * NUMBER-valued property in this set (`AxTreeNode.level: number | null`);
 * it is stringified rather than dropped, because dropping it would lose
 * heading-level data the interactivity cascade has no other way to
 * recover, and `null` is preserved as `null` rather than `'null'` so
 * "property absent" still reads as absent, not as the string `"null"`.
 * Every key is always present in the returned map, with `null` as the
 * value when CDP reported no such property: this is what makes "absent"
 * and "present but false" distinguishable by VALUE
 * (`accessibility.ts`'s own `boolProp`/`triProp` doc states the same
 * rule for {@link AxTreeNode} itself), rather than by whether the key
 * exists in the map at all.
 */
function axPropertiesFor(node: AxTreeNode): ReadonlyMap<string, string | boolean | null> {
  return new Map<string, string | boolean | null>([
    ['focusable', node.focusable],
    // `editable` and `settable` were missing here in the first cut, and
    // `interactivity.ts` caught it: its cascade checks both as qualifiers,
    // so until they were populated a `contenteditable` div and a range
    // slider were both invisible to it. Neither carries a click listener
    // and neither is in the tag allowlist, so the AX tree is the only
    // place that answer comes from.
    ['editable', node.editable],
    ['settable', node.settable],
    ['disabled', node.disabled],
    ['hidden', node.hidden],
    ['expanded', node.expanded],
    ['checked', node.checked],
    ['pressed', node.pressed],
    ['selected', node.selected],
    ['required', node.required],
    ['readonly', node.readonly],
    ['invalid', node.invalid],
    ['level', node.level === null ? null : String(node.level)],
  ]);
}

/** What {@link mergeAccessibility} produces. */
export interface AxMergeOutcome {
  /**
   * The input node index, with `role`/`name`/`axIgnored`/`axProperties`
   * filled in on every record whose `backendNodeId` a successful frame
   * read named. A record from a frame whose read failed, or a record
   * whose id no AX node named at all, comes back byte-for-byte as it was
   * given: this function only ever ADDS the four accessibility fields, it
   * never removes or resets a record.
   */
  readonly nodes: ReadonlyMap<number, PageMapNodeRecord>;
  /** One entry per frame whose `Accessibility.getFullAXTree` read failed. Empty when every frame succeeded. */
  readonly failures: readonly PageMapPhaseFailure[];
}

/**
 * Fans out one `Accessibility.getFullAXTree` read per frame in `frames`
 * (concurrency capped at {@link PAGEMAP_AX_CONCURRENCY_CAP}; see this
 * module's own doc), then joins every returned AX node onto `nodes` by
 * `backendNodeId`. A frame's read failing degrades that frame rather than
 * rejecting this call; see this module's own doc, "Degradation, not
 * failure", and {@link AxMergeOutcome.failures}.
 *
 * An AX node whose `backendNodeId` is not present in `nodes` is silently
 * skipped (not an error): the accessibility tree and the DOM/snapshot
 * phases are two different CDP reads of a page that can be racing a
 * mutation between them, and a handful of virtual or newly-detached AX
 * nodes with no matching indexed record is an ordinary outcome, not a
 * bug in either side.
 *
 * `sessionOf`, optional, defaults to empty: `backendNodeId -> the CDP
 * session whose DOM tree first claimed it`, the SAME provenance map
 * `capture.ts`'s `collectExtraSessions` already builds to guard its own
 * DOM-tree/snapshot merge against a cross-session id collision (see that
 * module's own doc, "Cross-session `backendNodeId` collisions", and
 * `index-assign.ts` for what was established about CDP's actual
 * guarantee). This join is a SECOND place the same collision could bite:
 * if frame X's and frame Y's renderers independently minted the same
 * numeric id, and the DOM merge kept X's node under that id, an AX read
 * scoped to frame Y could still attach Y's role/name onto X's already-won
 * node with no check at all. When `sessionOf` names an owner for an
 * incoming AX node's id that is NOT the frame this read came from, that AX
 * node is dropped, silently from this function's own point of view, the
 * collision itself was already reported once, by the DOM/snapshot merge,
 * and reporting the identical conflict a second time here would
 * double-count it. An id `sessionOf` has no entry for (including every id,
 * always, when a caller passes no map at all) is unconstrained: this
 * function has no opinion on a provenance question its caller chose not to
 * answer, so every existing caller that predates this parameter keeps its
 * exact prior behavior.
 */
export async function mergeAccessibility(
  bridge: CdpBridge,
  frames: readonly PageMapFrame[],
  nodes: ReadonlyMap<number, PageMapNodeRecord>,
  sessionOf: ReadonlyMap<number, CdpSessionId> = new Map(),
): Promise<AxMergeOutcome> {
  const failures: PageMapPhaseFailure[] = [];

  const perFrameResults = await mapWithConcurrencyLimit(
    frames,
    PAGEMAP_AX_CONCURRENCY_CAP,
    async (frame) => {
      try {
        return await fullAccessibilityTree(bridge, frame.sessionId, frame.frameId);
      } catch (err) {
        failures.push({
          phase: 'accessibility',
          reason: err instanceof Error ? err.message : String(err),
          frameId: frame.frameId,
        });
        return null;
      }
    },
  );

  // O(N): one shallow copy of the input map. Everything after this is
  // O(1) per AX node (see this module's own doc, "The join").
  const merged = new Map(nodes);

  // Index-based, not `for...of` over `perFrameResults` alone: the
  // collision guard needs to know WHICH frame a given result array came
  // from, and `mapWithConcurrencyLimit`'s own doc guarantees
  // `perFrameResults[i]` corresponds to `frames[i]`.
  for (let i = 0; i < frames.length; i += 1) {
    const axNodes = perFrameResults[i];
    if (axNodes === null || axNodes === undefined) continue; // that frame's read failed; already recorded above.
    const frame = frames[i] as PageMapFrame;
    for (const axNode of axNodes) {
      const existing = merged.get(axNode.backendNodeId);
      if (existing === undefined) continue; // AX tree named a node the DOM/snapshot phases never indexed; nothing to attach it to.
      const owner = sessionOf.get(axNode.backendNodeId);
      if (owner !== undefined && owner !== frame.sessionId) continue; // cross-session collision guard; see this function's own doc.
      merged.set(axNode.backendNodeId, {
        ...existing,
        role: axNode.role,
        name: axNode.name,
        axIgnored: axNode.ignored,
        axProperties: axPropertiesFor(axNode),
      });
    }
  }

  return { nodes: merged, failures };
}
