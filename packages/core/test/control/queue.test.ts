import { describe, expect, it } from 'vitest';
import {
  HoldDurationTracker,
  MIN_HOLD_SAMPLES,
  insertIntoQueue,
  queuePositionFor,
  removeFromQueue,
} from '../../src/control/queue.js';
import type { QueueEntry } from '../../src/control/types.js';

function entry(viewerId: string, priority: number, requestedAt = 0): QueueEntry {
  return {
    viewerId,
    identity: `id:${viewerId}`,
    label: viewerId,
    kind: 'human',
    priority,
    requestedAt,
    expiresAt: requestedAt + 120_000,
  };
}

describe('insertIntoQueue', () => {
  it('is FIFO within equal priority', () => {
    let queue: QueueEntry[] = [];
    queue = insertIntoQueue(queue, entry('a', 100, 1));
    queue = insertIntoQueue(queue, entry('b', 100, 2));
    queue = insertIntoQueue(queue, entry('c', 100, 3));
    expect(queue.map((e) => e.viewerId)).toEqual(['a', 'b', 'c']);
  });

  it('places a higher-priority entry ahead of lower-priority ones already queued', () => {
    let queue: QueueEntry[] = [];
    queue = insertIntoQueue(queue, entry('low', 50, 1));
    queue = insertIntoQueue(queue, entry('mid', 100, 2));
    queue = insertIntoQueue(queue, entry('high', 900, 3));
    expect(queue.map((e) => e.viewerId)).toEqual(['high', 'mid', 'low']);
  });

  it('a new entry at an already-represented priority goes after existing equal-priority entries (still FIFO)', () => {
    let queue: QueueEntry[] = [];
    queue = insertIntoQueue(queue, entry('first', 100, 1));
    queue = insertIntoQueue(queue, entry('high', 900, 2));
    queue = insertIntoQueue(queue, entry('second', 100, 3));
    expect(queue.map((e) => e.viewerId)).toEqual(['high', 'first', 'second']);
  });
});

describe('removeFromQueue', () => {
  it('removes the named viewer and leaves the rest in order', () => {
    let queue: QueueEntry[] = [entry('a', 100), entry('b', 100), entry('c', 100)];
    queue = removeFromQueue(queue, 'b');
    expect(queue.map((e) => e.viewerId)).toEqual(['a', 'c']);
  });
});

describe('queuePositionFor: computed per recipient', () => {
  const queue: QueueEntry[] = [entry('a', 100), entry('b', 100), entry('c', 100)];

  it('returns each viewer their own 1-based position, not a single shared value', () => {
    expect(queuePositionFor(queue, 'a')).toBe(1);
    expect(queuePositionFor(queue, 'b')).toBe(2);
    expect(queuePositionFor(queue, 'c')).toBe(3);
  });

  it('returns null for a viewer not in the queue, and for a null recipient', () => {
    expect(queuePositionFor(queue, 'nobody')).toBeNull();
    expect(queuePositionFor(queue, null)).toBeNull();
  });
});

describe('HoldDurationTracker', () => {
  it('estimateWaitMs returns null below MIN_HOLD_SAMPLES recorded holds', () => {
    const tracker = new HoldDurationTracker();
    for (let i = 0; i < MIN_HOLD_SAMPLES - 1; i++) tracker.record(5_000);
    expect(tracker.estimateWaitMs(1, 30_000)).toBeNull();
  });

  it('estimateWaitMs returns position * min(idleExpiryMs, medianHoldMs) once enough samples exist', () => {
    const tracker = new HoldDurationTracker();
    for (let i = 0; i < MIN_HOLD_SAMPLES; i++) tracker.record(10_000);
    expect(tracker.medianMs()).toBe(10_000);
    expect(tracker.estimateWaitMs(3, 30_000)).toBe(3 * 10_000);
    // idleExpiryMs is the ceiling: a much longer median hold does not blow the estimate past it.
    for (let i = 0; i < MIN_HOLD_SAMPLES; i++) tracker.record(100_000);
    expect(tracker.estimateWaitMs(2, 30_000)).toBeLessThanOrEqual(2 * 30_000);
  });
});
