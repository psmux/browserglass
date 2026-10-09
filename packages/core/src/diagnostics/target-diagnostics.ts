/**
 * `TargetDiagnostics`: console, page-error and network capture for one
 * Target, driven directly by a `CdpBridge` + `CdpSessionId`. No `Session`
 * dependency; `packages/server/src/session/managed-session.ts`
 * owns turning what this class emits into wire messages, capability
 * gating, and sending untrusted strings through `wire/sanitize.ts`.
 *
 * Domain ownership: nothing else in this build enables `Runtime`, `Log`,
 * or `Network`. `packages/core/src/cdp/target-registry.ts`'s own module
 * doc is explicit that of the full per-target domain-enable lifecycle it
 * implements only `Page.enable` (plus the unconditional
 * `Runtime.runIfWaitingForDebugger` safety net, which needs no
 * `Runtime.enable` first) and leaves `Runtime.enable` and everything else
 * "not built here". Confirmed directly: `grep -rn "Runtime.enable"
 * packages/core/src packages/server/src` matches only a timeout-table
 * entry in `cdp/timeouts.ts`, never a `bridge.send('Runtime.enable', ...)`
 * call. This class is therefore the sole owner of `Runtime`, `Log`, and
 * `Network` for a target: it enables exactly the domains its requested
 * feeds need and disables exactly what it enabled, tracked in
 * `enabledDomains` rather than assumed from any other module's state.
 *
 * Per-session, not per-target: every CDP domain-enable and every
 * `CdpBridge.on(...)` subscription this class makes is scoped to one
 * `CdpSessionId`. A cross-origin navigation swaps the renderer process,
 * which kills that session outright; the Target survives under a brand
 * new session id, and Chrome does not carry `Runtime.enable`/`Log.enable`/
 * `Network.enable` (or any listener) across that swap. `rebind()` is the
 * first class operation for this: it drops every session-scoped listener
 * and every piece of session-scoped correlation state (in particular
 * `pendingRequests`, since a request that started under the dead renderer
 * can never receive its terminal event), then re-subscribes and re-enables
 * whatever `feeds` was last requested against the new session. This
 * mirrors `session/target-activation.ts`'s `FrameSource.rebuild(targetId,
 * sessionId)` seam (driven by `session/recovery-target.ts`'s
 * `RecoveryCapture.rebuild` after a rung re-establishes a session); this
 * class calls it `rebind(sessionId)` rather than `rebuild`, taking only
 * the session id, because a `TargetDiagnostics` instance is already scoped
 * to one target and needs no `targetId` parameter to relocate.
 *
 * Every `bridge.on` handler closes over the `CdpSessionId` it was
 * registered against and re-checks it is still `this.sessionId` before
 * touching any instance state. `CdpBridge`'s own per-`(sessionId, event)`
 * keying (`bridge.ts`'s `on()`) already stops a fully unsubscribed handler
 * from firing again, but this guard additionally covers the case where a
 * `rebind()` runs synchronously ahead of an event that was already
 * in-flight for the old session: without it, that stale event could
 * mutate state (`pendingRequests`, `enabledDomains`) that by then belongs
 * to the new session.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../cdp/types.js';
import { type Clock, createSystemClock } from '../control/clock.js';
import type {
  ConsolePayload,
  DiagnosticsFeeds,
  DiagnosticsSink,
  NetworkRequestEntryPayload,
  NetworkSummaryPayload,
} from './types.js';

/** Spec-mandated: identical `(level, text)` within this window coalesces into one emission carrying `count`. */
const COALESCE_WINDOW_MS = 1000;

/**
 * Emissions (one `sink.on*` call, however many raw CDP events or coalesced
 * duplicates fed it) allowed per target per second; the rest are dropped,
 * never buffered. Shared across every feed on one target, not per-feed,
 * because the thing this protects is the one control-channel socket the
 * video streams also share (picture a wall of 12 panes, each with a noisy
 * page). 50/sec keeps the worst case, at the ~8KB text cap below, to
 * roughly 400KB/sec for the noisiest possible target: the same order of
 * magnitude as a single compressed video frame, not a multiple of it, and
 * comfortably above what a page a human is actually debugging produces
 * once the 1s coalescing window has already collapsed a log loop down to
 * one emission per unique message per second.
 */
const EMIT_CAP_PER_SEC = 50;

/** How often `network.summary` is emitted while the `network` feed is on. Frequent enough to feel live, coarse enough that it is never itself rate-limited. */
const NETWORK_SUMMARY_WINDOW_MS = 5000;

/** How many of a window's slowest requests `network.summary.slowest` carries. Unbounded would make one busy target's summary grow every window; 5 is enough to spot an outlier without the array itself becoming the next thing that needs capping. */
const SLOWEST_CAP = 5;

