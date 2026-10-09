/**
 * `request.gate.*`: a say in whether each outbound request one Target
 * makes is allowed to leave.
 *
 * Read this doc before changing any type in this file. It is the same
 * kind of argument `./evaluate.ts` makes, and for the same reason: the
 * safety of this feature rests on the SHAPE of what crosses the wire, not
 * on a runtime check somewhere that has to be right every time.
 *
 * ── `Fetch` stays refused, and this is not a hole in that ──
 *
 * `Fetch` is on `REFUSED_DOMAINS` in
 * `packages/server/src/rest/cdp-passthrough-allowlist.ts`. These messages
 * do not relax that by one method. The GATEWAY owns the domain
 * (`packages/core/src/interception/request-gate.ts`), enables it at
 * `requestStage: 'Request'` only, and never sends `Fetch.fulfillRequest`
 * or a `Fetch.continueRequest` carrying any modification field. A holder
 * of the `intercept` capability never speaks CDP at all; it registers
 * rules and answers verdicts.
 *
 * ── The escalations this shape closes ──
 *
 * 1. RESPONSE FORGERY. `Fetch.fulfillRequest` can invent a response body
 *    for any URL, which is how a page gets convinced it heard something
 *    it never heard. Unreachable: there is no message here carrying a
 *    body, a status, or response headers, and the gate is enabled at the
 *    Request stage where `fulfillRequest`'s response arguments do not
 *    apply.
 * 2. EGRESS REWRITE. `Fetch.continueRequest` accepts a replacement `url`,
 *    `method`, `headers` and `postData`. An allowlist cannot police that,
 *    because the destination the rewritten request names is not the
 *    destination that was inspected. Unreachable: {@link RequestGateResolve}
 *    carries a verdict and nothing else, and the verdict type is a two
 *    member union of string literals.
 * 3. RESPONSE INSPECTION. Reading response bodies for URLs the viewer
 *    could not otherwise read is a data exfiltration path. Unreachable:
 *    Request stage only, so there is no response to inspect yet.
 * 4. CROSS TARGET REACH. A rule set is registered against one `targetId`,
 *    resolved only within the caller's own session registry, exactly as
 *    `page.evaluate` resolves its own. A gate on one target never sees
 *    another target's requests, and never sees browser level traffic.
 * 5. REQUEST BODIES. A `POST` body can carry passwords and card numbers.
 *    {@link RequestGatePaused.postData} is therefore populated ONLY when
 *    the rule that matched set {@link GateRule.includeRequestBody}, and
 *    that flag additionally requires the `evaluate` capability
 *    (`INTERCEPT_BODY_CAPABILITY_RULE`). The reasoning is that a caller
 *    who can already run script in the page can already read anything the
 *    page is about to send, so the flag grants nothing new to a token
 *    that holds `evaluate`, and grants something significant to one that
 *    does not.
 *
 * ── What this DOES grant, stated plainly ──
 *
 * An egress VETO. A holder can refuse any request the page makes,
 * including the operator's own telemetry, consent, or audit scripts.
 * There is no way to offer a useful request gate while withholding that,
 * so an operator weighing the `intercept` capability should weigh exactly
 * this. It is strictly less dangerous than the bypass in escalation 2,
 * which is why the shape above is worth the trouble.
 *
 * ── The bound that is not about security ──
 *
 * A held request occupies a real Chrome network slot. A caller that holds
 * requests and never resolves them can wedge its own page, and burn node
 * capacity doing it. {@link MAX_GATE_HOLD_MS} bounds one hold and
 * {@link MAX_CONCURRENT_GATE_HOLDS} bounds how many may be outstanding at
 * once; past either, the server applies the rule's own
 * {@link GateRule.onTimeout} without asking. That is self-inflicted
 * damage control, not an authorization boundary.
 */

import type { Envelope } from '../envelope.js';

/**
 * The only two answers a gate may give.
 *
 * A two member union of string literals, deliberately, rather than an
 * object with optional override fields. Escalation 2 above is closed by
 * exactly this: there is nowhere to put a rewritten URL. A future change
 * that turns this into an object is re-opening that hole, and it is the
 * one review rule this module has.
 */
export type GateVerdict = 'allow' | 'deny';

/** The largest number of rules one `request.gate.enable` may carry. Each rule is matched against every request the target makes, so this is a per request cost. */
export const MAX_GATE_RULES = 32;

/** The longest a single {@link GateRule.urlPattern} may be, in UTF-8 bytes. */
export const MAX_GATE_PATTERN_BYTES = 2048;

/** Default time the server waits for a {@link RequestGateResolve} before applying the rule's {@link GateRule.onTimeout}. */
export const DEFAULT_GATE_HOLD_MS = 1500;

