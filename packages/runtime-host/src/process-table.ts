/**
 * Process table scanning. All three POSIX parse guards are load-bearing.
 * Process scanning is the fallback when there is no lease to trust (the
 * lease itself is authoritative); this module never runs on
 * the hot path of a launch onto a cleanly free profile.
 */

import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One Chrome browser-main process found for a given data dir. Never a renderer/GPU/utility child (those all carry `--type=`). */
export interface ChromeProcessInfo {
  pid: number;
  ppid: number;
  commandLine: string;
}

/** Matches `argv0` up to the first ` -` (parse guard 1). Split on ` -`, not whitespace, because an executable path itself can contain spaces (macOS `.app` bundles). */
const EXECUTABLE_NAME_RE = /(chrome|chromium|msedge|brave|headless_shell)[^/\\]*$/i;

function looksLikeChromeExecutable(commandLine: string): boolean {
  const splitIdx = commandLine.indexOf(' -');
  const argv0 = (splitIdx === -1 ? commandLine : commandLine.slice(0, splitIdx)).trim();
  const unquoted = argv0.replace(/^"(.*)"$/, '$1');
  return EXECUTABLE_NAME_RE.test(unquoted);
}

function containsDataDirArg(commandLine: string, dataDir: string): boolean {
  // Guard 2: after `--user-data-dir=<dataDir>`, the next character must be
  // whitespace, a quote, or end of string, so `/path/ws-1` does not match
  // a process whose data dir is actually `/path/ws-12`.
  const needle = '--user-data-dir=';
  let searchFrom = 0;
  for (;;) {
    const idx = commandLine.indexOf(needle, searchFrom);
    if (idx === -1) return false;
    let valueStart = idx + needle.length;
    let quote: string | null = null;
    if (commandLine[valueStart] === '"' || commandLine[valueStart] === "'") {
      quote = commandLine[valueStart] as string;
      valueStart += 1;
    }
    const value = quote
      ? commandLine.slice(valueStart, commandLine.indexOf(quote, valueStart))
      : (() => {
          const spaceIdx = commandLine.indexOf(' ', valueStart);
          return spaceIdx === -1
            ? commandLine.slice(valueStart)
            : commandLine.slice(valueStart, spaceIdx);
        })();
    const normalized = value.replace(/\\$/, '');
    const target = dataDir.replace(/[/\\]+$/, '');
    if (normalized.replace(/[/\\]+$/, '') === target) return true;
    searchFrom = idx + needle.length;
  }
}

function isChildTypeProcess(commandLine: string): boolean {
  // Guard 3: `--type=` anywhere in the command line excludes the process;
  // renderers/GPU/utility all carry it, and killing one kills half a
  // browser or is mistaken for the profile owner.
  return /--type=/.test(commandLine);
}

/** Exposes the three load-bearing per-process guards for direct, OS-independent unit testing. */
export const __guardsForTests = {
  looksLikeChromeExecutable,
  containsDataDirArg,
  isChildTypeProcess,
};

/**
 * The executable basenames {@link EXECUTABLE_NAME_RE} is written to
 * recognise, spelled out so a test can hold the Windows process-name
 * filter to the same list. Kept beside the regex it mirrors: the two
 * drifting apart is not hypothetical, it is the bug this exists to stop
 * recurring.
 */
export const __recognisedExecutableNamesForTests = [
  'chrome.exe',
  'chromium.exe',
  'msedge.exe',
  'brave.exe',
  'headless_shell.exe',
] as const;

function parsePosixPsOutput(output: string): ChromeProcessInfo[] {
  const results: ChromeProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const commandLine = match[3] as string;
    results.push({ pid, ppid, commandLine });
  }
  return results;
}

/** Parses `ps -axo pid=,ppid=,command=` output, exported for fixture-based unit tests (real `ps` output recorded from a Linux/macOS box). */
export function __parsePosixPsOutputForTests(output: string): ChromeProcessInfo[] {
  return parsePosixPsOutput(output);
}

function listAllPosix(): ChromeProcessInfo[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePosixPsOutput(out);
}

interface WindowsCimRow {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine: string | null;
}

