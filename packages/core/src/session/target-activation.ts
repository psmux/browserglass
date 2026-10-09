/**
 * `TargetActivationPolicy`: the session/stream orchestration piece that
 * decides which target gets live screencast frames. Empirical measurement
 * against real Chrome (`runtime-host/test/spike/spike-concurrent-screencast.ts`)
 * found that at most one
 * target per Chrome *window* ever produces continuous live screencast frames
 * at a time; every other tab of that same window is a hard zero frames per
 * second the instant it loses focus, with no grace period, regardless of
 * `maxStreamsPerInstance`. A follow-up measurement
 * (`runtime-host/test/spike/spike-window-isolation.ts`) showed that giving each
 * target its own OS window lifts that one-per-window ceiling entirely: 4
 * windows held 4/4 streams live at 82 to 90fps regardless of which one had
 * OS focus. `TargetActivationPolicy`'s job changed accordingly: it no
 * longer picks one active target for the whole Instance, it picks one
 * active target *per window*, since that is the actual unit Chrome's
 * compositor enforces the limit against.
 *
 * This class is the one place that decides, per window, which single
 * subscribed target currently owns a `CdpScreencastSource` (`../stream/cdp-screencast-source.js`,
 * the fast path) and calls `Target.activateTarget` to keep Chrome's own
 * notion of that window's focused tab in sync; every other subscribed
 * target in the same window gets a `ScreenshotPollSource`
 * (`../stream/screenshot-poll-source.js`, the fallback, measured to still
 * return fresh content from a backgrounded tab on demand) instead
 * of a screencast that would otherwise silently deliver zero frames
 * forever. A target in a *different* window is never affected by any of
 * this: it has its own active/background pair, entirely independent of
 * every other window's.
 *
 * `ScreenshotPollSource`'s `reason` union (`'cdp-unavailable' | 'screencast-refused'
 * | 'renderer-busy'`, `../stream/types.js`) has no member
 * for "this tab is simply not the active one right now"; `'renderer-busy'`
 * is reused here for that case, which is what selects the 1500ms
 * supplement poll cadence (`POLL_INTERVAL_SUPPLEMENT_MS`) rather than the
 * 50ms standalone one.
 */

import type { TargetId } from '@browserglass/protocol';
import type { CdpBridge } from '../cdp/bridge.js';
import type { TargetRegistry } from '../cdp/target-registry.js';
import type { CdpSessionId } from '../cdp/types.js';
import { CdpScreencastSource } from '../stream/cdp-screencast-source.js';
import { ScreenshotPollSource } from '../stream/screenshot-poll-source.js';
import type { FrameSource, FrameSourceSpec, RawFrame } from '../stream/types.js';

/** Which role one target's current `FrameSource` plays. */
export type CaptureMode = 'active' | 'background';

/**
 * The `activeByWindow` bucket for a target whose OS window is not known,
 * either because `TargetRegistry.windowIdFor` has not resolved yet or
 * because it failed and returned `null` (the contract says it never
 * throws). Real Chrome window ids from `Browser.getWindowForTarget` are
 * always non-negative, so `-1` cannot collide with one. Targets that land
 * here still get exactly one active target among themselves, the same
 * single-active-per-bucket rule every other window follows; they do not
 * all go live and do not all go background.
 */
const UNKNOWN_WINDOW_ID = -1;

/** One target's live capture state. */
interface TargetCaptureHandle {
  readonly targetId: TargetId;
  source: FrameSource;
  mode: CaptureMode;
  /**
   * The window bucket this capture was started in, remembered here rather
   * than re-resolved from the registry when it is needed.
   *
   * Teardown is the reason. A target is usually removed BECAUSE Chrome
   * destroyed it, and the registry drops a destroyed target before the
   * session tears its capture down, so asking the registry which window a
   * closing target belonged to is asking about something that no longer
   * exists. Re-resolving it there returned the unknown-window bucket at
   * best, which would have made `remove()` clear the wrong entry from
   * `activeByWindow` and leave the real window with no active target and no
   * promotion. Recording it at start time is both correct and cheaper: it
   * turns every teardown-path window lookup into a map read.
   */
  windowKey: number;
}

