/**
 * `control.contention`: the explicit co-driving signal `ControlLeaseEngine`
 * emits when a target's holder count crosses the two-holder threshold, in
 * either direction. See `packages/protocol/src/wire/messages/control.ts`'s
 * `ControlContention` doc for why this exists alongside `control.state`
 * (a client already gets the raw `holders` array on every broadcast; this
 * message is the ANNOUNCEMENT an autonomous agent needs so it does not have
 * to diff two broadcasts itself to notice "I am now co-driving").
 *
 * Every case here runs on the injected `ManualClock`, matching the rest of
 * this package's control suite.
 */

import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/control/clock.js';
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

function sharedHarness(overrides: Partial<ControlLeaseEngineOptions> = {}) {
  return harness({ mode: 'shared', ...overrides });
}

/** Every `control.contention` broadcast produced so far, decoded for a fixed, arbitrary recipient (the message is recipient independent, so which one is asked does not matter). */
function contentionMessages(effects: readonly LeaseEffect[]) {
  return effects
    .filter(isBroadcast)
    .map((b) => b.forViewer(null))
    .filter(
      (
        m,
      ): m is Extract<ReturnType<LeaseBroadcastEffect['forViewer']>, { t: 'control.contention' }> =>
        m.t === 'control.contention',
    );
}

/** The most recent broadcast `control.state`, skipping any `control.contention` broadcasts interleaved with it. */
function latestState(effects: readonly LeaseEffect[], viewerId: string | null) {
  const states = effects
    .filter(isBroadcast)
    .map((b) => b.forViewer(viewerId))
    .filter(
      (m): m is Extract<ReturnType<LeaseBroadcastEffect['forViewer']>, { t: 'control.state' }> =>
        m.t === 'control.state',
    );
  return states[states.length - 1]?.leases[0];
}

describe('control.contention: one holder to two', () => {
  it('fires exactly once, contended: true, when a second viewer joins a shared target', () => {
    const { effects, engine } = sharedHarness();

    engine.requestControl(human('vwr_alice'));
    expect(contentionMessages(effects)).toHaveLength(0); // one holder is not contention

    engine.requestControl(human('vwr_bob'));
    const msgs = contentionMessages(effects);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      t: 'control.contention',
      targetId: 'tgt_1',
      contended: true,
      holderCount: 2,
      mostRecentViewerId: 'vwr_bob',
    });
    expect(msgs[0]?.holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);
  });

  it('a third holder joining does not re-fire: the signal is edge triggered, not level triggered', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));
    expect(contentionMessages(effects)).toHaveLength(1);

    engine.requestControl(human('vwr_carol'));
    expect(contentionMessages(effects)).toHaveLength(1); // still just the one from 1 -> 2
  });

  it('carries kind and priority for every holder, so a machine can decide without a second round trip', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot', {}));
    engine.requestControl(human('vwr_alice', { priority: 100 }));

    const msg = contentionMessages(effects)[0];
    expect(msg?.holders).toEqual([
      expect.objectContaining({ viewerId: 'vwr_bot', kind: 'agent' }),
      expect.objectContaining({ viewerId: 'vwr_alice', kind: 'human', priority: 100 }),
    ]);
  });

  it('control.state is still the last broadcast of the call that also crosses the threshold, so consumers that read only the latest broadcast are unaffected', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));

    expect(latestState(effects, null)?.holderCount).toBe(2);
    const last = effects.filter(isBroadcast).at(-1)?.forViewer(null);
    expect(last?.t).toBe('control.state');
  });

  it('the ordering guarantee: the requester sees its OWN control.granted strictly before control.contention, even though the same call triggers both', () => {
    // This is the invariant `packages/server/test/ws/shared-control.test.ts`
    // ("shared control: lease broadcasts never precede the reply that
    // caused them") enforces at the wire level for control.state, and it
    // must hold for control.contention too: `control.granted` is the reply
    // to THIS viewer's own `control.request`, so nothing this same call
    // triggers, including a broadcast every OTHER viewer also receives, may
    // be written to the wire ahead of it. Getting this backwards once (by
    // emitting the contention check from inside `admitHolder`, before the
    // caller's own direct grant) broke every client that treats
    // "control.granted is the next message after my control.request" as an
    // assumption, without breaking anything in this package's own suite,
    // which is exactly why the regression only surfaced in
    // packages/server's socket-level tests. This test exists so a future
    // reordering is caught here first.
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    effects.length = 0;

    engine.requestControl(human('vwr_bob'));

    const grantedIndex = effects.findIndex(
      (e) => isDirect(e) && e.to === 'vwr_bob' && e.message.t === 'control.granted',
    );
    const contentionIndex = effects.findIndex(
      (e) => isBroadcast(e) && e.forViewer(null).t === 'control.contention',
    );
    const stateIndex = effects.findLastIndex(
      (e) => isBroadcast(e) && e.forViewer(null).t === 'control.state',
    );
    expect(grantedIndex).toBeGreaterThanOrEqual(0);
    expect(contentionIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeGreaterThanOrEqual(0);
    // granted -> contention -> state, strictly in that order.
    expect(grantedIndex).toBeLessThan(contentionIndex);
    expect(contentionIndex).toBeLessThan(stateIndex);
  });
});

