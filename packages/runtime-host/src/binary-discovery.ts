/**
 * Chrome binary discovery. First hit wins, in a fixed per-platform order.
 * Windows checks the registry `App Paths` key before any fixed path,
 * because a policy install can relocate Chrome and `App Paths` is how
 * Windows itself finds the default browser.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { BrowserChannel } from '@browserglass/protocol';

/** The resolved tuple `probe()` and node registration report. */
export interface ResolvedBinary {
  channel: BrowserChannel;
  path: string;
  version: string;
  mtimeMs: number;
  size: number;
}

/** Thrown when no binary for the requested channel can be found or run, carrying every path searched. */
export class BinaryNotFoundError extends Error {
  readonly code = 'E_BINARY_NOT_FOUND';
  readonly channel: BrowserChannel;
  readonly searched: readonly string[];

  constructor(channel: BrowserChannel, searched: readonly string[]) {
    super(`no runnable ${channel} binary found; searched: ${searched.join(', ')}`);
    this.name = 'BinaryNotFoundError';
    this.channel = channel;
    this.searched = searched;
  }
}

interface DiscoveryCacheEntry {
  resolved: ResolvedBinary;
  /** The file stat this cache entry was validated against; re-resolved when either changes. */
  statSnapshot: { mtimeMs: number; size: number };
}

const cache = new Map<BrowserChannel, DiscoveryCacheEntry>();

/** Test-only escape hatch: clears the module-level discovery cache. */
export function __resetBinaryDiscoveryCacheForTests(): void {
  cache.clear();
}

function envPath(): string | null {
  const v = process.env['BGLS_CHROME_PATH'];
  return v && existsSync(v) ? v : null;
}

function configPath(
  channel: BrowserChannel,
  binaries?: Partial<Record<BrowserChannel, string>>,
): string | null {
  const v = binaries?.[channel];
  return v && existsSync(v) ? v : null;
}

/**
 * Reads `HKLM`/`HKCU`'s `App Paths\chrome.exe` default value via `reg.exe`.
 * Returns `null` when the key is absent (not found is the normal case on a
 * machine without Chrome, not an error condition).
 */
function queryAppPathsRegistry(hive: 'HKLM' | 'HKCU', exeName: string): string | null {
  try {
    const out = execFileSync(
      'reg.exe',
      [
        'query',
        `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
        '/ve',
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        // A missing key is the normal, expected outcome for most channels on
        // most machines; reg.exe's own stderr text for that case is not
        // worth surfacing, and 'ignore' keeps it out of both this process's
        // console and the returned error's captured buffer.
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const match = /REG_SZ\s+(.+)\r?$/m.exec(out);
    const value = match?.[1]?.trim();
    return value && existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

/** Channel to `App Paths` exe name and vendor directory layout. */
const CHANNEL_EXE_NAME: Partial<Record<BrowserChannel, string>> = {
  chrome: 'chrome.exe',
  msedge: 'msedge.exe',
  brave: 'brave.exe',
};

function windowsFixedPaths(channel: BrowserChannel): string[] {
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  switch (channel) {
    case 'chrome':
      return [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ...(localAppData
          ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]
          : []),
      ];
    case 'msedge':
      return [
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ];
    case 'brave':
      return [join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')];
    default:
      return [];
  }
}

function macFixedPaths(channel: BrowserChannel): string[] {
  const home = process.env['HOME'] ?? '';
  switch (channel) {
    case 'chrome':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ...(home
          ? [join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
          : []),
      ];
    case 'chrome-beta':
      return ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'];
    case 'msedge':
      return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    case 'brave':
      return ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'];
    case 'chromium':
      return ['/Applications/Chromium.app/Contents/MacOS/Chromium'];
    default:
      return [];
  }
}

function linuxWhichCandidates(channel: BrowserChannel): string[] {
  switch (channel) {
    case 'chrome':
      return ['google-chrome-stable', 'google-chrome'];
    case 'chromium':
      return ['chromium-browser', 'chromium'];
    case 'msedge':
      return ['microsoft-edge-stable'];
    case 'brave':
      return ['brave-browser'];
    case 'chromium-headless-shell':
      return ['chromium-headless-shell'];
    default:
      return [];
  }
}

function which(bin: string): string | null {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], { encoding: 'utf8', timeout: 2000 });
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function linuxFixedPaths(channel: BrowserChannel): string[] {
  switch (channel) {
    case 'chrome':
      return ['/opt/google/chrome/chrome'];
    case 'chromium':
      return [
        '/usr/lib/chromium/chromium',
        '/usr/lib/chromium-browser/chromium-browser',
        '/snap/bin/chromium',
      ];
    default:
      return [];
  }
}

/**
 * On Windows, `<binary> --version` is not a reliable way to read Chrome's
 * version: empirically (against the Chrome 151 build this was verified
 * on), invoking `chrome.exe --version` with a fresh
 * `--user-data-dir` does not print a version string and exit, it launches
 * a full interactive browser and the invoking process exits near
 * immediately once it has handed off (a Windows-specific self-relaunch
 * Chrome performs regardless of the flag). Reading the PE file's own
 * `FileVersion` resource is instant, has no process side effects, and
 * returns the exact same string.
 */
function windowsFileVersion(path: string): string | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${path.replace(/'/g, "''")}').VersionInfo.FileVersion`,
      ],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    );
    const v = out.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Runs `<binary> --version` with a 2 second timeout and parses the version
 * string from stdout. POSIX only; see {@link windowsFileVersion} for why
 * Windows uses a different mechanism. A binary that cannot report a
 * version this way counts as not found.
 */
function posixVersionFromProcess(path: string): string | null {
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 2000 });
    const match = /[\d]+\.[\d]+\.[\d]+\.[\d]+/.exec(out);
    return match ? match[0] : out.trim() || null;
  } catch {
    return null;
  }
}

