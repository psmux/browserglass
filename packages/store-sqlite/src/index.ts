import { dirname, join } from 'node:path';
/**
 * `@browserglass/store-sqlite`: the complete 24 table persistence schema,
 * the forward-only migration runner, and every `Store` method, on SQLite
 * via `better-sqlite3`.
 */
import { fileURLToPath } from 'node:url';
import type { Store } from '@browserglass/protocol';
import { type SqliteOpts, openSqlite } from './engine.js';
import { SqliteStore } from './store.js';

export { openSqlite } from './engine.js';
export type { SqliteOpts } from './engine.js';
export { SqliteStore } from './store.js';
export {
  runMigrations,
  readMigrationFiles,
  schemaVersionOf,
  MigrationChecksumError,
} from './migrate.js';
export { busyRetryTotal } from './retry.js';

/**
 * `migrate: 'auto' | 'check' | 'off'` (a server config key, not part of
 * `Store` itself) drives what `start()` does after `init()` opens the
 * connection:
 *
 * - `'auto'` (default): migrates to the latest version.
 * - `'check'`: fails loudly if the schema is behind, applying nothing.
 * - `'off'`: does neither.
 */
export type MigrateMode = 'auto' | 'check' | 'off';

/** Options accepted by {@link createSqliteStore}. */
export interface CreateSqliteStoreOptions extends SqliteOpts {
  /** Directory containing `NNNN_name.sql` migration files. Defaults to this package's own `migrations/` directory. */
  migrationsDir?: string;
  /** See {@link MigrateMode}. Defaults to `'auto'`. */
  migrate?: MigrateMode;
}

/**
 * Resolves this package's root directory from whichever build tsup
 * produced. `import.meta.url` (ESM) and `__dirname` (CJS) are both
 * `dist/`, one directory below the package root either way; esbuild
 * statically warns that `import.meta` is empty in the CJS output, but that
 * branch is only ever reached from the ESM build, where `__dirname` is not
 * a bound identifier and this branch is the one taken.
 */
function packageRoot(): string {
  if (typeof __dirname !== 'undefined') return dirname(__dirname);
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

const DEFAULT_MIGRATIONS_DIR = join(packageRoot(), 'migrations');

/**
 * Opens (creating if necessary) a SQLite database at `path` with every
 * required pragma, and returns a ready `Store`. `init()` is called for the
 * caller; migration runs per `options.migrate` (default `'auto'`), because
 * `init()` never migrates on its own.
 */
export async function createSqliteStore(
  path: string,
  options: CreateSqliteStoreOptions = {},
): Promise<Store> {
  const db = openSqlite(path, options);
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const store = new SqliteStore(db, migrationsDir);
  await store.init();
  const mode = options.migrate ?? 'auto';
  if (mode === 'auto') {
    await store.migrate();
  } else if (mode === 'check') {
    const current = await store.schemaVersion();
    const { readMigrationFiles } = await import('./migrate.js');
    const latest = readMigrationFiles(migrationsDir).reduce(
      (max, f) => Math.max(max, f.version),
      0,
    );
    if (current < latest) {
      throw new Error(
        `store-sqlite: schema is at version ${current}, code expects version ${latest} (migrate: 'check')`,
      );
    }
  }
  return store;
}
