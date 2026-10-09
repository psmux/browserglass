/**
 * `healProfile` against real directories on disk.
 *
 * Every fixture here is written the way a killed Chrome actually leaves
 * one, because the point of the function is what it does to a profile it
 * did not create. In particular `Default/Preferences` is real Chrome
 * shaped JSON with `profile.exit_type: "Crashed"`, which is exactly what
 * survives a `taskkill /T /F` and exactly what puts the "Restore pages?"
 * bubble in front of an unattended run on the next launch.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProfileFs } from '../src/profile-fs.js';
import { healProfile } from '../src/profile-heal.js';

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

/** A profile directory in the state a hard killed Chrome leaves it. */
function crashedProfile(over: Record<string, unknown> = {}): string {
  root = mkdtempSync(join(tmpdir(), 'bgls-heal-'));
  const udd = join(root, 'udd');
  mkdirSync(join(udd, 'Default'), { recursive: true });
  writeFileSync(
    join(udd, 'Default', 'Preferences'),
    JSON.stringify({
      profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Person 1' },
      session: { restore_on_startup: 1, startup_urls: ['https://shop.example.com/checkout'] },
      credentials_enable_service: true,
      ...over,
    }),
    'utf8',
  );
  return udd;
}

function prefsOf(udd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(udd, 'Default', 'Preferences'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('healProfile, the crash marker', () => {
  it('rewrites exit_type to Normal and exited_cleanly to true, and says it did', async () => {
    const udd = crashedProfile();
    const result = await healProfile(udd);

    expect(result.inUse).toBe(false);
    expect(result.fixed).toContain('exit_type');
    const prefs = prefsOf(udd);
    expect((prefs['profile'] as Record<string, unknown>)['exit_type']).toBe('Normal');
    expect((prefs['profile'] as Record<string, unknown>)['exited_cleanly']).toBe(true);
  });

  it('leaves every other preference in the file exactly as it found it', async () => {
    const udd = crashedProfile();
    await healProfile(udd);
    // The profile's own name, and anything else nobody asked about, is
    // not this function's business. A repair that quietly rewrote the
    // rest of Preferences would be worse than the bubble it prevents.
    expect((prefsOf(udd)['profile'] as Record<string, unknown>)['name']).toBe('Person 1');
  });

  it('reports nothing fixed on a profile that closed cleanly, and still leaves it clean', async () => {
    const udd = crashedProfile({
      profile: {
        exit_type: 'Normal',
        exited_cleanly: true,
        name: 'Person 1',
        password_manager_leak_detection: false,
      },
      session: { restore_on_startup: 5 },
      credentials_enable_service: false,
    });
    const result = await healProfile(udd);
    expect(result.fixed).toEqual([]);
    expect((prefsOf(udd)['profile'] as Record<string, unknown>)['exit_type']).toBe('Normal');
  });
});

describe('healProfile, session restore', () => {
  it('sets startup to the new tab page and drops the urls the last run left behind', async () => {
    const udd = crashedProfile();
    const result = await healProfile(udd);

    expect(result.fixed).toContain('restore_on_startup');
    expect(result.fixed).toContain('startup_urls');
    const session = prefsOf(udd)['session'] as Record<string, unknown>;
    expect(session['restore_on_startup']).toBe(5);
    expect('startup_urls' in session).toBe(false);
  });
});

describe('healProfile, the password and autofill bubbles', () => {
  it('turns off the credential service, password saving and autofill', async () => {
    const udd = crashedProfile();
    await healProfile(udd);
    const prefs = prefsOf(udd);
    expect(prefs['credentials_enable_service']).toBe(false);
    expect((prefs['password_manager'] as Record<string, unknown>)['saving_enabled']).toBe(false);
    expect((prefs['autofill'] as Record<string, unknown>)['profile_enabled']).toBe(false);
  });

  it('turns off the leaked password warning, which blocks all input in headless', async () => {
    const udd = crashedProfile();
    await healProfile(udd);
    const prefs = prefsOf(udd);
    expect((prefs['profile'] as Record<string, unknown>)['password_manager_leak_detection']).toBe(
      false,
    );
  });
});

describe('healProfile, the lock files', () => {
  /**
   * `SingletonLock` is a symlink whose target is the literal string
   * `<hostname>-<pid>` and resolves to nothing, so `existsSync` answers
   * false for it and an implementation built on `existsSync` alone would
   * skip the one file that matters most. Skipped where the platform will
   * not create a symlink without elevation.
   */
  it('removes a dangling SingletonLock symlink, which existsSync cannot even see', async () => {
    const udd = crashedProfile();
    const lock = join(udd, 'SingletonLock');
    try {
      symlinkSync('somehost-4242', lock);
    } catch {
      return; // No symlink privilege on this machine; the plain file case below still covers the unlink.
    }
    expect(existsSync(lock)).toBe(false); // the point of this test

    const result = await healProfile(udd);
    expect(result.fixed).toContain('SingletonLock');
  });

  it('removes SingletonSocket and SingletonCookie when they are ordinary files', async () => {
    const udd = crashedProfile();
    writeFileSync(join(udd, 'SingletonSocket'), '');
    writeFileSync(join(udd, 'SingletonCookie'), '4242');

    const result = await healProfile(udd);
    expect(result.fixed).toContain('SingletonSocket');
    expect(result.fixed).toContain('SingletonCookie');
    expect(existsSync(join(udd, 'SingletonSocket'))).toBe(false);
    expect(existsSync(join(udd, 'SingletonCookie'))).toBe(false);
  });
});

describe('healProfile, what it refuses to do', () => {
  /**
   * An unparseable Preferences is what `corruption-probe.ts` detects and
   * what `ProfileService` quarantines a profile for. Writing a fresh one
   * over the top would erase the evidence and hand back a profile that
   * looks healthy and has lost every cookie-adjacent setting it carried.
   */
  it('reports an unparseable Preferences rather than replacing it', async () => {
    const udd = crashedProfile();
    writeFileSync(join(udd, 'Default', 'Preferences'), '{not json', 'utf8');

    const result = await healProfile(udd);
    expect(result.fixed).toContain('preferences unreadable');
    expect(readFileSync(join(udd, 'Default', 'Preferences'), 'utf8')).toBe('{not json');
  });

  it('is a no-op on a directory that does not exist', async () => {
    const result = await healProfile(join(tmpdir(), 'bgls-heal-does-not-exist-9f3a'));
    expect(result).toEqual({ fixed: [], inUse: false, heldByPid: null });
  });

  it('clears the lock files even when there is no Preferences to repair', async () => {
    root = mkdtempSync(join(tmpdir(), 'bgls-heal-'));
    writeFileSync(join(root, 'SingletonCookie'), '1');
    const result = await healProfile(root);
    expect(result.fixed).toEqual(['SingletonCookie']);
  });

  it('leaves no temporary file behind', async () => {
    const udd = crashedProfile();
    await healProfile(udd);
    expect(existsSync(join(udd, 'Default', 'Preferences.bgls-heal-tmp'))).toBe(false);
  });
});

/**
 * The Windows half of the change. Before it, `clearSingleton` on win32
 * returned `{ cleared: [], refusedLivePid: null }` having touched nothing,
 * on the correct observation that Windows Chrome leaves no `Singleton*`
 * files and the incorrect conclusion that there was therefore
 * nothing to clear. The crash marker is not POSIX specific, and on Windows
 * this runtime's terminate ladder always produces it.
 */
describe('ProfileFs.clearSingleton, on any platform', () => {
  it('repairs the crash marker, not only the lock files', async () => {
    const udd = crashedProfile();
    const fs = createProfileFs({ root: udd });

    const result = await fs.clearSingleton(udd);

    expect(result.refusedLivePid).toBeNull();
    expect(result.cleared).toContain('exit_type');
    expect((prefsOf(udd)['profile'] as Record<string, unknown>)['exit_type']).toBe('Normal');
  });

  it('still reports a removed lock file by its absolute path, as it always did', async () => {
    const udd = crashedProfile();
    writeFileSync(join(udd, 'SingletonCookie'), '1');
    const fs = createProfileFs({ root: udd });

    const result = await fs.clearSingleton(udd);
    expect(result.cleared).toContain(join(udd, 'SingletonCookie'));
  });
});
