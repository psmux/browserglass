/**
 * `RequestGate`: an allow or deny verdict on every outbound request one
 * Target makes, driven directly by a `CdpBridge` + `CdpSessionId`.
 *
 * ── Why this class exists rather than opening `Fetch` to callers ──
 *
 * `Fetch` is on `REFUSED_DOMAINS` in
 * `packages/server/src/rest/cdp-passthrough-allowlist.ts`, and it stays
 * there. That refusal is not bureaucratic: `Fetch.fulfillRequest` lets a
 * caller invent a response body for any URL, which is response forgery,
 * and `Fetch.continueRequest` accepts rewritten `url`, `method`,
 * `headers` and `postData`, which is an egress bypass that no allowlist
 * can inspect because the destination it names is not the destination
 * that was requested. Handing a tenant the raw domain hands it both.
 *
 * What a caller actually needs (a form-submit gate, say) is much smaller: a say in whether a
 * request is allowed to leave. So the gateway owns the domain and the
 * caller owns a verdict, and the verdict vocabulary is exactly two words.
 *
 * This is the same move `page.evaluate` made against a blanket `Runtime`
 * refusal (`packages/protocol/src/wire/messages/evaluate.ts`, read its
 * module doc): the escalation is closed by the SHAPE of what crosses the
 * boundary, not by a runtime check that has to be right every time. There
 * is no field in {@link RequestVerdict} in which a body, a header, a
 * method or a URL could be spelled, so no amount of cleverness on the
 * caller's side reaches `fulfillRequest` or a rewritten `continueRequest`.
 * A future maintainer who adds such a field is re-opening the hole, and
 * that is the one review rule this file has.
 *
 * ── What an operator gives up, stated plainly ──
 *
 * A tenant holding this gate can refuse ANY request the page makes,
 * including the operator's own telemetry, consent, or audit scripts. This
 * is an egress VETO rather than an egress bypass, which is the lesser of
 * the two, but it is real and there is no way to offer a useful gate
 * while withholding it. An operator who cannot accept that should not
 * register a gate; nothing enables `Fetch` unless one is registered.
 *
 * ── Domain ownership ──
 *
 * Nothing else in this build enables `Fetch`; confirmed by grep across
 * `packages/core/src` and `packages/server/src` before this file was
 * written. This class is therefore the sole owner of `Fetch` for a
 * target: it enables it only when a gate is actually registered, and
 * disables exactly what it enabled, tracked in {@link enabled} rather
 * than assumed.
 *
 * `requestStage: 'Request'` ONLY, never `'Response'`. At the Request
 * stage `Fetch.getResponseBody` and `Fetch.continueResponse` are not
 * applicable at all, so response inspection and response rewriting are
 * unreachable by construction rather than by policy.
 *
 * ── The failure mode that matters most ──
 *
 * CDP domain enables are per SESSION. A cross origin navigation swaps the
 * renderer process and kills the session; the Target survives under a new
 * session id with `Fetch` no longer enabled. A gate that does not re-arm
 * across that swap FAILS OPEN, silently, with no error anywhere, and for
 * a submit gate failing open is the worst possible outcome:
 * `TargetDiagnostics` hit exactly this bug and `rebind()` is the seam it
 * introduced to fix it. This class implements the same seam and
 * `Session.rebuildCaptureAndDiagnostics` calls it alongside the
 * diagnostics one.
 *
 * Because failing open is the danger, {@link paused} counts requests
 * currently held. A caller that wants to know whether the gate is really
 * armed should look at {@link isArmed}, which reports the domain state
 * this class last successfully set, not the state it intended.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../cdp/types.js';

/**
 * The only two things a gate may say. Deliberately not an object with
 * optional override fields; see this module's doc for why that shape is
 * the whole security argument.
 */
export type RequestVerdict = 'allow' | 'deny';

