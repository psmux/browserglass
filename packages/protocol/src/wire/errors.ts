import type { Envelope } from './envelope.js';

/**
 * The top-level category segment of every `bgls.error.<category>.<name>`
 * wire code. Every category {@link ERROR_REGISTRY} uses appears here.
 */
export type ErrorCategory =
  | 'auth'
  | 'cap'
  | 'protocol'
  | 'version'
  | 'target'
  | 'stream'
  | 'control'
  | 'input'
  | 'nav'
  | 'clipboard'
  | 'upload'
  | 'download'
  | 'dialog'
  | 'audit'
  | 'capture'
  | 'probe'
  // Page evaluation (`./messages/evaluate.ts`). Its own category rather
  // than folded into `protocol` or `internal`: a caller needs to branch on
  // "the page could not run this" separately from "the wire is broken",
  // and an operator reading an error stream needs evaluation failures to
  // be countable on their own, since this is the highest privilege surface
  // the protocol has.
  | 'evaluate'
  // The response-body join (`./messages/response-body.ts`). Its own
  // category rather than folded into `evaluate` or `target`: a caller
  // needs to branch on "this specific requestId was never shown to me" or
  // "the body is gone" separately from "the page threw" or "the target
  // closed", and an operator reading an error stream needs a body read to
  // be countable on its own, the same reasoning `evaluate` above already
  // gives for itself.
  | 'responsebody'
  // `./messages/a11y.ts`. Its own category for the same reason `evaluate`
  // and `responsebody` each get one: a caller needs to branch on "the
  // accessibility read itself did not complete" separately from every
  // other failure family, and an operator reading an error stream needs
  // it countable on its own.
  | 'a11y'
  // `./messages/diagnostics.ts`'s `diagnostics.subscribe`/`diagnostics.status.get`.
  // Its own category rather than folded into `target`: a caller needs to
  // branch on "this diagnostics request conflicts with the instance's
  // stealth level" separately from every other target-shaped failure, and
  // an operator reading an error stream needs a stealth conflict to be
  // countable on its own, the same reasoning `evaluate`/`responsebody`/`a11y`
  // each give for themselves above.
  | 'diagnostics'
  // `./messages/pagemap.ts`'s `page.map.get`/`page.map.stamp`. Its own
  // category rather than folded into `a11y`: a page map is a bigger sibling
  // of the accessibility read (same `devtools` gate, same "truncation is
  // data" house style) but it fails in a way `a11y` never does, an index
  // minted from one capture going stale against a navigated document
  // (see "What an index and an epoch mean" in `docs/page-map.md`), and a caller needs to branch on
  // that specifically. An operator reading an error stream needs page map
  // failures countable on their own too, the same reasoning every other
  // per-feature category above gives for itself.
  | 'pagemap'
  | 'instance'
  | 'limit'
  | 'quota'
  | 'routing'
  | 'policy'
  | 'internal';

/**
 * The single canonical `error` message shape, extending {@link Envelope}
 * (so `sq` is optional). There is no separate standalone form with `sq`
 * required.
 */
export interface ErrorMsg extends Envelope {
  t: 'error';
  /** `bgls.error.<category>.<name>`. */
  code: string;
  category: ErrorCategory;
  /** Safe to show a user. */
  message: string;
  /** Developer detail; may name internals. */
  detail?: string;
  /** True means a close follows within 100ms. */
  fatal: boolean;
  retryable: boolean;
  retryAfterMs?: number;
  /** What the DEVELOPER should change. */
  remediation?: string;
  context?: Record<string, unknown>;
}

/** One entry in the {@link ERROR_REGISTRY}: the static defaults for a `bgls.error.*` code. */
export interface ErrorRegistryEntry {
  code: string;
  category: ErrorCategory;
  /** Default `fatal` value; callers may override at emit time when context demands it. */
  fatal: boolean;
  /** Default `retryable` value. */
  retryable: boolean;
  remediation: string;
}

function entry(
  code: string,
  category: ErrorCategory,
  fatal: boolean,
  retryable: boolean,
  remediation: string,
): ErrorRegistryEntry {
  return Object.freeze({ code, category, fatal, retryable, remediation });
}

