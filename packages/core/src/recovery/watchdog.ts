/**
 * `FrameStalenessWatchdog`: per `Stream`, not per Session (a session-global
 * watchdog cannot tell a healthy tab from a stalled one once a session has
 * more than one target). The guard order is exactly this:
 *
 * ```js
 * const inputAge = Date.now() - this._lastInputAt;
 * if (inputAge < this._watchdogInputGraceMs) return;      // 60s default
 * if (Date.now() < this._aiActiveUntil) return;
 * if (!this._loading) { this.forceFrame().catch(() => {}); this._lastFrameAt = Date.now(); return; }
 * if (this.dialogOpen) return;                             // 4th guard: open JS dialog blocks renderer by design
 * ```
 *
 * plus the zero-participants guard, shown separately in the source:
 * `if (this.participants.size === 0) { this._lastFrameAt = Date.now(); return; }`.
 *
 * Reading order, all four (plus zero-participants) required to pass before
 * the watchdog fires: (0) no participants means no alarm; (1) input within
 * `watchdogInputGraceMs` suppresses; (2) an active `session.busy`
 * declaration suppresses; (3) a target that is NOT currently loading gets a
 * self-heal `forceFrame()` instead of an alarm (the common "legitimately
 * static page, screencast_silent is not a failure" case); a target that IS
 * loading skips this self-heal and falls through toward the alarm, since a
 * stuck load is exactly the case worth raising; (4) an open JS dialog
 * blocks the renderer by design and suppresses. Only once every guard has
 * been passed does the actual `now - lastFrameAt >= silenceMs` staleness
 * check fire the `screencast_silent` signal.
 */

import type { Clock, TimerHandle } from '../control/clock.js';
import { createSystemClock } from '../control/clock.js';

/** {@link FrameStalenessWatchdog}'s tunable parameters. */
export interface WatchdogTiming {
  /** How often the watchdog re-evaluates. Default 15000. */
  readonly watchdogIntervalMs: number;
  /** How long since the last frame before the watchdog fires (once every guard has passed). Default 30000. */
  readonly watchdogSilenceMs: number;
  /** Input within this long ago suppresses the watchdog. Default 60000. */
  readonly watchdogInputGraceMs: number;
  /** After a successful R0 for `screencast_silent`, the watchdog is suppressed for this long. Default 120000. */
  readonly watchdogPostRecoveryCooldownMs: number;
}

/** The default {@link WatchdogTiming}. */
export const DEFAULT_WATCHDOG_TIMING: WatchdogTiming = Object.freeze({
  watchdogIntervalMs: 15000,
  watchdogSilenceMs: 30000,
  watchdogInputGraceMs: 60000,
  watchdogPostRecoveryCooldownMs: 120000,
});

/** Constructor options for {@link FrameStalenessWatchdog}. */
export interface FrameStalenessWatchdogOptions extends Partial<WatchdogTiming> {
  readonly clock?: Clock;
  /** Number of viewers/attachments currently on this stream. Zero means no alarm, ever. */
  readonly participantCount: () => number;
  /** Monotonic ms of the last frame this stream actually produced. */
  readonly lastFrameAtMs: () => number;
  /** Monotonic ms of the last dispatched input on this stream's target. */
  readonly lastInputAtMs: () => number;
  /** Whether a `session.busy` declaration is currently suppressing detection for this target. */
  readonly isBusy: () => boolean;
  /** Whether the target is currently mid-navigation (`Page.loadEventFired` not yet seen). */
  readonly isLoading: () => boolean;
  /** Whether an unanswered JS dialog is open on this target. */
  readonly isDialogOpen: () => boolean;
  /** Forces one frame; called as the self-heal path when the target is not loading. */
  readonly forceFrame: () => Promise<boolean>;
  /** Fired once every guard has passed and the target is genuinely stale. Raises `screencast_silent`. */
  readonly onStale: () => void;
}

/**
 * Runs the frame-staleness check on a fixed interval for one `Stream`,
 * applying all four false-positive guards (plus the zero-participants
 * short circuit) before ever calling `onStale`.
 */
export class FrameStalenessWatchdog {
  private readonly clock: Clock;
  private readonly timing: WatchdogTiming;
  private readonly opts: FrameStalenessWatchdogOptions;
  private timer: TimerHandle | null = null;
  private cooldownUntil = 0;
  private disposed = false;

  constructor(opts: FrameStalenessWatchdogOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? createSystemClock();
    this.timing = Object.freeze({
      watchdogIntervalMs: opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_TIMING.watchdogIntervalMs,
      watchdogSilenceMs: opts.watchdogSilenceMs ?? DEFAULT_WATCHDOG_TIMING.watchdogSilenceMs,
      watchdogInputGraceMs:
        opts.watchdogInputGraceMs ?? DEFAULT_WATCHDOG_TIMING.watchdogInputGraceMs,
      watchdogPostRecoveryCooldownMs:
        opts.watchdogPostRecoveryCooldownMs ??
        DEFAULT_WATCHDOG_TIMING.watchdogPostRecoveryCooldownMs,
    });
  }

  /** Starts the periodic tick. Idempotent. */
  start(): void {
    if (this.timer || this.disposed) {
      return;
    }
    this.schedule();
  }

  /** Stops the periodic tick. Safe to call more than once, and after {@link dispose}. */
  stop(): void {
    if (this.timer) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Stops the watchdog for good; a disposed watchdog never reschedules itself again. */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /**
   * Records a successful recovery so the caller's watchdog reset plus
   * post-recovery cooldown rule is honoured:
   * only an `R0` success for the `screencast_silent` signal arms the
   * cooldown, cleared the moment a real frame arrives (a fresh
   * `lastFrameAtMs` reading past `cooldownUntil` already achieves that,
   * with no separate clear needed).
   */
  noteRecoverySuccess(rung: string, signal: string): void {
    if (rung === 'R0' && signal === 'screencast_silent') {
      this.cooldownUntil = this.clock.monotonicNow() + this.timing.watchdogPostRecoveryCooldownMs;
    }
  }

  /** Runs one evaluation immediately, outside the normal schedule. Exposed for tests; production code should rely on {@link start}. */
  async tick(): Promise<void> {
    const now = this.clock.monotonicNow();

    if (now < this.cooldownUntil) {
      return;
    }
    // Guard 0: zero participants means no alarm.
    if (this.opts.participantCount() === 0) {
      return;
    }
    // Guard 1: input within the grace window suppresses.
    if (now - this.opts.lastInputAtMs() < this.timing.watchdogInputGraceMs) {
      return;
    }
    // Guard 2: an active `session.busy` declaration suppresses.
    if (this.opts.isBusy()) {
      return;
    }
    // Guard 3: not loading -> self-heal with a forced frame instead of alarming.
    if (!this.opts.isLoading()) {
      await this.opts.forceFrame().catch(() => false);
      return;
    }
    // Guard 4: an open JS dialog blocks the renderer by design.
    if (this.opts.isDialogOpen()) {
      return;
    }

    if (now - this.opts.lastFrameAtMs() >= this.timing.watchdogSilenceMs) {
      this.opts.onStale();
    }
  }

  private schedule(): void {
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (!this.disposed) {
          this.schedule();
        }
      });
    }, this.timing.watchdogIntervalMs);
  }
}
