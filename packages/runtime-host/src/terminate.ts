/**
 * The terminate ladder. Seven steps: attempt a CDP clean close,
 * send the graceful signal, wait out the grace period, escalate to force,
 * confirm the process is actually gone, stop the supervisor, then build
 * the result. `mode: 'detach'` skips steps 1 through 5 (nothing is asked
 * of the process at all) and jumps straight to stopping supervision.
 *
 * On Windows, `'graceful'` collapses to `taskkill /T /F` (there is no
 * softer signal `taskkill` can send a GUI-subsystem process tree), so
 * `TerminateResult.effective` reports `'force'` with a warning saying so,
 * never silently escalating.
 *
 * Step 5's confirmation is NOT a check on `pid` alone. The pid this ladder
 * is handed (the one `BrowserRuntime.launch()` resolved and supervises) is
 * not reliably the process that ends up holding the profile directory:
 * Chrome's own Windows launch sequence can hand off from the process this
 * code spawned to a second, distinct process, and when that handoff races
 * `killProcessTree`'s own process-tree snapshot (`taskkill /T` walks the
 * tree ONCE, at the instant it runs), the second process is simply absent
 * from that snapshot. It is never enumerated, never killed, and the moment
 * its parent (`pid`) dies it is reparented to nothing: an orphan, still
 * holding the profile directory open, indistinguishable from a real leak
 * to everything downstream. `pidAlive(pid)` truthfully reports `pid` gone;
 * it has nothing to say about the orphan, so a pid-only confirmation
 * "succeeds" while the browser is still running. This is exactly what
 * turned up under concurrent release load: `ProfileService`'s own
 * independent scan (keyed on the user-data-dir, not a remembered pid) kept
 * finding a live Chrome moments after this ladder reported success.
 *
 * The fix is to make step 5 ask the same question `ProfileService` asks:
 * not "is the pid I launched gone" but "does anything still hold this
 * profile directory". `confirmProfileClear` below re-scans by data dir
 * (the exact scan `chromeProcsForDataDirAsync` performs, uncached via
 * `maxAgeMs: 0` so a kill just issued is reflected immediately), kills
 * whatever it still finds, and repeats until the scan comes back empty or
 * its own budget runs out. Only then is termination confirmed.
 *
 * Every `killProcessTree` call below is awaited. It is `async` precisely
 * so it does not block this whole process's event loop while `taskkill`
 * runs (see its own doc comment): under N concurrent releases, a blocking
 * kill serialised N independent OS-level kills onto one thread, and that
 * queueing alone was long enough to blow through this module's own
 * confirmation budgets even though every individual kill was fast and
 * reliable in isolation. Awaiting the now-async call still means "do not
 * move on until this particular kill attempt has actually run"; it no
 * longer means "freeze everything else while it does".
 */

import { platform } from 'node:os';
import type { TerminateMode, TerminateResult } from '@browserglass/protocol';
import { sendBrowserClose } from './cdp-close.js';
import { type ChromeProcessInfo, chromeProcsForDataDirAsync, pidAlive } from './process-table.js';
import { killProcessTree } from './spawn.js';

/** Options for {@link terminateBrowser}. */
export interface TerminateOptions {
  pid: number;
  cdpWsUrl: string | null;
  mode: TerminateMode;
  cdpCloseTimeoutMs: number;
  gracePeriodMs: number;
  /**
   * The profile directory (`LaunchedBrowser.profilePath`) this browser was
   * launched against, when known. Drives step 5's authoritative
   * confirmation (see this module's own doc); `null` falls back to a
   * plain `pid` liveness check, which is weaker but the best available
   * when no profile directory applies (should not occur for a real
   * launch, only in tests/fixtures that do not set one).
   */
  profilePath: string | null;
  /** Called once, after the process is confirmed gone (or immediately for `'detach'`, which never touches the process). Never called twice. */
  stopSupervision: () => void;
}

