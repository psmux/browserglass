/**
 * `ControlLeaseEngine` under `mode: 'shared'`.
 *
 * `lease-engine.test.ts` covers the exclusive engine end to end and is left
 * alone; this file is the shared-mode half, and the last section of it is the
 * compatibility promise going the other way: with one holder, the exclusive
 * path must be byte for byte unchanged on the wire.
 *
 * Every timing case runs against the injected `ManualClock`, never real time,
 * because the whole point of per holder timers is WHICH holder a deadline
 * takes down, and a real-time test cannot tell "the right one expired" from
 * "everything expired".
 */

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

/** Yields to the macrotask queue so every pending microtask has drained. */
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

describe('shared mode: a second request is granted immediately, with nothing queued', () => {
  it('grants both viewers their OWN leaseId, in one synchronous call each', () => {
    const { effects, engine } = sharedHarness();

    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    const aliceGrants = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    const bobGrants = ofType(directTo(effects, 'vwr_bob'), 'control.granted');
    expect(aliceGrants).toHaveLength(1);
    expect(bobGrants).toHaveLength(1);
    expect(aliceGrants[0]?.leaseId).not.toBe(bobGrants[0]?.leaseId);
    expect(aliceGrants[0]?.mode).toBe('shared');

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);
  });

  it('queues NOTHING: "granted fast" and "granted without queueing" are different claims, and this asserts the second', () => {
    const { effects, engine } = sharedHarness();

    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    engine.requestControl(viewer('vwr_carol'));

    // No control.queued reached anybody.
    for (const who of ['vwr_alice', 'vwr_bob', 'vwr_carol']) {
      expect(ofType(directTo(effects, who), 'control.queued')).toHaveLength(0);
      expect(ofType(directTo(effects, who), 'control.denied')).toHaveLength(0);
    }
    // And the queue itself is empty on the record, not merely drained later.
    expect(engine.getSnapshot().queue).toEqual([]);
    for (const who of ['vwr_alice', 'vwr_bob', 'vwr_carol', null]) {
      const state = latestState(effects, who);
      expect(state?.queue).toEqual([]);
      expect(state?.queueLength).toBe(0);
      expect(state?.queuePosition).toBeNull();
    }
  });

  it('never emits a preemption message: nobody waits, so nobody preempts', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob', { kind: 'agent' }), { priority: 900 });

    const everyDirect = effects.filter(isDirect).map((e) => e.message.t);
    expect(everyDirect).not.toContain('control.preempt.request');
    expect(everyDirect).not.toContain('control.preempt.cancelled');
    expect(everyDirect).not.toContain('control.preempted');
  });

  it('re-requesting while already holding is idempotent: the same leaseId, no second holder', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    const first = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]?.leaseId;

    engine.requestControl(viewer('vwr_alice'));
    const grants = ofType(directTo(effects, 'vwr_alice'), 'control.granted');
    expect(grants).toHaveLength(2);
    expect(grants[1]?.leaseId).toBe(first);
    expect(engine.getSnapshot().holders).toHaveLength(1);
  });
});

describe('shared mode: force and queue:false have a defined answer', () => {
  it('force: true is a no-op: an admin joins as one more holder and displaces nobody', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]?.leaseId;

    engine.requestControl(viewer('vwr_admin', { isAdmin: true }), { force: true });

    const snapshot = engine.getSnapshot();
    expect(snapshot.holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_admin']);
    // Alice's tenure is untouched: same leaseId, no revoke, no preempt notice.
    expect(snapshot.holders[0]?.leaseId).toBe(aliceLeaseId);
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.revoked')).toHaveLength(0);
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.preempt.request')).toHaveLength(0);
  });

  it('queue: false is a no-op too: there is nothing to queue behind, so the request is simply granted', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'), { queue: false });

    expect(ofType(directTo(effects, 'vwr_bob'), 'control.granted')).toHaveLength(1);
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.denied')).toHaveLength(0);
    expect(engine.getSnapshot().holders).toHaveLength(2);
  });

  it('an admin revoke names ONE driver and leaves the others driving', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    const result = await engine.revoke(viewer('vwr_admin', { isAdmin: true }), 'vwr_bob');
    await flushAll();

    expect(result).toEqual({ ok: true });
    const revoked = ofType(directTo(effects, 'vwr_bob'), 'control.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.leaseId).toBe(bobLeaseId);
    expect(ofType(directTo(effects, 'vwr_alice'), 'control.revoked')).toHaveLength(0);

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holders.map((h) => h.viewerId)).toEqual(['vwr_alice']);
  });
});

