/**
 * The raw CDP WebSocket attach proxy: a second, non-viewer upgrade path,
 * mirroring `peer-upgrade.ts`'s own precedent ("Deliberately its own
 * upgrade path... not folded into the `bgls.v1` viewer socket's message
 * loop", that file's top comment) for exactly the same reason. A CDP
 * client speaks a different protocol than `bgls.v1` (Chrome's own wire
 * format, not this project's envelope), is authenticated a different way
 * (a capability-gated bearer token via `?token=`, not a `hello.auth`
 * frame inside the socket), and once attached needs a wide open pipe to
 * Chrome's real CDP endpoint, none of which `Connection` (`ws/connection.ts`)
 * has any seam for.
 *
 * The whole point of this file, stated once because it drives every
 * decision below: BrowserGlass's own router should be reachable the same
 * way any other CDP endpoint is, so a project already built on Playwright
 * (or Puppeteer, or any other CDP driven library) can point
 * `chromium.connect_over_cdp(...)` at a BrowserGlass gateway and migrate
 * incrementally, without adopting `bgls.v1` first. Everything downstream
 * of `Target.attachToTarget`/`Runtime.evaluate` on a real CDP connection
 * has to keep working exactly as it does against bare Chrome, which is
 * why this module does NOT filter methods the way
 * `rest/cdp-passthrough-allowlist.ts` does: see `security.cdpProxyEnabled`'s
 * doc comment (`config/types.ts`) for the full policy argument for why
 * that is a deliberate, opt-in relaxation and not an oversight.
 *
 * Scope: LOCAL instances only (`DriveResolution.local === true`). An
 * instance launched by another node in the deployment has no raw CDP
 * socket reachable from this process; unlike the allowlisted REST
 * passthrough (`RestCdpSender`, one command per request, forwarded through
 * `BrowserRouter.dispatchAction`), a full duplex CDP session cannot be
 * forwarded through that same per-command RPC without building a second,
 * much larger cross node protocol. Refused honestly, with a `501 Not
 * Implemented` upgrade response (there is no JSON body to carry a code in
 * at this layer, only a status line), rather than pretending to work.
 *
 * COLLABORATION: a raw CDP client is a real viewer, not a side channel.
 *
 * The paragraphs above describe reaching Chrome; this one describes
 * joining everyone ELSE looking at the same Chrome, which for a long time
 * this module simply did not do (grep its own history for `lease`,
 * `presence`, or `viewer`: nothing). A Playwright/Puppeteer/
 * chrome-remote-interface client that dialled straight into this proxy was
 * invisible to `presence.state`, held no `ControlLease`, and could drive a
 * tab while a human sat there holding control, which breaks the one
 * promise this whole product makes: a human can always take the wheel.
 * `handleCdpUpgrade` now closes that gap through the SAME model every
 * other viewer joins (`docs/agent-and-human.md`), not a parallel one:
 *
 *  1. PRESENCE. Before the client's own WS handshake completes, this
 *     module calls `ManagedSession.attachViewer()`, exactly what
 *     `ws/connection.ts`'s `freshAttach()` calls for a `bgls.v1` viewer.
 *     The client appears in `presence.state` with `kind: 'agent'` (see
 *     below) and a `label` prefixed `cdp:` (`presenceLabelFor`), so a
 *     roster reads "a program is driving this", not an anonymous `vwr_`
 *     id indistinguishable from a person.
 *
 *  2. KIND: `'agent'`, unconditionally, regardless of whether this
 *     token happens to also carry the `automation` capability (the signal
 *     `ws/connection.ts`'s own viewers are keyed on). That capability
 *     answers "is this token meant for unattended `bgls.v1` driving";
 *     this endpoint answers a different question, "can anything but a
 *     program even speak this wire format", and the answer is always no.
 *     Nothing in a browser, and no human at a keyboard, emits raw CDP
 *     frames over `?token=`; only a library (Playwright, Puppeteer,
 *     chrome-remote-interface, a hand-rolled client like this module's own
 *     probe) does. So every client of this endpoint is unconditionally
 *     `'agent'` for BOTH `presence.state.kind` (UI) and the control
 *     engine's `HolderKind` (priority): `DEFAULT_PRIORITY.agent` (50,
 *     `core/src/control/types.ts`), the same as any other automation
 *     viewer, never elevated. `'service'` (the presence wire type's third
 *     member) is reserved for a DIFFERENT case this same pass also fixes
 *     (`ManagedSession.broadcastPresence()`'s `connectionlessHolders`): a
 *     lease borrowed with no live socket at all (REST driving, a peer
 *     forwarded action). This proxy's clients have a real, persistent
 *     socket and a real presence tenure, exactly like an `AutomationClient`
 *     does; they only speak a different wire protocol to get there. `kind`
 *     is never derived from `automation`'s presence here, unlike
 *     `ws/connection.ts`'s own viewers, because the question this module
 *     answers is not the one that capability was minted to answer.
 *
 *  3. CONTROL, through `ManagedSession.requestControl()` -> the SAME
 *     `ControlLeaseEngine` every viewer's `control.request` reaches, at
 *     `kind: 'agent'`'s ordinary priority, `force: false`, `queue: false`.
 *     Not a bypass: a human (`human: 100`) already holding the session's
 *     one page-type target at attach time outranks it, and with
 *     `queue: false` the engine denies rather than waits. See
 *     REQUIREMENT-3 on `handleCdpUpgrade` below for what this module does
 *     with a denial (refuses the WS upgrade outright) and why, given this
 *     proxy's own documented, deliberate refusal to parse or filter CDP
 *     methods a few paragraphs up: there is no partial-trust state (no
 *     "read-only" raw CDP) this module can honestly hold a socket open in,
 *     so it does not pretend to.
 *
 *     Scoped to ONE target: the session's first `type: 'page'` target at
 *     attach time (`ManagedSession.listTargets(['page'])[0]`), not every
 *     tab. A raw CDP client can, in principle, `Target.attachToTarget`
 *     any tab in the instance, and this module does not parse `Target.*`
 *     traffic to learn which one it actually chose (the same "no
 *     filtering" policy that makes the whole endpoint possible at all), so
 *     protecting every tab would mean holding a lease on tabs the client
 *     may never touch, starving other viewers of targets nobody is
 *     actually contending over. Protecting the one tab that exists at
 *     attach time, which is overwhelmingly the one a fresh
 *     `connect_over_cdp()` call actually drives, is the honest, stated
 *     trade-off made here; a session with zero page targets at
 *     attach time (a launch still in flight) attaches with no lease held
 *     at all rather than blocking on one appearing.
 *
 *  4. PREEMPTION. This proxy's own `ConnectionSink.sendEnvelope`
 *     (`liveClientSink`, below) is the delivery point for every DIRECT
 *     lease effect the engine addresses to this viewer
 *     (`control.preempt.request`, `control.preempted`, `control.revoked`,
 *     `control.denied`, `control.yield.request`): on any of them it closes
 *     the client-facing socket with `CDP_PROXY_CLOSE.CONTROL_LOST`
 *     (4611), immediately, rather than waiting out whatever grace period
 *     the engine offers a cooperative driver. A `bgls.v1` `AutomationClient`
 *     gets that grace because it can act on it (`humanType()` re-checks
 *     `hasControl()` before every character, `onControlYield` runs before
 *     the client dispatches another message); this proxy relays raw bytes
 *     with zero interpretation, so it has no way to stop mid-gesture, only
 *     open or shut. Closing immediately, the instant a human's takeover
 *     BEGINS rather than once it completes, is the conservative reading of
 *     "the CDP client must stop driving": a Playwright/Puppeteer caller
 *     sees its `connect_over_cdp()` session end with a comprehensible close
 *     event, not a hang, and not a live pipe that might still be relaying
 *     a queued command from before the takeover.
 *
 *  5. LIVENESS. `ControlLeaseEngine.recordInput()` requires proof of real
 *     client activity to hold off idle-expiry (`CONTROL_TIMING.idleExpiryMs`,
 *     30s); a `bgls.v1` viewer's own `input.*` messages supply that for
 *     free through `Session.dispatchInput()`, which this proxy's raw pipe
 *     never touches. So `pipe()`'s client-message handler calls it once
 *     per inbound client frame (any frame; this module still does not
 *     parse WHICH CDP method it is, only that the client sent something),
 *     which is the same "any traffic proves the socket is alive" standard
 *     `renewOnInput` already applies elsewhere. TTL renewal
 *     (`ControlLeaseEngine.renew()`) is separate and unconditional, on its
 *     own timer (`LEASE_RENEW_INTERVAL_MS`), matching how a real viewer's
 *     own lease renewal is a liveness signal, not an activity one.
 *
 *  6. CLEANUP. Whatever ends the raw pipe (client close, upstream close,
 *     a lease-loss close this module triggered itself) runs through
 *     `pipe()`'s single `closeBoth`, whose `onClosed` callback releases
 *     any held lease (`ControlLeaseEngine.release`, not left to the
 *     30-second `disconnectGraceMs` a `bgls.v1` reconnect would want: this
 *     socket never resumes, so nothing is served by holding the tenure
 *     open on the chance it might) and then calls
 *     `ManagedSession.detachViewer()`, exactly what `ws/connection.ts`'s
 *     own `onSocketClosed` calls for a `bgls.v1` viewer. No ghost holders,
 *     no ghost presence rows.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { CONTROL_TIMING } from '@browserglass/core';
import type { AuthResolver, Principal } from '@browserglass/protocol';
import type { BrowserRouter } from '@browserglass/router';
import { WebSocketServer, WebSocket as WsClient, type WebSocket as WsWebSocket } from 'ws';
import { AuthError, principalFor } from '../auth/resolver.js';
import type { Logger } from '../config/logger.js';
import { type ManagedSession, newViewerId } from '../session/managed-session.js';
import type { ConnectionSink } from '../session/types.js';
import { sanitizeMessage } from '../wire/sanitize.js';

/** Everything one accepted CDP proxy upgrade needs to authenticate, authorise, and reach the real browser. */
export interface CdpProxyDeps {
  /** `resolved.security.cdpProxyEnabled`. The whole feature is a no-op when false: `handleCdpUpgrade` refuses with 404 before touching anything else. */
  readonly enabled: boolean;
  /** Same resolver `principalFor` (REST and the viewer socket) already use. `undefined` means no auth is configured at all, refused as 401 rather than treated as open. */
  readonly resolver: AuthResolver | undefined;
  /** `resolved.auth.allowQueryToken`. Must be true for this path to ever authenticate anything: see `CdpProxyDeps`'s own module doc and `SecurityConfig.cdpProxyEnabled`'s doc comment for why a query token is the only carrier a raw CDP client can offer. */
  readonly allowQueryToken: boolean;
  readonly getRouter: () => BrowserRouter | undefined;
  /**
   * Resolves (building one if none exists yet) the `ManagedSession` this
   * instance's `bgls.v1` viewers already share, mirroring
   * `ws/connection.ts`'s own `processHello` -> `SessionRegistry.getOrCreate`
   * call exactly (`ctx.tenantId`/`ctx.appId` are threaded through only for
   * a first-time build; a caller joining an already-live session has both
   * ignored). This is what lets a raw CDP client join the SAME presence
   * roster and control lease model every other viewer joins, per this
   * module's own top comment, rather than reaching Chrome through a side
   * channel the rest of `@browserglass/server` cannot see. `undefined`
   * (the field is optional so an existing caller that constructs
   * `CdpProxyDeps` by hand does not fail to compile) is treated the same
   * as `enabled: false` would be further up: refused with 503, never
   * silently skipped.
   */
  readonly getManagedSession?: (
    instanceId: string,
    ctx: { readonly tenantId: string; readonly appId: string },
  ) => Promise<ManagedSession>;
  readonly logger: Logger;
  /** How long the proxy waits for its own outbound connection to the instance's real CDP endpoint before giving up. Default 10000ms. */
  readonly upstreamConnectTimeoutMs?: number;
}

