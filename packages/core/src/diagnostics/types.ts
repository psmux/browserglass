/**
 * The core-level (pre-wire) shapes `TargetDiagnostics` produces. These are
 * deliberately not the `@browserglass/protocol` wire messages themselves:
 * this package has no dependency on `targetId`/`Envelope` framing (a
 * `TargetDiagnostics` is already scoped to one target by construction), and
 * turning a payload into a `console.entry`/`page.error`/`network.request`/
 * `network.summary` envelope, including running `text`/`url`/`message`
 * through `packages/server/src/wire/sanitize.ts`, is `ManagedSession`'s job.
 */

/** Which CDP-backed feeds a `TargetDiagnostics` collector has (or should have) turned on. */
export interface DiagnosticsFeeds {
  console: boolean;
  errors: boolean;
  network: boolean;
}

/** One coalesced `console.*`/browser-level log line. `count` is always present (1 when never coalesced). */
export interface ConsolePayload {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** UNTRUSTED page content: not sanitized here, see the module doc. */
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
  count: number;
}

/** One uncaught page exception. */
export interface PageErrorPayload {
  name: string;
  /** UNTRUSTED page content: not sanitized here, see the module doc. */
  message: string;
  stack?: string;
  url?: string;
}

/** One network request that reached a terminal state (finished or failed). */
export interface NetworkRequestEntryPayload {
  requestId: string;
  method: string;
  /** UNTRUSTED page content: not sanitized here, see the module doc. */
  url: string;
  resourceType: string;
  status: number | null;
  /** Non-null when the request failed rather than returning a status. */
  errorText: string | null;
  fromCache: boolean;
  /** Wall ms from request to response end, null while still in flight (never emitted in that state; see `TargetDiagnostics`'s module doc). */
  durationMs: number | null;
  encodedBytes: number | null;
  startedAt: number;
}

/** A periodic network activity rollup, emitted once per summary window regardless of how many individual `NetworkRequestEntryPayload`s were emitted or dropped. */
export interface NetworkSummaryPayload {
  windowMs: number;
  requests: number;
  failed: number;
  bytesIn: number;
  /** Best-effort estimate from request body sizes seen on the wire; CDP exposes no cheap exact figure for bytes actually sent (headers included) without extra round trips this collector does not make. */
  bytesOut: number;
  slowest: Array<{ url: string; ms: number; status: number }>;
  /**
   * Requests that have been seen via `Network.requestWillBeSent` but have
   * not yet reached a terminal event (`Network.loadingFinished`/
   * `loadingFailed`, or `TargetDiagnostics`'s own `RESPONSE_FALLBACK_MS`
   * fallback), read live from `pendingRequests.size` at the moment this
   * summary is built. This is the one field on this payload that is a
   * GAUGE rather than a rollup: `requests`/`failed`/`bytesIn`/`bytesOut`
   * above all describe what happened during the just-closed window and
   * reset to zero at the start of the next one, but `inFlight` describes
   * "right now", which is exactly what a caller asking "is the network
   * idle" needs and what a windowed count could not answer (a request
   * that has been outstanding across several windows must keep counting
   * every time, not just in the window it started in). Inherits
   * `pendingRequests`'s own `MAX_PENDING_REQUESTS` (200) bound: past that
   * many concurrently outstanding requests this undercounts rather than
   * tracking without bound, for the same reason `target-diagnostics.ts`'s
   * module doc gives for the bound itself.
   */
  inFlight: number;
}

/** Where a `TargetDiagnostics` collector delivers everything it observes. One `TargetDiagnostics` per target; the sink is expected to already know which target it is looking at. */
export interface DiagnosticsSink {
  onConsole(e: ConsolePayload): void;
  onPageError(e: PageErrorPayload): void;
  onNetworkRequest(e: NetworkRequestEntryPayload): void;
  onNetworkSummary(e: NetworkSummaryPayload): void;
}
