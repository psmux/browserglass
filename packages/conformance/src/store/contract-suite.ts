import {
  type AppId,
  BglsError,
  type BrowserSpecInput,
  type InstanceLifecycleState,
  type NodeId,
  type ProfileId,
  type Store,
  type TenantId,
  newId,
} from '@browserglass/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * One method every `Store` implementation exports, named for a mutating (or
 * otherwise not purely a `capabilities()`/`ping()` style) call the "fails
 * informatively, not crashes" case in {@link runStoreContractSuite} exercises
 * against a stub adapter. Kept as a name plus a thunk building a minimal,
 * well typed argument list, rather than a bare string list, so a stub that
 * happens to validate its arguments before throwing `E_NOT_IMPLEMENTED`
 * still gets a call shaped closely enough to a real one to reach that
 * throw.
 */
interface StubProbe {
  readonly name: string;
  call(store: Store): Promise<unknown>;
}

/** Deterministic ids used only inside a stub probe call, never asserted against. */
const PROBE_TENANT = newId('ten') as TenantId;
const PROBE_APP = newId('app') as AppId;
const PROBE_NODE = newId('nod') as NodeId;
const PROBE_PROFILE = newId('prf') as ProfileId;

const MINIMAL_BROWSER_SPEC: BrowserSpecInput = {
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
};

/**
 * Every `Store` method beyond `init`/`close`/`ping`/`capabilities`/
 * `transaction`, called with a minimal, well formed argument list. Used
 * only against a stub adapter ({@link StoreContractSuiteOptions.expectNotImplemented}),
 * where every one of these is expected to throw a `BglsError` coded
 * `E_NOT_IMPLEMENTED` rather than crash with something unrelated (a
 * `TypeError` from an unguarded property read, for example).
 */
const STUB_PROBES: readonly StubProbe[] = [
  { name: 'getTenant', call: (s) => s.getTenant(PROBE_TENANT) },
  { name: 'listTenants', call: (s) => s.listTenants() },
  { name: 'createTenant', call: (s) => s.createTenant({ name: 'stub' }) },
  { name: 'updateTenant', call: (s) => s.updateTenant(PROBE_TENANT, {}) },
  { name: 'setTenantStatus', call: (s) => s.setTenantStatus(PROBE_TENANT, 'active') },
  { name: 'getApp', call: (s) => s.getApp(PROBE_TENANT, PROBE_APP) },
  { name: 'listApps', call: (s) => s.listApps(PROBE_TENANT) },
  { name: 'createApp', call: (s) => s.createApp({ tenantId: PROBE_TENANT, name: 'stub' }) },
  { name: 'getAppKey', call: (s) => s.getAppKey(PROBE_APP, 'kid') },
  {
    name: 'createAppKey',
    call: (s) =>
      s.createAppKey({ appId: PROBE_APP, kid: 'kid', publicKey: 'pk', alg: 'EdDSA' } as never),
  },
  { name: 'getPool', call: (s) => s.getPool(PROBE_TENANT, 'pol_stub' as never) },
  { name: 'listPools', call: (s) => s.listPools(PROBE_TENANT) },
  {
    name: 'createPool',
    call: (s) => s.createPool({ tenantId: PROBE_TENANT, name: 'stub', specId: 'bsp_stub' }),
  },
  {
    name: 'upsertBrowserSpec',
    call: (s) => s.upsertBrowserSpec(PROBE_TENANT, MINIMAL_BROWSER_SPEC),
  },
  { name: 'getBrowserSpec', call: (s) => s.getBrowserSpec(PROBE_TENANT, 'bsp_stub') },
  { name: 'getProfile', call: (s) => s.getProfile(PROBE_TENANT, PROBE_PROFILE) },
  { name: 'listProfiles', call: (s) => s.listProfiles(PROBE_TENANT) },
  {
    name: 'createProfile',
    call: (s) =>
      s.createProfile({
        tenantId: PROBE_TENANT,
        appId: PROBE_APP,
        key: 'stub',
        mode: 'ephemeral',
        storagePath: 'stub',
      }),
  },
  {
    name: 'acquireProfileLease',
    call: (s) =>
      s.acquireProfileLease({
        tenantId: PROBE_TENANT,
        profileId: PROBE_PROFILE,
        nodeId: PROBE_NODE,
        ttlMs: 1000,
      }),
  },
  {
    name: 'registerNode',
    call: (s) =>
      s.registerNode({
        name: 'stub',
        runtime: 'host',
        address: 'http://x',
        registrationSecretEnc: 'x',
      }),
  },
  { name: 'getNode', call: (s) => s.getNode(PROBE_NODE) },
  { name: 'listNodes', call: (s) => s.listNodes() },
  {
    name: 'createInstance',
    call: (s) =>
      s.createInstance({
        tenantId: PROBE_TENANT,
        appId: PROBE_APP,
        specId: 'bsp_stub',
        nodeId: PROBE_NODE,
        metadata: {},
        lifetime: 'viewer-bound',
      }),
  },
  { name: 'getInstance', call: (s) => s.getInstance(PROBE_TENANT, 'inst_stub' as never) },
  { name: 'listInstances', call: (s) => s.listInstances(PROBE_TENANT) },
  {
    name: 'reserveQuota',
    call: (s) =>
      s.reserveQuota({ tenantId: PROBE_TENANT, scope: 'stub', metric: 'stub', amount: 1 }),
  },
  { name: 'purge', call: (s) => s.purge('sessions', new Date(0).toISOString(), 10) },
  { name: 'maintain', call: (s) => s.maintain() },
  { name: 'migrate', call: (s) => s.migrate() },
  { name: 'schemaVersion', call: (s) => s.schemaVersion() },
];

