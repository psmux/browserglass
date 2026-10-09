/**
 * `Connection`: one viewer socket's `bgls.v1` message loop. This is the
 * class `ws/upgrade.ts` constructs once per accepted WebSocket, and it is
 * where these rules live: handshake ordering, version negotiation, the message loop (`sq`
 * assignment, capability enforcement, rate limiting), resume, refresh, and
 * untrusted-content caps.
 */

import { createHash } from 'node:crypto';
import {
  CONTROL_TIMING,
  type EvaluateOutcome,
  PageMapCaptureError,
  PageMapStaleEpochError,
  PrintToPdfOptionsError,
  type SessionViewerIdentity,
} from '@browserglass/core';
import {
  BglsError,
  type Capability,
  CloseCode,
  DEFAULT_A11Y_MAX_NODES,
  DEFAULT_EVALUATE_TIMEOUT_MS,
  DEFAULT_LIMITS,
  DEFAULT_PAGEMAP_TIMEOUT_MS,
  type EvaluateWorld,
  type GateRule,
  type Hello,
  MAX_A11Y_MAX_NODES,
  MAX_EVALUATE_ARGS,
  MAX_EVALUATE_RESULT_BYTES,
  MAX_EVALUATE_SOURCE_BYTES,
  MAX_EVALUATE_TIMEOUT_MS,
  MAX_GATE_PATTERN_BYTES,
  MAX_GATE_RULES,
  MAX_PAGEMAP_STAMP_INDICES,
  MAX_PAGEMAP_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  type PageMapInclude,
  type PdfPaperFormat,
  type Principal,
  type QualityProfile,
  type TargetKind,
  VersionNegotiationError,
  type Welcome,
  negotiateVersion,
  newId,
} from '@browserglass/protocol';
import { MsgType, decodeBinaryHeader, decodeUploadChunkPayload } from '@browserglass/protocol';
import type { WebSocket as WsWebSocket } from 'ws';
import type { TicketRegistry } from '../auth/tickets.js';
import type { TokenApi } from '../auth/types.js';
import type { Logger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { UploadStore } from '../files/upload-store.js';
import type { HookRegistry } from '../hooks/dispatch.js';
import type { ControlGrantedEvent, NavigationEvent, ViewerJoinedEvent } from '../hooks/types.js';
import type { ManagedSession } from '../session/managed-session.js';
import type { SessionRegistry } from '../session/registry.js';
import type { ConnectionSink } from '../session/types.js';
import { checkCapability } from '../wire/capability-check.js';
import { buildGoodbye, reasonForCloseCode } from '../wire/close.js';
import { type RateBucketName, ViewerRateLimiters } from '../wire/rate-limit.js';
import type { ResumeStore } from '../wire/resume-store.js';
import { sanitizeMessage } from '../wire/sanitize.js';
import { buildWelcomeFields, rateLimitInputsFor } from '../wire/welcome-fields.js';
import {
  type PreUpgradeCarriers,
  extractPreUpgradeCarriers,
  resolveCredential,
} from './credentials.js';

const SUPPORTED_VERSIONS = [1] as const;
const HELLO_DEADLINE_MS = 5000;
const EARLY_BUFFER_LIMIT_MULTIPLIER = 4;

type ConnState = 'awaiting-hello' | 'resolving' | 'live' | 'closed';

/** Everything a `Connection` needs from the rest of the gateway. */
export interface ConnectionDeps {
  readonly resolved: ResolvedConfig;
  readonly sessionRegistry: SessionRegistry;
  readonly resumeStore: ResumeStore;
  readonly ticketRegistry: TicketRegistry;
  readonly tokenApi: TokenApi;
  readonly hooks: HookRegistry;
  readonly logger: Logger;
  /**
   * The upload staging area (`files/upload-store.ts`), shared with the
   * REST routes so a file staged over the socket can be attached over HTTP
   * and the other way round. Optional so a hand built `ConnectionDeps`
   * (this package's own tests) may omit it; the `upload.*` handlers then
   * answer an honest error instead of pretending.
   */
  readonly uploads?: UploadStore;
}

/** What `ws/upgrade.ts` already knows about the raw HTTP upgrade request, before any credential is resolved. */
export interface ConnectionUpgradeContext {
  readonly origin: string;
  readonly remoteAddress: string | undefined;
  /**
   * The raw `User-Agent` header, or `null` when the client sent none.
   * Carried through purely for `ViewerJoinedEvent.userAgent`
   * (`hooks/types.ts`): nothing else on this connection's own message loop
   * reads it, and it is never treated as trustworthy (a hook handler that
   * branches on it is trusting the same header any HTTP server does, no
   * more and no less).
   */
  readonly userAgent: string | null;
  readonly preCarriers: PreUpgradeCarriers;
}

/** Sends an error envelope and closes with `code`, per the "bad credential completes the handshake, then closes" rule. `context` carries whatever structured detail the wire code needs beyond the message string (for instance `bgls.error.instance.wrong_node`'s `nodeId`); omitted entirely rather than sent as `undefined` when there is none. */
function sendErrorAndClose(
  sink: ConnectionSink,
  code: number,
  wireCode: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  sink.sendEnvelope({
    t: 'error',
    code: wireCode,
    category: wireCode.split('.')[2] ?? 'internal',
    message,
    fatal: true,
    retryable: false,
    ...(context !== undefined ? { context } : {}),
  });
  sink.sendEnvelope(buildGoodbye(code, message));
  sink.close(code, reasonForCloseCode(code));
}

/**
 * Sends one `hooks/dispatch.ts` veto's `reason` to `sink`, in the shape
 * `ManagedSession.reportInputSignal` already established for "this
 * specific action did not happen, but the connection is otherwise fine":
 * `t: 'error'`, `fatal: false`, `retryable: false`. Uses the pre-existing
 * `bgls.error.policy.denied` code (`protocol/src/wire/errors.ts`), whose
 * own remediation string already reads "An authorize() veto set
 * e.reason; see context.reason", written for exactly this case, and
 * unused by any call site until `HookRegistry.dispatch` was wired up to
 * anything. `category: 'policy'` matches
 * `wireCode.split('.')[2]`, the same derivation `sendErrorAndClose` uses
 * above, spelled out here because this call site has no reason to import
 * that helper (which hardcodes `fatal: true` and always closes, neither
 * of which is right for `onControlGranted`/`onNavigation`, whose whole
 * point is that the connection carries on).
 */
function sendVetoError(
  sink: ConnectionSink,
  reason: string | undefined,
  context: Record<string, unknown>,
): void {
  sink.sendEnvelope({
    t: 'error',
    code: 'bgls.error.policy.denied',
    category: 'policy',
    message: reason ?? 'Refused by a registered hook.',
    fatal: false,
    retryable: false,
    context: { reason: reason ?? null, ...context },
  });
}

/**
 * The capabilities a connection that declared itself view-only is stripped
 * of, regardless of what its token carries. See
 * `Connection.narrowGrantedForViewOnly()` for the reasoning; this list is
 * every capability in `wire/capability-check.ts`'s `REQUIRED_CAPABILITY`
 * table that gates a message which drives the page surface.
 */
const VIEW_ONLY_WITHHELD_CAPABILITIES: readonly Capability[] = Object.freeze([
  'control',
  'clipboard.write',
  // `evaluate` (`page.evaluate`) belongs here by the rule this list states:
  // it gates a message that drives the page surface, and script running in
  // the page can do everything `control` can and more, silently. A
  // connection that has declared "I will send no input" and then evaluates
  // `document.forms[0].submit()` has driven the page through a door it
  // said it would not use.
  //
  // Nothing in this repo is caught by this in practice, and that is on
  // purpose rather than by luck: `BrowserGlassClient` declares
  // `input: ['mouse','key','text','touch','scroll']` and
  // `AutomationClient` declares `['mouse','key','text']`, so neither ever
  // trips `declaresViewOnly()`. The entry is here for the caller that
  // hand-rolls a `hello` with an empty `input[]` to get a read-only
  // session, and would otherwise find that a read-only session came with
  // arbitrary script execution attached.
  'evaluate',
] as Capability[]);

/**
 * Whether `hello` declared this client as view-only, by offering an empty
 * `capabilities.input[]`.
 *
 * Read defensively rather than off the typed field, because `hello` reaches
 * `processHello` as an unvalidated cast from `JSON.parse`: a client that
 * omits `capabilities` entirely, or sends a non-array `input`, has not
 * declared anything, and MUST NOT be silently confined to view-only by a
 * malformed message. Only an actual, present, empty array counts, which
 * keeps this a deliberate client choice rather than something a typo can
 * cause.
 */
function declaresViewOnly(hello: Hello): boolean {
  const declared = (hello as { capabilities?: { input?: unknown } } | undefined)?.capabilities
    ?.input;
  return Array.isArray(declared) && declared.length === 0;
}

/** One viewer socket's live `bgls.v1` loop. Implements `ConnectionSink` so `ManagedSession` can push to it directly. */
export class Connection implements ConnectionSink {
  viewerId = '';

  private readonly ws: WsWebSocket;
  private readonly deps: ConnectionDeps;
  private readonly upgradeCtx: ConnectionUpgradeContext;

  private state: ConnState = 'awaiting-hello';
  private sqCounter = 0;
  private helloDeadlineTimer: NodeJS.Timeout | undefined;
  private readonly earlyBuffer: Buffer[] = [];
  private earlyBufferBytes = 0;

  private managed: ManagedSession | undefined;
  private granted = new Set<Capability>();
  /**
   * Whether this connection declared itself VIEW ONLY in its `hello`, by
   * offering an empty `capabilities.input[]`. See
   * {@link narrowGrantedForViewOnly} for what that means and why it is
   * stored on the connection rather than recomputed.
   */
  private viewOnly = false;
  private tenantId = '';
  private appId = '';
  private instanceId = '';
  /**
   * `uploadId`s this connection opened and has not completed.
   *
   * Two jobs, both load bearing. It is the ownership check for inbound
   * `UPLOAD_CHUNK` frames, which carry 16 bytes and no identity of their
   * own, so without it any socket that guessed a binary id could append to
   * another viewer's upload. And it is what `onSocketClosed` discards, so
   * an abandoned transfer costs a directory until the socket drops rather
   * than until the sweeper's TTL.
   *
   * Entries are removed on completion, so a finished upload survives this
   * connection: it is attached to a page that may not read it for minutes.
   */
  private readonly openUploads = new Set<string>();

  constructor(ws: WsWebSocket, deps: ConnectionDeps, upgradeCtx: ConnectionUpgradeContext) {
    this.ws = ws;
    this.deps = deps;
    this.upgradeCtx = upgradeCtx;

    this.helloDeadlineTimer = setTimeout(() => {
      if (this.state === 'awaiting-hello') this.close(CloseCode.MissingParams, 'hello_timeout');
    }, HELLO_DEADLINE_MS);
    this.helloDeadlineTimer.unref?.();

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) =>
      this.onMessage(data, isBinary),
    );
    ws.on('close', () => this.onSocketClosed());
    ws.on('error', (err: Error) =>
      deps.logger.warn({ component: 'ws' }, `WS socket error: ${err.message}`),
    );
  }

  // ── ConnectionSink ───────────────────────────────────────────────────

  isOpen(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(buf: Uint8Array): void {
    if (this.isOpen()) this.ws.send(buf, { binary: true });
  }

  /**
   * `console`/`pageError`/`network` are gated right here, not in `dispatch()`'s
   * inbound `bucketFor()` path: they cap OUTBOUND diagnostics traffic the
   * SERVER decides to send (`ManagedSession.deliverDiagnostics`), not a
   * message this connection ever received, and `sendEnvelope` is the one
   * place every outbound envelope funnels through regardless of who
   * produced it (a direct reply, a broadcast, or a diagnostics push). See
   * `wire/rate-limit.ts`'s `RateBucketName` doc for the full reasoning; a
   * message over budget is silently dropped ("coalesce, cap per target,
   * drop past the cap").
   */
  sendEnvelope<T extends { readonly t: string }>(env: T): void {
    if (!this.isOpen()) return;
    const diagBucket = diagnosticsBucketFor((env as { readonly t: string }).t);
    if (diagBucket) {
      const targetId = (env as { readonly targetId?: unknown }).targetId;
      const scope = typeof targetId === 'string' ? targetId : undefined;
      if (!this.ensureRateLimiters().take(diagBucket, performance.now(), scope)) return;
    }
    this.sqCounter += 1;
    const full = { v: 1, ...env, ts: Date.now(), sq: this.sqCounter };
    this.ws.send(JSON.stringify(full));
  }

  /**
   * Sends `env` as the direct reply to `msg` (`re` is "echo of a request's
   * id", see `docs/protocol/wire-spec.md`). Echoes `msg['id']` onto `re` when
   * `msg` carried one; sends `env` unchanged otherwise (a push with no
   * originating request, or a request that omitted `id`). This is the one
   * place every direct, single-recipient reply in this class should be
   * sent through, so every request-shaped message stays correlatable by
   * `BrowserGlassClient`'s (and `AutomationClient`'s) `request()` helper.
   */
  /**
   * Runs one `nav.*` command and answers the requester with a `nav.state`
   * carrying its own `re`.
   *
   * Every navigation method the browser client package ships
   * (`navigate`, `back`, `forward`, `reload`, `packages/client/src/client/BrowserGlassClient.ts`)
   * is a `request()`, and
   * `request()` correlates strictly on `re`. `ManagedSession.navigate()`
   * broadcasts a `nav.state` to the whole session, but a broadcast carries
   * no `re`, so before this reply existed every one of those calls hung for
   * the full 15s request timeout and then threw, even though the
   * navigation itself had already happened in Chrome. That is what made
   * `useNav()`'s address bar, back, forward and reload unusable in a real
   * app while looking, on screen, like they had worked.
   *
   * The requester therefore sees the state twice: once as its correlated
   * reply, once as the session-wide broadcast every other viewer also
   * gets. Both carry identical values, and the client applies them
   * idempotently.
   */
  private async runNav(
    msg: Record<string, unknown>,
    kind: 'goto' | 'back' | 'forward' | 'reload' | 'stop',
    params: { readonly url?: string; readonly ignoreCache?: boolean },
  ): Promise<void> {
    const targetId = str(msg['targetId']);
    // `onNavigation` only gates `'goto'`: a caller-named URL is the one
    // navigation kind that can point anywhere, which is what a veto over
    // "should this browser go here" actually needs to stop
    // (`docs/cdp-and-interception.md` makes the whole argument for an
    // in process request/navigation gate). `back`/`forward`/`reload`/`stop`
    // stay ungated: covering them would mean a `Page.getNavigationHistory`
    // round trip on EVERY history navigation just to learn the URL a
    // handler might want, which is exactly the cost `HookRegistry.has`
    // exists to let a call site avoid paying when nobody is listening, and
    // `HOOK_TIMEOUTS.onNavigation`'s 750ms fail-open budget was sized for
    // "cheap to check", not "cheap to check after a CDP call already ran".
    if (kind === 'goto' && this.managed && this.deps.hooks.has('onNavigation')) {
      // Cached, not read live: `listTargets()` reflects this session's own
      // bookkeeping (`ManagedSession`'s target registry), never a fresh CDP
      // round trip, which is the entire point per the comment above. `''`
      // when the target is not yet known to this session (a fresh
      // `target.new` that has never painted) rather than fetching it.
      const fromUrl = this.managed.listTargets().find((t) => t.targetId === targetId)?.url ?? '';
      const navEvent: NavigationEvent = {
        at: Date.now(),
        tenantId: this.tenantId,
        appId: this.appId,
        requestId: typeof msg['id'] === 'string' ? msg['id'] : newId('evt'),
        sessionId: this.managed.sessionId,
        targetId,
        viewerId: this.viewerId,
        url: params.url ?? '',
        fromUrl,
        kind: this.granted.has('automation') ? 'automation' : 'user',
        redirectChain: [],
      };
      const decision = await this.deps.hooks.dispatch('onNavigation', navEvent);
      if (decision.vetoed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.policy.denied',
          category: 'policy',
          message: decision.reason ?? 'Refused by onNavigation.',
          fatal: false,
          retryable: false,
          context: { reason: decision.reason ?? null, hook: 'onNavigation', targetId },
        });
        return;
      }
    }
    const state = await this.managed?.navigate(targetId, kind, params);
    if (msg['id'] === undefined) return;
    // `state` is null only when the history read behind it failed. The
    // command still ran, so the requester gets an honest, minimal answer
    // rather than a hang or a fabricated url.
    this.replyTo(
      msg,
      state ?? {
        t: 'nav.state' as const,
        targetId,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        securityState: 'unknown' as const,
      },
    );
  }

  private replyTo<T extends { readonly t: string }>(
    msg: Record<string, unknown> | undefined,
    env: T,
  ): void {
    const id = msg !== undefined && typeof msg['id'] === 'string' ? msg['id'] : undefined;
    this.sendEnvelope(id !== undefined ? { ...env, re: id } : env);
  }

  /**
   * The second half of `recording.*`'s dual-capability gate: `capture` is
   * already enforced generically by `checkCapability` before any handler
   * runs (`wire/capability-check.ts`'s table); `download` is enforced
   * here, by hand, for the reason that table's own `recording.*` comment
   * gives (a `ParamCapabilityRule` keyed on `baseCapability: 'capture'`
   * would also catch `target.capture`/`page.pdf.get`, which must not gain
   * this requirement). Replies with the identical `bgls.error.cap.missing`
   * shape the generic check itself sends on a primary-capability miss, so
   * a client cannot distinguish the two enforcement points from the wire
   * alone.
   */
  private requireDownloadCapability(msg: Record<string, unknown>): boolean {
    if (this.granted.has('download')) return true;
    this.replyTo(msg, {
      t: 'error',
      code: 'bgls.error.cap.missing',
      category: 'cap',
      message: 'Capability "download" is required for "recording.*" messages.',
      fatal: false,
      retryable: false,
      context: { required: 'download' },
    });
    return false;
  }

  close(code: number, reason: string): void {
    this.state = 'closed';
    if (this.helloDeadlineTimer) clearTimeout(this.helloDeadlineTimer);
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close(code, reason.slice(0, 123));
    }
  }

  // ── message loop ─────────────────────────────────────────────────────

  private onMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (isBinary) {
      // `UPLOAD_CHUNK` (`msgType 0x03`) is the one inbound binary type
      // this build accepts, and only on a live connection: the frame
      // carries no capability of its own, so it must not be processed
      // before `hello` has established what this viewer may do. The
      // `upload.begin` that opened the upload was capability checked like
      // any other message, and a chunk can only reach an upload that
      // handshake created, which is where the gate actually is.
      if (this.state === 'live') {
        this.onBinaryChunk(
          Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer),
        );
      }
      return;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);

    if (this.state === 'resolving') {
      const cap = DEFAULT_LIMITS.maxControlMsgBytes * EARLY_BUFFER_LIMIT_MULTIPLIER;
      if (this.earlyBufferBytes + buf.byteLength <= cap) {
        this.earlyBuffer.push(buf);
        this.earlyBufferBytes += buf.byteLength;
      }
      // Over budget: silently dropped. The protocol says the server MUST NOT close for this.
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      if (this.state === 'awaiting-hello') this.close(CloseCode.MissingParams, 'expected_hello');
      return;
    }

    if (this.state === 'awaiting-hello') {
      if (msg['t'] !== 'hello') {
        this.close(CloseCode.MissingParams, 'expected_hello');
        return;
      }
      if (this.helloDeadlineTimer) clearTimeout(this.helloDeadlineTimer);
      this.state = 'resolving';
      this.processHello(msg as unknown as Hello).catch((err) => {
        this.deps.logger.error(
          { component: 'ws' },
          `processHello failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        this.close(CloseCode.PolicyViolation, 'internal_error');
      });
      return;
    }

    if (this.state === 'live') {
      this.dispatch(msg);
    }
  }

  /**
   * One inbound `UPLOAD_CHUNK` binary frame (`@browserglass/protocol`'s
   * `binary.ts`, `msgType 0x03`).
   *
   * Fire and forget, deliberately: a chunk carries no correlation id, so
   * there is nothing to reply to and nothing for a client to await. Flow
   * control is `upload.accepted.maxInFlight` plus the declared size, which
   * `UploadStore.append` enforces by refusing bytes past it. Progress and
   * failure both surface on the control channel, as `upload.progress` and
   * as the `upload.complete` reply respectively, so a client that sends a
   * chunk too many learns about it when it tries to finalise rather than
   * mid-stream.
   *
   * A malformed frame, an unknown `msgType`, or a chunk for an upload this
   * connection does not own is dropped in silence. That is the v1 rule for
   * an unknown binary `msgType` (`decodeBinaryHeader`'s own doc) and it is
   * the right answer for the other two as well: this is a data channel, and
   * closing a viewer's socket over one bad frame would take their live
   * session with it.
   */
  private onBinaryChunk(buf: Buffer): void {
    const uploads = this.deps.uploads;
    if (uploads === undefined) return;
    let header: ReturnType<typeof decodeBinaryHeader>;
    try {
      header = decodeBinaryHeader(buf);
    } catch {
      return;
    }
    if (header.msgType !== MsgType.UPLOAD_CHUNK) return;
    let decoded: ReturnType<typeof decodeUploadChunkPayload>;
    try {
      decoded = decodeUploadChunkPayload(header.payload);
    } catch {
      return;
    }
    const binaryId = Buffer.from(decoded.uploadId).toString('hex');
    const uploadId = uploads.uploadIdForBinaryId(binaryId);
    // Not just "unknown id": an id this CONNECTION did not open. The
    // binary channel carries no tenant and no viewer, so without this a
    // socket that guessed 16 bytes could append to somebody else's upload.
    if (uploadId === null || !this.openUploads.has(uploadId)) return;

    // Copied, not passed as a view: `decoded.chunk` is a subarray of the
    // frame buffer, `ws` reuses its receive buffers, and the write below
    // is asynchronous. Handing the view straight to `append` would write
    // whatever landed in that buffer next.
    const bytes = Uint8Array.prototype.slice.call(decoded.chunk);
    void uploads
      .append(uploadId, this.tenantId, bytes)
      .then((status) => {
        this.sendEnvelope({ t: 'upload.progress', uploadId, receivedBytes: status.receivedBytes });
      })
      .catch((err: unknown) => {
        const code = uploadWireCodeFor(err, 'bgls.error.upload.too_large');
        this.sendEnvelope({
          t: 'error',
          code,
          category: code.split('.')[2] ?? 'upload',
          message: err instanceof Error ? err.message : `upload "${uploadId}" rejected a chunk`,
          fatal: false,
          retryable: false,
          context: { uploadId },
        });
      });
  }

  /** `this.deps.uploads`, or an honest error reply and `undefined`. Mirrors `rest/routes/uploads.ts`'s `requireUploads`: the feature exists and is capability gated, this gateway just has nothing wired behind it. */
  private requireUploads(msg: Record<string, unknown>): UploadStore | undefined {
    const uploads = this.deps.uploads;
    if (uploads === undefined) {
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.internal',
        category: 'internal',
        message: 'This gateway has no upload staging area wired.',
        fatal: false,
        retryable: false,
      });
      return undefined;
    }
    return uploads;
  }

  /** Sends a correlated, non-fatal `error` for an upload failure, mapping the store's own code (or a `FileInputError`) onto the wire registry. `fallback` is used when `err` is a plain string message rather than a thrown error. */
  private replyUploadError(msg: Record<string, unknown>, fallback: string, err: unknown): void {
    const message =
      typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    const code = typeof err === 'string' ? fallback : uploadWireCodeFor(err, fallback);
    this.replyTo(msg, {
      t: 'error',
      code,
      category: code.split('.')[2] ?? 'upload',
      message: sanitizeMessage(message),
      fatal: false,
      retryable: code === 'bgls.error.upload.hash_mismatch',
    });
  }

  private onSocketClosed(): void {
    this.state = 'closed';
    if (this.helloDeadlineTimer) clearTimeout(this.helloDeadlineTimer);
    if (this.managed && this.viewerId) this.managed.detachViewer(this.viewerId);
    // A caller that disconnects mid transfer leaves staged bytes behind.
    // The store's TTL sweep would eventually reclaim them, but the socket
    // closing is a much stronger signal than a timer: nothing will ever
    // finish these uploads, so they go now. COMPLETED uploads are left
    // alone on purpose: a client may legitimately stage a file, attach it,
    // and disconnect while the page still has the form open, and Chrome
    // reads the file lazily (see `files/upload-store.ts`), so discarding
    // on disconnect would break exactly the case the feature exists for.
    const uploads = this.deps.uploads;
    if (uploads !== undefined) {
      for (const uploadId of this.openUploads) {
        void uploads.discard(uploadId, this.tenantId).catch(() => undefined);
      }
    }
    this.openUploads.clear();
  }

  // ── hello / welcome ──────────────────────────────────────────────────

  private async processHello(hello: Hello): Promise<void> {
    const offered = hello.versions ?? [1];
    const minAccept = hello.minVersion ?? Math.min(...offered);
    let negotiated: { chosen: number; downgraded: boolean };
    try {
      negotiated = negotiateVersion(offered, minAccept, [...SUPPORTED_VERSIONS]);
    } catch (err) {
      const wireCode =
        err instanceof VersionNegotiationError
          ? 'bgls.error.version.unsupported'
          : 'bgls.error.version.unsupported';
      sendErrorAndClose(
        this,
        CloseCode.IncompatibleVersion,
        wireCode,
        'No mutually acceptable protocol version.',
      );
      return;
    }

    const outcome = await resolveCredential(this.upgradeCtx.preCarriers, hello.auth?.token, {
      resolver: this.deps.resolved.auth.resolver,
      store: this.deps.resolved.store,
      ticketRegistry: this.deps.ticketRegistry,
      tenantId: this.deps.resolved.tenantId,
      appId: this.deps.resolved.appId,
      maxCaps: this.deps.resolved.auth.maxCaps,
      origin: this.upgradeCtx.origin,
    });
    if (!outcome.ok) {
      sendErrorAndClose(this, outcome.closeCode, outcome.wireCode, outcome.message);
      return;
    }

    this.tenantId = outcome.principal.tenantId;
    this.appId = outcome.principal.appId;
    this.instanceId = outcome.instanceId;
    this.granted = new Set(outcome.principal.caps);
    this.viewerId = outcome.viewerId;
    // Before anything reads `this.granted`: `welcome.granted` is built from
    // it, `checkCapability` gates every inbound message on it, and
    // `attachViewer`/`resumeViewer` copy it into `ManagedSession`'s own
    // per-viewer capability map. A view-only viewer must be view-only in all
    // three, from the first message onward.
    this.viewOnly = declaresViewOnly(hello);
    this.narrowGrantedForViewOnly();

    let managed: ManagedSession;
    try {
      managed = await this.deps.sessionRegistry.getOrCreate(outcome.instanceId, {
        tenantId: this.tenantId,
        appId: this.appId,
      });
    } catch (err) {
      // `session/factory.ts`'s `ManagedSessionFactory` throws a `BglsError`
      // with code `E_INSTANCE_WRONG_NODE` when `router.driveInstance()`
      // resolves this instance to a different node: a real, running
      // instance this gateway process cannot serve, distinct from one that
      // genuinely does not exist. Answered with its own wire code
      // (`bgls.error.instance.wrong_node`) and `context.nodeId` so a
      // caller can tell "try a different gateway" apart from "give up",
      // instead of both collapsing into the same `instance.not_found`.
      // There is no reachable address for that node to hand back (see
      // `factory.ts`'s comment on `Node.dataPlaneUrl`); only the fact of
      // which node owns it.
      if (err instanceof BglsError && err.code === 'E_INSTANCE_WRONG_NODE') {
        sendErrorAndClose(
          this,
          CloseCode.PolicyViolation,
          'bgls.error.instance.wrong_node',
          err.message,
          err.context,
        );
        return;
      }
      sendErrorAndClose(
        this,
        CloseCode.PolicyViolation,
        'bgls.error.instance.not_found',
        err instanceof Error ? err.message : 'Instance is not reachable.',
      );
      return;
    }
    this.managed = managed;

    if (hello.resume) {
      const stopped = await this.resumeInto(managed, hello.resume.token, outcome.principal);
      if (stopped) return;
    } else {
      const stopped = await this.freshAttach(managed, hello, outcome.principal);
      if (stopped) return;
    }

    this.state = 'live';
    this.flushEarlyBuffer();
  }

  /**
   * Runs `onViewerJoined` before the socket is ever told it joined
   * anything: `resumed: false` for this path, `existingViewers` read from
   * `managed.viewerCount` BEFORE `attachViewer` adds this one, matching
   * the field's own doc ("the count before this join"). A veto here
   * cannot merely decline and let the caller carry on as an unattached
   * connection with no session behind it, so unlike
   * `onControlGranted`/`onNavigation` below (mid-session refusals that
   * leave everything else running) this one also closes the socket, with
   * `CloseCode.PolicyViolation` (4100), the same code
   * `E_INSTANCE_WRONG_NODE` above already uses for "this connection
   * cannot proceed for a reason that will not resolve itself on retry".
   * Returns whether the join was vetoed, so `processHello` knows not to
   * flip `this.state` to `'live'` or flush the early buffer for a socket
   * that is already closing.
   */
  private async freshAttach(
    managed: ManagedSession,
    hello: Hello,
    principal: Principal,
  ): Promise<boolean> {
    const joinEvent: ViewerJoinedEvent = {
      at: Date.now(),
      tenantId: this.tenantId,
      appId: this.appId,
      requestId: newId('evt'),
      sessionId: managed.sessionId,
      viewerId: this.viewerId,
      principal,
      resumed: false,
      remoteAddress: this.upgradeCtx.remoteAddress ?? '',
      userAgent: this.upgradeCtx.userAgent,
      existingViewers: managed.viewerCount,
    };
    const decision = await this.deps.hooks.dispatch('onViewerJoined', joinEvent);
    if (decision.vetoed) {
      sendVetoError(this, decision.reason, { hook: 'onViewerJoined' });
      this.sendEnvelope(
        buildGoodbye(CloseCode.PolicyViolation, decision.reason ?? 'Refused by onViewerJoined.'),
      );
      this.close(CloseCode.PolicyViolation, reasonForCloseCode(CloseCode.PolicyViolation));
      return true;
    }

    managed.attachViewer(this, {
      id: this.viewerId,
      tenantId: this.tenantId,
      appId: this.appId,
      subject: this.viewerId,
      capabilities: [...this.granted],
      kind: this.granted.has('automation') ? 'agent' : 'human',
      isAdmin: this.granted.has('admin'),
      connectedAtMs: Date.now(),
    });

    const welcome = await this.buildWelcome(managed, {
      resumed: false,
      reauth: false,
      resumeId: `re_${this.viewerId}`,
    });
    this.sendEnvelope(welcome as unknown as Record<string, unknown> & { t: string });
    // After welcome, never before: welcome must be sq 1, and
    // broadcastPresence() would otherwise consume it.
    managed.broadcastPresence();

    for (const sub of hello.subscribe ?? []) {
      void this.doSubscribe(sub.targetId, {
        ...(sub.quality !== undefined ? { quality: sub.quality } : {}),
        thumbnail: false,
        paused: false,
      });
    }
    return false;
  }

  /**
   * Same `onViewerJoined` gate as `freshAttach`, `resumed: true` here.
   * Returns `true` (meaning "stop, do not go live") both for the
   * pre-existing resume-rejected failures above and for a hook veto, so
   * `processHello` has one signal to check regardless of which reason
   * stopped the resume.
   */
  private async resumeInto(
    managed: ManagedSession,
    token: string,
    principal: Principal,
  ): Promise<boolean> {
    const result = this.deps.resumeStore.verifyAndConsume(token, Date.now());
    if (!result.ok) {
      sendErrorAndClose(
        this,
        CloseCode.ResumeRejected,
        'bgls.error.protocol.bad_envelope',
        `Resume rejected: ${result.reason}.`,
      );
      return true;
    }
    const snapshot = result.snapshot;
    if (
      snapshot.tenantId !== this.tenantId ||
      snapshot.appId !== this.appId ||
      snapshot.sessionId !== managed.sessionId
    ) {
      sendErrorAndClose(
        this,
        CloseCode.ResumeRejected,
        'bgls.error.protocol.bad_envelope',
        'Resume token does not match this session.',
      );
      return true;
    }

    const joinEvent: ViewerJoinedEvent = {
      at: Date.now(),
      tenantId: this.tenantId,
      appId: this.appId,
      requestId: newId('evt'),
      sessionId: managed.sessionId,
      viewerId: snapshot.viewerId,
      principal,
      resumed: true,
      remoteAddress: this.upgradeCtx.remoteAddress ?? '',
      userAgent: this.upgradeCtx.userAgent,
      existingViewers: managed.viewerCount,
    };
    const decision = await this.deps.hooks.dispatch('onViewerJoined', joinEvent);
    if (decision.vetoed) {
      sendVetoError(this, decision.reason, { hook: 'onViewerJoined' });
      this.sendEnvelope(
        buildGoodbye(CloseCode.PolicyViolation, decision.reason ?? 'Refused by onViewerJoined.'),
      );
      this.close(CloseCode.PolicyViolation, reasonForCloseCode(CloseCode.PolicyViolation));
      return true;
    }

    this.viewerId = snapshot.viewerId;

    // BEFORE `resumeViewer`, deliberately, and before anything is written to
    // this socket. Restoring a lease emits a BROADCAST `control.state`, and
    // with this connection already registered that broadcast was written
    // ahead of its own `welcome`, costing `welcome` its guaranteed `sq: 1`
    // and handing the client a broadcast where the handshake should be. See
    // `ManagedSession.restoreLeasesFor()` for the full reasoning and for why
    // the reconnecting viewer loses nothing by not receiving it: it is told
    // the same facts by `resumed.lease` and `welcome.lease.byTarget` below.
    const restoredLease = managed.restoreLeasesFor(this.viewerId);
    const leaseRestored = restoredLease !== null;

    // `resumeViewer` (not the ordinary `attachViewer`) reads back which
    // targets this exact `viewerId` was subscribed to before it
    // disconnected, from `ManagedSession`'s own retained bookkeeping: the
    // resume token itself carries no subscription snapshot (see
    // `wire/resume-store.ts`'s `ResumeSnapshot` doc).
    const { restoredTargetIds } = managed.resumeViewer(this, {
      id: this.viewerId,
      tenantId: this.tenantId,
      appId: this.appId,
      subject: this.viewerId,
      capabilities: [...this.granted],
      kind: this.granted.has('automation') ? 'agent' : 'human',
      isAdmin: this.granted.has('admin'),
      connectedAtMs: Date.now(),
    });

    const restoredStreams: {
      streamId: number;
      targetId: string;
      quality: QualityProfile;
      codec: 'jpeg';
      missedFrames: number;
      keyframePending: true;
    }[] = [];
    for (const targetId of restoredTargetIds) {
      const fields = await managed.subscribe(this.viewerId, targetId, {});
      const handle = managed.coreSession.streamHandleFor(targetId);
      // `sidEpoch` bumped on every resume even when geometry is unchanged,
      // as the protocol requires; `gen` is left as-is, since this build never
      // tears the underlying CDP session down for a resume.
      handle?.stream.bumpSidEpoch(Date.now());
      restoredStreams.push({
        streamId: fields.streamId,
        targetId,
        quality: fields.quality,
        codec: 'jpeg',
        missedFrames: 0,
        keyframePending: true,
      });
    }

    const welcome = await this.buildWelcome(managed, {
      resumed: true,
      reauth: false,
      resumeId: `re_${this.viewerId}`,
    });
    this.sendEnvelope(welcome as unknown as Record<string, unknown> & { t: string });
    this.sendEnvelope({
      t: 'resumed',
      sessionId: managed.sessionId,
      viewerId: this.viewerId,
      streams: restoredStreams,
      lease: restoredLease,
      leaseRestored,
      missedControl: 0,
      targets: managed.listTargets(),
      resume: welcome.resume,
    });
    managed.broadcastPresence();
    return false;
  }

  private handleReauth(hello: Hello): void {
    void (async () => {
      const outcome = await resolveCredential(this.upgradeCtx.preCarriers, hello.auth?.token, {
        resolver: this.deps.resolved.auth.resolver,
        store: this.deps.resolved.store,
        ticketRegistry: this.deps.ticketRegistry,
        tenantId: this.deps.resolved.tenantId,
        appId: this.deps.resolved.appId,
        maxCaps: this.deps.resolved.auth.maxCaps,
        origin: this.upgradeCtx.origin,
      });
      if (!outcome.ok) {
        sendErrorAndClose(this, outcome.closeCode, outcome.wireCode, outcome.message);
        return;
      }
      const previous = this.granted;
      this.granted = new Set(outcome.principal.caps);
      // Re-applied on every reauth, and this is the whole point of keeping
      // `viewOnly` on the connection instead of deriving it once. A reauth
      // replaces `granted` wholesale from a freshly resolved token, and a
      // token perfectly reasonably carries `control`: without this line, a
      // viewer who joined as view-only would be silently promoted into a
      // control-capable connection by an event that has nothing to do with
      // the choice they made. `hello{reauth:true}` is a credential refresh,
      // not a change of mind about driving.
      this.narrowGrantedForViewOnly();
      // Computed AFTER the view-only narrowing, and both calls below are fed
      // the narrowed set rather than the raw token capabilities. Feeding
      // `ManagedSession` the un-narrowed set would have handed it a
      // `control`-carrying capability set for a connection that cannot send
      // a single input message, which is exactly the "silently promoted into
      // control" case this whole path exists to prevent: `presence`,
      // diagnostics gating and `applyCapabilityShrink`'s own decision would
      // all have been made against capabilities this viewer does not have.
      const effectiveCaps = [...this.granted];
      const isShrink = [...previous].some((c) => !this.granted.has(c));
      if (this.managed) {
        // Widen or shrink, `ManagedSession` needs to know this connection's
        // capabilities changed right away: `setViewerCapabilities` keeps
        // diagnostics delivery's `devtools` gate current regardless of which
        // direction the reauth moved, while `applyCapabilityShrink` (lease
        // revocation, the `capabilities.updated` broadcast) stays gated on
        // an actual shrink, unchanged from before.
        this.managed.setViewerCapabilities(this.viewerId, effectiveCaps);
        if (isShrink) this.managed.applyCapabilityShrink(this.viewerId, effectiveCaps);
        const welcome = await this.buildWelcome(this.managed, {
          resumed: false,
          reauth: true,
          resumeId: `re_${this.viewerId}`,
        });
        this.sendEnvelope(welcome as unknown as Record<string, unknown> & { t: string });
      }
    })();
  }

  /**
   * Removes every capability that lets this connection DRIVE a browser,
   * when it declared itself view-only in `hello`.
   *
   * Requirement, in the user's words: "view or view and control", chosen
   * freely. The second half of that is easy, shared control grants it
   * immediately. The first half is the one that needed real enforcement:
   * view-only has to be a state the server holds a viewer in, not merely
   * the absence of a lease. "Did not get the lease" is a race that resolves
   * the moment anything grants one; a state does not.
   *
   * WHY THIS AND NOT A NEW WIRE FIELD. `hello.capabilities.input[]` already
   * exists, is already a hard constraint in the other direction (the
   * `codecs` list beside it is documented as "a hard constraint: the server
   * MUST NOT send a codec absent from this list"), and was read by nothing
   * on the server at all: every client in this repo sends the same
   * `['mouse','key','text','touch','scroll']` and the server ignored it. A
   * client declaring it produces NO input kinds is making exactly the
   * statement view-only needs, in a field that already means that, so this
   * needed no protocol change, no new negotiated field, and no coordination
   * with the engine or wire lanes.
   *
   * WHY NARROWING `granted` RATHER THAN A SEPARATE GATE. `checkCapability`
   * already runs on EVERY inbound message, every time, and already maps
   * `input.mouse`/`input.key`/`input.text`/`input.touch`/`input.composition`
   * AND `control.request`/`control.renew`/`control.release` to the `control`
   * capability. Dropping `control` here therefore closes the input path and
   * the lease-acquisition path together, through the one enforcement point
   * that is already audited and already tested, instead of adding a second
   * gate that a future message type could be added without. It also makes
   * `welcome.granted` tell the truth, which is what a UI needs to render a
   * view-only viewer as view-only without a new field of its own.
   *
   * `dialog.answer` goes too, for the same reason `input.*` does: answering
   * a `beforeunload` or a `window.confirm` is driving the page.
   *
   * `view`, `navigate`, `capture`, `tabs.manage`, `devtools` and the rest
   * are deliberately untouched. View-only is about not driving the page
   * surface, not about being a second-class viewer, and a token that was
   * issued without those never had them here anyway.
   */
  private narrowGrantedForViewOnly(): void {
    if (!this.viewOnly) return;
    for (const cap of VIEW_ONLY_WITHHELD_CAPABILITIES) this.granted.delete(cap);
  }

  /**
   * Asynchronous solely because of `welcome.instance.viewport`, which is
   * read from the live browser rather than guessed. See
   * `ManagedSession.instanceViewport()` for the measurement that forced it.
   * The read is cached per session, so exactly one handshake per session
   * pays a CDP round trip for it and every later one is synchronous in
   * practice.
   */
  private async buildWelcome(
    managed: ManagedSession,
    opts: { readonly resumed: boolean; readonly reauth: boolean; readonly resumeId: string },
  ): Promise<Welcome> {
    const instanceViewport = await managed.instanceViewport();
    const resolved = this.deps.resolved;
    const fields = buildWelcomeFields(resolved);
    const resumeWindowMs = resolved.session.resumeWindowMs;
    const minted = this.deps.resumeStore.mint(
      {
        sessionId: managed.sessionId,
        viewerId: this.viewerId,
        tenantId: this.tenantId,
        appId: this.appId,
        lastControlSq: this.sqCounter,
      },
      resumeWindowMs,
      Date.now(),
    );

    let sessionToken = '';
    let sessionTokenExpiresAt = Date.now() + 900_000;
    try {
      // `issueWithMeta` is synchronous-shaped but declared `Promise`-returning
      // by `TokenApi`; fire it and fall back to an empty credential if
      // signing keys are not configured, rather than failing the whole
      // handshake over a `welcome.sessionToken` field most embedded/dev
      // deployments never actually consult.
      void this.deps.tokenApi
        .issueWithMeta({
          sub: this.viewerId,
          caps: [...this.granted],
          scope: { kind: 'instance', instanceId: this.instanceId, targets: '*' },
          tenantId: resolved.tenantId,
          appId: resolved.appId,
          ttlSeconds: 900,
        })
        .then((issued) => {
          sessionToken = issued.token;
          sessionTokenExpiresAt = issued.expiresAt;
        })
        .catch(() => undefined);
    } catch {
      // best-effort only, see above
    }

    return {
      v: 1,
      t: 'welcome',
      re: '',
      ts: Date.now(),
      sq: 1,
      version: 1,
      serverVersion: '1.0.0',
      downgraded: false,
      viewerId: this.viewerId,
      sessionId: managed.sessionId,
      tenantId: this.tenantId,
      appId: this.appId,
      instance: {
        instanceId: this.instanceId,
        state: 'running',
        engine: 'chromium',
        channel: 'stable',
        engineVersion: '',
        headless: true,
        runtime: 'host',
        nodeId: managed.nodeId,
        profile: { mode: 'ephemeral', key: '', sizeBytes: 0 },
        // The browser's real rendered viewport, not a guess. An
        // `AutomationClient` stamps this onto every input envelope as
        // `fw`/`fh`, so a wrong value here puts every one of its clicks in
        // the wrong place. `dpr` stays 1: `Page.getLayoutMetrics` reports
        // CSS pixels and carries no device scale factor, and nothing in the
        // input path consumes `dpr`, so inventing one would be a second
        // fabricated field rather than a fix.
        viewport: { width: instanceViewport.width, height: instanceViewport.height, dpr: 1 },
        startedAt: Date.now(),
      },
      targets: managed.listTargets(),
      granted: [...this.granted],
      lease: {
        // Was hardcoded `{}`. See `ManagedSession.leaseSummariesFor()` for
        // why this is projected by the engine rather than assembled here,
        // and why it is scoped to the session's known targets rather than
        // to every listed one.
        byTarget: managed.leaseSummariesFor(this.viewerId),
        defaultTtlMs: 60_000,
        renewWithinMs: 15_000,
        idleReleaseMs: 20_000,
        maxQueue: 32,
      },
      presence: {
        viewers: managed.allConnections().map((c) => ({
          viewerId: c.viewerId,
          label: c.viewerId,
          kind: 'human',
          controlling: [],
        })),
      },
      limits: fields.limits,
      ack: fields.ack,
      streaming: fields.streaming,
      resume: { token: minted.token, windowMs: minted.windowMs, issuedAt: minted.issuedAt },
      sessionToken,
      sessionTokenExpiresAt,
      resumed: opts.resumed,
      reauth: opts.reauth,
      serverTime: Date.now(),
      notices: [],
    };
  }

  private flushEarlyBuffer(): void {
    const buffered = this.earlyBuffer.splice(0);
    this.earlyBufferBytes = 0;
    for (const buf of buffered) {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        this.dispatch(msg);
      } catch {
        // malformed early message: dropped, never closes the socket.
      }
    }
  }

  // ── dispatch ─────────────────────────────────────────────────────────

  private rateLimiters: ViewerRateLimiters | undefined;

  private ensureRateLimiters(): ViewerRateLimiters {
    this.rateLimiters ??= new ViewerRateLimiters(
      rateLimitInputsFor(this.deps.resolved),
      performance.now(),
    );
    return this.rateLimiters;
  }

  private dispatch(msg: Record<string, unknown>): void {
    const t = typeof msg['t'] === 'string' ? (msg['t'] as string) : undefined;
    if (t === undefined) return;

    if (t === 'hello') {
      if (msg['reauth'] === true) this.handleReauth(msg as unknown as Hello);
      else this.close(CloseCode.MissingParams, 'duplicate_hello');
      return;
    }

    const bucket = bucketFor(t);
    if (bucket) {
      const nowMono = performance.now();
      // `input`/`control` are rate limited per target and `ack` per stream,
      // not once for the whole connection (`ViewerRateLimiters`'s own doc
      // comment explains what each scope is protecting against). Reading
      // the scope here, ahead of this message type's real handler and
      // validation, is what makes that possible without deferring the rate
      // check past the "before any work is done" point every other bucket
      // still enforces at.
      const scope =
        bucket === 'ack'
          ? typeof msg['streamId'] === 'number'
            ? String(msg['streamId'])
            : undefined
          : typeof msg['targetId'] === 'string'
            ? (msg['targetId'] as string)
            : undefined;
      if (!this.ensureRateLimiters().take(bucket, nowMono, scope)) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.limit.rate',
          category: 'limit',
          message: `Rate limit exceeded for ${t}.`,
          fatal: false,
          retryable: true,
          retryAfterMs: 1000,
        });
        return;
      }
    }

    const capCheck = checkCapability(t, msg, this.granted);
    if (!capCheck.ok) {
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.cap.missing',
        category: 'cap',
        message: `Capability "${capCheck.required}" is required for "${t}".`,
        fatal: false,
        retryable: false,
        context: { required: capCheck.required },
      });
      return;
    }

    const handler = this.handlers[t];
    if (!handler) {
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.protocol.unknown_type',
        category: 'protocol',
        message: `Unknown message type "${t}".`,
        fatal: false,
        retryable: false,
      });
      return;
    }
    void Promise.resolve(handler.call(this, msg)).catch((err: unknown) => {
      // A handler threw or its promise rejected (for example a dead
      // `CdpBridge` after the browser process exited underneath a live
      // session). Left uncaught, this was both a process level
      // `unhandledRejection` and a silent hang for the caller: whatever UI
      // action sent `t` would wait forever for a reply that never came
      // (the demo's `Close` button, found not replying at all when the
      // instance's Chrome had already died). Every handler failure now gets a correlated,
      // non-fatal `error` reply instead, so the caller's `request()`
      // promise settles either way, plus a real log line for whoever is
      // operating the gateway.
      this.deps.logger.error(
        { component: 'ws' },
        `handler for "${t}" failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.internal',
        category: 'internal',
        message: `"${t}" failed.`,
        fatal: false,
        retryable: true,
      });
    });
  }

  private readonly handlers: Record<
    string,
    (msg: Record<string, unknown>) => void | Promise<void>
  > = {
    ping: (msg) => this.sendEnvelope({ t: 'pong', cts: msg['cts'], sts: Date.now() }),
    ack: (msg) =>
      this.managed?.ack(
        this.viewerId,
        num(msg['streamId']),
        num(msg['seq']),
        typeof msg['decodeMs'] === 'number' ? msg['decodeMs'] : undefined,
      ),
    'keyframe.request': async (msg) => {
      await this.managed?.requestKeyframe(this.viewerId, num(msg['streamId']));
    },

    'target.list': (msg) => {
      const includeKinds = Array.isArray(msg['includeKinds'])
        ? (msg['includeKinds'] as TargetKind[])
        : undefined;
      this.replyTo(msg, {
        t: 'target.listed',
        targets: this.managed?.listTargets(includeKinds) ?? [],
      });
    },
    'target.activate': async (msg) => {
      const targetId = str(msg['targetId']);
      await this.managed?.activateTarget(targetId);
      this.replyTo(msg, { t: 'target.updated', targetId, changed: { active: true } });
    },
    'target.new': async (msg) => {
      const t = await this.managed?.newTarget(
        typeof msg['url'] === 'string' ? msg['url'] : undefined,
        typeof msg['background'] === 'boolean' ? msg['background'] : undefined,
        typeof msg['newWindow'] === 'boolean' ? msg['newWindow'] : undefined,
      );
      if (t) this.replyTo(msg, { t: 'target.created', target: t });
    },
    'target.reorder': (msg) => {
      // Fire and forget on the wire (the client sends it with `trySend`, not
      // `request`), and it had no handler at all, so `tabs.reorder()` was a
      // shipped API that silently did nothing. The new order is broadcast,
      // never merely replied to, because tab order is a property of the
      // Instance that every viewer of it renders.
      const targetIds = Array.isArray(msg['targetIds'])
        ? (msg['targetIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      if (targetIds.length === 0) return;
      this.managed?.reorderTargets(targetIds);
    },
    'target.close': async (msg) => {
      const targetId = str(msg['targetId']);
      await this.managed?.closeTarget(targetId);
      this.replyTo(msg, { t: 'target.closed', targetId, reason: 'user' });
    },

    'stream.subscribe': async (msg) => {
      const quality =
        typeof msg['quality'] === 'string' ? (msg['quality'] as QualityProfile) : undefined;
      await this.doSubscribe(
        str(msg['targetId']),
        {
          ...(quality !== undefined ? { quality } : {}),
          thumbnail: msg['thumbnail'] === true,
          paused: msg['paused'] === true,
        },
        msg,
      );
    },
    'stream.unsubscribe': (msg) => this.managed?.unsubscribe(this.viewerId, num(msg['streamId'])),
    'stream.pause': () => undefined,
    'stream.resume': () => undefined,
    'stream.quality': async (msg) => {
      const quality =
        typeof msg['quality'] === 'string' ? (msg['quality'] as QualityProfile) : undefined;
      const maxWidth = typeof msg['maxWidth'] === 'number' ? msg['maxWidth'] : undefined;
      const maxHeight = typeof msg['maxHeight'] === 'number' ? msg['maxHeight'] : undefined;
      const fields = await this.managed?.reconfigureStream(this.viewerId, num(msg['streamId']), {
        ...(quality !== undefined ? { quality } : {}),
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        ...(maxHeight !== undefined ? { maxHeight } : {}),
      });
      if (fields) this.replyTo(msg, { t: 'stream.subscribed', ...fields });
    },

    // Relayed to the other viewers, never echoed back to the sender. The
    // `cursor` rate bucket for this type already existed at
    // `bucketFor()` below; the handler did not, so every cursor a viewer
    // sent was answered with `unknown_type` and shared cursor presence was
    // silently dead. See `ManagedSession.relayCursor()`.
    'presence.cursor': (msg) => {
      this.managed?.relayCursor(this.viewerId, {
        targetId: str(msg['targetId']),
        x: num(msg['x']),
        y: num(msg['y']),
        fw: num(msg['fw']),
        fh: num(msg['fh']),
        ...(typeof msg['action'] === 'string' ? { action: msg['action'] } : {}),
        ...(typeof msg['label'] === 'string' ? { label: msg['label'] } : {}),
      });
    },

    'input.mouse': (msg) => this.managed?.dispatchInput(this.viewerId, msg),
    'input.key': (msg) => this.managed?.dispatchInput(this.viewerId, msg),
    'input.text': (msg) => this.managed?.dispatchInput(this.viewerId, msg),
    'input.touch': (msg) => this.managed?.dispatchInput(this.viewerId, msg),
    'input.composition': (msg) => this.managed?.dispatchInput(this.viewerId, msg),
    'input.drag': (msg) => this.managed?.dispatchInput(this.viewerId, msg),

    'control.request': async (msg) => {
      const identity = this.viewerIdentity();
      const reason = typeof msg['reason'] === 'string' ? sanitizeMessage(msg['reason']) : undefined;
      const requestId = typeof msg['id'] === 'string' ? msg['id'] : undefined;
      const targetId = str(msg['targetId']);
      const force = msg['force'] === true;
      if (this.managed && !(await this.checkControlGranted(msg, targetId, force))) return;
      this.managed?.requestControl(identity, targetId, {
        ...(reason !== undefined ? { reason } : {}),
        force,
        queue: msg['queue'] !== false,
        ...(requestId !== undefined ? { requestId } : {}),
      });
    },
    'control.renew': async (msg) => {
      await this.managed?.renewControl(this.viewerId, str(msg['targetId']), str(msg['leaseId']));
    },
    'control.release': async (msg) => {
      await this.managed?.releaseControl(this.viewerId, str(msg['targetId']), str(msg['leaseId']));
    },
    'control.revoke': async (msg) => {
      await this.managed?.revokeControl(
        this.viewerIdentity(),
        str(msg['targetId']),
        str(msg['holderViewerId']),
        typeof msg['reason'] === 'string' ? msg['reason'] : undefined,
      );
    },

    /**
     * `control.yield`: stand the AGENTS on this target down, leave every
     * person driving. Gated on `control`, not `admin`
     * (`wire/capability-check.ts`).
     *
     * The success path deliberately sends nothing back, matching
     * `control.revoke` directly above and `control.renew`/`control.release`
     * above that: `packages/client`'s `BrowserGlassClient` sends every
     * control message except `control.request` with `trySend`, never
     * `request()`, so none of them awaits a correlated reply. Making this
     * one the exception would be a shape no client is built against.
     *
     * The two FAILURE paths do reply, because they are the whole reason
     * these have dedicated error codes: both mean the client sent the wrong message, and a client
     * that watches a message vanish learns nothing. `not_shared` is a
     * `control.yield` aimed at an exclusive target, where a person already
     * takes over through `control.request`; `not_human` is an automation
     * client sending a message that only a person may send, which the
     * priority ladder already handles for agent versus agent.
     *
     * A success carrying an EMPTY `notified` list is still a success, not an
     * error: "no automation is driving this page" is the state the caller
     * wanted. It is also the one case that produces no wire traffic at all,
     * so a caller cannot tell it from a dropped message; a `control.yielded`
     * ack would close that, and would need a new message in
     * `protocol/wire/messages/control.ts`.
     */
    'control.yield': async (msg) => {
      const result = await this.managed?.yieldControl(
        this.viewerIdentity(),
        str(msg['targetId']),
        typeof msg['reason'] === 'string' ? sanitizeMessage(msg['reason']) : undefined,
      );
      if (!result || result.ok) return;
      this.replyTo(
        msg,
        result.error === 'not_shared'
          ? {
              t: 'error',
              code: 'bgls.error.control.not_shared',
              category: 'control',
              message: 'control.yield applies to shared targets; this target is exclusive.',
              fatal: false,
              retryable: false,
            }
          : {
              t: 'error',
              code: 'bgls.error.control.not_human',
              category: 'control',
              message: 'control.yield may only be sent by a human viewer.',
              fatal: false,
              retryable: false,
            },
      );
    },

    'nav.goto': async (msg) => this.runNav(msg, 'goto', { url: str(msg['url']) }),
    'nav.back': async (msg) => this.runNav(msg, 'back', {}),
    'nav.forward': async (msg) => this.runNav(msg, 'forward', {}),
    'nav.reload': async (msg) =>
      this.runNav(msg, 'reload', { ignoreCache: msg['ignoreCache'] === true }),
    'nav.stop': async (msg) => this.runNav(msg, 'stop', {}),

    'target.capture': async (msg) => {
      const format =
        msg['format'] === 'png' || msg['format'] === 'jpeg' ? msg['format'] : undefined;
      const quality = typeof msg['quality'] === 'number' ? msg['quality'] : undefined;
      const result = await this.managed?.capture(str(msg['targetId']), {
        ...(format !== undefined ? { format } : {}),
        ...(quality !== undefined ? { quality } : {}),
      });
      if (result)
        this.replyTo(msg, {
          t: 'target.captured',
          captureId: `cap_${Date.now()}`,
          targetId: str(msg['targetId']),
          format: result.format,
          // Real dimensions and DPR, read back from the encoded bytes by
          // `ManagedSession.capture()` rather than hardcoded: see that
          // method's comment for why 0/0/1 here was wrong.
          width: result.width,
          height: result.height,
          dpr: result.dpr,
          sizeBytes: Buffer.byteLength(result.data, 'base64'),
          // The target's LIVE generation, from the same source
          // `InputDispatcher` fences against. This was a hardcoded `0`,
          // which is the identical defect `target.probe` below carries a
          // long comment about, in the reply right next to it: `Stream.gen`
          // seeds at 1 and `resolveGenFencing` is pure equality, so `0`
          // matches nothing that is alive.
          //
          // It was worse here than on the probe, because it did not merely
          // fail to help, it actively POISONED a client that was otherwise
          // working. `AutomationClient.screenshot()` caches this value into
          // `AutomationCore.genByTarget`, the same cache `ensureGen()`
          // fills, and that cache is read-once with no invalidation. So an
          // agent that took a screenshot at any point before its first
          // click had every subsequent `input.mouse` and `input.key` on
          // that target dropped as `gen_stale`, permanently, while
          // `evaluate`, `select`, `setInputFiles` and every other non-input
          // verb kept working. Measured directly: click and type before a
          // screenshot dispatch normally; after one, the page receives
          // nothing at all and the only trace is a single coalesced
          // `input dropped ... stale target generation (expected 1,
          // received 0)` line in the server log.
          gen: this.managed?.currentGenFor(str(msg['targetId'])) ?? 0,
          fullPage: false,
          data: result.data,
          downscaled: false,
        });
    },

    /**
     * `page.pdf.get` (`@browserglass/protocol`'s `wire/messages/pdf.ts`),
     * gated on `capture`: the capability check already ran by the time
     * this handler is entered (see this file's own header doc), so there
     * is no second copy of it here. Same shape as `page.a11y.get`/
     * `page.map.get` above: this handler owns VALIDATION and OUTCOME
     * MAPPING, `ManagedSession.pdf()` owns everything CDP- and
     * delivery-side.
     *
     * There is deliberately no "result too large, silently truncated"
     * case here, the same as `page.a11y.get`'s own doc states for itself:
     * a PDF that will not fit on the control channel is never truncated,
     * it is EITHER delivered as a `downloadId`/`url` pair (the common
     * case for any real page, see `wire/messages/pdf.ts`'s module doc) OR
     * refused outright as `bgls.error.capture.too_large` when even that
     * cannot happen (no download store configured, or the file exceeds
     * the store's own ceiling).
     */
    'page.pdf.get': async (msg) => {
      const targetId = str(msg['targetId']);

      const invalid = (reason: string): void => {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.protocol.bad_envelope',
          category: 'protocol',
          message: reason,
          fatal: false,
          retryable: false,
        });
      };

      if (targetId.length === 0) {
        invalid('targetId is required.');
        return;
      }

      const format =
        typeof msg['format'] === 'string' ? (msg['format'] as PdfPaperFormat) : undefined;
      const widthInches = typeof msg['widthInches'] === 'number' ? msg['widthInches'] : undefined;
      const heightInches =
        typeof msg['heightInches'] === 'number' ? msg['heightInches'] : undefined;
      if (format !== undefined && (widthInches !== undefined || heightInches !== undefined)) {
        invalid('format is mutually exclusive with widthInches/heightInches.');
        return;
      }
      if ((widthInches !== undefined) !== (heightInches !== undefined)) {
        invalid('widthInches and heightInches must be given together.');
        return;
      }
      const scale = typeof msg['scale'] === 'number' ? msg['scale'] : undefined;
      if (scale !== undefined && (scale < 0.1 || scale > 2)) {
        invalid('scale must be between 0.1 and 2.');
        return;
      }

      const managed = this.managed;
      if (!managed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.capture.failed',
          category: 'capture',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }

      let outcome: Awaited<ReturnType<ManagedSession['pdf']>>;
      try {
        outcome = await managed.pdf(targetId, {
          ...(format !== undefined ? { format } : {}),
          ...(widthInches !== undefined ? { widthInches } : {}),
          ...(heightInches !== undefined ? { heightInches } : {}),
          ...(typeof msg['landscape'] === 'boolean' ? { landscape: msg['landscape'] } : {}),
          ...(typeof msg['printBackground'] === 'boolean'
            ? { printBackground: msg['printBackground'] }
            : {}),
          ...(scale !== undefined ? { scale } : {}),
          ...(typeof msg['marginTopInches'] === 'number'
            ? { marginTopInches: msg['marginTopInches'] }
            : {}),
          ...(typeof msg['marginBottomInches'] === 'number'
            ? { marginBottomInches: msg['marginBottomInches'] }
            : {}),
          ...(typeof msg['marginLeftInches'] === 'number'
            ? { marginLeftInches: msg['marginLeftInches'] }
            : {}),
          ...(typeof msg['marginRightInches'] === 'number'
            ? { marginRightInches: msg['marginRightInches'] }
            : {}),
          ...(typeof msg['pageRanges'] === 'string'
            ? { pageRanges: sanitizeMessage(msg['pageRanges']) }
            : {}),
          ...(typeof msg['headerTemplate'] === 'string'
            ? { headerTemplate: sanitizeMessage(msg['headerTemplate']) }
            : {}),
          ...(typeof msg['footerTemplate'] === 'string'
            ? { footerTemplate: sanitizeMessage(msg['footerTemplate']) }
            : {}),
        });
      } catch (err) {
        if (err instanceof PrintToPdfOptionsError) {
          invalid(err.message);
          return;
        }
        const code =
          err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
        const wireCode =
          code === 'E_CDP_TIMEOUT'
            ? 'bgls.error.capture.failed'
            : code === 'E_CDP_TARGET_NOT_FOUND' || code === 'E_CDP_TARGET_CLOSED'
              ? 'bgls.error.target.not_found'
              : 'bgls.error.capture.failed';
        this.replyTo(msg, {
          t: 'error',
          code: wireCode,
          category: wireCode === 'bgls.error.target.not_found' ? 'target' : 'capture',
          message:
            err instanceof Error ? err.message : `page.pdf.get failed for target "${targetId}".`,
          fatal: false,
          retryable: wireCode !== 'bgls.error.target.not_found',
        });
        return;
      }

      if (outcome.kind === 'refused') {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.capture.too_large',
          category: 'capture',
          message:
            outcome.reason === 'downloads_unavailable'
              ? `The rendered PDF is ${outcome.sizeBytes} bytes, too large to inline, and this gateway has no download store configured to deliver it another way.`
              : `The rendered PDF is ${outcome.sizeBytes} bytes, exceeding the configured download size ceiling.`,
          fatal: false,
          retryable: false,
        });
        return;
      }

      this.replyTo(msg, {
        t: 'page.pdf.got',
        pdfId: outcome.pdfId,
        targetId,
        sizeBytes: outcome.sizeBytes,
        gen: outcome.gen,
        ...(outcome.kind === 'inline' ? { data: outcome.data } : {}),
        ...(outcome.kind === 'download'
          ? {
              downloadId: outcome.downloadId,
              url: outcome.url,
              expiresAt: outcome.expiresAt,
              sha256: outcome.sha256,
            }
          : {}),
      });
    },

    /**
     * `recording.start`/`.stop`/`.list` (`@browserglass/protocol`'s
     * `wire/messages/recording.ts`). `checkCapability` has already
     * required `capture` by the time any of these three handlers is
     * entered (`wire/capability-check.ts`'s table). What THIS code owns,
     * beyond what that generic check cannot express: the SECOND
     * capability this family requires, `download`
     * ({@link requireDownloadCapability}; see the capability table's own
     * comment on its `recording.*` entries for why the two are required
     * together and why this cannot be a `ParamCapabilityRule`), plus
     * VALIDATION and OUTCOME MAPPING for `ManagedSession`'s three
     * methods, the same split `page.pdf.get`/`page.responsebody.get`
     * above already use.
     */
    'recording.start': async (msg) => {
      if (!this.requireDownloadCapability(msg)) return;
      const targetId = str(msg['targetId']);
      if (targetId.length === 0) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.protocol.bad_envelope',
          category: 'protocol',
          message: 'targetId is required.',
          fatal: false,
          retryable: false,
        });
        return;
      }
      const mode = msg['mode'] === 'thumbnail' ? 'thumbnail' : 'live';
      const managed = this.managed;
      if (!managed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.target.not_found',
          category: 'target',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }
      try {
        const summary = await managed.startRecording(targetId, { mode });
        this.replyTo(msg, {
          t: 'recording.started',
          recordingId: summary.recordingId,
          targetId: summary.targetId,
          mode: summary.mode,
          startedAtMs: summary.startedAtMs,
        });
      } catch (err) {
        this.replyTo(msg, recordingErrorReply(err, targetId));
      }
    },

    'recording.stop': async (msg) => {
      if (!this.requireDownloadCapability(msg)) return;
      const recordingId = str(msg['recordingId']);
      if (recordingId.length === 0) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.protocol.bad_envelope',
          category: 'protocol',
          message: 'recordingId is required.',
          fatal: false,
          retryable: false,
        });
        return;
      }
      const managed = this.managed;
      if (!managed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.target.not_found',
          category: 'target',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }
      try {
        const summary = await managed.stopRecording(recordingId);
        this.replyTo(msg, {
          t: 'recording.stopped',
          recordingId: summary.recordingId,
          targetId: summary.targetId,
          startedAtMs: summary.startedAtMs,
          stoppedAtMs: summary.stoppedAtMs ?? Date.now(),
          framesWritten: summary.framesWritten,
          failed: summary.failed,
        });
      } catch (err) {
        this.replyTo(msg, recordingErrorReply(err, recordingId));
      }
    },

    'recording.list': async (msg) => {
      if (!this.requireDownloadCapability(msg)) return;
      const targetId = typeof msg['targetId'] === 'string' ? msg['targetId'] : undefined;
      const managed = this.managed;
      if (!managed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.target.not_found',
          category: 'target',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }
      this.replyTo(msg, { t: 'recording.listed', recordings: managed.listRecordings(targetId) });
    },

    'target.probe': async (msg) => {
      const result = await this.managed?.probe(str(msg['targetId']), num(msg['x']), num(msg['y']));
      if (result) {
        this.replyTo(msg, {
          t: 'target.probed',
          targetId: str(msg['targetId']),
          detail: (msg['detail'] as string) ?? 'hover',
          // The target's LIVE generation, read from the same source
          // `InputDispatcher` fences against (`core`'s
          // `Session.buildInputDispatcher`'s `getGeneration`, which is
          // `streamHandleFor(targetId)?.stream.gen ?? 0`). This was a
          // hardcoded `0`, and `0` is not a sentinel: `Stream.gen` seeds at
          // 1, `resolveGenFencing` is pure equality with no special case for
          // zero, and `TargetProbed.gen` is specified as "the generation it
          // was computed against". So a probe on any target with a stream
          // answered with a generation that matched nothing.
          //
          // Invisible to a subscribed viewer, which learns its generation
          // from `stream.subscribed` and the `nav.state`/`target.updated`
          // that follow, and never asks a probe for it. Fatal to an
          // `AutomationClient`, which has no subscription:
          // `AutomationCore.ensureGen()` reads the generation from
          // `target.probe` and caches it for the life of the client, so
          // every `input.mouse` it ever sent for that target carried
          // `gen: 0` and was error-dropped by `resolveGenFencing`. An agent's
          // input had therefore never dispatched by default.
          gen: this.managed?.currentGenFor(str(msg['targetId'])) ?? 0,
          hit: result.hit,
          ...(result.rect ? { rect: result.rect } : {}),
          ...(result.tagName ? { tagName: result.tagName } : {}),
          ...(result.label ? { label: sanitizeMessage(result.label) } : {}),
          ...(result.href !== undefined ? { href: result.href } : {}),
        });
      }
    },

    /**
     * `page.evaluate` (`@browserglass/protocol`'s
     * `wire/messages/evaluate.ts`), gated on the `evaluate` capability, plus
     * `control` when `userGesture: true`. Both checks have already run by
     * the time this handler is entered: `dispatch()` above consults
     * `REQUIRED_CAPABILITY['page.evaluate']` and every matching
     * `PARAMETER_DEPENDENT_CAPABILITY_RULES` entry before it looks a
     * handler up at all, so there is deliberately no capability check
     * repeated here (a second, hand-written copy of an authorization rule
     * is how the two copies come to disagree).
     *
     * What this handler is responsible for is everything the capability
     * check cannot express:
     *
     *  * VALIDATION, before any work and before the target is even
     *    resolved. Exactly one of `expression`/`functionDeclaration`, both
     *    within `MAX_EVALUATE_SOURCE_BYTES`; at most `MAX_EVALUATE_ARGS`
     *    JSON args; `timeoutMs` a positive number, clamped to
     *    `MAX_EVALUATE_TIMEOUT_MS`. Refused as
     *    `bgls.error.evaluate.invalid_request` rather than guessed at.
     *  * SCOPING, by passing the caller's `targetId` to
     *    `ManagedSession.evaluate()` and nothing else. There is no session
     *    id, execution context id or object id anywhere in this payload to
     *    forward even if this handler wanted to; see that method's own
     *    comment for how the registry lookup closes each escalation path.
     *  * OUTCOME MAPPING. A page-side throw comes back as
     *    `page.evaluated` with `ok: false` and a structured `exception`,
     *    NOT as an `error` envelope, so a caller can tell "your script
     *    threw" apart from "the wire failed". A timeout, an oversized
     *    result and a dead target each get their own `error` code.
     *  * AUDIT. See `auditEvaluate()` below.
     */
    // ── the outbound request gate ────────────────────────────────────
    //
    // Capability (`intercept`, plus `evaluate` when any rule asks for
    // request bodies) has already been checked by `dispatch()` through
    // `REQUIRED_CAPABILITY` and `PARAMETER_DEPENDENT_CAPABILITY_RULES`,
    // so there is deliberately no second hand-written copy of that rule
    // here: two copies of an authorization rule is how the two copies
    // come to disagree. What these handlers own is everything the
    // capability check cannot express.
    'request.gate.enable': async (msg) => {
      const targetId = str(msg['targetId']);
      const gateInvalid = (reason: string): void => {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.intercept.invalid_request',
          category: 'intercept',
          message: reason,
          fatal: false,
          retryable: false,
        });
      };

      const rawRules = msg['rules'];
      if (!Array.isArray(rawRules)) {
        gateInvalid('rules must be an array.');
        return;
      }
      if (rawRules.length > MAX_GATE_RULES) {
        gateInvalid(
          `rules may carry at most ${MAX_GATE_RULES} entries; received ${rawRules.length}. Every rule is matched against every request this target makes, so this is a per request cost.`,
        );
        return;
      }
      const rules: GateRule[] = [];
      for (const raw of rawRules as Array<Record<string, unknown>>) {
        const urlPattern = raw?.['urlPattern'];
        const verdict = raw?.['verdict'];
        if (typeof urlPattern !== 'string' || urlPattern.length === 0) {
          gateInvalid('every rule needs a non-empty urlPattern.');
          return;
        }
        if (Buffer.byteLength(urlPattern, 'utf8') > MAX_GATE_PATTERN_BYTES) {
          gateInvalid(`urlPattern may be at most ${MAX_GATE_PATTERN_BYTES} bytes.`);
          return;
        }
        if (verdict !== 'allow' && verdict !== 'deny' && verdict !== 'ask') {
          gateInvalid("every rule needs verdict: 'allow', 'deny' or 'ask'.");
          return;
        }
        rules.push(raw as unknown as GateRule);
      }

      const managed = this.managed;
      if (!managed) {
        gateInvalid('This connection has no live session.');
        return;
      }
      // One gate per target, one owner. Refused rather than silently
      // shared: two callers with different opinions about the same
      // request cannot both be right, and any precedence rule invented
      // between them would be a policy nobody asked for and nobody could
      // see from the outside.
      const other = managed.gateOwnedByOther(targetId, this.viewerId);
      if (other !== null) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.intercept.already_gated',
          category: 'intercept',
          message: `Another viewer (${other}) already holds the request gate on this target. One gate per target, deliberately: two callers answering the same request cannot both be right.`,
          fatal: false,
          retryable: false,
          context: { targetId },
        });
        return;
      }

      try {
        const ruleCount = await managed.enableRequestGate(this.viewerId, targetId, rules);
        this.replyTo(msg, { t: 'request.gate.enabled', targetId, ruleCount });
      } catch (err) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.intercept.failed',
          category: 'intercept',
          message: err instanceof Error ? err.message : 'Could not arm the request gate.',
          fatal: false,
          retryable: true,
          context: { targetId },
        });
      }
    },

    'request.gate.disable': async (msg) => {
      const targetId = str(msg['targetId']);
      await this.managed?.disableRequestGate(targetId);
      this.replyTo(msg, { t: 'request.gate.disabled', targetId });
    },

    // Fire and forget, like `input.*`: a verdict racing its own deadline
    // is ordinary, not an error, so there is nothing useful to reply. The
    // caller already knows the deadline; it was on the pause.
    'request.gate.resolve': (msg) => {
      const verdict = msg['verdict'];
      if (verdict !== 'allow' && verdict !== 'deny') return;
      this.managed?.resolveRequestGate(
        this.viewerId,
        str(msg['targetId']),
        str(msg['gateId']),
        verdict,
      );
    },

    'page.evaluate': async (msg) => this.handlePageEvaluate(msg, true),

    /**
     * `page.evaluate.internal` (`@browserglass/protocol`'s
     * `wire/messages/evaluate.ts`'s `PageEvaluateInternal`): the
     * SDK-internal counterpart to `page.evaluate` above, used only by
     * `@browserglass/automation`'s locator resolve/verify bookkeeping
     * (its `evaluateFunction` port, never its `evaluateExpression` one,
     * which carries a caller-authored predicate and still goes out as an
     * ordinary `page.evaluate`; see `AutomationClient`'s `locators`
     * getter). Same capability (`evaluate`), same handler, same
     * validation, same execution path as `page.evaluate`. This widens
     * NOTHING a `page.evaluate` holder could not already do. The only
     * difference `handlePageEvaluate`'s `allowExpression` flag makes is
     * refusing the one field this message type has no field for, and the
     * only difference THIS `t` makes is which bucket `bucketFor()` charges
     * (`evaluateInternal`, `wire/rate-limit.ts`), so a caller's own
     * explicit evaluate budget is not spent by however many round trips
     * the locator surface needed to resolve one selector. See that
     * module's doc for why this is an accounting split, not a new
     * security boundary, and why that is an acceptable trade here.
     */
    'page.evaluate.internal': async (msg) => this.handlePageEvaluate(msg, false),

    /**
     * `page.responsebody.get` (`@browserglass/protocol`'s
     * `wire/messages/response-body.ts`), gated on `devtools`. That
     * capability check has already run by the time this handler is
     * entered, exactly as `page.evaluate`'s own comment explains, so
     * there is deliberately no second copy of it here.
     *
     * What THIS handler owns, beyond what `checkCapability` cannot
     * express: VALIDATION (`targetId`/`requestId` both required,
     * non-empty strings, refused as `bgls.error.responsebody.invalid_request`
     * rather than guessed at), and OUTCOME MAPPING for
     * `ManagedSession.getResponseBody()`'s three shapes: the scoping
     * refusal (`E_RESPONSE_BODY_UNKNOWN_REQUEST`, this handler's whole
     * reason to exist as a narrow door rather than a hole in `cdp`), a
     * `'too_large'` outcome (never truncated, see `MAX_RESPONSE_BODY_BYTES`'s
     * own doc), and everything below the wire failing (a target that is
     * not this session's, a detached session, an evicted or never-buffered
     * body), which `./response-body.ts`'s own doc explains this pair
     * cannot, and does not claim to, tell apart any more precisely than
     * `bgls.error.responsebody.unavailable`.
     */
    'page.responsebody.get': async (msg) => {
      const targetId = str(msg['targetId']);
      const requestId = str(msg['requestId']);

      const invalid = (reason: string): void => {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.responsebody.invalid_request',
          category: 'responsebody',
          message: reason,
          fatal: false,
          retryable: false,
        });
      };

      if (targetId.length === 0 || requestId.length === 0) {
        invalid('targetId and requestId are both required, non-empty strings.');
        return;
      }

      const managed = this.managed;
      if (!managed) {
        // Answered rather than dropped, the same reason `page.evaluate`'s
        // own "no live session" branch is: a request/reply message left
        // unanswered is a hung promise at the caller.
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.responsebody.failed',
          category: 'responsebody',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }

      let outcome: Awaited<ReturnType<ManagedSession['getResponseBody']>>;
      try {
        outcome = await managed.getResponseBody(
          this.viewerId,
          targetId,
          requestId,
          MAX_RESPONSE_BODY_BYTES,
        );
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
        const wireCode =
          code === 'E_RESPONSE_BODY_UNKNOWN_REQUEST'
            ? 'bgls.error.responsebody.unknown_request'
            : code === 'E_CDP_TARGET_NOT_FOUND' || code === 'E_CDP_TARGET_CLOSED'
              ? 'bgls.error.target.not_found'
              : code === 'E_CDP_TIMEOUT'
                ? 'bgls.error.responsebody.timeout'
                : // `E_CDP_DETACHED` and `E_CDP_NAVIGATED_AWAY` are exactly the
                  // "gone due to navigation" case `./response-body.ts`'s own
                  // doc names; `E_CDP_SERVER_ERROR` is CDP's generic `-32000`,
                  // which also covers "no resource with given identifier
                  // found" (an evicted or never-buffered body). Neither this
                  // handler nor `mapCdpJsonRpcError` is permitted to inspect
                  // the raw CDP message any further to tell those apart, so
                  // both answer the same honest "gone", never an empty body.
                  code === 'E_CDP_DETACHED' ||
                    code === 'E_CDP_NAVIGATED_AWAY' ||
                    code === 'E_CDP_SERVER_ERROR'
                  ? 'bgls.error.responsebody.unavailable'
                  : 'bgls.error.responsebody.failed';
        this.replyTo(msg, {
          t: 'error',
          code: wireCode,
          category: wireCode === 'bgls.error.target.not_found' ? 'target' : 'responsebody',
          message:
            err instanceof Error
              ? err.message
              : `page.responsebody.get failed for target "${targetId}".`,
          fatal: false,
          retryable:
            wireCode === 'bgls.error.responsebody.timeout' ||
            wireCode === 'bgls.error.responsebody.failed',
        });
        return;
      }

      if (outcome.kind === 'too_large') {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.responsebody.too_large',
          category: 'responsebody',
          message: `The response body is ${outcome.sizeBytes} bytes, over the ${outcome.maxBytes} byte ceiling.`,
          fatal: false,
          retryable: false,
          context: { sizeBytes: outcome.sizeBytes, maxBytes: outcome.maxBytes },
        });
        return;
      }

      this.replyTo(msg, {
        t: 'page.responsebody.got',
        targetId,
        requestId,
        body: outcome.body,
        base64Encoded: outcome.base64Encoded,
        sizeBytes: outcome.sizeBytes,
      });
    },

    /**
     * `page.a11y.get` (`@browserglass/protocol`'s `wire/messages/a11y.ts`),
     * gated on `devtools`. That capability check has already run by the
     * time this handler is entered, exactly as `page.evaluate`'s own
     * comment explains, so there is deliberately no second copy of it
     * here.
     *
     * What THIS handler owns, beyond what `checkCapability` cannot
     * express: VALIDATION (`targetId` required; `maxNodes`, when given, a
     * positive number, clamped to `MAX_A11Y_MAX_NODES` the same way
     * `page.evaluate`'s own `timeoutMs` is clamped rather than refused,
     * because an over-large ask is optimism, not a typo), and OUTCOME
     * MAPPING for `ManagedSession.a11y()`'s CDP-transport failures,
     * mirroring `page.evaluate`'s own three-way split (timeout / target
     * gone / other). There is deliberately no "result too large" case to
     * map here: see `./messages/a11y.ts`'s own doc, "bounded, and
     * truncation reported as data". A reply over the ceiling is
     * `page.a11y.got` with `truncated: true`, never a refused `error`.
     */
    'page.a11y.get': async (msg) => {
      const targetId = str(msg['targetId']);
      const role = typeof msg['role'] === 'string' ? msg['role'] : undefined;
      const name = typeof msg['name'] === 'string' ? msg['name'] : undefined;

      const invalid = (reason: string): void => {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.a11y.invalid_request',
          category: 'a11y',
          message: reason,
          fatal: false,
          retryable: false,
        });
      };

      if (targetId.length === 0) {
        invalid('targetId is required.');
        return;
      }

      const rawMaxNodes = msg['maxNodes'];
      if (
        rawMaxNodes !== undefined &&
        (typeof rawMaxNodes !== 'number' || !Number.isFinite(rawMaxNodes) || rawMaxNodes <= 0)
      ) {
        invalid('maxNodes must be a positive number when given.');
        return;
      }
      const maxNodes = Math.min(
        typeof rawMaxNodes === 'number' ? rawMaxNodes : DEFAULT_A11Y_MAX_NODES,
        MAX_A11Y_MAX_NODES,
      );
      const stamp = msg['stamp'] === true;

      const managed = this.managed;
      if (!managed) {
        // Answered rather than dropped, the same reason `page.evaluate`'s
        // own "no live session" branch is.
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.a11y.failed',
          category: 'a11y',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }

      let outcome: Awaited<ReturnType<ManagedSession['a11y']>>;
      try {
        outcome = await managed.a11y(targetId, {
          ...(role !== undefined ? { role } : {}),
          ...(name !== undefined ? { name } : {}),
          maxNodes,
          stamp,
        });
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
        const wireCode =
          code === 'E_CDP_TIMEOUT'
            ? 'bgls.error.a11y.timeout'
            : code === 'E_CDP_TARGET_NOT_FOUND' || code === 'E_CDP_TARGET_CLOSED'
              ? 'bgls.error.target.not_found'
              : 'bgls.error.a11y.failed';
        this.replyTo(msg, {
          t: 'error',
          code: wireCode,
          category: wireCode === 'bgls.error.target.not_found' ? 'target' : 'a11y',
          message:
            err instanceof Error ? err.message : `page.a11y.get failed for target "${targetId}".`,
          fatal: false,
          retryable: wireCode !== 'bgls.error.target.not_found',
        });
        return;
      }

      this.replyTo(msg, {
        t: 'page.a11y.got',
        targetId,
        nodes: outcome.nodes,
        total: outcome.total,
        truncated: outcome.truncated,
        marker: outcome.marker,
      });
    },

    /**
     * `page.map.get` (`@browserglass/protocol`'s `wire/messages/pagemap.ts`),
     * gated on `devtools`. Same shape as `page.a11y.get` just above: the
     * capability check already ran by the time this handler is entered, so
     * there is no second copy of it here.
     *
     * What THIS handler owns: VALIDATION (`targetId` required; `include`,
     * when given, a non-empty array of `'nodes'`/`'text'`; `listeners`, when
     * given, a boolean; `timeoutMs`, when given, a positive number CLAMPED
     * to `MAX_PAGEMAP_TIMEOUT_MS` rather than refused, the identical
     * `page.a11y.get`/`page.evaluate` precedent this module's handler doc
     * for `page.a11y.get` already states: "an over-large ask is optimism,
     * not a typo"), and OUTCOME MAPPING for `ManagedSession.pageMap()`'s
     * CDP-transport failures, mirroring `page.a11y.get`'s own three-way
     * split (timeout / target gone / other). There is deliberately no
     * "result too large" case to map here either: a reply over
     * `MAX_PAGEMAP_RESULT_BYTES` is `page.map.got` with `truncated: true`,
     * never a refused `error`.
     */
    'page.map.get': async (msg) => {
      const targetId = str(msg['targetId']);

      const invalid = (reason: string): void => {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.pagemap.invalid_request',
          category: 'pagemap',
          message: reason,
          fatal: false,
          retryable: false,
        });
      };

      if (targetId.length === 0) {
        invalid('targetId is required.');
        return;
      }

      const rawInclude = msg['include'];
      let include: PageMapInclude[] | undefined;
      if (rawInclude !== undefined) {
        if (
          !Array.isArray(rawInclude) ||
          rawInclude.length === 0 ||
          !rawInclude.every((v) => v === 'nodes' || v === 'text')
        ) {
          invalid("include, when given, must be a non-empty array of 'nodes'/'text'.");
          return;
        }
        include = rawInclude as PageMapInclude[];
      }

      const rawListeners = msg['listeners'];
      if (rawListeners !== undefined && typeof rawListeners !== 'boolean') {
        invalid('listeners, when given, must be a boolean.');
        return;
      }
      const listeners = typeof rawListeners === 'boolean' ? rawListeners : undefined;

      const rawTimeoutMs = msg['timeoutMs'];
      if (
        rawTimeoutMs !== undefined &&
        (typeof rawTimeoutMs !== 'number' || !Number.isFinite(rawTimeoutMs) || rawTimeoutMs <= 0)
      ) {
        invalid('timeoutMs must be a positive number when given.');
        return;
      }
      const timeoutMs = Math.min(
        typeof rawTimeoutMs === 'number' ? rawTimeoutMs : DEFAULT_PAGEMAP_TIMEOUT_MS,
        MAX_PAGEMAP_TIMEOUT_MS,
      );

      const managed = this.managed;
      if (!managed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.pagemap.failed',
          category: 'pagemap',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }

      let outcome: Awaited<ReturnType<ManagedSession['pageMap']>>;
      try {
        outcome = await managed.pageMap(targetId, {
          ...(include !== undefined ? { include } : {}),
          ...(listeners !== undefined ? { listeners } : {}),
          timeoutMs,
        });
      } catch (err) {
        const { wireCode, category } = pageMapWireError(err);
        this.replyTo(msg, {
          t: 'error',
          code: wireCode,
          category,
          message:
            err instanceof Error ? err.message : `page.map.get failed for target "${targetId}".`,
          fatal: false,
          retryable: wireCode !== 'bgls.error.target.not_found',
        });
        return;
      }

      this.replyTo(msg, {
        t: 'page.map.got',
        targetId,
        epoch: outcome.epoch,
        ...(outcome.nodes !== undefined
          ? {
              nodes: outcome.nodes,
              total: outcome.total,
              truncated: outcome.truncated,
              truncatedByReason: outcome.truncatedByReason,
              degraded: outcome.degraded,
            }
          : {}),
        ...(outcome.text !== undefined ? { text: outcome.text } : {}),
      });
    },

    /**
     * `page.map.stamp` (`@browserglass/protocol`'s `wire/messages/pagemap.ts`),
     * gated on `devtools`, same as `page.map.get` just above. Owns
     * VALIDATION (`targetId`/`epoch` required non-empty strings; `indices`
     * a number array of at most `MAX_PAGEMAP_STAMP_INDICES` entries) and
     * OUTCOME MAPPING, with one extra case `page.map.get` does not have:
     * `PageMapStaleEpochError`, mapped to `bgls.error.pagemap.stale_epoch`
     * (see `docs/page-map.md` on indices and epochs).
     */
    'page.map.stamp': async (msg) => {
      const targetId = str(msg['targetId']);
      const epoch = str(msg['epoch']);

      const invalid = (reason: string): void => {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.pagemap.invalid_request',
          category: 'pagemap',
          message: reason,
          fatal: false,
          retryable: false,
        });
      };

      if (targetId.length === 0) {
        invalid('targetId is required.');
        return;
      }
      if (epoch.length === 0) {
        invalid('epoch is required.');
        return;
      }

      const rawIndices = msg['indices'];
      if (
        !Array.isArray(rawIndices) ||
        rawIndices.length > MAX_PAGEMAP_STAMP_INDICES ||
        !rawIndices.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        invalid(
          `indices must be an array of numbers, at most ${MAX_PAGEMAP_STAMP_INDICES} entries.`,
        );
        return;
      }
      const indices = rawIndices as number[];

      const managed = this.managed;
      if (!managed) {
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.pagemap.failed',
          category: 'pagemap',
          message: 'This connection has no live session.',
          fatal: false,
          retryable: false,
        });
        return;
      }

      let outcome: Awaited<ReturnType<ManagedSession['stampPageMap']>>;
      try {
        outcome = await managed.stampPageMap(targetId, epoch, indices);
      } catch (err) {
        const { wireCode, category } = pageMapWireError(err);
        this.replyTo(msg, {
          t: 'error',
          code: wireCode,
          category,
          message:
            err instanceof Error ? err.message : `page.map.stamp failed for target "${targetId}".`,
          fatal: false,
          retryable:
            wireCode !== 'bgls.error.target.not_found' &&
            wireCode !== 'bgls.error.pagemap.stale_epoch',
        });
        return;
      }

      this.replyTo(msg, {
        t: 'page.map.stamped',
        targetId,
        results: outcome.results,
        marker: outcome.marker,
      });
    },

    /**
     * `diagnostics.subscribe`/`diagnostics.unsubscribe`. `subscribe` replies
     * `diagnostics.subscribed` with the feeds actually running BEFORE doing
     * anything else: this connection issues no broadcast of its own as a
     * side effect of subscribing (unlike `stream.subscribe`, which can flip
     * a window's active target and broadcasts `target.updated` only after
     * its own reply, see `doSubscribe`'s comment and `ManagedSession.subscribe()`'s
     * for the three-suite breakage that rule fixed), so there is nothing to
     * reorder here, but the reply-first rule is kept explicit anyway so a
     * future addition to this handler does not reintroduce that bug by
     * broadcasting ahead of the reply.
     */
    'diagnostics.subscribe': async (msg) => {
      const targetId = str(msg['targetId']);
      try {
        const feeds = await this.managed?.subscribeDiagnostics(this.viewerId, targetId, {
          ...(typeof msg['console'] === 'boolean' ? { console: msg['console'] } : {}),
          ...(typeof msg['errors'] === 'boolean' ? { errors: msg['errors'] } : {}),
          ...(typeof msg['network'] === 'boolean' ? { network: msg['network'] } : {}),
          ...(typeof msg['acknowledgeStealthRisk'] === 'boolean'
            ? { acknowledgeStealthRisk: msg['acknowledgeStealthRisk'] }
            : {}),
        });
        if (feeds) this.replyTo(msg, { t: 'diagnostics.subscribed', targetId, ...feeds });
      } catch (err) {
        // `E_DIAGNOSTICS_STEALTH_CONFLICT` (`ManagedSession.subscribeDiagnostics`'s
        // own doc) is the one refusal here that is not "this target does not
        // exist": it is a policy conflict between what was asked for and
        // what the instance's stealth level allows, and a caller retrying
        // against `bgls.error.target.not_found` would learn nothing true.
        // Named explicitly so `wireErrorCodeFor`'s own registry entry
        // (`@browserglass/protocol`'s `errors.ts`) reaches the caller
        // instead of being flattened into the generic target fallback.
        const code =
          err instanceof BglsError && err.code === 'E_DIAGNOSTICS_STEALTH_CONFLICT'
            ? 'bgls.error.diagnostics.stealth_conflict'
            : 'bgls.error.target.not_found';
        this.replyTo(msg, {
          t: 'error',
          code,
          category: code === 'bgls.error.diagnostics.stealth_conflict' ? 'diagnostics' : 'target',
          message:
            err instanceof Error
              ? err.message
              : `Cannot subscribe to diagnostics for target "${targetId}".`,
          fatal: false,
          retryable: false,
        });
      }
    },
    'diagnostics.unsubscribe': (msg) => {
      this.managed?.unsubscribeDiagnostics(this.viewerId, str(msg['targetId']));
    },
    /**
     * `diagnostics.status.get`: the read-only counterpart to
     * `diagnostics.subscribe`, answering whether `targetId` is currently
     * fingerprintable (`Runtime` enabled) without subscribing to anything.
     * See `ManagedSession.diagnosticsStatus`'s own doc for why this never
     * throws the way `diagnostics.subscribe` can: there is no stealth
     * conflict to refuse when nothing is being turned on.
     */
    'diagnostics.status.get': (msg) => {
      const targetId = str(msg['targetId']);
      const status = this.managed?.diagnosticsStatus(targetId);
      if (status) this.replyTo(msg, { t: 'diagnostics.status.got', targetId, ...status });
    },

    /**
     * `upload.begin` / `upload.complete` / `upload.cancel` / `files.set`:
     * the socket's half of file upload, all four on the `upload`
     * capability (`wire/capability-check.ts`).
     *
     * The bytes themselves never appear here. They ride the binary channel
     * as `UPLOAD_CHUNK` frames (`onBinaryChunk` above), which is what the
     * `upload.*` messages were designed for and why `upload.accepted`
     * hands back a `binaryId`: a 16 byte field cannot carry a
     * caller-chosen string, so the server mints the binary key and the
     * caller keeps its own `uploadId` for correlation.
     */
    'upload.begin': async (msg) => {
      const uploads = this.requireUploads(msg);
      if (!uploads) return;
      const uploadId = str(msg['uploadId']);
      const name = str(msg['name']);
      const sizeBytes = num(msg['sizeBytes']);
      if (uploadId.length === 0 || name.length === 0) {
        this.replyUploadError(
          msg,
          'bgls.error.protocol.bad_envelope',
          'upload.begin needs uploadId and name.',
        );
        return;
      }
      try {
        const accepted = await uploads.begin({
          uploadId,
          tenantId: this.tenantId,
          name,
          sizeBytes,
          instanceId: this.instanceId,
          viewerId: this.viewerId,
          ...(typeof msg['mime'] === 'string' ? { mime: msg['mime'] } : {}),
        });
        this.openUploads.add(accepted.uploadId);
        this.replyTo(msg, {
          t: 'upload.accepted',
          uploadId: accepted.uploadId,
          chunkBytes: accepted.chunkBytes,
          maxInFlight: accepted.maxInFlight,
          binaryId: accepted.binaryId,
          expiresAt: accepted.expiresAt,
        });
      } catch (err) {
        this.replyUploadError(msg, 'bgls.error.protocol.bad_envelope', err);
      }
    },

    'upload.complete': async (msg) => {
      const uploads = this.requireUploads(msg);
      if (!uploads) return;
      const uploadId = str(msg['uploadId']);
      if (!this.openUploads.has(uploadId)) {
        this.replyUploadError(
          msg,
          'bgls.error.upload.not_found',
          `no open upload "${uploadId}" on this connection.`,
        );
        return;
      }
      try {
        const status = await uploads.complete(
          uploadId,
          this.tenantId,
          typeof msg['sha256'] === 'string' ? msg['sha256'] : undefined,
        );
        // Off the open set, not out of the store: a completed upload
        // outlives this connection on purpose. See `openUploads`.
        this.openUploads.delete(uploadId);
        this.replyTo(msg, {
          t: 'upload.done',
          uploadId: status.uploadId,
          // Deliberately not an absolute path. See `UploadDone.path`'s own
          // doc in `@browserglass/protocol` for the three reasons.
          path: `bgls-upload://${status.uploadId}/${status.name}`,
          sizeBytes: status.receivedBytes,
          ...(status.sha256 !== null ? { sha256: status.sha256 } : {}),
        });
      } catch (err) {
        // A failed completion took the bytes with it (a hash mismatch
        // discards, a short upload stays staging until the TTL), so this
        // connection stops claiming it either way.
        this.openUploads.delete(uploadId);
        this.replyUploadError(msg, 'bgls.error.protocol.bad_envelope', err);
      }
    },

    'upload.cancel': async (msg) => {
      const uploads = this.requireUploads(msg);
      if (!uploads) return;
      const uploadId = str(msg['uploadId']);
      if (!this.openUploads.has(uploadId)) return; // Idempotent; see `UploadCancel`'s own doc.
      this.openUploads.delete(uploadId);
      await uploads.discard(uploadId, this.tenantId);
    },

    'files.set': async (msg) => {
      const uploads = this.requireUploads(msg);
      if (!uploads) return;
      const targetId = str(msg['targetId']);
      const selector = str(msg['selector']);
      const rawIds = Array.isArray(msg['uploadIds']) ? (msg['uploadIds'] as unknown[]) : [];
      const uploadIds = rawIds.filter((id): id is string => typeof id === 'string');
      if (targetId.length === 0 || selector.length === 0 || uploadIds.length === 0) {
        this.replyUploadError(
          msg,
          'bgls.error.protocol.bad_envelope',
          'files.set needs targetId, selector and a non-empty uploadIds.',
        );
        return;
      }
      const managed = this.managed;
      if (!managed) return;
      try {
        // Every id resolved before the CDP call, so a request naming one
        // bad id among several fails without half-attaching the rest.
        // `pathFor` is the only producer of a path anywhere in this
        // feature, and it takes ids and a tenant.
        const paths: string[] = [];
        const names: string[] = [];
        for (const uploadId of uploadIds) {
          paths.push(await uploads.pathFor(uploadId, this.tenantId));
          names.push(uploads.status(uploadId, this.tenantId).name);
        }
        await managed.setInputFiles(targetId, selector, paths);
        for (const uploadId of uploadIds) uploads.touch(uploadId, this.tenantId);
        this.replyTo(msg, { t: 'files.set.result', targetId, selector, files: names });
      } catch (err) {
        this.replyUploadError(msg, 'bgls.error.protocol.bad_envelope', err);
      }
    },

    'dialog.answer': async (msg) => {
      await this.managed?.answerDialog(
        str(msg['targetId'] ?? ''),
        msg['accept'] === true,
        typeof msg['promptText'] === 'string' ? msg['promptText'] : undefined,
      );
    },

    'instance.restart': async (msg) => {
      const reason = typeof msg['reason'] === 'string' ? sanitizeMessage(msg['reason']) : undefined;
      const preserveProfile = msg['preserveProfile'] !== false;
      const ok = await this.managed?.restartInstance({
        ...(reason !== undefined ? { reason } : {}),
        preserveProfile,
      });
      if (ok === false) {
        // `ManagedSession.dispatchEffect`'s `'instance.restart.result'` case
        // already broadcast an uncorrelated `error` to every connection
        // (the informational half of the fix for a silent hang on failure);
        // `BrowserGlassClient.restart()`'s own `awaitMessage` predicate
        // additionally requires `m.re === id` to settle its promise on
        // failure (it never re-derives failure from `instance.recovered`
        // simply never arriving), so this connection, the one that actually
        // issued the request, also needs a directly correlated reply.
        this.replyTo(msg, {
          t: 'error',
          code: 'bgls.error.instance.unrecoverable',
          category: 'instance',
          message: 'instance.restart failed: the browser could not be relaunched.',
          fatal: false,
          retryable: true,
        });
      }
    },
  };

  /**
   * `sourceMsg` is the inbound `stream.subscribe` this call is answering,
   * used to echo `re`; omitted when a subscription is folded into `hello`
   * (`freshAttach`), which carries no per-subscription `id` to echo.
   */
  private async doSubscribe(
    targetId: string,
    req: {
      readonly quality?: QualityProfile;
      readonly thumbnail?: boolean;
      readonly paused?: boolean;
    },
    sourceMsg?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.managed) return;
    try {
      const fields = await this.managed.subscribe(this.viewerId, targetId, req);
      this.replyTo(sourceMsg, { t: 'stream.subscribed', ...fields });
      // Strictly after the reply: subscribing can promote this target to
      // the live one of its own OS window, and every viewer needs that
      // `active` flip, but never ahead of the correlated reply to the
      // request that caused it. See `ManagedSession.subscribe()`.
      this.managed.announceActiveFlags();
    } catch (err) {
      this.replyTo(sourceMsg, {
        t: 'error',
        code: 'bgls.error.target.not_found',
        category: 'target',
        message: err instanceof Error ? err.message : `Cannot subscribe to target "${targetId}".`,
        fatal: false,
        retryable: false,
      });
    }
  }

  /**
   * `page.evaluate` and `page.evaluate.internal`'s shared body. Both
   * capability check and rate-limit bucket have already run by the time
   * this is entered (`dispatch()`'s `bucketFor()`/`checkCapability()`, run
   * before either `t` reaches `this.handlers`), so what differs between
   * the two callers below is exactly one thing: `allowExpression`.
   *
   * `false` (the `.internal` caller) refuses an `expression` field rather
   * than silently ignoring it, for the same reason `page.evaluate` itself
   * refuses "both expression and functionDeclaration sent" rather than
   * picking one: a surface whose job is running precisely what it was
   * asked to run must never discard part of an ambiguous request. Every
   * real `page.evaluate.internal` sender (`AutomationClient`'s
   * `evaluateFunction` port) only ever sends `functionDeclaration`, one of
   * the locator engine's own fixed scripts, never caller-authored text;
   * see `PageEvaluateInternal`'s own doc for why that is what keeps this
   * split from becoming a general rate-limit bypass.
   */
  private async handlePageEvaluate(
    msg: Record<string, unknown>,
    allowExpression: boolean,
  ): Promise<void> {
    const targetId = str(msg['targetId']);
    const expression =
      allowExpression && typeof msg['expression'] === 'string' ? msg['expression'] : undefined;
    const functionDeclaration =
      typeof msg['functionDeclaration'] === 'string' ? msg['functionDeclaration'] : undefined;

    const invalid = (reason: string, context?: Record<string, unknown>): void => {
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.evaluate.invalid_request',
        category: 'evaluate',
        message: reason,
        fatal: false,
        retryable: false,
        ...(context !== undefined ? { context } : {}),
      });
    };

    if (!allowExpression && typeof msg['expression'] === 'string') {
      invalid('page.evaluate.internal has no expression field; send functionDeclaration instead.');
      return;
    }

    // Exactly one source. Never "prefer expression when both are sent":
    // on a surface whose entire job is running precisely what it was
    // handed, silently discarding half of an ambiguous request is the one
    // behaviour that could run something the caller did not mean.
    if ((expression === undefined) === (functionDeclaration === undefined)) {
      invalid('Send exactly one of expression or functionDeclaration.');
      return;
    }
    const source = expression ?? functionDeclaration ?? '';
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    if (sourceBytes === 0) {
      invalid('The script source is empty.');
      return;
    }
    if (sourceBytes > MAX_EVALUATE_SOURCE_BYTES) {
      invalid(
        `The script source is ${sourceBytes} bytes, over the ${MAX_EVALUATE_SOURCE_BYTES} byte ceiling.`,
        {
          sizeBytes: sourceBytes,
          maxBytes: MAX_EVALUATE_SOURCE_BYTES,
        },
      );
      return;
    }

    const rawArgs = msg['args'];
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      invalid('args must be an array when given.');
      return;
    }
    const args = (rawArgs as readonly unknown[] | undefined) ?? [];
    if (args.length > MAX_EVALUATE_ARGS) {
      invalid(`args carries ${args.length} entries, over the ${MAX_EVALUATE_ARGS} ceiling.`, {
        count: args.length,
        maxCount: MAX_EVALUATE_ARGS,
      });
      return;
    }

    const rawTimeout = msg['timeoutMs'];
    if (
      rawTimeout !== undefined &&
      (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)
    ) {
      invalid('timeoutMs must be a positive number of milliseconds when given.');
      return;
    }
    // Clamped rather than refused when over the ceiling: a caller asking
    // for longer than the maximum has expressed "as long as you will let
    // me", which the maximum answers honestly, and failing the call
    // outright would be a worse answer to a request that is not
    // dangerous, only optimistic. Zero, negative and non-numeric are
    // refused above, because those are typos, not preferences.
    const timeoutMs = Math.min(
      typeof rawTimeout === 'number' ? rawTimeout : DEFAULT_EVALUATE_TIMEOUT_MS,
      MAX_EVALUATE_TIMEOUT_MS,
    );

    // Refused rather than coerced to `'main'`. An unknown world is a
    // caller who believes they are running somewhere they are not, and
    // for this surface that belief is a security one: quietly answering
    // in the main world a request that asked to be unobservable is the
    // worst of the three possible answers.
    const rawWorld = msg['world'];
    if (rawWorld !== undefined && rawWorld !== 'main' && rawWorld !== 'isolated') {
      invalid("world must be 'main' or 'isolated' when given.");
      return;
    }
    const world = rawWorld as EvaluateWorld | undefined;

    const managed = this.managed;
    if (!managed) {
      // Answered rather than dropped. Every other handler here uses
      // `this.managed?.`, which silently does nothing when the session is
      // gone; for a request/reply message that is a hung promise at the
      // caller, which is the exact failure `dispatch()`'s own catch block
      // was added to stop happening.
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.evaluate.failed',
        category: 'evaluate',
        message: 'This connection has no live session.',
        fatal: false,
        retryable: false,
      });
      return;
    }

    const startedAt = Date.now();
    let outcome: EvaluateOutcome;
    try {
      outcome = await managed.evaluate(targetId, {
        ...(expression !== undefined ? { expression } : {}),
        ...(functionDeclaration !== undefined ? { functionDeclaration } : {}),
        args,
        awaitPromise: msg['awaitPromise'] !== false,
        userGesture: allowExpression && msg['userGesture'] === true,
        timeoutMs,
        maxResultBytes: MAX_EVALUATE_RESULT_BYTES,
        ...(world !== undefined ? { world } : {}),
      });
    } catch (err) {
      // Everything below the wire failed: a target that is not this
      // session's (or has closed), a detached CDP session, a renderer that
      // stopped answering. Each maps to its own wire code so a caller can
      // tell them apart from its own script throwing, which never reaches
      // this catch at all.
      const code =
        err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
      const wireCode =
        code === 'E_CDP_TIMEOUT'
          ? 'bgls.error.evaluate.timeout'
          : code === 'E_CDP_TARGET_NOT_FOUND' || code === 'E_CDP_TARGET_CLOSED'
            ? 'bgls.error.target.not_found'
            : 'bgls.error.evaluate.failed';
      this.auditEvaluate(
        targetId,
        source,
        sourceBytes,
        timeoutMs,
        msg,
        wireCode,
        Date.now() - startedAt,
        0,
      );
      this.replyTo(msg, {
        t: 'error',
        code: wireCode,
        category: wireCode === 'bgls.error.target.not_found' ? 'target' : 'evaluate',
        message:
          err instanceof Error ? err.message : `page.evaluate failed for target "${targetId}".`,
        fatal: false,
        retryable: wireCode !== 'bgls.error.target.not_found',
      });
      return;
    }

    if (outcome.kind === 'too_large') {
      this.auditEvaluate(
        targetId,
        source,
        sourceBytes,
        timeoutMs,
        msg,
        'result_too_large',
        Date.now() - startedAt,
        outcome.sizeBytes,
      );
      this.replyTo(msg, {
        t: 'error',
        code: 'bgls.error.evaluate.result_too_large',
        category: 'evaluate',
        message: `The result is ${outcome.sizeBytes} bytes, over the ${outcome.maxBytes} byte ceiling.`,
        fatal: false,
        retryable: false,
        context: { sizeBytes: outcome.sizeBytes, maxBytes: outcome.maxBytes },
      });
      return;
    }

    if (outcome.kind === 'exception') {
      this.auditEvaluate(
        targetId,
        source,
        sourceBytes,
        timeoutMs,
        msg,
        'threw',
        Date.now() - startedAt,
        0,
      );
      // `sanitizeMessage` is applied to the page's own message and stack
      // for the same reason it is applied to a console entry: both are
      // page-authored text arriving at a client that may render it, and an
      // evaluation is if anything MORE likely to surface a hostile page's
      // own words than a console line is.
      this.replyTo(msg, {
        t: 'page.evaluated',
        targetId,
        ok: false,
        resultType: 'undefined',
        sizeBytes: 0,
        exception: {
          message: sanitizeMessage(outcome.exception.message),
          ...(outcome.exception.name !== undefined
            ? { name: sanitizeMessage(outcome.exception.name) }
            : {}),
          ...(outcome.exception.stack !== undefined
            ? { stack: sanitizeMessage(outcome.exception.stack) }
            : {}),
          ...(outcome.exception.lineNumber !== undefined
            ? { lineNumber: outcome.exception.lineNumber }
            : {}),
          ...(outcome.exception.columnNumber !== undefined
            ? { columnNumber: outcome.exception.columnNumber }
            : {}),
        },
      });
      return;
    }

    const sizeBytes = outcome.kind === 'value' ? outcome.sizeBytes : 0;
    this.auditEvaluate(
      targetId,
      source,
      sourceBytes,
      timeoutMs,
      msg,
      'ok',
      Date.now() - startedAt,
      sizeBytes,
    );
    this.replyTo(msg, {
      t: 'page.evaluated',
      targetId,
      ok: true,
      resultType:
        outcome.kind === 'value'
          ? 'value'
          : outcome.kind === 'undefined'
            ? 'undefined'
            : 'unserializable',
      sizeBytes,
      ...(outcome.kind === 'value' ? { value: outcome.value } : {}),
      ...(outcome.kind === 'unserializable' && outcome.unserializableValue !== undefined
        ? { unserializableValue: outcome.unserializableValue }
        : {}),
      ...(outcome.kind === 'unserializable' && outcome.description !== undefined
        ? { description: sanitizeMessage(outcome.description) }
        : {}),
    });
  }

  /**
   * Emits the audit record for one `page.evaluate` call.
   *
   * Page evaluation is the highest privilege this protocol grants, so every
   * call is recorded, whether it succeeded, threw, timed out or was refused
   * downstream. The record names WHO (`viewerId`, and the connection is
   * already bound to one session and one Instance), WHAT TARGET, WHICH
   * SHAPE of call (expression or function, with a user gesture or not,
   * awaiting a promise or not), HOW BIG the script and the result were, HOW
   * LONG it took, and the OUTCOME.
   *
   * ── What is deliberately NOT recorded ────────────────────────────────
   *
   * The script source itself, and the result value. `config/logger.ts`'s
   * own `LogFields` doc states the rule this obeys: "Page content,
   * clipboard contents, form values, and keystrokes must never appear here,
   * at any level". An evaluation's
   * result IS page content by definition, and its source routinely contains
   * selectors and literals that are form values in all but name (a login
   * form filler's own password, for one). Logging either would turn the
   * audit trail into the largest single leak in the product, which is the
   * opposite of what an audit trail is for.
   *
   * What goes in instead is `sourceSha256`, the SHA-256 of the script
   * source. That is what makes the record actually useful for the questions
   * an operator asks: it groups repeated calls of the same script, so
   * "which script ran 40,000 times last night" and "did this viewer ever
   * run something it had not run before" are both answerable, without the
   * log ever holding a line of the script. An investigator who has the
   * suspect script in hand can hash it and search; an attacker who has the
   * log cannot run it backwards.
   *
   * ── Where this goes, and the gap ─────────────────────────────────────
   *
   * Through `deps.logger` at `info`, structured, with `component: 'ws'`,
   * which is the only observability seam a `Connection` has. The richer
   * `AuditSink` (`@browserglass/protocol`'s `AuditSinkEvent`) would be the
   * better home, and `page.evaluate` deserves a kind of its own in that
   * union next to `clipboard` and `navigate`, but the sink is currently
   * threaded only as far as `BrowserRouter` (`lifecycle/wiring.ts` passes
   * `config.observability.auditSink` to the router and nowhere else);
   * reaching it from here needs it plumbed through `SessionRegistry` and
   * `ConnectionDeps` first.
   * A structured log line is what this layer can honestly emit today, and
   * emitting it is strictly better than waiting for the plumbing.
   */
  private auditEvaluate(
    targetId: string,
    source: string,
    sourceBytes: number,
    timeoutMs: number,
    msg: Record<string, unknown>,
    outcome: string,
    durationMs: number,
    resultBytes: number,
  ): void {
    this.deps.logger.info(
      {
        component: 'ws',
        event: 'page.evaluate',
        viewerId: this.viewerId,
        targetId,
        kind: typeof msg['functionDeclaration'] === 'string' ? 'function' : 'expression',
        userGesture: msg['userGesture'] === true,
        awaitPromise: msg['awaitPromise'] !== false,
        // See this method's doc: the hash, never the source.
        sourceSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
        sourceBytes,
        timeoutMs,
        resultBytes,
        durationMs,
        outcome,
      },
      'page.evaluate',
    );
  }

  private viewerIdentity(): SessionViewerIdentity {
    return {
      viewerId: this.viewerId,
      identity: this.viewerId,
      label: this.viewerId,
      kind: this.granted.has('automation') ? 'agent' : 'human',
      capabilities: [...this.granted],
      isAdmin: this.granted.has('admin'),
    };
  }

  /**
   * Runs `onControlGranted` BEFORE `ManagedSession.requestControl()` is
   * ever called, not after: `core.ControlLeaseEngine.requestControl()`
   * (`packages/core/src/control/lease-engine.ts:309`) is synchronous and,
   * for the common ungated case, admits the holder and sends
   * `control.granted` to the wire in the SAME call, through a constructor
   * bound `emit` callback with no seam this package may reach into without
   * editing `@browserglass/core`. By the time
   * `requestControl()` returns, a grant has already been admitted AND
   * already sent, so a veto discovered afterward could only ever revoke
   * what a viewer already saw, not prevent it. Checking first is the only
   * way this hook can actually stop a grant rather than merely notice one,
   * which is the whole point of a vetoing hook (`hooks/types.ts`'s
   * `HOOK_TIMEOUTS.onControlGranted`, `vetoes: true`).
   *
   * The cost of running first: `leaseId` and `ttlMs` are not yet minted
   * (`admitHolder()` calls `mintLeaseId()` itself, `lease-engine.ts:611`,
   * with no way for a caller to supply one in advance), so this reports
   * `leaseId: ''` (this codebase's own "not applicable" sentinel for a
   * required string field, matching `SYSTEM_PRINCIPAL.tenantId: ''` in
   * `packages/router/src/router/types.ts`) and `ttlMs` from
   * `CONTROL_TIMING.leaseTtlMs`, the configured default a grant WOULD use
   * if admitted, not a per grant computed value. A handler that vetoes
   * does not need either; a handler that only logs can still correlate by
   * `targetId`/`viewerId`, which are stable across the whole exchange.
   *
   * `previousHolder` and `forceClaimed` ARE accurate: both are read from
   * `ControlLeaseEngine.getSnapshot()` (`managed.coreSession`, already a
   * public getter this file uses elsewhere, `connection.ts`'s own
   * `resumeInto`) before `requestControl()` can change anything, and a
   * holder identical to this requester (the idempotent "already holds it"
   * re-grant `lease-engine.ts:331` special cases) is reported as no
   * previous holder at all, since nothing is actually being displaced.
   *
   * Returns `false` when vetoed (the caller must not proceed to
   * `requestControl`), `true` otherwise. Skips the hook and hooked cost
   * entirely via `HookRegistry.has` when nothing is registered, matching
   * `onNavigation`'s own cheapness rule below (`runNav`).
   */
  private async checkControlGranted(
    msg: Record<string, unknown>,
    targetId: string,
    force: boolean,
  ): Promise<boolean> {
    if (!this.managed || !this.deps.hooks.has('onControlGranted')) return true;
    const snapshot = this.managed.coreSession.leaseEngineFor(targetId).getSnapshot();
    const currentHolder =
      snapshot.holder !== null && snapshot.holder.viewerId !== this.viewerId
        ? snapshot.holder
        : null;
    const grantEvent: ControlGrantedEvent = {
      at: Date.now(),
      tenantId: this.tenantId,
      appId: this.appId,
      requestId: typeof msg['id'] === 'string' ? msg['id'] : newId('evt'),
      sessionId: this.managed.sessionId,
      targetId,
      viewerId: this.viewerId,
      leaseId: '',
      subject: this.viewerId,
      forceClaimed: force && currentHolder !== null,
      previousHolder:
        currentHolder !== null
          ? { viewerId: currentHolder.viewerId, subject: currentHolder.identity }
          : null,
      ttlMs: CONTROL_TIMING.leaseTtlMs,
    };
    const decision = await this.deps.hooks.dispatch('onControlGranted', grantEvent);
    if (!decision.vetoed) return true;
    this.replyTo(msg, {
      t: 'error',
      code: 'bgls.error.policy.denied',
      category: 'policy',
      message: decision.reason ?? 'Refused by onControlGranted.',
      fatal: false,
      retryable: false,
      context: { reason: decision.reason ?? null, hook: 'onControlGranted', targetId },
    });
    return false;
  }
}

