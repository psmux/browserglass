/**
 * `bgls swarm run`: opens N instances at once and runs one action across
 * all of them concurrently, the single command this on-ramp exists to
 * ship: open N browsers and drive them all at once from a shell script.
 * Built
 * directly on `@browserglass/automation`'s `BrowserSwarm`, which is
 * already exactly this shape (`size` `AutomationClient`s opened and
 * driven together) minus the one piece it deliberately leaves to its
 * caller: `acquire()`, how to get from "I want another browser" to one
 * instance's `{instanceId, wsUrl, token}`. This file's `acquire()` is
 * `POST /v1/instances` (a fresh `requestId` per member, so the router's
 * idempotency window never dedupes two members onto the same instance)
 * plus `POST /v1/tokens`, the same two real REST calls `instances create`
 * and `util/drive.ts`'s `connectAutomation` already use.
 *
 * `--sticky-subject` is what makes a repeated run reuse its browsers
 * rather than add another `--size` of them to the machine. It does not go
 * straight into the `AcquireRequest` here: `BrowserSwarm` derives one
 * subject per member slot from it first (`<subject>#<index>`), because the
 * router resolves a single subject to a single instance and `--size`
 * simultaneous acquires on one subject would collapse onto it. See
 * `SwarmAcquireContext` in `@browserglass/automation` for that reasoning,
 * and `docs/scaling.md` for the model it belongs to.
 *
 * `BrowserSwarm` never releases what its own `acquire()` reserved
 * (`packages/automation/src/swarm.ts`'s own doc comment on
 * `SwarmAcquireResult`: "no paired release(), a real boundary, not an
 * oversight"). This command owns that release itself, in a `finally`,
 * for every instance `acquire()` created, not only the ones that made it
 * into `swarm.members`: a member whose REST create succeeded but whose
 * WS connect then failed would otherwise leak a running Chrome that
 * nothing in this process can ever reach again.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AutomationClient,
  BrowserSwarm,
  type SwarmAcquireContext,
  type SwarmMember,
} from '@browserglass/automation';
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
  errorMessage,
  mapDriveErrorToExitCode,
  mintInstanceToken,
  parseAffinityArgs,
  waitForInstanceReady,
  withLease,
} from '../util/drive.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';
import { restCall } from '../util/rest.js';

const ACTIONS = ['navigate', 'screenshot', 'click', 'type', 'status'] as const;
type Action = (typeof ACTIONS)[number];

interface MemberResult {
  readonly index: number;
  readonly instanceId: string;
  readonly targetId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/** Runs one member's action. `withLease` only wraps the actions that actually need a held `ControlLease` (`navigate`/`click`/`type`); `screenshot`/`status` need only `view`/`automation`/`capture`, matching `AutomationClient`'s own per-method capability requirements. */
async function runOneAction(
  client: AutomationClient,
  action: Action,
  opts: {
    value?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
    outDir?: string | undefined;
    index: number;
    instanceId: string;
  },
): Promise<unknown> {
  switch (action) {
    case 'navigate': {
      if (opts.value === undefined)
        throw new Error('swarm run --action navigate needs --value <url>');
      return withLease(client, () => client.navigate(opts.value as string));
    }
    case 'click': {
      if (opts.x === undefined || opts.y === undefined)
        throw new Error('swarm run --action click needs --x and --y');
      const x = opts.x;
      const y = opts.y;
      await withLease(client, () => client.clickAt(x, y));
      return { targetId: client.targetId, x, y, clicked: true };
    }
    case 'type': {
      if (opts.value === undefined) throw new Error('swarm run --action type needs --value <text>');
      const text = opts.value;
      await withLease(client, () => client.type(text));
      return { targetId: client.targetId, length: text.length, typed: true };
    }
    case 'screenshot': {
      const shot = await client.screenshot();
      if (opts.outDir !== undefined) {
        const path = join(opts.outDir, `member-${opts.index}-${opts.instanceId}.png`);
        writeFileSync(path, Buffer.from(shot.data, 'base64'));
        return {
          targetId: shot.targetId,
          width: shot.width,
          height: shot.height,
          sizeBytes: shot.sizeBytes,
          savedTo: path,
        };
      }
      return {
        targetId: shot.targetId,
        width: shot.width,
        height: shot.height,
        sizeBytes: shot.sizeBytes,
        data: shot.data,
      };
    }
    case 'status':
      return client.status();
  }
}

