/**
 * The `BrowserRuntime` extension point interface and its supporting types.
 * Implemented fully by `runtime-host` and `runtime-remote`, as a
 * correct-interface stub by `runtime-docker` and `runtime-k8s`.
 */

import type {
  BrowserChannel,
  BrowserSpec,
  HeadlessMode,
  InstanceId,
  ProfileId,
} from './entities.js';

/**
 * A minimal structural stand in for the DOM and Node `AbortSignal` type.
 * This package's `tsconfig` targets `lib: ["ES2023"]` only and pulls in
 * neither DOM nor Node ambient types, so the real `AbortSignal` name is not
 * visible here; any real `AbortSignal`, from a browser or from Node, is
 * structurally assignable to this shape.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

/** The four runtime kinds a node may load, one adapter per configured slot. */
export type RuntimeKind = 'host' | 'docker' | 'k8s' | 'remote';

/**
 * How a browser was told to stop, and how hard. Three of the four end the
 * browser and differ only in what they try first; the fourth does not end
 * it at all, which is why it gets most of this comment.
 *
 * * `'graceful'`: ask the process to exit and give it the caller's grace
 *   period to do so, then escalate. On Windows there is no signal softer
 *   than `taskkill /T /F`, so this collapses to `'force'` and
 *   `TerminateResult.effective` says so rather than escalating silently.
 * * `'clean'`: `'graceful'`, preceded by a CDP `Browser.close` so Chrome
 *   flushes Cookies, Local Storage, and Preferences before it goes.
 * * `'force'`: kill the process tree now, no grace period, nothing
 *   flushed.
 * * `'detach'`: end BrowserGlass's involvement and LEAVE THE BROWSER
 *   RUNNING. Nothing is asked of the process; supervision simply stops.
 *
 * `'detach'` exists for exactly one situation: the browser was not ours to
 * end. `runtime-remote` attaches to a CDP endpoint an operator registered,
 * which in practice is a person's own signed in Chrome with a real
 * application open in it. Sending that browser `Browser.close` on release
 * destroys work BrowserGlass never created and cannot restore. For a
 * browser BrowserGlass launched itself (`runtime-host`, `runtime-docker`,
 * `runtime-k8s`) `'detach'` is the opposite mistake: it leaks a process,
 * a profile lock, and a quota slot, so those runtimes must never be asked
 * for it. `router`'s `LocalNode.terminate` is where that split is enforced,
 * because it is the last hop that still holds the runtime object and can
 * therefore read which kind of runtime is on the other end rather than
 * trusting the caller's belief about it.
 *
 * Two consequences worth stating plainly, since both have bitten:
 *
 * 1. `'detach'` must never be a default anywhere. A caller that did not
 *    deliberately ask to leave a browser running gets a real teardown.
 * 2. A runtime that honours `'detach'` still has to forget the browser.
 *    It is no longer supervised, so the next thing that looks at that
 *    endpoint must not assume the same browser is still there, and must
 *    not assume it is gone either. Either can be true by then.
 */
export type TerminateMode = 'graceful' | 'clean' | 'force' | 'detach';

/**
 * The shared interface every runtime adapter implements: turning a
 * `BrowserSpec` plus a materialised profile into a running, reachable
 * Chrome, and enumerating what it believes is currently running so a
 * restarted node can reconcile rather than orphan every browser it started.
 */
export interface BrowserRuntime {
  readonly kind: RuntimeKind;

  /** What this runtime can and cannot do. Read once at node registration, re-read after a config reload. Router caches it per node. */
  capabilities(): RuntimeCapabilities;

  /** Cheap liveness and readiness check for the runtime itself, not any one browser. */
  probe(): Promise<RuntimeProbe>;

  /**
   * Turns a spec plus a materialised profile into a running browser. Must
   * be idempotent per `instanceId`: a second call with the same id while
   * the first is still live returns the existing handle.
   */
  launch(req: LaunchRequest): Promise<LaunchedBrowser>;

  /** Adopts a browser this process did not start. Used on node restart to reattach to survivors, and it is `runtime-remote`'s only launch path. */
  attach(req: AttachRequest): Promise<LaunchedBrowser>;

