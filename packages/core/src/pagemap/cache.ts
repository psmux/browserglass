/**
 * A per-target page map cache. Read "What this actually buys" below before
 * assuming it buys more than it does.
 *
 * ── What this actually buys ────────────────────────────────────────────
 *
 * `capture.ts` is the only expensive
 * part of a page map: three-to-four parallel CDP round trips plus a
 * per-frame accessibility fan-out plus a whole-subtree listener walk.
 * `budget.ts`, by contrast, is pure CPU over an already-finished
 * {@link PageMapCapture} and safe to call twice with two different byte
 * ceilings. This class caches the EXPENSIVE half only: one
 * {@link PageMapCapture} per target, so a second `page.map.get` against the
 * same target, same document, with only the byte budget or the `include`
 * projection differing, can skip `capture.ts` entirely and re-run
 * `budget.ts`/`extractPageMapText` against the cached value.
 *
 * The shape of the win is modest. The single largest win over a
 * rebuild-every-step pipeline is storing rects in DOCUMENT space (built
 * into `types.ts`/`snapshot.ts`/`frames.ts`), which means a SCROLL between
 * two reads invalidates nothing here: no CDP event fires, no
 * `invalidate` call happens, the cached capture is still exactly correct.
 * That is the case this cache is genuinely good for: two reads of the same
 * settled page, or a map-then-stamp-then-inspect flow where the stamp step
 * (`page.map.stamp`) does not itself mutate the
 * page.
 *
 * The case this cache is NOT good for, stated plainly: a click-then-read
 * loop, the most common agent loop there is.
 * A click is exactly the "input dispatched through the lease on that
 * target" invalidator {@link invalidate} exists for (see "The third
 * invalidator" below), so a correctly-wired caller invalidates on every
 * click, and the expected hit rate in that loop is near zero. This class
 * does not claim otherwise anywhere in its own behaviour: there is no
 * "trust the cache across an input event" mode, no TTL that would paper
 * over a missed invalidation with staleness instead of a fresh capture.
 *
 * ── Keyed by target id, the epoch riding along on the value ──────────────
 *
 * The cache is keyed by target id and epoch. There is no separate epoch axis in the map key here: {@link PageMapCapture}
 * already carries its own `epoch` (`types.ts`), so "keyed by target id and
 * epoch" falls out of storing the whole capture under its target id and
 * letting a caller compare `get(targetId)?.epoch` against whatever epoch
 * it is holding. A caller wanting an epoch-specific lookup ("give me this
 * capture only if it is still epoch X") gets that for free from the
 * returned value plus `index-assign.ts`'s `isFreshEpoch`, without this
 * class needing a second dimension in its own key space.
 *
 * ── The two measured invalidators ─────────────────────────────────────
 *
 * `DOM.documentUpdated` and `Page.frameNavigated`, subscribed per session
 * through `CdpBridge.on(event, handler, sessionId)` the moment a capture is
 * cached for that target, and torn down the moment the entry is
 * invalidated or replaced. Both are CDP EVENTS, not commands: whether
 * either fires on a session where this module has sent no explicit
 * `DOM.enable`/`Page.enable` is UNMEASURED by this build. `hit-test.ts` and
 * `accessibility.ts` both measured that `DOM.*` COMMANDS answer with no
 * enable step; neither measured whether `DOM.*` EVENTS are delivered
 * without one, and the listener probe (`listeners.ts`) measured
 * `DOMDebugger`/`Runtime` event silence, not `DOM`/`Page` event delivery.
 * In production, `Page.enable` already runs for every ordinary page target
 * (streaming, navigation tracking) well before a page map is ever
 * requested, so `Page.frameNavigated` firing is not in serious doubt; `DOM`
 * is the domain this build otherwise avoids explicitly enabling
 * (`accessibility.ts`'s own precedent), so whether `DOM.documentUpdated`
 * is delivered on a session that never sent `DOM.enable` is the one
 * genuinely open question here. REPORTED, not assumed either way: if it
 * turns out `DOM.documentUpdated` needs an explicit enable this build does
 * not otherwise send, this cache's document-replacement invalidator is
 * silently inert rather than silently wrong (a document replacement it
 * cannot see just means the cached capture no longer matches the live
 * page, the same failure mode as `DOM.documentUpdated` firing on document
 * replacement, not on every subtree mutation: one more reason not to trust this cache
 * alone against a page that might have changed underneath it).
 *
 * ── The third invalidator: exposed, not wired ─────────────────────────────
 *
 * There is a third invalidator: any input dispatched through the lease on
 * that target. This module does not reach into `InputDispatcher`
 * (`packages/core/src/input/dispatcher.ts`) to wire that itself.
 * {@link invalidate} is
 * public precisely so whichever layer already sees every dispatched input
 * event on a target's lease (the input layer itself, or the server-side
 * session object that owns both the lease and the `pageMap()` method) can
 * call it at the point that layer already knows an
 * input landed. Leaving this wiring out is not an oversight: it keeps this
 * cache's own dependency graph inside `pagemap/`, importing nothing from
 * `input/` or `control/`, so a change to how leases dispatch input can
 * never break this file by surprise.
 *
 * ── Complexity and lifecycle ──────────────────────────────────────────
 *
 * O(1) `get`/`set`/`invalidate`, each touching one `Map` entry and, for
 * `set`/`invalidate`, exactly two event subscriptions. Nothing here polls;
 * every subscription is live for exactly as long as its entry is cached,
 * torn down the instant the entry is replaced or explicitly invalidated,
 * so a long-lived `PageMapCache` never accumulates dead listeners for
 * targets whose capture has already been evicted. {@link dispose} tears
 * down every remaining entry's subscriptions at once, for a caller closing
 * the whole cache (an `Instance` shutting down, in a future stage's
 * wiring).
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../cdp/types.js';
import type { PageMapCapture } from './types.js';

interface CacheEntry {
  readonly capture: PageMapCapture;
  readonly unsubscribes: readonly Unsubscribe[];
}

/**
 * A per-target cache of one {@link PageMapCapture} each, invalidated by the
 * two measured CDP events plus an explicit external call. See this
 * module's own doc for the honest account of when it helps and when it
 * does not.
 */
