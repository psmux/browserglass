import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../src/control/clock.js';
import { FrameRecorder } from '../../src/recording/frame-recorder.js';
import type {
  RecordedFrameEntry,
  RecordingMeta,
  RecordingSink,
} from '../../src/recording/types.js';
import { fanOut } from '../../src/stream/attachment.js';
import { assignTiers } from '../../src/stream/encode-tier-set.js';
import { Stream } from '../../src/stream/stream.js';
import type { EncodeTier, SequencedFrame } from '../../src/stream/types.js';

function makeStream(clock: ManualClock): Stream {
  return new Stream({
    key: { sessionId: 'sess_1', targetId: 'tgt_1' as never, mode: 'live' },
    clock,
    onIdleTimeout: () => {},
  });
}

function tierSet(count = 1, emitEveryNth = 1): EncodeTier[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    spec: { codec: 'jpeg' as const, quality: 75, maxWidth: 1280, maxHeight: 720, emitEveryNth },
    buffer: new Uint8Array([index, 9, 9]),
    attachmentCount: 0,
  }));
}

function frameFromStream(stream: Stream, clock: ManualClock): SequencedFrame {
  const seq = stream.nextSeq();
  return {
    bytes: new Uint8Array([1]),
    codec: 'jpeg',
    width: 1280,
    height: 720,
    capturedAtMs: clock.monotonicNow(),
    meta: {
      deviceWidth: 1280,
      deviceHeight: 720,
      pageScaleFactor: 1,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      offsetTop: 0,
      timestamp: 0,
    },
    keyframe: true,
    streamId: 1,
    seq,
    gen: stream.gen,
    tsDeltaMs: stream.tsDeltaMs(clock.wallNow()),
  };
}

/** A `RecordingSink` test double that records every call and can be told to fail on demand. */
function recordingSink(overrides: Partial<RecordingSink> = {}) {
  const frames: { entry: RecordedFrameEntry; bytes: Uint8Array }[] = [];
  const metas: RecordingMeta[] = [];
  return {
    frames,
    metas,
    writeFrame:
      overrides.writeFrame ??
      vi.fn(async (entry: RecordedFrameEntry, bytes: Uint8Array) => {
        frames.push({ entry, bytes });
      }),
    writeMeta:
      overrides.writeMeta ??
      vi.fn(async (meta: RecordingMeta) => {
        metas.push(meta);
      }),
  } satisfies RecordingSink & { frames: typeof frames; metas: typeof metas };
}

