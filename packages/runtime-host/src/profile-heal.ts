/**
 * Erasing the traces of an unclean shutdown before Chrome opens a profile.
 *
 * WHY THIS FILE EXISTS. Under an ephemeral profile it did not need to.
 * `materialise()` clones a template that was closed cleanly, the clone is
 * driven once, and `trash()` removes it. Nothing ever reads the profile a
 * second time, so nothing ever reads what the first run left behind.
 *
 * A PERSISTENT profile is read a second time, by definition, and on
 * Windows this runtime always leaves something behind. `terminate.ts`'s
 * ladder collapses `'graceful'` to `taskkill /T /F` there, because there
 * is no softer signal to send a GUI subsystem process tree, and its own
 * doc says so. A hard killed Chrome writes nothing on the way out: the
 * last `Default/Preferences` it flushed still says
 * `profile.exit_type: "Crashed"` and `profile.exited_cleanly: false`, and
 * on POSIX its `SingletonLock` symlink still names the dead pid. The next
 * launch reads both. What the operator sees is a "Restore pages?" bubble,
 * or on a worse day the "Something went wrong when opening your profile"
 * dialog, sitting over the form the automation was about to fill, with
 * nobody there to dismiss it.
 *
 * WHAT WAS HERE BEFORE. Nothing. `corruption-probe.ts` READS
 * `Default/Preferences` (it parses it and checks the length) and never
 * writes it, so a crashed `exit_type` passes the probe cleanly: it is
 * valid JSON saying a true thing. `ProfileFs.clearSingleton` removed the
 * `Singleton*` files on POSIX and, on win32, returned
 * `{ cleared: [], refusedLivePid: null }` having done nothing at all,
 * because Windows Chrome uses a named mutex and a message window rather
 * than lock files and there was nothing to unlink.
 * That was a correct observation and an incomplete conclusion: the lock
 * files are not the only residue, they are just the only residue that
 * happens to be POSIX only.
 *
 * WHAT THIS DOES. Five repairs, the same ones long running automation
 * setups that relaunch a persistent Chrome profile typically make before
 * every launch. The rule this file implements: "Never SIGKILL a
 * browser we intend to start again. A killed Chrome leaves exit_type
 * 'Crashed' in Preferences and stale Singleton files in the profile
 * directory, which is what makes the next launch look like a profile lock
 * fight."
 *
 * ORDERING, WHICH IS NOT OPTIONAL. This must run AFTER anything still
 * holding the profile has been stopped and BEFORE Chrome is spawned.
 * Repairing a profile underneath a running browser is how a lock fight
 * starts, not how it ends: the live Chrome holds `Preferences` in memory
 * and rewrites it on its own schedule, so a repair either loses to that
 * write or corrupts it. A careful repair refuses outright when the profile
 * is in use, and so does this. `HostRuntime.doLaunch`
 * calls it in its `reconcile` phase, which is the phase that has just
 * killed every pre-existing Chrome on this data dir.
 */

import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SINGLETON_LOCK_FILES, chromeProcsForDataDirAsync } from './process-table.js';

/**
 * What one `healProfile` call repaired, for the launch log. Empty `fixed`
 * with `inUse: false` is the ordinary, healthy case: the last run closed
 * cleanly and there was nothing to do.
 */
export interface HealResult {
  /** Short names of what was repaired, for example `'SingletonLock'`, `'exit_type'`, `'startup_urls'`. */
  readonly fixed: readonly string[];
  /** True when a live Chrome still held the directory, in which case nothing was touched. */
  readonly inUse: boolean;
  /** The pid that held it, when `inUse`. */
  readonly heldByPid: number | null;
}

/** Options for {@link healProfile}. */
export interface HealOptions {
  /**
   * How stale a cached process table reading may be when answering "is
   * anything still using this profile". Default 0, meaning scan now.
   *
   * A process table scan is not free: on Windows it is a `wmic`/`CIM`
   * query costing roughly 400 ms, measured. The launch path pays that
   * once already, in the reconcile phase, immediately before calling this
   * function, so `HostRuntime.doLaunch` passes a small non-zero value and
   * gets the answer that scan produced instead of taking it twice. The
   * blind spot is exactly the same one the reconcile loop itself has: a
   * Chrome that appeared inside the window.
   *
   * Every other caller should leave this at 0. `ProfileFs.clearSingleton`
   * does: it is the lease STEAL path, where "did somebody take this
   * profile a moment ago" is the entire question being asked.
   */
  readonly maxProcessTableAgeMs?: number;
}

/** Chrome's own value for "open the new tab page on startup", as opposed to restoring the last session. */
const RESTORE_ON_STARTUP_NEW_TAB_PAGE = 5;

/**
 * Repairs one profile directory in place, or reports that it could not
 * because something is still using it.
 *
 * `profilePath` is the `--user-data-dir`, the directory that holds
 * `Default/`, not `Default/` itself.
 *
 * Every step is best effort and independent. A profile with an
 * unparseable `Preferences` still gets its lock files cleared, and a
 * profile whose `Preferences` cannot be written still reports what it
 * found. Nothing here throws for a filesystem reason: this runs on the
 * launch path, and refusing to launch because a preference file could not
 * be tidied would be a worse outcome than the dialog it was tidying to
 * avoid.
 */
