/**
 * The canonical capability enum. Deny by default: there is no
 * hierarchy, no wildcard, and no inheritance. `admin` does not imply
 * `view`; `control` does not imply `view`; `probe` does not imply `view`.
 */
export type Capability =
  | 'view'
  | 'control'
  | 'navigate'
  | 'tabs.manage'
  | 'capture'
  | 'probe'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'upload'
  | 'download'
  // DevTools-grade console/network read (`diagnostics.subscribe`).
  // Also the gate for
  // `page.responsebody.get` (`./messages/response-body.ts`), a narrower
  // door reachable ONLY through this capability rather than a new one of
  // its own: a `requestId` reaches a caller in exactly one way, as a field
  // on a `network.request` envelope, which is itself gated on `devtools`
  // plus an active `network` diagnostics subscription. A caller with no
  // `devtools` never learns a `requestId` to ask for in the first place,
  // so requiring `cdp` (the allowlisted raw CDP passthrough) or a fresh
  // capability here would ask for a grant the feature does not actually
  // need. See that module's own doc for the full argument, including how
  // the server enforces, per viewer and per target, that a `requestId` was
  // actually shown before honouring it.
  | 'devtools'
  | 'automation'
  | 'instance.create'
  | 'instance.restart'
  | 'instance.destroy'
  | 'profile.read'
  | 'profile.write'
  | 'admin'
  // A dedicated capability for `POST .../targets/:targetId/cdp` (the REST
  // allowlisted CDP passthrough, `packages/server/src/rest/routes/targets.ts`),
  // deliberately its own capability rather than folded into `devtools` or
  // `automation`: those two are granted for other reasons already (DevTools
  // grade console/network read, unattended scripted control) and neither
  // implies "also allowlisted raw CDP access to this target." Never
  // implied by another capability: still not folded into `devtools` or
  // `automation`, and still absent from `observer`, `driver` and
  // `operator` below. It IS in the `agent` and `owner` bundles: an `agent`
  // token is meant to drive a browser completely with nothing left to opt
  // into (see `AGENT_BUNDLE`'s own comment below), and `cdp` stays no more
  // dangerous there than anywhere else, because `isCdpMethodAllowed`
  // (`packages/server/src/rest/cdp-passthrough-allowlist.ts`) still filters
  // every call against `REFUSED_DOMAINS`/`REFUSED_METHODS` regardless of
  // which bundle granted it.
  | 'cdp'
  // Page evaluation: `page.evaluate` (`./messages/evaluate.ts`), running a
  // caller-supplied expression or function inside ONE target's own
  // JavaScript context and getting the result back by value.
  //
  // Its own capability, and off by default, for the same reason `cdp` is,
  // only more so. This is the single largest privilege this protocol
  // grants: script running in the page's context reads every cookie the
  // page can read, every form value, every token in `localStorage`, and can
  // drive the page as the user. So:
  //
  //  * NOT implied by `devtools`. Reading a target's console and network
  //    traffic (what `devtools` gates, see `diagnostics.subscribe`) is
  //    observation. Running script is authorship.
  //  * NOT implied by `automation`. Unattended scripted control means
  //    clicks, keys and navigation through the input path, all of which a
  //    human watching the same target can see happening and can preempt.
  //    Evaluated script leaves no such trace on the screen.
  //  * NOT implied by `control`. A held `ControlLease` says "this viewer is
  //    the one driving the pointer right now". It says nothing about
  //    whether the viewer may author code.
  //  * NOT implied by `cdp`, and it does NOT imply `cdp` either. The two
  //    are siblings, not a hierarchy. The REST CDP passthrough refuses the
  //    whole `Runtime` domain outright
  //    (`packages/server/src/rest/cdp-passthrough-allowlist.ts`) and that
  //    refusal STAYS. `page.evaluate` is not a hole punched in it: it is a
  //    separate, narrower door, one target at a time, results by value
  //    only, no object handles, no execution-context ids, no browser-level
  //    reach. See `./messages/evaluate.ts` for the full scoping argument.
  //  * NOT implied by `admin`. `admin` is an operator role over sessions
  //    and leases (it force-claims control, it revokes). Being able to
  //    throw a viewer off a target is not the same authority as being able
  //    to read that target's session cookies.
  //
  // Absent from `observer`, `driver` and `operator` below, so none of
  // those role names can grant it by accident. It IS in the `agent` and
  // `owner` bundles, deliberately: an `agent` token is meant to drive a
  // browser completely, and every locator verb this protocol offers
  // (`click(selector)`, `fill`, `select`, `waitForSelector`, `text`,
  // `html`) requires `evaluate` to resolve a selector at all, so an
  // `agent` bundle without it could not use a selector, only raw
  // coordinates. See `AGENT_BUNDLE`'s own comment below for the full
  // argument, including why `owner` was widened to match.
  | 'evaluate'
  /**
   * Registers an outbound REQUEST GATE on a target: a say in whether each
   * request the page makes is allowed to leave.
   *
   * Scoped the way `evaluate` above is scoped, and for the same reason.
   * `Fetch` stays in `REFUSED_DOMAINS`
   * (`packages/server/src/rest/cdp-passthrough-allowlist.ts`) and this
   * does not punch a hole in that refusal: the GATEWAY owns the domain
   * (`packages/core/src/interception/request-gate.ts`), enables it at
   * `requestStage: 'Request'` only, and the vocabulary a holder of this
   * capability gets is two words, allow or deny.
   *
   * There is deliberately no field anywhere in the gate messages through
   * which a URL, a method, a header or a body could be supplied, so
   * `Fetch.fulfillRequest` (response forgery) and a rewritten
   * `Fetch.continueRequest` (an egress bypass no allowlist can inspect,
   * because the destination it names is not the destination that was
   * requested) are unreachable by construction rather than by rule.
   *
   *  * NOT implied by `control`. Driving a page is not the same authority
   *    as deciding what the page may talk to.
   *  * NOT implied by `cdp`, and does NOT imply it.
   *  * NOT implied by `admin`.
   *
   * What it DOES grant, stated plainly because an operator has to be able
   * to weigh it: a holder can refuse any request the page makes,
   * including the operator's own telemetry, consent, or audit scripts.
   * That is an egress VETO. It is strictly less dangerous than an egress
   * bypass, and there is no way to offer a useful gate while withholding
   * it. Absent from `observer`, `driver` and `operator` below, so none of
   * those role names grants it by accident. It IS in the `agent` and
   * `owner` bundles: an `agent` token is meant to drive a browser
   * completely, with nothing left to opt into, and offering an
   * unattended script the ability to gate its own target's requests
   * without also handing it the veto would leave something opted out. See
   * `AGENT_BUNDLE`'s own comment below for the full argument and the
   * honest statement of what the veto costs an operator relying on it.
   */
  | 'intercept';