describe('FrameRecorder as a synthetic attachment', () => {
  it('receives frames through fanOut() and writes seq/gen/sidEpoch/tsDeltaMs read off the owning Stream', async () => {
    const clock = new ManualClock(1000);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
    });
    stream.addAttachment(recorder.attachment);

    const frame = frameFromStream(stream, clock);
    const result = fanOut([recorder.attachment], frame, tierSet());
    expect(result.sent).toBe(1);

    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    const [{ entry, bytes }] = sink.frames;
    expect(entry.seq).toBe(1);
    expect(entry.gen).toBe(stream.gen);
    expect(entry.sidEpoch).toBe(stream.sidEpoch);
    expect(entry.tsDeltaMs).toBe(0);
    expect(entry.frameIndex).toBe(1);
    expect(bytes).toEqual(new Uint8Array([0, 9, 9]));
  });

  it('persists the full-width gen (not truncated) and the sidEpoch distinction across a generation bump', async () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
    });
    stream.addAttachment(recorder.attachment);

    // A sidEpoch-only bump (reconfiguration): gen must not move.
    stream.bumpSidEpoch(clock.wallNow());
    let frame = frameFromStream(stream, clock);
    fanOut([recorder.attachment], frame, tierSet());
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    expect(sink.frames[0]?.entry.gen).toBe(1);
    expect(sink.frames[0]?.entry.sidEpoch).toBe(1);
    expect(sink.frames[0]?.entry.seq).toBe(1);

    // A generation bump (visual discontinuity): gen moves and seq resets.
    stream.bumpGeneration('reload', clock.wallNow());
    frame = frameFromStream(stream, clock);
    fanOut([recorder.attachment], frame, tierSet());
    await vi.waitFor(() => expect(sink.frames).toHaveLength(2));
    expect(sink.frames[1]?.entry.gen).toBe(2);
    expect(sink.frames[1]?.entry.sidEpoch).toBe(2);
    expect(sink.frames[1]?.entry.seq).toBe(1); // reset, distinct from the sidEpoch-only bump above

    // The recorded sequence lets a replayer distinguish "same shot, retimed" (row 1) from "new shot" (row 2), which a merged counter could not.
    expect(sink.frames[0]?.entry.gen).not.toBe(sink.frames[1]?.entry.gen);
  });

  it('writes RecordingMeta once, with extraMeta redacted', async () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
      pinnedTierIndex: 1,
      extraMeta: {
        sessionId: 'sess_secret',
        returnUrl: 'https://x.example/cb?code=SECRET123&state=1',
        note: 'hello',
      },
    });
    stream.addAttachment(recorder.attachment);

    await vi.waitFor(() => expect(sink.metas).toHaveLength(1));
    const [meta] = sink.metas;
    expect(meta?.recordingId).toBe(recorder.recordingId);
    expect(meta?.pinnedTierIndex).toBe(1);
    expect(meta?.extra?.sessionId).toBeUndefined();
    expect(meta?.extra?.returnUrl).toBe('https://x.example/cb?code=REDACTED&state=1');
    expect(meta?.extra?.note).toBe('hello');
  });
});

describe('FrameRecorder exclusion from tier assignment and adaptation', () => {
  it('interactiveAttachments() excludes the recorder', () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
    });
    stream.addAttachment(recorder.attachment);

    expect(stream.interactiveAttachments()).toHaveLength(0);
  });

  it("assignTiers() never sees the recorder's pinned tierIndex, and never reassigns it", () => {
    const recorder = new FrameRecorder({
      streamId: 1,
      stream: makeStream(new ManualClock(0)),
      targetId: 'tgt_1' as never,
      sink: recordingSink(),
      pinnedTierIndex: 0,
    });
    recorder.attachment.tierIndex = 0;

    // A real interactive attachment far down the ladder; if the recorder's
    // desiredLevel/tierIndex leaked into bucketing, the levels below would
    // be pulled toward it.
    const interactiveLike = { desiredLevel: 6 as const, synthetic: false };
    const levels = assignTiers([interactiveLike, { desiredLevel: 0, synthetic: true }], 2);
    expect(levels.levels).toEqual([6]); // the synthetic entry never widened the bucket range

    expect(recorder.attachment.tierIndex).toBe(0); // never touched by assignTiers
  });

  it('the recorder attachment stays pinned to its tierIndex across repeated fanOut calls with shifting interactive levels', () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
      pinnedTierIndex: 0,
    });
    stream.addAttachment(recorder.attachment);

    for (let i = 0; i < 5; i += 1) {
      const frame = frameFromStream(stream, clock);
      fanOut([recorder.attachment], frame, tierSet(2));
      expect(recorder.attachment.tierIndex).toBe(0);
    }
  });
});

