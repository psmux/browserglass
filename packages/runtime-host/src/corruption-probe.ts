/**
 * The 400 ms corruption probe. Runs after any unclean release (SIGKILL, lease steal, node crash
 * recovery) and on demand, on the acquire path exactly when recovery time
 * matters, so speed is a correctness requirement, not a nicety.
 * `PRAGMA quick_check`, never `integrity_check` (a full check on a 40 MB
 * cookie DB takes 2 to 10 seconds for barely more signal). Caches are
 * never touched: a corrupt HTTP cache is not a corrupt profile, Chrome
 * discards and rebuilds it.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ProbeResult } from '@browserglass/protocol';
import Database from 'better-sqlite3';
import { pidAlive, readSingletonLockPid } from './process-table.js';

type CheckResult = { name: string; ok: boolean; detail: string | null };

function checkLocalState(profilePath: string): CheckResult {
  const path = join(profilePath, 'Local State');
  if (!existsSync(path))
    return { name: 'local_state_parses', ok: true, detail: 'absent (fresh profile, not a fault)' };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hasOsCrypt = typeof parsed === 'object' && parsed !== null && 'os_crypt' in parsed;
    return hasOsCrypt
      ? { name: 'local_state_parses', ok: true, detail: null }
      : { name: 'local_state_parses', ok: false, detail: 'parses but has no os_crypt key' };
  } catch (err) {
    return {
      name: 'local_state_parses',
      ok: false,
      detail: `unparseable: ${(err as Error).message}`,
    };
  }
}

function checkPreferences(profilePath: string): CheckResult[] {
  const path = join(profilePath, 'Default', 'Preferences');
  const badPath = join(profilePath, 'Default', 'Preferences.bad');
  const results: CheckResult[] = [];

  if (!existsSync(path)) {
    results.push({
      name: 'preferences_parses',
      ok: true,
      detail: 'absent (fresh profile, not a fault)',
    });
    results.push({
      name: 'preferences_nonzero_length',
      ok: true,
      detail: 'absent (fresh profile, not a fault)',
    });
  } else {
    const size = statSync(path).size;
    results.push(
      size > 0
        ? { name: 'preferences_nonzero_length', ok: true, detail: null }
        : {
            name: 'preferences_nonzero_length',
            ok: false,
            detail: 'zero length Preferences file (crash or full disk between create and write)',
          },
    );
    try {
      JSON.parse(readFileSync(path, 'utf8'));
      results.push({ name: 'preferences_parses', ok: true, detail: null });
    } catch (err) {
      results.push({
        name: 'preferences_parses',
        ok: false,
        detail: `unparseable: ${(err as Error).message}`,
      });
    }
  }

  results.push(
    existsSync(badPath)
      ? { name: 'no_preferences_bad', ok: false, detail: 'Default/Preferences.bad present' }
      : { name: 'no_preferences_bad', ok: true, detail: null },
  );
  return results;
}

/** Reads only the first 16 bytes and checks the SQLite magic header, well under the 10 ms budget this check has for `Web Data`/`History`. */
function checkSqliteHeader(path: string, name: string): CheckResult {
  if (!existsSync(path)) return { name, ok: true, detail: 'absent (fresh profile, not a fault)' };
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    const magic = buf.toString('utf8', 0, 15);
    return magic === 'SQLite format 3'
      ? { name, ok: true, detail: null }
      : { name, ok: false, detail: `bad header: ${JSON.stringify(magic)}` };
  } catch (err) {
    return { name, ok: false, detail: `unreadable: ${(err as Error).message}` };
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

/** The one check allowed to actually open a database, read only, and run `PRAGMA quick_check` (30 to 300 ms budget). */
function checkCookiesQuickCheck(profilePath: string): CheckResult {
  const path = join(profilePath, 'Default', 'Network', 'Cookies');
  if (!existsSync(path))
    return { name: 'cookies_quick_check', ok: true, detail: 'absent (fresh profile, not a fault)' };
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
    const rows = db.pragma('quick_check') as Array<{ quick_check: string } | string>;
    const first = rows[0];
    const text = typeof first === 'string' ? first : first?.quick_check;
    return text === 'ok'
      ? { name: 'cookies_quick_check', ok: true, detail: null }
      : { name: 'cookies_quick_check', ok: false, detail: `quick_check: ${JSON.stringify(rows)}` };
  } catch (err) {
    return {
      name: 'cookies_quick_check',
      ok: false,
      detail: `open or check failed: ${(err as Error).message}`,
    };
  } finally {
    db?.close();
  }
}

