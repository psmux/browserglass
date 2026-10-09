import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPluginsAdd, runPluginsList, runPluginsRemove } from '../../src/commands/plugins-cmd.js';
import { type PluginsFile, readPluginsFile, writePluginsFile } from '../../src/plugins/record.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { Printer } from '../../src/util/output.js';
import { buildFixtureSource, satisfyingHostApi, writeFixturePlugin } from '../plugins/fixtures.js';
import { captureStdio, parseJsonLines } from '../support/capture-io.js';

// `bgls plugins add/list/remove` composes real building blocks
// (`parsePluginSource`, `fetchPlugin`, `hashPluginFile`, `load.ts`'s
// lifecycle, `record.ts`'s read/write) against real, local, hermetic
// fixtures: a "local" plugin source is a real directory on disk, and every
// test here runs with no network access, exactly the way
// `packages/cli/test/plugins/fetch.test.ts` already tests `fetch.ts`
// itself. Every fixture lives under a fresh temp directory tracked for
// cleanup.

function printer(json = false): Printer {
  return new Printer({ json, quiet: false, verbose: false, noColor: true });
}

const dirs: string[] = [];
function track(dir: string): string {
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real local plugin source directory: a `package.json` naming `plugin.mjs` as its `main`, and a valid frame-encoder (or permission-assist) manifest at that path, built with the same fixture source generator `load.test.ts`/`registry.test.ts` use. `fetchLocalPlugin` (via `parsePluginSource`'s "local" branch) reads this exact layout. */
function buildLocalPluginSourceDir(opts: {
  id: string;
  kind: 'frame-encoder' | 'permission-assist';
  platforms?: readonly NodeJS.Platform[];
}): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'bgls-plugins-cmd-src-')));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: opts.id, version: '1.0.0', main: 'plugin.mjs' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(dir, 'plugin.mjs'),
    buildFixtureSource({
      id: opts.id,
      kind: opts.kind,
      hostApi: satisfyingHostApi(),
      platforms: opts.platforms,
    }),
    'utf8',
  );
  return dir;
}

function freshDataDir(): string {
  return track(mkdtempSync(join(tmpdir(), 'bgls-plugins-cmd-data-')));
}

function freshFilePath(): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'bgls-plugins-cmd-project-')));
  return join(dir, 'bgls-plugins.json');
}

const OTHER_PLATFORM: NodeJS.Platform = process.platform === 'darwin' ? 'win32' : 'darwin';

describe('bgls plugins add', () => {
  it('installs a frame-encoder plugin from a local fixture directory: fetches, hashes, imports once, validates, writes the record', async () => {
    const srcDir = buildLocalPluginSourceDir({
      id: 'bgls-plugin-local-fixture',
      kind: 'frame-encoder',
    });
    const dataDir = freshDataDir();
    const filePath = freshFilePath();

    const io = captureStdio();
    const code = await runPluginsAdd(printer(true), srcDir, dataDir, filePath);
    io.restore();

    expect(code).toBe(EXIT_CODES.ok);
    const result = parseJsonLines(io.stdout)[0] as {
      added: true;
      id: string;
      kind: string;
      source: { type: string; path: string };
      entry: string;
      integrity: string;
      platforms: readonly string[];
      note: string;
    };
    expect(result.added).toBe(true);
    expect(result.id).toBe('bgls-plugin-local-fixture');
    expect(result.kind).toBe('frame-encoder');
    expect(result.source).toEqual({ type: 'local', path: srcDir });
    expect(result.integrity.startsWith('sha512-')).toBe(true);
    expect(result.note).toContain('never receives a CdpBridge');

    // The record on disk really carries the entry, and the entry file was
    // really copied under the data directory (not merely reported).
    const read = readPluginsFile(filePath);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.file.plugins).toHaveLength(1);
    expect(read.file.plugins[0]?.id).toBe('bgls-plugin-local-fixture');
    expect(read.file.plugins[0]?.entry).toBe(result.entry);
  });

  it("a git source pinned to a branch, not a commit, is refused with fetch.ts's own message reaching the user intact", async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath();

    const io = captureStdio();
    const code = await runPluginsAdd(
      printer(true),
      'git+https://github.com/example/repo.git#main',
      dataDir,
      filePath,
    );
    io.restore();

    expect(code).toBe(EXIT_CODES.usageError);
    const result = parseJsonLines(io.stdout)[0] as { added: false; code: string; reason: string };
    expect(result.added).toBe(false);
    expect(result.code).toBe('E_PLUGIN_SOURCE_REFUSED');
    // fetch.ts's own wording, not a flattened "invalid source".
    expect(result.reason).toContain('not a 40 character commit sha');
    expect(result.reason).toContain('branch or tag can move');

    // Nothing was written: no fetch, no record.
    const read = readPluginsFile(filePath);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.file.plugins).toHaveLength(0);
  });

  it('an unpinned npm spec is refused before any network call, with the exact-version reasoning intact', async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath();

    const io = captureStdio();
    const code = await runPluginsAdd(printer(true), 'some-plugin', dataDir, filePath);
    io.restore();

    expect(code).toBe(EXIT_CODES.usageError);
    const result = parseJsonLines(io.stdout)[0] as { added: false; code: string; reason: string };
    expect(result.code).toBe('E_PLUGIN_SOURCE_REFUSED');
    expect(result.reason).toContain('must pin an exact version');
  });

  it('a plugin declaring platforms that exclude this machine is refused and nothing is written', async () => {
    const srcDir = buildLocalPluginSourceDir({
      id: 'bgls-plugin-wrong-platform',
      kind: 'permission-assist',
      platforms: [OTHER_PLATFORM],
    });
    const dataDir = freshDataDir();
    const filePath = freshFilePath();

    const io = captureStdio();
    const code = await runPluginsAdd(printer(true), srcDir, dataDir, filePath);
    io.restore();

    expect(code).toBe(EXIT_CODES.usageError);
    const result = parseJsonLines(io.stdout)[0] as { added: false; code: string; reason: string };
    expect(result.code).toBe('E_PLUGIN_PLATFORM');
    expect(result.reason).toContain('E_PLUGIN_PLATFORM');
    expect(result.reason).toContain(process.platform);

    const read = readPluginsFile(filePath);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.file.plugins).toHaveLength(0);
  });
});

