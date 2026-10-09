/** Shared test fixtures: a fresh, migrated `SqliteStore` backed by a real temp file (never `:memory:`, so the concurrency and second-connection tests in this suite are exercising the real single-writer-lock file behaviour, not SQLite's separate in-memory semantics). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openSqlite } from '../src/engine.js';
import { runMigrations } from '../src/migrate.js';
import { SqliteStore } from '../src/store.js';

export const MIGRATIONS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'migrations');

export interface Fixture {
  dir: string;
  dbPath: string;
  db: Database.Database;
  store: SqliteStore;
  cleanup: () => void;
}

/** Opens a fresh temp-file database, applies every migration, and returns a ready `SqliteStore` plus the raw `db` handle for whitebox assertions. */
export function freshStore(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-store-sqlite-'));
  const dbPath = join(dir, 'control.db');
  const db = openSqlite(dbPath);
  runMigrations(db, MIGRATIONS_DIR);
  const store = new SqliteStore(db, MIGRATIONS_DIR);
  return {
    dir,
    dbPath,
    db,
    store,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Seeds the minimal row graph (tenant, node, app, browser spec, pool, profile) a lease/instance test needs. */
export async function seedBasics(store: SqliteStore) {
  const tenant = await store.createTenant({ name: 'Acme' });
  const node = await store.registerNode({
    name: 'node-1',
    runtime: 'host',
    address: 'http://127.0.0.1:9000',
    registrationSecretEnc: 'enc',
  });
  const app = await store.createApp({ tenantId: tenant.id, name: 'demo-app' });
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
  const pool = await store.createPool({ tenantId: tenant.id, name: 'default', specId: spec.id });
  const profile = await store.createProfile({
    tenantId: tenant.id,
    appId: app.id,
    key: 'user:1',
    mode: 'persistent',
    storagePath: 'profiles/user-1',
  });
  return { tenant, node, app, spec, pool, profile };
}
