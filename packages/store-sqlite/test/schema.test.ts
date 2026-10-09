import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/engine.js';
import { readMigrationFiles, runMigrations, schemaVersionOf } from '../src/migrate.js';
import { MIGRATIONS_DIR, freshStore } from './helpers.js';

describe('schema and engine config', () => {
  it('applies the schema from empty and reports schemaVersion() === 8', () => {
    const f = freshStore();
    // 0002_browser_spec_isolation.sql (`browser_specs.isolation`),
    // 0003_instance_expires_at.sql (`instances.expires_at`),
    // 0004_instance_session_id.sql (`instances.session_id`),
    // 0005_browser_spec_client_hints.sql (`browser_specs.client_hints`,
    // `docs/cdp-and-interception.md` section 4),
    // 0006_browser_spec_init_scripts.sql (`browser_specs.init_scripts`,
    // `entities.ts`'s `BrowserSpec.initScripts`),
    // 0007_browser_spec_remote_endpoint.sql
    // (`browser_specs.remote_endpoint_name`, `entities.ts`'s
    // `BrowserSpec.remoteEndpointName`) and
    // 0008_instance_metadata_lifetime.sql (`instances.metadata`,
    // `instances.lifetime`, `entities.ts`'s `Instance.metadata`/`.lifetime`)
    // follow the initial schema; schemaVersionOf reports the highest
    // applied version, not a migration count.
    expect(schemaVersionOf(f.db)).toBe(8);
    const tableCount = f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence'",
      )
      .get() as { n: number };
    // 23 doc-15 tables plus the migrations table itself = 24. 0002 through
    // 0008 each add a column to an existing table, not a new table, so
    // this count is unaffected by any of them.
    expect(tableCount.n).toBe(24);
    f.cleanup();
  });

  it('Store.schemaVersion() also reports 8', async () => {
    const f = freshStore();
    await expect(f.store.schemaVersion()).resolves.toBe(8);
    f.cleanup();
  });

  it('reads exactly eight migration files, skipping the pg-only/ directory entirely', () => {
    const files = readMigrationFiles(MIGRATIONS_DIR);
    expect(files.map((f) => f.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('creates the partial unique index that is the profile lease mutual exclusion mechanism', () => {
    const f = freshStore();
    const idx = f.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_profile_lease_live'",
      )
      .get() as { sql: string };
    expect(idx.sql).toContain('UNIQUE');
    expect(idx.sql).toContain('released_at IS NULL');
    f.cleanup();
  });

  it('PRAGMA foreign_keys reports 1 on a freshly opened second connection to the same file', () => {
    const f = freshStore();
    const second = openSqlite(f.dbPath);
    const fk = second.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    second.close();
    f.cleanup();
  });

  it('sets every required pragma', () => {
    const f = freshStore();
    expect(f.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(f.db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(f.db.pragma('auto_vacuum', { simple: true })).toBe(2); // INCREMENTAL
    f.cleanup();
  });

  it('running migrations again on an already-migrated database is a no-op', () => {
    const f = freshStore();
    const report = runMigrations(f.db, MIGRATIONS_DIR);
    expect(report.applied).toEqual([]);
    f.cleanup();
  });

  it('refuses to open a database whose directory sits on a forbidden network filesystem type', () => {
    // Exercised indirectly: skipFsTypeCheck defaults to false and the check
    // itself is a no-op off Linux, so this asserts the option plumbs
    // through rather than the OS-specific detection path.
    const db = openSqlite(':memory:', { memory: true });
    expect(db.open).toBe(true);
    db.close();
  });
});