/** Close codes this module uses on the CLIENT facing socket, once it is open. Outside the RFC 6455 reserved range, matching `peer-upgrade.ts`'s own `PEER_CLOSE` table's shape. */
const CDP_PROXY_CLOSE = Object.freeze({
  /** The upstream (real Chrome) connection failed after the client socket was already handed over, or the upstream closed first. */
  UPSTREAM_CLOSED: 4610,
  /**
   * This proxy's own client, holding (or waiting on) a control lease, was
   * told by the `ControlLeaseEngine` that it is losing it, is about to
   * lose it, or was refused it outright: `control.preempted`,
   * `control.revoked`, `control.denied`, `control.preempt.request`, or
   * `control.yield.request` addressed to this viewer. See this module's
   * own top comment, item 4, for why closing is the ONLY tool this proxy
   * has (no per-command gating exists for a connection it does not parse)
   * and why it closes on the WARNING signals too, not only the confirmed
   * ones.
   */
  CONTROL_LOST: 4611,
});

const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How often this proxy renews its client's control lease on its behalf,
 * unconditionally, regardless of real traffic (liveness, not activity; see
 * this module's own top comment, item 5, for the activity half). Well
 * inside `CONTROL_TIMING.renewWithinMs` (15000ms: the remaining-TTL
 * threshold at which a lease is considered due) relative to
 * `CONTROL_TIMING.leaseTtlMs` (60000ms): renewing every 20 seconds means
 * the SECOND renewal always lands with at least 40 seconds of TTL still on
 * the clock, comfortably before `control.expiring`'s own 10-second warning
 * window could ever fire under normal operation.
 */
const LEASE_RENEW_INTERVAL_MS = 20_000;

/**
 * The direct lease-effect message types (`@browserglass/protocol`'s
 * `wire/messages/control.ts`) that mean "this viewer is not, or is about
 * to stop being, an active holder". See this module's own top comment,
 * item 4, for why this proxy reacts to every one of these by closing the
 * client socket, including the two WARNING types
 * (`control.preempt.request`, `control.yield.request`) rather than only
 * the two CONFIRMED ones. Deliberately excludes `control.granted` (the
 * synchronous grant this module checks directly via `holderFor()`, not
 * through this interception path), `control.queued` (never reached: this
 * module always requests with `queue: false`), `control.preempt.cancelled`
 * (good news: a pending preemption against this viewer was withdrawn, it
 * is still holding) and `control.expiring` (a renewal reminder this
 * module's own timer already answers before it would ever fire).
 */
const CONTROL_LOSS_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'control.preempted',
  'control.revoked',
  'control.denied',
  'control.preempt.request',
  'control.yield.request',
]);

