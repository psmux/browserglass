import type { Envelope } from '../envelope.js';

/**
 * `page.responsebody.get` / `page.responsebody.got`: reads the response
 * body Chrome already has buffered for ONE request the caller ALREADY
 * WATCHED HAPPEN on its own `network` diagnostics feed
 * (`diagnostics.subscribe({ network: true })`, `./diagnostics.ts`'s
 * `DiagnosticsSubscribe`).
 *
 * Read this doc before changing anything in this file. The argument is
 * the same one `./evaluate.ts` and `./interception.ts` make, for the same
 * reason: this is a narrow door built beside an existing refusal, not a
 * hole punched in it.
 *
 * ── The gap this closes, named plainly ──────────────────────────────────
 *
 * `Network.getResponseBody` sits on the REST CDP passthrough allowlist
 * (`packages/server/src/rest/cdp-passthrough-allowlist.ts`, its last
 * entry), which reads as though a caller already has a path to a response
 * body. It does not, on its own: `getResponseBody` needs (a) the `Network`
 * domain enabled on the CDP session, and `Network.enable` is NOT in that
 * same allowlist, and (b) a real CDP `requestId`, which nothing reachable
 * over the passthrough ever hands a caller. `Network` is a partially open
 * domain there purely by omission, not by design (see
 * `cdp-passthrough-allowlist.ts`'s own doc on the gap between its stated
 * `Network.setRequestInterception` refusal and what the allowlist actually
 * enforces), and widening it further to admit `Network.enable` was
 * explicitly rejected: `packages/core/src/diagnostics/target-diagnostics.ts`
 * already owns the whole `Network` domain for a target the moment a viewer
 * subscribes to it (that class's own module doc: "this class is therefore
 * the sole owner of `Runtime`, `Log`, and `Network` for a target"), and a
 * second, independent caller enabling the same domain through the raw
 * passthrough would race it.
 *
 * `target-diagnostics.ts` is also the one thing in this build that mints a
 * `requestId` a caller can ever see: every `network.request` payload it
 * emits carries one (`packages/core/src/diagnostics/types.ts`'s
 * `NetworkRequestEntryPayload.requestId`). Those two facts sat on opposite
 * sides of a door nothing had opened: a consumer watching a form
 * submission silently succeed or fail (the motivating case: a single page
 * application's submit whose only visible outcome IS the response body)
 * had no usable path to one at all. This message pair is
 * that join, built as its OWN narrow door. `Network.getResponseBody`'s
 * allowlist entry stays exactly as unusable through the raw passthrough as
 * it always was; `Network.enable` stays off that allowlist; neither is
 * touched by anything below.
 *
 * ── Gated on `devtools`, not `cdp` ───────────────────────────────────────
 *
 * The bound this pair enforces is not "read any response this machine has
 * buffered", it is "read the body of a request you already watched
 * happen on your own feed". A `requestId` reaches a caller in exactly one
 * way: as a field on a `network.request` envelope (`./diagnostics.ts`'s
 * `NetworkRequestEntry`), itself gated on `devtools` plus an active
 * `diagnostics.subscribe({ network: true })` for that target
 * (`ManagedSession.deliverDiagnostics`). A caller with no `devtools` never
 * receives a `requestId` in the first place, so gating THIS pair on
 * `devtools` too, rather than on the much larger `cdp` grant, asks for
 * nothing the caller does not already have a concrete reason to hold.
 * `cdp` would be the wrong capability regardless of how convenient the
 * passthrough's allowlist entry makes it look: `cdp` means "allowlisted
 * raw CDP on this target", and this is not raw CDP at all, so requiring it
 * would force an unrelated grant onto a door that has nothing to do with
 * it.
 *
 * ── The gateway owns `Network`, exactly as it owns `Fetch` for the
 *    request gate ──────────────────────────────────────────────────────
 *
 * A holder of this door never speaks CDP. `Network.enable` is turned on
 * by `TargetDiagnostics` the moment a viewer subscribes with
 * `network: true`, and `Network.getResponseBody` is sent by
 * `ManagedSession` itself, server side, against the CDP session it already
 * resolved for this caller's own `targetId` through the identical
 * `ensureAttached()` / `TargetRegistry` seam `page.evaluate` uses (see
 * `./evaluate.ts`, escalation paths 1 to 4). There is no `sessionId` field
 * on either message here, and `targetId` is a BrowserGlass `tgt_*` id
 * resolved only within the caller's own session registry, so every one of
 * those four escalation paths is closed here for the identical reason it
 * is closed there.
 *
 * ── Enforced in the SERVER, not by convention ────────────────────────────
 *
 * A caller that never subscribed to `network`, or that is simply guessing
 * `requestId` strings, must not get a body back for one: a capability
 * check alone cannot express this bound, because `devtools` says nothing
 * about WHICH requests THIS viewer has actually been shown. `ManagedSession`
 * closes it directly: every `requestId` it ever puts on a `network.request`
 * envelope actually delivered to a given viewer, for a given target, is
 * recorded (bounded; see `ManagedSession.recordSeenNetworkRequestId`'s own
 * doc), and `page.responsebody.get` is refused with
 * `bgls.error.responsebody.unknown_request` for a `(viewerId, targetId,
 * requestId)` triple that was never recorded, BEFORE the server ever sends
 * a `Network.getResponseBody` CDP command. A token that holds `devtools`
 * and is willing to guess `requestId` strings gains nothing from guessing
 * one that happens to be real: the bound is checked against what THIS
 * VIEWER was actually shown, not against what exists in Chrome's buffer.
 *
 * ── The one thing this does NOT widen ────────────────────────────────────
 *
 * `Fetch` stays in `REFUSED_DOMAINS`
 * (`packages/server/src/rest/cdp-passthrough-allowlist.ts`); this feature
 * never touches it. The outbound request gate (`./interception.ts`) stays
 * Request-stage only, so it still cannot see a response body either. This
 * is a third, separate, narrower door beside both: it reads a body ONLY
 * for a request the caller's own diagnostics feed already showed
 * happening, ONLY after it finished, and ONLY as data returned by value,
 * never as a live CDP handle or anything that could be used to reach
 * further than the one buffered string Chrome already had.
 *
 * ── Bodies are not durable, and the error says so ────────────────────────
 *
 * `Network.getResponseBody`'s answer lives only as long as Chrome's own
 * per-request buffer does. A response is evicted the instant its
 * `Target`'s renderer is torn down, which is exactly what a cross-origin
 * navigation does (`target-diagnostics.ts`'s own module doc: a navigation
 * kills the CDP session outright, and Chrome does not carry `Network`
 * state, or its buffered bodies, across that swap). Chrome also drops the
 * buffer outright for a request that never produced a body to begin with
 * (a redirect, a 204, a preflight). Both surface from CDP as the same
 * generic `-32000` "no resource with given identifier found" error
 * (`packages/core/src/cdp/errors.ts`'s `mapCdpJsonRpcError` is the one
 * place in this codebase permitted to inspect a raw CDP error message, and
 * it is not permitted to inspect this one any further than the three
 * specific substrings it already matches, so it maps this case to the
 * generic `E_CDP_SERVER_ERROR`), which means this pair cannot, and does
 * not claim to, tell "evicted by navigation" apart from "never had a body"
 * any more precisely than that. What it refuses to do is answer either
 * case with an empty string: both come back as
 * `bgls.error.responsebody.unavailable`, whose own message says plainly
 * that the body is GONE, not that it was empty. An empty
 * `page.responsebody.got` reply (`sizeBytes: 0`) stays a real, different,
 * true answer this pair can still legitimately give, for the ordinary case
 * of a request that completed with nothing in its body while it was still
 * readable.
 *
 * ── Bounded, and refused rather than cut ─────────────────────────────────
 *
 * See {@link MAX_RESPONSE_BODY_BYTES}. Exactly `./evaluate.ts`'s own
 * precedent (`MAX_EVALUATE_RESULT_BYTES`): over the ceiling is
 * `bgls.error.responsebody.too_large`, carrying the real `sizeBytes` and
 * `maxBytes`, never a silently shortened `body`. A response body read
 * exists to answer a yes-or-no question about what a page did ("did the
 * submit succeed"), and a truncated JSON payload or a truncated HTML
 * document is not a smaller correct answer to that question, it is a
 * different and potentially misleading one, which is `MAX_EVALUATE_RESULT_BYTES`'s
 * own reasoning, word for word applicable here.
 */

