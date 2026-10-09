import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

/**
 * `pools.spec_id`, `instances.spec_id`, and `placement_queue.spec_id`
 * declare no `ON DELETE` action (so `NO ACTION`), while `browser_specs.tenant_id`
 * is `CASCADE`; `instances.app_id` is `RESTRICT` while `apps.tenant_id` is
 * `CASCADE`. Only the documented ordered procedure,
 * which deletes children before parents, is the supported path.
 */
describe('tenant deletion FK ordering', () => {
  it('a bare DELETE FROM apps fails while a live instance references it (instances.app_id RESTRICT), which is exactly what forces the App delete drain procedure', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
    await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      profileId: profile.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });

    expect(() => f.db.prepare('DELETE FROM apps WHERE id = ?').run(app.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(await f.store.getApp(tenant.id, app.id)).not.toBeNull();
    f.cleanup();
  });

  it('a bare DELETE FROM tenants fails when a live instance references its browser_specs row (instances.spec_id has NO ACTION)', async () => {
    // Isolates the spec_id NO ACTION hazard from same-tenant cascade
    // completeness: within one tenant, instances.tenant_id is itself
    // CASCADE, so a same-tenant instance is swept away in the same
    // cascading DELETE before the spec_id check would fire, and a bare
    // same-tenant DELETE FROM tenants succeeds cleanly (verified). The
    // hazard is real regardless: an instance whose spec_id still points at
    // a tenant's browser_specs row after that tenant's own rows are gone
    // (the exact state a half-finished, out-of-order deletion leaves
    // behind) blocks that tenant's row from ever being deleted. Tenant B's
    // spec referenced from tenant A's instance reproduces exactly that
    // surviving-reference state without waiting for a partial failure.
    const f = freshStore();
    const tenantA = await f.store.createTenant({ name: 'A' });
    const tenantB = await f.store.createTenant({ name: 'B' });
    const nodeA = await f.store.registerNode({
      name: 'nA',
      runtime: 'host',
      address: 'http://a',
      registrationSecretEnc: 'x',
    });
    const appA = await f.store.createApp({ tenantId: tenantA.id, name: 'appA' });
    const specB = await f.store.upsertBrowserSpec(tenantB.id, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'new',
      viewportW: 1920,
      viewportH: 1080,
      dpr: 1,
      locale: null,
      timezone: null,
      userAgent: null,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off',
      limits: {},
    });
    await f.store.createInstance({
      tenantId: tenantA.id,
      appId: appA.id,
      specId: specB.id,
      nodeId: nodeA.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });

    expect(() => f.db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantB.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(await f.store.getTenant(tenantB.id)).not.toBeNull();
    f.cleanup();
  });

  it('the ordered deletion procedure succeeds for the same graph', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
    const lease = await f.store.acquireProfileLease({
      tenantId: tenant.id,
      profileId: profile.id,
      nodeId: node.id,
      ttlMs: 30000,
    });
    expect(lease).not.toBeNull();
    const instance = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      profileId: profile.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });
    const session = await f.store.createSession({ tenantId: tenant.id, instanceId: instance.id });
    const viewer = await f.store.createViewer({
      tenantId: tenant.id,
      sessionId: session.id,
      instanceId: instance.id,
      sub: 'user-1',
      caps: ['view'],
    });
    await f.store.recordControlGrant({
      tenantId: tenant.id,
      sessionId: session.id,
      targetId: 'tgt_fake',
      viewerId: viewer.id,
      sub: 'user-1',
      grantedAt: new Date().toISOString(),
    });

    // The documented ordering, restricted to the tables this graph
    // touches: children before parents, instances (and everything above
    // it) fully gone before profiles/pools/browser_specs/apps, which are
    // gone before the tenant itself.
    const tenantId = tenant.id;
    const tx = f.db.transaction(() => {
      f.db.prepare('DELETE FROM control_leases WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM viewers WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM sessions WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM instances WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM profile_leases WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM profiles WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM pools WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM browser_specs WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM apps WHERE tenant_id = ?').run(tenantId);
      f.db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
    });

    expect(() => tx()).not.toThrow();
    expect(await f.store.getTenant(tenantId)).toBeNull();
    f.cleanup();
  });
});
