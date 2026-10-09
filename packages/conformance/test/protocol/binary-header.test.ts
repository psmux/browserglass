import {
  FrameFlag,
  HEADER_BYTES,
  MsgType,
  PayloadCodec,
  ProtocolError,
  decodeBinaryHeader,
  encodeBinaryHeader,
} from '@browserglass/protocol';
/**
 * Golden vector conformance for `@browserglass/protocol`'s 20 byte binary
 * frame header. This is an independent,
 * package boundary re-derivation of the same vector `@browserglass/protocol`
 * asserts against itself in `packages/protocol/test/wire/binary.test.ts`:
 * conformance imports only the public `@browserglass/protocol` entry point,
 * never a relative path into that package's `src`, so a regression that
 * only shows up through the built export surface (a missing re-export, a
 * `.d.ts` rollup dropping a type) is caught here even if protocol's own
 * suite, run against its own `src`, stays green.
 */
import { describe, expect, it } from 'vitest';

/** The reference vector: a 6 KB JPEG keyframe on stream 7, seq 42, 33ms into the stream, target generation 3. */
const GOLDEN_HEX = '42 47 01 01 07 00 2A 00 00 00 21 00 00 00 01 09 03 00 00 00';

function hexToBytes(hex: string): Uint8Array {
  const parts = hex.trim().split(/\s+/);
  const bytes = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) bytes[i] = Number.parseInt(parts[i]!, 16);
  return bytes;
}

describe('binary frame header: golden vector', () => {
  it('HEADER_BYTES is exactly 20', () => {
    expect(HEADER_BYTES).toBe(20);
  });

  it('decodes the golden vector byte for byte', () => {
    const bytes = hexToBytes(GOLDEN_HEX);
    expect(bytes).toHaveLength(20);

    const decoded = decodeBinaryHeader(bytes);
    expect(decoded.version).toBe(1);
    expect(decoded.msgType).toBe(MsgType.FRAME);
    expect(decoded.streamId).toBe(7);
    expect(decoded.seq).toBe(42);
    expect(decoded.tsDeltaMs).toBe(33);
    expect(decoded.payloadCodec).toBe(PayloadCodec.JPEG);
    expect(decoded.flags).toBe(FrameFlag.KEYFRAME | FrameFlag.FINAL);
    expect(decoded.keyframe).toBe(true);
    expect(decoded.final).toBe(true);
    expect(decoded.thumbnail).toBe(false);
    expect(decoded.partial).toBe(false);
    expect(decoded.synthetic).toBe(false);
    expect(decoded.dprScaled).toBe(false);
    expect(decoded.alpha).toBe(false);
    expect(decoded.ext).toBe(false);
    expect(decoded.gen16).toBe(3);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('re-encodes the decoded golden vector back to the identical 20 bytes', () => {
    const bytes = hexToBytes(GOLDEN_HEX);
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
    expect(Array.from(reencoded.subarray(0, HEADER_BYTES))).toEqual(
      Array.from(bytes.subarray(0, HEADER_BYTES)),
    );
  });

  it('reserved (offset 18-19) is always 0 on encode', () => {
    const encoded = encodeBinaryHeader({
      version: 1,
      msgType: MsgType.FRAME,
      streamId: 65535,
      seq: 0xffffffff,
      tsDeltaMs: 0xffffffff,
      payloadCodec: PayloadCodec.AV1,
      flags: 0xff,
      gen16: 0xffff,
    });
    expect(encoded[18]).toBe(0);
    expect(encoded[19]).toBe(0);
  });

  it('an unknown msgType decodes without throwing (MUST be skipped, MUST NOT close the socket)', () => {
    const bytes = hexToBytes(GOLDEN_HEX);
    bytes[3] = 0x42; // an app-private / reserved msgType, not FRAME
    expect(() => decodeBinaryHeader(bytes)).not.toThrow();
    const decoded = decodeBinaryHeader(bytes);
    expect(decoded.msgType).toBe(0x42);
  });

  it('a truncated buffer throws ProtocolError', () => {
    const bytes = hexToBytes(GOLDEN_HEX).subarray(0, 10);
    expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
  });

  it('a bad magic throws ProtocolError', () => {
    const bytes = hexToBytes(GOLDEN_HEX);
    bytes[0] = 0x00;
    expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
  });

  it('an unsupported version throws ProtocolError', () => {
    const bytes = hexToBytes(GOLDEN_HEX);
    bytes[2] = 99;
    expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
  });
});
