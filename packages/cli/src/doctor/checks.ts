/**
 * `bgls doctor`'s check implementations, one function per named check,
 * grouped as: environment, browser, store, profiles, packages, network,
 * plus `--check-invariants`. Every check answers "why is this
 * not working" without the operator reading source: `detail` states what
 * was observed, `fix` (when the verdict is not `pass`) states what to do.
 */

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  statfsSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import {
  invLeasedProfileHolderNonTerminal,
  invProfileLeaseUnique,
  invReadyInstanceHasNodeAndSession,
  invReleasedInstanceClean,
  invTenantInstanceCountWithinQuota,
  invTenantProfileBytesWithinQuota,
} from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, type Instance, type Profile } from '@browserglass/protocol';
import {
  BinaryNotFoundError,
  type ResolvedBinary,
  buildLaunchArgs,
  discoverCdpEndpoint,
  killProcessTree,
  resolveBrowserPid,
  resolveChromeBinary,
  spawnDetachedChrome,
  unlinkStaleDevToolsActivePort,
} from '@browserglass/runtime-host';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { openSqlite, readMigrationFiles, schemaVersionOf } from '@browserglass/store-sqlite';
import { DEFAULT_TENANT_ID } from '../gateway.js';
import { type PluginLoadResult, loadPlugin } from '../plugins/load.js';
import { readPluginsFile } from '../plugins/record.js';
import { type DoctorCheckResult, timedCheck } from './types.js';

const require = createRequire(import.meta.url);

// ── environment ─────────────────────────────────────────────────────────

/** Node major version floor, matching every package.json's `engines.node`. */
export async function checkNodeVersion(): Promise<DoctorCheckResult> {
  return timedCheck('node-version', 'environment', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) {
      return {
        verdict: 'fail',
        detail: `Node ${process.version} is running; BrowserGlass requires Node >= 22.`,
        fix: 'Install Node 22 or newer, e.g. via nvm/fnm/Volta, and re-run this command with it active.',
      };
    }
    return {
      verdict: 'pass',
      detail: `Node ${process.version}.`,
      observed: { version: process.version },
    };
  });
}

/** `UV_THREADPOOL_SIZE` governs libuv's worker pool; the default of 4 becomes a real bottleneck once several Chrome instances are launching or a store is doing concurrent file I/O. */
export async function checkUvThreadpoolSize(): Promise<DoctorCheckResult> {
  return timedCheck('uv-threadpool-size', 'environment', async () => {
    const raw = process.env['UV_THREADPOOL_SIZE'];
    const value = raw !== undefined ? Number(raw) : 4;
    if (!Number.isFinite(value) || value < 4) {
      return {
        verdict: 'warn',
        detail: `UV_THREADPOOL_SIZE is "${raw}", which is not a usable positive integer.`,
        fix: 'Set UV_THREADPOOL_SIZE to at least 8 (16 recommended for more than a handful of concurrent instances) before starting bgls serve.',
      };
    }
    if (value < 8) {
      return {
        verdict: 'warn',
        detail: `UV_THREADPOOL_SIZE is ${value} (the Node default). Concurrent Chrome launches and store I/O share this pool.`,
        fix: 'Set UV_THREADPOOL_SIZE=16 in the environment bgls serve runs in, or in .env (bgls doctor --fix can write this).',
      };
    }
    return {
      verdict: 'pass',
      detail: `UV_THREADPOOL_SIZE is ${value}.`,
      observed: { uvThreadpoolSize: value },
    };
  });
}

