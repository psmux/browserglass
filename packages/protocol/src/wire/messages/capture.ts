import type { Envelope } from '../envelope.js';

/**
 * C to S: a full-resolution screenshot request. This is
 * `Page.captureScreenshot`, NOT a screencast frame: independent of the
 * requester's stream quality tier.
 */
export interface TargetCapture extends Envelope {
  t: 'target.capture';
  targetId: string;
  /** Default `'png'`. */
  format?: 'png' | 'jpeg';
  /** JPEG only, 1 to 100, default 85. */
  quality?: number;
  /** Default false. */
  fullPage?: boolean;
  /** Element scoped, mutually exclusive with `fullPage` and `clip`. */
  selector?: string;
  /** Frame space, same space as input. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Caps the long edge, device px. */
  maxDimension?: number;
  /** Default `'auto'` (picks by size). */
  delivery?: 'auto' | 'inline' | 'url';
}

/**
 * S to C, addressed to the requesting viewer only: the capture result.
 * Delivered inline (`data`) below `limits.maxInlineCaptureBytes`, or via a
 * `downloadId` plus a following `download.ready` above it.
 */
export interface TargetCaptured extends Envelope {
  t: 'target.captured';
  captureId: string;
  targetId: string;
  format: 'png' | 'jpeg';
  /** Device px of the returned image. */
  width: number;
  height: number;
  dpr: number;
  sizeBytes: number;
  /** Target generation the capture was taken against. */
  gen: number;
  fullPage: boolean;
  /** Set when `delivery === 'inline'`. base64, no `data:` prefix. */
  data?: string;
  /** Set when `delivery === 'url'`. A `download.ready` follows immediately. */
  downloadId?: string;
  /** True when `maxDimension` or a server ceiling forced downscale. */
  downscaled: boolean;
}
