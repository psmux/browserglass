import type { WebSocketConstructorLike } from '@browserglass/client';
import { type Capability, ROLE_BUNDLES } from '@browserglass/protocol';
import { AutomationError } from './errors.js';
import type { ActionRecord, YieldPolicy } from './types.js';

/**
 * The REST half of `AutomationClient.launch()`: start a browser on a
 * running gateway, wait for it, get a socket ticket for it, and end it
 * again. Kept apart from `AutomationClient` so it can be tested with a
 * stubbed `fetch` and no socket at all.
 *
 * The flow is the one every hand written script used to carry:
 *
 *  1. `POST /v1/instances` with a fresh `requestId` (the gateway dedupes a
 *     repeated id for five minutes and would hand back the same browser).
 *  2. `GET /v1/instances/:id` until `state` is `ready`. An acquire can
 *     answer `launching` or `queued` before Chrome is up.
 *  3. `POST /v1/instances/:id/attach` with the caps we want. The ticket
 *     the acquire itself returns carries every cap the admin token holds
 *     (for a `bgls token` token that is the whole `owner` bundle, `admin`
 *     included), so we ask for a narrowed one instead. The attach route
 *     only ever narrows: a cap the admin token lacks is silently dropped,
 *     never added.
 *  4. On release, `DELETE /v1/instances/:id?force=true` (without `force`
 *     for a shareable launch, see `LaunchedInstance.release`), retried on
 *     `E_TERMINATE_FAILED` (Windows sometimes answers that once and then
 *     succeeds) and treated as done on a 404.
 *
 * The admin token is only ever sent as a header. It never appears in an
 * error message, a log line, or anything this module returns.
 */

/** Where `launch()` looks when no `gateway` is passed and `BGLS_URL` is unset. */
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7799/browserglass';

/**
 * The caps `launch()` asks for when the caller passes none: the `agent`
 * role bundle, which is every capability that means "operate this one
 * browser" (`evaluate`, `capture`, `devtools`, `intercept`, `download`,
 * `cdp`, `instance.restart` and the rest) and none of the fleet management
 * ones. With these every `AutomationClient` method works, including the
 * selector verbs, which need `evaluate`.
 */
export const DEFAULT_LAUNCH_CAPS: readonly Capability[] = ROLE_BUNDLES.agent;

/** Options for `AutomationClient.launch()`. Every field is optional. */
export interface LaunchOptions {
  /** Gateway base URL. Default `process.env.BGLS_URL`, then `http://127.0.0.1:7799/browserglass`. */
  gateway?: string;
  /** Admin bearer token for the REST calls. Default `process.env.BGLS_ADMIN_TOKEN`. Get one with `pnpm bgls token` where `bgls serve` runs. */
  adminToken?: string;
  /** Default `true` (Chrome's new headless mode). `false` opens a visible window. */
  headless?: boolean;
  /** Page viewport. `deviceScaleFactor` defaults to 1. */
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  /** Use a persistent profile with this key, so cookies and storage survive a release. Omit for a throwaway profile deleted on release. */
  profileKey?: string;
  /** Caps the socket ticket asks for. Default {@link DEFAULT_LAUNCH_CAPS}. Narrow only: a cap the admin token lacks is dropped. */
  caps?: readonly Capability[];
  /**
   * Acquire the control lease right after connecting, so the first
   * `navigate()` or `click()` just works. Default `true`. Pass `false` when
   * the client should watch rather than drive, or when you want to call
   * `acquireControl()` yourself with your own options.
   */
  control?: boolean;
  /** How long to wait for the browser to reach `ready`. Default 60000. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for `ready`. Default 250. */
  pollIntervalMs?: number;
  /** Extra `BrowserSpec` fields merged into the acquire's `browser` object (`locale`, `userAgent`, `isolation`, ...). `headless` and `viewport` above win over the same keys here. */
  browser?: Record<string, unknown>;
  /** Affinity subject. Tags the instance and asks for the one this subject had last time (`sticky.subject`), launching only if there is none. */
  subject?: string;
  /** With `subject`: how stale a previous browser may be and still be reattached to. */
  stickyWithinMs?: number;
  /** Passed to `AutomationClient.connect()`. */
  defaultTimeoutMs?: number;
  /** Passed to `AutomationClient.connect()`. */
  stepBudget?: number;
  /** Passed to `AutomationClient.connect()`. */
  yieldPolicy?: YieldPolicy;
  /** Passed to `AutomationClient.connect()`. */
  onAction?: (rec: ActionRecord) => void;
  /** Passed to `AutomationClient.connect()`. Test injection point for a scripted socket. */
  transport?: { WebSocketImpl?: WebSocketConstructorLike };
  /** Test injection point. Default the global `fetch`. */
  fetch?: typeof fetch;
}

