/**
 * The only file in the plugin design that touches the network, and the
 * file every source refusal has to pass through before `bgls plugins add` writes anything.
 *
 * Two jobs live here, kept deliberately separate:
 *
 * 1. {@link parsePluginSource} turns a spec string a human typed into a
 *    {@link PluginSource}, or refuses it. This is pure string parsing: no
 *    filesystem, no process, no network. It runs deny-first the way
 *    `isArgAllowed` does (`packages/protocol/src/domain/arg-lists.ts:67`):
 *    a known-bad form (`git+ssh://`, `git://`, plain `http://`, a branch, a
 *    tag, an npm range) is named and refused explicitly, and anything that
 *    matches none of the accepted shapes is refused too, deny winning by
 *    construction rather than by an exhaustive list of things to check for.
 * 2. {@link fetchPlugin} and its three per-kind helpers
 *    ({@link fetchNpmPackage}, {@link fetchGitCommit},
 *    {@link fetchLocalPlugin}) do the actual `npm pack` extraction or
 *    `git+https` clone at a pinned sha, following
 *    `packages/runtime-host/src/binary-discovery.ts`'s own posture:
 *    resolve platform-specific tooling explicitly, verify what came back
 *    rather than trusting it, and fail with every path searched rather
 *    than a bare "not found".
 *
 * **Why hashing and `bgls-plugins.json` are not here.** This file resolves
 * a source to one entry file on disk and stops. `integrity.ts` computes the
 * sha512 of that file; `record.ts` writes the JSON record. Splitting them
 * is deliberate, not a preference: three narrow files are
 * each independently readable, and this one is the one a reviewer most
 * needs to be able to read start to finish.
 *
 * **Why this file is safe to shell out from.** Every `execFileSync` call
 * below passes an argument array, never a string a shell re-parses. `git`
 * and `npm pack`'s own spec argument arrive as one `argv` element each, so
 * a spec string cannot break out into a second command no matter what
 * characters it contains, the same property `binary-discovery.ts`'s
 * `execFileSync('reg.exe', [...])` calls already have. `parsePluginSource`
 * additionally refuses anything containing a character outside a strict
 * allowlist *before* it ever reaches an `execFileSync` call, which is
 * belt-and-suspenders: the process boundary would already stop an
 * injection, and the allowlist means a malicious spec never gets that far
 * to find out.
 *
 * **Why `npm` is invoked as `node <npm-cli.js> pack …` rather than
 * `execFileSync('npm', …)`.** On Windows, `npm` on `PATH` is `npm.cmd`, a
 * batch file, and Node refuses to `execFile` a `.cmd` without `shell:
 * true` (a hardening change against Windows batch-argument injection).
 * `shell: true` is exactly what this file must never use. `npm` ships its
 * own real JavaScript entry point (`npm-cli.js`) next to every Node.js
 * install, and running that directly with `process.execPath` reaches the
 * same `npm pack` with no shell involved on any platform.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

// ── Plugin source: parsing and refusal ─────────────────────────────────

/** An npm package pinned to one exact version. npm is the default source. */
export interface PluginSourceNpm {
  readonly type: 'npm';
  readonly name: string;
  readonly version: string;
}

/** A `git+https://` source pinned to a full 40 hex character commit sha. The escape hatch, never the default. */
export interface PluginSourceGit {
  readonly type: 'git';
  readonly url: string;
  readonly commit: string;
}

/** A local directory, for plugin authors developing against their own build. Always normalised to an absolute path. */
export interface PluginSourceLocal {
  readonly type: 'local';
  readonly path: string;
}

export type PluginSource = PluginSourceNpm | PluginSourceGit | PluginSourceLocal;

/** {@link parsePluginSource}'s answer. Never throws: a bad spec comes back as `{ ok: false, reason }`, the same shape `@browserglass/plugin-api`'s `validatePluginManifest` uses for a bad manifest. */
export type PluginSourceParseResult =
  | { readonly ok: true; readonly source: PluginSource }
  | { readonly ok: false; readonly reason: string };

function refused(reason: string): PluginSourceParseResult {
  return { ok: false, reason };
}

