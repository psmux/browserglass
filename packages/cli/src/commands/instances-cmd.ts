/**
 * `bgls instances *`: the real instance and target lifecycle, promoted
 * out of `stubs.ts`'s `instancesCommand` (the "surface discoverable, gap
 * honest" placeholder). Every leaf here follows the same shape:
 *
 * - REST (`util/rest.ts`'s `restCall`) for anything the real route table
 *   (`packages/server/src/rest/router.ts`'s `LIVE`) actually serves:
 *   create, list, describe, release.
 * - `@browserglass/automation`'s `AutomationClient` (via `util/drive.ts`'s
 *   `connectAutomation`) for everything else, because the matching REST
 *   routes (`GET/POST .../targets`, `.../navigate`, `.../screenshot`) are
 *   still in `router.ts`'s `STUB_PATHS` in this build. There is no REST
 *   path for target list/create/close/click/type/console/network yet, so
 *   these go over the same `bgls.v1` socket a human viewer uses, exactly
 *   as `AutomationClient`'s own class doc describes ("automation is a
 *   Viewer").
 *
 * `kill` stays a stub: its own documented promise ("skip graceful
 * shutdown") is not something `DELETE /v1/instances/:id` can deliver in
 * this build. It is not only that the route forwards `reason`/`profile`
 * and never `ReleaseOptions.gracefulMs`: `BrowserRouter.release()`
 * (`packages/router/src/router/BrowserRouter.ts`) never reads
 * `opts.gracefulMs` at all, so forwarding it through the REST layer would
 * change nothing observable. `release()` always calls
 * `nodes.terminate(instanceId, 'graceful')` first and only escalates to
 * `'force'` if that call throws; there is no caller-selectable path to an
 * immediate force terminate anywhere in the router. Pretending `release`
 * does what `kill` promises, or wiring a field the router discards, would
 * both be exactly the dishonest gap this package's own convention refuses
 * to ship.
 */

import { writeFileSync } from 'node:fs';
import type { TabSummary } from '@browserglass/automation';
import type { AcquireRequest, InstanceView } from '@browserglass/router';
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
  buildAcquireRequest,
  connectAutomation,
  errorMessage,
  mapDriveErrorToExitCode,
  parseAffinityArgs,
  waitForInstanceReady,
  withLease,
  writeJsonLine,
} from '../util/drive.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';
import { RestClientError, restCall } from '../util/rest.js';

/** Every leaf's args include the eight global flags; this adds nothing beyond that shared base for read-only, non-driving commands. */
type Args = ParsedGlobalArgs & Record<string, unknown>;

/** Shared setup every leaf performs first: resolve global flags, build a `Printer`, resolve a `GatewayConnection`. On failure this already reports and sets `process.exitCode`; the caller should `return` when it gets back `undefined`. */
async function setup(args: Args): Promise<
  | {
      flags: ReturnType<typeof resolveGlobalFlags>;
      printer: Printer;
      connection: GatewayConnection;
    }
  | undefined
> {
  const flags = resolveGlobalFlags(args);
  const printer = new Printer(flags);
  try {
    const connection = await resolveGatewayConnection(flags);
    return { flags, printer, connection };
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_CODES.usageError;
    return undefined;
  }
}

/** Runs `fn`, reporting any thrown error through `printer` and setting the exit code `mapDriveErrorToExitCode` picks for it. Shared by every leaf below so the error handling is identical everywhere. */
async function guarded(printer: Printer, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    printer.error(errorMessage(err));
    process.exitCode = mapDriveErrorToExitCode(err);
  }
}

// ======================================================================
// list, describe, create, release: pure REST, the four routes
// `packages/server/src/rest/router.ts`'s `LIVE` table actually serves.
// ======================================================================

