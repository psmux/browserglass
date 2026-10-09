import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { probeProfileCorruption } from '../src/corruption-probe.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function freshProfileDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'bgls-corruption-probe-'));
  mkdirSync(join(dir, 'Default', 'Network'), { recursive: true });
  return dir;
}

describe('probeProfileCorruption, real profile directory', () => {
  it('reports ok for a completely fresh, empty profile directory (nothing to be corrupt yet)', () => {
    const profile = freshProfileDir();
    const result = probeProfileCorruption(profile);
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThan(5);
  });

  it('completes well under the 400ms budget on a real profile directory', () => {
    const profile = freshProfileDir();
    // A real, valid SQLite database, matching what Chrome's Cookies DB is.
    const db = new Database(join(profile, 'Default', 'Network', 'Cookies'));
    db.exec('CREATE TABLE cookies (host TEXT, name TEXT, value TEXT)');
    for (let i = 0; i < 500; i++)
      db.prepare('INSERT INTO cookies VALUES (?, ?, ?)').run(
        `host${i}.example.com`,
        `cookie${i}`,
        'value',
      );
    db.close();

    const result = probeProfileCorruption(profile);
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeLessThan(400);
  });

  it('detects a corrupt Cookies database via PRAGMA quick_check and reports ok:false', () => {
    const profile = freshProfileDir();
    // Not a valid SQLite file at all: quick_check must fail cleanly rather
    // than hang or throw uncaught.
    writeFileSync(
      join(profile, 'Default', 'Network', 'Cookies'),
      Buffer.from('this is not a sqlite database'),
    );
    const result = probeProfileCorruption(profile);
    expect(result.ok).toBe(false);
    const cookiesCheck = result.checks.find((c) => c.name === 'cookies_quick_check');
    expect(cookiesCheck?.ok).toBe(false);
  });

  it('detects a zero-length Preferences file (the crash/full-disk pattern) without flagging it as a fault on a fresh profile', () => {
    const profile = freshProfileDir();
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'), '');
    const result = probeProfileCorruption(profile);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === 'preferences_nonzero_length');
    expect(check?.ok).toBe(false);
  });

  it('never touches Cache, Code Cache, or GPUCache', () => {
    const profile = freshProfileDir();
    mkdirSync(join(profile, 'Default', 'Cache'), { recursive: true });
    writeFileSync(
      join(profile, 'Default', 'Cache', 'garbage'),
      'not touched, must not crash the probe',
    );
    const result = probeProfileCorruption(profile);
    expect(result.ok).toBe(true);
  });

  it('reports a Local State missing os_crypt as not ok', () => {
    const profile = freshProfileDir();
    writeFileSync(join(profile, 'Local State'), JSON.stringify({ some_other_key: true }));
    const result = probeProfileCorruption(profile);
    const check = result.checks.find((c) => c.name === 'local_state_parses');
    expect(check?.ok).toBe(false);
  });
});
