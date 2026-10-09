/**
 * Every command from the full documented `bgls` command surface that
 * this build does not implement: `bgls serve`, `bgls
 * doctor`, `bgls inspect`, `bgls config show`, and the browser-driving
 * `bgls instances *`/`bgls swarm run` surface are the real
 * implementations (see their own files under `commands/**`, principally
 * `instances-cmd.ts` and `swarm.ts`); everything else is registered here
 * with its documented flags so the surface is discoverable, and running
 * it prints a clear message and exits `1`. This makes the surface
 * discoverable and the gap honest.
 */

import { defineCommand } from 'citty';
import type { ArgsDef } from 'citty';
import { GLOBAL_ARGS, type ParsedGlobalArgs, resolveGlobalFlags } from '../context.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

/** One flag a stub command declares, purely for `--help`/discoverability; never read. */
interface StubArgSpec {
  readonly name: string;
  readonly kind: 'string' | 'boolean' | 'positional';
  readonly description?: string;
  readonly required?: boolean;
}

/** One stub leaf command's spec. */
interface StubLeafSpec {
  readonly name: string;
  readonly description: string;
  readonly args?: readonly StubArgSpec[];
  /** Adds `--dry-run`: every mutating command supports it. */
  readonly mutating?: boolean;
}

function buildArgs(spec: StubLeafSpec): ArgsDef {
  const args: ArgsDef = { ...GLOBAL_ARGS };
  for (const a of spec.args ?? []) {
    if (a.kind === 'positional') {
      args[a.name] = {
        type: 'positional',
        description: a.description ?? '',
        required: a.required ?? false,
      };
    } else {
      args[a.name] = { type: a.kind, description: a.description ?? '' };
    }
  }
  if (spec.mutating === true) {
    args['dry-run'] = {
      type: 'boolean',
      description: 'Preview only; make no changes.',
      default: false,
    };
  }
  return args;
}

/** Builds one stub leaf command: registered with its flags, always prints a clear not-implemented message and exits 1. */
function stubLeaf(fullName: string, spec: StubLeafSpec) {
  return defineCommand({
    meta: { name: spec.name, description: `${spec.description} Not implemented in this build.` },
    args: buildArgs(spec),
    async run({ args }) {
      const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
      const printer = new Printer(flags);
      const message = `bgls ${fullName} is registered but not implemented in this build of @browserglass/cli.`;
      printer.result({ error: { code: 'E_NOT_IMPLEMENTED', message } }, () =>
        printer.error(message),
      );
      process.exitCode = EXIT_CODES.operationalFailure;
    },
  });
}

/** Builds a stub group command (e.g. `bgls nodes`) whose only job is to host stub sub-commands. */
function stubGroup(
  groupName: string,
  description: string,
  leaves: Readonly<Record<string, StubLeafSpec>>,
) {
  const subCommands: Record<string, ReturnType<typeof stubLeaf>> = {};
  for (const [key, spec] of Object.entries(leaves)) {
    subCommands[key] = stubLeaf(`${groupName} ${spec.name}`, spec);
  }
  return defineCommand({
    meta: { name: groupName, description },
    subCommands,
  });
}

const pos = (name: string, description: string, required = true): StubArgSpec => ({
  name,
  kind: 'positional',
  description,
  required,
});
const str = (name: string, description: string): StubArgSpec => ({
  name,
  kind: 'string',
  description,
});
const bool = (name: string, description: string): StubArgSpec => ({
  name,
  kind: 'boolean',
  description,
});

/** `bgls nodes`. */
export const nodesCommand = stubGroup('nodes', 'Manage router nodes.', {
  list: {
    name: 'list',
    description: 'List nodes.',
    args: [
      str('pool', 'Filter by pool id.'),
      str('state', 'Filter by state.'),
      bool('watch', 'Stream updates.'),
    ],
  },
  describe: {
    name: 'describe',
    description: 'Describe one node.',
    args: [pos('nodeId', 'Node id.')],
  },
  drain: {
    name: 'drain',
    description: 'Drain a node.',
    mutating: true,
    args: [
      pos('nodeId', 'Node id.'),
      str('deadline', 'Drain deadline, e.g. 15m.'),
      str('force-after', 'Force-drain deadline, e.g. 20m.'),
      str('reason', 'Reason.'),
    ],
  },
  undrain: {
    name: 'undrain',
    description: 'Cancel a drain.',
    mutating: true,
    args: [pos('nodeId', 'Node id.')],
  },
  cordon: {
    name: 'cordon',
    description: 'Exclude a node from placement without shedding it.',
    mutating: true,
    args: [pos('nodeId', 'Node id.')],
  },
  uncordon: {
    name: 'uncordon',
    description: 'Reinclude a node in placement.',
    mutating: true,
    args: [pos('nodeId', 'Node id.')],
  },
  evict: {
    name: 'evict',
    description: 'Evict instances from a node.',
    mutating: true,
    args: [pos('nodeId', 'Node id.'), pos('instanceIds', 'Instance ids, space separated.', false)],
  },
});

