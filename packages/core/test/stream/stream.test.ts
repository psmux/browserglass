import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/control/clock.js';
import { Attachment } from '../../src/stream/attachment.js';
import { STREAM_LINGER_MS, Stream } from '../../src/stream/stream.js';
import type { AttachmentTransport } from '../../src/stream/types.js';

function fakeTransport(): AttachmentTransport {
  return { isOpen: () => true, bufferedAmount: () => 0, send: () => {} };
}

function makeStream(clock: ManualClock, onIdleTimeout: (s: Stream) => void = () => {}) {
  return new Stream({
    key: { sessionId: 'sess_1', targetId: 'tgt_1' as never, mode: 'live' },
    clock,
    onIdleTimeout,
  });
}

describe('Stream seq/gen bookkeeping', () => {
  it('nextSeq is monotonic from 1, incrementing by exactly 1 per call', () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    expect(stream.nextSeq()).toBe(1);
    expect(stream.nextSeq()).toBe(2);
    expect(stream.nextSeq()).toBe(3);
  });

  it('bumpGeneration increments gen and resets seq to 1 on the next call', () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    stream.nextSeq();
    stream.nextSeq();
    expect(stream.gen).toBe(1);
    stream.bumpGeneration('reload', clock.wallNow());
    expect(stream.gen).toBe(2);
    expect(stream.seq).toBe(0);
    expect(stream.nextSeq()).toBe(1);
  });

  it('bumpSidEpoch bumps sidEpoch without touching gen or seq', () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    stream.nextSeq();
    const genBefore = stream.gen;
    const seqBefore = stream.seq;
    stream.bumpSidEpoch(clock.wallNow());
    expect(stream.sidEpoch).toBe(1);
    expect(stream.gen).toBe(genBefore);
    expect(stream.seq).toBe(seqBefore);
  });

  it('tsDeltaMs is relative to the current sidEpoch base', () => {
    const clock = new ManualClock(1000);
    const stream = makeStream(clock);
    expect(stream.tsDeltaMs(1500)).toBe(500);
    stream.bumpSidEpoch(2000);
    expect(stream.tsDeltaMs(2100)).toBe(100);
  });
});

describe('Stream reference-counted lifecycle (streamLingerMs)', () => {
  it('does not tear down immediately when the last attachment leaves; waits streamLingerMs', async () => {
    const clock = new ManualClock(0);
    let idleFired = false;
    const stream = makeStream(clock, () => {
      idleFired = true;
    });
    const att = new Attachment({ viewerId: 'vwr_1', streamId: 1, transport: fakeTransport() });
    stream.addAttachment(att);
    stream.removeAttachment(att);
    expect(idleFired).toBe(false);

    await clock.advance(STREAM_LINGER_MS - 1);
    expect(idleFired).toBe(false);

    await clock.advance(2);
    expect(idleFired).toBe(true);
  });

  it('a resubscribe within the linger window cancels the pending teardown and keeps gen/seq continuing', async () => {
    const clock = new ManualClock(0);
    let idleFired = false;
    const stream = makeStream(clock, () => {
      idleFired = true;
    });
    stream.nextSeq();
    stream.nextSeq();
    const genBefore = stream.gen;
    const seqBefore = stream.seq;

    const att1 = new Attachment({ viewerId: 'vwr_1', streamId: 1, transport: fakeTransport() });
    stream.addAttachment(att1);
    stream.removeAttachment(att1);

    await clock.advance(STREAM_LINGER_MS - 500);
    const att2 = new Attachment({ viewerId: 'vwr_2', streamId: 2, transport: fakeTransport() });
    stream.addAttachment(att2); // reattach within the linger window

    await clock.advance(1000); // past the original linger deadline
    expect(idleFired).toBe(false); // the pending teardown was cancelled
    expect(stream.gen).toBe(genBefore); // same gen
    expect(stream.seq).toBe(seqBefore); // seq continues, never reset
  });

  it('interactiveAttachments excludes synthetic attachments', () => {
    const clock = new ManualClock(0);
    const stream = makeStream(clock);
    const real = new Attachment({ viewerId: 'vwr_1', streamId: 1, transport: fakeTransport() });
    const recorder = new Attachment({
      viewerId: 'vwr_recorder',
      streamId: 2,
      transport: fakeTransport(),
      synthetic: true,
    });
    stream.addAttachment(real);
    stream.addAttachment(recorder);
    expect(stream.interactiveAttachments()).toEqual([real]);
  });
});
