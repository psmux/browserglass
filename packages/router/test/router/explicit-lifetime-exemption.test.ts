import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
/**
 * `Instance.lifetime`'s `'explicit'` value
 * (`../../src/router/config.ts`'s `instanceLingerMs` doc: "`viewer-bound`
 * releases after the last viewer leaves plus `instanceLingerMs`; `explicit`
 * lives until released or `maxDurationMs`"). Before `NewInstance.lifetime`
 * had a real column to land in (`0008_instance_metadata_lifetime.sql`,
 * `store-sqlite`/`store-postgres`), every instance read back as the
 * hardcoded literal `'viewer-bound'`, so `'explicit'` could never be
 * expressed, let alone behave differently in `BrowserRouter.reaperSweep`.
 *
 * This is the per-run close policy the user requirement's "before
 * destroying or operating" case needs: a caller acquires a browser with
 * `lifetime: 'explicit'`, the worker driving it exits, and the instance
 * stays up for a human to inspect rather than being swept the moment
 * nobody is viewing it. `reaperSweep`'s idle branch (`BrowserRouter.ts`,
 * `if (instance.lifetime === 'explicit') continue;`, directly after the
 * `subject === null` warm-instance skip) is what this suite proves: an
 * `'explicit'` instance survives past `idleMs + idleGraceMs` (the
 * `'viewer-bound'` release path this same idle state elapsing already
 * releases, per `lifecycle.test.ts`'s "releases an idle instance at idleMs
 * + idleGraceMs" case), but is NOT exempt from the two checks that run
 * before the idle branch is even reached: `ttl_expired` and, the one this
 * suite pins, `max_duration`.
 */
import { describe, expect, it } from 'vitest';
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

describe("Instance.lifetime === 'explicit' is exempt from the viewer-bound idle sweep, but still bounded by maxDurationMs", () => {
  it('is NOT released by the idle sweep past idleMs + idleGraceMs, unlike the viewer-bound default', async () => {
    const clock = createFakeClock();
    const idleGraceUnderPressureMs = 5_000;
    const { router, store } = createTestRouter(clock, { config: { idleGraceUnderPressureMs } });
    const { tenantId, appId, poolId } = seedBasics(store);
    const idleMs = 1_000;
    const graceMs = 600_000; // IDLE_GRACE_MS_DEFAULT in BrowserRouter.ts
    (
      store as unknown as { __pools: Map<string, { limits: { sessionIdleMs: number } }> }
    ).__pools.get(poolId)!.limits.sessionIdleMs = idleMs;
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({ lifetime: 'explicit' }, principal);
    const instanceId = handle.result.instanceId;
    expect((await store.getInstance(tenantId, instanceId))?.lifetime).toBe('explicit');

    // Cross the exact threshold that DOES release a 'viewer-bound'
    // instance (`lifecycle.test.ts`'s sibling test, same idleMs/graceMs).
    clock.advance(idleMs + graceMs + 1);
    await router.reaperSweep();

    const stillLive = await store.getInstance(tenantId, instanceId);
    expect(stillLive?.state).not.toBe('released');
  });

  it('IS released once maxDurationMs is exceeded, exactly like a viewer-bound instance', async () => {
    // `placeAndLaunch` caps `ttl` at `Math.min(args.ttlMs ?? maxDurationMs,
    // maxDurationMs)`, so a requested `ttlMs` of 1_000_000 against a
    // `maxDurationMs` of 2_000 still expires the instance's own `expiresAt`
    // at 2_000ms: `ttl_expired` and `max_duration` become true on the same
    // clock tick, and `reaperSweep` checks `ttl_expired` first. This
    // mirrors `lifecycle.test.ts`'s own "releases an instance past
    // maxDurationMs regardless of activity" test, which asserts released
    // state only, for the same reason: with `ttlMs` set at all, the two
    // reasons are not distinguishable from outside `reaperSweep`. The
    // point this test pins is narrower and unaffected by which of the two
    // fires: an 'explicit' instance is NOT exempt from either deadline,
    // only from the idle sweep.
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock, { config: { maxDurationMs: 2_000 } });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({ lifetime: 'explicit', ttlMs: 1_000_000 }, principal);
    const instanceId = handle.result.instanceId;
    expect((await store.getInstance(tenantId, instanceId))?.lifetime).toBe('explicit');

    clock.advance(2_001);
    await router.reaperSweep();

    const instance = await store.getInstance(tenantId, instanceId);
    expect(instance?.state).toBe('released');
    expect(['ttl_expired', 'max_duration']).toContain(instance?.stateReason);
  });

  it("acquire without a lifetime defaults to 'viewer-bound', which the idle sweep DOES release", async () => {
    const clock = createFakeClock();
    const idleGraceUnderPressureMs = 5_000;
    const { router, store } = createTestRouter(clock, { config: { idleGraceUnderPressureMs } });
    const { tenantId, appId, poolId } = seedBasics(store);
    const idleMs = 1_000;
    const graceMs = 600_000;
    (
      store as unknown as { __pools: Map<string, { limits: { sessionIdleMs: number } }> }
    ).__pools.get(poolId)!.limits.sessionIdleMs = idleMs;
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;
    expect((await store.getInstance(tenantId, instanceId))?.lifetime).toBe('viewer-bound');

    clock.advance(idleMs + graceMs + 1);
    await router.reaperSweep();

    const instance = await store.getInstance(tenantId, instanceId);
    expect(instance?.state).toBe('released');
    expect(instance?.stateReason).toBe('idle_timeout');
  });
});
