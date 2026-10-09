/**
 * Turns one `bgls-plugins.json` entry into a running plugin, or into a
 * reported reason it is not one right now. This is the whole of
 * the plugin lifecycle, steps 1 through 5:
 * platform gate, verify, `await import()`, validate, `probe()` under a
 * deadline. Steps 6 (`encode()`/`assist()`) and 7 (report, never crash)
 * belong to whoever calls this module with the plugin it returns; this
 * file's own promise is that everything up to and including `probe()`
 * either succeeds or comes back as one of the named facts below, and never
 * throws past its own boundary.
 *
 * **Verification before import, unconditionally.** What is on disk is
 * verified against a digest on every load, before the module is imported,
 * and a mismatch refuses rather than warns. That
 * ordering is the one thing in this file that must never be reordered, so
 * it is worth being explicit about why it is safe here: {@link loadPlugin}
 * calls {@link verifyPluginFile} and returns on a mismatch *before* the
 * first line that could possibly reach `import()` executes, on any code
 * path. There is no branch in this function in which a hash mismatch and
 * an `import()` both happen. Getting this order wrong is, per the design
 * document, what makes every other control here decorative, so
 * `load.test.ts` checks it behaviourally, not just by asserting a status
 * string: its tampered-plugin fixtures write a marker file as a top-level
 * import side effect, and the test asserts that marker was never created,
 * which would catch an import happening on a tampered file even if this
 * comment ever became a lie.
 *
 * **No sandbox.** Once `import()` runs, the plugin's module body executes
 * with this process's full authority, and nothing below builds or claims
 * otherwise: no `node:vm`, no `worker_threads`, no dropped-privilege child
 * process. All three are refused explicitly, and the reason is
 * repeated here rather than only in the design document because this is
 * the one file where a reader might reasonably expect a boundary and there
 * is none to find. What this file *does* guarantee, by construction: the
 * plugin's `probe()` (and, for whoever calls `encode()`/`assist()` next,
 * those two) never receives a `CdpBridge`, a `Session`, a `ControlLease`,
 * a target id, or a CDP session id, because no parameter of any function
 * in this module ever carries one and this file never holds one to pass.
 *
 * **The deadline decision.** `probe()`'s own interface
 * (`PluginManifest.probe(): Promise<PluginProbe>`) takes no
 * `AbortSignal`, there is nothing to hand a probe implementation that
 * would let it cancel itself cooperatively. So the deadline here is
 * honest about what it can and cannot do: {@link withDeadline} stops this
 * process *waiting* on a plugin call once its budget elapses and reports
 * a `'probe-failed'` result, but it cannot forcibly halt code already
 * running in this address space, that would require exactly the sandbox
 * this design refuses to claim. A `probe()` that never settles therefore
 * leaves one abandoned, unref'd timer and one abandoned promise behind
 * (its eventual settlement, if any, is silently discarded), and the CLI
 * itself is free to continue and exit; nothing here keeps the process
 * alive waiting on it. `encode()` and `assist()` do take an
 * `AbortSignal` in their own interfaces precisely so a *cooperative*
 * plugin can stop early; {@link withDeadline} is exported so their future
 * callers (stage 5's `--video`, stage 6's `bgls attach` integration) can
 * apply the same "stop waiting, report, walk away" policy with their own
 * budgets (`probe()` 3000ms, `assist()` 15000ms, `encode()` uncapped) without re-deriving it.
 */

import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type PluginKind,
  type PluginProbe,
  type ValidatedPlugin,
  validatePluginManifest,
} from '@browserglass/plugin-api';
import { verifyPluginFile } from './integrity.js';
import type { PluginRecordEntry } from './record.js';

