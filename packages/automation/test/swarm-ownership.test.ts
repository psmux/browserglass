import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSwarm, swarmMemberSubject } from '../src/index.js';
import { type FakeGatewayHarness, createFakeGatewayHarness } from './fake-gateway.js';
import { completeSwarmMemberHandshake, tick } from './helpers.js';

/**
 * The ownership half of `BrowserSwarm`: `subject`, and the per member slot
 * derivation it drives.
 *
 * These tests never reach a router, because this package has none to
 * reach (`swarm.test.ts`'s own doc comment explains why the whole suite
 * runs against scripted fake gateways). What they prove is the part
 * `BrowserSwarm` is actually responsible for: which subject each
 * `acquire()` call is handed, and which slot a new member lands on.
 * Whether the router then reattaches or launches is
 * `packages/router`'s contract and its own suite's job, and claiming to
 * test it from here would be claiming more than this package can see.
 */
describe('BrowserSwarm ownership (subject)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A swarm fixture whose `acquire()` records every `(index, ctx)` pair it
   * was called with, and whose instance ids follow SOCKET creation order
   * rather than member index. The two coincide on a fresh `open()` and
   * deliberately do not after a `shrink()` plus `grow()`, which is the
   * case two of these tests exist for: `completeSwarmMemberHandshake
   * (harness, n)` stamps `inst_swarm_<n>` on the n-th socket, and
   * `AutomationClient.connect()` rejects a welcome whose instance id does
   * not match what `acquire()` returned, so the ids have to be keyed to
   * the socket, not to the slot.
   */
  function recordingSwarmFixture(harness: FakeGatewayHarness) {
    const calls: Array<{
      index: number;
      subject: string | undefined;
      stickyWithinMs: number | undefined;
    }> = [];
    let socketOrder = 0;
    return {
      calls,
      acquire: async (
        index: number,
        ctx: { subject: string | undefined; stickyWithinMs: number | undefined },
      ) => {
        calls.push({ index, subject: ctx.subject, stickyWithinMs: ctx.stickyWithinMs });
        const order = socketOrder++;
        return {
          instanceId: `inst_swarm_${order}`,
          wsUrl: 'wss://gateway.test/browserglass/socket',
          token: `tkn.swarm.${order}`,
        };
      },
      transport: { WebSocketImpl: harness.Impl },
    };
  }

  it('without a subject every member acquires anonymously: the default is a fresh browser per member, owned by nobody', async () => {
    const harness = createFakeGatewayHarness();
    const fixture = recordingSwarmFixture(harness);
    const openPromise = BrowserSwarm.open({
      size: 3,
      acquire: fixture.acquire,
      transport: fixture.transport,
    });
    await tick();
    for (let i = 0; i < 3; i++) completeSwarmMemberHandshake(harness, i);
    const swarm = await openPromise;

    expect(fixture.calls.map((c) => c.subject)).toEqual([undefined, undefined, undefined]);
    expect(swarm.subject).toBeUndefined();
    expect(swarm.members.map((m) => m.subject)).toEqual([undefined, undefined, undefined]);

    await swarm.close();
  });

  it('with a subject every member gets its OWN slot subject, never the bare one: N members means N distinct subjects', async () => {
    const harness = createFakeGatewayHarness();
    const fixture = recordingSwarmFixture(harness);
    const openPromise = BrowserSwarm.open({
      size: 3,
      subject: 'nightly-crawler',
      stickyWithinMs: 900_000,
      acquire: fixture.acquire,
      transport: fixture.transport,
    });
    await tick();
    for (let i = 0; i < 3; i++) completeSwarmMemberHandshake(harness, i);
    const swarm = await openPromise;

    expect(fixture.calls.map((c) => c.subject)).toEqual([
      'nightly-crawler#0',
      'nightly-crawler#1',
      'nightly-crawler#2',
    ]);
    expect(new Set(fixture.calls.map((c) => c.subject)).size).toBe(3);
    // The bare subject is never handed to an acquire. That is the exact
    // value that would make all three requests select the one instance the
    // router resolves it to, so a swarm asking for 3 would come back
    // holding 3 clients pointed at fewer browsers.
    expect(fixture.calls.some((c) => c.subject === 'nightly-crawler')).toBe(false);
    expect(fixture.calls.map((c) => c.stickyWithinMs)).toEqual([900_000, 900_000, 900_000]);
    expect(swarm.subject).toBe('nightly-crawler');
    expect(swarm.members.map((m) => m.subject)).toEqual([
      'nightly-crawler#0',
      'nightly-crawler#1',
      'nightly-crawler#2',
    ]);

    await swarm.close();
  });

  it('swarmMemberSubject() reproduces a slot subject from outside the swarm, and stays undefined when there is no subject', () => {
    expect(swarmMemberSubject('tenant-42', 0)).toBe('tenant-42#0');
    expect(swarmMemberSubject('tenant-42', 7)).toBe('tenant-42#7');
    expect(swarmMemberSubject(undefined, 3)).toBeUndefined();
  });

  it('two swarms opened with the same subject ask for the same slot subjects, which is how two processes address one browser set', async () => {
    const harnessA = createFakeGatewayHarness();
    const fixtureA = recordingSwarmFixture(harnessA);
    const openA = BrowserSwarm.open({
      size: 2,
      subject: 'team-shared',
      acquire: fixtureA.acquire,
      transport: fixtureA.transport,
    });
    await tick();
    for (let i = 0; i < 2; i++) completeSwarmMemberHandshake(harnessA, i);
    const swarmA = await openA;

    const harnessB = createFakeGatewayHarness();
    const fixtureB = recordingSwarmFixture(harnessB);
    const openB = BrowserSwarm.open({
      size: 2,
      subject: 'team-shared',
      acquire: fixtureB.acquire,
      transport: fixtureB.transport,
    });
    await tick();
    for (let i = 0; i < 2; i++) completeSwarmMemberHandshake(harnessB, i);
    const swarmB = await openB;

    expect(fixtureB.calls.map((c) => c.subject)).toEqual(fixtureA.calls.map((c) => c.subject));

    await swarmA.close();
    await swarmB.close();
  });

  it('with a subject, grow() after shrink() refills the freed slot rather than numbering past it, so that slot reattaches instead of launching', async () => {
    const harness = createFakeGatewayHarness();
    const fixture = recordingSwarmFixture(harness);
    const openPromise = BrowserSwarm.open({
      size: 3,
      subject: 'crawler',
      acquire: fixture.acquire,
      transport: fixture.transport,
    });
    await tick();
    for (let i = 0; i < 3; i++) completeSwarmMemberHandshake(harness, i);
    const swarm = await openPromise;

    await swarm.shrink(1); // drops slot 2
    const growPromise = swarm.grow(1);
    await tick();
    completeSwarmMemberHandshake(harness, 3); // the fourth SOCKET, still slot 2
    const added = await growPromise;

    expect(added[0]?.index).toBe(2);
    expect(added[0]?.subject).toBe('crawler#2');
    expect(fixture.calls.map((c) => c.subject)).toEqual([
      'crawler#0',
      'crawler#1',
      'crawler#2',
      'crawler#2',
    ]);
    expect(swarm.members.map((m) => m.subject)).toEqual(['crawler#0', 'crawler#1', 'crawler#2']);

    await swarm.close();
  });

  it('without a subject, grow() after shrink() keeps the original monotonic numbering: slot reuse is an ownership behaviour, not a change to anonymous swarms', async () => {
    const harness = createFakeGatewayHarness();
    const fixture = recordingSwarmFixture(harness);
    const openPromise = BrowserSwarm.open({
      size: 3,
      acquire: fixture.acquire,
      transport: fixture.transport,
    });
    await tick();
    for (let i = 0; i < 3; i++) completeSwarmMemberHandshake(harness, i);
    const swarm = await openPromise;

    await swarm.shrink(1);
    const growPromise = swarm.grow(1);
    await tick();
    completeSwarmMemberHandshake(harness, 3);
    const added = await growPromise;

    expect(added[0]?.index).toBe(3);
    expect(fixture.calls.map((c) => c.index)).toEqual([0, 1, 2, 3]);

    await swarm.close();
  });
});
