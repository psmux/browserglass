/**
 * The FIFO waiting queue for a `Lease`: insertion order within equal
 * priority, highest priority first, and the `estimatedWaitMs` guess,
 * defined as `position * min(idleExpiryMs, medianHoldMs)`, which this module
 * refuses to offer below a sample floor.
 */

import type { QueueEntry } from './types.js';

/**
 * Inserts `entry` into `queue`, preserving highest-priority-first ordering
 * and FIFO (insertion order) among entries of equal priority. Returns a new
 * array; does not mutate `queue`.
 */
export function insertIntoQueue(queue: readonly QueueEntry[], entry: QueueEntry): QueueEntry[] {
  const at = queue.findIndex((existing) => existing.priority < entry.priority);
  const index = at === -1 ? queue.length : at;
  return [...queue.slice(0, index), entry, ...queue.slice(index)];
}

/** Returns `queue` with `viewerId`'s entry removed, if present. Returns a new array; does not mutate `queue`. */
export function removeFromQueue(queue: readonly QueueEntry[], viewerId: string): QueueEntry[] {
  return queue.filter((entry) => entry.viewerId !== viewerId);
}

/** Returns `queue` with every entry whose `expiresAt` is at or before `now` removed. */
export function expireQueue(queue: readonly QueueEntry[], now: number): QueueEntry[] {
  return queue.filter((entry) => entry.expiresAt > now);
}

/**
 * This recipient's 1-based position in `queue`, or `null` if they are not
 * queued. Deliberately per-recipient: calling this once per viewer, rather than computing one shared
 * value, is what makes `control.state`'s per-viewer projection correct.
 */
export function queuePositionFor(
  queue: readonly QueueEntry[],
  viewerId: string | null,
): number | null {
  if (viewerId === null) return null;
  const index = queue.findIndex((entry) => entry.viewerId === viewerId);
  return index === -1 ? null : index + 1;
}

/** The minimum number of recorded hold durations before {@link HoldDurationTracker.estimateWaitMs} returns a guess instead of `null`. */
export const MIN_HOLD_SAMPLES = 10;

const MAX_HOLD_SAMPLES = 50;

/**
 * Tracks how long recent holders kept the lease, so the queue can offer a
 * labelled guess at `estimatedWaitMs`. Below {@link MIN_HOLD_SAMPLES}
 * recorded holds, `estimateWaitMs` returns `null` rather than a guess.
 */
export class HoldDurationTracker {
  private readonly samples: number[] = [];

  /** Records how long a just-ended tenure held the lease. */
  record(durationMs: number): void {
    this.samples.push(Math.max(0, durationMs));
    if (this.samples.length > MAX_HOLD_SAMPLES) this.samples.shift();
  }

  /** The median of the recorded hold durations, or `null` below {@link MIN_HOLD_SAMPLES} samples. */
  medianMs(): number | null {
    if (this.samples.length < MIN_HOLD_SAMPLES) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const lower = sorted[mid - 1];
    const upper = sorted[mid];
    if (upper === undefined) return null;
    return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
  }

  /**
   * `position * min(idleExpiryMs, medianHoldMs)` (the wire
   * `control.queued.estimatedWaitMs`), or `null` when there are not
   * yet enough samples to call it more than a guess.
   */
  estimateWaitMs(position: number, idleExpiryMs: number): number | null {
    const median = this.medianMs();
    if (median === null) return null;
    return position * Math.min(idleExpiryMs, median);
  }
}