  /** Per browser resource sample, called on the node's metrics tick. */
  stats(handle: LaunchedBrowser): Promise<RuntimeStats>;

  /** Stops one browser. `mode` picks how hard. */
  terminate(handle: LaunchedBrowser, mode: TerminateMode): Promise<TerminateResult>;

  /** Enumerates everything this runtime believes is currently running, built from durable state plus a live scan. Drives reconciliation. */
  list(): Promise<readonly RuntimeInventoryEntry[]>;

  /** Releases runtime wide resources. Does not kill browsers unless the node was configured with `killOnShutdown: true`. */
  dispose(): Promise<void>;
}

/**
 * One entry in a runtime's live inventory. The fields mirror the state file
 * entry shape.
 */
export interface RuntimeInventoryEntry {
  instanceId: InstanceId;
  runtimeKind: RuntimeKind;
  pid: number | null;
  containerId: string | null;
  podName: string | null;
  cdpUrl: string;
  browserGuid: string;
  profilePath: string;
  profileFence: number;
  startedAt: number;
  engineVersion: string;
  channel: BrowserChannel;
  headless: HeadlessMode;
  labels: Readonly<Record<string, string>>;
  status: 'live' | 'orphan' | 'foreign' | 'unknown';
}

// ── LaunchRequest and AttachRequest ─────────────────────────────────────

/** The request `launch()` receives. The runtime never merges the spec, the router already did. */
export interface LaunchRequest {
  instanceId: InstanceId;
  spec: BrowserSpec;
  /** Where the profile lives on this node, plus the lease proving it may be used. The runtime refuses to launch without a valid, unexpired lease. */
  profile: MaterialisedProfile;
  /** Deadline for the whole launch, wall clock ms. Defaults to `spec.launchTimeoutMs`, clamped by the runtime's own ceiling. */
  deadlineAt: number;
  /** Opaque, forwarded into logs and container labels for correlation. */
  labels: Readonly<Record<string, string>>;
  signal: AbortSignalLike;
}

/** A profile directory the runtime may use, already materialised, checked, and leased. The runtime does not create profiles. */
export interface MaterialisedProfile {
  profileId: ProfileId | null;
  /** Node local absolute path. For docker this is the host side of the mount. */
  path: string;
  /** Where the same directory appears inside the container. Null on host. */
  containerPath: string | null;
  mode: 'ephemeral' | 'persistent' | 'template';
  lease: { fence: number; expiresAt: number } | null;
}

/** The request `attach()` receives. */
export interface AttachRequest {
  instanceId: InstanceId;
  endpoint: CdpEndpoint | null;
  recovered: RecoveredIdentity | null;
  deadlineAt: number;
  signal: AbortSignalLike;
}

/** How to reach a CDP endpoint that already exists. */
export interface CdpEndpoint {
  /** `http://127.0.0.1:9222`, `ws://...`, or `unix:///run/bgls/inst_x.sock`. */
  url: string;
  auth: { scheme: 'bearer' | 'basic'; value: string } | null;
  /** If set, attach refuses any browser whose `/json/version` reports this browser GUID, the stale CDP race guard. */
  excludeBrowserGuid: string | null;
}

/** What a state file entry tells `attach()` about a survivor it should adopt. */
export interface RecoveredIdentity {
  pid: number | null;
  containerId: string | null;
  profilePath: string;
  cdpUrl: string;
  chromeVersion: string | null;
  startedAt: number;
}

// ── LaunchedBrowser (the handle) ────────────────────────────────────────

/** The phases `launch()` passes through, timed individually so a p95 regression can be attributed to one phase. */
export type LaunchPhase = 'preflight' | 'reconcile' | 'spawn' | 'cdpWait' | 'postLaunch';

/** Best effort detail about why a browser exited without being asked to. */
export interface ExitInfo {
  at: number;
  code: number | null;
  signal: string | null;
  cause: 'oom' | 'crash' | 'external' | 'unknown';
  lastStderr: string | null;
}