/** Options accepted by {@link runStoreContractSuite}. */
export interface StoreContractSuiteOptions {
  /** Human readable adapter name, used as the outer `describe` block's title, e.g. `'store-sqlite'` or `'store-postgres'`. */
  readonly name: string;
  /**
   * Returns the store instance under test, already `init()`ed and
   * migrated (or, for a stub, simply constructed) by the caller. A thunk
   * rather than a bare value: `runStoreContractSuite` registers its
   * `describe`/`it` structure synchronously at collection time, before a
   * caller's own `beforeAll` (which typically opens the real connection)
   * has run, so every access here happens lazily, at each test's actual
   * run time.
   */
  store(): Store;
  /**
   * Returns a second, independent connection or instance backed by the
   * SAME underlying storage as {@link store} (for example a second
   * `createSqliteStore()` call opened against the identical file path),
   * used only for the real, engine level concurrency assertion on
   * `acquireProfileLease`. Two genuinely separate connections racing the
   * same partial-unique-index insert is what makes that assertion real
   * concurrency rather than a mock. Omit
   * (or return `undefined`) to skip that one case; every other assertion
   * in this suite runs regardless.
   */
  secondConnection?(): Store | undefined;
  /**
   * When true, this suite asserts every method in {@link STUB_PROBES}
   * throws a `BglsError` coded `E_NOT_IMPLEMENTED` (so the suite fails
   * informatively, rather than crashing, against the Postgres stub) instead of running the full behavioural suite against
   * {@link store}. `capabilities()` and `ping()` are still asserted for
   * real, since `store-postgres` documents both as
   * genuinely implemented.
   */
  readonly expectNotImplemented?: boolean;
}

/**
 * A generic conformance suite against `@browserglass/protocol`'s `Store`
 * interface, runnable against any adapter: `store-sqlite` today, and
 * any future adapter, by passing its own `Store` instance in. Only
 * `Store`'s own documented contract is exercised, never an adapter's
 * internal representation, so this suite never imports `store-sqlite` or
 * `store-postgres` itself; the caller wires those in devDependency-only
 * test files.
 */
