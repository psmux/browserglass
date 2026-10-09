/**
 * `bgls inspect [instanceId]`. Connects over REST,
 * prints the instance, session, target, stream, and lease tree.
 * `--follow` tails the control channel as a Viewer with `caps: ['view']`.
 */

import { decodeBinaryHeader } from '@browserglass/protocol';
import type { InstanceView } from '@browserglass/router';
import { defineCommand } from 'citty';
import {
  GLOBAL_ARGS,
  type GatewayConnection,
  resolveGatewayConnection,
  resolveGlobalFlags,
} from '../context.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';
import { RestClientError, restCall } from '../util/rest.js';

interface SessionRowLike {
  readonly id: string;
  readonly state: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly peakViewers: number;
}

interface ViewerLike {
  readonly id: string;
  readonly subject: string;
  readonly state: string;
  readonly capabilities?: readonly string[];
  readonly heldLeases?: readonly string[] | { size: number };
}

interface InstanceTree {
  readonly instance: InstanceView['instance'];
  readonly live: InstanceView['live'];
  readonly session: SessionRowLike | null;
  readonly viewers: readonly ViewerLike[];
}

async function buildTree(connection: GatewayConnection, view: InstanceView): Promise<InstanceTree> {
  const instance = view.instance;
  let session: SessionRowLike | null = null;
  let viewers: readonly ViewerLike[] = [];
  if (instance.sessionId !== null) {
    try {
      session = await restCall<SessionRowLike>(
        connection,
        'GET',
        `/v1/sessions/${instance.sessionId}`,
      );
      viewers = await restCall<ViewerLike[]>(
        connection,
        'GET',
        `/v1/sessions/${instance.sessionId}/viewers`,
      );
    } catch (err) {
      if (!(err instanceof RestClientError && err.status === 404)) throw err;
    }
  }
  return { instance, live: view.live, session, viewers };
}

function heldLeaseCount(heldLeases: ViewerLike['heldLeases']): number {
  if (heldLeases === undefined) return 0;
  return 'size' in heldLeases ? heldLeases.size : heldLeases.length;
}

function printTreeHuman(printer: Printer, tree: InstanceTree): void {
  const i = tree.instance;
  printer.info(`instance ${i.id}  [${i.state}]  pool=${i.poolId ?? '-'}  node=${i.nodeId ?? '-'}`);
  printer.info(`  profile   ${i.profileId ?? '(none)'}`);
  printer.info(
    `  spec      engine=${i.spec.engine} channel=${i.spec.channel} headless=${i.spec.headless}`,
  );
  printer.info(`  lifetime  ${i.lifetime}, acquired=${new Date(i.acquiredAt).toISOString()}`);
  if (tree.live !== null) {
    printer.info(
      `  live      viewers=${tree.live.viewers} streams=${tree.live.streams} lastActivity=${new Date(tree.live.lastActivityAt).toISOString()}`,
    );
  } else {
    printer.info('  live      (no live session data)');
  }
  if (tree.session !== null) {
    printer.info(
      `  session ${tree.session.id}  [${tree.session.state}]  peakViewers=${tree.session.peakViewers}`,
    );
    if (tree.viewers.length === 0) {
      printer.info('    viewers (none)');
    }
    for (const v of tree.viewers) {
      printer.info(
        `    viewer ${v.id}  subject=${v.subject}  [${v.state}]  leases=${heldLeaseCount(v.heldLeases)}`,
      );
    }
  } else {
    printer.info('  session   (none)');
  }
  if (i.incidents.length > 0) {
    printer.info(`  incidents ${i.incidents.length} (most recent: ${i.incidents[0]?.code})`);
  }
}

