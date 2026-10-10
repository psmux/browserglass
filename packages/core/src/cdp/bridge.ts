/**
 * `CdpBridge`: one WebSocket per Instance, a shared request id space, flat
 * CDP sessions multiplexed over it.
 *
 * Fully typed `CdpMethod`/`CdpParams<M>`/`CdpResult<M>` signatures would
 * need a devtools-protocol type package, which is not a dependency of this
 * package, so `send`, `sendNoReply`, and `on` are typed against `string`
 * methods and `Record<string, unknown>` params instead.
 */

import type { InstanceId } from '@browserglass/protocol';
import type { ScreencastMetadata } from '@browserglass/protocol';
import { CrashBudget } from '../recovery/crash-budget.js';
import { SingleFlight } from '../recovery/single-flight.js';
import {
  CdpError,
  backoffError,
  closedError,
  crashedError,
  detachedError,
  mapCdpJsonRpcError,
  timeoutError,
} from './errors.js';
import {
  type CdpWebSocketCloseEvent,
  type CdpWebSocketLike,
  type TimerHandle,
  WS_READY_STATE,
  clearTimer,
  defaultWebSocketFactory,
  monotonicNow,
  scheduleTimer,
} from './platform.js';
import { type ReconnectDeps, type ReconnectOutcome, reconnectTransport } from './reconnect.js';
import { timeoutForMethod } from './timeouts.js';
import {
  type AttachOptions,
  type BrowserChannelKind,
  type BrowserVersion,
  CDP_HARD_MIN_MAJOR,
  CDP_MIN_MAJOR_DEFAULT,
  type CdpAttachOptionsExt,
  type CdpBridgeEvents,
  type CdpBridgeStats,
  type CdpEndpoint,
  type CdpSessionHandle,
  type CdpSessionId,
  type CdpWebSocketFactory,
  type ConnectOptions,
  type DetachReason,
  type LatencySample,
  type SendOptions,
  type Unsubscribe,
} from './types.js';

/**
 * The bridge's own connection lifecycle. `reconnecting` sits between `open`
 * and `closed`: entered only from an unexpected socket drop (never from a
 * caller's own `close()`, which goes `closing` -> `closed` directly, same
 * as before this state existed), left either back to `open` (a successful
 * redial) or on to `closed` (the reconnect budget gave up). Every existing
 * `state !== 'open'` guard in this file (`send`, `sendNoReply`) already
 * treats `reconnecting` the same as `closing`/`closed`: no command is
 * answerable while the transport itself is down, reconnect or not.
 */
export type CdpBridgeState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closing' | 'closed';

/** The attach backoff table, keyed by consecutive attach failure count. */
const BACKOFF_SCHEDULE_MS: readonly number[] = [0, 0, 0, 5000, 10000, 20000, 30000];

/** Consecutive attach failures on one target after which it is reported as degraded. */
const DEGRADED_AFTER_FAILURES = 10;

/** Resolves the backoff, in milliseconds, for a given consecutive attach failure count. */
function backoffForFailures(fails: number): number {
  const idx = Math.min(fails, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx] ?? 30000;
}

/** Per target attach and health state. */
interface SessionHealth {
  targetId: string;
  generation: number;
  handle: SessionHandleRecord | null;
  attaching: Promise<CdpSessionHandle> | null;
  dead: boolean;
  attachFails: number;
  backoffUntil: number;
  timeoutStreak: number;
  lastOkAt: number;
  lastErrorAt: number;
  lastError: CdpError | null;
  degraded: boolean;
}

/** A read only snapshot of one target's {@link SessionHealth}, safe to hand to a caller. */
export interface SessionHealthSnapshot {
  targetId: string;
  generation: number;
  attached: boolean;
  dead: boolean;
  attachFails: number;
  backoffUntil: number;
  timeoutStreak: number;
  lastOkAt: number;
  lastErrorAt: number;
  degraded: boolean;
}

/** Concrete, mutable backing store for a {@link CdpSessionHandle}. */
class SessionHandleRecord implements CdpSessionHandle {
  id: CdpSessionId;
  targetId: string;
  type: string;
  attachedAt: number;
  generation: number;
  alive: boolean;

  constructor(init: {
    id: CdpSessionId;
    targetId: string;
    type: string;
    attachedAt: number;
    generation: number;
  }) {
    this.id = init.id;
    this.targetId = init.targetId;
    this.type = init.type;
    this.attachedAt = init.attachedAt;
    this.generation = init.generation;
    this.alive = true;
  }
}

interface Pending {
  id: number;
  method: string;
  sessionId: CdpSessionId | null;
  sentAt: number;
  timer: TimerHandle | null;
  resolve: (v: unknown) => void;
  reject: (e: CdpError) => void;
}

/** One raw inbound CDP message, either a command response or an event. */
interface RawCdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The raw shape of a `Page.screencastFrame` event, before the bridge boundary rename. */
interface RawScreencastFrameParams {
  data: string;
  metadata: ScreencastMetadata;
  /** Chrome's frame sequence counter, not a CDP session id. Never let this name leak past the bridge. */
  sessionId: number;
}

/** A registered `on()` handler, tracked so a session detach can unregister everything bound to it. */
interface HandlerEntry {
  key: string;
  fn: (params: Record<string, unknown>, sessionId: string | null) => void;
}

/** Sentinel `id` for {@link CdpBridgeImpl.sendNoReply} messages: never allocated from `nextId`, so it can never collide with a tracked request. */
const NO_REPLY_ID = 0;

/**
 * `CdpBridge`'s public interface.
 */
export interface CdpBridge {
  readonly instanceId: InstanceId;
  readonly state: CdpBridgeState;
  readonly version: BrowserVersion | null;

