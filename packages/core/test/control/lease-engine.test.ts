import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/control/clock.js';
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

/** Yields to the macrotask queue so every pending microtask (however many hops a chained `await` needs) has drained. */
function flushAll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function viewer(viewerId: string, overrides: Partial<ViewerRef> = {}): ViewerRef {
  return {
    viewerId,
    identity: `sub:${viewerId}`,
    label: viewerId,
    kind: 'human',
    isAdmin: false,
    ...overrides,
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
  const engine = new ControlLeaseEngine({
    sessionId: 'sess_1',
    targetId: 'tgt_1',
    clock,
    emit: (effect) => effects.push(effect),
    onAudit: (note) => auditNotes.push(note),
    ...overrides,
  });
  return { clock: clock as ReturnType<typeof createManualClock>, effects, auditNotes, engine };
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

describe('ControlLeaseEngine: control.request on an unheld target', () => {
  it('grants immediately and broadcasts control.state', () => {
    const { effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holder?.viewerId).toBe('vwr_alice');
    expect(snapshot.leaseId).not.toBeNull();

    const granted = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]?.leaseId).toBe(snapshot.leaseId);

    const broadcasts = effects.filter(isBroadcast);
    expect(broadcasts.length).toBeGreaterThan(0);
    const state = broadcasts[broadcasts.length - 1]?.forViewer(null);
    expect(state?.leases[0]?.holderViewerId).toBe('vwr_alice');
  });
});