export const instancesListCommand = defineCommand({
  meta: { name: 'list', description: 'List instances.' },
  args: {
    ...GLOBAL_ARGS,
    pool: { type: 'string', description: 'Filter by pool id (REST query "poolId").' },
    state: { type: 'string', description: 'Filter by lifecycle state, e.g. "ready".' },
    subject: {
      type: 'string',
      description:
        'Filter by owner, the same value --sticky-subject sets on create. This is how you answer "what does this user/job already have running" before deciding to acquire.',
    },
    watch: {
      type: 'boolean',
      description:
        'Poll every 2s and reprint. No server-push events route exists in this build; this is a client-side poll loop, not a subscription.',
      default: false,
    },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;

    const query = new URLSearchParams();
    if (typeof args['pool'] === 'string') query.set('poolId', args['pool']);
    if (typeof args['state'] === 'string') query.set('state', args['state']);
    if (typeof args['subject'] === 'string') query.set('subject', args['subject']);
    const qs = query.toString();
    const path = `/v1/instances${qs.length > 0 ? `?${qs}` : ''}`;

    await guarded(printer, async () => {
      const fetchOnce = () =>
        restCall<{ items: InstanceView[]; nextCursor: string | null; hasMore: boolean }>(
          connection,
          'GET',
          path,
        );
      if (args['watch'] !== true) {
        const list = await fetchOnce();
        printer.result(list, (l) => {
          if (l.items.length === 0) {
            printer.info('No instances.');
            return;
          }
          for (const v of l.items)
            printer.info(
              `${v.instance.id}  [${v.instance.state}]  pool=${v.instance.poolId ?? '-'}  node=${v.instance.nodeId ?? '-'}`,
            );
        });
        return;
      }
      // --watch: no SIGINT/SIGTERM handler needed beyond the process's
      // default (Ctrl+C already kills a plain polling loop); this mirrors
      // `inspect.ts`'s `--follow` in spirit but over REST poll rather than
      // a live socket, since there is no `GET .../events` route to
      // subscribe to (`STUB_PATHS`).
      for (;;) {
        const list = await fetchOnce();
        if (printer.json) writeJsonLine(list);
        else
          for (const v of list.items)
            printer.info(
              `${v.instance.id}  [${v.instance.state}]  pool=${v.instance.poolId ?? '-'}  node=${v.instance.nodeId ?? '-'}`,
            );
        await new Promise((resolve) => setTimeout(resolve, 2000).unref?.());
      }
    });
  },
});

export const instancesDescribeCommand = defineCommand({
  meta: { name: 'describe', description: 'Describe one instance.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;

    await guarded(printer, async () => {
      const view = await restCall<InstanceView>(connection, 'GET', `/v1/instances/${instanceId}`);
      printer.result(view, (v) => {
        printer.info(
          `${v.instance.id}  [${v.instance.state}]  pool=${v.instance.poolId ?? '-'}  node=${v.instance.nodeId ?? '-'}`,
        );
        printer.info(
          `  spec      engine=${v.instance.spec.engine} channel=${v.instance.spec.channel} headless=${v.instance.spec.headless}`,
        );
        printer.info(`  profile   ${v.instance.profileId ?? '(none)'}`);
        if (v.live !== null)
          printer.info(`  live      viewers=${v.live.viewers} streams=${v.live.streams}`);
      });
    });
  },
});

export const instancesCreateCommand = defineCommand({
  meta: { name: 'create', description: 'Acquire a new instance.' },
  args: {
    ...GLOBAL_ARGS,
    pool: { type: 'string', description: 'Pool id. Default "default".' },
    'profile-key': {
      type: 'string',
      description: 'Persistent profile key. Omit for an ephemeral profile.',
    },
    headless: {
      type: 'boolean',
      description:
        'Launch headless (chrome "new" headless mode) or headful. Omit to use the pool default.',
    },
    viewport: { type: 'string', description: 'WxH, e.g. 1440x900.' },
    ...AFFINITY_ARGS,
    'dry-run': {
      type: 'boolean',
      description: 'Preview the AcquireRequest only; make no changes.',
      default: false,
    },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;

    let body: AcquireRequest;
    try {
      body = buildAcquireRequest({
        pool: args['pool'] as string | undefined,
        profileKey: args['profile-key'] as string | undefined,
        headless: args['headless'] as boolean | undefined,
        viewport: args['viewport'] as string | undefined,
        ...parseAffinityArgs(args as Record<string, unknown>),
      });
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.usageError;
      return;
    }

    if (args['dry-run'] === true) {
      printer.result({ dryRun: true, request: body }, (r) =>
        printer.info(`would POST /v1/instances with ${JSON.stringify(r.request)}`),
      );
      return;
    }

    await guarded(printer, async () => {
      const acquired = await restCall<{ instanceId: string; sessionId: string; state: string }>(
        connection,
        'POST',
        '/v1/instances',
        body,
      );
      // A fresh acquire is rarely `ready` the instant this resolves
      // (placement and launch both happen after); poll until it is so
      // the instanceId this prints is actually drivable by the caller's
      // very next command, not just accepted.
      const view = await waitForInstanceReady(connection, acquired.instanceId);
      const ready = view.instance.state === 'ready';
      printer.result(
        {
          instanceId: view.instance.id,
          sessionId: acquired.sessionId,
          state: view.instance.state,
          ready,
          poolId: view.instance.poolId,
          profileId: view.instance.profileId,
        },
        (r) => {
          printer.success(
            `created ${r.instanceId}  [${r.state}]${r.ready ? '' : ' (not yet ready; check "bgls instances describe" before driving it)'}`,
          );
        },
      );
      if (!ready) process.exitCode = EXIT_CODES.preconditionFailed;
    });
  },
});

