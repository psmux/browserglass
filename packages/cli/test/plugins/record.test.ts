import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PLUGINS_FILE,
  type PluginRecordEntry,
  type PluginsFile,
  findPluginEntry,
  readPluginsFile,
  removePluginEntry,
  upsertPluginEntry,
  validatePluginsFile,
  writePluginsFile,
} from '../../src/plugins/record.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPluginsFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-plugins-record-test-'));
  dirs.push(dir);
  return join(dir, 'bgls-plugins.json');
}

const encoderEntry: PluginRecordEntry = {
  id: '@browserglass/plugin-video-export',
  kind: 'frame-encoder',
  source: { type: 'npm', version: '0.2.1' },
  entry: 'plugins/@browserglass+plugin-video-export@0.2.1/plugin.mjs',
  integrity: 'sha512-Bm5wYWJjZGVmZ2hpams=',
  platforms: ['darwin', 'linux', 'win32'],
  addedAt: '2026-09-01T10:14:02.113Z',
};

const assistEntry: PluginRecordEntry = {
  id: 'bgls-plugin-macos-approve',
  kind: 'permission-assist',
  source: {
    type: 'git',
    url: 'https://github.com/someone/bgls-plugin-macos-approve.git',
    commit: '3f2a1c94e0b7d5a8c1f60d2b9e4a7c3d5e8f0a12',
  },
  entry: 'plugins/bgls-plugin-macos-approve@3f2a1c9/plugin.mjs',
  integrity: 'sha512-9Qk2YWJjZGVmZ2hpams=',
  platforms: ['darwin'],
  addedAt: '2026-09-01T10:19:44.902Z',
};

describe('readPluginsFile: absence', () => {
  it('reads a missing file as the empty record, not an error', () => {
    const path = tempPluginsFilePath(); // a path inside a fresh temp dir; nothing is ever written there
    const result = readPluginsFile(path);
    expect(result).toEqual({ ok: true, file: EMPTY_PLUGINS_FILE });
  });
});

describe('readPluginsFile: corruption', () => {
  it('reports a file that is not valid JSON, naming the path', () => {
    const path = tempPluginsFilePath();
    writeFileSync(path, '{ this is not json', 'utf8');
    const result = readPluginsFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe(path);
      expect(result.reason).toContain(path);
      expect(result.reason.toLowerCase()).toContain('json');
    }
  });

  it('reports a record whose shape is wrong as refused rather than trusted, naming the path', () => {
    const path = tempPluginsFilePath();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, plugins: [{ id: 'bad', kind: 'not-a-real-kind' }] }),
      'utf8',
    );
    const result = readPluginsFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe(path);
      expect(result.reason).toContain(path);
      expect(result.reason).toContain('bad');
    }
  });

  it('reports a wrong top level version as refused', () => {
    const path = tempPluginsFilePath();
    writeFileSync(path, JSON.stringify({ version: 2, plugins: [] }), 'utf8');
    const result = readPluginsFile(path);
    expect(result.ok).toBe(false);
  });
});

describe('readPluginsFile/writePluginsFile: round trip', () => {
  it('writes and reads back an identical record with one entry of each kind', () => {
    const path = tempPluginsFilePath();
    const file: PluginsFile = { version: 1, plugins: [encoderEntry, assistEntry] };
    writePluginsFile(path, file);
    const result = readPluginsFile(path);
    expect(result).toEqual({ ok: true, file });
  });

  it('creates the parent directory if it does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-plugins-record-test-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'deeper', 'bgls-plugins.json');
    writePluginsFile(path, { version: 1, plugins: [encoderEntry] });
    expect(readPluginsFile(path)).toEqual({
      ok: true,
      file: { version: 1, plugins: [encoderEntry] },
    });
  });
});

