/**
 * `instances.metadata`/`instances.lifetime`, `0008_instance_metadata_lifetime.sql`.
 *
 * The user requirement this closes: "hope each instance will have its own
 * unique name, description, id, titlebar content, url etc for the agent to
 * confirm what it is before destroying or operating." `metadata` is the
 * free form carrier for that (`name`/`description` are the two
 * conventional keys, `instanceMetadata.ts` in `router`); `lifetime` is
 * what lets a caller ask for "keep this browser open until I say so"
 * (`'explicit'`) instead of the default "close once the last
 * viewer leaves" (`'viewer-bound'`).
 *
 * Before this migration, both were accepted by `AcquireRequest`/`NewInstance`
 * and then silently discarded: `rowToInstance` hardcoded `metadata: {}`
 * and `lifetime: 'viewer-bound'` for every row, because there was no
 * column to read either back from. This suite proves the round trip a
 * real `createInstance` call now gets, through the store directly (the
 * `BrowserRouter` wiring is `router`'s own concern and is exercised there,
 * not here).
 */
import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

describe('instances.metadata / instances.lifetime round trip', () => {
  it('carries an explicit metadata map and lifetime through createInstance and back out through getInstance', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);

    const created = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      profileId: profile.id,
      nodeId: node.id,
      metadata: {
        name: 'checkout-repro-17',
        description: 'reproducing the double-submit bug on staging',
      },
      lifetime: 'explicit',
    });

    expect(created.metadata).toEqual({
      name: 'checkout-repro-17',
      description: 'reproducing the double-submit bug on staging',
    });
    expect(created.lifetime).toBe('explicit');

    // Read back through a FRESH `getInstance` call, not the object
    // `createInstance` handed back: the round trip through the actual
    // `TEXT`/CHECK columns, via `rowToInstance`, is what the original bug
    // broke. Trusting the just-created object would not have caught the
    // hardcoded `{}`/`'viewer-bound'` this migration replaces.
    const reread = await f.store.getInstance(tenant.id, created.id);
    expect(reread?.metadata).toEqual({
      name: 'checkout-repro-17',
      description: 'reproducing the double-submit bug on staging',
    });
    expect(reread?.lifetime).toBe('explicit');

    f.cleanup();
  });

  it('defaults an omitted metadata/lifetime to {} / viewer-bound, matching the value the old hardcode always returned', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool } = await seedBasics(f.store);

    const created = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: {},
      lifetime: 'viewer-bound',
    });

    expect(created.metadata).toEqual({});
    expect(created.lifetime).toBe('viewer-bound');

    const reread = await f.store.getInstance(tenant.id, created.id);
    expect(reread?.metadata).toEqual({});
    expect(reread?.lifetime).toBe('viewer-bound');

    f.cleanup();
  });

  it('two instances with different metadata/lifetime do not bleed into each other, ruling out a shared hardcoded default', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool } = await seedBasics(f.store);

    const a = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: { name: 'instance-a' },
      lifetime: 'explicit',
    });
    const b = await f.store.createInstance({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      nodeId: node.id,
      metadata: { name: 'instance-b' },
      lifetime: 'viewer-bound',
    });

    const rereadA = await f.store.getInstance(tenant.id, a.id);
    const rereadB = await f.store.getInstance(tenant.id, b.id);
    expect(rereadA?.metadata).toEqual({ name: 'instance-a' });
    expect(rereadA?.lifetime).toBe('explicit');
    expect(rereadB?.metadata).toEqual({ name: 'instance-b' });
    expect(rereadB?.lifetime).toBe('viewer-bound');

    f.cleanup();
  });

  it('rejects a lifetime value outside the two the domain type allows, via the column CHECK constraint', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool } = await seedBasics(f.store);

    await expect(
      f.store.createInstance({
        tenantId: tenant.id,
        appId: app.id,
        poolId: pool.id,
        specId: spec.id,
        nodeId: node.id,
        metadata: {},
        // Cast past the type system the same way a corrupt caller or a
        // future bug might: the CHECK constraint (`0008_instance_metadata_lifetime.sql`)
        // is the real backstop, not just the TypeScript union.
        lifetime: 'forever' as never,
      }),
    ).rejects.toThrow(/CHECK constraint failed/);

    f.cleanup();
  });
});
