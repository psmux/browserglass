/**
 * Golden byte-level vectors for the `bgls.v1` binary frame codec: the
 * 20-byte header `packages/protocol/src/wire/binary.ts` encodes and
 * decodes (`HEADER_BYTES`), plus the `UPLOAD_CHUNK` payload layout that
 * codec also documents.
 *
 * Every vector's `hex` field is written by hand against the byte layout in
 * `binary.ts`'s own doc comment (magic `B` `G`, then `version`, `msgType`,
 * `streamId` u16 LE, `seq` u32 LE, `tsDeltaMs` u32 LE, `payloadCodec`,
 * `flags`, `gen16` u16 LE, `reserved` u16 LE always 0), never produced by
 * calling `encodeBinaryHeader` and copying its output. A vector produced by
 * calling the encoder would only prove the encoder agrees with itself; the
 * point of a golden vector is that a from-scratch implementation in another
 * language, reading only `docs/protocol/wire-spec.md`'s byte table, can
 * compute the same 20 bytes independently and compare. This file's own
 * `test/protocol/golden-vectors.test.ts` then closes the loop by decoding
 * every one of these vectors with the real `decodeBinaryHeader` and
 * asserting field for field, and re-encoding the decoded fields back to the
 * identical bytes.
 *
 * `hex` is space-separated uppercase hex, matching the convention the
 * existing `test/protocol/binary-header.test.ts` golden vector already
 * uses, so a hex dump copy-pasted from
 * either place round-trips into the other's `hexToBytes()` helper.
 */

/** One valid, fully decodable binary frame header vector. */
export interface BinaryFrameVector {
  /** Short, stable name for this vector, used in test descriptions. */
  readonly name: string;
  /** What this vector is exercising, in one sentence. */
  readonly description: string;
  /** The 20 header bytes (no payload, unless `payloadHex` is set), space-separated uppercase hex. */
  readonly hex: string;
  /** Additional payload bytes appended after the header, when the vector needs a non-empty payload. */
  readonly payloadHex?: string;
  /** The exact fields `decodeBinaryHeader` must produce for `hex`. */
  readonly decoded: {
    readonly version: number;
    readonly msgType: number;
    readonly streamId: number;
    readonly seq: number;
    readonly tsDeltaMs: number;
    readonly payloadCodec: number;
    readonly flags: number;
    readonly gen16: number;
    readonly keyframe: boolean;
    readonly thumbnail: boolean;
    readonly partial: boolean;
    readonly final: boolean;
    readonly synthetic: boolean;
    readonly dprScaled: boolean;
    readonly alpha: boolean;
    readonly ext: boolean;
  };
}

/** One vector that MUST fail `decodeBinaryHeader`, with the reason a conforming implementation rejects it for. */
export interface MalformedBinaryFrameVector {
  readonly name: string;
  readonly description: string;
  readonly hex: string;
  /** Why a conforming decoder must reject this buffer. */
  readonly reason: 'truncated' | 'bad-magic' | 'unsupported-version';
}

/**
 * Valid frame header vectors. `msgType 0x01` (FRAME) is the common case;
 * `keyframe-jpeg-golden` is the reference vector from the wire spec, reproduced here (not imported from the existing
 * `test/protocol/binary-header.test.ts`, deliberately: that file predates
 * this data module and this repository's own test for it lives beside the
 * others in `golden-vectors.test.ts` rather than replacing the earlier,
 * already-passing assertions).
 */
