/**
 * `CdpBridge`'s public types: the endpoint shape, attach and send options,
 * the session handle, the bridge's own lifecycle events, and version
 * negotiation.
 */

import type { CdpWebSocketLike } from './platform.js';

/**
 * Chrome's flat session id: an opaque hex string, unique per attach,
 * changing on every reattach even though the target's own id is stable.
 */
export type CdpSessionId = string & { readonly __bglsCdpSessionId?: true };

/**
 * How to reach one CDP endpoint over a WebSocket. This is the low level,
 * transport facing shape `CdpBridge.connect` consumes, distinct from
 * `@browserglass/protocol`'s domain level `CdpEndpoint` (which describes
 * how a runtime adapter tells `attach()` to reach an already running
 * browser, with an `excludeBrowserGuid` recovery guard and no `headers` or
 * `ca` fields). The two interfaces serve different callers at different
 * layers and are deliberately not unified.
 */
export interface CdpEndpoint {
  /** `ws://` or `wss://`. */
  url: string;
  /** Bearer or other auth header, for a `runtime-remote` endpoint. */
  headers?: Record<string, string>;
  /** Custom CA certificates, PEM encoded, for a `wss://` endpoint with a private CA. */
  ca?: Uint8Array | readonly Uint8Array[];
  rejectUnauthorized?: boolean;
}

/** Options for `CdpBridge.sessionFor`. */
export interface AttachOptions {
  /** Always `true` when set; `flatten: false` is never sent, in any path. */
  flatten?: true;
  waitForDebuggerOnStart?: boolean;
}

/**
 * {@link AttachOptions} plus a `type` hint the caller (normally
 * `TargetRegistry`, which owns target classification) may stamp onto the resulting
 * `CdpSessionHandle.type`. `CdpBridge` itself has no visibility into target
 * classification.
 */
export interface CdpAttachOptionsExt extends AttachOptions {
  type?: string;
}

/** One live (or once live) attachment to a CDP target. */
export interface CdpSessionHandle {
  readonly id: CdpSessionId;
  /** Chrome's own target id, the hex string `Target.attachToTarget` was called with. */
  readonly targetId: string;
  readonly type: string;
  readonly attachedAt: number;
  /** Monotonic per target counter. A closure holding a stale handle can compare this against the live value and self discard. */
  readonly generation: number;
  readonly alive: boolean;
}

/** Unregisters a handler previously returned by `on`, `onBridge`, or `onScreencastFrame`. */
export type Unsubscribe = () => void;

/** Why a session detached. */
export type DetachReason =
  | 'target_destroyed'
  | 'target_crashed'
  | 'explicit'
  | 'bridge_closed'
  | 'replaced';

/** The bridge level (socket wide) events `onBridge` subscribes to. */
export interface CdpBridgeEvents {
  'bridge.open': () => void;
  'bridge.close': (info: { code: number; reason: string; wasClean: boolean }) => void;
  'bridge.error': (err: Error) => void;
  'session.attached': (h: CdpSessionHandle) => void;
  'session.detached': (h: CdpSessionHandle, reason: DetachReason) => void;
}

/** Options for `CdpBridge.connect`. */
export interface ConnectOptions {
  /** Default 10000. */
  connectTimeoutMs?: number;
  /** Default {@link CDP_MIN_MAJOR_DEFAULT}. Clamped to at least {@link CDP_HARD_MIN_MAJOR}. */
  minMajor?: number;
  /** Default false. */
  strictVersion?: boolean;
}

/** Options for `CdpBridge.send`. */
export interface SendOptions {
  timeoutMs?: number;
  /** Resolve `undefined` on timeout instead of rejecting. */
  fireAndForget?: boolean;
  /** `'high'` implies `fireAndForget` and skips the pending map entirely; use `sendNoReply` instead of this in new code. */
  priority?: 'normal' | 'high';
}

/** One method's rolling latency sample, as reported by `CdpBridge.stats`. */
export interface LatencySample {
  p50: number;
  p95: number;
  n: number;
}

/** A snapshot of one bridge's traffic and health counters. */
export interface CdpBridgeStats {
  sent: number;
  received: number;
  inFlight: number;
  timeouts: number;
  protocolErrors: number;
  sessions: number;
  bytesIn: number;
  bytesOut: number;
  latency: Readonly<Record<string, LatencySample>>;
}

/** Chrome's channel, inferred from `Browser.getVersion`'s `product` string. */
export type BrowserChannelKind = 'chrome' | 'chromium' | 'edge' | 'brave' | 'unknown';

/** The parsed, feature probed result of `Browser.getVersion` plus feature probing. */
export interface BrowserVersion {
  protocolVersion: string;
  product: string;
  channel: BrowserChannelKind;
  major: number;
  full: string;
  revision: string;
  userAgent: string;
  jsVersion: string;
  /** Probed lazily at connect, cached for the life of the bridge. */
  supports: Readonly<Record<string, boolean>>;
}

/** Constructs a {@link CdpWebSocketLike} for one {@link CdpEndpoint}. */
export type CdpWebSocketFactory = (endpoint: CdpEndpoint) => CdpWebSocketLike;

/**
 * The default `ConnectOptions.minMajor`.
 */
export const CDP_MIN_MAJOR_DEFAULT = 120;

/**
 * The hard floor `ConnectOptions.minMajor` clamps to at minimum. Below this
 * major, `Target.setAutoAttach`'s `filter` parameter does not exist, which
 * changes the attach model rather than merely degrading it.
 */
export const CDP_HARD_MIN_MAJOR = 105;
