import type { IncomingMessage } from 'node:http';
import type { Instance, InstanceLifecycleState, ProfileAction } from '@browserglass/protocol';
import type {
  AcquireHandle,
  AcquireRequest,
  AcquireResult,
  AttachRequest,
  AttachResult,
  InstanceListFilter,
} from '@browserglass/router';
import type {
  InstanceLaunchedEvent,
  InstanceReleasedEvent,
  QuotaExceededEvent,
} from '../../hooks/types.js';
import { compact } from '../../util/compact.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { RestError, mapRouterError, requireRouter, writeJson } from '../errors.js';
import { redactInstanceView } from '../redact.js';
import type { RestContext, RestHandler, RestRequestContext } from '../types.js';

/**
 * The four scopes `router.admit()` checks (`packages/router/src/admission/admit.ts`),
 * to the string name of the config field each one reads, exactly matching
 * that function's own `checks` array (`{scope:'tenant', limit:
 * limits.maxInstances}`, `{scope:'app', limit: limits.maxInstancesPerApp}`,
 * `{scope:'pool', limit: poolLimits.maxInstances}`, `{scope:'user', limit:
 * poolLimits.maxInstancesPerUser}`). `admit()` itself only ever returns the
 * NUMBER a scope breached, never which config field it came from, so this
 * table is what lets `onQuotaExceeded`'s `limit: string` name one.
 */
const QUOTA_LIMIT_NAME: Readonly<Record<'tenant' | 'app' | 'pool' | 'user', string>> =
  Object.freeze({
    tenant: 'maxInstances',
    app: 'maxInstancesPerApp',
    pool: 'maxInstances',
    user: 'maxInstancesPerUser',
  });

/**
 * Fires `onInstanceLaunched` after the REST response is already on the
 * wire, never before: this hook is non-vetoing
 * (`HOOK_TIMEOUTS.onInstanceLaunched`, `hooks/types.ts`), so there is
 * nothing for a caller to wait on, and this method does its own
 * `router.describe()` read to recover `Instance.poolId`/`.subject`/`.metadata`,
 * none of which `AcquireResult` itself carries (`packages/router/src/router/types.ts`'s
 * own shape has `node`/`profile`/`reused`/`timings`/`effectiveSpec`, but no
 * `poolId` and no `metadata`). Making the caller wait on a second store
 * read for a hook nobody may have registered would be a real latency cost
 * on every `acquire()`; firing after the response is already written pays
 * it only in the background, and `HookRegistry.dispatch` itself
 * short-circuits to nothing at all when `onInstanceLaunched` has no
 * handlers (`hooks/dispatch.ts`'s `dispatch`, first line).
 *
 * For `state: 'queued'`, `handle.result` is not yet the launched instance;
 * this awaits `handle.ready` first, which resolves once placement actually
 * completes (`AcquireHandle`'s own doc, `router/types.ts`). A request that
 * never leaves the queue (the process shuts down, the caller's `acquire`
 * itself already returned and nothing else is watching `ready`) simply
 * never fires this hook, which is correct: no instance was ever launched.
 */
