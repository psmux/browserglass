/**
 * `evaluateInSession`: the ONE place in `@browserglass/core` that sends
 * `Runtime.evaluate` on behalf of a caller rather than as an internal
 * liveness probe.
 *
 * The two existing internal uses (`session/recovery-target.ts` and
 * `stream/screenshot-poll-source.ts`) send the fixed expression `'1'` to
 * see whether a renderer still answers. This module is different in kind:
 * the expression comes from outside, so everything that can go wrong when
 * running someone else's code in a page has to have a defined answer here
 * rather than becoming a rejected promise somewhere up the stack.
 *
 * ── What this module is NOT ──────────────────────────────────────────────
 *
 * It is not a `Runtime` domain passthrough. It sends exactly one CDP method
 * (`Runtime.evaluate`), always with a page session id attached, always with
 * `returnByValue: true`, and it never returns a `RemoteObject.objectId` to
 * its caller. That last point is the load-bearing one: an `objectId` is a
 * live handle into the page that outlives the call and can be fed to
 * `Runtime.callFunctionOn` or walked with `Runtime.getProperties`, which is
 * the pivot `packages/server/src/rest/cdp-passthrough-allowlist.ts` closes
 * the whole domain to prevent. Dropping the handle on the floor here means
 * no layer above this one can leak it, because no layer above this one ever
 * sees it.
 *
 * ── Scoping ──────────────────────────────────────────────────────────────
 *
 * This function takes an already-resolved `CdpSessionId`. It does not
 * resolve one, and deliberately does not accept a target id: resolving a
 * target id to a session is the caller's job precisely because that is
 * where the authorization boundary lives (a `TargetRegistry` that only
 * holds one session's targets). Handing this function a session id it
 * should not have been given is a bug at the call site, and putting the
 * lookup here would have moved the security decision into a module that has
 * no idea whose session it is looking at.
 */

import type { CdpBridge } from './bridge.js';
import { CdpError } from './errors.js';
import type { CdpSessionId } from './types.js';

/** What to run, and how. See `@browserglass/protocol`'s `PageEvaluate` for the wire-level contract these fields mirror. */
export interface EvaluateRequest {
  /** A JavaScript expression, evaluated for its value. Mutually exclusive with {@link functionDeclaration}; the caller has already validated that exactly one is present. */
  readonly expression?: string;
  /** A function source, called with {@link args} and `globalThis` as its receiver. */
  readonly functionDeclaration?: string;
  /** JSON arguments for {@link functionDeclaration}. Ignored when {@link expression} is used. */
  readonly args?: readonly unknown[];
  /** Default true: settle a returned promise and report the settled value. */
  readonly awaitPromise?: boolean;
  /** Default false: run with a transient user activation. */
  readonly userGesture?: boolean;
  /** Evaluation deadline, milliseconds. */
  readonly timeoutMs: number;
  /** The JSON byte ceiling for a returned value, over which the outcome is `'too_large'`. */
  readonly maxResultBytes: number;
  /**
   * Which world to run in. Defaults to `'main'`, the behaviour this module
   * had before the option existed. See `PageEvaluate.world`.
   */
  readonly world?: EvaluateWorld;
  /**
   * The CDP frame id whose isolated world to use, required when
   * {@link world} is `'isolated'` and ignored otherwise.
   *
   * Supplied by the caller from ITS OWN target registry, never from the
   * wire. That is the whole reason the wire carries an enum instead of a
   * frame or context id: a caller who could name a frame here could name
   * one it was never handed, and escalation path 1 in `PageEvaluate`'s doc
   * comment exists to make that unspellable.
   */
  readonly frameId?: string;
}

/** The JavaScript world an evaluation runs in. Mirrors `PageEvaluate.world`. */
export type EvaluateWorld = 'main' | 'isolated';