/** The longest a caller may hold one request. See this module's doc on why this bound is about capacity, not authorization. */
export const MAX_GATE_HOLD_MS = 30000;

/** How many requests may be paused awaiting a verdict on one target at once. */
export const MAX_CONCURRENT_GATE_HOLDS = 64;

/**
 * One matching rule.
 *
 * A rule that names a `verdict` answers immediately on the server and
 * never pauses anything, which is the shape a caller should prefer: it
 * costs no round trip and cannot time out. A rule with `verdict: 'ask'`
 * is the one that produces a {@link RequestGatePaused}.
 */
export interface GateRule {
  /**
   * Glob style URL pattern, `*` matching any run of characters. Matched
   * against the full request URL.
   */
  urlPattern: string;
  /** Restricts the rule to these HTTP methods. Absent means every method. */
  methods?: readonly string[];
  /**
   * Restricts the rule to these Chrome resource types (`Document`, `XHR`,
   * `Fetch`, `Script`, and so on). Absent means every type.
   */
  resourceTypes?: readonly string[];
  /**
   * `'allow'` and `'deny'` are decided server side with no round trip.
   * `'ask'` pauses the request and emits {@link RequestGatePaused}.
   */
  verdict: GateVerdict | 'ask';
  /**
   * Include the request body on the {@link RequestGatePaused} this rule
   * produces. Only meaningful with `verdict: 'ask'`. Additionally
   * requires the `evaluate` capability; see escalation 5 in this module's
   * doc for why that particular capability is the right gate on it.
   */
  includeRequestBody?: boolean;
  /**
   * What an unanswered or late verdict counts as for this rule. Defaults
   * to `'deny'`: a gate that fails open is not a gate, and a common use is
   * stopping form submissions.
   */
  onTimeout?: GateVerdict;
  /** How long to hold a request matched by this rule. Defaults to {@link DEFAULT_GATE_HOLD_MS}, capped at {@link MAX_GATE_HOLD_MS}. */
  holdMs?: number;
}

/**
 * C to S: install (or replace) the rule set for one target. Requires the
 * `intercept` capability, plus `evaluate` when any rule sets
 * {@link GateRule.includeRequestBody}.
 *
 * Replaces wholesale rather than merging, so a caller always knows the
 * complete rule set in force. Sending `rules: []` leaves the gate armed
 * and matching nothing, which is not the same as
 * {@link RequestGateDisable}: the difference matters because arming and
 * disarming a gate is exactly when requests slip past.
 */
export interface RequestGateEnable extends Envelope {
  t: 'request.gate.enable';
  /** The BrowserGlass target id (`tgt_*`), resolved only within the caller's own session registry. */
  targetId: string;
  rules: readonly GateRule[];
}

/** C to S: remove the rule set and disable the gate for this target. */
export interface RequestGateDisable extends Envelope {
  t: 'request.gate.disable';
  targetId: string;
}

/**
 * S to C: a request matched a `verdict: 'ask'` rule and is being held.
 * Sent ONLY to the viewer that registered the rule set, never broadcast:
 * a paused request's URL and headers are the registering caller's
 * business and nobody else's.
 */
export interface RequestGatePaused extends Envelope {
  t: 'request.gate.paused';
  targetId: string;
  /** Correlates this pause with its {@link RequestGateResolve}. Server generated; a caller must echo it back verbatim. */
  gateId: string;
  url: string;
  method: string;
  resourceType: string;
  /** Request headers, lower cased keys. */
  headers: Readonly<Record<string, string>>;
  /** Present only when the matching rule set {@link GateRule.includeRequestBody}. See escalation 5. */
  postData?: string;
  /** When the server stops waiting and applies the rule's `onTimeout`, as an epoch milliseconds deadline so a caller can see how much time it has left rather than having to track its own. */
  deadlineAt: number;
}

/**
 * C to S: answer one held request.
 *
 * Carries a verdict and nothing else. That is the whole of escalation 2's
 * defence: see {@link GateVerdict}.
 */
export interface RequestGateResolve extends Envelope {
  t: 'request.gate.resolve';
  targetId: string;
  /** The `gateId` from the {@link RequestGatePaused} being answered. */
  gateId: string;
  verdict: GateVerdict;
}

/** S to C: the rule set is in force. Answers {@link RequestGateEnable}. */
export interface RequestGateEnabled extends Envelope {
  t: 'request.gate.enabled';
  targetId: string;
  /** How many rules are in force. Echoes the count the server accepted, which is what a caller should assert against rather than assuming its own array length survived. */
  ruleCount: number;
}

/** S to C: the gate is off. Answers {@link RequestGateDisable}. */
export interface RequestGateDisabled extends Envelope {
  t: 'request.gate.disabled';
  targetId: string;
}
