/**
 * Exponentially weighted moving averages for warm pool sizing:
 * `arrivalRate` (acquires per second, half life 300s) and `meanColdLaunchSec` (per pool, half life 900s).
 * Continuous time decay, so observations do not need to arrive on a fixed
 * tick: the decay factor is derived from the elapsed time since the last
 * observation, `alpha = 1 - 0.5^(dt / halfLifeMs)`.
 */

/** An EWMA of a value stream (for example cold launch duration), continuous time decayed. */
export class ValueEwma {
  private current: number | null = null;
  private lastAt: number | null = null;

  constructor(private readonly halfLifeMs: number) {}

  /** Folds one new sample, taken at `now`, into the average. */
  observe(now: number, sample: number): void {
    if (this.current === null || this.lastAt === null) {
      this.current = sample;
      this.lastAt = now;
      return;
    }
    const dt = Math.max(0, now - this.lastAt);
    const alpha = dt === 0 ? 0 : 1 - 0.5 ** (dt / this.halfLifeMs);
    this.current = this.current + alpha * (sample - this.current);
    this.lastAt = now;
  }

  /** The current average, or `fallback` when no observation has ever been made. */
  value(fallback: number): number {
    return this.current ?? fallback;
  }

  /** Whether at least one observation has been folded in. */
  hasValue(): boolean {
    return this.current !== null;
  }
}

/**
 * An EWMA of an *arrival rate* (events per second): each `recordArrival`
 * folds in the instantaneous rate implied by the gap since the previous
 * arrival, decayed the same continuous time way as `ValueEwma`.
 */
export class RateEwma {
  private readonly inner: ValueEwma;
  private lastArrivalAt: number | null = null;

  constructor(private readonly halfLifeMs: number) {
    this.inner = new ValueEwma(halfLifeMs);
  }

  /** Records one arrival event at `now`. The first call only seeds the clock; it takes two arrivals to produce a rate. */
  recordArrival(now: number): void {
    if (this.lastArrivalAt !== null) {
      const dt = Math.max(1, now - this.lastArrivalAt);
      const instantaneousPerSec = 1000 / dt;
      this.inner.observe(now, instantaneousPerSec);
    }
    this.lastArrivalAt = now;
  }

  /** The current arrival rate estimate, events per second. `0` before the second arrival. */
  ratePerSec(): number {
    return this.inner.value(0);
  }
}