/**
 * The name every isolated world this module creates is given.
 *
 * Fixed rather than per-call: `Page.createIsolatedWorld` returns the
 * EXISTING world when called again with the same frame and name, so a fixed
 * name is what makes {@link isolatedContextFor}'s cache-miss path cheap and
 * idempotent instead of leaking a fresh world per evaluation.
 */
const ISOLATED_WORLD_NAME = 'browserglass:isolated';

/**
 * Execution context ids for isolated worlds already created, keyed by
 * session and frame.
 *
 * A world dies when its frame navigates and CDP does not tell us, because
 * this build deliberately never enables `Runtime` (that domain's `enable`
 * is the leak anti-bot scripts read, and `evaluateInSession` avoids it).
 * So the cache is optimistic and {@link evaluateInSession} repairs it: a
 * stale id comes back as a "Cannot find context" protocol error, which is
 * retried exactly once against a freshly created world. Cheap in the common
 * case, correct in the uncommon one, and it costs no extra round trip on
 * the hot path.
 */
const isolatedContexts = new Map<string, number>();

/**
 * The one place the cache key is spelled.
 *
 * It was written by hand at three call sites before, and one of them drifted
 * to a different separator, so a stale world was never evicted and the retry
 * below re-read the id it had just been told was dead. A key built in more
 * than one place is a key that will disagree with itself eventually.
 */
function worldKey(sessionId: CdpSessionId, frameId: string): string {
  return `${sessionId}::${frameId}`;
}

/** Drops any cached isolated world for `sessionId`. Call when its session goes away. */
export function forgetIsolatedWorlds(sessionId: CdpSessionId): void {
  const prefix = `${sessionId}::`;
  for (const key of isolatedContexts.keys()) {
    if (key.startsWith(prefix)) isolatedContexts.delete(key);
  }
}

/** Resolves, creating if needed, the isolated world context id for one frame. */
async function isolatedContextFor(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  frameId: string,
  timeoutMs: number,
): Promise<number> {
  const key = worldKey(sessionId, frameId);
  const cached = isolatedContexts.get(key);
  if (cached !== undefined) return cached;
  const res = (await bridge.send(
    'Page.createIsolatedWorld',
    {
      frameId,
      worldName: ISOLATED_WORLD_NAME,
      // Never. Universal access would let the isolated world reach across
      // origins into other frames, which is exactly the reach the main
      // world does not have and this option must not quietly add.
      grantUniveralAccess: false,
    },
    sessionId,
    { timeoutMs },
  )) as { executionContextId?: number } | undefined;
  const id = res?.executionContextId;
  if (typeof id !== 'number') {
    throw new CdpError('E_CDP_PROTOCOL', {
      kind: 'protocol',
      message: 'Page.createIsolatedWorld returned no executionContextId.',
    });
  }
  isolatedContexts.set(key, id);
  return id;
}

/** Does this CDP failure mean the cached isolated world is gone? */
function isStaleContext(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /cannot find context|context with specified id|execution context was destroyed/i.test(msg);
}

