/**
 * `bgls-plugins.json`: the file that remembers what was installed, from
 * where, and at which hash. This
 * module is its whole read/write/validate surface: `JSON.parse` and
 * `JSON.stringify` only, no network, and no `import()` of anything the
 * record names, which is `load.ts`'s job (stage 2) and not this file's.
 *
 * WHY the record is treated as untrusted on read even though this process
 * is usually the one that wrote it: a file on disk can be edited by
 * anything with write access to it, and `bgls-plugins.json` (which lives
 * under the data directory, {@link defaultPluginsFilePath}) can equally
 * have been hand edited, copied between machines, or tampered with. The same reasoning
 * `@browserglass/plugin-api`'s `validate.ts` gives for a plugin's own
 * manifest applies here one layer up: "the host validates the object it
 * actually got rather than casting a type onto it". A record whose
 * `integrity` field lies about a hash would otherwise defeat the whole
 * verification story, so every field is checked, not merely
 * typed.
 *
 * Absence and corruption are reported differently on purpose (the rule that a degraded state is reported rather than silently
 * absent, applied here to two different degradations):
 *
 * - No file at all is the normal starting state for an operator who has
 *   never run `bgls plugins add`. {@link readPluginsFile} reads that as an
 *   empty record (`{ version: 1, plugins: [] }`) with no error at all,
 *   the same way `probeLocalBrowserCandidate`'s "not found" is a normal
 *   outcome and not a thrown error.
 * - A file that exists but does not parse as JSON, or parses but does not
 *   match the expected shape, is corruption: a human can act on it, so it
 *   is reported with the file's own path and a reason naming what is
 *   wrong, and {@link readPluginsFile} never invents a fallback value for
 *   it. Silently treating a corrupt record as empty would make an
 *   operator's real, tampered-with or truncated trust record disappear
 *   without a trace, which is the "silently succeeding with less" failure
 *   this whole design exists to prevent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type PluginKind, isPluginKind } from '@browserglass/plugin-api';
import { DIGEST_PREFIX } from './integrity.js';

/** The filename this record is always named, wherever it lives. */
export const PLUGINS_FILENAME = 'bgls-plugins.json';

/** The only `version` value this module understands. A future breaking change to the record shape bumps this and this module refuses anything else, the same way `hostApi` gates a plugin. */
export const PLUGINS_FILE_VERSION = 1;

/** Where a plugin's code came from, and the immutable coordinate recorded for each source kind (npm gets a version, git gets a 40-hex commit, local gets an absolute path). */
export type PluginRecordSource =
  | { readonly type: 'npm'; readonly version: string }
  | { readonly type: 'git'; readonly url: string; readonly commit: string }
  | { readonly type: 'local'; readonly path: string };

/** One installed plugin, exactly the shape of one record entry. */
export interface PluginRecordEntry {
  readonly id: string;
  readonly kind: PluginKind;
  readonly source: PluginRecordSource;
  /** Relative to the resolved data directory (`defaultDataDir()`, `session-file.ts`). Never an absolute path: the record names a location under the data directory, not a location on disk. */
  readonly entry: string;
  /** `sha512-<base64>`, verified against the entry file's actual bytes by `integrity.ts` on every load. */
  readonly integrity: string;
  readonly platforms: readonly NodeJS.Platform[];
  /** ISO 8601 timestamp, set once when `bgls plugins add` wrote this entry. */
  readonly addedAt: string;
}

/** The full contents of `bgls-plugins.json`. */
export interface PluginsFile {
  readonly version: typeof PLUGINS_FILE_VERSION;
  readonly plugins: readonly PluginRecordEntry[];
}

/** The empty record: what a missing file reads as, and what `bgls plugins add` starts from on a fresh project. */
export const EMPTY_PLUGINS_FILE: PluginsFile = { version: PLUGINS_FILE_VERSION, plugins: [] };

/** {@link validatePluginsFile}'s answer. */
export type PluginsFileValidation =
  | { readonly ok: true; readonly file: PluginsFile }
  | { readonly ok: false; readonly reason: string };

/** 40 lowercase or uppercase hex characters: a git commit sha, never a branch or a tag (only an exact commit is accepted). */
const COMMIT_SHA_RE = /^[0-9a-fA-F]{40}$/;

function fail(reason: string): PluginsFileValidation {
  return { ok: false, reason };
}