/**
 * All 21 {@link Capability} values, in the same order as the union, for
 * runtime membership checks, `caps` bound validation, and role-bundle
 * expansion.
 */
export const CAPABILITIES: readonly Capability[] = Object.freeze([
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'clipboard.read',
  'clipboard.write',
  'upload',
  'download',
  'devtools',
  'automation',
  'instance.create',
  'instance.restart',
  'instance.destroy',
  'profile.read',
  'profile.write',
  'admin',
  'cdp',
  'evaluate',
  'intercept',
]);

/** The minimum number of entries a token's `caps` claim may carry. */
export const MIN_CAPS = 1;
/** The maximum number of entries a token's `caps` claim may carry (one per {@link Capability} member, 21 since `cdp`, `evaluate`, and `intercept` were added). */
export const MAX_CAPS = 21;

/**
 * Checks whether `value` is one of the 20 canonical {@link Capability}
 * strings.
 */
export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Convenience role bundles, expanded to a `caps[]` array at token-signing
 * time and then discarded. Never stored, never sent on the wire, never
 * consulted in an authorization decision.
 *
 * Key asymmetries preserved deliberately: `observer` carries `view` only,
 * not `tabs.manage`; `driver` carries `clipboard.write` but not
 * `clipboard.read`; `instance.restart` is in `operator`/`owner` but not
 * `driver`; `capture`/`probe` are in `operator`/`owner` but not `driver`;
 * `operator` carries `profile.read` but not `profile.write`.
 *
 * `agent` is deliberately the odd one out, and this is a decision, not an
 * oversight: an `agent` token is meant to drive a browser completely, with
 * nothing left to opt into, so its bundle is every capability that means
 * "operate this one browser" and none of the capabilities that mean "manage
 * the fleet". Concretely, `agent` carries `evaluate`, `cdp`, `intercept` and
 * `devtools` on top of the original five (`view`, `control`, `navigate`,
 * `tabs.manage`, `automation`), plus `upload`, `download`, `capture`,
 * `probe`, `clipboard.read` and `clipboard.write`, all of which the ORIGINAL
 * `agent` bundle lacked and every locator verb needs (see `evaluate`'s own
 * comment on the `Capability` union above: `click(selector)`, `fill`,
 * `select`, `waitForSelector`, `text` and `html` all require `evaluate`,
 * a `role=` selector additionally needs `devtools` for its accessibility
 * tree read, `page.a11y.get`'s own comment in
 * `packages/server/src/wire/capability-check.ts` makes the same argument).
 *
 * `agent` ALSO carries `instance.create`, `instance.restart` and
 * `instance.destroy`, added after the original decision above: an agent
 * that can drive a browser completely was still unable to open one for
 * itself or close the one it was done with, which is not "operate this one
 * browser", it is "operate this one browser only for as long as somebody
 * else keeps it alive". This is safe against the same denial of service
 * `agent`'s narrow default scope already exists to prevent: `release()`
 * (`packages/router/src/router/BrowserRouter.ts`, `assertScopeAllowsInstance`
 * called right before anything else runs) refuses `instance.destroy` for an
 * instance a `{ kind: 'instance' }`-scoped token was not minted for, so an
 * agent token scoped to its own instance can end only its own instance,
 * never a sibling's, over both the in-process router call and the REST
 * `DELETE /v1/instances/:instanceId` handler (`packages/server/src/rest/routes/instances.ts`),
 * which calls that same `release()`. The residual risk this does NOT close:
 * a token minted with `{ kind: 'tenant' }` scope (or no scope claim at all,
 * which `assertScopeAllowsInstance` reads as tenant scope, matching the
 * default `claims.scope ?? opts.scope ?? { kind: 'tenant' }` in
 * `server/src/auth/resolver.ts`) passes that same check for EVERY instance
 * in the tenant, so an `agent` bundle handed to a tenant scoped token can
 * still end any sibling instance's browser. The fix for that is minting
 * agent tokens instance scoped, not a capability restriction; this bundle
 * change grants the verb, the scope claim on the token decides its reach.
 *
 * Two more of these are worth stating plainly rather than leaving to
 * inference:
 *
 *  * `intercept` is an EGRESS VETO. A holder can deny any request the page
 *    makes, including the operator's own telemetry, consent, or audit
 *    scripts (see `intercept`'s own comment on the `Capability` union
 *    above). Granting it to `agent` means an automation token can now
 *    silently starve the operator's own instrumentation of the very page
 *    it is driving.
 *  * `cdp` is raw CDP passthrough, still filtered by `isCdpMethodAllowed`
 *    (`packages/server/src/rest/cdp-passthrough-allowlist.ts`): the method
 *    must be on `CDP_PASSTHROUGH_ALLOWLIST`, and `REFUSED_DOMAINS`
 *    (`Target`, `Browser`, `IO`, `Runtime`, `Debugger`, `Fetch`,
 *    `Security`, `Profiler`, `HeapProfiler`, `Memory`, `SystemInfo`,
 *    `Tracing`) plus `REFUSED_METHODS` still apply on top of the
 *    allowlist. Granting `cdp` to `agent` is not an escape from that
 *    refusal list; it only lets an agent token reach the same
 *    already-allowlisted, single-target, no-`Runtime`-domain surface any
 *    other `cdp` holder can reach.
 *
 * `agent` still withholds `profile.read`, `profile.write` and `admin`:
 * those are tenant management (reading or wiping a profile directory,
 * revoking someone else's session) with no equivalent in "operate this one
 * browser", unlike `instance.create`/`instance.restart`/`instance.destroy`
 * above, which an agent needs for its OWN instance and which its scope
 * already confines to that instance.
 *
 * `owner` is widened the same way and for the same reason: an `owner`
 * token that could not do everything an `agent` token can do would be
 * incoherent, so `owner` now also carries `evaluate`, `cdp` and
 * `intercept` (it already carried everything else `agent` carries,
 * `devtools` included, plus `admin` and the tenant-management capabilities
 * `agent` withholds). `owner` is therefore now the full 21-member
 * capability set: the one bundle for which "nothing left to opt into"
 * applies without qualification.
 */
const OBSERVER_BUNDLE: readonly Capability[] = ['view'];

const DRIVER_BUNDLE: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'clipboard.write',
  'upload',
  'download',
];

