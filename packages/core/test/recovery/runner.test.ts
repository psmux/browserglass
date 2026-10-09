import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/control/clock.js';
import { CrashBudget } from '../../src/recovery/crash-budget.js';
import { RecoveryRunner, type RecoveryRunnerOptions } from '../../src/recovery/runner.js';
import { SingleFlight } from '../../src/recovery/single-flight.js';
import {
  RECOVERY_SIGNALS,
  RUNG_TIMEOUT_MS,
  type RecoveryTarget,
  automaticLadderFor,
  fullLadderFor,
} from '../../src/recovery/types.js';

/** A scriptable `RecoveryTarget` with every rung controllable per call. */
function fakeTarget(
  targetId: string,
  opts: { rungResult?: (rung: string, attempt: number) => boolean; hung?: boolean } = {},
): RecoveryTarget & { calls: string[] } {
  const calls: string[] = [];
  let restartAttempt = 0;
  let reattachAttempt = 0;
  let reloadAttempt = 0;
  let recreateAttempt = 0;
  const rungResult = opts.rungResult ?? (() => true);
  return {
    targetId,
    calls,
    async restartScreencast() {
      restartAttempt += 1;
      calls.push('R0');
      return rungResult('R0', restartAttempt);
    },
    async reattachSession() {
      reattachAttempt += 1;
      calls.push('R1');
      return rungResult('R1', reattachAttempt);
    },
    async reloadPage() {
      reloadAttempt += 1;
      calls.push('R2');
      return rungResult('R2', reloadAttempt);
    },
    async recreateTarget(url) {
      recreateAttempt += 1;
      calls.push(`R3:${url ?? 'blank'}`);
      return rungResult('R3', recreateAttempt);
    },
    async forceFrame() {
      calls.push('forceFrame');
      return true;
    },
    async probeHung() {
      calls.push('probeHung');
      return opts.hung ?? false;
    },
    currentUrl() {
      return 'https://example.com/page';
    },
  };
}

function makeRunner(overrides: Partial<RecoveryRunnerOptions> = {}) {
  const clock = createManualClock();
  const targetFlight = new SingleFlight<string>();
  const instanceFlight = new SingleFlight<string>();
  const progress: unknown[] = [];
  const recovered: unknown[] = [];
  const unrecoverable: unknown[] = [];
  const runner = new RecoveryRunner({
    instanceId: 'inst_1',
    clock,
    targetFlight,
    instanceFlight,
    onProgress: (e) => progress.push(e),
    onRecovered: (e) => recovered.push(e),
    onUnrecoverable: (e) => unrecoverable.push(e),
    ...overrides,
  });
  return { runner, clock, targetFlight, instanceFlight, progress, recovered, unrecoverable };
}

describe('automaticLadderFor / fullLadderFor', () => {
  it('every signal has a full ladder and an automatic (R0-R3) prefix of it', () => {
    for (const signal of RECOVERY_SIGNALS) {
      const full = fullLadderFor(signal);
      const auto = automaticLadderFor(signal);
      expect(full.slice(0, auto.length)).toEqual(auto);
      for (const rung of auto) {
        expect(['R0', 'R1', 'R2', 'R3']).toContain(rung);
      }
    }
  });

  it('selects the correct ladder for each of the eight signals', () => {
    expect(automaticLadderFor('screencast_silent')).toEqual(['R0', 'R1', 'R2', 'R3']);
    expect(automaticLadderFor('cdp_detached')).toEqual(['R1', 'R2', 'R3']);
    expect(automaticLadderFor('renderer_hung')).toEqual(['R2', 'R3']);
    expect(automaticLadderFor('target_crashed')).toEqual(['R2', 'R3']);
    expect(automaticLadderFor('browser_dead')).toEqual([]);
    expect(automaticLadderFor('profile_lease_lost')).toEqual([]);
    expect(automaticLadderFor('node_lost')).toEqual([]);
    expect(automaticLadderFor('disk_fatal')).toEqual([]);
  });
});

