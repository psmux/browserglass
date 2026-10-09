/**
 * Forward-only migration runner, ported from `store-sqlite`'s `migrate.ts`.
 * No `down` migrations, period: the file format has no
 * `down` section, on either adapter. Where `store-sqlite` takes SQLite's
 * single writer lock as its advisory lock substitute, this runner takes a
 * real Postgres session level advisory lock (`pg_advisory_lock`), so two processes racing
 * `migrate()` against the same database serialise instead of one of them
 * hitting a duplicate `CREATE TABLE`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MigrationReport } from '@browserglass/protocol';
import type { Pool, PoolClient } from 'pg';
import { nowIso } from './time.js';

/** One migration file discovered on disk, parsed but not yet applied. */
interface MigrationFile {
  version: number;
  name: string;
  path: string;
  sql: string;
  checksum: string;
  /** True when the file's first line is the `-- bgls:no-transaction` header escape, used for `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside a transaction block. */
  noTransaction: boolean;
}

const FILE_NAME_RE = /^(\d{4})_(.+)\.sql$/;

/**
 * Splits a migration into individual statements, so a `no-transaction`
 * migration can send them one at a time.
 *
 * This exists because the `-- bgls:no-transaction` escape is not enough on
 * its own. `pg` sends a string containing more than one statement using
 * the SIMPLE query protocol, and Postgres wraps a multi statement simple
 * query in an IMPLICIT transaction block. So `0007_gin_indexes.sql`, which
 * holds two `CREATE INDEX CONCURRENTLY` statements and correctly carries
 * the escape header, still failed with "CREATE INDEX CONCURRENTLY cannot
 * run inside a transaction block": the runner never opened a transaction,
 * Postgres opened one anyway. Sending each statement separately is the
 * only way to keep them out of one.
 *
 * Deliberately small rather than a real parser. It tracks single quoted
 * strings, dollar quoted bodies (tags included, so `$fn$ ... $fn$` nests
 * correctly), line comments and block comments, which is everything the
 * migrations in this package actually use. It is applied ONLY to
 * `no-transaction` files; everything else is still sent whole, inside an
 * explicit transaction, where a multi statement string is exactly what is
 * wanted.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag !== null) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        continue;
      }
    }
    if (ch === ';') {
      const stmt = sql.slice(start, i).trim();
      if (stmt !== '') out.push(stmt);
      start = i + 1;
    }
    i += 1;
  }
  const tail = sql.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/**
 * A fixed, arbitrary advisory lock key for BrowserGlass schema migrations,
 * chosen to fit a plain JS `number` (well under 2^53) so it serialises
 * unambiguously as a `pg` query parameter without a `bigint`/text casting
 * question. Any two BrowserGlass processes migrating the same Postgres
 * server take the SAME lock regardless of which database they are
 * migrating, which is fine: `pg_advisory_lock` is process/session scoped,
 * not table scoped, and this runner only ever holds it for the duration of
 * one `migrate()` call.
 */
const MIGRATION_LOCK_KEY = 728_196_042;

/**
 * Checksums of earlier revisions of migration files whose comments, never
 * their SQL, were later reworded. A database that recorded one of these for
 * the same version is accepted as if it recorded the current checksum, so a
 * comment edit does not lock existing deployments out.
 */
const LEGACY_CHECKSUMS: ReadonlyMap<number, readonly string[]> = new Map([
  [1, ['65c98e25b834c74d22f9b4440cc68e3ca3c7acb99539d749d2ed4d7285892dc1']],
  [7, ['c82489653fdf0b19b584105a1b24f65ad84a81bb4e1c8256cab6f1b03aae6c8f']],
  [8, ['cf5a9c7c4179656ac770a59b7a949c99a7fa9b8508d83395a90c46a04764522f']],
]);