export async function healProfile(profilePath: string, opts?: HealOptions): Promise<HealResult> {
  if (!existsSync(profilePath)) return { fixed: [], inUse: false, heldByPid: null };

  const holders = await chromeProcsForDataDirAsync(profilePath, {
    maxAgeMs: opts?.maxProcessTableAgeMs ?? 0,
  });
  if (holders.length > 0) {
    return { fixed: [], inUse: true, heldByPid: (holders[0] as { pid: number }).pid };
  }

  const fixed: string[] = [];

  // 1. The lock files. POSIX only in practice, since Windows Chrome
  //    leaves none, but attempted on every platform because a
  //    profile directory can be copied BETWEEN platforms (this runtime's
  //    own `materialise()` clones templates) and a stale `SingletonLock`
  //    that arrived inside a clone is exactly as confusing as one this
  //    machine wrote.
  for (const name of SINGLETON_LOCK_FILES) {
    const path = join(profilePath, name);
    let present = false;
    try {
      // `lstatSync`, not `existsSync`: `SingletonLock` is a SYMLINK whose
      // target is the string `<hostname>-<pid>` and does not resolve to
      // anything. `existsSync` follows symlinks and answers false for it.
      lstatSync(path);
      present = true;
    } catch {
      present = false;
    }
    if (!present) continue;
    try {
      rmSync(path, { force: true });
      fixed.push(name);
    } catch {
      // Held open, or a permission the launching user does not have.
      // Chrome will make its own attempt; this was the cheap try.
    }
  }

  // 2 to 5. The Preferences repairs. All four in one read/modify/write,
  //    because each extra rewrite of this file is another window for a
  //    reader to see a partial one.
  const prefsPath = join(profilePath, 'Default', 'Preferences');
  if (!existsSync(prefsPath)) return { fixed, inUse: false, heldByPid: null };

  let prefs: Record<string, unknown>;
  try {
    prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    if (prefs === null || typeof prefs !== 'object') throw new Error('not an object');
  } catch {
    // Deliberately NOT repaired by writing a fresh Preferences file. An
    // unparseable Preferences is what `corruption-probe.ts` exists to
    // detect and what `ProfileService` quarantines a profile for; writing
    // a clean one over the top would erase the evidence and hand the
    // caller a profile that looks healthy and has lost every setting and
    // every signed-in state it carried. Report it and stop.
    return { fixed: [...fixed, 'preferences unreadable'], inUse: false, heldByPid: null };
  }

  const section = (key: string): Record<string, unknown> => {
    const existing = prefs[key];
    if (existing !== null && typeof existing === 'object')
      return existing as Record<string, unknown>;
    const fresh: Record<string, unknown> = {};
    prefs[key] = fresh;
    return fresh;
  };

  // 2. The crash marker itself. This is the one that puts up the bubble.
  const profileSection = section('profile');
  if (profileSection['exit_type'] !== 'Normal') fixed.push('exit_type');
  profileSection['exit_type'] = 'Normal';
  profileSection['exited_cleanly'] = true;

  // 3. Session restore. Belt and braces beside the crash marker: even a
  //    profile that closed cleanly reopens its last tabs when
  //    `restore_on_startup` says so, and an automation run that reopens
  //    the previous run's half filled checkout form is worse than one that
  //    opens a blank tab. `startup_urls` is dropped rather than emptied, matching
  //    what Chrome writes when the setting is the new tab page.
  const sessionSection = section('session');
  if (sessionSection['restore_on_startup'] !== RESTORE_ON_STARTUP_NEW_TAB_PAGE)
    fixed.push('restore_on_startup');
  sessionSection['restore_on_startup'] = RESTORE_ON_STARTUP_NEW_TAB_PAGE;
  if ('startup_urls' in sessionSection) {
    // biome-ignore lint/performance/noDelete: the key must be absent from the written Preferences JSON, as Chrome writes it.
    delete sessionSection['startup_urls'];
    fixed.push('startup_urls');
  }

  // 4 and 5. The password and autofill bubbles. A profile that has just
  //    been signed into a site is exactly the profile Chrome offers to
  //    save a password for, and the offer arrives as an overlay anchored
  //    to the omnibox, over the page. There is no launch flag for this on
  //    current Chrome (`--disable-save-password-bubble` was removed), so
  //    the preference is the mechanism. Written to the materialised copy
  //    the runtime owns, never to a template or a seed.
  if (prefs['credentials_enable_service'] !== false) fixed.push('credentials_enable_service');
  prefs['credentials_enable_service'] = false;
  section('password_manager')['saving_enabled'] = false;
  section('autofill')['profile_enabled'] = false;

  // Written through a temporary file and renamed, so a reader never sees
  // half a Preferences. `corruption-probe.ts`'s `preferences_nonzero_length`
  // check exists because a zero length Preferences is a real outcome of a
  // crash between create and write, and a naive truncate-then-write here
  // would manufacture exactly that on every launch.
  const tmpPath = `${prefsPath}.bgls-heal-tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(prefs), 'utf8');
    renameSync(tmpPath, prefsPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Nothing further to try; the original Preferences is untouched,
      // which is the outcome that matters.
    }
    return { fixed: [...fixed, 'preferences unwritable'], inUse: false, heldByPid: null };
  }

  return { fixed, inUse: false, heldByPid: null };
}
