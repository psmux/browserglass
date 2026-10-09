/**
 * `RemoteCdpClient`: a minimal CDP command client for `runtime-remote`.
 *
 * This is deliberately not `@browserglass/core`'s `CdpBridge` (see
 * `platform.ts`'s top comment on why this package keeps small local copies).
 * `RemoteCdpClient` also does not need `CdpBridge`'s full scope: no
 * per-target circuit breaker, no screencast ack rule, no auto-attach
 * discovery. `runtime-remote` is cheap (no spawn, no supervision, no
 * profile locks, no orphan scan), and needs only enough CDP
 * to fetch `/json/version`, attach to one page target, and issue a handful
 * of `Emulation.*`/`Browser.*` commands.
 */

import {
  type MinimalFetch,
  type RemoteWebSocketCloseEvent,
  type RemoteWebSocketFactory,
  type RemoteWebSocketLike,
  type TimerHandle,
  WS_READY_STATE,
  clearTimer,
  defaultWebSocketFactory,
  globalFetch,
  monotonicNow,
  scheduleTimer,
} from './platform.js';

/** The parsed, relevant subset of `GET <origin>/json/version`'s JSON body. */
export interface CdpVersionInfo {
  webSocketDebuggerUrl: string;
  browserGuid: string;
  product: string;
  protocolVersion: string;
  userAgent: string;
}

/** One entry from `Target.getTargets`, the fields this client needs. */
export interface CdpTargetInfo {
  targetId: string;
  type: string;
  attached: boolean;
}

interface Pending {
  id: number;
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: TimerHandle;
}

/**
 * The minimal command-sending surface `spec-apply.ts` needs. {@link RemoteCdpClient}
 * satisfies this structurally; tests may supply a lighter fake instead of a
 * full scripted websocket.
 */
export interface CdpCommandSender {
  sendBrowser(method: string, params?: Record<string, unknown>): Promise<unknown>;
  sendPage(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Thrown by `RemoteCdpClient` on a CDP protocol error response, a timeout, or a closed socket. */
export class RemoteCdpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteCdpError';
    this.code = code;
  }
}

/** Constructor options for {@link RemoteCdpClient}. */
export interface RemoteCdpClientOptions {
  fetchImpl?: MinimalFetch | undefined;
  wsFactory?: RemoteWebSocketFactory | undefined;
  /** Per command timeout, default 10000. */
  commandTimeoutMs?: number;
}

/**
 * A minimal, single-browser CDP client: fetches `/json/version`, opens the
 * browser level websocket, and multiplexes browser scoped and one
 * page-session scoped command stream over it. One instance talks to exactly
 * one remote browser.
 */
export class RemoteCdpClient implements CdpCommandSender {
  private readonly fetchImpl: MinimalFetch;
  private readonly wsFactory: RemoteWebSocketFactory;
  private readonly commandTimeoutMs: number;

  private ws: RemoteWebSocketLike | null = null;
  private nextId = 1;
  private readonly inflight = new Map<number, Pending>();
  private pageSessionId: string | null = null;
  private closed = false;
  private requestedClose = false;
  private readonly closeListeners = new Set<(unexpected: boolean) => void>();

  constructor(opts: RemoteCdpClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalFetch();
    this.wsFactory = opts.wsFactory ?? defaultWebSocketFactory;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 10000;
  }

  /** The page session id attached by {@link attachFirstPage}, or `null` before that call or when no page target exists. */
  get sessionId(): string | null {
    return this.pageSessionId;
  }

