import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgType, PayloadCodec, encodeBinaryHeader } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  imageBytesOf,
  recordExportCommand,
  recordListCommand,
  recordReplayCommand,
  recordStartCommand,
  recordStopCommand,
  runRecordExport,
} from '../../src/commands/record.js';
import { type PluginsFile, writePluginsFile } from '../../src/plugins/record.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { cleanupDir, makeTempDataDir, writeFixturePlugin } from '../plugins/fixtures.js';
import { captureStdio, parseJsonLines } from '../support/capture-io.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../support/fake-gateway.js';
import { installFetchMock } from '../support/rest-fetch-mock.js';
import { waitForCondition } from '../support/ws-helpers.js';

const BASE_ARGS = { endpoint: 'http://127.0.0.1:7443', token: 'admin-tkn' };
const GRANTED_WITH_DOWNLOAD = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
  'devtools',
  'download',
];

// `bgls record` reads the exact on-disk layout `DiskRecordingSink`
// (`packages/server/src/recording/disk-recording-sink.ts`) writes:
//
//   <root>/<id>/meta.json, index.jsonl, frames/<n>.bin, complete.json
//
// These tests build that layout by hand in a temp dir, exactly as a real
// server would have left it, without needing a running gateway at all.

let root: string | undefined;

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  process.exitCode = undefined;
  vi.unstubAllGlobals();
});

function newRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'bgls-record-test-'));
  return root;
}

const JPEG_SOI = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function frameFileName(frameIndex: number): string {
  return `${String(frameIndex).padStart(8, '0')}.bin`;
}

interface WriteRecordingOptions {
  readonly root: string;
  readonly recordingId: string;
  readonly targetId?: string;
  readonly mode?: 'live' | 'thumbnail';
  readonly startedAtMs?: number;
  readonly frames?: readonly Uint8Array[];
  readonly complete?: {
    stoppedAtMs: number;
    framesWritten: number;
    failed: boolean;
    errorMessage?: string;
  };
  readonly skipFrameFiles?: readonly number[];
}

/** Writes one recording's directory tree by hand, mirroring `DiskRecordingSink`'s own layout exactly. */
function writeRecording(opts: WriteRecordingOptions): void {
  const dir = join(opts.root, opts.recordingId);
  mkdirSync(join(dir, 'frames'), { recursive: true });
  const startedAtMs = opts.startedAtMs ?? Date.now();
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      recordingId: opts.recordingId,
      targetId: opts.targetId ?? 'tgt_00000000000000000000000000',
      mode: opts.mode ?? 'live',
      pinnedTierIndex: 0,
      startedAtMs,
    }),
  );
  const frames = opts.frames ?? [];
  const lines: string[] = [];
  frames.forEach((bytes, i) => {
    const frameIndex = i + 1;
    if (!(opts.skipFrameFiles ?? []).includes(frameIndex)) {
      writeFileSync(join(dir, 'frames', frameFileName(frameIndex)), bytes);
    }
    lines.push(
      JSON.stringify({
        frameIndex,
        seq: frameIndex,
        gen: 1,
        sidEpoch: 1,
        tsDeltaMs: frameIndex * 100,
        byteLength: bytes.length,
        writtenAtMs: startedAtMs + frameIndex * 100,
      }),
    );
  });
  if (lines.length > 0) writeFileSync(join(dir, 'index.jsonl'), `${lines.join('\n')}\n`);
  if (opts.complete !== undefined)
    writeFileSync(join(dir, 'complete.json'), JSON.stringify(opts.complete));
}

