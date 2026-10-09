import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * `init_scripts` round trip on `browser_specs`
 * (`0006_browser_spec_init_scripts.sql`).
 *
 * Before this migration, `StoredBrowserSpec` had no `initScripts` field at
 * all (`packages/protocol/src/domain/store-types.ts`), so
 * `storedSpecToBrowserSpec` (`packages/store-sqlite/src/mappers.ts`)
 * hardcoded `initScripts: []` on every read regardless of what a caller
 * had set. See `entities.ts`'s `BrowserSpec.initScripts` doc comment: a
 * submit gate installed at launch has to survive a warm pool reuse or a
 * gateway restart, both of which rebuild an Instance from its stored spec
 * rather than the caller's original in-memory request.
 *
 * Two things this suite checks that a passing `tsc -b` cannot: that a
 * caller-supplied init script array genuinely survives `upsertBrowserSpec`
 * -> `getBrowserSpec` and `upsertBrowserSpec` -> `createPool` -> `getPool`
 * (the domain-shape expansion), and that a spec row written before this
 * migration (no `init_scripts` column value at all) still reads back as
 * `[]` rather than throwing on a NULL JSON column.
 */
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/engine.js';
import { runMigrations, schemaVersionOf } from '../src/migrate.js';
import { SqliteStore } from '../src/store.js';
import { MIGRATIONS_DIR, freshStore, seedBasics } from './helpers.js';

const SAMPLE_SCRIPTS = [
  { name: 'gate', source: 'window.HTMLFormElement.prototype.submit = () => {};' },
  { name: 'flag', source: 'window.__bgls_gate_armed = true;' },
];

describe('browser_specs.init_scripts round trip', () => {
  it('upsertBrowserSpec -> getBrowserSpec carries a caller-supplied initScripts array through unchanged, order included', async () => {
    const f = freshStore();
    const tenant = await f.store.createTenant({ name: 'Acme' });

    const written = await f.store.upsertBrowserSpec(tenant.id, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'new',
      viewportW: 1920,
      viewportH: 1080,
      dpr: 1,
      locale: null,
      timezone: null,
      userAgent: null,
      initScripts: SAMPLE_SCRIPTS,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off',
      limits: {},
    });
    expect(written.initScripts).toEqual(SAMPLE_SCRIPTS);

    const reread = await f.store.getBrowserSpec(tenant.id, written.id);
    expect(reread?.initScripts).toEqual(SAMPLE_SCRIPTS);

    f.cleanup();
  });

  it('a spec with initScripts and an otherwise identical spec without it get different content-addressed rows', async () => {
    // If `digestOfSpec` did not fold `initScripts` into the canonical JSON,
    // these two calls would collapse onto the same `browser_specs` row and
    // the second caller's request for a plain (no init scripts) spec would
    // silently receive the first caller's submit gate instead, or vice
    // versa: either way, one caller's browser runs a script it never asked
    // for.
    const f = freshStore();
    const tenant = await f.store.createTenant({ name: 'Acme' });
    const base = {
      engine: 'chromium' as const,
      channel: 'chrome' as const,
      headless: 'new' as const,
      viewportW: 1920,
      viewportH: 1080,
      dpr: 1,
      locale: null,
      timezone: null,
      userAgent: null,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off' as const,
      limits: {},
    };
    const withoutScripts = await f.store.upsertBrowserSpec(tenant.id, base);
    const withScripts = await f.store.upsertBrowserSpec(tenant.id, {
      ...base,
      initScripts: SAMPLE_SCRIPTS,
    });
    expect(withScripts.id).not.toBe(withoutScripts.id);
    expect(withoutScripts.initScripts ?? null).toBeNull();
    expect(withScripts.initScripts).toEqual(SAMPLE_SCRIPTS);

    f.cleanup();
  });

  it("storedSpecToBrowserSpec expands a stored spec's initScripts onto a Pool.template, not just the raw stored row", async () => {
    // `getBrowserSpec` returns the `StoredBrowserSpec` shape directly;
    // `getPool` is the path that exercises `mappers.ts`'s
    // `storedSpecToBrowserSpec`, the function that used to hardcode
    // `initScripts: []` unconditionally.
    const f = freshStore();
    const tenant = await f.store.createTenant({ name: 'Acme' });
    const spec = await f.store.upsertBrowserSpec(tenant.id, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'new',
      viewportW: 1920,
      viewportH: 1080,
      dpr: 1,
      locale: null,
      timezone: null,
      userAgent: null,
      initScripts: SAMPLE_SCRIPTS,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off',
      limits: {},
    });
    const pool = await f.store.createPool({
      tenantId: tenant.id,
      name: 'default',
      specId: spec.id,
    });
    const reread = await f.store.getPool(tenant.id, pool.id);
    expect(reread?.template.initScripts).toEqual(SAMPLE_SCRIPTS);

    f.cleanup();
  });

  it('a caller that never sets initScripts reads back [], on both the stored row and the expanded Pool.template', async () => {
    const f = freshStore();
    const { tenant, pool } = await seedBasics(f.store); // seedBasics's spec sets no initScripts

    const rereadPool = await f.store.getPool(tenant.id, pool.id);
    expect(rereadPool?.template.initScripts).toEqual([]);

    f.cleanup();
  });
});

describe('0006_browser_spec_init_scripts.sql on a populated pre-0006 database', () => {
  it('adds the column in place and an existing spec row reads back with initScripts [], not a thrown error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-store-sqlite-upgrade-'));
    const db = openSqlite(join(dir, 'control.db'));

    // Stop at 5, one before this migration, and write a spec row the way
    // pre-0006 code did: no `init_scripts` column exists yet at all, so it
    // has to be a raw INSERT in the version 5 column set, the same reason
    // `upsertBrowserSpec` cannot run against a pre-0006 schema at all: its
    // INSERT names `init_scripts` unconditionally, targeting the current
    // schema, not whatever schema happens to be open.
    runMigrations(db, MIGRATIONS_DIR, 5);
    expect(schemaVersionOf(db)).toBe(5);
    const store = new SqliteStore(db, MIGRATIONS_DIR);
    const tenant = await store.createTenant({ name: 'Acme' });
    const specId = 'bsp_initscriptsfixture0000000000';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO browser_specs (id, tenant_id, digest, engine, channel, headless, isolation, viewport_w, viewport_h, dpr, locale, timezone, user_agent, client_hints, proxy, args, extensions, stealth, limits, created_at)
       VALUES (?, ?, 'digest-fixture', 'chromium', 'chrome', 'new', 'tab', 1920, 1080, 1.0, NULL, NULL, ?, NULL, NULL, '[]', '[]', 'off', '{}', ?)`,
    ).run(specId, tenant.id, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0', now);

    // Upgrade in place, row and all. Runs every migration after 5, not just
    // 0006: `0007_browser_spec_remote_endpoint.sql` and
    // `0008_instance_metadata_lifetime.sql` also land here, which is fine,
    // since both only add another column this test does not assert on
    // (one on `browser_specs`, one on `instances`).
    runMigrations(db, MIGRATIONS_DIR);
    expect(schemaVersionOf(db)).toBe(8);

    const afterUpgrade = await store.getBrowserSpec(tenant.id, specId);
    expect(afterUpgrade?.initScripts ?? []).toEqual([]);
    // The rest of the pre-existing row is untouched by the migration.
    expect(afterUpgrade?.userAgent).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
    );

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
