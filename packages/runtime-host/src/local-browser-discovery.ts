/**
 * Discovery of a Chrome-family browser this process did NOT launch: the
 * user's own daily-driver profile, opened by hand, the way a person
 * actually uses their machine. Mirrors `binary-discovery.ts`'s per-platform
 * candidate table, applied to `--user-data-dir` locations instead of
 * binaries, and reuses `identity-probe.ts`'s `probeCdpIdentity` for the
 * same reason `cdp-endpoint.ts` does: readiness is never "a file exists",
 * it is "the endpoint answered and identified itself as a real browser".
 *
 * The reference for this whole module is browser-harness's `daemon.py`
 * (`profile_dirs`, `get_ws_url`, `remote_debugging_user_enabled`). Two of
 * its hard-won lessons carry over directly:
 *
 * 1. A `DevToolsActivePort` file is never trusted on its own. A stale file
 *    left behind by a browser that has since exited names a port nothing
 *    answers on; `probeLocalBrowserCandidate` always makes a live HTTP
 *    round trip to that exact port before treating the file as meaning
 *    anything (`cdp-endpoint.ts`'s own header describes the same race for
 *    a browser this node spawned itself).
 * 2. `GET /json/version` returning 403 means Chrome is up and reachable,
 *    but the human has not yet clicked the per-connection "Allow remote
 *    debugging" popup. That is a completely different situation from
 *    nothing listening at all, and callers need an error that tells them
 *    (or the agent driving them) exactly what to do about it, not a
 *    generic connection failure.
 *
 * Not wired into `HostRuntime`: `HostRuntime.attach()`
 * (`recovered.profilePath` + `endpoint.url`) already accepts the shape
 * {@link discoverLocalBrowser} produces, so a caller composes the two
 * itself rather than this module reaching into `runtime.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { CdpProbeTimeoutError, probeCdpIdentity } from './identity-probe.js';
import { chromeProcsForDataDirAsync } from './process-table.js';

/** One vendor/channel candidate this module knows how to look for. Not `@browserglass/protocol`'s `BrowserChannel`: several entries here (Canary, Dev, Beta, SxS) have no slot in that narrower launch-time enum. */
export interface LocalBrowserProfileEntry {
  label: string;
  userDataDir: string;
}

function table(
  base: string,
  entries: readonly (readonly [string, string])[],
): LocalBrowserProfileEntry[] {
  return entries.map(([label, rel]) => ({ label, userDataDir: join(base, ...rel.split('/')) }));
}

/** `%LOCALAPPDATA%`-relative, Windows Chromium-family install layout. */
function windowsProfileTable(localAppData: string): LocalBrowserProfileEntry[] {
  return table(localAppData, [
    ['chrome', 'Google/Chrome/User Data'],
    ['chrome-canary', 'Google/Chrome SxS/User Data'],
    ['chrome-beta', 'Google/Chrome Beta/User Data'],
    ['chrome-dev', 'Google/Chrome Dev/User Data'],
    ['chromium', 'Chromium/User Data'],
    ['msedge', 'Microsoft/Edge/User Data'],
    ['msedge-beta', 'Microsoft/Edge Beta/User Data'],
    ['msedge-dev', 'Microsoft/Edge Dev/User Data'],
    ['msedge-canary', 'Microsoft/Edge SxS/User Data'],
    ['brave', 'BraveSoftware/Brave-Browser/User Data'],
  ]);
}

/** `$HOME`-relative, macOS Chromium-family install layout. */
function macProfileTable(home: string): LocalBrowserProfileEntry[] {
  return table(home, [
    ['chrome', 'Library/Application Support/Google/Chrome'],
    ['chrome-canary', 'Library/Application Support/Google/Chrome Canary'],
    ['msedge', 'Library/Application Support/Microsoft Edge'],
    ['msedge-beta', 'Library/Application Support/Microsoft Edge Beta'],
    ['msedge-dev', 'Library/Application Support/Microsoft Edge Dev'],
    ['msedge-canary', 'Library/Application Support/Microsoft Edge Canary'],
    ['brave', 'Library/Application Support/BraveSoftware/Brave-Browser'],
  ]);
}

/** `$HOME`-relative, Linux Chromium-family install layout, including Flatpak sandboxed data dirs. */
function linuxProfileTable(home: string): LocalBrowserProfileEntry[] {
  return table(home, [
    ['chrome', '.config/google-chrome'],
    ['chromium', '.config/chromium'],
    ['chromium', '.config/chromium-browser'],
    ['msedge', '.config/microsoft-edge'],
    ['msedge-beta', '.config/microsoft-edge-beta'],
    ['msedge-dev', '.config/microsoft-edge-dev'],
    ['chromium', '.var/app/org.chromium.Chromium/config/chromium'],
    ['chrome', '.var/app/com.google.Chrome/config/google-chrome'],
    ['brave', '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser'],
    ['msedge', '.var/app/com.microsoft.Edge/config/microsoft-edge'],
  ]);
}

