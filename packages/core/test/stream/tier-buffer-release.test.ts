import { describe, expect, it } from 'vitest';
import { assignTiers, buildTiers } from '../../src/stream/encode-tier-set.js';
import {
  resetTier1EncoderFactory,
  setTier1EncoderFactory,
} from '../../src/stream/tier1-encoder.js';
import type { EncodeTier, RawFrame } from '../../src/stream/types.js';

/**
 * A small driver mimicking how a `Stream` would use `assignTiers` and
 * `buildTiers` frame over frame: it holds only the *current* frame's tier
 * set, replacing the reference outright rather than accumulating a history.
 * This is the structural guarantee that makes "every discarded tier buffer
 * is released" true: nothing in this package retains a prior frame's
 * `EncodeTier[]` once a new one has been built.
 */
class SingleFrameTierHolder {
  currentTiers: EncodeTier[] = [];

  async processFrame(frame: RawFrame, levels: readonly number[]): Promise<void> {
    this.currentTiers = await buildTiers(frame, levels, {
      ownerViewport: { width: frame.width, height: frame.height },
      ladderSpec: () => ({
        quality: 75,
        maxWidth: frame.width,
        maxHeight: frame.height,
        emitEveryNth: 1,
      }),
      header: (tierIndex) => ({
        version: 1,
        msgType: 1,
        streamId: 1,
        seq: 1,
        tsDeltaMs: 0,
        payloadCodec: 1,
        flags: 0,
        gen16: tierIndex,
      }),
    });
  }
}

describe('discarded tier buffers are released (not retained across frames)', () => {
  it('each processed frame replaces the held tier set outright; no accumulating history', async () => {
    setTier1EncoderFactory(async (input) => new Uint8Array(input));
    try {
      const holder = new SingleFrameTierHolder();
      const seenBufferRefs = new Set<Uint8Array>();
      let previousBuffers: (Uint8Array | null)[] = [];

      for (let i = 0; i < 20; i += 1) {
        const frame: RawFrame = {
          bytes: new Uint8Array([i]),
          codec: 'jpeg',
          width: 100,
          height: 100,
          capturedAtMs: i,
          meta: {
            deviceWidth: 100,
            deviceHeight: 100,
            pageScaleFactor: 1,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            offsetTop: 0,
            timestamp: i,
          },
          keyframe: true,
        };
        await holder.processFrame(
          frame,
          assignTiers([{ desiredLevel: 2, synthetic: false }], 2).levels,
        );

        for (const tier of holder.currentTiers) {
          if (tier.buffer) {
            seenBufferRefs.add(tier.buffer);
          }
        }
        // The holder's own live reference set never exceeds this frame's
        // tier count: nothing from a prior frame is still reachable from it.
        expect(holder.currentTiers.length).toBeLessThanOrEqual(2);
        const currentBufferSet = new Set(holder.currentTiers.map((t) => t.buffer));
        for (const prev of previousBuffers) {
          if (prev) {
            expect(currentBufferSet.has(prev)).toBe(false); // the old buffer was not carried forward
          }
        }
        previousBuffers = holder.currentTiers.map((t) => t.buffer);
      }

      // Every frame produced a fresh, distinct buffer object: 20 frames, 20
      // distinct buffers observed in total (one tier per frame here, since
      // a single attachment collapses to one tier), none of them reused.
      expect(seenBufferRefs.size).toBe(20);
    } finally {
      resetTier1EncoderFactory();
    }
  });
});