/** The value object `launch()` and `attach()` both return: a handle plus a teardown closure, not a class with behaviour. */
export interface LaunchedBrowser {
  instanceId: InstanceId;
  runtimeKind: RuntimeKind;

  /** How to reach CDP from this node. Exactly one variant is set. */
  transport:
    | { kind: 'http'; cdpUrl: string; host: string; port: number }
    | { kind: 'unix'; socketPath: string; cdpUrl: string }
    | { kind: 'pipe'; fdRead: number; fdWrite: number };

  /** Full control credential. Never leaves the node. */
  cdpWsUrl: string;
  /** Chrome's per browser GUID from `/json/version`, proving we attached to the browser we launched. */
  browserGuid: string;

  /** Exactly one of `pid`/`containerId`/`podName` is non null, except `runtime-remote` where all three are null. */
  pid: number | null;
  containerId: string | null;
  podName: string | null;

  profilePath: string;
  containerProfilePath: string | null;

  /** Reported by `/json/version`, for example `Chrome/147.0.7727.15`. */
  engineVersion: string;
  protocolVersion: string;
  /** User agent Chrome reports before any spec level override. */
  nativeUserAgent: string;

  launchDurationMs: number;
  launchPhases: Readonly<Record<LaunchPhase, number>>;
  startedAt: number;

  /** True when this handle came from `attach()`, not `launch()`. */
  adopted: boolean;

  /**
   * The `StealthProfile` that actually ran for this launch, or `null` when
   * `LaunchRequest.spec.stealth` was `'off'`. Recorded so a regression can
   * be tied to a specific profile version, per `StealthProfile.version`'s
   * own doc comment: a caller that sees anti-bot detections increase after
   * a deploy can check whether this changed. Optional rather than required
   * so a runtime that has not implemented stealth support at all (today,
   * every runtime other than `runtime-host`) keeps compiling and behaving
   * exactly as before; a runtime that never sets it is read the same as
   * one that set it to `null`, since neither one ran a profile. `attach()`
   * always reports `null` (or omits the field): a browser this runtime did
   * not launch has no launch-time profile resolution to report, whatever
   * it may actually be running.
   */
  stealthProfile?: { name: string; level: 'basic' | 'full'; version: string } | null;

  /** Idempotent. Safe to call from a shutdown path. Runtime specific teardown plus removes the durable state record. */
  readonly teardown: (mode: TerminateMode) => Promise<TerminateResult>;
  /** Fires when the runtime observes the browser exit without being asked. */
  readonly onUnexpectedExit: (cb: (info: ExitInfo) => void) => () => void;
}

// ── Capabilities and probe ──────────────────────────────────────────────

/**
 * What one runtime can and cannot do. A spec asking for something the
 * node's runtime cannot do is a placement failure (retried elsewhere), not
 * a launch failure (counts against the instance).
 */
export interface RuntimeCapabilities {
  kind: RuntimeKind;
  channels: readonly BrowserChannel[];
  headlessModes: readonly HeadlessMode[];
  resourceLimits: { cpus: boolean; memoryMb: boolean; shmMb: boolean; pidsLimit: boolean };
  extensions: { unpacked: boolean; crx: boolean; withHeadlessNew: boolean };
  proxyPerInstance: boolean;
  proxyAuthPerInstance: boolean;
  timezonePerInstance: boolean;
  localePerInstance: boolean;
  fileBridge: { download: boolean; upload: boolean };
  survivesNodeRestart: boolean;
  supportsAttach: boolean;
  gracefulTerminate: boolean;
  maxConcurrentBrowsers: number;
  maxLaunchTimeoutMs: number;
  notes: readonly string[];
}

/** The result of `probe()`, a cheap check of the runtime itself, not any one browser. */
export interface RuntimeProbe {
  ok: boolean;
  status: 'ready' | 'degraded' | 'unavailable';
  detail: string;
  engine: { name: string; version: string; path: string | null } | null;
  /** Populated when `status` is not `'ready'`. Actionable. */
  remediation: string | null;
  checkedAt: number;
}

// ── stats and terminate ─────────────────────────────────────────────────

