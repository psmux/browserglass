import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

describe('profile lease fencing', () => {
  it('fence strictly increases across a release and a re-acquire, never resetting to 1', async () => {
    const f = freshStore();
    const { tenant, node, profile } = await seedBasics(f.store);

    const lease1 = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 5000,
    });
    expect(lease1?.fence).toBe(1);

    await f.store.releaseProfileLease(lease1!.id, 'voluntary');

    const lease2 = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 5000,
    });
    expect(lease2?.fence).toBe(2);

    await f.store.releaseProfileLease(lease2!.id, 'voluntary');

    const lease3 = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 5000,
    });
    expect(lease3?.fence).toBe(3);

    f.cleanup();
  });

  it('a second acquire against a live (unreleased) lease is refused with null, and the live lease is untouched', async () => {
    const f = freshStore();
    const { tenant, node, profile } = await seedBasics(f.store);

    const first = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 5000,
    });
    expect(first).not.toBeNull();

    const second = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 5000,
    });
    expect(second).toBeNull();

    const stillLive = await f.store.getProfile(tenant.id, profile.id);
    expect(stillLive?.lease?.id).toBe(first!.id);
    expect(stillLive?.lease?.releasedAt).toBeNull();

    f.cleanup();
  });

  it('heartbeatProfileLease extends expiresAt and returns false once released', async () => {
    const f = freshStore();
    const { tenant, node, profile } = await seedBasics(f.store);
    const lease = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 1000,
    });

    const extended = await f.store.heartbeatProfileLease(lease!.id, 60000);
    expect(extended).toBe(true);

    await f.store.releaseProfileLease(lease!.id, 'voluntary');
    const afterRelease = await f.store.heartbeatProfileLease(lease!.id, 60000);
    expect(afterRelease).toBe(false);

    f.cleanup();
  });

  it('expireProfileLeases reclaims a lease whose expiry has passed and leaves a live one alone', async () => {
    const f = freshStore();
    const { tenant, node, profile } = await seedBasics(f.store);
    const lease = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));

    const reclaimed = await f.store.expireProfileLeases(new Date().toISOString(), 10);
    expect(reclaimed.map((l) => l.id)).toContain(lease!.id);

    const afterExpiry = await f.store.getProfile(tenant.id, profile.id);
    expect(afterExpiry?.lease).toBeNull();

    f.cleanup();
  });
});