// A local directory is recognised by shape alone: a relative `./`/`../`
// prefix, a POSIX-rooted path, a Windows drive letter, or a UNC share.
// Nothing else is treated as "probably a path", an npm name or a git URL
// never starts with any of these, so there is no ambiguous case to guess
// at.
const LOCAL_PATH_RE = /^(?:\.{1,2}[\\/]|[\\/]{1,2}|[A-Za-z]:[\\/])/;

// npm's own package name grammar, simplified to the shape this design
// accepts: lowercase, digits, `.`, `_`, `-`, with an optional `@scope/`.
// Deliberately does not allow the characters npm itself forbids in a name
// (upper case, `~`, `'`, spaces, …), which doubles as the injection
// allowlist: nothing outside this set reaches `execFileSync`.
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// An *exact* semver: no `^`, `~`, `x`, `*`, `latest`, or range. "Exact
// version" means the recorded thing cannot resolve to
// something different on the next install, the same argument that
// applies to a commit sha.
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;
const SHORT_SHA_RE = /^[0-9a-fA-F]{7,39}$/;

// A restrictive allowlist for the URL half of a `git+https://` source:
// letters, digits, and the small set of characters a host or path
// legitimately needs. No query string, no fragment (the fragment is
// already split off as the commit), no shell metacharacter of any kind.
const GIT_HTTPS_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+$/;

function parseNpmSource(spec: string): PluginSourceParseResult {
  // A scoped name's own "@" (the scope marker) must not be mistaken for
  // the version separator, so the search for the version's "@" starts
  // after index 0 rather than at index 0.
  const searchFrom = spec.startsWith('@') ? 1 : 0;
  const at = spec.indexOf('@', searchFrom);
  const name = at === -1 ? spec : spec.slice(0, at);
  const version = at === -1 ? undefined : spec.slice(at + 1);

  if (!NPM_NAME_RE.test(name)) {
    return refused(
      `"${name}" is not a valid npm package name; refused rather than passed to npm unexamined`,
    );
  }
  if (version === undefined || version.length === 0) {
    return refused(
      `an npm plugin source must pin an exact version, e.g. "${name}@1.2.3"; omitting the version (or writing "latest") makes the recorded hash meaningless the same way an unpinned git ref would`,
    );
  }
  if (!EXACT_VERSION_RE.test(version)) {
    return refused(
      `"${version}" is not an exact semver version; an npm source must pin one exact version (e.g. "1.2.3"), not a range, a dist-tag, or anything else that can resolve to a different package tomorrow`,
    );
  }
  return { ok: true, source: { type: 'npm', name, version } };
}

function parseGitHttpsSource(spec: string): PluginSourceParseResult {
  const withoutPrefix = spec.slice('git+'.length); // "https://…#<ref>"
  const hashIndex = withoutPrefix.lastIndexOf('#');
  if (hashIndex === -1) {
    return refused(
      `a git source must name a commit after "#", e.g. "git+https://host/repo.git#<40-hex-commit-sha>"; found no "#" in "${spec}"`,
    );
  }
  const url = withoutPrefix.slice(0, hashIndex);
  const ref = withoutPrefix.slice(hashIndex + 1);

  if (!GIT_HTTPS_URL_RE.test(url)) {
    return refused(
      `"${url}" is not a valid https git URL (only letters, digits, ".", "-", "_", "~", "/" and an optional port are accepted in the host and path); refused rather than passed to git unexamined`,
    );
  }

  if (FULL_SHA_RE.test(ref)) {
    return { ok: true, source: { type: 'git', url, commit: ref.toLowerCase() } };
  }
  if (SHORT_SHA_RE.test(ref)) {
    return refused(
      `"${ref}" is ${ref.length} hex characters, too short to be a full commit sha; a git source must be pinned to a full 40 character commit sha, because a short sha is ambiguous and can resolve to a different commit as the repository grows`,
    );
  }
  // Deny wins the same way it does in isArgAllowed (arg-lists.ts:67): a
  // branch or a tag is not distinguished from any other unrecognised ref
  // here, because the reason for refusing all three is identical.
  return refused(
    `"${ref}" is not a 40 character commit sha; a git source must be pinned to a full 40 character commit sha, a branch or tag can move and would make the recorded hash meaningless`,
  );
}

