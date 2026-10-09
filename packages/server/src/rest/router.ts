import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthError, principalFor } from '../auth/resolver.js';
import { applyCorsHeaders, handleCorsPreflight } from './cors.js';
import { RestError, notImplementedBody, writeError } from './errors.js';
import { compilePath } from './path.js';
import { fetchDownload } from './routes/downloads.js';
import { handleHealthz, handleReadyz } from './routes/health.js';
import {
  acquireInstance,
  attachInstance,
  getInstance,
  listInstances,
  releaseInstance,
} from './routes/instances.js';
import { getInstanceHistory, listOpenInstances } from './routes/inventory.js';
import { disconnectSessionViewer, viewersForInstance } from './routes/presence.js';
import { getSession, listSessionViewers } from './routes/sessions.js';
import {
  closeTarget,
  createTarget,
  dispatchInput,
  listTargets,
  navigateTarget,
  screenshotTarget,
  sendCdpCommand,
  setTargetFiles,
} from './routes/targets.js';
import { issueToken } from './routes/tokens.js';
import {
  completeUpload,
  deleteUpload,
  getUpload,
  initUpload,
  putUploadChunk,
} from './routes/uploads.js';
import type { RestContext, RestRoute } from './types.js';

interface RouteSpec {
  readonly method: string;
  readonly path: string;
  readonly capability: RestRoute['capability'];
  readonly handler: RestRoute['handler'];
  /** See {@link RestRoute.rawBody}. Only the upload chunk route sets it. */
  readonly rawBody?: boolean;
  /**
   * See {@link RestRoute.public}. Every stub route is public regardless of
   * this field (`compile`'s own `isStub` override below); among `LIVE`
   * routes only `GET /v1/downloads/:token` sets it, since a signed
   * download URL has to work as a plain, unauthenticated browser fetch
   * (`routes/downloads.ts`'s own module doc).
   */
  readonly public?: boolean;
}

/**
 * Exported (only from this module, not from `rest/index.ts`'s public
 * barrel) purely so `test/rest/openapi-drift.test.ts` can diff this table
 * against `openapi.json` without hand-copying it a second time. Nothing
 * in `dispatchRest` itself needs these to be visible outside this file.
 */