describe('bgls record start', () => {
  it('connects, calls recording.start, and reports the recordingId', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = recordStartCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        instanceId: 'inst_0000000000000000000000001',
        mode: 'thumbnail',
      },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    const gateway = startScriptedGateway(harness, { granted: GRANTED_WITH_DOWNLOAD as never });

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    expect(gateway.recordingStartCalls).toHaveLength(1);
    expect(gateway.recordingStartCalls[0]).toMatchObject({
      t: 'recording.start',
      mode: 'thumbnail',
    });
    const [line] = parseJsonLines(io.stdout) as [{ recordingId: string; mode: string }];
    expect(line.recordingId).toBe('rec_1');
    expect(line.mode).toBe('thumbnail');
  });

  it('reports a clean policy-denied exit when the token lacks download', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    // Default granted (no `download`), the same gap `bg_recording`'s own
    // MCP test proves: capture alone is not enough.
    const runPromise = recordStartCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_0000000000000000000000001' },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    startScriptedGateway(harness);

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    expect(process.exitCode).toBe(EXIT_CODES.policyDenied);
    expect(io.stderr.join('')).toContain('download');
  });

  it('an invalid --mode is a usage error before connecting', async () => {
    const io = captureStdio();
    await recordStartCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_1', mode: 'bogus' },
    } as never);
    io.restore();
    expect(process.exitCode).toBe(EXIT_CODES.usageError);
  });
});

describe('bgls record stop', () => {
  it('connects, calls recording.stop, and reports framesWritten', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = recordStopCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        instanceId: 'inst_0000000000000000000000001',
        recordingId: 'rec_42',
      },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    const gateway = startScriptedGateway(harness, { granted: GRANTED_WITH_DOWNLOAD as never });

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    expect(gateway.recordingStopCalls).toHaveLength(1);
    expect(gateway.recordingStopCalls[0]).toMatchObject({
      t: 'recording.stop',
      recordingId: 'rec_42',
    });
    const [line] = parseJsonLines(io.stdout) as [
      { recordingId: string; framesWritten: number; failed: boolean },
    ];
    expect(line).toMatchObject({ recordingId: 'rec_42', framesWritten: 3, failed: false });
  });

  it('reports a degraded recording (failed:true) as a success with a warning, not a crash', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    // Human mode (no --json), same reason `bgls record list`'s own
    // `rec_fail` test above checks stderr this way: `printer.warn()` is
    // suppressed entirely in `--json` mode (`util/output.ts`'s own doc),
    // so the human-readable "degraded" wording only ever reaches stderr
    // outside it.
    const runPromise = recordStopCommand.run!({
      args: {
        ...BASE_ARGS,
        instanceId: 'inst_0000000000000000000000001',
        recordingId: 'rec_degraded',
      },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    const gateway = startScriptedGateway(harness, { granted: GRANTED_WITH_DOWNLOAD as never });
    gateway.recordingStopResponder = (msg) => ({
      t: 'recording.stopped',
      recordingId: msg['recordingId'],
      targetId: 'tgt_0000000000000000000000001',
      startedAtMs: Date.now() - 1000,
      stoppedAtMs: Date.now(),
      framesWritten: 1,
      failed: true,
    });

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    expect(io.stderr.join('')).toContain('degraded');
  });
});

