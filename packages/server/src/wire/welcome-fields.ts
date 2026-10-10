/**
 * Builds `welcome.limits`, `welcome.ack`, and `welcome.streaming` from
 * `@browserglass/protocol`'s `DEFAULT_LIMITS` plus this server's own
 * `ResolvedConfig` overrides where a config namespace for one exists.
 * `ResolvedConfig` has no `streaming.*` namespace in this build, so
 * `welcome.streaming` is populated straight from the protocol defaults; a
 * later change that adds
 * a `streaming.*` config section can thread overrides through here without
 * touching any caller.
 */

import { type Codec, DEFAULT_LIMITS, type QualityProfile } from '@browserglass/protocol';
import type { ResolvedConfig } from '../config/types.js';

/** The three `welcome` sub-objects this module builds. */
export interface WelcomeFields {
  readonly limits: {
    readonly maxStreams: number;
    readonly maxBacklog: number;
    readonly maxBufferedBytes: number;
    readonly maxControlMsgBytes: number;
    readonly maxUploadBytes: number;
    readonly maxUploadChunkBytes: number;
    readonly inputRatePerSec: number;
    readonly controlRatePerSec: number;
    readonly navRatePerSec: number;
    readonly maxTargets: number;
    readonly maxSessionDurationMs: number;
    readonly idleTimeoutMs: number;
  };
  readonly ack: {
    readonly policy: 'per-stream' | 'cumulative' | 'off';
    readonly everyNFrames: number;
    readonly maxAckIntervalMs: number;
    readonly required: boolean;
  };
  readonly streaming: {
    readonly codec: Codec;
    readonly fallbackCodec: Codec;
    readonly maxFps: number;
    readonly keyframeIntervalMs: number;
    readonly adaptive: boolean;
    readonly qualityProfiles: QualityProfile[];
  };
}

/** Builds {@link WelcomeFields} from `resolved`. Pure; safe to call once per `welcome`. */
export function buildWelcomeFields(resolved: ResolvedConfig): WelcomeFields {
  return {
    limits: {
      maxStreams: DEFAULT_LIMITS.maxStreams,
      maxBacklog: DEFAULT_LIMITS.maxBacklog,
      maxBufferedBytes: DEFAULT_LIMITS.maxBufferedBytes,
      maxControlMsgBytes: DEFAULT_LIMITS.maxControlMsgBytes,
      maxUploadBytes: resolved.limits.uploadMaxBytes ?? DEFAULT_LIMITS.maxUploadBytes,
      maxUploadChunkBytes: 262_144,
      inputRatePerSec: resolved.limits.inputRatePerSec ?? DEFAULT_LIMITS.inputRatePerSec,
      controlRatePerSec: DEFAULT_LIMITS.controlRatePerSec.perSecond,
      navRatePerSec: DEFAULT_LIMITS.navRatePerSec.perSecond,
      maxTargets: resolved.limits.maxTargetsPerInstance ?? 64,
      maxSessionDurationMs: resolved.sessionLimits.maxDurationMs,
      idleTimeoutMs: resolved.sessionLimits.idleTimeoutMs,
    },
    ack: {
      policy: 'cumulative',
      everyNFrames: 1,
      maxAckIntervalMs: 250,
      required: true,
    },
    streaming: {
      codec: 'jpeg',
      fallbackCodec: 'jpeg',
      maxFps: DEFAULT_LIMITS.maxFps,
      keyframeIntervalMs: DEFAULT_LIMITS.keyframeIntervalMs,
      adaptive: true,
      qualityProfiles: ['auto', 'high', 'medium', 'low'],
    },
  };
}

/** The full rate-limit inputs {@link ViewerRateLimiters} (`./rate-limit.js`) needs, drawn from the same defaults `buildWelcomeFields` uses. */
export function rateLimitInputsFor(resolved: ResolvedConfig): {
  inputRatePerSec: number;
  controlRatePerSec: typeof DEFAULT_LIMITS.controlRatePerSec;
  navRatePerSec: typeof DEFAULT_LIMITS.navRatePerSec;
  cursorRate: typeof DEFAULT_LIMITS.cursorRate;
  probeFullRate: typeof DEFAULT_LIMITS.probeFullRate;
  captureRate: typeof DEFAULT_LIMITS.captureRate;
  ackRate: typeof DEFAULT_LIMITS.ackRate;
} {
  return {
    inputRatePerSec: resolved.limits.inputRatePerSec ?? DEFAULT_LIMITS.inputRatePerSec,
    controlRatePerSec: DEFAULT_LIMITS.controlRatePerSec,
    navRatePerSec: DEFAULT_LIMITS.navRatePerSec,
    cursorRate: DEFAULT_LIMITS.cursorRate,
    probeFullRate: DEFAULT_LIMITS.probeFullRate,
    captureRate: {
      perSecond: resolved.limits.captureRatePerSec ?? DEFAULT_LIMITS.captureRate.perSecond,
      burst: resolved.limits.captureBurst ?? DEFAULT_LIMITS.captureRate.burst,
    },
    ackRate: DEFAULT_LIMITS.ackRate,
  };
}