/** Constructor options for {@link TargetActivationPolicy}. */
export interface TargetActivationPolicyOptions {
  readonly bridge: CdpBridge;
  readonly registry: TargetRegistry;
  /** The capture spec (codec, quality, bounding box) to start a target's `FrameSource` with. Session owns the current quality/tier decision. */
  readonly specFor: (targetId: TargetId) => FrameSourceSpec;
  /** Called for every frame any managed `FrameSource` produces, active or background alike. */
  readonly onFrame: (targetId: TargetId, frame: RawFrame) => void;
  /** Forwarded to the background `ScreenshotPollSource`'s hang confirmation; optional. */
  readonly onHungConfirmed?: (targetId: TargetId) => void;
  readonly isLoading?: (targetId: TargetId) => boolean;
}

/**
 * Owns exactly one active (screencast) target per OS window and a
 * `ScreenshotPollSource` for every other subscribed target sharing that
 * window. An Instance with several streamed targets, each in its own
 * window (`BrowserSpec.isolation: 'window'`), therefore has several
 * simultaneously active targets, one per window; see the module doc for
 * why this exists and the evidence behind it.
 */
export class TargetActivationPolicy {
  private readonly opts: TargetActivationPolicyOptions;
  private readonly captures = new Map<TargetId, TargetCaptureHandle>();
  /** windowId (or `UNKNOWN_WINDOW_ID`) -> the target currently active (live-streaming) in that window. */
  private activeByWindow = new Map<number, TargetId>();

  constructor(opts: TargetActivationPolicyOptions) {
    this.opts = opts;
  }

  /** The active target of `windowId`, or `null` if that window has no active target (or no window with that id is tracked yet). */
  activeTargetIn(windowId: number): TargetId | null {
    return this.activeByWindow.get(windowId) ?? null;
  }

  /** Every currently live-streaming target, one per window (including the `UNKNOWN_WINDOW_ID` bucket, if populated). */
  get activeTargetIds(): readonly TargetId[] {
    return [...this.activeByWindow.values()];
  }

  /**
   * Back-compat shim for callers that still want "the one active target",
   * from before per-window activation existed (`Session.activeTargetId`,
   * `restartInstance`'s best-effort URL restore). Returns the active target
   * of the lowest-numbered window tracked, or `null` if nothing is active
   * anywhere.
   *
   * @deprecated per-window activation makes "the" active target ambiguous
   * once more than one window is streaming; prefer {@link activeTargetIds}
   * or {@link activeTargetIn}.
   */
  get activeTargetId(): TargetId | null {
    let lowest: number | null = null;
    for (const windowId of this.activeByWindow.keys()) {
      if (lowest === null || windowId < lowest) {
        lowest = windowId;
      }
    }
    return lowest === null ? null : (this.activeByWindow.get(lowest) ?? null);
  }

  /** Resolves `targetId`'s window via `TargetRegistry.windowIdFor`, folding a `null` (unknown) result onto `UNKNOWN_WINDOW_ID` so it still gets exactly one active target among its bucket-mates. */
  private async windowKeyFor(targetId: TargetId): Promise<number> {
    const windowId = await this.opts.registry.windowIdFor(targetId);
    return windowId ?? UNKNOWN_WINDOW_ID;
  }

  /** The `FrameSource` currently backing `targetId`, or `null` if it has none. */
  current(targetId: TargetId): FrameSource | null {
    return this.captures.get(targetId)?.source ?? null;
  }

  /** Which role `targetId`'s current `FrameSource` plays, or `null` if it has none. */
  modeOf(targetId: TargetId): CaptureMode | null {
    return this.captures.get(targetId)?.mode ?? null;
  }