export const instancesReleaseCommand = defineCommand({
  meta: { name: 'release', description: 'Release an instance.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    reason: { type: 'string', description: 'Reason, recorded on the instance.' },
    snapshot: {
      type: 'boolean',
      description:
        'Snapshot the profile before release (maps to ReleaseOptions.profile "snapshotThenKeep").',
      default: false,
    },
    force: {
      type: 'boolean',
      description:
        'End the browser even if other viewers are still attached to it. Without this, an instance somebody else is still watching is detached from this caller and left running.',
      default: false,
    },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const reason = args['reason'] as string | undefined;
    const profile = args['snapshot'] === true ? 'snapshotThenKeep' : undefined;
    const force = args['force'] === true;

    if (args['dry-run'] === true) {
      printer.result(
        { dryRun: true, instanceId, reason: reason ?? null, profile: profile ?? null },
        (r) => printer.info(`would DELETE /v1/instances/${r.instanceId}`),
      );
      return;
    }

    await guarded(printer, async () => {
      const query = new URLSearchParams();
      if (reason !== undefined) query.set('reason', reason);
      if (profile !== undefined) query.set('profile', profile);
      if (force) query.set('force', 'true');
      const qs = query.toString();
      // `outcome` and `remainingViewers` come straight from
      // `ReleaseResult`. A release that only detached this caller, because
      // an affinity-shared instance still has other viewers on it, is not
      // the same event as one that ended the browser, and printing
      // "released" for both would hide the difference at exactly the
      // moment it matters. `outcome` is optional here on purpose: a
      // gateway older than this field still answers `{released:true}`, and
      // this command should keep working against one.
      const result = await restCall<{
        released: boolean;
        outcome?: string;
        remainingViewers?: number;
      }>(connection, 'DELETE', `/v1/instances/${instanceId}${qs.length > 0 ? `?${qs}` : ''}`);
      printer.result({ instanceId, ...result }, (r) => {
        if (r.outcome === 'detached')
          printer.success(
            `detached from ${r.instanceId}; still running for ${r.remainingViewers ?? 0} other viewer(s). Pass --force to end it anyway.`,
          );
        else if (r.outcome === 'already_released')
          printer.info(`${r.instanceId} was already released; nothing to do.`);
        else printer.success(`released ${r.instanceId}`);
      });
    });
  },
});

/** `bgls instances kill`: stays a stub. See this file's module doc for why. */
export const instancesKillCommand = defineCommand({
  meta: {
    name: 'kill',
    description: 'Kill an instance, skipping graceful shutdown. Not implemented in this build.',
  },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args as ParsedGlobalArgs);
    const printer = new Printer(flags);
    const message =
      'bgls instances kill is registered but not implemented in this build: ReleaseOptions.gracefulMs is never read by BrowserRouter.release(), which always attempts a graceful terminate first and only escalates to a hard kill if that attempt throws, so nothing a caller can send skips the graceful step. Note that "bgls instances release --force" is a different thing and does exist: it means "end the browser even though other viewers are still attached", not "skip graceful shutdown". Use "bgls instances release" for a graceful release.';
    printer.result({ error: { code: 'E_NOT_IMPLEMENTED', message } }, () => printer.error(message));
    process.exitCode = EXIT_CODES.operationalFailure;
  },
});

