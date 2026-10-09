import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '../../src/stream/base64.js';

// "hello" as bytes, ASCII.
const HELLO_BYTES = [104, 101, 108, 108, 111];

describe('decodeBase64', () => {
  it('round-trips a known vector', () => {
    expect([...decodeBase64('aGVsbG8=')]).toEqual(HELLO_BYTES);
  });

  it('handles unpadded input', () => {
    expect([...decodeBase64('aGVsbG8')]).toEqual(HELLO_BYTES);
  });

  it('ignores embedded whitespace', () => {
    expect([...decodeBase64('aGVs\nbG8=')]).toEqual(HELLO_BYTES);
  });

  it('decodes an empty string to an empty buffer', () => {
    expect(decodeBase64('').byteLength).toBe(0);
  });
});
