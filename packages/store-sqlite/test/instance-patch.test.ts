import type { Instance } from '@browserglass/protocol';
/**
 * `transitionInstance`'s patch handling.
 *
 * The method takes `patch?: Partial<Instance>` and used to build its
 * `UPDATE` from exactly four of those fields (`stateReason`, `releasedAt`,
 * `lastActivityAt`, `expiresAt`). Everything else the caller passed was
 * accepted by the type, accepted at runtime, and then discarded. That is
 * neither a compile error nor a runtime error, which is why it survived
 * long enough to leave `instances.profile_id` NULL on all 46 rows of a
 * live demo database, and through that to leak roughly 3 GB of ephemeral
 * profile directories that `BrowserRouter.release()`'s `if
 * (instance.profileId)` guard could never reach.
 *
 * Everything here builds its rows the way `BrowserRouter` actually builds
 * them, not the way that makes the assertions convenient. In particular
 * `createInstance` is called WITHOUT `profileId`: the router cannot pass it
 * there, because at that point in `placeAndLaunch` the profile has not been
 * leased yet, so the column starts NULL and the `launching -> live` patch
 * is the only write that would ever fill it. A fixture that seeded
 * `profileId` at creation time would pass against the broken store and
 * prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

describe('transitionInstance patch handling', () => {
  it("persists every field BrowserRouter.placeAndLaunch's launching -> live patch carries", async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);

    // 1. The router's own `createInstance` call (`BrowserRouter.ts`, inside
    //    `placeAndLaunch`): id, tenant, app, pool, spec, node, subject. No
    //    `profileId`, because the profile lease does not exist yet.
    const instance = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      createdBySub: 'user-1',
      metadata: {},
      lifetime: 'viewer-bound',
    });
    expect(instance.profileId).toBeNull();
    expect(instance.sessionId).toBeNull();
    expect(instance.readyAt).toBeNull();

    // 2. The profile lease, which is where `lease.profileId` and
    //    `lease.fence` in the router's patch come from. A real lease, so
    //    the fence is the store's own monotonic value rather than a number
    //    invented by this test.
    const lease = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      instanceId: instance.id,
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('acquireProfileLease returned null');

    // 3. `createSession` before the transition, exactly as `placeAndLaunch`
    //    orders it, so the session id in the patch names a row that exists.
    const session = await f.store.createSession({ tenantId: tenant.id, instanceId: instance.id });

    // 4. The transition itself, all five patch fields the router passes.
    const readyAt = instance.acquiredAt + 1_500;
    const expiresAt = instance.acquiredAt + 60_000;
    const applied = await f.store.transitionInstance(
      tenant.id,
      instance.id,
      ['launching'],
      'live',
      {
        profileId: lease.profileId,
        sessionId: session.id,
        readyAt,
        fence: lease.fence,
        expiresAt,
      },
    );
    expect(applied).toBe(true);

    const fetched = await f.store.getInstance(tenant.id, instance.id);
    expect(fetched).not.toBeNull();
    // `profileId` is the one that cost 3 GB of disk: `release()` gates the
    // ephemeral profile directory teardown on it.
    expect(fetched?.profileId).toBe(lease.profileId);
    expect(fetched?.fence).toBe(lease.fence);
    expect(fetched?.sessionId).toBe(session.id);
    expect(fetched?.readyAt).toBe(readyAt);
    expect(fetched?.expiresAt).toBe(expiresAt);

    // The profile association survives the lease being released, which was
    // the other half of the loss: `profile_leases.instance_id` was the only
    // surviving link, and releasing the lease erased it.
    await f.store.releaseProfileLease(lease.id, 'test');
    const afterRelease = await f.store.getInstance(tenant.id, instance.id);
    expect(afterRelease?.profileId).toBe(lease.profileId);

    f.cleanup();
  });

  it('persists the fields the recovering -> live restart patch carries', async () => {
    // `BrowserRouter.reacquireProfileForRestart` passes `profileId`,
    // `fence`, and `readyAt` with no `expiresAt` and no `sessionId`; a
    // partial patch must still land every field it does carry.
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
    const instance = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });
    await f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'recovering');

    const readyAt = instance.acquiredAt + 9_000;
    const applied = await f.store.transitionInstance(
      tenant.id,
      instance.id,
      ['recovering'],
      'live',
      {
        profileId: profile.id,
        fence: 7,
        readyAt,
      },
    );
    expect(applied).toBe(true);

    const fetched = await f.store.getInstance(tenant.id, instance.id);
    expect(fetched?.profileId).toBe(profile.id);
    expect(fetched?.fence).toBe(7);
    expect(fetched?.readyAt).toBe(readyAt);

    f.cleanup();
  });

  it('persists a nodeId patch, the field the router drive tests move an instance with', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool } = await seedBasics(f.store);
    const other = await f.store.registerNode({
      name: 'node-2',
      runtime: 'host',
      address: 'http://127.0.0.1:9001',
      registrationSecretEnc: 'enc',
    });
    const instance = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });

    await f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'live', {
      nodeId: other.id,
    });
    const fetched = await f.store.getInstance(tenant.id, instance.id);
    expect(fetched?.nodeId).toBe(other.id);

    f.cleanup();
  });

  it('throws on a patch field it cannot persist, instead of silently discarding it', async () => {
    // The point of the whole exercise. `metadata` is a declared `Instance`
    // field with no `instances` column behind it, so `Partial<Instance>`
    // accepts it at compile time. Before this change it was dropped in
    // silence, which is exactly how `profileId` went missing for 46 rows.
    const f = freshStore();
    const { tenant, node, app, spec, pool } = await seedBasics(f.store);
    const instance = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });

    const patch: Partial<Instance> = { metadata: { k: 'v' } };
    await expect(
      f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'live', patch),
    ).rejects.toThrow(/metadata/);

    // And the row did not move: a refused patch refuses the whole
    // transition rather than half-applying it.
    const fetched = await f.store.getInstance(tenant.id, instance.id);
    expect(fetched?.state).toBe('launching');

    f.cleanup();
  });

  it('still ignores an explicitly undefined patch field, the shape exactOptionalPropertyTypes lets through', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool } = await seedBasics(f.store);
    const instance = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });

    const applied = await f.store.transitionInstance(
      tenant.id,
      instance.id,
      ['launching'],
      'live',
      {
        stateReason: undefined,
      },
    );
    expect(applied).toBe(true);

    f.cleanup();
  });
});