function fireInstanceLaunched(
  ctx: RestContext,
  rctx: RestRequestContext,
  router: ReturnType<typeof requireRouter>,
  handle: AcquireHandle,
): void {
  void (async () => {
    try {
      const result = handle.result.state === 'queued' ? await handle.ready : handle.result;
      // `result.instanceId` is `InstanceId | null` on `AcquireResult`
      // (`null` names a still-queued ticket, `packages/router/src/router/types.ts`),
      // but both branches above only ever produce an already-launched
      // result: `handle.result` here is the non-queued case, and
      // `handle.ready` resolves exclusively with `placeAndLaunch`'s
      // output, never a queued one (`BrowserRouter.settleReady` is only
      // ever called with a launched result or an error). Checked instead
      // of asserted so a future change that makes this untrue fails here
      // rather than silently firing the hook with a bogus instance id.
      if (result.instanceId === null) return;
      const instanceId = result.instanceId;
      const view = await router.describe(instanceId, rctx.principal);
      const instance = view.instance;
      const event: InstanceLaunchedEvent = {
        at: Date.now(),
        tenantId: rctx.principal.tenantId,
        appId: rctx.principal.appId,
        requestId: rctx.requestId,
        instanceId,
        sessionId: result.sessionId,
        nodeId: result.node.nodeId,
        poolId: instance.poolId,
        subject: instance.subject ?? rctx.principal.sub,
        spec: result.effectiveSpec,
        profile: {
          profileId: result.profile.profileId,
          key: result.profile.key,
          mode: result.profile.mode,
          created: result.profile.created,
        },
        reused: result.reused,
        timings: {
          profileMs: result.timings.profileMs,
          launchMs: result.timings.launchMs,
          totalMs: result.timings.totalMs,
        },
        metadata: instance.metadata,
      };
      await ctx.hooks.dispatch('onInstanceLaunched', event);
    } catch (err) {
      ctx.logger?.error(
        {
          component: 'server',
          instanceId: handle.result.instanceId,
          error: err instanceof Error ? err.message : String(err),
        },
        'onInstanceLaunched dispatch failed',
      );
    }
  })();
}

/**
 * Fires `onQuotaExceeded` for the one quota rejection this route can
 * actually observe: `E_QUOTA_INSTANCES` thrown by `doAcquire`'s admission
 * check (`BrowserRouter.ts`) when `onFull` resolves to `'reject'`. The
 * other two `AdmissionVerdict` kinds, `'queue'` and `'evict'`, never throw
 * here at all: a queued request returns a normal `202` `AcquireResult`
 * with `state: 'queued'`, and an evicted request retries `placeAndLaunch`
 * transparently. `action` is therefore always `'rejected'` from this call
 * site; `'queued'`/`'evicted'` are declared on the event type for a future
 * caller closer to the router (out of `packages/server`'s scope for this
 * pass) that can actually observe them.
 */
function fireQuotaExceeded(
  ctx: RestContext,
  rctx: RestRequestContext,
  err: unknown,
  body: AcquireRequest,
): void {
  if (
    err === null ||
    typeof err !== 'object' ||
    !('code' in err) ||
    (err as { code: unknown }).code !== 'E_QUOTA_INSTANCES'
  )
    return;
  const context = (err as { context?: Record<string, unknown> }).context ?? {};
  const scope = context['scope'];
  if (scope !== 'tenant' && scope !== 'app' && scope !== 'pool' && scope !== 'user') return;
  const event: QuotaExceededEvent = {
    at: Date.now(),
    tenantId: rctx.principal.tenantId,
    appId: rctx.principal.appId,
    requestId: rctx.requestId,
    scope: scope === 'user' ? 'subject' : scope,
    limit: QUOTA_LIMIT_NAME[scope],
    limitValue: typeof context['limit'] === 'number' ? context['limit'] : 0,
    current: typeof context['current'] === 'number' ? context['current'] : 0,
    subject: body.subject ?? rctx.principal.sub,
    action: 'rejected',
  };
  void ctx.hooks.dispatch('onQuotaExceeded', event).catch((dispatchErr: unknown) => {
    ctx.logger?.error(
      {
        component: 'server',
        error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      },
      'onQuotaExceeded dispatch failed',
    );
  });
}

/**
 * Fires `onInstanceReleased` after the REST response is already on the
 * wire, for the same non-vetoing/background-cost reason
 * {@link fireInstanceLaunched} does. `profileBytes`, `viewerSeconds`,
 * `framesSent` and `bytesSent` are honestly reported as `null`/`0`: none
 * of the four is tracked anywhere this REST route can reach without a new
 * dependency on `SessionRegistry` (the cumulative frame/byte counters live
 * on `ManagedSession`'s per-target `Attachment`s, `session/managed-session.ts`,
 * and `RestContext` carries no session registry today, only the narrower
 * `RestSessionDriver`/`RestCdpSender` ports, `rest/types.ts`). Wiring that
 * up is a real, separate change; reporting a fabricated non-zero number
 * here would be worse than the honest gap.
 */
