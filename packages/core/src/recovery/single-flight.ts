/**
 * `SingleFlight<K>`: the re-entrancy guard the recovery runner uses at both
 * of its two lock scopes (target, keyed `${instanceId}:${targetId}`, guards
 * `R0` to `R3`; instance, keyed `instanceId` alone, guards `R4`).
 *
 * Critical rule: a caller that gets `'waited'` must
 * re-derive its own health rather than assume the winner's success is its
 * success. This class only provides the coalescing primitive; the caller
 * (`runner.ts`) is the one that honours the rule.
 */

/** What one `SingleFlight.run()` call resolves to: `'ran'` if this call actually executed `fn`, `'waited'` if it coalesced onto an already in-flight call for the same key. */
export type SingleFlightOutcome = 'ran' | 'waited';

/**
 * Coalesces concurrent calls for the same key into one execution. A second
 * caller for a key already in flight awaits the first call's completion
 * (swallowing its rejection, since a failed recovery is not this caller's
 * failure to propagate) and returns `'waited'` without running `fn` again.
 */
export class SingleFlight<K> {
  private readonly inFlight = new Map<K, Promise<void>>();

  /** Runs `fn` for `key`, or waits for an already in-flight run for the same key. */
  async run(key: K, fn: () => Promise<void>): Promise<SingleFlightOutcome> {
    const existing = this.inFlight.get(key);
    if (existing) {
      await existing.catch(() => {});
      return 'waited';
    }
    const p = fn();
    this.inFlight.set(key, p);
    try {
      await p;
    } finally {
      this.inFlight.delete(key);
    }
    return 'ran';
  }

  /** Whether `key` currently has an in-flight run. */
  isRunning(key: K): boolean {
    return this.inFlight.has(key);
  }
}

/** The target-scope lock key: `${instanceId}:${targetId}` (guards `R0` to `R3`). */
export function targetFlightKey(instanceId: string, targetId: string): string {
  return `${instanceId}:${targetId}`;
}
