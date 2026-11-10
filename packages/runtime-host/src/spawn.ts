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
    // Never `taskkill /T`: it walks parent ids, and Windows reuses ids. A
    // process keeps the id of a parent that ended, so an id read a moment ago
    // (or a stale one) can pull an unrelated tree into the kill: a terminal
    // multiplexer and every shell under it. Walk the table ourselves and count
    // a child only when it was created after its parent.
    for (const p of await windowsTreeOf(pid)) {
      try {
        process.kill(p);
      } catch {
        // Already gone.
      }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    // macOS answers EPERM, not ESRCH, when every process left in the group
    // has already exited and is only waiting to be reaped: a zombie has no
    // credentials left to check a signal against. The terminate ladder hits
    // this routinely, sending SIGKILL a second time to a group the first
    // SIGKILL already finished off. A real permission failure leaves a
    // live member in the group, so that one still throws.
    if (code === 'EPERM' && !(await processGroupHasLiveMember(pid))) return;
    throw err;
  }
}

/** How long {@link processGroupHasLiveMember} waits for a dying group to finish exiting before calling a member live. */
const GROUP_EXIT_SETTLE_MS = 1000;

/**
 * `true` when process group `pgid` still holds a member that is not a
 * zombie. Polls briefly, since a member that was SIGKILLed a moment ago can
 * still be mid exit when the EPERM arrives. A `ps` that cannot run at all
 * answers `true`, so the caller rethrows rather than guessing the group is
 * gone.
 */
async function processGroupHasLiveMember(pgid: number): Promise<boolean> {
  const deadline = Date.now() + GROUP_EXIT_SETTLE_MS;
  for (;;) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('ps', ['-axo', 'pgid=,stat='], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch {
      return true;
    }
    const live = stdout.split('\n').some((line) => {
      const match = /^\s*(\d+)\s+(\S+)/.exec(line);
      return match !== null && Number(match[1]) === pgid && !match[2]?.startsWith('Z');
    });
    if (!live || Date.now() >= deadline) return live;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * `pid` and the processes it started, leaves first, from one snapshot of the
 * process table. A child counts only when its creation time is not earlier
 * than its parent's (one second of slack), so an orphan whose dead parent had
 * the same id, and everything under it, is left out. This process and its
 * parents are never in the list.
 */
async function windowsTreeOf(pid: number): Promise<number[]> {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = [long](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) }; \"$($_.ProcessId),$($_.ParentProcessId),$c\" }";
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return [];
  }
  const rows = new Map<number, { ppid: number; created: number }>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d+)$/.exec(line.trim());
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), created: Number(m[3]) });
  }
  if (!rows.has(pid)) return [];
  const mine = new Set<number>([process.pid]);
  for (let cur = rows.get(process.pid); cur && !mine.has(cur.ppid) && rows.has(cur.ppid); cur = rows.get(cur.ppid)) mine.add(cur.ppid);
  if (mine.has(pid)) return [];
  const kids = new Map<number, number[]>();
  for (const [p, r] of rows) if (p !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), p]);
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    const parent = rows.get(out[i]!)!;
    for (const c of kids.get(out[i]!) ?? []) {
      const child = rows.get(c)!;
      if (out.includes(c) || mine.has(c)) continue;
      if (parent.created && child.created && child.created + 1000 < parent.created) continue;
      out.push(c);
    }
  }
  return out.reverse();
}
