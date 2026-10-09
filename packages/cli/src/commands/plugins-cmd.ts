/**
 * `bgls plugins add/list/remove`. `bgls plugins add` is a separate,
 * explicit, human typed command that fetches, verifies and records; every
 * later invocation reads what is already on disk. This
 * file composes `packages/cli/src/plugins/{fetch,integrity,load,record}.ts`,
 * which already do every real piece of work (parsing a source spec,
 * touching the network, hashing, importing, validating); this command is
 * the thin CLI shell around them, not new logic.
 *
 * **This is the only place a fetch is ever initiated.** `fetch.ts`'s own
 * header already says it is "the only file in this design that touches the
 * network", and `add` below is the only caller of `fetchPlugin()` anywhere
 * in `packages/cli/src/commands/`. `list` and `remove` never call it: list
 * reads `bgls-plugins.json` and runs `load.ts`'s verify-then-import-then-
 * probe lifecycle against what is already on disk (`probe()` is what
 * `bgls doctor` and `bgls plugins list` report), and remove
 * only edits the record and deletes a directory. Nothing here reaches for
 * a plugin it does not already have a pinned, hashed copy of.
 *
 * **Refusals are surfaced intact.** `parsePluginSource()` and
 * `fetchPlugin()` already write refusal and failure messages in the
 * right register (naming what was expected, not flattening to
 * "invalid source"); this command prints `reason` verbatim rather than
 * paraphrasing it, the same rule `attach.ts` follows for
 * `local-browser-discovery.ts`'s own detail strings.
 *
 * **Nothing that fails validation is ever written.** `add` writes a record
 * entry only after the fetched file has been hashed, imported once, and
 * had its manifest shape checked by `@browserglass/plugin-api`'s
 * `validatePluginManifest`, and only when its declared `platforms`
 * includes this machine's. A refusal at any of those steps writes nothing
 * to `bgls-plugins.json` and copies nothing into the data directory.
 */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_KINDS, type PluginKind, validatePluginManifest } from '@browserglass/plugin-api';
import { defineCommand } from 'citty';
import { GLOBAL_ARGS, type ParsedGlobalArgs, resolveGlobalFlags } from '../context.js';
import {
  type FetchedPlugin,
  PluginFetchError,
  fetchPlugin,
  parsePluginSource,
} from '../plugins/fetch.js';
import { hashPluginFile } from '../plugins/integrity.js';
import { type PluginLoadResult, loadPlugin, pluginEntryPath } from '../plugins/load.js';
import {
  type PluginRecordEntry,
  type PluginRecordSource,
  defaultPluginsFilePath,
  findPluginEntry,
  readPluginsFile,
  removePluginEntry,
  resolvePluginsFileForRead,
  upsertPluginEntry,
  writePluginsFile,
} from '../plugins/record.js';
import { defaultDataDir } from '../session-file.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

/** Said on every successful `add`, human and `--json` alike: the honest statement of what the boundary is and is not (the install prompt, and the equivalent note `attach.ts` prints on every successful attach). */
const PLUGIN_TRUST_NOTE =
  'this plugin now runs with your account\'s full authority whenever it is invoked (probe, encode, or assist): your files, your network, your keychain prompts. It is loaded only by "bgls", never by "bgls serve", and it never receives a CdpBridge or a CDP connection.';

const PLUGINS_DIR_ARGS = {
  'data-dir': {
    type: 'string',
    description:
      'Root data directory the fetched plugin file is stored under, by convention <data-dir>/plugins/... . Default ./bgls-data. Env BGLS_DATA_DIR.',
  },
  file: {
    type: 'string',
    description:
      'Path to bgls-plugins.json, the record of what is installed. Default <data-dir>/bgls-plugins.json. A ./bgls-plugins.json left in the current directory by an older bgls is still read when the data dir has none.',
  },
} as const;

function resolveDataDir(args: { 'data-dir'?: string }): string {
  return args['data-dir'] !== undefined ? resolve(args['data-dir']) : defaultDataDir();
}

