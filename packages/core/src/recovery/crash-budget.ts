/**
 * `CrashBudget`: the "three restarts in ten minutes, each changing a
 * condition" limiter. Without this, a page that crashes on every load loops the
 * recovery ladder forever, one `target_crashed`/`renderer_hung` signal
 * after another. After three escalating restarts inside a ten minute
 * window, the fourth crash is not retried: the caller closes every viewer
 * `4004 Unrecoverable` naming what was tried.
 */

/** The three escalating conditions a crash-looping target's restarts try, in order. */
export type CrashCondition = 'plain' | 'blank_url' | 'quarantine_profile';

/** The three conditions, in the order they are tried. */
export const CRASH_CONDITIONS: readonly CrashCondition[] = Object.freeze([
  'plain',
  'blank_url',
  'quarantine_profile',
]);

/** Ten minutes, the crash budget's sliding window. */
export const CRASH_BUDGET_WINDOW_MS = 600_000;

/** Three restarts per window, per key, before the budget is exceeded. */
export const CRASH_BUDGET_MAX_ATTEMPTS = 3;

/** One `CrashBudget.recordCrash()` outcome. */
export interface CrashAttemptResult {
  /** 1-based count of restarts recorded for this key inside the current window, including this one. */
  readonly attempt: number;
  /** The condition to try for this restart. Meaningless when {@link exceeded} is true. */
  readonly condition: CrashCondition;
  /** `true` once the budget is exhausted: the caller must not retry, and should close every viewer `4004` instead. */
  readonly exceeded: boolean;
  /** Every condition tried so far in this window (up to all three), for the `4004` reason. */
  readonly triedSoFar: readonly CrashCondition[];
}

/**
 * Tracks, per key (normally a `targetId`), the timestamps of every
 * escalating restart attempted inside a sliding window. Timestamps are wall
 * clock (`Clock.wallNow()`), since the ten minute window is a real-world
 * duration a caller may reasonably want to reason about across a process
 * restart in a future persistence pass; nothing here depends on monotonic
 * versus wall clock semantics beyond "a fixed, non-decreasing ms reading",
 * so a monotonic clock works identically.
 */
export class CrashBudget {
  private readonly attemptsByKey = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;

  constructor(
    windowMs: number = CRASH_BUDGET_WINDOW_MS,
    maxAttempts: number = CRASH_BUDGET_MAX_ATTEMPTS,
  ) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
  }

  /**
   * Records one crash for `key` at `nowMs`, pruning attempts older than the
   * window first. Returns the next escalating condition to try, or
   * `exceeded: true` once three restarts already sit inside the window (the
   * fourth crash is not itself recorded as an attempt: nothing to escalate
   * to).
   */
  recordCrash(key: string, nowMs: number): CrashAttemptResult {
    let times = this.attemptsByKey.get(key);
    if (!times) {
      times = [];
      this.attemptsByKey.set(key, times);
    }
    const cutoff = nowMs - this.windowMs;
    while (times.length > 0 && (times[0] as number) < cutoff) {
      times.shift();
    }

    if (times.length >= this.maxAttempts) {
      return {
        attempt: times.length + 1,
        condition: CRASH_CONDITIONS[this.maxAttempts - 1] as CrashCondition,
        exceeded: true,
        triedSoFar: CRASH_CONDITIONS.slice(0, this.maxAttempts),
      };
    }

    times.push(nowMs);
    const attempt = times.length;
    const condition =
      CRASH_CONDITIONS[attempt - 1] ??
      (CRASH_CONDITIONS[CRASH_CONDITIONS.length - 1] as CrashCondition);
    return { attempt, condition, exceeded: false, triedSoFar: CRASH_CONDITIONS.slice(0, attempt) };
  }

  /** Clears every recorded attempt for `key`, e.g. once the target has stayed live long enough that the loop is over. */
  reset(key: string): void {
    this.attemptsByKey.delete(key);
  }
}
