import type { Pool } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

describe('Store CRUD coverage', () => {
  it('tenants, apps, pools, and browser specs round-trip, and upsertBrowserSpec is content addressed', async () => {
    const f = freshStore();
    const { tenant, app, spec, pool } = await seedBasics(f.store);

    expect((await f.store.getTenant(tenant.id))?.name).toBe('Acme');
    expect((await f.store.listTenants()).map((t) => t.id)).toContain(tenant.id);
    const renamed = await f.store.updateTenant(tenant.id, { name: 'Acme Renamed' });
    expect(renamed.name).toBe('Acme Renamed');
    await f.store.setTenantStatus(tenant.id, 'suspended');
    expect((await f.store.getTenant(tenant.id))?.state).toBe('suspended');

    expect((await f.store.getApp(tenant.id, app.id))?.name).toBe('demo-app');
    expect((await f.store.listApps(tenant.id)).length).toBe(1);

    const specAgain = await f.store.upsertBrowserSpec(tenant.id, {
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
    expect(specAgain.id).toBe(spec.id); // same digest, same row

    expect((await f.store.getPool(tenant.id, pool.id))?.name).toBe('default');
    expect((await f.store.getPoolByName(tenant.id, 'default'))?.id).toBe(pool.id);

    f.cleanup();
  });

  it('updatePool repoints a pool at a new spec, and also persists placement and duration/idle limits', async () => {
    // Regression: `updatePool` built its SET list from `name`, `state`,
    // `limits.maxInstances`, and `warm.min` only, silently dropping every
    // other `Partial<Pool>` field with a real backing column. `specId` is
    // the sharp one: `upsertBrowserSpec` is content addressed by digest, so
    // editing anything about a pool's browser spec (including `isolation`,
    // now that `browser_specs` has that column too) mints a NEW spec id,
    // and repointing the pool at it was the only way that edit could ever
    // take effect. Without this, a long lived pool row was stuck on
    // whatever spec it was created with forever.
    const f = freshStore();
    const { tenant, pool, spec } = await seedBasics(f.store);

    const specB = await f.store.upsertBrowserSpec(tenant.id, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'new',
      viewportW: 800,
      viewportH: 600,
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
    expect(specB.id).not.toBe(spec.id); // different digest, different row

    // Before the fix: still spec A's viewport, since `specId` was dropped.
    const before = await f.store.getPool(tenant.id, pool.id);
    expect(before?.template.viewport).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    const patch: Partial<Pool> & { specId: string } = {
      // `Pool` has no typed `specId` field (see `updatePool`'s own
      // comment); the store implementation accepts it via a cast.
      specId: specB.id,
      placement: { policy: 'affinity', params: { region: 'us' } },
      limits: { ...before!.limits, sessionMaxDurationMs: 3_600_000, sessionIdleMs: 120_000 },
    };
    const updated = await f.store.updatePool(tenant.id, pool.id, patch);
    expect(updated.template.viewport).toEqual({ width: 800, height: 600, deviceScaleFactor: 1 });
    expect(updated.placement).toEqual({ policy: 'affinity', params: { region: 'us' } });
    expect(updated.limits.sessionMaxDurationMs).toBe(3_600_000);
    expect(updated.limits.sessionIdleMs).toBe(120_000);

    // The next "acquire" (any fresh read of the pool) sees the new spec.
    const reread = await f.store.getPool(tenant.id, pool.id);
    expect(reread?.template.viewport).toEqual({ width: 800, height: 600, deviceScaleFactor: 1 });

    f.cleanup();
  });

  it('app keys enforce the "never both publicKey and secretEnc" rule and support rotation', async () => {
    const f = freshStore();
    const { tenant, app } = await seedBasics(f.store);

    await expect(
      f.store.createAppKey({
        appId: app.id,
        tenantId: tenant.id,
        alg: 'HS256',
        publicKey: 'x',
        secretEnc: 'y',
        notBefore: new Date().toISOString(),
      }),
    ).rejects.toThrow();

    const key1 = await f.store.createAppKey({
      appId: app.id,
      tenantId: tenant.id,
      alg: 'EdDSA',
      publicKey: 'pub1',
      notBefore: new Date().toISOString(),
    });
    await f.store.transaction((tx) => {
      f.store.rotateAppKey(tx, app.id, key1.id);
    });
    expect((await f.store.getAppKey(app.id, key1.id))?.status).toBe('active');

    await f.store.revokeAppKey(app.id, key1.id, true);
    expect((await f.store.getAppKey(app.id, key1.id))?.status).toBe('revoked');

    f.cleanup();
  });

  it('nodes register, heartbeat, and list by status', async () => {
    const f = freshStore();
    const node = await f.store.registerNode({
      name: 'n1',
      runtime: 'host',
      address: 'http://localhost:9000',
      registrationSecretEnc: 'x',
    });
    expect((await f.store.getNode(node.id))?.state).toBe('registering');

    await f.store.heartbeatNode({
      nodeId: node.id,
      beatAt: new Date().toISOString(),
      seq: 1,
      liveInstances: 0,
    });
    const fetched = await f.store.getNode(node.id);
    expect(fetched?.load.sampledAt).toBeGreaterThan(0);

    await f.store.setNodeStatus(node.id, 'ready');
    const ready = await f.store.listNodes({ status: ['ready'] });
    expect(ready.map((n) => n.id)).toContain(node.id);

    const stale = await f.store.findStaleNodes(new Date(Date.now() + 10000).toISOString());
    expect(stale.map((n) => n.id)).toContain(node.id);

    f.cleanup();
  });

  it("heartbeatNode reports load as USED, converted from the FREE figures a heartbeat carries, against the node's own registered capacity", async () => {
    // Regression for `rowToNode` (`mappers.ts`) hardcoding
    // `memoryUsedMb`/`profileDiskUsedMb` to `0` regardless of what a
    // heartbeat actually reported: with every node's memory and disk
    // headroom always reading as "fully free", `placementCandidates`'s
    // `capacity.maxMemoryMb - load.memoryUsedMb < memNeeded` check (and
    // its disk equivalent) could never exclude a genuinely memory or disk
    // starved node once cross node placement started reading real nodes
    // back through this store (`@browserglass/router`'s
    // `BrowserRouter.remoteNodeSnapshots`).
    const f = freshStore();
    const node = await f.store.registerNode({
      name: 'n2',
      runtime: 'host',
      address: 'http://localhost:9001',
      registrationSecretEnc: 'x',
      capacity: {
        maxInstances: 10,
        maxMemoryMb: 8_000,
        cpuCores: 4,
        profileDiskMb: 100_000,
        maxConcurrentLaunches: 4,
      },
    });

    await f.store.heartbeatNode({
      nodeId: node.id,
      beatAt: new Date().toISOString(),
      seq: 1,
      liveInstances: 2,
      memFreeMib: 2_000, // 8000 capacity - 2000 free = 6000 used
      diskFreeMib: 90_000, // 100000 capacity - 90000 free = 10000 used
      cpuLoadPct: 55,
      detail: { warmInstances: 1, launchingInstances: 2, loadAvg1: 1.5 },
    });

    const fetched = await f.store.getNode(node.id);
    expect(fetched?.load.liveInstances).toBe(2);
    expect(fetched?.load.memoryUsedMb).toBe(6_000);
    expect(fetched?.load.profileDiskUsedMb).toBe(10_000);
    expect(fetched?.load.cpuPercent).toBe(55);
    // `detail`'s round trip: no DDL column for any of these three, carried
    // in the JSON `detail` field instead (`store-types.ts`'s
    // `NodeHeartbeat.detail?: Json`); see `StoredHeartbeatDetail`
    // (`mappers.ts`) for the informal contract the write side
    // (`BrowserRouter.persistNodeState`) and this read side agree on.
    expect(fetched?.load.warmInstances).toBe(1);
    expect(fetched?.load.launchingInstances).toBe(2);
    expect(fetched?.load.loadAvg1).toBe(1.5);

    f.cleanup();
  });

  it('registerNode upserts on id: a restarting node keeps its identity and created_at, and status resets to registering', async () => {
    const f = freshStore();
    const first = await f.store.registerNode({
      id: 'nod_restart_test' as never,
      name: 'gateway-a',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      dataAddress: 'ws://127.0.0.1:5001/browserglass/node',
      registrationSecretEnc: 'first-life',
    });
    expect(first.dataPlaneUrl).toBe('ws://127.0.0.1:5001/browserglass/node');

    await f.store.setNodeStatus(first.id, 'ready');
    expect((await f.store.getNode(first.id))?.state).toBe('ready');

    // Simulate the process restarting: the same operator configured
    // `peer.nodeId`, a new `dataAddress` (the process bound a different
    // ephemeral port this time), same shared secret so the same
    // derivation would produce the same `registrationSecretEnc` in
    // practice, but the test varies it too, to prove the column is
    // genuinely updated, not merely preserved by accident.
    const second = await f.store.registerNode({
      id: 'nod_restart_test' as never,
      name: 'gateway-a',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      dataAddress: 'ws://127.0.0.1:5009/browserglass/node',
      registrationSecretEnc: 'second-life',
    });

    // Same durable id: this is the entire point. Not a second row, not a
    // freshly minted id.
    expect(second.id).toBe(first.id);
    expect((await f.store.listNodes()).filter((n) => n.id === first.id).length).toBe(1);

    // `created_at` is not exposed on the `Node` domain shape directly, but
    // `registeredAt` is derived from it (`mappers.ts`'s `rowToNode`), so an
    // unchanged `registeredAt` across the two calls is exactly the
    // "keeps its original registration time" claim this upsert makes.
    expect(second.registeredAt).toBe(first.registeredAt);

    // The new life's address won, proving this is a real update, not a
    // no-op that happened to return the old row.
    expect(second.dataPlaneUrl).toBe('ws://127.0.0.1:5009/browserglass/node');

    // A node that just restarted has not gone through `setNodeStatus('ready')`
    // again yet; the first life's 'ready' must not leak into the second
    // life's initial state, the same way a genuinely fresh node's first
    // ever registration starts at 'registering', never 'ready'.
    expect(second.state).toBe('registering');

    f.cleanup();
  });

  it('instance lifecycle: create, transitionInstance compare-and-set, bumpInstanceEpoch, claimWarmInstance', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
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
    expect(instance.state).toBe('launching');

    const ok = await f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'warm');
    expect(ok).toBe(true);
    const stale = await f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'live');
    expect(stale).toBe(false); // status is now 'warm', not 'launching'

    const claimed = await f.store.claimWarmInstance({
      tenantId: tenant.id,
      poolId: pool.id,
      specId: spec.id,
    });
    expect(claimed?.id).toBe(instance.id);
    expect(claimed?.state).toBe('ready');

    const epoch = await f.store.bumpInstanceEpoch(tenant.id, instance.id);
    expect(epoch).toBe(2);

    await f.store.touchInstance(tenant.id, instance.id, new Date().toISOString());
    const list = await f.store.listInstances(tenant.id, { poolId: pool.id });
    expect(list.map((i) => i.id)).toContain(instance.id);

    f.cleanup();
  });

  it('transitionInstance persists a caller-supplied expiresAt onto the row, rather than the acquiredAt + 14_400_000 fallback', async () => {
    // Regression: `BrowserRouter.placeAndLaunch`
    // computes `expiresAt` from the caller's `ttlMs` and passes it in the
    // patch that lands an instance on `'live'`, but before
    // `0003_instance_expires_at.sql` there was no column for it, so this
    // was silently dropped and every instance's `expiresAt` came back as
    // the fixed default no matter what `ttlMs` was requested.
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
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

    // A short TTL, well under the 14_400_000ms default fallback, so a
    // fallback-vs-real-value mixup would be obvious rather than
    // coincidentally close.
    const shortTtlExpiresAt = instance.acquiredAt + 60_000;
    await f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'live', {
      expiresAt: shortTtlExpiresAt,
    });

    const fetched = await f.store.getInstance(tenant.id, instance.id);
    expect(fetched?.expiresAt).toBe(shortTtlExpiresAt);
    expect(fetched?.expiresAt).not.toBe(instance.acquiredAt + 14_400_000);

    f.cleanup();
  });

  it('two concurrent claimWarmInstance calls for one warm instance produce one winner and one null (single process, sequential SQL, still exercises the subquery UPDATE)', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
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
    await f.store.transitionInstance(tenant.id, instance.id, ['launching'], 'warm');

    const [r1, r2] = await Promise.all([
      f.store.claimWarmInstance({ tenantId: tenant.id, poolId: pool.id, specId: spec.id }),
      f.store.claimWarmInstance({ tenantId: tenant.id, poolId: pool.id, specId: spec.id }),
    ]);
    const winners = [r1, r2].filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    f.cleanup();
  });

  it('sessions, viewers, and control leases round-trip', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
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
    const session = await f.store.createSession({
      tenantId: tenant.id,
      instanceId: instance.id,
      gatewayId: 'gw-1',
    });
    expect((await f.store.getSession(tenant.id, session.id))?.nodeId).toBe(node.id);
    expect((await f.store.listSessionsByGateway('gw-1')).map((s) => s.id)).toContain(session.id);

    const viewer = await f.store.createViewer({
      tenantId: tenant.id,
      sessionId: session.id,
      instanceId: instance.id,
      sub: 'user-1',
      caps: ['view', 'control'],
    });
    expect(viewer.capabilities).toEqual(['view', 'control']);
    await f.store.closeViewer(viewer.id, {
      disconnectedAt: new Date().toISOString(),
      closeCode: 1000,
      closeReason: null,
      bytesSent: 100,
      framesSent: 5,
      framesDropped: 0,
    });
    const viewers = await f.store.listViewers(tenant.id, session.id);
    expect(viewers[0]?.disconnectedAt).not.toBeNull();

    const grant = await f.store.recordControlGrant({
      tenantId: tenant.id,
      sessionId: session.id,
      targetId: 'tgt_x',
      viewerId: viewer.id,
      sub: 'user-1',
      grantedAt: new Date().toISOString(),
    });
    await f.store.recordControlRelease(grant.id, 'voluntary', 42);

    await f.store.endSession(tenant.id, session.id, 'session_ended', 4000);
    expect((await f.store.getSession(tenant.id, session.id))?.state).toBe('ended');

    f.cleanup();
  });

  it('quotas: reserveQuota check-and-increment refuses past the limit, releaseQuota gives the slot back', async () => {
    const f = freshStore();
    const { tenant } = await seedBasics(f.store);
    await f.store.setQuota({
      tenantId: tenant.id,
      scope: 'tenant',
      metric: 'liveInstances',
      limitValue: 1,
      window: 'concurrent',
      softPct: 80,
      action: 'reject',
      updatedAt: new Date().toISOString(),
    });

    const first = await f.store.reserveQuota({
      tenantId: tenant.id,
      scope: 'tenant',
      metric: 'liveInstances',
      amount: 1,
    });
    expect(first.allowed).toBe(true);
    const second = await f.store.reserveQuota({
      tenantId: tenant.id,
      scope: 'tenant',
      metric: 'liveInstances',
      amount: 1,
    });
    expect(second.allowed).toBe(false);

    await f.store.releaseQuota({
      tenantId: tenant.id,
      scope: 'tenant',
      metric: 'liveInstances',
      amount: 1,
    });
    const third = await f.store.reserveQuota({
      tenantId: tenant.id,
      scope: 'tenant',
      metric: 'liveInstances',
      amount: 1,
    });
    expect(third.allowed).toBe(true);

    expect((await f.store.getQuotas(tenant.id)).length).toBe(1);
    f.cleanup();
  });

  it('usage counters accumulate via incrementUsage and are readable via readUsage', async () => {
    const f = freshStore();
    const { tenant } = await seedBasics(f.store);
    const bucket = new Date().toISOString().slice(0, 13);
    await f.store.incrementUsage([
      { tenantId: tenant.id, bucket, granularity: 'hour', metric: 'browser_seconds', amount: 60 },
    ]);
    await f.store.incrementUsage([
      { tenantId: tenant.id, bucket, granularity: 'hour', metric: 'browser_seconds', amount: 30 },
    ]);
    const rows = await f.store.readUsage(tenant.id, bucket, bucket, 'browser_seconds');
    expect(rows[0]?.value).toBe(90);
    f.cleanup();
  });

  it('audit events append, query, and chain via appendAuditChained', async () => {
    const f = freshStore();
    const { tenant } = await seedBasics(f.store);
    await f.store.appendAudit([
      { tenantId: tenant.id, occurredAt: new Date().toISOString(), eventType: 'test.event' },
    ]);
    const page = await f.store.queryAudit(tenant.id, { eventType: 'test.event' });
    expect(page.events.length).toBe(1);

    await f.store.transaction((tx) => {
      f.store.appendAuditChained(tx, tenant.id, {
        tenantId: tenant.id,
        occurredAt: new Date().toISOString(),
        eventType: 'chained.one',
      });
      f.store.appendAuditChained(tx, tenant.id, {
        tenantId: tenant.id,
        occurredAt: new Date().toISOString(),
        eventType: 'chained.two',
        hash: 'h2',
      });
    });
    const chained = await f.store.queryAudit(tenant.id, { eventType: 'chained.two' });
    expect(chained.events[0]?.prevHash).toBeNull(); // chained.one had no hash set

    f.cleanup();
  });

  it('downloads and uploads round-trip', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
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

    const dl = await f.store.createDownload({
      tenantId: tenant.id,
      instanceId: instance.id,
      nodeId: node.id,
      filename: 'a.pdf',
      storagePath: 'dl/a.pdf',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const updatedDl = await f.store.updateDownload(tenant.id, dl.id, {
      status: 'complete',
      sizeBytes: 1024,
    });
    expect(updatedDl.status).toBe('complete');
    expect((await f.store.listDownloads(tenant.id, instance.id)).length).toBe(1);

    const ul = await f.store.createUpload({
      tenantId: tenant.id,
      instanceId: instance.id,
      filename: 'b.png',
      declaredBytes: 2048,
      storagePath: 'ul/b.png',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await f.store.updateUpload(tenant.id, ul.id, { receivedBytes: 2048, status: 'received' });
    const stale = await f.store.findStaleUploads(new Date(Date.now() + 1).toISOString(), 10);
    expect(stale.length).toBe(0); // status is 'received', not 'staging'

    f.cleanup();
  });

  it('attach tickets redeem exactly once (the fifth of the atomic five)', async () => {
    const f = freshStore();
    const { tenant, node } = await seedBasics(f.store);
    f.db
      .prepare(
        'INSERT INTO attach_tickets (id, tenant_id, node_id, instance_id, viewer_id, epoch, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'tkt_1',
        tenant.id,
        node.id,
        'inst_1',
        'vwr_1',
        1,
        new Date().toISOString(),
        new Date(Date.now() + 60000).toISOString(),
      );

    const redeem = {
      id: 'tkt_1',
      tenantId: tenant.id,
      nodeId: node.id,
      instanceId: 'inst_1',
      viewerId: 'vwr_1',
      epoch: 1,
      redeemedAt: new Date().toISOString(),
    };
    expect(await f.store.redeemAttachTicket(redeem)).toBe(true);
    expect(
      await f.store.redeemAttachTicket({ ...redeem, redeemedAt: new Date().toISOString() }),
    ).toBe(false);

    f.cleanup();
  });

  it('revocations are checked and cached, invites redeem with a redemption cap', async () => {
    const f = freshStore();
    const { tenant, node, app, spec, pool, profile } = await seedBasics(f.store);
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
    await f.store.putRevocation({
      tenantId: tenant.id,
      kind: 'sub',
      value: 'user-bad',
      effectiveAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const hit = await f.store.checkRevoked(tenant.id, [{ kind: 'sub', value: 'user-bad' }]);
    expect(hit).not.toBeNull();
    const miss = await f.store.checkRevoked(tenant.id, [{ kind: 'sub', value: 'user-good' }]);
    expect(miss).toBeNull();

    const invite = await f.store.createInvite({
      tenantId: tenant.id,
      appId: app.id,
      instanceId: instance.id,
      secretHash: 'hash1',
      createdBy: 'user-1',
      caps: ['view'],
      scope: {},
      maxRedemptions: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const redeemed = await f.store.transaction((tx) =>
      f.store.redeemInvite(tx, invite.secretHash, new Date().toISOString()),
    );
    expect(redeemed?.status).toBe('exhausted');
    const secondRedeem = await f.store.transaction((tx) =>
      f.store.redeemInvite(tx, invite.secretHash, new Date().toISOString()),
    );
    expect(secondRedeem).toBeNull();

    await f.store.revokeInvite(tenant.id, invite.id, 'admin');

    f.cleanup();
  });

  it('placement queue: enqueue, claimPlacements, completePlacement/failPlacement', async () => {
    const f = freshStore();
    const { tenant, app, spec, pool } = await seedBasics(f.store);
    const placement = await f.store.enqueuePlacement({
      tenantId: tenant.id,
      appId: app.id,
      poolId: pool.id,
      specId: spec.id,
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(placement.status).toBe('queued');

    const claimed = await f.store.claimPlacements('router-1', 10);
    expect(claimed.map((p) => p.id)).toContain(placement.id);
    expect(claimed[0]?.status).toBe('claimed');

    await f.store.failPlacement(placement.id, 'boom', true);
    const reclaimed = await f.store.claimPlacements('router-1', 10);
    expect(reclaimed.map((p) => p.id)).toContain(placement.id);

    await f.store.completePlacement(placement.id, 'inst_fake');

    f.cleanup();
  });

  it('purge deletes per-table with the documented semantics, and maintain() runs cleanly', async () => {
    const f = freshStore();
    const { tenant } = await seedBasics(f.store);
    await f.store.appendAudit([
      {
        tenantId: tenant.id,
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        eventType: 'old.event',
      },
    ]);

    const deleted = await f.store.purge('audit_events', new Date().toISOString(), 100);
    expect(deleted).toBe(1);

    const report = await f.store.maintain();
    expect(report.vacuumed).toBe(true);

    f.cleanup();
  });

  it('ping reports ok with a measured latency', async () => {
    const f = freshStore();
    const result = await f.store.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    f.cleanup();
  });
});
