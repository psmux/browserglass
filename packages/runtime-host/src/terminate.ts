/**
 * The terminate ladder. Seven steps: ask Chrome to close itself over CDP
 * (every mode but 'force'), send the graceful signal, wait out the grace
 * period, escalate to force, confirm the process is actually gone, stop
 * the supervisor, then build the result. `mode: 'detach'` skips steps 1 through 5 (nothing is asked
 * of the process at all) and jumps straight to stopping supervision.
 *
 * On Windows, a `'graceful'` that step 1 did not finish collapses to
 * `taskkill /T /F` (there is no softer signal `taskkill` can send a
 * GUI-subsystem process tree), so `TerminateResult.effective` reports
 * `'force'` with a warning saying so, never silently escalating.
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

/** Kept back from the caller's grace period so the soft close finishes before a caller side escalation to 'force' fires. */
const SOFT_CLOSE_MARGIN_MS = 500;

/**
 * How long step 1 may spend on `Browser.close` plus waiting for Chrome to
 * exit: the configured CDP close timeout, capped at the grace period less
 * {@link SOFT_CLOSE_MARGIN_MS}. Zero (skip step 1) when the grace period
 * leaves no room for it.
 */
export function softCloseBudgetMs(cdpCloseTimeoutMs: number, gracePeriodMs: number): number {
  return Math.max(0, Math.min(cdpCloseTimeoutMs, gracePeriodMs - SOFT_CLOSE_MARGIN_MS));
}

/**
 * Waits, until `deadlineAt`, for a browser asked to close to actually be
 * gone. The launched `pid` going away is the cheap signal; when it has, and
 * a profile directory is known, one scan by that directory confirms
 * nothing else still holds it (on Windows the process holding the profile
 * is not always `pid`, see this module's own doc). Never kills anything:
 * whatever is still running at the deadline is left to the steps below.
 */
