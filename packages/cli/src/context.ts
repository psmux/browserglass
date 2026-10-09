/**
 * Global flags shared by every `bgls` command: `--config`, `--endpoint`, `--token`, `--json`,
 * `--quiet`/`--verbose`, `--no-color`, `--profile`. `citty` does not
 * inherit a root command's `args` onto its sub-commands, so every command
 * defined in `commands/**` spreads {@link GLOBAL_ARGS} into its own `args`
 * and calls {@link resolveGlobalFlags} on the parsed result.
 */

import type { ArgsDef } from 'citty';
import { mintLocalAdminToken } from './dev-key.js';
import { defaultDataDir, readDevSession } from './session-file.js';
import { compact } from './util/compact.js';
import { BglsExit, EXIT_CODES } from './util/exit.js';
import type { GlobalFlags } from './util/output.js';

/** The `citty` `args` fragment every command spreads in to get the eight global flags. */
export const GLOBAL_ARGS = {
  config: {
    type: 'string',
    description: 'Path to bgls.config.{ts,js,mjs,json,toml}.',
  },
  endpoint: {
    type: 'string',
    description: 'Gateway base URL, e.g. http://127.0.0.1:7443. Env BGLS_ENDPOINT.',
  },
  token: {
    type: 'string',
    description: 'Admin bearer JWT. Env BGLS_ADMIN_TOKEN.',
  },
  json: {
    type: 'boolean',
    description: 'Machine-readable JSON output.',
    default: false,
  },
  quiet: {
    type: 'boolean',
    description: 'Suppress non-essential output.',
    default: false,
  },
  verbose: {
    type: 'boolean',
    description: 'Verbose diagnostic output.',
    default: false,
  },
  'no-color': {
    type: 'boolean',
    description: 'Disable ANSI color output.',
    default: false,
  },
  profile: {
    type: 'string',
    description: 'Named config profile to apply from bgls.config.',
  },
} satisfies ArgsDef;

/** The shape every command's parsed `args` has, after spreading {@link GLOBAL_ARGS} in. */
export interface ParsedGlobalArgs {
  readonly config?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly 'no-color'?: boolean;
  readonly profile?: string;
}

/** Reads the eight global flags out of a parsed `citty` args object, applying the `BGLS_*` environment fallbacks the surface listing documents. */
export function resolveGlobalFlags(args: ParsedGlobalArgs): GlobalFlags {
  return {
    ...compact({
      config: args.config,
      endpoint: args.endpoint ?? process.env['BGLS_ENDPOINT'],
      token: args.token ?? process.env['BGLS_ADMIN_TOKEN'],
      profile: args.profile,
    }),
    json: args.json ?? false,
    quiet: args.quiet ?? false,
    verbose: args.verbose ?? false,
    noColor: args['no-color'] ?? process.env['NO_COLOR'] !== undefined,
  };
}

/** A resolved gateway connection: where it is, and a bearer token good enough to call it with. */
export interface GatewayConnection {
  readonly endpoint: string;
  readonly wsUrl: string;
  readonly token: string;
  /** REST routes live under `${basePath}/v1/*`, never bare `/v1/*` (`packages/server/src/index.ts`'s `handleRequest`). Default `/browserglass` when no session file confirms the real one. */
  readonly basePath: string;
}

/**
 * Resolves how a command should reach a gateway: explicit `--endpoint`/
 * `--token` (or their env vars) win outright; otherwise this looks for a
 * `dev-session.json` written by a `bgls serve` started from this same
 * directory (see `session-file.ts`) and mints a fresh admin token locally
 * from its dev signing key. Throws {@link BglsExit} with `usageError` when
 * neither source yields an endpoint.
 *
 * `opts.ttlSeconds` overrides the minted token's lifetime. Only `bgls
 * token` passes it, because only that command hands the token to someone
 * who will use it later; every other command mints one per invocation and
 * spends it immediately, so the 600s default in `mintLocalAdminToken` is
 * what they want. It has no effect when `flags.token` supplies the token.
 */
export async function resolveGatewayConnection(
  flags: GlobalFlags,
  opts?: { readonly ttlSeconds?: number },
): Promise<GatewayConnection> {
  const session = readDevSession(defaultDataDir());
  const matchingSession =
    session !== null && (flags.endpoint === undefined || session.endpoint === flags.endpoint)
      ? session
      : null;

  if (flags.endpoint !== undefined) {
    if (flags.token !== undefined) {
      const wsUrl = matchingSession?.wsUrl ?? defaultWsUrl(flags.endpoint);
      const basePath = matchingSession?.basePath ?? '/browserglass';
      return { endpoint: flags.endpoint, wsUrl, token: flags.token, basePath };
    }
    // An explicit endpoint with no token still tries the session file for
    // a matching endpoint before giving up, so `--endpoint` alone works
    // against a gateway this same machine started.
    if (matchingSession !== null) {
      const token = await mintLocalAdminToken(matchingSession, opts);
      return {
        endpoint: flags.endpoint,
        wsUrl: matchingSession.wsUrl,
        token,
        basePath: matchingSession.basePath,
      };
    }
    throw new BglsExit(
      EXIT_CODES.usageError,
      '--endpoint was given with no --token (or BGLS_ADMIN_TOKEN) and no matching dev-session.json was found. Pass --token, or run this against a gateway started by "bgls serve" from this directory.',
    );
  }

  if (session === null) {
    throw new BglsExit(
      EXIT_CODES.usageError,
      'No --endpoint given and no dev-session.json found under ./bgls-data. Pass --endpoint (and --token), or run this from the directory "bgls serve" was started in.',
    );
  }
  const token = flags.token ?? (await mintLocalAdminToken(session, opts));
  return { endpoint: session.endpoint, wsUrl: session.wsUrl, token, basePath: session.basePath };
}

/** `ws(s)://host:port/browserglass/socket`: the default basePath/wsPath, used only when no session file confirms the real one. */
function defaultWsUrl(endpoint: string): string {
  return `${endpoint.replace(/^http/, 'ws')}/browserglass/socket`;
}
