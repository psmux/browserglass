/**
 * Locating a system ffmpeg and building the argument list to drive it,
 * following the exact search order `packages/runtime-host/src/binary-discovery.ts`
 * already uses to find Chrome: an env override first, then `which`/`where`,
 * then fixed per-platform install paths, and a candidate never counts as
 * found until it can actually report a version
 * (`binary-discovery.ts:282`, "A binary that cannot report a version
 * counts as not found; keep searching").
 *
 * Nothing here uses a shell. `which`/`where` and ffmpeg itself are always
 * invoked through `execFile`, passing an argument array, never a
 * concatenated command string, because `req.frames[].file` and `outPath`
 * both ultimately trace back to a
 * recording id and a path an attacker can influence in the general case.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EncodeRequest } from '@browserglass/plugin-api';

const execFileAsync = promisify(execFile);

/** A resolved, version-verified ffmpeg binary. */
export interface ResolvedFfmpeg {
  readonly path: string;
  readonly version: string;
}

function envFfmpegPath(): string | null {
  const v = process.env['BGLS_FFMPEG_PATH'];
  return v && existsSync(v) ? v : null;
}

/** Same shape as `binary-discovery.ts`'s own `which()`: `where` on Windows, `which` everywhere else. */
function which(bin: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], { encoding: 'utf8', timeout: 2000 });
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/** Fixed install locations a system ffmpeg commonly lands in, per platform. Not exhaustive; `which`/`where` and `BGLS_FFMPEG_PATH` are the primary paths. */
function fixedPaths(): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    case 'linux':
      return ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'];
    case 'win32': {
      const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
      const localAppData = process.env['LOCALAPPDATA'] ?? '';
      return [
        'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
        join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
        ...(localAppData ? [join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')] : []),
      ];
    }
    default:
      return [];
  }
}

/** Runs `<path> -version` and parses the first line's version token. `null` means "cannot report a version", which counts as not found. */
async function versionFor(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['-version'], { timeout: 3000 });
    const match = /ffmpeg version (\S+)/.exec(stdout);
    if (match?.[1]) return match[1];
    const firstLine = stdout.split(/\r?\n/)[0]?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a system ffmpeg, verifying it can report a version before
 * trusting it. Returns `null` rather than throwing: a missing ffmpeg is a
 * normal, reportable outcome (`probe()` says so and `--video` fails with
 * the install instruction), not a crash.
 */
export async function resolveFfmpeg(): Promise<ResolvedFfmpeg | null> {
  const candidates: string[] = [];
  const env = envFfmpegPath();
  if (env) candidates.push(env);
  const found = which(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (found) candidates.push(found);
  candidates.push(...fixedPaths());

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const version = await versionFor(candidate);
    if (version) return { path: candidate, version };
  }
  return null;
}

/** `req.frames[].file` "is never a path" per `@browserglass/plugin-api`'s own doc comment; this is the plugin checking that claim rather than trusting it before it is spliced into a path on disk. */
export function isPlainFilename(file: string): boolean {
  return (
    file.length > 0 && file !== '.' && file !== '..' && !file.includes('/') && !file.includes('\\')
  );
}

/** {@link buildConcatList}'s result: either a ready-to-write concat file, or the first frame filename that failed {@link isPlainFilename}. */
export type ConcatListResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly invalidFrame: string };

const FALLBACK_FRAME_DURATION_S = 1 / 30;

