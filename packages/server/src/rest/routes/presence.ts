/**
 * `GET /v1/instances/:instanceId/viewers` (capability `view`) and
 * `DELETE /v1/sessions/:sessionId/viewers/:viewerId` (capability `admin`):
 * the REST answer to "who is viewing and who is controlling this
 * instance right now", out of band, without holding a `bgls.v1` WebSocket
 * open just to receive `presence.state` (`messages/presence.ts`). An
 * orchestrator managing a swarm of browsers, or a dashboard, should not
 * have to open and hold a socket per instance just to ask this question;
 * that does not scale to the "massive concurrent users" case this whole
 * feature is for.
 *
 * DATA SOURCE. Deliberately NOT `store.listViewers()`
 * (`routes/sessions.ts`'s `GET /v1/sessions/:sessionId/viewers`, this
 * file's own nearest precedent): that table has zero production writers
 * anywhere in this repo (`store.createViewer` is called from nothing but
 * `store-sqlite`'s own CRUD tests), so that route always answers `[]` on
 * a real gateway today. `controlling`/`watching`/`idle` do not exist in
 * the store at all; they are LIVE, in-memory facts
 * (`session/managed-session.ts`'s `presenceEntries`, `targetTier`,
 * `streamIndex`, and the `ControlLeaseEngine` behind
 * `leaseSummariesFor`). This route reads the same live `ManagedSession`
 * `presence.state` itself reads, through `ManagedSession`'s already
 * public surface (`allConnections`, `leaseSummariesFor`, `listStreams`),
 * so a caller sees the same facts a connected WebSocket viewer would.
 *
 * KNOWN GAP, not silently swallowed: `presenceEntries` (the ONLY place
 * `label`/`kind`/`joinedAt` are tracked) is private to `ManagedSession`
 * and has no public accessor, and `managed-session.ts` was explicitly out
 * of scope for this change (owned by concurrent work making CDP clients
 * appear as real viewers there). `label` is reported as `viewerId` itself
 * (matching live reality: `attachViewer`/`resumeViewer` set
 * `presenceEntries.label = sink.viewerId` unconditionally today, so
 * `viewerId` and `label` already carry identical information on every
 * real gateway, not a fallback approximation). `kind` and `joinedAt` are
 * reported `null`, and `presenceFieldsUnavailable` names them explicitly
 * so a caller can detect the gap programmatically rather than mistake
 * `null` for "this viewer truly has no kind". Closing it needs exactly
 * one new public method on `ManagedSession` that returns (rather than
 * broadcasts) what `broadcastPresence()` already computes; see this
 * change's own handoff notes.
 *
 * CROSS NODE HONESTY. This route resolves through `router.describe()`
 * (see `viewersForInstance`'s own comment for why, over `driveInstance`),
 * which answers for an instance on ANY node in the fleet. But the live
 * viewer roster itself only ever exists in ONE gateway process's
 * `SessionRegistry` (`session/registry.ts`'s own module doc: "one
 * process's live `ManagedSession` pool"), and there is no cross node RPC
 * for it: `BrowserRouter`'s own `LiveViewerPort` (`router/types.ts`)
 * deliberately exposes only a COUNT (`countFor`), with a doc comment
 * explaining why the router "cannot count viewers itself... the real
 * viewer set lives in `@browserglass/server`'s session layer". This route
 * answers correctly and completely ONLY for an instance whose
 * `ManagedSession` is live in THIS gateway process. For any other case
 * (the instance lives on another node, or this process has no live
 * session for it yet, e.g. right after a restart before any viewer
 * reconnected) it answers `live: false` with an EMPTY viewer list, never
 * a guessed or partial one, and names `instance.nodeId` in the response
 * so a caller can tell "empty because nobody is connected" from "empty
 * because this gateway cannot see that node" and route the request to
 * the owning node instead.
 */

import type { LeaseSummary } from '@browserglass/protocol';
import { buildGoodbye } from '../../wire/close.js';
import { RestError, mapRouterError, requireRouter, writeJson } from '../errors.js';
import type { RestHandler } from '../types.js';

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RestError(400, 'E_MISSING_PARAM', `${name} is required.`);
  return value;
}

/** One connected viewer, as this route reports it. See this file's own module doc for exactly which fields are live today and which are a known, named gap. */
interface InstanceViewerInfo {
  readonly viewerId: string;
  /** `presenceEntries.label` on every real gateway today (see module doc): identical to `viewerId`. */
  readonly label: string;
  /** `null`: not available without a `ManagedSession` accessor this change could not add. See `presenceFieldsUnavailable` below. */
  readonly kind: 'human' | 'agent' | 'service' | null;
  /** `null`, same reason as `kind`. */
  readonly joinedAt: number | null;
  /** Always `false` today: `ManagedSession.broadcastPresence()` itself hardcodes `idle: false` on every entry (no idle tracking exists yet anywhere in this codebase), so this is not a gap this route introduces. */
  readonly idle: boolean;
  /** targetIds this viewer currently holds a `ControlLease` on. Several viewers can share one targetId here on a `mode: 'shared'` target; see `contendedTargets` for the aggregate, obvious-without-set-intersection view of that. */
  readonly controlling: readonly string[];
  /** targetIds this viewer is subscribed to a stream for. */
  readonly watching: readonly string[];
}

