/**
 * `bgls serve`: starts a full embedded gateway (store, profile filesystem,
 * host runtime, and a real `node:http`/`node:https` listener) from a
 * single command. `--standalone`/`--node-only` are registered but error
 * clearly, since they are not implemented yet (this build only ships
 * the in-process `embedded` shortcut, not a real two-process router/node
 * split).
 */

import { defineCommand } from 'citty';
import { GLOBAL_ARGS, resolveGlobalFlags } from '../context.js';
import { buildEmbeddedGateway } from '../gateway.js';
import { defaultDataDir } from '../session-file.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

function parseListen(addr: string | undefined): { host: string; port: number } {
  const raw = addr ?? '127.0.0.1:7443';
  const lastColon = raw.lastIndexOf(':');
  if (lastColon === -1) return { host: raw, port: 7443 };
  const host = raw.slice(0, lastColon) || '127.0.0.1';
  const port = Number(raw.slice(lastColon + 1));
  return { host, port: Number.isFinite(port) ? port : 7443 };
}

function parseStoreUrl(
  url: string | undefined,
): { kind: 'sqlite'; path: string } | { kind: 'postgres'; connectionString: string } | undefined {
  if (url === undefined) return undefined;
  if (url.startsWith('sqlite:')) return { kind: 'sqlite', path: url.slice('sqlite:'.length) };
  if (url.startsWith('postgres://') || url.startsWith('postgresql://'))
    return { kind: 'postgres', connectionString: url };
  return { kind: 'sqlite', path: url };
}

