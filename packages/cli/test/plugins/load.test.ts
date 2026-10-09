import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPluginFile } from '../../src/plugins/integrity.js';
import { loadPlugin, pluginEntryPath, withDeadline } from '../../src/plugins/load.js';
import type { PluginRecordEntry } from '../../src/plugins/record.js';
import {
  UNSATISFIABLE_HOST_API,
  cleanupDir,
  makeTempDataDir,
  satisfyingHostApi,
  writeFixturePlugin,
} from './fixtures.js';

const dirs: string[] = [];
const __dirname = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupDir(dir);
});

function tempDataDir(): string {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

// ── A verified plugin loading: the real reference plugin ────────────────

const realPluginPath = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'plugins',
  'plugin-video-export',
  'dist',
  'plugin.mjs',
);

// The reference plugin lives outside the pnpm workspace, so a plain
// `pnpm -r build` does not build it. CI builds it and runs this test; a
// local run skips it until `pnpm build:plugins` has been run once.
const referencePluginMissing = !existsSync(realPluginPath) && !process.env['CI'];

describe('loadPlugin: a verified plugin loads', () => {
  it.skipIf(referencePluginMissing)(
    'loads the real reference plugin (plugins/plugin-video-export/dist/plugin.mjs) end to end',
    async () => {
      expect(
        existsSync(realPluginPath),
        `expected the built reference plugin at ${realPluginPath}`,
      ).toBe(true);

      const dataDir = tempDataDir();
      const relativeEntry = join('plugins', 'video-export', 'plugin.mjs');
      const absPath = join(dataDir, relativeEntry);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, readFileSync(realPluginPath));
      const integrity = hashPluginFile(absPath);

      const entry: PluginRecordEntry = {
        id: '@browserglass/plugin-video-export',
        kind: 'frame-encoder',
        source: { type: 'npm', version: '0.1.0' },
        entry: relativeEntry,
        integrity,
        platforms: ['darwin', 'linux', 'win32'],
        addedAt: '2026-09-01T00:00:00.000Z',
      };

      const result = await loadPlugin(entry, dataDir, 'frame-encoder');

      // The real plugin's probe() looks for a system ffmpeg. This machine
      // may or may not have one, and either honest answer is a correct
      // *load*: 'ready' (ffmpeg found) or 'unusable' (probe says so, per
      // its own documented behaviour "reports honestly when ffmpeg is
      // absent"). Anything else means loading itself failed.
      expect(['ready', 'unusable']).toContain(result.status);
      if (result.status === 'ready' || result.status === 'unusable') {
        expect(result.plugin.id).toBe('@browserglass/plugin-video-export');
        expect(result.plugin.kind).toBe('frame-encoder');
        expect(typeof result.probe.detail).toBe('string');
      }
    },
  );

  it('loads a fixture frame-encoder plugin to "ready" when probe() reports usable', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: true, detail: 'always usable' };",
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.plugin.id).toBe('fixture-encoder');
      expect(result.probe.usable).toBe(true);
    }
  });

  it('loads a fixture permission-assist plugin, distinct kind, same lifecycle', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-assist',
      kind: 'permission-assist',
      probeBody: "return { usable: true, detail: 'accessibility granted' };",
    });

    const result = await loadPlugin(entry, dataDir, 'permission-assist');

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.plugin.kind).toBe('permission-assist');
    }
  });

  it('reports "unusable" (not a failure) when probe() honestly says usable: false', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-not-usable',
      kind: 'frame-encoder',
      probeBody: "return { usable: false, detail: 'no system ffmpeg found' };",
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('unusable');
    if (result.status === 'unusable') {
      expect(result.probe.detail).toBe('no system ffmpeg found');
    }
  });
});

// ── A tampered plugin refused BEFORE import ──────────────────────────────

describe('loadPlugin: verification happens before import', () => {
  it('refuses a plugin whose bytes no longer match its recorded hash, and never imports it', async () => {
    const dataDir = tempDataDir();
    const markerPath = join(dataDir, 'imported.marker');
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-tamper',
      kind: 'frame-encoder',
      importMarkerPath: markerPath,
    });

    // Tamper with the file after its hash was recorded, exactly the
    // scenario integrity.test.ts's own "rejects a file whose bytes
    // changed" case exercises one layer down.
    const absPath = pluginEntryPath(dataDir, entry.entry)!;
    writeFileSync(absPath, `${readFileSync(absPath, 'utf8')}\n// tampered\n`, 'utf8');

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('integrity-mismatch');
    // The behavioural proof: if import() had run, the module's top-level
    // side effect would have written this marker file. It must not
    // exist.
    expect(existsSync(markerPath)).toBe(false);
  });

  it('refuses a record whose recorded integrity was simply wrong from the start, same as tampering', async () => {
    const dataDir = tempDataDir();
    const markerPath = join(dataDir, 'imported.marker');
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-wrong-hash',
      kind: 'frame-encoder',
      importMarkerPath: markerPath,
      integrityOverride: 'sha512-Ym9ndXMgZmFrZSBkaWdlc3Q=', // well formed, deliberately wrong
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('integrity-mismatch');
    expect(existsSync(markerPath)).toBe(false);
  });
});

