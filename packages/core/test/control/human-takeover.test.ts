/**
 * A person taking a browser back off automation, in both lease modes.
 *
 * Three behaviours share this file because they are one story told at three
 * points: `PreemptReason` finally distinguishing a person from a peer, the
 * `minHoldMs` floor no longer making that person wait behind an agent, and
 * `control.yield`, which is how the same thing happens on a shared target
 * where there is no preemption machine to use.
 *
 * Every timing case runs on the injected `ManualClock`, never real time. The
 * whole question in most of them is WHICH deadline fired and WHOSE tenure it
 * took down, and a real time test cannot tell "the right one expired" from
 * "everything expired".
 */

import { describe, expect, it } from 'vitest';
import { type TimerHandle, createManualClock } from '../../src/control/clock.js';
import { CONTROL_TIMING } from '../../src/control/constants.js';
import {
  ControlLeaseEngine,
  type ControlLeaseEngineOptions,
} from '../../src/control/lease-engine.js';
import type {
  LeaseAuditNote,
  LeaseBroadcastEffect,
  LeaseDirectEffect,
  LeaseEffect,
  ViewerRef,
} from '../../src/control/types.js';

/** Yields to the macrotask queue so every pending microtask has drained. */
function flushAll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function human(viewerId: string, overrides: Partial<ViewerRef> = {}): ViewerRef {
  return {
    viewerId,
    identity: `sub:${viewerId}`,
    label: viewerId,
    kind: 'human',
    isAdmin: false,
    ...overrides,
  };
}

function agent(viewerId: string, overrides: Partial<ViewerRef> = {}): ViewerRef {
  return {
    viewerId,
    identity: `sub:${viewerId}`,
    label: viewerId,
    kind: 'agent',
    isAdmin: false,
    ...overrides,
  };
}

/**
 * A clock whose WALL reading sits a real Unix epoch above its MONOTONIC one,
 * which is what every production `Clock` looks like (`Date.now()` against
 * `performance.now()`) and what `ManualClock` deliberately is not: it answers
 * both questions with the same number, so a unit mix-up between the two is
 * invisible to every other test in this package.
 *
 * `minHoldMs` is the arithmetic that mix-up destroys. It compares
 * `PolicyContext.now` against a monotonic `LeaseHolder.grantedAt`, so handing
 * the policy a wall reading makes the difference roughly the epoch itself and
 * the floor unconditionally satisfied. Reverting `requestControl` to
 * `wallNow()` fails the two cases below and nothing else in the package,
 * which is exactly why the bug survived until now.
 */
function skewedClock(epochOffset = 1_700_000_000_000) {
  const base = createManualClock();
  return {
    monotonicNow: () => base.monotonicNow(),
    wallNow: () => base.wallNow() + epochOffset,
    setTimer: (fn: () => void, ms: number): TimerHandle => base.setTimer(fn, ms),
    clearTimer: (handle: TimerHandle) => base.clearTimer(handle),
    advance: (ms: number) => base.advance(ms),
  };
}

function isDirect(effect: LeaseEffect): effect is LeaseDirectEffect {
  return effect.to !== 'broadcast';
}

function isBroadcast(effect: LeaseEffect): effect is LeaseBroadcastEffect {
  return effect.to === 'broadcast';
}

function harness(overrides: Partial<ControlLeaseEngineOptions> = {}) {
  const clock = overrides.clock ?? createManualClock();
  const effects: LeaseEffect[] = [];
  const auditNotes: LeaseAuditNote[] = [];
  const releasedHeld: Array<{ targetId: string; viewerId: string }> = [];
  const engine = new ControlLeaseEngine({
    sessionId: 'sess_1',
    targetId: 'tgt_1',
    clock,
    emit: (effect) => effects.push(effect),
    onAudit: (note) => auditNotes.push(note),
    releaseHeld: (targetId, viewerId) => {
      releasedHeld.push({ targetId, viewerId });
    },
    ...overrides,
  });
  return {
    clock: clock as ReturnType<typeof createManualClock>,
    effects,
    auditNotes,
    releasedHeld,
    engine,
  };
}

function sharedHarness(overrides: Partial<ControlLeaseEngineOptions> = {}) {
  return harness({ mode: 'shared', ...overrides });
}

function directTo(effects: readonly LeaseEffect[], viewerId: string): LeaseDirectEffect[] {
  return effects.filter(isDirect).filter((e) => e.to === viewerId);
}

