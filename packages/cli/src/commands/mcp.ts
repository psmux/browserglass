/**
 * `bgls mcp`: the real launch path for `@browserglass/automation`'s MCP
 * server (`createAutomationMcpServer()`, `packages/automation/src/mcp/server.ts`).
 * That server has a genuinely complete 39 tool manifest
 * (`bg_status` through `bg_swarm_run`), but nothing in this repo ever
 * connected a transport to it or gave a newcomer a way to launch it short
 * of writing their own Node bootstrap. This command is that bootstrap,
 * shipped: it constructs the server, wires the SDK's own
 * `StdioServerTransport`, and connects it, so an MCP client (Claude
 * Desktop, Claude Code, any MCP-speaking agent host) can spawn
 * `bgls mcp` as a subprocess directly.
 *
 * Reuses the exact plumbing `swarm.ts`'s `swarm run` already established,
 * rather than reinventing it:
 *
 *  - `resolveGatewayConnection` (`context.ts`) for locating the gateway:
 *    an explicit `--endpoint`/`--token` pair (or their `BGLS_ENDPOINT`/
 *    `BGLS_ADMIN_TOKEN` env vars), or a `dev-session.json` written by a
 *    `bgls serve` started from this same directory, which mints a fresh
 *    admin token locally. Either way this command ends up with a REST
 *    base URL and a bearer token good enough to mint further, narrower
 *    tokens from, exactly the "token-minting REST base URL" case.
 *  - `buildAcquireRequest`/`waitForInstanceReady`/`mintInstanceToken`
 *    (`util/drive.ts`) to open one instance up front (unless
 *    `--instance-id` names an existing one) and bind the server's
 *    single-target tools (`bg_status`, `bg_click`, ...) to it.
 *  - The same acquire-per-member function shape `swarm run` hands
 *    `BrowserSwarm.open()`, handed here to `AutomationMcpServerOptions
 *    .swarm.acquire` instead, so `bg_swarm_open`/`bg_swarm_grow` mint as
 *    many further browsers as an agent asks for, on demand.
 *
 * MCP over stdio is a strict framing: stdout carries JSON-RPC only, once
 * `transport.start()` (inside `server.connect()`) takes it over. Every
 * diagnostic line this command prints therefore goes to `process.stderr`
 * directly, never through `Printer` (which writes JSON results to stdout
 * in `--json` mode, and would corrupt the stream either way).
 */

import { createAutomationMcpServer } from '@browserglass/automation';
import type {
  AutomationClient,
  SwarmAcquireContext,
  SwarmAcquireResult,
} from '@browserglass/automation';
import type { Capability } from '@browserglass/protocol';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defineCommand } from 'citty';
import {
  GLOBAL_ARGS,
  type GatewayConnection,
  type ParsedGlobalArgs,
  resolveGatewayConnection,
  resolveGlobalFlags,
} from '../context.js';
import {
  AFFINITY_ARGS,
  DRIVING_CAPS,
  buildAcquireRequest,
  connectAutomation,
  mintInstanceToken,
  parseAffinityArgs,
  waitForInstanceReady,
  withLease,
} from '../util/drive.js';
import { EXIT_CODES } from '../util/exit.js';
import { restCall } from '../util/rest.js';

/**
 * `DRIVING_CAPS` plus `evaluate`. More than half the manifest
 * (`bg_evaluate`, `bg_resolve`, `bg_wait_for`, `bg_wait_for_text`,
 * `bg_get_text`, `bg_fill`, `bg_select`, and `bg_read_page`, which is
 * built on `AutomationClient.text()`, itself built on evaluate) needs the
 * `evaluate` capability, and it is deliberately absent from every role
 * bundle (`packages/protocol/src/wire/capabilities.ts`'s own doc comment
 * on why), so it has to be asked for by name here, or an agent driving
 * through a server launched this way would find most of the manifest
 * answering POLICY_DENIED before it ever tried anything. `POST /v1/tokens`
 * still narrows this to whatever the resolved connection's own principal
 * actually holds, so this is a ceiling this command asks for, not a
 * guarantee it grants.
 */
const MCP_CAPS: readonly Capability[] = [...DRIVING_CAPS, 'evaluate'];

