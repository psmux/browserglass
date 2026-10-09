import { describe, expect, it } from 'vitest';
import { TokenBucket, TokenBucketRegistry } from '../../src/admission/tokenBucket.js';
import { createFakeClock } from '../support/fakeClock.js';

describe('TokenBucket', () => {
  it('allows up to capacity, then refuses', () => {
    const clock = createFakeClock();
    const bucket = new TokenBucket(clock, 3, 60); // 3 capacity, 60/min = 1/sec refill
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('refills over time, driven by the fake clock', () => {
    const clock = createFakeClock();
    const bucket = new TokenBucket(clock, 1, 60); // 1/sec refill
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    clock.advance(1000);
    expect(bucket.tryTake()).toBe(true);
  });

  it('never exceeds capacity even after a long idle period', () => {
    const clock = createFakeClock();
    const bucket = new TokenBucket(clock, 2, 60);
    clock.advance(1_000_000);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('retryAfterMs is 0 when a token is available, positive otherwise', () => {
    const clock = createFakeClock();
    const bucket = new TokenBucket(clock, 1, 60);
    expect(bucket.retryAfterMs()).toBe(0);
    bucket.tryTake();
    expect(bucket.retryAfterMs()).toBeGreaterThan(0);
  });
});

describe('TokenBucketRegistry', () => {
  it('creates one bucket per key, independent of the others', () => {
    const clock = createFakeClock();
    const registry = new TokenBucketRegistry(clock);
    const a = registry.bucketFor('tenant-a', 1, 60);
    const b = registry.bucketFor('tenant-b', 1, 60);
    expect(a.tryTake()).toBe(true);
    expect(a.tryTake()).toBe(false);
    expect(b.tryTake()).toBe(true); // tenant-b unaffected by tenant-a's exhaustion
  });

  it('returns the same bucket instance for a repeat key', () => {
    const clock = createFakeClock();
    const registry = new TokenBucketRegistry(clock);
    const first = registry.bucketFor('tenant-a', 5, 60);
    const second = registry.bucketFor('tenant-a', 999, 999); // ignored: already created
    expect(first).toBe(second);
  });
});
