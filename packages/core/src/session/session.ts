/**
 * `Session`: the live socket multiplexer for one Instance, everything in
 * memory except its durable `SessionRow` shadow (`toSessionRow()`). This is
 * the assembly point: it wires `../cdp/**`, `../control/**`, `../stream/**`,
 * and `../input/**` together, drives the `Session` and `Viewer` state
 * machines through `@browserglass/protocol`'s shared `transition()` helper,
 * and runs the recovery ladder (`../recovery/**`) per target.
 *
 * Per-target capture selection follows what a concurrent screencast
 * experiment showed: `TargetActivationPolicy` keeps exactly one
 * subscribed target on a live `CdpScreencastSource` and every other one on
 * `ScreenshotPollSource`, never assuming more than one target can produce
 * continuous live frames at once.
 *
 * Full frame fan-out (`Attachment`, tier assignment, `fanOut`) deliberately
 * lives outside this module: `AttachmentTransport` is a WebSocket concept,
 * and the WebSocket transport belongs to the gateway package. This class is
 * about session lifecycle and the recovery ladder, not frame delivery.
 * `Session` tracks subscription membership (who is subscribed to which
 * target, for the watchdog's participant count) and frame arrival timing
 * (for staleness detection), which is everything the recovery module needs.
 */

import {
  type InstanceId,
  type LeaseMode,
  SESSION_TRANSITIONS,
  type SessionEvent,
  type SessionId,
  type SessionRow,
  type SessionState,
  type TargetId,
  type TransitionOutcome,
  transition,
} from '@browserglass/protocol';
import type { CdpBridge } from '../cdp/bridge.js';
import type { TargetRegistry } from '../cdp/target-registry.js';
import type { TargetRuntime } from '../cdp/target-types.js';
import type { CdpSessionId, Unsubscribe } from '../cdp/types.js';
import type { Clock } from '../control/clock.js';
import { createSystemClock } from '../control/clock.js';
import type { ControlTiming } from '../control/constants.js';
import { ControlLeaseEngine } from '../control/lease-engine.js';
import type { ControlPolicyName } from '../control/policies.js';
import type { HolderKind } from '../control/types.js';
import {
  type DiagnosticsFeeds,
  type DiagnosticsSink,
  TargetDiagnostics,
} from '../diagnostics/index.js';
import { DownloadBridge, type DownloadSink } from '../downloads/index.js';
import type { InputCdpSender } from '../input/cdp-allowlist.js';
import { InputDispatcher, type InputTargetResolver } from '../input/dispatcher.js';
import { RequestGate, type RequestGateHandler } from '../interception/request-gate.js';
import { CrashBudget } from '../recovery/crash-budget.js';
import { RecoveryRunner } from '../recovery/runner.js';
import { SingleFlight, targetFlightKey } from '../recovery/single-flight.js';
import type { RecoverySignal, RecoveryTarget } from '../recovery/types.js';
import {
  DEFAULT_WATCHDOG_TIMING,
  FrameStalenessWatchdog,
  type WatchdogTiming,
} from '../recovery/watchdog.js';
import { InstanceStreamCounter } from '../stream/caps.js';
import { Stream } from '../stream/stream.js';
import type { FrameSource, FrameSourceSpec, RawFrame } from '../stream/types.js';
import { createCdpRecoveryTarget } from './recovery-target.js';
import { TargetActivationPolicy } from './target-activation.js';
import {
  DEFAULT_SESSION_LIFETIME_TIMING,
  type SessionEffect,
  type SessionLifetimeTiming,
  type SessionViewerIdentity,
} from './types.js';
import { type Viewer, type ViewerOptions, createViewer } from './viewer.js';

/** Allowed URL schemes for a best-effort URL restore (R3's blank-URL crash-budget step, and R4's own best-effort restore). Anything else is dropped in favour of `about:blank`. */
const RESTORABLE_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'about:'];

function isRestorableUrl(url: string | null): boolean {
  if (!url) return false;
  if (url === 'about:blank') return true;
  try {
    const scheme = new URL(url).protocol;
    return RESTORABLE_URL_SCHEMES.includes(scheme) && url !== 'about:';
  } catch {
    return false;
  }
}

/** One target's per-Session bookkeeping: its `Stream`, watchdog, lazily-built `ControlLeaseEngine`, and the participant set the watchdog reads. */
interface PerTargetState {
  readonly targetId: TargetId;
  readonly stream: Stream;
  readonly watchdog: FrameStalenessWatchdog;
  readonly recoveryTarget: RecoveryTarget;
  leaseEngine: ControlLeaseEngine | null;
  readonly viewerIds: Set<string>;
  lastFrameAtMono: number;
  lastInputAtMono: number;
  loading: boolean;
  dialogOpen: boolean;
  /** Lazily built by `setDiagnostics`, one per target like `leaseEngine`; see that method's doc. `null` until a viewer ever asks for diagnostics on this target. */
  diagnostics: TargetDiagnostics | null;
  /** Lazily built by `setRequestGate`, same shape as {@link diagnostics}. `null` until a caller actually registers a gate, which is what keeps `Fetch.enable` off every target that never asked for it. */
  requestGate: RequestGate | null;
  /** Lazily built by `startDownloadCapture`, same shape as {@link diagnostics}. `null` until a caller has actually asked to capture this target's downloads, which is what keeps `Page.setDownloadBehavior{eventsEnabled:true}` off every target nobody asked about (`../downloads/download-bridge.ts`'s module doc). */
  download: DownloadBridge | null;
}

/**
 * How this Session builds every `ControlLeaseEngine` it owns
 * (`Session.leaseEngineFor`). One setting for the whole Session, not per
 * target: mode is server side configuration, deliberately not a
 * `control.request` wire field, because arbitration has to be single valued
 * for a contended resource.
 *
 * Every key here is passed straight through to
 * `ControlLeaseEngineOptions`. The set is closed and validated at
 * construction ({@link assertKnownControlOptions}): a key this type does not
 * name is a configuration error, not something to drop on the floor. Shared
 * control shipped inert for exactly that reason, `session.control.mode` was
 * accepted by the server config and then never reached this class.
 */
export interface SessionControlOptions {
  /**
   * How many people may drive one target at once. Default `'exclusive'`,
   * which is what every existing integration already relies on.
   * `'shared'` admits N concurrent holders, each with their own `leaseId`.
   * Downgraded to `'exclusive'`, loudly, when `timing.allowShared` is false
   * (see `ControlLeaseEngineOptions.mode`).
   */
  readonly mode?: LeaseMode;
  /** Overrides for `CONTROL_TIMING` (lease TTL, disconnect grace, `allowShared`, and so on). */
  readonly timing?: Partial<ControlTiming>;
  /** Maximum queue depth before a request is denied `queue_full`. Exclusive mode only: nobody queues on a shared target. */
  readonly maxQueueDepth?: number;
  /** Which `ControlPolicy` arbitrates requests. Default `'exclusive'`. */
  readonly policyName?: ControlPolicyName;
}

/** The keys {@link SessionControlOptions} accepts, in one place so {@link assertKnownControlOptions} cannot drift from the type. */
const KNOWN_CONTROL_OPTION_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(['mode', 'timing', 'maxQueueDepth', 'policyName']),
);

/** The `LeaseMode` values this build understands. Anything else is a configuration error. */
const KNOWN_LEASE_MODES: ReadonlySet<string> = Object.freeze(
  new Set<LeaseMode>(['exclusive', 'shared']),
);

/**
 * Rejects a control option this Session would not act on, at construction,
 * with the offending key named.
 *
 * A configuration key that is accepted and then silently dropped is the
 * worst of both worlds: the operator believes the setting took, and nothing
 * anywhere reports otherwise. `session.control.mode` was in that state for
 * this whole feature, accepted by `resolveConfig` (which rejects no key it
 * does not recognise) and read by nobody, so shared control was configurable
 * and inert at the same time. Failing here turns that class of bug into a
 * startup error naming the key.
 */
function assertKnownControlOptions(control: SessionControlOptions): void {
  for (const key of Object.keys(control)) {
    if (!KNOWN_CONTROL_OPTION_KEYS.has(key)) {
      throw new Error(
        `Session: unknown control option 'session.control.${key}'. Known options: ${[...KNOWN_CONTROL_OPTION_KEYS].join(', ')}.`,
      );
    }
  }
  if (control.mode !== undefined && !KNOWN_LEASE_MODES.has(control.mode)) {
    throw new Error(
      `Session: unknown control mode '${String(control.mode)}'. Known modes: ${[...KNOWN_LEASE_MODES].join(', ')}.`,
    );
  }
}