export class PageMapCache {
  private readonly bridge: CdpBridge;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(bridge: CdpBridge) {
    this.bridge = bridge;
  }

  /** The cached capture for `targetId`, or `undefined` if nothing is cached (never captured, or invalidated since). Does not itself check the capture's own `epoch`; see this module's own doc, "Keyed by target id". */
  get(targetId: string): PageMapCapture | undefined {
    return this.entries.get(targetId)?.capture;
  }

  /**
   * Caches `capture` for `targetId`, replacing (and invalidating, tearing
   * down its subscriptions) whatever was cached before, then subscribes to
   * `DOM.documentUpdated` and `Page.frameNavigated` on `sessionId` so a
   * document replacement invalidates this entry on its own. `sessionId` is
   * the session `capture.ts` actually captured on, not derived from
   * `capture` itself: `PageMapCapture` carries no session id field (only
   * its `epoch`, which is a session id folded into an opaque string, not
   * one a caller should try to un-mint).
   */
  set(targetId: string, sessionId: CdpSessionId, capture: PageMapCapture): void {
    this.invalidate(targetId);
    const unsubDocumentUpdated = this.bridge.on(
      'DOM.documentUpdated',
      () => this.invalidate(targetId),
      sessionId,
    );
    const unsubFrameNavigated = this.bridge.on(
      'Page.frameNavigated',
      () => this.invalidate(targetId),
      sessionId,
    );
    this.entries.set(targetId, {
      capture,
      unsubscribes: [unsubDocumentUpdated, unsubFrameNavigated],
    });
  }

  /**
   * Drops the cached entry for `targetId`, if any, and unsubscribes its
   * two event handlers. Safe to call from inside one of those handlers
   * (the event dispatch this cache relies on, `CdpBridge`'s own `on`,
   * copies its handler set before invoking it: see that module's own
   * `handleMessage`), safe to call on a target with nothing cached
   * (a no-op), and safe to call more than once for the same target. This
   * is also the method a caller wires the third invalidator to; see this
   * module's own doc, "The third invalidator".
   */
  invalidate(targetId: string): void {
    const entry = this.entries.get(targetId);
    if (entry === undefined) return;
    for (const unsubscribe of entry.unsubscribes) unsubscribe();
    this.entries.delete(targetId);
  }

  /** Invalidates every entry currently cached, for a caller shutting the whole cache down. */
  dispose(): void {
    for (const targetId of [...this.entries.keys()]) {
      this.invalidate(targetId);
    }
  }
}