// ── A plugin absent for this platform: not-applicable, never touched ────

describe('loadPlugin: platform gating (gate 2)', () => {
  it('reports "not-applicable" for a plugin not declared for this platform, and never hashes or imports it', async () => {
    const dataDir = tempDataDir();
    const markerPath = join(dataDir, 'imported.marker');
    const otherPlatform: NodeJS.Platform = process.platform === 'darwin' ? 'win32' : 'darwin';
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-wrong-platform',
      kind: 'permission-assist',
      platforms: [otherPlatform],
      importMarkerPath: markerPath,
      // A hash that does not match on purpose: gate 2 must short-circuit
      // before verification even runs, so a bad hash here must never
      // surface as 'integrity-mismatch'.
      integrityOverride: 'sha512-bm90LWFwcGxpY2FibGU=',
    });

    const result = await loadPlugin(entry, dataDir, 'permission-assist');

    expect(result.status).toBe('not-applicable');
    if (result.status === 'not-applicable') {
      expect(result.reason).toContain(otherPlatform);
    }
    expect(existsSync(markerPath)).toBe(false);
  });

  it('reports "not-applicable" when the manifest itself disagrees with the record about platform support', async () => {
    const dataDir = tempDataDir();
    // Record claims every platform; the plugin's own manifest claims only
    // one that is not this machine's. The manifest is closer to ground
    // truth and must win.
    const otherPlatform: NodeJS.Platform = process.platform === 'darwin' ? 'win32' : 'darwin';
    const entry: PluginRecordEntry = {
      ...writeFixturePlugin(dataDir, {
        id: 'fixture-manifest-disagrees',
        kind: 'frame-encoder',
        platforms: [otherPlatform],
      }),
      platforms: ['darwin', 'linux', 'win32'],
    };

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('not-applicable');
  });
});

// ── A plugin that throws is reported, never crashes the host ────────────

describe('loadPlugin: a plugin that throws is reported, not a crash', () => {
  it('converts a synchronous throw from probe() into a "probe-failed" result', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-throws',
      kind: 'frame-encoder',
      probeBody: "throw new Error('probe blew up');",
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('probe-failed');
    if (result.status === 'probe-failed') {
      expect(result.reason).toContain('probe blew up');
    }
  });

  it('converts a rejected probe() promise into a "probe-failed" result, without an unhandled rejection', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-rejects',
      kind: 'frame-encoder',
      probeBody: "return Promise.reject(new Error('async probe failure'));",
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('probe-failed');
    if (result.status === 'probe-failed') {
      expect(result.reason).toContain('async probe failure');
    }
  });

  it('converts a module body that throws at import time into "load-failed"', async () => {
    const dataDir = tempDataDir();
    const relativeEntry = 'plugins/fixture-import-throws/plugin.mjs';
    const absPath = join(dataDir, relativeEntry);
    mkdirSync(join(dataDir, 'plugins', 'fixture-import-throws'), { recursive: true });
    writeFileSync(
      absPath,
      "throw new Error('boom at module top level');\nexport default {};\n",
      'utf8',
    );
    const entry: PluginRecordEntry = {
      id: 'fixture-import-throws',
      kind: 'frame-encoder',
      source: { type: 'local', path: dataDir },
      entry: relativeEntry,
      integrity: hashPluginFile(absPath),
      platforms: ['darwin', 'linux', 'win32'],
      addedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('load-failed');
    if (result.status === 'load-failed') {
      expect(result.reason).toContain('boom at module top level');
    }
  });
});

// ── The deadline decision: a plugin that never returns must not hang ────

describe('loadPlugin: deadline', () => {
  it('does not hang forever on a probe() that never resolves, and reports "probe-failed"', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-wedged',
      kind: 'frame-encoder',
      probeBody: 'return new Promise(() => {});', // never settles
    });

    const start = Date.now();
    const result = await loadPlugin(entry, dataDir, 'frame-encoder', 50);
    const elapsed = Date.now() - start;

    expect(result.status).toBe('probe-failed');
    if (result.status === 'probe-failed') {
      expect(result.reason).toContain('50ms');
    }
    // Generous slack for CI scheduling jitter, but this must not be
    // anywhere near "forever".
    expect(elapsed).toBeLessThan(2000);
  });

  it('withDeadline resolves on time and rejects on timeout, independent of loadPlugin', async () => {
    await expect(withDeadline(Promise.resolve('fast'), 1000, 'fast op')).resolves.toBe('fast');
    await expect(withDeadline(new Promise(() => {}), 20, 'slow op')).rejects.toThrow(
      /did not return within 20ms/,
    );
  });
});

