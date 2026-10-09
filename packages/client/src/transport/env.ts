/**
 * Ambient host-environment access for `@browserglass/client`.
 *
 * `packages/client/tsconfig.json` extends the repo's `tsconfig.base.json`,
 * which sets `lib: ["ES2023"]` only: no DOM lib, no `@types/node`. This
 * package still needs `setTimeout`/`clearTimeout`, a monotonic clock, and
 * (optionally) `document.visibilityState`, all of which are host-provided
 * globals rather than ECMAScript. This module declares the minimal
 * structural shape of each and reaches them through a single
 * `globalThis` cast, the same pattern `packages/protocol/src/wire/ids.ts`
 * uses for `crypto.getRandomValues`. Nothing here is a Node builtin: every
 * one of these globals is present in a browser, a Web Worker, and Node 22.
 */

/** The slice of the timer API this package needs. */
interface MinimalTimerFns {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The slice of `performance` this package needs: a monotonic clock. */
interface MinimalPerformance {
  now(): number;
}

/** The slice of `document` this package needs, for `pauseWhenHidden`. */
interface MinimalDocument {
  visibilityState: 'visible' | 'hidden' | string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** The slice of `crypto` this package needs, for opaque correlation ids. */
interface MinimalCrypto {
  getRandomValues(array: Uint8Array): Uint8Array;
}

interface HostGlobals {
  setTimeout: MinimalTimerFns['setTimeout'];
  clearTimeout: MinimalTimerFns['clearTimeout'];
  performance: MinimalPerformance;
  document?: MinimalDocument;
  crypto: MinimalCrypto;
}

function host(): HostGlobals {
  return globalThis as unknown as HostGlobals;
}

/** The current time, in fractional milliseconds, from a monotonic clock. Never uses `Date.now()`. */
export function now(): number {
  return host().performance.now();
}

/**
 * A handle returned by {@link scheduleTimer}, cancellable exactly once.
 * Calling `cancel()` more than once, or after the timer already fired, is
 * a harmless no-op.
 */
export interface CancellableTimer {
  cancel(): void;
}

/**
 * Schedules `fn` to run after `delayMs`. Calls the host timer's
 * `.unref?.()` when present (Node's `Timeout`; absent in a browser or
 * worker, guarded here) so a pending backoff or keepalive timer never
 * keeps a Node process alive on its own.
 */
export function scheduleTimer(fn: () => void, delayMs: number): CancellableTimer {
  const g = host();
  let fired = false;
  const handle = g.setTimeout(() => {
    fired = true;
    fn();
  }, delayMs) as { unref?: () => void };
  handle.unref?.();
  return {
    cancel(): void {
      if (fired) return;
      fired = true;
      g.clearTimeout(handle);
    },
  };
}

/** Whether the host exposes `document.visibilityState` at all (absent in a worker or Node). */
export function hasVisibilityApi(): boolean {
  return typeof host().document !== 'undefined';
}

/** The host's current `document.visibilityState`, or `'visible'` when no `document` exists. */
export function visibilityState(): 'visible' | 'hidden' | string {
  return host().document?.visibilityState ?? 'visible';
}

/**
 * Subscribes to `visibilitychange`. A no-op unsubscribe when the host has
 * no `document` (worker, Node without a DOM shim).
 */
export function onVisibilityChange(listener: () => void): () => void {
  const doc = host().document;
  if (!doc) return () => {};
  doc.addEventListener('visibilitychange', listener);
  return () => doc.removeEventListener('visibilitychange', listener);
}

/**
 * Mints an opaque correlation id for `Envelope.id`. Deliberately not a
 * BrowserGlass `<prefix>_<ULID>` id (those are minted server-side, once,
 * at admission): this is only ever echoed back in a response's `re`.
 */
export function randomCorrelationId(): string {
  const bytes = new Uint8Array(10);
  host().crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return `c_${hex}`;
}