/** Injectable inputs for {@link candidateLocalBrowserProfiles}, so tests never touch this machine's real home directory. */
export interface CandidateProfileDirsOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  localAppData?: string;
}

/** Every `--user-data-dir` this module knows to look for, in this platform's fixed order. First-hit-wins is `probeLocalBrowserCandidate`'s job, not this function's; this just enumerates. */
export function candidateLocalBrowserProfiles(
  opts: CandidateProfileDirsOptions = {},
): LocalBrowserProfileEntry[] {
  const p = opts.platform ?? platform();
  if (p === 'win32') {
    const local =
      opts.localAppData ??
      process.env['LOCALAPPDATA'] ??
      join(opts.homeDir ?? homedir(), 'AppData', 'Local');
    return windowsProfileTable(local);
  }
  if (p === 'darwin') {
    return macProfileTable(opts.homeDir ?? homedir());
  }
  return linuxProfileTable(opts.homeDir ?? homedir());
}

/** One `DevToolsActivePort` file's contents: the port on line 1, the browser's own devtools path on line 2. Read once, synchronously; unlike `cdp-endpoint.ts`'s `waitForDevToolsActivePort`, this never polls, because a candidate that has not written the file yet is simply not a live candidate. */
function readDevToolsActivePortFile(userDataDir: string): { port: number; wsPath: string } | null {
  const path = join(userDataDir, 'DevToolsActivePort');
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  const portLine = lines[0]?.trim();
  const wsPath = lines[1]?.trim() ?? '';
  const port = portLine ? Number(portLine) : Number.NaN;
  if (!portLine || Number.isNaN(port)) return null;
  return { port, wsPath };
}

/** Chrome's `chrome://inspect#remote-debugging` toggle, read straight from `Local State`. `null` when the file is missing or unparsable (never installed, or never launched once), distinct from `false` (installed, launched, toggle explicitly off). */
function readRemoteDebuggingToggle(userDataDir: string): boolean | null {
  const path = join(userDataDir, 'Local State');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const devtools = raw['devtools'] as Record<string, unknown> | undefined;
    const remoteDebugging = devtools?.['remote_debugging'] as Record<string, unknown> | undefined;
    const enabled = remoteDebugging?.['user-enabled'];
    return typeof enabled === 'boolean' ? enabled : null;
  } catch {
    return null;
  }
}

function extractGuid(webSocketDebuggerUrlOrPath: string): string | null {
  const match = /\/browser\/([^/]+)$/.exec(webSocketDebuggerUrlOrPath);
  return match ? (match[1] as string) : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** What {@link probeLocalBrowserCandidate} found for one candidate directory. */
export type LocalBrowserCandidateStatus =
  | 'live'
  | 'permission-blocked'
  | 'stale-port-file'
  | 'remote-debugging-disabled'
  | 'not-running';

/** One candidate's full probe result: enough to either use it (`status: 'live'`) or explain to a human why not. */
export interface LocalBrowserCandidateResult extends LocalBrowserProfileEntry {
  status: LocalBrowserCandidateStatus;
  /** The `http://127.0.0.1:<port>` origin, set whenever a live port was confirmed, `status: 'live'` or `'permission-blocked'`. */
  cdpUrl: string | null;
  /** The confirmed `webSocketDebuggerUrl`, set only when `status: 'live'`. */
  wsUrl: string | null;
  browserGuid: string | null;
  detail: string;
}

/** Options for {@link probeLocalBrowserCandidate} and {@link discoverLocalBrowser}. */
export interface ProbeLocalBrowserCandidateOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout for the liveness HTTP round trip. Default 1500. */
  requestTimeoutMs?: number;
  /** Passed to `probeCdpIdentity` for the two-poll GUID stability confirmation on the normal (200) path. Default 5000. */
  identityProbeTimeoutMs?: number;
  /** Passed to `chromeProcsForDataDirAsync` when no `DevToolsActivePort` file exists, to tell "nothing running here" from "running without remote debugging". Default the process table's own snapshot TTL. */
  maxProcessTableAgeMs?: number;
  /** Overrides the real process-table check (`chromeProcsForDataDirAsync`) used when no `DevToolsActivePort` file exists. Tests inject this rather than spawning a real browser to exercise the "running but remote debugging disabled" branch. */
  hasRunningProcess?: (userDataDir: string) => Promise<boolean>;
}