  connect(endpoint: CdpEndpoint, opts?: ConnectOptions): Promise<BrowserVersion>;
  sessionFor(targetId: string, opts?: CdpAttachOptionsExt): Promise<CdpSessionHandle>;
  /**
   * Registers a session Chrome auto-attached (a `Target.attachedToTarget`
   * event delivered because of `Target.setAutoAttach`, not a direct
   * `sessionFor()` call), so it participates in the same in-flight
   * rejection, generation counting, and `send()` validation as a manually
   * attached one. Idempotent: a target already holding a live handle keeps
   * it. `TargetRegistry` is the only intended caller.
   */
  registerAutoAttachedSession(
    targetId: string,
    sessionId: CdpSessionId,
    type?: string,
  ): CdpSessionHandle;
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: CdpSessionId,
    opts?: SendOptions,
  ): Promise<unknown>;
  /** No id, no timer, nothing in the pending map. */
  sendNoReply(method: string, params?: Record<string, unknown>, sessionId?: CdpSessionId): void;
  on(
    event: string,
    handler: (params: Record<string, unknown>, sessionId: CdpSessionId | null) => void,
    sessionId?: CdpSessionId,
  ): Unsubscribe;
  /**
   * Subscribes to `Page.screencastFrame` on one session with the ack rule
   * enforced: `Page.screencastFrameAck` is sent, unawaited,
   * as the literal first statement, before `handler` runs, and Chrome's
   * `params.sessionId` (a frame counter) is renamed to `castFrameId` so it
   * is never confused with the CDP session id.
   */
  onScreencastFrame(
    sessionId: CdpSessionId,
    handler: (data: string, metadata: ScreencastMetadata, castFrameId: number) => void,
  ): Unsubscribe;
  onBridge<K extends keyof CdpBridgeEvents>(k: K, h: CdpBridgeEvents[K]): Unsubscribe;
  detach(sessionId: CdpSessionId): Promise<void>;
  close(reason?: string): Promise<void>;
  stats(): CdpBridgeStats;
  /** Read only snapshot of one target's circuit breaker state; `undefined` if never attached. */
  sessionHealth(targetId: string): SessionHealthSnapshot | undefined;
  /** Cheap, session scoped liveness probe answered by the browser process, not the renderer. */
  checkLiveness(sessionId: CdpSessionId, timeoutMs?: number): Promise<boolean>;

  /**
   * Arms proxy credential handling (`Fetch.enable` with `handleAuthRequests:
   * true`) on one session, composing with whatever a PLAIN `Fetch.enable`
   * caller (today, only `../interception/request-gate.ts`'s `RequestGate`)
   * has independently enabled there, instead of the two silently clobbering
   * each other. See `./proxy-auth.ts`'s module doc for the full argument;
   * `ProxyAuthHandler` is the only intended caller. Idempotent per session.
   */
  armProxyAuth(sessionId: CdpSessionId): Promise<void>;
  /**
   * Disarms proxy credential handling on one session. Falls back to
   * whatever plain `Fetch.enable` config is still active there (a
   * `RequestGate` that outlives this call keeps working, `handleAuthRequests`
   * simply comes back off) rather than always sending a hard `Fetch.disable`,
   * which would silently turn off that other consumer's interception too.
   */
  disarmProxyAuth(sessionId: CdpSessionId): Promise<void>;
  /**
   * Whether a PLAIN (non proxy-auth) caller currently has `Fetch` enabled on
   * this session, i.e. whether something else (today, only `RequestGate`)
   * already owns deciding `Fetch.requestPaused`. `ProxyAuthHandler` reads
   * this before it would otherwise auto-continue a non-auth pause itself:
   * see `./proxy-auth.ts`'s module doc for why answering both is never safe.
   */
  hasPlainFetchInterception(sessionId: CdpSessionId): boolean;
}

/** Constructor options for {@link CdpBridgeImpl}. */
export interface CdpBridgeOptions {
  wsFactory?: CdpWebSocketFactory;
  /**
   * Overrides for the unexpected-close reconnect loop (`./reconnect.js`).
   * Every field defaults to the production value; the only intended caller
   * of this is this package's own test suite, shrinking the backoff/dial
   * timeout so a budget-exhaustion test does not spend real wall time
   * waiting on it.
   */
  reconnect?: {
    /** Defaults to a fresh `CrashBudget()` (ten minute window, three attempts), scoped to this one bridge for its whole lifetime. */
    budget?: CrashBudget;
    backoffMs?: readonly number[];
    dialTimeoutMs?: number;
  };
}

/** The concrete `CdpBridge` implementation. */
export class CdpBridgeImpl implements CdpBridge {
  readonly instanceId: InstanceId;

  private _state: CdpBridgeState = 'idle';
  private _version: BrowserVersion | null = null;
  private ws: CdpWebSocketLike | null = null;
  private readonly wsFactory: CdpWebSocketFactory;
  /** The endpoint `connect()` was called with, retained so an unexpected drop can redial the same one; `reconnectTransport` never sees a different endpoint than the caller's original `connect()` did. */
  private endpoint: CdpEndpoint | null = null;

  /**
   * One `CrashBudget` for this bridge's whole lifetime, not a fresh one per
   * disconnect: see `./reconnect.ts`'s module doc, point 1. A caller may
   * inject its own (tests only, in practice) via `CdpBridgeOptions.reconnect.budget`.
   */
  private readonly reconnectBudget: CrashBudget;
  private readonly reconnectBackoffMs: readonly number[] | undefined;
  private readonly reconnectDialTimeoutMs: number | undefined;
  /** Re-entrancy guard around the reconnect attempt itself (the single-flight idiom, `../recovery/single-flight.ts`): a second unexpected-close handler firing while one redial is already in flight coalesces onto it rather than dialing again. In practice `handleSocketClose`'s own `_state === 'reconnecting'` early-return already prevents this from ever double-triggering, since that flag is set synchronously before the first `await`; this is the belt to that guard's suspenders, and documents the invariant explicitly the way `recovery/runner.ts` does for the ladder. */
  private readonly reconnectFlight = new SingleFlight<string>();

  private readonly inflight = new Map<number, Pending>();
  private nextId = 1;

  private readonly handlers = new Map<string, Set<HandlerEntry>>();
  private readonly sessionHandlerEntries = new Map<CdpSessionId, Set<HandlerEntry>>();
  private readonly bridgeHandlers = new Map<string, Set<(...args: unknown[]) => void>>();

  private readonly healthByTargetId = new Map<string, SessionHealth>();
  private readonly sessionsBySessionId = new Map<CdpSessionId, SessionHandleRecord>();

