import type { Store } from '@browserglass/protocol';
/**
 * Postgres-specific concurrency tests: the operations that most need a
 * real database to prove (`claimWarmInstance`,
 * `claimPlacements`/`enqueuePlacement`, `reserveQuota`), each exercised with genuinely concurrent callers (real
 * `Promise.all` racing real queries against one database, not sequential
 * awaits), plus the `Store.transaction()`/`StoreTx` sync bridge
 * (`sync/bridge.ts`) end to end, since nothing else in this package's test
 * suite exercises a real `pg.Client` running inside it.
 *
 * Skipped entirely (with a clear message, never a silent zero) unless
 * `BGLS_TEST_POSTGRES_URL` is set. See `store.test.ts`'s top comment for
 * why: a Postgres server is not assumed to be available in every
 * development or CI environment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresStore } from '../src/index.js';

const connectionString = process.env['BGLS_TEST_POSTGRES_URL'];

describe.skipIf(!connectionString)('store-postgres concurrency', () => {
  let store: Store;
  let tenantId: string;
  let appId: string;
  let nodeId: string;
  let specId: string;
  let poolId: string;

  beforeAll(async () => {
    store = await createPostgresStore(connectionString as string, { migrate: 'auto' });
    const tenant = await store.createTenant({ name: 'concurrency-test' });
    tenantId = tenant.id;
    const app = await store.createApp({ tenantId, name: 'concurrency-app' });
    appId = app.id;
    const node = await store.registerNode({
      name: 'concurrency-node',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      registrationSecretEnc: 'unused',
    });
    nodeId = node.id;
    const spec = await store.upsertBrowserSpec(tenantId, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'new',
      viewportW: 1280,
      viewportH: 720,
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
    specId = spec.id;
    const pool = await store.createPool({
      tenantId,
      name: `concurrency-pool-${Date.now()}`,
      specId,
    });
    poolId = pool.id;
  });

  afterAll(async () => {
    await store.close();
  });

  it('claimWarmInstance: N concurrent callers against N warm instances each win a DIFFERENT instance via FOR UPDATE SKIP LOCKED, none blocked and none double-claimed', async () => {
    const N = 5;
    const instances = await Promise.all(
      Array.from({ length: N }, () =>
        store.createInstance({
          tenantId,
          appId,
          poolId,
          specId,
          nodeId,
          metadata: {},
          lifetime: 'viewer-bound',
        }),
      ),
    );
    await Promise.all(
      instances.map((i) => store.transitionInstance(tenantId, i.id, ['launching'], 'warm')),
    );

    const claims = await Promise.all(
      Array.from({ length: N }, () => store.claimWarmInstance({ tenantId, poolId, specId })),
    );
    const wonIds = claims.map((c) => c?.id).filter((id): id is string => id !== undefined);
    expect(wonIds).toHaveLength(N); // every caller won something
    expect(new Set(wonIds).size).toBe(N); // and no two callers won the same row
    for (const c of claims) expect(c?.state).toBe('ready');
  });

  it('claimPlacements: two concurrent claimers against a shared queue partition it with SELECT ... FOR UPDATE SKIP LOCKED, no row claimed twice', async () => {
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, () =>
        store.enqueuePlacement({
          tenantId,
          appId,
          poolId,
          specId,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );

    const [batchA, batchB] = await Promise.all([
      store.claimPlacements('router-a', N),
      store.claimPlacements('router-b', N),
    ]);
    const claimedIds = [...batchA, ...batchB].map((p) => p.id);
    expect(claimedIds.length).toBeGreaterThanOrEqual(N); // every enqueued row (plus any left over from a prior run) got claimed by exactly one of the two
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no id appears in both batches
    for (const p of [...batchA, ...batchB]) expect(p.status).toBe('claimed');
  });

  it('reserveQuota: a durable counter row makes the concurrency-window check-and-increment correct across truly parallel callers, never over-admitting past the limit', async () => {
    const scope = `concurrency-test:${Date.now()}`;
    await store.setQuota({
      tenantId,
      scope,
      metric: 'liveInstances',
      limitValue: 3,
      window: 'concurrent',
      softPct: 80,
      action: 'reject',
      updatedAt: new Date().toISOString(),
    });

    const attempts = 10;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        store.reserveQuota({ tenantId, scope, metric: 'liveInstances', amount: 1 }),
      ),
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(3); // exactly the limit, never more, regardless of how many callers raced it

    await Promise.all(
      Array.from({ length: attempts }, () =>
        store.releaseQuota({ tenantId, scope, metric: 'liveInstances', amount: 1 }),
      ),
    );
    const afterRelease = await store.reserveQuota({
      tenantId,
      scope,
      metric: 'liveInstances',
      amount: 1,
    });
    expect(afterRelease.allowed).toBe(true);
    expect(afterRelease.value).toBe(1);
  });

  it('Store.transaction()/StoreTx sync bridge: rotateAppKey and redeemInvite run real queries inside one real Postgres transaction', async () => {
    const key1 = await store.createAppKey({
      appId,
      tenantId,
      alg: 'EdDSA',
      publicKey: 'pub1',
      notBefore: new Date().toISOString(),
    });
    await store.transaction((tx) => {
      store.rotateAppKey(tx, appId, key1.id);
    });
    expect((await store.getAppKey(appId, key1.id))?.status).toBe('active');

    const instance = await store.createInstance({
      tenantId,
      appId,
      poolId,
      specId,
      nodeId,
      metadata: {},
      lifetime: 'viewer-bound',
    });
    const invite = await store.createInvite({
      tenantId,
      appId,
      instanceId: instance.id,
      secretHash: `hash-${Date.now()}`,
      createdBy: 'concurrency-test',
      caps: ['view'],
      scope: {},
      maxRedemptions: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const redeemed = await store.transaction((tx) =>
      store.redeemInvite(tx, invite.secretHash, new Date().toISOString()),
    );
    expect(redeemed?.status).toBe('exhausted');
    const secondRedeem = await store.transaction((tx) =>
      store.redeemInvite(tx, invite.secretHash, new Date().toISOString()),
    );
    expect(secondRedeem).toBeNull();
  });
});

if (!connectionString) {
  it.skip('store-postgres concurrency suite (set BGLS_TEST_POSTGRES_URL to a postgres:// connection string to run it)', () =>
    undefined);
}