async function followInstance(
  printer: Printer,
  connection: GatewayConnection,
  instanceId: string,
  jsonMode: boolean,
): Promise<void> {
  // `POST /v1/instances/:id/attach` (`BrowserRouter.attach`) mints its
  // `ticket` as a bare id (`newId('tkt')`) without ever registering it
  // with `@browserglass/server`'s own `TicketRegistry`, so redeeming it
  // always answers `bgls.error.auth.invalid_ticket` (confirmed directly);
  // its `wsUrl` is likewise a synthetic `ws://local/<nodeId>` placeholder
  // in this single-node, in-process build (`LocalNodeTransport` has no
  // real per-node WebSocket server to point at). `POST /v1/tokens` (a
  // real, working, separate auth path) minting a viewer-scoped bearer
  // token, presented against `connection.wsUrl` (the gateway's own real
  // WS endpoint), sidesteps both gaps at once.
  const minted = await restCall<{ readonly token: string }>(connection, 'POST', '/v1/tokens', {
    sub: 'bgls-inspect-follow',
    scope: { kind: 'instance', instanceId, targets: '*' },
    caps: ['view'],
    ttlSeconds: 300,
  });
  const ws = new WebSocket(connection.wsUrl, ['bgls.v1']);
  ws.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timed out')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connect failed'));
    });
  });

  ws.send(
    JSON.stringify({
      v: 1,
      t: 'hello',
      id: 'bgls-inspect-follow',
      ts: Date.now(),
      versions: [1],
      minVersion: 1,
      client: { name: 'bgls-inspect', version: '1', runtime: 'cli' },
      capabilities: { codecs: [], binaryFrames: true, input: [] },
      viewport: { width: 1024, height: 768, dpr: 1, visible: true, fitMode: 'contain' },
      auth: { scheme: 'bearer', token: minted.token },
    }),
  );

  if (!jsonMode) printer.info(`following instance ${instanceId}. Press Ctrl+C to stop.`);

  ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data) as { readonly t: string };
      if (jsonMode) {
        process.stdout.write(`${ev.data}\n`);
      } else {
        printer.info(
          `<- ${msg.t}  ${ev.data.length > 200 ? `${ev.data.slice(0, 200)}...` : ev.data}`,
        );
      }
    } else if (ev.data instanceof ArrayBuffer) {
      const header = decodeBinaryHeader(ev.data);
      if (jsonMode) {
        process.stdout.write(
          `${JSON.stringify({ t: 'frame', streamId: header.streamId, seq: header.seq })}\n`,
        );
      } else {
        printer.info(`<- frame streamId=${header.streamId} seq=${header.seq}`);
      }
      ws.send(
        JSON.stringify({
          v: 1,
          t: 'ack',
          ts: Date.now(),
          streamId: header.streamId,
          seq: header.seq,
        }),
      );
    }
  });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      try {
        ws.close();
      } catch {
        // Best effort.
      }
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    ws.addEventListener('close', () => resolve());
  });
}

/** `bgls inspect [instanceId]`. */
export const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Print the instance/session/target/stream/lease tree of a running gateway.',
  },
  args: {
    ...GLOBAL_ARGS,
    instanceId: {
      type: 'positional',
      description: 'Instance to inspect. Omit to list every instance.',
      required: false,
    },
    follow: {
      type: 'boolean',
      description: "Tail the control channel as a Viewer with caps:['view'].",
      default: false,
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args);
    const printer = new Printer(flags);

    let connection: GatewayConnection;
    try {
      connection = await resolveGatewayConnection(flags);
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    if (args.follow === true) {
      let instanceId = args.instanceId as string | undefined;
      if (instanceId === undefined) {
        const list = await restCall<{ readonly items: readonly InstanceView[] }>(
          connection,
          'GET',
          '/v1/instances',
        );
        instanceId = list.items[0]?.instance.id;
        if (instanceId === undefined) {
          printer.error('No instances to follow.');
          process.exitCode = EXIT_CODES.operationalFailure;
          return;
        }
      }
      try {
        await followInstance(printer, connection, instanceId, flags.json);
      } catch (err) {
        printer.error(
          `bgls inspect --follow failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = EXIT_CODES.operationalFailure;
      }
      return;
    }

    try {
      if (args.instanceId !== undefined) {
        const view = await restCall<InstanceView>(
          connection,
          'GET',
          `/v1/instances/${args.instanceId}`,
        );
        const tree = await buildTree(connection, view);
        printer.result(tree, (t) => printTreeHuman(printer, t));
      } else {
        const list = await restCall<{ readonly items: readonly InstanceView[] }>(
          connection,
          'GET',
          '/v1/instances',
        );
        if (list.items.length === 0) {
          printer.result([], () => printer.info('No instances.'));
          return;
        }
        const trees = await Promise.all(list.items.map((view) => buildTree(connection, view)));
        printer.result(trees, (ts) => {
          for (const t of ts) {
            printTreeHuman(printer, t);
            printer.info('');
          }
        });
      }
    } catch (err) {
      if (err instanceof RestClientError) {
        printer.error(`${err.code}: ${err.message}`);
        process.exitCode = EXIT_CODES.operationalFailure;
      } else {
        printer.error(err instanceof Error ? err.message : String(err));
        process.exitCode = EXIT_CODES.operationalFailure;
      }
    }
  },
});