/** One resource sample for a running browser. */
export interface RuntimeStats {
  instanceId: InstanceId;
  at: number;
  /** Whole browser totals, summed across browser plus renderer, GPU, and utility children. */
  cpuPercent: number | null;
  rssBytes: number | null;
  /** Docker/k8s only. Null on host, no limit to be near. */
  memoryLimitBytes: number | null;
  /** Fraction of `memoryLimitBytes`. The OOM predictor uses this. */
  memoryPressure: number | null;
  processCount: number | null;
  openFds: number | null;
  /** Container writable layer size. Growth means downloads or cache. */
  diskWrittenBytes: number | null;
  /** True if the runtime saw an OOM kill event since the last sample. */
  oomKilledSince: boolean;
}

/** What `terminate()` actually did, which may be harsher than what was asked. */
export interface TerminateResult {
  mode: TerminateMode;
  effective: TerminateMode;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Profile lock files found and removed during teardown. */
  locksCleared: readonly string[];
  warnings: readonly string[];
}

// ── Launch error catalogue ──────────────────────────────────────────────

/**
 * The 19 launch error codes, exported from `protocol` so every runtime and the CLI agree
 * on the same names.
 */
export type LaunchErrorCode =
  | 'E_PROFILE_FOREIGN_OWNER'
  | 'E_PROFILE_LOCKED'
  | 'E_PROFILE_LEASED_ELSEWHERE'
  | 'E_PROFILE_QUARANTINED'
  | 'E_BINARY_NOT_FOUND'
  | 'E_BINARY_UNRUNNABLE'
  | 'E_NO_DISPLAY'
  | 'E_XVFB_FAILED'
  | 'E_CDP_TIMEOUT'
  | 'E_CDP_STALE_BROWSER'
  | 'E_SANDBOX_DENIED'
  | 'E_SHM_TOO_SMALL'
  | 'E_OOM_KILLED'
  | 'E_PORT_EXHAUSTED'
  | 'E_ARG_DENIED'
  | 'E_SPEC_CONFLICT'
  | 'E_DOCKER_UNAVAILABLE'
  | 'E_IMAGE_MISSING'
  | 'E_LEASE_LOST'
  /**
   * `spec.stealth` named a level (`'basic'`/`'full'`) this node's
   * `enabledStealthLevels` does not list. Added alongside the injection
   * slot below: without it, a disallowed level had nothing to fail with
   * and a runtime could only accept the request or silently ignore it.
   */
  | 'E_STEALTH_LEVEL_DISALLOWED'
  /**
   * `spec.stealth` named an enabled level, but no `StealthProfile` is
   * registered for it. This is the one code this whole feature exists to
   * make reachable: before it, `stealth: 'full'` was accepted, stored, and
   * did nothing, with no error and no signal that nothing ran.
   */
  | 'E_STEALTH_PROFILE_MISSING';

/**
 * Thrown by a runtime when `launch()` or `attach()` fails. `code` never
 * changes for a given cause, so dashboards can group on it; `context`
 * carries pids, paths, ports, and exit codes for the log pipeline, never
 * sent to an app client.
 */
export class LaunchError extends Error {
  readonly code: LaunchErrorCode;
  readonly phase: LaunchPhase;
  readonly remediation: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string | number>>;
  override readonly cause: unknown;

