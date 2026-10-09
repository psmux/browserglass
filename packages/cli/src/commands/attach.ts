/**
 * `bgls attach`: BrowserGlass's whole premise is driving the Chrome a human
 * already has open, with their logins and sessions already in it, not a
 * fresh browser this tool launched. `@browserglass/runtime-host` already
 * has both halves of that: `discoverLocalBrowser()` (`local-browser-
 * discovery.ts`) finds a running Chrome-family browser this node did not
 * spawn, and `HostRuntime.attach()` already accepts that module's own
 * output unchanged (`endpoint.url` from `candidate.wsUrl`,
 * `recovered.profilePath` from `candidate.userDataDir`; neither the
 * identity probe nor the pid resolution inside `attach()` cares who
 * launched the browser). Nothing composed the two. This command is that
 * composition, kept thin: discovery does not reach into `runtime.ts`, and
 * this command does nothing `attach()` and `discoverLocalBrowser()` do not
 * already do themselves.
 *
 * `--list` scans every candidate profile this platform knows about and
 * reports each one's status without attaching to anything, because
 * "nothing found" is a far worse answer than "Chrome is running on your
 * Default profile but remote debugging is off, and here is what to do."
 * Without `--list`, this composes `discoverLocalBrowser()` with a real
 * `HostRuntime.attach()` call: a live candidate is not merely reported, it
 * is actually attached to (CDP identity confirmed, a real pid resolved),
 * then immediately detached again via `teardown('detach')`. This command
 * is a one-shot probe, not a supervisor process; `'detach'` mode skips
 * every step that would touch the browser itself (`terminate.ts`'s own
 * doc comment), so the human's browser is left exactly as they had it,
 * whether the probe succeeds or fails.
 *
 * Every discovery outcome (`live`, `permission-blocked`,
 * `remote-debugging-disabled`, `stale-port-file`, `not-running`) reaches
 * the user with the detail text `local-browser-discovery.ts` already wrote
 * for it, unflattened: that module's whole point is that "remote debugging
 * is off" is a completely different, more actionable message than a
 * generic connection failure, and this command's job is to get that
 * message in front of a human or a script, not to paraphrase it.
 *
 * Honesty, not choreography, is still the default: a browser this process
 * did not launch gives this command no control over channel, headless
 * mode, launch args, profile, extensions, or proxy, and that is said
 * plainly in every attached result, human and `--json` alike, rather than
 * left to be discovered the hard way.
 *
 * Choreography is now offered, but only opt in (nothing is installed by
 * default, see `docs/plugins.md`). When discovery reports
 * `permission-blocked` or `remote-debugging-disabled`, this command asks
 * `packages/cli/src/plugins/registry.ts`'s `assistFor()` whether a
 * `permission-assist` plugin is installed and ready for this machine. With
 * none installed, which is the default, ordinary state, this behaves
 * exactly as it always has: the same imperative error, the same exit code,
 * the same `--json` shape. With one ready, this opens
 * `chrome://inspect/#remote-debugging` in the human's default browser,
 * rate limited across process invocations by a marker file's mtime
 * (`INSPECT_REOPEN_TTL_MS`, mirroring browser-harness's own
 * `_open_chrome_inspect_once`, `admin.py:1083`), then calls the plugin's
 * `assist()`. That opener is deliberately not part of any plugin: it is
 * cross platform (opening a URL is the same act on every platform BrowserGlass
 * runs on) and it is useful with or without a plugin able to click Chrome's
 * own "Allow" sheet next, so it lives here, next to the discovery call,
 * which is the reasoning for the split.
 *
 * A plugin's `assist()` returning `'resolved'` is never taken on trust: this
 * command re-probes via `deps.discover()` before it will retry the attach
 * (the host always re-probes), the same
 * "a file existing is never proof, a live round trip is" rule
 * `local-browser-discovery.ts` already applies to `DevToolsActivePort`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AssistOutcome,
  AssistResult,
  AssistSituation,
  PermissionAssistPlugin,
} from '@browserglass/plugin-api';
import type { LaunchedBrowser } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import {
  type LocalBrowserCandidateResult,
  type LocalBrowserDiscoveryResult,
  LocalBrowserNotFoundError,
  LocalBrowserPermissionBlockedError,
  candidateLocalBrowserProfiles,
  createHostRuntime,
  discoverLocalBrowser,
  probeLocalBrowserCandidate,
} from '@browserglass/runtime-host';
import { defineCommand } from 'citty';
import { GLOBAL_ARGS, resolveGlobalFlags } from '../context.js';
import { withDeadline } from '../plugins/load.js';
import { EMPTY_PLUGINS_FILE, defaultPluginsFilePath, readPluginsFile } from '../plugins/record.js';
import { type PluginAvailability, assistFor } from '../plugins/registry.js';
import { defaultDataDir } from '../session-file.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

const execFileAsync = promisify(execFile);

/** Said on every successful attach, human and `--json` alike: see this module's own header. */
const ATTACH_LIMITATIONS =
  'this browser was not launched by BrowserGlass: its channel, headless mode, launch args, profile, extensions and proxy are whatever the human already had running, not something this attach chose or can change.';