  /**
   * Sessions where `armProxyAuth` has been called and not yet undone by
   * `disarmProxyAuth`. See `send()`'s `Fetch.enable`/`Fetch.disable`
   * composition block, and `./proxy-auth.ts`'s module doc for why this
   * bridge is the one place that special-cases those two methods by name.
   */
  private readonly fetchAuthArmedSessions = new Set<CdpSessionId>();
  /**
   * Sessions where the LAST plain (non proxy-auth) `Fetch.enable` this
   * bridge actually transmitted is still the current state, i.e. nothing
   * has sent a plain `Fetch.disable` for it since. Only meaningful, and
   * only maintained, once {@link fetchAuthArmedSessions} has at least one
   * entry; see `send()`'s composition block.
   */
  private readonly fetchPlainActiveSessions = new Set<CdpSessionId>();

  private closeFinalized = false;

  private statSent = 0;
  private statReceived = 0;
  private statTimeouts = 0;
  private statProtocolErrors = 0;
  private statBytesIn = 0;
  private statBytesOut = 0;
  private readonly latencySamples = new Map<string, number[]>();

  constructor(instanceId: InstanceId, opts: CdpBridgeOptions = {}) {
    this.instanceId = instanceId;
    this.wsFactory = opts.wsFactory ?? defaultWebSocketFactory;
    this.reconnectBudget = opts.reconnect?.budget ?? new CrashBudget();
    this.reconnectBackoffMs = opts.reconnect?.backoffMs;
    this.reconnectDialTimeoutMs = opts.reconnect?.dialTimeoutMs;
  }

  get state(): CdpBridgeState {
    return this._state;
  }

  get version(): BrowserVersion | null {
    return this._version;
  }

  // ── connect ───────────────────────────────────────────────────────────

