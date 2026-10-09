/**
 * The monotonic-versus-wall-clock split the control lease state machine
 * depends on throughout. Internal timing (durations, `setTimeout` delays,
 * grace-window arithmetic) is always computed from a monotonic reading;
 * the absolute Unix-ms values that go on the wire (`expiresAt`, `deadline`)
 * are always computed from a wall-clock reading.
 * Conflating the two is exactly the bug this split exists to prevent: a
 * system clock step (NTP correction, laptop sleep/resume) must never
 * corrupt a lease's internal grace timer.
 *
 * The tsconfig baseline enables only `lib: ["ES2023"]` (no DOM, no
 * `@types/node`; `protocol`'s `AbortSignalLike` works around the same
 * constraint), so the handful of Node globals this module needs
 * (`setTimeout`, `clearTimeout`, `performance`) are read off `globalThis`
 * through a local structural cast rather than declared as ambient globals,
 * which would risk colliding with a different signature declared by a
 * sibling module elsewhere in `core/src/**`.
 */

/** The subset of Node's `Timeout` handle this module relies on. */
export interface TimerHandle {
  /** Node's `Timeout.unref()`; absent (and a no-op) on non-Node timer handles. */
  unref?: () => void;
}

/**
 * The clock abstraction every lease-timing component takes by injection.
 * `createSystemClock()` is the production implementation; `createManualClock()`
 * is the deterministic, hand-advanced implementation every test in this
 * package uses instead of sleeping in real time.
 */
export interface Clock {
  /** Monotonic, arbitrary origin. Never appears on the wire; used only for internal duration arithmetic. */
  monotonicNow(): number;
  /** Wall clock, Unix ms. The only reading used to compute a wire `expiresAt` or `deadline` value. */
  wallNow(): number;
  /**
   * Schedules `fn` to run after `ms` (measured against {@link monotonicNow}).
   * Implementations tied to a real timer MUST call `.unref?.()` on the
   * returned handle so a pending lease timer never keeps the process alive.
   */
  setTimer(fn: () => void, ms: number): TimerHandle;
  /** Cancels a timer previously returned by {@link setTimer}. Safe to call more than once. */
  clearTimer(handle: TimerHandle): void;
}

interface GlobalTimerSource {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  performance?: { now(): number };
}

function globalTimerSource(): GlobalTimerSource {
  return globalThis as unknown as GlobalTimerSource;
}

/**
 * The production {@link Clock}: `performance.now()` (falling back to
 * `Date.now()` only if `performance` is somehow unavailable) for monotonic
 * reads, `Date.now()` for wall-clock reads, and the real `setTimeout` with
 * every returned handle unref'd.
 */
export function createSystemClock(): Clock {
  const g = globalTimerSource();
  const monotonic = g.performance ?? { now: () => Date.now() };
  return {
    monotonicNow: () => monotonic.now(),
    wallNow: () => Date.now(),
    setTimer(fn, ms) {
      const handle = g.setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer(handle) {
      g.clearTimeout(handle);
    },
  };
}

interface PendingTimer extends TimerHandle {
  readonly id: number;
  due: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/**
 * A deterministic {@link Clock} for tests. Time only moves when
 * {@link ManualClock.advance} is called; timers due at or before the
 * requested point fire in due-order (earliest first, ties broken by
 * scheduling order), and each firing is followed by a microtask flush so a
 * promise chain the callback settles (for example the drain-timeout race in
 * `lease-engine.ts`) has a chance to progress before the next timer fires.
 * `monotonicNow()` and `wallNow()` both advance together; nothing in this
 * package's tests depends on them diverging.
 */
export class ManualClock implements Clock {
  private now: number;
  private nextId = 1;
  private readonly timers: PendingTimer[] = [];

  constructor(initial = 0) {
    this.now = initial;
  }

  monotonicNow(): number {
    return this.now;
  }

  wallNow(): number {
    return this.now;
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    const timer: PendingTimer = {
      id: this.nextId++,
      due: this.now + Math.max(0, ms),
      fn,
      cancelled: false,
    };
    this.timers.push(timer);
    // The PendingTimer itself is handed back as the opaque handle (it has
    // no `unref`, which is optional on TimerHandle) so `clearTimer` can
    // cancel it by identity without a separate id-tracking structure.
    return timer;
  }

  clearTimer(handle: TimerHandle): void {
    (handle as PendingTimer).cancelled = true;
  }

  /**
   * Advances virtual time by `ms`, firing every timer due at or before the
   * new time, in due order, awaiting a microtask flush after each so
   * callbacks that resolve promises (used by the handoff-drain race) settle
   * before the next timer is considered.
   */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const next = this.dueTimer(target);
      if (!next) break;
      this.now = next.due;
      next.cancelled = true; // one-shot: mark fired so it is never picked again
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }

  private dueTimer(target: number): PendingTimer | null {
    let best: PendingTimer | null = null;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.due > target) continue;
      if (!best || timer.due < best.due || (timer.due === best.due && timer.id < best.id))
        best = timer;
    }
    return best;
  }
}

/** Convenience factory for {@link ManualClock}, mirroring {@link createSystemClock}'s naming. */
export function createManualClock(initial = 0): ManualClock {
  return new ManualClock(initial);
}
