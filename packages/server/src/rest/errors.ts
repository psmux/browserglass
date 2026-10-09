import type { ServerResponse } from 'node:http';
import type { Store } from '@browserglass/protocol';
import { compact } from '../util/compact.js';
import { redactServerPaths } from '../wire/sanitize.js';
import type { RestContext } from './types.js';

/** The one error envelope shape every REST response uses. */
export interface RestErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
  };
}

/** Thrown by REST route handlers. Carries everything `writeError` needs. */
export class RestError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    httpStatus: number,
    code: string,
    message: string,
    opts?: {
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.name = 'RestError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable =
      opts?.retryable ?? (httpStatus >= 500 || httpStatus === 429 || httpStatus === 503);
    this.retryAfterMs = opts?.retryAfterMs;
    this.details = opts?.details;
  }
}

/** Writes `error` as a JSON body with the standard envelope, plus `X-Bgls-Request-Id`. */
export function writeError(res: ServerResponse, requestId: string, err: RestError): void {
  const body: RestErrorBody = {
    error: compact({
      code: err.code,
      // Some routes build a RestError from a caught error's message; a
      // Node fs error's message carries an absolute server path.
      message: redactServerPaths(err.message),
      retryable: err.retryable,
      retryAfterMs: err.retryAfterMs,
      details: err.details,
      requestId,
    }),
  };
  res.setHeader('X-Bgls-Request-Id', requestId);
  res.writeHead(err.httpStatus, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Writes `value` as a JSON 200 (or `status`) body, plus `X-Bgls-Request-Id`. */
export function writeJson(
  res: ServerResponse,
  requestId: string,
  value: unknown,
  status = 200,
): void {
  res.setHeader('X-Bgls-Request-Id', requestId);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

/**
 * `ctx.getRouter()`, or a 503 naming exactly why a driving/instance route
 * cannot proceed: `mode: 'gateway'` with no control plane connection
 * leaves `wiring` (and therefore `router`) unresolved. Shared by
 * `routes/instances.ts` and `routes/targets.ts`: both need the same guard
 * now that `targets.ts`'s driving verbs resolve through the router's
 * `driveInstance` gate instead of reading `ctx.store` directly (see that
 * file's own module doc for why the direct store read was wrong).
 */
export function requireRouter(ctx: RestContext): NonNullable<ReturnType<RestContext['getRouter']>> {
  const router = ctx.getRouter();
  if (router === undefined) {
    throw new RestError(
      503,
      'E_ROUTER_UNAVAILABLE',
      'This gateway has no local router (mode is "gateway" without a control plane connection).',
    );
  }
  return router;
}

/**
 * `ctx.store`, or a 503 naming exactly why a store-backed route cannot
 * proceed: `RestContext.store` is optional for the same reason
 * `RestContext.driver`/`.cdp` are (a hand built `RestContext`, this
 * package's own tests, may omit it), and `createBrowserGlass` always wires
 * one. `routes/inventory.ts`'s `getInstanceHistory` is the one caller that
 * needs `Store.getInstance`/`Store.queryAudit` directly rather than
 * through `BrowserRouter`: a released instance can be readable here long
 * after `router.describe()` would answer `E_INSTANCE_GONE`, since the
 * `instances` row survives release "for the usage and audit window, then
 * deleted" (`store-sqlite/migrations/0001_initial.sql`'s own comment on
 * the table), which is exactly the point of a history route.
 */
export function requireStore(ctx: RestContext): Store {
  if (ctx.store === undefined) {
    throw new RestError(
      503,
      'E_STORE_UNAVAILABLE',
      'This gateway has no store wired (RestContext.store is unset).',
    );
  }
  return ctx.store;
}

/**
 * Which config knob actually governs each `admit()` scope
 * (`packages/router/src/admission/admit.ts`'s `checks` array: `tenant` ->
 * `limits.maxInstances`, `app` -> `limits.maxInstancesPerApp`, `pool` ->
 * `poolLimits.maxInstances`, `user` -> `poolLimits.maxInstancesPerUser`),
 * and how an operator actually raises it. Used only to enrich
 * `E_QUOTA_INSTANCES`'s message, so a caller who was just refused does not
 * have to go spelunking through `admit.ts` and `resolve.ts` to learn what
 * to change.
 *
 * `tenant` and `app` share one answer because this build's
 * `quotaProviderFromLimits` (`packages/server/src/lifecycle/wiring.ts`)
 * gives one app the same ceiling as its tenant: both read
 * `ResolvedConfig.limits.maxInstances`, raised via `BGLS_MAX_INSTANCES`.
 * `pool` and `user` have no environment variable at all: both come from
 * the pool's own `PoolLimits`
 * (`pool.limits.maxInstances`/`.maxInstancesPerUser`), set when the pool
 * is created or updated, not from a gateway-wide env var. Naming a
 * nonexistent env var for those two would be a worse answer than naming
 * the real knob.
 */
const QUOTA_SCOPE_GUIDANCE: Readonly<Record<'tenant' | 'app' | 'pool' | 'user', string>> =
  Object.freeze({
    tenant: 'limits.maxInstances (env BGLS_MAX_INSTANCES)',
    app: 'limits.maxInstances (env BGLS_MAX_INSTANCES; this build gives one app the same ceiling as its tenant)',
    pool: "this pool's own maxInstances, set when the pool is created or updated",
    user: "this pool's own maxInstancesPerUser, set when the pool is created or updated",
  });

/** Appends {@link QUOTA_SCOPE_GUIDANCE} to an `E_QUOTA_INSTANCES` message when `context.scope` names one of the four scopes `admit()` checks; returns `message` unchanged otherwise (an unrecognised or absent scope is a signal something upstream changed shape, not a reason to guess). */
function enrichQuotaMessage(message: string, context: Record<string, unknown> | undefined): string {
  const scope = context?.['scope'];
  if (scope !== 'tenant' && scope !== 'app' && scope !== 'pool' && scope !== 'user') return message;
  return `${message}. Raise ${QUOTA_SCOPE_GUIDANCE[scope]}.`;
}

/**
 * Turns a `BrowserRouter`-thrown `RouterError` (`httpStatus`/`code`/`message`,
 * optionally `retryAfterMs`/`context`) into the matching `RestError`, so
 * `driveInstance`'s honest `E_INSTANCE_NOT_FOUND` (404), `E_INSTANCE_GONE`
 * (410), `E_INSTANCE_NOT_READY` (409, retryable) and `dispatchAction`'s
 * `E_NODE_LOST` (503, retryable, the "owning node unreachable" case) all
 * reach the wire unchanged rather than flattened to a generic 500. Never
 * returns: rethrows `err` itself when it is not a `RouterError`-shaped
 * object, so a genuine bug does not get silently reported as a 500 with no
 * stack.
 *
 * `E_QUOTA_INSTANCES` is the one code whose message is enriched rather
 * than passed through verbatim: {@link enrichQuotaMessage} appends which
 * config field bound and how to raise it, so a swarm that just got
 * refused learns the answer from the error itself instead of reading
 * `admit.ts`.
 */
export function mapRouterError(err: unknown): never {
  if (err !== null && typeof err === 'object' && 'httpStatus' in err && 'code' in err) {
    const e = err as {
      httpStatus: number;
      code: string;
      message: string;
      retryAfterMs?: number;
      context?: Record<string, unknown>;
    };
    const message =
      e.code === 'E_QUOTA_INSTANCES' ? enrichQuotaMessage(e.message, e.context) : e.message;
    throw new RestError(
      e.httpStatus,
      e.code,
      message,
      compact({ retryAfterMs: e.retryAfterMs, details: e.context }),
    );
  }
  throw err;
}

/** The 501 body every stubbed route in the "everything else" set returns, naming which build this is. */
export function notImplementedBody(
  routeName: string,
): RestErrorBody['error'] & { readonly build: string } {
  return {
    code: 'E_NOT_IMPLEMENTED',
    message: `${routeName} is registered but not implemented in this build of @browserglass/server.`,
    retryable: false,
    requestId: '',
    build: 'rest-stub',
  };
}