// `bgls instances` (list/describe/create/release/targets/screenshot/
// navigate, plus click/type/open-target/close-target/console/network,
// which this stub table never declared) is real, in `commands/
// instances-cmd.ts`; `kill` alone stays a stub, registered there rather
// than here, since its own doc comment explains the specific REST gap
// that keeps it unimplemented. `bgls swarm` (`commands/swarm.ts`) is a
// new, real command this stub table never declared at all.

/** `bgls profiles`. */
export const profilesCommand = stubGroup('profiles', 'Manage browser profiles.', {
  list: {
    name: 'list',
    description: 'List profiles.',
    args: [
      str('tenant', ''),
      str('app', ''),
      str('key', 'Glob.'),
      str('sort', 'size | used | created.'),
      str('stale', 'Duration.'),
    ],
  },
  create: {
    name: 'create',
    description: 'Create a profile.',
    mutating: true,
    args: [
      str('key', 'Profile key.'),
      str('template', 'Template id.'),
      str('seed', 'Seed file.'),
      str('tenant', ''),
      str('app', ''),
    ],
  },
  describe: {
    name: 'describe',
    description: 'Describe one profile.',
    args: [
      pos('profileId', 'Profile id.', false),
      str('key', 'Profile key, alternative to profileId.'),
    ],
  },
  snapshot: {
    name: 'snapshot',
    description: 'Snapshot a profile.',
    mutating: true,
    args: [
      pos('profileId', 'Profile id.', false),
      str('key', 'Profile key.'),
      str('label', 'Label.'),
      bool('full', 'Full snapshot.'),
      bool('wait', 'Wait for completion.'),
    ],
  },
  restore: {
    name: 'restore',
    description: 'Restore a profile from a snapshot.',
    mutating: true,
    args: [
      pos('profileId', 'Profile id.'),
      str('snapshot', 'Snapshot id.'),
      bool('force', 'Force.'),
    ],
  },
  export: {
    name: 'export',
    description: 'Export a profile to a .bgprof file.',
    args: [
      pos('profileId', 'Profile id.'),
      str('out', '.bgprof output path.'),
      bool('full', 'Full export.'),
      bool('encrypt', 'Encrypt the export.'),
    ],
  },
  import: {
    name: 'import',
    description: 'Import a .bgprof file.',
    mutating: true,
    args: [
      str('in', '.bgprof input path.'),
      str('key', 'Profile key.'),
      str('tenant', ''),
      str('app', ''),
      bool('as-template', 'Import as a template.'),
      str('key-from', 'Migration: source key.'),
      str('prefix', 'Migration: key prefix.'),
      bool('link', 'Migration: link rather than copy.'),
      bool('copy', 'Migration: copy rather than link.'),
    ],
  },
  gc: {
    name: 'gc',
    description: 'Garbage-collect profiles (trash, expired ephemeral, LRU ephemeral, cache trim).',
    mutating: true,
    args: [
      str('older-than', 'Duration, default 30d.'),
      str('keep-snapshots', 'Default 3.'),
      str('max-bytes', 'Default 200G.'),
      bool('yes', 'Required in scripts; skips the interactive confirmation.'),
    ],
  },
  rm: {
    name: 'rm',
    description: 'Delete a profile.',
    mutating: true,
    args: [pos('profileId', 'Profile id.'), bool('yes', 'Skip confirmation.')],
  },
  unlock: {
    name: 'unlock',
    description: 'Force-release a stale profile lease.',
    mutating: true,
    args: [
      pos('profileId', 'Profile id.', false),
      str('key', 'Profile key, alternative to profileId.'),
    ],
  },
});

