/**
 * `bgls token`: print a bearer token for the gateway this directory's
 * `bgls serve` started, so the REST calls the root README and
 * `docs/quickstart.md` document can actually be run by hand.
 *
 * Those documents tell a reader to send `authorization: Bearer
 * $ADMIN_TOKEN` to `POST /browserglass/v1/instances` and `POST
 * /browserglass/v1/tokens`, and until this command existed there was no
 * way to get that value. `dev-session.json` holds the dev signing KEY,
 * not a token, and every other command mints its own token in-process
 * and never shows it. This command exposes the one step that was
 * missing: it resolves the gateway exactly the way `doctor`, `inspect`
 * and `instances *` do (`resolveGatewayConnection`), then prints the
 * token that resolution produced.
 *
 * Plain output is the bare token on stdout and nothing else, so
 * `TOKEN=$(pnpm bgls token)` works in a shell. Everything a human would
 * want to read (which endpoint it resolved against, when the token
 * expires) goes to stderr, and `--json` carries the same facts as data.
 * `Printer.info()` is deliberately not used for that note: `consola`
 * writes info lines to stdout, which would put text in front of the
 * token and break command substitution.
 *
 * A `bgls token mint|verify|decode|revoke` sub-surface is not implemented
 * in this build. It used to
 * be registered here as a stub group (see `commands/stubs.ts`), and that
 * group is what made a bare `bgls token` print a usage error instead of
 * a token. `citty` runs a parent command's own `run` in addition to any
 * matched sub-command, and it treats the first non-flag argument as a
 * sub-command name, so `--ttl 900` would be read as a sub-command called
 * `900`. A leaf command is the only shape that gives a bare `bgls token`
 * and a `--ttl` value at the same time.
 */

import { defineCommand } from 'citty';
import {
  GLOBAL_ARGS,
  type ParsedGlobalArgs,
  resolveGatewayConnection,
  resolveGlobalFlags,
} from '../context.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

/**
 * Below this lifetime the server jti-replay-checks the token on every
 * authenticated request that presents it (`JTI_REPLAY_CEILING_SEC` in
 * `packages/server/src/auth/verify.ts`), so a token minted this short is
 * good for one call and the second call fails `E_TOKEN_REPLAYED`. This
 * is why `mintLocalAdminToken`'s default TTL is 600s; see its doc
 * comment for the full reasoning.
 */
const JTI_REPLAY_CEILING_SEC = 300;

/** The `exp` claim of a JWT, in epoch seconds, or `null` when the token is not a readable JWT (an operator-supplied `--token` need not be one). */
function readExpiry(jwt: string): number | null {
  const payload = jwt.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      readonly exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

/** What `--json` emits: the token, and enough about the gateway to know where to send it. */
interface TokenResult {
  readonly token: string;
  readonly endpoint: string;
  readonly basePath: string;
  readonly wsUrl: string;
  /** Epoch seconds, from the token's own `exp` claim. `null` when it could not be read. */
  readonly expiresAt: number | null;
}

/** `bgls token`. */
export const tokenCommand = defineCommand({
  meta: {
    name: 'token',
    description:
      'Print a bearer token for the gateway "bgls serve" started here. Plain output is the bare token, so TOKEN=$(bgls token) works.',
  },
  args: {
    ...GLOBAL_ARGS,
    ttl: {
      type: 'string',
      description: `Token lifetime in seconds. Default 600. The gateway caps this at 900 and rejects anything larger, so this command rejects it too rather than quietly clamping. Below ${JTI_REPLAY_CEILING_SEC} the token is replay-checked and only good for one request. Ignored when --token or BGLS_ADMIN_TOKEN already supplies a token.`,
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);

    const ttlRaw = args['ttl'] as string | undefined;
    let ttlSeconds: number | undefined;
    if (ttlRaw !== undefined) {
      ttlSeconds = Number(ttlRaw);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
        printer.error(`--ttl must be a positive integer number of seconds, got "${ttlRaw}".`);
        process.exitCode = EXIT_CODES.usageError;
        return;
      }
    }

    let result: TokenResult;
    try {
      // `mintLocalAdminToken` throws `E_TTL_TOO_LONG` past the 900s cap;
      // that is a bad flag value, so it lands on `usageError` with the
      // same handling as a missing `dev-session.json`, which is the
      // `BglsExit` `resolveGatewayConnection` raises for itself.
      const connection = await resolveGatewayConnection(
        flags,
        ttlSeconds !== undefined ? { ttlSeconds } : undefined,
      );
      result = {
        token: connection.token,
        endpoint: connection.endpoint,
        basePath: connection.basePath,
        wsUrl: connection.wsUrl,
        expiresAt: readExpiry(connection.token),
      };
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    if (
      !flags.json &&
      !flags.quiet &&
      ttlSeconds !== undefined &&
      ttlSeconds <= JTI_REPLAY_CEILING_SEC
    ) {
      printer.warn(
        `--ttl ${ttlSeconds} is at or below the ${JTI_REPLAY_CEILING_SEC}s replay ceiling: this token is good for one request, then the gateway answers E_TOKEN_REPLAYED.`,
      );
    }

    printer.result(result, (r) => {
      if (!flags.quiet) {
        const expiry =
          r.expiresAt === null ? '' : `, expires ${new Date(r.expiresAt * 1000).toISOString()}`;
        process.stderr.write(`token for ${r.endpoint}${r.basePath}${expiry}\n`);
      }
      process.stdout.write(`${r.token}\n`);
    });
  },
});
