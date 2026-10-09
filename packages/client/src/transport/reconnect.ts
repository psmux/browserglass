import type { ReconnectBackoff } from '@browserglass/protocol';
import type { BackoffSchedule, ReconnectOptions } from './types.js';
import { DEFAULT_RECONNECT_OPTIONS } from './types.js';

/**
 * Resolves the concrete {@link BackoffSchedule} for one of the four named
 * families, against a caller's merged
 * {@link ReconnectOptions}. `slow` and `retryAfter` share the same
 * shape (`retryAfter` falls back to `slow`'s parameters whenever the
 * server did not send a `retryAfterMs`); `immediate` waits 0 to 150ms
 * flat, with no exponential growth and no dependency on attempt number.
 */
export function backoffScheduleFor(
  name: ReconnectBackoff,
  opts: ReconnectOptions,
): BackoffSchedule {
  switch (name) {
    case 'normal':
      return Object.freeze({
        name,
        baseDelayMs: opts.baseDelayMs,
        factor: opts.factor,
        capMs: opts.maxDelayMs,
        jitter: opts.jitter,
      });
    case 'slow':
      return Object.freeze({
        name,
        baseDelayMs: 1000,
        factor: opts.factor,
        capMs: opts.slowMaxDelayMs,
        jitter: opts.jitter,
      });
    case 'retryAfter':
      return Object.freeze({
        name,
        baseDelayMs: 1000,
        factor: opts.factor,
        capMs: opts.slowMaxDelayMs,
        jitter: opts.jitter,
      });
    case 'immediate':
      return Object.freeze({ name, baseDelayMs: 0, factor: 1, capMs: 150, jitter: 0 });
  }
}

/** The four named schedules resolved against {@link DEFAULT_RECONNECT_OPTIONS}, for reference and tests. */
export const DEFAULT_BACKOFF_SCHEDULES: Readonly<Record<ReconnectBackoff, BackoffSchedule>> =
  Object.freeze({
    normal: backoffScheduleFor('normal', DEFAULT_RECONNECT_OPTIONS),
    slow: backoffScheduleFor('slow', DEFAULT_RECONNECT_OPTIONS),
    retryAfter: backoffScheduleFor('retryAfter', DEFAULT_RECONNECT_OPTIONS),
    immediate: backoffScheduleFor('immediate', DEFAULT_RECONNECT_OPTIONS),
  });

/**
 * The plain silent-retry delay (the "silent 1"/"silent 2" attempts): flat `silentDelayMs`, jitter added on top, no exponential
 * growth. Used for the first `silentAttempts` attempts of the `normal`
 * schedule only, so a single blip does not flip any UI before the user
 * could plausibly notice.
 */
export function computeSilentDelayMs(
  opts: ReconnectOptions,
  random: () => number = Math.random,
): number {
  return opts.silentDelayMs * (1 + random() * opts.jitter);
}

/** Inputs to {@link computeBackoffDelayMs}. */
export interface DelayInput {
  schedule: BackoffSchedule;
  /** 1-based attempt number within this schedule (silent attempts excluded). */
  attempt: number;
  /** `goodbye.retryAfterMs` from the server, when the schedule is `retryAfter` and one was sent. */
  retryAfterMs?: number;
  /** Injectable for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * The reconnect backoff formula, exact:
 *
 * ```
 * nominal = min(cap, baseDelayMs * factor^(attempt-1))
 * delay   = nominal * (1 + random() * jitter)
 * ```
 *
 * Jitter is additive on top of the nominal delay, never shorter than it:
 * this spreads a thundering herd across a widening window without
 * slowing the fast path a single user feels. `retryAfter` uses the
 * server's `retryAfterMs` verbatim (plus the same additive jitter) when
 * one is supplied, falling back to the exponential ladder otherwise.
 * `immediate` ignores `attempt` entirely and returns a flat 0 to
 * `schedule.capMs` (150ms by default).
 */
export function computeBackoffDelayMs(input: DelayInput): number {
  const random = input.random ?? Math.random;
  const { schedule, attempt, retryAfterMs } = input;

  if (schedule.name === 'immediate') {
    return random() * schedule.capMs;
  }
  if (schedule.name === 'retryAfter' && typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return retryAfterMs * (1 + random() * schedule.jitter);
  }
  const nominal = Math.min(
    schedule.capMs,
    schedule.baseDelayMs * schedule.factor ** Math.max(0, attempt - 1),
  );
  return nominal * (1 + random() * schedule.jitter);
}

/** The result of {@link ReconnectController.next}: what to wait, and the bookkeeping behind it. */
export interface ScheduleResult {
  delayMs: number;
  /** The overall attempt counter for this outage, including any silent attempts, post-increment. */
  attempt: number;
  schedule: BackoffSchedule;
}

/**
 * Tracks one reconnect outage: the attempt counter, the resolved delay
 * for each attempt, and the cumulative-duration ceiling
 * (`maxReconnectMs`). Knows nothing about sockets or close codes;
 * `Transport` decides which named schedule applies to a given close and
 * calls {@link ReconnectController.next} to find out how long to wait.
 */
export class ReconnectController {
  private readonly opts: ReconnectOptions;
  private readonly random: () => number;
  private attemptCount = 0;
  private outageStartedAt: number | null = null;

