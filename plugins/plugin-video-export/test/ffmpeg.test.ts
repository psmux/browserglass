import { join } from 'node:path';
import type { EncodeRequest } from '@browserglass/plugin-api';
import { describe, expect, it } from 'vitest';
import { buildConcatList, buildFfmpegArgs, isPlainFilename } from '../src/ffmpeg.js';

const inputDir = process.platform === 'win32' ? 'C:\\rec\\frames' : '/rec/frames';

function req(overrides: Partial<EncodeRequest> = {}): EncodeRequest {
  return {
    inputDir,
    outPath: process.platform === 'win32' ? 'C:\\rec\\out.mp4' : '/rec/out.mp4',
    frames: [
      { frameIndex: 0, file: '00000000.jpg', tsDeltaMs: 0, sidEpoch: 0, byteLength: 100 },
      { frameIndex: 1, file: '00000001.jpg', tsDeltaMs: 40, sidEpoch: 0, byteLength: 100 },
      { frameIndex: 2, file: '00000002.jpg', tsDeltaMs: 90, sidEpoch: 0, byteLength: 100 },
    ],
    ...overrides,
  };
}

describe('isPlainFilename', () => {
  it('accepts a bare filename', () => {
    expect(isPlainFilename('00000000.jpg')).toBe(true);
  });

  it('rejects anything that looks like a path', () => {
    expect(isPlainFilename('../escape.jpg')).toBe(false);
    expect(isPlainFilename('sub/dir.jpg')).toBe(false);
    expect(isPlainFilename('sub\\dir.jpg')).toBe(false);
    expect(isPlainFilename('.')).toBe(false);
    expect(isPlainFilename('..')).toBe(false);
    expect(isPlainFilename('')).toBe(false);
  });
});

describe('buildConcatList', () => {
  it("derives each frame duration from the delta to the next frame's tsDeltaMs, for a known input", () => {
    const result = buildConcatList(req());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const frame0 = join(inputDir, '00000000.jpg');
    const frame1 = join(inputDir, '00000001.jpg');
    const frame2 = join(inputDir, '00000002.jpg');

    // frame 0 shows for 40ms (delta to frame 1), frame 1 for 50ms (delta to
    // frame 2), and frame 2 has no successor, so it takes the interval
    // before it, 50ms, as an estimate rather than the old fixed 1/30s.
    //
    // The last file is NOT repeated. Repeating it is the usual idiom for
    // making the concat demuxer honour the final duration, and measured
    // against ffmpeg 9.0.1 it produced a video decoding to six frames from
    // five real inputs, with a re-mux warning about a dts collision. This
    // list produces exactly as many frames as were captured.
    const expected = [
      `file '${frame0}'`,
      'duration 0.040000',
      `file '${frame1}'`,
      'duration 0.050000',
      `file '${frame2}'`,
      'duration 0.050000',
      '',
    ].join('\n');

    expect(result.content).toBe(expected);
  });

  it('never repeats the final file, because that invents a frame nobody captured', () => {
    const result = buildConcatList(req());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fileLines = result.content.split('\n').filter((l) => l.startsWith('file '));
    // Three input frames, three file entries. The old list had four.
    expect(fileLines).toHaveLength(3);
    expect(new Set(fileLines).size).toBe(3);
  });

  it('treats a sidEpoch change as a real boundary, not a measurable delta', () => {
    // `tsDeltaMs` restarts from the base of its own epoch, so a delta taken
    // across two epochs is not a duration. Before `EncoderFrame` carried
    // `sidEpoch` the only clue was a delta coming out non-positive, which
    // silently missed any reset where the new base happened to be larger.
    // Here it is larger, 500 against 100, so the old check saw nothing
    // wrong and would have claimed a 400ms frame.
    const result = buildConcatList(
      req({
        frames: [
          { frameIndex: 0, file: 'a.jpg', tsDeltaMs: 100, sidEpoch: 0, byteLength: 1 },
          { frameIndex: 1, file: 'b.jpg', tsDeltaMs: 500, sidEpoch: 1, byteLength: 1 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const durationLines = result.content.split('\n').filter((l) => l.startsWith('duration'));
    expect(durationLines[0]).toBe(`duration ${(1 / 30).toFixed(6)}`);
  });

  it('uses a constant 1/fps duration for every frame when fps is given, ignoring tsDeltaMs', () => {
    const result = buildConcatList(req({ fps: 10 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const durationLines = result.content.split('\n').filter((l) => l.startsWith('duration'));
    expect(durationLines).toEqual(['duration 0.100000', 'duration 0.100000', 'duration 0.100000']);
  });

  it('falls back to 1/30s when a delta is non-positive (a likely epoch reset EncoderFrame cannot see)', () => {
    const result = buildConcatList(
      req({
        frames: [
          { frameIndex: 0, file: 'a.jpg', tsDeltaMs: 1000, sidEpoch: 0, byteLength: 1 },
          { frameIndex: 1, file: 'b.jpg', tsDeltaMs: 20, sidEpoch: 0, byteLength: 1 }, // tsDeltaMs went backwards
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const durationLines = result.content.split('\n').filter((l) => l.startsWith('duration'));
    expect(durationLines[0]).toBe(`duration ${(1 / 30).toFixed(6)}`);
  });

  it('reports the offending frame instead of building a list when a frame name is a path', () => {
    const result = buildConcatList(
      req({
        frames: [
          { frameIndex: 0, file: '../escape.jpg', tsDeltaMs: 0, sidEpoch: 0, byteLength: 1 },
        ],
      }),
    );
    expect(result).toEqual({ ok: false, invalidFrame: '../escape.jpg' });
  });
});

describe('buildFfmpegArgs', () => {
  // What this test can and cannot tell you, because it matters more than
  // the assertion. It pins the argv this function MEANS to emit, which
  // catches a path being split across two arguments or a value going
  // missing. It cannot tell you ffmpeg accepts any of it.
  //
  // This test passed, green, for as long as the array said `-vsync vfr`,
  // an option ffmpeg 9 removed outright. The first real encode answered
  // `Unrecognized option 'vsync'` and wrote no file. A passing suite and a
  // working encoder turned out to be unrelated facts, which is why
  // this plugin is judged by a real export producing a real playable file
  // rather than by this going green.
  it('produces a fixed argv array with the concat list and outPath as single literal arguments', () => {
    const args = buildFfmpegArgs('/tmp/concat.txt', '/rec/out.mp4');
    expect(args).toEqual([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/tmp/concat.txt',
      '-fps_mode',
      'vfr',
      '-pix_fmt',
      'yuv420p',
      '/rec/out.mp4',
    ]);
  });

  it('never interpolates a hostile outPath into anything but its own trailing argument', () => {
    const hostile = "/rec/out.mp4'; rm -rf /";
    const args = buildFfmpegArgs('/tmp/concat.txt', hostile);
    expect(args[args.length - 1]).toBe(hostile);
    expect(args).toHaveLength(12);
  });
});