/** Parses a `--store-pool-*`/`BGLS_STORE_POOL_*` numeric flag, `undefined` when neither is set. */
function parsePoolNumber(flag: string | undefined, envVar: string): number | undefined {
  const raw = flag ?? process.env[envVar];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** `bgls serve`. */
export const serveCommand = defineCommand({
  meta: { name: 'serve', description: 'Start a BrowserGlass gateway.' },
  args: {
    ...GLOBAL_ARGS,
    listen: { type: 'string', description: 'host:port to listen on. Default 127.0.0.1:7443.' },
    store: {
      type: 'string',
      description: 'sqlite:./bgls.db | postgres://... Default sqlite:<data-dir>/bgls.db.',
    },
    runtime: { type: 'string', description: 'host | docker | remote. Repeatable. Default host.' },
    'profiles-dir': { type: 'string', description: 'Default <data-dir>/profiles.' },
    'recordings-dir': {
      type: 'string',
      description:
        'Where "recording.start" sessions write frames. Default: a private per-process temp directory (@browserglass/server\'s own default), which "bgls record list/export" cannot locate after this process exits. Set this (e.g. to <data-dir>/recordings) for recordings that outlive this process, and pass the same path to "bgls record --dir".',
    },
    'data-dir': {
      type: 'string',
      description:
        'Root directory for the store, profiles, and runtime state. Default ./bgls-data.',
    },
    headless: {
      type: 'boolean',
      description:
        "Accepted; per-request browser.headless remains the caller's own choice in this build.",
    },
    'max-instances': { type: 'string', description: 'Default 20.' },
    'max-memory-mb': { type: 'string', description: 'Accepted; not enforced in this build.' },
    auth: { type: 'string', description: 'dev | jwks | hmac | custom. Default dev.' },
    'jwks-url': { type: 'string', description: 'Required with --auth jwks.' },
    cors: {
      type: 'string',
      description:
        'Allowed CORS/WS origin. Repeatable, or pass "*" for wide open. Default: none allowed.',
    },
    'tls-cert': { type: 'string', description: 'PEM certificate path. Requires --tls-key.' },
    'tls-key': { type: 'string', description: 'PEM private key path. Requires --tls-cert.' },
    'store-pool-min': {
      type: 'string',
      description: 'Postgres store only. Connections pre-warmed at startup. Default 0.',
    },
    'store-pool-max': {
      type: 'string',
      description: 'Postgres store only. Maximum pool connections. Default 10.',
    },
    'store-pool-idle-timeout-ms': {
      type: 'string',
      description: 'Postgres store only. Idle connection lifetime. Default 10000.',
    },
    'store-pool-connect-timeout-ms': {
      type: 'string',
      description: 'Postgres store only. Connection attempt timeout. Default 10000.',
    },
    'store-tls': { type: 'boolean', description: 'Postgres store only. Connect over TLS.' },
    'store-tls-insecure': {
      type: 'boolean',
      description:
        'Postgres store only. Skip server certificate verification. Self-signed development databases only, never production.',
    },
    'store-tls-ca': {
      type: 'string',
      description:
        'Postgres store only. PEM CA certificate path, for a server certificate not signed by a system-trusted CA.',
    },
    'store-tls-cert': {
      type: 'string',
      description:
        'Postgres store only. PEM client certificate path, for mutual TLS. Requires --store-tls-key.',
    },
    'store-tls-key': {
      type: 'string',
      description:
        'Postgres store only. PEM client private key path, for mutual TLS. Requires --store-tls-cert.',
    },
    standalone: {
      type: 'boolean',
      description: 'Router only, no local node agent. Not implemented yet.',
    },
    'node-only': {
      type: 'boolean',
      description: 'Node agent only, requires --router. Not implemented yet.',
    },
    router: { type: 'string', description: 'Router WS URL, used with --node-only.' },
    open: {
      type: 'boolean',
      description: 'Open the built-in inspector in a browser. Not implemented in this build.',
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args);
    const printer = new Printer(flags);

    if (args.standalone === true || args['node-only'] === true) {
      printer.error(
        'bgls serve --standalone and --node-only are registered but not implemented in this build: BrowserGlass ships a single in-process "embedded" gateway only. Run "bgls serve" with no --standalone/--node-only flag.',
      );
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    const runtimeKinds = (
      Array.isArray(args.runtime)
        ? args.runtime
        : args.runtime !== undefined
          ? [args.runtime]
          : ['host']
    ) as string[];
    const unsupportedRuntime = runtimeKinds.find((k) => k !== 'host' && k !== 'remote');
    if (unsupportedRuntime !== undefined) {
      printer.error(
        `bgls serve --runtime ${unsupportedRuntime} is registered but not implemented by this CLI build: only "host" is wired up (docker/remote require additional configuration this CLI does not yet collect). Run with --runtime host, or omit --runtime.`,
      );
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    const authMode = args.auth ?? 'dev';
    if (authMode !== 'dev') {
      printer.error(
        `bgls serve --auth ${authMode} is registered but not implemented in this build: only "dev" (an ephemeral, locally minted signing key) is wired up. Run with --auth dev, or omit --auth.`,
      );
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    const store = parseStoreUrl(args.store ?? process.env['BGLS_STORE_URL']);

    if ((args['tls-cert'] === undefined) !== (args['tls-key'] === undefined)) {
      printer.error('bgls serve requires both --tls-cert and --tls-key, or neither.');
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    if ((args['store-tls-cert'] === undefined) !== (args['store-tls-key'] === undefined)) {
      printer.error('bgls serve requires both --store-tls-cert and --store-tls-key, or neither.');
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    const dataDir = args['data-dir'] ?? defaultDataDir();
    const { host, port } = parseListen(args.listen);
    const cors =
      args.cors === undefined
        ? undefined
        : Array.isArray(args.cors)
          ? (args.cors as string[])
          : [args.cors as string];

    if (args.headless === true) {
      printer.info(
        "--headless is accepted; per-request browser.headless is still the caller's own choice in this build.",
      );
    }
    if (args['max-memory-mb'] !== undefined) {
      printer.info('--max-memory-mb is accepted but not enforced in this build.');
    }
    if (args.open === true) {
      printer.warn('--open is registered but this build ships no built-in inspector UI to open.');
    }

    const poolMin = parsePoolNumber(args['store-pool-min'], 'BGLS_STORE_POOL_MIN');
    const poolMax = parsePoolNumber(args['store-pool-max'], 'BGLS_STORE_POOL_MAX');
    const poolIdleTimeoutMs = parsePoolNumber(
      args['store-pool-idle-timeout-ms'],
      'BGLS_STORE_POOL_IDLE_TIMEOUT_MS',
    );
    const poolConnectTimeoutMs = parsePoolNumber(
      args['store-pool-connect-timeout-ms'],
      'BGLS_STORE_POOL_CONNECT_TIMEOUT_MS',
    );
    const poolOptions =
      poolMin !== undefined ||
      poolMax !== undefined ||
      poolIdleTimeoutMs !== undefined ||
      poolConnectTimeoutMs !== undefined
        ? {
            ...(poolMin !== undefined ? { min: poolMin } : {}),
            ...(poolMax !== undefined ? { max: poolMax } : {}),
            ...(poolIdleTimeoutMs !== undefined ? { idleTimeoutMs: poolIdleTimeoutMs } : {}),
            ...(poolConnectTimeoutMs !== undefined
              ? { connectionTimeoutMs: poolConnectTimeoutMs }
              : {}),
          }
        : undefined;

    const storeTlsEnabled = args['store-tls'] === true || process.env['BGLS_STORE_TLS'] === 'true';
    const tlsOptions = storeTlsEnabled
      ? {
          enabled: true,
          ...(args['store-tls-insecure'] === true ? { rejectUnauthorized: false } : {}),
          ...(args['store-tls-ca'] !== undefined ? { caPath: args['store-tls-ca'] } : {}),
          ...(args['store-tls-cert'] !== undefined ? { certPath: args['store-tls-cert'] } : {}),
          ...(args['store-tls-key'] !== undefined ? { keyPath: args['store-tls-key'] } : {}),
        }
      : undefined;

    let gateway: Awaited<ReturnType<typeof buildEmbeddedGateway>>;
    try {
      const remoteEndpoints = (process.env['BGLS_REMOTE_ENDPOINTS'] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((pair) => {
          const i = pair.indexOf('=');
          return { name: pair.slice(0, i), url: pair.slice(i + 1) };
        });
      gateway = await buildEmbeddedGateway({
        dataDir,
        ...(runtimeKinds.includes('remote') ? { runtime: 'remote' as const, remoteEndpoints } : {}),
        listenHost: host,
        listenPort: port,
        ...(store?.kind === 'sqlite' ? { storePath: store.path } : {}),
        ...(store?.kind === 'postgres'
          ? {
              store: {
                kind: 'postgres' as const,
                connectionString: store.connectionString,
                ...(poolOptions !== undefined ? { pool: poolOptions } : {}),
                ...(tlsOptions !== undefined ? { tls: tlsOptions } : {}),
              },
            }
          : {}),
        ...(args['profiles-dir'] !== undefined ? { profilesDir: args['profiles-dir'] } : {}),
        ...(args['recordings-dir'] !== undefined ? { recordingsDir: args['recordings-dir'] } : {}),
        ...(args['max-instances'] !== undefined
          ? { maxInstances: Number(args['max-instances']) }
          : {}),
        ...(cors !== undefined ? { allowedOrigins: cors } : {}),
        ...(args['tls-cert'] !== undefined && args['tls-key'] !== undefined
          ? { tls: { certPath: args['tls-cert'], keyPath: args['tls-key'] } }
          : {}),
      });
    } catch (err) {
      printer.error(
        `bgls serve failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = EXIT_CODES.operationalFailure;
      return;
    }

    const failedPreflight = gateway.startReport.preflight.filter((r) => r.verdict === 'fail');
    for (const r of failedPreflight) printer.warn(`preflight ${r.name}: ${r.detail}`);

    printer.result(
      {
        endpoint: gateway.endpoint,
        wsUrl: gateway.wsUrl,
        dataDir,
        tenantId: gateway.session.tenantId,
        appId: gateway.session.appId,
        pid: process.pid,
      },
      (data) => {
        printer.success(`bgls gateway listening at ${data.endpoint}`);
        printer.info(`data directory: ${data.dataDir}`);
        printer.info(`ws endpoint:    ${data.wsUrl}`);
        printer.info('Press Ctrl+C to stop.');
      },
    );

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      printer.info(`received ${signal}, shutting down`);
      gateway
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep the process alive; the http server's own open listening socket
    // already does this, but an explicit never-resolving promise makes the
    // intent unambiguous to a reader.
    await new Promise<void>(() => undefined);
  },
});
