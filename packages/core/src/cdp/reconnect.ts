/**
 * `reconnectTransport`: the bounded, budgeted redial loop `CdpBridgeImpl`
 * runs when its WebSocket drops unexpectedly (as opposed to a caller's own
 * `close()`). Split out of `bridge.ts` so that file keeps its stated role as
 * the transport (open one socket, multiplex CDP over it) rather than also
 * growing the retry/backoff/budget bookkeeping; `bridge.ts` still owns the
 * actual socket swap and session invalidation once this module reports an
 * outcome.
 *
 * Modelled on browser-use's `BrowserSession.reconnect()`/`_auto_reconnect()`
 * (`browser_use/browser/session.py:2153` / `:2241`: three attempts, 1s/2s/4s
 * backoff), with two deliberate differences:
 *
 * 1. The attempt budget is a sliding ten minute window PER BRIDGE, not per
 *    disconnect event. `_auto_reconnect(max_attempts=3)` caps at three
 *    tries for ONE disconnect, but its own `finally` block
 *    (`session.py:2299`) requeues another three-attempt run if a further
 *    drop arrived while it was reconnecting, so a socket that drops every
 *    couple of seconds reconnects forever. `../recovery/crash-budget.ts`'s
 *    `CrashBudget` is already exactly the right shape for closing that hole
 *    (the "three restarts in ten minutes, then stop" limiter: a sliding
 *    window, N attempts, then stop), so it is reused
 *    directly here rather than reimplemented. Only `attempt`/`exceeded` are
 *    read from its result; `condition`/`triedSoFar` are the crash ladder's
 *    own vocabulary (`plain`/`blank_url`/`quarantine_profile`) and mean
 *    nothing for a transport reconnect, so they are ignored rather than
 *    reinterpreted. A `CrashBudget` instance lives for the whole bridge
 *    (constructed once in `CdpBridgeImpl`'s constructor), so the window
 *    genuinely spans every disconnect the bridge ever sees, not just the
 *    current one, including a run of successful reconnects: a socket that
 *    drops and reconnects every thirty seconds is still capped at three
 *    reconnects per ten minutes, on purpose (see the "no reset on success"
 *    note at the call site in `bridge.ts`).
 * 2. There is no separate "is this a transport drop or a dead browser"
 *    pre-classifier consulted before retrying. browser-use's
 *    `_is_connection_like_error`/`_is_browser_closed_error`
 *    (`browser_use/agent/service.py:1310`/`:1326`) are a genuinely good
 *    idea, but they classify an error MESSAGE, after the fact, for the
 *    agent loop's benefit in deciding whether to keep waiting. At the raw
 *    WebSocket layer there is no equivalent signal to classify: a refused
 *    connection (browser process gone) and a connection that opens but
 *    never completes a handshake (network blip, browser still alive, or a
 *    proxy in a bad state) can both manifest as "the dial never opens" or
 *    "the dial opens but errors soon after". The redial attempt itself IS
 *    the liveness test here: a live browser answers a genuine
 *    `Browser.getVersion` round trip within the budget's three attempts and
 *    this returns a working socket; a browser that is actually gone fails
 *    every attempt, and the budget's exhaustion (not a guessed error
 *    string) is what stands in for `_is_browser_closed_error`, bounded
 *    rather than looping.
 */

import type { CrashBudget } from '../recovery/crash-budget.js';
import { type CdpWebSocketLike, clearTimer, monotonicNow, scheduleTimer } from './platform.js';
import type { CdpEndpoint, CdpWebSocketFactory } from './types.js';

/**
 * 1s, 2s, 4s: browser-use's own schedule (`session.py:2241`'s `delays`),
 * reused verbatim. Nothing about this codebase's own transport suggests a
 * different curve serves a CDP socket drop any better, and matching a
 * known-reasonable schedule beats inventing a new one.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

/** How long one redial (`WebSocket` open) or verify (`Browser.getVersion`) round trip is allowed before it counts as a failed attempt. */
export const RECONNECT_DIAL_TIMEOUT_MS = 8000;

/** The key `CrashBudget` tracks reconnect attempts under: one bridge, one transport, one sliding window, so a single constant key is correct here (contrast the crash budget's own per-target keys, one crash-looping target each). */
const RECONNECT_BUDGET_KEY = 'transport';