/**
 * The largest response body, in decoded bytes, the server will put on the
 * wire. 4 MiB: four times `MAX_EVALUATE_RESULT_BYTES`, because unlike an
 * `evaluate()` result (which a caller shapes with its own expression, and
 * which this build has only ever seen used for a JSON-sized fragment), a
 * response body is not shaped by the caller at all. The case this feature
 * exists for often IS a whole rendered page: plenty of form actions still
 * answer with a full HTML document rather than a JSON fragment, and a
 * consumer polling for whether a form submit produced a confirmation
 * page has to be able to read that whole page's markup, not a snippet of
 * it. Still bounded well below anything that would stall a socket also
 * carrying video frames.
 *
 * Measured on the DECODED byte length either way: UTF-8 bytes of
 * {@link PageResponseBodyGot.body} when {@link PageResponseBodyGot.base64Encoded}
 * is false, decoded bytes of it when true. Comparing the encoded (base64)
 * length instead would let a binary response sneak roughly a third larger
 * than a text one before being refused, for no reason a caller could see.
 */
export const MAX_RESPONSE_BODY_BYTES = 4194304;

/**
 * C to S: read the buffered response body for one request. Requires
 * `devtools`; see this module's doc for the full scoping argument.
 */
export interface PageResponseBodyGet extends Envelope {
  t: 'page.responsebody.get';
  /** The BrowserGlass target id (`tgt_*`) the request happened on. Resolved only within the caller's own session registry; see this module's doc, "the gateway owns `Network`". */
  targetId: string;
  /**
   * The CDP `requestId` from a `network.request` envelope
   * (`./diagnostics.ts`'s `NetworkRequestEntry.requestId`) THIS viewer was
   * actually sent for THIS target. Refused as
   * `bgls.error.responsebody.unknown_request` for anything else,
   * including a real requestId this viewer was never shown; see this
   * module's doc, "enforced in the SERVER".
   */
  requestId: string;
}

/**
 * S to C, addressed to the requesting viewer ONLY, never broadcast, for
 * the identical reason `page.evaluated` is (`./evaluate.ts`): a response
 * body is page content by definition, so fanning it out to every viewer of
 * the session would be a data leak in the same class as broadcasting a
 * `clipboard.data` reply. Answers {@link PageResponseBodyGet}.
 */
export interface PageResponseBodyGot extends Envelope {
  t: 'page.responsebody.got';
  targetId: string;
  requestId: string;
  /**
   * UTF-8 text when {@link base64Encoded} is false, base64-encoded bytes
   * when true, exactly as `Network.getResponseBody` itself splits it
   * (binary responses, images, PDFs, and any body Chrome could not decode
   * as text arrive with `base64Encoded: true`).
   */
  body: string;
  base64Encoded: boolean;
  /** Decoded byte length of {@link body}, UTF-8 bytes when {@link base64Encoded} is false, decoded bytes when true. Zero is a real, legitimate answer (a `204`, or any response that completed with an empty body); it is not how "gone" is spelled, see this module's doc, "bodies are not durable". */
  sizeBytes: number;
}