async function waitForExit(
  pid: number,
  deadlineAt: number,
  pollIntervalMs = 100,
): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return !pidAlive(pid);
}

/**
 * Total wall-clock budget for step 5's scan-kill-rescan loop.
 *
 * Sized against a real, logged measurement, not the "~1.45 seconds"
 * baseline `process-table.ts` quotes for one scan on an otherwise-idle
 * box. Instrumenting this loop against the actual failure (a genuine
 * orphan: pid 72000, same pid and full command line across two
 * back-to-back scans, `--user-data-dir` pointing at the profile under
 * test, not a foreign process and not a cache artifact, since
 * `chromeProcsForDataDirAsync` here always passes `maxAgeMs: 0`) caught
 * two CONSECUTIVE fresh scans costing 2443ms and then 4433ms under the
 * concurrent Chrome load this machine was actually carrying at the time
 * (91+ chrome-family processes from other agents' own launches). That is
 * 6876ms of scan time alone, more than the old 5000ms budget on its own,
 * before the loop ever got a chance to attempt a SECOND kill of the same
 * straggler. The straggler was in fact killable: a manual check
 * immediately after the run found no trace of it. It just needed a
 * second scan-kill-rescan round that the old budget never let it have.
 *
 * 15000ms gives the loop room for 2 to 3 full rounds even at the
 * worst observed per-scan cost above, while staying well inside the
 * 60000ms per-test budget `runtime.e2e.test.ts` already grants every
 * test that calls `terminate()`.
 */
export const PROFILE_CLEAR_BUDGET_MS = 15_000;
const PROFILE_CLEAR_POLL_MS = 150;

/** What `confirmProfileClear` last observed, for an honest error message when it gives up. `clear: true` carries nothing else to report. */
type ProfileClearResult =
  | { clear: true }
  | { clear: false; lastSeen: readonly ChromeProcessInfo[] };

/**
 * The authoritative "is the browser actually gone" check (see this
 * module's own doc for why a pid-only check is not enough). Repeatedly
 * scans `profilePath` for any surviving chrome-family process, kills
 * whatever it finds, and rescans, until the scan is clean or the budget
 * runs out. `lastSeen` on a `false` result is exactly what the final
 * rescan found, so the caller's error message can say what was actually
 * observed instead of a generic "still holds this profile".
 */
async function confirmProfileClear(
  profilePath: string,
  markEffectiveForce: () => void,
): Promise<ProfileClearResult> {
  const deadline = Date.now() + PROFILE_CLEAR_BUDGET_MS;
  for (;;) {
    const stragglers = await chromeProcsForDataDirAsync(profilePath, { maxAgeMs: 0 });
    if (stragglers.length === 0) return { clear: true };
    if (Date.now() >= deadline) return { clear: false, lastSeen: stragglers };
    // All of them at once, not one at a time: see `killProcessTree`'s own
    // doc on why a blocking, serial kill is exactly what let this survive
    // under load in the first place.
    await Promise.all(stragglers.map((straggler) => killProcessTree(straggler.pid, 'SIGKILL')));
    markEffectiveForce();
    await new Promise((resolve) => setTimeout(resolve, PROFILE_CLEAR_POLL_MS));
  }
}

/**
 * Runs the terminate ladder against one browser process. Idempotent
 * against a process that is already gone: every step treats "already
 * dead" as success, not an error.
 */