/** A JavaScript exception raised inside the page. */
export interface EvaluateException {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

/**
 * Every way an evaluation can end, as data. Note that four of the five are
 * NOT failures of this function: only a `CdpError` throw (the command did
 * not complete at all) leaves this module as an exception, and that is
 * deliberate, because "the page threw" and "the socket died" want different
 * answers from the layer above and must not arrive looking the same.
 */
export type EvaluateOutcome =
  /** The script produced a JSON-representable value. */
  | { readonly kind: 'value'; readonly value: unknown; readonly sizeBytes: number }
  /** The script produced `undefined`. Distinct from a `null` value, which JSON cannot tell apart. */
  | { readonly kind: 'undefined' }
  /** The script produced something that cannot cross by value: a JSON-inexpressible primitive (`unserializableValue`) or a live object (`description`). No handle is returned either way. */
  | {
      readonly kind: 'unserializable';
      readonly unserializableValue?: string;
      readonly description?: string;
    }
  /** The script threw, or the promise it returned rejected. */
  | { readonly kind: 'exception'; readonly exception: EvaluateException }
  /** The script produced a value larger than {@link EvaluateRequest.maxResultBytes}. The value is discarded here rather than passed up, so nothing above this line can accidentally serialise it anyway. */
  | { readonly kind: 'too_large'; readonly sizeBytes: number; readonly maxBytes: number };

/** How much of a page-side stack is kept. Long enough to name the frame that threw, short enough that a deep recursion's stack cannot dominate a control message. */
const MAX_STACK_CHARS = 4096;
/** How much of a page-side exception message is kept. */
const MAX_MESSAGE_CHARS = 2048;
/** How much of a live object's description is kept (`'HTMLDivElement'`, `'function () { ... }'`). */
const MAX_DESCRIPTION_CHARS = 512;

/**
 * The extra time, in milliseconds, the socket-level timeout gets over the
 * in-page one.
 *
 * Both are armed, and the order matters. `Runtime.evaluate`'s own `timeout`
 * parameter makes V8 TERMINATE the running script, which is the only thing
 * that actually stops `while (true) {}` from pinning a renderer thread for
 * the life of the browser; a socket timeout alone would abandon the request
 * and leave the page spinning forever. But `timeout` is an experimental CDP
 * parameter, so an endpoint that ignores it must not be able to hang the
 * caller either. Giving the socket deadline a margin means the in-page one
 * wins whenever it works (the caller gets a real, attributable timeout) and
 * the socket one is a genuine backstop rather than a race.
 */
const SOCKET_TIMEOUT_MARGIN_MS = 2000;

/**
 * UTF-8 byte length of `s`, without allocating an encoded copy of it.
 *
 * `Buffer.byteLength` would be shorter, but nothing else in
 * `@browserglass/core` reaches for `Buffer` and this module is not the
 * place to start; `new TextEncoder().encode(s).length` is portable but
 * allocates a second megabyte to measure the first one, on a hot path whose
 * whole purpose is deciding whether a megabyte is too much.
 */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      // A surrogate pair is one code point, four UTF-8 bytes, and consumes
      // two UTF-16 units. A lone surrogate (no low surrogate following)
      // falls through to the three-byte branch, matching what an encoder
      // does with the replacement character.
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Builds the expression actually sent to the page.
 *
 * For `functionDeclaration`, the function source and its JSON arguments are
 * composed into ONE expression rather than going through
 * `Runtime.callFunctionOn`. `callFunctionOn` needs a receiver, which means
 * either an `objectId` (the live handle this whole module refuses to deal
 * in) or an `executionContextId` (which needs `Runtime.enable` plus
 * bookkeeping on `Runtime.executionContextCreated`, and which would put a
 * second, separately addressable context selector into the plumbing for no
 * gain). Composing into a single `Runtime.evaluate` keeps the CDP surface
 * at exactly one method and costs one round trip instead of two.
 *
 * The arguments are embedded with `JSON.stringify`, which is exact for the
 * JSON values the wire allows, with U+2028 and U+2029 escaped: both are
 * legal inside a JSON string and were illegal inside a JavaScript string
 * literal before ES2019, and escaping them costs nothing while removing a
 * whole class of "works until the page content contains a line separator"
 * surprise.
 *
 * A `functionDeclaration` that is not a valid function expression produces a
 * page-side `SyntaxError`, which comes back through the ordinary exception
 * path as data. That is the right answer: a caller's malformed source is
 * the caller's bug and it wants the page's own message, not a wire error.
 */
function buildExpression(req: EvaluateRequest): string {
  if (req.expression !== undefined) return req.expression;
  const args = (req.args ?? []).map((a) => jsLiteral(a)).join(', ');
  return `(${req.functionDeclaration}).call(globalThis${args.length > 0 ? `, ${args}` : ''})`;
}

function jsLiteral(value: unknown): string {
  // `undefined` is not JSON, and `JSON.stringify(undefined)` is the string
  // `undefined`... except it returns the VALUE undefined, which would
  // splice the literal text "undefined" into the expression via template
  // interpolation. Spelling it out is clearer than relying on that.
  if (value === undefined) return 'undefined';
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The subset of a CDP `RemoteObject` this module reads. */
interface RemoteObject {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

/** The subset of CDP `ExceptionDetails` this module reads. */
interface ExceptionDetails {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: RemoteObject;
}

/**
 * Runs `req` in the page behind `sessionId` and returns a defined outcome
 * for every completion, throwing only when the CDP command itself did not
 * complete (in which case the throw is a `CdpError`, already carrying
 * `kind`/`code`/`retryable` for the layer above to map).
 */
export async function evaluateInSession(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  req: EvaluateRequest,
): Promise<EvaluateOutcome> {
  const expression = buildExpression(req);
  const params: Record<string, unknown> = {
    expression,
    // Always. The absence of this flag is what produces an `objectId`, and
    // an `objectId` is the escalation this module exists to not hand out.
    returnByValue: true,
    // Default true, unlike CDP's own default, so `await` in an expression
    // does what it looks like it does. See `PageEvaluate.awaitPromise`.
    awaitPromise: req.awaitPromise !== false,
    userGesture: req.userGesture === true,
    // In-page termination. See SOCKET_TIMEOUT_MARGIN_MS.
    timeout: req.timeoutMs,
    // Never `true`: a throw inside the page is an ordinary outcome this
    // function reports as data, and asking CDP to pause the debugger on it
    // would freeze the renderer waiting for a debugger nobody is attaching.
    silent: false,
    // No `contextId`/`uniqueContextId` is ever taken from a caller, which
    // is escalation path 1 in `PageEvaluate`'s own doc comment. When
    // `world: 'isolated'` is asked for, the id below is one THIS module
    // created, for a frame the caller's own registry resolved, so a caller
    // still cannot name a context it was never handed.
  };

  const wantsIsolated = req.world === 'isolated';
  if (wantsIsolated) {
    if (req.frameId === undefined) {
      throw new CdpError('E_CDP_PROTOCOL', {
        kind: 'protocol',
        message: "world: 'isolated' needs a frameId resolved by the caller's own target registry.",
      });
    }
    params['contextId'] = await isolatedContextFor(bridge, sessionId, req.frameId, req.timeoutMs);
  }

  let raw: unknown;
  try {
    try {
      raw = await bridge.send('Runtime.evaluate', params, sessionId, {
        timeoutMs: req.timeoutMs + SOCKET_TIMEOUT_MARGIN_MS,
      });
    } catch (err) {
      // The one repair. An isolated world dies with its frame and nothing
      // tells us, because `Runtime` is never enabled here, so the first
      // evaluation after a navigation is expected to fail exactly once
      // against a context id that no longer resolves. Rebuild the world and
      // run it again. Anything that is not a stale context, and any failure
      // on the second attempt, falls through to the handler below unchanged.
      if (!wantsIsolated || req.frameId === undefined || !isStaleContext(err)) throw err;
      isolatedContexts.delete(worldKey(sessionId, req.frameId));
      params['contextId'] = await isolatedContextFor(bridge, sessionId, req.frameId, req.timeoutMs);
      raw = await bridge.send('Runtime.evaluate', params, sessionId, {
        timeoutMs: req.timeoutMs + SOCKET_TIMEOUT_MARGIN_MS,
      });
    }
  } catch (err) {
    // A `CdpError` propagates as-is: the caller distinguishes a timeout
    // (`E_CDP_TIMEOUT`) from a dead session (`E_CDP_DETACHED`,
    // `E_CDP_TARGET_CLOSED`) from a genuine protocol failure, and each maps
    // to a different wire error. Anything else is wrapped so the caller
    // never has to handle a bare `unknown`.
    if (err instanceof CdpError) throw err;
    throw new CdpError('E_CDP_SERVER_ERROR', {
      kind: 'protocol',
      method: 'Runtime.evaluate',
      sessionId,
      retryable: false,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  const response = (raw ?? {}) as { result?: RemoteObject; exceptionDetails?: ExceptionDetails };

  if (response.exceptionDetails) {
    return { kind: 'exception', exception: toException(response.exceptionDetails) };
  }

  const result = response.result ?? {};

  if (result.type === 'undefined') return { kind: 'undefined' };

  if (result.unserializableValue !== undefined) {
    // `NaN`, `Infinity`, `-Infinity`, `-0`, `123n`. JavaScript can name
    // these; JSON cannot. The source text is returned so a caller can at
    // least see what it got rather than a silent `null`.
    return { kind: 'unserializable', unserializableValue: result.unserializableValue };
  }

  if (result.value === undefined) {
    // `returnByValue: true` and still no `value`: the result was a live
    // object Chrome would not serialise (a DOM node, a function, `window`,
    // a cyclic structure). `objectId` may well be present on `result` here
    // and is DELIBERATELY not read: returning it would hand the caller the
    // very handle this module refuses to deal in. What goes back instead is
    // a description a human can act on.
    const description = result.description ?? result.className ?? result.subtype ?? result.type;
    return {
      kind: 'unserializable',
      ...(description !== undefined
        ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) }
        : {}),
    };
  }

  const json = JSON.stringify(result.value);
  // `JSON.stringify` returns `undefined` for a value it cannot represent at
  // the top level. `result.value` came out of a JSON response so this should
  // not happen, but treating it as zero bytes and shipping it would put a
  // hole in the size accounting, so it is reported honestly instead.
  if (json === undefined) return { kind: 'unserializable', description: typeof result.value };

  const sizeBytes = utf8ByteLength(json);
  if (sizeBytes > req.maxResultBytes) {
    return { kind: 'too_large', sizeBytes, maxBytes: req.maxResultBytes };
  }
  return { kind: 'value', value: result.value, sizeBytes };
}

/**
 * Maps CDP `ExceptionDetails` onto {@link EvaluateException}.
 *
 * The page's OWN message is preferred over CDP's `text`, which is usually
 * the generic `'Uncaught'`. A non-Error throw (`throw 'nope'`,
 * `throw {code: 7}`) has no `.message`, so the object's `description` is
 * used, which is what a caller reading their own logs would recognise.
 *
 * Line and column numbers are CDP's 0-based values raised to 1-based, which
 * is what every editor and every stack trace a developer has ever read
 * uses. Reporting CDP's raw 0-based numbers would be defensible and would
 * also be off by one for every single reader.
 */
function toException(details: ExceptionDetails): EvaluateException {
  const thrown = details.exception;
  const message =
    (typeof thrown?.value === 'string' ? thrown.value : undefined) ??
    extractMessage(thrown) ??
    thrown?.description ??
    details.text ??
    'evaluation threw';
  const name = thrown?.className;
  const stack =
    typeof thrown?.description === 'string' && thrown.description.includes('\n')
      ? thrown.description
      : undefined;
  return {
    message: message.slice(0, MAX_MESSAGE_CHARS),
    ...(name !== undefined ? { name } : {}),
    ...(stack !== undefined ? { stack: stack.slice(0, MAX_STACK_CHARS) } : {}),
    ...(details.lineNumber !== undefined ? { lineNumber: details.lineNumber + 1 } : {}),
    ...(details.columnNumber !== undefined ? { columnNumber: details.columnNumber + 1 } : {}),
  };
}

/**
 * Pulls `.message` out of a thrown Error that Chrome returned by value.
 * With `returnByValue: true` an `Error` serialises to `{}` in most Chrome
 * builds (its own properties are non-enumerable), so this succeeds only
 * when the page threw something whose `message` really is an own
 * enumerable string; the `description` fallback in {@link toException}
 * covers the ordinary case.
 */
function extractMessage(thrown: RemoteObject | undefined): string | undefined {
  const value = thrown?.value;
  if (value !== null && typeof value === 'object' && 'message' in value) {
    const m = (value as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}