describe('RecoveryRunner.trigger', () => {
  it('recovers at the first rung that succeeds', async () => {
    const { runner } = makeRunner();
    const target = fakeTarget('t1');
    const outcome = await runner.trigger(target, 'screencast_silent');
    expect(outcome.kind).toBe('recovered');
    expect(outcome.rung).toBe('R0');
    expect(target.calls).toEqual(['R0']);
  });

  it('a rung failure proceeds to the next rung rather than aborting the ladder', async () => {
    const { runner } = makeRunner();
    const target = fakeTarget('t1', { rungResult: (rung) => rung === 'R2' });
    const outcome = await runner.trigger(target, 'screencast_silent');
    expect(outcome.kind).toBe('recovered');
    expect(outcome.rung).toBe('R2');
    expect(target.calls.filter((c) => c !== 'forceFrame')).toEqual(['R0', 'R1', 'R2']);
  });

  it('runs the defensive probe before declaring unrecoverable, and returns to live if it answers', async () => {
    const { runner, unrecoverable, recovered } = makeRunner();
    const target = fakeTarget('t1', { rungResult: () => false, hung: false });
    const outcome = await runner.trigger(target, 'screencast_silent');
    expect(outcome.kind).toBe('exhausted_but_alive');
    expect(unrecoverable).toHaveLength(0);
    expect(recovered).toHaveLength(1);
  });

  it('declares unrecoverable when every rung fails and the defensive probe confirms the hang', async () => {
    const { runner, unrecoverable } = makeRunner();
    const target = fakeTarget('t1', { rungResult: () => false, hung: true });
    const outcome = await runner.trigger(target, 'screencast_silent');
    expect(outcome.kind).toBe('unrecoverable');
    expect(unrecoverable).toHaveLength(1);
    expect((unrecoverable[0] as { triedRungs: string[] }).triedRungs).toEqual([
      'R0',
      'R1',
      'R2',
      'R3',
    ]);
  });

  it('a signal whose ladder is empty in this build (browser_dead) goes straight to the defensive probe', async () => {
    const { runner } = makeRunner();
    const target = fakeTarget('t1', { hung: false });
    const outcome = await runner.trigger(target, 'browser_dead');
    expect(outcome.kind).toBe('exhausted_but_alive');
    expect(target.calls).toEqual(['probeHung']);
  });

  it('two simultaneous detections on one target produce exactly one recovery run, and the loser re-derives its own health', async () => {
    const { runner } = makeRunner();
    let resolveR0!: (v: boolean) => void;
    let r0Calls = 0;
    const target: RecoveryTarget = {
      targetId: 't1',
      async restartScreencast() {
        r0Calls += 1;
        return new Promise<boolean>((resolve) => {
          resolveR0 = resolve;
        });
      },
      async reattachSession() {
        return true;
      },
      async reloadPage() {
        return true;
      },
      async recreateTarget() {
        return true;
      },
      async forceFrame() {
        return true;
      },
      async probeHung() {
        return false;
      },
      currentUrl() {
        return null;
      },
    };

    const first = runner.trigger(target, 'screencast_silent');
    // Let the first call actually start (enter the SingleFlight) before the second races in.
    await Promise.resolve();
    await Promise.resolve();
    const second = runner.trigger(target, 'screencast_silent');

    expect(r0Calls).toBe(1); // exactly one recovery run, not two.
    resolveR0(true);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.kind).toBe('recovered');
    // The loser did not just inherit "recovered": it re-derived its own
    // health via `probeHung()`, which this fake always answers `false`
    // (not hung), so it reports healthy through the re-derivation path.
    expect(secondOutcome.kind).toBe('rederived_healthy');
  });

  it('input cancels recovery, except when the signal is renderer_hung', async () => {
    const { runner } = makeRunner();
    const neverResolves = new Promise<boolean>(() => {});
    let r0Started = false;
    const target: RecoveryTarget = {
      targetId: 't1',
      async restartScreencast() {
        r0Started = true;
        return neverResolves;
      },
      async reattachSession() {
        return true;
      },
      async reloadPage() {
        return true;
      },
      async recreateTarget() {
        return true;
      },
      async forceFrame() {
        return true;
      },
      async probeHung() {
        return false;
      },
      currentUrl() {
        return null;
      },
    };

    const outcomePromise = runner.trigger(target, 'screencast_silent');
    await Promise.resolve();
    await Promise.resolve();
    expect(r0Started).toBe(true);
    expect(runner.isRecovering('t1')).toBe(true);

    const cancelled = runner.cancelOnInput('t1');
    expect(cancelled).toBe(true);
    expect(runner.isRecovering('t1')).toBe(false);
    // The in-flight R0 rung is not itself aborted (it never resolves in
    // this fake), so `trigger()`'s own promise intentionally stays pending;
    // the important, externally observable effect is that the ladder will
    // not proceed to further rungs once R0 eventually settles.
    void outcomePromise;
  });

  it('cancelOnInput is a no-op for renderer_hung: input during a genuine hang proves nothing', async () => {
    const { runner } = makeRunner();
    const neverResolves = new Promise<boolean>(() => {});
    const target: RecoveryTarget = {
      targetId: 't1',
      async restartScreencast() {
        return true;
      },
      async reattachSession() {
        return true;
      },
      async reloadPage() {
        return neverResolves;
      },
      async recreateTarget() {
        return true;
      },
      async forceFrame() {
        return true;
      },
      async probeHung() {
        return true;
      },
      currentUrl() {
        return null;
      },
    };
    const outcomePromise = runner.trigger(target, 'renderer_hung');
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.isRecovering('t1')).toBe(true);
    expect(runner.cancelOnInput('t1')).toBe(false);
    expect(runner.isRecovering('t1')).toBe(true);
    void outcomePromise;
  });
});

