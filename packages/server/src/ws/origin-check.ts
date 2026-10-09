import type { IncomingMessage } from 'node:http';

/**
 * The WS upgrade path's `Origin` check (`src/index.ts`'s `handleUpgrade`
 * calls this before `ws/upgrade.ts` ever runs), kept in its own module so
 * the two policies sharing `security.allowedOrigins` (this one, and REST
 * CORS in `rest/cors.ts`) each have their own doc comment explaining why
 * they read the same list differently, rather than one comment trying to
 * cover both.
 *
 * A browser is the only kind of caller that ever sends an `Origin` header
 * on a WebSocket handshake in the first place (`fetch`/`XMLHttpRequest`/
 * `WebSocket` all set it unconditionally; nothing else does). So:
 *
 * * No `Origin` header at all: not a browser. The CLI, MCP, the Python
 *   client, and any server-to-server automation client all connect this
 *   way, and none of them has an origin to check against anything. Always
 *   allowed; `security.allowedOrigins` is never consulted.
 * * An `Origin` header whose host matches the `Host` header this request
 *   itself arrived on: a browser page served BY this gateway, connecting
 *   back to its own origin. Also always allowed with zero configuration,
 *   the same way a same origin `fetch()` needs no CORS header from any
 *   server anywhere; requiring an operator to allowlist a gateway's own
 *   origin against itself would make the zero-config path 403 by default,
 *   which is the regression this module exists to prevent (a real
 *   deployment's own page failed exactly this way when an earlier version
 *   of this check consulted `allowedOrigins` unconditionally).
 * * An `Origin` header naming a DIFFERENT host: a genuinely cross origin
 *   browser request. This is the one case `security.allowedOrigins`
 *   actually gates, default `[]`, so an operator has to opt a foreign
 *   origin in explicitly, exactly like REST CORS.
 */
export interface UpgradeOriginCheck {
  readonly allowed: boolean;
  /** Only set when `allowed` is `false`: names the offending origin and the config key to set, for the 403 body. */
  readonly message?: string;
}

/** The `Origin` header's host, or `null` when there is none or it does not parse as a URL. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Checks `req`'s `Origin` header (if any) against `allowedOrigins`, per
 * this module's own doc comment: no header, or a header matching this
 * request's own `Host`, always passes; a genuinely different origin needs
 * to be on `allowedOrigins` (or `allowedOrigins` must be the literal
 * `'*'`, an explicit "allow every origin" opt in).
 */
export function checkUpgradeOrigin(
  req: IncomingMessage,
  allowedOrigins: readonly string[] | '*',
): UpgradeOriginCheck {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return { allowed: true };

  const reqHost = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : null;
  const originHostname = originHost(origin);
  if (reqHost !== null && originHostname !== null && originHostname === reqHost) {
    return { allowed: true };
  }

  if (allowedOrigins === '*' || allowedOrigins.includes(origin)) return { allowed: true };

  return {
    allowed: false,
    message: `Origin "${origin}" is not allowed to open a WebSocket connection to this gateway. Add it to security.allowedOrigins (or the BGLS_ALLOWED_ORIGINS env var) to allow it.`,
  };
}
