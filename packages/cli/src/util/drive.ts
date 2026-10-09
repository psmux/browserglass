/**
 * Shared plumbing for every `bgls` command that actually drives a browser
 * (`instances navigate/click/type/open-target/close-target/console/
 * network`, and `swarm run`). Two things every one of them needs:
 *
 * 1. A bearer token scoped to one instance. `POST /v1/instances/:id/attach`
 *    exists on paper but its `ticket` is never registered with the
 *    server's `TicketRegistry` in this build (confirmed directly by
 *    `commands/inspect.ts`'s own `followInstance`, and independently by
 *    `doctor/deep.ts`'s own `mintToken` comment); `POST /v1/tokens`, a
 *    real and separate auth path, is the one that actually works, so
 *    every driving command mints its own token through it rather than
 *    the attach ticket.
 * 2. A connected `AutomationClient` bound to that instance (and,
 *    optionally, one of its targets), reusing `@browserglass/automation`
 *    rather than reimplementing the `bgls.v1` wire protocol a second time
 *    in this package.
 *
 * `connectAutomation()` retries the connect a few times: `doctor/deep.ts`
 * documents (and this file inherits) that an instance can report
 * `state: 'ready'` from the router before the node's own CDP session
 * attachment for its targets has actually landed, so the very first
 * connect attempt against a freshly created instance can race that.
 */

import type {
  AutomationClient,
  AutomationErrorCode,
  ControlLeaseHandle,
} from '@browserglass/automation';
import {
  AutomationError,
  AutomationClient as RealAutomationClient,
} from '@browserglass/automation';
import type { WebSocketConstructorLike } from '@browserglass/client';
import type { Capability } from '@browserglass/protocol';
import type { AcquireRequest, InstanceView } from '@browserglass/router';
import type { GatewayConnection } from '../context.js';
import { compact } from './compact.js';
import { EXIT_CODES, type ExitCode } from './exit.js';
import { RestClientError, restCall } from './rest.js';

/**
 * The capability set every driving command's token asks for: enough to
 * navigate, click, type, manage tabs, capture a screenshot, and read
 * console/network diagnostics. `POST /v1/tokens` always narrows this to
 * whatever the calling principal itself actually holds (never widens it,
 * per that route's own doc comment), so asking for the full set here and
 * letting the server narrow it is simpler, and no less honest, than each
 * command hand-picking a minimal subset.
 */
export const DRIVING_CAPS: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'devtools',
  'automation',
];

/**
 * The capability set `bgls record start`/`stop` tokens ask for. Narrower
 * than {@link DRIVING_CAPS} on purpose: starting or stopping a recording
 * touches neither the control lease nor navigation, so asking for those
 * would claim more than the command actually does. `capture` AND
 * `download` TOGETHER, never either alone, mirroring
 * `@browserglass/protocol`'s `wire/messages/recording.ts` module doc:
 * `capture` is the momentary-render half every reader of a target already
 * needs, `download` is the durable-artifact half a file that outlives the
 * session needs, and a recording needs both. `POST /v1/tokens` narrows
 * this to whatever the calling principal actually holds, the same as
 * {@link DRIVING_CAPS}, so asking for the full pair here and letting the
 * server narrow it is what every other driving command already does.
 */
export const RECORDING_CAPS: readonly Capability[] = ['view', 'capture', 'download'];

/** Resolves after `ms`, `.unref()`d so a retry backoff never keeps a one-shot CLI process alive on its own. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Mints a bearer token scoped to one instance, narrowed to whatever `connection`'s own principal actually holds. */
export async function mintInstanceToken(
  connection: GatewayConnection,
  instanceId: string,
  caps: readonly Capability[] = DRIVING_CAPS,
  ttlSeconds = 300,
): Promise<string> {
  const issued = await restCall<{ readonly token: string }>(connection, 'POST', '/v1/tokens', {
    sub: 'bgls-cli',
    subKind: 'service',
    scope: { kind: 'instance', instanceId, targets: '*' },
    caps,
    ttlSeconds,
  });
  return issued.token;
}

/** Options for {@link connectAutomation}. */
export interface ConnectAutomationOptions {
  /** Bind to this target rather than the instance's active one. */
  targetId?: string;
  /** Default {@link DRIVING_CAPS}. */
  caps?: readonly Capability[];
  /** Default 6: how many connect attempts before giving up. */
  attempts?: number;
  /** Default 500ms between attempts. */
  retryDelayMs?: number;
  /** Test-only: injects a scripted `WebSocketLike` in place of the real transport, mirroring `AutomationClientOptions.transport`. */
  transport?: { WebSocketImpl?: WebSocketConstructorLike };
}

/**
 * Mints a fresh token and connects an {@link AutomationClient} to
 * `instanceId`, retrying the whole mint+connect sequence (never reusing a
 * token across attempts: `InProcessJtiCache` enforces single-use, so a
 * replayed token from a failed attempt would be rejected outright, the
 * same reason `doctor/deep.ts`'s own retry loop mints fresh every time).
 */
