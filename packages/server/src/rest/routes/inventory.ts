/**
 * The confirm-before-destroy surface: "how many browsers are open, and
 * which one is which" (`GET /v1/instances/inventory`), and "what happened
 * to this one" for a browser already gone (`GET /v1/instances/:instanceId/history`).
 *
 * WHY THIS EXISTS. An agent holding both a read capability and
 * `instance.destroy` (both are in `AGENT_BUNDLE`,
 * `packages/protocol/src/wire/capabilities.ts`) must be able to check,
 * from data, which running Chrome it is about to kill, without opening a
 * `bgls.v1` WebSocket per candidate just to ask. `GET /v1/instances`
 * (`routes/instances.ts`) already lists instances, but its shape is the
 * generic, paginated `InstanceView` passthrough used by every existing
 * consumer; it carries no live tab titles/URLs (the one thing that
 * actually lets a caller tell two same-spec Chromes apart) and no
 * unpaged total, so "how many are open" needs client-side arithmetic
 * across every page. This file adds a second, purpose-built read rather
 * than reshaping that one, so nothing that already parses
 * `GET /v1/instances`'s response breaks.
 *
 * LIVE VERSUS CACHED, DECIDED DELIBERATELY. Getting `title`/`url` means
 * asking the live CDP session (`ManagedSession.listTargets()`,
 * `session/managed-session.ts:1279`, the same synchronous, in-memory call
 * `session/rest-driver.ts`'s `RestSessionDriver.listTargets` makes for the
 * driving-authority-gated `GET /v1/instances/:instanceId/targets`). This
 * route does NOT go through `BrowserRouter.driveInstance`/`resolveDrive`
 * (`routes/targets.ts`) to get there, and deliberately never triggers a
 * fresh attach for an instance with no live `ManagedSession`: attaching is
 * not cheap (a new CDP connection, a `TargetRegistry` build), and doing it
 * just to answer a read would change the very thing an operator is
 * inventorying, and would make listing N instances cost up to N new CDP
 * connections. Instead: `ctx.sessionRegistry.get(instanceId)`
 * (`presence.ts`'s own precedent) is a plain map lookup. When a session is
 * already live in THIS process, its current target list is free and
 * genuinely current; when it is not, this route reports `targetsLive:
 * false` and an empty `targets: []` rather than a stale guess, because
 * nothing durable tracks a browser's tab titles/URLs once no live session
 * holds them (the `instances` store row has no such column, and never
 * has). `targetsObservedAt` (epoch ms, `null` when not live) is the
 * staleness signal the task calls for: a caller comparing it against
 * "now" can tell a fresh reading from a remembered one, and there is no
 * remembered one to mistake for fresh, by construction.
 *
 * CROSS-NODE HONESTY, same shape as `presence.ts`'s own doc: a live
 * `ManagedSession` exists in exactly one gateway process's
 * `SessionRegistry`. For an instance on another node, or local but not
 * yet attached in this process, `targetsLive` reads `false` with an empty
 * `targets: []`, never a partial or guessed one. `nodeId` travels on every
 * summary row precisely so a caller who gets `targetsLive: false` can
 * tell "nobody has attached yet" from "ask the node that owns this
 * instance instead".
 *
 * REDACTION. Every `Instance` this file reads goes through
 * `redactInstance` (`../redact.ts`) before any field is pulled off it,
 * matching `routes/instances.ts`'s `getInstance`/`listInstances`. Neither
 * summary shape below actually spreads `instance.runtime` into the
 * response (each lists its fields by name), so there is no live leak path
 * today, but redacting first is the same belt-and-braces this codebase
 * already uses at every other `view`-capable instance read, and it means
 * a future field added to either summary by name still cannot reintroduce
 * `cdpWsUrl`/`cdpPort` by accident. See `../redact.ts`'s own doc comment
 * for why `cdpPort` alone is just as much a leak as the URL (Chrome's own
 * `/json/version` turns a port back into a full debug URL).
 *
 * CAPABILITY: `view` on both routes, not a new one and not `admin`. Both
 * are reads; `view` is the whole `OBSERVER_BUNDLE` and is already what
 * `getInstance`/`listInstances`/`viewersForInstance` use for the same
 * class of "look, do not touch" access. `AGENT_BUNDLE` carries
 * `instance.create`/`instance.destroy`/`instance.restart`
 * alongside `view`, so an agent holds both; keeping
 * this at `view` (rather than folding it under `instance.destroy` or a
 * new capability) means a purely observational caller, an operator
 * dashboard with no destroy authority, can still confirm what is running
 * without being handed the power to end it.
 *
 * KNOWN GAP in `getInstanceHistory`, named rather than silently dropped:
 * `first_viewer_at`, `release_reason`, `restart_count`, `peak_rss_mib`,
 * and `os_pid` live only on the raw `instances` table row
 * (`store-sqlite/migrations/0001_initial.sql`,
 * `store-postgres/migrations/0001_initial.sql`) and are never carried onto
 * the `Instance` domain entity `Store.getInstance` returns:
 * `rowToInstance` (`store-sqlite/src/mappers.ts:516`,
 * `store-postgres/src/mappers.ts:497`) reads neither column into any
 * `Instance` field. Closing this needs a new `Store` method (something
 * like `getInstanceHistory(tenantId, id)` returning those five fields, or
 * widening `Instance` itself) in `packages/protocol/src/domain/store.ts`
 * plus both adapters, none of which this file owns
 * (`packages/server/src/rest/**` only). Until that lands, this route
 * reports the five as `null` and names them in `historyFieldsUnavailable`,
 * the same "say the gap instead of guessing" contract `presence.ts`
 * already established for its own `kind`/`joinedAt` gap.
 *
 * AUDIT FOLD-IN. `store.queryAudit(tenantId, { instanceId })` already
 * exists on `Store` (`store-types.ts`) and needs no new method: this
 * route calls it unconditionally and returns whatever it finds. Today
 * that is `[]` on every real gateway (`audit_events` has zero production
 * writers as of this change; a concurrent change is making it persist).
 * Once it does, this route's `auditEvents` array starts carrying real
 * rows with no further change here, which is the point of reading
 * through the existing interface rather than reaching around it.
 */

