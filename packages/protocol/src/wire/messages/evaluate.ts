/**
 * `page.evaluate` / `page.evaluated`: the sanctioned, capability-gated page
 * evaluation surface, gated on the `evaluate` capability
 * (`../capabilities.ts`), off by default and never implied by any other
 * capability or role bundle.
 *
 * ── Why this exists as its own message pair ──────────────────────────────
 *
 * `packages/server/src/rest/cdp-passthrough-allowlist.ts` refuses the whole
 * `Runtime` domain on the raw CDP passthrough, on the stated grounds that
 * `Runtime.evaluate`/`Runtime.callFunctionOn`/`Runtime.compileScript` are
 * "arbitrary script execution in the page's own context, the exact thing
 * the allowlist exists to prevent". That refusal is correct for an
 * untrusted tenant of a shared gateway and it STAYS EXACTLY AS IT IS. This
 * message pair does not widen it, does not carve an exception into it, and
 * does not require the `cdp` capability at all.
 *
 * The reason a first party operator still needs page evaluation is that the
 * denylist was serving two trust models with one policy. An application
 * running its own browsers for its own users is not a tenant of anyone
 * else's gateway, and for it `Runtime.evaluate` is not an escalation but
 * the basic tool. So evaluation ships as a NARROWER door rather than a
 * hole in the wide one: everything a raw `Runtime` passthrough would have
 * additionally handed over is absent from this message by construction.
 *
 * ── The five escalation paths, and how each is closed ────────────────────
 *
 * A caller holding `evaluate` must be able to run script in a target it
 * legitimately holds, and must not be able to reach anything else. Each
 * path is closed by the SHAPE of this message, not by a runtime check that
 * a later edit could forget:
 *
 *  1. ANOTHER TARGET. The only target selector on the wire is `targetId`,
 *     which is a BrowserGlass `tgt_*` id, not a Chrome target id. The
 *     server resolves it exclusively through the `TargetRegistry` belonging
 *     to the caller's own `ManagedSession`, whose `require()` throws
 *     `E_CDP_TARGET_NOT_FOUND` for anything it does not hold. There is no
 *     `executionContextId` field, no `objectId` field, and no
 *     `uniqueContextId` field, so a caller cannot name a context the
 *     registry never handed it, and there is no `contextId` to reach a
 *     cross-origin iframe's isolated world with either.
 *
 *  2. ANOTHER SESSION. There is no CDP `sessionId` field. The server maps
 *     `targetId` to a CDP session itself, through its own registry. A
 *     caller has no way to express "run this on session S": the field does
 *     not exist on this message, so no amount of guessing session ids gets
 *     anywhere.
 *
 *  3. ANOTHER TENANT. A socket is bound to one Instance at handshake time
 *     (the token's `iid` claim), and the `ManagedSession` a connection
 *     reaches is the one that Instance owns. Since (1) confines resolution
 *     to that session's registry and (2) removes session addressing
 *     entirely, a cross-tenant reach would require the wire to accept an
 *     instance or session id it simply has no field for.
 *
 *  4. THE BROWSER PROCESS. `Runtime.evaluate` sent WITHOUT a session id
 *     runs against the browser-level target, which is how a raw
 *     passthrough reaches `Browser.*` scope. This message cannot express
 *     that: `targetId` is required, and the server always sends the CDP
 *     command with a resolved page session attached. There is no
 *     "browser-level evaluate" spelling.
 *
 *  5. LIVE OBJECT HANDLES. `Runtime.evaluate` normally returns a
 *     `RemoteObject` with an `objectId` that survives the call and can be
 *     used as the receiver of a later `Runtime.callFunctionOn`, or walked
 *     with `Runtime.getProperties`. That is the pivot the allowlist's own
 *     comment worries about. This message pair NEVER returns an
 *     `objectId`: results come back by value, and a result that cannot be
 *     represented by value comes back as a description string (see
 *     {@link PageEvaluated.resultType}), never as a handle. There is
 *     correspondingly no `page.getProperties` and no `page.callOn`.
 *
 * ── What a caller CAN express ────────────────────────────────────────────
 *
 * Exactly one of {@link PageEvaluate.expression} or
 * {@link PageEvaluate.functionDeclaration}. Sending both, or neither, is
 * `bgls.error.evaluate.invalid_request`; it is not silently resolved in the
 * caller's favour, because "whichever one I meant" is not a thing a
 * security-relevant surface should guess at.
 */

import type { Envelope } from '../envelope.js';

