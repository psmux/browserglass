import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmYieldEvent } from '../src/index.js';
import { completeSwarmMemberHandshake, openFakeSwarm, tick } from './helpers.js';

/**
 * A swarm with a person looking over the shoulder of ONE member
 * (a swarm of 20 browsers with a human looking over the shoulder of one
 * of them is the realistic shape of this).
 *
 * The property under test is mostly a negative one, which is why it needs
 * a test at all: a takeover on one member must change NOTHING about its
 * siblings. That is structurally true (each member is its own connection,
 * its own lease, its own stand-down gate) and the point of these cases is
 * to keep it structurally true, since the tempting wrong fix, halting the
 * swarm when a member is preempted, would be very easy to add later and
 * would break the main reason anyone wants a swarm.
 */
describe('BrowserSwarm and a human taking over one member', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Acquires control on every member and returns per-member input counts, so a later count proves who kept driving. */
  async function acquireAll(
    swarm: Awaited<ReturnType<typeof openFakeSwarm>>['swarm'],
    gateways: Awaited<ReturnType<typeof openFakeSwarm>>['gateways'],
  ) {
    const leases = swarm.members.map((m) => m.client.acquireControl({ waitMs: 5000 }));
    await tick();
    await Promise.all(leases);
    // Prime each member's generation so clickAt() needs no round trip.
    await Promise.all(swarm.members.map((m) => m.client.inspectAt(0, 0).then(() => undefined)));
    await tick();
    return gateways;
  }

  function inputCount(gateway: {
    ws: { sentJsonMessages(): Array<Record<string, unknown>> };
  }): number {
    return gateway.ws
      .sentJsonMessages()
      .filter((m) => typeof m['t'] === 'string' && (m['t'] as string).startsWith('input.')).length;
  }

  it('a yield on member 1 stops member 1 and leaves members 0 and 2 driving', async () => {
    const { swarm, gateways } = await openFakeSwarm({ size: 3 });
    await acquireAll(swarm, gateways);

    const taken = swarm.members[1]!;
    gateways[1]!.sendPreemptRequest(taken.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    const before = gateways.map((g) => inputCount(g));

    const results = await swarm.all((m) => m.client.clickAt(5, 5));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: 'LEASE_REVOKED',
      details: expect.objectContaining({ human: true }),
    });

    // The two untouched members dispatched; the taken one did not. This is
    // the whole claim: one person on one browser costs the other nineteen
    // (here two) nothing.
    expect(inputCount(gateways[0]!)).toBeGreaterThan(before[0]!);
    expect(inputCount(gateways[2]!)).toBeGreaterThan(before[2]!);
    expect(inputCount(gateways[1]!)).toBe(before[1]!);

    await swarm.close();
  });

  it('onControlYield() names which member was taken', async () => {
    const { swarm, gateways } = await openFakeSwarm({ size: 3 });
    await acquireAll(swarm, gateways);

    const seen: SwarmYieldEvent[] = [];
    swarm.onControlYield((ev) => seen.push(ev));

    gateways[2]!.sendPreemptRequest(swarm.members[2]!.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.member.index).toBe(2);
    expect(seen[0]!.member.instanceId).toBe('inst_swarm_2');
    expect(seen[0]!.notice.human).toBe(true);
    expect(seen[0]!.notice.byLabel).toBe('Alice');

    await swarm.close();
  });

  it('yielded() reports exactly the members currently stood down', async () => {
    const { swarm, gateways } = await openFakeSwarm({ size: 3 });
    await acquireAll(swarm, gateways);

    expect(swarm.yielded()).toEqual([]);

    gateways[0]!.sendPreemptRequest(swarm.members[0]!.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });
    gateways[2]!.sendPreemptRequest(swarm.members[2]!.targetId, {
      byLabel: 'Bob',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    expect(swarm.yielded().map((y) => y.member.index)).toEqual([0, 2]);
    expect(swarm.yielded().map((y) => y.notice.byLabel)).toEqual(['Alice', 'Bob']);

    await swarm.close();
  });

  it('covers members added by grow() without re-registering the callback', async () => {
    const { swarm, harness, gateways } = await openFakeSwarm({ size: 1 });

    const seen: SwarmYieldEvent[] = [];
    // Registered BEFORE the member exists. A registration that only wired
    // up members present at the time would silently miss everything a
    // long-running swarm grows into.
    swarm.onControlYield((ev) => seen.push(ev));

    const growPromise = swarm.grow(1);
    await tick();
    const grownGateway = completeSwarmMemberHandshake(harness, 1);
    const added = await growPromise;
    expect(added).toHaveLength(1);

    grownGateway.sendPreemptRequest(added[0]!.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    expect(seen.map((s) => s.member.index)).toEqual([1]);
    expect(gateways).toHaveLength(1);

    await swarm.close();
  });

  it('a caller handler that throws does not stop the member standing down, nor its siblings', async () => {
    const { swarm, gateways } = await openFakeSwarm({ size: 2 });
    await acquireAll(swarm, gateways);

    swarm.onControlYield(() => {
      throw new Error('caller handler blew up');
    });
    gateways[0]!.sendPreemptRequest(swarm.members[0]!.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    expect(swarm.yielded().map((y) => y.member.index)).toEqual([0]);
    const results = await swarm.all((m) => m.client.clickAt(5, 5));
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);

    await swarm.close();
  });
});
