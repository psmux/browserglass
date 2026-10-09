import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeCowCapability } from '../src/cow-probe.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('probeCowCapability, real probe on this machine', () => {
  it("reports the honest capability for this machine’s real filesystem (NTFS on Windows, verified: no block cloning, so 'none')", () => {
    dir = mkdtempSync(join(tmpdir(), 'bgls-cow-probe-'));
    const result = probeCowCapability(dir);
    if (process.platform === 'win32') {
      expect(result).toBe('none');
    } else {
      expect(['reflink', 'clonefile', 'none']).toContain(result);
    }
  });

  it('cleans up its own probe files, leaving no residue in tmp/', () => {
    dir = mkdtempSync(join(tmpdir(), 'bgls-cow-probe-'));
    probeCowCapability(dir);
    const tmpDir = join(dir, 'tmp');
    if (existsSync(tmpDir)) {
      expect(readdirSync(tmpDir)).toEqual([]);
    }
  });
});