function ofType<T extends string>(
  effects: readonly LeaseDirectEffect[],
  t: T,
): Array<Extract<LeaseDirectEffect['message'], { t: T }>> {
  return effects
    .filter(
      (e): e is LeaseDirectEffect & { message: Extract<LeaseDirectEffect['message'], { t: T }> } =>
        e.message.t === t,
    )
    .map((e) => e.message);
}

/** The most recent broadcast `control.state`, projected for `viewerId`. */
function latestState(effects: readonly LeaseEffect[], viewerId: string | null) {
  const broadcasts = effects.filter(isBroadcast);
  const last = broadcasts[broadcasts.length - 1];
  return last?.forViewer(viewerId).leases[0];
}

/** Every message type emitted by the preemption machine, whoever it went to. */
function preemptMessages(effects: readonly LeaseEffect[]): string[] {
  return effects
    .filter(isDirect)
    .map((e) => e.message.t)
    .filter((t) => t.startsWith('control.preempt'));
}

// ─────────────────────────────────────────────────────────────────────────
// 1. `human_takeover` is emitted, and only for the pairing it names.
// ─────────────────────────────────────────────────────────────────────────

describe('exclusive mode: the preempt reason names who is taking over from whom', () => {
  /** Grants `holder`, waits out `minHoldMs`, then lets `requester` preempt. Returns the reason the holder was told. */
  async function preemptReasonFor(
    holderViewer: ViewerRef,
    requesterViewer: ViewerRef,
    opts: { readonly priority?: number; readonly force?: boolean } = {},
  ) {
    const { clock, effects, engine } = harness();
    engine.requestControl(holderViewer);
    const leaseId = engine.getSnapshot().leaseId as string;
    await clock.advance(CONTROL_TIMING.minHoldMs + 1);
    effects.length = 0;

    engine.requestControl(requesterViewer, opts);
    expect(engine.getSnapshot().phase).toBe('preempt-pending');
    const requests = ofType(directTo(effects, holderViewer.viewerId), 'control.preempt.request');
    expect(requests).toHaveLength(1);

    // Let the grace lapse so `control.preempted` carries the reason too: the
    // two messages must agree, or a client that only listens for the second
    // learns something different from one that acts on the first.
    await clock.advance(CONTROL_TIMING.forceClaimNoticeMs + CONTROL_TIMING.agentPreemptGraceMs + 1);
    await flushAll();
    const preempted = ofType(directTo(effects, holderViewer.viewerId), 'control.preempted');
    expect(preempted).toHaveLength(1);
    expect(preempted[0]?.leaseId).toBe(leaseId);

    return {
      requestReason: requests[0]?.reason,
      preemptedReason: preempted[0]?.reason,
      graceMs: requests[0]?.graceMs,
    };
  }

  it("a human displacing an AGENT is 'human_takeover', on both messages", async () => {
    const seen = await preemptReasonFor(agent('vwr_bot'), human('vwr_alice'));
    expect(seen.requestReason).toBe('human_takeover');
    expect(seen.preemptedReason).toBe('human_takeover');
    // And it is the agent grace, not the force-claim notice.
    expect(seen.graceMs).toBe(CONTROL_TIMING.agentPreemptGraceMs);
  });

  it("a human displacing a HUMAN stays 'priority'", async () => {
    const seen = await preemptReasonFor(human('vwr_bob'), human('vwr_alice'), { priority: 200 });
    expect(seen.requestReason).toBe('priority');
    expect(seen.preemptedReason).toBe('priority');
  });

  it("an agent displacing an AGENT stays 'priority'", async () => {
    const seen = await preemptReasonFor(agent('vwr_bot1'), agent('vwr_bot2'), { priority: 200 });
    expect(seen.requestReason).toBe('priority');
    expect(seen.preemptedReason).toBe('priority');
  });

  it("an agent displacing a HUMAN stays 'priority': the value is about the requester, not merely about the holder", async () => {
    const seen = await preemptReasonFor(human('vwr_alice'), agent('vwr_bot'), { priority: 200 });
    expect(seen.requestReason).toBe('priority');
    expect(seen.preemptedReason).toBe('priority');
  });

  it("an admin force claim against an agent stays 'force_claim': an administrative act is not a person taking over", async () => {
    const seen = await preemptReasonFor(agent('vwr_bot'), human('vwr_admin', { isAdmin: true }), {
      force: true,
    });
    expect(seen.requestReason).toBe('force_claim');
    expect(seen.preemptedReason).toBe('force_claim');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. `minHoldMs` no longer makes a person wait behind an agent, and still
//    protects every other pairing.
// ─────────────────────────────────────────────────────────────────────────

describe('exclusive mode: minHoldMs is lifted for a human over an AGENT holder and for nothing else', () => {
  /** Grants `holderViewer`, then has `requesterViewer` ask `afterMs` later. Returns the resulting phase. */
  async function contendAfter(
    holderViewer: ViewerRef,
    requesterViewer: ViewerRef,
    afterMs: number,
    priority?: number,
  ) {
    const { clock, effects, engine } = harness();
    engine.requestControl(holderViewer);
    if (afterMs > 0) await clock.advance(afterMs);
    effects.length = 0;
    engine.requestControl(requesterViewer, priority !== undefined ? { priority } : {});
    return { phase: engine.getSnapshot().phase, effects, engine, clock };
  }

  it('CHANGED: a human takes over from an agent with no wait at all, at zero elapsed', async () => {
    const { phase, effects } = await contendAfter(agent('vwr_bot'), human('vwr_alice'), 0);
    expect(phase).toBe('preempt-pending');
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.preempt.request')).toHaveLength(1);
    // The person is told they are queued behind the grace, not denied.
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.queued')).toHaveLength(1);
  });

  it('CHANGED: still no wait one millisecond before minHoldMs would have elapsed', async () => {
    const { phase } = await contendAfter(
      agent('vwr_bot'),
      human('vwr_alice'),
      CONTROL_TIMING.minHoldMs - 1,
    );
    expect(phase).toBe('preempt-pending');
  });

  it('UNCHANGED: a human holder keeps the full minHoldMs against another human', async () => {
    const inside = await contendAfter(
      human('vwr_bob'),
      human('vwr_alice'),
      CONTROL_TIMING.minHoldMs - 1,
      200,
    );
    expect(inside.phase).toBe('held');
    expect(ofType(directTo(inside.effects, 'vwr_alice'), 'control.queued')).toHaveLength(1);
    expect(ofType(directTo(inside.effects, 'vwr_bob'), 'control.preempt.request')).toHaveLength(0);
  });

  it('UNCHANGED: a human holder keeps the full minHoldMs against an agent', async () => {
    const { phase, effects } = await contendAfter(
      human('vwr_alice'),
      agent('vwr_bot'),
      CONTROL_TIMING.minHoldMs - 1,
      200,
    );
    expect(phase).toBe('held');
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.preempt.request')).toHaveLength(0);
  });

  it('UNCHANGED: an agent holder keeps the full minHoldMs against ANOTHER AGENT', async () => {
    const { phase, effects } = await contendAfter(
      agent('vwr_bot1'),
      agent('vwr_bot2'),
      CONTROL_TIMING.minHoldMs - 1,
      200,
    );
    expect(phase).toBe('held');
    expect(ofType(directTo(effects, 'vwr_bot1'), 'control.preempt.request')).toHaveLength(0);
  });

  it('UNCHANGED: the floor still lifts on its own schedule for a human over a human', async () => {
    const { phase } = await contendAfter(
      human('vwr_bob'),
      human('vwr_alice'),
      CONTROL_TIMING.minHoldMs + 1,
      200,
    );
    expect(phase).toBe('preempt-pending');
  });

  it('lifting the floor grants no new preemption RIGHT: an agent ranked ABOVE a human still keeps the lease', async () => {
    // A deployment that has deliberately put automation above people on
    // `priority` gets what it configured. Only the WAIT was removed, never the
    // arbitration, so `priority > holder.priority` still has to pass on its
    // own and here it does not.
    const { effects, engine } = harness();
    engine.requestControl(agent('vwr_bot'), { priority: 500 });
    effects.length = 0;

    engine.requestControl(human('vwr_alice'));

    expect(engine.getSnapshot().phase).toBe('held');
    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_bot');
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.queued')).toHaveLength(1);
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.preempt.request')).toHaveLength(0);
  });

  it('the total wait for a person is agentPreemptGraceMs alone, not minHoldMs plus it', async () => {
    const { clock, effects, engine } = harness();
    engine.requestControl(agent('vwr_bot', { priority: 50 }));
    effects.length = 0;
    engine.requestControl(human('vwr_alice'));

    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs - 1);
    await flushAll();
    expect(engine.getSnapshot().phase).toBe('preempt-pending');
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.granted')).toHaveLength(0);

    await clock.advance(1);
    await flushAll();
    const granted = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    expect(granted).toHaveLength(1);
    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_alice');
  });
});

describe('minHoldMs is measured on the monotonic clock, never the wall clock', () => {
  it('a human holder keeps the floor against another human when the two readings are an epoch apart', async () => {
    const clock = skewedClock();
    const { effects, engine } = harness({ clock });
    engine.requestControl(human('vwr_bob'));
    await clock.advance(1);
    effects.length = 0;

    engine.requestControl(human('vwr_alice'), { priority: 200 });

    expect(engine.getSnapshot().phase).toBe('held');
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.queued')).toHaveLength(1);
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.preempt.request')).toHaveLength(0);
  });

  it('and still lets them through once the floor has genuinely elapsed', async () => {
    const clock = skewedClock();
    const { engine } = harness({ clock });
    engine.requestControl(human('vwr_bob'));
    await clock.advance(CONTROL_TIMING.minHoldMs + 1);

    engine.requestControl(human('vwr_alice'), { priority: 200 });

    expect(engine.getSnapshot().phase).toBe('preempt-pending');
  });
});

describe('an agent ranked below a human still cannot be preempted inside minHoldMs by an agent', () => {
  it('agent over agent waits, then succeeds once the floor lifts', async () => {
    const { clock, engine, effects } = harness();
    engine.requestControl(agent('vwr_bot1'));
    engine.requestControl(agent('vwr_bot2'), { priority: 200 });
    expect(engine.getSnapshot().phase).toBe('held');

    // The second agent is queued, so the eventual preempt comes from a fresh
    // request rather than from the queue entry: this asserts the floor, not
    // the queue.
    await clock.advance(CONTROL_TIMING.minHoldMs + 1);
    effects.length = 0;
    engine.requestControl(agent('vwr_bot3'), { priority: 300 });
    expect(engine.getSnapshot().phase).toBe('preempt-pending');
    expect(ofType(directTo(effects, 'vwr_bot1'), 'control.preempt.request')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. `control.yield`: shared mode's answer, which is not preemption.
// ─────────────────────────────────────────────────────────────────────────

describe('control.yield: refused where it does not apply', () => {
  it('an exclusive target answers not_shared and emits nothing', () => {
    const { effects, engine } = harness();
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;
    expect(engine.requestAgentYield(human('vwr_alice'))).toEqual({
      ok: false,
      error: 'not_shared',
    });
    expect(effects).toHaveLength(0);
  });

  it('an AGENT requester answers not_human: this is not how automation arbitrates against automation', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;
    expect(engine.requestAgentYield(agent('vwr_other_bot'))).toEqual({
      ok: false,
      error: 'not_human',
    });
    expect(effects).toHaveLength(0);
  });

  it('a target no agent is driving is a success with an empty list, not a failure', () => {
    const { engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));
    expect(engine.requestAgentYield(human('vwr_alice'))).toEqual({ ok: true, notified: [] });
  });
});

describe('control.yield: who is asked to stand down', () => {
  function threeDrivers() {
    const h = sharedHarness();
    h.engine.requestControl(human('vwr_alice'));
    h.engine.requestControl(agent('vwr_bot1'));
    h.engine.requestControl(human('vwr_bob'));
    h.engine.requestControl(agent('vwr_bot2'));
    return h;
  }

  it('every AGENT holder is asked and no HUMAN holder is, or even told', () => {
    const { effects, engine } = threeDrivers();
    const bot1Lease = ofType(directTo(effects, 'vwr_bot1'), 'control.granted')[0]?.leaseId;
    const bot2Lease = ofType(directTo(effects, 'vwr_bot2'), 'control.granted')[0]?.leaseId;
    effects.length = 0;

    const result = engine.requestAgentYield(human('vwr_alice'), { reason: 'taking this one' });
    expect(result).toEqual({ ok: true, notified: ['vwr_bot1', 'vwr_bot2'] });

    const bot1 = ofType(directTo(effects, 'vwr_bot1'), 'control.yield.request');
    const bot2 = ofType(directTo(effects, 'vwr_bot2'), 'control.yield.request');
    expect(bot1).toHaveLength(1);
    expect(bot2).toHaveLength(1);
    expect(directTo(effects, 'vwr_bob')).toHaveLength(0);
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.yield.request')).toHaveLength(0);

    // Each agent is told to release ITS OWN lease, never the primary
    // holder's, which here belongs to a person entirely uninvolved.
    expect(bot1[0]?.leaseId).toBe(bot1Lease);
    expect(bot2[0]?.leaseId).toBe(bot2Lease);
    expect(bot1[0]?.leaseId).not.toBe(bot2[0]?.leaseId);
    expect(bot1[0]?.byViewerId).toBe('vwr_alice');
    expect(bot1[0]?.byLabel).toBe('vwr_alice');
    expect(bot1[0]?.reason).toBe('taking this one');
    expect(bot1[0]?.graceMs).toBe(CONTROL_TIMING.agentPreemptGraceMs);
  });

  it('the deadline is wall clock and the grace is the agent grace', () => {
    const clock = createManualClock(1_700_000_000_000);
    const { effects, engine } = sharedHarness({ clock });
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;
    engine.requestAgentYield(human('vwr_alice'));
    const notice = ofType(directTo(effects, 'vwr_bot'), 'control.yield.request')[0];
    expect(notice?.deadline).toBe(clock.wallNow() + CONTROL_TIMING.agentPreemptGraceMs);
  });

  it('the request is audited', () => {
    const { auditNotes, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    engine.requestAgentYield(human('vwr_alice'));
    expect(auditNotes.filter((n) => n.type === 'control.yieldRequested')).toHaveLength(1);
  });

  it('a second yield inside the grace neither re-notices nor moves the deadline', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;

    engine.requestAgentYield(human('vwr_alice'));
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs - 1);
    // Asking again with one millisecond left must not buy the agent another
    // two seconds, and must not cut the grace it is already spending.
    expect(engine.requestAgentYield(human('vwr_bob'))).toEqual({ ok: true, notified: [] });
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.yield.request')).toHaveLength(1);

    await clock.advance(1);
    await flushAll();
    expect(engine.isHolder('vwr_bot')).toBe(false);
  });
});

describe('control.yield: an agent that stands down inside the grace', () => {
  it('exits through its own release, and the deadline never fires against it', async () => {
    const { clock, effects, engine, releasedHeld } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    const botLease = ofType(directTo(effects, 'vwr_bot'), 'control.granted')[0]?.leaseId as string;

    engine.requestAgentYield(human('vwr_alice'));
    effects.length = 0;
    await clock.advance(500);
    await engine.release('vwr_bot', botLease);
    await flushAll();

    expect(engine.isHolder('vwr_bot')).toBe(false);
    expect(releasedHeld).toContainEqual({ targetId: 'tgt_1', viewerId: 'vwr_bot' });

    // Past the deadline the cancelled timer must stay cancelled: an agent
    // that did as it was asked is never also told it was taken down.
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs + 1);
    await flushAll();
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.revoked')).toHaveLength(0);
    expect(engine.isHolder('vwr_alice')).toBe(true);
  });

  it('an agent that releases and immediately asks again keeps its NEW tenure when the old deadline fires', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    const firstLease = ofType(directTo(effects, 'vwr_bot'), 'control.granted')[0]
      ?.leaseId as string;

    engine.requestAgentYield(human('vwr_alice'));
    await clock.advance(100);
    await engine.release('vwr_bot', firstLease);
    await flushAll();
    effects.length = 0;

    engine.requestControl(agent('vwr_bot'));
    const secondLease = ofType(directTo(effects, 'vwr_bot'), 'control.granted')[0]
      ?.leaseId as string;
    expect(secondLease).not.toBe(firstLease);

    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs + 1);
    await flushAll();
    expect(engine.holderFor('vwr_bot')?.leaseId).toBe(secondLease);
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.revoked')).toHaveLength(0);
  });
});

describe('control.yield: an agent that ignores the grace is stood down for it', () => {
  async function yieldedOut() {
    const h = sharedHarness();
    h.engine.requestControl(human('vwr_alice'));
    h.engine.requestControl(agent('vwr_bot'));
    h.engine.requestControl(human('vwr_bob'));
    const aliceLease = ofType(directTo(h.effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLease = ofType(directTo(h.effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;
    const botLease = ofType(directTo(h.effects, 'vwr_bot'), 'control.granted')[0]
      ?.leaseId as string;
    h.effects.length = 0;
    h.engine.requestAgentYield(human('vwr_alice'));
    return { ...h, aliceLease, bobLease, botLease };
  }

  it('keeps its lease and its seat for the whole grace', async () => {
    const { clock, engine } = await yieldedOut();
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs - 1);
    await flushAll();
    expect(engine.isHolder('vwr_bot')).toBe(true);
  });

  it("loses it at the deadline, with control.revoked reason 'human_takeover' naming the person", async () => {
    const { clock, effects, engine, releasedHeld, auditNotes, botLease } = await yieldedOut();
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs);
    await flushAll();

    const revoked = ofType(directTo(effects, 'vwr_bot'), 'control.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      reason: 'human_takeover',
      leaseId: botLease,
      byLabel: 'vwr_alice',
    });
    expect(engine.isHolder('vwr_bot')).toBe(false);
    // Its held buttons, modifiers and touches go with it: an agent removed
    // mid action must not leave a jammed pointer inside a page two people
    // are still driving.
    expect(releasedHeld).toContainEqual({ targetId: 'tgt_1', viewerId: 'vwr_bot' });
    expect(auditNotes.filter((n) => n.type === 'control.yieldEnforced')).toHaveLength(1);
  });

  it('SHARED STAYS SHARED: both human drivers keep driving, with the same leaseIds, and are never revoked', async () => {
    const { clock, effects, engine, aliceLease, bobLease } = await yieldedOut();
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs);
    await flushAll();

    expect(engine.holderFor('vwr_alice')?.leaseId).toBe(aliceLease);
    expect(engine.holderFor('vwr_bob')?.leaseId).toBe(bobLease);
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.revoked')).toHaveLength(0);
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.revoked')).toHaveLength(0);
    expect(engine.getSnapshot().phase).toBe('held');

    const state = latestState(effects, 'vwr_bob');
    expect(state?.holderViewerId).toBe('vwr_bob');
    expect(state?.holders.map((holder) => holder.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);
    expect(state?.holderCount).toBe(2);
  });

  it('a yielded agent is not punished: it can ask again and is granted immediately, with no queue', async () => {
    const { clock, effects, engine } = await yieldedOut();
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs);
    await flushAll();
    effects.length = 0;

    engine.requestControl(agent('vwr_bot'));
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.granted')).toHaveLength(1);
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.queued')).toHaveLength(0);
    expect(engine.getSnapshot().queue).toEqual([]);
  });

  it('the LAST driver being an agent leaves the target unheld rather than held by nobody', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;
    engine.requestAgentYield(human('vwr_alice'));
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs);
    await flushAll();

    expect(ofType(directTo(effects, 'vwr_bot'), 'control.revoked')[0]?.reason).toBe(
      'human_takeover',
    );
    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('unheld');
    expect(snapshot.holders).toEqual([]);
    expect(latestState(effects, null)?.holderCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. A viewer's kind changing under a live tenure (a reauth that adds or
//    removes `automation`).
// ─────────────────────────────────────────────────────────────────────────

describe('a reauth that changes a viewer kind ends the tenure granted under the old one', () => {
  it('HUMAN GAINS AUTOMATION: the tenure ends, with a reason of its own', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    const leaseId = engine.holderFor('vwr_alice')?.leaseId as string;
    effects.length = 0;

    const result = await engine.applyViewerKind('vwr_alice', 'agent');
    await flushAll();

    expect(result).toEqual({ ended: true });
    const revoked = ofType(directTo(effects, 'vwr_alice'), 'control.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.reason).toBe('kind_changed');
    expect(revoked[0]?.leaseId).toBe(leaseId);
    expect(engine.isHolder('vwr_alice')).toBe(false);
  });

  it('AGENT LOSES AUTOMATION: the same, in the other direction', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    const leaseId = engine.holderFor('vwr_bot')?.leaseId as string;
    effects.length = 0;

    const result = await engine.applyViewerKind('vwr_bot', 'human');
    await flushAll();

    expect(result).toEqual({ ended: true });
    const revoked = ofType(directTo(effects, 'vwr_bot'), 'control.revoked');
    expect(revoked[0]).toMatchObject({ reason: 'kind_changed', leaseId });
    expect(engine.isHolder('vwr_bot')).toBe(false);
  });

  it("is distinguishable from the control shrink path, which arrives as 'admin'", async () => {
    // `ManagedSession.applyCapabilityShrink` ends a lease through `revoke()`
    // when `control` is lost, and `revoke()` builds `reason: 'admin'`. Same
    // trigger (a reauth), two facts a client must be able to tell apart.
    const shrink = sharedHarness();
    shrink.engine.requestControl(human('vwr_alice'));
    shrink.effects.length = 0;
    await shrink.engine.revoke(
      human('bgls:system', { isAdmin: true, label: 'system' }),
      'vwr_alice',
      'capability_lost',
    );
    await flushAll();
    expect(ofType(directTo(shrink.effects, 'vwr_alice'), 'control.revoked')[0]?.reason).toBe(
      'admin',
    );

    const reclass = sharedHarness();
    reclass.engine.requestControl(human('vwr_alice'));
    reclass.effects.length = 0;
    await reclass.engine.applyViewerKind('vwr_alice', 'agent');
    await flushAll();
    expect(ofType(directTo(reclass.effects, 'vwr_alice'), 'control.revoked')[0]?.reason).toBe(
      'kind_changed',
    );
  });

  it('an unchanged kind is a no-op: the same tenure, the same leaseId, no message', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    const leaseId = engine.holderFor('vwr_bot')?.leaseId;
    effects.length = 0;

    expect(await engine.applyViewerKind('vwr_bot', 'agent')).toEqual({ ended: false });
    expect(effects).toHaveLength(0);
    expect(engine.holderFor('vwr_bot')?.leaseId).toBe(leaseId);
  });

  it('a viewer who holds nothing is a no-op', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    effects.length = 0;
    expect(await engine.applyViewerKind('vwr_bystander', 'agent')).toEqual({ ended: false });
    expect(effects).toHaveLength(0);
  });

  it('the other drivers of a shared target are untouched', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    engine.requestControl(human('vwr_bob'));
    const aliceLease = engine.holderFor('vwr_alice')?.leaseId;
    const bobLease = engine.holderFor('vwr_bob')?.leaseId;
    effects.length = 0;

    await engine.applyViewerKind('vwr_bot', 'human');
    await flushAll();

    expect(engine.holderFor('vwr_alice')?.leaseId).toBe(aliceLease);
    expect(engine.holderFor('vwr_bob')?.leaseId).toBe(bobLease);
    expect(directTo(effects, 'vwr_alice')).toHaveLength(0);
    expect(engine.getSnapshot().phase).toBe('held');
  });

  it('in exclusive mode the queue head is promoted, exactly as on any other exit', async () => {
    const { clock, effects, engine } = harness();
    engine.requestControl(agent('vwr_bot'));
    await clock.advance(10);
    engine.requestControl(human('vwr_alice'), { priority: 10 });
    expect(engine.getSnapshot().queue.map((entry) => entry.viewerId)).toEqual(['vwr_alice']);
    effects.length = 0;

    await engine.applyViewerKind('vwr_bot', 'human');
    await flushAll();

    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_alice');
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.granted')).toHaveLength(1);
  });

  it('the departing holder is swept, so a reclassified driver leaves no button held down', async () => {
    const { engine, releasedHeld } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    await engine.applyViewerKind('vwr_bot', 'human');
    await flushAll();
    expect(releasedHeld).toContainEqual({ targetId: 'tgt_1', viewerId: 'vwr_bot' });
  });

  it('survives a real disconnect and reconnect first: the reauth arrives with the lease back in held', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));
    const bobLease = engine.holderFor('vwr_bob')?.leaseId as string;

    engine.handleSocketClosed('vwr_bob');
    await clock.advance(200);
    expect(engine.handleReconnect('vwr_bob', true)).toEqual({ restored: true });
    expect(engine.holderFor('vwr_bob')?.leaseId).toBe(bobLease);
    effects.length = 0;

    // The reauth that came in on the resumed socket carried `automation`.
    await engine.applyViewerKind('vwr_bob', 'agent');
    await flushAll();

    expect(ofType(directTo(effects, 'vwr_bob'), 'control.revoked')[0]?.reason).toBe('kind_changed');
    expect(engine.isHolder('vwr_bob')).toBe(false);
    expect(engine.isHolder('vwr_alice')).toBe(true);
  });
});