/** `assist()` gets 15000ms, longer than `probe()`'s 3000ms, because "a native UI sheet takes real time to appear". */
const ASSIST_TIMEOUT_MS = 15_000;

/** Open `chrome://inspect/#remote-debugging` at most once per this many milliseconds across separate process invocations, mirroring browser-harness's `INSPECT_REOPEN_TTL` (`admin.py:1080`). Repeatedly stealing focus onto a browser tab spends a human's attention, and that attention is the scarce resource this whole feature exists to save. */
export const INSPECT_REOPEN_TTL_MS = 180_000;

const CHROME_INSPECT_URL = 'chrome://inspect/#remote-debugging';

const STATUS_LABEL: Readonly<Record<LocalBrowserCandidateResult['status'], string>> = {
  live: 'LIVE',
  'permission-blocked': 'BLOCKED',
  'remote-debugging-disabled': 'DEBUG-OFF',
  'stale-port-file': 'STALE',
  'not-running': 'NOT-RUNNING',
};

function printCandidatesHuman(
  printer: Printer,
  results: readonly LocalBrowserCandidateResult[],
): void {
  for (const r of results) {
    printer.info(`  [${STATUS_LABEL[r.status]}] ${r.label}  ${r.userDataDir}`);
    printer.info(`         ${r.detail}`);
  }
  const liveCount = results.filter((r) => r.status === 'live').length;
  printer.info(
    `\n${results.length} candidate profile${results.length === 1 ? '' : 's'} checked, ${liveCount} live.`,
  );
}

/** `--json`/human payload for a successful attach. */
interface AttachedResult {
  readonly attached: true;
  readonly label: string;
  readonly instanceId: string;
  readonly profilePath: string;
  readonly pid: number | null;
  readonly cdpWsUrl: string;
  readonly browserGuid: string;
  readonly engineVersion: string;
  readonly protocolVersion: string;
  readonly adopted: boolean;
  readonly note: string;
}

/** What the installed `permission-assist` plugin did, or tried to do, once one was actually invoked. Absent entirely when no plugin ran (the default case, and identical to today's shape). */
interface AssistAttemptResult {
  readonly pluginId: string;
  readonly outcome: AssistOutcome;
  readonly detail: string;
}

/** `--json`/human payload when discovery could not produce a live candidate to attach to. `assist` is present only when a `permission-assist` plugin was actually invoked for this failure; its absence is the ordinary, default state and keeps this shape byte-for-byte identical to what it was before plugins existed. */
interface NotAttachedResult {
  readonly attached: false;
  readonly code: string;
  readonly detail: string;
  readonly candidates: readonly LocalBrowserCandidateResult[];
  readonly assist?: AssistAttemptResult;
}