/**
 * Where to read the record from and where to write it. An explicit
 * `--file` is both. Otherwise writes go to `<data-dir>/bgls-plugins.json`
 * and reads prefer that, falling back to a legacy `./bgls-plugins.json`
 * (`record.ts`'s `resolvePluginsFileForRead`).
 */
function resolveFilePaths(args: { file?: string; 'data-dir'?: string }): {
  readonly filePath: string;
  readonly readPath: string;
} {
  if (args.file !== undefined) {
    const p = resolve(args.file);
    return { filePath: p, readPath: p };
  }
  const dataDir = resolveDataDir(args);
  return {
    filePath: defaultPluginsFilePath(dataDir),
    readPath: resolvePluginsFileForRead(dataDir),
  };
}

function filePathArgs(args: unknown): [filePath: string, readPath: string] {
  const { filePath, readPath } = resolveFilePaths(args as { file?: string; 'data-dir'?: string });
  return [filePath, readPath];
}

// ── add ─────────────────────────────────────────────────────────────────

/** `bgls plugins add`'s payload on success. */
interface AddedResult {
  readonly added: true;
  readonly id: string;
  readonly kind: PluginKind;
  readonly source: PluginRecordSource;
  readonly entry: string;
  readonly integrity: string;
  readonly platforms: readonly NodeJS.Platform[];
  readonly summary: string;
  readonly addedAt: string;
  readonly note: string;
}

/** `bgls plugins add`'s payload on refusal or failure. `code` distinguishes a policy refusal (`E_PLUGIN_SOURCE_REFUSED`, `E_PLUGIN_PLATFORM`) from an operational failure (`E_PLUGIN_FETCH_FAILED`, `E_PLUGIN_LOAD_FAILED`, `E_PLUGIN_INVALID_MANIFEST`), but the human and `--json` message is always `reason`, unflattened. */
interface AddRefusedResult {
  readonly added: false;
  readonly code: string;
  readonly reason: string;
}

function refuseAdd(printer: Printer, code: string, reason: string): AddRefusedResult {
  const result: AddRefusedResult = { added: false, code, reason };
  printer.result(result, (r) => printer.error(r.reason));
  return result;
}

function formatSourceHuman(source: PluginRecordSource): string {
  switch (source.type) {
    case 'npm':
      return `npm ${source.version}`;
    case 'git':
      return `git+https ${source.url}#${source.commit.slice(0, 7)}`;
    case 'local':
      return `local ${source.path}`;
  }
}

function printAddedHuman(printer: Printer, r: AddedResult, filePath: string): void {
  printer.success(`installed "${r.id}" (${r.kind}) from ${formatSourceHuman(r.source)}`);
  printer.info(`  entry      ${r.entry}`);
  printer.info(`  integrity  ${r.integrity}`);
  printer.info(`  platforms  [${r.platforms.join(', ')}] (this machine: ${process.platform})`);
  printer.info(`  summary    ${r.summary}`);
  printer.info(`  recorded in ${filePath}`);
  printer.info(`  note       ${r.note}`);
}

