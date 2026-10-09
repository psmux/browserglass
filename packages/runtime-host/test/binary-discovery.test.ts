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
  it('finds the real installed Chrome via the registry App Paths key, ahead of any fixed path', () => {
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
  });

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