import type {
  Instance,
  InstanceLifecycleState,
  Scope,
  TargetSummary,
} from '@browserglass/protocol';
import type { InstanceListFilter } from '@browserglass/router';
import { compact } from '../../util/compact.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { RestError, requireRouter, requireStore, writeJson } from '../errors.js';
import { redactInstance } from '../redact.js';
import type { RestContext, RestHandler } from '../types.js';

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RestError(400, 'E_MISSING_PARAM', `${name} is required.`);
  return value;
}

/**
 * Every `InstanceLifecycleState` except the two terminal ones
 * (`released`, `failed`): "open" in the sense the user's own request
 * means it, a browser still occupying a slot somewhere, whether or not it
 * has finished launching yet. Mirrors `INSTANCE_STATES` in
 * `routes/instances.ts` minus those two, kept as an independent literal
 * here rather than importing that private set, since the two lists are
 * allowed to diverge in meaning (that one validates ANY state a caller
 * may filter on; this one defines what "open" means).
 */
const OPEN_STATES: readonly InstanceLifecycleState[] = [
  'requested',
  'placing',
  'launching',
  'ready',
  'degraded',
  'recovering',
  'draining',
  'releasing',
];
const OPEN_STATE_SET: ReadonlySet<InstanceLifecycleState> = new Set(OPEN_STATES);

interface TargetsField {
  readonly targets: readonly TargetSummary[];
  readonly targetsLive: boolean;
  /** Epoch ms this reading was taken, `null` when `targetsLive` is `false`. Never a remembered value presented as current; see this file's own module doc. */
  readonly targetsObservedAt: number | null;
}

/** {@link TargetsField} module doc: a live `ManagedSession` reports its current tabs for free; anything else reports honestly empty rather than stale or attached-on-demand. */
function targetsFor(ctx: RestContext, instanceId: string): TargetsField {
  const managed = ctx.sessionRegistry?.get(instanceId);
  if (managed === undefined) return { targets: [], targetsLive: false, targetsObservedAt: null };
  return { targets: managed.listTargets(), targetsLive: true, targetsObservedAt: Date.now() };
}

/** One row of `GET /v1/instances/inventory`'s `items`. */
interface OpenInstanceSummary extends TargetsField {
  readonly instanceId: string;
  readonly status: InstanceLifecycleState;
  readonly nodeId: string | null;
  /** `Instance.subject`, itself `created_by_sub` (`rowToInstance`). Named `createdBy` here to match the identity vocabulary this route's callers actually asked for. */
  readonly createdBy: string | null;
  readonly acquiredAt: number;
  readonly readyAt: number | null;
  readonly lastActivityAt: number;
  readonly expiresAt: number;
  /** Free-form name/description a caller attached at acquire time (`Instance.metadata`). Empty object until a caller sets any. */
  readonly metadata: Readonly<Record<string, string>>;
  /** `'viewer-bound'` releases after the last viewer leaves plus a linger; `'explicit'` lives until released. Tells a confirming agent whether this browser is meant to outlive the current run. */
  readonly lifetime: 'viewer-bound' | 'explicit';
}

