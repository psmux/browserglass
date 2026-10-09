import type { Envelope } from '../envelope.js';

/**
 * S to C: a `console.*` call from the remote page, sourced from both
 * `Runtime.consoleAPICalled` (the `console.*` call itself) and
 * `Log.entryAdded` (browser level messages: network failures, CSP
 * violations, deprecations). Off unless the viewer holds `devtools` and has
 * subscribed the target via `diagnostics.subscribe`. Coalesced: identical
 * `(level, text)` within a 1s window arrives once with `count`.
 */
export interface ConsoleEntry extends Envelope {
  t: 'console.entry';
  targetId: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** UNTRUSTED. */
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
  /** Coalesced duplicate count. */
  count?: number;
}

/** S to C: an uncaught page error, sourced from `Runtime.exceptionThrown`. Gated the same way as {@link ConsoleEntry}. */
export interface PageError extends Envelope {
  t: 'page.error';
  targetId: string;
  name: string;
  message: string;
  stack?: string;
  url?: string;
}

/** S to C: a periodic network activity summary. Gated the same way as {@link ConsoleEntry}; sent only when the `network` feed is on. */
export interface NetworkSummary extends Envelope {
  t: 'network.summary';
  targetId: string;
  windowMs: number;
  requests: number;
  failed: number;
  bytesIn: number;
  bytesOut: number;
  /** `url` is UNTRUSTED. */
  slowest: Array<{ url: string; ms: number; status: number }>;
  /**
   * How many requests were still in flight when this summary was taken.
   *
   * A GAUGE, unlike every other counter here, which are totals for the
   * window. This is the one field that answers "is the page busy right
   * now", and it is what `AutomationClient.waitForNetworkIdle()` reads.
   * Without it that question was unanswerable from the wire: every other
   * `network` signal fires on a TERMINAL outcome (finished, failed, or
   * the response fallback), so a caller could see what had ended and
   * never what had started.
   *
   * Optional because a summary from an older server does not carry it,
   * and a consumer must be able to tell "zero in flight" from "this
   * server does not report it" rather than reading an absent field as
   * idle. `waitForNetworkIdle` treats the absence as unknown and times
   * out honestly instead of resolving on a fact it was never told.
   */
  inFlight?: number;
}

/** C to S: request a signed DevTools frontend URL for a Target. Typed only, not wired yet: a separate feature (its own auth surface) from `diagnostics.subscribe`. */
export interface DevtoolsOpen extends Envelope {
  t: 'devtools.open';
  targetId: string;
}

/** S to C: reply to `devtools.open`. Typed only, not wired yet. */
export interface DevtoolsUrl extends Envelope {
  t: 'devtools.url';
  targetId: string;
  url: string;
  expiresAt: number;
}

/**
 * C to S: start diagnostics for one target. Requires `devtools`. Opt in per
 * target (not per connection, not a connection wide default) so a wall of
 * panes does not each pay for `Network.enable` unless a viewer actually
 * asked to watch that one.
 *
 * `console`/`errors` need `Runtime.enable` server side
 * (`packages/core/src/diagnostics/target-diagnostics.ts`'s `applyFeeds`),
 * which is the exact CDP domain-enable pattern `hit-test.ts`'s module doc
 * measures as an automation fingerprint (five plain `Runtime.evaluate`
 * calls produced zero `Runtime.executionContextCreated`/`consoleAPICalled`
 * events; one `Runtime.enable` produced one context-created event and
 * roughly 1500 console events in under two seconds). `network` alone does
 * not: it is served entirely by the `Network` domain, independent of
 * `Runtime` (`applyFeeds`'s `needNetwork` is never combined with
 * `needRuntime`). So a caller asking only for `network` on a
 * stealth-launched instance needs no acknowledgement at all; only
 * `console`/`errors` do.
 */
