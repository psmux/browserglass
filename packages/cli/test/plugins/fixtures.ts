/**
 * Shared plugin fixture generation for `load.test.ts` and
 * `registry.test.ts`. Not itself a test file (no `.test.` in its name, so
 * vitest's default include glob never collects it).
 *
 * A fixture is a real `.mjs` file written to a real temp directory and
 * hashed with the same {@link hashPluginFile} `load.ts` uses, so every
 * test here exercises the actual verify-then-import path rather than a
 * mock of it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashPluginFile } from '../../src/plugins/integrity.js';
import type { PluginRecordEntry, PluginRecordSource } from '../../src/plugins/record.js';

/**
 * The `@browserglass/plugin-api` version this test run is actually built
 * against, read the same way `load.ts`'s own `hostApiVersion()` does.
 * Fixtures declare their `hostApi` relative to this rather than a
 * hand-copied literal, so the suite does not silently start failing the
 * next time that package's version bumps.
 */
export function installedPluginApiVersion(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve('@browserglass/plugin-api/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string };
  return pkg.version;
}

/** A caret range that the installed `@browserglass/plugin-api` version satisfies, for fixtures meant to load successfully. */
export function satisfyingHostApi(): string {
  return `^${installedPluginApiVersion()}`;
}

/** A caret range far outside the installed version, for fixtures meant to fail the `hostApi` check. */
export const UNSATISFIABLE_HOST_API = '^999.0.0';

export interface FixtureSourceOptions {
  readonly id: string;
  readonly kind: 'frame-encoder' | 'permission-assist';
  readonly hostApi?: string;
  readonly platforms?: readonly NodeJS.Platform[];
  readonly summary?: string;
  /** JS statements for the body of `probe()`. Default: resolves `{ usable: true, detail: 'fixture usable' }`. */
  readonly probeBody?: string;
  /** JS statements for the body of `encode()` (frame-encoder only). Default: resolves `outcome: 'unsupported'`. */
  readonly encodeBody?: string;
  /** JS statements for the body of `assist()` (permission-assist only). Default: resolves `outcome: 'unavailable'`. */
  readonly assistBody?: string;
  /**
   * If set, the module writes this exact path at IMPORT time (top level,
   * before the default export is even read), so a test can assert
   * `import()` did or did not run by checking whether this file exists:
   * a behavioural proof, not just an inspected status string, of the
   * verify-before-import ordering `load.ts`'s module doc claims.
   */
  readonly importMarkerPath?: string;
}

/** Renders a real, importable plugin module for {@link FixtureSourceOptions}. */
export function buildFixtureSource(opts: FixtureSourceOptions): string {
  const platforms = opts.platforms ?? (['darwin', 'linux', 'win32'] as const);
  const marker = opts.importMarkerPath
    ? `import { writeFileSync as __markImported } from 'node:fs';\n__markImported(${JSON.stringify(opts.importMarkerPath)}, 'imported');\n`
    : '';
  const verb =
    opts.kind === 'frame-encoder'
      ? `  encode: async (req, signal) => {\n    ${opts.encodeBody ?? "return { outcome: 'unsupported', detail: 'fixture', bytesWritten: 0 };"}\n  },\n`
      : `  assist: async (s, signal) => {\n    ${opts.assistBody ?? "return { outcome: 'unavailable', detail: 'fixture' };"}\n  },\n`;
  return `${marker}export default {\n  id: ${JSON.stringify(opts.id)},\n  kind: ${JSON.stringify(opts.kind)},\n  hostApi: ${JSON.stringify(opts.hostApi ?? satisfyingHostApi())},\n  platforms: ${JSON.stringify(platforms)},\n  summary: ${JSON.stringify(opts.summary ?? 'fixture plugin')},\n  probe: async () => {\n    ${opts.probeBody ?? "return { usable: true, detail: 'fixture usable' };"}\n  },\n${verb}};\n`;
}

/** A fresh temp directory standing in for the CLI's data directory, tracked for cleanup by the caller. */
export function makeTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'bgls-plugins-load-test-'));
}

/** Writes `source` at `<dataDir>/<relativeEntry>` and returns the absolute path, creating parent directories as needed. */
export function writeFixtureFile(dataDir: string, relativeEntry: string, source: string): string {
  const absPath = join(dataDir, relativeEntry);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, source, 'utf8');
  return absPath;
}

/** Removes a directory tree created by {@link makeTempDataDir}. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface FixtureEntryOptions extends FixtureSourceOptions {
  /** Path relative to `dataDir`, matching `PluginRecordEntry.entry`'s own contract. Default: `"plugins/<id>/plugin.mjs"`. */
  readonly relativeEntry?: string;
  readonly source?: PluginRecordSource;
  /** Overrides the computed hash, e.g. to construct a tampered record deliberately. */
  readonly integrityOverride?: string;
}

/**
 * Writes a fixture plugin into `dataDir` and returns the matching
 * {@link PluginRecordEntry} an operator's `bgls-plugins.json` would carry
 * for it, hash included, the single call most of `load.test.ts` and
 * `registry.test.ts` build their setup from.
 */
export function writeFixturePlugin(dataDir: string, opts: FixtureEntryOptions): PluginRecordEntry {
  const relativeEntry =
    opts.relativeEntry ?? `plugins/${opts.id.replace(/[^a-z0-9.-]+/gi, '_')}/plugin.mjs`;
  const source = buildFixtureSource(opts);
  const absPath = writeFixtureFile(dataDir, relativeEntry, source);
  const integrity = opts.integrityOverride ?? hashPluginFile(absPath);
  return {
    id: opts.id,
    kind: opts.kind,
    source: opts.source ?? { type: 'local', path: dataDir },
    entry: relativeEntry,
    integrity,
    platforms: opts.platforms ?? (['darwin', 'linux', 'win32'] as const),
    addedAt: '2026-09-01T00:00:00.000Z',
  };
}