export const LIVE: readonly RouteSpec[] = [
  {
    method: 'POST',
    path: '/v1/instances',
    capability: 'instance.create',
    handler: acquireInstance,
  },
  { method: 'GET', path: '/v1/instances', capability: 'view', handler: listInstances },
  // Confirm-before-destroy inventory (`routes/inventory.ts`'s own module
  // doc has the full argument): live target titles/URLs, an unpaged
  // count, and the identity fields an agent needs to tell two same-spec
  // Chromes apart before it destroys one. Registered here, BEFORE
  // `GET /v1/instances/:instanceId` immediately below: both compile to a
  // same-length path pattern (`/v1/instances/inventory` vs
  // `/v1/instances/:instanceId`), and `dispatchRest` takes the first
  // `ROUTE_TABLE` match, so this declaration order is what keeps
  // "inventory" from being swallowed as `instanceId: "inventory"` by the
  // dynamic route.
  {
    method: 'GET',
    path: '/v1/instances/inventory',
    capability: 'view',
    handler: listOpenInstances,
  },
  { method: 'GET', path: '/v1/instances/:instanceId', capability: 'view', handler: getInstance },
  {
    method: 'DELETE',
    path: '/v1/instances/:instanceId',
    capability: 'instance.destroy',
    handler: releaseInstance,
  },
  {
    method: 'POST',
    path: '/v1/instances/:instanceId/attach',
    capability: 'view',
    handler: attachInstance,
  },
  // "What happened to this browser", readable after it is gone
  // (`routes/inventory.ts`'s own module doc): reads `Store.getInstance`
  // directly rather than through the router, since the `instances` row
  // outlives release for the retention window while the router itself
  // already answers `E_INSTANCE_GONE` for a released instance.
  {
    method: 'GET',
    path: '/v1/instances/:instanceId/history',
    capability: 'view',
    handler: getInstanceHistory,
  },
  { method: 'GET', path: '/v1/sessions/:sessionId', capability: 'view', handler: getSession },
  {
    method: 'GET',
    path: '/v1/sessions/:sessionId/viewers',
    capability: 'view',
    handler: listSessionViewers,
  },
  // Presence over REST (`routes/presence.ts`'s own module doc has the
  // full argument): who is viewing and who is controlling an instance,
  // answerable without holding a `bgls.v1` WebSocket open for
  // `presence.state`. `view` matches `listSessionViewers`/`getInstance`
  // immediately above: a read, gated the same as every other
  // observability route, not the `driveInstance` DRIVE authority gate
  // `routes/targets.ts`'s driving verbs use.
  {
    method: 'GET',
    path: '/v1/instances/:instanceId/viewers',
    capability: 'view',
    handler: viewersForInstance,
  },
  // `admin`: an operator forcibly disconnecting a misbehaving viewer is
  // "an operator role over sessions and leases" (`capabilities.ts`'s own
  // description of `admin`), the same class of action as
  // `control.revoke`/`SessionApi.kick`, not ordinary driving (`control`).
  {
    method: 'DELETE',
    path: '/v1/sessions/:sessionId/viewers/:viewerId',
    capability: 'admin',
    handler: disconnectSessionViewer,
  },
  // `admin`, not `capability: null`. `capability: null` used to let ANY
  // authenticated caller reach `issueToken` (a valid Principal is still
  // resolved for `capability: null`, only the membership check is
  // skipped, see this file's own capability check below), and the
  // handler forwarded the request body straight to `ctx.tokens.issueWithMeta`,
  // which clamps only against server wide `auth.maxCaps`/`tenantAllowedCaps`
  // and reads `tenantId`/`appId` from the body: a bare `view` token could
  // mint itself `admin`/`cdp`/`evaluate` for any tenant. `routes/tokens.ts`'s
  // own doc comment now explains the second, independent clamp the
  // handler applies on top of this gate (found in a security audit).
  { method: 'POST', path: '/v1/tokens', capability: 'admin', handler: issueToken },

  // The driving verbs.
  // HTTP is request/response: a caller wanting a live feed (frames,
  // console, network) still needs the WebSocket transport or a poll loop
  // against these, never a push from here. Each handler resolves
  // `ctx.driver`/`ctx.cdp`, which are unset in this build; see
  // `routes/targets.ts`'s top comment and `rest/types.ts`'s
  // `RestSessionDriver`/`RestCdpSender` doc comments for exactly what is
  // missing and why it is out of this package's reach.
  {
    method: 'GET',
    path: '/v1/instances/:instanceId/targets',
    capability: 'view',
    handler: listTargets,
  },
  {
    method: 'POST',
    path: '/v1/instances/:instanceId/targets',
    capability: 'tabs.manage',
    handler: createTarget,
  },
  {
    method: 'DELETE',
    path: '/v1/instances/:instanceId/targets/:targetId',
    capability: 'tabs.manage',
    handler: closeTarget,
  },
  {
    method: 'POST',
    path: '/v1/instances/:instanceId/targets/:targetId/navigate',
    capability: 'navigate',
    handler: navigateTarget,
  },
  {
    method: 'GET',
    path: '/v1/instances/:instanceId/targets/:targetId/screenshot',
    capability: 'capture',
    handler: screenshotTarget,
  },
  {
    method: 'POST',
    path: '/v1/instances/:instanceId/targets/:targetId/input',
    capability: 'control',
    handler: dispatchInput,
  },
  // The capability-gated, allowlisted CDP passthrough. `cdp` is a
  // dedicated capability (`packages/protocol/src/wire/capabilities.ts`),
  // off by default and granted by no role bundle; the method allowlist
  // (`cdp-passthrough-allowlist.ts`) is enforced inside the handler,
  // before it ever looks for a live sender, so a disallowed method is
  // refused the same way whether or not this build has one wired.
  {
    method: 'POST',
    path: '/v1/instances/:instanceId/targets/:targetId/cdp',
    capability: 'cdp',
    handler: sendCdpCommand,
  },

  // File upload, capability `upload`. Five staging routes plus one attach
  // route; all six were 501 stubs (the attach route did not exist at all)
  // and the `upload.*` wire messages that describe the same handshake were
  // typed only. `routes/uploads.ts`'s module doc explains the handshake and
  // why it is not one multipart POST; `files/safe-name.ts` explains why no
  // route here accepts a filesystem path from a caller.
  //
  // `upload` is the canonical capability from `capabilities.ts`'s 19
  // member table, not a new one. It already existed for exactly this and
  // was granted by nothing but the `driver`, `operator` and `owner`
  // bundles, which is the gating this feature wants: `observer` and
  // `agent` cannot upload, and a bare token has to name it.
  { method: 'POST', path: '/v1/upload/init', capability: 'upload', handler: initUpload },
  // `rawBody`: this one route takes bytes, not JSON. See `RestRoute.rawBody`.
  {
    method: 'PUT',
    path: '/v1/upload/:uploadId',
    capability: 'upload',
    handler: putUploadChunk,
    rawBody: true,
  },
  { method: 'GET', path: '/v1/upload/:uploadId', capability: 'upload', handler: getUpload },
  {
    method: 'POST',
    path: '/v1/upload/:uploadId/complete',
    capability: 'upload',
    handler: completeUpload,
  },
  { method: 'DELETE', path: '/v1/upload/:uploadId', capability: 'upload', handler: deleteUpload },
  {
    method: 'POST',
    path: '/v1/instances/:instanceId/targets/:targetId/files',
    capability: 'upload',
    handler: setTargetFiles,
  },

  // The download direction's fetch route: see `routes/downloads.ts`'s
  // module doc for why `capability: null` AND `public: true` together
  // (no Principal resolved at all, not merely an unchecked capability),
  // and `download-store.ts`'s for why the token stands in for that
  // authorization instead. `download.ready.url` is built from this exact
  // path (`ManagedSession`'s `dispatchEffect`, `download.completed` case).
  {
    method: 'GET',
    path: '/v1/downloads/:token',
    capability: null,
    public: true,
    handler: fetchDownload,
  },
];

