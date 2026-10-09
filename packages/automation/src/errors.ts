import type { ErrorMsg } from '@browserglass/protocol';

/**
 * The automation error taxonomy, widened by three codes beyond the core
 * set: `NOT_IMPLEMENTED` (every stubbed method throws it, naming
 * what it needs), `PROTOCOL_ERROR`
 * (the fallback for a wire `bgls.error.*` code with no closer match in
 * this taxonomy), and `INVALID_ARGUMENT` (a `BrowserSwarm` call given a
 * value that is wrong on its face, e.g. `size: 0` or `shrink()` asked for
 * more members than the swarm holds, rather than something the server
 * ever gets a chance to refuse). This extension follows the same
 * non-breaking-addition pattern the wire error registry uses.
 */
export type AutomationErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'NOT_VISIBLE'
  | 'OCCLUDED'
  | 'NOT_STABLE'
  | 'DISABLED'
  | 'DETACHED'
  | 'FRAME_DETACHED'
  | 'TARGET_CLOSED'
  | 'NAVIGATION_ABORTED'
  | 'TIMEOUT'
  | 'LEASE_NOT_HELD'
  | 'LEASE_REVOKED'
  | 'BUDGET_EXHAUSTED'
  | 'CONFIRM_DENIED'
  | 'POLICY_DENIED'
  | 'DRY_RUN'
  | 'INSTANCE_GONE'
  | 'NOT_IMPLEMENTED'
  | 'PROTOCOL_ERROR'
  | 'INVALID_ARGUMENT';

/**
 * Maps a wire `bgls.error.*` code to the closest {@link AutomationErrorCode}.
 * Codes with no obvious automation-taxonomy equivalent (rate limits, size
 * limits, malformed input) fall through to `PROTOCOL_ERROR`, never to
 * `undefined`: an unmapped wire error must still surface as something a
 * caller can branch on, following the protocol's "unmapped codes fall through to a
 * documented default" pattern (`bgls.error.internal`'s own resolution
 * function in `@browserglass/protocol`).
 */