/** `bgls sessions`. */
export const sessionsCommand = stubGroup('sessions', 'Manage live sessions.', {
  list: {
    name: 'list',
    description: 'List sessions.',
    args: [str('instance', ''), str('tenant', ''), bool('watch', '')],
  },
  describe: {
    name: 'describe',
    description: 'Describe one session.',
    args: [pos('sessionId', 'Session id.')],
  },
  viewers: {
    name: 'viewers',
    description: "List a session's viewers.",
    args: [pos('sessionId', 'Session id.')],
  },
  kick: {
    name: 'kick',
    description: 'Kick a viewer.',
    mutating: true,
    args: [pos('sessionId', 'Session id.'), str('viewer', 'Viewer id.'), str('reason', 'Reason.')],
  },
  lease: {
    name: 'lease',
    description: 'Grant, revoke, or force a control lease.',
    mutating: true,
    args: [
      pos('sessionId', 'Session id.'),
      str('target', 'Target id.'),
      str('grant', 'Viewer id to grant to.'),
      bool('revoke', 'Revoke the current holder.'),
      str('force', 'Viewer id to force-claim for.'),
    ],
  },
  end: {
    name: 'end',
    description: 'End a session.',
    mutating: true,
    args: [pos('sessionId', 'Session id.'), str('reason', 'Reason.')],
  },
  replay: {
    name: 'replay',
    description: 'Export a session replay (phase 3).',
    args: [pos('sessionId', 'Session id.'), str('out', 'Output file.')],
  },
});

/** `bgls bench`. */
export const benchCommand = stubGroup('bench', 'Run and report benchmark scenarios.', {
  run: {
    name: 'run',
    description: 'Run a benchmark scenario.',
    mutating: true,
    args: [
      pos('scenario', 'Scenario name, or "all".'),
      str('out', 'Output directory.'),
      str('duration', 'Duration.'),
      str('viewers-remote', 'Remote viewer host.'),
    ],
  },
  list: { name: 'list', description: 'List available scenarios.' },
  compare: {
    name: 'compare',
    description: 'Compare two benchmark reports.',
    args: [pos('reportA', 'First report.'), pos('reportB', 'Second report.')],
  },
  report: {
    name: 'report',
    description: 'Render a benchmark report.',
    args: [pos('dir', 'Report directory.')],
  },
  serve: {
    name: 'serve',
    description: 'Serve a benchmark report over HTTP.',
    args: [pos('dir', 'Report directory.')],
  },
});

// `bgls token` is real, in `commands/token.ts`: it prints the bearer
// token the documented REST calls need, which is the dev-mode subset of
// the `token mint` this table used to declare. The rest of that group
// (`mint`'s full flag set, `verify`, `decode`, `revoke`) is gone from
// the surface rather than stubbed, because `citty` reads the first
// non-flag argument as a sub-command name, so keeping the group would
// make `bgls token --ttl 900` fail with "Unknown command `900`". See
// `commands/token.ts`'s own doc comment.

/** `bgls keys`. */
export const keysCommand = stubGroup('keys', 'Manage signing keys.', {
  list: { name: 'list', description: 'List signing keys.' },
  rotate: {
    name: 'rotate',
    description: 'Rotate the active signing key.',
    mutating: true,
    args: [str('retire-after', 'Retire the previous key after this duration.')],
  },
  revoke: {
    name: 'revoke',
    description: 'Revoke a signing key.',
    mutating: true,
    args: [pos('kid', 'Key id.')],
  },
});

/** `bgls audit`. */
export const auditCommand = stubGroup('audit', 'Query, export, and verify the audit log.', {
  query: {
    name: 'query',
    description: 'Query audit records.',
    args: [str('since', 'Duration.'), str('type', 'Event type.')],
  },
  export: {
    name: 'export',
    description: 'Export audit records.',
    args: [str('out', 'Output file.'), str('since', 'Duration.')],
  },
  verify: { name: 'verify', description: "Verify the audit log's integrity." },
});

/** `bgls backup`. */
export const backupCommand = stubGroup('backup', 'Create, list, verify, and prune store backups.', {
  create: {
    name: 'create',
    description: 'Create a backup.',
    mutating: true,
    args: [str('out', 'Output path.')],
  },
  list: { name: 'list', description: 'List backups.' },
  verify: {
    name: 'verify',
    description: 'Verify a backup.',
    args: [pos('backupId', 'Backup id.')],
  },
  prune: {
    name: 'prune',
    description: 'Prune old backups.',
    mutating: true,
    args: [str('keep', 'Number to keep.')],
  },
});

