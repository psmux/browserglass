import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResolvedConfig } from '../config/types.js';

/**
 * CORS for the REST surface (defect: a `<browser-glass>` widget embedded
 * on a third party page has no way to reach this gateway at all, because
 * nothing here ever wrote a `Access-Control-*` header). Reuses
 * `security.allowedOrigins`, the same field `ws/origin-check.ts`'s WS
 * upgrade path also checks, rather than inventing a second origin list:
 * one gateway, one notion of "who is allowed to talk to me cross origin."
 *
 * `resolve.ts` defaults `allowedOrigins` to `[]` (nothing configured,
 * nothing allowed), so an operator who never set `security.allowedOrigins`
 * or `BGLS_ALLOWED_ORIGINS` gets no CORS headers at all and every cross
 * origin browser request is blocked client side, same as any REST server
 * that never heard of CORS.
 *
 * Unlike the WS side, this module has no same origin bypass to write:
 * a same origin `fetch()` never triggers CORS enforcement in the browser
 * in the first place, whether or not this server sends any
 * `Access-Control-*` header at all, so there is no equivalent regression
 * to guard against here.
 */

/** True when `origin` is allowed to receive CORS headers under `allowedOrigins`. */
function originAllowed(origin: string, allowedOrigins: readonly string[] | '*'): boolean {
  return allowedOrigins === '*' || allowedOrigins.includes(origin);
}

/**
 * Sets `Access-Control-Allow-Origin` (and `Vary: Origin`, and
 * `Access-Control-Allow-Credentials` when `security.corsCredentials` is
 * on) on `res` when `req`'s `Origin` header matches `allowedOrigins`.
 * Does nothing for a same origin request (no `Origin` header) or an
 * origin that is not on the list: an unmatched origin gets no CORS
 * headers at all, so the browser refuses the caller's own read of the
 * response, exactly as if this server had no CORS support for it.
 *
 * Deliberately never emits `Access-Control-Allow-Origin: *`: even when
 * `allowedOrigins` is configured as the literal `'*'`, this echoes the
 * exact requesting origin back instead. Browsers reject `*` combined
 * with `Access-Control-Allow-Credentials: true` outright, and always
 * echoing the real origin means enabling `corsCredentials` never needs a
 * second code path here for the wildcard case.
 */
export function applyCorsHeaders(
  config: ResolvedConfig,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return;
  const { allowedOrigins, corsCredentials } = config.security;
  if (!originAllowed(origin, allowedOrigins)) return;
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (corsCredentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
}

/**
 * Answers a CORS preflight request (`OPTIONS` carrying
 * `Access-Control-Request-Method`) directly, with a bare `200` and an
 * empty JSON body, and returns `true` so the caller (`dispatchRest`)
 * skips route matching and auth entirely for it: a preflight never
 * carries credentials or a body a route handler could act on. Returns
 * `false` for anything else (including a plain `OPTIONS` with no
 * preflight headers, which is not a CORS preflight and falls through to
 * the normal 404/405 handling), so dispatch proceeds as usual.
 *
 * `200 {}` rather than the more conventional `204 No Content`: matches
 * `routes/uploads.ts`'s `deleteUpload`, which documents the same
 * constraint this shares one process with, `rest/fetch-bridge.ts`'s
 * `fetchResponseFromNode` builds a web `Response` from the captured
 * body, and the `Response` constructor throws for any non-null body on a
 * `204`. Being the one code path in this package that answers
 * differently would buy nothing and break the Next.js/Hono adapters that
 * front this same handler.
 *
 * Answers every preflight the same way regardless of whether the origin
 * is actually on `allowedOrigins`, per the Fetch spec: the browser is
 * the one enforcing the result, by checking `Access-Control-Allow-Origin`
 * on this response. `applyCorsHeaders` above is what makes an unmatched
 * origin's preflight carry no such header, so the browser still refuses
 * to send the real request even though this answers 200 either way.
 */
export function handleCorsPreflight(
  config: ResolvedConfig,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if ((req.method ?? '').toUpperCase() !== 'OPTIONS') return false;
  const requestedMethod = req.headers['access-control-request-method'];
  if (typeof requestedMethod !== 'string' || requestedMethod.length === 0) return false;

  applyCorsHeaders(config, req, res);
  const requestedHeaders = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    typeof requestedHeaders === 'string' && requestedHeaders.length > 0
      ? requestedHeaders
      : 'Authorization, Content-Type',
  );
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('content-type', 'application/json');
  res.writeHead(200);
  res.end('{}');
  return true;
}