/** Constructor options for {@link Session}. */
export interface SessionOptions {
  readonly id: SessionId;
  readonly instanceId: InstanceId;
  readonly tenantId: string;
  readonly nodeId: string;
  readonly bridge: CdpBridge;
  readonly registry: TargetRegistry;
  readonly clock?: Clock;
  readonly lifetimeTiming?: Partial<SessionLifetimeTiming>;
  readonly watchdogTiming?: Partial<WatchdogTiming>;
  readonly crashBudget?: CrashBudget;
  readonly onEffect: (effect: SessionEffect) => void;
  /** Step 3 of the crash budget's escalation: quarantine the profile before the `R3` recreate. Optional; core has no profile-management access of its own. */
  readonly quarantineProfile?: (targetId: string) => void | Promise<void>;
  /**
   * `R4`'s real mechanism: closes the existing browser process, preserves
   * or destroys the profile per `preserveProfile`, relaunches, and returns
   * a freshly connected `CdpBridge` plus a freshly started `TargetRegistry`
   * on the new browser. Out of this package's own reach to build (`core`
   * neither spawns nor supervises Chrome, `runtime-host` does, reached via
   * `router.restart()`); `packages/server/src/session/factory.ts` is the
   * one real caller that wires this to `BrowserRouter.restart()` plus a
   * fresh `createCdpBridge()`/`createTargetRegistry()` pair. Defaults to a
   * function that always resolves `{ ok: false }`, so an `R4` request
   * without an injected executor cleanly reports "not recovered" rather
   * than silently pretending to succeed. A resolved
   * `{ ok: true, ... }`'s `bridge`/`registry` become this `Session`'s own
   * (`restartInstance()`'s `applyRebind`); the caller must not use them for
   * anything else afterward.
   */
  readonly restartInstanceExecutor?: (
    lastUrl: string | null,
    preserveProfile: boolean,
  ) => Promise<
    | { readonly ok: false }
    | { readonly ok: true; readonly bridge: CdpBridge; readonly registry: TargetRegistry }
  >;
  readonly screencastQuality?: FrameSourceSpec;
  readonly ownerViewerIds?: ReadonlySet<string>;
  /**
   * Overrides `InstanceStreamCounter`'s cap on how many targets this
   * Instance may stream (live or background) at once (`../stream/caps.js`'s
   * `DEFAULT_MAX_STREAMS_PER_INSTANCE` otherwise). Now that per-window
   * isolation lets several targets stream genuinely concurrently, this is a
   * resource guard, not an architectural one-live-target-per-Instance wall;
   * a host application that needs more than the default headroom can raise
   * it here.
   */
  readonly maxStreamsPerInstance?: number;
  /**
   * Called for every raw frame any managed target's `FrameSource` produces,
   * active or background alike, immediately after this Session's own `seq`
   * bookkeeping for that frame (`per.stream.nextSeq()`) so the seq this
   * callback receives is exactly the one this frame was assigned, including
   * frames no viewer will ever see (the gateway's frame emission needs
   * `seq` incremented per attempted send, never per successful send,
   * matching `Stream.nextSeq()`'s own contract). `core` builds no
   * `Attachment`, tier assignment, or fan-out of its own (see the module
   * doc); this is the one seam an outside transport layer (the WebSocket
   * gateway package's session module) uses to build that pipeline without
   * reaching into this class's private state. Optional and a no-op by
   * default, so every existing caller of `Session` is unaffected.
   */
  readonly onFrame?: (
    targetId: string,
    frame: RawFrame,
    seq: number,
    gen: number,
    tsDeltaMs: number,
  ) => void;
  /**
   * How this Session builds its `ControlLeaseEngine`s; see
   * {@link SessionControlOptions}. Omitted means the exclusive defaults,
   * which is what every existing caller gets.
   *
   * This is the ONE path from configuration to
   * `ControlLeaseEngineOptions.mode`. Without it `leaseEngineFor` builds
   * every engine without a mode, so `'shared'` defaults back to
   * `'exclusive'` and a shared target answers a second `control.request`
   * with `{granted: false, queued: true, position: 1}`.
   */
  readonly control?: SessionControlOptions;
}

/** The default screencast capture spec, used when `SessionOptions.screencastQuality` is not supplied. */
const DEFAULT_CAPTURE_SPEC: FrameSourceSpec = Object.freeze({
  codec: 'jpeg',
  quality: 80,
  maxWidth: 1440,
  maxHeight: 900,
  everyNthFrame: 1,
});

/**
 * The live socket multiplexer for one Instance. See the module doc for
 * scope and the capture activation policy.
 */
export class Session {
  readonly id: SessionId;
  readonly instanceId: InstanceId;
  readonly tenantId: string;
  readonly nodeId: string;

  private readonly clock: Clock;
  /** Not `readonly`: `restartInstance()`'s `applyRebind` swaps this to the fresh `CdpBridge` a successful `R4` executor returns, since the old one's WebSocket dies with the terminated browser process and `CdpBridge.connect()` refuses to be called a second time on the same instance (`../cdp/bridge.ts`). */
  private bridge: CdpBridge;
  /** Not `readonly`; see {@link bridge}'s note, same swap. */
  private registry: TargetRegistry;
  private readonly onEffect: (effect: SessionEffect) => void;
  private readonly lifetime: SessionLifetimeTiming;
  private readonly ownerViewerIds: ReadonlySet<string>;
  private readonly captureSpec: NonNullable<SessionOptions['screencastQuality']>;
  private readonly onFrameHook: SessionOptions['onFrame'];
  /** Validated at construction; see {@link SessionControlOptions}. Frozen so a caller cannot mutate it out from under an engine built earlier. */
  private readonly controlOptions: Readonly<SessionControlOptions>;
  /** Enforces `SessionOptions.maxStreamsPerInstance` : one acquire per target that gets a `PerTargetState` (`ensureTargetState`), one release per target whose `PerTargetState` is torn down (`teardownTarget`, and `applyRebind`'s equivalent teardown on `restartInstance`). */
  private readonly streamCounter: InstanceStreamCounter;

  private _state: SessionState = 'provisioning';
  private stateReason: string | null = null;
  readonly startedAtMono: number;
  private endedAtMono: number | null = null;
  private endReason: string | null = null;
  private peakViewers = 0;

  private readonly viewers = new Map<string, Viewer>();
  private readonly perTarget = new Map<string, PerTargetState>();
  /** Not `readonly`: rebuilt against the fresh `bridge`/`registry` by `restartInstance()`'s `applyRebind` (its closures capture `this.bridge`/`this.registry` by field read, but `../cdp/errors.ts`'s attach-failure bookkeeping is per `TargetActivationPolicy` instance, so a rebuild, not a mutation in place, is the correct reset). */
  private activation: TargetActivationPolicy;
  /** Not `readonly`; see {@link activation}'s note. `InputDispatcher` is rebuilt, not just re-pointed, because its constructor captures `bridge` by value (`InputDispatcherOptions.bridge`), not through a `this.bridge` closure the way `buildInputTargetResolver()`'s `targets` option does. */
  private inputDispatcher: InputDispatcher;
  private readonly recoveryRunner: RecoveryRunner;
  private readonly targetFlight = new SingleFlight<string>();
  private readonly instanceFlight = new SingleFlight<string>();
  private readonly crashBudget: CrashBudget;
  private readonly quarantineProfile: SessionOptions['quarantineProfile'];
  private readonly restartInstanceExecutor: NonNullable<SessionOptions['restartInstanceExecutor']>;
  /** {@link createTarget}'s own single-flight for a transparent relaunch, deliberately separate from `restartInstance()`'s instance-scope `SingleFlight` (`../recovery/single-flight.ts`); see that method's doc for why. `null` when no relaunch is in flight. */
  private relaunchInFlight: Promise<boolean> | null = null;

  private readonly registryUnsubs: Unsubscribe[] = [];
  /** Targets whose registry-level detach/crash events must be ignored: either already mid-recovery (self-triggered noise, see the `registry.on('detached', ...)` wiring below) or being torn down intentionally by this Session. */
  private readonly suppressSignalsFor = new Set<string>();

  /** Set synchronously, immediately before `inputDispatcher.enqueue()`, and read back inside the `checkFencing` closure; see the module doc's note on `InputDispatcherOptions.checkFencing`'s signature gap. */
  private fencingTargetId: string | null = null;

