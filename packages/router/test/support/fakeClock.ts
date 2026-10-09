/**
 * A manually advanced `Clock` for tests. `setTimeout`/`setInterval` never
 * fire on their own; `advance(ms)` moves the fake time forward and fires
 * every timer whose deadline the advance crosses, in deadline order, so a
 * test never waits on real wall clock time.
 */

import type { Clock, ClockTimer } from '../../src/router/clock.js';

interface FakeTimer extends ClockTimer {
  id: number;
  fireAt: number;
  intervalMs: number | null;
  fn: () => void;
  cancelled: boolean;
}

export interface FakeClock extends Clock {
  /** Advances the fake clock by `ms`, firing every timer whose deadline falls at or before the new time, in order. Handles a repeating timer rescheduling itself within the same advance. */
  advance(ms: number): void;
  /** The current fake time. */
  now(): number;
}

/** Creates a `FakeClock` starting at `startAt` (default 0). */
export function createFakeClock(startAt = 0): FakeClock {
  let current = startAt;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  const clock: FakeClock = {
    now: () => current,
    setTimeout(fn: () => void, ms: number): ClockTimer {
      const id = nextId++;
      const timer: FakeTimer = { id, fireAt: current + ms, intervalMs: null, fn, cancelled: false };
      timers.set(id, timer);
      return timer;
    },
    setInterval(fn: () => void, ms: number): ClockTimer {
      const id = nextId++;
      const timer: FakeTimer = { id, fireAt: current + ms, intervalMs: ms, fn, cancelled: false };
      timers.set(id, timer);
      return timer;
    },
    clearTimeout(timer: ClockTimer): void {
      (timer as FakeTimer).cancelled = true;
      timers.delete((timer as FakeTimer).id);
    },
    clearInterval(timer: ClockTimer): void {
      (timer as FakeTimer).cancelled = true;
      timers.delete((timer as FakeTimer).id);
    },
    advance(ms: number): void {
      const target = current + ms;
      // Fire timers strictly in deadline order, one at a time, so a timer
      // that schedules another timer during its own callback is handled
      // correctly (the new timer is only fired if its own deadline still
      // falls within this advance).
      for (;;) {
        let next: FakeTimer | null = null;
        for (const t of timers.values()) {
          if (t.cancelled) continue;
          if (t.fireAt > target) continue;
          if (!next || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && t.id < next.id))
            next = t;
        }
        if (!next) break;
        current = next.fireAt;
        if (next.intervalMs !== null) {
          next.fireAt = current + next.intervalMs;
        } else {
          timers.delete(next.id);
        }
        next.fn();
      }
      current = target;
    },
  };
  return clock;
}