describe('bgls record list', () => {
  it('reports a completed recording, human output', async () => {
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI, JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 2, failed: false },
    });

    const io = captureStdio();
    await recordListCommand.run!({ args: { dir: r } } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const out = io.stdout.join('');
    expect(out).toContain('[DONE] rec_a');
    expect(out).toContain('2 frames');
    expect(out).toContain('1 recording in');
  });

  it('reports a recording with no complete.json as INCOMPLETE, distinct from a finished one', async () => {
    const r = newRoot();
    writeRecording({ root: r, recordingId: 'rec_died', startedAtMs: 1_000, frames: [JPEG_SOI] });

    const io = captureStdio();
    await recordListCommand.run!({ args: { dir: r } } as never);
    io.restore();

    const out = io.stdout.join('');
    expect(out).toContain('[INCOMPLETE] rec_died');
    expect(out).toContain('no complete.json');
  });

  it('reports a recording whose sink degraded to a no-op as FAILED, carrying the error message', async () => {
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_fail',
      startedAtMs: 1_000,
      frames: [JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 1, failed: true, errorMessage: 'disk full' },
    });

    const io = captureStdio();
    await recordListCommand.run!({ args: { dir: r } } as never);
    io.restore();

    expect(io.stdout.join('')).toContain('[FAILED] rec_fail');
    // `printer.warn` (consola) writes through `console.warn`, i.e. stderr,
    // not stdout, per `capture-io.ts`'s own doc comment.
    expect(io.stderr.join('')).toContain('disk full');
  });

  it('--json emits structured data with completed/failed reflecting complete.json', async () => {
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 1, failed: false },
    });
    writeRecording({ root: r, recordingId: 'rec_b', startedAtMs: 500, frames: [JPEG_SOI] });

    const io = captureStdio();
    await recordListCommand.run!({ args: { dir: r, json: true } } as never);
    io.restore();

    const lines = parseJsonLines(io.stdout);
    expect(lines).toHaveLength(1);
    const result = lines[0] as {
      root: string;
      recordings: Array<{
        recordingId: string;
        completed: boolean;
        failed: boolean | null;
        frameCount: number;
      }>;
    };
    expect(result.recordings).toHaveLength(2);
    const a = result.recordings.find((x) => x.recordingId === 'rec_a')!;
    const b = result.recordings.find((x) => x.recordingId === 'rec_b')!;
    expect(a.completed).toBe(true);
    expect(a.failed).toBe(false);
    expect(b.completed).toBe(false);
    expect(b.failed).toBeNull();
  });

  it('an empty recordings directory reports zero recordings, not an error', async () => {
    const r = newRoot();
    mkdirSync(r, { recursive: true });

    const io = captureStdio();
    await recordListCommand.run!({ args: { dir: r, json: true } } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const lines = parseJsonLines(io.stdout);
    expect((lines[0] as { recordings: unknown[] }).recordings).toEqual([]);
  });

  it('a missing recordings directory reports zero recordings with a message explaining why, not a crash', async () => {
    const parent = newRoot();
    const missing = join(parent, 'does-not-exist');

    const io = captureStdio();
    await recordListCommand.run!({ args: { dir: missing } } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    expect(io.stdout.join('')).toContain('no recordings directory');
  });
});

describe('bgls record export', () => {
  it('writes each frame as a standalone image plus a timing manifest', async () => {
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI, PNG_SIG],
      complete: { stoppedAtMs: 2_000, framesWritten: 2, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_a', out: outDir },
    } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    expect(existsSync(join(outDir, '00000001.jpg'))).toBe(true);
    expect(existsSync(join(outDir, '00000002.png'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      recordingId: string;
      frames: Array<{ frameIndex: number; file: string; tsDeltaMs: number }>;
    };
    expect(manifest.recordingId).toBe('rec_a');
    expect(manifest.frames).toHaveLength(2);
    expect(manifest.frames[0]!.file).toBe('00000001.jpg');
    expect(manifest.frames[0]!.tsDeltaMs).toBe(100);
    const out = io.stdout.join('');
    expect(out).toContain('exported 2 frames');
    expect(out).toContain('not a video');
  });

  it('reports missing frame files without failing the whole export', async () => {
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI, JPEG_SOI],
      skipFrameFiles: [2],
      complete: { stoppedAtMs: 2_000, framesWritten: 2, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_a', out: outDir },
    } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    expect(io.stdout.join('')).toContain('exported 1 frame');
    expect(io.stderr.join('')).toContain('1 frame listed in the index but missing from disk');
  });

  it('an unknown recordingId exits notFound with an actionable message', async () => {
    const r = newRoot();
    mkdirSync(r, { recursive: true });

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_missing', out: join(r, 'out') },
    } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.notFound);
    expect(io.stderr.join('')).toContain('no recording "rec_missing"');
  });

  it('a recording with an empty index exits preconditionFailed', async () => {
    const r = newRoot();
    writeRecording({ root: r, recordingId: 'rec_empty', startedAtMs: 1_000, frames: [] });

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_empty', out: join(r, 'out') },
    } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.preconditionFailed);
  });

  it('an empty index still returns a frames array, because --video reads that field unconditionally', () => {
    // This shape went missing for a while and no test noticed, because the
    // test above only checks the exit code. `tsc -b` caught it and the
    // bundler did not, so the compile error sat behind a green suite.
    // Asserting the shape here means the next person who adds a field to
    // this return type gets a failing test rather than a type error that
    // only shows up in a full typecheck.
    const r = newRoot();
    writeRecording({ root: r, recordingId: 'rec_empty_shape', startedAtMs: 1_000, frames: [] });

    const result = runRecordExport(r, 'rec_empty_shape', join(r, 'out'));

    expect(result.code).toBe(EXIT_CODES.preconditionFailed);
    expect(result.frames).toEqual([]);
    expect(result.exported).toBe(0);
    expect(result.missing).toBe(0);
  });

  it('rejects a recordingId that looks like a path traversal attempt', async () => {
    const r = newRoot();
    mkdirSync(r, { recursive: true });

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: '../elsewhere', out: join(r, 'out') },
    } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.usageError);
  });
});

