/**
 * `principal.scope` enforcement on every `BrowserRouter` verb that names a
 * single instance, the companion to `drive-authorization.test.ts`.
 *
 * `driveInstance` was fixed first because it is the driving gate, but it
 * was never the only unenforced path: `attach`, `release`, `restart`,
 * `describe`, and `acquire`'s attach-by-`instanceId` short circuit all
 * authorised on `principal.tenantId` alone, so an instance scoped token
 * could reach every other instance of its own tenant through any of them.
 * `attach` is the worst of the set, since the ticket it mints is a durable
 * way onto an instance rather than a single action against it, and
 * `release`/`restart` are a denial of service against another user of the
 * same tenant.
 *
 * Refusals are `E_INSTANCE_NOT_FOUND` throughout, for the reason
 * `assertScopeAllowsInstance` documents: a caller who may not touch an
 * instance must not learn from the error code whether it exists.
 *
 * The last describe block is the regression guard that matters most here.
 * The reaper, `drainNode`, and capacity eviction all call `release()` with
 * a synthetic `systemPrincipalFor` principal and all swallow errors with
 * `.catch(() => undefined)`, so a scope check that wrongly refused a system
 * principal would disable the idle reaper, the TTL sweep, and node drain
 * silently, with no failing call and no log line.
 */