  /**
   * Starts tracking `targetId` on `sessionId`, or re-evaluates it if
   * already tracked. Which mode `targetId` gets is a per-window decision,
   * not a per-Instance one: it becomes the active (screencast) target of
   * its own window if that window has no active target yet or already
   * considers `targetId` its active one; otherwise it starts (or stays) in
   * background (poll) mode.
   *
   * This is re-evaluated on every call rather than short-circuiting on an
   * existing capture, because the window a target belongs to, and which
   * target in it is active, can both change between calls (a sibling tab
   * in the same OS window can be promoted after this one was last
   * subscribed). A capture whose mode no longer matches what the policy
   * now wants is rebuilt at the correct mode via `start`, whose own
   * stop-before-replace rule keeps this from leaking the stale one; a
   * capture whose mode already matches is returned unchanged.
   */
  async ensureSubscribed(targetId: TargetId, sessionId: CdpSessionId): Promise<FrameSource> {
    const windowKey = await this.windowKeyFor(targetId);
    const currentActive = this.activeByWindow.get(windowKey) ?? null;
    const mode: CaptureMode =
      currentActive === null || currentActive === targetId ? 'active' : 'background';

    const existing = this.captures.get(targetId);
    if (existing && existing.mode === mode) {
      if (mode === 'active') {
        this.activeByWindow.set(windowKey, targetId);
      }
      return existing.source;
    }
    const source = await this.start(targetId, sessionId, mode);
    if (mode === 'active') {
      this.activeByWindow.set(windowKey, targetId);
    }
    return source;
  }

  /**
   * Promotes `targetId` to the active (screencast) target of its own
   * window, calling `Target.activateTarget` and demoting whatever was
   * previously active in that same window to background (poll) mode
   * first. A target in a different window is never touched: this is the
   * one rule that makes several windows drivable at once, since demoting
   * or rebuilding a target's capture is exactly what interrupts it, and a
   * target in another window has nothing to do with `targetId` becoming
   * active in its own. A no-op if `targetId` is already its window's
   * active target.
   */
  async activate(targetId: TargetId): Promise<void> {
    const windowKey = await this.windowKeyFor(targetId);
    if (this.activeByWindow.get(windowKey) === targetId) {
      return;
    }
    const target = this.opts.registry.get(targetId);
    if (!target || !target.cdpSessionId) {
      return;
    }
    await this.opts.registry.activate(targetId).catch(() => undefined);

    // Demote whatever was previously active *in this same window* to
    // background (poll) mode, rebuilt (via `start`'s own stop-before-replace
    // rule) against its own live session id, never assumed to be the same
    // session as the target being promoted. Looked up from `activeByWindow`
    // keyed on `windowKey`, so a target that is active in a different
    // window is never read here at all, let alone stopped or rebuilt.
    const previousActiveId = this.activeByWindow.get(windowKey) ?? null;
    if (previousActiveId) {
      const previousTarget = this.opts.registry.get(previousActiveId);
      if (previousTarget?.cdpSessionId) {
        await this.rebuildAs(
          previousActiveId,
          previousTarget.cdpSessionId as CdpSessionId,
          'background',
        );
      } else {
        const previous = this.captures.get(previousActiveId);
        await previous?.source.stop().catch(() => undefined);
        this.captures.delete(previousActiveId);
      }
    }

    await this.rebuildAs(targetId, target.cdpSessionId as CdpSessionId, 'active');
    this.activeByWindow.set(windowKey, targetId);
  }

  /**
   * Rebuilds `targetId`'s `FrameSource` on `sessionId`, preserving its
   * current mode (active stays active, background stays background). This
   * is the seam `recovery-target.ts`'s `RecoveryCapture.rebuild` calls
   * after a rung re-establishes a CDP session; it never changes which
   * target is active, only restarts capture on the new session.
   */
  async rebuild(targetId: TargetId, sessionId: CdpSessionId): Promise<FrameSource> {
    let mode = this.captures.get(targetId)?.mode;
    if (mode === undefined) {
      const windowKey = await this.windowKeyFor(targetId);
      mode = this.activeByWindow.get(windowKey) === targetId ? 'active' : 'background';
    }
    return this.rebuildAs(targetId, sessionId, mode);
  }