function parseWindowsCimJson(json: string): ChromeProcessInfo[] {
  if (!json.trim()) return [];
  const parsed: unknown = JSON.parse(json);
  const rows: WindowsCimRow[] = Array.isArray(parsed)
    ? (parsed as WindowsCimRow[])
    : [parsed as WindowsCimRow];
  return rows
    .filter((r) => r.CommandLine)
    .map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      commandLine: r.CommandLine as string,
    }));
}

/** Parses the JSON `Get-CimInstance Win32_Process | ConvertTo-Json` shape, exported for fixture-based unit tests. */
export function __parseWindowsCimJsonForTests(json: string): ChromeProcessInfo[] {
  return parseWindowsCimJson(json);
}

/**
 * The WQL `-Filter` the Windows scan runs with.
 *
 * Filtering in the CIM provider rather than piping every process on the
 * machine through a `Where-Object` matters twice over. It is less work,
 * and more importantly it is BOUNDED work: the old form materialised all
 * ~400 `Win32_Process` instances (each `CommandLine` a separate provider
 * read) before discarding 99% of them, which is what pushed a scan past
 * its own timeout on a loaded machine and, because the throw propagated,
 * took the whole gateway's startup down with it.
 *
 * `%chrom%`, not `%chrome%`. "chromium" does not contain "chrome"
 * (c-h-r-o-m-i-u-m), so the previous pattern silently never matched
 * `chromium.exe` at all, and `headless_shell.exe` was not listed on any
 * pattern. Both are named in {@link EXECUTABLE_NAME_RE} as executables
 * this module is supposed to recognise, so on Windows every consumer of
 * this scan (orphan reaping, the profile lock check, `resolveBrowserPid`)
 * was blind to two of the five supported binaries.
 */
const WINDOWS_PROCESS_NAME_FILTER =
  "Name LIKE '%chrom%' OR Name LIKE '%msedge%' OR Name LIKE '%brave%' OR Name LIKE '%headless_shell%'";

/** The WQL filter above, for the test that holds it to {@link __recognisedExecutableNamesForTests}. */
export const __windowsProcessNameFilterForTests = (): string => WINDOWS_PROCESS_NAME_FILTER;

const WINDOWS_SCAN_SCRIPT = `Get-CimInstance Win32_Process -Filter "${WINDOWS_PROCESS_NAME_FILTER}" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`;

/**
 * How long a scan may take before it is abandoned.
 *
 * Generous on purpose. The scan is no longer on the event loop (see
 * {@link listAllChromeFamilyProcessesAsync}), so a slow one costs latency
 * on one call rather than freezing every socket in the process, and the
 * failure mode this replaces was a scan being killed at 8s on a machine
 * that was merely busy.
 */
const SCAN_TIMEOUT_MS = 30_000;

const SCAN_EXEC_OPTIONS = {
  encoding: 'utf8',
  timeout: SCAN_TIMEOUT_MS,
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
} as const;

const WINDOWS_SCAN_ARGV = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCAN_SCRIPT];
const POSIX_SCAN_ARGV = ['-axo', 'pid=,ppid=,command='];

function listAllWindows(): ChromeProcessInfo[] {
  return parseWindowsCimJson(execFileSync('powershell.exe', WINDOWS_SCAN_ARGV, SCAN_EXEC_OPTIONS));
}

/**
 * A point-in-time answer from the process table, and how old it is.
 *
 * `at` is the moment the scan STARTED, never the moment it finished. A
 * scan that takes a second describes a machine that is at least a second
 * stale by the time it returns, and dating it from its start is the only
 * reading that cannot claim to know something newer than it does.
 */
interface Snapshot {
  at: number;
  procs: ChromeProcessInfo[];
}

let snapshot: Snapshot | null = null;
let inFlight: Promise<ChromeProcessInfo[]> | null = null;
let lastScanError: Error | null = null;

/**
 * How long a {@link Snapshot} may be reused before a caller that did not
 * ask for anything fresher triggers a new scan.
 *
 * Sized against what a scan costs, not against how fast the process table
 * changes. A real measurement on a Windows machine running 410 processes
 * put one scan at ~1.45 seconds, so a TTL materially below that would
 * spend the majority of a burst re-answering a question whose answer had
 * not finished arriving the first time. The startup reconcile is the
 * shape that motivated this: it scans once per profile directory, and on
 * a checkout with 54 of them that was 54 separate PowerShell processes
 * and well over a minute of wall clock to answer one question 54 times.
 */