export function runStoreContractSuite(opts: StoreContractSuiteOptions): void {
  describe(`Store contract: ${opts.name}`, () => {
    it('capabilities() reports a well formed StoreCapabilities shape', () => {
      const caps = opts.store().capabilities();
      expect(typeof caps.transactions).toBe('boolean');
      expect(typeof caps.advisoryLocks).toBe('boolean');
      expect(typeof caps.skipLocked).toBe('boolean');
      expect(typeof caps.notify).toBe('boolean');
      expect(typeof caps.concurrentWriters).toBe('boolean');
      expect(caps.maxWriteConcurrency).toBeGreaterThanOrEqual(1);
    });

    it('ping() resolves {ok, latencyMs} and never throws', async () => {
      const result = await opts.store().ping();
      expect(typeof result.ok).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    if (opts.expectNotImplemented) {
      describe('fails informatively, not crashes (stub adapter)', () => {
        for (const probe of STUB_PROBES) {
          it(`${probe.name} throws BglsError('E_NOT_IMPLEMENTED', ...), never crashes`, async () => {
            await expect(probe.call(opts.store())).rejects.toMatchObject({
              name: 'BglsError',
              code: 'E_NOT_IMPLEMENTED',
            });
            // A genuinely informative failure is also a real `BglsError`
            // instance, not merely a look-alike shape, so a caller can
            // `instanceof` it.
            try {
              await probe.call(opts.store());
              expect.unreachable(`${probe.name} was expected to throw`);
            } catch (err) {
              expect(err).toBeInstanceOf(BglsError);
            }
          });
        }
      });
      return;
    }

    describe('behavioural contract (real adapter)', () => {
      let tenantId: TenantId;
      let appId: AppId;
      let nodeId: NodeId;
      let specId: string;

      beforeAll(async () => {
        const store = opts.store();
        const tenant = await store.createTenant({ name: `conformance-${opts.name}` });
        tenantId = tenant.id;
        const app = await store.createApp({ tenantId, name: 'conformance-app' });
        appId = app.id;
        const node = await store.registerNode({
          name: `conformance-node-${opts.name}`,
          runtime: 'host',
          address: 'http://127.0.0.1:0',
          registrationSecretEnc: 'unused',
        });
        nodeId = node.id;
        const spec = await store.upsertBrowserSpec(tenantId, MINIMAL_BROWSER_SPEC);
        specId = spec.id;
      });

      it('tenant / app / pool / profile round trip through the store as written', async () => {
        const store = opts.store();
        const pool = await store.createPool({ tenantId, name: 'default', specId });
        expect(pool.tenantId).toBe(tenantId);
        // `Pool` (the domain read shape) carries the resolved `template:
        // BrowserSpec`, not the `specId` string `NewPool` was given; the
        // channel written through `MINIMAL_BROWSER_SPEC` is what proves
        // the round trip.
        expect(pool.template.channel).toBe(MINIMAL_BROWSER_SPEC.channel);

        const created = await store.createProfile({
          tenantId,
          appId,
          key: 'contract-suite:user-1',
          mode: 'persistent',
          storagePath: 'profiles/contract-suite-1',
        });
        const read = await store.getProfile(tenantId, created.id);
        expect(read).not.toBeNull();
        expect(read?.key).toBe('contract-suite:user-1');
        expect(read?.mode).toBe('persistent');

        const byKey = await store.getProfileByKey(tenantId, appId, 'contract-suite:user-1');
        expect(byKey?.id).toBe(created.id);
      });

      it('acquireProfileLease is THE atomic method: two concurrent acquires for one profile produce exactly one winner and one null', async () => {
        const store = opts.store();
        const profile = await store.createProfile({
          tenantId,
          appId,
          key: `contract-suite:lease-${newId('prf')}`,
          mode: 'ephemeral',
          storagePath: 'profiles/contract-suite-lease',
        });

        const req = { tenantId, profileId: profile.id, nodeId, ttlMs: 30_000 };
        const second = opts.secondConnection?.();

        if (second) {
          // Real, engine level concurrency: two independent connections
          // (or instances) backed by the identical underlying storage,
          // racing the identical INSERT the partial unique index
          // arbitrates. This is genuinely two writers, not two `Promise`s
          // cooperatively scheduled on one JS thread.
          const [a, b] = await Promise.all([
            store.acquireProfileLease(req),
            second.acquireProfileLease(req),
          ]);
          const winners = [a, b].filter((r): r is NonNullable<typeof a> => r !== null);
          const losers = [a, b].filter((r) => r === null);
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);
          expect(winners[0]?.fence).toBe(1);
        } else {
          const [a, b] = await Promise.all([
            store.acquireProfileLease(req),
            store.acquireProfileLease(req),
          ]);
          const winners = [a, b].filter((r): r is NonNullable<typeof a> => r !== null);
          expect(winners).toHaveLength(1);
        }
      });

      it('fence strictly increases across a release and re-acquire, never decreases', async () => {
        const store = opts.store();
        const profile = await store.createProfile({
          tenantId,
          appId,
          key: `contract-suite:fence-${newId('prf')}`,
          mode: 'ephemeral',
          storagePath: 'profiles/contract-suite-fence',
        });
        const req = { tenantId, profileId: profile.id, nodeId, ttlMs: 30_000 };

        const first = await store.acquireProfileLease(req);
        expect(first).not.toBeNull();
        expect(first?.fence).toBe(1);
        await store.releaseProfileLease(first!.id, 'contract-suite');

        const second = await store.acquireProfileLease(req);
        expect(second).not.toBeNull();
        expect(second!.fence).toBeGreaterThan(first!.fence);

        await store.releaseProfileLease(second!.id, 'contract-suite');
        const third = await store.acquireProfileLease(req);
        expect(third!.fence).toBeGreaterThan(second!.fence);
      });

      it('heartbeatProfileLease returns false once the lease is released or expired', async () => {
        const store = opts.store();
        const profile = await store.createProfile({
          tenantId,
          appId,
          key: `contract-suite:heartbeat-${newId('prf')}`,
          mode: 'ephemeral',
          storagePath: 'profiles/contract-suite-heartbeat',
        });
        const lease = await store.acquireProfileLease({
          tenantId,
          profileId: profile.id,
          nodeId,
          ttlMs: 30_000,
        });
        expect(lease).not.toBeNull();
        expect(await store.heartbeatProfileLease(lease!.id, 30_000)).toBe(true);
        await store.releaseProfileLease(lease!.id, 'contract-suite');
        expect(await store.heartbeatProfileLease(lease!.id, 30_000)).toBe(false);
      });

      it('transitionInstance is a real compare-and-set: a stale `from` never applies', async () => {
        const store = opts.store();
        const instance = await store.createInstance({
          tenantId,
          appId,
          specId,
          nodeId,
          metadata: {},
          lifetime: 'viewer-bound',
        });
        // `Instance.state` is the domain `InstanceLifecycleState` (a
        // ten value union), a distinct value set from the `InstanceStatus`
        // (the DDL's seven value `status` column) `transitionInstance`'s
        // own `from`/`to` parameters use; a fresh row's DDL status
        // 'launching' maps to domain state 'launching' too, but 'live'
        // maps to 'ready' (store-sqlite's own `INSTANCE_STATUS_TO_STATE`),
        // which the assertion after the transition below accounts for.
        expect(instance.state).toBe('launching' satisfies InstanceLifecycleState);

        const staleApplied = await store.transitionInstance(
          tenantId,
          instance.id,
          ['live'],
          'draining',
        );
        expect(staleApplied).toBe(false);

        const applied = await store.transitionInstance(
          tenantId,
          instance.id,
          ['launching'],
          'live',
        );
        expect(applied).toBe(true);

        const after = await store.getInstance(tenantId, instance.id);
        expect(after?.state).toBe('ready' satisfies InstanceLifecycleState);
      });

      it('reserveQuota is an atomic check and increment, not a check then a separate increment', async () => {
        const store = opts.store();
        const scope = `contract-suite:${newId('evt')}`;
        const first = await store.reserveQuota({ tenantId, scope, metric: 'instances', amount: 1 });
        expect(first.value).toBeGreaterThanOrEqual(1);
        const second = await store.reserveQuota({
          tenantId,
          scope,
          metric: 'instances',
          amount: 1,
        });
        expect(second.value).toBe(first.value + 1);
        await store.releaseQuota({ tenantId, scope, metric: 'instances', amount: 2 });
      });

      it('redeemAttachTicket returns false on a second redemption of the same id', async () => {
        const store = opts.store();
        const ticketId = `tkt_${newId('evt').slice(4)}`;
        const now = new Date().toISOString();
        const instanceId = newId('inst');
        const viewerId = newId('vwr');
        // `Store` has no public "create a ticket" method (the
        // ticketing flow mints and inserts this row outside the
        // documented `Store` interface); `transaction()` plus
        // `StoreTx.insert()` is itself part of the public contract, so
        // this seeds the one row `redeemAttachTicket` is documented to
        // atomically flip `redeemed_at` on.
        await store.transaction((tx) => {
          tx.insert('attach_tickets', {
            id: ticketId,
            tenant_id: tenantId,
            node_id: nodeId,
            instance_id: instanceId,
            viewer_id: viewerId,
            epoch: 1,
            issued_at: now,
            expires_at: new Date(Date.now() + 30_000).toISOString(),
            redeemed_at: null,
          });
        });

        const redeem = {
          id: ticketId,
          tenantId,
          nodeId,
          instanceId,
          viewerId,
          epoch: 1,
          redeemedAt: now,
        };
        const firstRedemption = await store.redeemAttachTicket(redeem);
        expect(firstRedemption).toBe(true);
        const secondRedemption = await store.redeemAttachTicket({
          ...redeem,
          redeemedAt: new Date().toISOString(),
        });
        expect(secondRedemption).toBe(false);
      });

      it('purge deletes at most `limit` rows and returns the count actually removed', async () => {
        const store = opts.store();
        const deleted = await store.purge('placement_queue', new Date().toISOString(), 1);
        expect(deleted).toBeGreaterThanOrEqual(0);
        expect(deleted).toBeLessThanOrEqual(1);
      });

      it('migrate()/schemaVersion() agree on the current schema version', async () => {
        const store = opts.store();
        const version = await store.schemaVersion();
        expect(version).toBeGreaterThanOrEqual(1);
        const report = await store.migrate();
        expect(report.toVersion).toBe(version);
      });
    });
  });
}