async function waitForBrowserGone(
  pid: number,
  profilePath: string | null,
  deadlineAt: number,
): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    if (!pidAlive(pid)) {
      if (profilePath === null) return true;
      const holders = await chromeProcsForDataDirAsync(profilePath, { maxAgeMs: 0 });
      if (holders.length === 0) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
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

/**
 * The longest step 5 may run, however slow the scans get. The base budget
 * above is a soft deadline: the loop runs past it until it has made
 * {@link PROFILE_CLEAR_MIN_KILL_ROUNDS} kill rounds, and for as long as the
 * rounds are still making progress, but never past this.
 */
export const PROFILE_CLEAR_HARD_CAP_MS = 60_000;

/**
 * Kill rounds step 5 always gets before it may give up on the soft
 * deadline. A release under load used to fail with only one or two kill
 * attempts behind it, because two slow scans (5 s each was seen) used up
 * the whole 15 s budget. The hard cap still bounds the total.
 */
export const PROFILE_CLEAR_MIN_KILL_ROUNDS = 3;
const PROFILE_CLEAR_POLL_MS = 150;

/** What `confirmProfileClear` last observed, for an honest error message when it gives up. `clear: true` carries nothing else to report. */
export type ProfileClearResult =
  | { clear: true; rounds: number; elapsedMs: number }
  | {
      clear: false;
      lastSeen: readonly ChromeProcessInfo[];
      rounds: number;
      elapsedMs: number;
    };

/**
 * The process table and clock `confirmProfileClear` works against. The
 * defaults are the real ones; tests pass a fake process table whose scans
 * take a scripted amount of virtual time.
 */
export interface ProfileClearDeps {
  scan: (profilePath: string) => Promise<readonly ChromeProcessInfo[]>;
  kill: (pid: number) => Promise<void>;
  pidAlive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  budgetMs: number;
  hardCapMs: number;
  minKillRounds: number;
}

const realProfileClearDeps: ProfileClearDeps = {
  scan: (profilePath) => chromeProcsForDataDirAsync(profilePath, { maxAgeMs: 0 }),
  kill: async (pid) => {
    await killProcessTree(pid, 'SIGKILL');
  },
  pidAlive: (pid) => pidAlive(pid),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  budgetMs: PROFILE_CLEAR_BUDGET_MS,
  hardCapMs: PROFILE_CLEAR_HARD_CAP_MS,
  minKillRounds: PROFILE_CLEAR_MIN_KILL_ROUNDS,
};

/**
 * The authoritative "is the browser actually gone" check (see this
 * module's own doc for why a pid-only check is not enough). Repeatedly
 * scans `profilePath` for any surviving chrome-family process, kills
 * whatever it finds, and rescans, until the scan is clean or the budget
 * runs out. `lastSeen` on a `false` result is exactly what the final
 * rescan found, so the caller's error message can say what was actually
 * observed instead of a generic "still holds this profile".
 *
 * The budget is measured against how long the scans really take. A full
 * scan of the process table costs about 1.5 s on an idle Windows box and
 * was seen at 5 s under load, so a fixed 15 s window could hold as few as
 * two rounds, and a release then failed with Chrome still on its way out.
 * Three rules keep that from happening without letting a real leak run
 * forever:
 *
 * 1. A scan result is cross checked against `pidAlive` before anything is
 *    concluded from it. A slow scan reports the table as it was when the
 *    scan started; a process that died while it ran is not a straggler.
 *    When every reported pid is already gone, the loop rescans instead of
 *    killing or giving up.
 * 2. The loop gives up on the soft deadline only after `minKillRounds`
 *    kill rounds, however much of the budget the scans themselves ate.
 * 3. The soft deadline is pushed out whenever a round makes progress (the
 *    set of live stragglers changed), since a profile still changing hands
 *    is a teardown still under way. `hardCapMs` bounds everything.
 */
export async function confirmProfileClear(
  profilePath: string,
  markEffectiveForce: () => void,
  deps: ProfileClearDeps = realProfileClearDeps,
): Promise<ProfileClearResult> {
  const start = deps.now();
  const hardCap = start + deps.hardCapMs;
  let softDeadline = start + deps.budgetMs;
  let rounds = 0;
  let previous: Set<number> | null = null;
  for (;;) {
    const scanned = await deps.scan(profilePath);
    const stragglers = scanned.filter((p) => deps.pidAlive(p.pid));
    const now = deps.now();
    if (stragglers.length === 0) {
      // Either nothing was reported, or everything reported died while the
      // scan ran. An empty scan is proof; the second case needs one more
      // scan to be sure nothing new took over the profile in the meantime.
      if (scanned.length === 0) return { clear: true, rounds, elapsedMs: now - start };
      if (now >= hardCap)
        return { clear: false, lastSeen: scanned, rounds, elapsedMs: now - start };
      await deps.sleep(PROFILE_CLEAR_POLL_MS);
      continue;
    }

    const current = new Set(stragglers.map((p) => p.pid));
    const progressed =
      previous !== null &&
      (current.size < previous.size || [...current].some((pid) => !previous?.has(pid)));
    previous = current;
    if (progressed) softDeadline = Math.max(softDeadline, now + deps.budgetMs / 2);
    softDeadline = Math.min(softDeadline, hardCap);

    const outOfTime = now >= hardCap || (now >= softDeadline && rounds >= deps.minKillRounds);
    if (outOfTime) return { clear: false, lastSeen: stragglers, rounds, elapsedMs: now - start };
    // All of them at once, not one at a time: see `killProcessTree`'s own
    // doc on why a blocking, serial kill is exactly what let this survive
    // under load in the first place.
    await Promise.all(stragglers.map((straggler) => deps.kill(straggler.pid)));
    rounds += 1;
    markEffectiveForce();
    await deps.sleep(PROFILE_CLEAR_POLL_MS);
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

  // Step 1: every mode short of 'force' first asks Chrome to close itself
  // over CDP (`Browser.close`) and gives it a moment to exit. A controlled
  // shutdown is the only one in which Chrome writes its cookie store, Local
  // Storage and Preferences: it batches cookie writes about every 30
  // seconds, and the kill steps below skip the final batch. This used to
  // run for 'clean' only, and even there step 2 followed the
  // acknowledgement straight away, so on Windows `taskkill` landed while
  // Chrome was still writing. A persistent profile released within 30
  // seconds of a login lost the login.
  //
  // The wait is bounded by `softCloseBudgetMs`, which stays inside the
  // caller's grace period: `BrowserRouter.release()` escalates to a second,
  // 'force' terminate when `gracePeriodMs` passes with no answer, and that
  // force call must not overtake a Chrome that is busy closing itself.
  if (opts.mode !== 'force' && opts.cdpWsUrl) {
    const budgetMs = softCloseBudgetMs(opts.cdpCloseTimeoutMs, opts.gracePeriodMs);
    if (budgetMs > 0) {
      const softDeadline = Date.now() + budgetMs;
      await sendBrowserClose(opts.cdpWsUrl, budgetMs);
      await waitForBrowserGone(opts.pid, opts.profilePath, softDeadline);
    }
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
        `a chrome process still holds profile "${opts.profilePath}" after the '${opts.mode}' terminate ladder completed and its confirm loop gave up after ${result.rounds} kill rounds in ${result.elapsedMs}ms; last scan observed: ${seen}; refusing to report this as a successful termination`,
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
