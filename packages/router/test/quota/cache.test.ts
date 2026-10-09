import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/quota/cache.js';
import { CachedQuotaResolver } from '../../src/quota/resolve.js';
import { createFakeClock } from '../support/fakeClock.js';

describe('TtlCache', () => {
  it('returns null for a missing key', () => {
    const clock = createFakeClock();
    const cache = new TtlCache<number>(clock, 1000);
    expect(cache.get('x')).toBeNull();
  });

  it('returns the cached value before expiry', () => {
    const clock = createFakeClock();
    const cache = new TtlCache<number>(clock, 1000);
    cache.set('x', 42);
    clock.advance(999);
    expect(cache.get('x')).toBe(42);
  });

  it('expires exactly at the ttl boundary', () => {
    const clock = createFakeClock();
    const cache = new TtlCache<number>(clock, 1000);
    cache.set('x', 42);
    clock.advance(1000);
    expect(cache.get('x')).toBeNull();
  });

  it('getOrCompute only calls fn once while cached', async () => {
    const clock = createFakeClock();
    const cache = new TtlCache<number>(clock, 1000);
    const fn = vi.fn().mockResolvedValue(7);
    expect(await cache.getOrCompute('x', fn)).toBe(7);
    expect(await cache.getOrCompute('x', fn)).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invalidate forces a fresh compute', async () => {
    const clock = createFakeClock();
    const cache = new TtlCache<number>(clock, 1000);
    let n = 0;
    const fn = () => Promise.resolve(++n);
    expect(await cache.getOrCompute('x', fn)).toBe(1);
    cache.invalidate('x');
    expect(await cache.getOrCompute('x', fn)).toBe(2);
  });
});

describe('CachedQuotaResolver', () => {
  it('caches QuotaProvider.limits() for quotaCacheMs', async () => {
    const clock = createFakeClock();
    const limitsFn = vi.fn().mockResolvedValue({
      maxInstances: 10,
      maxInstancesPerApp: 10,
      maxInstancesPerUser: 10,
      maxViewers: 10,
      maxProfiles: 10,
      maxProfileBytes: 1,
      maxSessionMinutesPerDay: 1,
      maxAcquiresPerMinute: 1,
      maxFrameBytesPerMinute: 1,
    });
    const resolver = new CachedQuotaResolver({ limits: limitsFn }, clock, 5000);

    await resolver.limits('ten_1', 'app_1');
    await resolver.limits('ten_1', 'app_1');
    expect(limitsFn).toHaveBeenCalledTimes(1);

    clock.advance(5000);
    await resolver.limits('ten_1', 'app_1');
    expect(limitsFn).toHaveBeenCalledTimes(2);
  });
});