const OPERATOR_BUNDLE: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'clipboard.read',
  'clipboard.write',
  'upload',
  'download',
  'instance.create',
  'instance.destroy',
  'instance.restart',
  'profile.read',
];

const AGENT_BUNDLE: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'clipboard.read',
  'clipboard.write',
  'upload',
  'download',
  'devtools',
  'automation',
  'instance.create',
  'instance.restart',
  'instance.destroy',
  'evaluate',
  'cdp',
  'intercept',
];

const OWNER_BUNDLE: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'clipboard.read',
  'clipboard.write',
  'upload',
  'download',
  'devtools',
  'automation',
  'instance.create',
  'instance.destroy',
  'instance.restart',
  'profile.read',
  'profile.write',
  'admin',
  'evaluate',
  'cdp',
  'intercept',
];

/**
 * The frozen role-bundle table itself. See the bundle constants above for
 * the documented asymmetries each one preserves.
 */
export const ROLE_BUNDLES: Readonly<
  Record<'observer' | 'driver' | 'operator' | 'agent' | 'owner', readonly Capability[]>
> = Object.freeze({
  observer: Object.freeze(OBSERVER_BUNDLE),
  driver: Object.freeze(DRIVER_BUNDLE),
  operator: Object.freeze(OPERATOR_BUNDLE),
  agent: Object.freeze(AGENT_BUNDLE),
  owner: Object.freeze(OWNER_BUNDLE),
});