/**
 * Every other route from the planned REST surface (roughly 60 endpoints):
 * registered, returns 501 with a body naming this build. Capability is
 * `null` for stubs: a stub costs nothing to gate correctly since it never
 * touches anything, and gating it would need a principal resolution this
 * build has no reason to require just to say "not implemented".
 */
export const STUB_PATHS: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'PATCH', path: '/v1/instances/:instanceId' },
  { method: 'GET', path: '/v1/instances/:instanceId/events' },
  { method: 'POST', path: '/v1/instances/:instanceId/recover' },
  { method: 'GET', path: '/v1/sessions' },
  { method: 'DELETE', path: '/v1/sessions/:sessionId' },
  { method: 'GET', path: '/v1/sessions/:sessionId/streams' },
  { method: 'POST', path: '/v1/sessions/:sessionId/notice' },
  { method: 'GET', path: '/v1/sessions/:sessionId/control' },
  { method: 'DELETE', path: '/v1/sessions/:sessionId/control/:targetId' },
  { method: 'POST', path: '/v1/profiles' },
  { method: 'GET', path: '/v1/profiles' },
  { method: 'GET', path: '/v1/profiles/:key' },
  { method: 'DELETE', path: '/v1/profiles/:key' },
  { method: 'POST', path: '/v1/profiles/:key/seed' },
  { method: 'POST', path: '/v1/profiles/:key/snapshots' },
  { method: 'GET', path: '/v1/profiles/:key/snapshots' },
  { method: 'POST', path: '/v1/profiles/:key/restore' },
  { method: 'GET', path: '/v1/profiles/:key/export' },
  { method: 'POST', path: '/v1/profiles/:key/import' },
  { method: 'GET', path: '/v1/profiles/templates' },
  { method: 'POST', path: '/v1/profiles/templates' },
  { method: 'GET', path: '/v1/pools' },
  { method: 'POST', path: '/v1/pools' },
  { method: 'GET', path: '/v1/pools/:poolId' },
  { method: 'PATCH', path: '/v1/pools/:poolId' },
  { method: 'DELETE', path: '/v1/pools/:poolId' },
  { method: 'GET', path: '/v1/pools/:poolId/queue' },
  { method: 'GET', path: '/v1/queue/:queueId' },
  { method: 'GET', path: '/v1/nodes' },
  { method: 'GET', path: '/v1/nodes/:nodeId' },
  { method: 'POST', path: '/v1/nodes/:nodeId/drain' },
  { method: 'POST', path: '/v1/nodes/:nodeId/undrain' },
  { method: 'GET', path: '/v1/topology' },
  { method: 'GET', path: '/v1/admin/audit' },
  { method: 'GET', path: '/v1/admin/quotas' },
  { method: 'GET', path: '/v1/admin/config' },
  { method: 'POST', path: '/v1/admin/preflight' },
  // The five `/v1/upload/*` routes moved from here into `LIVE` a build ago;
  // the fetch side of `/v1/downloads/*` (`GET /v1/downloads/:token`, the
  // signed URL `download.ready.url` actually points at) has now moved the
  // same way. `GET /v1/downloads` (list) and `DELETE /v1/downloads/:downloadId`
  // (an authenticated, capability-gated management API over PAST
  // downloads, part of the planned REST surface) are a different,
  // still unbuilt feature and stay stubs; note that this build's
  // `DownloadStore` never persists a downloadId once its one-shot URL is
  // consumed or swept, so a real implementation of either stub needs a
  // durable `downloads` store row (`@browserglass/protocol`'s
  // `domain/store-types.ts` already declares one), not this staging
  // area, as its backing source.
  { method: 'GET', path: '/v1/downloads' },
  { method: 'DELETE', path: '/v1/downloads/:downloadId' },
];

