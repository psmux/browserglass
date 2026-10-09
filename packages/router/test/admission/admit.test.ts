import type { PoolLimits, QuotaLimits } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { admit } from '../../src/admission/admit.js';
import type { LiveCounts } from '../../src/admission/counts.js';

const LIMITS: QuotaLimits = {
  maxInstances: 10,
  maxInstancesPerApp: 10,
  maxInstancesPerUser: 10,
  maxViewers: 100,
  maxProfiles: 100,
  maxProfileBytes: 1_000_000_000,
  maxSessionMinutesPerDay: 100_000,
  maxAcquiresPerMinute: 100,
  maxFrameBytesPerMinute: 1_000_000_000,
};

function poolLimits(
  onFull: PoolLimits['onFull'],
  maxInstances = 10,
  maxInstancesPerUser = 10,
): PoolLimits {
  return {
    maxInstances,
    maxInstancesPerUser,
    maxViewersPerStream: 8,
    maxStreamsPerSession: 8,
    sessionIdleMs: 0,
    sessionMaxDurationMs: 0,
    onFull,
    queueMaxDepth: 20,
    queueMaxWaitMs: 60_000,
  };
}

const ZERO: LiveCounts = { tenantLive: 0, appLive: 0, poolLive: 0, userLive: 0 };

describe('admit', () => {
  it('admits when every scope has headroom', () => {
    expect(admit(ZERO, LIMITS, poolLimits('reject'), undefined)).toEqual({ kind: 'admit' });
  });

  it('rejects at the tenant scope, cheapest first', () => {
    const counts: LiveCounts = { ...ZERO, tenantLive: 10 };
    const verdict = admit(counts, LIMITS, poolLimits('reject'), undefined);
    expect(verdict).toMatchObject({ kind: 'reject', scope: 'tenant', limit: 10, current: 10 });
  });

  it('checks app before pool before user', () => {
    const counts: LiveCounts = { tenantLive: 0, appLive: 10, poolLive: 10, userLive: 10 };
    const verdict = admit(counts, LIMITS, poolLimits('reject'), undefined);
    expect(verdict).toMatchObject({ kind: 'reject', scope: 'app' });
  });

  it('defaults to queue at the pool onFull policy', () => {
    const counts: LiveCounts = { ...ZERO, poolLive: 10 };
    const verdict = admit(counts, LIMITS, poolLimits('queue'), undefined);
    expect(verdict.kind).toBe('queue');
  });

  it('evictIdle policy reports evict', () => {
    const counts: LiveCounts = { ...ZERO, poolLive: 10 };
    const verdict = admit(counts, LIMITS, poolLimits('evictIdle'), undefined);
    expect(verdict.kind).toBe('evict');
  });

  it("a request may narrow the pool's onFull to reject, but never widen reject to queue", () => {
    const counts: LiveCounts = { ...ZERO, poolLive: 10 };
    const narrowed = admit(counts, LIMITS, poolLimits('queue'), 'reject');
    expect(narrowed.kind).toBe('reject');

    const cannotWiden = admit(counts, LIMITS, poolLimits('reject'), 'queue');
    expect(cannotWiden.kind).toBe('reject');
  });

  it('ignores a non-finite (unlimited) scope', () => {
    const unlimited: QuotaLimits = { ...LIMITS, maxInstances: Number.POSITIVE_INFINITY };
    const counts: LiveCounts = { ...ZERO, tenantLive: 999_999 };
    expect(admit(counts, unlimited, poolLimits('reject'), undefined)).toEqual({ kind: 'admit' });
  });

  /**
   * A swarm of more than the OLD per-subject ceiling is admitted under the
   * new defaults. `admit()`'s `'user'` scope check reads
   * `poolLimits.maxInstancesPerUser`
   * (`packages/store-sqlite/src/defaults.ts`'s `DEFAULT_POOL_LIMITS`,
   * raised from 10 to 50 in step with
   * `packages/server/src/config/resolve.ts`'s own
   * `limits.maxInstancesPerSubject` fallback, also raised, from 3 to 50).
   * A fleet of 40 agents sharing one owner identity stalled well before
   * this under either old number; it is admitted now, all the way up to
   * the new ceiling.
   */
  it('a swarm of 40 browsers under one subject is admitted, past both of the old per-subject ceilings (3 and 10)', () => {
    const swarmLimits: QuotaLimits = { ...LIMITS, maxInstances: 1000, maxInstancesPerApp: 1000 };
    const swarmPool = poolLimits('reject', 1000, 50);

    for (let userLive = 0; userLive < 40; userLive += 1) {
      const counts: LiveCounts = {
        tenantLive: userLive,
        appLive: userLive,
        poolLive: userLive,
        userLive,
      };
      expect(admit(counts, swarmLimits, swarmPool, undefined)).toEqual({ kind: 'admit' });
    }

    // The rail is still real: the 41st through 50th are still admitted...
    for (let userLive = 40; userLive < 50; userLive += 1) {
      const counts: LiveCounts = {
        tenantLive: userLive,
        appLive: userLive,
        poolLive: userLive,
        userLive,
      };
      expect(admit(counts, swarmLimits, swarmPool, undefined)).toEqual({ kind: 'admit' });
    }
    // ...and the 51st, at the new ceiling, is refused at the user scope,
    // not silently let through.
    const atCeiling: LiveCounts = { tenantLive: 50, appLive: 50, poolLive: 50, userLive: 50 };
    expect(admit(atCeiling, swarmLimits, swarmPool, undefined)).toMatchObject({
      kind: 'reject',
      scope: 'user',
      limit: 50,
    });
  });
});