/**
 * Bound on in-flight `Network.requestWillBeSent` correlation entries
 * awaiting a terminal event. A long-poll or a hung request that never
 * finishes or fails must not let this map grow without bound for the
 * lifetime of the collector; past this many outstanding requests the
 * oldest (by insertion order, which `Map` preserves) is evicted rather
 * than tracked forever. 200 comfortably covers a real page's worst
 * legitimate burst (a waterfall of parallel subresource loads) while
 * still being a hard ceiling.
 */
const MAX_PENDING_REQUESTS = 200;

/**
 * How long, after `Network.responseReceived`, a pending request waits for
 * `Network.loadingFinished`/`Network.loadingFailed` before this collector
 * completes it anyway from what the response already told it. See
 * {@link TargetDiagnostics.completeFromResponseFallback}'s doc for why this
 * exists at all: confirmed directly against real Chrome 151.0.7922.174, a
 * `fetch()` whose caller never reads the response body (`fetch(url).catch(fn)`,
 * with no `.then(r => r.json())` or similar) gets `Network.dataReceived` and
 * `Network.responseReceived` like any other request, but Chrome never sends
 * `Network.loadingFinished` for it: nothing in the DevTools protocol marks
 * that load as finished until its body stream is drained or garbage
 * collected. That is an ordinary real-page pattern (a fire-and-forget beacon
 * or logging call), not a corner case, so a collector that only ever
 * completes on the two terminal events never reports such a request at all.
 * 1500ms is comfortably past how long a same-machine resource takes to
 * finish downloading in the ordinary case, so a request that WILL still get
 * a proper terminal event is not pre-empted by this.
 */
const RESPONSE_FALLBACK_MS = 1500;

/**
 * Coarse pre-cap on `text`/`message` length, independent of and in
 * addition to `packages/server/src/wire/sanitize.ts`'s precise
 * `consoleTextBytes` (8192) UTF-8 byte cap. That sanitizer runs downstream
 * in `ManagedSession`, in a package this module must not depend on; this
 * cap exists so a single pathological `console.log` (megabytes of
 * JSON, say) is never even held in the coalescing map or handed across the
 * `DiagnosticsSink` boundary while waiting for that later, exact pass.
 * Measured in characters, not bytes, since this collector has no cheap
 * UTF-8 byte count for a string it has not yet encoded.
 */
const MAX_TEXT_CHARS = 8192;

function truncateText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/** One pending coalesce bucket: duplicates of the same `(level, text)` increment `count` until `timer` fires. */
interface CoalesceEntry {
  level: ConsolePayload['level'];
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
  count: number;
  timer: ReturnType<Clock['setTimer']>;
}

/** One `Network.requestWillBeSent` awaiting its terminal event, keyed by CDP `requestId`. */
interface PendingRequest {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  fromCache: boolean;
  startedAt: number;
  /** CDP's own monotonic `timestamp` (seconds) from `requestWillBeSent`, for `durationMs` arithmetic. Undefined only if the payload was malformed. */
  startTimestamp?: number;
  /** Armed by `onResponseReceived`; see {@link RESPONSE_FALLBACK_MS}. `null` until a response has actually been seen for this request. */
  fallbackTimer: ReturnType<Clock['setTimer']> | null;
}

/** One in-progress `network.summary` window's running totals. */
interface NetworkWindowAccumulator {
  requests: number;
  failed: number;
  bytesIn: number;
  bytesOut: number;
  slowest: Array<{ url: string; ms: number; status: number }>;
}

function freshNetworkWindow(): NetworkWindowAccumulator {
  return { requests: 0, failed: 0, bytesIn: 0, bytesOut: 0, slowest: [] };
}

/** Maps a `Runtime.consoleAPICalled` `type` to the wire's 5-value level enum. Everything not explicitly listed (`dir`, `table`, `trace`, `group*`, `assert`, `count`, `timeEnd`, `profile*`, ...) is ordinary `log`-level output. */
function normalizeConsoleApiLevel(type: string): ConsolePayload['level'] {
  if (type === 'error') return 'error';
  if (type === 'warning') return 'warn';
  if (type === 'info') return 'info';
  if (type === 'debug') return 'debug';
  return 'log';
}

/** Maps a `Log.entryAdded` entry `level` (`verbose`/`info`/`warning`/`error`) to the wire's 5-value level enum. `verbose` becomes `debug`, the closest match. */
function normalizeLogLevel(level: string): ConsolePayload['level'] {
  if (level === 'error') return 'error';
  if (level === 'warning') return 'warn';
  if (level === 'info') return 'info';
  if (level === 'verbose') return 'debug';
  return 'log';
}