/**
 * One target with more than one current control holder, i.e. simultaneous
 * control made explicit rather than something a caller has to derive by
 * intersecting every viewer's `controlling[]`. `mode`/`holderCount` are
 * `LeaseSummary`'s own field names (`@browserglass/protocol`'s
 * `messages/control.ts`, the shared/co-driving vocabulary that message
 * already uses for exactly this fact), reused verbatim rather than a
 * parallel set of names invented for this route.
 */
interface ContendedTarget {
  readonly targetId: string;
  readonly mode: LeaseSummary['mode'];
  readonly holderCount: number;
}

/** `GET /v1/instances/:instanceId/viewers`, capability `view`. See this file's own module doc for data source, the known `kind`/`joinedAt` gap, and the cross node caveat. */
export const viewersForInstance: RestHandler = async (ctx, rctx) => {
  const router = requireRouter(ctx);
  const instanceId = requireParam(rctx.params, 'instanceId');

  // `router.describe()`, not `router.driveInstance()`. This is a read,
  // not a drive action: `getInstance` (`routes/instances.ts`,
  // capability `view`, the same capability this route uses) already
  // establishes the precedent of `describe()` for a `view` capable read.
  // `driveInstance()` additionally requires `ready`/`degraded` state and
  // records driving activity (`routes/targets.ts`'s own module doc); a
  // "who is connected" read is exactly the question an operator wants
  // answered WHILE an instance is `draining`/`recovering`, e.g. to decide
  // whether it is safe to force release it, so gating this route behind
  // the drivable-state requirement would refuse the one case it is most
  // useful for. `describe()` still authorizes (throws `E_INSTANCE_NOT_FOUND`
  // for a foreign tenant or truly unknown id, `mapRouterError` below), it
  // just does not additionally require the instance be drivable right now.
  let instance: Awaited<ReturnType<typeof router.describe>>['instance'];
  try {
    instance = (await router.describe(instanceId, rctx.principal)).instance;
  } catch (err) {
    mapRouterError(err);
  }

  // `ctx.sessionRegistry.get(instanceId)`: `undefined` covers BOTH "this
  // instance lives on another node" and "it is local but this process
  // holds no live `ManagedSession` for it yet" (see module doc's cross
  // node honesty section). Both are reported identically, honestly, as
  // `live: false` with an empty roster, never guessed at.
  const managed = ctx.sessionRegistry?.get(instanceId);

  if (managed === undefined) {
    writeJson(rctx.res, rctx.requestId, {
      instanceId,
      nodeId: instance.nodeId,
      sessionId: instance.sessionId,
      live: false,
      viewers: [],
      viewerCount: 0,
      controllingCount: 0,
      contendedTargets: [],
      presenceFieldsUnavailable: ['kind', 'joinedAt'],
    });
    return;
  }

  const connections = managed.allConnections();

  // `watching`: group `listStreams()` (every live subscription across
  // every connected viewer) by `viewerId`.
  const watchingByViewer = new Map<string, string[]>();
  for (const stream of managed.listStreams()) {
    const list = watchingByViewer.get(stream.viewerId);
    if (list) list.push(stream.targetId);
    else watchingByViewer.set(stream.viewerId, [stream.targetId]);
  }

  // `controlling` per viewer, and the contended-target aggregate, both
  // read off `leaseSummariesFor(viewerId)`: PER RECIPIENT for
  // `holderViewerId` (this viewer's own holding, `LeaseSummary`'s own
  // doc comment), but `mode`/`holderCount` are the same for every
  // recipient, so folding every viewer's projection into one
  // `targetId -> {mode, holderCount}` map is safe and does not depend on
  // iteration order.
  const contendedByTarget = new Map<string, ContendedTarget>();
  const viewers: InstanceViewerInfo[] = connections.map((conn) => {
    const summaries = managed.leaseSummariesFor(conn.viewerId);
    const controlling: string[] = [];
    for (const [targetId, summary] of Object.entries(summaries)) {
      if (summary.holderViewerId === conn.viewerId) controlling.push(targetId);
      if (summary.holderCount > 1) {
        contendedByTarget.set(targetId, {
          targetId,
          mode: summary.mode,
          holderCount: summary.holderCount,
        });
      }
    }
    return {
      viewerId: conn.viewerId,
      label: conn.viewerId,
      kind: null,
      joinedAt: null,
      idle: false,
      controlling,
      watching: watchingByViewer.get(conn.viewerId) ?? [],
    };
  });

  writeJson(rctx.res, rctx.requestId, {
    instanceId,
    nodeId: instance.nodeId,
    sessionId: instance.sessionId,
    live: true,
    viewers,
    viewerCount: viewers.length,
    controllingCount: viewers.filter((v) => v.controlling.length > 0).length,
    contendedTargets: [...contendedByTarget.values()],
    presenceFieldsUnavailable: ['kind', 'joinedAt'],
  });
};