describe('FrameRecorder failure degradation', () => {
  it('a write failure marks the recording failed, surfaces via lastError/onError, and stops touching the sink on subsequent frames', async () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const onError = vi.fn();
    let calls = 0;
    const sink = recordingSink({
      writeFrame: vi.fn(async () => {
        calls += 1;
        throw new Error('disk full');
      }),
    });
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
      onError,
    });
    stream.addAttachment(recorder.attachment);

    const frame1 = frameFromStream(stream, clock);
    const result1 = fanOut([recorder.attachment], frame1, tierSet());
    expect(result1.sent).toBe(1); // fanOut itself succeeds; the sink failure happens asynchronously after

    await vi.waitFor(() => expect(recorder.failed).toBe(true));
    expect(recorder.lastError?.message).toBe('disk full');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);

    // Subsequent frames: fanOut's very first check (isOpen()) now skips the
    // attachment before ever reaching the sink again -- degrade, don't retry.
    const frame2 = frameFromStream(stream, clock);
    const result2 = fanOut([recorder.attachment], frame2, tierSet());
    expect(result2.sent).toBe(0);
    expect(result2.skipped).toBe(1);
    expect(calls).toBe(1); // the sink was never called again

    // Never throws into the live fan-out path.
    expect(() =>
      fanOut([recorder.attachment], frameFromStream(stream, clock), tierSet()),
    ).not.toThrow();
  });

  it('a writeMeta failure also degrades the recording without throwing out of the constructor', async () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const onError = vi.fn();
    const sink = recordingSink({
      writeMeta: vi.fn(async () => {
        throw new Error('meta write failed');
      }),
    });

    let recorder: FrameRecorder | undefined;
    expect(() => {
      recorder = new FrameRecorder({
        streamId: 1,
        stream,
        targetId: 'tgt_1' as never,
        sink,
        clock,
        onError,
      });
    }).not.toThrow();

    await vi.waitFor(() => expect(recorder?.failed).toBe(true));
    expect(recorder?.lastError?.message).toBe('meta write failed');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a healthy recording keeps acking its own backlog so it never trips maxBacklog on its own', async () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
      maxBacklog: 2,
    });
    stream.addAttachment(recorder.attachment);

    for (let i = 0; i < 10; i += 1) {
      const frame = frameFromStream(stream, clock);
      const result = fanOut([recorder.attachment], frame, tierSet());
      expect(result.sent).toBe(1);
      // Let the pending write's ack settle before the next frame, mirroring
      // a real (fast) disk write completing well within one frame interval.
      await vi.waitFor(() => expect(sink.frames).toHaveLength(i + 1));
    }
    expect(recorder.failed).toBe(false);
  });

  it('keeps recording when frames are fanned out after the stream seq has moved on (overlapping encodes)', async () => {
    // The server assigns a seq when Chrome delivers a frame and encodes on a
    // queue, so by the time frame N is fanned out `stream.seq` can already
    // be N+3. A recorder that acked `stream.seq` leaked one backlog entry
    // per frame here and, after maxBacklog of them, was skipped forever.
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
      maxBacklog: 3,
    });
    stream.addAttachment(recorder.attachment);

    const queued = [1, 2, 3, 4].map(() => frameFromStream(stream, clock));
    for (const frame of queued) {
      expect(fanOut([recorder.attachment], frame, tierSet()).sent).toBe(1);
      await vi.waitFor(() => expect(sink.frames.at(-1)?.entry.seq).toBe(frame.seq));
    }
    for (let i = 0; i < 10; i += 1) {
      const frame = frameFromStream(stream, clock);
      expect(fanOut([recorder.attachment], frame, tierSet()).sent).toBe(1);
      await vi.waitFor(() => expect(sink.frames.at(-1)?.entry.seq).toBe(frame.seq));
    }
    expect(sink.frames.map((f) => f.entry.seq)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    expect(recorder.framesDropped).toBe(0);
    expect(recorder.failed).toBe(false);
  });

  it('clears a leaked backlog once nothing is in flight, even when the caller passes no seq', async () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const sink = recordingSink();
    const recorder = new FrameRecorder({
      streamId: 1,
      stream,
      targetId: 'tgt_1' as never,
      sink,
      clock,
      maxBacklog: 3,
    });
    // A transport caller that predates the seq argument: send() then
    // onSent(), with no seq passed, after the stream has run ahead.
    const att = recorder.attachment;
    const queued = [1, 2, 3, 4].map(() => frameFromStream(stream, clock));
    for (const frame of queued) {
      att.transport.send(new Uint8Array([1]));
      att.onSent(frame.seq, 1);
      await vi.waitFor(() => expect(att.backlog).toBe(0));
    }
    expect(att.backlog).toBe(0);
    expect(sink.frames).toHaveLength(4);
  });
});
