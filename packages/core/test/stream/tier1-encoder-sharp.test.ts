import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '../../src/stream/base64.js';
import { encodeTier1 } from '../../src/stream/tier1-encoder.js';

// A real, valid 1x1 PNG (a single opaque black pixel).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('the real sharp-backed tier-1 encoder (packages/core/package.json dependency)', () => {
  it('decodes a real PNG and re-encodes it as JPEG, producing a non-empty JPEG-signed buffer', async () => {
    const input = decodeBase64(TINY_PNG_BASE64);
    const out = await encodeTier1(input, 'png', {
      codec: 'jpeg',
      quality: 75,
      maxWidth: 4,
      maxHeight: 4,
      emitEveryNth: 1,
    });
    expect(out.byteLength).toBeGreaterThan(0);
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8); // JPEG SOI marker
  });
});
