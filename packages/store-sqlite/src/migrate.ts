/**
 * Forward-only migration runner. No `down` migrations,
 * period: the file format has no `down` section. On SQLite the exclusive
 * advisory lock used on Postgres (`pg_advisory_lock`) is the
 * writer lock, exclusive by definition, so "take the lock" is simply
 * "start the write transaction that runs the migration".
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MigrationReport } from '@browserglass/protocol';
import type Database from 'better-sqlite3';
import { nowIso } from './time.js';

/** One migration file discovered on disk, parsed but not yet applied. */
interface MigrationFile {
  version: number;
  name: string;
  path: string;
  sql: string;
  checksum: string;
  /** True when the file's first line is the `-- bgls:no-transaction` header escape. */
  noTransaction: boolean;
}

const FILE_NAME_RE = /^(\d{4})_(.+)\.sql$/;

/**
 * Checksums of earlier revisions of migration files whose comments, never
 * their SQL, were later reworded. A database that recorded one of these for
 * the same version is accepted as if it recorded the current checksum, so a
 * comment edit does not lock existing deployments out.
 */
const LEGACY_CHECKSUMS: ReadonlyMap<number, readonly string[]> = new Map([
  [1, ['0a0a6e3a53af0ead828488f831df54ad9ddffd36040b1634dfc8d91fa21734b3']],
  [2, ['e774fff59944ef5936ffed79a39daaa34283a1224ecf1a8934da1fffa1a2b7b2']],
  [3, ['c8cdc2e864ef5df14f743451d71d3331e51050ab9c56c3e5ba264b7bf27b1f0b']],
  [4, ['55b4abbff9896253cae582d286f4d95c666a4c60612396613fd2d7480837f1fe']],
  [8, ['016cbf1171511cf750503dfe1105e8f6907f2f68974fa96665b55f4649d4c655']],
]);

function checksumMatches(version: number, recorded: string, current: string): boolean {
  return recorded === current || (LEGACY_CHECKSUMS.get(version)?.includes(recorded) ?? false);
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Reads every `NNNN_name.sql` file directly inside `migrationsDir`, sorted
 * by version. The `pg-only/` subdirectory (Postgres-only migrations,
 * prefixed `pNNNN_`) is skipped entirely on SQLite.
 */
export function readMigrationFiles(migrationsDir: string): MigrationFile[] {
  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // skips the pg-only/ directory entry itself
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

/**
 * Runs every pending migration in `migrationsDir` against `db`, in order,
 * verifying that every already-applied migration's checksum is unchanged
 * before applying anything new. Each migration (unless marked
 * `-- bgls:no-transaction`) runs in the same transaction as its
 * `migrations` table row insert, so a crash mid-migration leaves no partial
 * schema and no orphaned row. `target`, when given, stops after applying
 * that version (used by tests to exercise a partial migration state); the
 * default applies every pending migration.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
  target?: number,
): MigrationReport {
  const migrationsTableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
    .get();

  const applied: AppliedRow[] = migrationsTableExists
    ? (db
        .prepare('SELECT version, name, checksum FROM migrations ORDER BY version')
        .all() as AppliedRow[])
    : [];
  const appliedByVersion = new Map(applied.map((r) => [r.version, r]));
  const fromVersion = applied.length > 0 ? Math.max(...applied.map((r) => r.version)) : 0;

  const files = readMigrationFiles(migrationsDir);

  // Checksum verification of every already-applied migration, before anything new runs.
  for (const file of files) {
    const record = appliedByVersion.get(file.version);
    if (record && !checksumMatches(file.version, record.checksum, file.checksum)) {
      throw new MigrationChecksumError(file.version, file.name);
    }
  }

  const report: MigrationReport['applied'][number][] = [];
  const appliedByBy = `${hostname()}:${process.pid}`;

  for (const file of files) {
    if (appliedByVersion.has(file.version)) continue;
    if (target !== undefined && file.version > target) break;

    const startedAt = performance.now();
    const applyOne = () => {
      db.exec(file.sql);
      db.prepare(
        'INSERT INTO migrations (version, name, checksum, applied_at, applied_by, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        file.version,
        file.name,
        file.checksum,
        nowIso(),
        appliedByBy,
        Math.round(performance.now() - startedAt),
      );
    };

    if (file.noTransaction) {
      // Escape hatch for a migration that cannot run inside a transaction
      // (for example Postgres CREATE INDEX CONCURRENTLY). SQLite has no such
      // restriction, but the header is honoured uniformly across adapters.
      applyOne();
    } else {
      db.transaction(applyOne)();
    }

    report.push({
      version: file.version,
      name: file.name,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  const toVersion =
    report.length > 0 ? (report[report.length - 1] as { version: number }).version : fromVersion;
  return { fromVersion, toVersion, applied: report };
}

/** Returns the highest applied migration version, or `0` on a database with no `migrations` table yet. */
export function schemaVersionOf(db: Database.Database): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
    .get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null };
  return row.v ?? 0;
}
