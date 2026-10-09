/**
 * The per-target frame-emission pipeline: `core`'s `TierAssigner`/`assignTiers`
 * bucket viewers into at most `k` encode tiers, this module encodes each
 * tier's payload once (tier 0 passthrough, every other tier a real `sharp`
 * re-encode via `encodeTier1`), and `frameOutAttachments` fans the result out
 * to every attachment, gating on the same five checks `core`'s own `fanOut`
 * uses (transport open, backlog, bufferedAmount, emit-skip, buffer-null).
 *
 * `core`'s `buildTiers`/`fanOut` (`@browserglass/core`) bake ONE
 * `streamId` into a tier's shared buffer at encode time, which is correct
 * only when every attachment reading that tier shares one wire `streamId`.
 * That does not hold here: `Viewer.allocateStreamId()`
 * (`core/src/session/viewer.ts`) hands out an independent, monotonic u16 per
 * *viewer socket*, so two different viewers subscribed to the very same
 * target can legitimately be carrying two different wire `streamId` values
 * for it (each with its own streamId). This module keeps
 * `core`'s expensive step (the encode) shared across every attachment in a
 * tier, exactly as `core` designed it, but defers the cheap step (prepending
 * the 20-byte binary header) to per-*distinct-`streamId`*, not per
 * attachment: within one frame's fan-out, every attachment sharing a
 * `streamId` and a tier reuses the same framed buffer, and only a genuinely
 * different `streamId` costs a second small header-plus-copy.
 */

import {
  type Attachment,
  type EncodeSpec,
  type LadderLevel,
  type RawFrame,
  encodeTier1,
  resolveLadderSpec,
} from '@browserglass/core';
import {
  type EncodableBinaryFrameHeader,
  FrameFlag,
  HEADER_BYTES,
  MsgType,
  type PayloadCodec,
  encodeBinaryHeader,
} from '@browserglass/protocol';

/** One tier's encoded payload (no header) plus the spec it was built from. */
interface BuiltTierPayload {
  readonly spec: EncodeSpec;
  readonly payload: Uint8Array;
}

/**
 * Encodes one payload per level in `levels` (best/index-0 first). Tier 0 is
 * passthrough whenever its bounding box already contains the captured
 * frame; every other tier is a real `encodeTier1` re-encode.
 */
export async function buildTierPayloads(
  frame: RawFrame,
  levels: readonly LadderLevel[],
  ownerViewport: { readonly width: number; readonly height: number },
): Promise<BuiltTierPayload[]> {
  const out: BuiltTierPayload[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index] as LadderLevel;
    const derived = resolveLadderSpec(level, ownerViewport);
    const spec: EncodeSpec = {
      codec: frame.codec === 'png' ? 'png' : 'jpeg',
      quality: derived.quality,
      maxWidth: derived.maxWidth,
      maxHeight: derived.maxHeight,
      emitEveryNth: derived.emitEveryNth,
    };
    const isPassthrough =
      index === 0 && spec.maxWidth >= frame.width && spec.maxHeight >= frame.height;
    const payload = isPassthrough ? frame.bytes : await encodeTier1(frame.bytes, frame.codec, spec);
    out.push({ spec, payload });
  }
  return out;
}

/** What one attachment needs to be fanned out: the core `Attachment` plus which tier index it currently reads. */
export interface FanOutEntry {
  readonly attachment: Attachment;
  readonly tierIndex: number;
}

/** Per-target, per-stream framing inputs shared by every attachment this frame. */
export interface FrameContext {
  readonly gen16: number;
  readonly seq: number;
  readonly tsDeltaMs: number;
  readonly payloadCodec: (typeof PayloadCodec)[keyof typeof PayloadCodec];
  readonly keyframe: boolean;
  readonly thumbnail: boolean;
}

function buildFramedBuffer(streamId: number, ctx: FrameContext, payload: Uint8Array): Uint8Array {
  let flags = 0;
  if (ctx.keyframe) flags |= FrameFlag.KEYFRAME;
  if (ctx.thumbnail) flags |= FrameFlag.THUMBNAIL;
  const header: EncodableBinaryFrameHeader = {
    version: 1,
    msgType: MsgType.FRAME,
    streamId,
    seq: ctx.seq,
    tsDeltaMs: ctx.tsDeltaMs,
    payloadCodec: ctx.payloadCodec,
    flags,
    gen16: ctx.gen16,
  };
  const headerBytes = encodeBinaryHeader(header);
  const buf = new Uint8Array(HEADER_BYTES + payload.byteLength);
  buf.set(headerBytes, 0);
  buf.set(payload, HEADER_BYTES);
  return buf;
}

/**
 * Fans `built` tier payloads out to `entries`, gating each attachment
 * exactly as `core`'s `fanOut` does (open, backlog, bufferedAmount,
 * emit-skip, null buffer), memoising the framed buffer per distinct wire
 * `streamId` within this one call so attachments that do share a `streamId`
 * still share one allocation. Returns the sent/skipped counts.
 */
export function frameOutAttachments(
  entries: readonly FanOutEntry[],
  built: readonly BuiltTierPayload[],
  ctx: FrameContext,
): { sent: number; skipped: number } {
  let sent = 0;
  let skipped = 0;
  const framedByKey = new Map<string, Uint8Array>();

  for (const { attachment: att, tierIndex } of entries) {
    if (!att.transport.isOpen()) {
      skipped += 1;
      continue;
    }
    if (att.backlog >= att.maxBacklog) {
      skipped += 1;
      att.onBackpressureSkip();
      continue;
    }
    if (att.transport.bufferedAmount() >= att.maxBufferedBytes) {
      skipped += 1;
      att.onBackpressureSkip();
      continue;
    }
    const tier = built[tierIndex];
    if (!tier) {
      skipped += 1;
      continue;
    }
    if (ctx.seq % tier.spec.emitEveryNth !== 0) {
      skipped += 1;
      continue;
    }
    const key = `${tierIndex}:${att.streamId}`;
    let framed = framedByKey.get(key);
    if (!framed) {
      framed = buildFramedBuffer(att.streamId, ctx, tier.payload);
      framedByKey.set(key, framed);
    }
    att.transport.send(framed);
    att.onSent(ctx.seq, framed.byteLength);
    sent += 1;
  }

  return { sent, skipped };
}
