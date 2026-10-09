/**
 * `encode()` and `probe()` when ffmpeg is absent.
 *
 * `node:fs`'s `existsSync` is mocked to always return `false` here so this
 * test is deterministic regardless of whether the machine actually running
 * it happens to have ffmpeg on PATH: `resolveFfmpeg` (`../src/ffmpeg.ts`)
 * checks every candidate with `existsSync` before ever trying to run it,
 * so forcing that to `false` reproduces "ffmpeg not found" on any machine,
 * which is the scenario this test is required to cover honestly (it must
 * not silently pass by actually encoding something).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => false };
});

describe('with no ffmpeg reachable', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('probe() reports unusable instead of throwing', async () => {
    const { default: plugin } = await import('../src/index.js');
    const result = await plugin.probe();
    expect(result.usable).toBe(false);
    expect(result.detail.toLowerCase()).toContain('ffmpeg');
  });

  it('encode() reports outcome "unsupported" with a bytesWritten of 0 instead of throwing or claiming a file was written', async () => {
    const { default: plugin } = await import('../src/index.js');
    const controller = new AbortController();
    const result = await plugin.encode(
      {
        inputDir: '/rec/frames',
        outPath: '/rec/out.mp4',
        frames: [
          { frameIndex: 0, file: '00000000.jpg', tsDeltaMs: 0, sidEpoch: 0, byteLength: 10 },
        ],
      },
      controller.signal,
    );
    expect(result.outcome).toBe('unsupported');
    expect(result.bytesWritten).toBe(0);
    expect(result.detail.toLowerCase()).toContain('ffmpeg');
  });
});

describe('encode() input validation, independent of ffmpeg availability', () => {
  it('rejects an empty frame list without ever resolving ffmpeg', async () => {
    const { default: plugin } = await import('../src/index.js');
    const controller = new AbortController();
    const result = await plugin.encode(
      { inputDir: '/rec/frames', outPath: '/rec/out.mp4', frames: [] },
      controller.signal,
    );
    expect(result).toEqual({
      outcome: 'unsupported',
      detail: 'no frames to encode',
      bytesWritten: 0,
    });
  });

  it('rejects a frame file that is a path instead of a bare filename, before touching ffmpeg', async () => {
    const { default: plugin } = await import('../src/index.js');
    const controller = new AbortController();
    const result = await plugin.encode(
      {
        inputDir: '/rec/frames',
        outPath: '/rec/out.mp4',
        frames: [
          { frameIndex: 0, file: '../escape.jpg', tsDeltaMs: 0, sidEpoch: 0, byteLength: 10 },
        ],
      },
      controller.signal,
    );
    expect(result.outcome).toBe('unsupported');
    expect(result.bytesWritten).toBe(0);
    expect(result.detail).toContain('../escape.jpg');
  });
});
