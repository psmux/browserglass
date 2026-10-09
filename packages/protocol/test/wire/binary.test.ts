import { describe, expect, it } from 'vitest';
import {
  FrameFlag,
  HEADER_BYTES,
  MsgType,
  PayloadCodec,
  decodeBinaryHeader,
  decodeUploadChunkPayload,
  encodeBinaryHeader,
  encodeUploadChunkPayload,
  peekGen16,
} from '../../src/wire/binary.js';
import { ProtocolError } from '../../src/wire/ids.js';

/**
 * The golden vector: a 6KB JPEG keyframe on stream 7, seq 42, 33ms into the stream,
 * target generation 3.
 */
const GOLDEN_HEADER_HEX = '42 47 01 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00';

function hexToBytes(hex: string): Uint8Array {
  const parts = hex.split(' ').filter(Boolean);
  const bytes = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    bytes[i] = Number.parseInt(parts[i] as string, 16);
  }
  return bytes;
}

describe('binary frame header', () => {
  it('decodes the golden vector to the exact documented fields', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX);
    const decoded = decodeBinaryHeader(bytes);

    expect(decoded.version).toBe(1);
    expect(decoded.msgType).toBe(MsgType.FRAME);
    expect(decoded.streamId).toBe(7);
    expect(decoded.seq).toBe(42);
    expect(decoded.tsDeltaMs).toBe(33);
    expect(decoded.payloadCodec).toBe(PayloadCodec.JPEG);
    expect(decoded.flags).toBe(FrameFlag.KEYFRAME | FrameFlag.FINAL);
    expect(decoded.gen16).toBe(3);
    expect(decoded.keyframe).toBe(true);
    expect(decoded.final).toBe(true);
    expect(decoded.thumbnail).toBe(false);
    expect(decoded.partial).toBe(false);
    expect(decoded.synthetic).toBe(false);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('round-trips the golden vector through encode after decode', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX);
    const decoded = decodeBinaryHeader(bytes);
    const reencoded = encodeBinaryHeader({
      version: decoded.version,
      msgType: decoded.msgType,
      streamId: decoded.streamId,
      seq: decoded.seq,
      tsDeltaMs: decoded.tsDeltaMs,
      payloadCodec: decoded.payloadCodec,
      flags: decoded.flags,
      gen16: decoded.gen16,
    });
    expect(Array.from(reencoded)).toEqual(Array.from(bytes));
  });

  it('round-trips an encoded header with a payload through decode, zero-copy', () => {
    const payloadBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
    const header = encodeBinaryHeader({
      version: 1,
      msgType: MsgType.FRAME,
      streamId: 12,
      seq: 99,
      tsDeltaMs: 1234,
      payloadCodec: PayloadCodec.JPEG,
      flags: FrameFlag.KEYFRAME | FrameFlag.FINAL,
      gen16: 5,
    });
    const full = new Uint8Array(HEADER_BYTES + payloadBytes.byteLength);
    full.set(header, 0);
    full.set(payloadBytes, HEADER_BYTES);

    const decoded = decodeBinaryHeader(full);
    expect(decoded.streamId).toBe(12);
    expect(decoded.seq).toBe(99);
    expect(decoded.gen16).toBe(5);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payloadBytes));

    // Zero-copy: mutating the source buffer must be visible through the view.
    full[HEADER_BYTES] = 0xaa;
    expect(decoded.payload[0]).toBe(0xaa);
  });

  it('decodes a header from a sub-view (byteOffset > 0) without copying garbage', () => {
    const inner = encodeBinaryHeader({
      version: 1,
      msgType: MsgType.FRAME,
      streamId: 1,
      seq: 1,
      tsDeltaMs: 0,
      payloadCodec: PayloadCodec.JPEG,
      flags: FrameFlag.KEYFRAME | FrameFlag.FINAL,
      gen16: 1,
    });
    const padded = new Uint8Array(5 + inner.byteLength);
    padded.set(inner, 5);
    const view = padded.subarray(5);

    const decoded = decodeBinaryHeader(view);
    expect(decoded.streamId).toBe(1);
    expect(decoded.gen16).toBe(1);
  });

  it('throws ProtocolError on a truncated buffer', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX).subarray(0, 10);
    expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on a bad magic', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX);
    bytes[0] = 0x00;
    expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on an unsupported version', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX);
    bytes[2] = 2;
    expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
  });

  it('decodes an unknown msgType without throwing', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX);
    bytes[3] = 0x42; // reserved range, unknown to this build
    const decoded = decodeBinaryHeader(bytes);
    expect(decoded.msgType).toBe(0x42);
  });

  it('peekGen16 reads gen16 without decoding the rest of the header', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX);
    expect(peekGen16(bytes)).toBe(3);
  });

  it('peekGen16 throws ProtocolError on a truncated buffer', () => {
    const bytes = hexToBytes(GOLDEN_HEADER_HEX).subarray(0, 4);
    expect(() => peekGen16(bytes)).toThrow(ProtocolError);
  });
});

describe('UPLOAD_CHUNK payload', () => {
  it('round-trips uploadId and chunk bytes', () => {
    const uploadId = new Uint8Array(16).map((_, i) => i);
    const chunk = new Uint8Array([9, 8, 7, 6]);
    const payload = encodeUploadChunkPayload(uploadId, chunk);
    const decoded = decodeUploadChunkPayload(payload);
    expect(Array.from(decoded.uploadId)).toEqual(Array.from(uploadId));
    expect(Array.from(decoded.chunk)).toEqual(Array.from(chunk));
  });

  it('throws ProtocolError when the uploadId is the wrong length', () => {
    expect(() => encodeUploadChunkPayload(new Uint8Array(15), new Uint8Array(0))).toThrow(
      ProtocolError,
    );
  });

  it('throws ProtocolError when decoding a payload shorter than the uploadId', () => {
    expect(() => decodeUploadChunkPayload(new Uint8Array(10))).toThrow(ProtocolError);
  });
});
