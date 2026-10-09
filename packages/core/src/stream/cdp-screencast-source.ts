/**
 * `CdpScreencastSource`: the primary `FrameSource`, wrapping
 * `Page.startScreencast`/`Page.screencastFrame`.
 *
 * The ack-first rule is enforced by `CdpBridge.onScreencastFrame` itself
 * (`../cdp/bridge.ts`): `Page.screencastFrameAck` is sent, unawaited, as the
 * literal first statement, before this source's handler runs. This module
 * never needs to reimplement that rule, only rely on it.
 */

import type { ScreencastMetadata } from '@browserglass/protocol';
import type { CdpBridge } from '../cdp/bridge.js';
import { monotonicNow } from '../cdp/platform.js';
import type { CdpSessionId, Unsubscribe } from '../cdp/types.js';
import { decodeBase64 } from './base64.js';
import { readFrameDimensions } from './frame-dimensions.js';
import type { FrameSource, FrameSourceSpec, RawFrame } from './types.js';

/** Constructor options for {@link CdpScreencastSource}. */
export interface CdpScreencastSourceOptions {
  bridge: CdpBridge;
  sessionId: CdpSessionId;
  /** Monotonic clock reader; defaults to `performance.now()`. */
  now?: () => number;
}

/**
 * Wraps one target's `Page.startScreencast` session. Change driven, not
 * rate driven: a static page legitimately emits zero frames. Dies on CDP
 * session death; the owning `Stream` is responsible for re-subscribing
 * (which bumps the target generation) after a `detached` event, this
 * source only reports `healthy: false` when that happens.
 */
export class CdpScreencastSource implements FrameSource {
  readonly kind = 'cdp-screencast' as const;

  private readonly bridge: CdpBridge;
  private readonly sessionId: CdpSessionId;
  private readonly now: () => number;

  private spec: FrameSourceSpec | null = null;
  private onFrameCb: ((f: RawFrame) => void) | null = null;
  private unsub: Unsubscribe | null = null;
  private _healthy = false;
  private _lastFrameAtMs = 0;
  private running = false;

  constructor(opts: CdpScreencastSourceOptions) {
    this.bridge = opts.bridge;
    this.sessionId = opts.sessionId;
    this.now = opts.now ?? monotonicNow;
  }

  get healthy(): boolean {
    return this._healthy;
  }

  get lastFrameAtMs(): number {
    return this._lastFrameAtMs;
  }

  async start(spec: FrameSourceSpec, onFrame: (f: RawFrame) => void): Promise<void> {
    this.spec = spec;
    this.onFrameCb = onFrame;
    this.unsub = this.bridge.onScreencastFrame(this.sessionId, (data, metadata) => {
      this.handleFrame(data, metadata);
    });

    await this.bridge.send(
      'Page.startScreencast',
      {
        format: spec.codec === 'png' ? 'png' : 'jpeg',
        quality: spec.codec === 'png' ? undefined : spec.quality,
        maxWidth: spec.maxWidth,
        maxHeight: spec.maxHeight,
        everyNthFrame: Math.max(1, spec.everyNthFrame),
      },
      this.sessionId,
    );
    this.running = true;
    this._healthy = true;
  }

  async reconfigure(spec: Partial<FrameSourceSpec>): Promise<void> {
    if (!this.spec) {
      throw new Error('CdpScreencastSource.reconfigure called before start');
    }
    this.spec = { ...this.spec, ...spec };
    if (!this.running) {
      return;
    }
    // `Page.startScreencast` may be called again on the same session to
    // change parameters; Chrome accepts a fresh call without an explicit
    // stop first.
    await this.bridge.send(
      'Page.startScreencast',
      {
        format: this.spec.codec === 'png' ? 'png' : 'jpeg',
        quality: this.spec.codec === 'png' ? undefined : this.spec.quality,
        maxWidth: this.spec.maxWidth,
        maxHeight: this.spec.maxHeight,
        everyNthFrame: Math.max(1, this.spec.everyNthFrame),
      },
      this.sessionId,
    );
  }

  /**
   * One-shot `Page.captureScreenshot` with `scale: 'css'` mandatory:
   * without it, screenshots come back at device pixels, and
   * on a 2x DPR profile the canvas alternates between two sizes across
   * frames, flickering every other frame.
   */
  async forceFrame(): Promise<boolean> {
    if (!this.spec || !this.onFrameCb) {
      return false;
    }
    try {
      const result = (await this.bridge.send(
        'Page.captureScreenshot',
        {
          format: this.spec.codec === 'png' ? 'png' : 'jpeg',
          quality: this.spec.codec === 'png' ? undefined : this.spec.quality,
          scale: 'css',
        },
        this.sessionId,
      )) as { data: string };
      const bytes = decodeBase64(result.data);
      this.emitRaw(bytes, this.spec.codec === 'png' ? 'png' : 'jpeg', null, true);
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this._healthy = false;
    this.unsub?.();
    this.unsub = null;
    try {
      await this.bridge.send('Page.stopScreencast', undefined, this.sessionId);
    } catch {
      // The session may already be gone; stop is best effort.
    }
  }

  private handleFrame(data: string, metadata: ScreencastMetadata): void {
    const bytes = decodeBase64(data);
    this.emitRaw(bytes, this.spec?.codec === 'png' ? 'png' : 'jpeg', metadata, false);
  }

  private emitRaw(
    bytes: Uint8Array,
    codec: 'jpeg' | 'png',
    metadata: ScreencastMetadata | null,
    forced: boolean,
  ): void {
    const dims = readFrameDimensions(bytes, codec);
    const fallbackW = this.spec?.maxWidth ?? 0;
    const fallbackH = this.spec?.maxHeight ?? 0;
    const nowMs = this.now();
    this._lastFrameAtMs = nowMs;
    this._healthy = true;

    const raw: RawFrame = {
      bytes,
      codec,
      width: dims?.width ?? fallbackW,
      height: dims?.height ?? fallbackH,
      capturedAtMs: nowMs,
      meta: {
        deviceWidth: metadata?.deviceWidth ?? fallbackW,
        deviceHeight: metadata?.deviceHeight ?? fallbackH,
        pageScaleFactor: metadata?.pageScaleFactor ?? 1,
        scrollOffsetX: metadata?.scrollOffsetX ?? 0,
        scrollOffsetY: metadata?.scrollOffsetY ?? 0,
        offsetTop: metadata?.offsetTop ?? 0,
        timestamp: metadata?.timestamp ?? nowMs / 1000,
      },
      keyframe: true,
      forced,
    };
    this.onFrameCb?.(raw);
  }
}