/** The name of one of the {@link ROLE_BUNDLES}. */
export type RoleBundleName = keyof typeof ROLE_BUNDLES;

/**
 * One parameter-dependent capability rule: a message requires
 * `baseCapability` unconditionally, plus `additionalCapability` when
 * `appliesWhen` evaluates to true against the message's payload.
 *
 * Originally the only three parameter-dependent checks, now four with {@link EVALUATE_USER_GESTURE_CAPABILITY_RULE},
 * expressed as data so a caller can enumerate and evaluate them
 * generically rather than special-casing each message type in an `if`
 * chain.
 */
export interface ParamCapabilityRule {
  /** The wire message type this rule governs, e.g. `'target.probe'`. */
  readonly message: string;
  /** The capability required regardless of payload. */
  readonly baseCapability: Capability;
  /** The capability required in addition, only when {@link appliesWhen} is true. */
  readonly additionalCapability: Capability;
  /** Evaluates the message payload to decide whether the additional capability applies. */
  readonly appliesWhen: (payload: Record<string, unknown>) => boolean;
}

/**
 * `target.probe` requires `view` always, plus `probe` when `detail: 'full'`.
 */
export const PROBE_CAPABILITY_RULE: ParamCapabilityRule = Object.freeze({
  message: 'target.probe',
  baseCapability: 'view',
  additionalCapability: 'probe',
  appliesWhen: (payload: Record<string, unknown>) => payload['detail'] === 'full',
});

/**
 * `control.request` requires `control` always, plus `admin` when
 * `force: true` (a viewer-initiated force claim).
 */