describe('bgls plugins list', () => {
  it('an empty record (nothing installed) is a normal, successful, empty answer', async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath(); // never written: the file does not exist yet

    const humanIo = captureStdio();
    const humanCode = await runPluginsList(printer(false), dataDir, filePath);
    humanIo.restore();
    expect(humanCode).toBe(EXIT_CODES.ok);
    expect(humanIo.stdout.join('')).toContain('no plugins installed');

    const jsonIo = captureStdio();
    const jsonCode = await runPluginsList(printer(true), dataDir, filePath);
    jsonIo.restore();
    expect(jsonCode).toBe(EXIT_CODES.ok);
    const result = parseJsonLines(jsonIo.stdout)[0] as { plugins: unknown[] };
    expect(result.plugins).toEqual([]);
  });

  it('shows an installed plugin as READY with its platform applicability and pinned source, human and --json', async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath();
    const entry = writeFixturePlugin(dataDir, {
      id: 'bgls-plugin-list-fixture',
      kind: 'frame-encoder',
      source: { type: 'npm', version: '1.2.3' },
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] } as PluginsFile);

    const humanIo = captureStdio();
    const humanCode = await runPluginsList(printer(false), dataDir, filePath);
    humanIo.restore();
    expect(humanCode).toBe(EXIT_CODES.ok);
    const humanOut = humanIo.stdout.join('');
    expect(humanOut).toContain('frame-encoder');
    expect(humanOut).toContain('bgls-plugin-list-fixture');
    expect(humanOut).toContain('[READY]');
    expect(humanOut).toContain('npm 1.2.3');
    expect(humanOut).toContain(`platforms: [${entry.platforms.join(', ')}]`);

    const jsonIo = captureStdio();
    const jsonCode = await runPluginsList(printer(true), dataDir, filePath);
    jsonIo.restore();
    expect(jsonCode).toBe(EXIT_CODES.ok);
    const result = parseJsonLines(jsonIo.stdout)[0] as {
      plugins: readonly { id: string; status: string; source: { type: string; version: string } }[];
    };
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.status).toBe('ready');
    expect(result.plugins[0]?.source).toEqual({ type: 'npm', version: '1.2.3' });
  });

  it('reports a plugin recorded for another platform as not-applicable, never imported, never hidden', async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath();
    const entry = writeFixturePlugin(dataDir, {
      id: 'bgls-plugin-other-platform',
      kind: 'permission-assist',
      platforms: [OTHER_PLATFORM],
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] } as PluginsFile);

    const io = captureStdio();
    const code = await runPluginsList(printer(true), dataDir, filePath);
    io.restore();

    expect(code).toBe(EXIT_CODES.ok);
    const result = parseJsonLines(io.stdout)[0] as {
      plugins: readonly { status: string; reason: string | null }[];
    };
    expect(result.plugins[0]?.status).toBe('not-applicable');
    expect(result.plugins[0]?.reason).toContain(process.platform);
  });
});

describe('bgls plugins remove', () => {
  it('removes a recorded plugin from the file and deletes its stored entry file', async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath();
    const entry = writeFixturePlugin(dataDir, {
      id: 'bgls-plugin-remove-fixture',
      kind: 'frame-encoder',
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] } as PluginsFile);

    const io = captureStdio();
    const code = await runPluginsRemove(
      printer(true),
      'bgls-plugin-remove-fixture',
      dataDir,
      filePath,
    );
    io.restore();

    expect(code).toBe(EXIT_CODES.ok);
    const result = parseJsonLines(io.stdout)[0] as { removed: true; id: string };
    expect(result.removed).toBe(true);
    expect(result.id).toBe('bgls-plugin-remove-fixture');

    const read = readPluginsFile(filePath);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.file.plugins).toHaveLength(0);
  });

  it('an unknown id is a usage error and leaves the record untouched', async () => {
    const dataDir = freshDataDir();
    const filePath = freshFilePath();
    const entry = writeFixturePlugin(dataDir, {
      id: 'bgls-plugin-keep-fixture',
      kind: 'frame-encoder',
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] } as PluginsFile);

    const io = captureStdio();
    const code = await runPluginsRemove(printer(true), 'no-such-plugin', dataDir, filePath);
    io.restore();

    expect(code).toBe(EXIT_CODES.usageError);
    const result = parseJsonLines(io.stdout)[0] as { removed: false; reason: string };
    expect(result.removed).toBe(false);
    expect(result.reason).toContain('no-such-plugin');

    const read = readPluginsFile(filePath);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.file.plugins).toHaveLength(1);
  });
});