// ======================================================================
// targets, open-target, close-target: target lifecycle. No REST route
// exists yet (`STUB_PATHS`'s `GET/POST .../targets`, `DELETE
// .../targets/:targetId`); these connect an AutomationClient and use its
// `tabs` namespace instead.
// ======================================================================

export const instancesTargetsCommand = defineCommand({
  meta: { name: 'targets', description: "List an instance's targets." },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId);
      let targets: readonly TabSummary[];
      try {
        targets = await client.tabs.list();
      } finally {
        client.close();
      }
      printer.result({ instanceId, targets }, () => {
        for (const t of targets)
          printer.info(
            `${t.targetId}  ${t.active ? '*' : ' '} ${t.title || '(untitled)'}  ${t.url}`,
          );
      });
    });
  },
});

export const instancesOpenTargetCommand = defineCommand({
  meta: { name: 'open-target', description: 'Open a new target (tab) on an instance.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    url: { type: 'string', description: 'URL to open. Default about:blank.' },
    background: {
      type: 'boolean',
      description: "Don't switch focus to the new target.",
      default: false,
    },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const url = args['url'] as string | undefined;

    if (args['dry-run'] === true) {
      printer.result({ dryRun: true, instanceId, url: url ?? null }, (r) =>
        printer.info(
          `would open a target on ${r.instanceId}${r.url !== null ? ` at ${r.url}` : ''}`,
        ),
      );
      return;
    }

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId);
      let target: TabSummary;
      try {
        target = await client.tabs.open({
          ...(url !== undefined ? { url } : {}),
          background: args['background'] === true,
        });
      } finally {
        client.close();
      }
      printer.result({ instanceId, target }, (r) =>
        printer.success(`opened ${r.target.targetId}  ${r.target.url}`),
      );
    });
  },
});

export const instancesCloseTargetCommand = defineCommand({
  meta: { name: 'close-target', description: 'Close one target on an instance.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    targetId: { type: 'positional', description: 'Target id to close.', required: true },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const targetId = args['targetId'] as string;

    if (args['dry-run'] === true) {
      printer.result({ dryRun: true, instanceId, targetId }, () =>
        printer.info(`would close ${targetId} on ${instanceId}`),
      );
      return;
    }

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId);
      try {
        await client.tabs.close(targetId);
      } finally {
        client.close();
      }
      printer.result({ instanceId, targetId, closed: true }, () =>
        printer.success(`closed ${targetId}`),
      );
    });
  },
});

// ======================================================================
// navigate, click, type, screenshot: coordinate-level driving.
// ======================================================================

export const instancesNavigateCommand = defineCommand({
  meta: { name: 'navigate', description: 'Navigate a target.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    url: { type: 'string', description: 'URL.' },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const url = args['url'] as string | undefined;
    const targetId = args['target'] as string | undefined;

    if (url === undefined) {
      printer.error('--url is required.');
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    if (args['dry-run'] === true) {
      printer.result({ dryRun: true, instanceId, targetId: targetId ?? null, url }, () =>
        printer.info(
          `would navigate ${instanceId}${targetId !== undefined ? `/${targetId}` : ''} to ${url}`,
        ),
      );
      return;
    }

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId, {
        ...(targetId !== undefined ? { targetId } : {}),
      });
      try {
        const status = await withLease(client, () => client.navigate(url));
        printer.result(status, (s) => printer.success(`${s.targetId}  ${s.url}  (${s.title})`));
      } finally {
        client.close();
      }
    });
  },
});

