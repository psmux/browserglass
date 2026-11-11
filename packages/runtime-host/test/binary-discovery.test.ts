import { beforeEach, describe, expect, it } from 'vitest';
import {
  BinaryNotFoundError,
  __resetBinaryDiscoveryCacheForTests,
  resolveChromeBinary,
} from '../src/binary-discovery.js';

beforeEach(() => {
  __resetBinaryDiscoveryCacheForTests();
});

describe('resolveChromeBinary, real discovery on this machine', () => {
  // The registry App Paths key only exists on Windows.
  it.skipIf(process.platform !== 'win32')(
    'finds the real installed Chrome via the registry App Paths key, ahead of any fixed path',
    () => {
      const resolved = resolveChromeBinary('chrome');
      expect(resolved.path.toLowerCase()).toContain('chrome.exe');
      // A shape and a floor, never a specific major. This read
      // `startsWith('151.')` and the test name said "Chrome 151", both of
      // which silently encoded whichever Chrome happened to be installed
      // when it was written. Chrome auto updates, so that assertion has a
      // shelf life measured in weeks: it began failing on every run once
      // this machine moved to 152. What this test is actually about is
      // registry App Paths discovery winning over the fixed path list, so
      // the version only needs to look like a real Chrome version.
      expect(resolved.version).toMatch(/^\d+\.\d+/);
      expect(Number(resolved.version.split('.')[0])).toBeGreaterThanOrEqual(105);
      expect(resolved.mtimeMs).toBeGreaterThan(0);
      expect(resolved.size).toBeGreaterThan(0);
    },
  );

  it('caches the resolution on {path, mtime, size} across repeated calls', () => {
    const first = resolveChromeBinary('chrome');
    const second = resolveChromeBinary('chrome');
    expect(second).toEqual(first);
  });

  it('honours BGLS_CHROME_PATH ahead of every other source when it points at a real file', () => {
    const real = resolveChromeBinary('chrome');
    __resetBinaryDiscoveryCacheForTests();
    const prior = process.env['BGLS_CHROME_PATH'];
    process.env['BGLS_CHROME_PATH'] = real.path;
    try {
      const resolved = resolveChromeBinary('chrome');
      expect(resolved.path).toBe(real.path);
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"; the variable must be removed.
      if (prior === undefined) delete process.env['BGLS_CHROME_PATH'];
      else process.env['BGLS_CHROME_PATH'] = prior;
    }
  });

  it('throws BinaryNotFoundError, carrying every searched path, for a channel that does not exist on this machine', () => {
    try {
      resolveChromeBinary('chromium-headless-shell');
      throw new Error('expected resolveChromeBinary to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BinaryNotFoundError);
      const e = err as BinaryNotFoundError;
      expect(e.channel).toBe('chromium-headless-shell');
    }
  });
});

describe('resolveChromeBinary, a host that names its Chrome', () => {
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"; the variable must be removed.
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        // biome-ignore lint/performance/noDelete: see above.
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('never falls back to another Chrome when BGLS_CHROME_PATH names one that is missing', () => {
    const missing = process.platform === 'win32' ? 'C:\nowhere\chrome.exe' : '/nowhere/chrome';
    withEnv({ BGLS_CHROME_PATH: missing, BGLS_NO_SYSTEM_CHROME: undefined }, () => {
      try {
        resolveChromeBinary('chrome');
        throw new Error('expected resolveChromeBinary to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryNotFoundError);
        expect((err as BinaryNotFoundError).searched).toEqual([missing]);
      }
    });
  });

  it('searches no system location with BGLS_NO_SYSTEM_CHROME=1 and nothing configured', () => {
    withEnv({ BGLS_CHROME_PATH: undefined, BGLS_NO_SYSTEM_CHROME: '1' }, () => {
      try {
        resolveChromeBinary('chrome');
        throw new Error('expected resolveChromeBinary to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryNotFoundError);
        expect((err as BinaryNotFoundError).searched).toEqual([]);
      }
    });
  });
});
