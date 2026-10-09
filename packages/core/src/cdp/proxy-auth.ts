/**
 * `ProxyAuthHandler`: answers `Fetch.authRequired` challenges for one CDP
 * session with credentials from `BrowserSpec.proxy.username`/`password`
 * (`@browserglass/protocol`'s `entities.ts`), so an upstream proxy that
 * demands Basic/Digest authentication does not simply fail every request.
 *
 * `packages/runtime-host/src/flags.ts` already explains why this cannot be
 * a launch flag: Chrome has none for proxy credentials, only the CDP
 * `Fetch.enable`/`handleAuthRequests`/`Fetch.continueWithAuth` dance, which
 * needs a live CDP session that package never holds. This is that dance,
 * built where a live session actually exists: `packages/core`'s CDP layer.
 * Modelled on browser-use's `_setup_proxy_auth`
 * (`browser_use/browser/session.py:2022`), with one behavioural difference
 * recorded below (this build never disables `Fetch` on the browser-scoped
 * "root" connection the way browser-use's dual root+session enable does,
 * because this build has no browser-scoped CDP session at all, flat
 * sessions only; every enable here is per attached target session, exactly
 * where `RequestGate` already lives).
 *
 * ── The central design problem: two independent `Fetch` consumers ──
 *
 * `../interception/request-gate.ts`'s `RequestGate` already owns `Fetch`
 * for a submit gate, `requestStage: 'Request'` only, `handleAuthRequests`
 * never mentioned (so implicitly `false`). CDP keeps only the LAST
 * `Fetch.enable` a session received: `patterns` and `handleAuthRequests`
 * are one config, not additive across two separate calls, and
 * `Fetch.disable` turns the domain off for anyone using it. Two objects
 * that each believe they own `Fetch.enable`/`Fetch.disable` on the same
 * session will silently fight, and whichever calls last wins entirely,
 * undoing the other with no error raised anywhere.
 *
 * This is solved at `../cdp/bridge.ts`, not in either consumer class:
 * `CdpBridge.armProxyAuth`/`disarmProxyAuth` are the only calls THIS class
 * makes to change `Fetch`'s state, and `CdpBridge.send()` itself
 * special-cases `Fetch.enable`/`Fetch.disable` (see that file's own
 * comment on the block) so that a PLAIN caller's own `Fetch.enable`
 * (`RequestGate.start()`/`rebind()`, calling `bridge.send()` exactly as it
 * always has, completely unaware this class exists) gets composed with
 * whatever this class has armed, instead of silently discarding it. Two
 * things make that composition safe rather than a guess:
 *
 *  1. The patterns union is always the same fixed value, "Request stage,
 *     matches everything", regardless of which of the two is present.
 *     `RequestGate` always asks for exactly that (see its own module doc:
 *     "narrowing belongs in the handler ... not the CDP filter", a
 *     deliberately unconfigurable choice), and this class needs the same
 *     catchall whether or not `RequestGate` is around, for reason 2.
 *  2. `patterns: [{urlPattern: '*'}], handleAuthRequests: true` is
 *     Puppeteer's own real, shipped shape for "credentials are set, but
 *     the app never asked for real request interception"
 *     (`NetworkManager.ts`'s `#applyProtocolRequestInterception`, verified
 *     against the current source: it is NOT an empty `patterns` array
 *     scoped to auth only, an assumption this file started from and had
 *     to correct against the real implementation). Puppeteer's own
 *     `#onRequestPaused` then continues every non-auth pause
 *     UNCONDITIONALLY whenever request interception was enabled only for
 *     credentials, not by the app. `subscribeRequestPaused` below is that
 *     same fallback, gated on {@link CdpBridge.hasPlainFetchInterception}:
 *     when `RequestGate` is NOT present on this session, this class is the
 *     only thing that will ever see `Fetch.requestPaused` and MUST
 *     continue it or the page's own network traffic stalls forever behind
 *     a domain nothing is answering. When `RequestGate` IS present, it
 *     already owns every `Fetch.requestPaused` on that session (verdicts,
 *     timeouts, the whole security argument in its own module doc), and
 *     this class's own handler defers instead of racing it: two
 *     `Fetch.continueRequest` calls for the same `requestId`, one from
 *     each class, would mean whichever lost the race sent a command
 *     against an already-continued request, and worse, would let a
 *     request straight through instants before `RequestGate`'s own
 *     verdict (up to `verdictTimeoutMs`) has even run, which is exactly
 *     the "silently disable the other" failure mode this whole design
 *     exists to prevent, just inverted.
 *
 * This class never itself sends `Fetch.enable`/`Fetch.disable`: every
 * change to `Fetch`'s state goes through `armProxyAuth`/`disarmProxyAuth`,
 * so the composition above is the ONLY place that ever decides the wire
 * shape.
 *
 * ── Credentials must never leak ──
 *
 * `credentials.password` reaches the wire exactly once, inside
 * `Fetch.continueWithAuth`'s own `authChallengeResponse`, which is CDP's
 * documented, correct carrier for it. It must never appear anywhere else:
 * not in a thrown error, not in an `onError` report, not in a log line
 * (this class has no logger, on purpose, matching every other file in
 * `../cdp/`), and not echoed back into any diagnostics or wire surface.
 * `onError` below is handed the raw `unknown` a rejected `bridge.send()`
 * throws, which is always a `CdpError` (`./errors.ts`): that class carries
 * `method`/`sessionId`/`targetId`/`elapsedMs`/Chrome's own error text, and
 * structurally has no field an outbound `params` object could land in, so
 * passing it through unmodified cannot leak the password by construction.
 * See `test/cdp/proxy-auth.test.ts`'s dedicated "never leaks" assertion.
 *
 * ── Re-arming: every path that mints a new session ──
 *
 * `start()`/`rebind()`/`stop()`/`isArmed` mirror `RequestGate`'s own
 * shape exactly, same reasoning: CDP domain enables are per SESSION, and a
 * session that has never had `armProxyAuth` called on it answers no
 * auth challenge at all, Chrome's own default kicking in instead
 * (typically a cancelled request), which for a proxy that REQUIRES
 * credentials looks exactly like an intermittent proxy outage. The one
 * caller that re-arms this class, `../cdp/target-registry.ts`'s
 * `installProxyAuth`, is invoked from the same two seams that already
 * survive a cross origin navigation for init scripts and stealth
 * (`TargetRegistryImpl.attach()` and `.handleAttachedToTarget()`), and
 * `recovery-target.ts`'s `reattachSession` (a transport reconnect's real
 * recovery path, per `../cdp/reconnect.ts`'s and `bridge.ts`'s own docs on
 * `invalidateSessionsAfterTransportDrop` synthesizing a fresh
 * `Target.detachedFromTarget`) calls `registry.attach()` too, so all three
 * of cross origin navigation, an ordinary re-attach, and a transport
 * reconnect converge on that one seam without this class needing to know
 * about any of them individually.
 */