// ── hostApi: wrong version is distinct from every other failure ─────────

describe('loadPlugin: hostApi (wrong version)', () => {
  it('reports "unsupported-host-api" and does not call probe() when the range excludes this host', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-old-host-api',
      kind: 'frame-encoder',
      hostApi: UNSATISFIABLE_HOST_API,
      probeBody: "throw new Error('probe must not be called when hostApi is unsupported');",
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('unsupported-host-api');
    if (result.status === 'unsupported-host-api') {
      expect(result.declared).toBe(UNSATISFIABLE_HOST_API);
      expect(result.hostApiVersion.length).toBeGreaterThan(0);
    }
  });

  it('rejects a non-caret hostApi range explicitly, naming what is expected', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-tilde-range',
      kind: 'frame-encoder',
      hostApi: '~1.2.3',
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('unsupported-host-api');
    if (result.status === 'unsupported-host-api') {
      expect(result.reason).toContain('caret range');
    }
  });

  it('accepts the exact caret range the installed plugin-api version satisfies', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-satisfying',
      kind: 'frame-encoder',
      hostApi: satisfyingHostApi(),
    });

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(['ready', 'unusable']).toContain(result.status);
  });
});

// ── Everything else that must be "load-failed", named precisely ─────────

describe('loadPlugin: load-failed variants', () => {
  it('refuses a manifest whose id disagrees with the record', async () => {
    const dataDir = tempDataDir();
    const entry: PluginRecordEntry = {
      ...writeFixturePlugin(dataDir, { id: 'actual-id', kind: 'frame-encoder' }),
      id: 'recorded-under-a-different-id',
    };

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('load-failed');
    if (result.status === 'load-failed') {
      expect(result.reason).toContain('does not match its record');
    }
  });

  it('refuses when the requested kind does not match the record', async () => {
    const dataDir = tempDataDir();
    const entry = writeFixturePlugin(dataDir, { id: 'fixture-kind', kind: 'frame-encoder' });

    const result = await loadPlugin(entry, dataDir, 'permission-assist');

    expect(result.status).toBe('load-failed');
  });

  it('refuses a manifest missing the verb function its kind requires (fails plugin-api validation)', async () => {
    const dataDir = tempDataDir();
    const relativeEntry = 'plugins/fixture-no-verb/plugin.mjs';
    const absPath = join(dataDir, relativeEntry);
    mkdirSync(join(dataDir, 'plugins', 'fixture-no-verb'), { recursive: true });
    writeFileSync(
      absPath,
      `export default {
  id: 'fixture-no-verb',
  kind: 'frame-encoder',
  hostApi: ${JSON.stringify(satisfyingHostApi())},
  platforms: ['darwin', 'linux', 'win32'],
  summary: 'missing encode()',
  probe: async () => ({ usable: true, detail: 'ok' }),
};
`,
      'utf8',
    );
    const entry: PluginRecordEntry = {
      id: 'fixture-no-verb',
      kind: 'frame-encoder',
      source: { type: 'local', path: dataDir },
      entry: relativeEntry,
      integrity: hashPluginFile(absPath),
      platforms: ['darwin', 'linux', 'win32'],
      addedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('load-failed');
    if (result.status === 'load-failed') {
      expect(result.reason).toContain('encode');
    }
  });

  it('refuses an entry file that is missing on disk', async () => {
    const dataDir = tempDataDir();
    const entry: PluginRecordEntry = {
      id: 'fixture-missing-file',
      kind: 'frame-encoder',
      source: { type: 'local', path: dataDir },
      entry: 'plugins/does-not-exist/plugin.mjs',
      integrity: 'sha512-bWlzc2luZw==',
      platforms: ['darwin', 'linux', 'win32'],
      addedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('load-failed');
    if (result.status === 'load-failed') {
      expect(result.reason).toContain('missing on disk');
    }
  });

  it('refuses an entry path that resolves outside the data directory', async () => {
    const dataDir = tempDataDir();
    const entry: PluginRecordEntry = {
      id: 'fixture-escape',
      kind: 'frame-encoder',
      source: { type: 'local', path: dataDir },
      entry: '../../../../etc/whatever/plugin.mjs',
      integrity: 'sha512-ZXNjYXBl',
      platforms: ['darwin', 'linux', 'win32'],
      addedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = await loadPlugin(entry, dataDir, 'frame-encoder');

    expect(result.status).toBe('load-failed');
    if (result.status === 'load-failed') {
      expect(result.reason).toContain('outside the data directory');
    }
  });
});