import type { Capability, InstanceId, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

/** Tenant scoped, the way `server/src/auth/resolver.ts`'s `principalFromClaims` defaults and `server/src/auth/verify.ts` copies a real token's claim. */
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

/** Narrowed to one instance, exactly the shape `server/src/ws/connection.ts:844` mints for every viewer at handshake and `ws/credentials.ts:118` mints from a redeemed ticket. */
function scopedTo(principal: Principal, instanceId: InstanceId): Principal {
  return { ...principal, scope: { kind: 'instance', instanceId, targets: '*' } };
}

/** Acquires two instances of one tenant and returns them with a principal scoped to the first. */
async function twoInstances(clock: ReturnType<typeof createFakeClock>) {
  const harness = createTestRouter(clock);
  const { tenantId, appId, poolId } = seedBasics(harness.store);
  const principal = principalFor(tenantId, appId);
  const mine = (await harness.router.acquire({}, principal)).result.instanceId;
  const other = (await harness.router.acquire({}, principal)).result.instanceId;
  expect(other).not.toBe(mine);
  return {
    ...harness,
    tenantId,
    appId,
    poolId,
    principal,
    mine,
    other,
    scoped: scopedTo(principal, mine),
  };
}

describe('attach: the ticket minting path', () => {
  it('refuses an instance scoped principal attaching to a different instance of its own tenant', async () => {
    const clock = createFakeClock();
    const { router, mine, other, scoped } = await twoInstances(clock);

    await expect(router.attach({ instanceId: mine }, scoped)).resolves.toMatchObject({
      instanceId: mine,
    });
    await expect(router.attach({ instanceId: other }, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });

  it('mints no ticket and records no activity for the refused instance', async () => {
    const clock = createFakeClock();
    const { router, store, tenantId, other, scoped } = await twoInstances(clock);
    const before = await store.getInstance(tenantId, other);
    clock.advance(60_000); // past activityTouchThrottleMs, so a touch would be a real write

    await expect(router.attach({ instanceId: other }, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });

    const after = await store.getInstance(tenantId, other);
    expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
  });

  it('refuses a pool scoped principal attaching to an instance of another pool', async () => {
    const clock = createFakeClock();
    const { router, poolId, principal, mine } = await twoInstances(clock);

    const ownPool: Principal = { ...principal, scope: { kind: 'pool', poolId, maxInstances: 10 } };
    const otherPool: Principal = {
      ...principal,
      scope: { kind: 'pool', poolId: newId('pol'), maxInstances: 10 },
    };

    await expect(router.attach({ instanceId: mine }, ownPool)).resolves.toMatchObject({
      instanceId: mine,
    });
    await expect(router.attach({ instanceId: mine }, otherPool)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });
});

describe('release and restart: denial of service on a sibling instance', () => {
  it('refuses an instance scoped principal releasing a different instance, leaving it drivable', async () => {
    const clock = createFakeClock();
    const { router, other, scoped, principal } = await twoInstances(clock);

    await expect(router.release(other, {}, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });

    // Not merely refused: untouched. A refusal that still drained or
    // invalidated the instance would be the same denial of service.
    await expect(router.driveInstance(other, principal)).resolves.toMatchObject({
      instanceId: other,
    });
  });

  it('still lets an instance scoped principal release its own instance', async () => {
    const clock = createFakeClock();
    const { router, mine, scoped } = await twoInstances(clock);

    await expect(router.release(mine, {}, scoped)).resolves.toMatchObject({ instanceId: mine });
  });

  it('refuses an instance scoped principal restarting a different instance, without moving it to recovering', async () => {
    const clock = createFakeClock();
    const { router, store, tenantId, other, scoped, nodes } = await twoInstances(clock);
    const terminatesBefore = nodes.terminateCount;

    await expect(router.restart(other, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });

    const after = await store.getInstance(tenantId, other);
    expect(after?.state).not.toBe('recovering');
    expect(nodes.terminateCount).toBe(terminatesBefore); // the refusal came before the terminate ladder
  });

  it('refuses a foreign tenant releasing an instance, the control case that already worked', async () => {
    const clock = createFakeClock();
    const { router, store, other } = await twoInstances(clock);
    const foreign = seedBasics(store);
    const foreignPrincipal = principalFor(foreign.tenantId, foreign.appId, 'foreign-user');

    await expect(router.release(other, {}, foreignPrincipal)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });
});

describe('acquire: the attach-by-instanceId short circuit', () => {
  it('refuses an instance scoped principal naming a different instance', async () => {
    const clock = createFakeClock();
    const { router, mine, other, scoped } = await twoInstances(clock);

    await expect(router.acquire({ instanceId: mine }, scoped)).resolves.toMatchObject({
      result: { instanceId: mine },
    });
    await expect(router.acquire({ instanceId: other }, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });
});

describe('describe: reading back a sibling instance', () => {
  it('refuses an instance scoped principal describing a different instance', async () => {
    const clock = createFakeClock();
    const { router, mine, other, scoped } = await twoInstances(clock);

    await expect(router.describe(mine, scoped)).resolves.toMatchObject({ instance: { id: mine } });
    await expect(router.describe(other, scoped)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });
});

describe('list: narrowed rather than refused', () => {
  it('shows a tenant scoped principal every instance of its tenant, unchanged', async () => {
    const clock = createFakeClock();
    const { router, principal, mine, other } = await twoInstances(clock);

    const rows = await router.list({}, principal);
    const ids = rows.map((r) => r.instance.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(other);
  });

  it('shows an instance scoped principal only its own instance', async () => {
    const clock = createFakeClock();
    const { router, mine, other, scoped } = await twoInstances(clock);

    // A refusal would be the wrong shape here: "list what I may see" has a
    // correct non-empty answer for a narrowed token, so this narrows the
    // result rather than throwing.
    const rows = await router.list({}, scoped);
    expect(rows.map((r) => r.instance.id)).toEqual([mine]);
    expect(rows.map((r) => r.instance.id)).not.toContain(other);
  });

  it('shows a pool scoped principal its own pool, and nothing from another pool', async () => {
    const clock = createFakeClock();
    const { router, poolId, principal, mine, other } = await twoInstances(clock);

    const ownPool: Principal = { ...principal, scope: { kind: 'pool', poolId, maxInstances: 10 } };
    const otherPool: Principal = {
      ...principal,
      scope: { kind: 'pool', poolId: newId('pol'), maxInstances: 10 },
    };

    const own = await router.list({}, ownPool);
    expect(own.map((r) => r.instance.id).sort()).toEqual([mine, other].sort());
    await expect(router.list({}, otherPool)).resolves.toEqual([]);
  });
});

describe("the router's own system principals keep working", () => {
  it('the idle reaper still releases, despite release() now checking scope', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({ ttlMs: 5_000 }, principal);
    clock.advance(5_001);
    // `reaperSweep` builds a `systemPrincipalFor(instance.tenantId, ...)`
    // principal and swallows every release error with
    // `.catch(() => undefined)`, so a scope check that refused a system
    // principal would show up nowhere except here, as an instance that
    // quietly never gets reaped.
    await router.reaperSweep();

    expect((await store.getInstance(tenantId, handle.result.instanceId))?.state).toBe('released');
  });

  it('drainNode still releases every instance on the node', async () => {
    const clock = createFakeClock();
    const { router, store, nodeRegistry } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    // `stop()` is the only caller and passes `SYSTEM_PRINCIPAL`, which is
    // `{ kind: 'tenant' }`; `drainNode` forwards whatever it is given
    // straight into `release()`.
    await router.drainNode(nodeRegistry.id(), { mode: 'graceful' }, principal);

    expect((await store.getInstance(tenantId, handle.result.instanceId))?.state).toBe('released');
  });
});

/**
 * `Principal.scope` is a required field that neither entry point into this
 * system actually enforces: `server/src/auth/verify.ts` copies
 * `claims.scope` out of a decoded JWT without checking the claim is there,
 * and `server/src/auth/resolver.ts` plus `server/src/ws/credentials.ts`
 * both decide whether an app supplied `AuthResolver` returned a `Principal`
 * with a duck-type guard that tests `sub` and `tenantId` and nothing else.
 * So a principal with no scope at all is a real runtime input, and
 * `server/test/lifecycle/viewer-port.test.ts` already builds one.
 */
describe('a principal carrying no scope at all', () => {
  it('is treated as tenant scoped rather than throwing or refusing', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const full = principalFor(tenantId, appId);
    const handle = await router.acquire({}, full);

    // The exact shape an app supplied AuthResolver can return today and
    // have accepted: tenantId and sub present, scope absent.
    const { scope: _dropped, ...noScope } = full;
    const scopeless = noScope as unknown as Principal;

    await expect(router.driveInstance(handle.result.instanceId, scopeless)).resolves.toMatchObject({
      instanceId: handle.result.instanceId,
    });
    await expect(router.describe(handle.result.instanceId, scopeless)).resolves.toMatchObject({
      instance: { id: handle.result.instanceId },
    });
    await expect(router.list({}, scopeless)).resolves.toHaveLength(1);
    await expect(router.release(handle.result.instanceId, {}, scopeless)).resolves.toMatchObject({
      outcome: 'terminated',
    });
  });

  it('still refuses that scopeless principal across a tenant boundary', async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const owner = seedBasics(store);
    const foreign = seedBasics(store);
    const handle = await router.acquire({}, principalFor(owner.tenantId, owner.appId));

    const { scope: _dropped, ...noScope } = principalFor(
      foreign.tenantId,
      foreign.appId,
      'foreign-user',
    );
    const scopeless = noScope as unknown as Principal;

    // Absent scope widens to the tenant, never past it: the tenant check is
    // a separate mechanism and is untouched by any of this.
    await expect(router.describe(handle.result.instanceId, scopeless)).rejects.toMatchObject({
      code: 'E_INSTANCE_NOT_FOUND',
    });
  });
});