import type { CdpBridge } from './bridge.js';
import type { CdpSessionId, Unsubscribe } from './types.js';

/** Proxy credentials for one Instance. Never logged, never echoed onto any wire surface other than `Fetch.continueWithAuth`'s own `authChallengeResponse`. */
export interface ProxyAuthCredentials {
  readonly username: string;
  readonly password: string;
}

export interface ProxyAuthHandlerOptions {
  readonly bridge: CdpBridge;
  readonly sessionId: CdpSessionId;
  readonly credentials: ProxyAuthCredentials;
  /**
   * Reports a `Fetch.continueWithAuth` (or the non-auth `Fetch.continueRequest`
   * fallback, see the module doc's point 2) that rejected. Never receives
   * anything containing `credentials.password`; see the module doc's
   * "credentials must not leak" section for why that is true by
   * construction and not merely by convention.
   */
  readonly onError?: (err: unknown) => void;
}

export class ProxyAuthHandler {
  private readonly bridge: CdpBridge;
  private readonly credentials: ProxyAuthCredentials;
  private readonly onError: ((err: unknown) => void) | undefined;

  private sessionId: CdpSessionId;
  private unsubs: Unsubscribe[] = [];
  /** Whether `armProxyAuth` is currently in force FOR `this.sessionId`. Never assumed from any other module's state, mirroring `RequestGate.enabled`'s own precedent. */
  private armed = false;
  private stopped = false;

  constructor(opts: ProxyAuthHandlerOptions) {
    this.bridge = opts.bridge;
    this.sessionId = opts.sessionId;
    this.credentials = opts.credentials;
    this.onError = opts.onError;
  }

  /** True only when `armProxyAuth` actually succeeded for the current session, mirroring `RequestGate.isArmed`'s own honesty rule: "is it really on", not "did somebody ask". */
  get isArmed(): boolean {
    return this.armed && !this.stopped;
  }

