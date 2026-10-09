/**
 * Capability enforcement for the `bgls.v1` message loop: server side, on
 * EVERY message, every time (`welcome.granted` is a UI
 * hint, never a security control). `REQUIRED_CAPABILITY` is the static
 * base-capability table; the five parameter-dependent rules from
 * `@browserglass/protocol`'s `PARAMETER_DEPENDENT_CAPABILITY_RULES` layer an
 * additional capability on top for specific payload shapes (`target.probe`
 * with `detail:'full'`, `control.request` with `force:true`,
 * `instance.restart` with `preserveProfile:false`, `page.evaluate` with
 * `userGesture:true`, and `request.gate.enable` with any rule setting
 * `includeRequestBody:true`).
 *
 * Note that the loop below selects rules by `baseCapability`, not by
 * message name, so a rule is offered every message sharing its base. That
 * is safe only because each rule's own `appliesWhen` inspects the payload
 * shape: `INTERCEPT_BODY_CAPABILITY_RULE` is offered all three
 * `request.gate.*` messages and matches only the one carrying a `rules`
 * array.
 */

import { type Capability, PARAMETER_DEPENDENT_CAPABILITY_RULES } from '@browserglass/protocol';

/**
 * The base capability every message type requires, or `null` for a type
 * with no capability gate (the handshake messages, and every purely
 * server-to-client type, which never arrives as `t` on an inbound message
 * and so is never looked up here). A `t` absent from this table entirely is
 * `bgls.error.protocol.unknown_type` territory, not a capability failure.
 */