/**
 * The largest script source, in UTF-8 bytes, either
 * {@link PageEvaluate.expression} or {@link PageEvaluate.functionDeclaration}
 * may carry.
 *
 * Set at half of `DEFAULT_LIMITS.maxControlMsgBytes` (65536) so a legal
 * expression plus its arguments and envelope still fits inside the control
 * message ceiling the handshake advertises. Anything larger is refused with
 * `bgls.error.evaluate.invalid_request` rather than truncated: a truncated
 * script is a DIFFERENT script, and running a prefix of what a caller asked
 * for is the worst possible answer on a surface whose whole job is running
 * exactly what it was given.
 */
export const MAX_EVALUATE_SOURCE_BYTES = 32768;

/**
 * The largest evaluation result, in UTF-8 bytes of its JSON encoding, the
 * server will put on the wire. 1 MiB.
 *
 * Chosen well above what `document.body.innerText` or
 * `document.documentElement.outerHTML` produce for a real page (the two
 * calls that motivate this feature) and well below anything that would
 * stall a socket also carrying video frames.
 *
 * Over the cap the server answers `bgls.error.evaluate.result_too_large`,
 * carrying the real `sizeBytes` and this `maxBytes` in `context`, rather
 * than truncating. Truncation was considered and rejected: a truncated
 * object is indistinguishable at the type level from a correct smaller one,
 * so a caller reading `result.items.length` would silently get a wrong
 * number, and a truncated HTML string still parses, just into the wrong
 * document. A refusal a caller can see and narrow their expression against
 * is strictly more useful than a lie it cannot detect.
 */
export const MAX_EVALUATE_RESULT_BYTES = 1048576;

/**
 * The largest number of arguments {@link PageEvaluate.args} may carry.
 * Arguments are JSON values, so this bounds the shape of the call, not its
 * size; total size is bounded by {@link MAX_EVALUATE_SOURCE_BYTES} plus the
 * control message ceiling.
 */
export const MAX_EVALUATE_ARGS = 16;

/**
 * The default evaluation timeout, in milliseconds, when
 * {@link PageEvaluate.timeoutMs} is omitted. Matches the `'Runtime.evaluate'`
 * entry already in `packages/core/src/cdp/timeouts.ts`, so the wire default
 * and the CDP layer's own per-method timeout agree instead of one silently
 * firing before the other.
 */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 30000;

/**
 * The largest {@link PageEvaluate.timeoutMs} a caller may ask for. A
 * caller-chosen timeout is a caller-chosen hold on a renderer thread, so it
 * is bounded: two minutes is long enough for any honest `await` and short
 * enough that a forgotten call cannot pin a tab for the life of a session.
 */
export const MAX_EVALUATE_TIMEOUT_MS = 120000;

/**
 * C to S: evaluate script in ONE target's own JavaScript context and return
 * the result by value. Requires the `evaluate` capability, plus `control`
 * when {@link userGesture} is true
 * (`EVALUATE_USER_GESTURE_CAPABILITY_RULE`).
 */
export interface PageEvaluate extends Envelope {
  t: 'page.evaluate';
  /**
   * The BrowserGlass target id (`tgt_*`) to evaluate in. Resolved only
   * within the caller's own session registry; see escalation paths 1 to 4
   * in this module's doc comment.
   */
  targetId: string;
  /**
   * A JavaScript expression, evaluated for its value. Mutually exclusive
   * with {@link functionDeclaration}.
   */
  expression?: string;
  /**
   * A function source (`'(a, b) => a + b'`, `'function (a) { ... }'`),
   * called with {@link args} and `globalThis` as its receiver. Mutually
   * exclusive with {@link expression}.
   */
  functionDeclaration?: string;
  /**
   * Arguments for {@link functionDeclaration}. JSON values only: there is
   * deliberately no way to pass a live object from the page back into it,
   * because that would require the object handles escalation path 5 exists
   * to refuse.
   */
  args?: readonly unknown[];
  /**
   * Default true. When the result is a promise, wait for it to settle and
   * return the settled value; a rejection comes back as an exception in
   * {@link PageEvaluated.exception}, exactly like a synchronous throw.
   *
   * The default is `true`, unlike CDP's own `Runtime.evaluate`, which
   * defaults it to false. A caller writing `await fetch(...)` in an
   * expression and getting a `Promise` description back instead of the
   * value is the single most common way to misuse this surface, and
   * defaulting to the behaviour that matches what the expression looks like
   * it does costs nothing: a caller who genuinely wants the promise object
   * itself can ask for it with `awaitPromise: false`.
   */
  awaitPromise?: boolean;
  /**
   * Evaluation deadline in milliseconds. Defaults to
   * {@link DEFAULT_EVALUATE_TIMEOUT_MS}, capped at
   * {@link MAX_EVALUATE_TIMEOUT_MS}. Enforced in the page (V8 terminates
   * the script) as well as on the socket, so a runaway loop is actually
   * killed rather than merely abandoned.
   */
  timeoutMs?: number;
  /**
   * Default false. Runs the script with a transient user activation. See
   * `EVALUATE_USER_GESTURE_CAPABILITY_RULE` for why this additionally
   * requires the `control` capability.
   */
  userGesture?: boolean;
  /**
   * Which JavaScript world the script runs in. Defaults to `'main'`, which
   * is what this surface has always done and what a caller reading page
   * state written by page script needs.
   *
   * `'isolated'` runs in a private world that shares the DOM and nothing
   * else: page globals are not visible to the script, and the script's own
   * globals are not visible to the page. That second half is the point.
   * A page cannot see the evaluation happen, cannot hook the functions it
   * calls, and cannot tamper with its results, which is what makes this the
   * right world for driving a site that is actively looking for automation.
   *
   * The cost is real and worth stating: a script in the isolated world
   * reading `window.somethingThePageSet` gets `undefined`, every time, and
   * that reads exactly like the value not existing. A caller comparing two
   * drivers on `typeof window.X` will draw the wrong conclusion from it.
   *
   * This is an enum and not a context id on purpose. Escalation path 1 in
   * this module's doc comment turns on a caller being unable to NAME an
   * execution context; letting one through here would reopen it. The
   * gateway resolves the world itself, against the main frame of the target
   * the registry already handed it, so `'isolated'` can only ever mean
   * "a private world in the frame I already had", never "some other frame's
   * world".
   */
  world?: EvaluateWorld;
}

