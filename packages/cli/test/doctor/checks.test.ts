import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BinaryNotFoundError, type ResolvedBinary } from '@browserglass/runtime-host';
import { afterEach, describe, expect, it } from 'vitest';
import { checkChrome, checkPlugins } from '../../src/doctor/checks.js';
import { type PluginsFile, writePluginsFile } from '../../src/plugins/record.js';
import { cleanupDir, makeTempDataDir, writeFixturePlugin } from '../plugins/fixtures.js';

describe('checkChrome', () => {
  it('passes and names the version/path when discovery succeeds', async () => {
    const fakeDiscover = (): ResolvedBinary => ({
      channel: 'chrome',
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      version: '151.0.7922.173',
      mtimeMs: 0,
      size: 0,
    });
    const result = await checkChrome(fakeDiscover);
    expect(result.verdict).toBe('pass');
    expect(result.detail).toContain('151.0.7922.173');
    expect(result.observed?.['path']).toBe(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    );
  });

  it('fails with a message naming the fix when discovery finds nothing, without touching the real installation (injectable override)', async () => {
    const fakeDiscover = (): ResolvedBinary => {
      throw new BinaryNotFoundError('chrome', [
        'C:\\fake\\chrome.exe',
        '(registry) HKLM\\...\\chrome.exe',
      ]);
    };
    const result = await checkChrome(fakeDiscover);
    expect(result.verdict).toBe('fail');
    expect(result.name).toBe('chrome');
    expect(result.detail).toContain('No runnable Chrome binary was found');
    expect(result.fix).toBeDefined();
    expect(result.fix).toMatch(/install google chrome/i);
  });
});

describe('checkPlugins', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupDir(dir);
  });

  function tempDataDir(): string {
    const dir = makeTempDataDir();
    dirs.push(dir);
    return dir;
  }

  it('passes when no bgls-plugins.json exists at all (the normal, nothing-installed state)', async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');

    const result = await checkPlugins(dataDir, filePath);

    expect(result.name).toBe('plugins');
    expect(result.group).toBe('plugins');
    expect(result.verdict).toBe('pass');
    expect(result.detail).toContain('No plugins installed');
  });

  it('passes when the record exists but names no plugins', async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');
    writePluginsFile(filePath, { version: 1, plugins: [] });

    const result = await checkPlugins(dataDir, filePath);

    expect(result.verdict).toBe('pass');
    expect(result.detail).toContain('No plugins installed');
  });

  it('fails, naming the fix, when bgls-plugins.json does not parse as JSON', async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');
    writeFileSync(filePath, '{ not valid json', 'utf8');

    const result = await checkPlugins(dataDir, filePath);

    expect(result.verdict).toBe('fail');
    expect(result.detail).toContain(filePath);
    expect(result.fix).toMatch(/bgls plugins add/);
  });

  it('passes and names each entry\'s status when every installed plugin loads to "ready"', async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-ready-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: true, detail: 'always usable' };",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };
    writePluginsFile(filePath, file);

    const result = await checkPlugins(dataDir, filePath);

    expect(result.verdict).toBe('pass');
    expect(result.detail).toContain('fixture-ready-encoder');
    expect(result.detail).toContain('ready');
    expect(result.observed?.['ready']).toBe(1);
    expect(result.observed?.['total']).toBe(1);
  });

  it("warns, never fails, when an installed plugin's own probe() honestly reports unusable", async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-unusable-encoder',
      kind: 'frame-encoder',
      probeBody: "return { usable: false, detail: 'no system ffmpeg found' };",
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] });

    const result = await checkPlugins(dataDir, filePath);

    expect(result.verdict).toBe('warn');
    expect(result.detail).toContain('fixture-unusable-encoder');
    expect(result.observed?.['unusable']).toBe(1);
  });

  it('fails, distinctly from "unusable", when an installed plugin\'s entry file no longer matches its recorded hash', async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-tampered-encoder',
      kind: 'frame-encoder',
      integrityOverride: 'sha512-notarealhash==',
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] });

    const result = await checkPlugins(dataDir, filePath);

    expect(result.verdict).toBe('fail');
    expect(result.detail).toContain('fixture-tampered-encoder');
    expect(result.observed?.['integrity-mismatch']).toBe(1);
    expect(result.fix).toMatch(/reinstall/i);
  });

  it('passes for a plugin recorded for another platform: "not-applicable" is reported, not treated as a degradation', async () => {
    const dataDir = tempDataDir();
    const filePath = join(dataDir, 'bgls-plugins.json');
    const otherPlatform: NodeJS.Platform = process.platform === 'darwin' ? 'win32' : 'darwin';
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-other-platform-assist',
      kind: 'permission-assist',
      platforms: [otherPlatform],
    });
    writePluginsFile(filePath, { version: 1, plugins: [entry] });

    const result = await checkPlugins(dataDir, filePath);

    expect(result.verdict).toBe('pass');
    expect(result.observed?.['not-applicable']).toBe(1);
  });
});
