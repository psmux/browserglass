/**
 * The one place every BrowserGlass test suite that starts a real Chrome
 * gets its profiles seeded and its temp folders cleaned.
 *
 * WHY. On Windows each start of the installed Chrome on a fresh profile
 * makes one failed Windows logon (Chrome's blank password check, see
 * `src/local-state-seed.ts`). Ten in ten minutes lock the account. One run
 * of the runtime-host and conformance suites on a Windows box did exactly
 * that, which also blocked SSH to it for the lockout window.
 *
 * WHAT. Wired into a package as both its `globalSetup` (this file's
 * default export) and a `setupFiles` entry (`seeded-chrome.setup.ts`):
 *
 *  1. Once per run, on Windows, make sure the machine has a trusted Local
 *     State seed. A machine without one makes it here, once, with one plain
 *     headless Chrome on its own profile; that start is the only failed
 *     logon the machine ever pays, and a lock file keeps two runs from
 *     both paying it. `spawnDetachedChrome` then copies the seed into every
 *     profile before Chrome starts.
 *  2. Each test worker runs with `BGLS_REQUIRE_SEEDED_PROFILE=1`, so a
 *     Windows Chrome start on a profile that still has no answer throws
 *     `UnseededProfileError` instead of costing a logon. (`VITEST` alone
 *     already turns the guard on; the explicit flag also reaches child
 *     processes a test starts with a cleared environment.)
 *  3. `os.tmpdir()` in every worker points at one fresh run folder, short
 *     on Windows so profile paths stay under runtime-host's 120 character
 *     limit, and `BGLS_TEST_TMP` names it for the suites that make their
 *     own short roots. Teardown ends any Chrome still running under it and
 *     removes it, so no test profile is left in the machine's temp folder.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isTrustedSeed, localStateSeedPath, readTrustedSeed } from '../../src/local-state-seed.js';
import { chromeProcsForDataDir, listAllChromeFamilyProcesses } from '../../src/process-table.js';

declare module 'vitest' {
  export interface ProvidedContext {
    bglsTestTmp: string;
  }
}

/** The installed Chrome on Windows, the one BrowserGlass discovers first. */
function windowsChrome(): string | undefined {
  const candidates = [
    process.env['BGLS_CHROME_PATH'],
    join(
      process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),
    join(
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

function killChromeOn(udd: string): void {
  for (const p of chromeProcsForDataDir(udd)) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // already gone
    }
  }
}

/**
 * Makes this machine's seed when it has none (Windows only). Resolves true
 * when a trusted seed exists afterwards. Costs one failed logon, once per
 * machine, and only when no seed was there.
 */
export async function ensureLocalStateSeed(
  log: (m: string) => void = console.warn,
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const seed = localStateSeedPath();
  if (readTrustedSeed()) return true;
  const lock = `${seed}.making`;
  mkdirSync(dirname(seed), { recursive: true });
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 5 * 60_000)
      rmSync(lock, { force: true });
    closeSync(openSync(lock, 'wx'));
  } catch {
    // Another run (or GlassQA) is making it: wait for its seed.
    const t0 = Date.now();
    while (Date.now() - t0 < 200_000 && !readTrustedSeed())
      await new Promise((r) => setTimeout(r, 2000));
    return !!readTrustedSeed();
  }
  const chrome = windowsChrome();
  const udd = join(dirname(seed), 'seed-udd');
  let child: ChildProcess | undefined;
  try {
    if (!chrome) return false;
    // A seed file Chrome would not trust is moved aside, not used.
    if (existsSync(seed))
      renameSync(seed, `${seed.replace(/\.json$/, '')}.untrusted-${Date.now()}.json`);
    log(
      `[seeded-chrome] making the Local State seed with one Chrome on ${udd}; this one start costs one failed Windows logon, once per machine`,
    );
    child = spawn(
      chrome,
      [
        '--headless=new',
        `--user-data-dir=${udd}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const s = JSON.parse(readFileSync(join(udd, 'Local State'), 'utf8')) as Record<
          string,
          unknown
        >;
        if (isTrustedSeed(s)) {
          writeFileSync(`${seed}.tmp`, JSON.stringify(s), 'utf8');
          renameSync(`${seed}.tmp`, seed);
          break;
        }
      } catch {
        // not written yet
      }
    }
  } finally {
    if (child?.pid) {
      try {
        execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
        // handed off already; the profile scan below gets the rest
      }
    }
    killChromeOn(udd);
    rmSync(udd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    rmSync(lock, { force: true });
  }
  const ok = !!readTrustedSeed();
  log(
    ok
      ? `[seeded-chrome] Local State seed made: ${seed}`
      : '[seeded-chrome] no Local State seed: Chrome did not fetch its variations in time',
  );
  return ok;
}

/** A fresh run folder: short on Windows (profile paths have a 120 character limit there). */
function makeRunRoot(): string {
  if (process.platform === 'win32') {
    const base = join(process.env['SystemDrive'] ?? 'C:', 'bglstmp');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, 'r'));
  }
  return mkdtempSync(join(tmpdir(), 'bgls-test-'));
}

/** Every Chrome whose command line names a profile under `root`. */
function chromesUnder(root: string): number[] {
  const needle = root.replace(/\\/g, '/').toLowerCase();
  return listAllChromeFamilyProcesses()
    .filter((p) => p.commandLine.replace(/\\/g, '/').toLowerCase().includes(needle))
    .map((p) => p.pid);
}

function endChromesUnder(root: string): number {
  const pids = chromesUnder(root);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // already gone
    }
  }
  return pids.length;
}

async function removeRunRoot(root: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!existsSync(root)) return;
    } catch {
      // a file a dying Chrome still holds (EBUSY on Windows): end it and retry
    }
    endChromesUnder(root);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[seeded-chrome] could not remove the test run folder ${root}`);
}

/** Vitest `globalSetup`: seed once, hand workers the run folder, clean it at the end. */
export default async function setup({
  provide,
}: { provide: (key: 'bglsTestTmp', value: string) => void }): Promise<() => Promise<void>> {
  if (process.platform === 'win32' && !(await ensureLocalStateSeed())) {
    console.error(
      `[seeded-chrome] this Windows machine has no trusted Local State seed (${localStateSeedPath()}). Every test that starts Chrome will fail with UnseededProfileError rather than cost a failed logon.`,
    );
  }
  const root = makeRunRoot();
  provide('bglsTestTmp', root);
  return async () => {
    const ended = endChromesUnder(root);
    if (ended > 0)
      console.warn(
        `[seeded-chrome] ended ${ended} Chrome process(es) a test left running under ${root}`,
      );
    await removeRunRoot(root);
  };
}
