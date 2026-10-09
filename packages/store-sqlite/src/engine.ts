/**
 * SQLite connection setup: the exact required pragma set, plus the network
 * filesystem refusal and the single writer role check that SQLite's single
 * writer rules call for.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

/** Filesystem types SQLite locking is documented-unreliable on; opening a database whose directory sits on one of these fails as corruption, not a clean error, so the adapter refuses at open time instead. */
const FORBIDDEN_FSTYPES = new Set([
  'nfs',
  'nfs3',
  'nfs4',
  'cifs',
  'smb',
  'smbfs',
  'fuse',
  'fuseblk',
]);

/** Options accepted by {@link openSqlite}. */
export interface SqliteOpts {
  /** `':memory:'` opens an in-process database, used by the test suite; the filesystem-type check is skipped for it. */
  memory?: boolean;
  /** Skips the network filesystem type check. For tests only; never set in production. */
  skipFsTypeCheck?: boolean;
}

/**
 * Reads `/proc/mounts` (Linux) to find the filesystem type backing `path`'s
 * directory, longest matching mount point wins. Returns `null` when the
 * check cannot be performed (non-Linux, or `/proc/mounts` unreadable),
 * which is treated as "not forbidden" rather than a hard failure, since the
 * check is a best-effort safety net, not the only line of defense.
 */
function detectFsType(path: string): string | null {
  if (process.platform !== 'linux') return null;
  try {
    if (!existsSync('/proc/mounts')) return null;
    const mounts = readFileSync('/proc/mounts', 'utf8');
    const dir = dirname(resolve(path));
    let bestMatch = '';
    let bestType: string | null = null;
    for (const line of mounts.split('\n')) {
      const parts = line.split(' ');
      const mountPoint = parts[1];
      const fsType = parts[2];
      if (!mountPoint || !fsType) continue;
      if (dir === mountPoint || dir.startsWith(`${mountPoint}/`) || mountPoint === '/') {
        if (mountPoint.length >= bestMatch.length) {
          bestMatch = mountPoint;
          bestType = fsType;
        }
      }
    }
    return bestType;
  } catch {
    return null;
  }
}

/**
 * Opens a SQLite database file with every required pragma,
 * and refuses to open a database whose directory sits on `nfs`, `cifs`,
 * `smbfs`, or a FUSE mount, per the single-writer rules.
 * `foreign_keys = ON` is set per connection (SQLite defaults it off), so
 * every caller that opens a second connection to the same file must call
 * this function too, never construct `Database` directly.
 */
export function openSqlite(path: string, opts: SqliteOpts = {}): Database.Database {
  if (!opts.memory && !opts.skipFsTypeCheck) {
    const fsType = detectFsType(path);
    if (fsType && FORBIDDEN_FSTYPES.has(fsType.toLowerCase())) {
      throw new Error(
        `refusing to open the BrowserGlass store on a ${fsType} mount (${path}): SQLite locking over a network filesystem is documented-unreliable and fails as silent corruption, not a clean error. Use local disk, or use a Postgres-backed store instead.`,
      );
    }
  }

  const db = new Database(path, {
    fileMustExist: false,
    // Set at the C level immediately on open, so even this function's own
    // very first pragma call is covered: without it, a second process
    // opening the same file at the same instant can hit SQLITE_BUSY before
    // the `busy_timeout` pragma below has had a chance to run.
    timeout: 5000,
  });

  // busy_timeout is set again here, redundantly with the constructor option
  // above, because it is cheap and makes the intent explicit at the call
  // site. auto_vacuum MUST be set before
  // journal_mode: switching into WAL mode resets a still-pending
  // auto_vacuum change back to NONE on a fresh database file (verified
  // empirically against the bundled SQLite 3.49), so it runs first among
  // the pragmas that touch the file's schema.
  db.pragma('busy_timeout = 5000'); // wait up to 5s for the writer lock before SQLITE_BUSY.
  db.pragma('auto_vacuum = INCREMENTAL'); // must be set before any table is created.
  db.pragma('journal_mode = WAL'); // readers never block the writer, and vice versa.
  db.pragma('synchronous = NORMAL'); // fsync at checkpoints, not every commit.
  db.pragma('foreign_keys = ON'); // off by default in SQLite; required per connection.
  db.pragma('cache_size = -64000'); // 64 MiB page cache (negative = KiB).
  db.pragma('mmap_size = 268435456'); // 256 MiB memory-mapped reads.
  db.pragma('temp_store = MEMORY'); // temp tables and sort scratch space in memory.
  db.pragma('wal_autocheckpoint = 1000'); // checkpoint the WAL at roughly 4 MiB.
  db.pragma('trusted_schema = OFF'); // reject a newer-schema database opened by an older build.

  return db;
}