function buildAttachedResult(
  instanceId: string,
  label: string,
  handle: LaunchedBrowser,
): AttachedResult {
  return {
    attached: true,
    label,
    instanceId,
    profilePath: handle.profilePath,
    pid: handle.pid,
    cdpWsUrl: handle.cdpWsUrl,
    browserGuid: handle.browserGuid,
    engineVersion: handle.engineVersion,
    protocolVersion: handle.protocolVersion,
    adopted: handle.adopted,
    note: ATTACH_LIMITATIONS,
  };
}

function printAttachedHuman(printer: Printer, r: AttachedResult): void {
  printer.success(`attached to ${r.label} at ${r.profilePath}`);
  printer.info(`  instance   ${r.instanceId}`);
  printer.info(`  pid        ${r.pid ?? '(unknown)'}`);
  printer.info(`  cdp        ${r.cdpWsUrl}`);
  printer.info(`  engine     ${r.engineVersion} (protocol ${r.protocolVersion})`);
  printer.info(`  note       ${r.note}`);
}

function printNotAttachedHuman(printer: Printer, r: NotAttachedResult): void {
  printer.error(r.detail);
  if (r.assist) {
    printer.info(
      `  permission-assist plugin "${r.assist.pluginId}", outcome ${r.assist.outcome}: ${r.assist.detail}`,
    );
  }
  if (r.candidates.length > 0) {
    printer.info('');
    printCandidatesHuman(printer, r.candidates);
  }
}

// ── The cross platform half: opening chrome://inspect, rate limited ─────
//
// This is real, working code on every platform BrowserGlass runs on,
// including this one (Windows). It touches nothing that only exists on
// macOS: opening a URL and checking a marker file's mtime are ordinary,
// fully testable filesystem and process operations.