function parseLocalSource(spec: string): PluginSourceParseResult {
  // Recorded as an absolute path, so a relative spec typed
  // at a particular working directory still means the same thing when
  // `bgls-plugins.json` is read back later from a different one.
  return { ok: true, source: { type: 'local', path: resolvePath(process.cwd(), spec) } };
}

/**
 * Parses an operator-typed plugin source spec into a {@link PluginSource},
 * or refuses it with a message a human can act on. Implements every
 * source refusal:
 *
 * - `git+ssh://`, `git://`, and plain `http://` (with or without the
 *   `git+` prefix) are refused by name, before any URL parsing happens.
 * - `git+https://` at anything other than a full 40 hex character commit
 *   sha (a branch, a tag, a short sha) is refused, with a distinct message
 *   for the short-sha case because that mistake is easy to make and easy
 *   to explain.
 * - An npm spec with no version, a version range, or a dist-tag like
 *   `"latest"` is refused; only an exact `name@1.2.3` is accepted.
 * - Anything matching none of the three accepted shapes is refused with
 *   the full list of what would have been accepted.
 *
 * Never throws and never touches the filesystem, the network, or a child
 * process: refusal here happens by parsing a string, before there is
 * anything to inject into.
 */
export function parsePluginSource(specRaw: string): PluginSourceParseResult {
  const spec = specRaw.trim();
  if (spec.length === 0) {
    return refused('empty plugin source');
  }

  if (spec.startsWith('git+')) {
    if (spec.startsWith('git+https://')) {
      return parseGitHttpsSource(spec);
    }
    const scheme = spec.slice('git+'.length).split(':')[0] || spec;
    return refused(
      `only "git+https://" is an accepted plugin source; "git+${scheme}" carries no authenticated transport (git+ssh, git://, and plain http:// are all refused for the same reason)`,
    );
  }

  // A bare git://, ssh://, or http:// with no "git+" prefix gets the same
  // refusal it would get with one, named explicitly rather than falling
  // through to the generic "not recognised" message.
  const bareScheme = /^(git|ssh|http):\/\//.exec(spec);
  if (bareScheme) {
    return refused(
      `"${bareScheme[1]}://" is not an accepted plugin source; use "git+https://host/repo.git#<40-hex-commit-sha>" for a git source, or an npm package spec ("name@1.2.3")`,
    );
  }

  if (LOCAL_PATH_RE.test(spec)) {
    return parseLocalSource(spec);
  }

  return parseNpmSource(spec);
}

// ── Fetch: turning a validated source into one entry file on disk ─────

/** Thrown by {@link fetchPlugin} and its per-kind helpers for anything that goes wrong while actually fetching (as opposed to `parsePluginSource`'s refusals, which are policy, not failure). */
export class PluginFetchError extends Error {
  readonly code = 'E_PLUGIN_FETCH_FAILED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginFetchError';
  }
}

/** What a fetch produced: one entry file, ready for the caller (`integrity.ts`, then `record.ts`) to hash and copy into the data directory. */
export interface FetchedPlugin {
  /** Absolute path to the resolved entry file, still sitting in a scratch location. */
  readonly entryPath: string;
  /** A directory the caller must remove once it has copied `entryPath` out (via e.g. `rmSync(cleanupDir, { recursive: true, force: true })`). `null` for a local source, which fetched nothing and created nothing. */
  readonly cleanupDir: string | null;
  /** The exact version (npm) or commit sha (git) this resolved to, for the caller's own record. `null` for a local source, which has no version of its own. */
  readonly resolved: string | null;
}

const GIT_TIMEOUT_MS = 120_000; // generous enough for a slow clone of a small repo; finite so a hung fetch cannot hang "bgls plugins add" forever
const NPM_PACK_TIMEOUT_MS = 120_000; // same reasoning, for a slow registry round trip
const TAR_TIMEOUT_MS = 30_000; // purely local decompression once the tarball is already on disk

function describeExecError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === 'string' && e.stderr.trim().length > 0) return e.stderr.trim();
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

function isEnoentError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * Reads the entry a fetched plugin's own `package.json` declares (its
 * `"main"` field, falling back to npm's own default of `"index.js"`), and
 * confirms the file actually exists. This is the declared entry file: the
 * host trusts what the plugin's own manifest names
 * as its entry, then verifies it rather than assuming it.
 */
