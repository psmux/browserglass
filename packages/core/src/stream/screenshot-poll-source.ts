/**
 * `ScreenshotPollSource`: the screenshot fallback mechanism, both modes.
 * Mode 1 (`'standalone'`) replaces the screencast entirely when CDP is
 * unavailable or `Page.startScreencast` was refused, polling at 50ms with
 * exactly one capture in flight. Mode 2 (`'supplement'`) runs alongside a
 * nominally healthy screencast at 1500ms when the renderer appears too busy
 * to repaint, driven by the {@link RendererProbe} hookup.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import { type TimerHandle, clearTimer, monotonicNow, scheduleTimer } from '../cdp/platform.js';
import type { CdpSessionId } from '../cdp/types.js';
import { decodeBase64 } from './base64.js';
import { readFrameDimensions } from './frame-dimensions.js';
import { RendererProbe } from './renderer-probe.js';
import type { FrameSource, FrameSourceSpec, RawFrame } from './types.js';

/** Poll interval for {@link ScreenshotPollSource} mode 1, `'cdp-unavailable'`. */
export const POLL_INTERVAL_STANDALONE_MS = 50;
/** Poll interval for {@link ScreenshotPollSource} mode 2, `'renderer-busy'` supplement. */
export const POLL_INTERVAL_SUPPLEMENT_MS = 1500;

/** Why {@link ScreenshotPollSource} is running. */
export type ScreenshotPollReason = 'cdp-unavailable' | 'screencast-refused' | 'renderer-busy';

/** Constructor options for {@link ScreenshotPollSource}. */
export interface ScreenshotPollSourceOptions {
  bridge: CdpBridge;
  sessionId: CdpSessionId;
  targetId: string;
  reason: ScreenshotPollReason;
  /** Called when four consecutive timeouts are confirmed by two `evaluate('1')` probes as a genuinely hung renderer. Optional: a caller not wiring recovery may omit it. */
  onHungConfirmed?: () => void;
  /** Reports whether the target is currently loading; a screenshot timeout while loading never counts toward the hang streak. */
  isLoading?: () => boolean;
  now?: () => number;
}

/**
 * Polls `Page.captureScreenshot` on a fixed interval with at most one
 * capture in flight at a time. `mode` is derived from `reason`:
 * `'renderer-busy'` uses the 1500ms supplement interval, everything else
 * uses the 50ms standalone interval.
 */
export class ScreenshotPollSource implements FrameSource {
  readonly kind = 'screenshot-poll' as const;

  private readonly bridge: CdpBridge;
  private readonly sessionId: CdpSessionId;
  private readonly now: () => number;
  private readonly probe: RendererProbe;
  private readonly onHungConfirmed: (() => void) | undefined;
  private readonly isLoading: () => boolean;
  readonly reason: ScreenshotPollReason;
  readonly intervalMs: number;

  private spec: FrameSourceSpec | null = null;
  private onFrameCb: ((f: RawFrame) => void) | null = null;
  private timer: TimerHandle | null = null;
  private inFlight = false;
  private running = false;
  private _healthy = false;
  private _lastFrameAtMs = 0;

  constructor(opts: ScreenshotPollSourceOptions) {
    this.bridge = opts.bridge;
    this.sessionId = opts.sessionId;
    this.reason = opts.reason;
    this.intervalMs =
      opts.reason === 'renderer-busy' ? POLL_INTERVAL_SUPPLEMENT_MS : POLL_INTERVAL_STANDALONE_MS;
    this.now = opts.now ?? monotonicNow;
    this.onHungConfirmed = opts.onHungConfirmed;
    this.isLoading = opts.isLoading ?? (() => false);
    this.probe = new RendererProbe({ targetId: opts.targetId });
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
    this.running = true;
    this._healthy = true;
    this.scheduleNext();
  }

  async reconfigure(spec: Partial<FrameSourceSpec>): Promise<void> {
    if (!this.spec) {
      throw new Error('ScreenshotPollSource.reconfigure called before start');
    }
    this.spec = { ...this.spec, ...spec };
  }

  async forceFrame(): Promise<boolean> {
    return this.captureOnce(true);
  }

  async stop(): Promise<void> {
    this.running = false;
    this._healthy = false;
    clearTimer(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.timer = scheduleTimer(() => {
      void this.tick();
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    // Mode 1's "one in flight" rule: a slow capture must not stack a second
    // request behind it. Skip this tick entirely rather than queueing.
    if (!this.inFlight) {
      await this.captureOnce(false);
    }
    this.scheduleNext();
  }

  private async captureOnce(forced: boolean): Promise<boolean> {
    if (!this.spec || !this.onFrameCb) {
      return false;
    }
    this.inFlight = true;
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
      const codec = this.spec.codec === 'png' ? 'png' : 'jpeg';
      const dims = readFrameDimensions(bytes, codec);
      const nowMs = this.now();
      this._lastFrameAtMs = nowMs;
      this._healthy = true;
      this.probe.recordSuccess();

      this.onFrameCb({
        bytes,
        codec,
        width: dims?.width ?? this.spec.maxWidth,
        height: dims?.height ?? this.spec.maxHeight,
        capturedAtMs: nowMs,
        meta: {
          deviceWidth: this.spec.maxWidth,
          deviceHeight: this.spec.maxHeight,
          pageScaleFactor: 1,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          offsetTop: 0,
          timestamp: nowMs / 1000,
        },
        keyframe: true,
        forced,
      });
      return true;
    } catch (err) {
      const shouldConfirm = this.probe.recordFailure(err, this.isLoading());
      if (shouldConfirm) {
        const hung = await this.probe.confirmHung(() =>
          this.bridge.send('Runtime.evaluate', { expression: '1' }, this.sessionId),
        );
        if (hung) {
          this.onHungConfirmed?.();
        }
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}

/** Inputs to {@link shouldRunSupplement}'s gating decision. */
export interface SupplementGateInput {
  nowMs: number;
  lastInputAtMs: number;
  /** `now < aiActiveUntilMs` means automation is currently driving the page. */
  aiActiveUntilMs: number;
  lastFrameAtMs: number;
  loading: boolean;
}

/**
 * The supplement gating expression, evaluated continuously: the
 * screenshot supplement keeps running unless recent input has gone stale
 * (over 10 s, with no AI activity and no navigation in flight) or the
 * screencast has resumed producing frames (silence under 2 s).
 */
export function shouldRunSupplement(input: SupplementGateInput): boolean {
  const inputAge = input.nowMs - input.lastInputAtMs;
  const aiActive = input.nowMs < input.aiActiveUntilMs;
  const frameSilence = input.nowMs - input.lastFrameAtMs;
  const navActive = input.loading;
  if ((inputAge > 10000 && !aiActive && !navActive) || frameSilence < 2000) {
    return false;
  }
  return true;
}
