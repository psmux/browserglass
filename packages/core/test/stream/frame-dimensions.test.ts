import { describe, expect, it } from 'vitest';
import { readFrameDimensions } from '../../src/stream/frame-dimensions.js';

/** A minimal, valid 2x1 PNG (IHDR width=2, height=1), rest of the chunks irrelevant to the parser. */
function buildMinimalPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const dv = new DataView(bytes.buffer);
  // Signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) + "IHDR"
  dv.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return bytes;
}

/** A minimal baseline JPEG: SOI, then an SOF0 (0xC0) segment carrying height then width. */
function buildMinimalJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(19);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  bytes[2] = 0xff;
  bytes[3] = 0xc0; // SOF0
  dv.setUint16(4, 11, false); // segment length (not including the 0xff 0xc0 marker bytes)
  bytes[6] = 8; // precision
  dv.setUint16(7, height, false);
  dv.setUint16(9, width, false);
  bytes[11] = 1; // num components
  return bytes;
}

describe('readFrameDimensions', () => {
  it('reads width/height out of a PNG IHDR chunk', () => {
    const dims = readFrameDimensions(buildMinimalPng(640, 480), 'png');
    expect(dims).toEqual({ width: 640, height: 480 });
  });

  it('reads width/height out of a JPEG SOF0 segment', () => {
    const dims = readFrameDimensions(buildMinimalJpeg(1280, 720), 'jpeg');
    expect(dims).toEqual({ width: 1280, height: 720 });
  });

  it('returns null for an unrecognised codec or a too-short buffer', () => {
    expect(readFrameDimensions(new Uint8Array([1, 2, 3]), 'jpeg')).toBeNull();
    expect(readFrameDimensions(new Uint8Array(50), 'h264')).toBeNull();
  });
});