  async connect(endpoint: CdpEndpoint, opts: ConnectOptions = {}): Promise<BrowserVersion> {
    if (this._state !== 'idle') {
      throw new CdpError('E_CDP_ALREADY_CONNECTED', {
        kind: 'transport',
        retryable: false,
        message: 'connect() called more than once on this bridge',
      });
    }
    this._state = 'connecting';
    this.endpoint = endpoint;
    const connectTimeoutMs = opts.connectTimeoutMs ?? 10000;

    const socket = this.wsFactory(endpoint);
    this.ws = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = scheduleTimer(() => {
        reject(
          new CdpError('E_CDP_TIMEOUT', {
            kind: 'timeout',
            retryable: true,
            message: `connect() timed out after ${connectTimeoutMs}ms`,
          }),
        );
      }, connectTimeoutMs);
      socket.onopen = () => {
        clearTimer(timer);
        resolve();
      };
      socket.onerror = (err: unknown) => {
        clearTimer(timer);
        reject(
          new CdpError('E_CDP_TRANSPORT', {
            kind: 'transport',
            retryable: true,
            message: 'WebSocket error during connect',
            cause: err,
          }),
        );
      };
    });

    this._state = 'open';
    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
    this.ws.onclose = (ev) => this.handleSocketClose(ev);
    this.ws.onerror = (err) =>
      this.emitBridge(
        'bridge.error',
        err instanceof Error ? err : new Error('CDP transport error'),
      );
    this.emitBridge('bridge.open');

    const rawVersion = (await this.send('Browser.getVersion', undefined, undefined, {
      timeoutMs: 5000,
    })) as {
      protocolVersion: string;
      product: string;
      revision: string;
      userAgent: string;
      jsVersion: string;
    };

    const version = parseBrowserVersion(rawVersion);
    const minMajor = Math.max(opts.minMajor ?? CDP_MIN_MAJOR_DEFAULT, CDP_HARD_MIN_MAJOR);
    if (version.major < CDP_HARD_MIN_MAJOR || (opts.strictVersion && version.major < minMajor)) {
      throw new CdpError('E_CDP_VERSION_TOO_OLD', {
        kind: 'version',
        retryable: false,
        message: `Chrome major ${version.major} is below the required minimum ${minMajor}`,
      });
    }

    const supports = await this.probeFeatures();
    this._version = { ...version, supports };
    return this._version;
  }

  private async probeFeatures(): Promise<Readonly<Record<string, boolean>>> {
    const probes: Array<[string, () => Promise<unknown>]> = [
      [
        'webLifecycle',
        () =>
          this.send('Page.setWebLifecycleState', { state: 'active' }, undefined, {
            timeoutMs: 3000,
          }),
      ],
      [
        'fileChooserIntercept',
        () =>
          this.send('Page.setInterceptFileChooserDialog', { enabled: false }, undefined, {
            timeoutMs: 3000,
          }),
      ],
      [
        'downloadEvents',
        () =>
          this.send(
            'Page.setDownloadBehavior',
            { behavior: 'default', eventsEnabled: false },
            undefined,
            { timeoutMs: 3000 },
          ),
      ],
    ];
    const supports: Record<string, boolean> = {};
    for (const [name, run] of probes) {
      try {
        await run();
        supports[name] = true;
      } catch (err) {
        supports[name] = !(err instanceof CdpError && err.code === 'E_CDP_METHOD_UNSUPPORTED');
      }
    }
    return supports;
  }

  // ── sessionFor (concurrency guard) ──────────────────────────────────

  private health(targetId: string): SessionHealth {
    let h = this.healthByTargetId.get(targetId);
    if (!h) {
      h = {
        targetId,
        generation: 0,
        handle: null,
        attaching: null,
        dead: false,
        attachFails: 0,
        backoffUntil: 0,
        timeoutStreak: 0,
        lastOkAt: 0,
        lastErrorAt: 0,
        lastError: null,
        degraded: false,
      };
      this.healthByTargetId.set(targetId, h);
    }
    return h;
  }

  async sessionFor(targetId: string, opts?: CdpAttachOptionsExt): Promise<CdpSessionHandle> {
    const h = this.health(targetId);
    const now = monotonicNow();

    if (h.backoffUntil && now < h.backoffUntil) {
      throw backoffError(targetId, h.backoffUntil, now);
    }
    if (h.handle && h.dead) {
      h.handle = null;
    }
    if (h.handle) {
      return h.handle;
    }
    if (h.attaching) {
      return h.attaching;
    }

    h.attaching = this.doAttach(targetId, opts);
    try {
      return await h.attaching;
    } finally {
      h.attaching = null;
    }
  }

  private async doAttach(targetId: string, opts?: CdpAttachOptionsExt): Promise<CdpSessionHandle> {
    const h = this.health(targetId);
    try {
      const result = (await this.send(
        'Target.attachToTarget',
        { targetId, flatten: true },
        undefined,
        { timeoutMs: timeoutForMethod('Target.attachToTarget') },
      )) as { sessionId: string };

      h.generation += 1;
      const handle = new SessionHandleRecord({
        id: result.sessionId as CdpSessionId,
        targetId,
        type: opts?.type ?? '',
        attachedAt: monotonicNow(),
        generation: h.generation,
      });

      h.handle = handle;
      h.dead = false;
      h.attachFails = 0;
      h.backoffUntil = 0;
      h.lastOkAt = monotonicNow();
      h.degraded = false;
      this.sessionsBySessionId.set(handle.id, handle);
      this.emitBridge('session.attached', handle);
      return handle;
    } catch (err) {
      h.attachFails += 1;
      h.lastErrorAt = monotonicNow();
      h.lastError = err instanceof CdpError ? err : null;
      const backoffMs = backoffForFailures(h.attachFails);
      h.backoffUntil = backoffMs > 0 ? monotonicNow() + backoffMs : 0;
      h.degraded = h.attachFails >= DEGRADED_AFTER_FAILURES;
      throw err;
    }
  }

  registerAutoAttachedSession(
    targetId: string,
    sessionId: CdpSessionId,
    type?: string,
  ): CdpSessionHandle {
    const h = this.health(targetId);
    if (h.handle?.alive) {
      return h.handle;
    }
    h.generation += 1;
    const handle = new SessionHandleRecord({
      id: sessionId,
      targetId,
      type: type ?? '',
      attachedAt: monotonicNow(),
      generation: h.generation,
    });
    h.handle = handle;
    h.dead = false;
    h.attachFails = 0;
    h.backoffUntil = 0;
    h.lastOkAt = monotonicNow();
    h.degraded = false;
    this.sessionsBySessionId.set(handle.id, handle);
    this.emitBridge('session.attached', handle);
    return handle;
  }

  sessionHealth(targetId: string): SessionHealthSnapshot | undefined {
    const h = this.healthByTargetId.get(targetId);
    if (!h) {
      return undefined;
    }
    return {
      targetId: h.targetId,
      generation: h.generation,
      attached: h.handle?.alive === true,
      dead: h.dead,
      attachFails: h.attachFails,
      backoffUntil: h.backoffUntil,
      timeoutStreak: h.timeoutStreak,
      lastOkAt: h.lastOkAt,
      lastErrorAt: h.lastErrorAt,
      degraded: h.degraded,
    };
  }

  async checkLiveness(sessionId: CdpSessionId, timeoutMs = 3000): Promise<boolean> {
    try {
      await this.send('Page.getFrameTree', undefined, sessionId, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  // ── send / sendNoReply ───────────────────────────────────────────────

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: CdpSessionId,
    opts: SendOptions = {},
  ): Promise<unknown> {
    if (opts.priority === 'high') {
      this.sendNoReply(method, params, sessionId);
      return Promise.resolve(undefined);
    }

    // ── Fetch domain composition (see `./proxy-auth.ts`'s module doc) ──
    // `Fetch.enable`/`Fetch.disable` are the one CDP method pair this
    // bridge special-cases by name. CDP keeps only the LAST `Fetch.enable`
    // a session received (patterns and `handleAuthRequests` together, one
    // config, not additive across calls), and `Fetch.disable` turns the
    // domain off entirely. This build has exactly two independent callers
    // of those methods (`RequestGate` for a submit gate, `ProxyAuthHandler`
    // for proxy credentials, confirmed by the same grep `RequestGate`'s own
    // module doc already relies on), and without this block whichever one
    // called last would silently win, undoing the other with no error
    // anywhere. Only takes effect on a session `armProxyAuth` has actually
    // armed; every other session, i.e. every call this build made before
    // proxy auth existed, passes through `method`/`params` completely
    // unmodified below.
    let effMethod = method;
    let effParams = params;
    if (sessionId !== undefined && (method === 'Fetch.enable' || method === 'Fetch.disable')) {
      // Tracked for EVERY session, whether or not proxy auth has armed
      // there, and regardless of which of the two calls first: a plain
      // caller (`RequestGate`) may enable `Fetch` before `armProxyAuth` is
      // ever called for that session (installed lazily, on an app's own
      // request, whereas proxy auth arms eagerly at attach time but is not
      // guaranteed to run first in every caller ordering). Without this
      // bookkeeping being unconditional, `hasPlainFetchInterception` would
      // answer `false` for a session `RequestGate` genuinely owns, simply
      // because proxy auth had not armed there YET, which is exactly the
      // ordering-dependent bug `./proxy-auth.ts`'s own handler needs this
      // to never have.
      if (method === 'Fetch.enable') {
        this.fetchPlainActiveSessions.add(sessionId);
      } else {
        this.fetchPlainActiveSessions.delete(sessionId);
      }
      if (this.fetchAuthArmedSessions.has(sessionId)) {
        // The union is always just "Request stage, matches everything",
        // regardless of which combination of the two consumers is present:
        // `RequestGate` always asks for exactly that (its own module doc:
        // "narrowing belongs in the handler ... not the CDP filter"), and
        // `ProxyAuthHandler` needs it too so it can fall back to continuing
        // every non-auth pause itself when `RequestGate` is not around (the
        // Puppeteer-verified shape, see `./proxy-auth.ts`). So this never
        // needs to actually inspect the caller's own `patterns`.
        effMethod = 'Fetch.enable';
        effParams = {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
          handleAuthRequests: true,
        };
      }
    }

    return this.transmit(effMethod, effParams, sessionId, opts);
  }

  /**
   * The actual wire transmission for a tracked command: id allocation,
   * pending map bookkeeping, timeout arming, payload send. Split out of
   * `send()` so `armProxyAuth`/`disarmProxyAuth` can call it directly with
   * params they have already composed themselves, bypassing `send()`'s own
   * Fetch composition block above. Calling back into `send()` instead would
   * re-enter that block while `fetchAuthArmedSessions`/`fetchPlainActiveSessions`
   * are mid-update for this exact call, which is a race this avoids by
   * construction rather than by a reentrancy flag.
   */
  private transmit(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: CdpSessionId | undefined,
    opts: SendOptions,
  ): Promise<unknown> {
    if (this._state !== 'open') {
      return Promise.reject(closedError({ method, sessionId: sessionId ?? null, elapsedMs: 0 }));
    }
    if (sessionId !== undefined) {
      const handle = this.sessionsBySessionId.get(sessionId);
      if (!handle || !handle.alive) {
        return Promise.reject(
          detachedError({ method, sessionId, elapsedMs: 0 }, 'unknown or already detached session'),
        );
      }
    }

    const id = this.nextId++;
    const timeoutMs = timeoutForMethod(method, opts.timeoutMs);
    const sentAt = monotonicNow();

    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = {
        id,
        method,
        sessionId: sessionId ?? null,
        sentAt,
        timer: null,
        resolve,
        reject,
      };
      this.inflight.set(id, pending);

      // A timer is armed for every tracked command, `fireAndForget` included:
      // the only difference `fireAndForget` makes is what the timer does when
      // it fires (resolve `undefined` instead of reject). `priority: 'high'`
      // is the option that skips the pending map and the timer entirely,
      // handled in `send()` by delegating to `sendNoReply` before this method
      // is ever reached.
      pending.timer = scheduleTimer(() => {
        this.inflight.delete(id);
        this.statTimeouts += 1;
        const health = sessionId ? this.findHealthBySessionId(sessionId) : undefined;
        if (health) {
          health.timeoutStreak += 1;
        }
        if (opts.fireAndForget) {
          pending.resolve(undefined);
        } else {
          pending.reject(
            timeoutError({
              method,
              sessionId: sessionId ?? null,
              elapsedMs: monotonicNow() - sentAt,
            }),
          );
        }
      }, timeoutMs);

      const payload = JSON.stringify({ id, method, params: params ?? {}, sessionId });
      this.ws?.send(payload);
      this.statSent += 1;
      this.statBytesOut += payload.length;
    });
  }

  /** {@link CdpBridge.armProxyAuth}'s real implementation. */
  async armProxyAuth(sessionId: CdpSessionId): Promise<void> {
    if (this.fetchAuthArmedSessions.has(sessionId)) {
      return;
    }
    this.fetchAuthArmedSessions.add(sessionId);
    await this.transmit(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true },
      sessionId,
      {},
    );
  }

  /** {@link CdpBridge.disarmProxyAuth}'s real implementation. */
  async disarmProxyAuth(sessionId: CdpSessionId): Promise<void> {
    if (!this.fetchAuthArmedSessions.has(sessionId)) {
      return;
    }
    this.fetchAuthArmedSessions.delete(sessionId);
    if (this.fetchPlainActiveSessions.has(sessionId)) {
      // A plain caller (`RequestGate`) is still enabled on this session:
      // fall back to its own config, `handleAuthRequests` simply off,
      // rather than disabling `Fetch` out from under it.
      await this.transmit(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
        sessionId,
        {},
      ).catch(() => {
        // Best effort, matching `RequestGate.stop()`'s own precedent: the
        // session may already be gone.
      });
    } else {
      await this.transmit('Fetch.disable', undefined, sessionId, {}).catch(() => {
        // Best effort, same reasoning.
      });
    }
  }

  /** {@link CdpBridge.hasPlainFetchInterception}'s real implementation. */
  hasPlainFetchInterception(sessionId: CdpSessionId): boolean {
    return this.fetchPlainActiveSessions.has(sessionId);
  }

  sendNoReply(method: string, params?: Record<string, unknown>, sessionId?: CdpSessionId): void {
    if (this._state !== 'open') {
      return;
    }
    const payload = JSON.stringify({ id: NO_REPLY_ID, method, params: params ?? {}, sessionId });
    try {
      this.ws?.send(payload);
      this.statSent += 1;
      this.statBytesOut += payload.length;
    } catch {
      // fire and forget: a send failure here must never throw into the caller.
    }
  }

  private findHealthBySessionId(sessionId: CdpSessionId): SessionHealth | undefined {
    const handle = this.sessionsBySessionId.get(sessionId);
    if (!handle) {
      return undefined;
    }
    return this.healthByTargetId.get(handle.targetId);
  }

  // ── message handling ─────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    this.statReceived += 1;
    this.statBytesIn += raw.length;

    let msg: RawCdpMessage;
    try {
      msg = JSON.parse(raw) as RawCdpMessage;
    } catch {
      this.statProtocolErrors += 1;
      return;
    }

    if (msg.id !== undefined && msg.id !== NO_REPLY_ID) {
      const pending = this.inflight.get(msg.id);
      if (!pending) {
        return;
      }
      this.inflight.delete(msg.id);
      clearTimer(pending.timer);
      const elapsedMs = monotonicNow() - pending.sentAt;
      if (msg.error) {
        this.statProtocolErrors += 1;
        pending.reject(
          mapCdpJsonRpcError(msg.error, {
            method: pending.method,
            sessionId: pending.sessionId,
            elapsedMs,
          }),
        );
      } else {
        this.recordLatency(pending.method, elapsedMs);
        const health = pending.sessionId
          ? this.findHealthBySessionId(pending.sessionId)
          : undefined;
        if (health) {
          health.timeoutStreak = 0;
          health.lastOkAt = monotonicNow();
        }
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === undefined) {
      return;
    }

    this.handleLifecycleEvent(msg.method, msg.params ?? {}, msg.sessionId ?? null);

    const key = msg.sessionId ? `${msg.sessionId} ${msg.method}` : msg.method;
    const bucket = this.handlers.get(key);
    if (bucket) {
      for (const entry of [...bucket]) {
        entry.fn(msg.params ?? {}, msg.sessionId ?? null);
      }
    }
  }

  /** Internal bookkeeping for the browser-scoped events that affect session health, run before any registered handler for the same event. */
  private handleLifecycleEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): void {
    if (method === 'Target.detachedFromTarget') {
      const evSessionId = (params['sessionId'] as string | undefined) ?? sessionId ?? undefined;
      if (evSessionId) {
        const handle = this.sessionsBySessionId.get(evSessionId as CdpSessionId);
        if (handle) {
          this.markSessionDead(handle, 'target_destroyed');
        }
      }
      return;
    }
    if (method === 'Target.targetCrashed') {
      const targetId = params['targetId'] as string | undefined;
      if (targetId) {
        const h = this.healthByTargetId.get(targetId);
        if (h?.handle) {
          this.markSessionDead(h.handle, 'target_crashed');
        }
      }
      return;
    }
    if (method === 'Target.targetDestroyed') {
      const targetId = params['targetId'] as string | undefined;
      if (targetId) {
        const h = this.healthByTargetId.get(targetId);
        if (h?.handle) {
          this.markSessionDead(h.handle, 'target_destroyed');
        }
      }
    }
  }

  private recordLatency(method: string, ms: number): void {
    let samples = this.latencySamples.get(method);
    if (!samples) {
      samples = [];
      this.latencySamples.set(method, samples);
    }
    samples.push(ms);
    if (samples.length > 200) {
      samples.shift();
    }
  }

  // ── on / onBridge / onScreencastFrame ───────────────────────────────

  on(
    event: string,
    handler: (params: Record<string, unknown>, sessionId: CdpSessionId | null) => void,
    sessionId?: CdpSessionId,
  ): Unsubscribe {
    const key = sessionId ? `${sessionId} ${event}` : event;
    const entry: HandlerEntry = {
      key,
      fn: (params, evSessionId) => handler(params, (evSessionId as CdpSessionId | null) ?? null),
    };
    let bucket = this.handlers.get(key);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(key, bucket);
    }
    bucket.add(entry);

    if (sessionId) {
      let sessionEntries = this.sessionHandlerEntries.get(sessionId);
      if (!sessionEntries) {
        sessionEntries = new Set();
        this.sessionHandlerEntries.set(sessionId, sessionEntries);
      }
      sessionEntries.add(entry);
    }

    return () => {
      this.handlers.get(key)?.delete(entry);
      if (sessionId) {
        this.sessionHandlerEntries.get(sessionId)?.delete(entry);
      }
    };
  }

  onScreencastFrame(
    sessionId: CdpSessionId,
    handler: (data: string, metadata: ScreencastMetadata, castFrameId: number) => void,
  ): Unsubscribe {
    return this.on(
      'Page.screencastFrame',
      (rawParams) => {
        const params = rawParams as unknown as RawScreencastFrameParams;
        const castFrameId = params.sessionId;
        // Ack first, always, before any other work. Never awaited.
        this.sendNoReply('Page.screencastFrameAck', { sessionId: castFrameId }, sessionId);
        handler(params.data, params.metadata, castFrameId);
      },
      sessionId,
    );
  }

  onBridge<K extends keyof CdpBridgeEvents>(k: K, h: CdpBridgeEvents[K]): Unsubscribe {
    let bucket = this.bridgeHandlers.get(k);
    if (!bucket) {
      bucket = new Set();
      this.bridgeHandlers.set(k, bucket);
    }
    const fn = h as (...args: unknown[]) => void;
    bucket.add(fn);
    return () => {
      this.bridgeHandlers.get(k)?.delete(fn);
    };
  }

  private emitBridge<K extends keyof CdpBridgeEvents>(
    k: K,
    ...args: Parameters<CdpBridgeEvents[K]>
  ): void {
    const bucket = this.bridgeHandlers.get(k);
    if (!bucket) {
      return;
    }
    for (const fn of [...bucket]) {
      fn(...args);
    }
  }

  // ── detach / close ───────────────────────────────────────────────────

  async detach(sessionId: CdpSessionId): Promise<void> {
    const handle = this.sessionsBySessionId.get(sessionId);
    if (!handle || !handle.alive) {
      return;
    }
    try {
      await this.send('Target.detachFromTarget', { sessionId });
    } catch {
      // Detaching an already-gone target throws by design; swallowed.
    }
    this.markSessionDead(handle, 'explicit');
  }

  /**
   * Marks a session dead: rejects its in-flight requests, unregisters its
   * event handlers, and clears it from the target's `SessionHealth`, but
   * only if that handle is still the current one for its target. A stale
   * detach handler firing after a newer attach has already replaced the
   * handle must not clear the new one.
   */
  private markSessionDead(handle: SessionHandleRecord, reason: DetachReason): void {
    if (!handle.alive) {
      return;
    }
    handle.alive = false;

    for (const [id, pending] of [...this.inflight]) {
      if (pending.sessionId === handle.id) {
        this.inflight.delete(id);
        clearTimer(pending.timer);
        pending.reject(
          detachedError(
            {
              method: pending.method,
              sessionId: handle.id,
              elapsedMs: monotonicNow() - pending.sentAt,
            },
            reason,
          ),
        );
      }
    }

    const sessionEntries = this.sessionHandlerEntries.get(handle.id);
    if (sessionEntries) {
      for (const entry of sessionEntries) {
        this.handlers.get(entry.key)?.delete(entry);
      }
      this.sessionHandlerEntries.delete(handle.id);
    }

    this.sessionsBySessionId.delete(handle.id);
    // CDP session ids are never reused (minted fresh per attach), so this
    // is hygiene against an unbounded leak across a long-lived bridge with
    // many navigations, not a correctness fix: a dead session's entries
    // here could never legitimately be read again either way.
    this.fetchAuthArmedSessions.delete(handle.id);
    this.fetchPlainActiveSessions.delete(handle.id);

    const h = this.healthByTargetId.get(handle.targetId);
    if (h && h.handle === handle) {
      h.handle = null;
      h.dead = true;
    }

    this.emitBridge('session.detached', handle, reason);
  }

  async close(reason?: string): Promise<void> {
    if (this._state === 'closed' || this._state === 'closing') {
      return;
    }
    this._state = 'closing';
    this.ws?.close(1000, reason ?? 'closed');
    this.finalizeClose({ code: 1000, reason: reason ?? '', wasClean: true });
  }

  /**
   * Dispatches an unexpected socket close, once and only once, to either
   * the reconnect attempt or straight to `finalizeClose`. An explicit
   * `close()` never reaches here as an unexpected close: it finalizes
   * synchronously itself, so `closeFinalized` is already true by the time
   * the socket's real `onclose` fires later, and the guard below short
   * circuits it. The `_state === 'reconnecting'` half of the guard is the
   * primary defence against a double-fired close event re-entering this
   * method; `reconnectFlight` (used inside `handleUnexpectedClose`) is the
   * second layer, for the case where re-entry happens through some other
   * path this file does not currently have.
   */
  private handleSocketClose(ev: CdpWebSocketCloseEvent): void {
    if (this.closeFinalized || this._state === 'reconnecting') {
      return;
    }
    if (this._state !== 'open') {
      // Died before ever reaching 'open' (mid-'connecting'), or some other
      // non-open state with no live sessions or in-flight state worth
      // preserving through a reconnect attempt. Finalize directly, same as
      // every state before this feature existed.
      this.finalizeClose(ev);
      return;
    }
    void this.handleUnexpectedClose(ev);
  }

  /**
   * THE GAP this module closes: previously `handleSocketClose` finalized
   * unconditionally, and the only way back to a working bridge was a full
   * Instance restart (`TargetRegistry`'s `restartInstance()`, which swaps in
   * an entirely fresh `CdpBridge`). This method instead treats an
   * unexpected drop as recoverable-until-proven-otherwise: reject what can
   * never be answered, invalidate what is provably dead, then spend a
   * bounded budget trying to get the same bridge working again before
   * giving up on it for good.
   */
  private async handleUnexpectedClose(ev: CdpWebSocketCloseEvent): Promise<void> {
    // Neither of these two steps depends on whether a reconnect will
    // eventually succeed: every in-flight command sent over the now-dead
    // socket can never be answered, and every CDP session id issued over it
    // is dead too, even if the browser process itself is still alive and
    // even if the reconnect below succeeds (C-CDP session ids are minted
    // per attach, never reused across a fresh `Target.attachToTarget`, flat
    // or not).
    this.rejectAllInflight();
    // Sessions are marked dead immediately, so a caller holding a stale
    // session id fails fast rather than waiting out a redial. The DETACH
    // announcement is held back until the redial succeeds: see
    // `announceSessionsDetached` for why announcing it up front turns a
    // dead browser into a storm of unrecoverable per target recoveries.
    const detachedSessions = this.invalidateSessionsAfterTransportDrop();

    this._state = 'reconnecting';
    this.emitBridge(
      'bridge.error',
      new Error(
        `CDP transport dropped unexpectedly (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''}); attempting reconnect`,
      ),
    );

    // A holder object, not a bare `let`, because TypeScript's control flow
    // narrowing does not follow a `let` variable's mutation across a
    // function-call boundary into a callback (`SingleFlight.run` invokes
    // `fn` internally, invisibly to the type checker's flow graph at this
    // call site): a bare `let outcome: ReconnectOutcome | null = null`
    // reassigned only inside the closure below would still type-check as
    // `null` after the `await`, making every `.kind`/`.socket` access below
    // a compile error. A property on an object is never narrowed across a
    // call boundary this way, so this sidesteps the issue entirely.
    const result: { outcome: ReconnectOutcome | null } = { outcome: null };
    const flightResult = await this.reconnectFlight.run(this.instanceId, async () => {
      const deps: ReconnectDeps = {
        endpoint: this.endpoint as CdpEndpoint,
        wsFactory: this.wsFactory,
        budget: this.reconnectBudget,
        ...(this.reconnectBackoffMs !== undefined ? { backoffMs: this.reconnectBackoffMs } : {}),
        ...(this.reconnectDialTimeoutMs !== undefined
          ? { dialTimeoutMs: this.reconnectDialTimeoutMs }
          : {}),
      };
      result.outcome = await reconnectTransport(deps);
    });

    if (flightResult === 'waited') {
      // Per `single-flight.ts`'s rule, a caller that merely waited must not
      // assume the winner's outcome as its own. There is nothing to
      // re-derive here beyond reading `this._state`, which the winner has
      // already finished updating (to 'open' or 'closed') by the time
      // `run()` resolves; this branch exists to make that explicit rather
      // than fall through and risk acting on a half-applied outcome.
      return;
    }

    if (this.closeFinalized) {
      // An explicit close() ran while this reconnect attempt was in
      // flight. The bridge is terminally closed regardless of what the
      // reconnect found; if it actually found a live socket, close that
      // one too instead of leaving it dangling.
      if (result.outcome && result.outcome.kind === 'reconnected') {
        result.outcome.socket.close(1000, 'bridge closed during reconnect');
      }
      return;
    }

    if (result.outcome && result.outcome.kind === 'reconnected') {
      this.adoptReconnectedSocket(result.outcome.socket);
      // Only now. The browser is alive and every session id minted before
      // the drop is stale, which is precisely what a detach means.
      this.announceSessionsDetached(detachedSessions);
    } else {
      this.emitBridge('bridge.error', new Error('CDP reconnect budget exhausted; giving up'));
      this.finalizeClose(ev);
    }
  }

  /** Wires a freshly reconnected socket in as `this.ws` and returns the bridge to `'open'`. Deliberately does NOT reset `reconnectBudget`: see `./reconnect.ts`'s module doc, point 1, a flapping-but-recovering connection must still exhaust the same ten minute budget as a flapping-and-failing one. */
  private adoptReconnectedSocket(socket: CdpWebSocketLike): void {
    this.ws = socket;
    socket.onmessage = (msgEv) => this.handleMessage(msgEv.data);
    socket.onclose = (closeEv) => this.handleSocketClose(closeEv);
    socket.onerror = (err) =>
      this.emitBridge(
        'bridge.error',
        err instanceof Error ? err : new Error('CDP transport error'),
      );
    this._state = 'open';
    this.emitBridge('bridge.open');
  }

  /** Rejects every currently in-flight command with `E_CDP_CLOSED`. Shared by the unexpected-close path (which must do this immediately, reconnect or not) and `finalizeClose` (a no-op there once this has already run). */
  private rejectAllInflight(): void {
    for (const [, pending] of [...this.inflight]) {
      clearTimer(pending.timer);
      pending.reject(
        closedError({
          method: pending.method,
          sessionId: pending.sessionId,
          elapsedMs: monotonicNow() - pending.sentAt,
        }),
      );
    }
    this.inflight.clear();
  }

  /**
   * Marks every currently alive session dead, exactly as `finalizeClose`
   * always has, but ALSO synthesizes the same `Target.detachedFromTarget`
   * event delivery Chrome itself would send for a real detach, dispatched
   * to whatever is registered on `bridge.on('Target.detachedFromTarget',
   * ...)`. `TargetRegistry` is exactly such a registrant
   * (`target-registry.ts`'s `handleDetachedFromTarget`, wired via
   * `this.bridge.on('Target.detachedFromTarget', ...)` with no `sessionId`
   * filter, i.e. the browser-scoped bucket), and its own handler already
   * turns that into a `'detached'` registry event, which `Session` already
   * turns into the existing `cdp_detached` recovery signal
   * (`session.ts`'s `this.registry.on('detached', (t) =>
   * this.reportSignal(t.id, 'cdp_detached'))`). That is this module's
   * answer to "is a transport reconnect a new rung or does it feed an
   * existing signal": it feeds `cdp_detached`, through the exact event path
   * that already exists for a real Chrome-side detach, so nothing above
   * `CdpBridge` needs new wiring to learn that its session ids just went
   * stale, and the recovery ladder is not duplicated here.
   */
  private invalidateSessionsAfterTransportDrop(): {
    readonly sessionId: string;
    readonly targetId: string;
  }[] {
    const detached: { sessionId: string; targetId: string }[] = [];
    for (const handle of [...this.sessionsBySessionId.values()]) {
      if (!handle.alive) {
        continue;
      }
      detached.push({ sessionId: handle.id, targetId: handle.targetId });
      this.markSessionDead(handle, 'bridge_closed');
    }
    return detached;
  }

  /**
   * Announces the detach, and ONLY after a reconnect actually succeeded.
   *
   * The ordering is the whole point and getting it wrong broke a documented
   * invariant. `chaos-1-kill-browser` asserts that no viewer socket ever
   * closes as a side effect of the browser process dying, and it passed for
   * the life of this repo until this announcement was made unconditionally,
   * before the redial rather than after it.
   *
   * The reason is that `cdp_detached` is a PER TARGET, recoverable signal,
   * and `browser_dead` is a different one with a different rung. A dead
   * browser announced as one `cdp_detached` per target preempts the
   * `browser_dead` path with a recovery that cannot possibly work, and
   * viewers get torn down on the way. So:
   *
   *   reconnected  ->  the browser is alive and every prior session id is
   *                    stale, which is exactly what a detach means. Announce.
   *   exhausted    ->  the browser is gone. Say nothing here, let
   *                    `finalizeClose` run as it always did, and let the
   *                    layer that watches the process report `browser_dead`.
   */
  private announceSessionsDetached(
    detached: readonly { readonly sessionId: string; readonly targetId: string }[],
  ): void {
    const bucket = this.handlers.get('Target.detachedFromTarget');
    if (!bucket) return;
    for (const params of detached) {
      for (const entry of [...bucket]) {
        entry.fn(params, null);
      }
    }
  }

  private finalizeClose(info: CdpWebSocketCloseEvent): void {
    if (this.closeFinalized) {
      return;
    }
    this.closeFinalized = true;
    this._state = 'closed';

    this.rejectAllInflight();

    for (const handle of [...this.sessionsBySessionId.values()]) {
      this.markSessionDead(handle, 'bridge_closed');
    }

    this.emitBridge('bridge.close', info);
  }

  // ── stats ─────────────────────────────────────────────────────────────

  stats(): CdpBridgeStats {
    const latency: Record<string, LatencySample> = {};
    for (const [method, samples] of this.latencySamples) {
      latency[method] = percentileStats(samples);
    }
    let sessionsCount = 0;
    for (const handle of this.sessionsBySessionId.values()) {
      if (handle.alive) {
        sessionsCount += 1;
      }
    }
    return {
      sent: this.statSent,
      received: this.statReceived,
      inFlight: this.inflight.size,
      timeouts: this.statTimeouts,
      protocolErrors: this.statProtocolErrors,
      sessions: sessionsCount,
      bytesIn: this.statBytesIn,
      bytesOut: this.statBytesOut,
      latency,
    };
  }
}