function compile(routes: readonly RouteSpec[], isStub: boolean): readonly RestRoute[] {
  return routes.map((r) => {
    const { regex, paramNames } = compilePath(r.path);
    return {
      method: r.method,
      pattern: regex,
      paramNames,
      capability: r.capability,
      ...(r.rawBody === true ? { rawBody: true } : {}),
      // Stub routes never touch anything, so they need no principal
      // resolution just to say "not implemented"; a stub is ALWAYS public
      // regardless of `r.public` (which stub entries never set anyway,
      // `ROUTE_TABLE`'s own construction below passes `capability: null`
      // for every one and nothing else). Among `LIVE` routes, `r.public`
      // is the explicit, rare opt-out for the one route
      // (`GET /v1/downloads/:token`) that has to work as an
      // unauthenticated fetch; every other `LIVE` route still defaults to
      // requiring a principal.
      public: isStub || r.public === true,
      handler: isStub
        ? async (_ctx, rctx) => {
            const body = notImplementedBody(`${r.method} ${r.path}`);
            writeError(rctx.res, rctx.requestId, new RestError(501, body.code, body.message));
          }
        : r.handler,
    };
  });
}

const ROUTE_TABLE: readonly RestRoute[] = [
  ...compile(LIVE, false),
  ...compile(
    STUB_PATHS.map((s) => ({ ...s, capability: null, handler: async () => undefined })),
    true,
  ),
];

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new RestError(
        413,
        'E_REQUEST_TOO_LARGE',
        `Request body exceeds limits.maxRequestBodyBytes (${maxBytes}).`,
      );
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RestError(400, 'E_BAD_JSON', 'Request body is not valid JSON.');
  }
}