describe('shared mode: the deployment veto', () => {
  it('timing.allowShared: false downgrades to exclusive, loudly, and the target queues again', () => {
    const { effects, auditNotes, engine } = harness({
      mode: 'shared',
      timing: { allowShared: false },
    });
    expect(engine.getMode()).toBe('exclusive');
    expect(auditNotes.map((n) => n.type)).toContain('control.sharedNotAllowed');

    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.queued')).toHaveLength(1);
  });
});

describe('shared mode: per holder timers', () => {
  it('one holder failing to renew loses only their own tenure; the other keeps driving', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    // Bob keeps renewing, roughly every half TTL; Alice never does. Only
    // Alice's renewal grace should ever fire.
    const step = CONTROL_TIMING.leaseTtlMs / 2;
    for (
      let elapsed = 0;
      elapsed < CONTROL_TIMING.leaseTtlMs + CONTROL_TIMING.renewGraceMs + step;
      elapsed += step
    ) {
      await clock.advance(step);
      engine.renew('vwr_bob', bobLeaseId);
    }
    await flushAll();

    const aliceRevoked = ofType(directTo(effects, 'vwr_alice'), 'control.revoked');
    expect(aliceRevoked.map((m) => m.reason)).toContain('expired');
    expect(aliceRevoked[0]?.leaseId).toBe(aliceLeaseId);
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.revoked')).toHaveLength(0);

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holders.map((h) => h.viewerId)).toEqual(['vwr_bob']);
    expect(snapshot.holders[0]?.leaseId).toBe(bobLeaseId);
  });

  it('idle release never fires on a shared target: nobody is waiting for it to fire for', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    // Well past idleReleaseMs (20s), but both keep renewing, so neither TTL
    // nor idle expiry is reached.
    for (let i = 0; i < 4; i++) {
      await clock.advance(CONTROL_TIMING.idleReleaseMs / 2);
      engine.renew('vwr_alice', aliceLeaseId);
      engine.renew('vwr_bob', bobLeaseId);
    }
    await flushAll();

    expect(ofType(directTo(effects, 'vwr_alice'), 'control.revoked')).toHaveLength(0);
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.revoked')).toHaveLength(0);
    expect(engine.getSnapshot().holders).toHaveLength(2);
  });

  it('one holder disconnecting starts THEIR grace while the lease stays held and the other drives on', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    engine.handleSocketClosed('vwr_alice');

    const midGrace = engine.getSnapshot();
    expect(midGrace.phase).toBe('held'); // NOT held-grace: bob never stopped driving
    expect(midGrace.holders.find((h) => h.viewerId === 'vwr_alice')?.connected).toBe(false);
    expect(midGrace.holders.find((h) => h.viewerId === 'vwr_bob')?.connected).toBe(true);
    expect(midGrace.holders).toHaveLength(2);

    await clock.advance(CONTROL_TIMING.disconnectGraceMs - 1_000);
    expect(engine.getSnapshot().holders).toHaveLength(2);

    await clock.advance(2_000); // past the grace
    await flushAll();

    const after = engine.getSnapshot();
    expect(after.phase).toBe('held');
    expect(after.holders.map((h) => h.viewerId)).toEqual(['vwr_bob']);
    expect(
      ofType(directTo(effects, 'vwr_alice'), 'control.revoked').map((m) => m.reason),
    ).toContain('expired');
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.revoked')).toHaveLength(0);
  });

  it('a disconnected holder reconnecting inside their own grace keeps the SAME leaseId, with the lease never leaving held', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]?.leaseId;

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(5_000);
    expect(engine.handleReconnect('vwr_alice', true)).toEqual({ restored: true });

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('held');
    expect(snapshot.holders).toHaveLength(2);
    expect(snapshot.holders.find((h) => h.viewerId === 'vwr_alice')?.leaseId).toBe(aliceLeaseId);
    expect(snapshot.holders.find((h) => h.viewerId === 'vwr_alice')?.connected).toBe(true);

    // And the grace timer that was pending for alice is dead, not merely ignored:
    // advancing past it must not evict her.
    await clock.advance(CONTROL_TIMING.disconnectGraceMs + 1_000);
    await flushAll();
    expect(engine.getSnapshot().holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);
  });

  it('the LAST holder disconnecting takes the lease to unheld when their own grace expires', async () => {
    const { clock, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.handleSocketClosed('vwr_alice');

    await clock.advance(CONTROL_TIMING.disconnectGraceMs + 1_000);
    await flushAll();

    const snapshot = engine.getSnapshot();
    expect(snapshot.holders).toEqual([]);
    expect(snapshot.phase).toBe('unheld');
  });
});

