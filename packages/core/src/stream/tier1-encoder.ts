/**
 * Tier-1 re-encoding: a real decode plus a real encode via `sharp`, used
 * for every encode tier that is not the tier-0 passthrough. `sharp` is a real
 * runtime dependency of `@browserglass/core` (`packages/core/package.json`),
 * imported dynamically and behind a small structural interface: this
 * package's `tsconfig` exposes no ambient Node globals (no `@types/node`;
 * see `../cdp/platform.ts`'s header comment for the identical constraint),
 * so `Buffer` is reached the same way every other Node-only global in this
 * package is, through a `globalThis` structural cast, rather than by
 * widening the package's `lib` array.
 *
 * The encoder factory is injectable (`setTier1EncoderFactory`) so tests
 * never load the native `sharp` binding; the production default lazily
 * `import()`s it on first use.
 */

import type { EncodeSpec, FrameCodec } from './types.js';

interface MinimalSharpInstance {
  resize(width: number, height: number, opts?: { fit?: string }): MinimalSharpInstance;
  jpeg(opts: { quality: number }): MinimalSharpInstance;
  webp(opts: { quality: number; effort?: number }): MinimalSharpInstance;
  png(): MinimalSharpInstance;
  toBuffer(): Promise<Uint8Array>;
}

type SharpFactory = (input: unknown) => MinimalSharpInstance;

interface MinimalBufferCtor {
  from(bytes: Uint8Array): unknown;
}

function bufferFrom(bytes: Uint8Array): unknown {
  const ctor = (globalThis as unknown as { Buffer?: MinimalBufferCtor }).Buffer;
  return ctor ? ctor.from(bytes) : bytes;
}

/** A tier-1 encoder: decodes `input` (in `sourceCodec`) and re-encodes per `spec`. */
export type Tier1Encoder = (
  input: Uint8Array,
  sourceCodec: FrameCodec,
  spec: EncodeSpec,
) => Promise<Uint8Array>;

let sharpFactoryPromise: Promise<SharpFactory> | null = null;

async function loadSharpFactory(): Promise<SharpFactory> {
  if (!sharpFactoryPromise) {
    sharpFactoryPromise = import('sharp').then((mod) => {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      return candidate as unknown as SharpFactory;
    });
  }
  return sharpFactoryPromise;
}

/** The production tier-1 encoder: `sharp`, effort 2 for WebP, resizing to `spec`'s bounding box with `fit: 'inside'` (never upscaling, never cropping). */
export const defaultTier1Encoder: Tier1Encoder = async (input, _sourceCodec, spec) => {
  const sharpFactory = await loadSharpFactory();
  let pipeline = sharpFactory(bufferFrom(input)).resize(spec.maxWidth, spec.maxHeight, {
    fit: 'inside',
  });
  if (spec.codec === 'webp') {
    pipeline = pipeline.webp({ quality: spec.quality, effort: 2 });
  } else if (spec.codec === 'png') {
    pipeline = pipeline.png();
  } else {
    pipeline = pipeline.jpeg({ quality: spec.quality });
  }
  return pipeline.toBuffer();
};

let activeEncoder: Tier1Encoder = defaultTier1Encoder;

/** Overrides the tier-1 encoder implementation; tests use this to avoid loading the native `sharp` binding. */
export function setTier1EncoderFactory(encoder: Tier1Encoder): void {
  activeEncoder = encoder;
}

/** Restores the production `sharp`-backed encoder. */
export function resetTier1EncoderFactory(): void {
  activeEncoder = defaultTier1Encoder;
}

/** Encodes one tier-1 buffer using whichever {@link Tier1Encoder} is currently active. */
export async function encodeTier1(
  input: Uint8Array,
  sourceCodec: FrameCodec,
  spec: EncodeSpec,
): Promise<Uint8Array> {
  return activeEncoder(input, sourceCodec, spec);
}
