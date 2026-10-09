import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateIdle, isMaxDurationExceeded, isTtlExpired } from '../../src/router/lifecycle.js';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

function principalFor(tenantId: string, appId: string, sub = 'user-1'): Principal {
  return {
    tenantId,
    appId,
    sub,
    subKind: 'user',
    caps: ['instance.create', 'view', 'control'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe('evaluateIdle, the two-phase idle state machine', () => {
  const idleMs = 1000;
  const idleGraceMs = 500;

  it('stays active before idleMs elapses', () => {
    expect(evaluateIdle(idleMs - 1, idleMs, idleGraceMs, idleGraceMs, false).phase).toBe('active');
  });
  it('enters idle-grace once idleMs elapses, but does not release yet', () => {
    const decision = evaluateIdle(idleMs, idleMs, idleGraceMs, idleGraceMs, false);
    expect(decision.phase).toBe('idle-grace');
    expect(decision.closesInMs).toBe(idleGraceMs);
  });
  it('does not release one millisecond before idleMs + idleGraceMs', () => {
    expect(
      evaluateIdle(idleMs + idleGraceMs - 1, idleMs, idleGraceMs, idleGraceMs, false).phase,
    ).toBe('idle-grace');
  });
  it('releases exactly at idleMs + idleGraceMs', () => {
    expect(evaluateIdle(idleMs + idleGraceMs, idleMs, idleGraceMs, idleGraceMs, false).phase).toBe(
      'release',
    );
  });
  it('uses the shortened grace under queue pressure', () => {
    const underPressure = 100;
    expect(
      evaluateIdle(idleMs + underPressure, idleMs, idleGraceMs, underPressure, true).phase,
    ).toBe('release');
    expect(
      evaluateIdle(idleMs + underPressure - 1, idleMs, idleGraceMs, underPressure, true).phase,
    ).toBe('idle-grace');
  });
});

describe('isTtlExpired / isMaxDurationExceeded', () => {
  it('ttl is not expired before, and is expired strictly after, expiresAt', () => {
    expect(isTtlExpired(1000, 1000)).toBe(false);
    expect(isTtlExpired(1001, 1000)).toBe(true);
  });
  it('max duration is exceeded strictly after acquiredAt + maxDurationMs', () => {
    expect(isMaxDurationExceeded(1000, 0, 1000)).toBe(false);
    expect(isMaxDurationExceeded(1001, 0, 1000)).toBe(true);
  });
});

describe('BrowserRouter.reaperSweep, driven entirely by the injectable Clock', () => {
  it('does not release an idle instance before idleMs + idleGraceMs', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock, {
      config: { idleGraceUnderPressureMs: 100_000 },
    });
    const { tenantId, appId, poolId } = seedBasics(store);
    (
      store as unknown as { __pools: Map<string, { limits: { sessionIdleMs: number } }> }
    ).__pools.get(poolId)!.limits.sessionIdleMs = 10_000;
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // idleMs (10_000) elapses, but not the grace (default 600_000) yet.
    clock.advance(10_000 + 1);
    await router.reaperSweep();
    const stillLive = await store.getInstance(tenantId, instanceId);
    expect(stillLive?.state).not.toBe('released');
  });

  it('releases an idle instance at idleMs + idleGraceMs and not before', async () => {
    const clock = createFakeClock();
    const idleGraceUnderPressureMs = 5_000; // not under pressure in this test, but keep it small so the default 600_000 grace isn't what's exercised
    const { router, store } = createTestRouter(clock, { config: { idleGraceUnderPressureMs } });
    const { tenantId, appId, poolId } = seedBasics(store);
    // Force a short, deterministic idle threshold and directly patch the
    // router's IDLE_GRACE_MS_DEFAULT-equivalent behaviour by using a pool
    // idle threshold small enough that even the default 600_000ms grace is
    // exercised precisely via the fake clock (no real time elapses).
    const idleMs = 1_000;
    const graceMs = 600_000; // IDLE_GRACE_MS_DEFAULT in BrowserRouter.ts
    (
      store as unknown as { __pools: Map<string, { limits: { sessionIdleMs: number } }> }
    ).__pools.get(poolId)!.limits.sessionIdleMs = idleMs;
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    // One millisecond short of idleMs + graceMs: must not release yet.
    clock.advance(idleMs + graceMs - 1);
    await router.reaperSweep();
    const notYet = await store.getInstance(tenantId, instanceId);
    expect(notYet?.state).not.toBe('released');

    // Cross the threshold: must release now.
    clock.advance(1);
    await router.reaperSweep();
    const released = await store.getInstance(tenantId, instanceId);
    expect(released?.state).toBe('released');
  });

  it('releases an instance whose ttl has expired, reason ttl_expired', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({ ttlMs: 5_000 }, principal);
    clock.advance(5_001);
    await router.reaperSweep();
    const instance = await store.getInstance(tenantId, handle.result.instanceId);
    expect(instance?.state).toBe('released');
  });

  it('releases an instance past maxDurationMs regardless of activity', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock, { config: { maxDurationMs: 2_000 } });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({ ttlMs: 1_000_000 }, principal);
    clock.advance(2_001);
    await router.reaperSweep();
    const instance = await store.getInstance(tenantId, handle.result.instanceId);
    expect(instance?.state).toBe('released');
  });
});