/** `probe()` has no `AbortSignal` of its own to cancel by, so this is purely "how long this process waits before giving up and reporting failure" (see this module's doc comment). */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * Every way {@link loadPlugin} can end. Five failure facts:
 * missing, wrong version, fails verification, fails to load, throws, plus
 * the platform gate and the two live outcomes, kept as
 * distinct tags on purpose: a caller that collapses these into one boolean
 * is the exact failure mode this avoids, and `registry.ts` (and every
 * later `bgls doctor`/`bgls plugins list` reader) depends on being able to
 * tell them apart.
 *
 * "Missing" itself (no record entry at all for a kind) is not a case of
 * this type, there is no entry to call {@link loadPlugin} with in that
 * situation. It is `registry.ts`'s `'absent'` state.
 */
export type PluginLoadResult =
  /** Gate 2 (platform): the record's own `platforms` does not include `process.platform`, or the plugin's own manifest disagrees with the record about that once it is read. Reported, never hidden, but also never hashed, imported, or executed to find out. */
  | { readonly status: 'not-applicable'; readonly reason: string }
  /** The one hard stop: the file on disk does not match the hash `bgls plugins add` recorded. `import()` never ran. */
  | { readonly status: 'integrity-mismatch'; readonly reason: string }
  /** `import()` threw, the default export is missing or malformed, `id` disagrees with the record, or the entry file itself could not be found on disk. */
  | { readonly status: 'load-failed'; readonly reason: string }
  /** The plugin loaded and validated, but its declared `hostApi` range does not admit this host's own `@browserglass/plugin-api` contract version. Not called. */
  | {
      readonly status: 'unsupported-host-api';
      readonly reason: string;
      readonly declared: string;
      readonly hostApiVersion: string;
    }
  /** `probe()` itself threw, or did not return within {@link PROBE_TIMEOUT_MS} (see this module's doc comment on what "timeout" can and cannot do here). */
  | { readonly status: 'probe-failed'; readonly plugin: ValidatedPlugin; readonly reason: string }
  /** Loaded, validated, and `probe()` reports `usable: true`. */
  | { readonly status: 'ready'; readonly plugin: ValidatedPlugin; readonly probe: PluginProbe }
  /** Loaded, validated, and `probe()` itself honestly reports `usable: false` (e.g. no system ffmpeg). This is not a failure of this module; it is the plugin answering "not right now" the way `PluginProbe` asks it to. */
  | { readonly status: 'unusable'; readonly plugin: ValidatedPlugin; readonly probe: PluginProbe };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Races `promise` against `timeoutMs`. On timeout the returned promise
 * rejects with a {@link PluginTimeoutError}; `promise` itself is left
 * running (see this module's doc comment: there is nothing to cancel it
 * with) and its eventual settlement, whenever it comes, is discarded
 * rather than left to surface as an unhandled rejection.
 *
 * The timer is `unref()`'d so an abandoned wait can never by itself keep
 * the CLI process alive past whatever else it was doing, "a wedged
 * plugin is a wedged CLI" describes the failure this line
 * exists to prevent.
 *
 * Exported so a future caller of `encode()`/`assist()` (both of which,
 * unlike `probe()`, accept an `AbortSignal` a well-behaved plugin can
 * actually act on) can apply the same policy with its own budget.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolveOuter, rejectOuter) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectOuter(new PluginTimeoutError(`${label} did not return within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveOuter(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectOuter(err);
      },
    );
  });
}

/** Thrown by {@link withDeadline} on expiry. Never thrown past {@link loadPlugin}'s own boundary; it is always converted to a `'probe-failed'` result. */
export class PluginTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginTimeoutError';
  }
}

// ── The host's own contract version ────────────────────────────────────

let cachedHostApiVersion: string | null = null;

/**
 * The version of `@browserglass/plugin-api` this CLI was actually built
 * and installed against, read from that package's own `package.json`:
 * the same `require.resolve('@browserglass/<name>/package.json')` pattern
 * `bgls doctor`'s `packageVersion` already uses
 * (`packages/cli/src/doctor/checks.ts`). Not a constant hand-copied from
 * `packages/plugin-api/package.json`, because a hand-copied string is
 * exactly the kind of duplication that drifts silently the next time that
 * package's version bumps.
 */
function hostApiVersion(): string {
  if (cachedHostApiVersion !== null) return cachedHostApiVersion;
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve('@browserglass/plugin-api/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { readonly version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(
      `@browserglass/plugin-api's own package.json (${pkgJsonPath}) has no "version" string`,
    );
  }
  cachedHostApiVersion = pkg.version;
  return cachedHostApiVersion;
}