/**
 * The full `bgls.error.*` registry. `bgls.error.auth.no_credential` is
 * used by the client transport's credential-resolution failure path.
 */
export const ERROR_REGISTRY: Readonly<Record<string, ErrorRegistryEntry>> = Object.freeze({
  'bgls.error.auth.invalid_ticket': entry(
    'bgls.error.auth.invalid_ticket',
    'auth',
    true,
    false,
    'Mint a fresh ticket via tokens.issue before connecting',
  ),
  'bgls.error.auth.ticket_consumed': entry(
    'bgls.error.auth.ticket_consumed',
    'auth',
    true,
    false,
    "Tickets are single use; don't share across sockets or StrictMode double mounts",
  ),
  'bgls.error.auth.ticket_expired': entry(
    'bgls.error.auth.ticket_expired',
    'auth',
    true,
    false,
    'Ticket TTL is 30s by default; issue at connect time, not render time',
  ),
  'bgls.error.auth.origin_mismatch': entry(
    'bgls.error.auth.origin_mismatch',
    'auth',
    true,
    false,
    "Add the page origin to security.allowedOrigins and the ticket's origin binding",
  ),
  'bgls.error.auth.token_invalid': entry(
    'bgls.error.auth.token_invalid',
    'auth',
    true,
    false,
    "Check the signing key and the 'aid' claim",
  ),
  'bgls.error.auth.expiring': entry(
    'bgls.error.auth.expiring',
    'auth',
    false,
    false,
    'Refresh with hello reauth:true. Informational',
  ),
  'bgls.error.auth.expired': entry(
    'bgls.error.auth.expired',
    'auth',
    true,
    false,
    'Same as expiring, too late',
  ),
  'bgls.error.auth.conflicting_credentials': entry(
    'bgls.error.auth.conflicting_credentials',
    'auth',
    true,
    false,
    'Send exactly one of header, ticket, or hello.auth',
  ),
  'bgls.error.auth.tenant_suspended': entry(
    'bgls.error.auth.tenant_suspended',
    'auth',
    true,
    false,
    'Billing or admin action required',
  ),
  'bgls.error.auth.no_credential': entry(
    'bgls.error.auth.no_credential',
    'auth',
    true,
    false,
    "The client's credentials() callback threw or returned no usable credential",
  ),
  'bgls.error.cap.missing': entry(
    'bgls.error.cap.missing',
    'cap',
    false,
    false,
    'Token lacks a capability; context.required names it',
  ),
  'bgls.error.version.unsupported': entry(
    'bgls.error.version.unsupported',
    'version',
    true,
    false,
    'context.serverVersions lists what the server speaks',
  ),
  'bgls.error.protocol.expected_hello': entry(
    'bgls.error.protocol.expected_hello',
    'protocol',
    true,
    false,
    'Send hello first',
  ),
  'bgls.error.protocol.duplicate_hello': entry(
    'bgls.error.protocol.duplicate_hello',
    'protocol',
    true,
    false,
    'Use reauth:true to re-authenticate',
  ),
  'bgls.error.protocol.bad_envelope': entry(
    'bgls.error.protocol.bad_envelope',
    'protocol',
    false,
    false,
    'context.field names the offending field',
  ),
  'bgls.error.protocol.unknown_type': entry(
    'bgls.error.protocol.unknown_type',
    'protocol',
    false,
    false,
    'Informational, debug builds only',
  ),
  'bgls.error.protocol.sq_gap': entry(
    'bgls.error.protocol.sq_gap',
    'protocol',
    true,
    true,
    'Client bug or a proxy dropping messages',
  ),
  'bgls.error.protocol.redundant_resume': entry(
    'bgls.error.protocol.redundant_resume',
    'protocol',
    false,
    false,
    'Resume in hello OR as a standalone message, not both',
  ),
  'bgls.error.target.not_found': entry(
    'bgls.error.target.not_found',
    'target',
    false,
    false,
    'Target closed; call target.list',
  ),
  'bgls.error.target.limit': entry(
    'bgls.error.target.limit',
    'target',
    false,
    false,
    'limits.maxTargets reached',
  ),
  'bgls.error.target.last_target': entry(
    'bgls.error.target.last_target',
    'target',
    false,
    false,
    'Set targets.allowCloseLast',
  ),
  'bgls.error.stream.limit': entry(
    'bgls.error.stream.limit',
    'stream',
    false,
    false,
    'limits.maxStreams reached for this viewer',
  ),
  'bgls.error.stream.not_found': entry(
    'bgls.error.stream.not_found',
    'stream',
    false,
    false,
    'Stale streamId; re-subscribe',
  ),
  'bgls.error.stream.not_streamable': entry(
    'bgls.error.stream.not_streamable',
    'stream',
    false,
    false,
    'This target kind cannot be streamed; check TargetSummary.kind before subscribing',
  ),
  'bgls.error.stream.codec_unsupported': entry(
    'bgls.error.stream.codec_unsupported',
    'stream',
    false,
    false,
    'context.available lists server codecs',
  ),
  'bgls.error.stream.sid_epoch_stale': entry(
    'bgls.error.stream.sid_epoch_stale',
    'stream',
    false,
    true,
    'Recompute coordinates from the latest stream.subscribed',
  ),
  'bgls.error.stream.keyframe_unavailable': entry(
    'bgls.error.stream.keyframe_unavailable',
    'stream',
    false,
    true,
    'Target not painting (modal dialog or hung renderer)',
  ),
  'bgls.error.stream.dropped_slow_consumer': entry(
    'bgls.error.stream.dropped_slow_consumer',
    'stream',
    false,
    true,
    'The consumer fell behind and frames were dropped for it; reduce quality or improve the connection',
  ),
  'bgls.error.control.not_held': entry(
    'bgls.error.control.not_held',
    'control',
    false,
    false,
    'Call control.request, wait for control.granted',
  ),
  'bgls.error.control.lease_stale': entry(
    'bgls.error.control.lease_stale',
    'control',
    false,
    false,
    'leaseId is from a previous grant; use the newest',
  ),
  'bgls.error.control.queue_full': entry(
    'bgls.error.control.queue_full',
    'control',
    false,
    true,
    'limits.maxQueue reached',
  ),
  'bgls.error.control.shared_not_allowed': entry(
    'bgls.error.control.shared_not_allowed',
    'control',
    false,
    false,
    'Enable control.allowShared server side',
  ),
  // `control.yield`'s two preconditions, each named honestly rather than
  // folded into a neighbour. `not_held` was the obvious reach for
  // `not_shared`, and it is a lie about which precondition failed: the
  // sender may well hold control, the target is simply exclusive. Reusing
  // `cap.missing` for `not_human` is the same mistake in the other
  // direction, since an automation client sending a yield genuinely does
  // hold `control` and would be told it lacks a capability it has.
  'bgls.error.control.not_shared': entry(
    'bgls.error.control.not_shared',
    'control',
    false,
    false,
    "control.yield applies to mode:'shared' targets; use control.request on an exclusive target",
  ),
  'bgls.error.control.not_human': entry(
    'bgls.error.control.not_human',
    'control',
    false,
    false,
    'control.yield is a human takeover; automation clients arbitrate by priority',
  ),
  'bgls.error.input.gen_stale': entry(
    'bgls.error.input.gen_stale',
    'input',
    false,
    true,
    'Coordinates were computed against an older target generation',
  ),
  'bgls.error.input.malformed': entry(
    'bgls.error.input.malformed',
    'input',
    false,
    false,
    'fw, fh, gen, and leaseId are required on every input message',
  ),
  // Distinct from `gen_stale`/`malformed`, both of which are the CALLER
  // sending something wrong: this is a well-formed, current, correctly
  // leased input message whose CDP dispatch itself failed or never
  // completed (a session lookup that outran its timeout under load, or a
  // raced dispatch whose underlying send settled with an error after the
  // dispatcher had already moved on). The caller sent the right thing and
  // the browser never got it, which is exactly the case a caller CAN act
  // on (resend the input, or the character it typed), unlike an ordinary
  // `dispatch_error` from unrelated background CDP traffic.
  'bgls.error.input.dispatch_failed': entry(
    'bgls.error.input.dispatch_failed',
    'input',
    false,
    true,
    'The input reached the server but was not confirmed delivered to the page; resend it',
  ),
  'bgls.error.nav.blocked': entry(
    'bgls.error.nav.blocked',
    'nav',
    false,
    false,
    'context.rule names the matched egress rule',
  ),
  'bgls.error.nav.invalid_url': entry(
    'bgls.error.nav.invalid_url',
    'nav',
    false,
    false,
    'Only http, https, and about:blank are allowed by default',
  ),
  'bgls.error.nav.no_history': entry(
    'bgls.error.nav.no_history',
    'nav',
    false,
    false,
    'Check canGoBack before offering the button',
  ),
  'bgls.error.clipboard.empty': entry(
    'bgls.error.clipboard.empty',
    'clipboard',
    false,
    false,
    'Nothing selected in the remote page',
  ),
  'bgls.error.upload.too_large': entry(
    'bgls.error.upload.too_large',
    'upload',
    false,
    false,
    'context.maxBytes; raise limits.maxUploadBytes',
  ),
  'bgls.error.upload.mime_blocked': entry(
    'bgls.error.upload.mime_blocked',
    'upload',
    false,
    false,
    'security.uploadMimeAllowList',
  ),
  'bgls.error.upload.bad_offset': entry(
    'bgls.error.upload.bad_offset',
    'upload',
    false,
    true,
    'Chunk index outside the expected window',
  ),
  'bgls.error.upload.hash_mismatch': entry(
    'bgls.error.upload.hash_mismatch',
    'upload',
    false,
    true,
    'Retransmit; usually a truncated chunk',
  ),
  'bgls.error.upload.not_found': entry(
    'bgls.error.upload.not_found',
    'upload',
    false,
    false,
    'Send upload.begin first, or the upload expired',
  ),
  'bgls.error.upload.scan_failed': entry(
    'bgls.error.upload.scan_failed',
    'upload',
    false,
    false,
    "Scanner rejected the bytes; context.verdict is 'infected' or 'unscannable'",
  ),
  'bgls.error.download.expired': entry(
    'bgls.error.download.expired',
    'download',
    false,
    false,
    'Signed URLs live limits.downloadUrlTtlMs; fetch sooner',
  ),
  'bgls.error.dialog.not_found': entry(
    'bgls.error.dialog.not_found',
    'dialog',
    false,
    false,
    'Already answered or auto-dismissed. Normal under a race',
  ),
  'bgls.error.audit.unavailable': entry(
    'bgls.error.audit.unavailable',
    'audit',
    false,
    true,
    'auditFailClosed tenant, audit sink not accepting. Never internal',
  ),
  'bgls.error.capture.no_match': entry(
    'bgls.error.capture.no_match',
    'capture',
    false,
    false,
    'Selector matched nothing, or the match had no visible box',
  ),
  'bgls.error.capture.too_large': entry(
    'bgls.error.capture.too_large',
    'capture',
    false,
    false,
    'Exceeded limits.maxCaptureBytes',
  ),
  'bgls.error.capture.failed': entry(
    'bgls.error.capture.failed',
    'capture',
    false,
    true,
    'Renderer refused the screenshot, usually an open modal',
  ),
  'bgls.error.probe.no_element': entry(
    'bgls.error.probe.no_element',
    'probe',
    false,
    false,
    "Nothing hit-testable on a 'full' probe",
  ),
  'bgls.error.probe.detail_unavailable': entry(
    'bgls.error.probe.detail_unavailable',
    'probe',
    false,
    false,
    "Target busy (blocked dialog or renderer timeout); retry 'hover'",
  ),
  // ── evaluate (`./messages/evaluate.ts`) ────────────────────────────────
  //
  // A page-side THROW is deliberately absent from this table: it is not an
  // error envelope at all, it comes back as `page.evaluated` with
  // `ok: false` and a structured `exception`. These four codes are the
  // cases where the evaluation itself did not complete, which is a
  // different thing and which a caller must be able to tell apart from the
  // page's own JavaScript failing.
  'bgls.error.evaluate.timeout': entry(
    'bgls.error.evaluate.timeout',
    'evaluate',
    false,
    true,
    'The script did not settle within timeoutMs; V8 has terminated it. Shorten the work, or raise timeoutMs up to MAX_EVALUATE_TIMEOUT_MS',
  ),
  'bgls.error.evaluate.result_too_large': entry(
    'bgls.error.evaluate.result_too_large',
    'evaluate',
    false,
    false,
    'context.sizeBytes exceeded context.maxBytes; narrow the expression to return less (a field, not the whole object)',
  ),
  'bgls.error.evaluate.invalid_request': entry(
    'bgls.error.evaluate.invalid_request',
    'evaluate',
    false,
    false,
    'Send exactly one of expression or functionDeclaration, within MAX_EVALUATE_SOURCE_BYTES, with at most MAX_EVALUATE_ARGS JSON args',
  ),
  'bgls.error.evaluate.failed': entry(
    'bgls.error.evaluate.failed',
    'evaluate',
    false,
    true,
    'The CDP command itself did not complete (renderer hung, session detached mid-call). This is transport, not the script in the page throwing',
  ),
  // ── response body (`./messages/response-body.ts`) ──────────────────────
  //
  // `unknown_request` is the enforcement point for this door's whole
  // scoping argument (see that module's doc, "enforced in the SERVER"): a
  // `requestId` this viewer was never shown, on this target, whether
  // fabricated or simply belonging to another viewer's own subscription.
  'bgls.error.responsebody.invalid_request': entry(
    'bgls.error.responsebody.invalid_request',
    'responsebody',
    false,
    false,
    'targetId and requestId are both required, non-empty strings',
  ),
  'bgls.error.responsebody.unknown_request': entry(
    'bgls.error.responsebody.unknown_request',
    'responsebody',
    false,
    false,
    'This requestId was never sent to you as a network.request on this target. Subscribe with diagnostics.subscribe({ network: true }) and read the requestId off the entry you were actually shown',
  ),
  'bgls.error.responsebody.unavailable': entry(
    'bgls.error.responsebody.unavailable',
    'responsebody',
    false,
    false,
    'Chrome no longer has this body buffered (commonly a navigation since the request finished, or a response with no body to begin with, such as a redirect or a 204). This is not the same as an empty body',
  ),
  'bgls.error.responsebody.too_large': entry(
    'bgls.error.responsebody.too_large',
    'responsebody',
    false,
    false,
    'context.sizeBytes exceeded context.maxBytes (MAX_RESPONSE_BODY_BYTES); there is no way to narrow a response the caller did not shape',
  ),
  'bgls.error.responsebody.timeout': entry(
    'bgls.error.responsebody.timeout',
    'responsebody',
    false,
    true,
    'The CDP command did not complete in time; retry',
  ),
  'bgls.error.responsebody.failed': entry(
    'bgls.error.responsebody.failed',
    'responsebody',
    false,
    true,
    'The CDP command itself did not complete (detached session, closed target)',
  ),
  // ── accessibility (`./messages/a11y.ts`) ────────────────────────────────
  //
  // Note what is ABSENT: there is no "result too large" code, because a
  // reply over the byte ceiling is reported as data (`truncated: true`),
  // not refused; see that module's doc, "bounded, and truncation reported
  // as data".
  'bgls.error.a11y.invalid_request': entry(
    'bgls.error.a11y.invalid_request',
    'a11y',
    false,
    false,
    'targetId is required; maxNodes, when given, must be a positive number at most MAX_A11Y_MAX_NODES',
  ),
  'bgls.error.a11y.timeout': entry(
    'bgls.error.a11y.timeout',
    'a11y',
    false,
    true,
    'Accessibility.queryAXTree did not complete in time; retry, or narrow with role/name',
  ),
  'bgls.error.a11y.failed': entry(
    'bgls.error.a11y.failed',
    'a11y',
    false,
    true,
    'The CDP command itself did not complete (renderer hung, session detached mid-call)',
  ),
  // ── page map (`./messages/pagemap.ts`) ──────────────────────────────────
  //
  // Note what is ABSENT, for the identical reason `a11y` above states it:
  // there is no "result too large" code, because a `page.map.got` over the
  // byte ceiling is reported as data (`truncated: true`), not refused.
  'bgls.error.pagemap.invalid_request': entry(
    'bgls.error.pagemap.invalid_request',
    'pagemap',
    false,
    false,
    'targetId is required; timeoutMs, when given, must be a positive number (clamped to MAX_PAGEMAP_TIMEOUT_MS, never refused); page.map.stamp also requires epoch and a non-empty indices array of at most MAX_PAGEMAP_STAMP_INDICES entries',
  ),
  'bgls.error.pagemap.timeout': entry(
    'bgls.error.pagemap.timeout',
    'pagemap',
    false,
    true,
    'The capture did not complete within timeoutMs; retry, or narrow with include',
  ),
  'bgls.error.pagemap.failed': entry(
    'bgls.error.pagemap.failed',
    'pagemap',
    false,
    true,
    'The CDP command itself did not complete (renderer hung, session detached mid-call)',
  ),
  // A `page.map.stamp` whose `epoch`
  // does not name the most recently captured document for this target.
  // Refused before any CDP command goes out, which is the whole point: an
  // epoch mismatch is caught up front rather than discovered only when the
  // stamped index turns out to name a different element than the caller
  // thinks it does.
  'bgls.error.pagemap.stale_epoch': entry(
    'bgls.error.pagemap.stale_epoch',
    'pagemap',
    false,
    false,
    'Call page.map.get again and stamp against its epoch; the document navigated (or nothing has been captured for this target yet) since the epoch you sent was minted',
  ),
  // `diagnostics.subscribe` asking for `console`/`errors` (either of which
  // needs `Runtime.enable`, see that message's own doc) on an instance
  // launched with `BrowserSpec.stealth !== 'off'`, without
  // `acknowledgeStealthRisk: true`. Deliberately refused rather than
  // silently allowed or silently downgraded: `Runtime.enable` is the exact
  // CDP domain-enable pattern this build's own stealth posture exists to
  // avoid (`packages/core/src/cdp/hit-test.ts`'s module doc measures it
  // directly), so a caller must say, on the wire, that it accepts putting
  // the fingerprint back rather than have a console-logging debug session
  // quietly un-stealth a browser an operator asked to be stealthy.
  // `network`-only requests never trigger this: `Network.enable` is
  // independent of `Runtime` (`target-diagnostics.ts`'s `applyFeeds`).
  'bgls.error.diagnostics.stealth_conflict': entry(
    'bgls.error.diagnostics.stealth_conflict',
    'diagnostics',
    false,
    false,
    'This instance was launched with a stealth level active; console/error diagnostics need Runtime.enable, which reintroduces the CDP automation fingerprint that level exists to avoid. Pass acknowledgeStealthRisk: true on diagnostics.subscribe to proceed anyway, or subscribe with network only (no acknowledgement needed).',
  ),
  'bgls.error.instance.recovering': entry(
    'bgls.error.instance.recovering',
    'instance',
    false,
    true,
    'Wait for instance.recovered. Informational',
  ),
  'bgls.error.instance.restart_busy': entry(
    'bgls.error.instance.restart_busy',
    'instance',
    false,
    true,
    'Recovery or restart already running, or the rate limit has not refilled',
  ),
  'bgls.error.instance.not_found': entry(
    'bgls.error.instance.not_found',
    'instance',
    false,
    false,
    "instanceId on instance.restart is not this session's",
  ),
  'bgls.error.instance.unrecoverable': entry(
    'bgls.error.instance.unrecoverable',
    'instance',
    true,
    false,
    'Every recovery rung failed; acquire a new instance',
  ),
  'bgls.error.limit.rate': entry(
    'bgls.error.limit.rate',
    'limit',
    false,
    true,
    'context.limit, retryAfterMs',
  ),
  'bgls.error.limit.size': entry(
    'bgls.error.limit.size',
    'limit',
    false,
    false,
    'context.maxBytes',
  ),
  'bgls.error.limit.value': entry(
    'bgls.error.limit.value',
    'limit',
    false,
    false,
    'Field out of range; context.field/min/max',
  ),
  'bgls.error.quota.instances': entry(
    'bgls.error.quota.instances',
    'quota',
    true,
    false,
    'Tenant instance quota reached',
  ),
  'bgls.error.quota.storage': entry(
    'bgls.error.quota.storage',
    'quota',
    false,
    false,
    'Profile or upload storage quota reached',
  ),
  'bgls.error.routing.no_capacity': entry(
    'bgls.error.routing.no_capacity',
    'routing',
    true,
    true,
    'Retry after retryAfterMs',
  ),
  'bgls.error.routing.node_lost': entry(
    'bgls.error.routing.node_lost',
    'routing',
    true,
    true,
    'The router will re-place on reconnect',
  ),
  'bgls.error.policy.denied': entry(
    'bgls.error.policy.denied',
    'policy',
    false,
    false,
    'An authorize() veto set e.reason; see context.reason',
  ),
  'bgls.error.internal': entry(
    'bgls.error.internal',
    'internal',
    false,
    true,
    'context.traceId. Never leaks a stack in production',
  ),
});

