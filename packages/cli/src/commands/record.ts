/**
 * `bgls record`: the whole recording surface from the CLI's own side.
 * Two different shapes, sharing one subcommand group because they answer
 * two different questions about the same feature:
 *
 * - `start`/`stop` are LIVE: they connect an `AutomationClient`
 *   (`@browserglass/automation`, via `util/drive.ts`'s
 *   `connectAutomation()`) to a running instance and call
 *   `recording.start`/`.stop` over that socket, exactly like `instances
 *   navigate`/`click` connect to drive a target. They need a running
 *   gateway and a token, and they answer "start/stop recording right
 *   now."
 * - `list`/`export` are DISK: read only, over the exact on disk layout
 *   `@browserglass/server`'s `DiskRecordingSink`
 *   (`packages/server/src/recording/disk-recording-sink.ts`) already
 *   writes once ANY session (this CLI's `start`, or a caller driving the
 *   wire directly) calls `recording.start`:
 *
 *       <root>/<recordingId>/meta.json      -- RecordingMeta, written once
 *       <root>/<recordingId>/index.jsonl    -- one RecordedFrameEntry per line, append only
 *       <root>/<recordingId>/frames/<n>.bin -- one file per frame, zero padded frameIndex
 *       <root>/<recordingId>/complete.json  -- written once, at recording.stop
 *
 *   They need no running gateway at all, and they answer "what actually
 *   landed on disk, including from a session that has since ended."
 *
 * WHY `list`/`export` READ THE DISK DIRECTLY, NOT THE WIRE. `recording.list`
 * (`@browserglass/protocol`'s `wire/messages/recording.ts`) answers "what
 * is this live session's socket aware of," an in memory view that forgets
 * everything the moment the socket closes. A recording is a durable
 * artifact that outlives the socket by design (that module's own doc
 * argues this at length), and the whole point of `complete.json`'s
 * presence or absence is to tell a completed recording from one whose
 * session died mid write, which is exactly the case a live socket cannot
 * answer either, because there is no socket left to ask. Reading the
 * directory this command was pointed at is the only way to answer that
 * question after the fact. `start`/`stop` do not have this problem: they
 * are asking the live socket to do something right now, not to remember
 * something that happened earlier.
 *
 * WHERE THAT DIRECTORY IS. `recordings.dir` (`packages/server/src/config/
 * resolve.ts`) defaults to a directory scoped to the server process's own
 * pid under the system temp directory, deliberately, so two gateways on
 * one machine never collide. Nothing about that default is guessable from
 * outside that process once it exits. `--dir`, or `BGLS_RECORDING_DIR`
 * (the same environment variable `resolveConfig()` itself reads), or
 * `bgls serve --recordings-dir` (see `commands/serve.ts`) are the only
 * ways to point this command and a real gateway at the same directory;
 * this command defaults `--dir` to `<data-dir>/recordings` purely as a
 * convention to pair with, never as a claim about what any given `bgls
 * serve` actually used.
 *
 * `replay` is deliberately NOT implemented here (see `recordReplayCommand`
 * below): playing frames back on a timeline needs a viewer, which this
 * CLI does not have, and `export` is offered as the honest alternative.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RecordedFrameEntry, RecordingMeta } from '@browserglass/core';
import type { EncodeRequest, EncodeResult, EncoderFrame } from '@browserglass/plugin-api';
import { defineCommand } from 'citty';
import {
  GLOBAL_ARGS,
  type GatewayConnection,
  type ParsedGlobalArgs,
  resolveGatewayConnection,
  resolveGlobalFlags,
} from '../context.js';
import { defaultPluginsFilePath, readPluginsFile } from '../plugins/record.js';
import { encoderFor } from '../plugins/registry.js';
import { defaultDataDir } from '../session-file.js';
import {
  RECORDING_CAPS,
  connectAutomation,
  errorMessage,
  mapDriveErrorToExitCode,
} from '../util/drive.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

const RECORDING_DIR_ARGS = {
  'data-dir': {
    type: 'string',
    description:
      'Root directory recordings live under by convention: <data-dir>/recordings. Default ./bgls-data. Ignored when --dir is given.',
  },
  dir: {
    type: 'string',
    description:
      'Recordings root directory (overrides --data-dir). Must be the same directory a "bgls serve --recordings-dir" (or BGLS_RECORDING_DIR) used: bgls serve defaults to a private per-process temp directory when neither is set, which this command cannot guess.',
  },
} as const;

/** Resolves the recordings root: `--dir`, then `BGLS_RECORDING_DIR` (the same env var the server itself reads), then `<data-dir>/recordings`. */
function resolveRecordingsDir(args: { dir?: string; 'data-dir'?: string }): string {
  if (args.dir !== undefined) return resolve(args.dir);
  if (process.env['BGLS_RECORDING_DIR'] !== undefined)
    return resolve(process.env['BGLS_RECORDING_DIR']);
  return resolve(join(args['data-dir'] ?? defaultDataDir(), 'recordings'));
}

