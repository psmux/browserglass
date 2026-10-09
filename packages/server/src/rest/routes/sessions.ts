import { RestError, writeJson } from '../errors.js';
import type { RestContext, RestHandler } from '../types.js';

function requireStore(ctx: RestContext): NonNullable<RestContext['store']> {
  if (ctx.store === undefined) {
    throw new RestError(503, 'E_STORE_UNAVAILABLE', 'No store is configured on this gateway.');
  }
  return ctx.store;
}

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RestError(400, 'E_MISSING_PARAM', `${name} is required.`);
  return value;
}

/** `GET /v1/sessions/:sessionId`, capability `view`. */
export const getSession: RestHandler = async (ctx, rctx) => {
  const store = requireStore(ctx);
  const sessionId = requireParam(rctx.params, 'sessionId');
  const row = await store.getSession(rctx.principal.tenantId, sessionId);
  if (row === null) throw new RestError(404, 'E_SESSION_NOT_FOUND', `No session "${sessionId}".`);
  writeJson(rctx.res, rctx.requestId, row);
};

/** `GET /v1/sessions/:sessionId/viewers`, capability `view`. */
export const listSessionViewers: RestHandler = async (ctx, rctx) => {
  const store = requireStore(ctx);
  const sessionId = requireParam(rctx.params, 'sessionId');
  const session = await store.getSession(rctx.principal.tenantId, sessionId);
  if (session === null)
    throw new RestError(404, 'E_SESSION_NOT_FOUND', `No session "${sessionId}".`);
  const viewers = await store.listViewers(rctx.principal.tenantId, sessionId);
  writeJson(rctx.res, rctx.requestId, viewers);
};
