import { ProtocolError } from './ids.js';

/**
 * Fixed size of the binary frame header, in bytes. An earlier draft of the
 * format said 18; the header has 20 bytes, as laid out in the byte table
 * in `docs/protocol/wire-spec.md`.
 */
export const HEADER_BYTES = 20;

/** Binary frame `msgType` values (header byte offset 3). */
export const MsgType = Object.freeze({
  /** S to C: an encoded image or video frame. */
  FRAME: 0x01,
  /** S to C: reserved for v2. A v1 receiver MUST ignore it. */
  AUDIO: 0x02,
  /** C to S: a file chunk. `seq` is the chunk index; `streamId` is 0. */
  UPLOAD_CHUNK: 0x03,
  /** S to C: reserved for a future in-band small-file delivery path. */
  DOWNLOAD_CHUNK: 0x04,
  /** S to C: a custom cursor image from the remote page. */
  CURSOR_BITMAP: 0x05,
} as const);

/** Name of a {@link MsgType} entry. */
export type MsgTypeName = keyof typeof MsgType;
/** Numeric value of a {@link MsgType} entry. */
export type MsgTypeValue = (typeof MsgType)[MsgTypeName];

/** Lower bound (inclusive) of the reserved `msgType` range, `0x06` to `0x7F`. */
export const MSG_TYPE_RESERVED_MIN = 0x06;
/** Upper bound (inclusive) of the reserved `msgType` range, `0x06` to `0x7F`. */
export const MSG_TYPE_RESERVED_MAX = 0x7f;
/** Lower bound (inclusive) of the app-private `msgType` range, `0x80` to `0xFF`. */
export const MSG_TYPE_APP_PRIVATE_MIN = 0x80;
/** Upper bound (inclusive) of the app-private `msgType` range, `0x80` to `0xFF`. */
export const MSG_TYPE_APP_PRIVATE_MAX = 0xff;

/** Binary frame `payloadCodec` values (header byte offset 14). */
export const PayloadCodec = Object.freeze({
  /** Raw bytes; meaning depends on `msgType`. Used by `UPLOAD_CHUNK`. */
  NONE: 0x00,
  /** Baseline JPEG, straight from `Page.startScreencast`. Floor codec, v1 default. */
  JPEG: 0x01,
  /** WebP, server-side transcode from the captured JPEG. */
  WEBP: 0x02,
  /** AVIF, server-side transcode. Optional, server build flag. */
  AVIF: 0x03,
  /** PNG, from `Page.startScreencast format:'png'` or `Page.captureScreenshot`. */
  PNG: 0x04,
  /** H.264 Annex B byte stream, one access unit per message. Roadmap. */
  H264: 0x10,
  /** Raw VP9 frame. Roadmap. */
  VP9: 0x11,
  /** Reserved. */
  AV1: 0x12,
} as const);

/** Name of a {@link PayloadCodec} entry. */
export type PayloadCodecName = keyof typeof PayloadCodec;
/** Numeric value of a {@link PayloadCodec} entry. */
export type PayloadCodecValue = (typeof PayloadCodec)[PayloadCodecName];

/** Binary frame `flags` bitfield (header byte offset 15). */
export const FrameFlag = Object.freeze({
  /** Self-contained. Image codecs: always set. Video codecs: marks an IDR. */
  KEYFRAME: 0x01,
  /** Reduced-size preview for an unfocused target, tab strip only. */
  THUMBNAIL: 0x02,
  /** Fragment; more fragments follow with the same `seq`. */
  PARTIAL: 0x04,
  /** Last fragment of this `seq`. An unfragmented frame has this set, `PARTIAL` clear. */
  FINAL: 0x08,
  /** Produced by an explicit screenshot rather than the screencast. */
  SYNTHETIC: 0x10,
  /** Encoder downscaled below the target's device pixel size. */
  DPR_SCALED: 0x20,
  /** Payload carries an alpha channel (WebP or PNG only). */
  ALPHA: 0x40,
  /** Payload begins with a 2-byte LE extension length, then that many bytes of extension data, then the codec payload. */
  EXT: 0x80,
} as const);

/** Name of a {@link FrameFlag} entry. */
export type FrameFlagName = keyof typeof FrameFlag;
/** Numeric value of a {@link FrameFlag} entry. */
export type FrameFlagValue = (typeof FrameFlag)[FrameFlagName];

