import { type PoolLimits, type QuotaLimits, newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { releaseAdmission, reserveAdmission } from '../../src/admission/reserve.js';
import { createFakeClock } from '../support/fakeClock.js';
import { createMockStore } from '../support/mockStore.js';

const LIMITS: QuotaLimits = {
  maxInstances: 1,
  maxInstancesPerApp: 1000,
  maxInstancesPerUser: 1000,
  maxViewers: 1000,
  maxProfiles: 1000,
  maxProfileBytes: 1_000_000_000,
  maxSessionMinutesPerDay: 100_000,
  maxAcquiresPerMinute: 1000,
  maxFrameBytesPerMinute: 1_000_000_000,
};

const POOL_LIMITS: PoolLimits = {
  maxInstances: 1000,
  maxInstancesPerUser: 1000,
  maxViewersPerStream: 8,
  maxStreamsPerSession: 8,
  sessionIdleMs: 1_800_000,
  sessionMaxDurationMs: 14_400_000,
  onFull: 'reject',
  queueMaxDepth: 20,
  queueMaxWaitMs: 60_000,
};

describe('reserveAdmission, real concurrency', () => {
  it('admits exactly one of two simultaneous acquires against a tenant limit of one', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    // Two "simultaneous" calls: neither awaits anything before the other
    // starts, exercising the same race a real concurrent HTTP handler pair
    // would hit. reserveAdmission's own internal awaits interleave with
    // Promise.all the same way two independent event loop turns would.
    const [a, b] = await Promise.all([
      reserveAdmission(store, tenantId, appId, poolId, 'user-a', LIMITS, POOL_LIMITS),
      reserveAdmission(store, tenantId, appId, poolId, 'user-b', LIMITS, POOL_LIMITS),
    ]);

    const results = [a, b];
    const reserved = results.filter((r) => r.kind === 'reserved');
    const refused = results.filter((r) => r.kind === 'refused');
    expect(reserved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    if (refused[0]?.kind === 'refused') {
      expect(refused[0].scope).toBe('tenant');
      expect(refused[0].limit).toBe(1);
    }
  });

  it('a released reservation frees the slot for a subsequent caller', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    const first = await reserveAdmission(
      store,
      tenantId,
      appId,
      poolId,
      'user-a',
      LIMITS,
      POOL_LIMITS,
    );
    expect(first.kind).toBe('reserved');

    const blocked = await reserveAdmission(
      store,
      tenantId,
      appId,
      poolId,
      'user-b',
      LIMITS,
      POOL_LIMITS,
    );
    expect(blocked.kind).toBe('refused');

    if (first.kind === 'reserved') await releaseAdmission(store, first.reservation);

    const afterRelease = await reserveAdmission(
      store,
      tenantId,
      appId,
      poolId,
      'user-c',
      LIMITS,
      POOL_LIMITS,
    );
    expect(afterRelease.kind).toBe('reserved');
  });

  it('ten concurrent reservations against a limit of one admit exactly one', async () => {
    const clock = createFakeClock();
    const store = createMockStore(clock);
    const tenantId = newId('ten');
    const appId = newId('app');
    const poolId = newId('pol');

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveAdmission(store, tenantId, appId, poolId, `user-${i}`, LIMITS, POOL_LIMITS),
      ),
    );
    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'refused')).toHaveLength(9);
  });
});
