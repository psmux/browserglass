/**
 * `EncodeTierSet`: the encode-once-per-frame-per-stream fan-out mechanism.
 * `assignTiers` (the pure k-means bucketing function) plus `TierAssigner`
 * (the stateful wrapper applying the asymmetric collapse hysteresis and
 * level dwell) and the tier-0 passthrough / tier-1 `sharp` re-encode paths.
 * Synthetic attachments (recorders) are filtered out before tiering.
 */

import { type EncodableBinaryFrameHeader, encodeBinaryHeader } from '@browserglass/protocol';
import type { Attachment } from './attachment.js';
import { encodeTier1 } from './tier1-encoder.js';
import type { EncodeSpec, EncodeTier, RawFrame } from './types.js';

/** Split from 1 to 2 tiers requires `hi - lo >= 2` sustained for this long. */
export const TIER_SPLIT_DWELL_MS = 2000;
/** Collapse from 2 to 1 requires `hi - lo <= 1` sustained for this long. Splitting is cheap to undo; collapsing throws away an encoder's warm state, hence the asymmetry. */
export const TIER_COLLAPSE_DWELL_MS = 5000;
/** A tier's level may not change more than once per this interval. */
export const TIER_LEVEL_DWELL_MS = 2000;
/** How often `assignTiers` re-runs on its own, in addition to every attachment-set change. */
export const TIER_EVAL_INTERVAL_MS = 1000;