/** The decoded fields of a binary frame header, plus the derived flag booleans. */
export interface BinaryFrameHeader {
  /** Protocol major of the binary frame path. Always `1`. */
  version: number;
  /** Raw `msgType` byte. Compare against {@link MsgType} constants. */
  msgType: number;
  /** `0` means session scoped; otherwise a `stream.subscribed`-assigned handle. */
  streamId: number;
  /** Per-stream sequence, from 1, wraps at 2^32. */
  seq: number;
  /** Milliseconds since this stream's `sidEpoch` base. */
  tsDeltaMs: number;
  /** Raw `payloadCodec` byte. Compare against {@link PayloadCodec} constants. */
  payloadCodec: number;
  /** Raw `flags` byte. */
  flags: number;
  /** Low 16 bits of the target generation this frame was produced against. */
  gen16: number;
  /** Bit 0 of {@link flags}. */
  keyframe: boolean;
  /** Bit 1 of {@link flags}. */
  thumbnail: boolean;
  /** Bit 2 of {@link flags}. */
  partial: boolean;
  /** Bit 3 of {@link flags}. */
  final: boolean;
  /** Bit 4 of {@link flags}. */
  synthetic: boolean;
  /** Bit 5 of {@link flags}. */
  dprScaled: boolean;
  /** Bit 6 of {@link flags}. */
  alpha: boolean;
  /** Bit 7 of {@link flags}. */
  ext: boolean;
}

/** A decoded binary frame header plus a zero-copy view of its payload. */
export interface DecodedBinaryFrame extends BinaryFrameHeader {
  /** Zero-copy view over the payload, starting at byte offset {@link HEADER_BYTES}. */
  payload: Uint8Array;
}

/** Fields required to encode a binary frame header; `reserved` is always written as 0. */
export type EncodableBinaryFrameHeader = Omit<
  BinaryFrameHeader,
  'keyframe' | 'thumbnail' | 'partial' | 'final' | 'synthetic' | 'dprScaled' | 'alpha' | 'ext'
>;

/** Resolves an `ArrayBuffer`/view input to a `{ buffer, byteOffset, byteLength }` triple, without copying. */
function resolveBuffer(input: ArrayBufferLike | ArrayBufferView): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
} {
  if (ArrayBuffer.isView(input)) {
    return {
      buffer: input.buffer as ArrayBuffer,
      byteOffset: input.byteOffset,
      byteLength: input.byteLength,
    };
  }
  return { buffer: input as ArrayBuffer, byteOffset: 0, byteLength: input.byteLength };
}

/**
 * Encodes a 20-byte little-endian binary frame header (see
 * {@link HEADER_BYTES}), with `gen16` at offset 16 and `reserved` at
 * offset 18, always written as 0.
 */
export function encodeBinaryHeader(header: EncodableBinaryFrameHeader): Uint8Array {
  const buf = new ArrayBuffer(HEADER_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x42); // 'B'
  dv.setUint8(1, 0x47); // 'G'
  dv.setUint8(2, header.version);
  dv.setUint8(3, header.msgType);
  dv.setUint16(4, header.streamId, true);
  dv.setUint32(6, header.seq, true);
  dv.setUint32(10, header.tsDeltaMs, true);
  dv.setUint8(14, header.payloadCodec);
  dv.setUint8(15, header.flags);
  dv.setUint16(16, header.gen16, true);
  dv.setUint16(18, 0, true); // reserved: MUST be 0 on send
  return new Uint8Array(buf);
}

/**
 * Decodes a binary frame: validates magic, version, and minimum length,
 * then returns the header fields, derived flag booleans, and a zero-copy
 * `Uint8Array` view over the payload. `reserved` (offset 18) is ignored on
 * receive, per spec.
 *
 * Throws {@link ProtocolError} on a truncated buffer, a bad magic, or an
 * unsupported version. An unknown `msgType` does NOT throw: the caller
 * decides how to handle it (a v1 receiver must skip an unknown `msgType`
 * and continue, never close the socket).
 */