describe('the stale kind is what control.yield and minHoldMs would have read', () => {
  it('a human who GAINED automation is asked to yield after re-requesting, where the stale record would have skipped them', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));

    await engine.applyViewerKind('vwr_bob', 'agent');
    await flushAll();
    engine.requestControl(agent('vwr_bob'));
    effects.length = 0;

    expect(engine.requestAgentYield(human('vwr_alice'))).toEqual({
      ok: true,
      notified: ['vwr_bob'],
    });
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.yield.request')).toHaveLength(1);
  });

  it('an agent that LOST automation is left alone by a yield after re-requesting, where the stale record would have stood them down', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));

    await engine.applyViewerKind('vwr_bot', 'human');
    await flushAll();
    engine.requestControl(human('vwr_bot'));
    effects.length = 0;

    expect(engine.requestAgentYield(human('vwr_alice'))).toEqual({ ok: true, notified: [] });
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.yield.request')).toHaveLength(0);
  });

  it('a re-granted tenure is arbitrated under the NEW kind: a human who gained automation loses the minHoldMs floor', async () => {
    const { clock, effects, engine } = harness();
    engine.requestControl(human('vwr_bob'));
    await clock.advance(10);

    await engine.applyViewerKind('vwr_bob', 'agent');
    await flushAll();
    engine.requestControl(agent('vwr_bob'));
    effects.length = 0;

    // Zero elapsed on the fresh tenure. Under the old kind this would queue.
    engine.requestControl(human('vwr_alice'));

    expect(engine.getSnapshot().phase).toBe('preempt-pending');
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.preempt.request')[0]?.reason).toBe(
      'human_takeover',
    );
  });
});