function nearestCentre(centres: readonly number[], level: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centres.length; i += 1) {
    const dist = Math.abs((centres[i] as number) - level);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function seedCentres(lo: number, hi: number, k: number): number[] {
  if (k <= 1) {
    return [Math.round((lo + hi) / 2)];
  }
  const centres: number[] = [];
  for (let i = 0; i < k; i += 1) {
    centres.push(Math.round(lo + ((hi - lo) * i) / (k - 1)));
  }
  return centres;
}

/**
 * A bucketing result: one ladder level per tier index, ordered best (index
 * 0, lowest number) to worst.
 */
export interface TierLevels {
  levels: readonly number[];
}

/**
 * Pure k-means bucketing over the discrete `[0,7]` ladder axis, seeded at
 * `lo`/`hi`, 4 iterations (always enough on an 8-point axis). Each tier
 * encodes at the WORST (highest) level in its bucket: encoding at the mean
 * would starve the weakest member, which re-triggers adaptation, which
 * reshuffles buckets, which oscillates. Worst-in-bucket is a fixed point:
 * running `assignTiers` again on the level set it just produced (a
 * single-element-per-bucket set, since it collapses to `hi - lo <= 1` once
 * bucketed at the worst member) changes nothing.
 *
 * Filters out `synthetic` attachments before computing levels: a
 * recorder or other non-interactive consumer must never pin a stream's
 * tiers to its own quality preference.
 */
export function assignTiers(
  attachments: readonly Pick<Attachment, 'desiredLevel' | 'synthetic'>[],
  k: number,
): TierLevels {
  const levels = attachments.filter((a) => !a.synthetic).map((a) => a.desiredLevel);
  if (levels.length === 0) {
    return { levels: [] };
  }

  const lo = Math.min(...levels);
  const hi = Math.max(...levels);

  if (hi - lo <= 1 || k <= 1) {
    return { levels: [hi] };
  }

  let centres = seedCentres(lo, hi, k);
  for (let iter = 0; iter < 4; iter += 1) {
    const buckets: number[][] = centres.map(() => []);
    for (const lv of levels) {
      const bucket = buckets[nearestCentre(centres, lv)];
      bucket?.push(lv);
    }
    const next = buckets.map((b, i) =>
      b.length === 0 ? (centres[i] as number) : Math.round(b.reduce((s, v) => s + v, 0) / b.length),
    );
    if (next.every((v, i) => v === centres[i])) {
      break;
    }
    centres = next;
  }

  const buckets: number[][] = centres.map(() => []);
  for (const lv of levels) {
    const bucket = buckets[nearestCentre(centres, lv)];
    bucket?.push(lv);
  }

  const worstPerBucket = buckets.filter((b) => b.length > 0).map((b) => Math.max(...b));
  const sorted = [...new Set(worstPerBucket)].sort((a, b) => a - b);
  return { levels: sorted };
}

/**
 * The stateful wrapper around {@link assignTiers} applying the asymmetric
 * collapse hysteresis and the per-tier level dwell (the anti-thrash
 * rules). `assignTiers` itself stays pure and dwell-free so its
 * fixed-point property is independently testable.
 */
export class TierAssigner {
  private readonly k: number;
  private readonly now: () => number;
  private currentLevels: readonly number[] = [];
  private splitCandidateSince: number | null = null;
  private collapseCandidateSince: number | null = null;
  private lastLevelChangeAtByIndex = new Map<number, number>();

  constructor(k: number, now: () => number) {
    this.k = k;
    this.now = now;
  }

  /** Runs the bucketing decision, applying dwell timers, and returns the effective (possibly dwell-held) tier levels. */
  evaluate(
    attachments: readonly Pick<Attachment, 'desiredLevel' | 'synthetic'>[],
  ): readonly number[] {
    const nowMs = this.now();
    const raw = assignTiers(attachments, this.k);
    const tierCount = this.currentLevels.length;

    if (raw.levels.length > tierCount) {
      // Candidate split.
      if (this.splitCandidateSince === null) {
        this.splitCandidateSince = nowMs;
      }
      this.collapseCandidateSince = null;
      if (nowMs - this.splitCandidateSince < TIER_SPLIT_DWELL_MS && tierCount > 0) {
        return this.currentLevels;
      }
    } else if (raw.levels.length < tierCount) {
      // Candidate collapse.
      if (this.collapseCandidateSince === null) {
        this.collapseCandidateSince = nowMs;
      }
      this.splitCandidateSince = null;
      if (nowMs - this.collapseCandidateSince < TIER_COLLAPSE_DWELL_MS) {
        return this.currentLevels;
      }
    } else {
      this.splitCandidateSince = null;
      this.collapseCandidateSince = null;
    }

    const applied = raw.levels.map((lv, idx) => {
      const prev = this.currentLevels[idx];
      if (prev === undefined || prev === lv) {
        return lv;
      }
      const lastChange = this.lastLevelChangeAtByIndex.get(idx) ?? 0;
      if (nowMs - lastChange < TIER_LEVEL_DWELL_MS) {
        return prev;
      }
      this.lastLevelChangeAtByIndex.set(idx, nowMs);
      return lv;
    });

    this.currentLevels = applied;
    return applied;
  }
}

/**
 * Builds the concrete `EncodeTier[]` for a set of levels: tier 0 (or
 * whichever tier's spec equals the capture spec) is passthrough (the
 * captured bytes with a header prepended, no re-encode, no copy); every
 * other tier costs a real `sharp` decode plus encode.
 */
export async function buildTiers(
  frame: RawFrame,
  levels: readonly number[],
  opts: {
    ownerViewport: { width: number; height: number };
    ladderSpec: (level: number) => {
      quality: number;
      maxWidth: number;
      maxHeight: number;
      emitEveryNth: number;
    };
    header: (tierIndex: number) => EncodableBinaryFrameHeader;
  },
): Promise<EncodeTier[]> {
  const tiers: EncodeTier[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index] as number;
    const derived = opts.ladderSpec(level);
    const spec: EncodeSpec = {
      codec: frame.codec === 'png' ? 'png' : 'jpeg',
      quality: derived.quality,
      maxWidth: derived.maxWidth,
      maxHeight: derived.maxHeight,
      emitEveryNth: derived.emitEveryNth,
    };

    const isPassthrough =
      spec.maxWidth >= frame.width && spec.maxHeight >= frame.height && index === 0;
    let payload: Uint8Array;
    if (isPassthrough) {
      payload = frame.bytes;
    } else {
      payload = await encodeTier1(frame.bytes, frame.codec, spec);
    }

    const header = encodeBinaryHeader(opts.header(index));
    const buffer = new Uint8Array(header.byteLength + payload.byteLength);
    buffer.set(header, 0);
    buffer.set(payload, header.byteLength);

    tiers.push({ index, spec, buffer, attachmentCount: 0 });
  }
  return tiers;
}