function resolveEntryFile(packageRoot: string): string {
  const pkgJsonPath = join(packageRoot, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new PluginFetchError(`fetched plugin has no package.json at its root (${packageRoot})`);
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new PluginFetchError(
      `fetched plugin's package.json is not valid JSON: ${describeExecError(err)}`,
      {
        cause: err,
      },
    );
  }
  const main = typeof pkg['main'] === 'string' && pkg['main'].length > 0 ? pkg['main'] : 'index.js';
  const entryPath = join(packageRoot, main);
  if (!existsSync(entryPath)) {
    throw new PluginFetchError(
      `fetched plugin declares entry "${main}" in package.json but ${entryPath} does not exist`,
    );
  }
  return entryPath;
}

/**
 * Locates npm's own `npm-cli.js` next to the Node.js binary running this
 * process, so `npm pack` can be run as `node <npm-cli.js> pack …` with no
 * shell (see this module's header for why `execFileSync('npm', …)` does
 * not work on Windows). Two layouts cover every install this repository
 * supports: npm sitting beside `node.exe` (the Windows and most
 * single-prefix installs), and npm under `<prefix>/lib/node_modules` next
 * to a `<prefix>/bin/node` (the common POSIX prefix layout). First hit
 * wins, the same rule `binary-discovery.ts`'s `candidateList` uses.
 */
function resolveNpmCli(): string {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new PluginFetchError(
    `could not find npm's own npm-cli.js next to this Node.js installation (searched: ${candidates.join(', ')}); an npm plugin source requires the npm that ships with this Node.js runtime`,
  );
}

function runGit(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args as string[], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (isEnoentError(err)) {
      throw new PluginFetchError(
        'git was not found on PATH; a git+https plugin source requires git to be installed on this machine',
        { cause: err },
      );
    }
    throw new PluginFetchError(`git ${args.join(' ')} failed: ${describeExecError(err)}`, {
      cause: err,
    });
  }
}

/**
 * Clones `url` shallow at exactly `commit` (`--depth 1` at the sha),
 * verifies the
 * checkout actually landed on that sha, removes `.git` before anything
 * else is read, and resolves the declared entry file.
 *
 * Exported (not merely called by {@link fetchPlugin}) so a test can drive
 * it directly against a local fixture repository, per this design's own
 * instruction to test fetch mechanics hermetically rather than against the
 * real network: a `url` here is anything `git remote add origin` accepts,
 * including a plain filesystem path to a local repository, since git's own
 * remote transport treats a local path as a first-class remote with no
 * network involved.
 */