describe('control.contention: the case that matters most, a human joining an agent-held target', () => {
  it('fires with the agent and the human both in holders, so an agent reading this can decide to stand down on its own', () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(agent('vwr_bot'));
    expect(contentionMessages(effects)).toHaveLength(0);

    engine.requestControl(human('vwr_alice'));

    const msg = contentionMessages(effects)[0];
    expect(msg?.contended).toBe(true);
    expect(msg?.mostRecentViewerId).toBe('vwr_alice');
    expect(msg?.holders).toEqual([
      expect.objectContaining({ viewerId: 'vwr_bot', kind: 'agent' }),
      expect.objectContaining({ viewerId: 'vwr_alice', kind: 'human' }),
    ]);
    // Nothing about shared mode's permissiveness changed: the agent is
    // still driving, still a holder, still not preempted or yielded.
    expect(engine.isHolder('vwr_bot')).toBe(true);
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.yield.request')).toHaveLength(0);
    expect(ofType(directTo(effects, 'vwr_bot'), 'control.revoked')).toHaveLength(0);
  });
});

describe('control.contention: two holders back to one', () => {
  it('fires contended: false when one of two holders releases', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;
    effects.length = 0;

    await engine.release('vwr_bob', bobLeaseId);

    const msgs = contentionMessages(effects);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      contended: false,
      holderCount: 1,
      mostRecentViewerId: 'vwr_alice',
    });
    expect(msgs[0]?.holders.map((h) => h.viewerId)).toEqual(['vwr_alice']);
  });

  it('fires contended: false when an admin revokes one of two holders, leaving the other driving', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(agent('vwr_bot'));
    effects.length = 0;

    await engine.revoke(human('vwr_admin', { isAdmin: true }), 'vwr_bot', 'misbehaving');

    const msgs = contentionMessages(effects);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.contended).toBe(false);
    expect(msgs[0]?.holders.map((h) => h.viewerId)).toEqual(['vwr_alice']);
    expect(engine.isHolder('vwr_alice')).toBe(true); // the survivor keeps driving, undisturbed
  });

  it('going from three holders to two does not fire: only the crossing under two matters', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));
    engine.requestControl(human('vwr_carol'));
    const carolLeaseId = ofType(directTo(effects, 'vwr_carol'), 'control.granted')[0]
      ?.leaseId as string;
    effects.length = 0;

    await engine.release('vwr_carol', carolLeaseId);

    expect(contentionMessages(effects)).toHaveLength(0);
  });

  it('reports null mostRecentViewerId and empty holders when the last of two holders leaves, taking the target to unheld', async () => {
    const { effects, engine } = sharedHarness();
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob'));
    const aliceLeaseId = ofType(directTo(effects, 'vwr_alice'), 'control.granted')[0]
      ?.leaseId as string;
    const bobLeaseId = ofType(directTo(effects, 'vwr_bob'), 'control.granted')[0]
      ?.leaseId as string;
    effects.length = 0;

    await engine.release('vwr_alice', aliceLeaseId);
    await engine.release('vwr_bob', bobLeaseId);

    const msgs = contentionMessages(effects);
    // The 2 -> 1 crossing fired once (alice's release); bob's release then
    // takes 1 -> 0, which is not a crossing of the two-holder threshold and
    // fires nothing further.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.contended).toBe(false);
    expect(msgs[0]?.holderCount).toBe(1);
    expect(engine.getSnapshot().phase).toBe('unheld');
  });
});

describe('control.contention: exclusive mode is unchanged', () => {
  it('never fires under mode: exclusive, even with a second requester queued behind the holder', () => {
    const { effects, engine } = harness(); // default mode: 'exclusive'
    engine.requestControl(human('vwr_alice'));
    engine.requestControl(human('vwr_bob')); // queues; never becomes a second holder

    expect(contentionMessages(effects)).toHaveLength(0);
    expect(engine.getSnapshot().holders).toHaveLength(1);
  });
});

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