/** The argv used to open a URL with this platform's own handler. An array, never a shell string: argument construction never goes through shell interpolation, applied here even though `url` is always the fixed {@link CHROME_INSPECT_URL} constant and never caller supplied. Exported for its own direct, per-platform test. */
export function buildOpenUrlCommand(
  url: string,
  plat: NodeJS.Platform,
): { readonly cmd: string; readonly args: readonly string[] } {
  if (plat === 'darwin') {
    return { cmd: 'open', args: [url] };
  }
  if (plat === 'win32') {
    // No shell: `rundll32` with `url.dll,FileProtocolHandler` hands the URL
    // to the OS's own registered handler without going through `cmd.exe`
    // and its own metacharacter parsing (`&`, `|`, `>`), which a plain
    // `cmd /c start` invocation would.
    return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

async function openUrlWithOsHandler(): Promise<boolean> {
  const { cmd, args } = buildOpenUrlCommand(CHROME_INSPECT_URL, process.platform);
  try {
    await execFileAsync(cmd, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens {@link CHROME_INSPECT_URL} at most once per `opts.ttlMs`
 * (default {@link INSPECT_REOPEN_TTL_MS}), tracked by `markerPath`'s mtime,
 * mirroring browser-harness's `_open_chrome_inspect_once` (`admin.py:1083`)
 * exactly: a missing marker means "never opened, go ahead"; a marker newer
 * than the TTL means "opened recently, do nothing"; opening successfully
 * touches the marker so the next call within the window is a no-op.
 *
 * Returns whether it actually opened a tab this call. Never throws: a
 * failure to write the marker or to launch the handler degrades to "did
 * not open", not a crash, since a missed reminder is a much smaller problem
 * than a command that stops working because a browser tab could not open.
 */
export async function openChromeInspectOnce(
  markerPath: string,
  opts: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly open?: () => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const now = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? INSPECT_REOPEN_TTL_MS;
  try {
    const ageMs = now - statSync(markerPath).mtimeMs;
    if (ageMs < ttlMs) {
      return false;
    }
  } catch {
    // No marker yet: this is the first call, or the data directory was
    // cleared. Either way, nothing to rate limit against, so proceed.
  }

  const opened = await (opts.open ?? openUrlWithOsHandler)();
  if (!opened) {
    return false;
  }

  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '');
    utimesSync(markerPath, now / 1000, now / 1000);
  } catch {
    // Best effort: a marker that could not be written just means the next
    // call may reopen sooner than the TTL intends, which is the rate limit
    // being too generous for one call, not a functional failure.
  }
  return true;
}

/**
 * Every `@browserglass/runtime-host` entry point {@link runAttach} calls,
 * injected so tests exercise the discover-then-attach composition and the
 * output shapes without depending on this machine having a real, running,
 * remote-debuggable Chrome. `resolveAssistPlugin` and `openChromeInspect`
 * are injected for the same reason: a test exercises the choreography
 * (or its deliberate absence) without a real plugin on disk and without
 * actually opening a browser tab.
 */
export interface AttachDeps {
  discover: typeof discoverLocalBrowser;
  scanCandidates: () => Promise<readonly LocalBrowserCandidateResult[]>;
  createRuntime: typeof createHostRuntime;
  /** Resolves the `permission-assist` plugin for this machine right now, or a named reason there is not one. `{ status: 'absent' }`, nothing recorded at all, is the default, ordinary state. */
  resolveAssistPlugin: () => Promise<PluginAvailability<PermissionAssistPlugin>>;
  /** Opens `chrome://inspect/#remote-debugging`, rate limited. See {@link openChromeInspectOnce}. */
  openChromeInspect: () => Promise<boolean>;
}

async function resolveAssistPluginReal(): Promise<PluginAvailability<PermissionAssistPlugin>> {
  const read = readPluginsFile(defaultPluginsFilePath());
  // A record that fails to parse or validate is `bgls plugins verify`'s
  // and `bgls plugins list`'s business to report in full; this command
  // degrades to the same "nothing usable" answer a genuinely empty record
  // would give, rather than failing an attach over a plugin record problem
  // that has nothing to do with the browser this command is trying to find.
  const file = read.ok ? read.file : EMPTY_PLUGINS_FILE;
  return assistFor(file, defaultDataDir());
}

const REAL_DEPS: AttachDeps = {
  discover: discoverLocalBrowser,
  // `discoverLocalBrowser()` itself stops at the first live candidate
  // (first-hit-wins is its whole point, per its own doc comment); `--list`
  // wants every candidate's status regardless, so this scans the full
  // table directly with the same per-candidate probe.
  scanCandidates: async () =>
    Promise.all(candidateLocalBrowserProfiles().map((c) => probeLocalBrowserCandidate(c))),
  createRuntime: createHostRuntime,
  resolveAssistPlugin: resolveAssistPluginReal,
  openChromeInspect: () => openChromeInspectOnce(join(defaultDataDir(), 'attach-inspect-marker')),
};

/** Calls a ready `permission-assist` plugin's `assist()` under {@link ASSIST_TIMEOUT_MS}, aborting the signal on expiry. Never throws: a plugin that throws or wedges becomes `'unavailable'` (a throw at call time is a failure, not a crash), same as the plugin having said so itself. */
async function invokeAssist(
  plugin: PermissionAssistPlugin,
  situation: AssistSituation,
): Promise<AssistResult> {
  const controller = new AbortController();
  try {
    return await withDeadline(
      plugin.assist(situation, controller.signal),
      ASSIST_TIMEOUT_MS,
      `"${plugin.id}".assist()`,
    );
  } catch (err) {
    controller.abort();
    return { outcome: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs `HostRuntime.attach()` against an already-discovered live candidate and prints the result. Factored out of {@link runAttach} so a successful re-probe after a plugin's `assist()` reports `'resolved'` can reuse it without duplicating the runtime lifecycle. */
async function attachToLiveCandidate(
  printer: Printer,
  deps: AttachDeps,
  discovery: LocalBrowserDiscoveryResult,
): Promise<number> {
  // A throwaway node identity and state directory for this one probe: this
  // command is not the long-running node that owns this browser's durable
  // registration (nothing here launched it, and nothing here supervises
  // it after the process exits), so it gets its own scratch state rather
  // than writing into whatever state directory a real "bgls serve" on this
  // machine uses. Removed in the `finally` below regardless of outcome.
  const stateDir = mkdtempSync(join(tmpdir(), 'bgls-attach-'));
  try {
    const { runtime } = await deps.createRuntime({
      nodeId: newId('nod'),
      stateDir,
      profileRoot: join(stateDir, 'profiles'),
    });
    try {
      const instanceId = newId('inst');
      const handle = await runtime.attach({
        instanceId,
        endpoint: { url: discovery.candidate.wsUrl, auth: null, excludeBrowserGuid: null },
        recovered: {
          pid: null,
          containerId: null,
          profilePath: discovery.candidate.userDataDir,
          cdpUrl: discovery.candidate.cdpUrl,
          chromeVersion: null,
          startedAt: Date.now(),
        },
        deadlineAt: Date.now() + 10_000,
        signal: { aborted: false },
      });
      try {
        const result = buildAttachedResult(instanceId, discovery.candidate.label, handle);
        printer.result(result, (r) => printAttachedHuman(printer, r));
        return EXIT_CODES.ok;
      } finally {
        // A one-shot probe, not a supervisor: this releases this node's own
        // tracking of the browser without asking the browser itself to do
        // anything ('detach' mode skips every step that would touch the
        // process, per `terminate.ts`'s own doc comment). The human's
        // browser is left exactly as they had it.
        await handle.teardown('detach');
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Builds the {@link AssistSituation} `permission-assist.ts` describes, from whichever discovery failure triggered it. Only called once a `'ready'` plugin exists, so the extra `scanCandidates()` round trip for `LocalBrowserPermissionBlockedError` (which does not carry the candidate's own `label`) never runs on the default, no-plugin path. */
async function buildAssistSituation(
  deps: AttachDeps,
  err: LocalBrowserPermissionBlockedError,
): Promise<AssistSituation>;
async function buildAssistSituation(
  deps: AttachDeps,
  err: LocalBrowserNotFoundError,
  disabledCandidate: LocalBrowserCandidateResult,
): Promise<AssistSituation>;
async function buildAssistSituation(
  deps: AttachDeps,
  err: LocalBrowserPermissionBlockedError | LocalBrowserNotFoundError,
  disabledCandidate?: LocalBrowserCandidateResult,
): Promise<AssistSituation> {
  if (err instanceof LocalBrowserPermissionBlockedError) {
    const results = await deps.scanCandidates();
    const match = results.find((r) => r.userDataDir === err.userDataDir);
    return {
      status: 'permission-blocked',
      userDataDir: err.userDataDir,
      label: match?.label ?? 'chrome',
      cdpUrl: err.cdpUrl,
      detail: err.message,
    };
  }
  const disabled = disabledCandidate as LocalBrowserCandidateResult;
  return {
    status: 'remote-debugging-disabled',
    userDataDir: disabled.userDataDir,
    label: disabled.label,
    cdpUrl: null,
    detail: disabled.detail,
  };
}

/**
 * Handles a discovery failure: builds the same {@link NotAttachedResult}
 * this command has always printed, and, only when a `permission-assist`
 * plugin is installed and reports `'ready'` for this machine, also opens
 * `chrome://inspect` (rate limited) and calls the plugin before printing.
 *
 * With no plugin installed (`resolveAssistPlugin()` answers anything other
 * than `'ready'`, and `'absent'` is the default), this prints exactly what
 * it always has: same detail, same candidates, same exit code, no `assist`
 * field at all. Absence is the normal case, and it costs this path nothing beyond the one `resolveAssistPlugin()`
 * call already required to find that out.
 */
async function handleDiscoveryFailure(
  printer: Printer,
  deps: AttachDeps,
  err: LocalBrowserPermissionBlockedError | LocalBrowserNotFoundError,
): Promise<number> {
  const baseResult: NotAttachedResult =
    err instanceof LocalBrowserPermissionBlockedError
      ? { attached: false, code: err.code, detail: err.message, candidates: [] }
      : { attached: false, code: err.code, detail: err.message, candidates: err.searched };

  const disabledCandidate =
    err instanceof LocalBrowserNotFoundError
      ? err.searched.find((r) => r.status === 'remote-debugging-disabled')
      : undefined;
  const assistable =
    err instanceof LocalBrowserPermissionBlockedError || disabledCandidate !== undefined;

  if (!assistable) {
    printer.result(baseResult, (r) => printNotAttachedHuman(printer, r));
    return EXIT_CODES.preconditionFailed;
  }

  const availability = await deps.resolveAssistPlugin();
  if (availability.status !== 'ready') {
    // Nothing usable installed: today's behaviour, unchanged.
    printer.result(baseResult, (r) => printNotAttachedHuman(printer, r));
    return EXIT_CODES.preconditionFailed;
  }

  const situation =
    err instanceof LocalBrowserPermissionBlockedError
      ? await buildAssistSituation(deps, err)
      : await buildAssistSituation(deps, err, disabledCandidate as LocalBrowserCandidateResult);

  await deps.openChromeInspect();

  const plugin = availability.plugin;
  const assistResult = await invokeAssist(plugin, situation);

  if (assistResult.outcome === 'resolved') {
    // The plugin's own word is not proof: re-probe before trusting it, exactly as `local-browser-
    // discovery.ts` never trusts a `DevToolsActivePort` file on its own.
    try {
      const reprobed = await deps.discover();
      return attachToLiveCandidate(printer, deps, reprobed);
    } catch {
      const enriched: NotAttachedResult = {
        ...baseResult,
        assist: {
          pluginId: plugin.id,
          outcome: assistResult.outcome,
          detail: `${assistResult.detail} (a re-probe afterwards still could not confirm it; retry once you have checked by hand)`,
        },
      };
      printer.result(enriched, (r) => printNotAttachedHuman(printer, r));
      return EXIT_CODES.preconditionFailed;
    }
  }

  const enriched: NotAttachedResult = {
    ...baseResult,
    assist: { pluginId: plugin.id, outcome: assistResult.outcome, detail: assistResult.detail },
  };
  printer.result(enriched, (r) => printNotAttachedHuman(printer, r));
  return EXIT_CODES.preconditionFailed;
}

/**
 * The command's real work, factored out of `run()` so it is unit
 * testable. Returns the process exit code.
 */
export async function runAttach(
  printer: Printer,
  list: boolean,
  deps: AttachDeps = REAL_DEPS,
): Promise<number> {
  if (list) {
    const results = await deps.scanCandidates();
    printer.result({ candidates: results }, (r) => printCandidatesHuman(printer, r.candidates));
    return results.some((r) => r.status === 'live') ? EXIT_CODES.ok : EXIT_CODES.preconditionFailed;
  }

  let discovery: LocalBrowserDiscoveryResult;
  try {
    discovery = await deps.discover();
  } catch (err) {
    if (
      err instanceof LocalBrowserPermissionBlockedError ||
      err instanceof LocalBrowserNotFoundError
    ) {
      return handleDiscoveryFailure(printer, deps, err);
    }
    throw err;
  }

  return attachToLiveCandidate(printer, deps, discovery);
}

/** `bgls attach`. */
export const attachCommand = defineCommand({
  meta: {
    name: 'attach',
    description:
      'Find and attach to a Chrome-family browser the human already has open, not one BrowserGlass launched. --list reports every candidate profile and its status without attaching to anything.',
  },
  args: {
    ...GLOBAL_ARGS,
    list: {
      type: 'boolean',
      description: 'List every candidate browser profile and its status, without attaching.',
      default: false,
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args);
    const printer = new Printer(flags);
    try {
      process.exitCode = await runAttach(printer, args.list === true);
    } catch (err) {
      printer.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_CODES.operationalFailure;
    }
  },
});