function percentileStats(samples: readonly number[]): LatencySample {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, n: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
  return { p50, p95, n: samples.length };
}

/** Parses `Browser.getVersion`'s raw result into a {@link BrowserVersion}, `supports` left empty for the caller to fill in. */
function parseBrowserVersion(raw: {
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
  jsVersion: string;
}): Omit<BrowserVersion, 'supports'> {
  const match = /\/(\d+)\./.exec(raw.product);
  const major = match ? Number.parseInt(match[1] as string, 10) : 0;
  const channel = channelFromProduct(raw.product);
  return {
    protocolVersion: raw.protocolVersion,
    product: raw.product,
    channel,
    major,
    full: raw.product,
    revision: raw.revision,
    userAgent: raw.userAgent,
    jsVersion: raw.jsVersion,
  };
}

function channelFromProduct(product: string): BrowserChannelKind {
  const lower = product.toLowerCase();
  if (lower.includes('edg')) {
    return 'edge';
  }
  if (lower.includes('brave')) {
    return 'brave';
  }
  if (lower.includes('chromium')) {
    return 'chromium';
  }
  if (lower.includes('chrome')) {
    return 'chrome';
  }
  return 'unknown';
}

/** Constructs a {@link CdpBridge} for one Instance. */
export function createCdpBridge(instanceId: InstanceId, opts?: CdpBridgeOptions): CdpBridge {
  return new CdpBridgeImpl(instanceId, opts);
}

export type { AttachOptions, CdpAttachOptionsExt };