// ── A narrow semver reader, caret ranges only ──────────────────────────
//
// `PluginManifest.hostApi` is typed as a plain `string`
// (a semver range of the host contract this plugin was built against),
// with no further grammar specified. This loader is where that string's meaning is decided, so the
// decision is made once, here, and documented rather than left implicit:
// only a caret range ("^x.y.z", optionally with a prerelease tag, the
// exact form every dependency in every package.json in this repository
// already uses, and the form the reference plugin declares:
// `HOST_API_RANGE = "^0.1.0-alpha.0"`) is understood. A tilde range, an
// exact pin, an `x`-range, a comparator, or an OR-range is refused with a
// message naming what would have been accepted, the same "deny wins,
// name what was expected" shape `isArgAllowed`
// (`packages/protocol/src/domain/arg-lists.ts:64`) and `fetch.ts`'s own
// URL grammar use. Writing a general semver range parser to cover forms
// nothing in this design ever produces would be exactly the kind of
// abstraction this project's build order argues against building ahead
// of a real second caller.

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated identifiers after the `-`, or `[]` for no prerelease tag. */
  readonly prerelease: readonly string[];
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

function parseSemVer(input: string): SemVer | null {
  const m = SEMVER_RE.exec(input);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** Semver precedence for one dot-separated prerelease identifier: numeric identifiers compare numerically and always sort before any alphanumeric identifier, per the semver 2.0.0 spec. */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aIsNum = /^\d+$/.test(a);
  const bIsNum = /^\d+$/.test(b);
  if (aIsNum && bIsNum) return Number(a) - Number(b);
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A version with no prerelease outranks one with a prerelease, otherwise identifiers compare left to right. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const c = comparePrereleaseIdentifier(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** The exclusive upper bound of `^v`: npm's own caret rule, including the 0.x special cases that make a pre-1.0 range narrower than its major-version-only reading would suggest. */
function caretUpperBound(v: SemVer): SemVer {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: v.patch + 1, prerelease: [] };
}

/** {@link hostApiSatisfies}'s answer. */
type HostApiCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Checks whether `hostVersion` (the host's own resolved
 * `@browserglass/plugin-api` version) is admitted by `range` (a plugin's
 * declared `hostApi`), under the caret-only grammar this module documents
 * above.
 */
function hostApiSatisfies(range: string, hostVersion: string): HostApiCheck {
  const trimmed = range.trim();
  if (!trimmed.startsWith('^')) {
    return {
      ok: false,
      reason: `only a caret range ("^x.y.z", e.g. "^${hostVersion}") is understood as a hostApi range; got ${JSON.stringify(range)}`,
    };
  }
  const lower = parseSemVer(trimmed.slice(1));
  if (!lower) {
    return {
      ok: false,
      reason: `hostApi ${JSON.stringify(range)} is not a valid caret semver range`,
    };
  }
  const host = parseSemVer(hostVersion);
  if (!host) {
    return {
      ok: false,
      reason: `internal: host contract version ${JSON.stringify(hostVersion)} is not valid semver`,
    };
  }

  // npm's own rule for a prerelease version: it only satisfies a range
  // that itself names a prerelease on the exact same [major, minor,
  // patch] tuple. Without this, a plugin built against one alpha of the
  // host contract would silently be accepted by every later alpha too,
  // even ones that changed the contract out from under it.
  if (host.prerelease.length > 0) {
    const sameTuple =
      host.major === lower.major && host.minor === lower.minor && host.patch === lower.patch;
    if (!sameTuple || lower.prerelease.length === 0) {
      return {
        ok: false,
        reason: `host contract version ${hostVersion} is a prerelease and only satisfies a hostApi range that names a prerelease on the same ${lower.major}.${lower.minor}.${lower.patch}`,
      };
    }
  }

  const upper = caretUpperBound(lower);
  const ok = compareSemVer(host, lower) >= 0 && compareSemVer(host, upper) < 0;
  return ok
    ? { ok: true }
    : {
        ok: false,
        reason: `hostApi ${JSON.stringify(range)} does not admit the host's contract version ${hostVersion}`,
      };
}

// ── The loader itself ───────────────────────────────────────────────────

/** Resolves `entry.entry` (always relative, `record.ts`'s `PluginRecordEntry` doc: "Never an absolute path") against `dataDir`, and refuses a resolution that escapes it. A `bgls-plugins.json` on disk is untrusted input (see `record.ts`'s own module doc), so a hand-edited or corrupted `entry` naming `"../../../../etc/something"` is checked for here rather than trusted to `record.ts`'s shape validation, which only confirms `entry` is *a* string. */
function resolveEntryPath(
  dataDir: string,
  entryRelative: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const root = resolvePath(dataDir);
  const resolved = resolvePath(root, entryRelative);
  const withinRoot = resolved === root || resolved.startsWith(root + sep);
  if (!withinRoot) {
    return {
      ok: false,
      reason: `plugin entry path "${entryRelative}" resolves outside the data directory (${root}); refusing rather than reading it`,
    };
  }
  return { ok: true, path: resolved };
}

/**
 * Runs the load lifecycle (steps 1 through 5) for one record
 * entry: platform gate, verify, import, validate, probe. `expectedKind`
 * is the kind the caller actually wants (`registry.ts` calls this once
 * per extension point); it is checked against both `entry.kind` and the
 * loaded manifest's own `kind`, so a record that was hand-edited to
 * misdeclare its kind is caught the same way a misdeclared `id` is.
 *
 * Never throws. Every failure mode (missing (not this function's case; see `PluginLoadResult`'s doc),
 * wrong version, fails verification, fails to load, throws, comes back
 * as a distinct {@link PluginLoadResult} tag instead.
 */
export async function loadPlugin(
  entry: PluginRecordEntry,
  dataDir: string,
  expectedKind: PluginKind,
  probeTimeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PluginLoadResult> {
  try {
    if (entry.kind !== expectedKind) {
      return {
        status: 'load-failed',
        reason: `plugin "${entry.id}" is recorded as kind "${entry.kind}", not the requested "${expectedKind}"`,
      };
    }

    // Gate 2 (platform): filtered on the RECORD's own platforms, before
    // anything on disk is even located, let alone hashed or imported.
    if (!entry.platforms.includes(process.platform)) {
      return {
        status: 'not-applicable',
        reason: `"${entry.id}" declares platforms [${entry.platforms.join(', ')}]; this machine is ${process.platform}`,
      };
    }

    const resolvedPath = resolveEntryPath(dataDir, entry.entry);
    if (!resolvedPath.ok) {
      return { status: 'load-failed', reason: resolvedPath.reason };
    }
    const absPath = resolvedPath.path;

    try {
      statSync(absPath);
    } catch {
      return {
        status: 'load-failed',
        reason: `"${entry.id}"'s entry file is missing on disk at ${absPath}; run "bgls plugins verify" to check every plugin`,
      };
    }

    // Verify, unconditionally before the next line: a digest
    // mismatch returns here and `import()` (below) never runs on this
    // code path.
    if (!verifyPluginFile(absPath, entry.integrity)) {
      return {
        status: 'integrity-mismatch',
        reason: `"${entry.id}"'s entry file at ${absPath} does not match the recorded integrity hash; refusing to import it. This is either a corrupted install or the file has been replaced since "bgls plugins add" ran, reinstall with "bgls plugins add" to re-record it, do not simply re-trust it.`,
      };
    }

    let imported: unknown;
    try {
      const fileUrl = pathToFileURL(absPath).href;
      const mod = (await import(/* @vite-ignore */ fileUrl)) as { default?: unknown };
      imported = mod.default;
    } catch (err) {
      console.error('BGLSDEBUG import failed', absPath, pathToFileURL(absPath).href, err);
      return { status: 'load-failed', reason: `"${entry.id}" did not load (${errorMessage(err)})` };
    }

    const validated = validatePluginManifest(imported);
    if (!validated.ok) {
      console.error('BGLSDEBUG validate failed', absPath, validated.reason);
      return {
        status: 'load-failed',
        reason: `"${entry.id}"'s default export is not a valid plugin: ${validated.reason}`,
      };
    }
    const manifest = validated.manifest;

    if (manifest.id !== entry.id) {
      return {
        status: 'load-failed',
        reason: `"${entry.id}" is recorded under that id, but its own manifest declares id ${JSON.stringify(manifest.id)}; refusing to trust a plugin whose identity does not match its record`,
      };
    }
    if (manifest.kind !== expectedKind) {
      return {
        status: 'load-failed',
        reason: `"${entry.id}"'s manifest declares kind "${manifest.kind}", not the requested "${expectedKind}"`,
      };
    }
    // Defense in depth against gate 2 above: the RECORD said this
    // platform was fine, but the plugin's own manifest is closer to
    // ground truth (it comes from inside the verified, imported module,
    // not from a possibly hand-edited JSON file). A disagreement here is
    // reported the same quiet way as any other platform mismatch, not as
    // an error, because from a caller's point of view it is the same
    // fact: this plugin does not run here.
    if (!manifest.platforms.includes(process.platform)) {
      return {
        status: 'not-applicable',
        reason: `"${entry.id}"'s own manifest declares platforms [${manifest.platforms.join(', ')}], which does not include ${process.platform}, though the record claimed it did`,
      };
    }

    const hostApiCheck = hostApiSatisfies(manifest.hostApi, hostApiVersion());
    if (!hostApiCheck.ok) {
      return {
        status: 'unsupported-host-api',
        reason: hostApiCheck.reason,
        declared: manifest.hostApi,
        hostApiVersion: hostApiVersion(),
      };
    }

    let probe: PluginProbe;
    try {
      probe = await withDeadline(manifest.probe(), probeTimeoutMs, `"${entry.id}".probe()`);
    } catch (err) {
      return { status: 'probe-failed', plugin: manifest, reason: errorMessage(err) };
    }

    return probe.usable
      ? { status: 'ready', plugin: manifest, probe }
      : { status: 'unusable', plugin: manifest, probe };
  } catch (err) {
    console.error('BGLSDEBUG unexpected', err);
    // Lifecycle step 7: anything thrown at any step becomes a reported
    // result, never a crash. Every branch above already returns rather
    // than throws; this is the backstop for whatever this function's
    // author did not anticipate.
    return {
      status: 'load-failed',
      reason: `unexpected error loading "${entry.id}": ${errorMessage(err)}`,
    };
  }
}

/** Exposes the same path resolution {@link loadPlugin} uses internally, so a caller (e.g. `bgls plugins list`) can print where an entry would be read from, or confirm a record entry is even resolvable, without duplicating the escape check. Returns `null` for the same reason {@link loadPlugin} would refuse: the resolved path escapes `dataDir`. */
export function pluginEntryPath(dataDir: string, entryRelative: string): string | null {
  const resolved = resolveEntryPath(dataDir, entryRelative);
  return resolved.ok ? resolved.path : null;
}