  constructor(opts: {
    code: LaunchErrorCode;
    phase: LaunchPhase;
    message: string;
    remediation: string;
    retryable: boolean;
    context?: Readonly<Record<string, string | number>>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'LaunchError';
    this.code = opts.code;
    this.phase = opts.phase;
    this.remediation = opts.remediation;
    this.retryable = opts.retryable;
    this.context = opts.context ?? {};
    this.cause = opts.cause;
  }
}

// ── Supervision ──────────────────────────────────────────────────────────

/** `BrowserSupervisor` construction options, one supervisor per launched browser. */
export interface SupervisorConfig {
  /** Default 5000. SIGTERM to SIGKILL escalation. */
  gracePeriodMs: number;
  /** Default 3000. `Browser.close` before falling back to signals. */
  cdpCloseTimeoutMs: number;
  /** Default 10000. */
  statsIntervalMs: number;
  /** Default 3. Consecutive failed CDP probes before `'degraded'`. */
  unhealthyProbes: number;
  /** Default false. Leave browsers running on node exit. */
  killOnShutdown: boolean;
}

/** A virtual X display, one per browser, never shared, so one browser's window cannot trip another's occlusion detection. */
export interface VirtualDisplay {
  readonly kind: 'xvfb' | 'xvnc' | 'weston' | 'none';
  /** For example `:99`, set into `DISPLAY` for the browser process. */
  readonly displayName: string;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** Resolves when the display answers a probe, not when the process spawns. */
  waitReady(timeoutMs: number): Promise<void>;
  stop(): Promise<void>;
}

// ── Stealth ─────────────────────────────────────────────────────────────

/** One check `StealthProfile.selfTest` performed against a fixture page. */
export interface StealthCheckResult {
  check: string;
  observed: string;
  expected: string;
  ok: boolean;
}

/**
 * A pluggable stealth patch set the runtime loads when `spec.stealth` is
 * `'basic'` or `'full'`. Default off, opt in only. `runtime-host` is the
 * first runtime to give this interface a real injection slot:
 * `HostRuntimeConfig.stealthProfiles` (`@browserglass/runtime-host`,
 * `config.ts`) registers one or more implementations, and
 * `HostRuntimeConfig.enabledStealthLevels` gates which levels a spec may
 * reach. A level with no registered profile fails the launch loudly
 * (`E_STEALTH_PROFILE_MISSING`) rather than accepting the request and
 * running nothing, which is what happened before this slot existed.
 */
export interface StealthProfile {
  readonly name: string;
  readonly level: 'none' | 'basic' | 'full';
  /** Semver, recorded on the instance so a regression can be tied to a specific profile version. */
  readonly version: string;
  /** Chrome majors this profile has been validated against. */
  readonly validatedChromeMajors: readonly number[];

  /** Extra launch args, passed through the same `ARG_ALLOW`/`ARG_DENY` as `extraArgs`. No exemption. */
  launchArgs(spec: BrowserSpec): readonly string[];

  /** Scripts evaluated before any page script. Array order preserved and significant. */
  initScripts(spec: BrowserSpec): readonly { name: string; source: string }[];

  /** CDP level adjustments applied once per new target. */
  onTargetAttached(ctx: StealthTargetContext): Promise<void>;

  /** Self test against `about:blank` plus a bundled local fixture page. Returns per check results, not a pass/fail score. */
  selfTest(ctx: StealthTargetContext): Promise<readonly StealthCheckResult[]>;
}

/** The per target context a `StealthProfile` receives for CDP level adjustments and self tests. */
export interface StealthTargetContext {
  cdpSessionId: string;
  targetId: string;
  /**
   * The CDP target type this hook runs for. A hook that changes page level
   * emulation (the device metrics override, for one) must skip `'iframe'`:
   * an out of process iframe has its own session, and overriding its
   * metrics would resize the frame rather than the page. Optional so a
   * hand built context in an older test still type checks.
   */
  targetType?: 'page' | 'iframe';
  evaluate: (expression: string) => Promise<unknown>;
  /**
   * Sends one CDP command on this target's session and resolves with its
   * result, or rejects if Chrome rejects the command. Added alongside
   * `evaluate`: `onTargetAttached`'s own doc comment promises "CDP level
   * adjustments", and a page-JS `evaluate` call cannot make one (there is
   * no JS API for, say, `Emulation.setAutomationOverride`). A profile that
   * only ever needs `evaluate` is free to ignore this.
   */
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

// ── Remote endpoints ────────────────────────────────────────────────────

/**
 * A named, encrypted at rest CDP endpoint an operator has registered for
 * `runtime-remote`. An app must never supply a URL directly, letting an
 * app name a CDP endpoint is an SSRF primitive that also hands the
 * attacker a browser.
 */
export interface RemoteEndpoint {
  name: string;
  tenantId: string;
  url: string;
  auth: { scheme: 'bearer' | 'basic'; value: string } | null;
}
