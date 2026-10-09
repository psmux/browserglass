/**
 * Reads the actual pixel dimensions out of an encoded JPEG or PNG buffer.
 * `Page.startScreencast`'s `maxWidth`/`maxHeight` is a bounding box, not an
 * exact target: Chrome scales to fit while preserving aspect, so
 * `RawFrame.width`/`.height` must be read from the bytes Chrome actually
 * produced, per frame, never assumed from the requested spec.
 */

/** PNG signature, then the IHDR chunk: width and height are the first 8 bytes of chunk data, at fixed offsets. */
function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) {
    return null;
  }
  // Signature: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR chunk starts at offset 8: 4-byte length, 4-byte type "IHDR", then width (u32be), height (u32be).
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  return { width, height };
}

/**
 * Scans JPEG markers for the first SOF (start-of-frame) segment, which
 * carries height then width as big-endian u16 fields 5 bytes into the
 * segment payload.
 */
function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    // Standalone markers with no length/payload.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01 ||
      marker === 0x00
    ) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) {
      break;
    }
    const segmentLength = dv.getUint16(offset + 2, false);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 9 <= bytes.length) {
      const height = dv.getUint16(offset + 5, false);
      const width = dv.getUint16(offset + 7, false);
      return { width, height };
    }
    if (marker === 0xda) {
      // Start of scan: dimensions were expected before this and were not found.
      break;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Reads the actual pixel dimensions out of an encoded frame buffer for the
 * given codec. Returns `null` if the format is unrecognised or the buffer
 * is too short to carry a header (a source falls back to its requested
 * spec dimensions in that case, logged as a decode anomaly by the caller).
 */
export function readFrameDimensions(
  bytes: Uint8Array,
  codec: 'jpeg' | 'png' | string,
): { width: number; height: number } | null {
  if (codec === 'png') {
    return parsePngDimensions(bytes);
  }
  if (codec === 'jpeg') {
    return parseJpegDimensions(bytes);
  }
  return null;
}
