import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_PLUGINS_FILE, type PluginsFile } from '../../src/plugins/record.js';
import { assistFor, encoderFor } from '../../src/plugins/registry.js';
import { cleanupDir, makeTempDataDir, writeFixturePlugin } from './fixtures.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupDir(dir);
});

function tempDataDir(): string {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

// ── An empty registry answers quietly ────────────────────────────────────

describe('encoderFor / assistFor: an empty registry', () => {
  it('answers "absent" for a completely empty record, with no file access beyond the record itself', async () => {
    const dataDir = tempDataDir(); // never written to below
    const result = await encoderFor(EMPTY_PLUGINS_FILE, dataDir);
    expect(result).toEqual({ status: 'absent' });
  });

  it('answers "absent" for assistFor too, independently of encoderFor', async () => {
    const dataDir = tempDataDir();
    const result = await assistFor(EMPTY_PLUGINS_FILE, dataDir);
    expect(result).toEqual({ status: 'absent' });
  });

  it('answers "absent" when the record has entries, but none of the requested kind', async () => {
    const dataDir = tempDataDir();
    const encoderEntry = writeFixturePlugin(dataDir, {
      id: 'only-an-encoder',
      kind: 'frame-encoder',
    });
    const file: PluginsFile = { version: 1, plugins: [encoderEntry] };

    const result = await assistFor(file, dataDir);

    expect(result).toEqual({ status: 'absent' });
  });
});

// ── A plugin absent for this platform is not listed as ready ────────────

describe('encoderFor / assistFor: platform gating at listing time', () => {
  it('reports "not-applicable" rather than "absent" for a kind that IS recorded but not for this platform', async () => {
    const dataDir = tempDataDir();
    const otherPlatform: NodeJS.Platform = process.platform === 'darwin' ? 'win32' : 'darwin';
    const entry = writeFixturePlugin(dataDir, {
      id: 'macos-only-assist',
      kind: 'permission-assist',
      platforms: [otherPlatform],
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await assistFor(file, dataDir);

    expect(result.status).toBe('not-applicable');
  });
});

// ── The plugin every consumer actually wants: ready ──────────────────────

describe('encoderFor / assistFor: a ready plugin', () => {
  it('resolves a usable frame-encoder end to end through the registry', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'registry-ready-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: true, detail: 'ready via registry' };",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await encoderFor(file, dataDir);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.plugin.id).toBe('registry-ready-encoder');
      expect(typeof result.plugin.encode).toBe('function');
    }
  });

  it('resolves a usable permission-assist plugin end to end through the registry', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'registry-ready-assist',
      kind: 'permission-assist',
      probeBody: "return { usable: true, detail: 'ready via registry' };",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await assistFor(file, dataDir);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(typeof result.plugin.assist).toBe('function');
    }
  });

  it('passes through "unusable" for a plugin that loads but honestly probes as not usable right now', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'registry-unusable-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: false, detail: 'no ffmpeg' };",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await encoderFor(file, dataDir);

    expect(result.status).toBe('unusable');
  });
});

// ── The registry forwards, rather than collapses, every load.ts fact ────

describe('encoderFor / assistFor: forward every distinct failure fact', () => {
  it('forwards "integrity-mismatch" from load.ts unchanged', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'registry-tampered',
      kind: 'frame-encoder',
      integrityOverride: 'sha512-dGFtcGVyZWQ=',
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await encoderFor(file, dataDir);

    expect(result.status).toBe('integrity-mismatch');
  });

  it('forwards "unsupported-host-api" from load.ts unchanged, including which range was declared', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'registry-old-host-api',
      kind: 'frame-encoder',
      hostApi: '^999.0.0',
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await encoderFor(file, dataDir);

    expect(result.status).toBe('unsupported-host-api');
    if (result.status === 'unsupported-host-api') {
      expect(result.declared).toBe('^999.0.0');
    }
  });

  it('forwards "probe-failed" from load.ts unchanged', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'registry-probe-throws',
      kind: 'permission-assist',
      probeBody: "throw new Error('registry probe failure');",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };

    const result = await assistFor(file, dataDir);

    expect(result.status).toBe('probe-failed');
    if (result.status === 'probe-failed') {
      expect(result.reason).toContain('registry probe failure');
    }
  });
});

// ── Policy: the first entry of a kind is authoritative ───────────────────

describe('encoderFor / assistFor: more than one entry of the same kind', () => {
  it('consults only the first matching entry in file order, ignoring a second of the same kind', async () => {
    const dataDir = tempDataDir();
    const first = writeFixturePlugin(dataDir, {
      id: 'first-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: true, detail: 'first' };",
    });
    const second = writeFixturePlugin(dataDir, {
      id: 'second-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: true, detail: 'second' };",
    });
    const file: PluginsFile = { version: 1, plugins: [first, second] };

    const result = await encoderFor(file, dataDir);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.plugin.id).toBe('first-encoder');
    }
  });
});