/** `<dataDir>/plugins/<id, "/" replaced with "+">[@<version-or-short-commit>]/plugin.mjs`, the layout `docs/plugins.md` shows (`plugins/@browserglass+plugin-video-export@0.2.1/plugin.mjs`). */
function pluginDestRelativePath(id: string, versionOrCommit: string | null): string {
  const idSlug = id.replace(/\//g, '+');
  const suffix = versionOrCommit === null ? '' : `@${versionOrCommit}`;
  return `plugins/${idSlug}${suffix}/plugin.mjs`;
}

/**
 * `bgls plugins add`'s real work, factored out of the `citty` command for
 * testability. Composes, in order: {@link parsePluginSource} (refuse a bad
 * spec before touching anything), {@link fetchPlugin} (the one network
 * call), {@link hashPluginFile}, one `import()` of the freshly fetched file
 * to read and validate its own manifest, the platform gate, and finally
 * the record write. A refusal or failure at any step writes nothing.
 */
export async function runPluginsAdd(
  printer: Printer,
  sourceRaw: string,
  dataDir: string,
  filePath: string,
  readPath: string = filePath,
): Promise<number> {
  const parsed = parsePluginSource(sourceRaw);
  if (!parsed.ok) {
    refuseAdd(printer, 'E_PLUGIN_SOURCE_REFUSED', parsed.reason);
    return EXIT_CODES.usageError;
  }
  const source = parsed.source;

  let fetched: FetchedPlugin;
  try {
    fetched = fetchPlugin(source);
  } catch (err) {
    const code = err instanceof PluginFetchError ? err.code : 'E_PLUGIN_FETCH_FAILED';
    const reason = err instanceof Error ? err.message : String(err);
    refuseAdd(printer, code, reason);
    return EXIT_CODES.operationalFailure;
  }

  try {
    const integrity = hashPluginFile(fetched.entryPath);

    let imported: unknown;
    try {
      const mod = (await import(pathToFileURL(fetched.entryPath).href)) as { default?: unknown };
      imported = mod.default;
    } catch (err) {
      refuseAdd(
        printer,
        'E_PLUGIN_LOAD_FAILED',
        `"${sourceRaw}" was fetched, but its entry file did not load: ${err instanceof Error ? err.message : String(err)}`,
      );
      return EXIT_CODES.operationalFailure;
    }

    const validated = validatePluginManifest(imported);
    if (!validated.ok) {
      refuseAdd(
        printer,
        'E_PLUGIN_INVALID_MANIFEST',
        `"${sourceRaw}" was fetched, but its default export is not a valid plugin: ${validated.reason}. Not installed. Nothing was written.`,
      );
      return EXIT_CODES.operationalFailure;
    }
    const manifest = validated.manifest;

    if (!manifest.platforms.includes(process.platform)) {
      refuseAdd(
        printer,
        'E_PLUGIN_PLATFORM',
        `E_PLUGIN_PLATFORM: "${manifest.id}" declares platforms [${manifest.platforms.join(', ')}]; this machine is ${process.platform}. Not installed. Nothing was written.`,
      );
      return EXIT_CODES.usageError;
    }

    const folderTag =
      source.type === 'git' && fetched.resolved !== null
        ? fetched.resolved.slice(0, 7)
        : fetched.resolved;
    const destRelative = pluginDestRelativePath(manifest.id, folderTag);
    const destAbsolute = pluginEntryPath(dataDir, destRelative);
    if (destAbsolute === null) {
      refuseAdd(
        printer,
        'E_PLUGIN_INVALID_MANIFEST',
        `"${manifest.id}" is not a safe plugin id: its derived install path escapes the data directory (${dataDir}); refusing to write it. Not installed. Nothing was written.`,
      );
      return EXIT_CODES.operationalFailure;
    }

    const read = readPluginsFile(readPath);
    if (!read.ok) {
      printer.error(
        `${read.reason}; refusing to write a new entry into a file that does not already parse correctly. Fix or remove ${read.path} first.`,
      );
      return EXIT_CODES.preconditionFailed;
    }

    mkdirSync(dirname(destAbsolute), { recursive: true });
    copyFileSync(fetched.entryPath, destAbsolute);

    const recordSource: PluginRecordSource =
      source.type === 'npm'
        ? { type: 'npm', version: fetched.resolved ?? source.version }
        : source.type === 'git'
          ? { type: 'git', url: source.url, commit: fetched.resolved ?? source.commit }
          : { type: 'local', path: source.path };

    const entry: PluginRecordEntry = {
      id: manifest.id,
      kind: manifest.kind,
      source: recordSource,
      entry: destRelative,
      integrity,
      platforms: manifest.platforms,
      addedAt: new Date().toISOString(),
    };

    writePluginsFile(filePath, upsertPluginEntry(read.file, entry));

    const result: AddedResult = {
      added: true,
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      entry: entry.entry,
      integrity: entry.integrity,
      platforms: entry.platforms,
      summary: manifest.summary,
      addedAt: entry.addedAt,
      note: PLUGIN_TRUST_NOTE,
    };
    printer.result(result, (r) => printAddedHuman(printer, r, filePath));
    return EXIT_CODES.ok;
  } finally {
    if (fetched.cleanupDir !== null) {
      rmSync(fetched.cleanupDir, { recursive: true, force: true });
    }
  }
}

// ── list ────────────────────────────────────────────────────────────────

/** One row of `bgls plugins list`'s output: the recorded entry, plus exactly what `load.ts`'s lifecycle reports for it on this machine right now. Never a boolean; `status` is `load.ts`'s own vocabulary, unflattened. */
interface PluginListRow {
  readonly id: string;
  readonly kind: PluginKind;
  readonly source: PluginRecordSource;
  readonly entry: string;
  readonly platforms: readonly NodeJS.Platform[];
  readonly addedAt: string;
  readonly status: PluginLoadResult['status'];
  readonly reason: string | null;
  readonly summary: string | null;
  readonly probeDetail: string | null;
}

const STATUS_LABEL: Readonly<Record<PluginLoadResult['status'], string>> = {
  ready: 'READY',
  unusable: 'UNUSABLE',
  'not-applicable': 'NOT-APPLICABLE',
  'integrity-mismatch': 'INTEGRITY-MISMATCH',
  'load-failed': 'LOAD-FAILED',
  'unsupported-host-api': 'UNSUPPORTED-HOST-API',
  'probe-failed': 'PROBE-FAILED',
};

function toListRow(entry: PluginRecordEntry, result: PluginLoadResult): PluginListRow {
  const base = {
    id: entry.id,
    kind: entry.kind,
    source: entry.source,
    entry: entry.entry,
    platforms: entry.platforms,
    addedAt: entry.addedAt,
    status: result.status,
  };
  if (result.status === 'ready' || result.status === 'unusable') {
    return {
      ...base,
      reason: null,
      summary: result.plugin.summary,
      probeDetail: result.probe.detail,
    };
  }
  return { ...base, reason: result.reason, summary: null, probeDetail: null };
}

function printListHuman(printer: Printer, rows: readonly PluginListRow[]): void {
  if (rows.length === 0) {
    printer.info('no plugins installed. Install one with "bgls plugins add <spec>".');
    return;
  }
  for (const kind of PLUGIN_KINDS) {
    const forKind = rows.filter((r) => r.kind === kind);
    printer.info(`\n${kind}`);
    if (forKind.length === 0) {
      printer.info('  (none installed for this kind on this platform)');
      continue;
    }
    for (const r of forKind) {
      printer.info(`  ${r.id}  [${STATUS_LABEL[r.status]}]  ${formatSourceHuman(r.source)}`);
      const detail = r.reason ?? r.probeDetail;
      if (detail !== null) printer.info(`    ${detail}`);
      printer.info(
        `    entry: ${r.entry}, platforms: [${r.platforms.join(', ')}], added ${r.addedAt}`,
      );
    }
  }
}

/**
 * `bgls plugins list`'s real work. Reads `bgls-plugins.json` (an empty
 * record on a fresh project, not an error) and, for every recorded entry,
 * runs `load.ts`'s full lifecycle: platform gate, integrity verify,
 * import, validate, `probe()`. Never fetches anything; every entry it
 * inspects is already on disk.
 */
export async function runPluginsList(
  printer: Printer,
  dataDir: string,
  filePath: string,
): Promise<number> {
  const read = readPluginsFile(filePath);
  if (!read.ok) {
    printer.error(read.reason);
    return EXIT_CODES.preconditionFailed;
  }

  const rows = await Promise.all(
    read.file.plugins.map(async (entry) =>
      toListRow(entry, await loadPlugin(entry, dataDir, entry.kind)),
    ),
  );

  printer.result({ plugins: rows }, (r) => printListHuman(printer, r.plugins));
  return EXIT_CODES.ok;
}

// ── remove ──────────────────────────────────────────────────────────────

/** `bgls plugins remove`'s payload. */
type RemoveResult =
  | { readonly removed: true; readonly id: string; readonly entry: string }
  | { readonly removed: false; readonly id: string; readonly reason: string };

/**
 * `bgls plugins remove`'s real work: a line removal from `bgls-plugins.json`
 * plus a best-effort directory removal under the data directory
 * (uninstall is a line removal plus a directory removal). The record write is authoritative; a failure to
 * delete the now-orphaned file on disk is not reported as a failure of the
 * command, since the plugin is already untrusted and unreachable through
 * `bgls-plugins.json` the moment the record write lands.
 */
export async function runPluginsRemove(
  printer: Printer,
  id: string,
  dataDir: string,
  filePath: string,
  readPath: string = filePath,
): Promise<number> {
  const read = readPluginsFile(readPath);
  if (!read.ok) {
    printer.error(read.reason);
    return EXIT_CODES.preconditionFailed;
  }

  const entry = findPluginEntry(read.file, id);
  if (entry === undefined) {
    const result: RemoveResult = {
      removed: false,
      id,
      reason: `no plugin named "${id}" is recorded in ${filePath}`,
    };
    printer.result(result, (r) => printer.error((r as { reason: string }).reason));
    return EXIT_CODES.usageError;
  }

  writePluginsFile(filePath, removePluginEntry(read.file, id));

  const absEntryPath = pluginEntryPath(dataDir, entry.entry);
  if (absEntryPath !== null) {
    rmSync(dirname(absEntryPath), { recursive: true, force: true });
  }

  const result: RemoveResult = { removed: true, id, entry: entry.entry };
  printer.result(result, (r) =>
    printer.success(
      `removed "${(r as { id: string }).id}" from ${filePath} and deleted its stored entry file.`,
    ),
  );
  return EXIT_CODES.ok;
}

// ── citty wiring ───────────────────────────────────────────────────────

export const pluginsAddCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Fetch, verify and record one plugin. The only command in this CLI that ever fetches a plugin: nothing else, including "bgls plugins list", touches the network.',
  },
  args: {
    ...GLOBAL_ARGS,
    ...PLUGINS_DIR_ARGS,
    source: {
      type: 'positional',
      description:
        'Plugin source: an npm spec pinned to an exact version ("name@1.2.3"), a git+https URL pinned to a full 40 character commit sha ("git+https://host/repo.git#<sha>"), or a local directory path. A branch, a tag, a version range, git+ssh, git:// and plain http:// are all refused.',
      required: true,
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    try {
      process.exitCode = await runPluginsAdd(
        printer,
        args['source'] as string,
        resolveDataDir(args as { 'data-dir'?: string }),
        ...filePathArgs(args),
      );
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.operationalFailure;
    }
  },
});