  /** `GET <httpOrigin>/json/version`, without opening a websocket. */
  async fetchVersion(
    httpOrigin: string,
    headers?: Record<string, string>,
  ): Promise<CdpVersionInfo> {
    const res = await this.fetchImpl(
      `${httpOrigin}/json/version`,
      headers ? { headers } : undefined,
    );
    if (!res.ok) {
      throw new RemoteCdpError(
        'E_CDP_HTTP',
        `GET ${httpOrigin}/json/version returned HTTP ${res.status}`,
      );
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const webSocketDebuggerUrl =
      typeof raw['webSocketDebuggerUrl'] === 'string' ? raw['webSocketDebuggerUrl'] : null;
    if (!webSocketDebuggerUrl) {
      throw new RemoteCdpError(
        'E_CDP_HTTP',
        `${httpOrigin}/json/version did not report a webSocketDebuggerUrl`,
      );
    }
    const match = /\/browser\/([^/]+)$/.exec(webSocketDebuggerUrl);
    const browserGuid = match ? (match[1] as string) : '';
    return {
      webSocketDebuggerUrl,
      browserGuid,
      product: typeof raw['Browser'] === 'string' ? raw['Browser'] : '',
      protocolVersion: typeof raw['Protocol-Version'] === 'string' ? raw['Protocol-Version'] : '',
      userAgent: typeof raw['User-Agent'] === 'string' ? raw['User-Agent'] : '',
    };
  }

  /** Opens the browser-level websocket at `wsUrl` (the `webSocketDebuggerUrl` `/json/version` reported) and waits for it to open. */
  async connect(wsUrl: string, headers?: Record<string, string>): Promise<void> {
    const socket = this.wsFactory(wsUrl, headers);
    this.ws = socket;
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WS_READY_STATE.OPEN) {
        resolve();
        return;
      }
      const timer = scheduleTimer(
        () => reject(new RemoteCdpError('E_CDP_TIMEOUT', `connecting to ${wsUrl} timed out`)),
        this.commandTimeoutMs,
      );
      socket.onopen = () => {
        clearTimer(timer);
        resolve();
      };
      socket.onerror = (err) => {
        clearTimer(timer);
        reject(
          err instanceof Error
            ? err
            : new RemoteCdpError('E_CDP_TRANSPORT', 'websocket error while connecting'),
        );
      };
    });
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onclose = (ev) => this.handleClose(ev);
  }

  /** Sends a browser-scoped command (no `sessionId`). */
  sendBrowser(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params, undefined);
  }

  /** Sends a command scoped to the attached page session, if any; falls back to browser scope when no page session exists. */
  sendPage(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params, this.pageSessionId ?? undefined);
  }

  /**
   * Finds one page target via `Target.getTargets` and attaches to it with
   * `flatten: true` (the same rule as `core`'s CDP layer: `flatten: false`
   * is never sent, in any path). Returns the session id, or `null` when the
   * remote browser has no page target to attach to (an emulation override
   * has nothing to apply to in that case).
   */
  async attachFirstPage(): Promise<string | null> {
    const result = (await this.sendBrowser('Target.getTargets')) as {
      targetInfos: CdpTargetInfo[];
    };
    const page = result.targetInfos.find((t) => t.type === 'page');
    if (!page) {
      return null;
    }
    const attach = (await this.sendBrowser('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.pageSessionId = attach.sessionId;
    return this.pageSessionId;
  }

  private send(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (this.closed || !this.ws) {
      return Promise.reject(
        new RemoteCdpError('E_CDP_CLOSED', `${method} rejected, the client is closed`),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = scheduleTimer(() => {
        this.inflight.delete(id);
        reject(
          new RemoteCdpError(
            'E_CDP_TIMEOUT',
            `${method} timed out after ${this.commandTimeoutMs}ms`,
          ),
        );
      }, this.commandTimeoutMs);
      this.inflight.set(id, { id, method, resolve, reject, timer });
      this.ws?.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
    });
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.id === undefined) {
      return;
    }
    const pending = this.inflight.get(msg.id);
    if (!pending) {
      return;
    }
    this.inflight.delete(msg.id);
    clearTimer(pending.timer);
    if (msg.error) {
      pending.reject(
        new RemoteCdpError('E_CDP_SERVER_ERROR', `${pending.method}: ${msg.error.message}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleClose(_ev: RemoteWebSocketCloseEvent): void {
    this.closed = true;
    for (const [id, pending] of [...this.inflight]) {
      this.inflight.delete(id);
      clearTimer(pending.timer);
      pending.reject(
        new RemoteCdpError('E_CDP_CLOSED', `${pending.method} rejected, the socket closed`),
      );
    }
    const unexpected = !this.requestedClose;
    for (const cb of [...this.closeListeners]) {
      cb(unexpected);
    }
  }

  /**
   * Registers a callback fired once, whenever the underlying websocket
   * closes, from either side. `unexpected` is `false` only when this
   * client's own `close()` requested the close; `RemoteRuntime` uses this
   * to implement `LaunchedBrowser.onUnexpectedExit`.
   */
  onClose(cb: (unexpected: boolean) => void): () => void {
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  /** True once the socket has closed, from either side. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Closes the underlying websocket. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.requestedClose = true;
    this.closed = true;
    this.ws?.close(1000, 'runtime-remote client closed');
  }

  /** Elapsed monotonic time since construction is not tracked here; exposed for callers timing their own operations. */
  static now(): number {
    return monotonicNow();
  }
}
