import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSwarm } from '../src/index.js';
import { createFakeGatewayHarness } from './fake-gateway.js';
import {
  completeSwarmMemberHandshake,
  fixtureSwarmOptions,
  openFakeSwarm,
  tick,
} from './helpers.js';

/**
 * `BrowserSwarm` end to end against `size` independent scripted gateways
 * (`./fake-gateway.ts`, `./helpers.ts`'s `openFakeSwarm()`), one real
 * `FakeGatewaySocket` per member: there is no real `@browserglass/server`
 * for this package's own test suite to run against (see
 * `automation-client.test.ts`'s own doc comment), so a swarm of N fakes is
 * the same substitution at N.
 */
describe('BrowserSwarm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('open() opens `size` members concurrently, each an independent client bound to its own instance and target', async () => {
    const { swarm } = await openFakeSwarm({ size: 3 });

    expect(swarm.members.length).toBe(3);
    const instanceIds = swarm.members.map((m) => m.instanceId);
    const targetIds = swarm.members.map((m) => m.targetId);
    // Every member landed on the instance/target `acquire()`+`welcome`
    // actually gave it, not on a shared or mixed-up one.
    expect(new Set(instanceIds).size).toBe(3);
    expect(new Set(targetIds).size).toBe(3);
    swarm.members.forEach((m, i) => {
      expect(m.index).toBe(i);
      expect(m.client.instanceId).toBe(m.instanceId);
      expect(m.client.targetId).toBe(m.targetId);
    });

    await swarm.close();
  });

  it('open() rejects a non-positive size before calling acquire() at all', async () => {
    const harness = createFakeGatewayHarness();
    await expect(
      BrowserSwarm.open(fixtureSwarmOptions(harness, { size: 0 })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(harness.instances.length).toBe(0);
  });

  it('a member whose connect succeeds but whose post-connect url navigate fails does not leak its socket', async () => {
    // `opts.url` makes `openOneMember()` call `acquireControl()` right
    // after connecting; granting no `control` capability makes that call
    // throw POLICY_DENIED locally, after the socket is already open, so
    // this exercises the same cleanup path a failed `nav.goto` would.
    const harness = createFakeGatewayHarness();
    const openPromise = BrowserSwarm.open(
      fixtureSwarmOptions(harness, { size: 1, url: 'https://example.test/start' }),
    );
    await tick();
    completeSwarmMemberHandshake(harness, 0, { granted: ['view', 'automation'] });

    await expect(openPromise).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // The connect succeeded before acquireControl() failed; the fix under
    // test is that `openOneMember()` closes that socket itself rather
    // than leaving it open with no `SwarmMember` anywhere to reach it.
    expect(harness.instances[0]?.readyState).toBe(3);
  });

  it('all() runs every member concurrently rather than serially: every member starts before any of them finishes', async () => {
    const { swarm } = await openFakeSwarm({ size: 3 });

    const order: string[] = [];
    const allPromise = swarm.all(async (m) => {
      order.push(`start:${m.index}`);
      await tick(50);
      order.push(`end:${m.index}`);
      return m.index;
    });
    await tick(50);
    const results = await allPromise;

    // A serial (`for...of` with `await` inside) implementation would
    // interleave start/end pairs: start:0, end:0, start:1, end:1, ...
    // Concurrent execution starts every member before any of them ends.
    expect(order.slice(0, 3).sort()).toEqual(['start:0', 'start:1', 'start:2']);
    expect(order.slice(3).sort()).toEqual(['end:0', 'end:1', 'end:2']);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : undefined))).toEqual([0, 1, 2]);

    await swarm.close();
  });

  it('all() uses Promise.allSettled: one member throwing does not fail or stop the others', async () => {
    const { swarm } = await openFakeSwarm({ size: 3 });

    const completed: number[] = [];
    const results = await swarm.all(async (m) => {
      if (m.index === 1) throw new Error(`member ${m.index} boom`);
      await tick(10);
      completed.push(m.index);
      return m.index * 10;
    });
    await tick(10);

    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 0 });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('member 1 boom');
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: 20 });
    // Members 0 and 2 actually ran to completion; the failing member did
    // not abort or cancel them.
    expect(completed.sort()).toEqual([0, 2]);

    await swarm.close();
  });

  it('grow() adds members without disturbing the existing ones, and shrink() removes and closes the most recently added', async () => {
    const { swarm, harness } = await openFakeSwarm({ size: 2 });
    const originalTargetIds = swarm.members.map((m) => m.targetId);

    const growPromise = swarm.grow(1);
    await tick();
    completeSwarmMemberHandshake(harness, 2);
    const added = await growPromise;

    expect(added.length).toBe(1);
    expect(added[0]?.index).toBe(2);
    expect(swarm.members.length).toBe(3);
    expect(swarm.members.slice(0, 2).map((m) => m.targetId)).toEqual(originalTargetIds);

    const grownSocket = harness.instances[2];
    expect(grownSocket?.readyState).toBe(1);

    await swarm.shrink(1);
    expect(swarm.members.length).toBe(2);
    expect(swarm.members.map((m) => m.targetId)).toEqual(originalTargetIds);
    // shrink() actually closed the removed member's socket, not just
    // dropped it from `members`.
    expect(grownSocket?.readyState).toBe(3);

    await swarm.close();
  });

  it('shrink() throws INVALID_ARGUMENT rather than clamping when asked to remove more members than the swarm holds', async () => {
    const { swarm } = await openFakeSwarm({ size: 2 });
    await expect(swarm.shrink(5)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(swarm.members.length).toBe(2);
    await swarm.close();
  });

  it('close() releases every member: every socket closes and members becomes empty', async () => {
    const { swarm, harness } = await openFakeSwarm({ size: 3 });
    expect(harness.instances.every((ws) => ws.readyState === 1)).toBe(true);

    await swarm.close();

    expect(harness.instances.every((ws) => ws.readyState === 3)).toBe(true);
    expect(swarm.members.length).toBe(0);

    // Idempotent: closing an already-closed swarm does not throw.
    await expect(swarm.close()).resolves.toBeUndefined();
  });

  it("each member reads its own target's console concurrently, with no cross-contamination between members", async () => {
    const { swarm, gateways } = await openFakeSwarm(
      { size: 3 },
      {
        0: { granted: ['view', 'automation', 'devtools'] },
        1: { granted: ['view', 'automation', 'devtools'] },
        2: { granted: ['view', 'automation', 'devtools'] },
      },
    );

    const seen: Array<{ member: number; text: string }> = [];
    for (const m of swarm.members) {
      m.client.on('console', (ev) => seen.push({ member: m.index, text: ev.text }));
    }

    const subscribePromise = swarm.all((m) => m.client.diagnostics.subscribe());
    await tick();
    await subscribePromise;

    // Fire one console line per member's own gateway, all before anything
    // awaits again, to prove they land on the right member rather than
    // broadcasting across the whole swarm.
    gateways.forEach((gateway, i) =>
      gateway.sendConsoleEntry(swarm.members[i]!.targetId, { text: `hello from ${i}` }),
    );
    await tick();

    expect(seen.sort((a, b) => a.member - b.member)).toEqual([
      { member: 0, text: 'hello from 0' },
      { member: 1, text: 'hello from 1' },
      { member: 2, text: 'hello from 2' },
    ]);

    await swarm.close();
  });

  it('diagnostics.subscribe() throws POLICY_DENIED locally when a member lacks the devtools capability, before any wire traffic', async () => {
    const { swarm, gateways } = await openFakeSwarm({ size: 1 });
    const before = gateways[0]!.ws.sentJsonMessages().length;

    await expect(swarm.members[0]!.client.diagnostics.subscribe()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(gateways[0]!.ws.sentJsonMessages().length).toBe(before);

    await swarm.close();
  });
});
