/** A token-bucket rate limit: a steady rate plus a burst allowance. */
export interface RateLimit {
  perSecond: number;
  burst: number;
}

/**
 * Server-wide default limits. `welcome.limits` on the `Welcome` message (see
 * `./messages/session.js`) is the subset of these a client needs at
 * connect time; this is the fuller set used across the server, core, and
 * router for validation ceilings.
 */
export interface Limits {
  /** Frames a viewer may have unacked on one stream before the server skips it. */
  maxBacklog: number;
  /** Transport-buffered bytes per attachment before the server skips it. */
  maxBufferedBytes: number;
  /** Total streams (live plus thumbnail) a viewer may hold. */
  maxStreams: number;
  /** Concurrent live (non-thumbnail) streams a viewer may hold; the demo's concurrent-tab ceiling. */
  maxLiveStreams: number;
  /** Concurrent thumbnail streams a viewer may hold. */
  maxThumbnailStreams: number;
  /** Viewers permitted per Session. */
  maxViewers: number;
  /** Server-advertised fps ceiling. */
  maxFps: number;
  keyframeIntervalMs: number;
  statsIntervalMs: number;
  maxControlMsgBytes: number;
  maxBinaryMessageBytes: number;
  /** Per-viewer input event rate. */
  inputRatePerSec: number;
  controlRatePerSec: RateLimit;
  navRatePerSec: RateLimit;
  /** `presence.cursor`, `presence.viewport`, and `target.probe detail:'hover'`. */
  cursorRate: RateLimit;
  /** `target.probe detail:'full'`. */
  probeFullRate: RateLimit;
  /** `target.capture`, per viewer. */
  captureRatePerSec: number;
  ackRate: RateLimit;
  maxUploadBytes: number;
  /** `clipboard.write`; exempted from `maxControlMsgBytes` up to this ceiling. */
  maxClipboardBytes: number;
  maxSelectorBytes: number;
  maxInlineCaptureBytes: number;
  maxCaptureBytes: number;
  maxProbeLabelBytes: number;
  maxProbeHrefBytes: number;
  maxProbeNameBytes: number;
  maxProbeAttrs: number;
  maxProbeAttrBytes: number;
  maxProbeHtmlBytes: number;
  /** Ceiling on the `session.busy` window. */
  maxBusyMs: number;
}

/**
 * The default {@link Limits}. The rate limits match the table in
 * `docs/protocol/wire-spec.md`.
 */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxBacklog: 3,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxStreams: 28,
  maxLiveStreams: 4,
  maxThumbnailStreams: 24,
  maxViewers: 32,
  maxFps: 30,
  keyframeIntervalMs: 2000,
  statsIntervalMs: 2000,
  maxControlMsgBytes: 65536,
  maxBinaryMessageBytes: 1048576,
  inputRatePerSec: 300,
  controlRatePerSec: Object.freeze({ perSecond: 60, burst: 120 }),
  navRatePerSec: Object.freeze({ perSecond: 4, burst: 8 }),
  cursorRate: Object.freeze({ perSecond: 20, burst: 40 }),
  probeFullRate: Object.freeze({ perSecond: 2, burst: 4 }),
  captureRatePerSec: 1,
  ackRate: Object.freeze({ perSecond: 200, burst: 400 }),
  maxUploadBytes: 268435456,
  maxClipboardBytes: 262144,
  maxSelectorBytes: 1024,
  maxInlineCaptureBytes: 32768,
  maxCaptureBytes: 33554432,
  maxProbeLabelBytes: 80,
  maxProbeHrefBytes: 2048,
  maxProbeNameBytes: 256,
  maxProbeAttrs: 32,
  maxProbeAttrBytes: 512,
  maxProbeHtmlBytes: 4096,
  maxBusyMs: 300000,
});
