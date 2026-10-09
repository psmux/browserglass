/**
 * A real `@browserglass/store-sqlite` `Store`, backed by a temp file (never
 * `:memory:`, matching `store-sqlite`'s own test fixture convention, so
 * the concurrency tests exercise real single-writer-lock file behaviour
 * rather than SQLite's separate in-memory semantics), for `ProfileService`
 * tests that need genuine transactional correctness rather than a mock.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '@browserglass/protocol';
import { createSqliteStore } from '@browserglass/store-sqlite';

/** A fresh, migrated `Store` plus its temp directory and a `cleanup` to close and remove it. */
export interface StoreFixture {
  dir: string;
  store: Store;
  cleanup: () => Promise<void>;
}

/** Opens a fresh temp-file SQLite database, migrated, ready for use. */
export async function freshRouterStore(): Promise<StoreFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-router-profiles-'));
  const dbPath = join(dir, 'control.db');
  const store = await createSqliteStore(dbPath);
  return {
    dir,
    store,
    cleanup: async () => {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One tenant, one app, one node, one browser spec: the minimal row graph a lease and instance test needs. */
export interface Basics {
  tenantId: string;
  appId: string;
  nodeId: string;
  specId: string;
}

/** Seeds a tenant, an app, a node, and a browser spec. */
export async function seedBasics(store: Store): Promise<Basics> {
  const tenant = await store.createTenant({ name: 'Acme' });
  const app = await store.createApp({ tenantId: tenant.id, name: 'demo-app' });
  const node = await store.registerNode({
    name: 'node-1',
    runtime: 'host',
    address: 'http://127.0.0.1:9000',
    registrationSecretEnc: 'enc',
  });
  const spec = await store.upsertBrowserSpec(tenant.id, {
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
  return { tenantId: tenant.id, appId: app.id, nodeId: node.id, specId: spec.id };
}

/** Creates a minimal `Instance` row, for tests exercising `resolve`'s reuse branch (which reads the holder instance's `appId` via `Store.getInstance`). */
export async function createTestInstance(
  store: Store,
  basics: Basics,
  instanceId: string,
  appId = basics.appId,
): Promise<void> {
  await store.createInstance({
    id: instanceId as never,
    tenantId: basics.tenantId as never,
    appId: appId as never,
    specId: basics.specId,
    nodeId: basics.nodeId as never,
    metadata: {},
    lifetime: 'viewer-bound',
  });
}