/** Rejects a recordingId that could steer a joined path outside `root` (defence in depth; a local operator already controls this machine, but there is no reason to trust an id blindly either). */
function isSafeRecordingId(id: string): boolean {
  return id.length > 0 && !id.includes('/') && !id.includes('\\') && id !== '.' && id !== '..';
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Parses `index.jsonl`, tolerating a truncated final line (a session that died mid write can leave a partial JSON object on the last line). */
function readIndex(path: string): RecordedFrameEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: RecordedFrameEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as RecordedFrameEntry);
    } catch {
      // Truncated/corrupt last line from a mid-write crash. Skip it; every
      // earlier line is still a complete, valid entry.
    }
  }
  return entries;
}

/** What `complete.json` holds, mirrored from `DiskRecordingSink.finalize()`'s own shape rather than importing a server internal for one read only JSON contract. */
interface RecordingCompletionFile {
  readonly stoppedAtMs: number;
  readonly framesWritten: number;
  readonly failed: boolean;
  readonly errorMessage?: string;
}

/** One recording's summary, human and `--json` alike. */
interface RecordingListEntry {
  readonly recordingId: string;
  readonly targetId: string | null;
  readonly mode: 'live' | 'thumbnail' | null;
  readonly startedAtMs: number | null;
  readonly stoppedAtMs: number | null;
  readonly frameCount: number;
  readonly sizeBytes: number;
  /** `true` once `complete.json` exists, i.e. `recording.stop` actually ran (`finalize()`'s own doc). Its absence means the session died mid recording, not that the recording is still running (this command has no way to tell those apart from disk alone). */
  readonly completed: boolean;
  /** `null` when `completed` is `false`: whether the recording degraded to a no-op is only known once `complete.json` says so. */
  readonly failed: boolean | null;
  readonly errorMessage: string | null;
}

function readRecording(root: string, recordingId: string): RecordingListEntry {
  const dir = join(root, recordingId);
  const meta = readJson<Partial<RecordingMeta>>(join(dir, 'meta.json'));
  const index = readIndex(join(dir, 'index.jsonl'));
  const complete = readJson<RecordingCompletionFile>(join(dir, 'complete.json'));
  const sizeBytes = index.reduce(
    (sum, e) => sum + (typeof e.byteLength === 'number' ? e.byteLength : 0),
    0,
  );
  return {
    recordingId,
    targetId: meta?.targetId ?? null,
    mode: meta?.mode ?? null,
    startedAtMs: meta?.startedAtMs ?? null,
    stoppedAtMs: complete?.stoppedAtMs ?? null,
    frameCount: complete?.framesWritten ?? index.length,
    sizeBytes,
    completed: complete !== null,
    failed: complete !== null ? complete.failed : null,
    errorMessage: complete?.errorMessage ?? null,
  };
}