function fireInstanceReleased(
  ctx: RestContext,
  rctx: RestRequestContext,
  before: Instance,
  reason: string | undefined,
  profile: ProfileAction | undefined,
): void {
  void (async () => {
    try {
      const event: InstanceReleasedEvent = {
        at: Date.now(),
        tenantId: rctx.principal.tenantId,
        appId: rctx.principal.appId,
        requestId: rctx.requestId,
        instanceId: before.id,
        sessionId: before.sessionId ?? '',
        reason: reason ?? 'released',
        durationMs: Date.now() - before.acquiredAt,
        profileAction: profile ?? 'keep',
        profileBytes: null,
        viewerSeconds: 0,
        framesSent: 0,
        bytesSent: 0,
      };
      await ctx.hooks.dispatch('onInstanceReleased', event);
    } catch (err) {
      ctx.logger?.error(
        {
          component: 'server',
          instanceId: before.id,
          error: err instanceof Error ? err.message : String(err),
        },
        'onInstanceReleased dispatch failed',
      );
    }
  })();
}

const INSTANCE_STATES: ReadonlySet<InstanceLifecycleState> = new Set([
  'requested',
  'placing',
  'launching',
  'ready',
  'degraded',
  'recovering',
  'draining',
  'releasing',
  'released',
  'failed',
]);

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RestError(400, 'E_MISSING_PARAM', `${name} is required.`);
  return value;
}

/**
 * Checks the affinity selector on an `AcquireRequest` body before it
 * reaches the router.
 *
 * `sticky.subject` is how a REST caller says "give me the browser this
 * subject already has, and launch one only if there is none" (the same
 * concept as the CLI's `--sticky-subject` and `BrowserSwarmOptions
 * .subject`; there is no second mechanism). It has always been accepted
 * here, since this route passes its body straight to `router.acquire`, but
 * a mistyped one used to sail through: `sticky: "alice"` (a bare string
 * rather than an object) leaves `sticky.subject` undefined, and
 * `findReusable`'s sticky branch then compares every candidate instance's
 * subject against `undefined`, matches nothing, and launches a fresh
 * browser. The caller gets a 201 and a new Chrome, which is precisely the
 * symptom they were trying to fix, with no signal anywhere that their
 * request was malformed. A body typo is worth a 400.
 *
 * `subject` is checked alongside it because the two travel together: it
 * tags the instance the router creates (`req.subject ?? principal.sub`),
 * so a caller who sends `sticky.subject` without a matching `subject`
 * launches a browser filed under its own token's sub, which the next
 * identical request will not find. That combination is not rejected (a
 * gateway whose token sub already IS the subject is a legitimate setup, and
 * refusing it would break callers who are right), but it is the single
 * easiest way to get this wrong, so it is called out in the docs and left
 * to the caller.
 */
function validateAffinity(body: AcquireRequest): void {
  const sticky: unknown = body.sticky;
  if (sticky !== undefined) {
    if (typeof sticky !== 'object' || sticky === null || Array.isArray(sticky)) {
      throw new RestError(
        400,
        'E_INVALID_BODY',
        'sticky must be an object of the shape { "subject": string, "withinMs"?: number }.',
      );
    }
    const { subject, withinMs } = sticky as { subject?: unknown; withinMs?: unknown };
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new RestError(
        400,
        'E_INVALID_BODY',
        'sticky.subject must be a non-empty string naming who the instance belongs to.',
      );
    }
    if (
      withinMs !== undefined &&
      (typeof withinMs !== 'number' || !Number.isFinite(withinMs) || withinMs <= 0)
    ) {
      throw new RestError(
        400,
        'E_INVALID_BODY',
        'sticky.withinMs, when given, must be a positive number of milliseconds.',
      );
    }
  }
  const subject: unknown = body.subject;
  if (subject !== undefined && (typeof subject !== 'string' || subject.length === 0)) {
    throw new RestError(400, 'E_INVALID_BODY', 'subject, when given, must be a non-empty string.');
  }
}