export function fetchGitCommit(url: string, commit: string): FetchedPlugin {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-plugin-git-'));
  try {
    runGit(dir, ['init', '--quiet', '.']);
    runGit(dir, ['remote', 'add', 'origin', url]);
    // A modern git server (GitHub included) can fetch an arbitrary
    // reachable commit by its sha, not only a branch tip, which is what
    // makes a --depth 1 fetch of a pinned sha possible at all. A server
    // that refuses this fails here with git's own error, not a silent
    // fallback to a full clone.
    runGit(dir, ['fetch', '--quiet', '--depth', '1', 'origin', commit]);
    runGit(dir, ['checkout', '--quiet', commit]);
    const head = runGit(dir, ['rev-parse', 'HEAD']).trim().toLowerCase();
    if (head !== commit.toLowerCase()) {
      // Should be unreachable (checkout of an exact sha lands on that sha
      // by definition), and is checked anyway: the pinned sha is the
      // entire security argument for a git source, so this file never
      // takes "it probably worked" on faith.
      throw new PluginFetchError(
        `checked out commit does not match the pinned sha (pinned ${commit}, checked out ${head}); refusing to trust this checkout`,
      );
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  // The .git directory is removed before anything is read:
  // history, other refs, and any hooks the repository shipped are gone
  // before the plugin's own files are opened.
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  const entryPath = resolveEntryFile(dir);
  return { entryPath, cleanupDir: dir, resolved: commit.toLowerCase() };
}

/**
 * Packs and extracts an npm spec (`"name@1.2.3"`, or a local directory
 * path for hermetic testing, since `npm pack` accepts either) with no
 * dependency resolution: `npm pack` alone, never `npm install`, so a
 * plugin's declared zero runtime dependencies are never fetched
 * transitively (install is fetch and extract, with no dependency
 * resolution).
 *
 * Exported for the same hermetic-testing reason as {@link fetchGitCommit}:
 * `npm pack` run against a local fixture directory touches no network at
 * all, which is what makes this file's own test suite able to exercise
 * the real extraction path without the real registry.
 */
export function fetchNpmPackage(spec: string): FetchedPlugin {
  const packDir = mkdtempSync(join(tmpdir(), 'bgls-plugin-npm-pack-'));
  const extractDir = mkdtempSync(join(tmpdir(), 'bgls-plugin-npm-extract-'));
  try {
    const npmCli = resolveNpmCli();
    let stdout: string;
    try {
      stdout = execFileSync(
        process.execPath,
        [npmCli, 'pack', spec, '--pack-destination', packDir, '--json'],
        {
          encoding: 'utf8',
          timeout: NPM_PACK_TIMEOUT_MS,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      throw new PluginFetchError(`npm pack ${spec} failed: ${describeExecError(err)}`, {
        cause: err,
      });
    }

    let packed: unknown;
    try {
      packed = JSON.parse(stdout);
    } catch (err) {
      throw new PluginFetchError(
        `npm pack ${spec} did not print valid JSON: ${describeExecError(err)}`,
        {
          cause: err,
        },
      );
    }
    if (!Array.isArray(packed) || packed.length === 0) {
      throw new PluginFetchError(`npm pack ${spec} reported no packed tarball`);
    }
    const entry = packed[0] as Record<string, unknown>;
    const filename = entry['filename'];
    const version = entry['version'];
    if (typeof filename !== 'string' || typeof version !== 'string') {
      throw new PluginFetchError(
        `npm pack ${spec} produced an unexpected --json shape (no string "filename"/"version")`,
      );
    }

    const tgzPath = join(packDir, filename);
    try {
      // The archive is named relative to the extract directory, never by
      // its absolute path. GNU tar reads a colon in an -f argument as a
      // "host:file" remote tape, so a Windows path like "C:\..." would
      // send it looking for a host named "C". GNU tar's --force-local
      // avoids that, but the tar that ships with Windows itself
      // (System32\tar.exe, bsdtar) rejects --force-local outright, and
      // which of the two comes first on PATH varies from one machine to
      // the next. Both temp directories come from the same tmpdir(), so
      // the relative path never crosses a drive and never carries a
      // colon, and every tar accepts it. The destination is the child
      // process's own `cwd` for the same reason: no path for tar to
      // misparse.
      execFileSync('tar', ['-xzf', relative(extractDir, tgzPath)], {
        cwd: extractDir,
        timeout: TAR_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new PluginFetchError(`extracting ${filename} failed: ${describeExecError(err)}`, {
        cause: err,
      });
    }

    const packageRoot = join(extractDir, 'package'); // npm's own tarball layout: every entry lives under "package/"
    const entryPath = resolveEntryFile(packageRoot);
    return { entryPath, cleanupDir: extractDir, resolved: version };
  } catch (err) {
    rmSync(extractDir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

/** Resolves the declared entry file of a plugin already on disk. No network, no process, nothing to fetch. */
export function fetchLocalPlugin(path: string): FetchedPlugin {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new PluginFetchError(`local plugin source "${path}" is not a directory`);
  }
  return { entryPath: resolveEntryFile(path), cleanupDir: null, resolved: null };
}

/**
 * Dispatches a validated {@link PluginSource} to the fetcher for its kind.
 * The only code path in this design that reaches the network, and it runs
 * exclusively from `bgls plugins add`, a command a human types. Nothing
 * is fetched at run time.
 */
export function fetchPlugin(source: PluginSource): FetchedPlugin {
  switch (source.type) {
    case 'npm':
      return fetchNpmPackage(`${source.name}@${source.version}`);
    case 'git':
      return fetchGitCommit(source.url, source.commit);
    case 'local':
      return fetchLocalPlugin(source.path);
  }
}
