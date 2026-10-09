import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKOFF_SCHEDULES,
  ReconnectController,
  backoffScheduleFor,
  computeBackoffDelayMs,
  computeSilentDelayMs,
} from '../../src/transport/reconnect.js';
import { DEFAULT_RECONNECT_OPTIONS } from '../../src/transport/types.js';

/** A deterministic "random" generator returning 0, so delay === nominal exactly (no jitter added). */
const ZERO_RANDOM = () => 0;
/** A deterministic "random" generator returning 1, so delay === nominal * (1 + jitter) exactly (max jitter). */
const ONE_RANDOM = () => 1;

describe('backoffScheduleFor', () => {
  it('resolves the normal schedule from ReconnectOptions', () => {
    const s = backoffScheduleFor('normal', DEFAULT_RECONNECT_OPTIONS);
    expect(s).toEqual({ name: 'normal', baseDelayMs: 250, factor: 2, capMs: 8000, jitter: 0.25 });
  });

  it('resolves the slow schedule starting at 1000ms, capped at 30000ms', () => {
    const s = backoffScheduleFor('slow', DEFAULT_RECONNECT_OPTIONS);
    expect(s.baseDelayMs).toBe(1000);
    expect(s.capMs).toBe(30000);
  });

  it('retryAfter falls back to the same shape as slow', () => {
    const retryAfter = backoffScheduleFor('retryAfter', DEFAULT_RECONNECT_OPTIONS);
    const slow = backoffScheduleFor('slow', DEFAULT_RECONNECT_OPTIONS);
    expect(retryAfter.baseDelayMs).toBe(slow.baseDelayMs);
    expect(retryAfter.capMs).toBe(slow.capMs);
  });

  it('immediate waits 0 to 150ms flat, independent of attempt number', () => {
    const s = backoffScheduleFor('immediate', DEFAULT_RECONNECT_OPTIONS);
    expect(s.baseDelayMs).toBe(0);
    expect(s.capMs).toBe(150);
  });

  it('DEFAULT_BACKOFF_SCHEDULES matches backoffScheduleFor against the defaults for all four names', () => {
    for (const name of ['normal', 'slow', 'retryAfter', 'immediate'] as const) {
      expect(DEFAULT_BACKOFF_SCHEDULES[name]).toEqual(
        backoffScheduleFor(name, DEFAULT_RECONNECT_OPTIONS),
      );
    }
  });
});

describe('computeBackoffDelayMs: the exponential formula, exact', () => {
  const normal = backoffScheduleFor('normal', DEFAULT_RECONNECT_OPTIONS);

  it('nominal = min(cap, base * factor^(attempt-1)); jitter adds on top, never shortens', () => {
    // attempt 1: nominal 250ms, band 250 to 313 (250 * 1.25 = 312.5)
    expect(computeBackoffDelayMs({ schedule: normal, attempt: 1, random: ZERO_RANDOM })).toBe(250);
    expect(computeBackoffDelayMs({ schedule: normal, attempt: 1, random: ONE_RANDOM })).toBeCloseTo(
      312.5,
      5,
    );
  });

  it('matches the published table for attempts 1 to 8 (7+ all cap at 8000)', () => {
    // [attempt, nominal] pairs from the published table (the numbered rows, silent attempts excluded).
    const table: Array<[number, number]> = [
      [1, 250],
      [2, 500],
      [3, 1000],
      [4, 2000],
      [5, 4000],
      [6, 8000],
      [7, 8000],
      [8, 8000],
    ];
    for (const [attempt, nominal] of table) {
      const lo = computeBackoffDelayMs({ schedule: normal, attempt, random: ZERO_RANDOM });
      const hi = computeBackoffDelayMs({ schedule: normal, attempt, random: ONE_RANDOM });
      expect(lo, `attempt ${attempt} lower bound`).toBeCloseTo(nominal, 5);
      expect(hi, `attempt ${attempt} upper bound`).toBeCloseTo(nominal * 1.25, 5);
      // never shorter than nominal, for a spread of random() values
      for (const r of [0, 0.1, 0.5, 0.9, 1]) {
        expect(
          computeBackoffDelayMs({ schedule: normal, attempt, random: () => r }),
        ).toBeGreaterThanOrEqual(nominal);
      }
    }
  });

  it('retryAfter uses the server retryAfterMs verbatim (plus additive jitter) when present', () => {
    const retryAfter = backoffScheduleFor('retryAfter', DEFAULT_RECONNECT_OPTIONS);
    expect(
      computeBackoffDelayMs({
        schedule: retryAfter,
        attempt: 1,
        retryAfterMs: 5000,
        random: ZERO_RANDOM,
      }),
    ).toBe(5000);
    expect(
      computeBackoffDelayMs({
        schedule: retryAfter,
        attempt: 1,
        retryAfterMs: 5000,
        random: ONE_RANDOM,
      }),
    ).toBeCloseTo(6250, 5);
  });

  it('retryAfter falls back to the exponential ladder when no retryAfterMs is supplied', () => {
    const retryAfter = backoffScheduleFor('retryAfter', DEFAULT_RECONNECT_OPTIONS);
    expect(computeBackoffDelayMs({ schedule: retryAfter, attempt: 1, random: ZERO_RANDOM })).toBe(
      1000,
    );
  });

  it('immediate ignores attempt entirely and stays within 0 to capMs', () => {
    const immediate = backoffScheduleFor('immediate', DEFAULT_RECONNECT_OPTIONS);
    expect(computeBackoffDelayMs({ schedule: immediate, attempt: 1, random: ZERO_RANDOM })).toBe(0);
    expect(computeBackoffDelayMs({ schedule: immediate, attempt: 99, random: ONE_RANDOM })).toBe(
      150,
    );
  });
});

