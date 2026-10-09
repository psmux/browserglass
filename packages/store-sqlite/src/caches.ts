/**
 * The in-adapter TTL caches the store contract documents on three specific
 * `Store` methods: `getAppKey` (30s, with 5s negative caching),
 * `getQuotas` (30s), and `checkRevoked` (2s). A tiny generic cache, not a
 * dependency, since the whole point is a bounded number of small maps with
 * one clock source.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** A `Map`-backed TTL cache. `positiveTtlMs` covers a hit; `negativeTtlMs` (defaults to `positiveTtlMs`) covers a cached `null`/miss, letting a caller give a hot "not found" path a shorter TTL than a hot "found" path. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();

  constructor(
    private readonly positiveTtlMs: number,
    private readonly isNegative: (v: V) => boolean,
    private readonly negativeTtlMs: number = positiveTtlMs,
  ) {}

  get(key: K, now: number): { hit: true; value: V } | { hit: false } {
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return { hit: false };
    }
    return { hit: true, value: entry.value };
  }

  set(key: K, value: V, now: number): void {
    const ttl = this.isNegative(value) ? this.negativeTtlMs : this.positiveTtlMs;
    this.entries.set(key, { value, expiresAt: now + ttl });
  }

  invalidate(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