/**
 * Maps a `ManagedSession.pageMap()`/`stampPageMap()` rejection onto the
 * `bgls.error.pagemap.*` registry, for both `page.map.get` and
 * `page.map.stamp`'s catch blocks above. Mirrors `page.a11y.get`'s inline
 * `code`/`wireCode` mapping, pulled out to one function because both
 * handlers need it and because `PageMapCaptureError` wraps its underlying
 * transport failure in `.cause` (`@browserglass/core`'s `pagemap/capture.ts`)
 * rather than carrying an `E_CDP_*` code directly on itself, so the code to
 * inspect is one layer deeper here than `page.a11y.get`'s own `err.code`
 * check needs to go.
 */
function pageMapWireError(err: unknown): { wireCode: string; category: 'pagemap' | 'target' } {
  if (err instanceof PageMapStaleEpochError) {
    return { wireCode: 'bgls.error.pagemap.stale_epoch', category: 'pagemap' };
  }
  const inspect = err instanceof PageMapCaptureError ? err.cause : err;
  const code =
    inspect instanceof Error && 'code' in inspect
      ? String((inspect as { code: unknown }).code)
      : '';
  if (code === 'E_CDP_TIMEOUT') {
    return { wireCode: 'bgls.error.pagemap.timeout', category: 'pagemap' };
  }
  if (code === 'E_CDP_TARGET_NOT_FOUND' || code === 'E_CDP_TARGET_CLOSED') {
    return { wireCode: 'bgls.error.target.not_found', category: 'target' };
  }
  return { wireCode: 'bgls.error.pagemap.failed', category: 'pagemap' };
}

