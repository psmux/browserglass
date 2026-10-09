/**
 * Index identity and the document epoch. Read this whole doc before
 * changing anything here.
 *
 * ── The index itself needs no allocation ──────────────────────────────────
 *
 * browser-use's `_allocate_selector_index` (`dom/serializer/serializer.py:647`
 * through `:656`) returns the backend node id unless it is already taken, in
 * which case it allocates from a synthetic counter seeded above every
 * reserved id. That fallback exists because their pipeline REBUILDS a
 * compacted tree with its own index space every step, so two of their own
 * synthetic nodes could collide on a reused number.
 *
 * This design never builds a second index space. `PageMapCapture.nodes`
 * (`./types.ts`) is keyed by `backendNodeId` directly, and every join in
 * this pipeline (`snapshot.ts`, `dom-tree.ts`, `ax-merge.ts`) already merges
 * ON that key. A `Map` cannot hold two different values under one key by
 * construction, so within one capture there is no scenario where two
 * "logical" nodes compete for the same index: {@link pageMapIndexOf} is
 * therefore a documented identity function, not a placeholder for
 * allocation logic that belongs somewhere else. `@browserglass/protocol`'s
 * `wire/messages/pagemap.ts` module doc still names the synthetic-counter
 * fallback ("falling back to a synthetic id above every reserved backend id
 * on the rare collision, same as browser-use's `_allocate_selector_index`"),
 * carried over from the browser-use precedent it is comparing itself
 * against; REPORTED to the pagemap lead: that fallback describes a failure
 * mode this design's own architecture does not have, because it never
 * mints a second index space for the fallback to draw from. Nothing here
 * needs to change to close the gap; the wire doc's sentence is what would
 * need revisiting.
 *
 * A `backendNodeId` IS unique within the CDP session it was minted on, but
 * NOT across two different sessions, and this is now ESTABLISHED, not
 * assumed: Chromium's own `DOMNodeIds` implementation
 * (`third_party/blink/renderer/core/dom/dom_node_ids.cc`) backs every
 * `backendNodeId` with `g_last_id`, a single `static` counter at namespace
 * scope inside one renderer process, incrementing from zero (wrapping back
 * to zero at `DOMNodeId`'s max rather than continuing into a second
 * process-wide space). That is process-local by construction: two
 * different renderer processes each run their own copy of that counter,
 * starting from zero independently, so an out-of-process iframe's renderer
 * and the main frame's renderer WILL, in the ordinary case of two pages
 * with a similar-sized DOM, mint overlapping numeric ids for two entirely
 * different nodes, not merely in some pathological edge case. This was not
 * measured against a live Chrome in this environment (this repository's
 * own gateway cannot launch one under this path's depth,
 * `E_PROFILE_ROOT_TOO_LONG`); it is established by reading the counter's
 * own implementation, which is the authoritative source for what value it
 * produces.
 *
 * Once closing GAP 1 makes out-of-process iframe content actually reach
 * `PageMapCapture.nodes` (`capture.ts`'s own module doc, "Multi-session DOM
 * tree merge"), a cross-session collision stops being a latent, unexercised
 * risk and becomes routine: any page with one cross-origin iframe of
 * similar complexity to its main document is a live candidate. `capture.ts`
 * now GUARDS this rather than silently overwriting: its per-session merge
 * (`collectExtraSessions`) tracks which session's DOM tree first claimed
 * each `backendNodeId`, and a second session reporting the same id is
 * detected, dropped (first writer wins) and reported as one
 * `PageMapPhaseFailure` (`phase: 'domTree'`) naming both the id and the
 * losing frame, rather than conflating two different nodes under one
 * index. See `capture.ts`'s own doc, "Cross-session `backendNodeId`
 * collisions", for the exact mechanism. This module still mints no
 * synthetic index space of its own ({@link pageMapIndexOf} stays the
 * identity function below), because the guard's job is to detect and
 * refuse a collision, not to renumber around one; renumbering would need
 * exactly the second index space this file's own doc argues is
 * unnecessary, and would also break the "the index IS the `backendNodeId`,
 * stable and directly actionable" property this scheme was chosen for in
 * the first place.
 *
 * ── The epoch ──────────────────────────────────────────────────────────
 *
 * Minted per capture from the CDP session id and the main frame's
 * `loaderId` (`frames.ts`'s `CaptureFrameTreeOutcome.mainLoaderId`, read
 * straight off `Page.getFrameTree` with no further processing on that
 * module's side). Two captures of the same navigated document, on the same
 * session, share an epoch; a navigation mints a new `loaderId` and
 * therefore a new epoch; a session that reattaches (`CdpSessionId` "opaque
 * hex string, unique per attach, changing on every reattach" per
 * `cdp/types.ts`'s own doc) mints a new epoch too, even against the same
 * document, which is the conservative direction: an epoch that changed too
 * often costs a caller one extra capture, an epoch that failed to change
 * when the underlying node identity actually moved would let a stale index
 * through undetected.
 *
 * The format is deliberately unparsed and unparseable as anything other
 * than an opaque token: `@browserglass/protocol`'s `PageMapEpoch` doc says
 * "Opaque; never parse it," and this module holds up that promise by using
 * a separator (`::`) that cannot appear in either input un-escaped in a way
 * that would make two DIFFERENT `(sessionId, loaderId)` pairs collide on
 * one string: `CdpSessionId` is CDP's own hex attach id and `loaderId` is
 * CDP's own hex-ish navigation id, neither of which this codebase has ever
 * observed containing a colon, and even if one did, the only consequence of
 * an accidental match would be a caller-observable epoch string equality
 * that does not correspond to a real identity conflation. This module does
 * not try to make that impossible; it tries to make the ordinary case
 * cheap and correct, matching `mintAxMarkerAttr`'s own stated bar
 * (`cdp/accessibility.ts`: "it only has to be unique enough... never a
 * secret").
 *
 * `loaderId: null` (frames.ts's own doc: "null only if `Page.getFrameTree`
 * omitted it, never observed, tolerated defensively") mints an epoch that
 * still varies with `sessionId`, so a caller on that degenerate path still
 * gets navigation-vs-no-navigation freshness for free within one session's
 * lifetime, even though it cannot distinguish two different navigations
 * that both failed to report a `loaderId`. That residual gap is strictly
 * narrower than having no epoch at all.
 *
 * ── Checking an epoch: the mechanism, not the wire error ─────────────────
 *
 * A mismatch is refused with `bgls.error.pagemap.stale_epoch` before any
 * CDP command goes out. That wire error code is minted by whichever
 * server-side handler implements `page.map.stamp`
 * (`packages/server/src/session/managed-session.ts` and
 * `packages/server/src/ws/connection.ts`, a different package). This
 * module's job stops at
 * giving that handler a cheap, typed way to ask the question:
 * {@link assertFreshEpoch} throws {@link PageMapStaleEpochError} carrying
 * both epochs, and the caller decides how to turn that into the wire error;
 * {@link isFreshEpoch} is the same check without the throw, for a caller
 * that would rather branch than catch.
 */