  private idleTimer: ReturnType<Clock['setTimer']> | null = null;
  private graceTimer: ReturnType<Clock['setTimer']> | null = null;
  private maxDurationTimer: ReturnType<Clock['setTimer']> | null = null;
  private noViewerTimer: ReturnType<Clock['setTimer']> | null = null;
  private busyUntilMono = 0;
  private extendedCount = 0;
  private readonly maxExtensions = 3;
  private readonly extendMs = 7_200_000;

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.instanceId = opts.instanceId;
    this.tenantId = opts.tenantId;
    this.nodeId = opts.nodeId;
    this.bridge = opts.bridge;
    this.registry = opts.registry;
    this.clock = opts.clock ?? createSystemClock();
    this.onEffect = opts.onEffect;
    this.lifetime = Object.freeze({ ...DEFAULT_SESSION_LIFETIME_TIMING, ...opts.lifetimeTiming });
    this.ownerViewerIds = opts.ownerViewerIds ?? new Set();
    this.captureSpec = opts.screencastQuality ?? DEFAULT_CAPTURE_SPEC;
    this.onFrameHook = opts.onFrame;
    assertKnownControlOptions(opts.control ?? {});
    this.controlOptions = Object.freeze({ ...opts.control });
    this.streamCounter = new InstanceStreamCounter(
      opts.maxStreamsPerInstance !== undefined
        ? { maxStreamsPerInstance: opts.maxStreamsPerInstance }
        : {},
    );
    this.crashBudget = opts.crashBudget ?? new CrashBudget();
    this.quarantineProfile = opts.quarantineProfile;
    this.restartInstanceExecutor =
      opts.restartInstanceExecutor ?? (() => Promise.resolve({ ok: false }));
    this.startedAtMono = this.clock.monotonicNow();

    this.activation = this.buildActivation();
    this.inputDispatcher = this.buildInputDispatcher();

    this.recoveryRunner = new RecoveryRunner({
      instanceId: this.instanceId,
      clock: this.clock,
      targetFlight: this.targetFlight,
      instanceFlight: this.instanceFlight,
      crashBudget: this.crashBudget,
      ...(this.quarantineProfile ? { quarantineProfile: this.quarantineProfile } : {}),
      onProgress: (event) => this.onEffect({ kind: 'recovery.progress', event }),
      onRecovered: (event) => {
        const per = this.perTarget.get(event.targetId);
        per?.watchdog.noteRecoverySuccess(event.rung, event.signal);
        this.onEffect({ kind: 'recovery.recovered', event });
      },
      onUnrecoverable: (event) => this.handleUnrecoverable(event),
    });

    this.registryUnsubs.push(
      this.registry.on('crashed', (t) => this.reportSignal(t.id, 'target_crashed')),
      this.registry.on('detached', (t) => this.reportSignal(t.id, 'cdp_detached')),
    );