/** Coarse CPU/RAM sanity check: warns when there is unlikely to be room for even one Chrome instance. */
export async function checkCpuAndRam(): Promise<DoctorCheckResult> {
  return timedCheck('cpu-ram', 'environment', async () => {
    const coreCount = cpus().length;
    const totalGb = totalmem() / 1024 ** 3;
    const freeGb = freemem() / 1024 ** 3;
    const observed = {
      cores: coreCount,
      totalMemGb: Number(totalGb.toFixed(2)),
      freeMemGb: Number(freeGb.toFixed(2)),
    };
    if (coreCount < 2 || totalGb < 2) {
      return {
        verdict: 'warn',
        detail: `${coreCount} CPU core(s), ${totalGb.toFixed(1)} GB total RAM. Each Chrome instance typically needs a full core and 200 to 500 MB.`,
        fix: 'Run bgls serve on a host with at least 2 cores and 4 GB RAM for anything beyond a single instance.',
        observed,
      };
    }
    return {
      verdict: 'pass',
      detail: `${coreCount} CPU cores, ${totalGb.toFixed(1)} GB total RAM, ${freeGb.toFixed(1)} GB free.`,
      observed,
    };
  });
}

/** `profiles.dir` exists, is writable, and has free space. Transcribed from `@browserglass/server`'s own preflight `profile-dir`/`profile-space` checks, run standalone here (doctor never requires a running gateway). */
export async function checkProfileDirFilesystem(
  profilesDir: string,
  minFreeBytes = 2_147_483_648,
): Promise<DoctorCheckResult> {
  return timedCheck('profile-dir-fs', 'environment', async () => {
    try {
      mkdirSync(profilesDir, { recursive: true });
      accessSync(profilesDir, fsConstants.W_OK);
    } catch (err) {
      return {
        verdict: 'fail',
        detail: `profiles.dir "${profilesDir}" could not be created or is not writable: ${err instanceof Error ? err.message : String(err)}.`,
        fix: `Create "${profilesDir}" by hand and grant this user write access, or point --profiles-dir elsewhere.`,
      };
    }
    try {
      const stats = statfsSync(profilesDir);
      const free = stats.bavail * stats.bsize;
      if (free < minFreeBytes) {
        return {
          verdict: 'warn',
          detail: `"${profilesDir}" has ${(free / 1024 ** 3).toFixed(1)} GB free, below the recommended ${(minFreeBytes / 1024 ** 3).toFixed(1)} GB.`,
          fix: 'Free disk space on the volume backing this directory before running real workloads.',
          observed: { freeBytes: free },
        };
      }
      return {
        verdict: 'pass',
        detail: `"${profilesDir}" exists, is writable, ${(free / 1024 ** 3).toFixed(1)} GB free.`,
        observed: { freeBytes: free },
      };
    } catch {
      return {
        verdict: 'pass',
        detail: `"${profilesDir}" exists and is writable; free space could not be measured on this platform.`,
      };
    }
  });
}

