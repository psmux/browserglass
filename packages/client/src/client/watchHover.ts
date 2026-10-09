import type { ProbeResult } from './types.js';

/** Sends one `target.probe{detail:'hover'}` and resolves its result, or rejects on failure/timeout. */
export type ProbeFn = (x: number, y: number) => Promise<ProbeResult>;

/**
 * Drives `client.probe()` with the exact four-step coalescing algorithm
 * `watchHover()` uses, kept in its own class so
 * it is testable with synthetic positions independent of any DOM pointer
 * event:
 *
 * 1. `feed()` accepts every position with no sampling and no timer debounce.
 * 2. No probe in flight for this target: fire immediately with the given position.
 * 3. A probe IS in flight: only the latest position is remembered; repeated
 *    calls overwrite it at zero cost.
 * 4. When the answer lands: if the latest fed position differs from the one
 *    the in-flight probe was asked about, the answer is discarded and a new
 *    probe fires immediately with the latest position. If it matches (and
 *    the target generation has not moved on since the ask), the answer is
 *    delivered and the slot frees.
 *
 * This self-limits to one probe per round trip; a failed request retries
 * with whatever position is latest, the same way a stale answer would.
 */
export class HoverWatcher {
  private readonly probeFn: ProbeFn;
  private readonly currentGen: () => number;
  private readonly callback: (r: ProbeResult | null) => void;

  private inFlight = false;
  private latest: { x: number; y: number } | null = null;
  private askedFor: { x: number; y: number } | null = null;
  private stopped = false;

  constructor(
    probeFn: ProbeFn,
    currentGen: () => number,
    callback: (r: ProbeResult | null) => void,
  ) {
    this.probeFn = probeFn;
    this.currentGen = currentGen;
    this.callback = callback;
  }

  /** Step 1: feed one raw pointer position, in frame space. */
  feed(x: number, y: number): void {
    if (this.stopped) return;
    this.latest = { x, y };
    if (!this.inFlight) this.fire();
  }

  /** The pointer left the canvas: no more positions until the next `feed()`, and the app hears `null` right away. */
  leave(): void {
    if (this.stopped) return;
    this.latest = null;
    this.callback(null);
  }

  /** Stops accepting new positions and discards whatever answer an in-flight probe eventually returns. */
  stop(): void {
    this.stopped = true;
    this.latest = null;
  }

  private fire(): void {
    const pos = this.latest;
    if (!pos) return;
    this.inFlight = true;
    this.askedFor = pos;
    const genAtAsk = this.currentGen();
    this.probeFn(pos.x, pos.y).then(
      (result) => this.settle(result, genAtAsk),
      () => this.settle(null, genAtAsk),
    );
  }

  private settle(result: ProbeResult | null, genAtAsk: number): void {
    this.inFlight = false;
    if (this.stopped) return;

    const asked = this.askedFor;
    const latest = this.latest;
    const stillCurrent =
      latest !== null && asked !== null && latest.x === asked.x && latest.y === asked.y;

    // Step 4: a newer position arrived while this probe was in flight, or
    // the pointer left the canvas in the meantime: discard and re-fire
    // with whatever is latest now.
    if (!stillCurrent) {
      if (latest) this.fire();
      return;
    }

    // Discard a request failure or a stale target generation the same way:
    // whatever is current is worth one more try, nothing is worth
    // delivering as an answer.
    if (result === null || result.gen !== genAtAsk || this.currentGen() !== genAtAsk) {
      return;
    }

    this.callback(result);
  }
}