export async function connectAutomation(
  connection: GatewayConnection,
  instanceId: string,
  opts: ConnectAutomationOptions = {},
): Promise<AutomationClient> {
  const attempts = opts.attempts ?? 6;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleepMs(retryDelayMs);
    try {
      const token = await mintInstanceToken(connection, instanceId, opts.caps ?? DRIVING_CAPS);
      return await RealAutomationClient.connect({
        endpoint: connection.wsUrl,
        token,
        instanceId,
        ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}),
        ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Acquires the ControlLease `fn` needs on `client`'s current target, runs `fn`, and always releases afterward, success or failure. Every navigate/click/type command goes through this rather than leaving a lease held past the one action a one-shot CLI invocation exists to perform. */
export async function withLease<T>(client: AutomationClient, fn: () => Promise<T>): Promise<T> {
  const lease: ControlLeaseHandle = await client.acquireControl();
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}

/** Writes one JSON value to stdout as a single line, for JSON Lines streaming commands (`console --follow`, `network --follow`). Never touches `console.log`: that would route through whatever `NO_COLOR`/formatting `consola` applies, which is not the contract here. */
export function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Parses a `WxH` viewport flag (e.g. `1440x900`) into `BrowserSpec.viewport`'s shape. Throws a plain `Error` (the caller maps this to `EXIT_CODES.usageError`) on a malformed value, never silently falls back. */
export function parseViewport(spec: string): {
  width: number;
  height: number;
  deviceScaleFactor: number;
} {
  const m = /^(\d+)x(\d+)$/.exec(spec.trim());
  if (m === null) throw new Error(`invalid --viewport "${spec}": expected WxH, e.g. "1440x900"`);
  return { width: Number(m[1]), height: Number(m[2]), deviceScaleFactor: 1 };
}

/** Options common to `instances create` and `swarm run`'s own `acquire()`, factored out because both build the same `AcquireRequest` shape from the same flags. */
export interface AcquireFlags {
  pool?: string | undefined;
  profileKey?: string | undefined;
  headless?: boolean | undefined;
  viewport?: string | undefined;
  /** `--sticky-subject`: who this browser belongs to. See {@link buildAcquireRequest} for the two request fields it becomes and why it has to be both. */
  stickySubject?: string | undefined;
  /** `--sticky-within-ms`: how stale that browser may be and still be reattached to. Only meaningful with `stickySubject`. */
  stickyWithinMs?: number | undefined;
}

/**
 * Builds an `AcquireRequest` body from {@link AcquireFlags}, throwing
 * (unwrapped `Error`, mapped by the caller to `usageError`) on a malformed
 * `--viewport` or a `--sticky-within-ms` that is not a positive number.
 *
 * `stickySubject` sets TWO fields, and that is the whole reason this
 * mapping lives in one function rather than at each call site. `sticky
 * .subject` is the SELECTOR: it is what makes the router look for an
 * existing instance whose `subject` matches, instead of launching
 * (`packages/router/src/router/reuse.ts`, `findReusable` step 2).
 * `subject` is the TAG: `BrowserRouter.doAcquire` stores `req.subject ??
 * principal.sub` on whatever instance it creates, so without it a browser
 * launched by `--sticky-subject alice` would be filed under the CLI's own
 * token subject and the next `--sticky-subject alice` would not find it.
 * Set one without the other and the feature degrades to "always launch",
 * silently, which is exactly the defect this flag exists to remove.
 *
 * `--sticky-subject` is deliberately compatible with an ephemeral profile
 * (no `--profile-key`), which is the common case: a throwaway browser that
 * is nonetheless the SAME throwaway browser as last time. The router
 * rejects `--sticky-subject` together with `--profile-key` as
 * `E_CONFLICTING_SELECTORS`, since a persistent profile key already names
 * which instance is wanted; this function does not duplicate that check,
 * so the error text a user sees comes from the one place that owns the
 * rule.
 */
export function buildAcquireRequest(flags: AcquireFlags, requestId?: string): AcquireRequest {
  const browser = compact({
    headless:
      flags.headless === undefined
        ? undefined
        : flags.headless
          ? ('new' as const)
          : ('off' as const),
    viewport: flags.viewport !== undefined ? parseViewport(flags.viewport) : undefined,
  });
  if (
    flags.stickyWithinMs !== undefined &&
    (!Number.isFinite(flags.stickyWithinMs) || flags.stickyWithinMs <= 0)
  ) {
    throw new Error(
      `invalid --sticky-within-ms "${String(flags.stickyWithinMs)}": expected a positive number of milliseconds`,
    );
  }
  if (flags.stickyWithinMs !== undefined && flags.stickySubject === undefined) {
    throw new Error(
      '--sticky-within-ms needs --sticky-subject: a window is only meaningful once there is a subject to reattach to',
    );
  }
  // Spelled out rather than run through `compact()`: `sticky.subject` is
  // required once `sticky` exists at all, and `compact()`'s return type is
  // `Partial<T>`, which under `exactOptionalPropertyTypes` cannot satisfy
  // a required field.
  const sticky: AcquireRequest['sticky'] =
    flags.stickySubject === undefined
      ? undefined
      : flags.stickyWithinMs === undefined
        ? { subject: flags.stickySubject }
        : { subject: flags.stickySubject, withinMs: flags.stickyWithinMs };
  return compact({
    requestId,
    pool: flags.pool,
    profile:
      flags.profileKey !== undefined
        ? { mode: 'persistent' as const, key: flags.profileKey }
        : undefined,
    browser: Object.keys(browser).length > 0 ? browser : undefined,
    sticky,
    subject: flags.stickySubject,
  });
}

/**
 * The two affinity flags, declared once and spread into every command that
 * acquires a browser (`instances create`, `swarm run`), so the flag names,
 * and more importantly the wording of what they do, cannot drift apart
 * between commands. `citty` types every flag as a string here;
 * {@link parseAffinityArgs} does the number conversion.
 */
export const AFFINITY_ARGS = {
  'sticky-subject': {
    type: 'string' as const,
    description:
      'Who this browser belongs to, e.g. a user id or a job name. Omit and a new browser is launched every time. Give the same value again and the browser from last time is reattached to instead, launching only if there is none.',
  },
  'sticky-within-ms': {
    type: 'string' as const,
    description:
      'With --sticky-subject: how stale that browser may be, in milliseconds, and still be reattached to. Omit for no window.',
  },
};

/** Reads {@link AFFINITY_ARGS} off a parsed `citty` args object into the matching {@link AcquireFlags} fields. Throws (mapped by the caller to `usageError`) on a `--sticky-within-ms` that is not a number at all; `buildAcquireRequest` owns the range check. */
export function parseAffinityArgs(
  args: Record<string, unknown>,
): Pick<AcquireFlags, 'stickySubject' | 'stickyWithinMs'> {
  const raw = args['sticky-within-ms'] as string | undefined;
  if (raw !== undefined && Number.isNaN(Number(raw))) {
    throw new Error(
      `invalid --sticky-within-ms "${raw}": expected a positive number of milliseconds`,
    );
  }
  return {
    stickySubject: args['sticky-subject'] as string | undefined,
    stickyWithinMs: raw !== undefined ? Number(raw) : undefined,
  };
}

/** Terminal instance states `waitForInstanceReady()` stops polling on: `ready` is success, the rest mean this instance will never become drivable. */
const TERMINAL_INSTANCE_STATES = new Set(['ready', 'degraded', 'failed', 'released', 'releasing']);

/**
 * Polls `GET /v1/instances/:id` until the instance reaches `ready` (or
 * another terminal state, or `timeoutMs` elapses), returning the last
 * view seen. A freshly acquired instance is not drivable the instant
 * `POST /v1/instances` returns: placement and launch both happen after
 * that response, per `AcquireResult.state`'s own `'requested' | 'placing'
 * | 'launching' | ...` progression, so every driving command that just
 * created its own instance polls this before minting a token against it.
 */
export async function waitForInstanceReady(
  connection: GatewayConnection,
  instanceId: string,
  timeoutMs = 20_000,
  pollMs = 500,
): Promise<InstanceView> {
  const deadline = Date.now() + timeoutMs;
  let last: InstanceView = await restCall<InstanceView>(
    connection,
    'GET',
    `/v1/instances/${instanceId}`,
  );
  while (
    last.instance.state !== 'ready' &&
    !TERMINAL_INSTANCE_STATES.has(last.instance.state) &&
    Date.now() < deadline
  ) {
    await sleepMs(pollMs);
    last = await restCall<InstanceView>(connection, 'GET', `/v1/instances/${instanceId}`);
  }
  return last;
}

/**
 * Maps whatever a driving command caught (a `RestClientError`, an
 * `AutomationError`, or anything else) onto the narrowest `EXIT_CODES`
 * entry that applies, per `util/exit.ts`'s own doc comment on `4` to `6`.
 * Every `instances *`/`swarm run` command's `catch` block goes through
 * this, so a script gets the same exit code for "instance not found"
 * regardless of which command hit it.
 */
export function mapDriveErrorToExitCode(err: unknown): ExitCode {
  if (err instanceof RestClientError) {
    if (err.status === 404) return EXIT_CODES.notFound;
    if (err.status === 403 || err.status === 401) return EXIT_CODES.policyDenied;
    return EXIT_CODES.operationalFailure;
  }
  if (err instanceof AutomationError) {
    const code: AutomationErrorCode = err.code;
    if (code === 'NOT_FOUND' || code === 'TARGET_CLOSED' || code === 'INSTANCE_GONE')
      return EXIT_CODES.notFound;
    if (
      code === 'POLICY_DENIED' ||
      code === 'LEASE_NOT_HELD' ||
      code === 'LEASE_REVOKED' ||
      code === 'CONFIRM_DENIED'
    )
      return EXIT_CODES.policyDenied;
    if (code === 'TIMEOUT') return EXIT_CODES.timeout;
    return EXIT_CODES.operationalFailure;
  }
  return EXIT_CODES.operationalFailure;
}

/** Formats any caught value as a one-line message, the same fallback every command's `catch` block uses before calling `printer.error()`. */
export function errorMessage(err: unknown): string {
  if (err instanceof RestClientError) return `${err.code}: ${err.message}`;
  if (err instanceof AutomationError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
