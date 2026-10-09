/**
 * The input rate limiter: a per-`(viewer, target)` token bucket, admission
 * classes, and sustained-critical-starvation escalation tracking.
 * `criticalOverrunMs` is 10000 (the wire contract says "sustained for
 * 10 s") and `inputRatePerSec` is 300.
 *
 * The release class (`mouse.up`, `key.up`, `touch.end`, `touch.cancel`,
 * exactly `../control/fencing.ts`'s `ALWAYS_DISPATCHED_KINDS`) is exempted
 * from the bucket entirely, not merely floored at a lower reserve: dropping
 * a release is never a dropped event, it is a corrupted state that no
 * timeout fixes. The guarantee is stronger than a plain `critical` class
 * (which may only dip below the reserve): up, end, and cancel are the one
 * class never dropped, not by the rate limiter, not by stale gen, not by
 * stale lease.
 */

import type { InputFenceKind } from '../control/fencing.js';
import { ALWAYS_DISPATCHED_KINDS } from '../control/fencing.js';

/** The default rate constants. */
export const RATE_DEFAULTS = Object.freeze({
  /** Per viewer per target. */
  inputRatePerSec: 300,
  /** `droppable` may not dip below this many tokens; `critical` may, down to zero. */
  reserveTokens: 60,
  /** Sustained `critical`-class starvation (continuously denied admission) for this long is treated as abuse. */
  criticalOverrunMs: 10_000,
});

/** One `(viewer, target)` pair's token bucket state. */
export interface TokenBucket {
  tokens: number;
  lastRefillMonoMs: number;
}

/** Constructs a fresh bucket, starting full (one second of burst allowance). */
export function createTokenBucket(ratePerSec: number, nowMonoMs: number): TokenBucket {
  return { tokens: ratePerSec, lastRefillMonoMs: nowMonoMs };
}

/** Refills `bucket` for elapsed time, capped at `ratePerSec` (one second of burst). Mutates `bucket` in place. */
export function refillTokenBucket(
  bucket: TokenBucket,
  ratePerSec: number,
  nowMonoMs: number,
): void {
  const elapsedSec = Math.max(0, nowMonoMs - bucket.lastRefillMonoMs) / 1000;
  bucket.lastRefillMonoMs = nowMonoMs;
  bucket.tokens = Math.min(ratePerSec, bucket.tokens + elapsedSec * ratePerSec);
}

/** The three admission classes. `exempt` extends the usual two-class scheme, see the module doc. */
export type AdmissionClass = 'droppable' | 'critical' | 'exempt';

/**
 * Classifies one input kind for rate-limit admission. Mouse and touch moves,
 * plus wheel and `drag.over`, are `droppable` (a drag produces a lot of
 * `over` events, and each one is superseded by the next exactly like a
 * mouse move); the release class is `exempt` (bypasses the bucket
 * entirely) and now includes `drag.drop`/`drag.leave` alongside `mouse.up`,
 * for the same reason those are in `ALWAYS_DISPATCHED_KINDS`: a drag must
 * not be the one input kind a rate limit can leave stuck open; everything
 * else (`down`, `key.down`/`up`/`char`, `input.text`, `touch.start`,
 * `drag.enter`) is `critical`.
 */
export function classifyAdmission(kind: InputFenceKind): AdmissionClass {
  if (ALWAYS_DISPATCHED_KINDS.has(kind)) {
    return 'exempt';
  }
  if (
    kind === 'mouse.move' ||
    kind === 'mouse.wheel' ||
    kind === 'touch.move' ||
    kind === 'drag.over'
  ) {
    return 'droppable';
  }
  return 'critical';
}

/**
 * Attempts to admit one event of admission class `cls` against `bucket`,
 * refilling first. `droppable` succeeds only while `tokens - 1 >= reserveTokens`;
 * `critical` succeeds down to `tokens - 1 >= 0`. `exempt` is not expected to
 * reach this function at all; callers should skip it via
 * {@link classifyAdmission} returning `'exempt'` before calling this.
 */
export function admit(
  bucket: TokenBucket,
  cls: Exclude<AdmissionClass, 'exempt'>,
  ratePerSec: number,
  reserveTokens: number,
  nowMonoMs: number,
): boolean {
  refillTokenBucket(bucket, ratePerSec, nowMonoMs);
  const floor = cls === 'droppable' ? reserveTokens : 0;
  if (bucket.tokens - 1 < floor) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

/**
 * Tracks how long the `critical` class has been continuously denied
 * admission for one `(viewer, target)` pair. `note(false, now)` returns
 * `'escalate'` the first time the continuous denial streak reaches
 * `criticalOverrunMs`; every call while admitted resets the streak.
 */
export class CriticalStarvationTracker {
  private startedAtMonoMs: number | null = null;
  private escalated = false;

  note(admitted: boolean, nowMonoMs: number, criticalOverrunMs: number): 'ok' | 'escalate' {
    if (admitted) {
      this.startedAtMonoMs = null;
      this.escalated = false;
      return 'ok';
    }
    if (this.startedAtMonoMs === null) {
      this.startedAtMonoMs = nowMonoMs;
    }
    if (!this.escalated && nowMonoMs - this.startedAtMonoMs >= criticalOverrunMs) {
      this.escalated = true;
      return 'escalate';
    }
    return 'ok';
  }
}