export const REQUIRED_CAPABILITY: Readonly<Record<string, Capability | null>> = Object.freeze({
  hello: null,
  resume: null,
  ping: null,
  ack: null,

  'target.list': 'view',
  'target.activate': 'view',
  'target.new': 'tabs.manage',
  'target.close': 'tabs.manage',
  'target.reorder': 'tabs.manage',

  'stream.subscribe': 'view',
  'stream.unsubscribe': 'view',
  'stream.pause': 'view',
  'stream.resume': 'view',
  'stream.quality': 'view',
  'keyframe.request': 'view',

  'input.mouse': 'control',
  'input.key': 'control',
  'input.text': 'control',
  'input.touch': 'control',
  'input.composition': 'control',
  'input.drag': 'control',

  'control.request': 'control',
  'control.renew': 'control',
  'control.release': 'control',
  'control.revoke': 'admin',
  // `control`, deliberately NOT `admin`. A yield asks the AUTOMATION on a
  // shared target to stand down and leaves every person driving, so it is an
  // ordinary act by somebody who already holds control, not an
  // administrative one. `control.revoke` above stays the admin instrument
  // and stays narrower still: it names ONE holder, of any kind, and removes
  // them. Gating the yield on `admin` would mean the only people who could
  // ask a robot to stop sharing their tab are the operators, which is
  // exactly backwards for the case the feature exists for.
  'control.yield': 'control',

  'nav.goto': 'navigate',
  'nav.back': 'navigate',
  'nav.forward': 'navigate',
  'nav.reload': 'navigate',
  'nav.stop': 'navigate',

  'instance.restart': 'instance.restart',

  'dialog.answer': 'control',

  'target.capture': 'capture',
  // `page.pdf.get` (`@browserglass/protocol`'s `wire/messages/pdf.ts`).
  // Same capability as `target.capture`, deliberately: a PDF is a render
  // of the page the caller can already see, the identical authority a
  // screenshot already gets, not a new privilege of its own. See that
  // message's own module doc for the full argument for why this is
  // measured against `capture` rather than `evaluate`.
  'page.pdf.get': 'capture',
  'target.probe': 'view',

  'clipboard.read': 'clipboard.read',
  'clipboard.write': 'clipboard.write',

  // File upload, all four on the canonical `upload` capability from
  // `@browserglass/protocol`'s 19 member table rather than a new one.
  // `upload` was already there, already meant exactly this, and is granted
  // by the `driver`, `operator` and `owner` bundles only: `observer` and
  // `agent` do not carry it, so an automation token has to name it
  // explicitly. Attaching a file to a form is a real privilege (it is how
  // a document leaves the machine), and `files.set` is gated on the same
  // capability as the staging routes rather than on `control`, so a token
  // that can drive the mouse cannot, by that alone, attach a file.
  'upload.begin': 'upload',
  'upload.complete': 'upload',
  'upload.cancel': 'upload',
  'files.set': 'upload',

  // Reading a target's console and network activity is gated on
  // `devtools`, the capability reserved for DevTools-grade access; `view` alone is not enough.
  'diagnostics.subscribe': 'devtools',
  'diagnostics.unsubscribe': 'devtools',
  // The read-only status query (`@browserglass/protocol`'s
  // `wire/messages/diagnostics.ts`, `DiagnosticsStatusGet`). Same
  // capability as `diagnostics.subscribe` above, deliberately: whether a
  // target is CDP-fingerprintable right now is DevTools-grade information
  // about the browser's own detectability, not `view`-grade content about
  // the page, even though answering it has no side effect on the target.
  'diagnostics.status.get': 'devtools',

  // Page evaluation. Its own capability, off by default, never implied by
  // `devtools`, `automation`, `control`, `cdp` or `admin`; see
  // `@browserglass/protocol`'s `Capability` union for the full argument on
  // each of those. `EVALUATE_USER_GESTURE_CAPABILITY_RULE` layers `control`
  // on top when the payload sets `userGesture: true`, through the generic
  // parameter-dependent path in `checkCapability` below.
  'page.evaluate': 'evaluate',

  // `page.evaluate`'s SDK-internal counterpart
  // (`@browserglass/protocol`'s `PageEvaluateInternal`). Same capability,
  // deliberately: this message widens nothing a `page.evaluate` holder
  // could not already do, it only charges a different, smaller rate
  // bucket (`evaluateInternal`, `../wire/rate-limit.ts`) for the locator
  // surface's own resolve/verify bookkeeping. See that message's own doc
  // for why splitting the BUCKET, while keeping the capability identical,
  // is what stops the split from becoming a rate-limit bypass.
  'page.evaluate.internal': 'evaluate',

  // The response-body join (`@browserglass/protocol`'s
  // `wire/messages/response-body.ts`). Gated on `devtools`, deliberately
  // NOT `cdp` and NOT a fresh capability of its own: a `requestId` reaches
  // a caller only as a field on a `network.request` envelope, itself
  // gated on `devtools` plus an active network diagnostics subscription,
  // so this door asks for nothing the caller does not already have a
  // reason to hold. The capability check alone does not close the whole
  // scoping argument here, unlike every other row in this table: a second
  // enforcement point lives in `ManagedSession.getResponseBody`, which
  // refuses a `requestId` this specific viewer was never actually shown
  // for this target, which `checkCapability` has no way to express (it
  // sees only "does this token hold devtools", never "was THIS viewer
  // told about THIS requestId"). See that module's own doc.
  'page.responsebody.get': 'devtools',

  // The accessibility tree door (`@browserglass/protocol`'s
  // `wire/messages/a11y.ts`). Gated on `devtools`, deliberately NOT
  // `evaluate`: `Accessibility.queryAXTree` and the optional `DOM.setAttributeValue`
  // stamp are CDP domain calls, not page script, so this asks for the
  // capability that already covers reading a target's structure and
  // content (`page.responsebody.get`'s own entry, just above, made the
  // identical argument for response bodies). The locator engine's `role=`
  // selector layers this door underneath an ordinary `resolve()` call, so
  // using `role=` needs BOTH `devtools` (this message) and `evaluate`
  // (the `page.evaluate` call `resolve()` still makes afterwards); see
  // that module's own doc for why that is an honest account of the two
  // distinct things `role=` does rather than an oversight.
  'page.a11y.get': 'devtools',

  // The page map door (`@browserglass/protocol`'s `wire/messages/pagemap.ts`),
  // `page.map.get` and `page.map.stamp` both. Gated on `devtools`, exactly
  // the argument `page.a11y.get` just above already makes for itself and
  // that message's own module doc restates verbatim: every CDP command the
  // capture sends (`DOMSnapshot.captureSnapshot`, `DOM.getDocument`,
  // `Page.getFrameTree`, `Accessibility.getFullAXTree`, and
  // `DOMDebugger.getEventListeners` for the optional listener signal) is a
  // domain read, never page script, so `devtools` already covers it and
  // gating on `evaluate` would ask for a capability this feature does not
  // use. `page.map.stamp` stays on the same capability as `page.map.get`
  // rather than earning one of its own: it writes through
  // `DOM.setAttributeValue`, the identical mechanism `page.a11y.get`'s own
  // `stamp: true` path already uses under this same gate, never through
  // page script or a live object handle.
  'page.map.get': 'devtools',
  'page.map.stamp': 'devtools',

  // The outbound request gate. Its own capability, off by default and
  // absent from every role bundle, for the same reasons `evaluate` above
  // is: it is not implied by `control` (driving a page is not the same
  // authority as deciding what the page may talk to), not by `cdp`, and
  // not by `admin`. `INTERCEPT_BODY_CAPABILITY_RULE` layers `evaluate` on
  // top when any rule asks for request bodies, through the same generic
  // parameter-dependent path `userGesture` uses.
  //
  // `Fetch` stays in `REFUSED_DOMAINS` (`../rest/cdp-passthrough-allowlist.js`).
  // These three messages are a narrow door beside that refusal, not a
  // hole through it: the gateway owns the domain and the caller's whole
  // vocabulary is allow or deny. See `@browserglass/protocol`'s
  // `wire/messages/interception.ts` for the escalation-by-escalation
  // argument.
  'request.gate.enable': 'intercept',
  'request.gate.disable': 'intercept',
  'request.gate.resolve': 'intercept',

  // `recording.*` (`@browserglass/protocol`'s `wire/messages/recording.ts`).
  // Base capability `capture`, deliberately NOT `view`: a durable
  // recording is a materially different authority from watching a live
  // stream nobody stores (that module's own doc makes the argument in
  // full). `capture` alone is not the whole story either -- it is the
  // same authority `target.capture`/`page.pdf.get` already get for a
  // MOMENTARY render, gone once the reply is sent, nothing left on disk.
  // A recording produces the opposite thing: a file that outlives the
  // socket, the viewer, and the session itself. That is the authority
  // `download` already gates (extracting bytes that leave the live
  // session as a retrievable artifact), so every `recording.*` message
  // ALSO requires `download`, checked by hand in `ws/connection.ts`'s
  // handler rather than through `PARAMETER_DEPENDENT_CAPABILITY_RULES`:
  // that mechanism selects rules by `baseCapability`, not by message name
  // (see this file's own header doc), so a rule with `baseCapability:
  // 'capture'` would also apply to `target.capture`/`page.pdf.get`, which
  // must NOT gain a `download` requirement they never had. This is the
  // same "second enforcement point `checkCapability` cannot express"
  // pattern `page.responsebody.get`'s own entry above documents.
  'recording.start': 'capture',
  'recording.stop': 'capture',
  'recording.list': 'capture',
});

/** One capability-check outcome. */
export type CapabilityCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly required: Capability };

/**
 * Checks `granted` against `t`'s required capability (base, plus any
 * parameter-dependent addition the payload triggers). A `t` with no entry
 * in {@link REQUIRED_CAPABILITY} passes here (the caller is expected to
 * reject it as `unknown_type` first, not silently allow it as capability-free).
 */
export function checkCapability(
  t: string,
  payload: Record<string, unknown>,
  granted: ReadonlySet<Capability>,
): CapabilityCheckResult {
  const base = REQUIRED_CAPABILITY[t];
  if (base && !granted.has(base)) {
    return { ok: false, required: base };
  }
  for (const rule of PARAMETER_DEPENDENT_CAPABILITY_RULES) {
    if (rule.baseCapability !== base) continue;
    if (!rule.appliesWhen(payload)) continue;
    if (!granted.has(rule.additionalCapability)) {
      return { ok: false, required: rule.additionalCapability };
    }
  }
  return { ok: true };
}