/**
 * Maps an `UploadStoreError` code, or a `core` `FileInputError` reason,
 * onto the `bgls.error.*` registry.
 *
 * Two of these reuse a code from another category, and it is worth saying
 * why rather than leaving it to look like a mistake. `E_UPLOAD_LIMIT` (the
 * gateway is already holding as much staged data as it will hold) becomes
 * `quota.storage`, whose own registry note is "Profile or upload storage
 * quota reached": that is exactly this. And a selector that matched
 * nothing becomes `capture.no_match`, which is the registry's only code
 * meaning "selector matched nothing" and whose note says so, even though
 * it sits under the `capture` category. Adding a `files.*` category would
 * mean changing the protocol's error table, which is a protocol change and not
 * one this feature needs.
 */
function uploadWireCodeFor(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  const reason = (err as { reason?: unknown } | null)?.reason;
  switch (code) {
    case 'E_UPLOAD_TOO_LARGE':
      return 'bgls.error.upload.too_large';
    case 'E_UPLOAD_LIMIT':
      return 'bgls.error.quota.storage';
    case 'E_UPLOAD_NOT_FOUND':
    case 'E_UPLOAD_NOT_READY':
    case 'E_UPLOAD_GONE':
      return 'bgls.error.upload.not_found';
    case 'E_UPLOAD_HASH_MISMATCH':
      return 'bgls.error.upload.hash_mismatch';
    case 'E_UPLOAD_SIZE_MISMATCH':
      return 'bgls.error.upload.bad_offset';
    case 'E_UPLOAD_ID_INVALID':
    case 'E_UPLOAD_DUPLICATE':
    case 'E_UPLOAD_ALREADY_COMPLETE':
      return 'bgls.error.protocol.bad_envelope';
    case 'E_FILE_INPUT':
      return reason === 'no_match'
        ? 'bgls.error.capture.no_match'
        : 'bgls.error.protocol.bad_envelope';
    default:
      return fallback;
  }
}

