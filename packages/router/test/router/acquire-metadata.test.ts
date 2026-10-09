import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
/**
 * `AcquireRequest.metadata`/`.lifetime` threaded end to end through
 * `BrowserRouter.acquire`, `../../src/router/types.ts`'s doc on both
 * fields. This is the router-level half of the fix: `instance-metadata-lifetime.test.ts`
 * (`packages/store-sqlite/test`) proves the store round trip in
 * isolation; this file proves `doAcquire` actually validates and passes
 * `req.metadata`/`req.lifetime` into `placeAndLaunch` in the first place,
 * which is the exact step that once silently dropped both.
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

describe('BrowserRouter.acquire threads metadata/lifetime through to the created instance', () => {
  it('an acquire naming metadata.name/description reads both back through store.getInstance', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire(
      { metadata: { name: 'checkout-repro-17', description: 'inspect after failure' } },
      principal,
    );

    const instance = await store.getInstance(tenantId, handle.result.instanceId);
    expect(instance?.metadata).toEqual({
      name: 'checkout-repro-17',
      description: 'inspect after failure',
    });
  });

  it('an acquire with no metadata gets {} back, not undefined and not a stale value from a previous acquire', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    await router.acquire({ metadata: { name: 'first' } }, principal);
    const second = await router.acquire({ subject: 'a-different-subject' }, principal);

    const instance = await store.getInstance(tenantId, second.result.instanceId);
    expect(instance?.metadata).toEqual({});
  });

  it('an acquire with lifetime: explicit reads back lifetime: explicit, not the viewer-bound default', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({ lifetime: 'explicit' }, principal);

    const instance = await store.getInstance(tenantId, handle.result.instanceId);
    expect(instance?.lifetime).toBe('explicit');
  });

  it('an acquire whose metadata exceeds the key cap is rejected with E_SPEC_INVALID before any instance is created', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const oversized: Record<string, string> = {};
    for (let i = 0; i < 17; i++) oversized[`k${i}`] = 'v';

    await expect(router.acquire({ metadata: oversized }, principal)).rejects.toMatchObject({
      code: 'E_SPEC_INVALID',
    });

    const rows = await store.listInstances(tenantId, {});
    expect(rows).toHaveLength(0);
  });
});
