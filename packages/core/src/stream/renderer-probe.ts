/**
 * `RendererProbe`: detects a genuinely wedged renderer, deliberately hard
 * to trigger (a false positive previously cascaded into concurrent browser
 * relaunches killing every tab).
 *
 * One instance is constructed per `targetId`. An earlier design keyed the
 * probe off a session-global "current page", which does not work once each
 * target has its own independent stream.
 */

import type { Clock } from '../control/clock.js';
import { createSystemClock } from '../control/clock.js';

/** Consecutive screenshot timeouts required before a confirmation probe runs. */
export const FAIL_STREAK_THRESHOLD = 4;
/** Number of independent `evaluate('1')` confirmation attempts. */
export const CONFIRM_ATTEMPTS = 2;
/** Budget for each confirmation attempt, in milliseconds. */
export const CONFIRM_TIMEOUT_MS = 2500;
/** Gap between confirmation attempts, in milliseconds. */
export const CONFIRM_GAP_MS = 500;

/** Constructor options for {@link RendererProbe}. */
export interface RendererProbeOptions {
  targetId: string;
  clock?: Clock;
}

/**
 * Tracks one target's consecutive screenshot-timeout streak and runs the
 * two-attempt confirmation probe once the streak crosses the threshold.
 */
export class RendererProbe {
  readonly targetId: string;
  private readonly clock: Clock;
  private failStreak = 0;

  constructor(opts: RendererProbeOptions) {
    this.targetId = opts.targetId;
    this.clock = opts.clock ?? createSystemClock();
  }

  /** Current consecutive-timeout count. Exposed for tests and diagnostics. */
  get streak(): number {
    return this.failStreak;
  }

  /**
   * Records one screenshot failure from the fallback poll's catch block.
   * Only a timeout (the literal string `"timeout"` in the error message,
   * so a closed page during tab switch never counts), and only while the
   * target is not navigating, advances the streak; anything else resets it
   * to 0. Returns `true` once the streak reaches {@link FAIL_STREAK_THRESHOLD},
   * meaning the caller should now run {@link confirmHung}.
   */
  recordFailure(err: unknown, loading: boolean): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (loading || !message.includes('timeout')) {
      this.failStreak = 0;
      return false;
    }
    this.failStreak += 1;
    return this.failStreak >= FAIL_STREAK_THRESHOLD;
  }

  /** Resets the streak, e.g. after a successful capture. */
  recordSuccess(): void {
    this.failStreak = 0;
  }

  /**
   * The confirmation probe: two independent `evaluate('1')` calls,
   * {@link CONFIRM_TIMEOUT_MS} each, {@link CONFIRM_GAP_MS} apart. A busy
   * (merely slow) renderer answers one of them; a genuinely deadlocked one
   * answers neither. `evaluate` is injected so this module never touches
   * CDP directly.
   */
  async confirmHung(evaluate: () => Promise<unknown>): Promise<boolean> {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      try {
        await raceTimeout(evaluate(), CONFIRM_TIMEOUT_MS, this.clock);
        this.failStreak = 0;
        return false;
      } catch {
        // try again, or fall through as hung after the last attempt
      }
      if (attempt < CONFIRM_ATTEMPTS - 1) {
        await sleep(CONFIRM_GAP_MS, this.clock);
      }
    }
    return true;
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number, clock: Clock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimer(() => reject(new Error('probe timeout')), ms);
    p.then(
      (v) => {
        clock.clearTimer(timer);
        resolve(v);
      },
      (e) => {
        clock.clearTimer(timer);
        reject(e as Error);
      },
    );
  });
}

function sleep(ms: number, clock: Clock): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.setTimer(resolve, ms);
  });
}