/**
 * `presence.state`'s `label` for one CDP proxy viewer: `cdp:<token
 * subject>`, so a roster reads this as a raw CDP client rather than an
 * opaque `vwr_` id indistinguishable from an ordinary `bgls.v1` viewer
 * (every OTHER viewer's own label IS its `vwr_` id, `attachViewer()`'s own
 * default; this proxy is the one caller that overrides it, precisely
 * because it is the one caller whose viewer id alone tells a human
 * nothing).
 *
 * `principal.sub` is app-issued but NOT trusted content the way a
 * `vwr_` id is: `BglsClaims.sub` is "opaque to BrowserGlass" and 1 to 128
 * UTF-8 bytes of whatever the issuing app chose, so it is sanitised here
 * with `sanitizeMessage` (control characters and bidi overrides stripped,
 * byte capped) before it ever reaches a wire field a UI renders, the same
 * treatment every other page- or app-derived string gets crossing this
 * boundary (`wire/sanitize.ts`'s own module doc).
 */
function presenceLabelFor(principal: Principal): string {
  return `cdp:${sanitizeMessage(principal.sub)}`;
}

/** One process wide `noServer` `WebSocketServer` for CDP proxy connections, distinct from `ws/upgrade.ts`'s own `wss`: a CDP client never offers the `bgls.v1` subprotocol (chrome-remote-interface, Playwright's and Puppeteer's own CDP transports all dial a bare `new WebSocket(url)`), so sharing one `WebSocketServer` would mean weakening the viewer path's own subprotocol negotiation for no benefit over a second `noServer` instance, exactly `peer-upgrade.ts`'s own `peerWss` reasoning. */
const cdpProxyWss = new WebSocketServer({ noServer: true });

