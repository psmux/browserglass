/**
 * `RecoveryRunner`: drives one Instance's recovery ladder end to end,
 * automatically through `R3`, with seven required properties:
 *
 * 1. Re-entrancy guard: concurrent recoveries on one target are
 *    catastrophic (`SingleFlight` at target scope, `trigger()`).
 * 2. Per-rung timeout raced against a deadline (`RUNG_TIMEOUT_MS`,
 *    `raceRung()`).
 * 3. A rung failure does not abort the ladder: caught and the loop
 *    continues to the next rung.
 * 4. Watchdog reset plus cooldown on success: reported via `onRecovered`,
 *    which a caller wires to `FrameStalenessWatchdog.noteRecoverySuccess`.
 * 5. The lock scope switches from target to instance at exactly the `R3`
 *    to `R4` boundary: `trigger()` (the automatic `R0` to `R3` ladder) uses
 *    the target-scope `SingleFlight`; `restartInstance()` (`R4`, manual
 *    only) uses a separate, instance-scope `SingleFlight`.
 * 6. Per-rung progress reporting (`onProgress`, matching `instance.recovering`'s
 *    `{rung, attempt, of, etaMs}` shape).
 * 7. Input cancels recovery except when the signal is `renderer_hung`
 *    (`cancelOnInput()`).
 */

import type { RecoveryRung } from '@browserglass/protocol';
import type { Clock } from '../control/clock.js';
import { createSystemClock } from '../control/clock.js';
import type { CrashBudget, CrashCondition } from './crash-budget.js';
import type { SingleFlight } from './single-flight.js';
import {
  type AutomaticRung,
  CRASH_LOOP_SIGNALS,
  RUNG_TIMEOUT_MS,
  type RecoveredEvent,
  type RecoveryOutcome,
  type RecoveryProgressEvent,
  type RecoverySignal,
  type RecoveryTarget,
  type UnrecoverableEvent,
  automaticLadderFor,
} from './types.js';

/** Constructor options for {@link RecoveryRunner}. */
export interface RecoveryRunnerOptions {
  readonly instanceId: string;
  readonly clock?: Clock;
  /** Target-scope re-entrancy guard, keyed `${instanceId}:${targetId}`. Guards `R0` to `R3`. Shared across every target of this instance. */
  readonly targetFlight: SingleFlight<string>;
  /** Instance-scope re-entrancy guard, keyed `instanceId` alone. Guards `R4`. */
  readonly instanceFlight: SingleFlight<string>;
  readonly crashBudget?: CrashBudget;
  /** Step 3 of the crash budget's third escalating condition: quarantine the profile before the `R3` recreate. Optional; core has no profile-management access of its own. */
  readonly quarantineProfile?: (targetId: string) => void | Promise<void>;
  readonly onProgress?: (evt: RecoveryProgressEvent) => void;
  readonly onRecovered?: (evt: RecoveredEvent) => void;
  readonly onUnrecoverable?: (evt: UnrecoverableEvent) => void;
}

/** Drives the recovery ladder for every target of one Instance. See the module doc for the seven required properties. */
export class RecoveryRunner {
  private readonly opts: RecoveryRunnerOptions;
  private readonly clock: Clock;
  /** Targets with an in-flight (locally observed) recovery run; also doubles as the input-cancellation flag. */
  private readonly recovering = new Map<string, RecoverySignal>();

  constructor(opts: RecoveryRunnerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? createSystemClock();
  }

  /** Whether `targetId` currently has a recovery run in flight. */
  isRecovering(targetId: string): boolean {
    return this.recovering.has(targetId);
  }

  /** The signal driving `targetId`'s in-flight recovery, if any. */
  currentSignal(targetId: string): RecoverySignal | undefined {
    return this.recovering.get(targetId);
  }

  /**
   * Input arrived for `targetId`. Cancels its in-flight recovery unless the
   * active signal is `renderer_hung` (input during a genuine hang proves
   * nothing: it goes nowhere). Returns `true` when a cancellation actually
   * happened. Does not abort an already-running rung's own `await`; it only
   * stops the ladder from proceeding to its next rung.
   */
  cancelOnInput(targetId: string): boolean {
    const signal = this.recovering.get(targetId);
    if (!signal || signal === 'renderer_hung') {
      return false;
    }
    this.recovering.delete(targetId);
    return true;
  }

  /**
   * Triggers recovery for `target` under `signal`. Two simultaneous callers
   * for the same target coalesce onto one ladder run via the target-scope
   * `SingleFlight`; the loser gets `'waited'` back and, per the module's
   * critical rule, re-derives its own health with `target.probeHung()`
   * rather than trusting the winner's outcome.
   */
  async trigger(target: RecoveryTarget, signal: RecoverySignal): Promise<RecoveryOutcome> {
    const key = target.targetId;
    let outcome: RecoveryOutcome = { kind: 'unrecoverable', signal };

    const flightResult = await this.opts.targetFlight.run(key, async () => {
      outcome = await this.runLadder(target, signal);
    });

    if (flightResult === 'waited') {
      const stillHung = await target.probeHung().catch(() => true);
      return { kind: stillHung ? 'rederived_unhealthy' : 'rederived_healthy', signal };
    }
    return outcome;
  }

