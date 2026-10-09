import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { QueueDepthTracker, claimAndPlace, enqueue } from '../../src/queue/queue.js';
import { createFakeClock } from '../support/fakeClock.js';
import { createMockStore } from '../support/mockStore.js';

describe('queue claim-then-place', () => {
  it('never double-pops the same entry under concurrent reconcile loops', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const depth = new QueueDepthTracker();
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    for (let i = 0; i < 5; i++) {
      await enqueue(
        store,
        depth,
        {
          tenantId,
          appId,
          poolId,
          specId: 'spec1',
          deadlineAt: new Date(clock.now() + 60_000).toISOString(),
        },
        20,
      );
    }

    const placedIds: string[] = [];
    const place = async (entry: { id: string }) => {
      placedIds.push(entry.id);
      return { kind: 'placed' as const, instanceId: newId('inst') };
    };

    // Two "concurrent" reconcile loops racing over the same five entries,
    // each asking to claim up to five. Store.claimPlacements is the
    // atomic compare-and-set: no entry may be claimed, and therefore
    // placed, by both loops.
    const [batchA, batchB] = await Promise.all([
      claimAndPlace(store, depth, 'router-a', 5, 3, new Date(clock.now()).toISOString(), place),
      claimAndPlace(store, depth, 'router-b', 5, 3, new Date(clock.now()).toISOString(), place),
    ]);

    const claimedIds = [...batchA, ...batchB].map((r) => r.id);
    expect(claimedIds).toHaveLength(5);
    expect(new Set(claimedIds).size).toBe(5); // no id claimed twice
    expect(placedIds).toHaveLength(5);
    expect(new Set(placedIds).size).toBe(5); // no id placed twice
    expect(depth.depth(poolId)).toBe(0);
  });

  it('a retry outcome returns the entry to queued and bumps attempts, without double placing it later', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const depth = new QueueDepthTracker();
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    const row = await enqueue(
      store,
      depth,
      {
        tenantId,
        appId,
        poolId,
        specId: 'spec1',
        deadlineAt: new Date(clock.now() + 60_000).toISOString(),
      },
      20,
    );

    let attempt = 0;
    const place = async (): Promise<
      { kind: 'retry'; error: string } | { kind: 'placed'; instanceId: string }
    > => {
      attempt += 1;
      if (attempt === 1) return { kind: 'retry', error: 'no_capacity' };
      return { kind: 'placed', instanceId: newId('inst') };
    };

    const first = await claimAndPlace(
      store,
      depth,
      'router-a',
      5,
      3,
      new Date(clock.now()).toISOString(),
      place,
    );
    expect(first).toHaveLength(1);
    expect(depth.depth(poolId)).toBe(1); // still queued, not double counted

    const second = await claimAndPlace(
      store,
      depth,
      'router-a',
      5,
      3,
      new Date(clock.now()).toISOString(),
      place,
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(row.id);
    expect(depth.depth(poolId)).toBe(0); // placed, released exactly once
    expect(attempt).toBe(2);
  });

  it('an entry past its deadline is failed without ever calling place', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const depth = new QueueDepthTracker();
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    await enqueue(
      store,
      depth,
      {
        tenantId,
        appId,
        poolId,
        specId: 'spec1',
        deadlineAt: new Date(clock.now() + 1000).toISOString(),
      },
      20,
    );
    clock.advance(2000); // past the deadline

    let placeCalls = 0;
    const place = async () => {
      placeCalls += 1;
      return { kind: 'placed' as const, instanceId: newId('inst') };
    };

    const claimed = await claimAndPlace(
      store,
      depth,
      'router-a',
      5,
      3,
      new Date(clock.now()).toISOString(),
      place,
    );
    expect(claimed).toHaveLength(1);
    expect(placeCalls).toBe(0);
    expect(depth.depth(poolId)).toBe(0);
  });

  it('enqueue enforces queueMaxDepth', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const depth = new QueueDepthTracker();
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    await enqueue(
      store,
      depth,
      {
        tenantId,
        appId,
        poolId,
        specId: 'spec1',
        deadlineAt: new Date(clock.now() + 60_000).toISOString(),
      },
      1,
    );
    await expect(
      enqueue(
        store,
        depth,
        {
          tenantId,
          appId,
          poolId,
          specId: 'spec1',
          deadlineAt: new Date(clock.now() + 60_000).toISOString(),
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'E_QUEUE_FULL' });
  });
});