/**
 * Probes one candidate `--user-data-dir` and reports exactly what state it
 * is in. Never throws: every outcome, including "nothing is there", is a
 * normal result of this function, so a caller can scan every candidate and
 * decide what to do with the whole set. {@link discoverLocalBrowser} is
 * that caller for the common case.
 */
export async function probeLocalBrowserCandidate(
  entry: LocalBrowserProfileEntry,
  opts: ProbeLocalBrowserCandidateOptions = {},
): Promise<LocalBrowserCandidateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 1500;

  const portFile = readDevToolsActivePortFile(entry.userDataDir);
  if (!portFile) {
    const hasRunningProcess =
      opts.hasRunningProcess ??
      (async (userDataDir: string) =>
        (
          await chromeProcsForDataDirAsync(userDataDir, {
            maxAgeMs: opts.maxProcessTableAgeMs ?? 2000,
          })
        ).length > 0);
    const running = await hasRunningProcess(entry.userDataDir);
    if (!running) {
      return {
        ...entry,
        status: 'not-running',
        cdpUrl: null,
        wsUrl: null,
        browserGuid: null,
        detail: `no ${entry.label} process is using ${entry.userDataDir}`,
      };
    }
    const toggle = readRemoteDebuggingToggle(entry.userDataDir);
    return {
      ...entry,
      status: 'remote-debugging-disabled',
      cdpUrl: null,
      wsUrl: null,
      browserGuid: null,
      detail:
        toggle === false
          ? `${entry.label} is running on ${entry.userDataDir} with remote debugging recorded off; enable chrome://inspect/#remote-debugging ("Allow remote debugging for this browser instance") in that browser, then retry`
          : `${entry.label} is running on ${entry.userDataDir} but never wrote a DevToolsActivePort file; it was not started with remote debugging enabled for this session`,
    };
  }

  const origin = `http://127.0.0.1:${portFile.port}`;
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await withTimeout(fetchImpl(`${origin}/json/version`), requestTimeoutMs);
  } catch {
    // The file exists, but nothing answered its port: a leftover from a
    // browser that has since exited, per this module's own header, and
    // per `cdp-endpoint.ts`'s identical reasoning for the same file.
    return {
      ...entry,
      status: 'stale-port-file',
      cdpUrl: null,
      wsUrl: null,
      browserGuid: null,
      detail: `${entry.userDataDir}'s DevToolsActivePort names port ${portFile.port}, but nothing answered there; this is very likely a leftover file from a previous run, not a live browser`,
    };
  }

  if (res.status === 403) {
    return {
      ...entry,
      status: 'permission-blocked',
      cdpUrl: origin,
      wsUrl: null,
      browserGuid: null,
      detail: `permission-blocked: Chrome is reachable at ${origin}, but the per-session "Allow remote debugging" popup has not been accepted; click Allow in the browser, then retry`,
    };
  }

  if (res.status === 404) {
    // Chrome 147+ disables /json/* HTTP discovery on this profile; the ws
    // path DevToolsActivePort itself recorded still works. Trusting that
    // path here is safe in a way blindly reading the file never was: the
    // 404 we just received over this exact port proves something live is
    // speaking Chrome's CDP HTTP server there, not merely that a file
    // exists on disk.
    if (!portFile.wsPath) {
      return {
        ...entry,
        status: 'stale-port-file',
        cdpUrl: null,
        wsUrl: null,
        browserGuid: null,
        detail: `${origin}/json/version returned 404 and DevToolsActivePort recorded no websocket path to fall back to`,
      };
    }
    const wsUrl = `ws://127.0.0.1:${portFile.port}${portFile.wsPath}`;
    return {
      ...entry,
      status: 'live',
      cdpUrl: origin,
      wsUrl,
      browserGuid: extractGuid(portFile.wsPath),
      detail:
        'confirmed live via DevToolsActivePort fallback (Chrome 147+ /json/* lockdown on this profile)',
    };
  }

  if (!res.ok) {
    return {
      ...entry,
      status: 'stale-port-file',
      cdpUrl: null,
      wsUrl: null,
      browserGuid: null,
      detail: `${origin}/json/version returned unexpected HTTP ${res.status}`,
    };
  }

  // The normal case: confirm identity the same way a browser this node
  // launched itself would be confirmed, via `probeCdpIdentity`'s two-poll
  // GUID stability guard, rather than trusting this one response alone.
  try {
    const identity = await probeCdpIdentity({
      cdpUrl: origin,
      mode: 'fresh',
      overallTimeoutMs: opts.identityProbeTimeoutMs ?? 5000,
      fetchImpl,
    });
    return {
      ...entry,
      status: 'live',
      cdpUrl: origin,
      wsUrl: identity.webSocketDebuggerUrl,
      browserGuid: identity.browserGuid,
      detail: 'confirmed live via /json/version',
    };
  } catch (err) {
    const detail =
      err instanceof CdpProbeTimeoutError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ...entry,
      status: 'stale-port-file',
      cdpUrl: null,
      wsUrl: null,
      browserGuid: null,
      detail: `${origin} answered /json/version but never confirmed a stable identity: ${detail}`,
    };
  }
}