  /**
   * `R4`, manual only (`instance.restart`), instance-scope single-flight:
   * the lock scope switch this module's property 5 requires. Concurrent
   * callers coalesce onto one restart; a joiner gets back `'rederived_healthy'`
   * meaning "a restart ran, re-check your own target" rather than an
   * assumed outcome of its own.
   */
  async restartInstance(execute: () => Promise<boolean>): Promise<RecoveryOutcome> {
    const key = this.opts.instanceId;
    let ok = false;
    const flightResult = await this.opts.instanceFlight.run(key, async () => {
      ok = await execute().catch(() => false);
    });
    if (flightResult === 'waited') {
      return { kind: 'rederived_healthy', signal: 'browser_dead', rung: 'R4' };
    }
    return { kind: ok ? 'recovered' : 'unrecoverable', signal: 'browser_dead', rung: 'R4' };
  }

  private async runLadder(
    target: RecoveryTarget,
    signal: RecoverySignal,
  ): Promise<RecoveryOutcome> {
    const key = target.targetId;
    this.recovering.set(key, signal);

    try {
      let crashCondition: CrashCondition | undefined;
      if (this.opts.crashBudget && CRASH_LOOP_SIGNALS.has(signal)) {
        const result = this.opts.crashBudget.recordCrash(key, this.clock.wallNow());
        if (result.exceeded) {
          const evt: UnrecoverableEvent = {
            targetId: key,
            signal,
            triedRungs: [],
            crashConditionsTried: result.triedSoFar,
          };
          this.opts.onUnrecoverable?.(evt);
          return { kind: 'crash_budget_exceeded', signal };
        }
        crashCondition = result.condition;
      }

      const rungs = automaticLadderFor(signal);
      let attempt = 0;
      for (const rung of rungs) {
        attempt += 1;
        if (!this.recovering.has(key)) {
          // Cancelled by input mid-ladder (guaranteed not `renderer_hung`; see `cancelOnInput`).
          return { kind: 'cancelled_by_input', signal };
        }
        this.opts.onProgress?.({
          targetId: key,
          rung,
          attempt,
          of: rungs.length,
          etaMs: RUNG_TIMEOUT_MS[rung],
          signal,
        });

        const ok = await this.raceRung(rung, () => this.runRung(target, rung, crashCondition));
        if (ok) {
          const evt: RecoveredEvent = { targetId: key, rung, signal };
          this.opts.onRecovered?.(evt);
          return { kind: 'recovered', rung, signal };
        }
        // Rung failure: caught inside `raceRung`, proceed to the next rung rather than aborting.
      }

      // Ladder exhausted (within this build's automatic scope). Defensive
      // probe before declaring unrecoverable: if the renderer answers, go
      // back to live.
      const stillHung = await target.probeHung().catch(() => true);
      if (!stillHung) {
        const lastRung: RecoveryRung =
          rungs.length > 0 ? (rungs[rungs.length - 1] as RecoveryRung) : 'R0';
        const evt: RecoveredEvent = { targetId: key, rung: lastRung, signal };
        this.opts.onRecovered?.(evt);
        return { kind: 'exhausted_but_alive', signal };
      }
      const evt: UnrecoverableEvent = { targetId: key, signal, triedRungs: rungs };
      this.opts.onUnrecoverable?.(evt);
      return { kind: 'unrecoverable', signal };
    } finally {
      this.recovering.delete(key);
    }
  }

  private async runRung(
    target: RecoveryTarget,
    rung: AutomaticRung,
    crashCondition: CrashCondition | undefined,
  ): Promise<boolean> {
    switch (rung) {
      case 'R0':
        return target.restartScreencast();
      case 'R1':
        return target.reattachSession();
      case 'R2':
        return target.reloadPage();
      case 'R3': {
        const wantsBlank =
          crashCondition === 'blank_url' || crashCondition === 'quarantine_profile';
        if (crashCondition === 'quarantine_profile' && this.opts.quarantineProfile) {
          await this.opts.quarantineProfile(target.targetId);
        }
        const url = wantsBlank ? null : target.currentUrl();
        return target.recreateTarget(url);
      }
    }
  }

  /** Races one rung against its {@link RUNG_TIMEOUT_MS} deadline; a timeout OR a rejection both resolve `false` (a failure), never rejecting the caller. */
  private raceRung(rung: AutomaticRung, fn: () => Promise<boolean>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = this.clock.setTimer(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, RUNG_TIMEOUT_MS[rung]);

      fn().then(
        (ok) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimer(timer);
          resolve(ok);
        },
        () => {
          if (settled) return;
          settled = true;
          this.clock.clearTimer(timer);
          resolve(false);
        },
      );
    });
  }
}
