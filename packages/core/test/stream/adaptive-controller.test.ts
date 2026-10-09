import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/control/clock.js';
import {
  ADAPT,
  clampLevel,
  countBadSignals,
  resetForNewGeneration,
  step,
} from '../../src/stream/adaptive-controller.js';
import { Attachment } from '../../src/stream/attachment.js';
import { fanOut } from '../../src/stream/attachment.js';
import type { AttachmentTransport, EncodeTier, SequencedFrame } from '../../src/stream/types.js';

function fakeTransport(): AttachmentTransport {
  return { isOpen: () => true, bufferedAmount: () => 0, send: () => {} };
}

describe('countBadSignals (four signals)', () => {
  it('counts all four signals past high water, including bufferedBytes', () => {
    const att = { ackRttEmaMs: 500, dropRate: 0, decodeMsEma: 0, bufferedBytesEma: 2_000_000 };
    expect(countBadSignals(att)).toBe(2); // rtt and bufferedBytes
  });

  it('is zero for a fully healthy attachment', () => {
    const att = { ackRttEmaMs: 10, dropRate: 0, decodeMsEma: 1, bufferedBytesEma: 0 };
    expect(countBadSignals(att)).toBe(0);
  });
});

describe('clampLevel', () => {
  it('floors the lease holder at controllerFloorLevel (L4) even if the caller asks for worse', () => {
    expect(clampLevel(7, { isLeaseHolder: true })).toBe(4);
    expect(clampLevel(1, { isLeaseHolder: true })).toBe(1); // better than the floor is fine
  });

  it('clamps to [0,7] regardless', () => {
    expect(clampLevel(-2, { isLeaseHolder: false })).toBe(0);
    expect(clampLevel(20, { isLeaseHolder: false })).toBe(7);
  });
});

describe('step (AIMD)', () => {
  it('decreases by 2 on a single bad signal and by 3 when 2+ signals are bad', () => {
    const clock = new ManualClock(0);
    const attSingleBad = new Attachment({
      viewerId: 'a',
      streamId: 1,
      transport: fakeTransport(),
      desiredLevel: 2,
      now: () => clock.monotonicNow(),
    });
    attSingleBad.ackRttEmaMs = 500; // one bad signal
    const next1 = step(attSingleBad, clock.monotonicNow(), { isLeaseHolder: false });
    expect(next1).toBe(4); // 2 + decreaseStep(2)

    const attTwoBad = new Attachment({
      viewerId: 'b',
      streamId: 1,
      transport: fakeTransport(),
      desiredLevel: 2,
      now: () => clock.monotonicNow(),
    });
    attTwoBad.ackRttEmaMs = 500;
    attTwoBad.decodeMsEma = 100;
    const next2 = step(attTwoBad, clock.monotonicNow(), { isLeaseHolder: false });
    expect(next2).toBe(5); // 2 + decreaseStepSevere(3)
  });

  it('does not change level within minDwellMs of the last change', () => {
    const clock = new ManualClock(0);
    const att = new Attachment({
      viewerId: 'a',
      streamId: 1,
      transport: fakeTransport(),
      desiredLevel: 2,
      now: () => clock.monotonicNow(),
    });
    att.ackRttEmaMs = 500;
    step(att, clock.monotonicNow(), { isLeaseHolder: false }); // -> 4, lastLevelChangeAt = 0
    clock.advance(500);
    att.ackRttEmaMs = 500; // still bad, but within minDwellMs of the last change
    const next = step(att, clock.monotonicNow(), { isLeaseHolder: false });
    expect(next).toBe(4); // unchanged, dwell still active
  });
});

describe('regression: an L7 attachment with emitEveryNth:4 and a clean link climbs back to L2 within 15s of simulated time', () => {
  it('climbs from L7 to L2, evaluated at the real ADAPT.intervalMs (1000ms) cadence, using a fake clock (no real sleeping)', async () => {
    const clock = new ManualClock(0);
    const transport = fakeTransport();
    const att = new Attachment({
      viewerId: 'vwr_a',
      streamId: 1,
      transport,
      desiredLevel: 7,
      now: () => clock.monotonicNow(),
    });

    // A clean link: every signal stays well under target throughout, and
    // fanOut is exercised each simulated frame at L7's emitEveryNth:4 so
    // dropRate is computed from real backpressure-skip accounting (which
    // stays at 0, since every frame is sent and acked), never from the
    // emit-side skips, which dropRate deliberately excludes.
    const tiers: EncodeTier[] = [
      {
        index: 0,
        spec: { codec: 'jpeg', quality: 38, maxWidth: 512, maxHeight: 288, emitEveryNth: 4 },
        buffer: new Uint8Array([1]),
        attachmentCount: 0,
      },
    ];

    const startMs = clock.monotonicNow();
    let seq = 0;
    let convergedAtMs: number | null = null;
    while (clock.monotonicNow() - startMs <= 15000) {
      // A handful of frames per adapt tick, all sent and immediately acked.
      for (let i = 0; i < 5; i += 1) {
        seq += 1;
        const frame: SequencedFrame = {
          bytes: new Uint8Array([1]),
          codec: 'jpeg',
          width: 512,
          height: 288,
          capturedAtMs: clock.monotonicNow(),
          meta: {
            deviceWidth: 512,
            deviceHeight: 288,
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
        fanOut([att], frame, tiers);
        if (att.lastSentSeq === seq) {
          att.onAck(seq, 1); // healthy, fast decode
        }
      }
      step(att, clock.monotonicNow(), { isLeaseHolder: false });
      if (att.desiredLevel <= 2 && convergedAtMs === null) {
        convergedAtMs = clock.monotonicNow() - startMs;
        break;
      }
      await clock.advance(ADAPT.intervalMs);
    }

    expect(att.desiredLevel).toBeLessThanOrEqual(2);
    expect(convergedAtMs).not.toBeNull();
    expect(convergedAtMs as number).toBeLessThanOrEqual(15000);
  });
});

describe('resetForNewGeneration', () => {
  it('resets goodWindows and sets a fresh cooldown so a post-recovery climb starts clean', () => {
    const clock = new ManualClock(1000);
    const att = new Attachment({
      viewerId: 'a',
      streamId: 1,
      transport: fakeTransport(),
      now: () => clock.monotonicNow(),
    });
    att.adaptive.goodWindows = 1;
    resetForNewGeneration(att, clock.monotonicNow());
    expect(att.adaptive.goodWindows).toBe(0);
    expect(att.adaptive.cooldownUntil).toBe(4000);
  });
});
