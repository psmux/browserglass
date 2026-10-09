import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientHintsSpec } from '@browserglass/protocol';
/**
 * `client_hints` round trip on `browser_specs`
 * (`0005_browser_spec_client_hints.sql`).
 *
 * Before this migration, `StoredBrowserSpec` had no `clientHints` field at
 * all (`packages/protocol/src/domain/store-types.ts`), so
 * `storedSpecToBrowserSpec` (`packages/store-sqlite/src/mappers.ts`)
 * hardcoded `clientHints: null` on every read regardless of what a caller
 * had set. See `docs/cdp-and-interception.md` section 4, "The client hints
 * half, which the flag alone does not cover".
 *
 * Two things this suite checks that a passing `tsc -b` cannot: that a
 * caller-supplied `ClientHintsSpec` genuinely survives
 * `upsertBrowserSpec` -> `getBrowserSpec` and `upsertBrowserSpec` ->
 * `createPool` -> `getPool` (the domain-shape expansion), and that a spec
 * row written before this migration (no `client_hints` column value at
 * all) still reads back as `null` rather than throwing on a NULL JSON
 * column.
 */
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/engine.js';
import { runMigrations, schemaVersionOf } from '../src/migrate.js';
import { SqliteStore } from '../src/store.js';
import { MIGRATIONS_DIR, freshStore, seedBasics } from './helpers.js';

const SAMPLE_HINTS: ClientHintsSpec = {
  brands: [
    { brand: 'Chromium', version: '128' },
    { brand: 'Not;A=Brand', version: '24' },
  ],
  platform: 'Windows',
  platformVersion: '15.0.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  fullVersion: '128.0.6613.120',
};

describe('browser_specs.client_hints round trip', () => {
  it('upsertBrowserSpec -> getBrowserSpec carries a caller-supplied ClientHintsSpec through unchanged', async () => {
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
      clientHints: SAMPLE_HINTS,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off',
      limits: {},
    });
    expect(written.clientHints).toEqual(SAMPLE_HINTS);

    const reread = await f.store.getBrowserSpec(tenant.id, written.id);
    expect(reread?.clientHints).toEqual(SAMPLE_HINTS);

    f.cleanup();
  });

  it('a spec with clientHints and an otherwise identical spec without it get different content-addressed rows', async () => {
    // If `digestOfSpec` did not fold `clientHints` into the canonical JSON,
    // these two calls would collapse onto the same `browser_specs` row and
    // the second caller's request for a plain (no client hints) spec would
    // silently receive the first caller's client hints instead.
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
    const withoutHints = await f.store.upsertBrowserSpec(tenant.id, base);
    const withHints = await f.store.upsertBrowserSpec(tenant.id, {
      ...base,
      clientHints: SAMPLE_HINTS,
    });
    expect(withHints.id).not.toBe(withoutHints.id);
    expect(withoutHints.clientHints ?? null).toBeNull();
    expect(withHints.clientHints).toEqual(SAMPLE_HINTS);

    f.cleanup();
  });

  it("storedSpecToBrowserSpec expands a stored spec's clientHints onto a Pool.template, not just the raw stored row", async () => {
    // `getBrowserSpec` returns the `StoredBrowserSpec` shape directly;
    // `getPool` is the path that exercises `mappers.ts`'s
    // `storedSpecToBrowserSpec`, the function that used to hardcode
    // `clientHints: null` unconditionally.
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
      clientHints: SAMPLE_HINTS,
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
    expect(reread?.template.clientHints).toEqual(SAMPLE_HINTS);

    f.cleanup();
  });

  it('a caller that never sets clientHints reads back null, on both the stored row and the expanded Pool.template', async () => {
    const f = freshStore();
    const { tenant, pool } = await seedBasics(f.store); // seedBasics's spec sets no clientHints

    const rereadPool = await f.store.getPool(tenant.id, pool.id);
    expect(rereadPool?.template.clientHints).toBeNull();

    f.cleanup();
  });
});

describe('0005_browser_spec_client_hints.sql on a populated pre-0005 database', () => {
  it('adds the column in place and an existing spec row reads back with clientHints null, not a thrown error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-store-sqlite-upgrade-'));
    const db = openSqlite(join(dir, 'control.db'));

    // Stop at 4, one before this migration, and write a spec row the way
    // pre-0005 code did: no `client_hints` column exists yet at all, so it
    // has to be a raw INSERT in the version 4 column set (identical to the
    // version 2 set, since neither migration 3 nor 4 touches
    // `browser_specs`), the same reason `upsertBrowserSpec` cannot run
    // against a pre-0005 schema at all: its INSERT names `client_hints`
    // unconditionally, targeting the current schema, not whatever schema
    // happens to be open.
    runMigrations(db, MIGRATIONS_DIR, 4);
    expect(schemaVersionOf(db)).toBe(4);
    const store = new SqliteStore(db, MIGRATIONS_DIR);
    const tenant = await store.createTenant({ name: 'Acme' });
    const specId = 'bsp_clienthintsfixture000000000';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO browser_specs (id, tenant_id, digest, engine, channel, headless, isolation, viewport_w, viewport_h, dpr, locale, timezone, user_agent, proxy, args, extensions, stealth, limits, created_at)
       VALUES (?, ?, 'digest-fixture', 'chromium', 'chrome', 'new', 'tab', 1920, 1080, 1.0, NULL, NULL, ?, NULL, '[]', '[]', 'off', '{}', ?)`,
    ).run(specId, tenant.id, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0', now);

    // Upgrade in place, row and all. Runs every migration after 4, not
    // just 0005: `0006_browser_spec_init_scripts.sql`,
    // `0007_browser_spec_remote_endpoint.sql`, and
    // `0008_instance_metadata_lifetime.sql` also land here, which is fine,
    // since all three only add another column (nullable, or NOT NULL with
    // a default) to an existing table, and this test's assertions are all
    // about `client_hints`.
    runMigrations(db, MIGRATIONS_DIR);
    expect(schemaVersionOf(db)).toBe(8);

    const afterUpgrade = await store.getBrowserSpec(tenant.id, specId);
    expect(afterUpgrade?.clientHints ?? null).toBeNull();
    // The rest of the pre-existing row is untouched by the migration.
    expect(afterUpgrade?.userAgent).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
    );

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
