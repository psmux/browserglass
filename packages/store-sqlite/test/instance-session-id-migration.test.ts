import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * `0004_instance_session_id.sql` against a database that already has rows,
 * which is the only case that actually matters: the live demo database is
 * at version 3 with 46 `instances` rows in it, and the migration has to
 * land on that, not on the empty schema `schema.test.ts` exercises.
 *
 * Two things are checked that a fresh-schema test cannot see: that the
 * `ALTER TABLE ADD COLUMN` succeeds with rows present and leaves them
 * meaning what they meant, and that the column's `ON DELETE SET NULL`
 * really does keep `purgeTable('sessions', ...)` working. RESTRICT there
 * would have quietly broken session retention for every instance still
 * pointing at a purged session, and that failure would not surface until a
 * retention sweep ran in production.
 */
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/engine.js';
import { runMigrations, schemaVersionOf } from '../src/migrate.js';
import { SqliteStore } from '../src/store.js';
import { MIGRATIONS_DIR } from './helpers.js';

describe('0004_instance_session_id.sql on a populated pre-0004 database', () => {
  it('adds the column in place, leaves existing rows null, and does not block the sessions purge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-store-sqlite-upgrade-'));
    const db = openSqlite(join(dir, 'control.db'));

    // Stop at 3: the exact schema shape the live demo database is on.
    runMigrations(db, MIGRATIONS_DIR, 3);
    expect(schemaVersionOf(db)).toBe(3);
    const store = new SqliteStore(db, MIGRATIONS_DIR);

    // `seedBasics` (the usual helper) creates its browser spec via
    // `store.upsertBrowserSpec`, whose INSERT names `client_hints`
    // (`0005_browser_spec_client_hints.sql`, added after this migration).
    // That column does not exist at schema version 3, so `upsertBrowserSpec`
    // cannot run here for exactly the reason `createInstance` cannot either
    // (this file's own comment below): current code targets the current
    // schema, and a version 3 database is not the current schema. The
    // browser spec and pool rows are therefore inserted raw, in the version
    // 3 column set (which for `browser_specs` is identical to the column
    // set as of `0002_browser_spec_isolation.sql`, since migrations 3 and 4
    // touch only `instances`), the same workaround this test already
    // applies to the `instances` row itself.
    const tenant = await store.createTenant({ name: 'Acme' });
    const node = await store.registerNode({
      name: 'node-1',
      runtime: 'host',
      address: 'http://127.0.0.1:9000',
      registrationSecretEnc: 'enc',
    });
    const app = await store.createApp({ tenantId: tenant.id, name: 'demo-app' });
    const specId = 'bsp_upgradepathfixture00000000';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO browser_specs (id, tenant_id, digest, engine, channel, headless, isolation, viewport_w, viewport_h, dpr, locale, timezone, user_agent, proxy, args, extensions, stealth, limits, created_at)
       VALUES (?, ?, 'digest-fixture', 'chromium', 'chrome', 'new', 'tab', 1920, 1080, 1.0, NULL, NULL, NULL, NULL, '[]', '[]', 'off', '{}', ?)`,
    ).run(specId, tenant.id, now);
    const poolId = 'pol_upgradepathfixture00000000';
    db.prepare(
      `INSERT INTO pools (id, tenant_id, name, spec_id, min_warm, max_instances, placement, idle_timeout_ms, max_duration_ms, status, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 0, 10, '{}', 900000, 14400000, 'active', ?, ?)`,
    ).run(poolId, tenant.id, specId, now, now);
    const profile = await store.createProfile({
      tenantId: tenant.id,
      appId: app.id,
      key: 'user:1',
      mode: 'persistent',
      storagePath: 'profiles/user-1',
    });
    const spec = { id: specId };
    const pool = { id: poolId };

    // The instance row is inserted raw, in the v3 column set, because that
    // is what pre-0004 code wrote. `createInstance` names `session_id` in
    // its INSERT and so cannot write to a v3 schema at all, which is
    // correct rather than a limitation: `createSqliteStore`'s
    // `migrate: 'check'` mode refuses a schema older than the code before
    // any of this is reachable.
    const oldId = 'inst_upgradepathfixture0000000';
    db.prepare(
      `INSERT INTO instances (id, tenant_id, app_id, pool_id, spec_id, profile_id, node_id, epoch, status, status_since, restart_count, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 'launching', ?, 0, NULL, ?, ?)`,
    ).run(oldId, tenant.id, app.id, pool.id, spec.id, node.id, now, now, now);

    // Upgrade in place, rows and all. Runs every migration after 3, not
    // just 0004: `0005_browser_spec_client_hints.sql`,
    // `0006_browser_spec_init_scripts.sql`,
    // `0007_browser_spec_remote_endpoint.sql`, and
    // `0008_instance_metadata_lifetime.sql` also land here. The first
    // three only touch `browser_specs`; 0008 touches `instances` (adding
    // `metadata`/`lifetime`, `NOT NULL DEFAULT`ed so the pre-existing row
    // this test seeded below reads back with both at their defaults, not
    // an error), which is fine, since this test's assertions are all
    // about `session_id`.
    runMigrations(db, MIGRATIONS_DIR);
    expect(schemaVersionOf(db)).toBe(8);

    // The pre-existing row keeps meaning exactly what it meant. There is no
    // backfill and there cannot be one: nothing recorded which of an
    // instance's sessions was current, or which profile a released lease
    // had handed it.
    const afterUpgrade = await store.getInstance(tenant.id, oldId);
    expect(afterUpgrade?.sessionId).toBeNull();
    expect(afterUpgrade?.profileId).toBeNull();

    // It is patchable from here on, though.
    const session = await store.createSession({ tenantId: tenant.id, instanceId: oldId });
    await store.transitionInstance(tenant.id, oldId, ['launching'], 'live', {
      profileId: profile.id,
      sessionId: session.id,
    });
    const patched = await store.getInstance(tenant.id, oldId);
    expect(patched?.sessionId).toBe(session.id);
    expect(patched?.profileId).toBe(profile.id);

    // Retention: `purge.ts` deletes ended sessions past their window. The
    // new foreign key must degrade the instance's pointer, never veto the
    // delete.
    await store.endSession(tenant.id, session.id, 'test', 1000);
    db.prepare("UPDATE sessions SET ended_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      session.id,
    );
    expect(await store.purge('sessions', '2020-01-01T00:00:00.000Z', 100)).toBe(1);

    const afterPurge = await store.getInstance(tenant.id, oldId);
    expect(afterPurge?.sessionId).toBeNull();
    // And only the session pointer cleared. The profile association, the
    // one that cost 3 GB of undeleted profile directories, survives.
    expect(afterPurge?.profileId).toBe(profile.id);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
