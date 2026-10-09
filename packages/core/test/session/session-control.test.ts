/**
 * `SessionOptions.control`: the one path from configuration to
 * `ControlLeaseEngineOptions.mode`.
 *
 * Shared control shipped inert because this path did not exist.
 * `Session.leaseEngineFor` built every engine without a mode, so `'shared'`
 * fell back to `'exclusive'` and a second `control.request` on a target the
 * operator had configured as shared came back
 * `{granted: false, queued: true, position: 1}`. The setting was accepted by
 * the server config layer and then dropped on the floor, which is why the
 * unknown-key case below is a test and not a comment.
 */

import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/control/clock.js';
import { Session, type SessionControlOptions } from '../../src/session/session.js';
import type { SessionEffect } from '../../src/session/types.js';
import { startFakeRegistry } from '../cdp/test-helpers.js';

async function makeSession(control?: SessionControlOptions) {
  const { bridge, registry, world, instanceId } = await startFakeRegistry();
  world.targetInfos = [
    { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
  ];
  await registry.resync();
  const targetId = registry.tabs()[0]!.id;

  const clock = createManualClock();
  const effects: SessionEffect[] = [];
  const build = () =>
    new Session({
      id: 'sess_1' as never,
      instanceId,
      tenantId: 'tnt_1',
      nodeId: 'node_1',
      bridge,
      registry,
      clock,
      onEffect: (e) => effects.push(e),
      ...(control ? { control } : {}),
    });
  return { build, effects, targetId };
}

describe('SessionOptions.control: mode reaches the lease engine', () => {
  it('defaults to exclusive when control is omitted, so no existing integration changes behaviour', async () => {
    const { build, targetId } = await makeSession();
    const session = build();
    session.provision();
    expect(session.controlMode()).toBe('exclusive');
    expect(session.leaseEngineFor(targetId).getMode()).toBe('exclusive');
  });

  it("mode: 'shared' actually reaches the engine, and a second request is granted rather than queued", async () => {
    const { build, targetId } = await makeSession({ mode: 'shared' });
    const session = build();
    session.provision();

    const engine = session.leaseEngineFor(targetId);
    expect(engine.getMode()).toBe('shared');

    const who = (viewerId: string) => ({
      viewerId,
      identity: `sub:${viewerId}`,
      label: viewerId,
      kind: 'human' as const,
      isAdmin: false,
    });
    engine.requestControl(who('vwr_alice'));
    engine.requestControl(who('vwr_bob'));

    const snapshot = engine.getSnapshot();
    expect(snapshot.holders.map((h) => h.viewerId)).toEqual(['vwr_alice', 'vwr_bob']);
    expect(snapshot.queue).toEqual([]);
  });

  it('timing overrides reach the engine too, so session.control.graceMs cannot be another silent drop', async () => {
    const { build, targetId } = await makeSession({
      mode: 'shared',
      timing: { disconnectGraceMs: 4_000, allowShared: false },
    });
    const session = build();
    session.provision();
    // `allowShared: false` is the deployment veto, and it only bites if the
    // timing override genuinely arrived.
    expect(session.leaseEngineFor(targetId).getMode()).toBe('exclusive');
  });
});

describe('SessionOptions.control: an option this Session would not act on fails loudly', () => {
  it('throws, naming the key, for a control option that is not in the accepted set', async () => {
    const { build } = await makeSession({ leaseMs: 1_000 } as unknown as SessionControlOptions);
    expect(build).toThrow(/unknown control option 'session\.control\.leaseMs'/);
  });

  it('throws, naming the value, for a mode this build does not understand', async () => {
    const { build } = await makeSession({
      mode: 'collaborative',
    } as unknown as SessionControlOptions);
    expect(build).toThrow(/unknown control mode 'collaborative'/);
  });

  it('accepts every key the type names', async () => {
    const { build, targetId } = await makeSession({
      mode: 'shared',
      timing: { leaseTtlMs: 5_000 },
      maxQueueDepth: 4,
      policyName: 'exclusive',
    });
    const session = build();
    session.provision();
    expect(session.leaseEngineFor(targetId).getMode()).toBe('shared');
  });
});
