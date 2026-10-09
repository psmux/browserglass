/**
 * A small keyed TTL cache, driven by an injectable `Clock` rather than the
 * wall clock, so cache expiry is testable without waiting on real time.
 * Used to cache resolved quota limits for `quotaCacheMs` (default 5000ms).
 */

import type { Clock } from '../router/clock.js';

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** A keyed cache with a fixed time to live per entry and lazy expiry (checked on read, never swept on a timer). */
export class TtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
  ) {}

  /** The cached value for `key`, or `null` if absent or expired. */
  get(key: string): V | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Stores `value` for `key`, resetting its expiry to `now + ttlMs`. */
  set(key: string, value: V): void {
    this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  /** Removes `key`, if present. Used to force a fresh read after a mutation the cache should not mask. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Returns the cached value for `key`, or computes it with `fn`, caches, and returns it. */
  async getOrCompute(key: string, fn: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const value = await fn();
    this.set(key, value);
    return value;
  }
}