export const instancesClickCommand = defineCommand({
  meta: { name: 'click', description: 'Click at a point on a target.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    x: { type: 'string', description: 'X, viewport CSS pixels.' },
    y: { type: 'string', description: 'Y, viewport CSS pixels.' },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    button: { type: 'string', description: 'left | right | middle. Default left.' },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const targetId = args['target'] as string | undefined;
    const button = (args['button'] as 'left' | 'right' | 'middle' | undefined) ?? 'left';

    const x = Number(args['x']);
    const y = Number(args['y']);
    if (
      args['x'] === undefined ||
      args['y'] === undefined ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      printer.error('--x and --y are required and must be numbers.');
      process.exitCode = EXIT_CODES.usageError;
      return;
    }
    if (args['dry-run'] === true) {
      printer.result({ dryRun: true, instanceId, targetId: targetId ?? null, x, y, button }, () =>
        printer.info(
          `would click (${x},${y}) on ${instanceId}${targetId !== undefined ? `/${targetId}` : ''}`,
        ),
      );
      return;
    }

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId, {
        ...(targetId !== undefined ? { targetId } : {}),
      });
      try {
        const boundTargetId = client.targetId;
        await withLease(client, () => client.clickAt(x, y, { button }));
        printer.result({ instanceId, targetId: boundTargetId, x, y, button, clicked: true }, () =>
          printer.success(`clicked (${x},${y}) on ${boundTargetId}`),
        );
      } finally {
        client.close();
      }
    });
  },
});

export const instancesTypeCommand = defineCommand({
  meta: { name: 'type', description: 'Type text into a target (per-character key events).' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    text: { type: 'positional', description: 'Text to type.', required: true },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    'dry-run': { type: 'boolean', description: 'Preview only; make no changes.', default: false },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const text = args['text'] as string;
    const targetId = args['target'] as string | undefined;

    if (args['dry-run'] === true) {
      printer.result(
        { dryRun: true, instanceId, targetId: targetId ?? null, length: text.length },
        () =>
          printer.info(
            `would type ${text.length} character(s) into ${instanceId}${targetId !== undefined ? `/${targetId}` : ''}`,
          ),
      );
      return;
    }

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId, {
        ...(targetId !== undefined ? { targetId } : {}),
      });
      try {
        const boundTargetId = client.targetId;
        await withLease(client, () => client.type(text));
        printer.result(
          { instanceId, targetId: boundTargetId, length: text.length, typed: true },
          () => printer.success(`typed ${text.length} character(s) into ${boundTargetId}`),
        );
      } finally {
        client.close();
      }
    });
  },
});

export const instancesScreenshotCommand = defineCommand({
  meta: { name: 'screenshot', description: 'Capture a screenshot.' },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    out: {
      type: 'string',
      description: 'Output file (PNG). Omit to include base64 "data" in the result instead.',
    },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const targetId = args['target'] as string | undefined;
    const out = args['out'] as string | undefined;

    await guarded(printer, async () => {
      const client = await connectAutomation(connection, instanceId, {
        ...(targetId !== undefined ? { targetId } : {}),
      });
      try {
        const shot = await client.screenshot();
        if (out !== undefined) {
          writeFileSync(out, Buffer.from(shot.data, 'base64'));
          printer.result(
            {
              instanceId,
              targetId: shot.targetId,
              format: shot.format,
              width: shot.width,
              height: shot.height,
              sizeBytes: shot.sizeBytes,
              savedTo: out,
            },
            (r) => printer.success(`saved ${r.width}x${r.height} ${r.format} to ${r.savedTo}`),
          );
        } else {
          printer.result(
            {
              instanceId,
              targetId: shot.targetId,
              format: shot.format,
              width: shot.width,
              height: shot.height,
              sizeBytes: shot.sizeBytes,
              data: shot.data,
            },
            (r) =>
              printer.success(`captured ${r.width}x${r.height} ${r.format}, ${r.sizeBytes} bytes`),
          );
        }
      } finally {
        client.close();
      }
    });
  },
});

// ======================================================================
// console, network: diagnostics observation, `devtools` capability.
// ======================================================================

