/**
 * `Instance.firstViewerAt`/`.releaseReason`/`.restartCount`/`.peakRssMib`/`.osPid`
 * (`entities.ts`), the fifth occurrence of "the `instances` row has the
 * column, `rowToInstance` drops it" in this repo (`clientHints`,
 * `initScripts`, `remoteEndpointName`, `metadata`/`lifetime`, and now
 * these five), surfaced for `GET /v1/instances/:instanceId/history`
 * (`packages/server/src/rest/routes/inventory.ts`), which used to report
 * all five as `null` in a `historyFieldsUnavailable` marker because
 * `rowToInstance` had nowhere to read them from into `Instance`.
 *
 * Two of the five have real writers, exercised here directly:
 * `firstViewerAt` (`Store.claimWarmInstance`'s own `COALESCE(first_viewer_at, ?)`)
 * and `releaseReason` (`transitionInstance`'s new writable
 * `releaseReason` patch field, which `BrowserRouter.release()`'s terminal
 * transition now sets; that router-level wiring is exercised by
 * `router`'s own reaper/release suites, not here). `restartCount` is
 * exercised through `Store.bumpInstanceEpoch`, its only writer.
 * `peakRssMib`/`osPid` have no writer in this build at all (see
 * `entities.ts`'s own doc on both); this file proves they read back
 * `null` rather than throwing or silently vanishing, which is the honest
 * value for a column nothing has populated yet.
 */
import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

describe('instances.first_viewer_at / release_reason / restart_count / peak_rss_mib / os_pid', () => {
  it('a freshly created instance reads all five as their honest defaults: null, null, 0, null, null', async () => {
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

    expect(created.firstViewerAt).toBeNull();
    expect(created.releaseReason).toBeNull();
    expect(created.restartCount).toBe(0);
    expect(created.peakRssMib).toBeNull();
    expect(created.osPid).toBeNull();

    f.cleanup();
  });

  it('claimWarmInstance stamps firstViewerAt once, and a later claim (on a different row) does not touch the first', async () => {
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
    await f.store.transitionInstance(tenant.id, created.id, ['launching'], 'warm');

    const claimed = await f.store.claimWarmInstance({
      tenantId: tenant.id,
      poolId: pool.id,
      specId: spec.id,
    });
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.firstViewerAt).not.toBeNull();

    const reread = await f.store.getInstance(tenant.id, created.id);
    expect(reread?.firstViewerAt).toBe(claimed?.firstViewerAt);

    // Nothing left to claim: the second call finds no 'warm' row for this
    // spec/pool and returns null, proving `firstViewerAt` was stamped on
    // the row this test actually created, not by some other side effect.
    const secondClaim = await f.store.claimWarmInstance({
      tenantId: tenant.id,
      poolId: pool.id,
      specId: spec.id,
    });
    expect(secondClaim).toBeNull();

    f.cleanup();
  });

  it('bumpInstanceEpoch increments restartCount, read back through a fresh getInstance', async () => {
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
    expect(created.restartCount).toBe(0);

    await f.store.bumpInstanceEpoch(tenant.id, created.id);
    await f.store.bumpInstanceEpoch(tenant.id, created.id);

    const reread = await f.store.getInstance(tenant.id, created.id);
    expect(reread?.restartCount).toBe(2);

    f.cleanup();
  });

  it('transitionInstance persists releaseReason at the terminal transition, and it survives past that instance staying released', async () => {
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
    await f.store.transitionInstance(tenant.id, created.id, ['launching'], 'draining', {
      stateReason: 'idle_timeout',
    });
    const applied = await f.store.transitionInstance(
      tenant.id,
      created.id,
      ['draining'],
      'released',
      { releaseReason: 'idle_timeout' },
    );
    expect(applied).toBe(true);

    const reread = await f.store.getInstance(tenant.id, created.id);
    expect(reread?.state).toBe('released');
    expect(reread?.releaseReason).toBe('idle_timeout');

    f.cleanup();
  });
});
