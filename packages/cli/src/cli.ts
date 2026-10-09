/**
 * Assembles the `bgls` command tree with `citty` and runs it. `bgls
 * serve`, `bgls doctor`, `bgls inspect`, `bgls attach`, `bgls config show`,
 * `bgls mcp`, `bgls token`, every `bgls instances *`/`bgls swarm run`
 * command that actually drives a browser (see `commands/instances-cmd.ts`,
 * `commands/swarm.ts`, `commands/mcp.ts`), and `bgls record list`/`bgls
 * record export` (`commands/record.ts`; `bgls record replay` stays
 * deliberately unimplemented, see that file's own doc), and `bgls plugins
 * add`/`bgls plugins list`/`bgls plugins remove` (`commands/plugins-cmd.ts`;
 * see `docs/plugins.md`) are real; every other documented command is
 * registered with its flags and reports "not implemented in this build"
 * (see `commands/stubs.ts`).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineCommand, runMain } from 'citty';
import { attachCommand } from './commands/attach.js';
import { configCommand } from './commands/config-cmd.js';
import { doctorCommand } from './commands/doctor.js';
import { inspectCommand } from './commands/inspect.js';
import { instancesCommand } from './commands/instances-cmd.js';
import { mcpCommand } from './commands/mcp.js';
import { pluginsCommand } from './commands/plugins-cmd.js';
import { recordCommand } from './commands/record.js';
import { serveCommand } from './commands/serve.js';
import {
  auditCommand,
  backupCommand,
  benchCommand,
  completionCommand,
  devCommand,
  keysCommand,
  maintainCommand,
  migrateCommand,
  nodeAliasCommand,
  nodesCommand,
  poolsCommand,
  profilesCommand,
  restoreCommand,
  routerAliasCommand,
  sessionsCommand,
  tailCommand,
  tenantsCommand,
  versionCommand,
} from './commands/stubs.js';
import { swarmCommand } from './commands/swarm.js';
import { tokenCommand } from './commands/token.js';

function readOwnVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@browserglass/cli/package.json');
    return (
      (JSON.parse(readFileSync(pkgPath, 'utf8')) as { readonly version?: string }).version ??
      '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

const PACKAGE_VERSION = readOwnVersion();

/** The root `bgls` command. */
export const bglsMain = defineCommand({
  meta: {
    name: 'bgls',
    version: PACKAGE_VERSION,
    description: 'BrowserGlass: run and inspect a BrowserGlass gateway.',
  },
  subCommands: {
    serve: serveCommand,
    doctor: doctorCommand,
    inspect: inspectCommand,
    attach: attachCommand,
    config: configCommand,
    nodes: nodesCommand,
    instances: instancesCommand,
    swarm: swarmCommand,
    mcp: mcpCommand,
    profiles: profilesCommand,
    sessions: sessionsCommand,
    tail: tailCommand,
    bench: benchCommand,
    token: tokenCommand,
    dev: devCommand,
    node: nodeAliasCommand,
    router: routerAliasCommand,
    keys: keysCommand,
    audit: auditCommand,
    backup: backupCommand,
    restore: restoreCommand,
    migrate: migrateCommand,
    maintain: maintainCommand,
    record: recordCommand,
    plugins: pluginsCommand,
    pools: poolsCommand,
    tenants: tenantsCommand,
    completion: completionCommand,
    version: versionCommand,
  },
});

/** Runs the `bgls` CLI against `process.argv`. Used by `bin.ts`; exported so a host process can embed the CLI directly. */
export function runCli(): Promise<void> {
  return runMain(bglsMain);
}
