import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeJson } from '../errors.js';
import type { RestContext } from '../types.js';

/** `GET /healthz`. Always unauthenticated, always `{ ok: true }` once the process is up. */
export function handleHealthz(_req: IncomingMessage, res: ServerResponse, requestId: string): void {
  writeJson(res, requestId, { ok: true });
}

/**
 * `GET /readyz`. Always unauthenticated. 503 until `start()` has resolved
 * and at least one node is ready; 200 with a small status report after.
 */
export function handleReadyz(ctx: RestContext, res: ServerResponse, requestId: string): void {
  const ready = ctx.isReady();
  writeJson(
    res,
    requestId,
    {
      ok: ready,
      accepting: ctx.isAccepting(),
      mode: ctx.config.mode,
    },
    ready ? 200 : 503,
  );
}
