/**
 * `HostRuntime`, the `@browserglass/runtime-host` implementation of
 * `@browserglass/protocol`'s `BrowserRuntime`. Ties together binary
 * discovery, flag composition, detached spawn, CDP endpoint discovery, the
 * durable state file, startup reattach, and the terminate ladder. Real
 * Chrome on the host OS.
 */

import type { ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import type {
  AttachRequest,
  BrowserRuntime,
  ExitInfo,
  HeadlessMode,
  LaunchRequest,
  LaunchedBrowser,
  RuntimeCapabilities,
  RuntimeInventoryEntry,
  RuntimeKind,
  RuntimeProbe,
  RuntimeStats,
  StealthProfile,
  TerminateMode,
  TerminateResult,
} from '@browserglass/protocol';
import { BinaryNotFoundError, resolveChromeBinary } from './binary-discovery.js';
import { discoverCdpEndpoint, unlinkStaleDevToolsActivePort } from './cdp-endpoint.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  defaultProfileRoot,
  defaultStateDir,
  resolveAllowNoSandbox,
} from './config.js';
import type { HostRuntimeConfig } from './config.js';
import {
  cdpTimeoutError,
  foreignOwnerError,
  noDisplayError,
  noValidLeaseError,
  profileLockedError,
  stealthArgDeniedError,
} from './errors.js';
import { buildLaunchArgs } from './flags.js';
import { type CdpIdentity, probeCdpIdentity } from './identity-probe.js';
import { chromeProcsForDataDirAsync, classifyChromeProcess, pidAlive } from './process-table.js';
import { healProfile } from './profile-heal.js';
import { listAllProfileDirs, reconcileOnStartup } from './reconcile.js';
import { killProcessTree, resolveBrowserPid, spawnDetachedChrome } from './spawn.js';
import type { StateFileEntry, StateFileStore } from './state-file.js';
import { resolveRequiredStealthProfile, validateStealthProfiles } from './stealth.js';
import { BrowserSupervisor, StderrRingBuffer } from './supervisor.js';
import { terminateBrowser } from './terminate.js';

interface LiveEntry {
  handle: LaunchedBrowser;
  supervisor: BrowserSupervisor;
  exitListeners: Set<(info: ExitInfo) => void>;
}

/** How long a reaped orphan gets to exit on SIGTERM before the reap escalates to SIGKILL. */
const ORPHAN_SIGTERM_GRACE_MS = 3000;

/**
 * Waits until no browser main process holds `profilePath`, escalating to
 * SIGKILL after {@link ORPHAN_SIGTERM_GRACE_MS}. Without this the launch
 * that follows a reap races the dying process for the profile's
 * SingletonLock, and on Linux the dying process usually wins. Returns
 * quietly at `deadlineAt`: whatever still holds the profile then is
 * reported by the launch's own CDP wait, with better context than this
 * could give.
 */