/**
 * Maps a `ManagedSession.startRecording`/`.stopRecording` throw to a
 * `recording.*` handler's `error` reply, mirroring `uploadWireCodeFor`'s
 * own shape immediately above. `E_RECORDING_UNAVAILABLE`/`E_RECORDING_NOT_FOUND`
 * are this feature's own codes (`managed-session.ts`); `E_CDP_TARGET_NOT_FOUND`/
 * `E_CDP_TARGET_CLOSED` are `startRecording`'s own `Session.subscribe()`
 * call surfacing the same "no live session" failure `target.capture`/
 * `page.pdf.get` already map to `bgls.error.target.not_found` above.
 * `category` stays `'target'` for all three named cases: every one of
 * them is about a named resource (a target or a recording) rather than a
 * malformed request or a wire-level fault, and `ErrorCategory`
 * (`@browserglass/protocol`) has no `'recording'` member of its own (a
 * protocol change this feature does not need; see `@browserglass/protocol`'s
 * `wire/messages/recording.ts` module doc for the capability decision
 * this mirrors, made the same way for the same reason: use what already
 * exists rather than widen a shared enum for one feature).
 */
function recordingErrorReply(
  err: unknown,
  subject: string,
): { t: 'error' } & Record<string, unknown> {
  const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
  const wireCode =
    code === 'E_RECORDING_UNAVAILABLE'
      ? 'bgls.error.target.recording_unavailable'
      : code === 'E_RECORDING_NOT_FOUND'
        ? 'bgls.error.target.recording_not_found'
        : code === 'E_CDP_TARGET_NOT_FOUND' || code === 'E_CDP_TARGET_CLOSED'
          ? 'bgls.error.target.not_found'
          : 'bgls.error.internal';
  return {
    t: 'error',
    code: wireCode,
    category: wireCode === 'bgls.error.internal' ? 'internal' : 'target',
    message: err instanceof Error ? err.message : `recording request failed for "${subject}".`,
    fatal: false,
    retryable: false,
  };
}