/** Windows Defender real-time protection scanning `profiles.dir` slows every profile-directory write; detects this and, only on `--fix`, adds an exclusion. */
export async function checkWindowsDefender(profilesDir: string): Promise<DoctorCheckResult> {
  return timedCheck('windows-defender', 'environment', async () => {
    if (process.platform !== 'win32') {
      return { verdict: 'skipped', detail: 'Not running on Windows.' };
    }
    try {
      const statusOut = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-MpComputerStatus).RealTimeProtectionEnabled',
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (statusOut !== 'True') {
        return { verdict: 'pass', detail: 'Windows Defender real-time protection is not enabled.' };
      }
      const exclusionsOut = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-MpPreference).ExclusionPath -join ";"'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const excluded = exclusionsOut
        .split(';')
        .map((p) => p.trim().toLowerCase())
        .some((p) => p.length > 0 && profilesDir.toLowerCase().startsWith(p));
      if (excluded) {
        return {
          verdict: 'pass',
          detail: `Windows Defender real-time protection is enabled, but "${profilesDir}" is already excluded.`,
        };
      }
      return {
        verdict: 'warn',
        detail: `Windows Defender real-time protection is enabled and "${profilesDir}" is not excluded. Real-time scanning of Chrome's profile directory (many small LevelDB writes) measurably slows launches and can trigger file-lock contention.`,
        fix: `Run as Administrator: Add-MpPreference -ExclusionPath "${profilesDir}" (bgls doctor --fix attempts this automatically).`,
      };
    } catch (err) {
      return {
        verdict: 'skipped',
        detail: `Could not query Windows Defender status: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
  });
}

/** Best-effort mechanical fix for {@link checkWindowsDefender}: adds a Defender exclusion. Requires Administrator; failure is reported, never thrown. */
export function fixWindowsDefenderExclusion(profilesDir: string): {
  readonly applied: boolean;
  readonly detail: string;
} {
  if (process.platform !== 'win32') return { applied: false, detail: 'Not running on Windows.' };
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-MpPreference -ExclusionPath "${profilesDir.replace(/"/g, '""')}"`,
      ],
      { timeout: 5000, windowsHide: true, stdio: 'ignore' },
    );
    return { applied: true, detail: `Added a Windows Defender exclusion for "${profilesDir}".` };
  } catch (err) {
    return {
      applied: false,
      detail: `Could not add the exclusion (likely not running as Administrator): ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
}

// ── browser ──────────────────────────────────────────────────────────────

/**
 * Chrome version and path, via the same {@link resolveChromeBinary} the
 * real runtime uses. `discover` is injectable so a test can simulate "no
 * usable Chrome" without touching this machine's real installation
 * (registry entry or PATH).
 */
export async function checkChrome(
  discover: (channel: 'chrome') => ResolvedBinary = resolveChromeBinary,
): Promise<DoctorCheckResult> {
  return timedCheck('chrome', 'browser', async () => {
    try {
      const resolved = discover('chrome');
      return {
        verdict: 'pass',
        detail: `Chrome ${resolved.version} at "${resolved.path}".`,
        observed: { version: resolved.version, path: resolved.path },
      };
    } catch (err) {
      if (err instanceof BinaryNotFoundError) {
        return {
          verdict: 'fail',
          detail: `No runnable Chrome binary was found. Searched: ${err.searched.join(', ')}.`,
          fix: 'Install Google Chrome (https://www.google.com/chrome/), or set BGLS_CHROME_PATH to a working chrome executable.',
        };
      }
      return {
        verdict: 'fail',
        detail: `Chrome discovery failed: ${err instanceof Error ? err.message : String(err)}.`,
        fix: 'Install Google Chrome, or set BGLS_CHROME_PATH to a working chrome executable.',
      };
    }
  });
}

/**
 * Measures real launch-to-CDP-ready timing: spawns Chrome headless against
 * a throwaway profile directory, waits for `DevToolsActivePort` plus a
 * confirmed `/json/version` GUID, then kills it. Skipped entirely when the
 * `chrome` check already failed (there is nothing to launch).
 */
export async function checkChromeLaunchTiming(scratchDir: string): Promise<DoctorCheckResult> {
  return timedCheck('chrome-launch', 'browser', async () => {
    let resolved: ResolvedBinary;
    try {
      resolved = resolveChromeBinary('chrome');
    } catch {
      return { verdict: 'skipped', detail: 'No Chrome binary found; see the "chrome" check.' };
    }

    mkdirSync(scratchDir, { recursive: true });
    unlinkStaleDevToolsActivePort(scratchDir);
    const built = buildLaunchArgs({
      spec: { ...DEFAULT_BROWSER_SPEC, headless: 'new' },
      profilePath: scratchDir,
      profileMode: 'ephemeral',
      allowNoSandbox: false,
    });

    const launchStart = performance.now();
    const spawned = spawnDetachedChrome({
      binaryPath: resolved.path,
      args: built.args,
      env: built.env,
    });
    try {
      const { identity } = await discoverCdpEndpoint({
        profilePath: scratchDir,
        deadlineAt: Date.now() + 10_000,
      });
      const launchMs = performance.now() - launchStart;
      return {
        verdict: launchMs > 5000 ? 'warn' : 'pass',
        detail: `Chrome reached a stable CDP endpoint (browserGuid ${identity.browserGuid}) in ${launchMs.toFixed(0)}ms.`,
        ...(launchMs > 5000
          ? {
              fix: 'Launch times above 5s are usually disk contention (see the windows-defender and profile-dir-fs checks) or an overloaded host.',
            }
          : {}),
        observed: { launchMs: Math.round(launchMs) },
      };
    } catch (err) {
      return {
        verdict: 'fail',
        detail: `Chrome did not reach a stable CDP endpoint: ${err instanceof Error ? err.message : String(err)}.`,
        fix: 'Check antivirus/sandboxing software is not blocking Chrome from opening a debugging port, and that the profile directory is writable.',
      };
    } finally {
      // `spawned.spawnPid` is only reliably the long-lived browser process
      // on POSIX; on Windows Chrome hands off to a new browser-main process
      // and the originally spawned pid is usually already gone (see
      // `spawn.ts`'s `resolveBrowserPid` doc comment). Killing both is what actually reaches the real process on
      // every platform without leaving an orphan.
      killProcessTree(spawned.spawnPid);
      try {
        const realPid = await resolveBrowserPid(scratchDir, Date.now() + 2000, 100);
        killProcessTree(realPid);
      } catch {
        // No browser-main process ever appeared for this profile dir
        // (the launch itself failed before Chrome got that far); nothing
        // more to kill.
      }
    }
  });
}

// ── store ────────────────────────────────────────────────────────────────

/** Schema version and pending-migration count, opened read-only-ish (`migrate: 'off'`): doctor never migrates on its own outside `--fix`. */
export async function checkStoreSchema(storePath: string): Promise<DoctorCheckResult> {
  return timedCheck('store-schema', 'store', async () => {
    if (!existsSync(storePath)) {
      return {
        verdict: 'pass',
        detail: `No database yet at "${storePath}"; bgls serve will create and migrate it on first start.`,
      };
    }
    const store = await createSqliteStore(storePath, { migrate: 'off' });
    try {
      const current = await store.schemaVersion();
      const migrationsDir = join(
        dirname(require.resolve('@browserglass/store-sqlite/package.json')),
        'migrations',
      );
      const latest = readMigrationFiles(migrationsDir).reduce(
        (max, f) => Math.max(max, f.version),
        0,
      );
      if (current < latest) {
        return {
          verdict: 'warn',
          detail: `Schema is at version ${current}; ${latest - current} migration(s) are pending (latest is ${latest}).`,
          fix: 'Run bgls serve once (migrate: "auto" is the default) or bgls doctor --fix to apply pending migrations.',
          observed: { schemaVersion: current, latestVersion: latest },
        };
      }
      return {
        verdict: 'pass',
        detail: `Schema version ${current}, up to date.`,
        observed: { schemaVersion: current },
      };
    } finally {
      await store.close();
    }
  });
}

/** Opportunistic "who holds this database" check: a `BEGIN IMMEDIATE` that blocks means a writer (typically a running `bgls serve`) currently holds it. */
export async function checkStoreLockHolder(storePath: string): Promise<DoctorCheckResult> {
  return timedCheck('store-lock', 'store', async () => {
    if (!existsSync(storePath)) {
      return { verdict: 'skipped', detail: 'No database file yet.' };
    }
    const db = openSqlite(storePath, {});
    try {
      db.prepare('BEGIN IMMEDIATE').run();
      db.prepare('ROLLBACK').run();
      return {
        verdict: 'pass',
        detail: 'No other process currently holds a write lock on the database.',
      };
    } catch (err) {
      return {
        verdict: 'warn',
        detail: `The database is currently locked by another process (likely a running "bgls serve"): ${err instanceof Error ? err.message : String(err)}.`,
      };
    } finally {
      db.close();
    }
  });
}

// ── profiles ─────────────────────────────────────────────────────────────

/** Profile count, total size, orphans (quarantined), and stale (past-expiry) leases, read from the store's `profiles` table. */
export async function checkProfiles(
  storePath: string,
  tenantId = DEFAULT_TENANT_ID,
): Promise<DoctorCheckResult> {
  return timedCheck('profiles', 'profiles', async () => {
    if (!existsSync(storePath)) {
      return { verdict: 'pass', detail: 'No database yet; nothing to report.' };
    }
    const store = await createSqliteStore(storePath, { migrate: 'off' });
    try {
      const profiles: Profile[] = await store.listProfiles(tenantId);
      const totalBytes = profiles.reduce((sum, p) => sum + p.sizeBytes, 0);
      const orphans = profiles.filter((p) => p.state === 'quarantined').length;
      const now = Date.now();
      const staleLeases = profiles.filter(
        (p) => p.lease !== null && p.lease.expiresAt < now,
      ).length;
      const uniqueOk = invProfileLeaseUnique(profiles);
      const observed = {
        count: profiles.length,
        totalBytes,
        orphans,
        staleLeases,
      };
      if (!uniqueOk) {
        return {
          verdict: 'fail',
          detail:
            'More than one profile reports the same lease holder instance (INV-1 violated); the store is in an inconsistent state.',
          fix: 'Stop every bgls serve process against this database and inspect the profiles/profile_leases tables by hand before restarting.',
          observed,
        };
      }
      if (staleLeases > 0) {
        return {
          verdict: 'warn',
          detail: `${profiles.length} profile(s), ${(totalBytes / 1024 ** 2).toFixed(1)} MB total, ${orphans} orphan(s), ${staleLeases} stale lease(s) past their expiry.`,
          fix: 'Run "bgls profiles unlock <profileId>" for a stale lease once its holder is confirmed gone (not implemented by this CLI build; the sweeper reclaims it automatically once the gateway is running).',
          observed,
        };
      }
      return {
        verdict: 'pass',
        detail: `${profiles.length} profile(s), ${(totalBytes / 1024 ** 2).toFixed(1)} MB total, ${orphans} orphan(s), no stale leases.`,
        observed,
      };
    } finally {
      await store.close();
    }
  });
}

// ── packages ─────────────────────────────────────────────────────────────

/** `.changeset/config.json`'s `fixed` group: these packages always publish the same version, so a mismatch on disk means a partial/broken install. */
const FIXED_VERSION_GROUP = ['protocol', 'core', 'router', 'server', 'client', 'react'] as const;

function packageVersion(name: string): string | null {
  try {
    const pkgJsonPath = require.resolve(`@browserglass/${name}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { readonly version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Version consistency across the `fixed` changesets group. Never proposes a fix that touches a package version: `--fix` never edits versions. */
export async function checkPackageVersions(): Promise<DoctorCheckResult> {
  return timedCheck('packages', 'packages', async () => {
    const versions = FIXED_VERSION_GROUP.map((name) => ({ name, version: packageVersion(name) }));
    const missing = versions.filter((v) => v.version === null);
    if (missing.length > 0) {
      return {
        verdict: 'fail',
        detail: `Could not resolve a version for: ${missing.map((m) => m.name).join(', ')}. The install looks incomplete.`,
        fix: 'Run pnpm install (or pnpm -r build) from the repository root.',
      };
    }
    const distinct = new Set(versions.map((v) => v.version));
    if (distinct.size > 1) {
      return {
        verdict: 'fail',
        detail: `The "fixed" package group has mismatched versions: ${versions.map((v) => `${v.name}@${v.version}`).join(', ')}.`,
        fix: 'This is a broken install (a partial upgrade). Reinstall so every @browserglass/* package in the fixed group resolves to the same version. bgls doctor never changes package versions itself.',
        observed: Object.fromEntries(versions.map((v) => [v.name, v.version])),
      };
    }
    return {
      verdict: 'pass',
      detail: `Fixed package group consistent at ${[...distinct][0]}.`,
      observed: Object.fromEntries(versions.map((v) => [v.name, v.version])),
    };
  });
}

// ── plugins ──────────────────────────────────────────────────────────────

/**
 * What `bgls-plugins.json` names and whether each named plugin is usable
 * on this machine right now. Runs the exact same lifecycle `bgls plugins
 * list` does, `load.ts`'s `loadPlugin`: platform gate, integrity verify,
 * `import()`, manifest validation, `probe()` under a deadline
 * (`packages/cli/src/commands/plugins-cmd.ts`, `runPluginsList`). Nothing
 * here fetches anything or touches the network; every entry inspected is
 * already on disk, as every command but `bgls plugins add` must be.
 *
 * No `bgls-plugins.json` at all is the normal default state, nothing
 * installed, and reports `pass`: plugins are optional and only ever
 * arrive by an explicit `bgls plugins add`
 * (nothing is fetched at run time). A record that exists but
 * fails to parse or fails shape validation is `fail`, the same "broken
 * install, a human can act on it directly" verdict
 * {@link checkPackageVersions} gives a fixed-group version mismatch.
 *
 * Among installed entries, `'integrity-mismatch'` and `'load-failed'`
 * escalate the whole check to `fail`: the former is the one named hard
 * stop (a plugin whose file no longer matches the hash recorded at
 * install time), the latter means the plugin cannot run here at all.
 * `'unusable'`, `'probe-failed'` and `'unsupported-host-api'` are `warn`:
 * correctly recorded and verified, just not usable right now (no system
 * ffmpeg for a frame-encoder, a probe that did not answer in time, or a
 * host contract mismatch). `'ready'` and `'not-applicable'` are never a
 * degradation on their own: a shared `bgls-plugins.json` naming a plugin
 * for a platform this machine is not is reported as inapplicable, not an
 * error.
 */
export async function checkPlugins(dataDir: string, filePath: string): Promise<DoctorCheckResult> {
  return timedCheck('plugins', 'plugins', async () => {
    const read = readPluginsFile(filePath);
    if (!read.ok) {
      return {
        verdict: 'fail',
        detail: read.reason,
        fix: `Fix or remove "${filePath}" by hand, or reinstall the plugin(s) it names with "bgls plugins add <spec>".`,
      };
    }

    if (read.file.plugins.length === 0) {
      return {
        verdict: 'pass',
        detail: `No plugins installed ("${filePath}" absent or empty). Optional; install one with "bgls plugins add <spec>".`,
      };
    }

    const rows = await Promise.all(
      read.file.plugins.map(async (entry) => ({
        entry,
        result: await loadPlugin(entry, dataDir, entry.kind),
      })),
    );
    const summary = rows
      .map(({ entry, result }) => `${entry.id} (${entry.kind}): ${result.status}`)
      .join('; ');
    const counts: Record<PluginLoadResult['status'], number> = {
      ready: 0,
      unusable: 0,
      'not-applicable': 0,
      'integrity-mismatch': 0,
      'load-failed': 0,
      'unsupported-host-api': 0,
      'probe-failed': 0,
    };
    for (const { result } of rows) counts[result.status] += 1;
    const observed = { total: rows.length, ...counts };

    const untrustworthy = rows.filter(
      ({ result }) => result.status === 'integrity-mismatch' || result.status === 'load-failed',
    );
    if (untrustworthy.length > 0) {
      return {
        verdict: 'fail',
        detail: `${untrustworthy.length} of ${rows.length} installed plugin(s) cannot be trusted or loaded: ${summary}.`,
        fix: 'An integrity-mismatch means the plugin\'s entry file no longer matches the hash recorded at install time; reinstall it with "bgls plugins add <spec>" rather than re-trusting it. A load-failed plugin is either a broken install or a bug in the plugin itself; "bgls plugins list" prints the full reason for each.',
        observed,
      };
    }

    const degraded = rows.filter(
      ({ result }) =>
        result.status === 'unusable' ||
        result.status === 'probe-failed' ||
        result.status === 'unsupported-host-api',
    );
    if (degraded.length > 0) {
      return {
        verdict: 'warn',
        detail: `${degraded.length} of ${rows.length} installed plugin(s) are recorded correctly but not usable right now: ${summary}.`,
        fix: '"bgls plugins list" prints why each one is not usable right now (e.g. no system ffmpeg found for a frame-encoder, or a host API version mismatch).',
        observed,
      };
    }

    return {
      verdict: 'pass',
      detail: `${rows.length} plugin(s) installed: ${summary}.`,
      observed,
    };
  });
}

// ── network ──────────────────────────────────────────────────────────────

/** Whether the configured `--listen` address is currently bindable. */
export async function checkNetworkListener(host: string, port: number): Promise<DoctorCheckResult> {
  return timedCheck('network-listener', 'network', async () => {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve({
            verdict: 'warn',
            detail: `${host}:${port} is already in use (likely by a running "bgls serve").`,
            fix: 'Stop the process using that port, or pass a different --listen address.',
          });
        } else {
          resolve({
            verdict: 'warn',
            detail: `Could not test-bind ${host}:${port}: ${err.message}.`,
          });
        }
      });
      server.listen(port, host, () => {
        server.close(() => {
          resolve({ verdict: 'pass', detail: `${host}:${port} is free.` });
        });
      });
    });
  });
}