export const pluginsListCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'Show every installed plugin: which extension point it serves, whether it is usable on this machine right now, and its pinned source.',
  },
  args: { ...GLOBAL_ARGS, ...PLUGINS_DIR_ARGS },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    try {
      process.exitCode = await runPluginsList(
        printer,
        resolveDataDir(args as { 'data-dir'?: string }),
        resolveFilePaths(args as { file?: string; 'data-dir'?: string }).readPath,
      );
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.operationalFailure;
    }
  },
});

export const pluginsRemoveCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove one plugin from bgls-plugins.json and delete its stored entry file.',
  },
  args: {
    ...GLOBAL_ARGS,
    ...PLUGINS_DIR_ARGS,
    id: {
      type: 'positional',
      description: 'Plugin id, as recorded in bgls-plugins.json ("bgls plugins list" shows it).',
      required: true,
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    try {
      process.exitCode = await runPluginsRemove(
        printer,
        args['id'] as string,
        resolveDataDir(args as { 'data-dir'?: string }),
        ...filePathArgs(args),
      );
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.operationalFailure;
    }
  },
});

/** `bgls plugins`: optional, explicitly installed extension points. See `docs/plugins.md`. */
export const pluginsCommand = defineCommand({
  meta: {
    name: 'plugins',
    description:
      'Install, list and remove optional BrowserGlass plugins (frame-encoder, permission-assist). See docs/plugins.md.',
  },
  subCommands: {
    add: pluginsAddCommand,
    list: pluginsListCommand,
    remove: pluginsRemoveCommand,
  },
});