/** The wire code used when an internal error code has no entry in {@link E_TO_WIRE_ERROR}. */
export const DEFAULT_WIRE_ERROR_CODE = 'bgls.error.internal';

/**
 * Thrown by server-side code using the internal `E_*` vocabulary,
 * distinct from the wire's `bgls.error.*` namespace. Both are kept,
 * because they are different namespaces.
 */
export class BglsError extends Error {
  /** The internal `E_*` code, e.g. `'E_PROFILE_BUSY'`. */
  readonly code: string;
  readonly detail: string | undefined;
  readonly context: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options?: { detail?: string; context?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BglsError';
    this.code = code;
    this.detail = options?.detail;
    this.context = options?.context;
  }
}

/**
 * Maps internal `E_*` throw codes to the `bgls.error.*` wire code a client
 * receives. Covers the session protocol, streaming, and auth codes;
 * packages that introduce further `E_*` codes in their own domain should
 * extend this table. Unmapped codes fall through to
 * {@link DEFAULT_WIRE_ERROR_CODE}.
 */
export const E_TO_WIRE_ERROR: Readonly<Record<string, string>> = Object.freeze({
  E_AUTH_INVALID_TICKET: 'bgls.error.auth.invalid_ticket',
  E_AUTH_TICKET_CONSUMED: 'bgls.error.auth.ticket_consumed',
  E_AUTH_TICKET_EXPIRED: 'bgls.error.auth.ticket_expired',
  E_AUTH_ORIGIN_MISMATCH: 'bgls.error.auth.origin_mismatch',
  E_AUTH_TOKEN_INVALID: 'bgls.error.auth.token_invalid',
  E_AUTH_CONFLICTING_CREDENTIALS: 'bgls.error.auth.conflicting_credentials',
  E_TENANT_SUSPENDED: 'bgls.error.auth.tenant_suspended',
  E_CAP_MISSING: 'bgls.error.cap.missing',
  E_VERSION_UNSUPPORTED: 'bgls.error.version.unsupported',
  E_PROTOCOL_EXPECTED_HELLO: 'bgls.error.protocol.expected_hello',
  E_PROTOCOL_DUPLICATE_HELLO: 'bgls.error.protocol.duplicate_hello',
  E_PROTOCOL_BAD_ENVELOPE: 'bgls.error.protocol.bad_envelope',
  E_PROTOCOL_SQ_GAP: 'bgls.error.protocol.sq_gap',
  E_PROTOCOL_REDUNDANT_RESUME: 'bgls.error.protocol.redundant_resume',
  E_GONE: 'bgls.error.target.not_found',
  E_NOT_FOUND: 'bgls.error.target.not_found',
  E_TARGET_LIMIT: 'bgls.error.target.limit',
  E_TARGET_LAST_TARGET: 'bgls.error.target.last_target',
  E_STREAM_LIMIT: 'bgls.error.stream.limit',
  E_STREAM_NOT_FOUND: 'bgls.error.stream.not_found',
  E_NOT_STREAMABLE: 'bgls.error.stream.not_streamable',
  E_CODEC_UNSUPPORTED: 'bgls.error.stream.codec_unsupported',
  E_CONTROL_NOT_HELD: 'bgls.error.control.not_held',
  E_CONTROL_LEASE_STALE: 'bgls.error.control.lease_stale',
  E_CONTROL_QUEUE_FULL: 'bgls.error.control.queue_full',
  E_INPUT_GEN_STALE: 'bgls.error.input.gen_stale',
  E_INPUT_MALFORMED: 'bgls.error.input.malformed',
  E_INPUT_DISPATCH_FAILED: 'bgls.error.input.dispatch_failed',
  E_NAV_BLOCKED: 'bgls.error.nav.blocked',
  E_NAV_INVALID_URL: 'bgls.error.nav.invalid_url',
  E_CLIPBOARD_EMPTY: 'bgls.error.clipboard.empty',
  E_UPLOAD_TOO_LARGE: 'bgls.error.upload.too_large',
  E_UPLOAD_MIME_BLOCKED: 'bgls.error.upload.mime_blocked',
  E_DOWNLOAD_EXPIRED: 'bgls.error.download.expired',
  E_DIALOG_NOT_FOUND: 'bgls.error.dialog.not_found',
  E_CAPTURE_TOO_LARGE: 'bgls.error.capture.too_large',
  E_CAPTURE_FAILED: 'bgls.error.capture.failed',
  E_PROBE_NO_ELEMENT: 'bgls.error.probe.no_element',
  E_EVALUATE_TIMEOUT: 'bgls.error.evaluate.timeout',
  E_EVALUATE_TOO_LARGE: 'bgls.error.evaluate.result_too_large',
  E_EVALUATE_INVALID: 'bgls.error.evaluate.invalid_request',
  E_EVALUATE_FAILED: 'bgls.error.evaluate.failed',
  E_RESPONSE_BODY_INVALID: 'bgls.error.responsebody.invalid_request',
  E_RESPONSE_BODY_UNKNOWN_REQUEST: 'bgls.error.responsebody.unknown_request',
  E_RESPONSE_BODY_UNAVAILABLE: 'bgls.error.responsebody.unavailable',
  E_RESPONSE_BODY_TOO_LARGE: 'bgls.error.responsebody.too_large',
  E_RESPONSE_BODY_TIMEOUT: 'bgls.error.responsebody.timeout',
  E_RESPONSE_BODY_FAILED: 'bgls.error.responsebody.failed',
  E_DIAGNOSTICS_STEALTH_CONFLICT: 'bgls.error.diagnostics.stealth_conflict',
  E_INSTANCE_NOT_FOUND: 'bgls.error.instance.not_found',
  E_INSTANCE_UNRECOVERABLE: 'bgls.error.instance.unrecoverable',
  E_RATE_LIMIT: 'bgls.error.limit.rate',
  E_QUOTA_INSTANCES: 'bgls.error.quota.instances',
  E_QUOTA_STORAGE: 'bgls.error.quota.storage',
  E_NO_CAPACITY: 'bgls.error.routing.no_capacity',
  E_NODE_LOST: 'bgls.error.routing.node_lost',
  E_POLICY_DENIED: 'bgls.error.policy.denied',
});

/**
 * Resolves the `bgls.error.*` wire code for an internal `E_*` code (or a
 * {@link BglsError} instance), defaulting to
 * {@link DEFAULT_WIRE_ERROR_CODE} for anything unmapped.
 */
export function wireErrorCodeFor(internalCode: string | BglsError): string {
  const code = typeof internalCode === 'string' ? internalCode : internalCode.code;
  return E_TO_WIRE_ERROR[code] ?? DEFAULT_WIRE_ERROR_CODE;
}
