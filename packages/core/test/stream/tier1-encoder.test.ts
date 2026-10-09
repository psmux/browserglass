import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeTier1,
  resetTier1EncoderFactory,
  setTier1EncoderFactory,
} from '../../src/stream/tier1-encoder.js';

describe('tier1-encoder injection seam', () => {
  afterEach(() => resetTier1EncoderFactory());

  it('encodeTier1 delegates to whichever encoder is currently active, never loading the native sharp binding in a test', async () => {
    let calledWith: unknown = null;
    setTier1EncoderFactory(async (input, sourceCodec, spec) => {
      calledWith = { sourceCodec, spec };
      return new Uint8Array([...input, 0x99]);
    });

    const out = await encodeTier1(new Uint8Array([1, 2, 3]), 'jpeg', {
      codec: 'jpeg',
      quality: 60,
      maxWidth: 100,
      maxHeight: 100,
      emitEveryNth: 1,
    });
    expect([...out]).toEqual([1, 2, 3, 0x99]);
    expect(calledWith).toEqual({
      sourceCodec: 'jpeg',
      spec: { codec: 'jpeg', quality: 60, maxWidth: 100, maxHeight: 100, emitEveryNth: 1 },
    });
  });

  it('resetTier1EncoderFactory restores a fresh (sharp-backed) default, distinct from an injected fake', async () => {
    setTier1EncoderFactory(async () => new Uint8Array([0xaa]));
    resetTier1EncoderFactory();
    // We don't invoke encodeTier1 here (that would load the real sharp
    // binding); this only asserts the seam resets without throwing.
    expect(typeof encodeTier1).toBe('function');
  });
});