/** What {@link launchInstance} hands back: enough to connect, and a way to end the browser. */
export interface LaunchedInstance {
  readonly instanceId: string;
  readonly wsUrl: string;
  readonly ticket: string;
  /**
   * Ends the browser. A throwaway launch (no `profileKey`, no `subject`)
   * ends it with `force=true`. A launch that other callers can share, by
   * profile key or by subject, releases without force, so the gateway
   * ends the browser only when this was the last viewer on it and
   * otherwise just detaches. Retries `E_TERMINATE_FAILED`; a 404 counts
   * as done.
   */
  release(): Promise<void>;
}

const TOKEN_HELP =
  'Get one by running `pnpm bgls token` in the directory where `bgls serve` runs, then pass it as `adminToken` or set BGLS_ADMIN_TOKEN.';

let launchCounter = 0;

/** A `requestId` nothing else will ever send. The gateway dedupes a repeat for five minutes. */
function freshRequestId(): string {
  launchCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `launch-${process.pid}-${Date.now()}-${launchCounter}-${rand}`;
}

function resolveGateway(opts: LaunchOptions): string {
  const raw = opts.gateway ?? process.env['BGLS_URL'] ?? DEFAULT_GATEWAY_URL;
  return raw.replace(/\/+$/, '');
}

function resolveToken(opts: LaunchOptions): string {
  const token = opts.adminToken ?? process.env['BGLS_ADMIN_TOKEN'];
  if (token === undefined || token.trim() === '') {
    throw new AutomationError(
      'UNAUTHENTICATED',
      `AutomationClient.launch(): no admin token. ${TOKEN_HELP}`,
    );
  }
  return token.trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RestFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** One REST call. Throws an `AutomationError` on a non 2xx answer; the token never lands in the message. */
class Rest {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new AutomationError(
        'GATEWAY_ERROR',
        `${method} ${this.base}${path} failed: ${err instanceof Error ? err.message : String(err)}. Is \`bgls serve\` running there?`,
        { method, path },
      );
    }
    const text = await res.text();
    if (!res.ok) throw toError(method, path, parseFailure(res.status, text));
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function parseFailure(status: number, text: string): RestFailure {
  let code = 'E_UNKNOWN';
  let message = text.slice(0, 300) || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (typeof parsed.error?.code === 'string') code = parsed.error.code;
    if (typeof parsed.error?.message === 'string') message = parsed.error.message;
  } catch {
    // not JSON; keep the raw text
  }
  return { status, code, message };
}

function toError(method: string, path: string, f: RestFailure): AutomationError {
  const details = { status: f.status, gatewayCode: f.code, method, path };
  if (f.status === 401) {
    const why =
      f.code === 'E_TOKEN_EXPIRED'
        ? 'The admin token has expired (they last 10 minutes by default).'
        : `The gateway refused the admin token (${f.code}).`;
    return new AutomationError('UNAUTHENTICATED', `${why} ${TOKEN_HELP}`, details);
  }
  if (f.status === 403) {
    return new AutomationError(
      'POLICY_DENIED',
      `${method} ${path}: the admin token lacks the capability for this call (${f.code}: ${f.message}). ${TOKEN_HELP}`,
      details,
    );
  }
  return new AutomationError(
    'GATEWAY_ERROR',
    `${method} ${path} -> HTTP ${f.status} ${f.code}: ${f.message}`,
    details,
  );
}

interface AcquireReply {
  readonly instanceId: string;
  readonly state: string;
}

interface DescribeReply {
  readonly instance?: { readonly state?: string; readonly stateReason?: string | null };
}

interface AttachReply {
  readonly attach: { readonly wsUrl: string; readonly ticket: string };
}

