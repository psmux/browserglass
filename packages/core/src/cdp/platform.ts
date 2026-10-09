/**
 * Minimal platform access for the CDP layer: a monotonic clock, timer
 * scheduling, and a structural handle to `fetch` and `WebSocket`.
 *
 * This package's `tsconfig` sets `lib: ["ES2023"]` only, with
 * neither `dom` nor Node's own ambient globals visible, and no `@types/node`
 * package is installed anywhere in the workspace. `setTimeout`, `fetch`,
 * `WebSocket`, and `performance` are all real globals at runtime in Node 22
 * (and in a browser), but none of them has a compile time declaration here.
 * Every accessor in this module reaches them through a `globalThis` cast to
 * a small structural interface, the same technique `protocol`'s
 * `wire/ids.ts` uses for `crypto.getRandomValues` and `domain/runtime.ts`
 * uses for `AbortSignalLike`.
 */

/** The subset of a Node `Timeout` or a browser numeric handle this module needs. */
export interface TimerHandle {
  /** Present on Node's `Timeout`, absent on a browser numeric handle. Always called optionally. */
  unref?: () => void;
}

interface MinimalTimers {
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

function timers(): MinimalTimers {
  return globalThis as unknown as MinimalTimers;
}

/**
 * Schedules `handler` to run after `ms` milliseconds and immediately calls
 * `.unref?.()` on the resulting handle, per the universal rule that every
 * timer tied to watchdog or backoff logic must not keep the process alive.
 * Every timer this package creates goes through this function.
 */
export function scheduleTimer(handler: () => void, ms: number): TimerHandle {
  const handle = timers().setTimeout(handler, ms);
  handle.unref?.();
  return handle;
}

/** Cancels a timer created by {@link scheduleTimer}. Safe to call twice. */
export function clearTimer(handle: TimerHandle | null | undefined): void {
  if (handle) {
    timers().clearTimeout(handle);
  }
}

interface MinimalPerformance {
  now: () => number;
}

/**
 * The monotonic clock every duration measurement in this package uses.
 * Never `Date.now()`, which is wall clock and can jump backward on an NTP
 * correction or a system clock change.
 */
export function monotonicNow(): number {
  return (globalThis as unknown as { performance: MinimalPerformance }).performance.now();
}

// ── fetch ────────────────────────────────────────────────────────────────

/** The subset of the `Response` shape {@link probeCdpIdentity} needs. */
export interface MinimalFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The subset of the `fetch` function {@link probeCdpIdentity} needs. */
export type MinimalFetch = (
  url: string,
  init?: { signal?: unknown },
) => Promise<MinimalFetchResponse>;

/**
 * The real global `fetch`, reached through a structural cast. Used as the
 * default when no fetch implementation is injected; tests always inject
 * their own so no real network call is ever made from this package's suite.
 */
export function globalFetch(): MinimalFetch {
  return (globalThis as unknown as { fetch: MinimalFetch }).fetch;
}

// ── WebSocket ────────────────────────────────────────────────────────────

/** A close event as delivered to {@link CdpWebSocketLike.onclose}. */
export interface CdpWebSocketCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** A message event as delivered to {@link CdpWebSocketLike.onmessage}. */
export interface CdpWebSocketMessageEvent {
  data: string;
}

/**
 * The minimal structural contract `CdpBridge` needs from a WebSocket. The
 * real global `WebSocket` (Node 22's built in implementation, or a
 * browser's) satisfies this structurally; a scripted fake used in this
 * package's tests satisfies it directly, with no real socket anywhere in
 * the suite.
 */
export interface CdpWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((ev: CdpWebSocketCloseEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: CdpWebSocketMessageEvent) => void) | null;
}

/** The standard `WebSocket.readyState` values, transcribed since no ambient declaration is visible here. */
export const WS_READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});

/**
 * Constructs a {@link CdpWebSocketLike} against the real global `WebSocket`.
 * This is the default {@link CdpWebSocketFactory}; production callers may
 * supply their own (for example one built on the `ws` package, to carry
 * `CdpEndpoint.headers` for a bearer-authenticated `runtime-remote`
 * endpoint, which the standard `WebSocket` constructor cannot express).
 */
export function defaultWebSocketFactory(endpoint: { url: string }): CdpWebSocketLike {
  interface GlobalWebSocketCtor {
    new (url: string): CdpWebSocketLike;
  }
  const Ctor = (globalThis as unknown as { WebSocket: GlobalWebSocketCtor }).WebSocket;
  return new Ctor(endpoint.url);
}