const WIRE_ERROR_MAP: Readonly<Record<string, AutomationErrorCode>> = Object.freeze({
  'bgls.error.target.not_found': 'TARGET_CLOSED',
  'bgls.error.target.limit': 'POLICY_DENIED',
  'bgls.error.target.last_target': 'POLICY_DENIED',
  'bgls.error.control.not_held': 'LEASE_NOT_HELD',
  'bgls.error.control.lease_stale': 'LEASE_REVOKED',
  'bgls.error.control.queue_full': 'POLICY_DENIED',
  'bgls.error.control.shared_not_allowed': 'POLICY_DENIED',
  'bgls.error.input.gen_stale': 'NOT_STABLE',
  'bgls.error.input.malformed': 'PROTOCOL_ERROR',
  'bgls.error.nav.blocked': 'NAVIGATION_ABORTED',
  'bgls.error.nav.invalid_url': 'NAVIGATION_ABORTED',
  'bgls.error.nav.no_history': 'NAVIGATION_ABORTED',
  'bgls.error.capture.no_match': 'NOT_FOUND',
  'bgls.error.capture.too_large': 'POLICY_DENIED',
  'bgls.error.capture.failed': 'PROTOCOL_ERROR',
  // Page evaluation. Note what is ABSENT: there is no entry for "the page
  // threw", because a page-side exception is not a wire error at all. It
  // arrives as `page.evaluated` with `ok: false`, and `AutomationClient`'s
  // own evaluate path turns it into a `PROTOCOL_ERROR` carrying the page's
  // own message and stack plus `details.pageException`. These four are the
  // cases where the evaluation never ran to completion.
  'bgls.error.evaluate.timeout': 'TIMEOUT',
  'bgls.error.evaluate.result_too_large': 'POLICY_DENIED',
  'bgls.error.evaluate.invalid_request': 'INVALID_ARGUMENT',
  'bgls.error.evaluate.failed': 'PROTOCOL_ERROR',
  // The response-body join. `unknown_request` is the scoping refusal
  // (a requestId this client was never actually shown, whether guessed or
  // stale), which reads as a policy refusal for the same reason
  // `cap.missing` does. `unavailable` is `NOT_FOUND`: CDP's own "no
  // resource with given identifier found" for a body Chrome no longer has
  // buffered, the closest existing taxonomy entry to "the thing you asked
  // for is not there any more" (`capture.no_match` uses the same code for
  // the same shape of absence). `too_large` mirrors `evaluate.result_too_large`.
  'bgls.error.responsebody.invalid_request': 'INVALID_ARGUMENT',
  'bgls.error.responsebody.unknown_request': 'POLICY_DENIED',
  'bgls.error.responsebody.unavailable': 'NOT_FOUND',
  'bgls.error.responsebody.too_large': 'POLICY_DENIED',
  'bgls.error.responsebody.timeout': 'TIMEOUT',
  'bgls.error.responsebody.failed': 'PROTOCOL_ERROR',
  // The accessibility tree door. `timeout` and `failed` mirror `evaluate`'s
  // own two transport-failure codes exactly (the CDP command itself did
  // not complete); `invalid_request` mirrors `evaluate.invalid_request`
  // for the same reason (a malformed request, not a mismatch). There is no
  // "too large" entry here: `a11y()` reports an over-cap reply as
  // `truncated: true`, not as a refusal; see `@browserglass/protocol`'s
  // `wire/messages/a11y.ts`.
  'bgls.error.a11y.timeout': 'TIMEOUT',
  'bgls.error.a11y.invalid_request': 'INVALID_ARGUMENT',
  'bgls.error.a11y.failed': 'PROTOCOL_ERROR',
  // The page map door. `timeout`/`failed`/`invalid_request` mirror `a11y`'s
  // own three exactly, for the same reasons. `stale_epoch` is
  // `page.map.stamp`'s own refusal (`@browserglass/protocol`'s
  // `wire/messages/pagemap.ts`, "The epoch"): the caller's `epoch` no
  // longer matches the target's current capture, so the write was refused
  // before any `DOM.setAttributeValue` went out. There is no taxonomy code
  // for "your identity token is stale, try again with a fresh one", so
  // this falls to `PROTOCOL_ERROR` explicitly rather than by omission: a
  // caller catching it should re-capture with `pageMap()` and re-stamp
  // against the new epoch, never retry the same stamp call unchanged.
  'bgls.error.pagemap.timeout': 'TIMEOUT',
  'bgls.error.pagemap.invalid_request': 'INVALID_ARGUMENT',
  'bgls.error.pagemap.failed': 'PROTOCOL_ERROR',
  'bgls.error.pagemap.stale_epoch': 'PROTOCOL_ERROR',
  'bgls.error.probe.no_element': 'NOT_FOUND',
  'bgls.error.probe.detail_unavailable': 'PROTOCOL_ERROR',
  'bgls.error.instance.not_found': 'INSTANCE_GONE',
  'bgls.error.instance.unrecoverable': 'INSTANCE_GONE',
  'bgls.error.instance.recovering': 'PROTOCOL_ERROR',
  'bgls.error.instance.restart_busy': 'POLICY_DENIED',
  'bgls.error.cap.missing': 'POLICY_DENIED',
  'bgls.error.limit.rate': 'POLICY_DENIED',
  'bgls.error.limit.size': 'POLICY_DENIED',
  'bgls.error.limit.value': 'PROTOCOL_ERROR',
  // The recording door (`recording.start`/`.stop`/`.list`,
  // `@browserglass/server`'s `ws/connection.ts` `recordingErrorReply()`).
  // `recording_unavailable` is the operator's own choice, not a
  // capability problem: this gateway was started with no recordings
  // directory configured at all (`ManagedSession.startRecording()`'s own
  // `E_RECORDING_UNAVAILABLE`), which is a policy fact about this
  // deployment, the same shape `cap.missing` already reports for a token
  // policy fact, so it maps to the same code. `recording_not_found` is a
  // named resource that is not there, the same shape `capture.no_match`
  // and `probe.no_element` already use.
  'bgls.error.target.recording_unavailable': 'POLICY_DENIED',
  'bgls.error.target.recording_not_found': 'NOT_FOUND',
});

/**
 * Thrown by every {@link AutomationClient} method that can fail. Carries
 * the taxonomy code, a human-readable message, and an optional
 * `details` bag: `LEASE_REVOKED` uses it for `lastCompletedStep` and
 * `partial`; `NOT_IMPLEMENTED` uses it to name what the stub needs;
 * `POLICY_DENIED` uses it for `retryAfterMs` on the requeue-backoff
 * refusal.
 */
export class AutomationError extends Error {
  readonly code: AutomationErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: AutomationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.details = details;
  }

  /** Wraps a server `error` message as an {@link AutomationError}, mapping its wire code through {@link WIRE_ERROR_MAP}. */
  static fromErrorMsg(msg: ErrorMsg): AutomationError {
    const code = WIRE_ERROR_MAP[msg.code] ?? 'PROTOCOL_ERROR';
    return new AutomationError(code, msg.message, {
      wireCode: msg.code,
      category: msg.category,
      ...(msg.context !== undefined ? { context: msg.context } : {}),
    });
  }

  /** Convenience constructor for a stubbed method: names what it needs. */
  static notImplemented(method: string, needs: string): AutomationError {
    return new AutomationError(
      'NOT_IMPLEMENTED',
      `${method}() is not implemented in this build: it needs ${needs}`,
      { method, needs },
    );
  }
}