describe('a queue entry whose viewer kind changed is corrected in place, not dropped', () => {
  it('keeps its position and its priority, and carries the NEW kind onto the holder it becomes', async () => {
    const { clock, engine, effects } = harness();
    engine.requestControl(human('vwr_alice'));
    await clock.advance(10);
    engine.requestControl(human('vwr_first'), { priority: 20 });
    engine.requestControl(human('vwr_bob'), { priority: 10 });
    expect(engine.getSnapshot().queue.map((entry) => entry.viewerId)).toEqual([
      'vwr_first',
      'vwr_bob',
    ]);
    effects.length = 0;

    expect(await engine.applyViewerKind('vwr_bob', 'agent')).toEqual({ ended: false });

    const queue = engine.getSnapshot().queue;
    // Still queued, still second, still on the priority they asked with: an
    // operator action they cannot see must not move them in a line they can.
    expect(queue.map((entry) => entry.viewerId)).toEqual(['vwr_first', 'vwr_bob']);
    expect(queue[1]?.kind).toBe('agent');
    expect(queue[1]?.priority).toBe(10);
    expect(effects).toHaveLength(0);

    // And the correction survives all the way onto the holder record, which
    // is the only thing a queue entry's kind is ever used for.
    await engine.release('vwr_alice', engine.holderFor('vwr_alice')?.leaseId as string);
    await flushAll();
    await engine.release('vwr_first', engine.holderFor('vwr_first')?.leaseId as string);
    await flushAll();
    expect(engine.holderFor('vwr_bob')?.kind).toBe('agent');
  });

  it('is audited even when no tenure ended', async () => {
    const { auditNotes, clock, engine } = harness();
    engine.requestControl(human('vwr_alice'));
    await clock.advance(10);
    engine.requestControl(human('vwr_bob'), { priority: 10 });

    await engine.applyViewerKind('vwr_bob', 'agent');

    const notes = auditNotes.filter((note) => note.type === 'control.viewerKindChanged');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ viewerId: 'vwr_bob', kind: 'agent', endedTenure: false });
  });
});

