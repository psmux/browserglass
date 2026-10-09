/**
 * `BrowserRouter.driveInstance`'s two authorization boundaries, as distinct
 * from the state checks `drive.test.ts` covers. Both were unenforced on
 * this path: the drive cache was keyed by `instanceId` alone, so a cache
 * hit answered and returned before the only tenant check on the path
 * (`store.getInstance(principal.tenantId, ...)`) ever ran, and
 * `principal.scope` was read nowhere in `BrowserRouter.ts` at all, so an
 * instance scoped token could drive any instance of its tenant.
 *
 * Every refusal below is asserted as `E_INSTANCE_NOT_FOUND` on purpose. A
 * caller who may not drive an instance must not learn from the error code
 * whether that instance exists, is mid launch, or was released, which is
 * exactly what `E_INSTANCE_NOT_READY`/`E_INSTANCE_GONE` would tell them.
 */

import type { Capability, NodeActionRequest, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

/**
 * Built the way production builds one: `server/src/auth/verify.ts` copies
 * `scope` straight out of the token's own claim, and
 * `server/src/auth/resolver.ts`'s `principalFromClaims` defaults it to
 * `{ kind: 'tenant' }`. Nothing about this shape is test convenience.
 */
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

describe('driveInstance: tenant isolation across the drive cache', () => {
  it('refuses a foreign tenant even after the owning tenant has warmed the drive cache', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const owner = seedBasics(store);
    const foreign = seedBasics(store);
    const ownerPrincipal = principalFor(owner.tenantId, owner.appId);
    const foreignPrincipal = principalFor(foreign.tenantId, foreign.appId, 'foreign-user');

    const handle = await router.acquire({}, ownerPrincipal);
    const instanceId = handle.result.instanceId;

    // Negative control: with a cold cache the store read IS the tenant
    // check, and it already refuses. The defect is only reachable once the
    // owning tenant has driven the instance at least once.
    await expect(router.driveInstance(instanceId, foreignPrincipal)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });

    await router.driveInstance(instanceId, ownerPrincipal); // warms the cache

    await expect(router.driveInstance(instanceId, foreignPrincipal)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('a refused foreign tenant does not touch the victim instance: no activity write, no audit event', async () => {
    const clock = createFakeClock();
    const { router, store, audit } = createTestRouter(clock);
    const owner = seedBasics(store);
    const foreign = seedBasics(store);
    const ownerPrincipal = principalFor(owner.tenantId, owner.appId);
    const foreignPrincipal = principalFor(foreign.tenantId, foreign.appId, 'foreign-user');

    const handle = await router.acquire({}, ownerPrincipal);
    await router.driveInstance(handle.result.instanceId, ownerPrincipal);
    const before = await store.getInstance(owner.tenantId, handle.result.instanceId);
    audit.events.length = 0;
    clock.advance(60_000); // past activityTouchThrottleMs, so a touch here would be a real write rather than one throttled away

    await expect(
      router.driveInstance(handle.result.instanceId, foreignPrincipal),
    ).rejects.toMatchObject({ code: 'E_INSTANCE_NOT_FOUND' });

    const after = await store.getInstance(owner.tenantId, handle.result.instanceId);
    expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
    expect(audit.events.filter((e) => e.k === 'instance.drive')).toHaveLength(0);
  });

  it('dispatchAction inherits the tenant refusal and never reaches a node', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const owner = seedBasics(store);
    const foreign = seedBasics(store);
    const ownerPrincipal = principalFor(owner.tenantId, owner.appId);
    const foreignPrincipal = principalFor(foreign.tenantId, foreign.appId, 'foreign-user');

    const handle = await router.acquire({}, ownerPrincipal);
    await router.driveInstance(handle.result.instanceId, ownerPrincipal);
    nodes.dispatchCalls.length = 0;

    const req: NodeActionRequest = {
      kind: 'screenshot',
      instanceId: handle.result.instanceId,
      targetId: 'tgt-1',
    };
    await expect(
      router.dispatchAction(handle.result.instanceId, req, foreignPrincipal),
    ).rejects.toMatchObject({ code: 'E_INSTANCE_NOT_FOUND' });
    expect(nodes.dispatchCalls).toHaveLength(0);
  });

  it('still serves the owning tenant from the cache: the fix costs no extra store read', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.driveInstance(handle.result.instanceId, principal);

    let getInstanceCalls = 0;
    const realGetInstance = store.getInstance.bind(store);
    store.getInstance = ((tid: string, id: string) => {
      getInstanceCalls += 1;
      return realGetInstance(tid, id);
    }) as typeof store.getInstance;

    await router.driveInstance(handle.result.instanceId, principal);
    expect(getInstanceCalls).toBe(0);
  });
});