function versionFor(path: string): string | null {
  return platform() === 'win32' ? windowsFileVersion(path) : posixVersionFromProcess(path);
}

function candidateList(
  channel: BrowserChannel,
  binaries?: Partial<Record<BrowserChannel, string>>,
): string[] {
  const candidates: string[] = [];
  const env = envPath();
  if (env) candidates.push(env);
  const cfg = configPath(channel, binaries);
  if (cfg) candidates.push(cfg);

  const p = platform();
  if (p === 'win32') {
    const exeName = CHANNEL_EXE_NAME[channel];
    if (exeName) {
      const hklm = queryAppPathsRegistry('HKLM', exeName);
      if (hklm) candidates.push(hklm);
      const hkcu = queryAppPathsRegistry('HKCU', exeName);
      if (hkcu) candidates.push(hkcu);
    }
    candidates.push(...windowsFixedPaths(channel));
  } else if (p === 'darwin') {
    candidates.push(...macFixedPaths(channel));
    // mdfind is intentionally not implemented yet: it is a
    // best-effort last resort ahead of the bundled build only, and the
    // fixed paths above cover the verified target machine's platform.
  } else {
    for (const bin of linuxWhichCandidates(channel)) {
      const found = which(bin);
      if (found) candidates.push(found);
    }
    candidates.push(...linuxFixedPaths(channel));
  }

  return candidates;
}

/**
 * Resolves `channel` to an executable path, verifying it can actually
 * report a version, and caches the result keyed on the resolved file's
 * `{mtime, size}` so a Chrome upgrade in place invalidates the cache on
 * the next call rather than silently launching a stale binary.
 */
export function resolveChromeBinary(
  channel: BrowserChannel,
  binaries?: Partial<Record<BrowserChannel, string>>,
): ResolvedBinary {
  const cached = cache.get(channel);
  if (cached) {
    try {
      const st = statSync(cached.resolved.path);
      if (st.mtimeMs === cached.statSnapshot.mtimeMs && st.size === cached.statSnapshot.size) {
        return cached.resolved;
      }
    } catch {
      // File vanished since the last resolution; fall through and re-search.
    }
  }

  const searched: string[] = [];
  for (const candidate of candidateList(channel, binaries)) {
    searched.push(candidate);
    if (!existsSync(candidate)) continue;
    const version = versionFor(candidate);
    if (!version) continue; // A binary that cannot report a version counts as not found; keep searching.
    const st = statSync(candidate);
    const resolved: ResolvedBinary = {
      channel,
      path: candidate,
      version,
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    cache.set(channel, { resolved, statSnapshot: { mtimeMs: st.mtimeMs, size: st.size } });
    return resolved;
  }

  throw new BinaryNotFoundError(channel, searched);
}
