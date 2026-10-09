/**
 * The AIMD adaptive quality controller: the `ADAPT` constants and the
 * per-attachment `step()` function, evaluated every `intervalMs` (default
 * 1000ms).
 *
 * `dropRate` is read off `Attachment.dropRate`,
 * which `attachment.ts` computes from backpressure skips only, never
 * `emitEveryNth` skips: at L7 (`emitEveryNth: 4`), 75 percent of frames are
 * legitimately unsent by design, and counting those as drops would read a
 * healthy L7 attachment as permanently bad, exactly the bug this
 * resolution fixes.
 *
 * Freezing adaptation while a session is `recovering` is the caller's
 * responsibility: this module exposes only the pure per-tick `step()` and
 * does not own that gate. A caller must simply not invoke `step()` for any attachment
 * on a recovering stream, and must call {@link resetForNewGeneration} once
 * recovery completes (the first frame of the new generation) so the
 * climb-back starts clean.
 */

import type { Attachment } from './attachment.js';
import { type LadderLevel, clampLadderLevel } from './quality-ladder.js';

/** The AIMD controller's tunable constants. */
export const ADAPT = Object.freeze({
  intervalMs: 1000,
  rttTargetMs: 150,
  rttHighMs: 400,
  dropTarget: 0.02,
  dropHigh: 0.1,
  decodeTargetMs: 12,
  decodeHighMs: 25,
  bufferedTargetBytes: 256 * 1024,
  bufferedHighBytes: 1024 * 1024,

  increaseAfterGoodWindows: 2,
  increaseStep: 1,
  decreaseStep: 2,
  decreaseStepSevere: 3,
  cooldownAfterDecreaseMs: 3000,
  minDwellMs: 2000,
  /** `L4`; applies only to the `ControlLease` holder's attachment. */
  controllerFloorLevel: 4 as LadderLevel,
});

/**
 * Counts how many of the four signals (rtt, dropRate, decodeMs,
 * bufferedBytes) are past their "high water" threshold. `bufferedBytes`
 * joins the other three in both the bad-signal count and the `good`
 * predicate; checking only three in one of them would be an asymmetry.
 */
export function countBadSignals(
  att: Pick<Attachment, 'ackRttEmaMs' | 'dropRate' | 'decodeMsEma' | 'bufferedBytesEma'>,
): number {
  let bad = 0;
  if (att.ackRttEmaMs >= ADAPT.rttHighMs) bad += 1;
  if (att.dropRate >= ADAPT.dropHigh) bad += 1;
  if (att.decodeMsEma >= ADAPT.decodeHighMs) bad += 1;
  if (att.bufferedBytesEma >= ADAPT.bufferedHighBytes) bad += 1;
  return bad;
}

/**
 * Applies the lease-holder floor and the `[0,7]` clamp to a candidate
 * level. `resolutionCapLevel`, when supplied, is a further worst-case
 * ceiling derived from the client's reported viewport; it is
 * a resolution cap, not a quality change, so it is applied the same way as
 * the lease floor: it can only make the level *better* (a lower number),
 * never worse.
 */
export function clampLevel(
  level: number,
  opts: { isLeaseHolder: boolean; resolutionFloor?: LadderLevel } = { isLeaseHolder: false },
): LadderLevel {
  let candidate = level;
  if (opts.isLeaseHolder) {
    candidate = Math.min(candidate, ADAPT.controllerFloorLevel);
  }
  if (opts.resolutionFloor !== undefined) {
    candidate = Math.min(candidate, opts.resolutionFloor);
  }
  return clampLadderLevel(candidate);
}

/**
 * One AIMD evaluation for one attachment. Higher level number means worse
 * quality, so a positive step is a decrease. Falls fast (2 levels on the
 * first bad window, 3 when 2 or more signals are bad), climbs slowly (1
 * level after 2 consecutive good windows). Mutates `att.adaptive` in
 * place (`goodWindows`, `cooldownUntil`, `lastLevelChangeAt`) and returns
 * the resulting level, which the caller (the `Stream`/tier-bucketing layer)
 * is responsible for actually applying.
 *
 * `nowMs` is caller-supplied (never read internally) so the whole
 * adaptation loop can run against an injected {@link import('../control/clock.js').Clock}
 * in tests, with no real waiting.
 */
export function step(
  att: Attachment,
  nowMs: number,
  opts: { isLeaseHolder: boolean; resolutionFloor?: LadderLevel } = { isLeaseHolder: false },
): LadderLevel {
  const state = att.adaptive;
  const bad = countBadSignals(att);
  const good =
    bad === 0 &&
    att.dropRate <= ADAPT.dropTarget &&
    att.ackRttEmaMs <= ADAPT.rttTargetMs &&
    att.decodeMsEma <= ADAPT.decodeTargetMs &&
    att.bufferedBytesEma <= ADAPT.bufferedTargetBytes;

  if (nowMs - state.lastLevelChangeAt < ADAPT.minDwellMs) {
    return state.desiredLevel;
  }

  let next = state.desiredLevel;
  if (bad >= 2) {
    state.goodWindows = 0;
    state.cooldownUntil = nowMs + ADAPT.cooldownAfterDecreaseMs;
    next = clampLevel(state.desiredLevel + ADAPT.decreaseStepSevere, opts);
  } else if (bad === 1) {
    state.goodWindows = 0;
    state.cooldownUntil = nowMs + ADAPT.cooldownAfterDecreaseMs;
    next = clampLevel(state.desiredLevel + ADAPT.decreaseStep, opts);
  } else if (good && nowMs >= state.cooldownUntil) {
    state.goodWindows += 1;
    if (state.goodWindows >= ADAPT.increaseAfterGoodWindows) {
      state.goodWindows = 0;
      next = clampLevel(state.desiredLevel - ADAPT.increaseStep, opts);
    }
  }

  if (next !== state.desiredLevel) {
    state.desiredLevel = next;
    state.lastLevelChangeAt = nowMs;
  }
  return state.desiredLevel;
}

/**
 * Resets an attachment's adaptive state for the first frame of a new
 * target generation: `cooldownUntil = now + 3000`,
 * `goodWindows` reset, so the climb-back after a recovery starts clean
 * rather than inheriting a cooldown or partial good-window count from
 * before the outage.
 */
export function resetForNewGeneration(att: Attachment, nowMs: number): void {
  att.adaptive.goodWindows = 0;
  att.adaptive.cooldownUntil = nowMs + 3000;
}