/** Thrown by {@link discoverLocalBrowser} when a candidate answered, but is waiting on the human to click Chrome's own "Allow remote debugging" popup. The one case worth a distinct error type: it tells the caller (human or agent) exactly what to do next, rather than reporting a generic connection failure. */
export class LocalBrowserPermissionBlockedError extends Error {
  readonly code = 'E_LOCAL_BROWSER_PERMISSION_BLOCKED';
  readonly userDataDir: string;
  readonly cdpUrl: string;

  constructor(userDataDir: string, cdpUrl: string, detail: string) {
    super(detail);
    this.name = 'LocalBrowserPermissionBlockedError';
    this.userDataDir = userDataDir;
    this.cdpUrl = cdpUrl;
  }
}

/** Thrown by {@link discoverLocalBrowser} when no candidate could be attached to at all, carrying every candidate's own result so a caller can show a full diagnostic, not just "not found". */
export class LocalBrowserNotFoundError extends Error {
  readonly code = 'E_LOCAL_BROWSER_NOT_FOUND';
  readonly searched: readonly LocalBrowserCandidateResult[];

  constructor(
    searched: readonly LocalBrowserCandidateResult[],
    remoteDebuggingDisabledSomewhere: boolean,
  ) {
    const hint = remoteDebuggingDisabledSomewhere
      ? 'at least one profile checked is running without remote debugging enabled; open chrome://inspect/#remote-debugging in that browser and tick "Allow remote debugging for this browser instance", then retry'
      : 'no Chrome-family browser was found running at all on any checked profile; open the browser you want to attach to, then retry';
    super(
      `no already-running, attachable Chrome-family browser was found (${hint}); checked: ${searched.map((s) => `${s.label} (${s.status})`).join(', ')}`,
    );
    this.name = 'LocalBrowserNotFoundError';
    this.searched = searched;
  }
}

/** Options for {@link discoverLocalBrowser}. */
export interface DiscoverLocalBrowserOptions extends ProbeLocalBrowserCandidateOptions {
  /** Overrides the candidate list this module would otherwise compute from the platform; tests supply real temp directories here. */
  candidates?: readonly LocalBrowserProfileEntry[];
  candidateOptions?: CandidateProfileDirsOptions;
}

/** What {@link discoverLocalBrowser} returns on success. */
export interface LocalBrowserDiscoveryResult {
  candidate: LocalBrowserCandidateResult & { status: 'live'; cdpUrl: string; wsUrl: string };
  results: readonly LocalBrowserCandidateResult[];
}

/**
 * Scans every candidate profile directory for this platform (or
 * `opts.candidates`, for tests) and returns the first one confirmed live.
 * `candidate.wsUrl` plus `candidate.userDataDir` are exactly the shape
 * `HostRuntime.attach()` already accepts (`endpoint.url` /
 * `recovered.profilePath`); this module does not call `attach()` itself,
 * so a caller composes the two.
 *
 * Throws {@link LocalBrowserPermissionBlockedError} when nothing is live but
 * at least one candidate is waiting on the human to accept Chrome's popup
 * (the single most actionable failure), or {@link LocalBrowserNotFoundError}
 * otherwise, carrying every candidate's own result.
 */
export async function discoverLocalBrowser(
  opts: DiscoverLocalBrowserOptions = {},
): Promise<LocalBrowserDiscoveryResult> {
  const candidates = opts.candidates ?? candidateLocalBrowserProfiles(opts.candidateOptions);
  const results: LocalBrowserCandidateResult[] = [];
  for (const entry of candidates) {
    const result = await probeLocalBrowserCandidate(entry, opts);
    results.push(result);
    if (result.status === 'live' && result.cdpUrl && result.wsUrl) {
      return { candidate: result as LocalBrowserDiscoveryResult['candidate'], results };
    }
  }
  const blocked = results.find((r) => r.status === 'permission-blocked');
  if (blocked) {
    throw new LocalBrowserPermissionBlockedError(
      blocked.userDataDir,
      blocked.cdpUrl ?? '',
      blocked.detail,
    );
  }
  throw new LocalBrowserNotFoundError(
    results,
    results.some((r) => r.status === 'remote-debugging-disabled'),
  );
}