/**
 * The JavaScript world a {@link PageEvaluate} runs in. See
 * {@link PageEvaluate.world}.
 */
export type EvaluateWorld = 'main' | 'isolated';

/**
 * C to S: the SDK-internal counterpart to {@link PageEvaluate}, used ONLY
 * for a locator verb's own resolve/verify bookkeeping
 * (`@browserglass/automation`'s `LocatorEngine`), never for a
 * caller-authored expression. Requires the identical `evaluate`
 * capability as {@link PageEvaluate}, is resolved through the identical
 * `ManagedSession.evaluate()` scoping (same target/session escalation
 * paths this module's own doc walks through for `PageEvaluate`), and
 * returns the identical {@link PageEvaluated} reply. The one thing that
 * differs is which token bucket a call spends from: `evaluateInternal`,
 * not `evaluate` (`packages/server/src/wire/rate-limit.ts`), so that a
 * caller's own explicit `evaluate()`/`waitForFunction()` budget is never
 * exhausted by however many round trips the locator surface needed to
 * resolve one selector (confirmed by direct observation: a single
 * `fill()` call's verify retry loop could exhaust the shared bucket and
 * trip the caller's NEXT, unrelated `page.evaluate` with a rate-limit
 * refusal).
 *
 * This is an ACCOUNTING split, not a new security boundary, and it is
 * important to be honest about what it does and does not close:
 *
 *  * It closes nothing a `page.evaluate` holder could not already reach.
 *    Both messages require the same capability and go through the same
 *    scoping, so this message widens no privilege.
 *  * It is not forgeable INTO a privilege a client lacks: there is no
 *    field here (and, notably, no `userGesture`) that lets a holder of
 *    `evaluate` alone reach something `EVALUATE_USER_GESTURE_CAPABILITY_RULE`
 *    would otherwise require `control` for.
 *  * It IS, honestly, a second meter on the same door: nothing stops a
 *    client from sending this message type directly instead of
 *    `page.evaluate`, and doing so would run exactly as it always could,
 *    just charged to `evaluateInternal` instead of `evaluate`. What
 *    prevents that from being a general rate-limit bypass is deliberate
 *    sizing, not refusal: `evaluateInternal`'s bucket is sized to genuine
 *    locator bookkeeping traffic (see its own doc in `rate-limit.ts`),
 *    not to general scripting, so the most a client gains by routing
 *    everything through this door is that bucket's modest, bounded
 *    throughput on top of nothing else escalated. The only way to close
 *    even that residual gap is to stop locator resolution from crossing
 *    the wire as script at all (moving `resolve`/`verify` server-side);
 *    this build takes the smaller, immediately available step instead,
 *    because the larger one touches the locator engine's own owned files.
 *
 * Deliberately narrower than {@link PageEvaluate} in shape, matching what
 * its one real sender (`AutomationClient`'s `evaluateFunction` port,
 * `packages/automation/src/client/AutomationClient.ts`) actually needs:
 * there is no `expression` field (every real call passes one of the
 * locator engine's own fixed scripts as `functionDeclaration`, never
 * caller-authored text; the locator's one caller-content evaluate, the
 * `verify` predicate `click()` accepts, deliberately still goes out as an
 * ordinary {@link PageEvaluate} and is charged to the caller's own
 * bucket) and no `userGesture` (an internal bookkeeping read never needs
 * one).
 */