/** Starts a browser, waits for it, mints a narrowed socket ticket. Ends the browser again if any step after the acquire fails. */
export async function launchInstance(opts: LaunchOptions = {}): Promise<LaunchedInstance> {
  const token = resolveToken(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const rest = new Rest(resolveGateway(opts), token, fetchImpl);
  const caps = opts.caps ?? DEFAULT_LAUNCH_CAPS;
  if (caps.length === 0) {
    throw new AutomationError('INVALID_ARGUMENT', 'AutomationClient.launch(): caps is empty');
  }

  const browser: Record<string, unknown> = {
    ...(opts.browser ?? {}),
    headless: opts.headless === false ? 'off' : 'new',
    ...(opts.viewport !== undefined
      ? {
          viewport: {
            width: opts.viewport.width,
            height: opts.viewport.height,
            deviceScaleFactor: opts.viewport.deviceScaleFactor ?? 1,
          },
        }
      : {}),
  };
  const created = await rest.call<AcquireReply>('POST', '/v1/instances', {
    requestId: freshRequestId(),
    browser,
    ...(opts.profileKey !== undefined
      ? { profile: { mode: 'persistent', key: opts.profileKey } }
      : {}),
    ...(opts.subject !== undefined
      ? {
          subject: opts.subject,
          sticky: {
            subject: opts.subject,
            ...(opts.stickyWithinMs !== undefined ? { withinMs: opts.stickyWithinMs } : {}),
          },
        }
      : {}),
  });
  const instanceId = created.instanceId;
  // A second launch of the same profile key or subject gets the SAME
  // running browser back. Forcing the release would end it under every
  // other client still using it, so a shareable launch leaves the call to
  // the gateway's viewer count instead.
  const shareable = opts.profileKey !== undefined || opts.subject !== undefined;
  const release = () => releaseInstance(rest, instanceId, !shareable);

  try {
    await waitForReady(rest, instanceId, created.state, opts);
    const attached = await rest.call<AttachReply>(
      'POST',
      `/v1/instances/${encodeURIComponent(instanceId)}/attach`,
      { capabilities: [...caps], ticketTtlMs: 300_000 },
    );
    return { instanceId, wsUrl: attached.attach.wsUrl, ticket: attached.attach.ticket, release };
  } catch (err) {
    await release().catch(() => {});
    throw err;
  }
}

async function waitForReady(
  rest: Rest,
  instanceId: string,
  initial: string,
  opts: LaunchOptions,
): Promise<void> {
  const timeoutMs = opts.readyTimeoutMs ?? 60_000;
  const interval = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let state = initial;
  for (;;) {
    if (state === 'ready' || state === 'degraded') return;
    if (state === 'failed' || state === 'released' || state === 'releasing') {
      throw new AutomationError(
        'INSTANCE_GONE',
        `browser ${instanceId} ended up '${state}' before it was ready`,
        { instanceId, state },
      );
    }
    if (Date.now() >= deadline) {
      throw new AutomationError(
        'TIMEOUT',
        `browser ${instanceId} was still '${state}' after ${timeoutMs}ms; raise readyTimeoutMs or check the gateway's log`,
        { instanceId, state, timeoutMs },
      );
    }
    await sleep(interval);
    const view = await rest.call<DescribeReply>(
      'GET',
      `/v1/instances/${encodeURIComponent(instanceId)}`,
    );
    state = view.instance?.state ?? 'unknown';
  }
}

/** How many times a release is tried before giving up, and the pause between tries. */
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 1000;

async function releaseInstance(rest: Rest, instanceId: string, force: boolean): Promise<void> {
  const path = `/v1/instances/${encodeURIComponent(instanceId)}${force ? '?force=true' : ''}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await rest.call('DELETE', path);
      return;
    } catch (err) {
      const gatewayCode =
        err instanceof AutomationError ? (err.details?.['gatewayCode'] as string) : undefined;
      const status = err instanceof AutomationError ? err.details?.['status'] : undefined;
      // Already gone is what we wanted.
      if (status === 404 || gatewayCode === 'E_INSTANCE_GONE') return;
      const retryable =
        gatewayCode === 'E_TERMINATE_FAILED' ||
        (err instanceof AutomationError && err.code === 'GATEWAY_ERROR' && status === undefined);
      if (!retryable || attempt >= RELEASE_ATTEMPTS) throw err;
      await sleep(RELEASE_RETRY_MS);
    }
  }
}
