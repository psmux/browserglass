/**
 * An in process token bucket. A multi node deployment would need a shared
 * counter (a sliding window in Redis, say); a single process gets by with
 * this. Used for `maxAcquiresPerMinute`. Driven entirely by an injected
 * `Clock`, never the wall clock directly, so a test can exercise refill
 * without waiting on real time.
 */

import type { Clock } from '../router/clock.js';

/** One rate limited bucket: `capacity` tokens, refilling at `refillPerMs` tokens per millisecond. */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly clock: Clock,
    private readonly capacity: number,
    /** Tokens refilled per minute. `capacity` is also the burst ceiling. */
    private readonly refillPerMinute: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = Math.max(0, now - this.lastRefillAt);
    if (elapsedMs === 0) return;
    const refilled = (elapsedMs / 60_000) * this.refillPerMinute;
    if (refilled > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refilled);
      this.lastRefillAt = now;
    }
  }

  /** Attempts to take one token. Returns `true` (and consumes it) when available, `false` otherwise. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until at least one token is available, `0` if one already is. */
  retryAfterMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.refillPerMinute) * 60_000);
  }
}

/**
 * Keyed `TokenBucket`s, one per tenant, created lazily on first use.
 * `capacity`/`refillPerMinute` are supplied at first use (a tenant's
 * `maxAcquiresPerMinute` is only known once its quotas are resolved) and
 * fixed for that key's lifetime thereafter; a later call with different
 * numbers for an already created key is ignored, since a rate limit
 * changing mid flight is rare enough that a process restart picking it up
 * is an acceptable simplification for this build.
 */
export class TokenBucketRegistry {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly clock: Clock) {}

  /** The bucket for `key` (typically a tenant id), created with `capacity`/`refillPerMinute` on first use. */
  bucketFor(key: string, capacity: number, refillPerMinute: number): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.clock, capacity, refillPerMinute);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}
