import { describe, expect, it } from 'vitest';
import { Attachment, fanOut } from '../../src/stream/attachment.js';
import type { AttachmentTransport, EncodeTier, SequencedFrame } from '../../src/stream/types.js';

function fakeTransport(
  overrides: Partial<AttachmentTransport> = {},
): AttachmentTransport & { sends: Uint8Array[] } {
  const sends: Uint8Array[] = [];
  return {
    isOpen: overrides.isOpen ?? (() => true),
    bufferedAmount: overrides.bufferedAmount ?? (() => 0),
    send: overrides.send ?? ((buf: Uint8Array) => sends.push(buf)),
    sends,
  };
}

function oneTierSet(emitEveryNth = 1): EncodeTier[] {
  return [
    {
      index: 0,
      spec: { codec: 'jpeg', quality: 75, maxWidth: 1280, maxHeight: 720, emitEveryNth },
      buffer: new Uint8Array([1, 2, 3]),
      attachmentCount: 0,
    },
  ];
}

function frame(seq: number): SequencedFrame {
  return {
    bytes: new Uint8Array([9]),
    codec: 'jpeg',
    width: 1280,
    height: 720,
    capturedAtMs: 0,
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
    gen: 1,
    tsDeltaMs: 0,
  };
}

describe('fanOut', () => {
  it('sends to every healthy attachment and skips a closed one, in the documented check order', () => {
    const open = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport: fakeTransport() });
    const closed = new Attachment({
      viewerId: 'vwr_b',
      streamId: 1,
      transport: fakeTransport({ isOpen: () => false }),
    });
    const result = fanOut([open, closed], frame(1), oneTierSet());
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(open.lastSentSeq).toBe(1);
    expect(closed.lastSentSeq).toBe(0);
  });

  it('skips an attachment at its backlog cap without touching the transport', () => {
    const transport = fakeTransport();
    const att = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport, maxBacklog: 1 });
    att.onSent(1, 10); // backlog now 1, at the cap
    const result = fanOut([att], frame(2), oneTierSet());
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(transport.sends).toHaveLength(0); // fanOut never called transport.send for the capped attachment
    expect(att.skipStreak).toBe(1);
  });

  it('skips an attachment over its buffered-bytes cap', () => {
    const att = new Attachment({
      viewerId: 'vwr_a',
      streamId: 1,
      transport: fakeTransport({ bufferedAmount: () => 5_000_000 }),
    });
    const result = fanOut([att], frame(1), oneTierSet());
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(att.skipStreak).toBe(1);
  });

  it('emit-side skip (seq % emitEveryNth !== 0) does not touch skipStreak', () => {
    const att = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport: fakeTransport() });
    const tiers = oneTierSet(4); // L7-style
    fanOut([att], frame(1), tiers); // 1 % 4 !== 0, skipped
    fanOut([att], frame(2), tiers);
    fanOut([att], frame(3), tiers);
    expect(att.skipStreak).toBe(0);
    expect(att.dropRate).toBe(0);
  });

  it('a null tier buffer (encode failure) is skipped without touching skipStreak', () => {
    const att = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport: fakeTransport() });
    const tiers: EncodeTier[] = [
      {
        index: 0,
        spec: { codec: 'jpeg', quality: 75, maxWidth: 100, maxHeight: 100, emitEveryNth: 1 },
        buffer: null,
        attachmentCount: 0,
      },
    ];
    const result = fanOut([att], frame(1), tiers);
    expect(result.sent).toBe(0);
    expect(att.skipStreak).toBe(0);
  });

  it('per-attachment cost: exactly one isOpen() call and cheap comparisons, for a single-tier fan-out to 200 attachments', () => {
    let isOpenCalls = 0;
    const attachments = Array.from({ length: 200 }, (_, i) => {
      const transport = fakeTransport({
        isOpen: () => {
          isOpenCalls += 1;
          return true;
        },
      });
      return new Attachment({ viewerId: `vwr_${i}`, streamId: 1, transport });
    });

    const result = fanOut(attachments, frame(1), oneTierSet());

    expect(result.sent).toBe(200);
    expect(isOpenCalls).toBe(200); // exactly one isOpen() per attachment, no retries
    for (const att of attachments) {
      expect(att.backlog).toBe(1);
    }
  });

  it('SC1: a viewer whose transport never drains does not change the frame rate, latency, or quality any other viewer receives', () => {
    const healthyTransports = Array.from({ length: 20 }, () => fakeTransport());
    const healthy = healthyTransports.map(
      (t, i) => new Attachment({ viewerId: `vwr_${i}`, streamId: 1, transport: t }),
    );
    // A permanently stalled viewer: transport stays open but never acks, so its backlog pins at the cap after one frame.
    const stalledTransport = fakeTransport();
    const stalled = new Attachment({
      viewerId: 'vwr_stalled',
      streamId: 1,
      transport: stalledTransport,
      maxBacklog: 3,
    });

    const tiers = oneTierSet();
    for (let seq = 1; seq <= 10; seq += 1) {
      fanOut([...healthy, stalled], frame(seq), tiers);
      // Every healthy attachment is sent to on every frame, regardless of the
      // stalled one's state: its transport drains normally (simulated by
      // acking immediately), so its backlog never caps.
      for (const att of healthy) {
        expect(att.lastSentSeq).toBe(seq);
        att.onAck(seq);
      }
      // The stalled attachment's transport never acks, so its backlog grows
      // toward the cap and it starts getting skipped.
    }

    // The stalled attachment stopped receiving frames once its backlog capped (after frame 3), but every healthy viewer still got all 10.
    expect(stalled.lastSentSeq).toBeLessThan(10);
    for (const t of healthyTransports) {
      expect(t.sends).toHaveLength(10);
    }
  });
});

describe('Attachment.onAck', () => {
  it('decrements backlog by the number of sentAtBySeq entries actually drained, not the seq delta (a bug in an earlier design)', () => {
    const att = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport: fakeTransport() });
    // Simulate three sends, but only two of them actually reached sentAtBySeq
    // (seq 5 was skipped for this attachment, so only seq 3 and seq 4 were sent).
    att.onSent(3, 100);
    att.onSent(4, 100);
    expect(att.backlog).toBe(2);

    // A cumulative ack at seq 6 (well past both sent seqs, mimicking a large
    // seq-delta from frames skipped for this attachment) must only drain
    // the 2 entries that actually exist, never subtract a naive delta.
    att.onAck(6);
    expect(att.backlog).toBe(0);
    expect(att.sentAtBySeq.size).toBe(0);
  });

  it('is cumulative: acking a higher seq also clears everything below it', () => {
    const att = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport: fakeTransport() });
    att.onSent(1, 10);
    att.onSent(2, 10);
    att.onSent(3, 10);
    att.onAck(2);
    expect(att.backlog).toBe(1);
    expect(att.sentAtBySeq.has(3)).toBe(true);
    expect(att.sentAtBySeq.has(1)).toBe(false);
  });

  it('ignores an ack at or below the last acked seq', () => {
    const att = new Attachment({ viewerId: 'vwr_a', streamId: 1, transport: fakeTransport() });
    att.onSent(1, 10);
    att.onAck(1);
    att.onAck(1);
    expect(att.lastAckedSeq).toBe(1);
  });
});