/** Renders one `Runtime.consoleAPICalled` `RemoteObject` argument to display text, without a live CDP round trip (no `Runtime.getProperties` call): primitives use `value` directly, objects fall back to `description`, and anything else falls back to a `[type]` placeholder. */
function formatRemoteObject(arg: Record<string, unknown>): string {
  if ('value' in arg) {
    const v = arg['value'];
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  if (typeof arg['unserializableValue'] === 'string') return arg['unserializableValue'] as string;
  if (typeof arg['description'] === 'string') return arg['description'] as string;
  return typeof arg['type'] === 'string' ? `[${arg['type'] as string}]` : '[object]';
}

function formatConsoleArgs(args: unknown): string {
  if (!Array.isArray(args)) return '';
  return args.map((a) => formatRemoteObject((a ?? {}) as Record<string, unknown>)).join(' ');
}

/** One rendered CDP stack frame, in `at fn (url:line:col)` form. `lineNumber`/`columnNumber` are CDP's 0-based values, rendered 1-based to match every other tool a human debugging this would see. */
function formatFrame(f: Record<string, unknown>): string {
  const fn =
    typeof f['functionName'] === 'string' && f['functionName']
      ? (f['functionName'] as string)
      : '<anonymous>';
  const url = typeof f['url'] === 'string' ? (f['url'] as string) : '';
  const line = typeof f['lineNumber'] === 'number' ? (f['lineNumber'] as number) + 1 : 0;
  const column = typeof f['columnNumber'] === 'number' ? (f['columnNumber'] as number) + 1 : 0;
  return `at ${fn} (${url}:${line}:${column})`;
}

/** Extracts `{url, line, column, stack}` from a CDP `Runtime.StackTrace`, or `{}` if the payload carries none (an unhandled rejection with no synchronous frame, for instance). */
function frameInfo(stackTrace: unknown): {
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
} {
  if (typeof stackTrace !== 'object' || stackTrace === null) return {};
  const frames = (stackTrace as Record<string, unknown>)['callFrames'];
  if (!Array.isArray(frames) || frames.length === 0) return {};
  const top = frames[0] as Record<string, unknown>;
  const url = typeof top['url'] === 'string' && top['url'] ? (top['url'] as string) : undefined;
  const line =
    typeof top['lineNumber'] === 'number' ? (top['lineNumber'] as number) + 1 : undefined;
  const column =
    typeof top['columnNumber'] === 'number' ? (top['columnNumber'] as number) + 1 : undefined;
  const stack = frames.map((f) => formatFrame((f ?? {}) as Record<string, unknown>)).join('\n');
  // `exactOptionalPropertyTypes` (this package's tsconfig) rejects an
  // object literal that always carries the key with a possibly-`undefined`
  // value against a target typed `key?: T` (not `key?: T | undefined`); the
  // conditional spread below is the established pattern for this
  // (`input/validation.ts`'s `validateMouse`).
  return {
    ...(url !== undefined ? { url } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(stack ? { stack } : {}),
  };
}

/** Constructor options for {@link TargetDiagnostics}. */
export interface TargetDiagnosticsOptions {
  bridge: CdpBridge;
  sessionId: CdpSessionId;
  targetId: string;
  sink: DiagnosticsSink;
  /** Default: {@link createSystemClock}. Tests inject a `ManualClock` so the 1s coalescing window and the 5s summary window advance deterministically. */
  clock?: Clock;
}

export class TargetDiagnostics {
  readonly targetId: string;
  private readonly bridge: CdpBridge;
  private readonly sink: DiagnosticsSink;
  private readonly clock: Clock;

  private sessionId: CdpSessionId;
  private unsubs: Unsubscribe[] = [];
  private stopped = false;

  /** What `start()`/`reconfigure()` were last asked for, independent of what actually ended up enabled; `rebind()` re-applies this against the new session. */
  private requestedFeeds: DiagnosticsFeeds = { console: false, errors: false, network: false };
  /** What is actually enabled right now, keyed by CDP domain name. Cleared on `rebind()` (domain state lives on the session) and on `stop()`. */
  private readonly enabledDomains = new Set<'Runtime' | 'Log' | 'Network'>();
  private _feeds: DiagnosticsFeeds = { console: false, errors: false, network: false };

  private readonly consoleCoalesce = new Map<string, CoalesceEntry>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private networkWindow: NetworkWindowAccumulator = freshNetworkWindow();
  private summaryTimer: ReturnType<Clock['setTimer']> | null = null;

  /** Fixed one-second emission budget window; see {@link EMIT_CAP_PER_SEC}. */
  private emitWindowStart = Number.NEGATIVE_INFINITY;
  private emitCountThisWindow = 0;

  constructor(opts: TargetDiagnosticsOptions) {
    this.bridge = opts.bridge;
    this.sessionId = opts.sessionId;
    this.targetId = opts.targetId;
    this.sink = opts.sink;
    this.clock = opts.clock ?? createSystemClock();
    this.subscribeListeners();
  }

  /** What is actually on right now (not merely what was last requested): the honest answer `diagnostics.subscribed` echoes back to the viewer. */
  get feeds(): DiagnosticsFeeds {
    return this._feeds;
  }

  /**
   * Whether the `Runtime` domain is enabled on this target's CURRENT
   * session right now: the one CDP-visible side effect this module's own
   * doc measures as an automation fingerprint (`hit-test.ts`'s module doc
   * repeats the same measurement: five `Runtime.evaluate` calls on a fresh
   * session produced zero `Runtime.executionContextCreated`/`consoleAPICalled`
   * events, one `Runtime.enable` produced one context-created event and
   * roughly 1500 console events in under two seconds). Exposed as its own
   * getter, separate from {@link feeds}, because the two answer different
   * questions: `feeds` says what a CALLER asked for and got
   * (`console`/`errors`/`network`, each potentially requested by several
   * viewers and unioned by `ManagedSession`), while this says whether the
   * one CDP domain every one of those callers' `Runtime`-needing feeds
   * shares is ACTUALLY on, which is what decides whether this target is
   * currently fingerprintable. `enabledDomains` already tracked this
   * (`applyFeeds`'s `tryEnable`/disable calls), but only as private,
   * CDP-internal bookkeeping; before this getter, a caller had no way to
   * ask the question this class's own module doc frames as load bearing
   * ("BrowserGlass is quiet by default, and becomes loud the moment a
   * caller subscribes to console or network diagnostics") without reaching
   * into that private state. `false` for a target with no `TargetDiagnostics`
   * at all (nobody has ever called `start()`), matching the honest
   * quiet-by-default state this whole build is built around: `Session`
   * (`../session/session.ts`) reports that case itself, since a target with
   * nothing subscribed never gets one of these constructed in the first
   * place.
   */
  get fingerprintActive(): boolean {
    return this.enabledDomains.has('Runtime');
  }

  /** Enables only the CDP domains the requested feeds need. Idempotent: a domain already enabled is never re-sent. */
  async start(feeds: DiagnosticsFeeds): Promise<void> {
    await this.applyFeeds(feeds);
  }

  /** Changes feeds on a running collector without tearing down: enables newly needed domains, disables domains no longer needed by anything, leaves the rest untouched. Same underlying operation as {@link start}; the separate name is for caller clarity (`Session.setDiagnostics` calling into an existing collector versus creating one). */
  async reconfigure(feeds: DiagnosticsFeeds): Promise<void> {
    await this.applyFeeds(feeds);
  }

  /**
   * Re-establishes this collector against a new `CdpSessionId` for the same
   * target, after a cross-origin navigation (or any other renderer swap)
   * killed the old session. Drops every session-scoped listener and every
   * piece of session-scoped state (in-flight network correlation, pending
   * coalesce timers, the enabled-domain set), then re-subscribes and
   * re-applies whatever feeds were last requested, against the new
   * session. A no-op if `sessionId` is already the current one.
   */
  async rebind(sessionId: CdpSessionId): Promise<void> {
    if (this.stopped) throw new Error('TargetDiagnostics: cannot rebind after stop()');
    if (sessionId === this.sessionId) return;

    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.clearPendingRequests();
    for (const entry of this.consoleCoalesce.values()) this.clock.clearTimer(entry.timer);
    this.consoleCoalesce.clear();
    this.enabledDomains.clear();
    this.stopSummaryTimer();
    this._feeds = { console: false, errors: false, network: false };

    this.sessionId = sessionId;
    this.subscribeListeners();
    await this.applyFeeds(this.requestedFeeds);
  }

  /** Disables exactly the domains this collector enabled, and drops every listener and timer. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.stopSummaryTimer();
    for (const entry of this.consoleCoalesce.values()) this.clock.clearTimer(entry.timer);
    this.consoleCoalesce.clear();
    this.clearPendingRequests();

    const domains = [...this.enabledDomains];
    this.enabledDomains.clear();
    await Promise.all(
      domains.map((d) =>
        this.bridge.send(`${d}.disable`, undefined, this.sessionId).catch(() => {
          // The session may already be gone (target closed, renderer swapped
          // without a rebind ever landing); a disable that never reaches the
          // browser leaves nothing to clean up on this end either way.
        }),
      ),
    );
    this._feeds = { console: false, errors: false, network: false };
  }

  // ── domain enable/disable ────────────────────────────────────────────

  private async applyFeeds(feeds: DiagnosticsFeeds): Promise<void> {
    if (this.stopped) throw new Error('TargetDiagnostics: cannot start/reconfigure after stop()');
    this.requestedFeeds = feeds;

    const needRuntime = feeds.console || feeds.errors;
    const needLog = feeds.console;
    const needNetwork = feeds.network;

    if (needRuntime && !this.enabledDomains.has('Runtime')) {
      await this.tryEnable('Runtime.enable', 'Runtime');
    }
    if (needLog && !this.enabledDomains.has('Log')) {
      await this.tryEnable('Log.enable', 'Log');
    }
    if (needNetwork && !this.enabledDomains.has('Network')) {
      await this.tryEnable('Network.enable', 'Network');
      if (this.enabledDomains.has('Network')) {
        this.networkWindow = freshNetworkWindow();
        this.scheduleSummaryFlush();
      }
    }

    if (!needRuntime && this.enabledDomains.has('Runtime')) {
      this.enabledDomains.delete('Runtime');
      await this.bridge.send('Runtime.disable', undefined, this.sessionId).catch(() => {});
    }
    if (!needLog && this.enabledDomains.has('Log')) {
      this.enabledDomains.delete('Log');
      await this.bridge.send('Log.disable', undefined, this.sessionId).catch(() => {});
    }
    if (!needNetwork && this.enabledDomains.has('Network')) {
      this.enabledDomains.delete('Network');
      this.stopSummaryTimer();
      await this.bridge.send('Network.disable', undefined, this.sessionId).catch(() => {});
    }

    // The feed a viewer actually gets is the AND of "requested" and
    // "actually enabled": a domain that failed to enable (target mid
    // navigation, mid crash) must not be reported as on just because it
    // was asked for, and a domain kept alive only for a sibling feed
    // (Runtime serves both `console` and `errors`) must not leak into the
    // feed that did not ask for it.
    this._feeds = {
      console:
        feeds.console && this.enabledDomains.has('Runtime') && this.enabledDomains.has('Log'),
      errors: feeds.errors && this.enabledDomains.has('Runtime'),
      network: feeds.network && this.enabledDomains.has('Network'),
    };
  }

  private async tryEnable(method: string, domain: 'Runtime' | 'Log' | 'Network'): Promise<void> {
    try {
      await this.bridge.send(method, undefined, this.sessionId);
      this.enabledDomains.add(domain);
    } catch {
      // A target that died, or a session that was mid-swap, between
      // `diagnostics.subscribe` and the domain actually enabling is
      // ordinary, not exceptional: matches `target-registry.ts`'s own
      // `initPageDomain` precedent for `Page.enable`. Leaving the domain
      // unmarked means `stop()`/`applyFeeds()` never sends a `.disable`
      // for something that never actually enabled, and `_feeds` (computed
      // by the caller right after this) honestly reports the feed as off.
    }
  }

  private stopSummaryTimer(): void {
    if (this.summaryTimer) {
      this.clock.clearTimer(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  /** Clears every armed {@link RESPONSE_FALLBACK_MS} timer before dropping `pendingRequests`, so `rebind()`/`stop()` never leave one running past the correlation state it would complete. */
  private clearPendingRequests(): void {
    for (const entry of this.pendingRequests.values()) {
      if (entry.fallbackTimer) this.clock.clearTimer(entry.fallbackTimer);
    }
    this.pendingRequests.clear();
  }

  private scheduleSummaryFlush(): void {
    this.summaryTimer = this.clock.setTimer(() => this.flushSummary(), NETWORK_SUMMARY_WINDOW_MS);
  }

  private flushSummary(): void {
    const snapshot = this.networkWindow;
    this.networkWindow = freshNetworkWindow();
    if (this.admitEmission()) {
      this.sink.onNetworkSummary({
        windowMs: NETWORK_SUMMARY_WINDOW_MS,
        requests: snapshot.requests,
        failed: snapshot.failed,
        bytesIn: snapshot.bytesIn,
        bytesOut: snapshot.bytesOut,
        slowest: snapshot.slowest,
        // Read live, not from `snapshot`: `pendingRequests` is not part of
        // the windowed accumulator `flushSummary` just reset, it is
        // instance state that outlives any one window. See
        // `NetworkSummaryPayload.inFlight`'s own doc for why this is a
        // gauge, not a rollup.
        inFlight: this.pendingRequests.size,
      } satisfies NetworkSummaryPayload);
    }
    // Re-arm for the next window as long as the network feed is still
    // actually on; `applyFeeds`/`stop`/`rebind` all call `stopSummaryTimer`
    // first when turning it off, so this only re-schedules while wanted.
    if (this.enabledDomains.has('Network')) this.scheduleSummaryFlush();
  }

  /**
   * An out-of-cycle `network.summary` emission for the one transition a
   * consumer waiting on {@link NetworkSummaryPayload.inFlight} (a
   * `waitForNetworkIdle`-style caller, `packages/automation`'s
   * `AutomationClient`) cares about most: the last outstanding request
   * just finished. Without this, that caller would only learn "went idle"
   * on the next scheduled tick, up to {@link NETWORK_SUMMARY_WINDOW_MS}
   * (5000ms) late, which is ten times {@link RESPONSE_FALLBACK_MS} and
   * would make the common "wait a moment after the last click, then act"
   * pattern feel broken even though the underlying signal was already
   * known. Called from every path that can remove the last
   * `pendingRequests` entry (`onLoadingFinished`, `onLoadingFailed`,
   * `completeFromResponseFallback`); a no-op unless `pendingRequests` is
   * now actually empty, so a request finishing while others are still
   * outstanding does not trigger it. Cancels and re-arms the periodic
   * timer through the same `flushSummary()` this emission reuses, so this
   * never produces a second, redundant emission on top of the next
   * scheduled one.
   */
  private flushIfNowIdle(): void {
    if (!this._feeds.network) return;
    if (this.pendingRequests.size !== 0) return;
    this.stopSummaryTimer();
    this.flushSummary();
  }

  // ── emission budget ──────────────────────────────────────────────────

  /** Admits one emission against the fixed 1s/{@link EMIT_CAP_PER_SEC} budget, returning whether the caller may proceed. Past-cap emissions are dropped outright, never queued (spec: "dropping past the cap rather than buffering unboundedly"). */
  private admitEmission(): boolean {
    const now = this.clock.monotonicNow();
    if (now - this.emitWindowStart >= 1000) {
      this.emitWindowStart = now;
      this.emitCountThisWindow = 0;
    }
    if (this.emitCountThisWindow >= EMIT_CAP_PER_SEC) return false;
    this.emitCountThisWindow += 1;
    return true;
  }

  // ── console / errors ─────────────────────────────────────────────────

  private handleConsoleLike(
    level: ConsolePayload['level'],
    rawText: string,
    extra: { url?: string; line?: number; column?: number; stack?: string },
  ): void {
    const text = truncateText(rawText);
    const key = `${level} ${text}`;
    const existing = this.consoleCoalesce.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    const entry: CoalesceEntry = {
      level,
      text,
      ...extra,
      count: 1,
      timer: null as unknown as ReturnType<Clock['setTimer']>,
    };
    entry.timer = this.clock.setTimer(() => {
      this.consoleCoalesce.delete(key);
      if (this.admitEmission()) {
        this.sink.onConsole({
          level: entry.level,
          text: entry.text,
          count: entry.count,
          // `exactOptionalPropertyTypes`: only carry the key when the
          // entry actually has one, matching `frameInfo`'s own construction.
          ...(entry.url !== undefined ? { url: entry.url } : {}),
          ...(entry.line !== undefined ? { line: entry.line } : {}),
          ...(entry.column !== undefined ? { column: entry.column } : {}),
          ...(entry.stack !== undefined ? { stack: entry.stack } : {}),
        });
      }
    }, COALESCE_WINDOW_MS);
    this.consoleCoalesce.set(key, entry);
  }

  private readonly onConsoleApiCalled = (params: Record<string, unknown>): void => {
    if (!this._feeds.console) return;
    const type = typeof params['type'] === 'string' ? (params['type'] as string) : 'log';
    const level = normalizeConsoleApiLevel(type);
    const text = formatConsoleArgs(params['args']);
    const frame = frameInfo(params['stackTrace']);
    this.handleConsoleLike(level, text, frame);
  };

  private readonly onLogEntryAdded = (params: Record<string, unknown>): void => {
    if (!this._feeds.console) return;
    const entryRaw = params['entry'];
    if (typeof entryRaw !== 'object' || entryRaw === null) return;
    const entry = entryRaw as Record<string, unknown>;
    const level = normalizeLogLevel(
      typeof entry['level'] === 'string' ? (entry['level'] as string) : '',
    );
    const text = typeof entry['text'] === 'string' ? (entry['text'] as string) : '';
    const url =
      typeof entry['url'] === 'string' && entry['url'] ? (entry['url'] as string) : undefined;
    const line =
      typeof entry['lineNumber'] === 'number' ? (entry['lineNumber'] as number) + 1 : undefined;
    this.handleConsoleLike(level, text, {
      ...(url !== undefined ? { url } : {}),
      ...(line !== undefined ? { line } : {}),
    });
  };

  private readonly onExceptionThrown = (params: Record<string, unknown>): void => {
    if (!this._feeds.errors) return;
    const detailsRaw = params['exceptionDetails'];
    if (typeof detailsRaw !== 'object' || detailsRaw === null) return;
    const details = detailsRaw as Record<string, unknown>;
    const exceptionRaw = details['exception'];
    const exception =
      typeof exceptionRaw === 'object' && exceptionRaw !== null
        ? (exceptionRaw as Record<string, unknown>)
        : undefined;
    const name =
      typeof exception?.['className'] === 'string' ? (exception['className'] as string) : 'Error';
    const description =
      typeof exception?.['description'] === 'string'
        ? (exception['description'] as string)
        : undefined;
    const message = truncateText(
      description ??
        (typeof details['text'] === 'string' ? (details['text'] as string) : 'Uncaught exception'),
    );
    const frame = frameInfo(details['stackTrace']);
    const url =
      typeof details['url'] === 'string' && details['url'] ? (details['url'] as string) : frame.url;
    if (!this.admitEmission()) return;
    this.sink.onPageError({
      name,
      message,
      ...(frame.stack !== undefined ? { stack: frame.stack } : {}),
      ...(url !== undefined ? { url } : {}),
    });
  };

  // ── network ───────────────────────────────────────────────────────────

  private readonly onRequestWillBeSent = (params: Record<string, unknown>): void => {
    if (!this._feeds.network) return;
    const requestId =
      typeof params['requestId'] === 'string' ? (params['requestId'] as string) : undefined;
    const requestRaw = params['request'];
    if (!requestId || typeof requestRaw !== 'object' || requestRaw === null) return;
    const request = requestRaw as Record<string, unknown>;
    const method = typeof request['method'] === 'string' ? (request['method'] as string) : 'GET';
    const url = typeof request['url'] === 'string' ? (request['url'] as string) : '';
    const resourceType = typeof params['type'] === 'string' ? (params['type'] as string) : 'Other';
    const wallTimeSec =
      typeof params['wallTime'] === 'number' ? (params['wallTime'] as number) : undefined;
    const startedAt =
      wallTimeSec !== undefined ? Math.round(wallTimeSec * 1000) : this.clock.wallNow();
    const startTimestamp =
      typeof params['timestamp'] === 'number' ? (params['timestamp'] as number) : undefined;
    const postData = request['postData'];
    if (typeof postData === 'string') {
      this.networkWindow.bytesOut += new TextEncoder().encode(postData).length;
    }

    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      const oldestKey = this.pendingRequests.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.pendingRequests.get(oldestKey);
        if (oldest?.fallbackTimer) this.clock.clearTimer(oldest.fallbackTimer);
        this.pendingRequests.delete(oldestKey);
      }
    }
    this.pendingRequests.set(requestId, {
      method,
      url,
      resourceType,
      status: null,
      fromCache: false,
      startedAt,
      fallbackTimer: null,
      ...(startTimestamp !== undefined ? { startTimestamp } : {}),
    });
  };

  private readonly onResponseReceived = (params: Record<string, unknown>): void => {
    if (!this._feeds.network) return;
    const requestId =
      typeof params['requestId'] === 'string' ? (params['requestId'] as string) : undefined;
    if (!requestId) return;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    const responseRaw = params['response'];
    if (typeof responseRaw !== 'object' || responseRaw === null) return;
    const response = responseRaw as Record<string, unknown>;
    pending.status = typeof response['status'] === 'number' ? (response['status'] as number) : null;
    pending.fromCache =
      Boolean(response['fromDiskCache']) ||
      Boolean(response['fromServiceWorker']) ||
      Boolean(response['fromPrefetchCache']);
    // See RESPONSE_FALLBACK_MS's doc: real Chrome does not reliably send
    // Network.loadingFinished for a fetch() whose response body the page
    // never reads, so a response having arrived is armed here as a
    // fallback completion in case neither terminal event ever follows.
    // Guarded so a redelivered responseReceived (not expected, but the
    // rest of this class treats CDP payloads as untrusted) never arms a
    // second timer for the same request.
    if (!pending.fallbackTimer) {
      pending.fallbackTimer = this.clock.setTimer(
        () => this.completeFromResponseFallback(requestId),
        RESPONSE_FALLBACK_MS,
      );
    }
  };

  private readonly onLoadingFinished = (params: Record<string, unknown>): void => {
    if (!this._feeds.network) return;
    const requestId =
      typeof params['requestId'] === 'string' ? (params['requestId'] as string) : undefined;
    if (!requestId) return;
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    if (!pending) return;
    if (pending.fallbackTimer) this.clock.clearTimer(pending.fallbackTimer);
    const timestamp =
      typeof params['timestamp'] === 'number' ? (params['timestamp'] as number) : undefined;
    const encodedBytes =
      typeof params['encodedDataLength'] === 'number'
        ? (params['encodedDataLength'] as number)
        : null;
    const durationMs = this.durationFrom(pending.startTimestamp, timestamp);
    this.completeNetworkRequest(
      {
        requestId,
        method: pending.method,
        url: pending.url,
        resourceType: pending.resourceType,
        status: pending.status,
        errorText: null,
        fromCache: pending.fromCache,
        durationMs,
        encodedBytes,
        startedAt: pending.startedAt,
      },
      false,
    );
    this.flushIfNowIdle();
  };

  private readonly onLoadingFailed = (params: Record<string, unknown>): void => {
    if (!this._feeds.network) return;
    const requestId =
      typeof params['requestId'] === 'string' ? (params['requestId'] as string) : undefined;
    if (!requestId) return;
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    // Unlike the pre-fallback version of this method, a missing `pending`
    // is now a plain no-op rather than a degraded emission built from
    // empty strings. Once `onResponseReceived` can also complete a request
    // (via the fallback timer), a `pending` entry can legitimately already
    // be gone by the time `loadingFailed` arrives for it (a response that
    // started, then the connection dropped mid-transfer); re-emitting it
    // here with a blank url and method would be a second, worse row for
    // the same request rather than new information. A `loadingFailed` for
    // a request that never got a response at all (the ordinary case this
    // handler exists for: DNS failure, connection refused) still has its
    // `pending` entry, untouched, so that path is unaffected.
    if (!pending) return;
    if (pending.fallbackTimer) this.clock.clearTimer(pending.fallbackTimer);
    const timestamp =
      typeof params['timestamp'] === 'number' ? (params['timestamp'] as number) : undefined;
    const errorText =
      typeof params['errorText'] === 'string'
        ? (params['errorText'] as string)
        : 'unknown network error';
    const durationMs = this.durationFrom(pending.startTimestamp, timestamp);
    this.completeNetworkRequest(
      {
        requestId,
        method: pending.method,
        url: pending.url,
        resourceType: pending.resourceType,
        status: pending.status,
        errorText,
        fromCache: pending.fromCache,
        durationMs,
        encodedBytes: null,
        startedAt: pending.startedAt,
      },
      true,
    );
    this.flushIfNowIdle();
  };

  /**
   * Completes a pending request purely from what `Network.responseReceived`
   * already told this collector, when neither `Network.loadingFinished` nor
   * `Network.loadingFailed` showed up within `RESPONSE_FALLBACK_MS` of it.
   * See that constant's doc for why real Chrome leaves such a request
   * pending forever otherwise. `durationMs`/`encodedBytes` are `null`
   * rather than approximated from the response's own headers-only
   * `encodedDataLength`, because that figure undercounts a body
   * `Network.dataReceived` has already told this collector arrived; a
   * viewer is better served by an honest "unknown" than a number that
   * looks precise and is not.
   */
  private completeFromResponseFallback(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return; // completed (or evicted) by something else first
    this.pendingRequests.delete(requestId);
    this.completeNetworkRequest(
      {
        requestId,
        method: pending.method,
        url: pending.url,
        resourceType: pending.resourceType,
        status: pending.status,
        errorText: null,
        fromCache: pending.fromCache,
        durationMs: null,
        encodedBytes: null,
        startedAt: pending.startedAt,
      },
      false,
    );
    this.flushIfNowIdle();
  }

  private durationFrom(
    startTimestamp: number | undefined,
    endTimestamp: number | undefined,
  ): number | null {
    if (startTimestamp === undefined || endTimestamp === undefined) return null;
    return Math.max(0, Math.round((endTimestamp - startTimestamp) * 1000));
  }

  /** Records one terminal (finished or failed) request into the running summary window, then emits the per-request row through the shared emission budget. Summary totals are NOT gated by that budget: a dropped `network.request` row must not also corrupt the rollup, which is exactly the figure a viewer falls back to when individual rows are being dropped. */
  private completeNetworkRequest(entry: NetworkRequestEntryPayload, failed: boolean): void {
    this.networkWindow.requests += 1;
    if (failed) this.networkWindow.failed += 1;
    if (entry.encodedBytes !== null) this.networkWindow.bytesIn += entry.encodedBytes;
    if (entry.durationMs !== null) {
      this.networkWindow.slowest.push({
        url: entry.url,
        ms: entry.durationMs,
        status: entry.status ?? 0,
      });
      this.networkWindow.slowest.sort((a, b) => b.ms - a.ms);
      if (this.networkWindow.slowest.length > SLOWEST_CAP)
        this.networkWindow.slowest.length = SLOWEST_CAP;
    }
    if (this.admitEmission()) {
      this.sink.onNetworkRequest({ ...entry, url: truncateText(entry.url) });
    }
  }

  // ── subscription ─────────────────────────────────────────────────────

  /**
   * Subscribes every CDP event this collector ever needs, scoped to the
   * current `this.sessionId`, unconditionally: subscribing is free (no CDP
   * round trip, just local JS event wiring) and each handler independently
   * checks `this._feeds` before doing any work, so a domain never being
   * enabled simply means Chrome never sends it that event in the first
   * place. Called once from the constructor and again from `rebind()`
   * after the session changes.
   */
  private subscribeListeners(): void {
    const boundSessionId = this.sessionId;
    const guard =
      <T extends (params: Record<string, unknown>) => void>(fn: T) =>
      (params: Record<string, unknown>): void => {
        // See the module doc: a handler still in flight from before a
        // `rebind()` moved past this session must not touch state that by
        // now belongs to a different session.
        if (boundSessionId !== this.sessionId) return;
        try {
          fn(params);
        } catch {
          // A malformed CDP payload must never throw into the bridge's
          // synchronous event dispatch loop.
        }
      };

    this.unsubs = [
      this.bridge.on('Runtime.consoleAPICalled', guard(this.onConsoleApiCalled), boundSessionId),
      this.bridge.on('Log.entryAdded', guard(this.onLogEntryAdded), boundSessionId),
      this.bridge.on('Runtime.exceptionThrown', guard(this.onExceptionThrown), boundSessionId),
      this.bridge.on('Network.requestWillBeSent', guard(this.onRequestWillBeSent), boundSessionId),
      this.bridge.on('Network.responseReceived', guard(this.onResponseReceived), boundSessionId),
      this.bridge.on('Network.loadingFinished', guard(this.onLoadingFinished), boundSessionId),
      this.bridge.on('Network.loadingFailed', guard(this.onLoadingFailed), boundSessionId),
    ];
  }
}