/** `bgls restore`. */
export const restoreCommand = stubGroup('restore', 'Apply or reconcile a backup.', {
  apply: {
    name: 'apply',
    description: 'Apply a backup.',
    mutating: true,
    args: [pos('backupId', 'Backup id.')],
  },
  reconcile: {
    name: 'reconcile',
    description: 'Reconcile the store against live state.',
    mutating: true,
  },
});

/** `bgls migrate`. */
export const migrateCommand = stubGroup('migrate', 'Inspect and run store migrations.', {
  status: {
    name: 'status',
    description: 'Show the current schema version and pending migrations.',
  },
  up: { name: 'up', description: 'Apply pending migrations.', mutating: true },
  create: {
    name: 'create',
    description: 'Scaffold a new migration file.',
    mutating: true,
    args: [pos('name', 'Migration name.')],
  },
});

// `bgls record` (list/export real, replay deliberately left unimplemented
// with an honest error) is real, in `commands/record.ts`; this stub table
// never declares it.

/** `bgls pools`. */
export const poolsCommand = stubGroup('pools', 'Manage instance pools.', {
  list: { name: 'list', description: 'List pools.' },
  create: {
    name: 'create',
    description: 'Create a pool.',
    mutating: true,
    args: [pos('name', 'Pool name.')],
  },
  update: {
    name: 'update',
    description: 'Update a pool.',
    mutating: true,
    args: [pos('poolId', 'Pool id.')],
  },
  scale: {
    name: 'scale',
    description: "Scale a pool's warm count.",
    mutating: true,
    args: [pos('poolId', 'Pool id.'), str('warm', 'Warm instance count.')],
  },
});

/** `bgls tenants`. */
export const tenantsCommand = stubGroup('tenants', 'Manage tenants.', {
  list: { name: 'list', description: 'List tenants.' },
  create: {
    name: 'create',
    description: 'Create a tenant.',
    mutating: true,
    args: [pos('name', 'Tenant name.')],
  },
  quota: {
    name: 'quota',
    description: "View or set a tenant's quota.",
    mutating: true,
    args: [pos('tenantId', 'Tenant id.')],
  },
});

/** `bgls tail`. */
export const tailCommand = stubLeaf('tail', {
  name: 'tail',
  description: 'Tail live events across sessions/instances/viewers/tenants.',
  args: [
    str('session', ''),
    str('instance', ''),
    str('viewer', ''),
    str('tenant', ''),
    str('types', 'Comma-separated event types.'),
    str('since', 'Duration.'),
    bool('follow', 'Keep streaming.'),
  ],
});

/** `bgls dev`: alias for `serve` with dev auth, the built-in inspector, and file watching. */
export const devCommand = stubLeaf('dev', {
  name: 'dev',
  description: 'Alias for "serve" with dev auth, the built-in inspector, and file watching.',
});

/** `bgls node`: alias for `serve --node-only`. */
export const nodeAliasCommand = stubLeaf('node', {
  name: 'node',
  description: 'Alias for "serve --node-only".',
});

/** `bgls router`: alias for `serve --standalone`. */
export const routerAliasCommand = stubLeaf('router', {
  name: 'router',
  description: 'Alias for "serve --standalone".',
});

/** `bgls maintain`: the retention job. */
export const maintainCommand = stubLeaf('maintain', {
  name: 'maintain',
  description: 'Run the retention job (profile GC, audit trim, stale-lease sweep) once.',
  mutating: true,
});

/** `bgls completion`. */
export const completionCommand = stubGroup('completion', 'Print a shell completion script.', {
  bash: { name: 'bash', description: 'Print a bash completion script.' },
  zsh: { name: 'zsh', description: 'Print a zsh completion script.' },
  fish: { name: 'fish', description: 'Print a fish completion script.' },
  powershell: { name: 'powershell', description: 'Print a PowerShell completion script.' },
});

/**
 * `bgls version [--json]`. Listed alongside every other command in the
 * documented command surface,
 * so it follows the same "registered, not implemented, exit 1" rule as
 * the rest of that listing; `bgls --version` (the root `citty` flag,
 * wired in `cli.ts`) is the real, working way to check the installed
 * version.
 */
export const versionCommand = stubLeaf('version', {
  name: 'version',
  description: 'Print version information. Use "bgls --version" for the real, working equivalent.',
});
