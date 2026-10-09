/**
 * `DiskRecordingSink`: the disk-writing half of `@browserglass/core`'s
 * `RecordingSink` seam (`packages/core/src/recording/types.ts`). That
 * package deliberately has no `node:fs` dependency anywhere (it is
 * transport-agnostic, the same division `AttachmentTransport` already
 * draws for a viewer's socket); this is the host implementation
 * `frame-recorder.ts`'s module doc says a host owns.
 *
 * LAYOUT, one directory per recording under the configured root
 * (`ResolvedConfig.recordings.dir`, mirroring `downloads.dir`'s own
 * per-process scoping):
 *
 *     <root>/<recordingId>/meta.json      -- `RecordingMeta`, written once
 *     <root>/<recordingId>/index.jsonl    -- one `RecordedFrameEntry` per line, append-only
 *     <root>/<recordingId>/frames/<n>.bin -- one file per frame, zero-padded frameIndex
 *     <root>/<recordingId>/complete.json  -- written once, at `finalize()` (stop, not part of `RecordingSink`)
 *
 * PATH SAFETY, the same threat `downloads/download-store.ts`'s own module
 * doc states for its direction: a `recordingId` that could steer where
 * bytes land would be an arbitrary-file-write primitive with a browser
 * shaped delivery mechanism. `recordingId` here is never caller input: it
 * is always freshly minted by `ManagedSession.startRecording()` via
 * `newId('rec')` before this class is ever constructed (`recording.stop`'s
 * caller-supplied `recordingId` is only ever used as a Map key to look up
 * the ALREADY-CONSTRUCTED sink instance, never to build a fresh one), so
 * there is no reachable path from wire input to this constructor's
 * `recordingId` argument. `assertId('rec', ...)` below is still run, belt
 * and braces: it is a real, already-tested validator this package already
 * depends on for a different id family, and refusing a malformed id here
 * costs nothing. `frameIndex` (used to name each frame file) is an
 * internal `FrameRecorder` counter, likewise never caller input.
 *
 * REDACTION. `writeMeta` receives a `RecordingMeta` whose `extra` field
 * `FrameRecorder` has ALREADY passed through `redactMeta()`
 * (`core/src/recording/redact.ts`) before calling this sink; this class
 * runs the WHOLE meta object through `redactMeta()` again, one more time,
 * immediately before serialising it to disk. That second pass is not
 * paranoia about `FrameRecorder`'s own discipline (its module doc and
 * tests already establish it), it is the same "primary defence plus belt
 * and braces" shape `download-store.ts`/`upload-store.ts` use for path
 * safety, applied to the metadata this feature actually exists to be
 * careful about: a session recording of a logged-in browser is a far more
 * dangerous artifact than a live stream nobody stores
 * (`redact.ts`'s own module doc makes this argument first).
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type RecordedFrameEntry,
  type RecordingMeta,
  type RecordingSink,
  redactMeta,
} from '@browserglass/core';
import { assertId } from '@browserglass/protocol';
import { containedPath } from '../files/safe-name.js';

/** Zero-padded so `frames/*.bin` sorts in write order under a plain `ls`/`dir`; 8 digits covers 99,999,999 frames, far beyond anything a real recording reaches. */
function frameFileName(frameIndex: number): string {
  return `${String(frameIndex).padStart(8, '0')}.bin`;
}

export interface DiskRecordingSinkOptions {
  /** The configured recordings root (`ResolvedConfig.recordings.dir`). Must already exist or be creatable; this class creates everything under it. */
  readonly root: string;
  readonly recordingId: string;
}

/** What `finalize()` writes to `complete.json`; also returned so a caller (`ManagedSession.stopRecording`) can build its own wire reply without a second disk read. */
export interface RecordingCompletion {
  readonly stoppedAtMs: number;
  readonly framesWritten: number;
  readonly failed: boolean;
}

export class DiskRecordingSink implements RecordingSink {
  private readonly dir: string;
  /** Resolves once the recording's own directory tree exists; every write awaits this instead of re-issuing `mkdir` per call. */
  private readonly ready: Promise<void>;

  constructor(opts: DiskRecordingSinkOptions) {
    assertId('rec', opts.recordingId);
    this.dir = containedPath(opts.root, opts.recordingId);
    this.ready = mkdir(join(this.dir, 'frames'), { recursive: true }).then(() => undefined);
  }

  /** The directory this recording's files live under, for a caller that wants to report it (never sent to a viewer; disk layout is server-internal). */
  get root(): string {
    return this.dir;
  }

  async writeFrame(entry: RecordedFrameEntry, bytes: Uint8Array): Promise<void> {
    await this.ready;
    await Promise.all([
      writeFile(join(this.dir, 'frames', frameFileName(entry.frameIndex)), bytes),
      appendFile(join(this.dir, 'index.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8'),
    ]);
  }

  async writeMeta(meta: RecordingMeta): Promise<void> {
    await this.ready;
    // Second redaction pass; see this module's own doc for why this is
    // deliberate rather than redundant with `FrameRecorder`'s own call.
    const safeMeta = redactMeta(meta as unknown as Record<string, unknown>);
    await writeFile(join(this.dir, 'meta.json'), JSON.stringify(safeMeta, null, 2), 'utf8');
  }

  /**
   * Not part of `RecordingSink`: called once, directly by
   * `ManagedSession.stopRecording()`, after it has already removed this
   * recording's `Attachment` from the live fan-out set (so no further
   * `writeFrame` call can race this). `errorMessage`, when given, MUST
   * already be sanitised by the caller (`packages/server/src/wire/sanitize.ts`'s
   * `sanitizeMessage`, the same treatment every other host-derived string
   * reaching the wire gets) before it reaches here: this class writes
   * whatever string it is handed, verbatim, to disk.
   */
  async finalize(opts: RecordingCompletion & { readonly errorMessage?: string }): Promise<void> {
    await this.ready;
    const completion: Record<string, unknown> = {
      stoppedAtMs: opts.stoppedAtMs,
      framesWritten: opts.framesWritten,
      failed: opts.failed,
      ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
    };
    await writeFile(join(this.dir, 'complete.json'), JSON.stringify(completion, null, 2), 'utf8');
  }
}
