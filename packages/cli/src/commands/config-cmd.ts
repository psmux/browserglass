/**
 * `bgls config show [--annotate]`: resolves the same four-layer precedence
 * `bgls serve` applies (built-in defaults, `bgls.config.ts`, `BGLS_*`
 * environment variables, CLI flags) and prints the merged result.
 * `--annotate` names, per value, which layer it came from.
 */

import { defineCommand } from 'citty';
import { BGLS_DEFAULTS, envToConfig, loadConfigFile, resolveAnnotated } from '../config-resolve.js';
import type { BglsConfig } from '../config.js';
import { GLOBAL_ARGS, type ParsedGlobalArgs, resolveGlobalFlags } from '../context.js';
import { defaultDataDir } from '../session-file.js';
import { compact } from '../util/compact.js';
import { Printer } from '../util/output.js';

type RuntimeKind = NonNullable<BglsConfig['runtime']>['kind'];
type AuthMode = NonNullable<BglsConfig['auth']>['mode'];

function flagsToConfig(args: Record<string, unknown>): BglsConfig {
  const listen = args['listen'] as string | undefined;
  const store = args['store'] as string | undefined;
  const runtimeKind = args['runtime'] as RuntimeKind | undefined;
  const profilesDir = args['profiles-dir'] as string | undefined;
  const headless = args['headless'] as boolean | undefined;
  const maxInstances = args['max-instances'] as string | undefined;
  const authMode = args['auth'] as AuthMode | undefined;
  const jwksUrl = args['jwks-url'] as string | undefined;

  return compact({
    listen,
    store: store !== undefined ? { url: store } : undefined,
    runtime:
      runtimeKind !== undefined || headless !== undefined
        ? compact({ kind: runtimeKind, headless })
        : undefined,
    profiles: profilesDir !== undefined ? { dir: profilesDir } : undefined,
    node: maxInstances !== undefined ? { maxInstances: Number(maxInstances) } : undefined,
    auth:
      authMode !== undefined || jwksUrl !== undefined
        ? compact({ mode: authMode, jwksUrl })
        : undefined,
  });
}

/** `bgls config`. */
export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Inspect the resolved bgls configuration.' },
  subCommands: {
    show: defineCommand({
      meta: {
        name: 'show',
        description:
          'Print the resolved configuration, merging defaults, bgls.config.ts, environment, and CLI flags.',
      },
      args: {
        ...GLOBAL_ARGS,
        annotate: {
          type: 'boolean',
          description: 'Name the precedence layer each value came from.',
          default: false,
        },
        listen: { type: 'string' },
        store: { type: 'string' },
        runtime: { type: 'string' },
        'profiles-dir': { type: 'string' },
        headless: { type: 'boolean' },
        'max-instances': { type: 'string' },
        auth: { type: 'string' },
        'jwks-url': { type: 'string' },
      },
      async run({ args }) {
        const raw = args as unknown as Record<string, unknown>;
        const flags = resolveGlobalFlags(args as unknown as ParsedGlobalArgs);
        const printer = new Printer(flags);

        const configPath = raw['config'] as string | undefined;
        const { config: fileConfig, filepath } = await loadConfigFile(configPath, process.cwd());
        const envConfig = envToConfig(process.env);
        const flagConfig = flagsToConfig(raw);

        const report = resolveAnnotated(
          {
            default: BGLS_DEFAULTS,
            'config file': fileConfig,
            environment: envConfig,
            'cli flag': flagConfig,
          },
          filepath,
        );

        printer.result(report, (r) => {
          printer.info(`data directory: ${defaultDataDir()}`);
          printer.info(`config file: ${r.configFilePath ?? '(none found)'}`);
          if (raw['annotate'] === true) {
            for (const v of r.values) {
              printer.info(`  ${v.path.padEnd(32)} = ${JSON.stringify(v.value)}   (${v.layer})`);
            }
          } else {
            printer.info(JSON.stringify(r.merged, null, 2));
          }
        });
      },
    }),
  },
});