function bucketFor(t: string): RateBucketName | undefined {
  if (t.startsWith('input.')) return 'input';
  if (t.startsWith('control.')) return 'control';
  if (t.startsWith('nav.')) return 'nav';
  if (t === 'presence.cursor') return 'cursor';
  if (t === 'target.probe') return 'probeFull';
  if (t === 'target.capture') return 'capture';
  // `page.pdf.get`: same bucket as `target.capture`, deliberately. Both
  // are one CDP round trip against the renderer, gated on the identical
  // `capture` capability (`../wire/capability-check.ts`); see that
  // table's own comment for the full argument for sharing rather than
  // minting a second ceiling for the same cost class of request.
  if (t === 'page.pdf.get') return 'capture';
  // `recording.start` only: one CDP round trip (`Session.subscribe()`'s
  // `registry.attach()`/`activation.ensureSubscribed`), the same cost
  // class as `target.capture`/`page.pdf.get`, gated on the same base
  // capability (`capture`, see `wire/capability-check.ts`'s own comment
  // on the `recording.*` entries). `recording.stop`/`.list` touch no CDP
  // session at all (in-memory `ManagedSession` bookkeeping only), so
  // neither gets a bucket, matching `target.list`'s own unbucketed
  // precedent.
  if (t === 'recording.start') return 'capture';
  if (t === 'page.evaluate') return 'evaluate';
  // The SDK-internal counterpart above: same cost class, charged to its
  // own smaller bucket instead so a caller's own `page.evaluate` traffic
  // is never crowded out by however many round trips the locator surface
  // needed. See `evaluateInternal`'s own doc in `wire/rate-limit.ts`.
  if (t === 'page.evaluate.internal') return 'evaluateInternal';
  // Gate verdicts share the `evaluate` bucket rather than getting one of
  // their own. A `request.gate.resolve` is the answer to a request the
  // server itself paused, so its rate is bounded by the page's own
  // request rate and not by anything the caller chooses; bucketing it
  // with evaluate keeps one wedged client from spending the whole
  // connection's budget through either door.
  if (t.startsWith('request.gate.')) return 'evaluate';
  // Same bucket, same reasoning: one `Network.getResponseBody` CDP round
  // trip is the same cost class as one `Runtime.evaluate` round trip, and
  // a caller that could otherwise spam either door should not get two
  // separate budgets to do it with.
  if (t === 'page.responsebody.get') return 'evaluate';
  // `Accessibility.queryAXTree` and the optional `DOM.setAttributeValue`
  // write are the same CDP round-trip cost class as `Runtime.evaluate`,
  // so this stays on the shared `evaluate` bucket rather than moving to
  // `evaluateInternal` alongside `page.evaluate.internal` above.
  // Deliberately: `page.a11y.get` is not purely locator bookkeeping the
  // way `page.evaluate.internal` is. `AutomationClient.a11y()` sends the
  // identical message type as a caller-facing read (`sendA11y`,
  // `packages/automation/src/client/AutomationClient.ts`), and `bucketFor()`
  // dispatches on the wire `t` alone, with no way to tell that call apart
  // from the `role=` selector's internal one from here. Moving this whole
  // `t` to the smaller internal bucket would hand every `a11y()` caller a
  // tighter budget than `page.evaluate` gives them for a call the caller
  // asked for directly, which is the wrong direction. A `role=` selector's
  // OWN resolve() round trip (the `RESOLVE_SCRIPT` it runs right after
  // this query) already moved to `page.evaluate.internal`
  // (`AutomationClient`'s `locators` getter), so a `role=` lookup now
  // spends one `evaluate` token (this query) and one smaller
  // `evaluateInternal` token (the resolve), down from two full `evaluate`
  // tokens. Splitting `page.a11y.get` itself the same way `page.evaluate`
  // was split would need a caller/internal distinction inside
  // `@browserglass/protocol`'s `wire/messages/a11y.ts` and
  // `packages/core/src/cdp/accessibility.ts`, both outside this change's
  // owned paths.
  if (t === 'page.a11y.get') return 'evaluate';
  // Its own bucket, deliberately not `evaluate`: a page map capture is
  // roughly ten times the CDP round-trip cost of one `Runtime.evaluate`
  // (three-plus parallel commands, a per-frame accessibility fan-out, and
  // optionally the listener signal), so bucketing it with `evaluate` would
  // let one caller's page-map traffic spend the whole connection's
  // evaluate budget. See `@browserglass/protocol`'s `wire/messages/pagemap.ts`
  // module doc and `../wire/rate-limit.ts`'s `PAGEMAP_BUCKET_DEFAULT`.
  // `page.map.stamp` shares the bucket with `page.map.get`: see that
  // constant's own doc for why a second, separate meter for the stamp path
  // is not worth the extra bucket.
  if (t === 'page.map.get' || t === 'page.map.stamp') return 'pagemap';
  if (t === 'ack') return 'ack';
  return undefined;
}

/** `Connection.sendEnvelope()`'s OUTBOUND counterpart to `bucketFor()` above: maps a diagnostics push's own `t` to the bucket that caps it. Never consulted by `dispatch()`, since none of these three types ever arrives as an inbound `t`. */
function diagnosticsBucketFor(t: string): RateBucketName | undefined {
  if (t === 'console.entry') return 'console';
  if (t === 'page.error') return 'pageError';
  if (t === 'network.request' || t === 'network.summary') return 'network';
  return undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