function checkLeveldbManifest(profilePath: string): CheckResult {
  const dir = join(profilePath, 'Default', 'Local Storage', 'leveldb');
  const currentPath = join(dir, 'CURRENT');
  if (!existsSync(currentPath))
    return {
      name: 'local_storage_manifest',
      ok: true,
      detail: 'absent (fresh profile, not a fault)',
    };
  try {
    const manifestName = readFileSync(currentPath, 'utf8').trim();
    const manifestPath = join(dir, manifestName);
    return existsSync(manifestPath)
      ? { name: 'local_storage_manifest', ok: true, detail: null }
      : {
          name: 'local_storage_manifest',
          ok: false,
          detail: `CURRENT names ${manifestName}, which does not exist`,
        };
  } catch (err) {
    return {
      name: 'local_storage_manifest',
      ok: false,
      detail: `unreadable: ${(err as Error).message}`,
    };
  }
}

function findLeveldbDirs(profilePath: string): string[] {
  const roots = [
    join(profilePath, 'Default', 'Local Storage', 'leveldb'),
    join(profilePath, 'Default', 'Session Storage'),
    join(profilePath, 'Default', 'Service Worker', 'Database'),
  ];
  return roots.filter((d) => existsSync(d));
}

function checkNoZeroLengthLdb(profilePath: string): CheckResult {
  const dirs = findLeveldbDirs(profilePath);
  const zeroLength: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ldb')) continue;
      try {
        if (statSync(join(dir, entry)).size === 0) zeroLength.push(join(dir, entry));
      } catch {
        // Vanished between readdir and stat; not this check's concern.
      }
    }
  }
  return zeroLength.length === 0
    ? { name: 'no_zero_length_ldb', ok: true, detail: null }
    : {
        name: 'no_zero_length_ldb',
        ok: false,
        detail: `zero length .ldb files: ${zeroLength.join(', ')}`,
      };
}

/**
 * POSIX only: reads `SingletonLock`'s target pid and confirms it is dead.
 * Windows has no equivalent artifact to check (Chrome uses a named mutex
 * plus message window there instead, verified empirically to leave no
 * `SingletonLock`/`SingletonSocket`/`SingletonCookie` file on this build);
 * this check reports `ok: true` there unconditionally, with a detail note
 * saying so.
 */
function checkSingletonLockDead(profilePath: string): CheckResult {
  if (process.platform === 'win32') {
    return {
      name: 'singleton_lock_dead',
      ok: true,
      detail: 'not applicable on Windows (Chrome leaves no SingletonLock file there)',
    };
  }
  const pid = readSingletonLockPid(profilePath);
  if (pid === null) return { name: 'singleton_lock_dead', ok: true, detail: null };
  return pidAlive(pid)
    ? { name: 'singleton_lock_dead', ok: false, detail: `SingletonLock names live pid ${pid}` }
    : {
        name: 'singleton_lock_dead',
        ok: true,
        detail: `SingletonLock names dead pid ${pid}, clearable`,
      };
}

/**
 * `.bgls-fence` structural validity only: present and a well-formed
 * non-negative decimal integer. Whether it matches a caller's expected
 * fence is a comparison only the caller (the router's lease holder) can
 * make, since `ProfileFs.probe()` takes only a `path`, per the
 * `ProfileFs` interface `protocol` defines; see
 * `profile-fs.ts`'s `readFence` for the actual value a caller compares.
 */
function checkFenceWellFormed(profilePath: string): CheckResult {
  const path = join(profilePath, '.bgls-fence');
  if (!existsSync(path))
    return {
      name: 'fence_well_formed',
      ok: true,
      detail: 'absent (treated as fence 0 by the caller)',
    };
  const raw = readFileSync(path, 'utf8').trim();
  return /^\d+$/.test(raw)
    ? { name: 'fence_well_formed', ok: true, detail: null }
    : {
        name: 'fence_well_formed',
        ok: false,
        detail: `not a decimal integer: ${JSON.stringify(raw)}`,
      };
}

/**
 * Runs all ten checks, cheapest first, and reports the total wall-clock duration.
 * Never touches `Cache`, `Code Cache`, or `GPUCache`.
 */
export function probeProfileCorruption(profilePath: string): ProbeResult {
  const started = performance.now();
  const checks: CheckResult[] = [];

  checks.push(checkLocalState(profilePath));
  checks.push(...checkPreferences(profilePath));
  checks.push(checkCookiesQuickCheck(profilePath));
  checks.push(checkSqliteHeader(join(profilePath, 'Default', 'Web Data'), 'web_data_header'));
  checks.push(checkSqliteHeader(join(profilePath, 'Default', 'History'), 'history_header'));
  checks.push(checkLeveldbManifest(profilePath));
  checks.push(checkNoZeroLengthLdb(profilePath));
  checks.push(checkSingletonLockDead(profilePath));
  checks.push(checkFenceWellFormed(profilePath));

  const durationMs = performance.now() - started;
  return {
    ok: checks.every((c) => c.ok),
    checks,
    durationMs,
  };
}