function checksumMatches(version: number, recorded: string, current: string): boolean {
  return recorded === current || (LEGACY_CHECKSUMS.get(version)?.includes(recorded) ?? false);
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Reads every `NNNN_name.sql` file directly inside `migrationsDir`, sorted by version. */
export function readMigrationFiles(migrationsDir: string): MigrationFile[] {
  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = FILE_NAME_RE.exec(entry.name);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2] as string;
    const path = join(migrationsDir, entry.name);
    const sql = readFileSync(path, 'utf8');
    files.push({
      version,
      name,
      path,
      sql,
      checksum: checksumOf(sql),
      noTransaction: sql.trimStart().startsWith('-- bgls:no-transaction'),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

/** Thrown when an already-applied migration's on-disk checksum no longer matches the `migrations` table, meaning history was edited. */
export class MigrationChecksumError extends Error {
  constructor(
    public readonly version: number,
    public override readonly name: string,
  ) {
    super(
      `migration ${version}_${name}.sql has been edited since it was applied: its checksum no longer matches the recorded checksum. Migration history is immutable; a schema change is a new migration file, never an edit to an applied one.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS exists',
    [table],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Runs every pending migration in `migrationsDir` against `pool`, in
 * order, verifying that every already-applied migration's checksum is
 * unchanged before applying anything new. Holds a session level
 * `pg_advisory_lock` for the whole call, on one checked-out client, so a
 * second process calling this concurrently against the same server blocks
 * until the first finishes rather than racing the same `CREATE TABLE`.
 * Each migration (unless marked `-- bgls:no-transaction`) runs in the same
 * transaction as its `migrations` table row insert, so a crash mid
 * migration leaves no partial schema and no orphaned row. `target`, when
 * given, stops after applying that version.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
  target?: number,
): Promise<MigrationReport> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const migrationsTableExists = await tableExists(client, 'migrations');
      const applied: AppliedRow[] = migrationsTableExists
        ? (
            await client.query<AppliedRow>(
              'SELECT version, name, checksum FROM migrations ORDER BY version',
            )
          ).rows
        : [];
      const appliedByVersion = new Map(applied.map((r) => [r.version, r]));
      const fromVersion = applied.length > 0 ? Math.max(...applied.map((r) => r.version)) : 0;

      const files = readMigrationFiles(migrationsDir);

      for (const file of files) {
        const record = appliedByVersion.get(file.version);
        if (record && !checksumMatches(file.version, record.checksum, file.checksum)) {
          throw new MigrationChecksumError(file.version, file.name);
        }
      }

      const report: MigrationReport['applied'][number][] = [];
      const appliedBy = `${hostname()}:${process.pid}`;

      for (const file of files) {
        if (appliedByVersion.has(file.version)) continue;
        if (target !== undefined && file.version > target) break;

        const startedAt = performance.now();
        const recordRow = async (conn: PoolClient | Pool): Promise<void> => {
          await conn.query(
            'INSERT INTO migrations (version, name, checksum, applied_at, applied_by, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)',
            [
              file.version,
              file.name,
              file.checksum,
              nowIso(),
              appliedBy,
              Math.round(performance.now() - startedAt),
            ],
          );
        };

        if (file.noTransaction) {
          // Escape hatch for a migration that cannot run inside a
          // transaction, chiefly `CREATE INDEX CONCURRENTLY`, which
          // Postgres refuses with "cannot run inside a transaction block".
          //
          // One statement at a time, deliberately. Not opening a
          // transaction here is necessary but NOT sufficient: `pg` sends a
          // multi statement string over the simple query protocol, and
          // Postgres wraps that in an implicit transaction, so a file with
          // two `CREATE INDEX CONCURRENTLY` statements failed with the very
          // error this branch exists to avoid. See `splitSqlStatements`.
          for (const statement of splitSqlStatements(file.sql)) {
            await client.query(statement);
          }
          await recordRow(client);
        } else {
          await client.query('BEGIN');
          try {
            await client.query(file.sql);
            await recordRow(client);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }

        report.push({
          version: file.version,
          name: file.name,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }

      const toVersion =
        report.length > 0
          ? (report[report.length - 1] as { version: number }).version
          : fromVersion;
      return { fromVersion, toVersion, applied: report };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Returns the highest applied migration version, or `0` on a database with no `migrations` table yet. */
export async function schemaVersionOf(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    if (!(await tableExists(client, 'migrations'))) return 0;
    const row = await client.query<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM migrations',
    );
    return row.rows[0]?.v ?? 0;
  } finally {
    client.release();
  }
}
