/**
 * The router's injectable clock. Every timer tied to heartbeat, idle, or
 * reconcile logic goes through this seam rather than calling `Date.now()`
 * or the global `setTimeout`/`setInterval` directly, so a test can drive
 * the router's lifecycle logic (the reaper, the warm pool reconciler, the
 * queue's expiry sweep) without waiting on real wall clock time.
 */

/** The minimal timer handle a `Clock` hands back, so a caller can `.unref?.()` it or cancel it later. */
export interface ClockTimer {
  unref?(): void;
}

/**
 * The time and timer surface `BrowserRouter` and its collaborators depend
 * on. `now()` MUST be non decreasing (monotonic) for the duration of one
 * process; the system implementation backs it with `Date.now()`, which
 * satisfies that in practice for a single embedded process, while a test
 * clock can advance `now()` under full manual control.
 */
export interface Clock {
  /** The current time, epoch milliseconds. */
  now(): number;
  /** Schedules `fn` once, after `ms`. The returned handle supports `.unref?.()`. */
  setTimeout(fn: () => void, ms: number): ClockTimer;
  /** Schedules `fn` repeatedly, every `ms`. The returned handle supports `.unref?.()`. */
  setInterval(fn: () => void, ms: number): ClockTimer;
  /** Cancels a timer returned by `setTimeout`. */
  clearTimeout(timer: ClockTimer): void;
  /** Cancels a timer returned by `setInterval`. */
  clearInterval(timer: ClockTimer): void;
}

/**
 * The production `Clock`, backed by the real wall clock and the global
 * timer functions. Every scheduled timer calls `.unref?.()` immediately, so
 * a heartbeat, reaper, or warm pool reconcile loop never by itself keeps
 * the Node process alive.
 */
export const systemClock: Clock = Object.freeze({
  now(): number {
    return Date.now();
  },
  setTimeout(fn: () => void, ms: number): ClockTimer {
    const timer = globalThis.setTimeout(fn, ms);
    (timer as unknown as ClockTimer).unref?.();
    return timer as unknown as ClockTimer;
  },
  setInterval(fn: () => void, ms: number): ClockTimer {
    const timer = globalThis.setInterval(fn, ms);
    (timer as unknown as ClockTimer).unref?.();
    return timer as unknown as ClockTimer;
  },
  clearTimeout(timer: ClockTimer): void {
    globalThis.clearTimeout(timer as unknown as ReturnType<typeof globalThis.setTimeout>);
  },
  clearInterval(timer: ClockTimer): void {
    globalThis.clearInterval(timer as unknown as ReturnType<typeof globalThis.setInterval>);
  },
});