export const PROCESS_TABLE_SNAPSHOT_TTL_MS = 1000;

function runScanAsync(): Promise<ChromeProcessInfo[]> {
  return platform() === 'win32'
    ? execFileAsync('powershell.exe', WINDOWS_SCAN_ARGV, SCAN_EXEC_OPTIONS).then((r) =>
        parseWindowsCimJson(r.stdout),
      )
    : execFileAsync('ps', POSIX_SCAN_ARGV, SCAN_EXEC_OPTIONS).then((r) =>
        parsePosixPsOutput(r.stdout),
      );
}

/**
 * The last error a scan failed with, or `null` if the last scan
 * succeeded. Exposed so a caller that cares (a doctor command, a
 * diagnostic report) can tell "no Chrome is running" apart from "the
 * question could not be asked", which the empty array deliberately does
 * not distinguish.
 */
export function lastProcessTableScanError(): Error | null {
  return lastScanError;
}

/** Drops the cached snapshot. For tests, and for a caller that has just killed something and wants the next read to see the machine as it now is. */
export function invalidateProcessTableSnapshot(): void {
  snapshot = null;
}

/**
 * Scans the process table without blocking the event loop, reusing a
 * recent answer and coalescing concurrent callers onto one scan.
 *
 * This is the function every production path should call. The synchronous
 * {@link listAllChromeFamilyProcesses} spawns a child process and waits
 * for it with the event loop stopped, which on Windows measured ~1.45
 * seconds per call. That is survivable for a one-off CLI command and
 * ruinous everywhere else: `resolveBrowserPid` polls this every 100ms on
 * EVERY launch, so each browser start froze the entire gateway, in
 * repeated 1.45 second blocks, for as long as Chrome took to appear. With
 * several launches in flight the freezes serialise and compound, and
 * every screencast frame, input event, and lease message for every OTHER
 * session in the process waits behind them. "Several browsers cannot be
 * driven at once" was, in large part, this.
 *
 * Errors are swallowed to an empty array on purpose. Every caller is
 * asking a best-effort question (is anything already holding this profile
 * directory? is there an orphan to reap?) whose honest answer when the
 * process table cannot be read is "nothing found", and the previous
 * behaviour of throwing turned a slow scan during startup reconcile into
 * a gateway that refused to boot at all. {@link lastProcessTableScanError}
 * is there for callers that need to tell the two apart.
 *
 * @param maxAgeMs Reuse a snapshot no older than this. `0` forces a scan
 * that started after this call did.
 */
export async function listAllChromeFamilyProcessesAsync(opts?: { maxAgeMs?: number }): Promise<
  ChromeProcessInfo[]
