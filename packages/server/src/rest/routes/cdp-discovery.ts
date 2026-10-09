/**
 * `GET /json/version` and `GET /json/list`, the two HTTP discovery
 * endpoints a real CDP client library probes before it ever opens a
 * WebSocket (Playwright's `chromium.connect_over_cdp('http://...')` and
 * Puppeteer's `puppeteer.connect({ browserURL })` both fetch `/json/version`
 * first for `webSocketDebuggerUrl`; some tooling calls `/json/list`
 * instead). Handled OUTSIDE `dispatchRest`'s own `ROUTE_TABLE`
 * (`rest/router.ts`), and called directly from `src/index.ts`'s
 * `handleRequest`, for the same reason `/healthz`/`/readyz` are: a bare
 * CDP client always requests these two paths at the origin root,
 * regardless of `basePath`, never with any prefix a caller could be
 * expected to know to add.
 *
 * Gated exactly like the WebSocket proxy itself
 * (`ws/cdp-upgrade.ts`): behind `security.cdpProxyEnabled` (404 when off,
 * so a disabled gateway looks like it has no such route at all, not like
 * a broken one) and the `cdp` capability, resolved the same way every
 * other REST route resolves a principal.
 *
 * One deliberate departure from stock CDP: real Chrome answers
 * `/json/version` for "the browser", singular, because a debug port only
 * ever fronts one. BrowserGlass multiplexes many instances behind one
 * gateway, so there is no "the browser" to describe without being told
 * which one; both routes below require an explicit `?instanceId=`
 * query parameter and refuse with `E_MISSING_PARAM` otherwise, rather
 * than guessing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '@browserglass/protocol';
import { AuthError, principalFor } from '../../auth/resolver.js';
import { RestError, writeError, writeJson } from '../errors.js';
import type { RestContext } from '../types.js';

/** Which of the two discovery routes a request is asking for. */
export type CdpDiscoveryKind = 'version' | 'list';

/**
 * Builds the `ws://`/`wss://` URL this proxy answers a client's discovery
 * request with, derived from THIS request's own scheme and host, never
 * from the instance's real `cdpWsUrl`. That field never leaves this
 * gateway over REST: `GET /v1/instances/:instanceId` and
 * `GET /v1/instances` used to hand it straight to any `view` capable
 * caller (found in a security audit; `../redact.ts`'s own doc comment has
 * the full argument and the exploit it closed), so this comment's claim
 * is enforced by `redactInstance`/`redactInstanceView` now, not merely by
 * this route declining to build the URL from it. `x-forwarded-proto`
 * is honoured the same way a reverse proxied deployment already expects
 * `publicUrl`/`trustProxy` handling to (this route does not consult
 * `resolved.trustProxy` itself, since a forged `x-forwarded-proto` here
 * only ever changes `ws` vs `wss` in a URL string the caller already knows
 * the real scheme of from the request it just made).
 */
function webSocketDebuggerUrl(
  req: IncomingMessage,
  cdpProxyPath: string,
  instanceId: string,
): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto =
    typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim() : undefined;
  const isTls =
    proto === 'https' ||
    proto === 'wss' ||
    (req.socket as { encrypted?: boolean }).encrypted === true;
  const host = req.headers.host ?? 'localhost';
  return `${isTls ? 'wss' : 'ws'}://${host}${cdpProxyPath}/${encodeURIComponent(instanceId)}`;
}

/**
 * Handles one `GET /json/version` or `GET /json/list` request. `cdpProxyPath`
 * is `resolved.cdpProxyPath` (`${basePath}/cdp`), passed in by
 * `src/index.ts` rather than read off `ctx.config` a second time, so this
 * function's own signature makes the dependency explicit.
 */
export async function handleCdpDiscovery(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  kind: CdpDiscoveryKind,
  cdpProxyPath: string,
  requestId: string,
): Promise<void> {
  if (!ctx.config.security.cdpProxyEnabled) {
    writeError(
      res,
      requestId,
      new RestError(404, 'E_ROUTE_NOT_FOUND', `No route for GET /json/${kind}.`),
    );
    return;
  }
  if (ctx.resolver === undefined) {
    writeError(
      res,
      requestId,
      new RestError(
        401,
        'E_UNAUTHENTICATED',
        'No AuthResolver is configured; every non-public route needs a Principal.',
      ),
    );
    return;
  }

  let principal: Principal;
  try {
    principal = await principalFor(req, ctx.resolver, {
      allowQueryToken: ctx.config.auth.allowQueryToken,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      writeError(res, requestId, new RestError(401, err.rejection.code, err.rejection.message));
      return;
    }
    throw err;
  }

  if (!principal.caps.includes('cdp')) {
    writeError(res, requestId, new RestError(403, 'E_FORBIDDEN', 'Missing capability "cdp".'));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const instanceId = url.searchParams.get('instanceId');
  if (instanceId === null || instanceId.length === 0) {
    writeError(
      res,
      requestId,
      new RestError(
        400,
        'E_MISSING_PARAM',
        'instanceId query parameter is required. Unlike a bare Chrome debug port, this gateway multiplexes many instances, so /json/version and /json/list cannot answer for "the browser" without knowing which one.',
      ),
    );
    return;
  }

  const router = ctx.getRouter();
  if (router === undefined) {
    writeError(
      res,
      requestId,
      new RestError(
        503,
        'E_ROUTER_UNAVAILABLE',
        'This gateway has no local router (mode is "gateway" without a control plane connection).',
      ),
    );
    return;
  }

  let title: string;
  try {
    const view = await router.describe(instanceId, principal);
    title = `BrowserGlass instance ${view.instance.id}`;
  } catch (err) {
    const httpStatus =
      err !== null &&
      typeof err === 'object' &&
      'httpStatus' in err &&
      typeof (err as { httpStatus: unknown }).httpStatus === 'number'
        ? (err as { httpStatus: number }).httpStatus
        : 404;
    const code =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'E_INSTANCE_NOT_FOUND';
    const message = err instanceof Error ? err.message : `instance ${instanceId} not found.`;
    writeError(res, requestId, new RestError(httpStatus, code, message));
    return;
  }

  const wsUrl = webSocketDebuggerUrl(req, cdpProxyPath, instanceId);

  if (kind === 'version') {
    writeJson(res, requestId, {
      Browser: title,
      'Protocol-Version': '1.3',
      'User-Agent': 'BrowserGlass CDP proxy',
      'V8-Version': '',
      'WebKit-Version': '',
      webSocketDebuggerUrl: wsUrl,
    });
    return;
  }

  // `kind === 'list'`: one entry, the browser-level attach point this
  // proxy exposes. A real driver enumerates PAGES by sending
  // `Target.getTargets` over the WebSocket connection itself once
  // attached (exactly what `Target.attachToTarget` is for), so this route
  // does not attempt to re-derive that list over HTTP; it exists only so
  // a tool that reads `/json/list` before opening any socket finds
  // something there.
  writeJson(res, requestId, [
    {
      id: instanceId,
      type: 'browser',
      title,
      description: '',
      url: '',
      webSocketDebuggerUrl: wsUrl,
    },
  ]);
}