/**
 * Handles one REST request already known to be under `basePath`. Resolves
 * `subPath` relative to `${basePath}/`. Returns nothing (always writes a
 * response): the caller (`handleRequest`/`rest`/`fetch`) is responsible
 * for the `basePath` prefix check itself.
 */
export async function dispatchRest(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
): Promise<void> {
  const requestId = `req_${randomUUID()}`;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();

  // CORS: answered before anything else, including the shutting-down
  // check below, since a preflight is not a real request against this
  // gateway's state and never should be gated on it. A matched, non
  // preflight request gets its `Access-Control-*` headers set here too,
  // so every response written further down (success or error) already
  // carries them.
  if (handleCorsPreflight(ctx.config, req, res)) return;
  applyCorsHeaders(ctx.config, req, res);

  if (!ctx.isAccepting()) {
    writeError(
      res,
      requestId,
      new RestError(
        503,
        'E_SHUTTING_DOWN',
        'This gateway is shutting down and is no longer accepting requests.',
      ),
    );
    return;
  }

  if (subPath === '/healthz' || subPath === ctx.config.observability.healthPath) {
    handleHealthz(req, res, requestId);
    return;
  }
  if (subPath === '/readyz' || subPath === ctx.config.observability.readyPath) {
    handleReadyz(ctx, res, requestId);
    return;
  }

  const route = ROUTE_TABLE.find((r) => r.method === method && r.pattern.test(subPath));
  if (route === undefined) {
    writeError(
      res,
      requestId,
      new RestError(404, 'E_ROUTE_NOT_FOUND', `No route for ${method} ${subPath}.`),
    );
    return;
  }

  try {
    // A `rawBody` route reads the request stream itself: `readBody` below
    // buffers the whole body, decodes it as UTF-8 and parses it as JSON,
    // all three of which are wrong for binary and any one of which would
    // consume the stream before the handler ever sees it. See
    // `RestRoute.rawBody` and `routes/uploads.ts`'s `readRawBody`.
    const body =
      route.rawBody === true
        ? undefined
        : await readBody(req, ctx.config.limits.maxRequestBodyBytes);

    const principal = route.public
      ? undefined
      : ctx.resolver !== undefined
        ? await principalFor(req, ctx.resolver, {
            allowQueryToken: ctx.config.auth.allowQueryToken,
          })
        : undefined;
    if (!route.public && principal === undefined) {
      throw new RestError(
        401,
        'E_UNAUTHENTICATED',
        'No AuthResolver is configured; every non-public route needs a Principal.',
      );
    }
    if (
      route.capability !== null &&
      principal !== undefined &&
      !principal.caps.includes(route.capability)
    ) {
      throw new RestError(403, 'E_FORBIDDEN', `Missing capability "${route.capability}".`);
    }

    const match = route.pattern.exec(subPath);
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, idx) => {
      params[name] = decodeURIComponent(match?.[idx + 1] ?? '');
    });

    await route.handler(ctx, {
      req,
      res,
      params,
      query: url.searchParams,
      requestId,
      // biome-ignore lint/style/noNonNullAssertion: every non-public route above already required a principal or threw.
      principal: principal!,
      body,
    });
  } catch (err) {
    if (err instanceof RestError) {
      writeError(res, requestId, err);
      return;
    }
    if (err instanceof AuthError) {
      writeError(res, requestId, new RestError(401, err.rejection.code, err.rejection.message));
      return;
    }
    ctx.logger.error(
      { component: 'server', requestId, error: err instanceof Error ? err.message : String(err) },
      'REST handler threw',
    );
    writeError(res, requestId, new RestError(500, 'E_INTERNAL', 'Internal error.'));
  }
}
