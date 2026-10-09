/**
 * Detached spawn and whole-tree kill. A non-detached child shares the parent's process group and
 * dies with it, the opposite of what supervision needs; always spawn
 * detached, on every platform, and always kill the whole tree, never a
 * bare pid.
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { chromeProcsForDataDirAsync } from './process-table.js';

const execFileAsync = promisify(execFile);

/** Options for {@link spawnDetachedChrome}. */
export interface SpawnDetachedOptions {
  binaryPath: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Bounded stderr capture; the supervisor keeps only the trailing ring buffer of this. */
  onStderr?: (chunk: string) => void;
}

/** The live handle {@link spawnDetachedChrome} returns. */
export interface SpawnedChrome {
  /** The pid Node's own `spawn()` returned. On Windows this is frequently NOT the long-lived browser process, see {@link resolveBrowserPid}. */
  spawnPid: number;
  child: ChildProcess;
}

/**
 * Spawns Chrome detached on every platform, with `stdio: ['ignore', 'ignore', 'pipe']`
 * so stderr can feed the supervisor's ring buffer while stdout is
 * discarded (Chrome does not use stdout for anything BrowserGlass reads).
 * `detached: true` gives the child its own process group on POSIX, which
 * is what makes `process.kill(-pgid, sig)` reach the whole tree later.
 */
export function spawnDetachedChrome(opts: SpawnDetachedOptions): SpawnedChrome {
  const child = spawn(opts.binaryPath, opts.args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...opts.env },
  });
  child.unref();
  if (opts.onStderr) {
    child.stderr?.on('data', (chunk: Buffer) => opts.onStderr?.(chunk.toString('utf8')));
  }
  return { spawnPid: child.pid ?? -1, child };
}

/**
 * Resolves the actual, long-lived Chrome browser-main process id for
 * `profilePath`, polling the process table until it appears or
 * `deadlineAt` passes.
 *
 * On Windows this is NOT the same as `spawnPid`: empirically, invoking
 * `chrome.exe` (with any arguments) causes the initially spawned process
 * to hand off to a new browser-main process and exit almost immediately,
 * even though `detached: true` was set; the new process's own parent pid
 * is the vanished original, not this Node process. Recording `spawnPid`
 * as `LaunchedBrowser.pid` would then name a pid that no longer exists by
 * the time anything tries to supervise or kill it. Resolving the real pid
 * from the process table (matching `--user-data-dir=<profilePath>`,
 * excluding `--type=`, exactly as the orphan scanner already does) is
 * required on Windows, and is a safe no-op fast path on POSIX where
 * `spawnPid` already is the right pid, since it will simply resolve to
 * that same process.
 *
 * This same handoff can recur at TERMINATE time, not only at launch: see
 * `terminate.ts`'s own module doc for the concurrent-release evidence
 * (a second, distinct pid found still holding the profile directory,
 * parented to the very pid this function resolved and {@link killProcessTree}
 * was asked to kill) and `confirmProfileClear`, the rescan-and-kill loop
 * that makes termination robust to it happening again after this
 * resolution already ran once.
 */
export async function resolveBrowserPid(
  profilePath: string,
  deadlineAt: number,
  pollIntervalMs = 100,
): Promise<number> {
  for (;;) {
    // `maxAgeMs: 0`, so a poll never answers from a snapshot taken before
    // this launch started and reports the pid of nothing. Coalescing still
    // applies: several launches polling at once share one scan rather than
    // each spawning their own.
    //
    // The async scan is what makes this loop safe to run at all. It used
    // to call the synchronous `chromeProcsForDataDir`, which on Windows
    // measured ~1.45 seconds with the event loop stopped for every one of
    // them, on a 100ms poll, on EVERY launch. A single browser start
    // therefore froze the whole gateway in repeated 1.45 second blocks
    // until Chrome appeared, and concurrent starts stacked those freezes
    // end to end while every other session's frames and input waited.
    const found = await chromeProcsForDataDirAsync(profilePath, { maxAgeMs: 0 });
    if (found.length > 0) return (found[0] as { pid: number }).pid;
    if (Date.now() >= deadlineAt) {
      throw new Error(
        `no chrome browser-main process found for profile ${profilePath} before the deadline`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Kills the whole process tree rooted at `pid`: `process.kill(-pgid, sig)`
 * on POSIX (the negative pid targets the whole process group `detached:
 * true` created), `taskkill /T /F /PID <pid>` on Windows. Killing a bare
 * pid leaves orphaned renderers behind; this function is the only place
 * permitted to terminate a browser's OS processes. Empirically verified
 * on Windows to reach the whole tree even when `pid`'s own parent process
 * has already exited (the common case here, see {@link resolveBrowserPid}).
 * Never throws when the target is already gone.
 *
 * `async`, using `execFile` rather than `execFileSync`: the synchronous
 * form used to stop THIS WHOLE PROCESS's event loop for as long as
 * `taskkill` took to run. Under N concurrent releases that serialised N
 * independent, OS-level kills onto a single thread, one after another,
 * so a `taskkill` that would finish in milliseconds run on its own could
 * miss its own 5 second timeout simply because several other `taskkill`
 * calls were blocking the thread ahead of it, and every other in-flight
 * async check (`confirmProfileClear`'s own rescans, other releases'
 * progress) was frozen for the same stretch. That is exactly the shape of
 * the concurrent-release leak this file's own callers exist to fix: each
 * kill was individually reliable, and the serialisation between them was
 * not. Making this non-blocking lets N real, OS-scheduled `taskkill`
 * child processes actually run concurrently instead of queueing behind
 * each other on this process's one thread.
 */
export async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  if (platform() === 'win32') {
    try {
      // No `stdio: 'ignore'` needed here the way the old `execFileSync`
      // call required it: `execFile`'s promisified form does not inherit
      // this process's stdio at all, it captures stdout/stderr into the
      // resolved/rejected result, which is simply discarded below. A
      // target that already exited (a real, harmless race between this
      // check and taskkill's own lookup) makes taskkill exit non-zero,
      // which is not worth surfacing since the catch below already
      // treats it as success.
      await execFileAsync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // Already gone, or taskkill could not find it; both are fine here.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}