  constructor(
    reconnectOptions: Partial<ReconnectOptions> = {},
    random: () => number = Math.random,
  ) {
    this.opts = { ...DEFAULT_RECONNECT_OPTIONS, ...reconnectOptions };
    this.random = random;
  }

  /** The merged reconnect options this controller was constructed with. */
  get options(): Readonly<ReconnectOptions> {
    return this.opts;
  }

  /** The current attempt counter (0 before the first attempt of this outage). */
  get attempt(): number {
    return this.attemptCount;
  }

  /** Milliseconds elapsed since the first attempt of the current outage, or `null` if none is in progress. */
  outageElapsedMs(nowMs: number): number | null {
    return this.outageStartedAt === null ? null : nowMs - this.outageStartedAt;
  }

  /** Clears all outage state: the next {@link next} call starts a fresh outage at attempt 1. */
  reset(): void {
    this.attemptCount = 0;
    this.outageStartedAt = null;
  }

  /**
   * Resets only the attempt counter, keeping the outage clock running.
   * Used when `visibilitychange` fires while `pauseWhenHidden` had
   * suspended scheduling: the client reconnects immediately "with the
   * counter reset", but the outage itself, and
   * therefore the resume-window and `maxReconnectMs` clocks, did not
   * pause.
   */
  resetAttemptCounter(): void {
    this.attemptCount = 0;
  }

  /**
   * Whether the cumulative outage duration has already reached
   * `maxReconnectMs`; the caller should move to `fatal` instead of
   * scheduling another attempt.
   */
  hasExceededMaxReconnect(nowMs: number): boolean {
    const elapsed = this.outageElapsedMs(nowMs);
    return elapsed !== null && elapsed >= this.opts.maxReconnectMs;
  }

  /**
   * Whether, at `nowMs`, a resume is still worth attempting for an outage
   * that began at `outageStartedAt`, given the effective (client versus
   * server, whichever is smaller) `resumeWindowMs`. Returns `true` when
   * no outage is in progress yet (nothing to compare against).
   */
  isWithinResumeWindow(nowMs: number, resumeWindowMs: number): boolean {
    const elapsed = this.outageElapsedMs(nowMs);
    return elapsed === null || elapsed < resumeWindowMs;
  }

  /**
   * Advances the attempt counter and returns how long to wait before the
   * next connection attempt for close-code family `backoffName`. The
   * first `silentAttempts` attempts of the `normal` family use the flat
   * silent delay instead of the exponential ladder; every other family,
   * and every attempt past the silent ones, uses
   * {@link computeBackoffDelayMs}.
   */
  next(backoffName: ReconnectBackoff, nowMs: number, retryAfterMs?: number): ScheduleResult {
    if (this.outageStartedAt === null) this.outageStartedAt = nowMs;
    this.attemptCount += 1;

    const schedule = backoffScheduleFor(backoffName, this.opts);
    if (backoffName === 'normal' && this.attemptCount <= this.opts.silentAttempts) {
      return {
        delayMs: computeSilentDelayMs(this.opts, this.random),
        attempt: this.attemptCount,
        schedule,
      };
    }
    const effectiveAttempt =
      backoffName === 'normal' ? this.attemptCount - this.opts.silentAttempts : this.attemptCount;
    const delayMs = computeBackoffDelayMs(
      retryAfterMs === undefined
        ? { schedule, attempt: effectiveAttempt, random: this.random }
        : { schedule, attempt: effectiveAttempt, retryAfterMs, random: this.random },
    );
    return { delayMs, attempt: this.attemptCount, schedule };
  }
}