describe('shared mode: the release asymmetry with several holders', () => {
  it('a departing driver is fenced off for ordinary input immediately, and their releases still dispatch', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    await engine.release('vwr_alice', aliceLeaseId);
    await flushAll();

    // Alice's ordinary input is dropped from this instant.
    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'mouse.down' }),
    ).toMatchObject({
      dispatch: false,
      reason: 'stale_lease',
    });
    // Her mouse.up still dispatches: she must not leave a button down inside
    // a page bob is still driving.
    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'mouse.up' }),
    ).toMatchObject({ dispatch: true });
    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'key.up' }),
    ).toMatchObject({ dispatch: true });
    // And bob, who did nothing, is untouched.
    expect(
      engine.checkFencing({ viewerId: 'vwr_bob', leaseId: bobLeaseId, kind: 'mouse.down' }),
    ).toMatchObject({
      dispatch: true,
      attributedTo: 'vwr_bob',
    });
  });

  it("releaseHeld is called for the departing driver alone, so nobody else's held buttons are lifted", async () => {
    const { effects, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;

    await engine.release('vwr_alice', aliceLeaseId);
    await flushAll();

    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);
  });

  it('a driver inside their disconnect grace is fenced off even though the lease is still held', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    engine.handleSocketClosed('vwr_alice');

    // `held-grace` is what fences a disconnected holder off in exclusive
    // mode; a shared lease stays `held`, so `LeaseHolder.connected` has to
    // do that job instead.
    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'mouse.move' }),
    ).toMatchObject({ dispatch: false });
    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'mouse.up' }),
    ).toMatchObject({ dispatch: true });
    expect(
      engine.checkFencing({ viewerId: 'vwr_bob', leaseId: bobLeaseId, kind: 'mouse.move' }),
    ).toMatchObject({ dispatch: true });
  });

  it('a revoked driver is fenced off while the remaining drivers are not', async () => {
    const { effects, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    await engine.revoke(viewer('vwr_admin', { isAdmin: true }), 'vwr_alice');
    await flushAll();

    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'key.down' }),
    ).toMatchObject({ dispatch: false });
    expect(
      engine.checkFencing({ viewerId: 'vwr_alice', leaseId: aliceLeaseId, kind: 'key.up' }),
    ).toMatchObject({ dispatch: true });
    expect(
      engine.checkFencing({ viewerId: 'vwr_bob', leaseId: bobLeaseId, kind: 'key.down' }),
    ).toMatchObject({ dispatch: true });
    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);
  });
});

describe('shared mode: isHolder, holderFor, renew and release are per holder', () => {
  it('isHolder is true for EVERY driver, not just the longest tenured one', () => {
    const { engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    expect(engine.isHolder('vwr_alice')).toBe(true);
    expect(engine.isHolder('vwr_bob')).toBe(true);
    expect(engine.isHolder('vwr_carol')).toBe(false);
    expect(engine.holderFor('vwr_bob')?.viewerId).toBe('vwr_bob');
    expect(engine.holderFor('vwr_carol')).toBeNull();
    // `holder`, singular, is the PRIMARY holder and would have answered
    // "is bob driving" with the wrong viewer.
    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_alice');
  });

  it('renew renews one tenure and leaves the other holder deadline where it was', async () => {
    const { clock, effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    await clock.advance(10_000);
    const beforeAlice = engine
      .projectState(null)
      .holders.find((h) => h.viewerId === 'vwr_alice')?.expiresAt;
    engine.renew('vwr_bob', bobLeaseId);

    const after = engine.projectState(null);
    expect(after.holders.find((h) => h.viewerId === 'vwr_alice')?.expiresAt).toBe(beforeAlice);
    const bobExpiry = after.holders.find((h) => h.viewerId === 'vwr_bob')?.expiresAt as number;
    expect(bobExpiry).toBeGreaterThan(beforeAlice as number);
  });

  it("release with another holder's leaseId is not_held, so one driver cannot end another driver's tenure", async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    expect(await engine.release('vwr_alice', bobLeaseId)).toEqual({ ok: false, error: 'not_held' });
    expect(engine.getSnapshot().holders).toHaveLength(2);
  });

  it('the last holder releasing takes the lease to unheld', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;

    await engine.release('vwr_alice', aliceLeaseId);
    await engine.release('vwr_bob', bobLeaseId);
    await flushAll();

    const snapshot = engine.getSnapshot();
    expect(snapshot.holders).toEqual([]);
    expect(snapshot.phase).toBe('unheld');
  });
});