/** Validates one entry's `source` field against the three shapes {@link PluginRecordSource} allows, naming the entry's `id` in any failure so it is findable in a large record. */
function validateSource(
  id: string,
  value: unknown,
): { ok: true; source: PluginRecordSource } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: `plugin "${id}": "source" is not an object` };
  }
  const s = value as Record<string, unknown>;
  if (s['type'] === 'npm') {
    if (typeof s['version'] !== 'string' || s['version'] === '') {
      return { ok: false, reason: `plugin "${id}": npm source is missing a non-empty "version"` };
    }
    return { ok: true, source: { type: 'npm', version: s['version'] } };
  }
  if (s['type'] === 'git') {
    if (typeof s['url'] !== 'string' || s['url'] === '') {
      return { ok: false, reason: `plugin "${id}": git source is missing a non-empty "url"` };
    }
    if (typeof s['commit'] !== 'string' || !COMMIT_SHA_RE.test(s['commit'])) {
      return {
        ok: false,
        reason: `plugin "${id}": git source "commit" must be a 40 character hex commit sha, got ${JSON.stringify(s['commit'])}`,
      };
    }
    return { ok: true, source: { type: 'git', url: s['url'], commit: s['commit'] } };
  }
  if (s['type'] === 'local') {
    if (typeof s['path'] !== 'string' || s['path'] === '') {
      return { ok: false, reason: `plugin "${id}": local source is missing a non-empty "path"` };
    }
    return { ok: true, source: { type: 'local', path: s['path'] } };
  }
  return {
    ok: false,
    reason: `plugin "${id}": "source.type" must be "npm", "git" or "local", got ${JSON.stringify(s['type'])}`,
  };
}

/** Validates one array element from `plugins` against {@link PluginRecordEntry}. */
function validateEntry(
  value: unknown,
  index: number,
): { ok: true; entry: PluginRecordEntry } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: `plugins[${index}] is not an object` };
  }
  const e = value as Record<string, unknown>;
  if (typeof e['id'] !== 'string' || e['id'] === '') {
    return { ok: false, reason: `plugins[${index}]: missing or invalid "id"` };
  }
  const id = e['id'];
  if (!isPluginKind(e['kind'])) {
    return {
      ok: false,
      reason: `plugin "${id}": "kind" must be "frame-encoder" or "permission-assist", got ${JSON.stringify(e['kind'])}`,
    };
  }
  const source = validateSource(id, e['source']);
  if (!source.ok) return source;
  if (typeof e['entry'] !== 'string' || e['entry'] === '') {
    return { ok: false, reason: `plugin "${id}": missing or invalid "entry"` };
  }
  if (
    typeof e['integrity'] !== 'string' ||
    !e['integrity'].startsWith(DIGEST_PREFIX) ||
    e['integrity'] === DIGEST_PREFIX
  ) {
    return {
      ok: false,
      reason: `plugin "${id}": "integrity" must be a "${DIGEST_PREFIX}<base64>" digest string`,
    };
  }
  if (
    !Array.isArray(e['platforms']) ||
    e['platforms'].length === 0 ||
    !e['platforms'].every((p) => typeof p === 'string')
  ) {
    return {
      ok: false,
      reason: `plugin "${id}": "platforms" must be a non-empty array of platform strings`,
    };
  }
  if (typeof e['addedAt'] !== 'string' || Number.isNaN(Date.parse(e['addedAt']))) {
    return { ok: false, reason: `plugin "${id}": "addedAt" must be an ISO 8601 timestamp string` };
  }
  return {
    ok: true,
    entry: {
      id,
      kind: e['kind'],
      source: source.source,
      entry: e['entry'],
      integrity: e['integrity'],
      platforms: e['platforms'] as readonly NodeJS.Platform[],
      addedAt: e['addedAt'],
    },
  };
}

/**
 * Checks that `candidate` (typically `JSON.parse`'s own output) has the
 * shape {@link PluginsFile} requires, entry by entry. Never throws: a
 * malformed record comes back as `{ ok: false, reason }` so the caller can
 * report it and refuse, the same rule `@browserglass/plugin-api`'s
 * `validatePluginManifest` follows for a plugin's own manifest.
 */
