import { execFile } from 'node:child_process';
/**
 * `@browserglass/plugin-video-export`: the reference `frame-encoder`
 * plugin.
 *
 * This needs no browser and holds no `CdpBridge`: `bgls record export`
 * already writes every frame to disk, plus a `manifest.json` sidecar with
 * each frame's `tsDeltaMs`, before this plugin is ever called
 * (`packages/cli/src/commands/record.ts`, `runRecordExport`). The whole
 * job is a pure file-to-file transform over data that already exists,
 * performed after the recording session that produced it has ended.
 * That is exactly why this plugin can be handed no bridge, no session,
 * and no target id at all: it has no use for any of them.
 *
 * The encoder itself is a system ffmpeg, located the way
 * `packages/runtime-host/src/binary-discovery.ts` locates Chrome (see
 * `./ffmpeg.ts`), never bundled: a per-platform ffmpeg build is tens of megabytes, which the single-file
 * rule this whole package builds under (see `tsup.config.ts`) makes
 * deliberately awkward. A machine without ffmpeg is a normal, reportable
 * outcome, both from `probe()` and from `encode()`, never a thrown error.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  EncodeRequest,
  EncodeResult,
  FrameEncoderPlugin,
  PluginProbe,
} from '@browserglass/plugin-api';
import { buildConcatList, buildFfmpegArgs, resolveFfmpeg } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

/**
 * The host contract range this plugin was built against. `packages/cli`'s
 * loader checks this against the host's own contract version at load
 * time; this plugin pins
 * it to the `@browserglass/plugin-api` version it was actually built
 * against, which is the only version of "the contract" that exists yet.
 */
const HOST_API_RANGE = '^0.1.0-alpha.0';

async function probe(): Promise<PluginProbe> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    return {
      usable: false,
      detail:
        'ffmpeg not found; searched BGLS_FFMPEG_PATH, PATH (which/where), and common per-platform install locations. Install ffmpeg or set BGLS_FFMPEG_PATH to its executable.',
    };
  }
  return { usable: true, detail: `ffmpeg ${ffmpeg.version} at ${ffmpeg.path}` };
}

async function encode(req: EncodeRequest, signal: AbortSignal): Promise<EncodeResult> {
  if (req.frames.length === 0) {
    return { outcome: 'unsupported', detail: 'no frames to encode', bytesWritten: 0 };
  }

  const concatList = buildConcatList(req);
  if (!concatList.ok) {
    return {
      outcome: 'unsupported',
      detail: `frame file must be a bare filename within inputDir, got ${JSON.stringify(concatList.invalidFrame)}`,
      bytesWritten: 0,
    };
  }

  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    return {
      outcome: 'unsupported',
      detail:
        'ffmpeg not found; searched BGLS_FFMPEG_PATH, PATH (which/where), and common per-platform install locations. Install ffmpeg or set BGLS_FFMPEG_PATH to its executable.',
      bytesWritten: 0,
    };
  }

  if (signal.aborted) {
    return { outcome: 'unsupported', detail: 'encode aborted before it started', bytesWritten: 0 };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bgls-plugin-video-export-'));
  const concatListPath = join(tmpDir, 'concat.txt');
  try {
    writeFileSync(concatListPath, concatList.content, 'utf8');
    const args = buildFfmpegArgs(concatListPath, req.outPath);
    // execFile, not exec: args is a real argv array, never a shell string,
    // so neither req.outPath nor anything derived from a frame filename is
    // ever parsed as shell syntax (the same reasoning arg-lists.ts applies
    // to launch flags).
    await execFileAsync(ffmpeg.path, args, { signal, maxBuffer: 16 * 1024 * 1024 });

    let bytesWritten = 0;
    try {
      bytesWritten = statSync(req.outPath).size;
    } catch {
      // The host stats the output file itself and does not trust this
      // field (EncodeResult.bytesWritten's own doc comment); a failed
      // local stat here just means this best-effort number stays 0.
    }
    return {
      outcome: 'encoded',
      detail: `encoded ${req.frames.length} frames with ffmpeg ${ffmpeg.version} at ${ffmpeg.path}`,
      bytesWritten,
    };
  } catch (err) {
    if (signal.aborted) {
      return { outcome: 'unsupported', detail: 'encode aborted', bytesWritten: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: 'unsupported', detail: `ffmpeg failed: ${message}`, bytesWritten: 0 };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const plugin: FrameEncoderPlugin = {
  id: '@browserglass/plugin-video-export',
  kind: 'frame-encoder',
  hostApi: HOST_API_RANGE,
  platforms: ['darwin', 'linux', 'win32'],
  summary: "Encodes a recording's exported frames into a video file using a system ffmpeg.",
  probe,
  encode,
};

export default plugin;