/** What the gate is asked about. Read only, and everything here is already visible to the caller's own page. */
export interface GatedRequest {
  readonly requestId: string;
  readonly targetId: string;
  readonly url: string;
  readonly method: string;
  /** Chrome's `Network.ResourceType`: `Document`, `XHR`, `Fetch`, `Script`, `Image`, and so on. */
  readonly resourceType: string;
  /** Present only when Chrome supplied it and the request actually carries one. Never synthesised. */
  readonly postData?: string;
  /** Request headers as Chrome reported them, lower cased keys. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Decides one request. Returning anything other than `'deny'` allows, so a handler that throws is handled by {@link RequestGateOptions.onError} and does not accidentally read as a deny. */
export type RequestGateHandler = (req: GatedRequest) => RequestVerdict | Promise<RequestVerdict>;

export interface RequestGateOptions {
  readonly bridge: CdpBridge;
  readonly targetId: string;
  readonly sessionId: CdpSessionId;
  readonly handler: RequestGateHandler;
  /**
   * How long one verdict may take before {@link RequestGateOptions.onTimeoutVerdict}
   * is applied. A held request occupies a real Chrome network slot, so
   * this is a bound on self-inflicted damage as much as on latency.
   */
  readonly verdictTimeoutMs?: number;
  /**
   * What a timed out or thrown verdict counts as. Defaults to `'deny'`:
   * a gate that fails open is not a gate, and the typical use is stopping
   * form submissions. An operator who would rather
   * lose the gate than lose the page can pass `'allow'`.
   */
  readonly onTimeoutVerdict?: RequestVerdict;
  /** Reports a handler that threw or timed out. Never throws back into the gate. */
  readonly onError?: (err: unknown, req: GatedRequest) => void;
}

const DEFAULT_VERDICT_TIMEOUT_MS = 1500;

/**
 * How many requests may be held awaiting a verdict at once before the
 * gate stops asking and applies {@link RequestGateOptions.onTimeoutVerdict}
 * directly.
 *
 * A page under load issues hundreds of requests, each one held pending a
 * round trip to a caller that may be slow or wedged. Without a ceiling a
 * single unresponsive handler converts into an unbounded queue of paused
 * requests and a page that never finishes loading, which looks to
 * everyone involved like the browser broke rather than like the gate did.
 */
const MAX_CONCURRENT_HOLDS = 64;

const TIMEOUT = Symbol('verdict-timeout');

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class RequestGate {
  private readonly bridge: CdpBridge;
  private readonly targetId: string;
  private readonly handler: RequestGateHandler;
  private readonly verdictTimeoutMs: number;
  private readonly timeoutVerdict: RequestVerdict;
  private readonly onError: ((err: unknown, req: GatedRequest) => void) | undefined;

  private sessionId: CdpSessionId;
  private unsubs: Unsubscribe[] = [];
  /** Whether `Fetch.enable` is currently in force FOR `this.sessionId`. Never assumed from any other module's state. */
  private enabled = false;
  private stopped = false;
  private held = 0;
  private allowed = 0;
  private denied = 0;

  constructor(opts: RequestGateOptions) {
    this.bridge = opts.bridge;
    this.targetId = opts.targetId;
    this.sessionId = opts.sessionId;
    this.handler = opts.handler;
    this.verdictTimeoutMs = opts.verdictTimeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS;
    this.timeoutVerdict = opts.onTimeoutVerdict ?? 'deny';
    this.onError = opts.onError;
  }

  /** True only when `Fetch.enable` actually succeeded for the current session. This is the honest answer to "is the gate really on", which is not the same question as "did somebody ask for a gate". */
  get isArmed(): boolean {
    return this.enabled && !this.stopped;
  }

  /** Requests currently held awaiting a verdict, plus the running verdict tally. For diagnostics and for spotting a wedged handler. */
  get stats(): { readonly held: number; readonly allowed: number; readonly denied: number } {
    return { held: this.held, allowed: this.allowed, denied: this.denied };
  }

  /** Subscribes and enables `Fetch` at the Request stage. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('RequestGate: cannot start() after stop()');
    if (this.enabled) return;
    this.subscribe();
    // `patterns` deliberately matches everything: a gate that only saw
    // some requests would be a gate the caller had to reason about the
    // gaps in. Narrowing belongs in the handler, which can answer
    // `'allow'` in one comparison, not in the CDP filter.
    await this.bridge.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      this.sessionId,
    );
    this.enabled = true;
  }

  /**
   * Re-arms against a new CDP session after a renderer swap.
   *
   * This is the method the whole class exists to get right. See the module
   * doc: without it, a cross origin navigation silently disarms the gate
   * and every subsequent request is allowed with no error raised anywhere.
   */
  async rebind(sessionId: CdpSessionId): Promise<void> {
    if (this.stopped) return;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // The old session is gone, so every request held against it is gone
    // with it: there is nothing left to continue or fail, and the counter
    // must not carry the dead holds forward or the concurrency ceiling
    // would leak downward on every navigation.
    this.held = 0;
    this.enabled = false;
    this.sessionId = sessionId;
    await this.start();
  }

  /** Disables `Fetch` if this gate enabled it, and drops every listener. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.held = 0;
    if (!wasEnabled) return;
    await this.bridge.send('Fetch.disable', undefined, this.sessionId).catch(() => {
      // The session may already be gone (target closed, renderer swapped
      // without a rebind landing). A disable that never reaches the
      // browser leaves nothing to clean up on this end either way.
    });
  }

  private subscribe(): void {
    const boundSession = this.sessionId;
    this.unsubs.push(
      this.bridge.on(
        'Fetch.requestPaused',
        (params, sessionId) => {
          // Re-checked even though `CdpBridge.on` is already keyed per
          // `(sessionId, event)`: a `rebind()` can run synchronously ahead
          // of an event that was already in flight for the old session,
          // and letting that event through would mutate `held` for a
          // session this gate no longer speaks for.
          if (sessionId !== boundSession || boundSession !== this.sessionId) return;
          void this.handlePaused(params);
        },
        boundSession,
      ),
    );
  }

  private async handlePaused(params: Record<string, unknown>): Promise<void> {
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null;
    if (requestId === null) return;

    // A `responseStatusCode`/`responseErrorReason` on the event means this
    // is a Response stage pause. `Fetch.enable` above never asks for that
    // stage, so reaching here would mean somebody else enabled `Fetch` on
    // this session. Continue it untouched rather than deciding on it: this
    // gate answers for the stage it asked for and no other.
    if ('responseStatusCode' in params || 'responseErrorReason' in params) {
      await this.continue(requestId);
      return;
    }

    const raw = (params['request'] ?? {}) as Record<string, unknown>;
    const rawHeaders = (raw['headers'] ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }

    const req: GatedRequest = {
      requestId,
      targetId: this.targetId,
      url: typeof raw['url'] === 'string' ? raw['url'] : '',
      method: typeof raw['method'] === 'string' ? raw['method'] : 'GET',
      resourceType: typeof params['resourceType'] === 'string' ? params['resourceType'] : 'Other',
      headers,
      ...(typeof raw['postData'] === 'string' ? { postData: raw['postData'] } : {}),
    };

    if (this.held >= MAX_CONCURRENT_HOLDS) {
      // Not asked, so not counted as a verdict the handler gave. The
      // caller is told through `onError` because a gate silently changing
      // its own answer under load is exactly the kind of thing that has
      // to be visible.
      this.onError?.(
        new Error(
          `RequestGate: ${this.held} requests already held (ceiling ${MAX_CONCURRENT_HOLDS}); applying the timeout verdict without asking`,
        ),
        req,
      );
      await this.apply(this.timeoutVerdict, requestId);
      return;
    }

    this.held += 1;
    let verdict: RequestVerdict;
    try {
      const outcome = await withTimeout(Promise.resolve(this.handler(req)), this.verdictTimeoutMs);
      if (outcome === TIMEOUT) {
        this.onError?.(
          new Error(`RequestGate: verdict timed out after ${this.verdictTimeoutMs}ms`),
          req,
        );
        verdict = this.timeoutVerdict;
      } else {
        verdict = outcome === 'deny' ? 'deny' : 'allow';
      }
    } catch (err) {
      this.onError?.(err, req);
      verdict = this.timeoutVerdict;
    } finally {
      this.held -= 1;
    }

    await this.apply(verdict, requestId);
  }

  private async apply(verdict: RequestVerdict, requestId: string): Promise<void> {
    if (verdict === 'deny') {
      this.denied += 1;
      await this.fail(requestId);
      return;
    }
    this.allowed += 1;
    await this.continue(requestId);
  }

  /**
   * `Fetch.continueRequest` with the request id and NOTHING else.
   *
   * The absent fields are the point. This call accepts `url`, `method`,
   * `postData`, `headers` and `interceptHeaders`, and every one of them
   * is an egress rewrite. They are not passed here, there is no parameter
   * anywhere in this class through which a caller could supply one, and
   * that is what makes the gate safe to expose.
   */
  private async continue(requestId: string): Promise<void> {
    await this.bridge.send('Fetch.continueRequest', { requestId }, this.sessionId).catch((err) => {
      // A request whose renderer died mid verdict cannot be continued.
      // Nothing to recover: the navigation that killed it will re-issue
      // whatever still matters.
      this.onError?.(err, {
        requestId,
        targetId: this.targetId,
        url: '',
        method: '',
        resourceType: 'Other',
        headers: {},
      });
    });
  }

  /** `Fetch.failRequest` with `BlockedByClient`, which is the reason Chrome itself reports for an extension blocked request, so the page sees a shape it already knows how to handle. */
  private async fail(requestId: string): Promise<void> {
    await this.bridge
      .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, this.sessionId)
      .catch((err) => {
        this.onError?.(err, {
          requestId,
          targetId: this.targetId,
          url: '',
          method: '',
          resourceType: 'Other',
          headers: {},
        });
      });
  }
}