import type { PageMapEpoch } from '@browserglass/protocol';
import type { CdpSessionId } from '../cdp/types.js';

/**
 * The final index value a caller sees for one node. Identity, by
 * construction: see this module's own doc for why {@link PageMapCapture}'s
 * single flat `backendNodeId`-keyed map means there is no separate index
 * space to allocate from, unlike browser-use's own `_allocate_selector_index`.
 * Exists as a named function, not inlined at every call site, so a reader
 * of `capture.ts`/`budget.ts` sees explicitly that "the index" and "the
 * backend node id" are one documented decision, not an accident of which
 * field happened to be handy.
 */
export function pageMapIndexOf(backendNodeId: number): number {
  return backendNodeId;
}

/**
 * The separator between the session id and the loader id in a minted
 * epoch. Not a parsing contract for anyone outside this module: see this
 * module's own doc, "The epoch", for why this stays opaque to every
 * consumer including the ones on this wire.
 */
const EPOCH_SEPARATOR = '::';

/**
 * Mints one capture's epoch from the CDP session id it was captured on and
 * the main frame's `loaderId` at that moment (`frames.ts`,
 * `CaptureFrameTreeOutcome.mainLoaderId`). See this module's own doc for
 * what varies the result and why `loaderId: null` still yields a usable,
 * if narrower, epoch.
 */
export function mintPageMapEpoch(sessionId: CdpSessionId, loaderId: string | null): PageMapEpoch {
  return `${sessionId}${EPOCH_SEPARATOR}${loaderId ?? ''}`;
}

/**
 * Thrown by {@link assertFreshEpoch}. Carries both epochs so a caller can
 * log or surface the mismatch without re-deriving it, and so a test can
 * assert on the exact pair without parsing either (both are opaque; see
 * this module's own doc).
 */
export class PageMapStaleEpochError extends Error {
  readonly currentEpoch: PageMapEpoch;
  readonly requestedEpoch: PageMapEpoch;

  constructor(currentEpoch: PageMapEpoch, requestedEpoch: PageMapEpoch) {
    super(
      `page map epoch mismatch: capture is at ${JSON.stringify(currentEpoch)}, request named ${JSON.stringify(requestedEpoch)}`,
    );
    this.name = 'PageMapStaleEpochError';
    this.currentEpoch = currentEpoch;
    this.requestedEpoch = requestedEpoch;
  }
}

/**
 * `true` when `requestedEpoch` (from an incoming `page.map.stamp`, per the
 * wire doc) still names the same capture as `currentEpoch` (the live
 * capture, or the one cached against this target; see `cache.ts`). A plain
 * string comparison: both sides are opaque tokens minted by
 * {@link mintPageMapEpoch}, and the whole point of the epoch is that
 * equality is the entire question, never a partial or fuzzy match.
 */
export function isFreshEpoch(currentEpoch: PageMapEpoch, requestedEpoch: PageMapEpoch): boolean {
  return currentEpoch === requestedEpoch;
}

/**
 * {@link isFreshEpoch}, as a guard: throws {@link PageMapStaleEpochError}
 * on a mismatch, so a caller acting on an index (`page.map.stamp`) can
 * refuse the request in one call before any CDP command goes out, which is
 * strictly better than the locator engine's `ref`, whose staleness is only ever
 * discovered on use (`packages/automation/src/locator/types.ts`,
 * `LocatorMatch.ref`).
 */
export function assertFreshEpoch(currentEpoch: PageMapEpoch, requestedEpoch: PageMapEpoch): void {
  if (!isFreshEpoch(currentEpoch, requestedEpoch)) {
    throw new PageMapStaleEpochError(currentEpoch, requestedEpoch);
  }
}