describe('validatePluginsFile', () => {
  it('accepts the empty record', () => {
    expect(validatePluginsFile({ version: 1, plugins: [] })).toEqual({
      ok: true,
      file: EMPTY_PLUGINS_FILE,
    });
  });

  it('accepts a well formed record with npm, git and local sources', () => {
    const localEntry: PluginRecordEntry = {
      id: 'local-dev-plugin',
      kind: 'frame-encoder',
      source: { type: 'local', path: '/home/dev/plugin/dist/plugin.mjs' },
      entry: 'plugins/local-dev-plugin/plugin.mjs',
      integrity: 'sha512-YWJjZGVmZ2hpams=',
      platforms: ['linux'],
      addedAt: '2026-09-01T00:00:00.000Z',
    };
    const result = validatePluginsFile({
      version: 1,
      plugins: [encoderEntry, assistEntry, localEntry],
    });
    expect(result).toEqual({
      ok: true,
      file: { version: 1, plugins: [encoderEntry, assistEntry, localEntry] },
    });
  });

  it('refuses a non-object', () => {
    expect(validatePluginsFile('not an object').ok).toBe(false);
    expect(validatePluginsFile(null).ok).toBe(false);
    expect(validatePluginsFile([]).ok).toBe(false);
  });

  it('refuses plugins that is not an array', () => {
    expect(validatePluginsFile({ version: 1, plugins: 'nope' }).ok).toBe(false);
  });

  it('refuses an unknown kind', () => {
    const result = validatePluginsFile({
      version: 1,
      plugins: [{ ...encoderEntry, kind: 'video-thing' }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a git source with a branch name instead of a 40 hex commit sha', () => {
    const result = validatePluginsFile({
      version: 1,
      plugins: [
        {
          ...assistEntry,
          source: {
            type: 'git',
            url: 'https://github.com/someone/bgls-plugin-macos-approve.git',
            commit: 'main',
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('commit');
  });

  it('refuses an integrity field with no sha512- prefix', () => {
    const result = validatePluginsFile({
      version: 1,
      plugins: [{ ...encoderEntry, integrity: 'not-a-digest' }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an addedAt that does not parse as a date', () => {
    const result = validatePluginsFile({
      version: 1,
      plugins: [{ ...encoderEntry, addedAt: 'not-a-date' }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a duplicate id', () => {
    const result = validatePluginsFile({ version: 1, plugins: [encoderEntry, encoderEntry] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(encoderEntry.id);
  });

  it('refuses an empty platforms array', () => {
    const result = validatePluginsFile({
      version: 1,
      plugins: [{ ...encoderEntry, platforms: [] }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('findPluginEntry / upsertPluginEntry / removePluginEntry', () => {
  it('finds an entry by id', () => {
    const file: PluginsFile = { version: 1, plugins: [encoderEntry, assistEntry] };
    expect(findPluginEntry(file, assistEntry.id)).toEqual(assistEntry);
    expect(findPluginEntry(file, 'does-not-exist')).toBeUndefined();
  });

  it('upsert adds a new entry without mutating the original file', () => {
    const original: PluginsFile = { version: 1, plugins: [encoderEntry] };
    const updated = upsertPluginEntry(original, assistEntry);
    expect(original.plugins).toHaveLength(1);
    expect(updated.plugins).toHaveLength(2);
    expect(findPluginEntry(updated, assistEntry.id)).toEqual(assistEntry);
  });

  it('upsert replaces an existing entry with the same id', () => {
    const original: PluginsFile = { version: 1, plugins: [encoderEntry] };
    const replacement: PluginRecordEntry = {
      ...encoderEntry,
      source: { type: 'npm', version: '0.3.0' },
    };
    const updated = upsertPluginEntry(original, replacement);
    expect(updated.plugins).toHaveLength(1);
    expect(findPluginEntry(updated, encoderEntry.id)).toEqual(replacement);
  });

  it('remove drops the named entry and leaves others untouched, without mutating the original', () => {
    const original: PluginsFile = { version: 1, plugins: [encoderEntry, assistEntry] };
    const updated = removePluginEntry(original, encoderEntry.id);
    expect(original.plugins).toHaveLength(2);
    expect(updated.plugins).toEqual([assistEntry]);
  });
});