export interface DiagnosticsSubscribe extends Envelope {
  t: 'diagnostics.subscribe';
  targetId: string;
  /** Which feeds to turn on. Default: console and errors, NOT network. */
  console?: boolean;
  errors?: boolean;
  network?: boolean;
  /**
   * Required `true` when this request asks for `console` and/or `errors`
   * (either explicitly or by default) AND the instance was launched with a
   * stealth level active (`BrowserSpec.stealth !== 'off'`). Omitted or
   * `false` in that situation is refused with
   * `bgls.error.diagnostics.stealth_conflict`, naming the conflict: turning
   * `Runtime` on reintroduces the exact fingerprint the launch's stealth
   * level was chosen to avoid, and a caller must say so on purpose rather
   * than have it happen as a side effect of debugging a page. Never
   * required, and always ignored, for `network`-only requests or for a
   * non-stealth instance.
   */
  acknowledgeStealthRisk?: boolean;
}

/** C to S: stop diagnostics for one target. */
export interface DiagnosticsUnsubscribe extends Envelope {
  t: 'diagnostics.unsubscribe';
  targetId: string;
}

/** S to C: reply to `diagnostics.subscribe`, echoing what is actually on (may differ from the request if a feed could not be enabled). */
export interface DiagnosticsSubscribed extends Envelope {
  t: 'diagnostics.subscribed';
  targetId: string;
  console: boolean;
  errors: boolean;
  network: boolean;
  /**
   * Whether the `Runtime` domain is enabled on this target's CURRENT CDP
   * session right now, after this call resolved: the one CDP-visible side
   * effect `console`/`errors` cost this target (see `DiagnosticsSubscribe`'s
   * own doc). Independent of `console`/`errors` above by construction, not
   * merely in practice: those two report what THIS subscribe request asked
   * for and got, while this reports the domain's actual state, which can
   * already have been `true` before this call (another viewer's earlier
   * subscribe) or stay `true` after this call turns `console`/`errors` off
   * for THIS viewer alone (a third viewer's own subscription still needs
   * it; `ManagedSession.unionFeeds` keeps `Runtime` on for as long as any
   * subscriber does).
   */
  fingerprintActive: boolean;
}

/**
 * C to S: reads whether `targetId`'s automation fingerprint is present
 * RIGHT NOW, without subscribing to anything and without any side effect.
 * The one way to answer "is this target quiet or loud" before deciding
 * whether to pay the cost of finding out (`diagnostics.subscribe` itself
 * turns `Runtime` on if it was off). Requires `devtools`, the same
 * capability every other diagnostics door in this file needs: knowing
 * whether a target is CDP-fingerprintable is itself DevTools-grade
 * information about the browser's own detectability, not merely about the
 * page's content.
 */
export interface DiagnosticsStatusGet extends Envelope {
  t: 'diagnostics.status.get';
  targetId: string;
}

/** S to C: reply to `diagnostics.status.get`. */
export interface DiagnosticsStatusGot extends Envelope {
  t: 'diagnostics.status.got';
  targetId: string;
  /** See {@link DiagnosticsSubscribed.fingerprintActive}; identical meaning, read without subscribing. */
  fingerprintActive: boolean;
}

/**
 * S to C: one network request that completed or failed, sourced from
 * `Network.requestWillBeSent` through `Network.loadingFinished` or
 * `Network.loadingFailed`. `url` is UNTRUSTED. Gated the same way as
 * {@link ConsoleEntry}; sent only when the `network` feed is on. This is
 * the per request detail {@link NetworkSummary} deliberately does not
 * carry ("network tab info" needs method/url/status/type/timing/size, not
 * just a rollup).
 */
export interface NetworkRequestEntry extends Envelope {
  t: 'network.request';
  targetId: string;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  /** Non-null when the request failed rather than returning a status. */
  errorText: string | null;
  fromCache: boolean;
  /** Wall ms from request to response end, null while still in flight. */
  durationMs: number | null;
  encodedBytes: number | null;
  startedAt: number;
}