/** Outbound reachability, informational only: a fully offline dev workflow is legitimate. */
export async function checkNetworkOutbound(): Promise<DoctorCheckResult> {
  return timedCheck('network-outbound', 'network', async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      timer.unref?.();
      await fetch('https://registry.npmjs.org/', { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      return { verdict: 'pass', detail: 'Outbound HTTPS reachable.' };
    } catch (err) {
      return {
        verdict: 'warn',
        detail: `Outbound HTTPS is not reachable: ${err instanceof Error ? err.message : String(err)}. This is fine for a fully local/offline setup.`,
      };
    }
  });
}

const TUNNEL_ENV_MARKERS: readonly { readonly env: string; readonly label: string }[] = [
  { env: 'CODESPACES', label: 'GitHub Codespaces' },
  { env: 'GITPOD_WORKSPACE_ID', label: 'Gitpod' },
  { env: 'REPL_ID', label: 'Replit' },
  { env: 'NGROK_URL', label: 'ngrok' },
];

/** Detects common dev-tunnel/cloud-IDE environments, since `--listen 127.0.0.1` is unreachable from outside them without a tunnel. */
export async function checkNetworkTunnel(): Promise<DoctorCheckResult> {
  return timedCheck('network-tunnel', 'network', async () => {
    const found = TUNNEL_ENV_MARKERS.find((m) => process.env[m.env] !== undefined);
    if (found !== undefined) {
      return {
        verdict: 'pass',
        detail: `Running inside ${found.label}. If bgls serve binds 127.0.0.1, a browser outside this environment cannot reach it without that platform's own port forwarding/tunnel.`,
      };
    }
    return { verdict: 'pass', detail: 'No known dev-tunnel/cloud-IDE environment detected.' };
  });
}