describe('control.yield: the promises it must not break', () => {
  it('NOTHING from the preemption machine is emitted for a shared target, at any point in a yield', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    engine.requestAgentYield(human('vwr_alice'));
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs + 1);
    await flushAll();
    expect(preemptMessages(effects)).toEqual([]);
  });

  it('the queue stays empty and queuePosition stays null throughout', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    engine.requestAgentYield(human('vwr_alice'));
    await clock.advance(CONTROL_TIMING.agentPreemptGraceMs + 1);
    await flushAll();
    // `effects.filter(isBroadcast)` now also carries `control.contention`
    // broadcasts (a human joining an agent-held target crosses the
    // co-driving threshold), which have no `leases`: this loop is
    // specifically about `control.state`'s queue fields, so it skips
    // anything else `forViewer` returns rather than assuming every
    // broadcast is one.
    for (const broadcast of effects.filter(isBroadcast)) {
      const msg = broadcast.forViewer('vwr_bot');
      if (msg.t !== 'control.state') continue;
      const state = msg.leases[0];
      expect(state?.queue).toEqual([]);
      expect(state?.queueLength).toBe(0);
      expect(state?.queuePosition).toBeNull();
    }
  });

  it('a human simply STARTING TO DRIVE a shared target an agent holds yields nothing: the yield is explicit', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;

    engine.requestControl(human('vwr_alice'));

    expect(ofType(directTo(effects, 'vwr_bot'), 'control.yield.request')).toHaveLength(0);
    expect(engine.isHolder('vwr_bot')).toBe(true);
    expect(engine.isHolder('vwr_alice')).toBe(true);
    expect(latestState(effects, null)?.holderCount).toBe(2);
  });
});