export function validatePluginsFile(candidate: unknown): PluginsFileValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return fail('bgls-plugins.json does not contain a JSON object');
  }
  const c = candidate as Record<string, unknown>;
  if (c['version'] !== PLUGINS_FILE_VERSION) {
    return fail(
      `bgls-plugins.json "version" must be ${PLUGINS_FILE_VERSION}, got ${JSON.stringify(c['version'])}`,
    );
  }
  if (!Array.isArray(c['plugins'])) {
    return fail('bgls-plugins.json "plugins" must be an array');
  }
  const plugins: PluginRecordEntry[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < c['plugins'].length; i++) {
    const validated = validateEntry(c['plugins'][i], i);
    if (!validated.ok) return fail(validated.reason);
    if (seenIds.has(validated.entry.id)) {
      return fail(`bgls-plugins.json lists "${validated.entry.id}" more than once`);
    }
    seenIds.add(validated.entry.id);
    plugins.push(validated.entry);
  }
  return { ok: true, file: { version: PLUGINS_FILE_VERSION, plugins } };
}

/** {@link readPluginsFile}'s answer. */
export type PluginsFileReadResult =
  | { readonly ok: true; readonly file: PluginsFile }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * Reads and validates `path`. A missing file is the normal empty state and
 * comes back `{ ok: true, file: EMPTY_PLUGINS_FILE }`, never an error. A
 * file that exists but fails to parse or fails validation comes back
 * `{ ok: false, path, reason }`, naming this exact file so a human can go
 * look at it (see this module's doc comment for why the two are kept
 * apart).
 */
export function readPluginsFile(path: string): PluginsFileReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: true, file: EMPTY_PLUGINS_FILE };
    }
    return { ok: false, path, reason: `could not read ${path}: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, path, reason: `${path} is not valid JSON: ${(err as Error).message}` };
  }

  const validated = validatePluginsFile(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      path,
      reason: `${path} does not match the expected bgls-plugins.json shape: ${validated.reason}`,
    };
  }
  return { ok: true, file: validated.file };
}

/**
 * Writes `file` to `path` as pretty printed JSON, creating the parent
 * directory if needed. Always writes a value that would itself read back
 * as `ok: true` from {@link readPluginsFile}, since this module is the
 * only writer and a record it cannot read back is a bug here, not
 * elsewhere.
 */
export function writePluginsFile(path: string, file: PluginsFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * Absolute path to `bgls-plugins.json` under `dataDir`, beside the plugin
 * files it names (`<dataDir>/plugins/...`) and every other piece of local
 * state. It used to live in the current working directory, which put a
 * machine specific file (a `local` source records an absolute path) at
 * the root of whatever repository `bgls plugins add` happened to run in.
 */
export function defaultPluginsFilePath(dataDir: string): string {
  return join(dataDir, PLUGINS_FILENAME);
}

/** Where `bgls-plugins.json` was written before it moved under the data directory: the current working directory. Read only, as a fallback. */
export function legacyPluginsFilePath(cwd: string = process.cwd()): string {
  return join(cwd, PLUGINS_FILENAME);
}

/**
 * The record a reader should use when no explicit `--file` was given: the
 * one under `dataDir` when it exists, otherwise a legacy one in `cwd` when
 * that exists, otherwise the `dataDir` path (which then reads as the empty
 * record). Writers always write {@link defaultPluginsFilePath}; once they
 * have, the new file shadows the legacy one for every reader.
 */
export function resolvePluginsFileForRead(dataDir: string, cwd: string = process.cwd()): string {
  const current = defaultPluginsFilePath(dataDir);
  if (existsSync(current)) return current;
  const legacy = legacyPluginsFilePath(cwd);
  if (existsSync(legacy)) return legacy;
  return current;
}

/** Finds the entry with this `id`, or `undefined`. Ids are unique within a valid {@link PluginsFile} ({@link validatePluginsFile} refuses a duplicate). */
export function findPluginEntry(file: PluginsFile, id: string): PluginRecordEntry | undefined {
  return file.plugins.find((p) => p.id === id);
}

/** Returns a new {@link PluginsFile} with `entry` added, replacing any existing entry of the same `id`. Pure: `file` is not mutated. */
export function upsertPluginEntry(file: PluginsFile, entry: PluginRecordEntry): PluginsFile {
  const withoutExisting = file.plugins.filter((p) => p.id !== entry.id);
  return { version: PLUGINS_FILE_VERSION, plugins: [...withoutExisting, entry] };
}

/** Returns a new {@link PluginsFile} with the entry named `id` removed. A no-op (still a new object) if no entry has that id. Pure: `file` is not mutated. */
export function removePluginEntry(file: PluginsFile, id: string): PluginsFile {
  return { version: PLUGINS_FILE_VERSION, plugins: file.plugins.filter((p) => p.id !== id) };
}