function listRecordings(root: string): RecordingListEntry[] {
  if (!existsSync(root)) return [];
  const dirents = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const entries = dirents.map((d) => readRecording(root, d.name));
  entries.sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
  return entries;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function printListHuman(
  printer: Printer,
  root: string,
  entries: readonly RecordingListEntry[],
): void {
  if (entries.length === 0) {
    printer.info(
      existsSync(root)
        ? `no recordings in ${root}`
        : `no recordings directory at ${root} (nothing recorded here yet, or --dir doesn't match the "bgls serve --recordings-dir"/BGLS_RECORDING_DIR value that produced them)`,
    );
    return;
  }
  for (const e of entries) {
    const status = !e.completed ? 'INCOMPLETE' : e.failed === true ? 'FAILED' : 'DONE';
    const started =
      e.startedAtMs !== null ? new Date(e.startedAtMs).toISOString() : 'unknown start time';
    printer.info(
      `  [${status}] ${e.recordingId}  started ${started}  ${e.frameCount} frames  ${formatBytes(e.sizeBytes)}`,
    );
    if (e.targetId !== null)
      printer.info(`         target ${e.targetId}${e.mode !== null ? ` (${e.mode})` : ''}`);
    if (!e.completed)
      printer.info(
        '         no complete.json: the session that wrote this recording ended without calling recording.stop',
      );
    if (e.errorMessage !== null) printer.warn(`         error: ${e.errorMessage}`);
  }
  printer.info(`\n${entries.length} recording${entries.length === 1 ? '' : 's'} in ${root}.`);
}

/** `bgls record start`. Connects an `AutomationClient` to a running instance and calls `recording.start`; see this module's own doc for why this is a different shape from `list`/`export`. */
export const recordStartCommand = defineCommand({
  meta: {
    name: 'start',
    description:
      "Start a durable, disk-persisted recording of a target's stream on a running instance. Needs a running gateway and a token carrying BOTH the capture and download capabilities.",
  },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    mode: {
      type: 'string',
      description:
        'live | thumbnail. Default live (the full screencast). thumbnail pins the recording to the low-cost polling tier instead.',
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    let connection: GatewayConnection;
    try {
      connection = await resolveGatewayConnection(flags);
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    const instanceId = args['instanceId'] as string;
    const targetId = args['target'] as string | undefined;
    const modeArg = args['mode'] as string | undefined;
    if (modeArg !== undefined && modeArg !== 'live' && modeArg !== 'thumbnail') {
      printer.error(`invalid --mode "${modeArg}": expected "live" or "thumbnail".`);
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    try {
      const client = await connectAutomation(connection, instanceId, {
        caps: RECORDING_CAPS,
        ...(targetId !== undefined ? { targetId } : {}),
      });
      try {
        const handle = await client.startRecording({
          ...(modeArg !== undefined ? { mode: modeArg } : {}),
        });
        printer.result(handle, (h) => {
          printer.success(`recording ${h.recordingId} started on ${h.targetId} (${h.mode})`);
          printer.info(
            'this is written to the gateway\'s own disk and outlives this connection; read it back with "bgls record list"/"bgls record export" against the same --recordings-dir the gateway used. Stop it with "bgls record stop".',
          );
        });
      } finally {
        client.close();
      }
    } catch (err) {
      printer.error(errorMessage(err));
      process.exitCode = mapDriveErrorToExitCode(err);
    }
  },
});

/** `bgls record stop`. Connects an `AutomationClient` to a running instance and calls `recording.stop`; see this module's own doc for why this is a different shape from `list`/`export`. */
export const recordStopCommand = defineCommand({
  meta: {
    name: 'stop',
    description:
      'Stop a recording started with "bgls record start". Needs a running gateway and a token carrying BOTH the capture and download capabilities.',
  },
  args: {
    ...GLOBAL_ARGS,
    instanceId: {
      type: 'positional',
      description: 'Instance id the recording is running on.',
      required: true,
    },
    recordingId: {
      type: 'positional',
      description: 'Recording id, from "bgls record start".',
      required: true,
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    let connection: GatewayConnection;
    try {
      connection = await resolveGatewayConnection(flags);
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    const instanceId = args['instanceId'] as string;
    const recordingId = args['recordingId'] as string;

    try {
      const client = await connectAutomation(connection, instanceId, { caps: RECORDING_CAPS });
      try {
        const result = await client.stopRecording(recordingId);
        printer.result(result, (r) => {
          if (r.failed) {
            printer.warn(
              `recording ${r.recordingId} stopped, but it had already degraded to a no-op after a write failure; ${r.framesWritten} frame(s) reached disk before that happened.`,
            );
          } else {
            printer.success(
              `recording ${r.recordingId} stopped: ${r.framesWritten} frame${r.framesWritten === 1 ? '' : 's'} written.`,
            );
          }
          printer.info(
            'read it back with "bgls record list"/"bgls record export" against the same --recordings-dir the gateway used.',
          );
        });
      } finally {
        client.close();
      }
    } catch (err) {
      printer.error(errorMessage(err));
      process.exitCode = mapDriveErrorToExitCode(err);
    }
  },
});

/** `bgls record list`. */
export const recordListCommand = defineCommand({
  meta: { name: 'list', description: 'List recordings found under the recordings directory.' },
  args: { ...GLOBAL_ARGS, ...RECORDING_DIR_ARGS },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    const root = resolveRecordingsDir(args as { dir?: string; 'data-dir'?: string });
    const entries = listRecordings(root);
    printer.result({ root, recordings: entries }, (r) =>
      printListHuman(printer, r.root, r.recordings),
    );
    process.exitCode = EXIT_CODES.ok;
  },
});

/** One frame written by `export`, `--json`/manifest alike. */
interface ExportedFrame {
  readonly frameIndex: number;
  readonly file: string;
  readonly seq: number;
  readonly gen: number;
  readonly sidEpoch: number;
  readonly tsDeltaMs: number;
  readonly byteLength: number;
}

function frameFileName(frameIndex: number): string {
  return `${String(frameIndex).padStart(8, '0')}.bin`;
}

/** Sniffs whether `bytes` is a PNG or JPEG (the only two codecs a recorded frame can be, per `packages/core/src/stream/types.ts`'s `EncodeSpec.codec`), by magic number, the same check `frame-dimensions.ts` already relies on for the same two formats. */
function sniffExtension(bytes: Uint8Array): 'png' | 'jpg' | 'bin' {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  return 'bin';
}

/** `bgls record export`'s real work, factored out for testability. Returns `{ code, exported, missing, frames }`; `frames` is exactly what `manifest.json` carries, and is what `--video` hands to a frame-encoder plugin without re-reading anything. */
export function runRecordExport(
  root: string,
  recordingId: string,
  outDir: string,
): { code: number; exported: number; missing: number; frames: ExportedFrame[] } {
  const recDir = join(root, recordingId);
  const index = readIndex(join(recDir, 'index.jsonl'));
  if (index.length === 0) {
    // `frames: []` is required, not incidental. A caller passing `--video`
    // reads this field unconditionally, and an empty recording is a real
    // case: `index.jsonl` is append only, so a session that died before its
    // first frame leaves the file present and empty.
    return { code: EXIT_CODES.preconditionFailed, exported: 0, missing: 0, frames: [] };
  }
  mkdirSync(outDir, { recursive: true });
  const frames: ExportedFrame[] = [];
  let missing = 0;
  for (const entry of index) {
    const framePath = join(recDir, 'frames', frameFileName(entry.frameIndex));
    if (!existsSync(framePath)) {
      missing += 1;
      continue;
    }
    const bytes = new Uint8Array(readFileSync(framePath));
    const ext = sniffExtension(bytes);
    const file = `${String(entry.frameIndex).padStart(8, '0')}.${ext}`;
    writeFileSync(join(outDir, file), bytes);
    frames.push({
      frameIndex: entry.frameIndex,
      file,
      seq: entry.seq,
      gen: entry.gen,
      sidEpoch: entry.sidEpoch,
      tsDeltaMs: entry.tsDeltaMs,
      byteLength: entry.byteLength,
    });
  }
  const meta = readJson<Partial<RecordingMeta>>(join(recDir, 'meta.json'));
  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(
      {
        recordingId,
        targetId: meta?.targetId ?? null,
        mode: meta?.mode ?? null,
        startedAtMs: meta?.startedAtMs ?? null,
        frames,
      },
      null,
      2,
    )}\n`,
  );
  return {
    code: frames.length > 0 ? EXIT_CODES.ok : EXIT_CODES.preconditionFailed,
    exported: frames.length,
    missing,
    frames,
  };
}

/**
 * What `--video` accomplished, or the specific reason it did not. One shape
 * per fact `registry.encoderFor()` (or the encoder itself) can report,
 * on purpose: absence,
 * a wrong version, a load failure, an honest "can't run right now", and a
 * throw at call time are different facts, never collapsed into one
 * "could not make a video".
 */
type VideoOutcome =
  | { readonly status: 'encoded'; readonly path: string; readonly bytesWritten: number }
  | { readonly status: 'unsupported'; readonly detail: string }
  | { readonly status: 'encode-mismatch'; readonly detail: string }
  | { readonly status: 'absent' }
  | { readonly status: 'not-applicable'; readonly reason: string }
  | { readonly status: 'integrity-mismatch'; readonly reason: string }
  | { readonly status: 'load-failed'; readonly reason: string }
  | {
      readonly status: 'unsupported-host-api';
      readonly reason: string;
      readonly declared: string;
      readonly hostApiVersion: string;
    }
  | { readonly status: 'probe-failed'; readonly reason: string }
  | { readonly status: 'unusable'; readonly detail: string };

/** The `E_...` code `--json` reports for every non-`'encoded'` {@link VideoOutcome}. */
function videoErrorCode(status: Exclude<VideoOutcome['status'], 'encoded'>): string {
  switch (status) {
    case 'absent':
      return 'E_PLUGIN_ABSENT';
    case 'not-applicable':
      return 'E_PLUGIN_NOT_APPLICABLE';
    case 'integrity-mismatch':
      return 'E_PLUGIN_INTEGRITY_MISMATCH';
    case 'load-failed':
      return 'E_PLUGIN_LOAD_FAILED';
    case 'unsupported-host-api':
      return 'E_PLUGIN_UNSUPPORTED_HOST_API';
    case 'probe-failed':
      return 'E_PLUGIN_PROBE_FAILED';
    case 'unusable':
      return 'E_PLUGIN_UNUSABLE';
    case 'unsupported':
      return 'E_PLUGIN_ENCODE_UNSUPPORTED';
    case 'encode-mismatch':
      return 'E_PLUGIN_ENCODE_MISMATCH';
  }
}

/** The human sentence for every non-`'encoded'` {@link VideoOutcome}: what happened, and, since the frame export itself already succeeded, a reminder of what the human already has. */
function videoOutcomeMessage(
  outcome: Exclude<VideoOutcome, { status: 'encoded' }>,
  exported: number,
  outDir: string,
): string {
  const already = `Exported ${exported} frame${exported === 1 ? '' : 's'} and manifest.json to ${outDir} instead.`;
  switch (outcome.status) {
    case 'absent':
      return `no frame-encoder plugin is installed, so --video cannot produce a video. ${already} Install one with "bgls plugins add <spec>", or feed manifest.json's per-frame tsDeltaMs to your own tool.`;
    case 'not-applicable':
      return `the recorded frame-encoder plugin does not apply on this platform: ${outcome.reason}. ${already}`;
    case 'integrity-mismatch':
      return `the recorded frame-encoder plugin failed integrity verification: ${outcome.reason}. ${already} Run "bgls plugins verify" to re-check it.`;
    case 'load-failed':
      return `the frame-encoder plugin did not load: ${outcome.reason}. ${already} Run "bgls plugins verify" to re-check every plugin.`;
    case 'unsupported-host-api':
      return `the frame-encoder plugin wants host API ${outcome.declared}, this host offers ${outcome.hostApiVersion} (${outcome.reason}). ${already}`;
    case 'probe-failed':
      return `the frame-encoder plugin's probe failed: ${outcome.reason}. ${already}`;
    case 'unusable':
      return `the frame-encoder plugin reports it cannot run right now: ${outcome.detail}. ${already}`;
    case 'unsupported':
      return `the frame-encoder plugin could not produce a video: ${outcome.detail}. ${already}`;
    case 'encode-mismatch':
      return `the frame-encoder plugin reported success but did not write ${outcome.detail}. ${already}`;
  }
}

/** The `--json` shape for {@link VideoOutcome}: the raw outcome fields, plus (for anything but `'encoded'`) the same `{ error: { code, message } }` shape `E_NOT_FOUND`/`E_NO_FRAMES` already use elsewhere in this command. */
function videoResultJson(
  video: VideoOutcome,
  exported: number,
  outDir: string,
): Record<string, unknown> {
  if (video.status === 'encoded') return { ...video };
  return {
    ...video,
    error: {
      code: videoErrorCode(video.status),
      message: videoOutcomeMessage(video, exported, outDir),
    },
  };
}

/**
 * Resolves and runs the `frame-encoder` plugin for `--video`, or reports
 * exactly why it could not (see `docs/plugins.md`).
 * Never throws: `registry.encoderFor()`/`load.ts` already convert every
 * failure into a named result, and the encoder's own `encode()` throwing
 * is caught here the same way, matching the "throws at call time" rule
 * for a `frame-encoder`: converted to `outcome: 'unsupported'`.
 */
async function runVideoExport(
  frames: readonly ExportedFrame[],
  outDir: string,
  outPath: string,
): Promise<VideoOutcome> {
  const pluginsFilePath = defaultPluginsFilePath();
  const read = readPluginsFile(pluginsFilePath);
  if (!read.ok) {
    return { status: 'load-failed', reason: `${read.reason}` };
  }
  const dataDir = defaultDataDir();
  const availability = await encoderFor(read.file, dataDir);
  if (availability.status !== 'ready' && availability.status !== 'unusable') {
    return availability;
  }
  if (availability.status === 'unusable') {
    return { status: 'unusable', detail: availability.probe.detail };
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const encoderFrames: EncoderFrame[] = frames.map((f) => ({
    frameIndex: f.frameIndex,
    file: f.file,
    tsDeltaMs: f.tsDeltaMs,
    sidEpoch: f.sidEpoch,
    byteLength: f.byteLength,
  }));
  const request: EncodeRequest = { inputDir: outDir, frames: encoderFrames, outPath };
  let result: EncodeResult;
  try {
    result = await availability.plugin.encode(request, new AbortController().signal);
  } catch (err) {
    return { status: 'unsupported', detail: errorMessage(err) };
  }
  if (result.outcome === 'unsupported') {
    return { status: 'unsupported', detail: result.detail };
  }
  // Nothing the plugin says about its own success is taken on trust. A real `statSync` of `outPath`, not `result.bytesWritten`.
  if (!existsSync(outPath)) {
    return { status: 'encode-mismatch', detail: outPath };
  }
  const bytesWritten = statSync(outPath).size;
  return { status: 'encoded', path: outPath, bytesWritten };
}

/** `bgls record export`. */
export const recordExportCommand = defineCommand({
  meta: {
    name: 'export',
    description:
      'Export a recording\'s frames as standalone JPEG/PNG files plus a timing manifest (manifest.json). Does NOT produce a video by itself: this build has no video encoder or muxer (packages/core deliberately ships no ffmpeg dependency). Feed manifest.json\'s per-frame tsDeltaMs to your own video tool, or pass --video <file.mp4> to use an installed frame-encoder plugin (see "bgls plugins add"), if you want one.',
  },
  args: {
    ...GLOBAL_ARGS,
    ...RECORDING_DIR_ARGS,
    recordingId: { type: 'positional', description: 'Recording id.', required: true },
    out: {
      type: 'string',
      description:
        'Output directory for the exported frames and manifest.json. Default ./<recordingId>-frames.',
    },
    video: {
      type: 'string',
      description:
        'Also produce a video at this path, using an installed frame-encoder plugin. Requires "bgls plugins add" to have installed one; without --video nothing about a plain export changes, and no plugin is loaded.',
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    const recordingId = args['recordingId'] as string;
    if (!isSafeRecordingId(recordingId)) {
      printer.error(`invalid recording id "${recordingId}".`);
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    const root = resolveRecordingsDir(args as { dir?: string; 'data-dir'?: string });
    const recDir = join(root, recordingId);
    if (!existsSync(recDir) || !statSync(recDir).isDirectory()) {
      const message = `no recording "${recordingId}" found in ${root}. Run "bgls record list" (with the same --dir) to see what's there.`;
      printer.result({ error: { code: 'E_NOT_FOUND', message } }, () => printer.error(message));
      process.exitCode = EXIT_CODES.notFound;
      return;
    }
    const outDir = resolve(args['out'] ?? `./${recordingId}-frames`);
    const { code, exported, missing, frames } = runRecordExport(root, recordingId, outDir);
    if (exported === 0) {
      const message = `recording "${recordingId}" has no exportable frames (index.jsonl is missing or empty).`;
      printer.result({ error: { code: 'E_NO_FRAMES', message } }, () => printer.error(message));
      process.exitCode = code;
      return;
    }

    const videoArg = args['video'] as string | undefined;
    let video: VideoOutcome | undefined;
    if (videoArg !== undefined) {
      video = await runVideoExport(frames, outDir, resolve(videoArg));
    }

    printer.result(
      {
        recordingId,
        outDir,
        exported,
        missing,
        ...(video !== undefined ? { video: videoResultJson(video, exported, outDir) } : {}),
      },
      (r) => {
        printer.success(
          `exported ${r.exported} frame${r.exported === 1 ? '' : 's'} to ${r.outDir}`,
        );
        if (r.missing > 0)
          printer.warn(
            `${r.missing} frame${r.missing === 1 ? '' : 's'} listed in the index but missing from disk were skipped.`,
          );
        printer.info(
          'this is a JPEG/PNG frame sequence plus a timing manifest, not a video; see manifest.json.',
        );
        if (video !== undefined) {
          if (video.status === 'encoded') {
            printer.success(`encoded video to ${video.path} (${video.bytesWritten} bytes).`);
          } else {
            printer.error(videoOutcomeMessage(video, r.exported, r.outDir));
          }
        }
      },
    );
    process.exitCode =
      video !== undefined && video.status !== 'encoded' ? EXIT_CODES.operationalFailure : code;
  },
});

/**
 * `bgls record replay`: NOT implemented, deliberately, rather than
 * registered half working. Playing a recording back on a timeline (frame
 * N painted at its `tsDeltaMs`, honoring `gen`/`sidEpoch` discontinuities
 * exactly as `stream.ts` intends them to be read) needs a viewer that can
 * decode and paint JPEG/PNG frames, and this CLI has no such surface: it
 * is a terminal tool, not an image viewer. `bgls record export` is the
 * honest alternative, offered directly in this command's own error.
 */
export const recordReplayCommand = defineCommand({
  meta: { name: 'replay', description: 'Replay a recording. Not implemented in this build.' },
  args: {
    ...GLOBAL_ARGS,
    recordingId: { type: 'positional', description: 'Recording id.', required: true },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    const message =
      'bgls record replay is registered but not implemented in this build: playing a recording back on a timeline needs a viewer that can decode and paint JPEG/PNG frames, and this CLI has no such surface. Run "bgls record export <recordingId> --out <dir>" to pull the frames out as standalone images plus a timing manifest, then play them back with your own tool.';
    printer.result({ error: { code: 'E_NOT_IMPLEMENTED', message } }, () => printer.error(message));
    process.exitCode = EXIT_CODES.operationalFailure;
  },
});

/** `bgls record`: the assembled group. */
export const recordCommand = defineCommand({
  meta: {
    name: 'record',
    description: 'Start, stop, list, export, and replay session recordings.',
  },
  subCommands: {
    start: recordStartCommand,
    stop: recordStopCommand,
    list: recordListCommand,
    export: recordExportCommand,
    replay: recordReplayCommand,
  },
});