/** Whether `req`'s URL path names one instance under `pathPrefix` (`${basePath}/cdp`). Cheap and pure, no socket consumption, mirroring `shouldHandlePeerUpgrade`'s own shape. Matches `${pathPrefix}/<anything with no further slash>`; a path with no instance segment, or with more than one, is not a match (`instanceIdFromPath` never has to re-validate the shape it already checked here). */
export function shouldHandleCdpUpgrade(req: IncomingMessage, pathPrefix: string): boolean {
  const id = instanceIdFromPath(req, pathPrefix);
  return id !== null;
}

/** Extracts the `:instanceId` segment from `${pathPrefix}/:instanceId`, or `null` when the path does not match that exact shape (wrong prefix, no segment, or an extra path segment past the instance id). */
function instanceIdFromPath(req: IncomingMessage, pathPrefix: string): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const prefix = `${pathPrefix}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  try {
    const decoded = decodeURIComponent(rest);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null; // malformed percent-encoding
  }
}

/** Writes a pre-handshake HTTP refusal and destroys `socket`, mirroring `src/index.ts`'s own `handleUpgrade` refusals and `peer-upgrade.ts`'s `refuse`. Never called once the client's WS handshake has actually completed; a failure past that point is a close code instead (`CDP_PROXY_CLOSE`). */
function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
    socket.destroy();
  } catch {
    // best effort: a socket already closing or dead is a no-op here, same
    // tolerance `peer-upgrade.ts`'s own `refuse` documents.
  }
}

/**
 * The `httpStatus` a `BrowserRouter`-thrown error carries, per
 * `rest/errors.ts`'s `mapRouterError` doc (`driveInstance`'s
 * `E_INSTANCE_NOT_FOUND`/404, `E_INSTANCE_GONE`/410,
 * `E_INSTANCE_NOT_READY`/409). Falls back to 500 for anything not shaped
 * like a `RouterError`, since an upgrade refusal has no JSON body to carry
 * a code in, only a status line.
 */
function httpStatusOf(err: unknown): number {
  if (err !== null && typeof err === 'object' && 'httpStatus' in err) {
    const status = (err as { httpStatus: unknown }).httpStatus;
    if (typeof status === 'number') return status;
  }
  return 500;
}

/**
 * Narrows an arbitrary received close code to one RFC 6455 permits SENDING.
 * `client.once('close', (code, ...) => ...)` below hands `closeBoth` the
 * code the OTHER end reported, which very often is 1005 ("No Status
 * Received", what `ws` reports for a close handshake that carried no code
 * at all, ordinary and common) or 1006 ("Abnormal Closure", a dropped TCP
 * connection with no close frame). Both are reserved: the spec forbids
 * ever SENDING either one, and `ws`'s own `close()` refuses them, throwing
 * synchronously. Forwarding a received code straight into a `close()` call
 * on the OTHER socket, as this function used to, meant that call threw,
 * the surrounding `try/catch` swallowed it (matching every other "best
 * effort" close in this codebase's WS layer), and the other socket was
 * never actually asked to close: it sat open, connected, and unresolved.
 * Found by this proxy's own test suite hanging in `afterEach` on
 * `FakeChromeServer.close()`, which (like the real `ws.WebSocketServer.close()`
 * it wraps) waits for every one of its connections to close first;
 * `chrome.close()` was reporting that hang, not causing it.
 */
function safeCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

/**
 * Pipes CDP frames bidirectionally between `client` (the external caller's
 * socket, already upgraded) and `upstream` (this process's own connection
 * to the instance's real CDP endpoint, already open). Forwards frame type
 * (text vs binary) unchanged in both directions: CDP is JSON text over the
 * wire, but the raw bytes are relayed exactly as received rather than
 * re-encoded, so this proxy has no opinion about, and cannot corrupt,
 * anything Chrome or the client actually sends.
 *
 * Either side closing or erroring closes the other: a raw attach socket
 * has no resume, no reconnect, and no partial-failure mode worth keeping
 * half of. `once`, not `on`, for the terminal events on each side, so a
 * side that both errors and then closes (the ordinary sequence for a
 * dropped TCP connection) only ever triggers one teardown, not two racing
 * ones.
 *
 * `opts.onClientMessage`, when given, fires once per inbound CLIENT frame
 * (before it is forwarded, though the ordering is not load bearing): this
 * module's own top comment, item 5, wires it to `recordInput()` so a
 * client actually driving the page never idle-expires its own lease. It
 * never inspects `data`; whether the frame parses as CDP at all is not
 * this function's concern, matching the module's own "no filtering"
 * policy.
 *
 * `opts.onClosed`, when given, fires exactly once, inside `closeBoth`,
 * regardless of which side triggered the teardown or which of the four
 * listeners below fired: this module's own top comment, item 6, wires it
 * to release any held lease and detach the proxy's presence entry. Kept
 * as a single callback on the ALREADY-DEDUPED teardown path (guarded by
 * `closed` below) rather than a `client.once('close', ...)` of its own,
 * so cleanup cannot fire twice no matter how many of `client`'s own
 * `close`/`error` events this function itself reacts to.
 */
function pipe(
  client: WsWebSocket,
  upstream: WsWebSocket,
  logger: Logger,
  instanceId: string,
  opts?: { readonly onClientMessage?: () => void; readonly onClosed?: () => void },
): void {
  let closed = false;
  const closeBoth = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    const outgoingCode = safeCloseCode(code);
    for (const ws of [client, upstream]) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        try {
          ws.close(outgoingCode, reason);
        } catch {
          // best effort, matches every other close call in this codebase's WS layer.
        }
      }
    }
    opts?.onClosed?.();
  };

  client.on('message', (data: Buffer, isBinary: boolean) => {
    opts?.onClientMessage?.();
    if (upstream.readyState !== upstream.OPEN) return;
    try {
      upstream.send(data, { binary: isBinary });
    } catch {
      // best effort; the upstream's own 'error'/'close' handlers below report the failure.
    }
  });
  upstream.on('message', (data: Buffer, isBinary: boolean) => {
    if (client.readyState !== client.OPEN) return;
    try {
      client.send(data, { binary: isBinary });
    } catch {
      // best effort, same reasoning as above.
    }
  });

  client.once('close', (code: number, reasonBuf: Buffer) =>
    closeBoth(code, reasonBuf.toString('utf8')),
  );
  client.once('error', (err: Error) => {
    logger.warn({ component: 'cdp-proxy', instanceId }, `client socket error: ${err.message}`);
    closeBoth(1011, 'client socket error');
  });
  upstream.once('close', () =>
    closeBoth(CDP_PROXY_CLOSE.UPSTREAM_CLOSED, 'upstream CDP connection closed'),
  );
  upstream.once('error', (err: Error) => {
    logger.warn(
      { component: 'cdp-proxy', instanceId },
      `upstream CDP socket error: ${err.message}`,
    );
    closeBoth(CDP_PROXY_CLOSE.UPSTREAM_CLOSED, 'upstream CDP connection failed');
  });
}

/**
 * Completes (or refuses) one CDP proxy upgrade. Async by nature (auth
 * resolution, `driveInstance`, `describe`, and the outbound Chrome
 * connection all await), unlike the viewer socket's `completeHandshakeAndServe`,
 * which is why this function itself is not the `server.on('upgrade', ...)`
 * listener directly: `src/index.ts`'s `handleUpgrade` calls it and returns.
 *
 * Order of operations, and why: `enabled` is checked first (cheapest,
 * and the honest "this feature does not exist" answer for a disabled
 * gateway) before any auth work runs at all. Authentication, then the
 * `cdp` capability check, then `driveInstance` (the same authority gate
 * every other driving surface resolves through), then `describe` for the
 * real `cdpWsUrl`, then the outbound connect. The client's own WS
 * handshake is completed ONLY after the outbound connection to Chrome is
 * confirmed open: never leave a client's socket open while this process
 * might still refuse it, which would otherwise let a caller with a merely
 * plausible-looking instance id sit on an open, silent socket waiting for
 * a hello, `nodeSocket.ts`'s peer link.
 */
export function handleCdpUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathPrefix: string,
  deps: CdpProxyDeps,
): void {
  if (!deps.enabled) {
    refuseUpgrade(socket, 404, 'Not Found');
    return;
  }
  const instanceId = instanceIdFromPath(req, pathPrefix);
  if (instanceId === null) {
    refuseUpgrade(socket, 400, 'Bad Request');
    return;
  }
  if (deps.resolver === undefined) {
    refuseUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  void (async () => {
    let principal: Principal;
    try {
      principal = await principalFor(req, deps.resolver as AuthResolver, {
        allowQueryToken: deps.allowQueryToken,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        refuseUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      deps.logger.error(
        { component: 'cdp-proxy', instanceId },
        `auth resolution threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      refuseUpgrade(socket, 500, 'Internal Server Error');
      return;
    }

    // `cdp`, the same capability the REST allowlisted passthrough already
    // requires (`rest/routes/targets.ts`'s `sendCdpCommand`), checked the
    // same way `dispatchRest` checks every other route's capability:
    // `principal.caps.includes(...)`, no hierarchy, no implication from
    // any other capability. See `capabilities.ts`'s own doc comment on
    // `cdp` for why it stands alone.
    if (!principal.caps.includes('cdp')) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }

    // `control`, ADDITIONALLY to `cdp` above. `cdp`
    // alone answers "may this token reach a real, unfiltered CDP endpoint
    // at all"; it says nothing about driving through the control-lease
    // model, and before this check any `cdp`-capable token could open this
    // proxy's wide open pipe regardless. Once the pipe is open there is no
    // per-command filter downstream that could still refuse an unwanted
    // `Input.*`/`Page.navigate` call (this module's own top comment: "does
    // NOT filter methods"), so `control` has to be required HERE, at the
    // point authority is granted, exactly the way `rest/routes/targets.ts`
    // requires it of the REST passthrough's own `Input.*` allowlist entries
    // (`ManagedSession.sendCdp`'s `withRestControl` gate). A token that
    // only ever needed `cdp` for a narrow, non-driving reason no longer
    // gets a free pass into a fully driving raw socket.
    if (!principal.caps.includes('control')) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const router = deps.getRouter();
    if (router === undefined) {
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    let local: boolean;
    try {
      const resolution = await router.driveInstance(instanceId, principal);
      local = resolution.local;
    } catch (err) {
      refuseUpgrade(socket, httpStatusOf(err), 'Not Found');
      return;
    }
    if (!local) {
      // Honest limitation, not a bug: see this module's own top comment,
      // "Scope: LOCAL instances only".
      refuseUpgrade(socket, 501, 'Not Implemented');
      return;
    }

    let cdpWsUrl: string | undefined;
    try {
      const view = await router.describe(instanceId, principal);
      cdpWsUrl = view.instance.runtime?.cdpWsUrl;
    } catch (err) {
      refuseUpgrade(socket, httpStatusOf(err), 'Not Found');
      return;
    }
    if (cdpWsUrl === undefined) {
      // The instance exists and resolved as local, but this process holds
      // no live runtime detail for it yet (`BrowserRouter.describe`'s own
      // doc: `liveRuntimeByInstance` is populated only for an instance
      // THIS router process itself launched, and only once Chrome has
      // actually answered). Retryable: a caller mid-launch should try
      // again shortly, not treat this as permanent.
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    // COLLABORATION: joins the same presence roster and control lease
    // model every `bgls.v1` viewer joins. See this module's own top
    // comment for the full argument; this block is items 1 through 3 of
    // it (presence, kind, control), before the upstream connect below
    // (items 4 through 6, wired into `pipe()`) can even be attempted.
    if (deps.getManagedSession === undefined) {
      // The feature this module exists for is wired (`deps.enabled` was
      // already checked, first thing, above), but the ONE dependency that
      // lets it join the collaboration model instead of bypassing it was
      // not supplied. Refused the same way an absent `router` is refused
      // a few lines up, rather than silently falling back to the old,
      // invisible-to-presence behaviour: a half-wired deployment should
      // fail loudly, not quietly reintroduce the exact defect this check
      // closes.
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    let managed: ManagedSession;
    try {
      managed = await deps.getManagedSession(instanceId, {
        tenantId: principal.tenantId,
        appId: principal.appId,
      });
    } catch (err) {
      deps.logger.error(
        { component: 'cdp-proxy', instanceId },
        `could not resolve this instance's ManagedSession: ${err instanceof Error ? err.message : String(err)}`,
      );
      refuseUpgrade(socket, httpStatusOf(err), 'Service Unavailable');
      return;
    }

    const viewerId = newViewerId();
    const presenceLabel = presenceLabelFor(principal);
    // `null` until the client's own WS handshake actually completes
    // (`cdpProxyWss.handleUpgrade`'s callback, below): everything before
    // that point can still refuse the upgrade outright
    // (`refuseUpgrade`'s own pre-handshake contract, this module's
    // existing top comment), so there is nothing yet for `sendEnvelope`
    // to act on, and `isOpen`/`bufferedAmount` have nothing real to
    // report either.
    let liveClient: WsWebSocket | null = null;
    const sink: ConnectionSink = {
      viewerId,
      isOpen: () => liveClient !== null && liveClient.readyState === liveClient.OPEN,
      bufferedAmount: () => liveClient?.bufferedAmount ?? 0,
      // A raw CDP client never receives a binary video frame: it has no
      // `bgls.v1` stream subscription, and even if `ManagedSession` ever
      // tried to hand this viewer id one, corrupting Chrome's own wire
      // protocol with an unrelated binary frame would be actively harmful
      // rather than merely useless. Silently dropped, matching this
      // module's own "best effort" tolerance elsewhere.
      send: () => undefined,
      // The one live channel back from the control-lease model to this
      // proxy's client: see this module's own top comment, item 4, and
      // `CONTROL_LOSS_MESSAGE_TYPES`'s own doc for exactly which messages
      // this reacts to and why. Every OTHER `bgls.v1` envelope
      // (`presence.state` itself included) is a silent no-op, because a
      // raw CDP client has no `bgls.v1` parser to hand it to and forwarding
      // one down Chrome's own wire protocol would corrupt it.
      sendEnvelope: (env) => {
        if (liveClient === null) return;
        if (!CONTROL_LOSS_MESSAGE_TYPES.has(env.t)) return;
        try {
          liveClient.close(CDP_PROXY_CLOSE.CONTROL_LOST, `lost control: ${env.t}`);
        } catch {
          // best effort, matches every other close call in this module.
        }
      },
      close: (code, reason) => {
        try {
          liveClient?.close(safeCloseCode(code), reason);
        } catch {
          // best effort, matches every other close call in this module.
        }
      },
    };

    managed.attachViewer(
      sink,
      {
        id: viewerId,
        tenantId: principal.tenantId,
        appId: principal.appId,
        subject: principal.sub,
        capabilities: principal.caps,
        // Unconditionally `'agent'`. See this module's own top comment,
        // item 2, for why this does NOT mirror `ws/connection.ts`'s own
        // `automation`-capability derivation.
        kind: 'agent',
        isAdmin: principal.caps.includes('admin'),
        connectedAtMs: Date.now(),
      },
      presenceLabel,
    );
    managed.broadcastPresence();

    // The one target this attach protects. See this module's own top
    // comment, item 3, for why exactly one, and why the first page target
    // rather than every target.
    const primaryTargetId = managed.listTargets(['page'])[0]?.targetId;
    let heldTargetId: string | null = null;
    let heldLeaseId: string | null = null;

    /**
     * Releases whatever lease this viewer holds (best effort: a lease
     * already gone by the time this runs, e.g. an idle/TTL expiry that
     * already fired `control.revoked`, is not an error), then detaches
     * the viewer, exactly `ws/connection.ts`'s own `onSocketClosed` does
     * for a `bgls.v1` viewer. Explicit `release()` BEFORE `detachViewer()`
     * on purpose: `detachViewer()` -> `core.Session.removeViewer()` calls
     * `ControlLeaseEngine.handleSocketClosed()`, which puts an EXCLUSIVE
     * holder into a 30-second disconnect grace on the assumption the
     * socket might reconnect (`docs/agent-and-human.md`'s own
     * `disconnectGraceMs` table). A raw CDP proxy socket never reconnects
     * (this module's own `pipe()` doc: "no resume, no reconnect"), so
     * that grace would only ever hold the target hostage for up to 30
     * seconds after this client is provably gone. Releasing first empties
     * the holder record `handleSocketClosed` would otherwise grace, the
     * same pattern `BrowserGlassClient.disconnect()` uses client side
     * ("Releases every held lease... FIRST").
     */
    const releaseAndDetach = (): void => {
      if (heldTargetId !== null && heldLeaseId !== null) {
        const targetId = heldTargetId;
        const leaseId = heldLeaseId;
        heldTargetId = null;
        heldLeaseId = null;
        void managed.coreSession
          .leaseEngineFor(targetId)
          .release(viewerId, leaseId)
          .catch(() => undefined);
      }
      managed.detachViewer(viewerId);
    };

    if (primaryTargetId !== undefined) {
      managed.requestControl(
        {
          viewerId,
          identity: principal.sub,
          label: presenceLabel,
          kind: 'agent',
          capabilities: principal.caps,
          isAdmin: principal.caps.includes('admin'),
        },
        primaryTargetId,
        // Not `force`, not `queue`: an ordinary, unprivileged request, the
        // same one any `control.request{}` sends. See this module's own
        // top comment, item 3: NOT a special bypass path.
        {
          reason: 'raw CDP attach (playwright / puppeteer / chrome-remote-interface)',
          force: false,
          queue: false,
        },
      );
      const holder = managed.coreSession.leaseEngineFor(primaryTargetId).holderFor(viewerId);
      if (holder === null) {
        // Somebody else already outranks or already holds this target
        // (in exclusive mode; shared mode's `requestShared` grants
        // unconditionally and never reaches this branch). See this
        // module's own top comment, item 3: refused outright, `409
        // Conflict`, rather than opened half-trusted.
        releaseAndDetach();
        refuseUpgrade(socket, 409, 'Conflict');
        return;
      }
      heldTargetId = primaryTargetId;
      heldLeaseId = holder.leaseId;
    }

    // `cdpWsUrl` is `InstanceRuntimeInfo.cdpWsUrl`, documented at its own
    // declaration (`@browserglass/protocol`'s `entities.ts`) as "Secret.
    // Leaking this is full browser control." It is used here to open THIS
    // process's own outbound connection and is never written to `socket`,
    // a log field, or any response the caller can read: the caller only
    // ever learns this proxy's own `wss://.../browserglass/cdp/:instanceId`
    // path (`rest/routes/cdp-discovery.ts`'s `webSocketDebuggerUrl`), never
    // Chrome's real endpoint.
    const upstream = new WsClient(cdpWsUrl, { perMessageDeflate: false });
    const timeoutMs = deps.upstreamConnectTimeoutMs ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS;
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        upstream.terminate();
      } catch {
        // best effort
      }
      releaseAndDetach();
      refuseUpgrade(socket, 504, 'Gateway Timeout');
    }, timeoutMs);
    connectTimer.unref?.();

    upstream.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);

      // Race guard: time passed (the outbound connect itself, plus
      // whatever this process was doing before it got scheduled) between
      // the synchronous grant check above and this callback. If a human
      // took over in that window, the confirmation already reached
      // `sink.sendEnvelope` (recorded below), but `liveClient` was still
      // `null` when it arrived, so nothing closed. Checked directly
      // against the engine rather than trusting a flag, since it is the
      // engine's own current answer that matters here, not whether a
      // message happened to arrive in time.
      if (
        heldTargetId !== null &&
        heldLeaseId !== null &&
        managed.coreSession.leaseEngineFor(heldTargetId).holderFor(viewerId) === null
      ) {
        try {
          upstream.terminate();
        } catch {
          // best effort
        }
        releaseAndDetach();
        refuseUpgrade(socket, 409, 'Conflict');
        return;
      }

      cdpProxyWss.handleUpgrade(req, socket, head, (client) => {
        liveClient = client;
        const renewTimer =
          heldTargetId !== null && heldLeaseId !== null
            ? setInterval(() => {
                if (heldTargetId === null || heldLeaseId === null) return;
                // Synchronous (`ControlLeaseEngine.renew`'s own signature),
                // unlike `release()`/`recordInput()`'s asynchronous siblings
                // on this same class; no `await`/`.then()` needed.
                const result = managed.coreSession
                  .leaseEngineFor(heldTargetId)
                  .renew(viewerId, heldLeaseId);
                if (result.ok) return;
                // A renewal this proxy itself sent was refused: the lease
                // moved out from under it in a way that never reached
                // `sendEnvelope` (or already has, and this is merely
                // confirming it). Either way, close rather than keep
                // piping against a lease that is no longer ours.
                try {
                  client.close(CDP_PROXY_CLOSE.CONTROL_LOST, `lost control: renew ${result.error}`);
                } catch {
                  // best effort
                }
              }, LEASE_RENEW_INTERVAL_MS)
            : null;
        renewTimer?.unref?.();
        pipe(client, upstream, deps.logger, instanceId, {
          ...(heldTargetId !== null && heldLeaseId !== null
            ? {
                onClientMessage: () => {
                  if (heldTargetId === null || heldLeaseId === null) return;
                  managed.coreSession
                    .leaseEngineFor(heldTargetId)
                    .recordInput(viewerId, heldLeaseId);
                },
              }
            : {}),
          onClosed: () => {
            if (renewTimer !== null) clearInterval(renewTimer);
            releaseAndDetach();
          },
        });
      });
    });
    upstream.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      deps.logger.error(
        { component: 'cdp-proxy', instanceId },
        `could not reach the instance's real CDP endpoint: ${err.message}`,
      );
      releaseAndDetach();
      refuseUpgrade(socket, 502, 'Bad Gateway');
    });
  })();
}
