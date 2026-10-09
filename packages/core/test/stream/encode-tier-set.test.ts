import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TIER_COLLAPSE_DWELL_MS,
  TIER_SPLIT_DWELL_MS,
  TierAssigner,
  assignTiers,
  buildTiers,
} from '../../src/stream/encode-tier-set.js';
import {
  resetTier1EncoderFactory,
  setTier1EncoderFactory,
} from '../../src/stream/tier1-encoder.js';
import type { RawFrame } from '../../src/stream/types.js';

function att(desiredLevel: number, synthetic = false) {
  return { desiredLevel, synthetic };
}

describe('assignTiers (pure k-means bucketing)', () => {
  it('collapses to one tier when the spread is at most 1 level, encoding at the worst', () => {
    const result = assignTiers([att(2), att(3)], 2);
    expect(result.levels).toEqual([3]);
  });

  it('produces at most k tiers, each at the worst level in its bucket', () => {
    const result = assignTiers([att(0), att(1), att(6), att(7)], 2);
    expect(result.levels.length).toBeLessThanOrEqual(2);
    // The worst level anywhere in the set must be represented by some tier
    // (nobody is ever given a tier better than they asked for).
    expect(Math.max(...result.levels)).toBe(7);
  });

  it('is a fixed point: running it again on its own output changes nothing', () => {
    const levels = [0, 1, 2, 3, 4, 5, 6, 7];
    const attachments = levels.map((lv) => att(lv));
    const first = assignTiers(attachments, 2);

    // Feed the result's own levels back in as a fresh attachment set.
    const second = assignTiers(
      first.levels.map((lv) => att(lv)),
      2,
    );
    expect(second.levels).toEqual(first.levels);

    // And a third pass, for good measure.
    const third = assignTiers(
      second.levels.map((lv) => att(lv)),
      2,
    );
    expect(third.levels).toEqual(second.levels);
  });

  it('filters out synthetic attachments before computing levels', () => {
    const withRecorder = assignTiers([att(0), att(1), att(0, true)], 2);
    const withoutRecorder = assignTiers([att(0), att(1)], 2);
    expect(withRecorder.levels).toEqual(withoutRecorder.levels);
  });

  it('returns no tiers for an empty (or all-synthetic) attachment set', () => {
    expect(assignTiers([], 2).levels).toEqual([]);
    expect(assignTiers([att(3, true)], 2).levels).toEqual([]);
  });

  it('never exceeds k tiers even with maximum spread', () => {
    const attachments = [0, 1, 2, 3, 4, 5, 6, 7].map((lv) => att(lv));
    const result = assignTiers(attachments, 2);
    expect(result.levels.length).toBeLessThanOrEqual(2);
  });
});

describe('TierAssigner (asymmetric collapse hysteresis)', () => {
  it('does not split immediately: requires tierSplitDwellMs of sustained spread', () => {
    let now = 0;
    const assigner = new TierAssigner(2, () => now);
    // Start with one tier (small spread).
    expect(assigner.evaluate([att(2), att(3)])).toEqual([3]);
    // Spread widens, but not sustained yet.
    now += TIER_SPLIT_DWELL_MS - 100;
    expect(assigner.evaluate([att(0), att(7)])).toEqual([3]); // still held
    now += 200; // now past the dwell
    expect(assigner.evaluate([att(0), att(7)])).toEqual([0, 7]);
  });

  it('does not collapse immediately: requires tierCollapseDwellMs of sustained convergence', () => {
    let now = 0;
    const assigner = new TierAssigner(2, () => now);
    now += TIER_SPLIT_DWELL_MS + 1;
    expect(assigner.evaluate([att(0), att(7)])).toEqual([0, 7]);
    now += 100; // spread narrows, but not sustained
    expect(assigner.evaluate([att(2), att(3)])).toEqual([0, 7]); // still held
    now += TIER_COLLAPSE_DWELL_MS;
    expect(assigner.evaluate([att(2), att(3)])).toEqual([3]);
  });
});

describe('buildTiers', () => {
  beforeEach(() => {
    setTier1EncoderFactory(async (input) => new Uint8Array([...input, 0xee])); // cheap fake, distinguishable from passthrough
  });
  afterEach(() => resetTier1EncoderFactory());

  const frame: RawFrame = {
    bytes: new Uint8Array([1, 2, 3]),
    codec: 'jpeg',
    width: 100,
    height: 100,
    capturedAtMs: 0,
    meta: {
      deviceWidth: 100,
      deviceHeight: 100,
      pageScaleFactor: 1,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      offsetTop: 0,
      timestamp: 0,
    },
    keyframe: true,
  };

  it('tier 0 is a passthrough: the header plus the exact captured bytes, no re-encode', async () => {
    const tiers = await buildTiers(frame, [2], {
      ownerViewport: { width: 100, height: 100 },
      ladderSpec: () => ({ quality: 75, maxWidth: 100, maxHeight: 100, emitEveryNth: 1 }),
      header: () => ({
        version: 1,
        msgType: 1,
        streamId: 1,
        seq: 1,
        tsDeltaMs: 0,
        payloadCodec: 1,
        flags: 0,
        gen16: 0,
      }),
    });
    expect(tiers).toHaveLength(1);
    const payload = tiers[0]!.buffer!.subarray(20); // HEADER_BYTES
    expect(payload).toEqual(frame.bytes);
  });

  it('a second, lower-resolution tier goes through the tier-1 encoder, not the passthrough path', async () => {
    const tiers = await buildTiers(frame, [1, 7], {
      ownerViewport: { width: 100, height: 100 },
      ladderSpec: (level) =>
        level === 1
          ? { quality: 82, maxWidth: 100, maxHeight: 100, emitEveryNth: 1 }
          : { quality: 38, maxWidth: 40, maxHeight: 40, emitEveryNth: 4 },
      header: () => ({
        version: 1,
        msgType: 1,
        streamId: 1,
        seq: 1,
        tsDeltaMs: 0,
        payloadCodec: 1,
        flags: 0,
        gen16: 0,
      }),
    });
    expect(tiers).toHaveLength(2);
    const worseTierPayload = tiers[1]!.buffer!.subarray(20);
    expect(worseTierPayload[worseTierPayload.length - 1]).toBe(0xee); // came from the fake tier-1 encoder
  });
});