export const CONTROL_REQUEST_CAPABILITY_RULE: ParamCapabilityRule = Object.freeze({
  message: 'control.request',
  baseCapability: 'control',
  additionalCapability: 'admin',
  appliesWhen: (payload: Record<string, unknown>) => payload['force'] === true,
});

/**
 * `instance.restart` requires `instance.restart` always, plus
 * `profile.write` when `preserveProfile: false` (wipes the profile
 * directory, audited as a profile deletion).
 */
export const INSTANCE_RESTART_CAPABILITY_RULE: ParamCapabilityRule = Object.freeze({
  message: 'instance.restart',
  baseCapability: 'instance.restart',
  additionalCapability: 'profile.write',
  appliesWhen: (payload: Record<string, unknown>) => payload['preserveProfile'] === false,
});

/**
 * `page.evaluate` requires `evaluate` always, plus `control` when
 * `userGesture: true`.
 *
 * The threat this closes: `Runtime.evaluate`'s `userGesture` flag makes the
 * evaluated script run with a transient user activation, which is the
 * browser's own gate on the actions it will only perform for a real human.
 * With it set, evaluated script can open popups the popup blocker would
 * otherwise refuse, enter fullscreen, read the system clipboard through
 * `navigator.clipboard.readText()`, start a download, and prompt for
 * permissions, none of which plain evaluation can do. That is a claim to be
 * acting AS the person at the keyboard, which is exactly what `control`
 * means everywhere else in this protocol, so it requires `control` on top
 * of `evaluate` rather than coming free with it.
 *
 * Deliberately `control` and not `admin`: unlike the other three rules
 * here, the escalation is not an operator-grade override of someone else's
 * session, it is "this call counts as the user's own interaction". A caller
 * that already holds `control` for driving the pointer is exactly the
 * caller for whom a synthesised user gesture is honest.
 *
 * Note that `control` here is the CAPABILITY, checked at the wire layer,
 * not a held `ControlLease`. Holding the lease as well is enforced
 * separately by the server's own handler where it applies; a capability
 * check can only ever answer "may this token ever do this", never "is this
 * viewer the one driving right now".
 */
export const EVALUATE_USER_GESTURE_CAPABILITY_RULE: ParamCapabilityRule = Object.freeze({
  message: 'page.evaluate',
  baseCapability: 'evaluate',
  additionalCapability: 'control',
  appliesWhen: (payload: Record<string, unknown>) => payload['userGesture'] === true,
});

/**
 * All parameter-dependent capability rules, keyed by nothing in particular;
 * consumers filter by `message`. See {@link ParamCapabilityRule}.
 */
/**
 * Asking for request BODIES on a gated request needs `evaluate` as well
 * as `intercept`.
 *
 * A `POST` body carries whatever the user typed, passwords and card
 * numbers included, so it is a materially different thing to hand over
 * than a URL and a method. The reason `evaluate` is the right second
 * capability, rather than a new one: a caller who can run script in the
 * page can already read anything that page is about to send, so this
 * grants nothing new to a token holding `evaluate`, and grants something
 * significant to one that does not. See
 * `./messages/interception.ts`, escalation path 5.
 */
export const INTERCEPT_BODY_CAPABILITY_RULE: ParamCapabilityRule = Object.freeze({
  message: 'request.gate.enable',
  baseCapability: 'intercept',
  additionalCapability: 'evaluate',
  appliesWhen: (payload: Record<string, unknown>) =>
    Array.isArray(payload['rules']) &&
    (payload['rules'] as Array<Record<string, unknown>>).some(
      (r) => r?.['includeRequestBody'] === true,
    ),
});

export const PARAMETER_DEPENDENT_CAPABILITY_RULES: readonly ParamCapabilityRule[] = Object.freeze([
  PROBE_CAPABILITY_RULE,
  CONTROL_REQUEST_CAPABILITY_RULE,
  INSTANCE_RESTART_CAPABILITY_RULE,
  EVALUATE_USER_GESTURE_CAPABILITY_RULE,
  INTERCEPT_BODY_CAPABILITY_RULE,
]);
