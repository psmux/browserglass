import type { BrowserGlass } from '../index.js';
import { compact } from '../util/compact.js';

/**
 * Hono uses the web `Request`/`Response` types, so the BrowserGlass side of
 * the integration is `bg.fetch`, not `bg.rest()`:
 *
 * ```ts
 * app.all('/browserglass/*', (c) => bg.fetch(c.req.raw, { remoteAddress: c.env?.remoteAddress }));
 * ```
 *
 * WebSocket still comes off the raw Node server via `bg.attachUpgrade`,
 * because there is no portable web standard upgrade in Node's Hono
 * adapter (`@hono/node-server`): `serve()` returns a real `node:http`
 * `Server`, and that is what `bg.attachUpgrade` is for.
 * `bg.fetch`'s `{ webSocket }` response path (the way Deno, Bun, and
 * Cloudflare Workers complete a WS upgrade from inside a fetch handler) is
 * v1.1 scope, not v1: {@link honoRoute} throws {@link UpgradeUnsupportedError}
 * if a WS upgrade is attempted through it on Node, naming `attachUpgrade`
 * as the fix.
 */

/** The minimal shape of Hono's request context this module reads. */
export interface HonoContextLike {
  readonly req: { readonly raw: Request };
  readonly env?: { readonly remoteAddress?: string };
}

/**
 * Thrown by {@link honoRoute} when a request looks like a WebSocket
 * upgrade attempt (`Upgrade: websocket`) reaching `bg.fetch()` on Node.
 * `bg.fetch()` only ever answers ordinary HTTP requests in this build;
 * completing a WS handshake from inside a `fetch`-shaped handler is v1.1
 * scope for runtimes with a web standard upgrade story (Deno, Bun,
 * Cloudflare Workers), which Node's Hono adapter does not have.
 */
export class UpgradeUnsupportedError extends Error {
  readonly code = 'E_UPGRADE_UNSUPPORTED' as const;
  constructor() {
    super(
      'WebSocket upgrades cannot be completed through bg.fetch() on Node. ' +
        'Wire bg.attachUpgrade(server, opts) onto the raw http.Server behind this framework instead ' +
        "(the server @hono/node-server's serve() returns).",
    );
    this.name = 'UpgradeUnsupportedError';
  }
}

/**
 * Builds the one Hono route handler the example above mounts at
 * `app.all('/browserglass/*', ...)`: forwards every matching request to
 * `bg.fetch`, carrying `ctx.env?.remoteAddress` through as
 * `FetchContext.remoteAddress`. Throws {@link UpgradeUnsupportedError} for
 * a request that looks like a WebSocket upgrade attempt, since `bg.fetch`
 * cannot complete one on Node; see this module's top level documentation.
 */
export function honoRoute(bg: BrowserGlass): (c: HonoContextLike) => Promise<Response> {
  return async (c: HonoContextLike): Promise<Response> => {
    if (c.req.raw.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      throw new UpgradeUnsupportedError();
    }
    return bg.fetch(c.req.raw, compact({ remoteAddress: c.env?.remoteAddress }));
  };
}