export const swarmRunCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Open N instances at once and run one action across all of them concurrently.',
  },
  args: {
    ...GLOBAL_ARGS,
    size: { type: 'string', description: 'How many instances to open.', required: true },
    action: {
      type: 'string',
      description: `Action to run on every member: ${ACTIONS.join(' | ')}.`,
      required: true,
    },
    value: { type: 'string', description: 'URL for --action navigate, text for --action type.' },
    x: { type: 'string', description: 'X for --action click.' },
    y: { type: 'string', description: 'Y for --action click.' },
    'out-dir': {
      type: 'string',
      description:
        'Directory to save each member\'s PNG for --action screenshot. Omit to include base64 "data" in the result instead.',
    },
    pool: { type: 'string', description: 'Pool id. Default "default".' },
    'profile-key': {
      type: 'string',
      description: 'Persistent profile key applied to every member. Omit for ephemeral profiles.',
    },
    headless: {
      type: 'boolean',
      description: 'Launch every member headless or headful. Omit to use the pool default.',
    },
    viewport: { type: 'string', description: 'WxH applied to every member, e.g. 1440x900.' },
    ...AFFINITY_ARGS,
    keep: {
      type: 'boolean',
      description:
        "Don't release the instances afterward. Defaults to false, except with --sticky-subject, where it defaults to true: releasing browsers you just claimed ownership of would make the next run relaunch them and the flag pointless. Pass --no-keep to release anyway.",
    },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);

    const size = Number(args['size']);
    if (!Number.isInteger(size) || size < 1) {
      printer.error(`--size must be a positive integer, got "${args['size'] as string}".`);
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    const action = args['action'] as string;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      printer.error(`--action must be one of ${ACTIONS.join(', ')}, got "${action}".`);
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    const outDir = args['out-dir'] as string | undefined;
    if (outDir !== undefined) mkdirSync(outDir, { recursive: true });

    // `--sticky-subject` is read here, at the swarm level, and handed to
    // `BrowserSwarm` rather than straight into `buildAcquireRequest`:
    // every member needs its OWN subject (`<subject>#<index>`), or all
    // `--size` acquires race onto the one instance the router's sticky
    // reuse resolves that subject to. The swarm owns that derivation and
    // hands each `acquire()` call the result; see
    // `SwarmAcquireContext`'s doc comment for the full reasoning.
    let affinity: ReturnType<typeof parseAffinityArgs>;
    try {
      affinity = parseAffinityArgs(args as Record<string, unknown>);
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    const acquireFlags = {
      pool: args['pool'] as string | undefined,
      profileKey: args['profile-key'] as string | undefined,
      headless: args['headless'] as boolean | undefined,
      viewport: args['viewport'] as string | undefined,
    };
    const x = args['x'] !== undefined ? Number(args['x']) : undefined;
    const y = args['y'] !== undefined ? Number(args['y']) : undefined;

    if (args['dry-run'] === true) {
      const ownership =
        affinity.stickySubject === undefined
          ? 'launching a new browser for every member'
          : `reattaching each member to the browser it owns as "${affinity.stickySubject}#<member index>", launching only the missing ones`;
      printer.result(
        {
          dryRun: true,
          size,
          action,
          pool: acquireFlags.pool ?? 'default',
          stickySubject: affinity.stickySubject ?? null,
        },
        (r) =>
          printer.info(
            `would open ${r.size} instance(s) in pool "${r.pool}" and run "${r.action}" on all of them, ${ownership}`,
          ),
      );
      return;
    }

    let connection: GatewayConnection;
    try {
      connection = await resolveGatewayConnection(flags);
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    // Every instanceId `acquire()` successfully created, tracked
    // regardless of whether that member's own WS connect subsequently
    // succeeded: see this file's module doc for why this must be wider
    // than `swarm.members`.
    const acquiredInstanceIds: string[] = [];

    const acquire = async (
      index: number,
      ctx: SwarmAcquireContext,
    ): Promise<{ instanceId: string; wsUrl: string; token: string }> => {
      const body = buildAcquireRequest(
        { ...acquireFlags, stickySubject: ctx.subject, stickyWithinMs: ctx.stickyWithinMs },
        `bgls-swarm-${Date.now()}-${index}`,
      );
      const acquired = await restCall<{ instanceId: string }>(
        connection,
        'POST',
        '/v1/instances',
        body,
      );
      acquiredInstanceIds.push(acquired.instanceId);
      await waitForInstanceReady(connection, acquired.instanceId);
      const token = await mintInstanceToken(connection, acquired.instanceId, DRIVING_CAPS);
      return { instanceId: acquired.instanceId, wsUrl: connection.wsUrl, token };
    };

    let results: MemberResult[] = [];
    let openError: unknown;
    try {
      const swarm = await BrowserSwarm.open({
        size,
        acquire,
        ...(affinity.stickySubject !== undefined ? { subject: affinity.stickySubject } : {}),
        ...(affinity.stickyWithinMs !== undefined
          ? { stickyWithinMs: affinity.stickyWithinMs }
          : {}),
      });
      try {
        const settled = await swarm.all(async (member: SwarmMember, index: number) =>
          runOneAction(member.client, action as Action, {
            value: args['value'] as string | undefined,
            x,
            y,
            outDir,
            index,
            instanceId: member.instanceId,
          }),
        );
        results = settled.map((r, i) => {
          const member = swarm.members[i];
          const instanceId = member?.instanceId ?? '';
          const targetId = member?.targetId ?? '';
          return r.status === 'fulfilled'
            ? { index: i, instanceId, targetId, ok: true, value: r.value }
            : { index: i, instanceId, targetId, ok: false, error: errorMessage(r.reason) };
        });
      } finally {
        await swarm.close();
      }
    } catch (err) {
      openError = err;
    }

    // Three-way, not two: `--keep` unset means "do whatever this run's
    // ownership implies". Without a subject these browsers belong to
    // nobody and nothing can ever reach them again, so releasing them is
    // the only responsible default. With one, the point of the run was to
    // own a set of browsers across runs, and releasing them at the end
    // would relaunch every one of them next time, i.e. exactly the
    // behaviour `--sticky-subject` exists to stop. `--no-keep` still
    // overrides, for a caller that genuinely wants the set torn down.
    const keep = (args['keep'] as boolean | undefined) ?? affinity.stickySubject !== undefined;
    if (!keep) {
      // Best effort, one at a time is fine here: this is teardown, not
      // the concurrent driving this command exists to demonstrate.
      for (const instanceId of acquiredInstanceIds) {
        try {
          await restCall(connection, 'DELETE', `/v1/instances/${instanceId}`);
        } catch {
          // Already gone, or never reached "ready"; nothing more this
          // command can do about it.
        }
      }
    }

    if (openError !== undefined) {
      printer.error(`swarm run: opening ${size} member(s) failed: ${errorMessage(openError)}`);
      process.exitCode = mapDriveErrorToExitCode(openError);
      return;
    }

    const failed = results.filter((r) => !r.ok).length;
    printer.result(
      { size, action, stickySubject: affinity.stickySubject ?? null, released: !keep, results },
      () => {
        for (const r of results) {
          if (r.ok) printer.info(`member ${r.index} (${r.instanceId}): ${JSON.stringify(r.value)}`);
          else printer.error(`member ${r.index} (${r.instanceId}) failed: ${r.error}`);
        }
        printer.info(`${results.length - failed}/${results.length} member(s) succeeded.`);
      },
    );
    if (failed > 0) process.exitCode = EXIT_CODES.operationalFailure;
  },
});

/** `bgls swarm`. */
export const swarmCommand = defineCommand({
  meta: { name: 'swarm', description: 'Open several instances at once and drive them together.' },
  subCommands: {
    run: swarmRunCommand,
  },
});