/** Constructor options for {@link reconnectTransport}. */
export interface ReconnectDeps {
  readonly endpoint: CdpEndpoint;
  readonly wsFactory: CdpWebSocketFactory;
  /** Shared across the bridge's whole lifetime; see the module doc's point 1 for why this must not be a fresh budget per call. */
  readonly budget: CrashBudget;
  readonly backoffMs?: readonly number[];
  readonly dialTimeoutMs?: number;
  /** Overridable for tests, so a budget-exhaustion test does not spend real wall time on backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What {@link reconnectTransport} resolved to. */
export type ReconnectOutcome =
  | { readonly kind: 'reconnected'; readonly socket: CdpWebSocketLike; readonly attempts: number }
  | { readonly kind: 'exhausted'; readonly attempts: number };

/**
 * Opens one fresh socket and waits for it to be ready, or rejects on error
 * or timeout. Shares its shape with `CdpBridgeImpl.connect()`'s own open
 * promise, deliberately not factored together with it: `connect()` owns the
 * bridge's one-time first connection (with its own version/feature-probe
 * follow-up), this owns a budgeted retry loop with a much narrower job, and
 * collapsing the two would make the retry budget's boundaries harder to see
 * at either call site than the small duplication costs.
 */
function openOnce(
  wsFactory: CdpWebSocketFactory,
  endpoint: CdpEndpoint,
  timeoutMs: number,
): Promise<CdpWebSocketLike> {
  const socket = wsFactory(endpoint);
  return new Promise<CdpWebSocketLike>((resolve, reject) => {
    const timer = scheduleTimer(() => {
      reject(new Error(`reconnect dial timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.onopen = () => {
      clearTimer(timer);
      resolve(socket);
    };
    socket.onerror = (err) => {
      clearTimer(timer);
      reject(err instanceof Error ? err : new Error('reconnect dial errored'));
    };
  });
}

/** Sentinel request id for the verify round trip: distinct from the bridge's own `nextId` space (which starts at 1) and from `NO_REPLY_ID` (0), though collision is moot anyway since this candidate socket carries no other traffic yet. */
const VERIFY_REQUEST_ID = -1;

/**
 * Confirms a freshly opened socket is a live, responsive CDP endpoint (a
 * real `Browser.getVersion` round trip), not merely a TCP/WebSocket
 * handshake that happened to succeed against something stale. Runs entirely
 * outside the bridge's own message routing and pending map: the candidate
 * socket is discarded on failure without ever being wired to `this.ws`.
 */
function verifyLive(socket: CdpWebSocketLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = scheduleTimer(() => {
      socket.onmessage = null;
      reject(new Error(`reconnect verify timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.onmessage = (ev) => {
      let msg: { id?: number; error?: unknown };
      try {
        msg = JSON.parse(ev.data) as { id?: number; error?: unknown };
      } catch {
        return;
      }
      if (msg.id !== VERIFY_REQUEST_ID) {
        return;
      }
      clearTimer(timer);
      socket.onmessage = null;
      if (msg.error) {
        reject(new Error('reconnect verify: Browser.getVersion returned an error'));
      } else {
        resolve();
      }
    };
    try {
      socket.send(
        JSON.stringify({ id: VERIFY_REQUEST_ID, method: 'Browser.getVersion', params: {} }),
      );
    } catch (err) {
      clearTimer(timer);
      reject(err instanceof Error ? err : new Error('reconnect verify send failed'));
    }
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    scheduleTimer(() => resolve(), ms);
  });
}

/**
 * Whether a dial failure was the operating system saying nothing is
 * listening on that port. Node reports this as `ECONNREFUSED` on the error
 * itself, and a `ws` failure wraps it, so both the `code` property and the
 * message are checked rather than assuming one shape.
 */
function isConnectionRefused(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'ECONNREFUSED') return true;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause?.code === 'ECONNREFUSED') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('ECONNREFUSED');
}

/**
 * Whether this endpoint is on the local machine, which is what makes a
 * refused connection conclusive rather than merely discouraging.
 *
 * Takes the whole {@link CdpEndpoint} rather than a bare string because
 * that is what `ReconnectDeps` actually carries: a `wss://` endpoint with
 * `headers` and a private `ca` is a `runtime-remote` shape, and reading
 * only `url` off it keeps this honest about which field decides.
 */
function isLoopbackEndpoint(endpoint: CdpEndpoint): boolean {
  let host: string;
  try {
    host = new URL(endpoint.url).hostname;
  } catch {
    return false;
  }
  // `URL` keeps the brackets on an IPv6 literal, hence the `[::1]` form.
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Runs the budgeted redial loop. Never throws: exhaustion is a normal,
 * reported outcome (`{kind: 'exhausted'}`), not a rejection, so the caller
 * in `bridge.ts` never needs a try/catch around this to reach its own
 * finalize path.
 */
export async function reconnectTransport(deps: ReconnectDeps): Promise<ReconnectOutcome> {
  const backoffMs = deps.backoffMs ?? RECONNECT_BACKOFF_MS;
  const dialTimeoutMs = deps.dialTimeoutMs ?? RECONNECT_DIAL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;

  for (;;) {
    const record = deps.budget.recordCrash(RECONNECT_BUDGET_KEY, monotonicNow());
    if (record.exceeded) {
      return { kind: 'exhausted', attempts: record.attempt - 1 };
    }
    try {
      const socket = await openOnce(deps.wsFactory, deps.endpoint, dialTimeoutMs);
      await verifyLive(socket, dialTimeoutMs);
      return { kind: 'reconnected', socket, attempts: record.attempt };
    } catch (err) {
      // One dial failure IS worth classifying. A refused connection to a
      // LOOPBACK endpoint means nothing is listening on that port any
      // more, which for a browser this node launched means the process is
      // gone. Retrying that is not resilience, it is a delay: three
      // attempts at 1s, 2s and 4s spend seven seconds proving what the
      // first `ECONNREFUSED` already said, and the recovery ladder a level
      // up cannot start until this gives up.
      //
      // Measured, so the claim is not overstated: disabling reconnect
      // entirely does NOT change `chaos-1-kill-browser`'s outcome, so this
      // is not the cause of that failure and is not a fix for it. It is
      // worth doing on its own terms, to stop a dead browser costing seven
      // seconds of pointless redialling before anything else can act.
      //
      // Scoped to loopback deliberately. Against a remote endpoint a
      // refusal really can be transient, a proxy or a forwarder restarting,
      // and there the budget's own backoff is the right answer.
      if (isConnectionRefused(err) && isLoopbackEndpoint(deps.endpoint)) {
        return { kind: 'exhausted', attempts: record.attempt };
      }
      // Anything else is a timeout, a verify failure, or a transport error
      // with no local signal worth reading. Back off and let the budget
      // decide when to stop.
      const idx = Math.min(record.attempt - 1, backoffMs.length - 1);
      const delay = backoffMs[idx] ?? backoffMs[backoffMs.length - 1] ?? 0;
      await sleep(delay);
    }
  }
}