export interface PageEvaluateInternal extends Envelope {
  t: 'page.evaluate.internal';
  /** Same scoping as {@link PageEvaluate.targetId}. */
  targetId: string;
  /** The SDK's own fixed script source. See this interface's own doc for why there is no sibling `expression` field. */
  functionDeclaration: string;
  /** Arguments for {@link functionDeclaration}. Same JSON-values-only rule as {@link PageEvaluate.args}. */
  args?: readonly unknown[];
  /** Same default and meaning as {@link PageEvaluate.awaitPromise}. */
  awaitPromise?: boolean;
  /** Same default, cap and meaning as {@link PageEvaluate.timeoutMs}. */
  timeoutMs?: number;
  /** Same default and meaning as {@link PageEvaluate.world}. */
  world?: EvaluateWorld;
}

/**
 * How {@link PageEvaluated} carries what the script produced.
 *
 *  * `'value'`: a JSON-representable value, in {@link PageEvaluated.value}.
 *  * `'undefined'`: the script completed and produced `undefined`. Kept
 *    distinct from `'value'` with `value: null`, because `undefined` and
 *    `null` are different answers and JSON cannot tell them apart.
 *  * `'unserializable'`: the script completed but its result cannot cross
 *    the wire by value. Two sub-cases, both non-fatal and both descriptive:
 *    a primitive JavaScript can name but JSON cannot (`NaN`, `Infinity`,
 *    `-Infinity`, `-0`, a BigInt) arrives as a source-text string in
 *    {@link PageEvaluated.unserializableValue}; a live object (a DOM node, a
 *    function, `window`, a cyclic structure) arrives as a human-readable
 *    {@link PageEvaluated.description} such as `'HTMLDivElement'` or
 *    `'function'`. Either way NO handle is returned, so this is a dead end
 *    by design rather than a step towards one: the caller must narrow their
 *    expression to something serialisable (`el.textContent`, not `el`).
 */
export type PageEvaluateResultType = 'value' | 'undefined' | 'unserializable';

/**
 * A JavaScript exception raised inside the page, reported as DATA rather
 * than as a wire `error`.
 *
 * This distinction is the point. A page-side throw is a normal, expected
 * outcome of running someone's script: `document.querySelector('#x').value`
 * on a page that has not rendered `#x` yet throws, and that is information
 * the caller wants, not a protocol failure. It arrives as
 * `page.evaluated` with `ok: false`, so a caller can tell it apart from a
 * transport failure (`bgls.error.evaluate.failed`, the CDP command itself
 * did not complete), a timeout (`bgls.error.evaluate.timeout`), a target
 * that went away (`bgls.error.target.not_found`) and a refusal
 * (`bgls.error.cap.missing`), all of which arrive as `error` envelopes.
 */
export interface PageEvaluateException {
  /** The page's own `error.message`, or the thrown value stringified when a non-Error was thrown. */
  message: string;
  /** The constructor name (`'TypeError'`), when the thrown value was an Error. */
  name?: string;
  /** The page's own stack, when it had one. Truncated by the server to a sane length. */
  stack?: string;
  /** 1-based line number within the evaluated source, when the page reported one. */
  lineNumber?: number;
  /** 1-based column number within the evaluated source, when the page reported one. */
  columnNumber?: number;
}

/**
 * S to C, addressed to the requesting viewer ONLY, never broadcast. An
 * evaluation result is page content by definition (that is what it was
 * asked to read), so fanning it out to every viewer of the session would be
 * a data leak in the same class as broadcasting a `clipboard.data` reply.
 */
export interface PageEvaluated extends Envelope {
  t: 'page.evaluated';
  targetId: string;
  /** False when the page threw, in which case {@link exception} is set and {@link resultType} carries no meaning. */
  ok: boolean;
  /** See {@link PageEvaluateResultType}. */
  resultType: PageEvaluateResultType;
  /** The result, when {@link resultType} is `'value'`. */
  value?: unknown;
  /** The source text of a JSON-inexpressible primitive, when {@link resultType} is `'unserializable'`. */
  unserializableValue?: string;
  /** A human-readable description of a live object, when {@link resultType} is `'unserializable'` and it was not a primitive. */
  description?: string;
  /** UTF-8 byte length of {@link value}'s JSON encoding. Zero for every other {@link resultType}. */
  sizeBytes: number;
  /** Set when {@link ok} is false. */
  exception?: PageEvaluateException;
  re?: string;
}
