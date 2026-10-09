import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * `@browserglass/store-postgres`: the full `Store` interface on Postgres
 * via `pg`. Mirrors `@browserglass/store-sqlite`'s own `index.ts` shape
 * (`createSqliteStore`/`MigrateMode`) so a caller (`bgls serve`) can pick
 * either adapter by connection string alone.
 */
import type { Store } from '@browserglass/protocol';
import { BglsError } from '@browserglass/protocol';
import {
  type PostgresPoolSizeOptions,
  type PostgresTlsOptions,
  openPostgresPool,
} from './engine.js';
import { readMigrationFiles } from './migrate.js';
import { PostgresStore } from './store.js';

export { openPostgresPool, buildTypeOverrides } from './engine.js';
export type { PostgresPoolOptions, PostgresPoolSizeOptions, PostgresTlsOptions } from './engine.js';
export { PostgresStore } from './store.js';
export {
  runMigrations,
  readMigrationFiles,
  schemaVersionOf,
  MigrationChecksumError,
} from './migrate.js';
export { retryTotal, isUniqueViolation } from './retry.js';
export { SyncBridge } from './sync/bridge.js';
export { PgTx } from './sync/tx.js';

/** Same semantics as `store-sqlite`'s `MigrateMode`: what `createPostgresStore` does after `init()` opens the pool. */
export type MigrateMode = 'auto' | 'check' | 'off';

/** Options accepted by {@link createPostgresStore}. */
export interface CreatePostgresStoreOptions {
  pool?: PostgresPoolSizeOptions;
  tls?: PostgresTlsOptions;
  applicationName?: string;
  /** Directory containing `NNNN_name.sql` migration files. Defaults to this package's own `migrations/` directory. */
  migrationsDir?: string;
  /** See {@link MigrateMode}. Defaults to `'auto'`. */
  migrate?: MigrateMode;
}

/** Resolves this package's root directory from whichever build tsup produced, mirroring `store-sqlite`'s own `packageRoot()`. */
function packageRoot(): string {
  if (typeof __dirname !== 'undefined') return dirname(__dirname);
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

const DEFAULT_MIGRATIONS_DIR = join(packageRoot(), 'migrations');

/**
 * Opens a `pg.Pool` against `connectionString` with every option
 * `PostgresPoolOptions` accepts, and returns a ready `Store`. `init()` is
 * called for the caller; migration runs per `options.migrate` (default
 * `'auto'`), matching `store-sqlite`'s `createSqliteStore` exactly.
 *
 * A connection failure at `init()` (bad host, bad credentials, server
 * unreachable, TLS handshake failure) is rethrown as a `BglsError` coded
 * `E_STORE_CONNECTION_FAILED` naming the setting responsible
 * (`--store`/`BGLS_STORE_URL`, or `--store-tls-*`/`BGLS_STORE_TLS_*` for a
 * TLS specific failure), because a bad store connection should fail with a clear error rather than an opaque `pg` stack
 * trace three layers down.
 */
export async function createPostgresStore(
  connectionString: string,
  options: CreatePostgresStoreOptions = {},
): Promise<Store> {
  const pool = openPostgresPool({
    connectionString,
    ...(options.pool !== undefined ? { pool: options.pool } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.applicationName !== undefined ? { applicationName: options.applicationName } : {}),
  });
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const ssl = buildSslForBridge(options.tls);
  const store = new PostgresStore(
    pool,
    migrationsDir,
    {
      connectionString,
      ...(ssl !== undefined ? { ssl } : {}),
      ...(options.applicationName !== undefined
        ? { applicationName: options.applicationName }
        : {}),
    },
    options.pool?.max ?? 10,
  );

  try {
    await store.init();
  } catch (err) {
    await pool.end().catch(() => undefined);
    const settingName = options.tls?.enabled
      ? '--store-tls-* / BGLS_STORE_TLS_*'
      : '--store / BGLS_STORE_URL';
    throw new BglsError(
      'E_STORE_CONNECTION_FAILED',
      `could not connect to the Postgres store configured by ${settingName}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err, context: { setting: settingName } },
    );
  }

  const mode = options.migrate ?? 'auto';
  if (mode === 'auto') {
    await store.migrate();
  } else if (mode === 'check') {
    const current = await store.schemaVersion();
    const latest = readMigrationFiles(migrationsDir).reduce(
      (max, f) => Math.max(max, f.version),
      0,
    );
    if (current < latest) {
      throw new Error(
        `store-postgres: schema is at version ${current}, code expects version ${latest} (migrate: 'check')`,
      );
    }
  }
  return store;
}

/** Builds the `tls.ConnectionOptions`-shaped `ssl` config the sync bridge's worker thread needs, matching `engine.ts`'s own `buildSsl` for the main pool. Duplicated rather than imported because `engine.ts`'s version is private to that module's `PoolConfig['ssl']` shape; both read the same four fields. */
function buildSslForBridge(
  tls: PostgresTlsOptions | undefined,
): { rejectUnauthorized?: boolean; ca?: string; cert?: string; key?: string } | undefined {
  if (!tls || !tls.enabled) return undefined;
  return {
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
    ...(tls.caPath ? { ca: readFileSync(tls.caPath, 'utf8') } : {}),
    ...(tls.certPath ? { cert: readFileSync(tls.certPath, 'utf8') } : {}),
    ...(tls.keyPath ? { key: readFileSync(tls.keyPath, 'utf8') } : {}),
  };
}
