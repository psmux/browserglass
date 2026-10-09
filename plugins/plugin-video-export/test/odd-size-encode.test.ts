/**
 * A real encode of odd sized frames, run only where a system ffmpeg is
 * reachable (skipped otherwise, never faked). This is the check the argv
 * unit test in `ffmpeg.test.ts` cannot make: that ffmpeg itself accepts
 * frames whose width and height are not divisible by 2. Before the pad
 * filter it answered `height not divisible by 2` and wrote no file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../src/ffmpeg.js';
import plugin from '../src/index.js';

const ffmpeg = await resolveFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'bgls-odd-size-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(ffmpeg === null)('encoding frames with odd dimensions', () => {
  it.each([
    ['odd height', '640x361'],
    ['odd width', '641x360'],
    ['both odd', '101x51'],
  ])('encodes %s (%s) into a non-empty video', async (_label, size) => {
    const sub = join(dir, size);
    execFileSync(ffmpeg!.path, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${size}:rate=10`,
      '-frames:v',
      '3',
      join(dir, `${size}-%08d.jpg`),
    ]);
    const frames = [1, 2, 3].map((n, i) => ({
      frameIndex: i,
      file: `${size}-${String(n).padStart(8, '0')}.jpg`,
      tsDeltaMs: i * 100,
      sidEpoch: 0,
      byteLength: statSync(join(dir, `${size}-${String(n).padStart(8, '0')}.jpg`)).size,
    }));
    const outPath = `${sub}.mp4`;
    const result = await plugin.encode(
      { inputDir: dir, outPath, frames },
      new AbortController().signal,
    );
    expect(result.detail).not.toMatch(/divisible by 2/);
    expect(result.outcome).toBe('encoded');
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
  }, 60000);
});
