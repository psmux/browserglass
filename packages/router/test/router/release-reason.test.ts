import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
/**
 * `BrowserRouter.release()`'s terminal transition now writes
 * `Instance.releaseReason` (`entities.ts`'s doc, `BrowserRouter.ts` step
 * 9 of `release()`), closing the gap `GET /v1/instances/:instanceId/history`
 * (`packages/server/src/rest/routes/inventory.ts`) used to report as
 * `null` under `historyFieldsUnavailable`. The store-level write/read
 * mechanics are proven directly in `store-sqlite`'s
 * `instance-history-fields.test.ts`; this file proves the router's own
 * `release()` actually reaches that code path with the right value for
 * an explicit caller reason and for the reaper's own sweep reasons.
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

describe('BrowserRouter.release() persists Instance.releaseReason', () => {
  it('a caller-initiated release with an explicit reason lands on the instance, not just the audit log', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;
    expect((await store.getInstance(tenantId, instanceId))?.releaseReason).toBeNull();

    await router.release(instanceId, { reason: 'operator_requested', force: true }, principal);

    const instance = await store.getInstance(tenantId, instanceId);
    expect(instance?.state).toBe('released');
    expect(instance?.releaseReason).toBe('operator_requested');
  });

  it('a reaper sweep release lands the SWEEP reason, not a caller string, and it survives the transition to released', async () => {
    // `placeAndLaunch` caps `expiresAt` at `acquiredAt + maxDurationMs`
    // whenever the caller's `ttlMs` is unset or larger (`Math.min(args.ttlMs
    // ?? maxDurationMs, maxDurationMs)`), so `isTtlExpired` and
    // `isMaxDurationExceeded` become true on the SAME clock tick here and
    // `reaperSweep` checks `ttl_expired` first (`explicit-lifetime-exemption.test.ts`'s
    // sibling test carries the same note). The point this test pins is
    // narrower than which of the two fires: a reaper-driven release
    // (`reason` set internally by `reaperSweep`, never by this test)
    // still lands on `releaseReason`, proving the write path is not
    // somehow specific to `router.release()`'s own explicit-`opts.reason`
    // callers.
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock, { config: { maxDurationMs: 2_000 } });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    clock.advance(2_001);
    await router.reaperSweep();

    const instance = await store.getInstance(tenantId, instanceId);
    expect(instance?.state).toBe('released');
    expect(['ttl_expired', 'max_duration']).toContain(instance?.releaseReason);
  });

  it('a release with no reason at all still stamps releaseReason, matching the audit event fallback: requested', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;

    await router.release(instanceId, { force: true }, principal);

    const instance = await store.getInstance(tenantId, instanceId);
    expect(instance?.releaseReason).toBe('requested');
  });
});