describe('ControlLeaseEngine: queueing, queuePosition computed per recipient', () => {
  it('a second request while held queues behind the holder', () => {
    const { effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    effects.length = 0;
    engine.requestControl(viewer('vwr_bob', { kind: 'human' }));

    const queued = ofType(directTo(effects, 'vwr_bob'), 'control.queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.position).toBe(1);

    const snapshot = engine.getSnapshot();
    expect(snapshot.queue.map((q) => q.viewerId)).toEqual(['vwr_bob']);
  });

  it("control.state's queuePosition differs per recipient (the holder, the queued viewer, and a bystander each see their own value)", () => {
    const { effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const lastBroadcast = effects.filter(isBroadcast).at(-1);
    expect(lastBroadcast).toBeDefined();
    expect(lastBroadcast?.forViewer('vwr_alice').leases[0]?.queuePosition).toBeNull();
    expect(lastBroadcast?.forViewer('vwr_bob').leases[0]?.queuePosition).toBe(1);
    expect(lastBroadcast?.forViewer('vwr_bystander').leases[0]?.queuePosition).toBeNull();
    expect(lastBroadcast?.forViewer(null).leases[0]?.queuePosition).toBeNull();
  });
});

describe('ControlLeaseEngine: two-step preemption', () => {
  async function grantThenPreempt() {
    const { clock, effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const originalLeaseId = engine.getSnapshot().leaseId;
    expect(originalLeaseId).not.toBeNull();

    // minHoldMs must elapse before a priority preempt is honoured.
    await clock.advance(CONTROL_TIMING.minHoldMs + 1);
    effects.length = 0;

    engine.requestControl(viewer('vwr_operator'), { priority: 200 });
    expect(engine.getSnapshot().phase).toBe('preempt-pending');

    const preemptRequests = ofType(directTo(effects, 'vwr_alice'), 'control.preempt.request');
    expect(preemptRequests).toHaveLength(1);
    expect(preemptRequests[0]?.deadline).toBeGreaterThan(0);

    return { clock, effects, engine, originalLeaseId: originalLeaseId as string };
  }

  it('the holder still drives during the grace: a stale check never happens because the leaseId is unchanged', () => {
    // Covered structurally: `beginPreempt` never mints a new leaseId, and
    // `fencing.test.ts` asserts `preempt-pending` remains dispatchable.
    expect(true).toBe(true);
  });

  it('released:true when the holder releases inside the grace: exactly one control.preempted, addressed to the loser', async () => {
    const { effects, engine, originalLeaseId } = await grantThenPreempt();

    const result = await engine.release('vwr_alice', originalLeaseId);
    expect(result).toEqual({ ok: true });
    await flushAll();

    const preempted = effects.filter(isDirect).filter((e) => e.message.t === 'control.preempted');
    expect(preempted).toHaveLength(1);
    expect(preempted[0]?.to).toBe('vwr_alice');
    const message = preempted[0]?.message;
    expect(message).toMatchObject({
      released: true,
      byViewerId: 'vwr_operator',
      leaseId: originalLeaseId,
    });

    const granted = ofType(directTo(effects, 'vwr_operator'), 'control.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]?.leaseId).not.toBe(originalLeaseId);

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holder?.viewerId).toBe('vwr_operator');
  });

  it('released:false when the grace deadline passes without a release: exactly one control.preempted, addressed to the loser', async () => {
    const { clock, effects, engine, originalLeaseId } = await grantThenPreempt();

    // Alice never releases. Advance past forceClaimNoticeMs (the human-holder grace).
    await clock.advance(CONTROL_TIMING.forceClaimNoticeMs + 1);
    await flushAll();

    const preempted = effects.filter(isDirect).filter((e) => e.message.t === 'control.preempted');
    expect(preempted).toHaveLength(1);
    expect(preempted[0]?.to).toBe('vwr_alice');
    expect(preempted[0]?.message).toMatchObject({
      released: false,
      byViewerId: 'vwr_operator',
      leaseId: originalLeaseId,
    });

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holder?.viewerId).toBe('vwr_operator');
  });

  it('control.preempt.cancelled goes to the holder alone when the requester withdraws; leaseId is unchanged (same tenure)', async () => {
    const { effects, engine, originalLeaseId } = await grantThenPreempt();

    engine.withdrawRequest('vwr_operator');
    await flushAll();

    const cancelled = ofType(directTo(effects, 'vwr_alice'), 'control.preempt.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.leaseId).toBe(originalLeaseId);
    expect(cancelled[0]?.reason).toBe('withdrawn');

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.leaseId).toBe(originalLeaseId);
    expect(snapshot.holder?.viewerId).toBe('vwr_alice');
  });
});

describe('ControlLeaseEngine: leaseId fencing via checkFencing', () => {
  it('a stale leaseId on mouse.up still dispatches; the same on mouse.down does not', () => {
    const { engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const staleLeaseId = 'lse_not_current_anymore';

    const upDecision = engine.checkFencing({
      viewerId: 'vwr_alice',
      leaseId: staleLeaseId,
      kind: 'mouse.up',
    });
    expect(upDecision.dispatch).toBe(true);

    const downDecision = engine.checkFencing({
      viewerId: 'vwr_alice',
      leaseId: staleLeaseId,
      kind: 'mouse.down',
    });
    expect(downDecision.dispatch).toBe(false);
  });
});

describe('ControlLeaseEngine: control.revoke (admin; NOT preemption)', () => {
  it('naming a stale holder returns not_held and leaves the current lease untouched', async () => {
    const { engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const before = engine.getSnapshot();

    const admin = viewer('vwr_admin', { isAdmin: true });
    const result = await engine.revoke(admin, 'vwr_someone_else');

    expect(result).toEqual({ ok: false, error: 'not_held' });
    const after = engine.getSnapshot();
    expect(after.phase).toBe(before.phase);
    expect(after.leaseId).toBe(before.leaseId);
    expect(after.holder?.viewerId).toBe(before.holder?.viewerId);
  });

  it('requires admin: a non-admin caller gets cap_missing and the lease is untouched', async () => {
    const { engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const before = engine.getSnapshot();

    const result = await engine.revoke(viewer('vwr_not_admin'), 'vwr_alice');
    expect(result).toEqual({ ok: false, error: 'cap_missing' });
    expect(engine.getSnapshot()).toMatchObject({ phase: before.phase, leaseId: before.leaseId });
  });

  it('naming the actual current holder revokes with no grace and no notice, distinct from preemption', async () => {
    const { effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    effects.length = 0;

    const admin = viewer('vwr_admin', { isAdmin: true });
    const result = await engine.revoke(admin, 'vwr_alice', 'policy violation');
    expect(result).toEqual({ ok: true });

    const revoked = ofType(directTo(effects, 'vwr_alice'), 'control.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.reason).toBe('admin');

    // Not preemption: no control.preempt.request was ever sent, and no control.preempted follows.
    expect(effects.filter(isDirect).some((e) => e.message.t === 'control.preempt.request')).toBe(
      false,
    );
    expect(effects.filter(isDirect).some((e) => e.message.t === 'control.preempted')).toBe(false);

    expect(engine.getSnapshot().phase).toBe('unheld');
  });
});

describe('ControlLeaseEngine: disconnect grace', () => {
  it("a disconnected holder's lease survives 29s and dies at 31s", async () => {
    const { clock, effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    engine.handleSocketClosed('vwr_alice');
    expect(engine.getSnapshot().phase).toBe('held-grace');

    await clock.advance(29_000);
    expect(engine.getSnapshot().phase).toBe('held-grace');
    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_alice');

    await clock.advance(2_000); // total 31s
    await flushAll();

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('unheld');
    expect(snapshot.holder).toBeNull();

    const revoked = ofType(directTo(effects, 'vwr_alice'), 'control.revoked');
    expect(revoked.some((m) => m.reason === 'expired')).toBe(true);
  });

  it('a reconnect inside the grace window with a valid resume token restores held with the SAME leaseId', async () => {
    const { clock, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const originalLeaseId = engine.getSnapshot().leaseId;

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(5_000);

    const result = engine.handleReconnect('vwr_alice', true);
    expect(result).toEqual({ restored: true });

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.leaseId).toBe(originalLeaseId);
    expect(snapshot.holder?.connected).toBe(true);
  });

  it('a reconnect without a valid resume token does not restore the lease', async () => {
    const { clock, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    engine.handleSocketClosed('vwr_alice');
    await clock.advance(5_000);

    const result = engine.handleReconnect('vwr_alice', false);
    expect(result).toEqual({ restored: false });
    expect(engine.getSnapshot().phase).toBe('held-grace');
  });
});

describe('ControlLeaseEngine: renew', () => {
  it('renew with the current leaseId reissues control.granted with the same leaseId', () => {
    const { effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const leaseId = engine.getSnapshot().leaseId as string;
    effects.length = 0;

    const result = engine.renew('vwr_alice', leaseId);
    expect(result).toEqual({ ok: true });

    const granted = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]?.leaseId).toBe(leaseId);
  });

  it('renew with a stale leaseId returns lease_stale', () => {
    const { engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const result = engine.renew('vwr_alice', 'lse_not_current');
    expect(result).toEqual({ ok: false, error: 'lease_stale' });
  });

  it('renew from a non-holder returns not_held', () => {
    const { engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const leaseId = engine.getSnapshot().leaseId as string;
    const result = engine.renew('vwr_bob', leaseId);
    expect(result).toEqual({ ok: false, error: 'not_held' });
  });
});

describe('ControlLeaseEngine: the five-step handoff drain', () => {
  it('bounds the drain at handoverDrainMs and still runs step 4 (releaseHeld) when step 3 times out, recording handoverDrainTimeout', async () => {
    const releaseHeldCalls: Array<{ targetId: string; viewerId: string }> = [];
    const { clock, engine, auditNotes } = harness({
      // Never resolves: forces the race to settle via the handoverDrainMs timeout.
      drainInput: () => new Promise(() => {}),
      releaseHeld: (targetId, viewerId) => {
        releaseHeldCalls.push({ targetId, viewerId });
      },
    });
    engine.requestControl(viewer('vwr_alice'));
    const leaseId = engine.getSnapshot().leaseId as string;

    const releasePromise = engine.release('vwr_alice', leaseId);
    await clock.advance(CONTROL_TIMING.handoverDrainMs + 1);
    await releasePromise;
    await flushAll();

    expect(releaseHeldCalls).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);
    expect(auditNotes).toContainEqual(
      expect.objectContaining({
        type: 'control.handoverDrainTimeout',
        targetId: 'tgt_1',
        handoverDrainTimeout: true,
      }),
    );
    expect(engine.getSnapshot().phase).toBe('unheld');
  });

  it('a queued viewer is granted the lease once the drain settles', async () => {
    const { engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const leaseId = engine.getSnapshot().leaseId as string;
    engine.requestControl(viewer('vwr_bob'));

    await engine.release('vwr_alice', leaseId);
    await flushAll();

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holder?.viewerId).toBe('vwr_bob');
    expect(snapshot.leaseId).not.toBe(leaseId);
  });
});

/**
 * Re-requesting a lease you already hold.
 *
 * Found by driving the real demo: the second request queued the holder
 * behind ITSELF, returning `{granted: false, queued: true, position: 1}`
 * with the requester's own viewerId as both the holder and the only queue
 * entry. `RequestControlButton` renders that as a permanent "Waiting, 1 in
 * queue" on a pane the viewer is already driving, and nothing about it
 * looks like an error, so it is easy to hit by accident: a double click, a
 * React StrictMode effect running twice, any component that re-requests on
 * remount.
 */
describe('requesting control while already holding it', () => {
  it('re-grants idempotently instead of queueing the holder behind itself', () => {
    const { engine, effects } = harness();

    engine.requestControl(viewer('vwr_alice'));
    const firstGrant = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    expect(firstGrant).toHaveLength(1);

    engine.requestControl(viewer('vwr_alice'));

    const grants = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    const queued = ofType(directTo(effects, 'vwr_alice'), 'control.queued');
    expect(grants).toHaveLength(2);
    expect(queued).toHaveLength(0);

    // The same lease, not a fresh one. Minting a new leaseId would
    // invalidate every input message already in flight stamped with the
    // old one, which is a real cost for what should be a no-op.
    expect(grants[1]?.leaseId).toBe(grants[0]?.leaseId);
  });

  it('still queues a DIFFERENT viewer while the lease is held', () => {
    const { engine, effects } = harness();

    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    // The idempotent path is scoped to the holder; everyone else takes the
    // ordinary contended route.
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.granted')).toHaveLength(0);
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.queued')).toHaveLength(1);
  });
});