function toOpenInstanceSummary(ctx: RestContext, instance: Instance): OpenInstanceSummary {
  return {
    instanceId: instance.id,
    status: instance.state,
    nodeId: instance.nodeId,
    createdBy: instance.subject,
    acquiredAt: instance.acquiredAt,
    readyAt: instance.readyAt,
    lastActivityAt: instance.lastActivityAt,
    expiresAt: instance.expiresAt,
    metadata: instance.metadata,
    lifetime: instance.lifetime,
    ...targetsFor(ctx, instance.id),
  };
}

/**
 * `GET /v1/instances/inventory`, capability `view`. Query: `limit`
 * (default 100, max 1000), `cursor`, `poolId`, `subject`, and `state`
 * (must be one of {@link OPEN_STATES}; a caller asking for `released` or
 * `failed` is pointed at the history route instead of silently getting an
 * empty page). With no `state`, every open state is included.
 *
 * Registered in `router.ts`'s `LIVE` table BEFORE
 * `GET /v1/instances/:instanceId`: both compile to a same-length path
 * pattern (`/v1/instances/inventory` vs `/v1/instances/:instanceId`), and
 * `dispatchRest` matches the first `ROUTE_TABLE` entry whose pattern
 * matches, so declaration order is what keeps `/v1/instances/inventory`
 * from being swallowed by the dynamic route as `instanceId: "inventory"`.
 */
export const listOpenInstances: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const limitRaw = rctx.query.get('limit');
  const limit = Math.min(1000, Math.max(1, limitRaw !== null ? Number(limitRaw) || 100 : 100));
  const cursorRaw = rctx.query.get('cursor');
  const after = cursorRaw !== null ? decodeCursor(cursorRaw) : null;

  const stateParam = rctx.query.get('state');
  let states: readonly InstanceLifecycleState[] = OPEN_STATES;
  if (stateParam !== null) {
    if (!OPEN_STATE_SET.has(stateParam as InstanceLifecycleState)) {
      throw new RestError(
        400,
        'E_INVALID_QUERY',
        `state "${stateParam}" is not an open instance state. Use one of ${OPEN_STATES.join(', ')}, or GET /v1/instances/:instanceId/history for a released or failed one.`,
      );
    }
    states = [stateParam as InstanceLifecycleState];
  }

  const filter: InstanceListFilter = compact({
    state: states,
    poolId: rctx.query.get('poolId') ?? undefined,
    subject: rctx.query.get('subject') ?? undefined,
  });
  // Unpaged: `router.list` returns every row this principal's scope
  // allows, the same as `listInstances` (`routes/instances.ts`) already
  // relies on for its own REST-level cursor slicing below. `totalCount` is
  // this array's length BEFORE that slice, so "how many are open" is
  // answerable from page one without walking every page and summing.
  const rows = await router.list(filter, rctx.principal);
  const totalCount = rows.length;

  const startIdx = after === null ? 0 : rows.findIndex((r) => r.instance.id === after) + 1;
  const page = rows.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < rows.length;
  const lastId = page[page.length - 1]?.instance.id;

  writeJson(rctx.res, rctx.requestId, {
    items: page.map((row) => toOpenInstanceSummary(ctx, redactInstance(row.instance))),
    totalCount,
    nextCursor: hasMore && lastId !== undefined ? encodeCursor(lastId) : null,
    hasMore,
  });
};

/**
 * The same narrowing `BrowserRouter`'s own (unexported)
 * `scopeAllowsInstanceRow` applies (`packages/router/src/router/BrowserRouter.ts:245`),
 * reproduced here rather than imported because that function is a module
 * private helper, not part of `@browserglass/router`'s public surface, and
 * `packages/router/**` is out of this file's ownership for this change.
 * `getInstanceHistory` needs its own copy because it deliberately reads
 * `Store.getInstance` directly rather than through
 * `BrowserRouter.describe()` (see this file's module doc: a released
 * instance can still answer here long after the router says
 * `E_INSTANCE_GONE`), so it gets none of the router's own scope
 * enforcement for free and must not skip it. Kept logically identical to
 * the router's version: absent scope reads as tenant scope, `tenant`
 * covers everything the caller's own tenant check already established,
 * `pool` requires the instance be in that exact pool, `instance`/`stream`
 * require an exact instance id match, and an unrecognised scope kind
 * (unreachable while `Scope` stays a closed union; decoded JSON has no
 * such guarantee) is refused.
 */