// `--video`: frame export
// happens exactly as above, then `runVideoExport` in `record.ts` asks
// `registry.encoderFor()` for a plugin. It reads `bgls-plugins.json` from
// `process.cwd()` (`defaultPluginsFilePath()`'s own default) and resolves
// entries relative to `BGLS_DATA_DIR` (`defaultDataDir()`'s own default),
// so these tests point both at one temp "project" directory the same way
// `token.test.ts` already points `BGLS_DATA_DIR` at a temp dir: save/restore
// the env var, and stub `process.cwd()` for the duration of each test only.
//
// ffmpeg is not installed in this environment. The "no encoder installed"
// and "encoder present but reports unusable" paths below are fully proved
// with a fake plugin fixture (`test/plugins/fixtures.ts`, the same helper
// `load.test.ts`/`registry.test.ts` use) and need no real encoder at all.
// The "ready" -> `encode()` -> `'encoded'` path is NOT exercised here: it
// would need either a real ffmpeg or a fixture plugin that fakes success
// without writing a real file, which this suite deliberately does not do
// (this command verifies `outPath` with a real `statSync`, so a fixture
// claiming success without writing the file would prove the *rejection*
// path, not the success path).

describe('bgls record export --video', () => {
  let projectDir: string | undefined;
  let previousDataDir: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    previousDataDir = process.env['BGLS_DATA_DIR'];
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"; the variable must be removed.
    if (previousDataDir === undefined) delete process.env['BGLS_DATA_DIR'];
    else process.env['BGLS_DATA_DIR'] = previousDataDir;
    if (cwdSpy !== undefined) cwdSpy.mockRestore();
    cwdSpy = undefined;
    if (projectDir !== undefined) cleanupDir(projectDir);
    projectDir = undefined;
  });

  /** Points `process.cwd()` (where `bgls-plugins.json` is read from) and `BGLS_DATA_DIR` (where a plugin's `entry` resolves from) at one fresh temp directory, and returns it. */
  function pointAtFreshProject(): string {
    projectDir = makeTempDataDir();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    process.env['BGLS_DATA_DIR'] = projectDir;
    return projectDir;
  }

  it('reports absence with actionable text when no frame-encoder plugin is installed, human output', async () => {
    pointAtFreshProject(); // no bgls-plugins.json written: the normal, default state
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 1, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_a', out: outDir, video: join(outDir, 'video.mp4') },
    } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.operationalFailure);
    expect(io.stdout.join('')).toContain('exported 1 frame'); // the frame export itself still happened
    const err = io.stderr.join('');
    expect(err).toContain('no frame-encoder plugin is installed');
    expect(err).toContain('bgls plugins add');
    expect(err).toContain(`Exported 1 frame and manifest.json to ${outDir}`);
  });

  it('reports absence with the "absent"/E_PLUGIN_ABSENT shape in --json', async () => {
    pointAtFreshProject();
    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 1, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: {
        dir: r,
        recordingId: 'rec_a',
        out: outDir,
        video: join(outDir, 'video.mp4'),
        json: true,
      },
    } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.operationalFailure);
    const [line] = parseJsonLines(io.stdout) as [
      { exported: number; video: { status: string; error: { code: string; message: string } } },
    ];
    expect(line.exported).toBe(1);
    expect(line.video.status).toBe('absent');
    expect(line.video.error.code).toBe('E_PLUGIN_ABSENT');
    expect(line.video.error.message).toContain('no frame-encoder plugin is installed');
  });

  it('surfaces the specific "cannot run right now" reason from a fixture plugin whose probe reports unusable, human output', async () => {
    const dataDir = pointAtFreshProject();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-encoder-unusable',
      kind: 'frame-encoder',
      probeBody: "return { usable: false, detail: 'no system ffmpeg found' };",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };
    writePluginsFile(join(dataDir, 'bgls-plugins.json'), file);

    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 1, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_a', out: outDir, video: join(outDir, 'video.mp4') },
    } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.operationalFailure);
    const err = io.stderr.join('');
    expect(err).toContain('cannot run right now');
    expect(err).toContain('no system ffmpeg found');
  });

  it('surfaces the same unusable reason in the --json shape, distinct from absence', async () => {
    const dataDir = pointAtFreshProject();
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-encoder-unusable',
      kind: 'frame-encoder',
      probeBody: "return { usable: false, detail: 'no system ffmpeg found' };",
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };
    writePluginsFile(join(dataDir, 'bgls-plugins.json'), file);

    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI],
      complete: { stoppedAtMs: 2_000, framesWritten: 1, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: {
        dir: r,
        recordingId: 'rec_a',
        out: outDir,
        video: join(outDir, 'video.mp4'),
        json: true,
      },
    } as never);
    io.restore();

    const [line] = parseJsonLines(io.stdout) as [
      { video: { status: string; detail: string; error: { code: string } } },
    ];
    expect(line.video.status).toBe('unusable');
    expect(line.video.detail).toBe('no system ffmpeg found');
    expect(line.video.error.code).toBe('E_PLUGIN_UNUSABLE');
  });

  it('a plain export (no --video) is byte-for-byte unchanged and never imports an installed plugin', async () => {
    const dataDir = pointAtFreshProject();
    const markerPath = join(dataDir, 'imported.marker');
    const entry = writeFixturePlugin(dataDir, {
      id: 'fixture-encoder-marker',
      kind: 'frame-encoder',
      importMarkerPath: markerPath,
    });
    const file: PluginsFile = { version: 1, plugins: [entry] };
    writePluginsFile(join(dataDir, 'bgls-plugins.json'), file);

    const r = newRoot();
    writeRecording({
      root: r,
      recordingId: 'rec_a',
      startedAtMs: 1_000,
      frames: [JPEG_SOI, PNG_SIG],
      complete: { stoppedAtMs: 2_000, framesWritten: 2, failed: false },
    });
    const outDir = join(r, 'out');

    const io = captureStdio();
    await recordExportCommand.run!({
      args: { dir: r, recordingId: 'rec_a', out: outDir },
    } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const out = io.stdout.join('');
    expect(out).toContain('exported 2 frames');
    expect(out).toContain('not a video');
    expect(existsSync(join(outDir, '00000001.jpg'))).toBe(true);
    expect(existsSync(join(outDir, '00000002.png'))).toBe(true);
    // The strongest proof a plugin was never loaded: its module's own
    // top-level import side effect never ran, so `import()` itself never
    // happened, not merely that its result went unused.
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('bgls record replay', () => {
  it('is registered but not implemented, and says so rather than half-working', async () => {
    const io = captureStdio();
    await recordReplayCommand.run!({ args: { recordingId: 'rec_a' } } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.operationalFailure);
    expect(io.stderr.join('')).toContain('not implemented in this build');
    expect(io.stderr.join('')).toContain('bgls record export');
  });
});

describe('imageBytesOf: exported frames are standalone images', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);

  it('strips the 20 byte wire header the recorder stores in front of each frame', () => {
    const header = encodeBinaryHeader({
      version: 1,
      msgType: MsgType.FRAME,
      streamId: 1,
      seq: 3,
      tsDeltaMs: 1011,
      payloadCodec: PayloadCodec.JPEG,
      flags: 0,
      gen16: 1,
    });
    const stored = new Uint8Array(header.length + jpeg.length);
    stored.set(header, 0);
    stored.set(jpeg, header.length);
    expect([...imageBytesOf(stored)]).toEqual([...jpeg]);
  });

  it('passes bytes without the wire magic through unchanged', () => {
    expect(imageBytesOf(jpeg)).toBe(jpeg);
  });
});