  /**
   * Stops and forgets `targetId`'s capture, e.g. once its last subscriber
   * unsubscribes or the target is gone for good. If `targetId` was its
   * window's active target, promotes another subscribed target sharing
   * that window, if one exists, so closing the live tab does not leave the
   * whole window with nothing live; drops the window from `activeByWindow`
   * once it has no subscribed target left instead.
   */
  async remove(targetId: TargetId): Promise<void> {
    const existing = this.captures.get(targetId);
    if (!existing) {
      return;
    }
    // Read off the handle rather than resolved from the registry: by the
    // time a target is removed it is usually already gone from the registry
    // (Chrome destroyed it, which is what triggered this), so asking the
    // registry would answer about a target that no longer exists. See
    // `TargetCaptureHandle.windowKey`.
    const windowKey = existing.windowKey;

    await existing.source.stop().catch(() => undefined);
    this.captures.delete(targetId);

    if (this.activeByWindow.get(windowKey) !== targetId) {
      return;
    }
    this.activeByWindow.delete(windowKey);

    const sibling = this.findSubscribedSiblingInWindow(windowKey, targetId);
    if (!sibling) {
      return;
    }
    const siblingTarget = this.opts.registry.get(sibling);
    if (!siblingTarget?.cdpSessionId) {
      return;
    }
    await this.opts.registry.activate(sibling).catch(() => undefined);
    await this.rebuildAs(sibling, siblingTarget.cdpSessionId as CdpSessionId, 'active');
    this.activeByWindow.set(windowKey, sibling);
  }

  /**
   * Finds a subscribed target sharing `windowKey` with `excludeId`, for
   * `remove()` to promote once `excludeId`'s own capture is gone. A linear
   * scan over `captures`, fine at the per-window subscription counts this
   * handles, and synchronous: every candidate's window is already on its
   * own handle, so this asks the registry nothing and cannot fail partway
   * through a teardown.
   */
  private findSubscribedSiblingInWindow(windowKey: number, excludeId: TargetId): TargetId | null {
    for (const [id, handle] of this.captures) {
      if (id === excludeId) continue;
      if (handle.windowKey === windowKey) {
        return id;
      }
    }
    return null;
  }

  /** Stops every tracked capture. Call when the Instance is going away. */
  async disposeAll(): Promise<void> {
    for (const targetId of [...this.captures.keys()]) {
      await this.remove(targetId);
    }
  }

  private async rebuildAs(
    targetId: TargetId,
    sessionId: CdpSessionId,
    mode: CaptureMode,
  ): Promise<FrameSource> {
    const source = await this.start(targetId, sessionId, mode);
    return source;
  }

  /**
   * Builds and starts a fresh `FrameSource` for `targetId` and installs it
   * as the entry `this.captures` holds for it. Always stops whatever
   * source was previously in that slot first: `rebuild()` (the seam
   * `recovery-target.ts`'s `RecoveryCapture.rebuild` calls after a rung
   * re-establishes a CDP session) used to call this indirectly without
   * stopping the old source itself, so a recovery-driven rebuild leaked
   * the stopped session's `FrameSource` and its timer every time. Centering
   * the stop here, the one place `this.captures` gets overwritten, closes
   * that leak for every caller at once rather than requiring each one to
   * remember it.
   */
  private async start(
    targetId: TargetId,
    sessionId: CdpSessionId,
    mode: CaptureMode,
  ): Promise<FrameSource> {
    const previous = this.captures.get(targetId);
    if (previous) {
      await previous.source.stop().catch(() => undefined);
    }
    // Resolved while the target is unambiguously still live, and kept on
    // the handle. See `TargetCaptureHandle.windowKey`.
    const windowKey = previous?.windowKey ?? (await this.windowKeyFor(targetId));
    const source =
      mode === 'active'
        ? this.buildScreencastSource(sessionId)
        : this.buildPollSource(targetId, sessionId);
    const spec = this.opts.specFor(targetId);
    await source.start(spec, (frame) => this.opts.onFrame(targetId, frame));
    this.captures.set(targetId, { targetId, source, mode, windowKey });
    return source;
  }

  private buildScreencastSource(sessionId: CdpSessionId): FrameSource {
    return new CdpScreencastSource({ bridge: this.opts.bridge, sessionId });
  }

  private buildPollSource(targetId: TargetId, sessionId: CdpSessionId): FrameSource {
    return new ScreenshotPollSource({
      bridge: this.opts.bridge,
      sessionId,
      targetId,
      // Repurposed for "not the active tab right now", which is what
      // selects the 1500ms supplement cadence rather than the 50ms
      // standalone one. See the module doc.
      reason: 'renderer-busy',
      ...(this.opts.onHungConfirmed
        ? { onHungConfirmed: () => this.opts.onHungConfirmed?.(targetId) }
        : {}),
      ...(this.opts.isLoading ? { isLoading: () => this.opts.isLoading?.(targetId) ?? false } : {}),
    });
  }
}