/**
 * Completes the OTHER half of `attach()`/`acquire()`'s real credential.
 * `wiring.ts`'s `attachCredentialIssuerFor` resolves `config.publicUrl`
 * into an absolute `ws`/`wss` URL when an operator configured one, but
 * with no `publicUrl` set (this SDK's own default, and
 * `examples/nextjs-demo/server.mjs`'s setup before this fix) it can only
 * hand back `config.wsPath`, a bare path: that closure is built once at
 * process construction time and has no live HTTP request to read a host
 * from. This function does, because it runs per REST call: it finishes
 * the job the same way `examples/nextjs-demo/app/api/browser/agent/route.ts`'s
 * own `wsOrigin(req)` already does for its own hand-rolled credential,
 * reading `Host` off the very request the caller used to reach this
 * gateway and inferring `ws` vs `wss` from whether the socket is TLS.
 *
 * A no-op when `attach.wsUrl` is already absolute (an operator configured
 * `publicUrl`): `attachCredentialIssuerFor` already produced the correct
 * URL in that case and this must not second-guess it against whatever
 * `Host` a caller happened to send.
 *
 * The one case this cannot get right: a caller behind a TLS-terminating
 * proxy with no `publicUrl` configured sees `ws://` here (this process's
 * own socket genuinely is plain HTTP). Setting `publicUrl` is the fix for
 * that deployment, not something a per-request guess can discover on its
 * own.
 */
function resolveAttachUrl(req: IncomingMessage, wsUrl: string): string {
  if (/^wss?:\/\//i.test(wsUrl)) return wsUrl;
  const host = req.headers.host ?? 'localhost';
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  return `${encrypted ? 'wss' : 'ws'}://${host}${wsUrl}`;
}

/** `POST /v1/instances`, capability `instance.create`. */
export const acquireInstance: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const body = (rctx.body ?? {}) as AcquireRequest;
  validateAffinity(body);
  try {
    const handle = await router.acquire(body, rctx.principal);
    const status = handle.result.state === 'queued' ? 202 : 201;
    const result: AcquireResult = handle.result.attach
      ? {
          ...handle.result,
          attach: {
            ...handle.result.attach,
            wsUrl: resolveAttachUrl(rctx.req, handle.result.attach.wsUrl),
          },
        }
      : handle.result;
    writeJson(rctx.res, rctx.requestId, result, status);
    fireInstanceLaunched(ctx, rctx, router, handle);
  } catch (err) {
    fireQuotaExceeded(ctx, rctx, err, body);
    mapRouterError(err);
  }
};

/** `GET /v1/instances`, capability `view`. REST level cursor pagination over `router.list`'s full result. */
export const listInstances: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const limitRaw = rctx.query.get('limit');
  const limit = Math.min(1000, Math.max(1, limitRaw !== null ? Number(limitRaw) || 100 : 100));
  const cursorRaw = rctx.query.get('cursor');
  const after = cursorRaw !== null ? decodeCursor(cursorRaw) : null;

  const stateParam = rctx.query.get('state');
  if (stateParam !== null && !INSTANCE_STATES.has(stateParam as InstanceLifecycleState)) {
    throw new RestError(
      400,
      'E_INVALID_QUERY',
      `state "${stateParam}" is not a known instance state.`,
    );
  }

  const filter: InstanceListFilter = compact({
    state: stateParam !== null ? (stateParam as InstanceLifecycleState) : undefined,
    poolId: rctx.query.get('poolId') ?? undefined,
    subject: rctx.query.get('subject') ?? undefined,
  });
  const rows = await router.list(filter, rctx.principal);

  const startIdx = after === null ? 0 : rows.findIndex((r) => r.instance.id === after) + 1;
  const page = rows.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < rows.length;
  const lastId = page[page.length - 1]?.instance.id;
  writeJson(rctx.res, rctx.requestId, {
    // `redactInstanceView`: `router.list()`'s rows carry `instance.runtime.cdpWsUrl`
    // (`BrowserRouter.describe/list`, `redact.ts`'s own doc comment for the
    // full argument). `view` is the whole `OBSERVER_BUNDLE`; without this,
    // any read only caller could read Chrome's real CDP socket straight
    // off a list page.
    items: page.map(redactInstanceView),
    nextCursor: hasMore && lastId !== undefined ? encodeCursor(lastId) : null,
    hasMore,
  });
};