  /** Subscribes and arms proxy credential handling. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error('ProxyAuthHandler: cannot start() after stop()');
    }
    if (this.armed) {
      return;
    }
    this.subscribe();
    await this.bridge.armProxyAuth(this.sessionId);
    this.armed = true;
  }

  /**
   * Re-arms against a new CDP session after a renderer swap, a re-attach,
   * or a transport reconnect. See the module doc's "Re-arming" section for
   * why every one of those converges on `target-registry.ts` calling this.
   */
  async rebind(sessionId: CdpSessionId): Promise<void> {
    if (this.stopped) {
      return;
    }
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.armed = false;
    this.sessionId = sessionId;
    await this.start();
  }

  /** Disarms proxy credential handling, if this handler armed it, and drops every listener. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const wasArmed = this.armed;
    this.armed = false;
    if (!wasArmed) {
      return;
    }
    await this.bridge.disarmProxyAuth(this.sessionId).catch(() => {
      // The session may already be gone; nothing left to clean up either way.
    });
  }

  private subscribe(): void {
    const boundSession = this.sessionId;
    this.unsubs.push(
      this.bridge.on(
        'Fetch.authRequired',
        (params, sessionId) => {
          // Re-checked even though `CdpBridge.on` is already keyed per
          // `(sessionId, event)`: a `rebind()` can run synchronously ahead
          // of an event already in flight for the old session, matching
          // `RequestGate.subscribe`'s own precedent for the identical race.
          if (sessionId !== boundSession || boundSession !== this.sessionId) return;
          void this.handleAuthRequired(params);
        },
        boundSession,
      ),
      this.bridge.on(
        'Fetch.requestPaused',
        (params, sessionId) => {
          if (sessionId !== boundSession || boundSession !== this.sessionId) return;
          void this.handleRequestPaused(params);
        },
        boundSession,
      ),
    );
  }

  private async handleAuthRequired(params: Record<string, unknown>): Promise<void> {
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null;
    if (requestId === null) return;
    const sessionId = this.sessionId;

    const challenge = (params['authChallenge'] ?? {}) as Record<string, unknown>;
    const source = typeof challenge['source'] === 'string' ? challenge['source'] : '';

    if (source !== 'Proxy') {
      // Not this proxy's challenge to answer: a site's own `401` Basic auth
      // prompt must never receive the upstream proxy's credentials.
      // `'Default'` defers to Chrome's own handling (ordinarily the request
      // fails as an unauthenticated site would show a browser), the same
      // choice browser-use's own non-proxy branch makes.
      await this.bridge
        .send(
          'Fetch.continueWithAuth',
          { requestId, authChallengeResponse: { response: 'Default' } },
          sessionId,
        )
        .catch((err: unknown) => this.onError?.(err));
      return;
    }

    await this.bridge
      .send(
        'Fetch.continueWithAuth',
        {
          requestId,
          authChallengeResponse: {
            response: 'ProvideCredentials',
            username: this.credentials.username,
            password: this.credentials.password,
          },
        },
        sessionId,
      )
      .catch((err: unknown) => this.onError?.(err));
  }

  private async handleRequestPaused(params: Record<string, unknown>): Promise<void> {
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null;
    if (requestId === null) return;

    // `armProxyAuth` only ever asks for the Request stage; a Response stage
    // pause reaching here would mean something else enabled `Fetch` for
    // that stage. Continue it untouched rather than deciding on it,
    // mirroring `RequestGate`'s own identical guard.
    if ('responseStatusCode' in params || 'responseErrorReason' in params) {
      await this.continueUnconditionally(requestId);
      return;
    }

    // See the module doc's point 2: `RequestGate`, when present on this
    // session, already owns every `Fetch.requestPaused` verdict. Answering
    // it here too would race its own (up to `verdictTimeoutMs`-long)
    // decision and could let a request through before the gate ever ruled
    // on it, which is the exact failure this design exists to prevent.
    if (this.bridge.hasPlainFetchInterception(this.sessionId)) {
      return;
    }

    await this.continueUnconditionally(requestId);
  }

  /**
   * `Fetch.continueRequest` with the request id and nothing else, the same
   * restraint `RequestGate.continue` documents for the same reason: this
   * class has no verdict to apply here at all, it exists only to keep
   * traffic moving on a session `RequestGate` is not managing.
   */
  private async continueUnconditionally(requestId: string): Promise<void> {
    await this.bridge
      .send('Fetch.continueRequest', { requestId }, this.sessionId)
      .catch((err: unknown) => {
        // A request whose renderer died mid flight cannot be continued;
        // nothing to recover, matching `RequestGate.continue`'s own precedent.
        this.onError?.(err);
      });
  }
}