describe('shared mode: the control.state projection', () => {
  it('holders is complete, in grant order, and identical for every recipient', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    for (const who of ['vwr_alice', 'vwr_bob', 'vwr_carol', null]) {
      const state = latestState(effects, who);
      expect(state?.holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);
      expect(state?.holderCount).toBe(2);
      expect(state?.mode).toBe('shared');
    }
  });

  it("holderViewerId is a PER RECIPIENT projection of the recipient's own holding", () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    expect(latestState(effects, 'vwr_alice')?.holderViewerId).toBe('vwr_alice');
    expect(latestState(effects, 'vwr_bob')?.holderViewerId).toBe('vwr_bob');
    expect(latestState(effects, 'vwr_carol')?.holderViewerId).toBeNull();
    expect(latestState(effects, null)?.holderViewerId).toBeNull();
    // Which is what keeps `holderViewerId === myViewerId` an honest "am I
    // driving?" for every driver, not only the longest tenured one.
  });

  it('holders keeps a disconnected driver, marked connected: false, until their grace actually expires', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    engine.handleSocketClosed('vwr_alice');

    const state = latestState(effects, 'vwr_bob');
    expect(state?.holders.find((h) => h.viewerId === 'vwr_alice')?.connected).toBe(false);
    expect(state?.holders.find((h) => h.viewerId === 'vwr_bob')?.connected).toBe(true);
  });

  it('projectState is the same projection control.state broadcasts, so welcome and resumed cannot disagree with it', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    for (const who of ['vwr_alice', 'vwr_bob', 'vwr_carol', null]) {
      expect(engine.projectState(who)).toEqual(latestState(effects, who));
    }
  });
});

/**
 * The compatibility promise. `mode: 'exclusive'` is the SDK default and is
 * what every existing integration already relies on, so these cases compare
 * the two modes field by field at one holder and assert they agree on
 * everything except `mode` itself.
 */