export function decodeBinaryHeader(buf: ArrayBufferLike | ArrayBufferView): DecodedBinaryFrame {
  const { buffer, byteOffset, byteLength } = resolveBuffer(buf);
  if (byteLength < HEADER_BYTES) {
    throw new ProtocolError(
      `short binary message: expected at least ${HEADER_BYTES} bytes, got ${byteLength}`,
    );
  }
  const dv = new DataView(buffer, byteOffset, byteLength);
  const magic0 = dv.getUint8(0);
  const magic1 = dv.getUint8(1);
  if (magic0 !== 0x42 || magic1 !== 0x47) {
    throw new ProtocolError(
      `bad magic: expected 0x42 0x47 ("BG"), got 0x${magic0.toString(16)} 0x${magic1.toString(16)}`,
    );
  }
  const version = dv.getUint8(2);
  if (version !== 1) {
    throw new ProtocolError(`unsupported binary version ${version}`);
  }
  const flags = dv.getUint8(15);
  return {
    version,
    msgType: dv.getUint8(3),
    streamId: dv.getUint16(4, true),
    seq: dv.getUint32(6, true),
    tsDeltaMs: dv.getUint32(10, true),
    payloadCodec: dv.getUint8(14),
    flags,
    gen16: dv.getUint16(16, true),
    keyframe: (flags & FrameFlag.KEYFRAME) !== 0,
    thumbnail: (flags & FrameFlag.THUMBNAIL) !== 0,
    partial: (flags & FrameFlag.PARTIAL) !== 0,
    final: (flags & FrameFlag.FINAL) !== 0,
    synthetic: (flags & FrameFlag.SYNTHETIC) !== 0,
    dprScaled: (flags & FrameFlag.DPR_SCALED) !== 0,
    alpha: (flags & FrameFlag.ALPHA) !== 0,
    ext: (flags & FrameFlag.EXT) !== 0,
    payload: new Uint8Array(buffer, byteOffset + HEADER_BYTES, byteLength - HEADER_BYTES),
  };
}

/**
 * Reads only `gen16` (offset 16) from a binary frame buffer, without
 * allocating or decoding the rest of the header. This is the fast path a
 * receiver uses to drop a stale-generation frame before doing any other
 * work: two byte loads and an integer compare ahead of any allocation.
 * Throws {@link ProtocolError} if the buffer is shorter than
 * {@link HEADER_BYTES}.
 */
export function peekGen16(buf: ArrayBufferLike | ArrayBufferView): number {
  const { buffer, byteOffset, byteLength } = resolveBuffer(buf);
  if (byteLength < HEADER_BYTES) {
    throw new ProtocolError(
      `short binary message: expected at least ${HEADER_BYTES} bytes, got ${byteLength}`,
    );
  }
  return new DataView(buffer, byteOffset, byteLength).getUint16(16, true);
}

/**
 * Byte layout of the `UPLOAD_CHUNK` (`msgType 0x03`) payload: the first 16
 * bytes are the `uploadId` as raw UUID bytes (not text form), followed by
 * the chunk bytes. `seq` in the header is the zero-based chunk index; byte
 * offset equals `seq * upload.accepted.chunkBytes`.
 */
export const UPLOAD_CHUNK_ID_BYTES = 16;

/** One decoded `UPLOAD_CHUNK` payload. */
export interface DecodedUploadChunk {
  /** The 16 raw UUID bytes identifying the upload. */
  uploadId: Uint8Array;
  /** Zero-copy view of the chunk bytes following the upload id. */
  chunk: Uint8Array;
}

/**
 * Splits an `UPLOAD_CHUNK` payload (as produced by {@link decodeBinaryHeader}'s
 * `payload` field) into its `uploadId` and chunk-bytes parts. Throws
 * {@link ProtocolError} if the payload is shorter than
 * {@link UPLOAD_CHUNK_ID_BYTES}.
 */
export function decodeUploadChunkPayload(payload: Uint8Array): DecodedUploadChunk {
  if (payload.byteLength < UPLOAD_CHUNK_ID_BYTES) {
    throw new ProtocolError(
      `short upload chunk payload: expected at least ${UPLOAD_CHUNK_ID_BYTES} bytes, got ${payload.byteLength}`,
    );
  }
  return {
    uploadId: payload.subarray(0, UPLOAD_CHUNK_ID_BYTES),
    chunk: payload.subarray(UPLOAD_CHUNK_ID_BYTES),
  };
}

/** Builds an `UPLOAD_CHUNK` payload from a 16-byte upload id and the chunk bytes. */
export function encodeUploadChunkPayload(uploadId: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (uploadId.byteLength !== UPLOAD_CHUNK_ID_BYTES) {
    throw new ProtocolError(
      `uploadId must be exactly ${UPLOAD_CHUNK_ID_BYTES} bytes, got ${uploadId.byteLength}`,
    );
  }
  const out = new Uint8Array(UPLOAD_CHUNK_ID_BYTES + chunk.byteLength);
  out.set(uploadId, 0);
  out.set(chunk, UPLOAD_CHUNK_ID_BYTES);
  return out;
}