async function collectOrFollow(
  printer: Printer,
  connection: GatewayConnection,
  instanceId: string,
  targetId: string | undefined,
  feeds: { console?: boolean; errors?: boolean; network?: boolean },
  events: readonly ('console' | 'pageerror' | 'network' | 'networksummary')[],
  follow: boolean,
  collectWindowMs: number,
): Promise<void> {
  const client = await connectAutomation(connection, instanceId, {
    ...(targetId !== undefined ? { targetId } : {}),
  });
  const boundTargetId = client.targetId;
  const unsubscribes: Array<() => void> = [];
  let stopFollowing: (() => void) | undefined;
  try {
    await client.diagnostics.subscribe(feeds);

    if (!follow) {
      const collected: Array<{ type: string; entry: unknown }> = [];
      for (const type of events) {
        unsubscribes.push(client.on(type, (entry) => collected.push({ type, entry })));
      }
      await new Promise((resolve) => setTimeout(resolve, collectWindowMs).unref?.());
      printer.result({ instanceId, targetId: boundTargetId, entries: collected }, () => {
        if (collected.length === 0) {
          printer.info(
            `No events observed in ${collectWindowMs}ms. Use --follow to keep watching.`,
          );
          return;
        }
        for (const c of collected) printer.info(`[${c.type}] ${JSON.stringify(c.entry)}`);
      });
      return;
    }

    // --follow: stream indefinitely until Ctrl+C. Mirrors `inspect.ts`'s
    // `--follow`: JSON Lines to stdout in --json mode, one formatted line
    // to stderr (via printer.info) otherwise.
    if (!printer.json) printer.info(`following ${boundTargetId}. Press Ctrl+C to stop.`);
    for (const type of events) {
      unsubscribes.push(
        client.on(type, (entry) => {
          if (printer.json)
            writeJsonLine({
              ...(typeof entry === 'object' && entry !== null
                ? entry
                : { targetId: boundTargetId, value: entry }),
              type,
            });
          else printer.info(`[${type}] ${JSON.stringify(entry)}`);
        }),
      );
    }
    // A one-shot CLI process would exit right after this resolves anyway,
    // but removing exactly the listener added here (never
    // `removeAllListeners`, which would also drop any unrelated SIGINT/
    // SIGTERM handler) keeps this function safe to call more than once in
    // the same process, which every test exercising --follow relies on.
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      stopFollowing = stop;
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  } finally {
    if (stopFollowing !== undefined) {
      process.off('SIGINT', stopFollowing);
      process.off('SIGTERM', stopFollowing);
    }
    for (const un of unsubscribes) un();
    try {
      await client.diagnostics.unsubscribe();
    } catch {
      // Best effort: the socket may already be going down.
    }
    client.close();
  }
}

export const instancesConsoleCommand = defineCommand({
  meta: { name: 'console', description: "Read a target's console and page errors." },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    follow: {
      type: 'boolean',
      description: 'Stream indefinitely instead of collecting for 2s and exiting.',
      default: false,
    },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const targetId = args['target'] as string | undefined;

    await guarded(printer, () =>
      collectOrFollow(
        printer,
        connection,
        instanceId,
        targetId,
        { console: true, errors: true },
        ['console', 'pageerror'],
        args['follow'] === true,
        2000,
      ),
    );
  },
});

export const instancesNetworkCommand = defineCommand({
  meta: { name: 'network', description: "Read a target's network activity." },
  args: {
    ...GLOBAL_ARGS,
    instanceId: { type: 'positional', description: 'Instance id.', required: true },
    target: { type: 'string', description: "Target id. Default the instance's active target." },
    follow: {
      type: 'boolean',
      description: 'Stream indefinitely instead of collecting for 2s and exiting.',
      default: false,
    },
  },
  async run({ args }) {
    const setupResult = await setup(args as Args);
    if (setupResult === undefined) return;
    const { printer, connection } = setupResult;
    const instanceId = args['instanceId'] as string;
    const targetId = args['target'] as string | undefined;

    await guarded(printer, () =>
      collectOrFollow(
        printer,
        connection,
        instanceId,
        targetId,
        { console: false, errors: false, network: true },
        ['network', 'networksummary'],
        args['follow'] === true,
        2000,
      ),
    );
  },
});

/** `bgls instances`: the assembled group. */
export const instancesCommand = defineCommand({
  meta: { name: 'instances', description: 'Manage and drive browser instances.' },
  subCommands: {
    list: instancesListCommand,
    describe: instancesDescribeCommand,
    create: instancesCreateCommand,
    release: instancesReleaseCommand,
    kill: instancesKillCommand,
    targets: instancesTargetsCommand,
    'open-target': instancesOpenTargetCommand,
    'close-target': instancesCloseTargetCommand,
    navigate: instancesNavigateCommand,
    click: instancesClickCommand,
    type: instancesTypeCommand,
    screenshot: instancesScreenshotCommand,
    console: instancesConsoleCommand,
    network: instancesNetworkCommand,
  },
});