/**
 * `DELETE /v1/sessions/:sessionId/viewers/:viewerId`, capability `admin`.
 * Forcibly disconnects one viewer: the operator's tool for correcting a
 * connected viewer (human, agent, or CDP client) that is misbehaving, stuck, or
 * needs to be removed without ending the whole session.
 *
 * CAPABILITY: `admin`, not `control` and not a new one. `capabilities.ts`'s
 * own description of `admin` is "an operator role over sessions and
 * leases (it force-claims control, it revokes)": forcibly dropping
 * another viewer's connection is exactly that class of action, not
 * driving a page (`control`) or fleet management (`instance.*`). `admin`
 * is granted only by the `owner` role bundle among the five named
 * bundles (`observer`/`driver`/`operator`/`agent` all withhold it), so an
 * ordinary driving or automation token cannot reach this route.
 *
 * Looks up the live session directly against `ctx.sessionRegistry`
 * (`SessionRegistry.all()`, scanning for `sessionId`, the same pattern
 * `session/rest-driver.ts`'s `findLocalManaged` and `session-api.ts`'s
 * `findManaged` both already use) rather than going through
 * `SessionApi.kick`: `SessionApi` is `bg.sessions`, an in-process, already
 * trusted SDK surface with no tenant check of its own (correct for a
 * trusted embedder calling it directly; wrong to reuse unchanged for a
 * network facing route, where it would let an `admin` token on tenant A
 * kick a viewer on tenant B's session merely by guessing a `sessionId`).
 * This handler checks `managed.tenantId === rctx.principal.tenantId`
 * itself before touching anything, closing that gap rather than
 * inheriting it.
 *
 * `reason`/`code` are QUERY params (`?reason=...&code=4003`), not a JSON
 * body: `router.ts`'s own `readBody` never reads a body for a DELETE
 * request at all, matching `releaseInstance`'s (`routes/instances.ts`)
 * existing convention for the same reason.
 */
export const disconnectSessionViewer: RestHandler = async (ctx, rctx) => {
  const sessionId = requireParam(rctx.params, 'sessionId');
  const viewerId = requireParam(rctx.params, 'viewerId');

  if (ctx.sessionRegistry === undefined) {
    throw new RestError(
      503,
      'E_SESSION_REGISTRY_UNAVAILABLE',
      'This gateway has no live session registry wired (RestContext.sessionRegistry is unset).',
    );
  }

  const managed = ctx.sessionRegistry
    .all()
    .find((m) => m.sessionId === sessionId && m.tenantId === rctx.principal.tenantId);
  if (managed === undefined) {
    throw new RestError(
      404,
      'E_SESSION_NOT_FOUND',
      `No live session "${sessionId}" on this gateway.`,
    );
  }

  const conn = managed.connectionFor(viewerId);
  if (conn === undefined) {
    throw new RestError(
      404,
      'E_VIEWER_NOT_FOUND',
      `No live viewer "${viewerId}" on session "${sessionId}".`,
    );
  }

  // Query params, not a JSON body: `router.ts`'s own `readBody` never
  // reads a body for GET/DELETE/HEAD at all (DELETE bodies are widely
  // unsupported by proxies/clients), matching this codebase's existing
  // DELETE convention (`routes/instances.ts`'s `releaseInstance` reads
  // `reason`/`profile`/`force` off `rctx.query` the same way).
  const reasonParam = rctx.query.get('reason');
  const reason =
    reasonParam !== null && reasonParam.length > 0
      ? reasonParam
      : 'Disconnected by an administrator.';
  const codeParam = rctx.query.get('code');
  const parsedCode = codeParam !== null ? Number(codeParam) : Number.NaN;
  const code = Number.isInteger(parsedCode) ? parsedCode : 4003;

  // `buildGoodbye`, the same helper `SessionApi.kick` uses
  // (`session-api.ts`, `wire/close.ts`): a `goodbye` envelope so the
  // client can distinguish an intentional disconnect from a network drop,
  // then the actual socket close.
  conn.sendEnvelope(buildGoodbye(code, reason));
  conn.close(code, reason);

  writeJson(rctx.res, rctx.requestId, { disconnected: true, sessionId, viewerId });
};
