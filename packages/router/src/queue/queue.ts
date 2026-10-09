/**
 * The acquire queue. Field for field identical to the `placement_queue`
 * table, which is exactly `protocol`'s `PlacementRow`/`NewPlacement`
 * (`Store.enqueuePlacement`/`claimPlacements`/`completePlacement`/
 * `failPlacement`), this module is a thin, typed wrapper around those
 * `Store` methods rather than a second queue implementation.
 *
 * Dequeue is claim-then-place: `Store.claimPlacements` is documented as
 * atomic (`SELECT ... FOR UPDATE SKIP LOCKED` on Postgres, an `UPDATE`
 * inside the single writer lock on SQLite), which is what prevents two
 * concurrent reconcile loops from claiming, and placing, the same queued
 * request twice, even single process.
 *
 * `Store`'s placement queue surface has no depth query (only enqueue,
 * claim, complete, fail), so the `queueMaxDepth` cap this module enforces
 * (`E_QUEUE_FULL`) is tracked in an in process counter, `QueueDepthTracker`,
 * rather than a live store count. This does not survive a process
 * restart, a deliberate choice, since a durable depth query would need a
 * `Store` method the protocol does not define.
 */

import type { NewPlacement, PlacementRow, Store } from '@browserglass/protocol';
import { routerErr } from '../router/errors.js';

/** Per pool queue depth, tracked in process since `Store` exposes no count query for `placement_queue`. */
export class QueueDepthTracker {
  private readonly depthByPool = new Map<string, number>();

  depth(poolId: string): number {
    return this.depthByPool.get(poolId) ?? 0;
  }

  increment(poolId: string): void {
    this.depthByPool.set(poolId, this.depth(poolId) + 1);
  }

  decrement(poolId: string): void {
    const next = this.depth(poolId) - 1;
    if (next <= 0) this.depthByPool.delete(poolId);
    else this.depthByPool.set(poolId, next);
  }
}

/**
 * Enqueues one acquire request. Enforces `queueMaxDepth` (default 20)
 * against the in process depth tracker before calling
 * `Store.enqueuePlacement`, throwing `E_QUEUE_FULL` rather than accepting
 * an unbounded queue.
 */
export async function enqueue(
  store: Store,
  depth: QueueDepthTracker,
  req: NewPlacement,
  queueMaxDepth: number,
): Promise<PlacementRow> {
  if (depth.depth(req.poolId) >= queueMaxDepth) {
    throw routerErr(
      'E_QUEUE_FULL',
      `queue for pool ${req.poolId} is at its depth cap of ${queueMaxDepth}`,
    );
  }
  const row = await store.enqueuePlacement(req);
  depth.increment(req.poolId);
  return row;
}

/** The outcome of one claimed placement attempt, as reported back to `claimAndPlace`. */
export type PlaceAttemptOutcome =
  | { kind: 'placed'; instanceId: string }
  | { kind: 'retry'; error: string }
  | { kind: 'abandon'; error: string };

/**
 * Claims up to `limit` queued entries via `Store.claimPlacements` (the
 * atomic compare-and-set step, so two concurrent calls to `claimAndPlace`
 * never claim the same row) and, for each one, either expires it
 * (`deadlineAt` already passed: `queued -> abandoned`, approximated as
 * `failPlacement(id, ..., false)` since `Store`'s placement queue surface has no direct status setter
 * beyond `complete`/`fail`, see this module's top comment) or attempts to
 * place it with `place`. A `'retry'` outcome bumps `attempts` and returns
 * the entry to `queued` unless `queueMaxAttempts` is reached, at which
 * point it is failed outright.
 *
 * Deadline expiry is checked here, inside the same claim, rather than as
 * a separate scan: `Store` has no query to list queued entries without
 * claiming them, and claiming an entry only to immediately release it back
 * unplaced would spuriously bump `attempts` on a request that was never
 * actually tried.
 */
export async function claimAndPlace(
  store: Store,
  depth: QueueDepthTracker,
  routerId: string,
  limit: number,
  queueMaxAttempts: number,
  nowIso: string,
  place: (entry: PlacementRow) => Promise<PlaceAttemptOutcome>,
): Promise<PlacementRow[]> {
  const claimed = await store.claimPlacements(routerId, limit);
  for (const entry of claimed) {
    if (entry.deadlineAt <= nowIso) {
      await store.failPlacement(entry.id, 'queue_timeout', false);
      depth.decrement(entry.poolId);
      continue;
    }
    const outcome = await place(entry);
    if (outcome.kind === 'placed') {
      await store.completePlacement(entry.id, outcome.instanceId);
      depth.decrement(entry.poolId);
    } else if (outcome.kind === 'retry' && entry.attempts + 1 < queueMaxAttempts) {
      await store.failPlacement(entry.id, outcome.error, true);
    } else {
      await store.failPlacement(entry.id, outcome.error, false);
      depth.decrement(entry.poolId);
    }
  }
  return claimed;
}