describe('the exclusive path is unchanged on the wire with one holder', () => {
  it('control.granted carries the same fields in both modes, mode aside', () => {
    const exclusive = harness();
    const shared = sharedHarness();
    exclusive.engine.requestControl(viewer('vwr_alice'));
    shared.engine.requestControl(viewer('vwr_alice'));

    const a = ofType(directTo(exclusive.effects, 'vwr_alice'), 'control.granted')[0];
    const b = ofType(directTo(shared.effects, 'vwr_alice'), 'control.granted')[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Object.keys(a as object).sort()).toEqual(Object.keys(b as object).sort());
    expect(a?.mode).toBe('exclusive');
    expect(b?.mode).toBe('shared');
    // leaseId is minted per grant, so compare everything else.
    const {
      leaseId: _a,
      mode: _am,
      ...aRest
    } = a as Record<string, unknown> & { leaseId: string; mode: string };
    const {
      leaseId: _b,
      mode: _bm,
      ...bRest
    } = b as Record<string, unknown> & { leaseId: string; mode: string };
    expect(aRest).toEqual(bRest);
  });

  it('control.state carries the same fields and the same values in both modes, mode aside', () => {
    const exclusive = harness();
    const shared = sharedHarness();
    exclusive.engine.requestControl(viewer('vwr_alice'));
    shared.engine.requestControl(viewer('vwr_alice'));

    const a = exclusive.engine.projectState('vwr_alice');
    const b = shared.engine.projectState('vwr_alice');
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect({ ...a, mode: 'x' }).toEqual({ ...b, mode: 'x' });
    // The single holder IS the primary holder, so the derived getters agree
    // with the plural collection.
    expect(a.holderViewerId).toBe('vwr_alice');
    expect(a.holderCount).toBe(1);
    expect(a.holders.map((h) => h.viewerId)).toEqual(['vwr_alice']);
  });

  it("a bystander's exclusive projection is recipient independent, which is what shared mode deliberately changes", () => {
    const exclusive = harness();
    exclusive.engine.requestControl(viewer('vwr_alice'));

    // In exclusive mode `holderViewerId` names the one holder for EVERY
    // recipient, including one who does not hold. That is the pre-existing
    // behaviour and it must not have moved.
    expect(exclusive.engine.projectState('vwr_carol').holderViewerId).toBe('vwr_alice');
    expect(exclusive.engine.projectState(null).holderViewerId).toBe('vwr_alice');
  });

  it('the exclusive engine still queues, still preempts nobody by accident, and still reaches held-grace on disconnect', async () => {
    const { clock, effects, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.queued')).toHaveLength(1);

    engine.handleSocketClosed('vwr_alice');
    expect(engine.getSnapshot().phase).toBe('held-grace');

    await clock.advance(CONTROL_TIMING.disconnectGraceMs + 1_000);
    await flushAll();
    // The queued viewer is promoted, which is the exclusive machine working
    // exactly as it did before shared mode existed.
    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_bob');
  });
});

describe('projectSummary: the welcome projection, narrowed from the same source', () => {
  it('agrees field for field with projectState, so welcome cannot contradict the first control.state', () => {
    const { engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    for (const who of ['vwr_alice', 'vwr_bob', 'vwr_carol', null]) {
      const state = engine.projectState(who);
      const summary = engine.projectSummary(who);
      expect(summary.holderViewerId).toBe(state.holderViewerId);
      expect(summary.holderLabel).toBe(state.holderLabel);
      expect(summary.mode).toBe(state.mode);
      expect(summary.holderCount).toBe(state.holderCount);
      expect(summary.queueLength).toBe(state.queueLength);
      expect(summary.queuePosition).toBe(state.queuePosition);
      expect(summary.expiresAt).toBe(state.expiresAt ?? summary.expiresAt);
    }
  });

  it('reports an unheld lease honestly rather than inventing a holder', () => {
    const { engine } = sharedHarness();
    const summary = engine.projectSummary('vwr_alice');
    expect(summary.holderViewerId).toBeNull();
    expect(summary.holderCount).toBe(0);
    expect(summary.queueLength).toBe(0);
    expect(typeof summary.expiresAt).toBe('number');
  });
});

/**
 * The one window in which a shared lease's queue is non-empty at all: a
 * request that lands while the LAST holder's departure is still settling
 * (`handing-over`). Granting into a phase whose settlement is about to clear
 * the holder list would hand out a lease discarded microseconds later, so the
 * request is parked instead. It is an admission backlog, bounded by
 * `handoverDrainMs`, and it is never presented to a client as a queue.
 */
describe('shared mode: the admission backlog is never visible as a queue', () => {
  it('a request during the settlement is granted when it settles, with no control.queued and no queue on any broadcast', async () => {
    let releaseDrain: (() => void) | null = null;
    const { effects, engine } = sharedHarness({
      drainInput: () =>
        new Promise<void>((resolve) => {
          releaseDrain = () => resolve();
        }),
    });
    engine.requestControl(viewer('vwr_alice'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;

    const releasing = engine.release('vwr_alice', aliceLeaseId);
    await Promise.resolve();
    expect(engine.getSnapshot().phase).toBe('handing-over');

    // Bob asks mid-settlement.
    engine.requestControl(viewer('vwr_bob'), { requestId: 'req_bob' });
    expect(ofType(directTo(effects, 'vwr_bob'), 'control.queued')).toHaveLength(0);

    releaseDrain?.();
    await releasing;
    await flushAll();

    const bobGrants = ofType(directTo(effects, 'vwr_bob'), 'control.granted');
    expect(bobGrants).toHaveLength(1);
    expect(bobGrants[0]?.re).toBe('req_bob'); // the reply still echoes the original request
    expect(engine.getSnapshot().holders.map((h) => h.viewerId)).toEqual(['vwr_bob']);

    // Every control.state a client could have seen reported an empty queue.
    for (const broadcast of effects.filter(isBroadcast)) {
      for (const who of ['vwr_alice', 'vwr_bob', null]) {
        const lease = broadcast.forViewer(who).leases[0];
        expect(lease?.queue).toEqual([]);
        expect(lease?.queueLength).toBe(0);
        expect(lease?.queuePosition).toBeNull();
      }
    }
  });
});

/**
 * The two disconnect deadlines, and the gap between them.
 *
 * Measured on a real hard close (`ws.terminate()`, no close frame) before
 * this split: "held button released 30514ms after a hard socket close". The
 * departed driver's tenure was preserved so a reconnect could resume the same
 * `leaseId`, and the hygiene sweep was welded to that same deadline, so
 * everybody else stared at a jammed pointer for the full 30 seconds.
 *
 * The cases below are written so that MERGING THE TWO DEADLINES BACK TOGETHER
 * fails them, in both directions: an early assertion catches hygiene running
 * late, and a late one catches the tenure being evicted early.
 */
describe('shared mode: hygiene runs promptly, the tenure survives the full grace', () => {
  const HYGIENE = CONTROL_TIMING.disconnectHygieneMs;
  const GRACE = CONTROL_TIMING.disconnectGraceMs;

  it('sweeps the departed driver at disconnectHygieneMs while KEEPING them in holders, connected: false', async () => {
    const { clock, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    engine.handleSocketClosed('vwr_alice');
    expect(releasedHeld).toEqual([]); // nothing swept yet

    // Just before the hygiene deadline: still nothing.
    await clock.advance(HYGIENE - 100);
    expect(releasedHeld).toEqual([]);

    // Just after it: alice's held state is gone.
    await clock.advance(200);
    await flushAll();
    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);

    // THE POINT OF THE SPLIT. At a time between the two deadlines the sweep
    // has run and the tenure has NOT. This is the assertion that fails if
    // anybody welds the deadlines back together.
    const between = engine.getSnapshot();
    expect(between.phase).toBe('held');
    const alice = between.holders.find((h) => h.viewerId === 'vwr_alice');
    expect(alice).toBeDefined();
    expect(alice?.connected).toBe(false);
    expect(between.holders).toHaveLength(2);
  });

  it('1500ms is not the tenure deadline: alice is still a holder well past it, and only loses her seat at the full grace', async () => {
    const { clock, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    engine.handleSocketClosed('vwr_alice');

    // The e2e suite asserts exactly this at 1500ms after a hard close, which
    // is what proves handleReconnect's shared path is reachable rather than
    // dead code. It must keep passing.
    await clock.advance(1_500);
    await flushAll();
    expect(engine.getSnapshot().holders.find((h) => h.viewerId === 'vwr_alice')?.connected).toBe(
      false,
    );

    // Still hers at 29s.
    await clock.advance(GRACE - 1_500 - 1_000);
    await flushAll();
    expect(engine.getSnapshot().holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);

    // Gone at 31s.
    await clock.advance(2_000);
    await flushAll();
    expect(engine.getSnapshot().holders.map((h) => h.viewerId)).toEqual(['vwr_bob']);
  });

  it('a reconnect INSIDE the hygiene window cancels the sweep entirely, so a blip does not interrupt the drag', async () => {
    const { clock, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = engine.holderFor('vwr_alice')?.leaseId;

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(HYGIENE - 500);
    expect(engine.handleReconnect('vwr_alice', true)).toEqual({ restored: true });

    // Past the point the sweep would have fired: it must not fire at all.
    await clock.advance(2_000);
    await flushAll();
    expect(releasedHeld).toEqual([]);
    expect(engine.holderFor('vwr_alice')?.leaseId).toBe(aliceLeaseId);
    expect(engine.holderFor('vwr_alice')?.connected).toBe(true);
  });

  it('a reconnect AFTER the sweep still restores the same leaseId; the held state is simply gone', async () => {
    const { clock, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    const aliceLeaseId = engine.holderFor('vwr_alice')?.leaseId;

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(HYGIENE + 100);
    await flushAll();
    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);

    expect(engine.handleReconnect('vwr_alice', true)).toEqual({ restored: true });
    expect(engine.holderFor('vwr_alice')?.leaseId).toBe(aliceLeaseId);
    expect(engine.holderFor('vwr_alice')?.connected).toBe(true);
    // Nothing re-presses what was released. The server cannot know which keys
    // are still physically down on a machine it was not talking to.
    expect(releasedHeld).toHaveLength(1);
  });

  it('sweeps ONLY the departed driver, so the drivers still connected keep what they are holding', async () => {
    const { clock, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    engine.requestControl(viewer('vwr_carol'));

    engine.handleSocketClosed('vwr_bob');
    await clock.advance(HYGIENE + 100);
    await flushAll();

    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_bob' }]);
  });

  it('the LAST driver leaving gets no prompt sweep: nobody is left to be inconvenienced', async () => {
    const { clock, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(HYGIENE + 100);
    await flushAll();
    expect(releasedHeld).toEqual([]); // the ordinary grace expiry sweep is soon enough

    await clock.advance(GRACE);
    await flushAll();
    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);
  });

  it('a driver who disconnects while the OTHER driver is also disconnected gets no prompt sweep either', async () => {
    const { clock, releasedHeld, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    engine.handleSocketClosed('vwr_alice');
    // Bob drops before alice's sweep is due. Nobody is watching the page now,
    // so bob gets the ordinary grace, and alice's already-scheduled sweep
    // still runs (it was correct when it was scheduled).
    engine.handleSocketClosed('vwr_bob');
    await clock.advance(HYGIENE + 100);
    await flushAll();
    expect(releasedHeld.map((r) => r.viewerId)).toEqual(['vwr_alice']);
  });

  it('is configurable through the timing object', async () => {
    const { clock, releasedHeld, engine } = sharedHarness({ timing: { disconnectHygieneMs: 400 } });
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(500);
    await flushAll();
    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);
  });

  it('records an audit note, so the sweep is observable rather than invisible', async () => {
    const { clock, auditNotes, engine } = sharedHarness();
    engine.requestControl(viewer('vwr_alice'));
    engine.requestControl(viewer('vwr_bob'));
    engine.handleSocketClosed('vwr_alice');
    await clock.advance(HYGIENE + 100);
    await flushAll();

    const note = auditNotes.find((n) => n.type === 'control.disconnectHygiene');
    expect(note).toBeDefined();
    expect(note?.['viewerId']).toBe('vwr_alice');
  });
});

describe('exclusive mode is untouched by the hygiene split', () => {
  it('a disconnected exclusive holder is swept at the FULL grace, exactly as before', async () => {
    const { clock, releasedHeld, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    engine.handleSocketClosed('vwr_alice');
    expect(engine.getSnapshot().phase).toBe('held-grace');

    // Past the shared-mode hygiene deadline: nothing has happened, because an
    // exclusive lease can never have another connected driver to protect.
    await clock.advance(CONTROL_TIMING.disconnectHygieneMs + 100);
    await flushAll();
    expect(releasedHeld).toEqual([]);
    expect(engine.getSnapshot().phase).toBe('held-grace');
    expect(engine.getSnapshot().holder?.viewerId).toBe('vwr_alice');

    // And the sweep still lands where it always did, at the grace expiry.
    await clock.advance(CONTROL_TIMING.disconnectGraceMs);
    await flushAll();
    expect(releasedHeld).toEqual([{ targetId: 'tgt_1', viewerId: 'vwr_alice' }]);
    expect(engine.getSnapshot().phase).toBe('unheld');
  });

  it('an exclusive reconnect inside the grace is unchanged: same leaseId, no sweep, at a time past the shared deadline', async () => {
    const { clock, releasedHeld, engine } = harness();
    engine.requestControl(viewer('vwr_alice'));
    const leaseId = engine.getSnapshot().leaseId;

    engine.handleSocketClosed('vwr_alice');
    await clock.advance(CONTROL_TIMING.disconnectHygieneMs + 3_000);
    await flushAll();

    expect(engine.handleReconnect('vwr_alice', true)).toEqual({ restored: true });
    expect(engine.getSnapshot().leaseId).toBe(leaseId);
    // The drag a reconnecting exclusive holder resumes is still intact, which
    // it would not be if prompt hygiene had been applied here as a side effect.
    expect(releasedHeld).toEqual([]);
  });
});