/** Writes one diagnostic line to stderr, never stdout: see this file's module doc for why. */
function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description:
      "Serve @browserglass/automation's MCP server (39 tools, including bg_page_map for a whole page indexed map and bg_swarm_open/list/grow/shrink/close/run for parallel browsers) over stdio, for an MCP client to spawn as a subprocess.",
  },
  args: {
    ...GLOBAL_ARGS,
    'instance-id': {
      type: 'string',
      description:
        "Bind the server's default target (what bg_status/bg_click/... act on with no swarmId) to this already-running instance instead of opening a new one.",
    },
    pool: {
      type: 'string',
      description:
        'Pool id, both for the instance opened at startup and for every instance bg_swarm_open/bg_swarm_grow later mints. Default "default". Ignored with --instance-id.',
    },
    'profile-key': {
      type: 'string',
      description:
        'Persistent profile key for the instance opened at startup. Ignored with --instance-id. Not applied to later bg_swarm_open/bg_swarm_grow members: give those a subject through the tool call itself instead.',
    },
    headless: {
      type: 'boolean',
      description:
        'Launch headless or headful. Applies to the instance opened at startup and to every later bg_swarm_open/bg_swarm_grow member. Omit to use the pool default.',
    },
    viewport: {
      type: 'string',
      description:
        'WxH, e.g. 1440x900. Applies to the instance opened at startup and to every later bg_swarm_open/bg_swarm_grow member.',
    },
    ...AFFINITY_ARGS,
    url: {
      type: 'string',
      description: 'Navigate the bound instance here once the server is up, before serving.',
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);

    let connection: GatewayConnection;
    try {
      connection = await resolveGatewayConnection(flags);
    } catch (err) {
      logStderr(`bgls mcp: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    let affinity: ReturnType<typeof parseAffinityArgs>;
    try {
      affinity = parseAffinityArgs(args as Record<string, unknown>);
    } catch (err) {
      logStderr(`bgls mcp: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    const acquireFlags = {
      pool: args['pool'] as string | undefined,
      profileKey: args['profile-key'] as string | undefined,
      headless: args['headless'] as boolean | undefined,
      viewport: args['viewport'] as string | undefined,
    };

    const explicitInstanceId = args['instance-id'] as string | undefined;
    let boundInstanceId: string;
    if (explicitInstanceId !== undefined) {
      boundInstanceId = explicitInstanceId;
    } else {
      try {
        const body = buildAcquireRequest(
          {
            ...acquireFlags,
            stickySubject: affinity.stickySubject,
            stickyWithinMs: affinity.stickyWithinMs,
          },
          `bgls-mcp-${Date.now()}`,
        );
        const acquired = await restCall<{ instanceId: string }>(
          connection,
          'POST',
          '/v1/instances',
          body,
        );
        await waitForInstanceReady(connection, acquired.instanceId);
        boundInstanceId = acquired.instanceId;
      } catch (err) {
        logStderr(
          `bgls mcp: failed to open the initial instance: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = EXIT_CODES.operationalFailure;
        return;
      }
    }

    let client: AutomationClient;
    try {
      client = await connectAutomation(connection, boundInstanceId, { caps: MCP_CAPS });
    } catch (err) {
      logStderr(
        `bgls mcp: failed to connect the bound instance ${boundInstanceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = EXIT_CODES.operationalFailure;
      return;
    }

    const url = args['url'] as string | undefined;
    if (url !== undefined) {
      try {
        await withLease(client, () => client.navigate(url));
      } catch (err) {
        logStderr(
          `bgls mcp: initial navigate to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Handed to `AutomationMcpServerOptions.swarm.acquire`: the same
    // shape `swarm run`'s own `acquire()` uses (see `swarm.ts`'s module
    // doc), one fresh instance and one fresh, narrowly-capable token per
    // call, so `bg_swarm_open`/`bg_swarm_grow` can mint as many browsers
    // as an agent asks for without this command pre-provisioning any of
    // them.
    let memberSeq = 0;
    const acquire = async (
      _index: number,
      ctx: SwarmAcquireContext,
    ): Promise<SwarmAcquireResult> => {
      const body = buildAcquireRequest(
        { ...acquireFlags, stickySubject: ctx.subject, stickyWithinMs: ctx.stickyWithinMs },
        `bgls-mcp-swarm-${Date.now()}-${memberSeq++}`,
      );
      const acquired = await restCall<{ instanceId: string }>(
        connection,
        'POST',
        '/v1/instances',
        body,
      );
      await waitForInstanceReady(connection, acquired.instanceId);
      const token = await mintInstanceToken(connection, acquired.instanceId, MCP_CAPS);
      return { instanceId: acquired.instanceId, wsUrl: connection.wsUrl, token };
    };

    const server = createAutomationMcpServer({ client, swarm: { acquire } });
    // `createAutomationMcpServer` already sets `onclose` to close every
    // swarm this server opened; chain onto that rather than overwrite it
    // (its own doc comment says so), so the bound client is released too
    // once the MCP client disconnects the stdio transport.
    const priorOnClose = server.onclose;
    server.onclose = () => {
      priorOnClose?.();
      client.close();
    };

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logStderr(
      `bgls mcp: serving over stdio; bound target ${client.targetId} on instance ${boundInstanceId} at ${connection.endpoint}.`,
    );

    // Keep the process alive until the MCP client disconnects the stdio
    // transport (server.onclose above then fires) or this process is
    // killed. Mirrors `bgls serve`'s own never-resolving promise.
    await new Promise<void>(() => undefined);
  },
});