function scopeAllowsInstance(
  scope: Scope | undefined,
  instanceId: string,
  poolId: string | null,
): boolean {
  if (scope === undefined) return true;
  if (scope.kind === 'tenant') return true;
  if (scope.kind === 'pool') return poolId !== null && poolId === scope.poolId;
  if (scope.kind === 'instance' || scope.kind === 'stream') return scope.instanceId === instanceId;
  return false;
}

/**
 * `GET /v1/instances/:instanceId/history`, capability `view`. Answers
 * "what happened to this browser" for an instance that may already be
 * released: reads `Store.getInstance` directly (never
 * `BrowserRouter.describe()`, which throws `E_INSTANCE_GONE` for exactly
 * the row this route exists to still answer for) and folds in whatever
 * `Store.queryAudit` has for this `instanceId`, which survives the
 * `instances` row's own deletion by design (`AuditEvent`'s own doc,
 * `store-types.ts`: "no foreign keys ... so an audit row survives deletion
 * of the instance").
 *
 * `historyFieldsUnavailable` names the five raw-row-only fields this route
 * cannot fill yet (see this file's own module doc, KNOWN GAP): `null`
 * here is "not available", never a fabricated zero or a guess.
 *
 * SCOPE, when the `instances` row itself is gone (outside its retention
 * window) but audit rows for it survive: `queryAudit` is already
 * tenant-scoped, so cross-TENANT leakage is impossible, but a
 * pool/instance/stream-narrowed token's finer scope cannot be re-checked
 * in that branch, because the one thing that would let this function
 * check it (`poolId`) lived only on the row that is now gone. Documented
 * rather than silently accepted: this is a real, narrow gap (a narrowed
 * token can read audit-only history for an instance outside its scope,
 * but ONLY once that instance's row has already left the retention
 * window), not something a new `Store` method already available to this
 * file could close.
 */
export const getInstanceHistory: RestHandler = async (ctx, rctx) => {
  const store = requireStore(ctx);
  const instanceId = requireParam(rctx.params, 'instanceId');
  const tenantId = rctx.principal.tenantId;

  const [instanceRaw, audit] = await Promise.all([
    store.getInstance(tenantId, instanceId),
    store.queryAudit(tenantId, { instanceId, limit: 200 }),
  ]);

  if (instanceRaw === null) {
    if (audit.events.length === 0) {
      throw new RestError(
        404,
        'E_INSTANCE_NOT_FOUND',
        `No history for instance "${instanceId}": no instances row (outside the retention window, or it never existed) and no audit_events row for it either.`,
      );
    }
    writeJson(rctx.res, rctx.requestId, {
      instanceId,
      instanceRecordFound: false,
      status: null,
      nodeId: null,
      createdBy: null,
      createdAt: null,
      launchedAt: null,
      firstViewerAt: null,
      lastActiveAt: null,
      releasedAt: null,
      releaseReason: null,
      statusSince: null,
      restartCount: null,
      peakRssMib: null,
      osPid: null,
      metadata: null,
      lifetime: null,
      historyFieldsUnavailable: [
        'firstViewerAt',
        'releaseReason',
        'restartCount',
        'peakRssMib',
        'osPid',
      ],
      auditEvents: audit.events,
    });
    return;
  }

  if (!scopeAllowsInstance(rctx.principal.scope, instanceRaw.id, instanceRaw.poolId)) {
    throw new RestError(404, 'E_INSTANCE_NOT_FOUND', `instance ${instanceId} not found`);
  }

  const instance = redactInstance(instanceRaw);
  writeJson(rctx.res, rctx.requestId, {
    instanceId: instance.id,
    instanceRecordFound: true,
    status: instance.state,
    nodeId: instance.nodeId,
    createdBy: instance.subject,
    createdAt: instance.acquiredAt,
    launchedAt: instance.readyAt,
    firstViewerAt: null,
    lastActiveAt: instance.lastActivityAt,
    releasedAt: instance.releasedAt,
    releaseReason: null,
    statusSince: instance.stateChangedAt,
    restartCount: null,
    peakRssMib: null,
    osPid: null,
    metadata: instance.metadata,
    lifetime: instance.lifetime,
    historyFieldsUnavailable: [
      'firstViewerAt',
      'releaseReason',
      'restartCount',
      'peakRssMib',
      'osPid',
    ],
    auditEvents: audit.events,
  });
};
