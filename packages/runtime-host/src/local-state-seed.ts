/**
 * Chrome's blank password check, and the Local State seed that answers it.
 *
 * On Windows, Chrome asks at startup whether the signed in user's password
 * is blank by calling LogonUser with an empty password. Each call is one
 * failed interactive logon (Security event 4625, logon type 2, from
 * chrome.exe). Chrome skips the check when the profile's `Local State`
 * already holds an earlier answer. Every fresh BrowserGlass profile has no
 * `Local State`, so every start of the installed Chrome on one cost a
 * failed logon, and under a common lockout policy (10 in 10 minutes) a
 * test suite or a busy gateway locked the Windows account, and every SSH
 * login to the machine with it.
 *
 * Writing only the answer keys (`password_manager.os_password_blank` and
 * `os_password_last_changed`) is not enough: Chrome asked again on every
 * such profile in testing. A whole `Local State` that Chrome itself wrote
 * after answering, and after it fetched its variations, is trusted. So one
 * such file is kept per machine as the seed, at
 * `~/.browserglass/local-state-seed.json` (or `BGLS_LOCAL_STATE_SEED`).
 * GlassQA keeps and reads the same file, so a machine has one seed for
 * both.
 *
 * {@link prepareLocalState} runs right before every Chrome start
 * (`spawnDetachedChrome` calls it): a profile without an answer gets the
 * seed as its `Local State`, or the seed's answer merged into the
 * `Local State` it has. BrowserGlass never makes a seed itself here, since
 * making one costs the one failed logon it exists to avoid; the test
 * suites make it once per machine (`test/support/seeded-chrome.ts`), and
 * GlassQA does the same.
 *
 * Under a test runner (`VITEST` set) or with `BGLS_REQUIRE_SEEDED_PROFILE=1`,
 * a Windows Chrome start on a profile that still has no answer is refused
 * with {@link UnseededProfileError} instead of costing a failed logon.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type State = Record<string, unknown>;

/** Where this machine's seed lives: `BGLS_LOCAL_STATE_SEED`, else `~/.browserglass/local-state-seed.json`. */
export function localStateSeedPath(): string {
  return (
    process.env['BGLS_LOCAL_STATE_SEED'] ??
    join(homedir(), '.browserglass', 'local-state-seed.json')
  );
}