describe('RecoveryRunner rung timeout', () => {
  it('races each rung against its per-rung deadline and treats a timeout as a failure, proceeding to the next rung', async () => {
    const { runner, clock } = makeRunner();
    const target: RecoveryTarget = {
      targetId: 't1',
      async restartScreencast() {
        return new Promise<boolean>(() => {}); // never resolves: must be timed out, not awaited forever.
      },
      async reattachSession() {
        return true;
      },
      async reloadPage() {
        return true;
      },
      async recreateTarget() {
        return true;
      },
      async forceFrame() {
        return true;
      },
      async probeHung() {
        return false;
      },
      currentUrl() {
        return null;
      },
    };
    const outcomePromise = runner.trigger(target, 'screencast_silent');
    await clock.advance(RUNG_TIMEOUT_MS.R0 + 1);
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe('recovered');
    expect(outcome.rung).toBe('R1');
  });
});

describe('RecoveryRunner.restartInstance: lock scope switches from target to instance at the R3/R4 boundary', () => {
  it('restartInstance uses the instance-scope SingleFlight, independent of the target-scope one', async () => {
    const targetFlight = new SingleFlight<string>();
    const instanceFlight = new SingleFlight<string>();
    const clock = createManualClock();
    const runner = new RecoveryRunner({
      instanceId: 'inst_1',
      clock,
      targetFlight,
      instanceFlight,
    });

    let executions = 0;
    let resolveExec!: (v: boolean) => void;
    const execute = () =>
      new Promise<boolean>((resolve) => {
        executions += 1;
        resolveExec = resolve;
      });

    const first = runner.restartInstance(execute);
    await Promise.resolve();
    await Promise.resolve();
    const second = runner.restartInstance(execute);

    expect(executions).toBe(1); // coalesced at instance scope.
    expect(targetFlight.isRunning('inst_1')).toBe(false); // never touches the target-scope flight.
    expect(instanceFlight.isRunning('inst_1')).toBe(true);

    resolveExec(true);
    const [a, b] = await Promise.all([first, second]);
    expect(a.kind).toBe('recovered');
    expect(a.rung).toBe('R4');
    expect(b.kind).toBe('rederived_healthy');
  });

  it('a concurrent automatic (R0-R3) recovery on some target and a manual restartInstance do not block each other', async () => {
    const targetFlight = new SingleFlight<string>();
    const instanceFlight = new SingleFlight<string>();
    const clock = createManualClock();
    const runner = new RecoveryRunner({
      instanceId: 'inst_1',
      clock,
      targetFlight,
      instanceFlight,
    });
    const target = fakeTarget('t1');

    const ladderPromise = runner.trigger(target, 'screencast_silent');
    const restartPromise = runner.restartInstance(async () => true);
    const [ladderOutcome, restartOutcome] = await Promise.all([ladderPromise, restartPromise]);
    expect(ladderOutcome.kind).toBe('recovered');
    expect(restartOutcome.kind).toBe('recovered');
  });
});