describe('computeSilentDelayMs', () => {
  it('is flat (no exponential growth) with jitter on top of silentDelayMs', () => {
    expect(computeSilentDelayMs(DEFAULT_RECONNECT_OPTIONS, ZERO_RANDOM)).toBe(200);
    expect(computeSilentDelayMs(DEFAULT_RECONNECT_OPTIONS, ONE_RANDOM)).toBe(250);
  });
});

describe('ReconnectController', () => {
  it('the first silentAttempts (default 2) attempts of the normal schedule use the flat silent delay', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    const a1 = ctl.next('normal', 0);
    const a2 = ctl.next('normal', 0);
    expect(a1).toMatchObject({ delayMs: 200, attempt: 1 });
    expect(a2).toMatchObject({ delayMs: 200, attempt: 2 });
  });

  it('attempts past silentAttempts follow the exponential ladder, offset so attempt 3 overall is numbered attempt 1', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    ctl.next('normal', 0); // silent 1 (overall attempt 1)
    ctl.next('normal', 0); // silent 2 (overall attempt 2)
    const a3 = ctl.next('normal', 0); // numbered attempt 1: nominal 250ms
    const a4 = ctl.next('normal', 0); // numbered attempt 2: nominal 500ms
    expect(a3).toMatchObject({ delayMs: 250, attempt: 3 });
    expect(a4).toMatchObject({ delayMs: 500, attempt: 4 });
  });

  it('a non-normal schedule (e.g. slow) never uses the silent delay, even on attempt 1', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    const a1 = ctl.next('slow', 0);
    expect(a1.delayMs).toBe(1000); // slow's own base, not silentDelayMs (200)
  });

  it('reset() clears the attempt counter and the outage clock', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    ctl.next('normal', 1000);
    ctl.next('normal', 1100);
    expect(ctl.attempt).toBe(2);
    ctl.reset();
    expect(ctl.attempt).toBe(0);
    expect(ctl.outageElapsedMs(5000)).toBeNull();
  });

  it('resetAttemptCounter() resets the attempt count but keeps the outage clock running (visibilitychange resume)', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    ctl.next('normal', 1000); // outage starts at t=1000
    ctl.resetAttemptCounter();
    expect(ctl.attempt).toBe(0);
    expect(ctl.outageElapsedMs(1000 + 60000)).toBe(60000); // clock did not reset
  });

  it('hasExceededMaxReconnect() is false until the cumulative outage passes maxReconnectMs', () => {
    const ctl = new ReconnectController({ maxReconnectMs: 10000 }, ZERO_RANDOM);
    ctl.next('normal', 0);
    expect(ctl.hasExceededMaxReconnect(9999)).toBe(false);
    expect(ctl.hasExceededMaxReconnect(10000)).toBe(true);
  });

  it('hasExceededMaxReconnect() is false with no outage in progress', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    expect(ctl.hasExceededMaxReconnect(999999)).toBe(false);
  });

  it('isWithinResumeWindow() reflects elapsed outage time against the given window', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    ctl.next('normal', 0); // outage starts at t=0
    expect(ctl.isWithinResumeWindow(119999, 120000)).toBe(true);
    expect(ctl.isWithinResumeWindow(120000, 120000)).toBe(false);
  });

  it('isWithinResumeWindow() is true with no outage in progress (nothing to compare against yet)', () => {
    const ctl = new ReconnectController({}, ZERO_RANDOM);
    expect(ctl.isWithinResumeWindow(0, 120000)).toBe(true);
  });
});