// ── invariants ───────────────────────────────────────────────────────────

/**
 * `--check-invariants`: evaluates every `INV-*` predicate from
 * `@browserglass/protocol` that can be checked from a single store
 * snapshot alone. The remaining invariants need live in-process session
 * state (viewer sockets, per-stream sequence counters) that an external
 * CLI process has no access to in this build; those are reported
 * `skipped` with the reason, never silently omitted.
 */
export async function checkInvariants(
  storePath: string,
  tenantId = DEFAULT_TENANT_ID,
): Promise<readonly DoctorCheckResult[]> {
  const snapshotOnly = ['INV-1', 'INV-10', 'INV-12', 'INV-15', 'INV-18', 'INV-19'];
  const needsLiveState = [
    'INV-2',
    'INV-3',
    'INV-4',
    'INV-5',
    'INV-6',
    'INV-7',
    'INV-8',
    'INV-9',
    'INV-11',
    'INV-13',
    'INV-14',
    'INV-16',
    'INV-17',
    'INV-20',
    'INV-21',
    'INV-22',
    'INV-23',
    'INV-24',
    'INV-25',
  ];
  const skippedResults: DoctorCheckResult[] = needsLiveState.map((id) => ({
    name: id,
    group: 'invariants',
    verdict: 'skipped',
    durationMs: 0,
    detail: `${id} needs live in-process session/connection state, not available to an external CLI process in this build.`,
  }));

  if (!existsSync(storePath)) {
    return [
      ...snapshotOnly.map((id) => ({
        name: id,
        group: 'invariants' as const,
        verdict: 'skipped' as const,
        durationMs: 0,
        detail: 'No database yet.',
      })),
      ...skippedResults,
    ];
  }

  const store = await createSqliteStore(storePath, { migrate: 'off' });
  try {
    const [profiles, instances, tenant] = await Promise.all([
      store.listProfiles(tenantId),
      store.listInstances(tenantId),
      store.getTenant(tenantId),
    ]);
    const results: DoctorCheckResult[] = [];

    results.push(
      await timedCheck('INV-1', 'invariants', async () => {
        const ok = invProfileLeaseUnique(profiles);
        return ok
          ? { verdict: 'pass', detail: 'Every profile lease holder is unique.' }
          : {
              verdict: 'fail',
              detail: 'Two or more profiles report the same lease holder instance.',
            };
      }),
    );

    results.push(
      await timedCheck('INV-10', 'invariants', async () => {
        const violations = instances.filter((i: Instance) => !invReadyInstanceHasNodeAndSession(i));
        return violations.length === 0
          ? { verdict: 'pass', detail: 'Every ready instance has a nodeId and sessionId.' }
          : {
              verdict: 'fail',
              detail: `${violations.length} ready instance(s) missing a nodeId or sessionId: ${violations.map((i) => i.id).join(', ')}.`,
            };
      }),
    );

    results.push(
      await timedCheck('INV-12', 'invariants', async () => {
        const byId = new Map(instances.map((i: Instance) => [i.id, i.state] as const));
        const violations = profiles.filter((p) => {
          const holderState = p.lease?.holderInstanceId
            ? (byId.get(p.lease.holderInstanceId) ?? null)
            : null;
          return !invLeasedProfileHolderNonTerminal(p, holderState);
        });
        return violations.length === 0
          ? {
              verdict: 'pass',
              detail: "Every leased profile's holder instance is in a non-terminal state.",
            }
          : {
              verdict: 'fail',
              detail: `${violations.length} leased profile(s) reference a released/failed holder instance.`,
            };
      }),
    );

    results.push(
      await timedCheck('INV-15', 'invariants', async () => {
        if (tenant === null) return { verdict: 'skipped', detail: 'No tenant row found.' };
        const liveCount = instances.filter(
          (i: Instance) => i.state !== 'released' && i.state !== 'failed',
        ).length;
        const ok = invTenantInstanceCountWithinQuota(liveCount, tenant.quotas);
        return ok
          ? {
              verdict: 'pass',
              detail: `${liveCount} live instance(s), within quota (${tenant.quotas.maxInstances}).`,
            }
          : {
              verdict: 'fail',
              detail: `${liveCount} live instance(s) exceeds quota (${tenant.quotas.maxInstances}).`,
            };
      }),
    );

    results.push(
      await timedCheck('INV-18', 'invariants', async () => {
        if (tenant === null) return { verdict: 'skipped', detail: 'No tenant row found.' };
        const totalBytes = profiles.reduce((sum, p) => sum + p.sizeBytes, 0);
        const ok = invTenantProfileBytesWithinQuota(totalBytes, tenant.quotas);
        return ok
          ? {
              verdict: 'pass',
              detail: `${(totalBytes / 1024 ** 3).toFixed(2)} GB total, within quota.`,
            }
          : {
              verdict: 'fail',
              detail: `${(totalBytes / 1024 ** 3).toFixed(2)} GB total exceeds quota (${(tenant.quotas.maxProfileBytes / 1024 ** 3).toFixed(2)} GB).`,
            };
      }),
    );

    results.push(
      await timedCheck('INV-19', 'invariants', async () => {
        const violations = instances.filter((i: Instance) => {
          const stillHoldsLease = profiles.some((p) => p.lease?.holderInstanceId === i.id);
          return !invReleasedInstanceClean(i, stillHoldsLease);
        });
        return violations.length === 0
          ? {
              verdict: 'pass',
              detail: 'Every released instance is clean (releasedAt set, no held lease).',
            }
          : {
              verdict: 'fail',
              detail: `${violations.length} released instance(s) still hold a profile lease or lack releasedAt.`,
            };
      }),
    );

    return [...results, ...skippedResults];
  } finally {
    await store.close();
  }
}

export { schemaVersionOf };
