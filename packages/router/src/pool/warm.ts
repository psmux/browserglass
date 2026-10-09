/**
 * Warm pool sizing and reconciliation.
 * The reconciler owns per pool arrival rate and cold launch time EWMAs and
 * decides how many warm instances a pool wants; it never launches directly,
 * it calls an injected `launchWarm` (supplied by `BrowserRouter`, which
 * alone holds the placement, profile leasing, and node launch machinery).
 */

import type { PoolId, TenantId, WarmPolicy } from '@browserglass/protocol';
import type { Clock, ClockTimer } from '../router/clock.js';
import { RateEwma, ValueEwma } from './ewma.js';

/**
 * `desired(pool, t)`:
 * `clamp(ceil(arrivalRate * meanColdLaunchSec * safetyFactor), warm.min, warm.max)`,
 * with `minAcquiresPerMinute` suppressing warming entirely for a barely
 * used pool (returns `0`, ignoring `warm.min`, since keeping a warm
 * instance around for a pool nobody is acquiring from wastes exactly the
 * resource warming exists to save). `meanColdLaunchSec` is floored at 0.5
 * and capped at 30 before use.
 */
export function desiredWarmCount(
  warm: WarmPolicy,
  arrivalRatePerSec: number,
  meanColdLaunchSecRaw: number,
  safetyFactor: number,
): number {
  const arrivalPerMinute = arrivalRatePerSec * 60;
  if (arrivalPerMinute < warm.minAcquiresPerMinute) return 0;
  const meanColdLaunchSec = Math.min(30, Math.max(0.5, meanColdLaunchSecRaw));
  const raw = Math.ceil(arrivalRatePerSec * meanColdLaunchSec * safetyFactor);
  return Math.min(warm.max, Math.max(warm.min, raw));
}

/** Per pool EWMA state, `arrivalRate` half life 300s and `meanColdLaunchSec` half life 900s. */
class PoolWarmState {
  readonly arrivalRate = new RateEwma(300_000);
  readonly coldLaunchSec = new ValueEwma(900_000);
}

/**
 * A pool identity: `Pool.id` alone is not enough to call back into
 * `Store` (`getPool`/`listInstances` are always scoped to a `tenantId`),
 * so the reconciler keys everything on the pair.
 */
export interface PoolRef {
  tenantId: TenantId;
  poolId: PoolId;
}

function poolKey(ref: PoolRef): string {
  return `${ref.tenantId} ${ref.poolId}`;
}

/** What the reconciler asks `BrowserRouter` to do: launch one warm instance for `ref`. */
export type LaunchWarmFn = (ref: PoolRef) => Promise<void>;

/** How many currently warm instances a pool has right now, so the reconciler knows how many more (if any) it wants. */
export type CurrentWarmCountFn = (ref: PoolRef) => Promise<number>;

/**
 * Runs the warm pool sizing loop: every `warmReconcileMs`, for every
 * tracked pool, computes `desired(pool, t)` and launches up to
 * `warmLaunchBurst` replacements toward it (the anti thundering herd cap,
 * which single node matters even more, it is the only defence against a
 * launch storm since there is no second node to spread to). Also exposes
 * `preWarmOnRelease`, called directly by `BrowserRouter.release` rather
 * than waiting for the next tick, since immediate pre-warming on release
 * does more for p50 acquire latency than anything else here.
 */
export class WarmPoolReconciler {
  private readonly stateByPool = new Map<string, PoolWarmState>();
  private timer: ClockTimer | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly warmReconcileMs: number,
    private readonly warmLaunchBurst: number,
    private readonly safetyFactor: number,
    private readonly currentWarmCount: CurrentWarmCountFn,
    private readonly launchWarm: LaunchWarmFn,
  ) {}

  private stateFor(ref: PoolRef): PoolWarmState {
    const key = poolKey(ref);
    let state = this.stateByPool.get(key);
    if (!state) {
      state = new PoolWarmState();
      this.stateByPool.set(key, state);
    }
    return state;
  }

  /** Feeds one acquire arrival into `ref`'s arrival rate EWMA. */
  recordAcquireArrival(ref: PoolRef): void {
    this.stateFor(ref).arrivalRate.recordArrival(this.clock.now());
  }

  /** Feeds one observed cold launch duration (seconds) into `ref`'s EWMA. */
  recordColdLaunch(ref: PoolRef, seconds: number): void {
    this.stateFor(ref).coldLaunchSec.observe(this.clock.now(), seconds);
  }

  /** `desired(pool, t)` for `ref` right now, from its current EWMA state. */
  desiredFor(warm: WarmPolicy, ref: PoolRef): number {
    const state = this.stateFor(ref);
    return desiredWarmCount(
      warm,
      state.arrivalRate.ratePerSec(),
      state.coldLaunchSec.value(0.5),
      this.safetyFactor,
    );
  }

  /** Reconciles one pool toward its desired warm count, launching at most `warmLaunchBurst` this call. */
  async reconcilePool(ref: PoolRef, warm: WarmPolicy): Promise<number> {
    const desired = this.desiredFor(warm, ref);
    const current = await this.currentWarmCount(ref);
    const deficit = Math.max(0, desired - current);
    const toLaunch = Math.min(deficit, this.warmLaunchBurst);
    for (let i = 0; i < toLaunch; i++) {
      await this.launchWarm(ref);
    }
    return toLaunch;
  }

  /**
   * Pre-warm on release: called immediately after an instance releases,
   * outside the normal reconcile tick. Launches at most one replacement,
   * only if the pool is currently below its desired count.
   */
  async preWarmOnRelease(ref: PoolRef, warm: WarmPolicy): Promise<void> {
    const desired = this.desiredFor(warm, ref);
    const current = await this.currentWarmCount(ref);
    if (current < desired) await this.launchWarm(ref);
  }

  /** Starts the periodic reconcile tick. `pools()` is re-read on every tick, so newly created pools are picked up without restarting the reconciler. */
  start(pools: () => Promise<readonly { ref: PoolRef; warm: WarmPolicy }[]>): void {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => {
      void (async () => {
        for (const { ref, warm } of await pools()) {
          await this.reconcilePool(ref, warm);
        }
      })();
    }, this.warmReconcileMs);
  }

  /** Stops the periodic reconcile tick. */
  stop(): void {
    if (this.timer) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