function quoteConcatPath(path: string): string {
  // ffmpeg's concat demuxer quoting: a path goes inside single quotes, and
  // a literal single quote inside it is escaped as '\''  (close quote,
  // escaped quote, reopen quote), the same escaping the shell itself uses.
  return path.replace(/'/g, "'\\''");
}

/**
 * Builds an ffmpeg `concat` demuxer list (see `ffmpeg -f concat`) honouring
 * each frame's real on-screen duration: `EncoderFrame.tsDeltaMs` is
 * "milliseconds since the current sidEpoch's base"
 * (`packages/core/src/recording/types.ts`, `RecordedFrameEntry.tsDeltaMs`),
 * so a frame's duration is the delta to the *next* frame's `tsDeltaMs`, not
 * `tsDeltaMs` itself. When `req.fps` is given every frame instead gets a
 * constant `1/fps` duration, matching `EncodeRequest.fps`'s doc: "Absent
 * means the plugin derives one from `tsDeltaMs`."
 *
 * `EncoderFrame` carries `sidEpoch`, so an epoch boundary is CHECKED rather
 * than inferred: a delta measured across two different epochs is not a
 * duration at all, because `tsDeltaMs` restarts from that epoch's own base.
 * A non-positive delta within one epoch is a separate case, a genuine
 * anomaly, and both fall back to a fixed 1/30s rather than producing a zero
 * or negative duration ffmpeg would reject.
 *
 * The final frame is its own case and is an ESTIMATE, not a measurement.
 * How long it stayed on screen is the gap between it and the moment
 * recording stopped, which lives in the recording's `complete.json` and is
 * never handed to a plugin, so the interval before it is used instead.
 */
export function buildConcatList(req: EncodeRequest): ConcatListResult {
  const { frames } = req;
  for (const frame of frames) {
    if (!isPlainFilename(frame.file)) {
      return { ok: false, invalidFrame: frame.file };
    }
  }

  const lines: string[] = [];
  let previousDurationS: number | null = null;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const absPath = join(req.inputDir, frame.file);
    lines.push(`file '${quoteConcatPath(absPath)}'`);

    let durationS: number;
    if (req.fps !== undefined && req.fps > 0) {
      durationS = 1 / req.fps;
    } else {
      const next = frames[i + 1];
      if (next === undefined) {
        // The last frame has no successor to measure against, and its real
        // on screen duration is NOT knowable from `EncoderFrame`: how long
        // it stayed up is the gap between it and the moment recording
        // stopped, which lives in the recording's `complete.json` and is
        // never handed to a plugin. The interval before it is the best
        // estimate available, and it is a estimate rather than a fact.
        durationS = previousDurationS ?? FALLBACK_FRAME_DURATION_S;
      } else if (next.sidEpoch !== frame.sidEpoch) {
        // A real epoch boundary, which is now checkable rather than
        // inferred. `tsDeltaMs` is measured from the base of its own
        // `sidEpoch` and that base resets on a bump, so a delta ACROSS a
        // boundary is not a duration at all and must not be treated as one.
        // Before `EncoderFrame` carried `sidEpoch` the only clue was a non
        // positive delta, which caught some resets and missed any where the
        // new epoch's base happened to be larger.
        durationS = FALLBACK_FRAME_DURATION_S;
      } else {
        const deltaMs = next.tsDeltaMs - frame.tsDeltaMs;
        durationS =
          Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs / 1000 : FALLBACK_FRAME_DURATION_S;
      }
    }
    previousDurationS = durationS;
    lines.push(`duration ${durationS.toFixed(6)}`);
  }

  // The last listed file is deliberately NOT repeated.
  //
  // Repeating it is a widely copied idiom for making the concat demuxer
  // honour the final `duration`, and it works, and it costs a frame that
  // was never captured. Measured against ffmpeg 9.0.1 with five real input
  // frames: with the repeat the output decodes to SIX frames, and with the
  // last duration left at the old 1/30s fallback the sixth landed close
  // enough to the fifth that a re-mux warned `non monotonically increasing
  // dts: 4 >= 4`. Without the repeat the output decodes to five frames at
  // presentation times 0, 1, 2, 3 and 4 seconds, which is exactly the five
  // moments that were captured, and a re-mux warns about nothing.
  //
  // The cost of not repeating is that the container comes out one frame
  // interval short, 4.04 seconds rather than 5, because the demuxer drops
  // the final duration. That is the honest trade: a recording is evidence
  // of what a browser displayed, and a video claiming a sixth frame that
  // no one captured is a worse lie than a tail that ends early.
  return { ok: true, content: `${lines.join('\n')}\n` };
}

/**
 * The fixed ffmpeg argument list, an array (never a shell string) so a
 * hostile `concatListPath` or `outPath` cannot be interpreted as anything
 * but one literal argument each. There is no field here for a plugin
 * caller to widen: no codec, no bitrate, no filter graph, matching
 * `EncodeRequest`'s own refusal of an options passthrough.
 */
export function buildFfmpegArgs(concatListPath: string, outPath: string): string[] {
  // `-fps_mode vfr`, not `-vsync vfr`. The two mean the same thing and
  // `-vsync` is the one that no longer exists: it was deprecated in favour
  // of `-fps_mode` in ffmpeg 5.0 and REMOVED outright by ffmpeg 9, which
  // answers `Unrecognized option 'vsync'` and exits without writing a file.
  //
  // Found by running it. This function had a unit test asserting the exact
  // argument array it produced, and that test passed the whole time, because
  // it checked that the arguments were the ones this function meant to emit
  // and nothing checked that ffmpeg accepted them. The first real encode
  // against ffmpeg 9.0.1 failed immediately. That is the entire reason
  // this plugin is judged by a real end to end export rather than by a
  // green test suite.
  //
  // The floor this sets is ffmpeg 5.0, released 2022. Stated in the README
  // rather than probed for, since `probe()` already reports the version it
  // found and a caller on something older gets a real ffmpeg error naming
  // the option, which is more use than a version assertion of ours.
  return [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-fps_mode',
    'vfr',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ];
}