export async function terminateBrowser(opts: TerminateOptions): Promise<TerminateResult> {
  const start = Date.now();
  const warnings: string[] = [];
  let effective: TerminateMode = opts.mode;

  if (opts.mode === 'detach') {
    // Steps 1 to 5 skipped entirely: nothing is asked of the process, the
    // supervisor simply stops watching it and it is left running.
    opts.stopSupervision();
    return {
      mode: 'detach',
      effective: 'detach',
      exitCode: null,
      signal: null,
      durationMs: Date.now() - start,
      locksCleared: [],
      warnings: [],
    };
  }

  const isWindows = platform() === 'win32';

  // Step 1: 'clean' attempts a CDP-level Browser.close first, giving
  // Chrome the chance to flush Cookies, Local Storage, and Preferences.
  if (opts.mode === 'clean' && opts.cdpWsUrl) {
    await sendBrowserClose(opts.cdpWsUrl, opts.cdpCloseTimeoutMs);
  }

  // Step 2: send the graceful signal, unless the mode already demands
  // force. On Windows there is no softer signal than taskkill /T /F, so
  // 'graceful' (and 'clean' once its CDP attempt above did not finish the
  // job) collapses straight to force here, and TerminateResult.effective
  // is corrected to say so.
  let exitedAfterSoftStep = !pidAlive(opts.pid);
  if (!exitedAfterSoftStep) {
    if (isWindows) {
      await killProcessTree(opts.pid);
      effective = 'force';
      if (opts.mode !== 'force') {
        warnings.push(
          `requested '${opts.mode}' but Windows has no graceful signal; collapsed to 'force' (taskkill /T /F)`,
        );
      }
    } else if (opts.mode !== 'force') {
      await killProcessTree(opts.pid, 'SIGTERM');
    } else {
      await killProcessTree(opts.pid, 'SIGKILL');
      effective = 'force';
    }
  }

  // Step 3: wait out the grace period, unless force already fired above.
  if (!isWindows && opts.mode !== 'force') {
    exitedAfterSoftStep = await waitForExit(opts.pid, Date.now() + opts.gracePeriodMs);
  } else {
    exitedAfterSoftStep = !pidAlive(opts.pid);
  }

  // Step 4: escalate to force if the process is still alive.
  if (!exitedAfterSoftStep && pidAlive(opts.pid)) {
    await killProcessTree(opts.pid, 'SIGKILL');
    effective = 'force';
  }

  // Step 5: confirm the process is actually gone before considering
  // teardown complete (the profile release path makes the equivalent
  // guarantee). A
  // process that is not confirmed dead here MUST NOT be reported as a
  // successful termination.
  //
  // `opts.profilePath` drives the authoritative check (this module's own
  // doc): rescan-and-kill by user-data-dir until nothing is left, not a
  // liveness check on `opts.pid` alone, since `pid` is not reliably the
  // process that ends up holding that directory. Falls back to the plain
  // pid check only when no profile path applies.
  if (opts.profilePath) {
    const result = await confirmProfileClear(opts.profilePath, () => {
      effective = 'force';
    });
    if (!result.clear) {
      // Honest about what the LAST rescan actually saw (pid, ppid, and the
      // command line that proves it is really this profile's browser-main
      // process, not a bare "still holds" claim with nothing behind it),
      // so a real leak and a budget that simply ran out under load are
      // distinguishable from the error text alone.
      const seen = result.lastSeen
        .map((p) => `pid ${p.pid} (ppid ${p.ppid}): ${p.commandLine}`)
        .join('; ');
      throw new Error(
        `a chrome process still holds profile "${opts.profilePath}" after the '${opts.mode}' terminate ladder completed and its ${PROFILE_CLEAR_BUDGET_MS}ms confirm budget ran out; last scan observed: ${seen}; refusing to report this as a successful termination`,
      );
    }
  } else {
    const confirmedDead = await waitForExit(opts.pid, Date.now() + 5000, 50);
    if (!confirmedDead) {
      throw new Error(
        `pid ${opts.pid} still reports alive after the '${opts.mode}' terminate ladder completed; refusing to report this as a successful termination`,
      );
    }
  }

  // Step 6: stop supervision now that the process is confirmed gone.
  opts.stopSupervision();

  // Step 7: build the result.
  return {
    mode: opts.mode,
    effective,
    exitCode: null,
    signal: null,
    durationMs: Date.now() - start,
    locksCleared: [],
    warnings,
  };
}