export const BINARY_FRAME_VECTORS: readonly BinaryFrameVector[] = [
  {
    name: 'keyframe-jpeg-golden',
    description:
      'Reference vector: a 6KB JPEG keyframe on stream 7, seq 42, 33ms into the stream, target generation 3. flags = KEYFRAME (0x01) | FINAL (0x08) = 0x09.',
    hex: '42 47 01 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00',
    decoded: {
      version: 1,
      msgType: 0x01,
      streamId: 7,
      seq: 42,
      tsDeltaMs: 33,
      payloadCodec: 0x01,
      flags: 0x09,
      gen16: 3,
      keyframe: true,
      thumbnail: false,
      partial: false,
      final: true,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'session-scoped-upload-chunk',
    description:
      'streamId 0 is reserved for session-scoped binary messages (binary.ts: "0 means session scoped"). msgType 0x03 is UPLOAD_CHUNK, seq is the chunk index (here the first chunk, seq 1), payloadCodec NONE (0x00, meaning is msgType dependent), flags and gen16 both 0 since a chunk carries no frame semantics.',
    hex: '42 47 01 03 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00',
    decoded: {
      version: 1,
      msgType: 0x03,
      streamId: 0,
      seq: 1,
      tsDeltaMs: 0,
      payloadCodec: 0x00,
      flags: 0x00,
      gen16: 0,
      keyframe: false,
      thumbnail: false,
      partial: false,
      final: false,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'max-values-all-flags-seq-wraparound-boundary',
    description:
      'Every multi-byte field at its maximum representable value (streamId 0xFFFF, seq 0xFFFFFFFF, tsDeltaMs 0xFFFFFFFF, gen16 0xFFFF), and flags 0xFF: every one of the 8 defined bits (KEYFRAME, THUMBNAIL, PARTIAL, FINAL, SYNTHETIC, DPR_SCALED, ALPHA, EXT) set at once. seq at 0xFFFFFFFF is the value immediately before the wraparound BinaryFrameHeader.seq documents ("wraps at 2^32"): the next frame on this stream would legally re-encode seq as 0.',
    hex: '42 47 01 01 FF FF FF FF FF FF FF FF FF FF 12 FF FF FF 00 00',
    decoded: {
      version: 1,
      msgType: 0x01,
      streamId: 65535,
      seq: 4294967295,
      tsDeltaMs: 4294967295,
      payloadCodec: 0x12,
      flags: 0xff,
      gen16: 65535,
      keyframe: true,
      thumbnail: true,
      partial: true,
      final: true,
      synthetic: true,
      dprScaled: true,
      alpha: true,
      ext: true,
    },
  },
  {
    name: 'seq-just-past-wraparound',
    description:
      'seq 0 immediately after the 2^32 wraparound the previous vector sits at the edge of. A receiver tracking per-stream sequence continuity must treat this as the successor of seq 0xFFFFFFFF, not as a reset to a fresh stream.',
    hex: '42 47 01 01 FF FF 00 00 00 00 00 00 00 00 12 00 FF FF 00 00',
    decoded: {
      version: 1,
      msgType: 0x01,
      streamId: 65535,
      seq: 0,
      tsDeltaMs: 0,
      payloadCodec: 0x12,
      flags: 0x00,
      gen16: 65535,
      keyframe: false,
      thumbnail: false,
      partial: false,
      final: false,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'thumbnail-webp-tab-strip',
    description:
      'A reduced-size WebP preview for an unfocused target (FrameFlag.THUMBNAIL). flags = THUMBNAIL (0x02) | KEYFRAME (0x01) | FINAL (0x08) = 0x0B: a thumbnail frame is always self-contained and unfragmented.',
    hex: '42 47 01 01 03 00 64 00 00 00 F4 01 00 00 02 0B 01 00 00 00',
    decoded: {
      version: 1,
      msgType: 0x01,
      streamId: 3,
      seq: 100,
      tsDeltaMs: 500,
      payloadCodec: 0x02,
      flags: 0x0b,
      gen16: 1,
      keyframe: true,
      thumbnail: true,
      partial: false,
      final: true,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'cursor-bitmap-png',
    description:
      'msgType 0x05 (CURSOR_BITMAP): a custom cursor image from the remote page, PNG encoded, session scoped (streamId 0).',
    hex: '42 47 01 05 00 00 01 00 00 00 00 00 00 00 04 01 00 00 00 00',
    decoded: {
      version: 1,
      msgType: 0x05,
      streamId: 0,
      seq: 1,
      tsDeltaMs: 0,
      payloadCodec: 0x04,
      flags: 0x01,
      gen16: 0,
      keyframe: true,
      thumbnail: false,
      partial: false,
      final: false,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'partial-fragment-not-final',
    description:
      'The first fragment of a multi-fragment frame: flags = PARTIAL (0x04) only, FINAL clear. binary.ts: "Fragment; more fragments follow with the same seq" until a fragment with FINAL (and PARTIAL clear or set, per the codec: an unfragmented frame has FINAL set and PARTIAL clear; a fragmented frame\'s last piece may still carry PARTIAL clear here to signal completion).',
    hex: '42 47 01 01 07 00 2B 00 00 00 22 00 00 00 01 04 03 00 00 00',
    decoded: {
      version: 1,
      msgType: 0x01,
      streamId: 7,
      seq: 43,
      tsDeltaMs: 34,
      payloadCodec: 0x01,
      flags: 0x04,
      gen16: 3,
      keyframe: false,
      thumbnail: false,
      partial: true,
      final: false,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'reserved-msgtype-unknown-but-valid',
    description:
      "msgType 0x50 falls in the reserved range (MSG_TYPE_RESERVED_MIN 0x06 to MSG_TYPE_RESERVED_MAX 0x7F). decodeBinaryHeader MUST decode this without throwing: binary.ts's own doc says an unknown msgType 'does NOT throw: the caller decides how to handle it (a v1 receiver must skip an unknown msgType and continue, never close the socket)'. This is the binary-frame-path twin of the JSON-side 'ignore unknown t' rule.",
    hex: '42 47 01 50 01 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00',
    decoded: {
      version: 1,
      msgType: 0x50,
      streamId: 1,
      seq: 1,
      tsDeltaMs: 0,
      payloadCodec: 0x00,
      flags: 0x00,
      gen16: 0,
      keyframe: false,
      thumbnail: false,
      partial: false,
      final: false,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
  {
    name: 'app-private-msgtype-unknown-but-valid',
    description:
      "msgType 0xA0 falls in the app-private range (MSG_TYPE_APP_PRIVATE_MIN 0x80 to MSG_TYPE_APP_PRIVATE_MAX 0xFF), reserved for a host application to define its own binary message kinds outside this protocol's own catalogue. Decodes cleanly, same as the reserved-range case above; a generic bgls.v1 client that does not itself define 0xA0 still must not throw or close the socket over it.",
    hex: '42 47 01 A0 01 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00',
    decoded: {
      version: 1,
      msgType: 0xa0,
      streamId: 1,
      seq: 1,
      tsDeltaMs: 0,
      payloadCodec: 0x00,
      flags: 0x00,
      gen16: 0,
      keyframe: false,
      thumbnail: false,
      partial: false,
      final: false,
      synthetic: false,
      dprScaled: false,
      alpha: false,
      ext: false,
    },
  },
];

/**
 * Malformed buffers a conforming decoder MUST reject with a `ProtocolError`.
 * These are the three failure modes `decodeBinaryHeader`'s own doc comment
 * names explicitly: "Throws ProtocolError on a truncated buffer, a bad
 * magic, or an unsupported version." An unknown `msgType` is NOT in this
 * list on purpose: see `reserved-msgtype-unknown-but-valid` and
 * `app-private-msgtype-unknown-but-valid` above, which decode successfully.
 */
export const MALFORMED_BINARY_FRAME_VECTORS: readonly MalformedBinaryFrameVector[] = [
  {
    name: 'empty-buffer',
    description: 'Zero bytes: the shortest possible truncation, well below HEADER_BYTES (20).',
    hex: '',
    reason: 'truncated',
  },
  {
    name: 'truncated-mid-header',
    description:
      "The keyframe-jpeg-golden vector's first 10 bytes only, cut off inside the tsDeltaMs field.",
    hex: '42 47 01 01 07 00 2A 00 00 00',
    reason: 'truncated',
  },
  {
    name: 'one-byte-short',
    description:
      'Exactly HEADER_BYTES - 1 (19) bytes: the boundary case one byte below the minimum, not zero and not a large truncation.',
    hex: '42 47 01 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00',
    reason: 'truncated',
  },
  {
    name: 'bad-magic-first-byte',
    description:
      'The keyframe-jpeg-golden vector with byte 0 changed from 0x42 (\'B\') to 0x00. binary.ts requires both magic bytes 0x42 0x47 ("BG").',
    hex: '00 47 01 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00',
    reason: 'bad-magic',
  },
  {
    name: 'bad-magic-second-byte',
    description:
      "The keyframe-jpeg-golden vector with byte 1 changed from 0x47 ('G') to 0x00: both magic bytes are checked independently, not just their combination.",
    hex: '42 00 01 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00',
    reason: 'bad-magic',
  },
  {
    name: 'unsupported-version-99',
    description:
      'The keyframe-jpeg-golden vector with byte 2 (version) changed from 1 to 99 (0x63): this build speaks binary frame version 1 only.',
    hex: '42 47 63 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00',
    reason: 'unsupported-version',
  },
  {
    name: 'unsupported-version-0',
    description:
      "Version 0: the only other value flagged as historically ambiguous alongside the 18 vs 20 byte header-length conflict binary.ts's own HEADER_BYTES doc comment resolves; version 0 was never a shipped wire version.",
    hex: '42 47 00 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00',
    reason: 'unsupported-version',
  },
];

/**
 * The `UPLOAD_CHUNK` (`msgType 0x03`) payload layout: 16 raw UUID bytes
 * (the `uploadId`), then the chunk bytes, per `binary.ts`'s
 * `UPLOAD_CHUNK_ID_BYTES` doc. This is the payload half of the
 * `session-scoped-upload-chunk` header vector above; the `upload.*` JSON
 * control messages that negotiate an upload are themselves typed only and
 * not wired in this build (see `docs/protocol/wire-spec.md`'s message
 * catalogue), but the binary payload framing they would ride on on is
 * implemented and covered here regardless, since `binary.ts` ships
 * `encodeUploadChunkPayload`/`decodeUploadChunkPayload` unconditionally.
 */
export interface UploadChunkPayloadVector {
  readonly name: string;
  readonly description: string;
  /** The 16-byte uploadId, hex, space-separated. */
  readonly uploadIdHex: string;
  /** The chunk bytes, hex, space-separated. */
  readonly chunkHex: string;
  /** `uploadIdHex` followed by `chunkHex`, concatenated: the full payload a decoder splits back apart. */
  readonly payloadHex: string;
}

export const UPLOAD_CHUNK_PAYLOAD_VECTORS: readonly UploadChunkPayloadVector[] = [
  {
    name: 'ascii-chunk',
    description:
      'A 16-byte uploadId (bytes 0x00 through 0x0F, for a payload that is easy to eyeball) followed by the 5 ASCII bytes "hello".',
    uploadIdHex: '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F',
    chunkHex: '68 65 6C 6C 6F',
    payloadHex: '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 68 65 6C 6C 6F',
  },
  {
    name: 'zero-length-chunk',
    description:
      'A valid uploadId with zero chunk bytes: the payload is exactly UPLOAD_CHUNK_ID_BYTES (16) long. A legal, if unusual, final chunk for a file whose size is an exact multiple of chunkBytes.',
    uploadIdHex: 'FF EE DD CC BB AA 99 88 77 66 55 44 33 22 11 00',
    chunkHex: '',
    payloadHex: 'FF EE DD CC BB AA 99 88 77 66 55 44 33 22 11 00',
  },
];