describe('Crash budget: three restarts in ten minutes, each changing a condition, then unrecoverable', () => {
  it('a target that crashes on every load produces exactly three restarts then declares unrecoverable, not an infinite loop', async () => {
    const crashBudget = new CrashBudget();
    const { runner, unrecoverable } = makeRunner({ crashBudget });
    // R2 (reload) always "succeeds" in the sense of completing, but the
    // page immediately crashes again afterward in this scenario, so the
    // caller re-triggers `target_crashed` on every attempt; the ladder
    // itself never reports success for `target_crashed` here.
    const conditionsTried: string[] = [];
    const target = fakeTarget('t1', { rungResult: () => false, hung: true });

    for (let i = 0; i < 3; i += 1) {
      const outcome = await runner.trigger(target, 'target_crashed');
      expect(outcome.kind).toBe('unrecoverable');
    }
    expect(unrecoverable).toHaveLength(3);

    // A fourth crash: the budget is exhausted, so the ladder must not run
    // a fourth time at all.
    target.calls.length = 0;
    const fourth = await runner.trigger(target, 'target_crashed');
    expect(fourth.kind).toBe('crash_budget_exceeded');
    expect(target.calls).toEqual([]); // no rungs attempted: not an infinite loop.
    expect(unrecoverable).toHaveLength(4);
    const lastEvent = unrecoverable[3] as { crashConditionsTried?: string[] };
    expect(lastEvent.crashConditionsTried).toEqual(['plain', 'blank_url', 'quarantine_profile']);
    void conditionsTried;
  });

  it('R3 tries the current condition: plain (last URL), then blank, then quarantine plus blank', async () => {
    const crashBudget = new CrashBudget();
    const seenUrls: (string | null)[] = [];
    const quarantined: string[] = [];
    const { runner } = makeRunner({
      crashBudget,
      quarantineProfile: (targetId) => void quarantined.push(targetId),
    });
    const target: RecoveryTarget = {
      targetId: 't1',
      async restartScreencast() {
        return false;
      },
      async reattachSession() {
        return false;
      },
      async reloadPage() {
        return false;
      },
      async recreateTarget(url) {
        seenUrls.push(url);
        return false;
      },
      async forceFrame() {
        return true;
      },
      async probeHung() {
        return true;
      },
      currentUrl() {
        return 'https://example.com/crashy';
      },
    };
    await runner.trigger(target, 'target_crashed');
    await runner.trigger(target, 'target_crashed');
    await runner.trigger(target, 'target_crashed');
    expect(seenUrls).toEqual(['https://example.com/crashy', null, null]);
    expect(quarantined).toEqual(['t1']);
  });
});

describe('progress reporting', () => {
  it('reports per-rung progress matching {rung, attempt, of, etaMs}', async () => {
    const { runner, progress } = makeRunner();
    const target = fakeTarget('t1');
    await runner.trigger(target, 'cdp_detached');
    expect(progress).toEqual([
      {
        targetId: 't1',
        rung: 'R1',
        attempt: 1,
        of: 3,
        etaMs: RUNG_TIMEOUT_MS.R1,
        signal: 'cdp_detached',
      },
    ]);
  });
});