    this.armMaxDurationTimer();
  }

  // ── state ────────────────────────────────────────────────────────────

  get state(): SessionState {
    return this._state;
  }

  /** Applies one `SessionEvent` through the shared `transition()` helper against `SESSION_TRANSITIONS`. */
  private applyEvent(event: SessionEvent, ctx: unknown = {}): TransitionOutcome<SessionState> {
    const outcome = transition(SESSION_TRANSITIONS, 'Session', this.id, this._state, event, ctx);
    if (outcome.kind === 'ok') {
      this._state = outcome.to;
      if (outcome.to === 'ended' && this.endedAtMono === null) {
        this.endedAtMono = this.clock.monotonicNow();
      }
    }
    return outcome;
  }

  /** The durable shadow row: everything about viewers, streams, attachments, and control leases is deliberately excluded. */
  toSessionRow(): SessionRow {
    return {
      id: this.id,
      instanceId: this.instanceId,
      tenantId: this.tenantId as SessionRow['tenantId'],
      nodeId: this.nodeId as SessionRow['nodeId'],
      state: this._state,
      startedAt: this.startedAtMono,
      endedAt: this.endedAtMono,
      endReason: this.endReason,
      peakViewers: this.peakViewers,
    };
  }

  /** Marks the session provisioned (targets enumerated, arming timers). Call once after `TargetRegistry.start()` resolves. */
  provision(): TransitionOutcome<SessionState> {
    return this.applyEvent('provisioned', { targetRegistryPopulated: true });
  }

  // ── viewers ──────────────────────────────────────────────────────────

  /** Registers a new viewer and marks the session live. */
  addViewer(opts: Omit<ViewerOptions, 'sessionId'>): Viewer {
    const viewer = createViewer({ ...opts, sessionId: this.id });
    this.viewers.set(viewer.id, viewer);
    this.peakViewers = Math.max(this.peakViewers, this.viewers.size);
    this.clearIdleTimers();
    if (this.noViewerTimer) {
      this.clock.clearTimer(this.noViewerTimer);
      this.noViewerTimer = null;
    }
    this.applyEvent('viewerAttached');
    return viewer;
  }

  /** Removes a viewer (socket closed past its resume window, kicked, or expired). Arms the idle and no-viewer timers once the last one leaves. */
  removeViewer(viewerId: string): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) return;
    for (const targetId of [...this.perTarget.keys()]) {
      const per = this.perTarget.get(targetId);
      per?.viewerIds.delete(viewerId);
      const engine = per?.leaseEngine;
      engine?.handleSocketClosed(viewerId);
    }
    this.viewers.delete(viewerId);
    if (this.viewers.size === 0) {
      this.applyEvent('lastViewerLeft', { zeroViewers: true });
      this.armIdleTimer();
      this.armNoViewerTimer();
    }
  }

  private requireViewer(viewerId: string): Viewer {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) {
      throw new Error(`unknown viewer ${viewerId}`);
    }
    return viewer;
  }

  // ── per-target state and capture selection ──────────────────────────

  /**
   * Builds (or returns) `targetId`'s `PerTargetState`. Creating one for the
   * first time is what `streamCounter.acquire` gates: it throws a typed
   * `E_STREAM_LIMIT` `BglsError` right here, before any `Stream`/watchdog
   * is built, if this Instance is already at its cap. Paired 1:1 with
   * `teardownTarget`'s `streamCounter.release`, so the count tracks exactly
   * how many `PerTargetState`s (not how many viewer subscriptions, several
   * of which can share one) are alive for this Instance, regardless of
   * whether they arrived through `subscribe()` or `leaseEngineFor()`.
   */
  private ensureTargetState(targetId: string): PerTargetState {
    let per = this.perTarget.get(targetId);
    if (per) return per;

    this.streamCounter.acquire(this.instanceId);

    const recoveryTarget = createCdpRecoveryTarget({
      targetId: targetId as TargetId,
      bridge: this.bridge,
      registry: this.registry,
      capture: {
        current: () => this.activation.current(targetId as TargetId),
        rebuild: (sessionId: CdpSessionId) =>
          this.rebuildCaptureAndDiagnostics(targetId as TargetId, sessionId),
      },
    });

    const watchdog = new FrameStalenessWatchdog({
      clock: this.clock,
      ...this.watchdogOptsFor(targetId),
      participantCount: () => this.perTarget.get(targetId)?.viewerIds.size ?? 0,
      lastFrameAtMs: () => this.perTarget.get(targetId)?.lastFrameAtMono ?? 0,
      lastInputAtMs: () => this.perTarget.get(targetId)?.lastInputAtMono ?? 0,
      isBusy: () => this.clock.monotonicNow() < this.busyUntilMono,
      isLoading: () => this.perTarget.get(targetId)?.loading ?? false,
      isDialogOpen: () => this.perTarget.get(targetId)?.dialogOpen ?? false,
      forceFrame: () => recoveryTarget.forceFrame(),
      onStale: () => this.reportSignal(targetId, 'screencast_silent'),
    });

    per = {
      targetId: targetId as TargetId,
      stream: new Stream({
        key: { sessionId: this.id, targetId: targetId as TargetId, mode: 'live' },
        clock: this.clock,
        onIdleTimeout: () => this.teardownTarget(targetId),
      }),
      watchdog,
      recoveryTarget,
      leaseEngine: null,
      viewerIds: new Set(),
      lastFrameAtMono: this.clock.monotonicNow(),
      lastInputAtMono: this.clock.monotonicNow(),
      loading: false,
      dialogOpen: false,
      diagnostics: null,
      requestGate: null,
      download: null,
    };
    this.perTarget.set(targetId, per);
    watchdog.start();
    return per;
  }

  private watchdogOptsFor(_targetId: string): Partial<WatchdogTiming> {
    return {};
  }

  /**
   * `RecoveryCapture.rebuild`'s real implementation (`./recovery-target.ts`):
   * rebuilds `targetId`'s `FrameSource` on the fresh `sessionId` a recovery
   * rung just re-attached, AND rebinds this target's `TargetDiagnostics`
   * onto the same new session, if one is running.
   *
   * CDP domain enables and event listeners are scoped to the CDP SESSION,
   * not the target. A cross-origin navigation tears down the old renderer's
   * session and Chrome mints a fresh `CdpSessionId` for the same, still-live
   * target, silently dropping everything `Runtime.enable`/`Log.enable`/`Network.enable`
   * turned on for the old one. Every rung that re-attaches
   * (`restartScreencast`, `reattachSession`, `reloadPage`, `recreateTarget`
   * in `./recovery-target.ts`) already funnels through exactly one call to
   * `capture.rebuild(sessionId)` once it has a live session again, which is
   * why this is the single seam that needs to know about diagnostics too,
   * rather than teaching every rung about it individually. Without this, a
   * viewer watching a pane's console across a cross-origin navigation would
   * simply stop seeing new entries, with nothing in the logs to explain why.
   */
  private async rebuildCaptureAndDiagnostics(
    targetId: TargetId,
    sessionId: CdpSessionId,
  ): Promise<FrameSource> {
    const per = this.perTarget.get(targetId);
    const [source] = await Promise.all([
      this.activation.rebuild(targetId, sessionId),
      per?.diagnostics ? per.diagnostics.rebind(sessionId) : Promise.resolve(),
      // The request gate rebinds on the SAME seam as diagnostics, and for
      // a sharper reason. A cross origin navigation swaps the renderer and
      // kills the CDP session, taking `Fetch.enable` with it. Diagnostics
      // that miss that swap lose console lines, which is bad. A gate that
      // misses it FAILS OPEN: every request the new page makes is allowed,
      // silently, with no error raised anywhere and nothing in any log to
      // say the gate stopped gating. For a submit gate that is the worst
      // reachable outcome, so this line is load bearing security, not
      // housekeeping.
      per?.requestGate ? per.requestGate.rebind(sessionId) : Promise.resolve(),
      // Same seam, same reason, for downloads: `Page.setDownloadBehavior`
      // is a per-session switch (`../downloads/download-bridge.ts`'s
      // module doc), so a cross origin navigation silently turns it off on
      // whatever fresh session Chrome minted for the new renderer unless
      // this rebinds it there too. Missing this would not fail open the
      // way a missed request-gate rebind does (a download a hostile page
      // starts after the swap simply never gets `download.started` at
      // all, rather than being let through something meant to stop it),
      // but it is still a silent feature loss with nothing in any log to
      // explain it, exactly the failure mode diagnostics rebinding here
      // already exists to prevent.
      per?.download ? per.download.rebind(sessionId) : Promise.resolve(),
    ]);
    return source;
  }

  private handleFrame(targetId: string, frame: RawFrame): void {
    const per = this.perTarget.get(targetId);
    if (!per) return;
    per.lastFrameAtMono = this.clock.monotonicNow();
    const seq = per.stream.nextSeq();
    this.onFrameHook?.(
      targetId,
      frame,
      seq,
      per.stream.gen,
      per.stream.tsDeltaMs(this.clock.wallNow()),
    );
  }

  /** Subscribes `viewerId` to `targetId`'s stream, ensuring capture is running (screencast if this is the first/active target on the Instance, poll otherwise). Returns the viewer's freshly allocated `streamId`. */
  async subscribe(viewerId: string, targetId: string): Promise<number> {
    const viewer = this.requireViewer(viewerId);
    const per = this.ensureTargetState(targetId);
    const handle = await this.registry.attach(targetId as TargetId);
    await this.activation.ensureSubscribed(targetId as TargetId, handle.id);
    per.viewerIds.add(viewerId);
    const streamId = viewer.allocateStreamId();
    viewer.subscriptions.add(streamId);
    return streamId;
  }

  /** Promotes `targetId` to the Instance's one active (screencast) target. */
  async activateTarget(targetId: string): Promise<void> {
    await this.activation.activate(targetId as TargetId);
  }

  /**
   * Read-only access to `targetId`'s live `Stream` (`seq`/`gen`/`sidEpoch`
   * bookkeeping) and its current `FrameSource`'s `forceFrame()`, for an
   * outside transport layer (the WebSocket gateway package's session
   * module) building the actual per-viewer `Attachment`/fan-out pipeline
   * this package deliberately does not construct (see the module doc).
   * `undefined` if `targetId` has no active per-target state
   * (never subscribed, or already torn down).
   */
  /**
   * The one target on this Instance currently backed by a live
   * `Page.startScreencast`, or `null` when nothing is subscribed yet.
   *
   * A real Chrome window composites only its active tab, so exactly one
   * subscribed target is screencast backed at a time and every other one is
   * served by periodic screenshots. `TargetActivationPolicy` has
   * always known which, but nothing outside `Session` could ask, so the
   * transport layer guessed by taking the first target that happened to
   * have a stream handle. That guess is what `TargetSummary.active` was
   * built from, and it is why a tab strip showed every tab as POLLING and
   * none as LIVE.
   */
  get activeTargetId(): string | null {
    return this.activation.activeTargetId;
  }

  /**
   * Every target currently screencast backed: the active target of each OS
   * window, one per window.
   *
   * This is the shape the transport layer actually needs, and
   * `activeTargetId` above is now the lossy view of it. Chromium composites
   * only a window's visible tab, so under the old `isolation: 'tab'` model
   * (every target a tab of one window) the two were the same thing and one
   * id said everything there was to say. Under `isolation: 'window'` each
   * target has its own window, each window composites its own active tab,
   * and several targets are screencast backed at once, so collapsing that
   * to a single id would mark exactly one pane LIVE and every other pane
   * POLLING no matter how many were genuinely streaming.
   */
  get activeTargetIds(): readonly string[] {
    return this.activation.activeTargetIds;
  }

  /** The screencast backed target of `windowId`, or `null` when that window has none. */
  activeTargetIn(windowId: number): string | null {
    return this.activation.activeTargetIn(windowId);
  }

  streamHandleFor(
    targetId: string,
  ): { readonly stream: Stream; readonly forceFrame: () => Promise<boolean> } | undefined {
    const per = this.perTarget.get(targetId);
    if (!per) return undefined;
    return {
      stream: per.stream,
      forceFrame: () =>
        this.activation.current(targetId as TargetId)?.forceFrame() ?? Promise.resolve(false),
    };
  }

  /** Unsubscribes `viewerId` from `streamId`, and drops the target's capture entirely once nobody is left. */
  unsubscribe(viewerId: string, streamId: number, targetId: string): void {
    const viewer = this.viewers.get(viewerId);
    viewer?.subscriptions.delete(streamId);
    const per = this.perTarget.get(targetId);
    per?.viewerIds.delete(viewerId);
    if (per && per.viewerIds.size === 0) {
      // No `Attachment` objects are constructed in this module (see the
      // module doc), so the stream's own linger timer never runs;
      // `teardownTarget` below is the equivalent immediate teardown.
      void this.teardownTarget(targetId);
    }
  }

  private async teardownTarget(targetId: string): Promise<void> {
    const per = this.perTarget.get(targetId);
    if (!per) return;
    this.suppressSignalsFor.add(targetId);
    try {
      per.watchdog.dispose();
      per.leaseEngine?.dispose();
      per.stream.forceStop();
      await this.activation.remove(targetId as TargetId);
      this.inputDispatcher.disposeTarget(targetId);
      this.perTarget.delete(targetId);
    } finally {
      this.suppressSignalsFor.delete(targetId);
      // Stopped in this same `finally`, alongside the stream-cap release
      // right below: a `TargetDiagnostics` left running past this point has
      // nothing left to ever call `stop()` on it again, which leaks exactly
      // the `Network.enable` (and `Runtime`/`Log`) domains that must never
      // outlive a torn-down target.
      // Best effort: a CDP session that is already gone (the common case for
      // a target that is being torn down because it crashed or detached) is
      // not a reason to skip the stream-cap release that follows.
      await per.diagnostics?.stop().catch(() => undefined);
      // Same reasoning one line up, applied to `Fetch`. A gate left
      // running past teardown has nothing left to ever call `stop()` on
      // it, which leaks the `Fetch.enable` it owns onto a session nobody
      // is managing any more. Best effort, for the same reason: a target
      // being torn down because it crashed has no session left to answer
      // a `Fetch.disable` anyway.
      await per.requestGate?.stop().catch(() => undefined);
      // Same reasoning again, for downloads: a `DownloadBridge` left
      // running past teardown has nothing left to ever call `stop()` on
      // it, which leaks `Page.setDownloadBehavior{eventsEnabled:true}`
      // onto a session nobody is managing any more. Best effort for the
      // same reason: a target torn down because it crashed has no session
      // left to answer a disable anyway. `stop()` itself also fails every
      // download still in flight (its own doc), so a viewer waiting on one
      // learns the target is gone instead of waiting out a dead deadline.
      await per.download?.stop().catch(() => undefined);
      // Released unconditionally, alongside `suppressSignalsFor`'s own
      // cleanup: `streamCounter.acquire` ran once for this target
      // (`ensureTargetState`), so this must run once here regardless of
      // which step above threw, or the cap would drift upward forever
      // across a target that fails to tear down cleanly.
      this.streamCounter.release(this.instanceId);
    }
  }

  // ── control lease ───────────────────────────────────────────────────

  /**
   * Lazily builds (or returns) `targetId`'s `ControlLeaseEngine`, under this
   * Session's {@link SessionControlOptions}.
   *
   * Every option is spread in conditionally rather than passed as
   * `undefined`, because `exactOptionalPropertyTypes` is on and
   * `ControlLeaseEngineOptions` distinguishes an absent key (take the
   * default) from a present `undefined`.
   */
  leaseEngineFor(targetId: string): ControlLeaseEngine {
    const per = this.ensureTargetState(targetId);
    if (!per.leaseEngine) {
      const control = this.controlOptions;
      per.leaseEngine = new ControlLeaseEngine({
        sessionId: this.id,
        targetId,
        clock: this.clock,
        emit: (effect) => this.onEffect({ kind: 'lease', targetId, effect }),
        ownerViewerIds: this.ownerViewerIds,
        drainInput: (t) => this.inputDispatcher.tailFor(t),
        releaseHeld: (t, v) => this.inputDispatcher.releaseHeld(t, v),
        ...(control.mode !== undefined ? { mode: control.mode } : {}),
        ...(control.timing !== undefined ? { timing: control.timing } : {}),
        ...(control.maxQueueDepth !== undefined ? { maxQueueDepth: control.maxQueueDepth } : {}),
        ...(control.policyName !== undefined ? { policyName: control.policyName } : {}),
      });
    }
    return per.leaseEngine;
  }

  /** This Session's configured lease mode, before `timing.allowShared`'s veto (which `ControlLeaseEngine` applies per engine). `'exclusive'` when unset. */
  controlMode(): LeaseMode {
    return this.controlOptions.mode ?? 'exclusive';
  }

  // ── diagnostics ──────────────────────────────────────────────────────

  /**
   * Turns diagnostics on, or widens/narrows an already-running collector,
   * for `targetId`. One
   * `TargetDiagnostics` per target, lazily built here exactly like
   * `leaseEngineFor`'s `ControlLeaseEngine`, so a target nobody has ever
   * asked to diagnose never pays for `Runtime.enable`/`Log.enable`/`Network.enable`.
   * Returns the feeds actually running (`TargetDiagnostics.feeds` after
   * `start`/`reconfigure` resolves), which is what a caller building the
   * wire layer echoes back on `diagnostics.subscribed`; `ManagedSession` is
   * the one that decides what `feeds` should be (the union of every viewer
   * currently subscribed to this target), `Session` itself has no opinion
   * on why one set of feeds was chosen over another.
   */
  /**
   * Installs, replaces, or removes the outbound request gate for one
   * target. Passing `null` removes it and disables `Fetch`.
   *
   * Lazy on purpose, exactly like {@link setDiagnostics}: `Fetch.enable`
   * is never sent for a target nobody has registered a gate on, so a
   * deployment that does not use this feature pays nothing for it and no
   * page anywhere gets its requests paused by default. That laziness is
   * also the honest answer to the operator question "what does enabling
   * interception cost me", which is: nothing until you ask.
   *
   * The gate can say `'allow'` or `'deny'` and nothing else. It cannot
   * rewrite a URL, a method, a header, or a body, because
   * {@link RequestGate} never passes those fields to
   * `Fetch.continueRequest` and exposes no parameter through which a
   * caller could supply one. See that class's module doc for the full
   * argument, including what an operator gives up (a tenant holding a
   * gate can refuse the operator's own telemetry; that is an egress veto,
   * it is real, and there is no way to offer a useful gate without it).
   */
  async setRequestGate(targetId: string, handler: RequestGateHandler | null): Promise<void> {
    const per = this.ensureTargetState(targetId);
    if (handler === null) {
      const existing = per.requestGate;
      per.requestGate = null;
      await existing?.stop();
      return;
    }
    // Replacing an existing gate tears the old one down first rather than
    // leaving two `Fetch.enable` owners on one session, which would make
    // "who disables it" ambiguous and leak the domain on the loser.
    if (per.requestGate) {
      const existing = per.requestGate;
      per.requestGate = null;
      await existing.stop();
    }
    const handle = await this.registry.attach(targetId as TargetId);
    const gate = new RequestGate({
      bridge: this.bridge,
      sessionId: handle.id,
      targetId,
      handler,
    });
    per.requestGate = gate;
    await gate.start();
  }

  /** Whether `targetId`'s gate is genuinely armed right now, which is not the same question as whether one was registered: a gate whose `Fetch.enable` failed, or which is mid rebind, reports false. */
  requestGateArmed(targetId: string): boolean {
    return this.perTarget.get(targetId)?.requestGate?.isArmed ?? false;
  }

  /**
   * Whether `targetId` currently carries the CDP automation fingerprint
   * `TargetDiagnostics.fingerprintActive` measures (the `Runtime` domain
   * enabled on its current session). A pure read, mirroring
   * `requestGateArmed`'s own shape: `false` for a target with no
   * `TargetDiagnostics` at all (nobody has ever called
   * {@link setDiagnostics} for it), which is the correct default for a
   * target this Session has never touched `Runtime` for, not an error case.
   * `Session` has no opinion on whether that state is ACCEPTABLE (see
   * {@link setDiagnostics}'s own doc: "Session itself has no opinion on why
   * one set of feeds was chosen over another"); that policy question,
   * including the stealth-conflict gate this method exists to let
   * `ManagedSession` answer, is entirely `ManagedSession`'s to decide.
   */
  fingerprintActive(targetId: string): boolean {
    return this.perTarget.get(targetId)?.diagnostics?.fingerprintActive ?? false;
  }

  async setDiagnostics(targetId: string, feeds: DiagnosticsFeeds): Promise<DiagnosticsFeeds> {
    const per = this.ensureTargetState(targetId);
    if (!per.diagnostics) {
      const handle = await this.registry.attach(targetId as TargetId);
      per.diagnostics = new TargetDiagnostics({
        bridge: this.bridge,
        sessionId: handle.id,
        targetId,
        sink: this.diagnosticsSinkFor(targetId),
        // Same `Clock` every other per-target component here already uses
        // (the watchdog, `Stream`), rather than `TargetDiagnostics`'s own
        // default `createSystemClock()`: a manual clock in a test drives the
        // 1s coalescing window and the 5s network-summary window
        // deterministically, matching `TargetDiagnosticsOptions.clock`'s own
        // doc ("Tests inject a ManualClock").
        clock: this.clock,
      });
      await per.diagnostics.start(feeds);
    } else {
      await per.diagnostics.reconfigure(feeds);
    }
    return per.diagnostics.feeds;
  }

  /**
   * Turns diagnostics off for `targetId`. A no-op if none is running (never
   * subscribed, or already stopped). Also called from `teardownTarget`,
   * paired with the stream-cap release the same way `leaseEngine.dispose()`
   * already is: a collector left running past its target's teardown is a
   * leak that keeps `Network.enable` on and costs frame rate on a streaming
   * target (see `TargetDiagnostics.stop()`'s own contract).
   */
  async stopDiagnostics(targetId: string): Promise<void> {
    const per = this.perTarget.get(targetId);
    if (!per?.diagnostics) return;
    await per.diagnostics.stop();
    per.diagnostics = null;
  }

  /** Builds the `DiagnosticsSink` one target's `TargetDiagnostics` reports to, closing over `targetId` so `SessionEffect`'s `diagnostics.*` variants can carry it: none of `DiagnosticsSink`'s four methods receive it themselves (see `./types.ts`'s note on why). */
  private diagnosticsSinkFor(targetId: string): DiagnosticsSink {
    return {
      onConsole: (entry) => this.onEffect({ kind: 'diagnostics.console', targetId, entry }),
      onPageError: (entry) => this.onEffect({ kind: 'diagnostics.pageError', targetId, entry }),
      onNetworkRequest: (entry) =>
        this.onEffect({ kind: 'diagnostics.networkRequest', targetId, entry }),
      onNetworkSummary: (entry) =>
        this.onEffect({ kind: 'diagnostics.networkSummary', targetId, entry }),
    };
  }

  // ── downloads ────────────────────────────────────────────────────────

  /**
   * Arms download capture for `targetId`, writing completed files into
   * `downloadPath`. One `DownloadBridge` per target, lazily built here
   * exactly like {@link setDiagnostics}'s `TargetDiagnostics` and
   * {@link setRequestGate}'s `RequestGate`, so a target nobody has asked to
   * capture downloads for never pays for
   * `Page.setDownloadBehavior{eventsEnabled:true}` and Chrome never writes
   * a byte to `downloadPath` on its account. Calling this again with a
   * DIFFERENT `downloadPath` on an already-armed target re-sends nothing
   * (`DownloadBridge.start` is idempotent once armed); a caller that
   * genuinely needs to relocate an armed target's staging directory must
   * `stopDownloadCapture` first. `ManagedSession` is the one that decides
   * WHEN to call this (which capability gates it, which target ids exist);
   * `Session` itself has no opinion on why downloads were asked for on one
   * target and not another.
   */
  async startDownloadCapture(targetId: string, downloadPath: string): Promise<void> {
    const per = this.ensureTargetState(targetId);
    if (!per.download) {
      const handle = await this.registry.attach(targetId as TargetId);
      per.download = new DownloadBridge({
        bridge: this.bridge,
        sessionId: handle.id,
        targetId,
        sink: this.downloadSinkFor(targetId),
      });
    }
    await per.download.start(downloadPath);
  }

  /**
   * Disarms download capture for `targetId`. A no-op if none is running.
   * Also called from `teardownTarget`, paired with the stream-cap release
   * the same way `stopDiagnostics`/`setRequestGate(targetId, null)` already
   * are: a `DownloadBridge` left running past its target's teardown is a
   * leak that keeps `Page.setDownloadBehavior{eventsEnabled:true}` on a
   * session nobody is managing any more.
   */
  async stopDownloadCapture(targetId: string): Promise<void> {
    const per = this.perTarget.get(targetId);
    if (!per?.download) return;
    await per.download.stop();
    per.download = null;
  }

  /** Whether `targetId`'s download capture is genuinely armed right now, mirroring {@link requestGateArmed}'s own honesty rule: a capture whose `Page.setDownloadBehavior` failed, or which is mid rebind, reports false. */
  downloadCaptureArmed(targetId: string): boolean {
    return this.perTarget.get(targetId)?.download?.armed ?? false;
  }

  /** Builds the `DownloadSink` one target's `DownloadBridge` reports to, closing over `targetId` exactly like {@link diagnosticsSinkFor} does for the same reason: none of `DownloadSink`'s four methods carry it themselves. */
  private downloadSinkFor(targetId: string): DownloadSink {
    return {
      onDownloadStarted: (entry) => this.onEffect({ kind: 'download.started', targetId, entry }),
      onDownloadProgress: (entry) => this.onEffect({ kind: 'download.progress', targetId, entry }),
      onDownloadCompleted: (entry) =>
        this.onEffect({ kind: 'download.completed', targetId, entry }),
      onDownloadFailed: (entry) => this.onEffect({ kind: 'download.failed', targetId, entry }),
    };
  }

  /** Builds a `ViewerRef` (the control module's identity shape) from a `Viewer` and its declared kind/admin status. */
  private viewerRef(identity: SessionViewerIdentity): {
    viewerId: string;
    identity: string;
    label: string;
    kind: HolderKind;
    isAdmin: boolean;
  } {
    return {
      viewerId: identity.viewerId,
      identity: identity.identity,
      label: identity.label,
      kind: identity.kind,
      isAdmin: identity.isAdmin,
    };
  }

  /** Handles `control.request` for one target on behalf of `identity`. `opts.requestId`, when given, is the wire request's own `id`, echoed as `re` on whichever direct effect answers it (see `ControlLeaseEngine.requestControl`'s doc). */
  requestControl(
    identity: SessionViewerIdentity,
    targetId: string,
    opts: {
      readonly reason?: string;
      readonly priority?: number;
      readonly force?: boolean;
      readonly queue?: boolean;
      readonly requestId?: string;
    } = {},
  ): void {
    this.leaseEngineFor(targetId).requestControl(this.viewerRef(identity), opts);
  }

  // ── input ────────────────────────────────────────────────────────────

  /**
   * Enqueues one raw inbound input message. `checkFencing`'s callback
   * (wired at construction) reads `fencingTargetId`, set synchronously
   * immediately below: `InputDispatcher.enqueue()` runs every validation,
   * generation, and fencing check synchronously before its first `await`
   * (`../input/dispatcher.ts`), so this value is still current at the
   * moment `checkFencing` is actually invoked. `InputDispatcherOptions.checkFencing`'s
   * own signature (`../input/dispatcher.ts`) carries no `targetId`
   * parameter, unlike `getGeneration`/`lastHolderViewerId`, which do; this
   * is the narrowest adapter that closes that gap without changing the
   * dispatcher's interface.
   *
   * `opts.awaitFull` passes straight through to `InputDispatcher.enqueue()`'s
   * own `opts` (see that method's doc for why it is a call-site argument and
   * never a field read off `raw`). Only `ManagedSession.clickTarget`/
   * `typeTarget`'s REST one-shot driving path
   * (`packages/server/src/session/managed-session.ts`) passes it; the WS
   * streaming path (`ManagedSession.dispatchInput`, called from
   * `ws/connection.ts`'s parsed messages) never does, and must not, for the
   * same reason `enqueue()` itself does not read it off the message.
   */
  dispatchInput(viewerId: string, raw: unknown, opts?: { readonly awaitFull?: boolean }): void {
    const targetId = extractTargetId(raw);
    this.fencingTargetId = targetId;
    try {
      this.inputDispatcher.enqueue(viewerId, raw, opts);
    } finally {
      this.fencingTargetId = null;
    }
    if (targetId) {
      const per = this.perTarget.get(targetId);
      if (per) {
        per.lastInputAtMono = this.clock.monotonicNow();
      }
      this.bumpIdle();
      // Input cancels recovery except when the signal is `renderer_hung`
      // (input during a genuine hang proves nothing).
      this.recoveryRunner.cancelOnInput(targetId);
    }
  }

  /** Builds a fresh `TargetActivationPolicy` bound to `this.bridge`/`this.registry` (read live at each call inside its closures, `TargetActivationPolicyOptions` itself takes the objects by value at construction). Used at construction and again by `restartInstance()`'s `applyRebind`, once `this.bridge`/`this.registry` have been swapped to the freshly relaunched browser's pair. */
  private buildActivation(): TargetActivationPolicy {
    return new TargetActivationPolicy({
      bridge: this.bridge,
      registry: this.registry,
      specFor: () => this.captureSpec,
      onFrame: (targetId, frame) => this.handleFrame(targetId, frame),
      onHungConfirmed: (targetId) => this.reportSignal(targetId, 'renderer_hung'),
      isLoading: (targetId) => this.perTarget.get(targetId)?.loading ?? false,
    });
  }

  /** Builds a fresh `InputDispatcher` bound to `this.bridge` (captured by value at construction, unlike `targets`, whose `buildInputTargetResolver()` closures re-read `this.registry` live). Used at construction and again by `restartInstance()`'s `applyRebind`: a rebuild, not a mutation in place, since `InputDispatcher` has no setter for its own `bridge` field and every in-flight per-target chain it might be holding is for a `targetId` the just-terminated browser owned anyway. */
  private buildInputDispatcher(): InputDispatcher {
    return new InputDispatcher({
      sessionId: this.id,
      bridge: this.bridge as unknown as InputCdpSender,
      targets: this.buildInputTargetResolver(),
      checkFencing: (input, fenceOpts) => {
        const targetId = this.fencingTargetId;
        const engine = targetId ? this.perTarget.get(targetId)?.leaseEngine : null;
        if (!engine) {
          return {
            dispatch: false,
            attributedTo: null,
            reason: input.leaseId ? 'stale_lease' : 'no_lease',
          };
        }
        return engine.checkFencing(input, fenceOpts);
      },
      getGeneration: (targetId) => this.perTarget.get(targetId)?.stream.gen ?? 0,
      lastHolderViewerId: () => null,
      // Diagnostics only: which lease id this viewer SHOULD have used, so a
      // `fence_denied` signal can report the comparison rather than just the
      // verdict. Per viewer, not per target, because a shared lease has
      // several holders each with their own id. `perTarget.get()` rather
      // than `leaseEngineFor()`, deliberately: this runs on the rejected
      // path of every input message and must never create per-target state
      // (which would acquire an `InstanceStreamCounter` slot) as a side
      // effect of reporting an error.
      currentLeaseIdFor: (targetId, viewerId) =>
        this.perTarget.get(targetId)?.leaseEngine?.holderFor(viewerId)?.leaseId ?? null,
      // Routed to the transport, at last. This was an empty function whose
      // comment said a future task owning the wire layer would pick these
      // up. That task is the server package, and it never received them
      // because nothing told it they existed, so every dropped input was
      // silent: no error reply, no log line, nothing. It hid three separate
      // defects that stopped automation input dead.
      //
      // `dispatch_error` is the one member carrying no `viewerId` (a CDP
      // failure belongs to the target, not to whoever happened to send the
      // message that hit it), which is why `targetId` is lifted onto the
      // effect and the whole signal travels alongside it rather than being
      // flattened into effect fields.
      onSignal: (signal) => {
        this.onEffect({ kind: 'input.signal', targetId: signal.targetId, signal });
      },
    });
  }

  private buildInputTargetResolver(): InputTargetResolver {
    return {
      get: (targetId: string) => {
        const target = this.registry.get(targetId as TargetId);
        return target
          ? {
              viewport: target.viewport
                ? { width: target.viewport.width, height: target.viewport.height }
                : null,
            }
          : undefined;
      },
      attach: (targetId: string) => this.registry.attach(targetId as TargetId),
    };
  }

  // ── recovery ─────────────────────────────────────────────────────────

  /**
   * Reports one recovery signal for `targetId`. Automatic entry point for
   * the frame-staleness watchdog and CDP lifecycle events; a future task
   * that owns the router/node health channel (out of this package's reach)
   * is expected to call this too, for `browser_dead`, `profile_lease_lost`,
   * `node_lost`, and `disk_fatal`.
   */
  reportSignal(targetId: string, signal: RecoverySignal): void {
    if (this.suppressSignalsFor.has(targetId)) return;
    if (this.recoveryRunner.isRecovering(targetId)) return; // self-triggered noise from a rung's own detach/close calls; the runner is already handling this target.
    const per = this.perTarget.get(targetId);
    if (!per) return;

    this.applyEvent('instanceRecovering');
    void this.recoveryRunner.trigger(per.recoveryTarget, signal).then((outcome) => {
      if (
        outcome.kind === 'recovered' ||
        outcome.kind === 'exhausted_but_alive' ||
        outcome.kind === 'rederived_healthy'
      ) {
        if (this._state === 'recovering') {
          this.applyEvent('recovered', { instanceReady: true });
        }
      }
    });
  }

  private handleUnrecoverable(event: {
    readonly targetId: string;
    readonly signal: RecoverySignal;
    readonly triedRungs: readonly unknown[];
    readonly crashConditionsTried?: readonly unknown[];
  }): void {
    this.onEffect({ kind: 'recovery.unrecoverable', event: event as never });
    void this.teardownTarget(event.targetId);
    this.applyEvent('unrecoverable');
    this.onEffect({
      kind: 'close_all_viewers',
      code: 4004,
      reason: `unrecoverable: ${event.signal}`,
    });
  }

  /**
   * Creates a new target on this Instance, transparently relaunching the
   * browser first if it has already exited.
   *
   * Under `isolation: 'window'` every streamed target is a whole OS window
   * (`runtime-host/test/spike/spike-window-isolation.ts`), so closing every pane
   * closes every window, and headful Chrome exits the moment its last
   * window closes: measured directly in `runtime-host/test/spike/spike-keep-alive.ts`,
   * which shows this is true even with a `--keep-alive-for-test` launch
   * flag, so there is no launch-side fix. The CDP endpoint dies with the
   * process, and the very next `TargetRegistry.create()` (the call at the
   * bottom of this method) would otherwise fail with `closedError()`
   * ("the bridge closed", `../cdp/bridge.ts`) the instant it tried
   * `Target.createTarget` on a socket that no longer exists.
   *
   * The honest fix is not to special-case this inside the `R0` to `R3`
   * recovery ladder (`../recovery/**`): every rung there operates on one
   * `RecoveryTarget`, and by construction there is no target left to run a
   * ladder against once every pane is closed (`reportSignal` itself is a
   * no-op when `perTarget` has no entry for the id it is given, and this is
   * precisely the state a fully-closed Instance is in). `browser_dead`'s
   * only path through this build's ladder is already `R4`, manual restart,
   * so this reuses that exact mechanism (`restartInstance()`, its
   * executor, and `applyRebind()`) rather than inventing a second one.
   *
   * `relaunchInFlight` is this method's own single-flight, deliberately
   * separate from `restartInstance()`'s own instance-scope `SingleFlight`.
   * That one lets a "waited" (losing) concurrent caller come back with
   * `recovered: false` even when the winner actually succeeded: a losing
   * caller there is not re-derived the way a target-scope loser is
   * (`RecoveryRunner.trigger()`'s own critical rule), it is simply told
   * `false`. That is the right contract for a genuinely manual
   * `instance.restart` (one admin action, one result), but the wrong one
   * here: three panes opened at once must not turn into three
   * `instance.restart.result` effects, two of them a spurious "could not be
   * relaunched" error broadcast to every viewer. Gating the single
   * `restartInstance()` call at this level, so it is only ever actually
   * invoked once no matter how many `createTarget()` calls race, sidesteps
   * that ambiguity outright: every caller here awaits the exact same
   * promise, and `this.bridge`/`this.registry` (mutated in place by
   * `applyRebind`, not per caller) are what every caller re-checks
   * afterward, rather than trusting whichever boolean `restartInstance()`
   * happened to resolve to.
   */
  async createTarget(opts: {
    readonly url?: string;
    readonly background?: boolean;
    readonly newWindow?: boolean;
  }): Promise<TargetRuntime> {
    if (this.bridge.state !== 'open') {
      if (!this.relaunchInFlight) {
        this.relaunchInFlight = this.restartInstance({
          reason: 'target.new after the browser process exited',
          preserveProfile: true,
        }).finally(() => {
          this.relaunchInFlight = null;
        });
      }
      await this.relaunchInFlight;
      // Whether or not the relaunch actually succeeded, `this.registry` is
      // already Session's current one (unchanged if it failed, freshly
      // swapped in by `applyRebind` if it worked): let `create()` below
      // speak for itself, on the live-or-still-dead bridge, rather than
      // duplicating its own error handling here.
    }
    return this.registry.create(opts);
  }

  /**
   * `R4`, manual only (`instance.restart`). Tears down every per-target
   * event handler (registry subscriptions, watchdogs) before the injected
   * executor runs (event handlers must be torn down between close and
   * launch, or they leak and fire stale callbacks), and only re-wires them once the executor confirms the
   * browser is back. `lastUrl` is best effort and drops anything outside
   * `http`, `https`, and `about:blank`.
   *
   * A successful executor call hands back a freshly connected `CdpBridge`
   * and a freshly started `TargetRegistry` on the relaunched browser;
   * `applyRebind()` swaps them in as this `Session`'s own, discards every
   * stale per-target state keyed by a `targetId` the terminated browser
   * owned (a fresh browser process mints entirely new CDP target ids), and best-effort pairs the terminated browser's
   * targets with the new browser's targets positionally so an already
   * subscribed viewer's stream survives under the new id rather than
   * silently going nowhere. Emits `instance.restart.progress` once at the
   * start and `instance.restart.result` once at the end (previously neither `instance.recovering` nor
   * `instance.recovered`/an `error` was ever sent for a manual restart, real
   * success or real failure alike), so a caller building the wire layer
   * (`ManagedSession.dispatchEffect`) never has to guess.
   *
   * Returns whether the restart succeeded, so `ManagedSession`/`ws/connection.ts`
   * can tell a genuinely failed restart from a successful one without
   * re-deriving it from `Session.state` (a failed restart must be
   * observable, not a silent hang).
   */
  async restartInstance(
    opts: { readonly reason?: string; readonly preserveProfile?: boolean } = {},
  ): Promise<boolean> {
    const activeTargetId = this.activation.activeTargetId;
    const rawUrl = activeTargetId ? (this.registry.get(activeTargetId)?.url ?? null) : null;
    const lastUrl = isRestorableUrl(rawUrl) ? rawUrl : null;
    const preserveProfile = opts.preserveProfile ?? true;
    const startMono = this.clock.monotonicNow();

    // Deliberately does not call `applyEvent('instanceRecovering')`:
    // `SESSION_TRANSITIONS`' `recovering` state has no transition back to
    // `live` on a plain failure (only `recovered` or `unrecoverable` ->
    // `ended`), and a single failed manual restart is neither of those, the
    // caller may simply retry later. `SessionState` (this class's own
    // internal machine) and the wire's `InstanceState`/`instance.recovering`
    // are already documented as separate vocabularies at different
    // resolutions (`./types.ts`'s module doc); broadcasting
    // `instance.recovering`/`instance.recovered` below stays fully coherent
    // with `this._state` staying `live` throughout a manual restart attempt.
    this.onEffect({ kind: 'instance.restart.progress', attempt: 1 });

    let rebindResult: {
      readonly targetRebinds: readonly {
        readonly oldTargetId: string;
        readonly newTargetId: string;
      }[];
      readonly targetsLost: readonly string[];
    } = { targetRebinds: [], targetsLost: [] };

    const execute = async (): Promise<boolean> => {
      const previousTargetIds = [...this.perTarget.keys()];
      this.teardownAllEventHandlers();
      const executed = await this.restartInstanceExecutor(lastUrl, preserveProfile);
      if (!executed.ok) return false;
      rebindResult = await this.applyRebind(
        executed.bridge,
        executed.registry,
        previousTargetIds,
        activeTargetId,
        lastUrl,
      );
      this.wireAllEventHandlers();
      return true;
    };

    const outcome = await this.recoveryRunner.restartInstance(execute);
    const recovered = outcome.kind === 'recovered';
    if (recovered && this._state === 'recovering') {
      this.applyEvent('recovered', { instanceReady: true });
    }

    this.onEffect({
      kind: 'instance.restart.result',
      result: recovered
        ? {
            ok: true,
            durationMs: this.clock.monotonicNow() - startMono,
            bridge: this.bridge,
            registry: this.registry,
            targetRebinds: rebindResult.targetRebinds,
            targetsLost: rebindResult.targetsLost,
          }
        : { ok: false, durationMs: this.clock.monotonicNow() - startMono },
    });

    return recovered;
  }

  /**
   * Swaps `this.bridge`/`this.registry` to the freshly relaunched browser's
   * pair, discards every per-target state keyed by a now-gone `targetId`
   * (the terminated browser's own ids), rebuilds `this.activation`/`this.inputDispatcher`
   * against the new pair, and best-effort re-establishes capture for each
   * still-viewed old target under its positional successor in the new
   * browser's `tabs()` list (capture keeps this to one live screencast
   * target, so the overwhelmingly common case is
   * exactly one pairing). A previously subscribed target with no successor
   * (more targets existed before than after) is reported lost, not paired.
   * When `lastUrl` is non-null and the previously *active* target survives
   * the pairing, best-effort navigates its successor there (R4's own
   * best-effort URL restore, matching R3's `recreateTarget`'s identical
   * `lastUrl` handling).
   */
  private async applyRebind(
    bridge: CdpBridge,
    registry: TargetRegistry,
    previousTargetIds: readonly string[],
    activeTargetId: TargetId | null,
    lastUrl: string | null,
  ): Promise<{
    readonly targetRebinds: readonly {
      readonly oldTargetId: string;
      readonly newTargetId: string;
    }[];
    readonly targetsLost: readonly string[];
  }> {
    const viewersByOldTarget = new Map<string, Set<string>>();
    for (const targetId of previousTargetIds) {
      const per = this.perTarget.get(targetId);
      if (per) viewersByOldTarget.set(targetId, new Set(per.viewerIds));
    }

    for (const targetId of previousTargetIds) {
      const per = this.perTarget.get(targetId);
      if (!per) continue;
      per.watchdog.dispose();
      per.leaseEngine?.dispose();
      per.stream.forceStop();
      this.inputDispatcher.disposeTarget(targetId);
      this.perTarget.delete(targetId);
      // This loop is `teardownTarget`'s equivalent for every old target at
      // once (it does not call `teardownTarget` itself: that also awaits
      // `this.activation.remove`, which would try to promote a sibling on
      // an `activation` this method is about to discard wholesale anyway).
      // Same pairing rule applies: one `streamCounter.release` per
      // `PerTargetState` destroyed, or a restart would leak one stream-cap
      // slot per surviving target every time it ran.
      this.streamCounter.release(this.instanceId);
    }

    this.bridge = bridge;
    this.registry = registry;
    this.activation = this.buildActivation();
    this.inputDispatcher = this.buildInputDispatcher();

    const newTargetIds = this.registry.tabs().map((t) => t.id as string);
    const pairCount = Math.min(previousTargetIds.length, newTargetIds.length);
    const targetRebinds: { oldTargetId: string; newTargetId: string }[] = [];

    for (let i = 0; i < pairCount; i += 1) {
      const oldTargetId = previousTargetIds[i] as string;
      const newTargetId = newTargetIds[i] as string;
      targetRebinds.push({ oldTargetId, newTargetId });

      const viewerIds = viewersByOldTarget.get(oldTargetId);
      if (viewerIds && viewerIds.size > 0) {
        const per = this.ensureTargetState(newTargetId);
        const handle = await this.registry.attach(newTargetId as TargetId);
        await this.activation.ensureSubscribed(newTargetId as TargetId, handle.id);
        for (const viewerId of viewerIds) per.viewerIds.add(viewerId);
        if (lastUrl && oldTargetId === activeTargetId) {
          await this.bridge
            .send('Page.navigate', { url: lastUrl }, handle.id)
            .catch(() => undefined);
        }
      }
    }

    return { targetRebinds, targetsLost: previousTargetIds.slice(pairCount) };
  }

  private teardownAllEventHandlers(): void {
    for (const unsub of this.registryUnsubs.splice(0)) {
      unsub();
    }
    for (const per of this.perTarget.values()) {
      per.watchdog.stop();
    }
  }

  private wireAllEventHandlers(): void {
    this.registryUnsubs.push(
      this.registry.on('crashed', (t) => this.reportSignal(t.id, 'target_crashed')),
      this.registry.on('detached', (t) => this.reportSignal(t.id, 'cdp_detached')),
    );
    for (const per of this.perTarget.values()) {
      per.watchdog.start();
    }
  }

  // ── idle and lifetime ───────────────────────────────────────────────

  /**
   * Signals real activity on the session (a viewer about to connect, an
   * accepted input event), refreshing the idle timer so a session that is
   * about to receive a connection does not lose a race with the grace
   * timer.
   */
  keepAlive(): void {
    this.bumpIdle();
  }

  /**
   * `session.busy`: suppresses the idle timer AND the frame-silence
   * watchdog for `forMs` (clamped to `maxBusyMs`). `busyDoesNotSuppressMaxDuration`:
   * the max-duration timer is never touched here.
   */
  setBusy(forMs: number): void {
    const clamped = Math.min(Math.max(0, forMs), this.lifetime.maxBusyMs);
    this.busyUntilMono = this.clock.monotonicNow() + clamped;
    this.bumpIdle();
  }

  clearBusy(): void {
    this.busyUntilMono = this.clock.monotonicNow();
  }

  private bumpIdle(): void {
    this.clearIdleTimers();
    if (this.viewers.size > 0) return; // idle timer only runs once the last viewer has left; see `removeViewer`.
    this.armIdleTimer();
  }

  private clearIdleTimers(): void {
    if (this.idleTimer) {
      this.clock.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.graceTimer) {
      this.clock.clearTimer(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.idleTimer = this.clock.setTimer(() => {
      this.idleTimer = null;
      this.onEffect({
        kind: 'notice',
        notice: {
          kind: 'session.expiring',
          reason: 'idle',
          inMs: this.lifetime.idleGraceMs,
          canExtend: false,
          extendedCount: 0,
          maxExtensions: 0,
        },
      });
      this.applyEvent('idleTimerFired', { zeroViewers: true });
      this.graceTimer = this.clock.setTimer(() => {
        this.graceTimer = null;
        this.applyEvent('graceTimerFired', { zeroViewers: true });
        this.endReason = 'idle_timeout';
        this.onEffect({ kind: 'close_all_viewers', code: 4001, reason: 'idle_timeout' });
      }, this.lifetime.idleGraceMs);
    }, this.lifetime.idleTimeoutMs);
  }

  private armNoViewerTimer(): void {
    this.noViewerTimer = this.clock.setTimer(() => {
      this.noViewerTimer = null;
      // No-viewer past timeout: reported, but ending the session here would
      // race a genuine automation-only session (no human viewer ever
      // attaches, by design); this reason is "not warned" and enforcement
      // is left to the caller.
      this.onEffect({
        kind: 'notice',
        notice: {
          kind: 'session.expiring',
          reason: 'no-viewer',
          inMs: 0,
          canExtend: false,
          extendedCount: 0,
          maxExtensions: 0,
        },
      });
    }, this.lifetime.noViewerTimeoutMs);
  }

  private armMaxDurationTimer(): void {
    this.maxDurationTimer = this.clock.setTimer(() => {
      this.maxDurationTimer = null;
      // `busyDoesNotSuppressMaxDuration`: wall clock enforcement is never
      // gated on `busyUntilMono`.
      this.endReason = 'max_duration';
      this.applyEvent('maxDurationFired');
      this.onEffect({ kind: 'close_all_viewers', code: 4002, reason: 'max_duration' });
    }, this.lifetime.maxDurationMs);
  }

  /** Extends the max-duration deadline by `extendMs`, up to `maxExtensions`. Returns whether the extension was applied. */
  extendMaxDuration(): boolean {
    if (this.extendedCount >= this.maxExtensions) return false;
    this.extendedCount += 1;
    if (this.maxDurationTimer) {
      this.clock.clearTimer(this.maxDurationTimer);
    }
    this.maxDurationTimer = this.clock.setTimer(() => {
      this.maxDurationTimer = null;
      this.endReason = 'max_duration';
      this.applyEvent('maxDurationFired');
      this.onEffect({ kind: 'close_all_viewers', code: 4002, reason: 'max_duration' });
    }, this.extendMs);
    return true;
  }

  // ── shutdown ─────────────────────────────────────────────────────────

  /** Tears everything down: every target, every timer, every registry subscription. Idempotent. */
  dispose(): void {
    this.clearIdleTimers();
    if (this.maxDurationTimer) {
      this.clock.clearTimer(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.noViewerTimer) {
      this.clock.clearTimer(this.noViewerTimer);
      this.noViewerTimer = null;
    }
    for (const unsub of this.registryUnsubs.splice(0)) {
      unsub();
    }
    for (const targetId of [...this.perTarget.keys()]) {
      void this.teardownTarget(targetId);
    }
  }
}

/** Extracts `targetId` from a raw, not-yet-validated inbound input message, matching `../input/dispatcher.ts`'s own internal `targetIdOf`. Used only to set {@link Session.fencingTargetId} before `enqueue()`; the dispatcher re-validates the field itself. */
function extractTargetId(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null) {
    const t = (raw as Record<string, unknown>)['targetId'];
    if (typeof t === 'string') return t;
  }
  return null;
}

export { isRestorableUrl };
