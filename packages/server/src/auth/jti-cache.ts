import type { JtiCache } from '@browserglass/protocol';

interface Entry {
  readonly expEpochSec: number;
}

/**
 * Per gateway process replay cache for token `jti`s. Insertion ordered map
 * keyed by `${aid}:${jti}`. Capacity default 200000 entries (about 20 MiB).
 * Eviction sweeps by expiry first, then oldest first once at capacity.
 * Eviction under pressure is deliberately fail open: a full cache admits
 * the token rather than rejecting a legitimate client, because fail closed
 * here is a denial of service vector. A `jti` whose lifetime
 * (`exp - iat`) exceeds 300 seconds is never cached or replay checked,
 * since a long lived token is assumed intended for repeated use.
 */
export class InProcessJtiCache implements JtiCache {
  private readonly capacity: number;
  private readonly entries = new Map<string, Entry>();
  private lastSweepAt = 0;
  private readonly sweepIntervalMs = 10_000;
  private evictedTotal = 0;

  constructor(capacity = 200_000) {
    this.capacity = capacity;
  }

  /** Total entries evicted under capacity pressure since construction. Exposed for `bgls_auth_jti_cache_evicted_total`. */
  get evictedCount(): number {
    return this.evictedTotal;
  }

  size(): number {
    return this.entries.size;
  }

  admit(aid: string, jti: string, expSec: number): boolean {
    this.sweepIfDue();
    const key = `${aid}:${jti}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.expEpochSec > nowSec) {
      return false;
    }
    this.entries.set(key, { expEpochSec: expSec });
    this.evictIfOverCapacity();
    return true;
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    const nowSec = Math.floor(now / 1000);
    for (const [key, entry] of this.entries) {
      if (entry.expEpochSec <= nowSec) this.entries.delete(key);
    }
  }

  private evictIfOverCapacity(): void {
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.evictedTotal += 1;
    }
  }
}

/** Tokens with `exp - iat` above this many seconds are never cached or replay checked (long lived, repeated use assumed). */
export const JTI_CACHE_MAX_LIFETIME_SEC = 300;