> {
  const maxAgeMs = opts?.maxAgeMs ?? PROCESS_TABLE_SNAPSHOT_TTL_MS;
  const requiredSince = Date.now() - maxAgeMs;
  if (snapshot !== null && snapshot.at >= requiredSince) return snapshot.procs;
  // A scan already running is JOINED rather than raced, even under
  // `maxAgeMs: 0`, and that is a deliberate trade rather than an
  // oversight. Two callers arriving in the same tick compute
  // `requiredSince` values a millisecond apart, so a rule of "only join a
  // scan that started at or after I asked" would have the second one
  // start a redundant scan of a machine the first is already reading:
  // exactly the stampede this cache exists to prevent, and worst in the
  // case that matters most, several browsers launching at once.
  //
  // What a joiner gives up is bounded and, for every caller that passes
  // `maxAgeMs: 0`, already handled. `resolveBrowserPid` is the only hot
  // one, and it polls to a deadline: a first answer that predates its
  // spawn by a few hundred milliseconds costs it one more turn of a loop
  // it was going to take anyway. A caller genuinely needing a scan that
  // cannot predate its request calls `invalidateProcessTableSnapshot()`
  // and accepts the full cost.
  if (inFlight !== null) return inFlight;
  {
    const startedAt = Date.now();
    inFlight = runScanAsync()
      .then((procs) => {
        snapshot = { at: startedAt, procs };
        lastScanError = null;
        return procs;
      })
      .catch((err: unknown) => {
        lastScanError = err instanceof Error ? err : new Error(String(err));
        // Cache the failure too, so a machine whose process table
        // cannot be read does not respawn a doomed child process on
        // every one of a burst of callers.
        snapshot = { at: startedAt, procs: [] };
        return [] as ChromeProcessInfo[];
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }
}

/** Every Chrome-family process visible on this machine, every process type included (used by the singleton/orphan classifier, which needs `--type=` entries too for completeness of the picture even though it never targets them directly). Prefer {@link listAllChromeFamilyProcessesAsync} anywhere inside the gateway: this one stops the event loop for the length of the scan. */
export function listAllChromeFamilyProcesses(): ChromeProcessInfo[] {
  const startedAt = Date.now();
  try {
    const procs = platform() === 'win32' ? listAllWindows() : listAllPosix();
    snapshot = { at: startedAt, procs };
    lastScanError = null;
    return procs;
  } catch (err) {
    lastScanError = err instanceof Error ? err : new Error(String(err));
    snapshot = { at: startedAt, procs: [] };
    return [];
  }
}

/**
 * Every Chrome **browser-main** process (never a renderer/GPU/utility
 * child) whose command line names `--user-data-dir=<dataDir>` exactly,
 * per the three load-bearing POSIX parse guards.
 */
export function chromeProcsForDataDir(dataDir: string): ChromeProcessInfo[] {
  return filterForDataDir(listAllChromeFamilyProcesses(), dataDir);
}

/** The three per-process guards, applied to an already-taken snapshot. Split out so a caller holding one snapshot can answer for many data dirs without rescanning: that is the whole of what made the startup reconcile take a minute. */
export function filterForDataDir(
  procs: readonly ChromeProcessInfo[],
  dataDir: string,
): ChromeProcessInfo[] {
  return procs.filter(
    (p) =>
      looksLikeChromeExecutable(p.commandLine) &&
      !isChildTypeProcess(p.commandLine) &&
      containsDataDirArg(p.commandLine, dataDir),
  );
}

/**
 * {@link chromeProcsForDataDir} without stopping the event loop. Prefer
 * this everywhere inside the gateway; see
 * {@link listAllChromeFamilyProcessesAsync} for why it matters.
 */
export async function chromeProcsForDataDirAsync(
  dataDir: string,
  opts?: { maxAgeMs?: number },
): Promise<ChromeProcessInfo[]> {
  return filterForDataDir(await listAllChromeFamilyProcessesAsync(opts), dataDir);
}

/** Best-effort liveness check: `true` when a process with this pid exists, regardless of owner. `EPERM` (exists, owned by someone else) counts as alive, the usual `kill(pid, 0)` convention. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How one Chrome process found for a profile's data dir was classified. */
export type ProcessClassification = 'self' | 'ownedByUs' | 'launching' | 'foreign' | 'orphan';

/**
 * Classifies one process against the four skip rules, in order. `proc.ppid ===
 * process.pid` is the NORMAL state of a healthy browser this process is
 * driving; treating it as an orphan is a real historical bug this
 * classifier exists to avoid repeating.
 */
export function classifyChromeProcess(
  proc: ChromeProcessInfo,
  opts: { currentlyLaunchingPids: ReadonlySet<number> },
): ProcessClassification {
  if (proc.pid === process.pid) return 'self';
  if (proc.ppid === process.pid) return 'ownedByUs';
  if (opts.currentlyLaunchingPids.has(proc.pid)) return 'launching';
  if (proc.ppid > 1 && pidAlive(proc.ppid) && proc.ppid !== process.pid) return 'foreign';
  return 'orphan';
}

// ── Singleton lock handling ────────────────────────────────────────────

/**
 * Reads the pid encoded in a POSIX `SingletonLock` symlink target
 * (`<hostname>-<pid>`). Returns `null` when the file is absent or is not
 * a symlink in the expected shape. Windows has no equivalent artifact
 * (Chrome there uses a named mutex plus a message-only window instead);
 * callers on Windows should rely on {@link chromeProcsForDataDir}.
 */
export function readSingletonLockPid(profileDir: string): number | null {
  if (platform() === 'win32') return null;
  const path = `${profileDir}/SingletonLock`;
  try {
    const st = lstatSync(path);
    if (!st.isSymbolicLink()) return null;
    const target = readlinkSync(path);
    const match = /-(\d+)$/.exec(target);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** The POSIX singleton artifact filenames, always removed together. */
export const SINGLETON_LOCK_FILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
] as const;