function readJson(file: string): State | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v !== null && typeof v === 'object' ? (v as State) : undefined;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, data: unknown): boolean {
  const tmp = `${file}.bgls-${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/** True when a Local State holds Chrome's answer to the blank password check. */
export function hasPasswordCheckAnswer(state: State | undefined): boolean {
  const pm = state?.['password_manager'] as State | undefined;
  return (
    !!pm &&
    typeof pm === 'object' &&
    pm['os_password_last_changed'] !== undefined &&
    pm['os_password_blank'] !== undefined
  );
}

/**
 * A Local State Chrome trusts as a seed: the answer, plus the state Chrome
 * keeps once it has fetched its variations. One taken before that fetch
 * was not trusted in testing (Chrome asked again).
 */
export function isTrustedSeed(state: State | undefined): boolean {
  return (
    hasPasswordCheckAnswer(state) &&
    state?.['variations_seed_date'] !== undefined &&
    state?.['variations_last_fetch_time'] !== undefined
  );
}

/** Reads this machine's seed, or `undefined` when there is none or Chrome would not trust it. */
export function readTrustedSeed(): State | undefined {
  const s = readJson(localStateSeedPath());
  return isTrustedSeed(s) ? s : undefined;
}

/** True when the profile (a `--user-data-dir`) already answers the blank password check. */
export function profileHasPasswordCheckAnswer(userDataDir: string): boolean {
  return hasPasswordCheckAnswer(readJson(join(userDataDir, 'Local State')));
}

/** What {@link seedProfileLocalState} did. */
export type SeedOutcome = 'seeded' | 'had-answer' | 'no-seed' | 'unreadable' | 'unwritable';

/**
 * Gives a profile the seed's Local State, or merges the seed's answer into
 * the Local State it has. Never touches a profile that already answers, and
 * leaves an unreadable Local State to Chrome's own repair.
 */
export function seedProfileLocalState(userDataDir: string): SeedOutcome {
  const file = join(userDataDir, 'Local State');
  const exists = existsSync(file);
  const have = exists ? readJson(file) : undefined;
  if (exists && !have) return 'unreadable';
  if (hasPasswordCheckAnswer(have)) return 'had-answer';
  const seed = readTrustedSeed();
  if (!seed) return 'no-seed';
  const merged = {
    ...seed,
    ...(have ?? {}),
    password_manager: {
      ...((have?.['password_manager'] as State | undefined) ?? {}),
      ...(seed['password_manager'] as State),
    },
  };
  return writeAtomic(file, merged) ? 'seeded' : 'unwritable';
}

/**
 * Binaries that run the blank password check: the installed Chrome,
 * Chrome for Testing and Chromium. The headless shell
 * (`chrome-headless-shell`) never asks.
 */
export function runsPasswordCheck(binaryPath: string): boolean {
  const name = basename(binaryPath.replace(/\\/g, '/')).toLowerCase();
  return (
    name === 'chrome.exe' || name === 'chromium.exe' || name === 'chrome' || name === 'chromium'
  );
}

/** The `--user-data-dir` a Chrome command line names, or `null`. */
export function userDataDirFromArgs(args: readonly string[]): string | null {
  for (const a of args) {
    if (a.startsWith('--user-data-dir='))
      return a.slice('--user-data-dir='.length).replace(/^"|"$/g, '');
  }
  return null;
}

/** Thrown when a Chrome start on Windows would use a profile that has no answer to the blank password check. */
export class UnseededProfileError extends Error {
  readonly userDataDir: string;
  constructor(userDataDir: string, outcome: SeedOutcome) {
    super(
      [
        `refusing to start Chrome on an unseeded profile (${userDataDir}, seed: ${outcome}).`,
        'On Windows every such start costs one failed logon for the signed in account, and 10 in 10 minutes lock it.',
        `Make this machine's seed once (${localStateSeedPath()}): the test suites do it in test/support/seeded-chrome.ts,`,
        'see docs/stealth.md "Failed Windows logons".',
      ].join(' '),
    );
    this.name = 'UnseededProfileError';
    this.userDataDir = userDataDir;
  }
}

/** Whether an unseeded Windows start must be refused: under a test runner, or when asked. */
export function seedRequired(): boolean {
  return process.env['BGLS_REQUIRE_SEEDED_PROFILE'] === '1' || !!process.env['VITEST'];
}

/** Options for {@link prepareLocalState}; `platform` is for tests. */
export interface PrepareLocalStateOptions {
  readonly platform?: NodeJS.Platform;
}

/**
 * Runs right before a Chrome start. On Windows, seeds the profile named by
 * `--user-data-dir` (unless `BGLS_SEED_LOCAL_STATE=0`), then, when
 * {@link seedRequired}, refuses a start that would still ask Windows.
 * Elsewhere it does nothing: Chrome on macOS and Linux has no such check.
 */
export function prepareLocalState(
  binaryPath: string,
  args: readonly string[],
  opts: PrepareLocalStateOptions = {},
): SeedOutcome | 'skipped' {
  if ((opts.platform ?? process.platform) !== 'win32') return 'skipped';
  if (!runsPasswordCheck(binaryPath)) return 'skipped';
  const udd = userDataDirFromArgs(args);
  if (!udd) {
    // Chrome's own default profile: never ours to seed, and never right in a test.
    if (seedRequired()) throw new UnseededProfileError('(no --user-data-dir)', 'no-seed');
    return 'skipped';
  }
  const outcome: SeedOutcome =
    process.env['BGLS_SEED_LOCAL_STATE'] === '0'
      ? profileHasPasswordCheckAnswer(udd)
        ? 'had-answer'
        : 'no-seed'
      : seedProfileLocalState(udd);
  if (seedRequired() && outcome !== 'seeded' && outcome !== 'had-answer') {
    throw new UnseededProfileError(udd, outcome);
  }
  return outcome;
}