describe('driveInstance: principal.scope enforcement', () => {
  it('refuses an instance scoped principal driving a different instance of its own tenant', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const mine = await router.acquire({}, principal);
    const other = await router.acquire({}, principal);
    expect(other.result.instanceId).not.toBe(mine.result.instanceId);

    // Exactly the shape `server/src/ws/credentials.ts:118` mints from a
    // redeemed ticket, and the shape `server/src/auth/verify.ts` copies out
    // of a token's own `scope` claim.
    const scoped: Principal = {
      ...principal,
      scope: { kind: 'instance', instanceId: mine.result.instanceId, targets: '*' },
    };

    await expect(router.driveInstance(mine.result.instanceId, scoped)).resolves.toMatchObject({
      instanceId: mine.result.instanceId,
    });
    await expect(router.driveInstance(other.result.instanceId, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('refuses an instance scoped principal on a cache hit too, not only on a fresh store read', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const mine = await router.acquire({}, principal);
    const other = await router.acquire({}, principal);
    await router.driveInstance(other.result.instanceId, principal); // warms the cache for the instance the scoped token may not touch

    const scoped: Principal = {
      ...principal,
      scope: { kind: 'instance', instanceId: mine.result.instanceId, targets: '*' },
    };
    await expect(router.driveInstance(other.result.instanceId, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('refuses a stream scoped principal pointed at another instance, and allows its own', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const mine = await router.acquire({}, principal);
    const other = await router.acquire({}, principal);
    const scoped: Principal = {
      ...principal,
      scope: { kind: 'stream', instanceId: mine.result.instanceId, targets: ['tgt-1'] },
    };

    await expect(router.driveInstance(mine.result.instanceId, scoped)).resolves.toMatchObject({
      instanceId: mine.result.instanceId,
    });
    await expect(router.driveInstance(other.result.instanceId, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('refuses a pool scoped principal driving an instance from another pool, on a cache hit as well as a fresh read', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId, poolId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.driveInstance(handle.result.instanceId, principal); // warms the cache

    const ownPool: Principal = { ...principal, scope: { kind: 'pool', poolId, maxInstances: 10 } };
    const otherPool: Principal = {
      ...principal,
      scope: { kind: 'pool', poolId: newId('pol'), maxInstances: 10 },
    };

    await expect(router.driveInstance(handle.result.instanceId, ownPool)).resolves.toMatchObject({
      instanceId: handle.result.instanceId,
    });
    await expect(router.driveInstance(handle.result.instanceId, otherPool)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('does not leak instance state through the scope refusal: an out-of-scope instance answers as not found, not as not ready', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const mine = await router.acquire({}, principal);
    const other = await router.acquire({}, principal);
    await store.transitionInstance(tenantId, other.result.instanceId, ['live'], 'draining', {});

    const scoped: Principal = {
      ...principal,
      scope: { kind: 'instance', instanceId: mine.result.instanceId, targets: '*' },
    };
    // A tenant scoped principal is told the truth: `draining` is retryable.
    await expect(router.driveInstance(other.result.instanceId, principal)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_READY',
    });
    // The out-of-scope one learns nothing about that instance's state.
    await expect(router.driveInstance(other.result.instanceId, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('dispatchAction inherits the scope refusal and never reaches a node', async () => {
    const clock = createFakeClock();
    const { router, store, nodes } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const mine = await router.acquire({}, principal);
    const other = await router.acquire({}, principal);
    await router.driveInstance(other.result.instanceId, principal);
    nodes.dispatchCalls.length = 0;

    const scoped: Principal = {
      ...principal,
      scope: { kind: 'instance', instanceId: mine.result.instanceId, targets: '*' },
    };
    const req: NodeActionRequest = {
      kind: 'click',
      instanceId: other.result.instanceId,
      targetId: 'tgt-1',
      x: 1,
      y: 1,
    };
    await expect(router.dispatchAction(other.result.instanceId, req, scoped)).rejects.toMatchObject(
      { code: 'E_INSTANCE_NOT_FOUND' },
    );
    expect(nodes.dispatchCalls).toHaveLength(0);
  });
});
