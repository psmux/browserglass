/**
 * `DiskRecordingSink`: the disk half of `@browserglass/core`'s
 * `RecordingSink` seam. See `src/recording/disk-recording-sink.ts`'s
 * module doc for the layout and the two safety guarantees this suite
 * pins: `recordingId` path validation, and a second `redactMeta()` pass
 * immediately before every `meta.json`/`complete.json` write.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedFrameEntry, RecordingMeta } from '@browserglass/core';
import { ProtocolError, newId } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskRecordingSink } from '../../src/recording/disk-recording-sink.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bgls-recording-sink-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ENTRY: RecordedFrameEntry = {
  frameIndex: 1,
  seq: 1,
  gen: 1,
  sidEpoch: 1,
  tsDeltaMs: 0,
  byteLength: 4,
  writtenAtMs: 1000,
};

describe('DiskRecordingSink: layout', () => {
  it('writes one frame file plus one index.jsonl line per writeFrame call', async () => {
    const recordingId = newId('rec');
    const sink = new DiskRecordingSink({ root, recordingId });
    await sink.writeFrame(ENTRY, new Uint8Array([1, 2, 3, 4]));
    await sink.writeFrame({ ...ENTRY, frameIndex: 2, seq: 2 }, new Uint8Array([5, 6]));

    const frame1 = await readFile(join(root, recordingId, 'frames', '00000001.bin'));
    const frame2 = await readFile(join(root, recordingId, 'frames', '00000002.bin'));
    expect([...frame1]).toEqual([1, 2, 3, 4]);
    expect([...frame2]).toEqual([5, 6]);

    const index = await readFile(join(root, recordingId, 'index.jsonl'), 'utf8');
    const lines = index
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RecordedFrameEntry);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.frameIndex).toBe(1);
    expect(lines[1]?.frameIndex).toBe(2);
  });

  it('writes complete.json from finalize(), a call outside the RecordingSink interface', async () => {
    const recordingId = newId('rec');
    const sink = new DiskRecordingSink({ root, recordingId });
    await sink.writeFrame(ENTRY, new Uint8Array([1]));
    await sink.finalize({ stoppedAtMs: 2000, framesWritten: 1, failed: false });

    const completion = JSON.parse(await readFile(join(root, recordingId, 'complete.json'), 'utf8'));
    expect(completion).toEqual({ stoppedAtMs: 2000, framesWritten: 1, failed: false });
  });
});

describe('DiskRecordingSink: path safety', () => {
  it('refuses a recordingId that is not a valid rec_ id', () => {
    expect(() => new DiskRecordingSink({ root, recordingId: '../evil' })).toThrow(ProtocolError);
    expect(() => new DiskRecordingSink({ root, recordingId: 'not-a-recording-id' })).toThrow(
      ProtocolError,
    );
  });
});

describe('DiskRecordingSink: redaction', () => {
  it('runs writeMeta through redactMeta() a second time, dropping a credential-shaped key even if one somehow reached this sink', async () => {
    const recordingId = newId('rec');
    const sink = new DiskRecordingSink({ root, recordingId });
    // `RecordingMeta` never legitimately carries `sessionId`/`password` at
    // its own top level (only inside `extra`, and `FrameRecorder` already
    // redacts that before this sink ever sees it); this cast simulates a
    // caller that bypassed that discipline, to prove this sink's OWN pass
    // catches it too rather than trusting the upstream call site alone.
    // `redactMeta()` inspects TOP-LEVEL keys only (see `redact.ts`'s own
    // doc); `extra`'s own contents are `FrameRecorder`'s job to have
    // already redacted before this sink ever sees them (proven by
    // `core`'s own `frame-recorder.test.ts`), not this sink's. This cast
    // simulates a caller that put a credential-shaped key at the TOP
    // level -- something `RecordingMeta`'s own type never allows a real
    // caller to do -- to prove this sink's second pass catches that class
    // of mistake too, rather than trusting the upstream call site alone.
    const meta = {
      recordingId,
      targetId: 'tgt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      mode: 'live',
      pinnedTierIndex: 0,
      startedAtMs: 1000,
      sessionId: 'sess_should_never_be_written',
      password: 'hunter2',
      extra: { note: 'kept' },
    } as unknown as RecordingMeta;

    await sink.writeMeta(meta);

    const written = await readFile(join(root, recordingId, 'meta.json'), 'utf8');
    expect(written).not.toContain('sess_should_never_be_written');
    expect(written).not.toContain('hunter2');
    const parsed = JSON.parse(written);
    expect(parsed.recordingId).toBe(recordingId);
    expect(parsed.extra).toEqual({ note: 'kept' });
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.password).toBeUndefined();
  });
});