/** `GET /v1/instances/:instanceId`, capability `view`. */
export const getInstance: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const instanceId = requireParam(rctx.params, 'instanceId');
  try {
    const view = await router.describe(instanceId, rctx.principal);
    // `redactInstanceView`: strips `instance.runtime.cdpWsUrl` before this
    // read only `view` capable route hands out Chrome's real, unauthenticated
    // debug socket. See `redact.ts`'s own doc comment.
    writeJson(rctx.res, rctx.requestId, redactInstanceView(view));
  } catch (err) {
    mapRouterError(err);
  }
};

/**
 * `DELETE /v1/instances/:instanceId`, capability `instance.destroy`.
 *
 * Reports `BrowserRouter.release`'s own `ReleaseResult` rather than a bare
 * `{ released: true }`. Once affinity hands the same instance to more than
 * one viewer (two tabs of the same user, a shared workspace), a release is
 * no longer guaranteed to end the browser: the router terminates only when
 * the caller is the last viewer out, unless `?force=true`. A caller told
 * "released: true" when the browser is in fact still running for somebody
 * else has been told something false, so the outcome travels back.
 *
 * `released` is kept alongside `outcome` and means what it always meant,
 * "this instance is not running for you any more", so an existing client
 * reading that one boolean is not broken by the addition. In this build
 * `outcome: 'detached'` cannot actually occur through a stock gateway:
 * `LiveViewerPort` is not wired up in `@browserglass/server` yet, so the
 * router's viewer count reads a constant 0 and every release terminates.
 * The field is correct today and stays correct when that wiring lands.
 */
export const releaseInstance: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const instanceId = requireParam(rctx.params, 'instanceId');
  const reason = rctx.query.get('reason') ?? undefined;
  const profile = (rctx.query.get('profile') ?? undefined) as ProfileAction | undefined;
  const force = rctx.query.get('force') === 'true' ? true : undefined;
  try {
    // Read BEFORE `release()`, not after: a `'terminated'` outcome takes
    // the instance row to `released`, and this is the one place this
    // route still has `Instance.sessionId`/`.acquiredAt` to build
    // `onInstanceReleased`'s `sessionId`/`durationMs` from. Best effort,
    // wrapped in its own `try`/`catch` rather than a bare `.catch()`: a
    // `describe()` failure here (rejection OR a synchronous throw) must
    // never turn a real release into a 500, since the release itself has
    // not run yet.
    let before: Awaited<ReturnType<typeof router.describe>> | null = null;
    try {
      before = await router.describe(instanceId, rctx.principal);
    } catch {
      before = null;
    }
    const result = await router.release(
      instanceId,
      compact({ reason, profile, force }),
      rctx.principal,
    );
    writeJson(rctx.res, rctx.requestId, { released: result.outcome !== 'detached', ...result });
    // `'detached'`/`'already_released'` are not the instance actually
    // ending here: `'detached'` means another viewer is still on it
    // (nothing happened), `'already_released'` is the idempotent no-op
    // for a row that ended earlier. Only `'terminated'`/`'browser_detached'`
    // are a real end of this instance's life.
    if (before && (result.outcome === 'terminated' || result.outcome === 'browser_detached')) {
      fireInstanceReleased(ctx, rctx, before.instance, reason, profile);
    }
  } catch (err) {
    mapRouterError(err);
  }
};

/** `POST /v1/instances/:instanceId/attach`, capability `view`. */
export const attachInstance: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const instanceId = requireParam(rctx.params, 'instanceId');
  const body = (rctx.body ?? {}) as Omit<AttachRequest, 'instanceId'>;
  try {
    const attached = await router.attach({ instanceId, ...body }, rctx.principal);
    const result: AttachResult = {
      ...attached,
      attach: { ...attached.attach, wsUrl: resolveAttachUrl(rctx.req, attached.attach.wsUrl) },
    };
    writeJson(rctx.res, rctx.requestId, result);
  } catch (err) {
    mapRouterError(err);
  }
};