async function waitForProfileRelease(profilePath: string, deadlineAt: number): Promise<void> {
  const escalateAt = Date.now() + ORPHAN_SIGTERM_GRACE_MS;
  let escalated = false;
  while (Date.now() < deadlineAt) {
    const holders = await chromeProcsForDataDirAsync(profilePath, { maxAgeMs: 0 });
    if (holders.length === 0) return;
    if (!escalated && Date.now() >= escalateAt) {
      escalated = true;
      await Promise.all(holders.map((p) => killProcessTree(p.pid, 'SIGKILL')));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Everything {@link HostRuntime}'s handle construction needs beyond what `LaunchedBrowser` itself carries, kept out of the public handle shape rather than smuggled onto it. */
interface HandleMeta {
  profileFence: number;
  channel: string;
  headless: HeadlessMode;
  labels: Readonly<Record<string, string>>;
}

/** How much of a launching Chrome's stderr a failed launch quotes back. The tail is the part that names the reason. */
const LAUNCH_STDERR_BYTES = 4096;

/**
 * `@browserglass/runtime-host`'s `BrowserRuntime`. One instance per node
 * process. Construct with {@link createHostRuntime}, which also runs
 * startup reconciliation before the runtime is returned, so a caller never sees a `HostRuntime`
 * that has not yet accounted for whatever survived a previous process.
 */
export class HostRuntime implements BrowserRuntime {
  readonly kind: RuntimeKind = 'host';

  private readonly config: HostRuntimeConfig;
  private readonly stateStore: StateFileStore;
  private readonly live = new Map<string, LiveEntry>();
  private readonly meta = new Map<string, HandleMeta>();
  private readonly inFlightLaunches = new Map<string, Promise<LaunchedBrowser>>();
  private readonly currentlyLaunchingPids = new Set<number>();
  private gpuInitFailureSeen = false;
  private disposed = false;

  private constructor(config: HostRuntimeConfig, stateStore: StateFileStore) {
    this.config = config;
    this.stateStore = stateStore;
  }

  /**
   * Constructs the runtime and runs the full startup reattach algorithm
   * before returning, adopting every survivor the state file and the
   * live process table agree still belongs to this node.
   */
  static async create(config: HostRuntimeConfig): Promise<{
    runtime: HostRuntime;
    reconcileReport: Awaited<ReturnType<typeof reconcileOnStartup>>['report'];
  }> {
    // Fails fast, at node startup, rather than on whichever launch first
    // needs the doubly registered level: see `validateStealthProfiles`'s
    // own doc comment.
    validateStealthProfiles(config.stealthProfiles ?? []);

    const stateDir = config.stateDir ?? defaultStateDir();
    const profileRoot = config.profileRoot ?? defaultProfileRoot();
    const { store, report } = await reconcileOnStartup({
      stateDir,
      nodeId: config.nodeId,
      profileDirsToScan: listAllProfileDirs(profileRoot),
    });

    const runtime = new HostRuntime(config, store);
    for (const entry of store.list()) {
      // Every entry the state file now holds (after reconciliation
      // rewrote it to "adopted entries only") is, by construction, a
      // survivor this node just confirmed via the same GUID-verified
      // check `attach()` itself would perform.
      const identity = await probeCdpIdentity({
        cdpUrl: entry.cdpUrl,
        mode: 'adopt',
        expectBrowserGuid: entry.browserGuid,
        overallTimeoutMs: 5000,
      });
      const handle = runtime.buildHandle({
        instanceId: entry.instanceId,
        cdpUrl: entry.cdpUrl,
        identity,
        pid: entry.pid,
        profilePath: entry.profilePath,
        adopted: true,
        startedAt: entry.startedAt,
        launchDurationMs: 0,
        launchPhases: { preflight: 0, reconcile: 0, spawn: 0, cdpWait: 0, postLaunch: 0 },
      });
      runtime.registerLive(entry.instanceId, handle, {
        profileFence: entry.profileFence,
        channel: entry.channel,
        headless: entry.headless,
        labels: entry.labels,
      });
    }
    return { runtime, reconcileReport: report };
  }

  capabilities(): RuntimeCapabilities {
    const notes: string[] = [
      'xvfb-headful is not implemented yet; only headless: new and headless: off are available',
      'extensions supports only ExtensionRef.kind "path" (an unpacked directory), via --load-extension and --disable-extensions-except; "crx" and "storeId" entries are accepted by the type but no flag installs them, hence extensions.crx: false',
      'extension loading under headless: new is subject to real limits in that mode (no browser action UI, MV2 extensions do not run at all), hence extensions.withHeadlessNew: false',
      "proxyPerInstance covers the launch flags, --proxy-server and --proxy-bypass-list; proxy.username/password are answered separately at the CDP layer, because no launch flag carries a credential (packages/core/src/cdp/proxy-auth.ts's ProxyAuthHandler, armed per page/iframe target by packages/core/src/cdp/target-registry.ts, re-armed across cross origin navigation, an ordinary re-attach, and a transport reconnect, and composed with RequestGate on a shared session through CdpBridge.armProxyAuth/disarmProxyAuth so the two Fetch consumers never silently disable each other)",
      "proxyAuthPerInstance is true as of the pass that threaded BrowserSpec.proxy.username/password into createTargetRegistry's proxyAuthCredentials argument at both call sites in packages/server/src/session/factory.ts, the fresh attach and the restart; before that the CDP implementation existed and nothing fed it, which is why this flag was false while the code underneath it worked. The credential reaches exactly one CDP call, Fetch.continueWithAuth, and packages/server/test/session/factory-proxy-auth.test.ts drives a real Fetch.authRequired challenge and asserts the password appears nowhere else, in no other call and in no log line",
      'fileBridge (download/upload) is not wired yet',
      'supportsAttach also covers attach()ing to a browser this node did not launch at all (see @browserglass/cli\'s "bgls attach", local-browser-discovery.ts); an attach of that kind carries no control whatsoever over channel, headless mode, launch args, profile, extensions or proxy, since none of those were chosen by this runtime',
    ];
    if (platform() === 'win32')
      notes.push('resourceLimits are unavailable on Windows host (no cgroup equivalent)');

    const channels: RuntimeCapabilities['channels'] =
      platform() === 'win32'
        ? ['chrome', 'msedge', 'brave']
        : platform() === 'darwin'
          ? ['chrome', 'chrome-beta', 'msedge', 'brave', 'chromium']
          : ['chrome', 'chromium', 'msedge', 'brave', 'chromium-headless-shell'];

    return {
      kind: 'host',
      channels,
      headlessModes: ['new', 'off'],
      resourceLimits: { cpus: false, memoryMb: false, shmMb: false, pidsLimit: false },
      extensions: { unpacked: true, crx: false, withHeadlessNew: false },
      proxyPerInstance: true,
      proxyAuthPerInstance: true,
      timezonePerInstance: true,
      localePerInstance: true,
      fileBridge: { download: false, upload: false },
      survivesNodeRestart: true,
      supportsAttach: true,
      gracefulTerminate: true,
      // 100, was 64: raised to agree with `@browserglass/cli`'s own
      // `node.maxInstances` default (`packages/cli/src/config-resolve.ts`,
      // also 100), so the CLI's advertised node capacity is not silently
      // undercut by a lower ceiling here.
      maxConcurrentBrowsers: this.config.maxConcurrentBrowsers ?? 100,
      maxLaunchTimeoutMs: 120_000,
      notes,
    };
  }

  async probe(): Promise<RuntimeProbe> {
    try {
      const resolved = resolveChromeBinary('chrome', this.config.binaries);
      return {
        ok: true,
        status: 'ready',
        detail: `chrome ${resolved.version} at ${resolved.path}`,
        engine: { name: 'chrome', version: resolved.version, path: resolved.path },
        remediation: null,
        checkedAt: Date.now(),
      };
    } catch (err) {
      const detail = err instanceof BinaryNotFoundError ? err.message : String(err);
      return {
        ok: false,
        status: 'unavailable',
        detail,
        engine: null,
        remediation: 'install Chrome, or set BGLS_CHROME_PATH',
        checkedAt: Date.now(),
      };
    }
  }

  async launch(req: LaunchRequest): Promise<LaunchedBrowser> {
    const existingLive = this.live.get(req.instanceId);
    if (existingLive) return existingLive.handle;
    const inFlight = this.inFlightLaunches.get(req.instanceId);
    if (inFlight) return inFlight;

    const promise = this.doLaunch(req).finally(() => this.inFlightLaunches.delete(req.instanceId));
    this.inFlightLaunches.set(req.instanceId, promise);
    return promise;
  }

  private async doLaunch(req: LaunchRequest): Promise<LaunchedBrowser> {
    const overallStart = Date.now();
    const phaseDurations: Record<
      'preflight' | 'reconcile' | 'spawn' | 'cdpWait' | 'postLaunch',
      number
    > = {
      preflight: 0,
      reconcile: 0,
      spawn: 0,
      cdpWait: 0,
      postLaunch: 0,
    };
    const timed = async <T>(
      phase: keyof typeof phaseDurations,
      fn: () => Promise<T> | T,
    ): Promise<T> => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        phaseDurations[phase] = performance.now() - start;
      }
    };

    if (!req.profile.lease || req.profile.lease.expiresAt < Date.now()) {
      throw noValidLeaseError(req.profile.profileId);
    }

    // Resolved before any filesystem/process work: a disallowed level or a
    // missing profile is a pure config decision, unrelated to whether
    // Chrome is even installed, and this launch must refuse for either
    // reason rather than accept `spec.stealth` and run nothing (see
    // `stealth.ts`'s own doc comment).
    const stealthProfile = resolveRequiredStealthProfile(this.config, req.spec);

    // Headful Chrome on Linux with no display prints "Missing X server or
    // $DISPLAY" and exits, which would otherwise surface 45 seconds later
    // as a CDP timeout that says nothing about the cause.
    if (
      req.spec.headless === 'off' &&
      platform() === 'linux' &&
      !process.env['DISPLAY'] &&
      !process.env['WAYLAND_DISPLAY']
    ) {
      throw noDisplayError();
    }

    const resolved = await timed('preflight', () =>
      resolveChromeBinary(req.spec.channel, this.config.binaries),
    );

    await timed('reconcile', async () => {
      const preExisting = await chromeProcsForDataDirAsync(req.profile.path, { maxAgeMs: 0 });
      // Pids this runtime still supervises. A process parented to us that
      // is NOT in here is one we spawned and then let go of (a `'detach'`
      // terminate, or a launch that failed after spawn). On POSIX its ppid
      // stays this process for as long as we live, so `classifyChromeProcess`
      // calls it `ownedByUs`, and leaving it alone means the new Chrome
      // finds the profile's SingletonLock held, forwards its arguments to
      // the old process and exits, and this launch never sees a
      // DevToolsActivePort. Windows hid this because Chrome's launch handoff
      // leaves the browser main parented to a vanished pid, which classifies
      // as `orphan` already.
      const supervisedPids = new Set<number>();
      for (const entry of this.live.values()) {
        if (entry.handle.pid !== null) supervisedPids.add(entry.handle.pid);
      }
      const toReap: number[] = [];
      for (const proc of preExisting) {
        const classification = classifyChromeProcess(proc, {
          currentlyLaunchingPids: this.currentlyLaunchingPids,
        });
        if (classification === 'foreign') {
          throw foreignOwnerError(
            req.profile.path,
            preExisting.map((p) => p.pid),
          );
        }
        if (
          classification === 'orphan' ||
          (classification === 'ownedByUs' && !supervisedPids.has(proc.pid))
        ) {
          toReap.push(proc.pid);
        }
      }
      if (toReap.length > 0) {
        await Promise.all(toReap.map((pid) => killProcessTree(pid, 'SIGTERM')));
        await waitForProfileRelease(req.profile.path, req.deadlineAt);
      }
      unlinkStaleDevToolsActivePort(req.profile.path);

      // Last thing in the reconcile phase, and it has to be last: it
      // refuses to touch a profile any Chrome still holds, and the loop
      // above is what makes that true. See `profile-heal.ts`'s module doc
      // for what it repairs and why nothing did before it existed.
      //
      // Runs for every profile mode, not only `'persistent'`. An ephemeral
      // clone is normally clean, but `materialise()` clones a TEMPLATE,
      // and a template built from a profile that once crashed carries that
      // profile's `exit_type: "Crashed"` into every clone ever made from
      // it. Healing an already clean profile costs a stat, a parse, and a
      // rewrite of a file Chrome is about to rewrite anyway; skipping it
      // on a mode that "cannot" need it is how that case would have gone
      // unnoticed.
      //
      // The result is discarded rather than logged because this package
      // has no logger at all (nothing in `runtime.ts` logs anything), and
      // inventing one for this would be a bigger change than the repair.
      // What it repairs is asserted directly in `test/profile-heal.test.ts`
      // against a real crashed-profile fixture on disk.
      //
      // `maxProcessTableAgeMs`: the loop directly above just took an
      // uncached process table reading for this exact data dir, and on
      // Windows that reading costs about 400 ms. Taking a second one here
      // would double it on every launch to re-answer a question that was
      // answered a few microseconds ago. See `HealOptions`.
      await healProfile(req.profile.path, { maxProcessTableAgeMs: 2000 });
    });

    const { args, env, deniedStealthArgs } = buildLaunchArgs({
      spec: req.spec,
      profilePath: req.profile.path,
      profileMode: req.profile.mode,
      allowNoSandbox: resolveAllowNoSandbox(this.config),
      disableGpu: this.gpuInitFailureSeen,
      stealthArgs: stealthProfile?.launchArgs(req.spec) ?? [],
    });
    if (stealthProfile && deniedStealthArgs.length > 0) {
      // A registered profile's own args, not app-supplied `extraArgs`: see
      // `stealthArgDeniedError`'s own doc comment for why this fails the
      // launch instead of silently dropping them the way `deniedExtraArgs`
      // is dropped.
      throw stealthArgDeniedError(
        stealthProfile.name,
        deniedStealthArgs.map((d) => d.arg),
      );
    }
    // Chrome's stderr and exit status while the launch is still in doubt.
    // Without them a launch that never produces DevToolsActivePort fails
    // with nothing but a path and a deadline, when Chrome usually printed
    // exactly why it gave up. The supervisor takes over the buffer once the
    // launch succeeds.
    const launchStderr = new StderrRingBuffer(LAUNCH_STDERR_BYTES);
    let launchSettled = false;
    let earlyExit: string | null = null;
    const launchFailureDetail = (err: unknown): string => {
      const parts = [err instanceof Error ? err.message : String(err)];
      if (earlyExit) parts.push(`chrome ${earlyExit}`);
      const tail = launchStderr.contents.trim();
      parts.push(tail ? `chrome stderr: ${tail}` : 'chrome wrote nothing to stderr');
      return parts.join('; ');
    };
    const { realPid, child } = await timed('spawn', async () => {
      const spawned = spawnDetachedChrome({
        binaryPath: resolved.path,
        args,
        env,
        onStderr: (chunk) => {
          if (!launchSettled) launchStderr.push(chunk);
        },
      });
      spawned.child.once('exit', (code, signal) => {
        earlyExit = signal ? `exited on ${signal}` : `exited with code ${code}`;
      });
      this.currentlyLaunchingPids.add(spawned.spawnPid);
      try {
        const pid = await resolveBrowserPid(req.profile.path, req.deadlineAt);
        return { realPid: pid, child: spawned.child };
      } catch (err) {
        await killProcessTree(spawned.spawnPid, 'SIGKILL');
        throw new Error(launchFailureDetail(err), { cause: err });
      } finally {
        this.currentlyLaunchingPids.delete(spawned.spawnPid);
      }
    });

    let cdpUrl: string;
    let identity: CdpIdentity;
    try {
      const discovered = await timed('cdpWait', () =>
        discoverCdpEndpoint({ profilePath: req.profile.path, deadlineAt: req.deadlineAt }),
      );
      cdpUrl = discovered.cdpUrl;
      identity = discovered.identity;
    } catch (err) {
      await killProcessTree(realPid, 'SIGKILL');
      throw cdpTimeoutError(launchFailureDetail(err));
    }
    launchSettled = true;

    const handle = await timed('postLaunch', () =>
      this.buildHandle({
        instanceId: req.instanceId,
        cdpUrl,
        identity,
        pid: realPid,
        profilePath: req.profile.path,
        adopted: false,
        startedAt: overallStart,
        launchDurationMs: Date.now() - overallStart,
        launchPhases: phaseDurations,
        stealthProfile,
      }),
    );

    this.registerLive(
      req.instanceId,
      handle,
      {
        profileFence: req.profile.lease?.fence ?? 0,
        channel: req.spec.channel,
        headless: req.spec.headless,
        labels: req.labels,
      },
      child,
      launchStderr.contents,
    );
    return handle;
  }

  async attach(req: AttachRequest): Promise<LaunchedBrowser> {
    const existingLive = this.live.get(req.instanceId);
    if (existingLive) return existingLive.handle;

    const cdpUrl = req.endpoint?.url ?? req.recovered?.cdpUrl;
    if (!cdpUrl) throw new Error('attach() requires either endpoint.url or recovered.cdpUrl');
    const profilePath = req.recovered?.profilePath;
    if (!profilePath)
      throw new Error(
        'HostRuntime.attach() requires recovered.profilePath to resolve the real browser pid',
      );

    const mode = req.endpoint?.excludeBrowserGuid ? 'reused' : 'fresh';
    const identity = await probeCdpIdentity({
      cdpUrl,
      mode,
      overallTimeoutMs: Math.max(1000, req.deadlineAt - Date.now()),
      ...(req.endpoint?.excludeBrowserGuid
        ? { excludeBrowserGuid: req.endpoint.excludeBrowserGuid }
        : {}),
    });

    const found = await chromeProcsForDataDirAsync(profilePath, { maxAgeMs: 0 });
    if (found.length === 0) throw profileLockedError(profilePath, req.recovered?.pid ?? -1);
    const realPid = (found[0] as { pid: number }).pid;

    const meta: HandleMeta = { profileFence: 0, channel: 'chrome', headless: 'new', labels: {} };
    const handle = this.buildHandle({
      instanceId: req.instanceId,
      cdpUrl,
      identity,
      pid: realPid,
      profilePath,
      adopted: true,
      startedAt: req.recovered?.startedAt ?? Date.now(),
      launchDurationMs: 0,
      launchPhases: { preflight: 0, reconcile: 0, spawn: 0, cdpWait: 0, postLaunch: 0 },
    });

    this.registerLive(req.instanceId, handle, meta);
    return handle;
  }

  private buildHandle(opts: {
    instanceId: string;
    cdpUrl: string;
    identity: CdpIdentity;
    pid: number;
    profilePath: string;
    adopted: boolean;
    startedAt: number;
    launchDurationMs: number;
    launchPhases: LaunchedBrowser['launchPhases'];
    /** The `StealthProfile` `doLaunch` resolved for this launch, or `null`/omitted for `spec.stealth: 'off'` and for every `attach()` call (an adopted browser's launch time profile, if any, is not something this call can know). */
    stealthProfile?: StealthProfile | null;
  }): LaunchedBrowser {
    const raw = opts.identity.raw;
    const engineVersion =
      typeof raw['Browser'] === 'string' ? (raw['Browser'] as string) : 'unknown';
    const protocolVersion =
      typeof raw['Protocol-Version'] === 'string' ? (raw['Protocol-Version'] as string) : 'unknown';
    const nativeUserAgent =
      typeof raw['User-Agent'] === 'string' ? (raw['User-Agent'] as string) : '';
    const url = new URL(opts.cdpUrl);

    // `teardownWithGrace` is not part of `LaunchedBrowser` (that interface,
    // `protocol/domain/runtime.ts`, fixes `teardown` at `(mode) => ...`
    // with no way to name a per call grace period, and widening a shared
    // protocol interface for one runtime is not worth it). It is attached here as an extra property on
    // the same object regardless, so `LocalNode.terminate` (router) can
    // reach a real grace period override through the structural cast its
    // own `callTeardown` helper performs, while every caller that only
    // knows the plain `LaunchedBrowser`/`BrowserRuntime` interface sees
    // nothing different. `handle` is typed with the extra property up
    // front (rather than assigned via a plain `LaunchedBrowser` literal
    // and cast after) so TypeScript's excess property check does not
    // reject it.
    const handle: LaunchedBrowser & {
      teardownWithGrace: (mode: TerminateMode, gracePeriodMs?: number) => Promise<TerminateResult>;
    } = {
      instanceId: opts.instanceId as LaunchedBrowser['instanceId'],
      runtimeKind: 'host',
      transport: { kind: 'http', cdpUrl: opts.cdpUrl, host: url.hostname, port: Number(url.port) },
      cdpWsUrl: opts.identity.webSocketDebuggerUrl,
      browserGuid: opts.identity.browserGuid,
      pid: opts.pid,
      containerId: null,
      podName: null,
      profilePath: opts.profilePath,
      containerProfilePath: null,
      engineVersion,
      protocolVersion,
      nativeUserAgent,
      launchDurationMs: opts.launchDurationMs,
      launchPhases: opts.launchPhases,
      startedAt: opts.startedAt,
      adopted: opts.adopted,
      // See `LaunchedBrowser.stealthProfile`'s own doc comment: recorded so
      // a detection regression can be tied to a specific profile version.
      // `level` is narrowed to `'basic' | 'full'` here rather than
      // widened on `LaunchedBrowser` itself, since `resolveRequiredStealthProfile`
      // never returns a profile for `spec.stealth: 'off'`.
      stealthProfile: opts.stealthProfile
        ? {
            name: opts.stealthProfile.name,
            level: opts.stealthProfile.level as 'basic' | 'full',
            version: opts.stealthProfile.version,
          }
        : null,
      teardown: async (mode: TerminateMode) => this.terminate(handle, mode),
      teardownWithGrace: async (mode: TerminateMode, gracePeriodMs?: number) =>
        this.terminate(handle, mode, gracePeriodMs),
      onUnexpectedExit: (cb) => {
        const listeners = this.live.get(opts.instanceId)?.exitListeners;
        listeners?.add(cb);
        return () => listeners?.delete(cb);
      },
    };
    return handle;
  }

  private registerLive(
    instanceId: string,
    handle: LaunchedBrowser,
    meta: HandleMeta,
    child?: ChildProcess,
    launchStderr?: string,
  ): void {
    const exitListeners = new Set<(info: ExitInfo) => void>();
    const supervisor = new BrowserSupervisor({
      instanceId,
      pid: handle.pid as number,
      ...(child !== undefined ? { child } : {}),
      ...(launchStderr ? { launchStderr } : {}),
      statsIntervalMs:
        this.config.supervisor?.statsIntervalMs ?? DEFAULT_SUPERVISOR_CONFIG.statsIntervalMs,
      unhealthyProbes:
        this.config.supervisor?.unhealthyProbes ?? DEFAULT_SUPERVISOR_CONFIG.unhealthyProbes,
      onExit: (info) => {
        this.live.delete(instanceId);
        this.meta.delete(instanceId);
        this.stateStore.remove(instanceId);
        for (const cb of exitListeners) cb(info);
      },
      onGpuInitFailure: () => {
        this.gpuInitFailureSeen = true;
      },
    });
    supervisor.start();
    this.live.set(instanceId, { handle, supervisor, exitListeners });
    this.meta.set(instanceId, meta);

    this.stateStore.add({
      instanceId,
      pid: handle.pid as number,
      pgid: handle.pid as number,
      containerId: null,
      startedAt: handle.startedAt,
      cdpUrl: handle.transport.kind === 'http' ? handle.transport.cdpUrl : '',
      browserGuid: handle.browserGuid,
      profilePath: handle.profilePath,
      profileFence: meta.profileFence,
      engineVersion: handle.engineVersion,
      channel: meta.channel,
      headless: meta.headless,
      displayName: null,
      downloadDir: null,
      labels: meta.labels,
    });
  }

  async stats(handle: LaunchedBrowser): Promise<RuntimeStats> {
    const alive = handle.pid !== null && pidAlive(handle.pid);
    return {
      instanceId: handle.instanceId,
      at: Date.now(),
      cpuPercent: null,
      rssBytes: null,
      memoryLimitBytes: null,
      memoryPressure: null,
      processCount: alive ? (await chromeProcsForDataDirAsync(handle.profilePath)).length : 0,
      openFds: null,
      diskWrittenBytes: null,
      oomKilledSince: false,
    };
  }

  /**
   * `gracePeriodMs` is an addition beyond `BrowserRuntime.terminate(handle,
   * mode)`'s own two argument interface (`protocol/domain/runtime.ts`,
   * which this package leaves unchanged): a caller holding a `HostRuntime`
   * reference specifically, not just a `BrowserRuntime`, may pass a third
   * argument that overrides `config.supervisor.gracePeriodMs` for this one
   * terminate call. Extra optional parameters keep this method assignable
   * to the plain interface, so nothing that calls through the interface
   * type is affected; `LocalNode.terminate` (router) reaches this via the
   * `teardownWithGrace` property `buildHandle` attaches to every handle
   * this runtime returns, per that property's own comment.
   */
  async terminate(
    handle: LaunchedBrowser,
    mode: TerminateMode,
    gracePeriodMs?: number,
  ): Promise<TerminateResult> {
    const live = this.live.get(handle.instanceId);
    return terminateBrowser({
      pid: handle.pid as number,
      cdpWsUrl: handle.cdpWsUrl,
      profilePath: handle.profilePath,
      mode,
      cdpCloseTimeoutMs:
        this.config.supervisor?.cdpCloseTimeoutMs ?? DEFAULT_SUPERVISOR_CONFIG.cdpCloseTimeoutMs,
      gracePeriodMs:
        gracePeriodMs ??
        this.config.supervisor?.gracePeriodMs ??
        DEFAULT_SUPERVISOR_CONFIG.gracePeriodMs,
      stopSupervision: () => {
        live?.supervisor.stop();
        this.live.delete(handle.instanceId);
        this.meta.delete(handle.instanceId);
        this.stateStore.remove(handle.instanceId);
      },
    });
  }

  async list(): Promise<readonly RuntimeInventoryEntry[]> {
    return this.stateStore.list().map((e) => ({
      instanceId: e.instanceId as RuntimeInventoryEntry['instanceId'],
      runtimeKind: 'host' as const,
      pid: e.pid,
      containerId: null,
      podName: null,
      cdpUrl: e.cdpUrl,
      browserGuid: e.browserGuid,
      profilePath: e.profilePath,
      profileFence: e.profileFence,
      startedAt: e.startedAt,
      engineVersion: e.engineVersion,
      channel: e.channel as RuntimeInventoryEntry['channel'],
      headless: e.headless,
      labels: e.labels,
      status: pidAlive(e.pid) ? ('live' as const) : ('unknown' as const),
    }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const kills: Promise<unknown>[] = [];
    for (const [instanceId, entry] of this.live) {
      entry.supervisor.stop();
      if (this.config.killOnShutdown) {
        // The full force ladder, not a bare kill of the remembered pid:
        // Chrome on Windows can hand the profile over to a process outside
        // the tree `taskkill /T` walks (see `terminate.ts`), and only the
        // ladder's rescan by profile directory finds and ends that one.
        kills.push(
          terminateBrowser({
            pid: entry.handle.pid as number,
            cdpWsUrl: entry.handle.cdpWsUrl,
            profilePath: entry.handle.profilePath,
            mode: 'force',
            cdpCloseTimeoutMs: 0,
            gracePeriodMs: 0,
            stopSupervision: () => undefined,
          }).catch(() => killProcessTree(entry.handle.pid as number, 'SIGKILL')),
        );
        this.stateStore.remove(instanceId);
      }
    }
    await Promise.all(kills);
  }
}

/** Builds a {@link HostRuntime}, running startup reconciliation first. */
export async function createHostRuntime(
  config: HostRuntimeConfig,
): ReturnType<typeof HostRuntime.create> {
  return HostRuntime.create(config);
}
