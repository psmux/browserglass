/**
 * `ManagedSession`: one Instance's live `bgls.v1` transport, wiring
 * `core`'s `Session` (`packages/core/src/session/session.ts`) to every
 * connected viewer's socket. This is where the whole system meets: it owns
 * the `CdpBridge`/`TargetRegistry` pair, the `Session` built on top of
 * them, and the `Attachment`/tier-assignment/fan-out pipeline `core`
 * deliberately does not build, built here against `Session.streamHandleFor()` and `Session`'s `onFrame`
 * hook instead of reaching into `core`'s private state.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Attachment,
  type AxTreeNode,
  type CdpBridge,
  type Clock,
  type Viewer as CoreViewer,
  type ViewerOptions as CoreViewerOptions,
  DEFAULT_LADDER_LEVEL,
  type EvaluateOutcome,
  type EvaluateRequest,
  FrameRecorder,
  type InputSignal,
  type InstanceRestartResult,
  type LadderLevel,
  PageMapCache,
  type PageMapCapture,
  PageMapStaleEpochError,
  type PrintToPdfOptions,
  QUALITY_PROFILE_MAP,
  type RawFrame,
  type RecoverySignal,
  type ResponseBodyOutcome,
  Session,
  type SessionControlOptions,
  type SessionEffect,
  type SessionViewerIdentity,
  type TargetRegistry,
  TierAssigner,
  step as adaptiveStep,
  buildPageMapBudget,
  capturePageMap,
  clampToProfile,
  createSystemClock,
  decodeBase64,
  evaluateInSession,
  extractPageMapText,
  getResponseBodyFromCdp,
  hitTestAtPoint,
  isFreshEpoch,
  mintAxMarkerAttr,
  monotonicNow,
  printToPdf,
  queryAccessibilityTree,
  readFrameDimensions,
  resetForNewGeneration,
  setFileInputFiles,
  stampAccessibilityNodes,
} from '@browserglass/core';
import {
  BglsError,
  type Capability,
  DEFAULT_GATE_HOLD_MS,
  DEFAULT_LIMITS,
  type GateRule,
  type GateVerdict,
  type LeaseState,
  type LeaseSummary,
  MAX_A11Y_RESULT_BYTES,
  MAX_GATE_HOLD_MS,
  MAX_INLINE_PDF_BYTES,
  MAX_PAGEMAP_RESULT_BYTES,
  type PageMapDegradation,
  type PageMapEpoch,
  type PageMapFrameFailure,
  type PageMapInclude,
  type PageMapNode,
  type PageMapTextBlock,
  type PageMapTruncationReason,
  type PresenceState,
  type QualityProfile,
  type TargetKind,
  type TargetSummary,
  newId,
} from '@browserglass/protocol';
import type { DownloadStore, FinalizedDownload } from '../downloads/download-store.js';
import { DownloadStoreError } from '../downloads/download-store.js';
import type { HookRegistry } from '../hooks/dispatch.js';
import type { DownloadEvent, RecoveryEvent } from '../hooks/types.js';
import { DiskRecordingSink } from '../recording/disk-recording-sink.js';
import { type FanOutEntry, buildTierPayloads, frameOutAttachments } from './frame-pipeline.js';
import { isLeaseHolder, leaseHoldersOf } from './lease-holders.js';

/**
 * What `startRecording()`/`stopRecording()`/`listRecordings()` return: the
 * server-side shape of `@browserglass/protocol`'s wire `RecordingSummary`
 * (`wire/messages/recording.ts`), built here rather than importing that
 * type directly so this class does not have to import a `messages/*`
 * module for one shape; `ws/connection.ts` spreads this straight into its
 * `recording.started`/`.stopped`/`.listed` replies.
 */
export interface RecordingSummaryResult {
  readonly recordingId: string;
  readonly targetId: string;
  readonly mode: 'live' | 'thumbnail';
  readonly startedAtMs: number;
  readonly stoppedAtMs?: number;
  readonly framesWritten: number;
  /** `FrameRecorder.framesDropped`: frames skipped because the sink was behind. */
  readonly framesDropped: number;
  readonly failed: boolean;
}

/**
 * The body of a `nav.state` envelope, without the `v`/`ts`/`re` fields
 * `broadcast()` and `replyTo()` each stamp in their own way. `ManagedSession.navigate()`
 * returns one so the connection layer can answer the requester with a
 * correlated copy of the same state it broadcasts to everyone else.
 */
export interface NavStatePayload {
  readonly t: 'nav.state';
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
  readonly errorText?: string;
}
import type { Logger } from '../config/logger.js';
import { safeFileName } from '../files/safe-name.js';
import { buildGoodbye } from '../wire/close.js';
import {
  redactServerPaths,
  sanitizeConsoleText,
  sanitizeMessage,
  sanitizeSuggestedName,
  sanitizeUrl,
} from '../wire/sanitize.js';
import { type TargetRuntimeLike, toTargetSummary } from '../wire/target-summary.js';
import type { ConnectionSink } from './types.js';

/**
 * Mirrors `core`'s `DiagnosticsFeeds` (`packages/core/src/diagnostics/**`)
 * structurally rather than importing
 * it: this class only ever passes a value of this shape straight through to
 * `Session.setDiagnostics`/reads one back off its return value, and
 * TypeScript's structural typing makes a locally declared interface and an
 * imported one interchangeable at every call site that matters, without
 * this file needing `core`'s public barrel to re-export a type it would
 * otherwise have no other reason to.
 */
interface DiagnosticsFeeds {
  readonly console: boolean;
  readonly errors: boolean;
  readonly network: boolean;
}

/**
 * `subscribeDiagnostics`'s reply shape and `diagnosticsStatus`'s return
 * shape: {@link DiagnosticsFeeds} plus whether the `Runtime` automation
 * fingerprint (`core`'s `TargetDiagnostics.fingerprintActive`, reached here
 * through `Session.fingerprintActive`) is on right now. See
 * `@browserglass/protocol`'s `DiagnosticsSubscribed`/`DiagnosticsStatusGot`
 * for the wire-facing version of this same pair of facts.
 */
interface DiagnosticsStatus extends DiagnosticsFeeds {
  readonly fingerprintActive: boolean;
}

/** `core`'s `RecoverySignal` to wire `InstanceRecovering.signal`. Three core signals (`profile_lease_lost`, `node_lost`, `disk_fatal`) have no close wire equivalent (they describe router/node-layer conditions the wire vocabulary was never given a member for); `'manual'` is the closest fallback bucket, since none of them is actually a manual restart, but every genuinely used automatic signal (`screencast_silent`, `cdp_detached`, `renderer_hung`, `target_crashed`, `browser_dead`) maps precisely. */
const RECOVERY_SIGNAL_TO_WIRE: Readonly<
  Record<
    RecoverySignal,
    'no_frames' | 'renderer_hung' | 'cdp_dead' | 'process_gone' | 'oom' | 'manual'
  >
> = Object.freeze({
  screencast_silent: 'no_frames',
  cdp_detached: 'cdp_dead',
  renderer_hung: 'renderer_hung',
  target_crashed: 'process_gone',
  browser_dead: 'process_gone',
  profile_lease_lost: 'manual',
  node_lost: 'manual',
  disk_fatal: 'manual',
});

/**
 * `core`'s `RecoverySignal` to `RecoveryEvent.trigger` (`hooks/types.ts`),
 * the narrower five member vocabulary the hook declares. Mirrors
 * {@link RECOVERY_SIGNAL_TO_WIRE}'s own choice of bucketing the three
 * router/node layer signals (`profile_lease_lost`, `node_lost`,
 * `disk_fatal`) under one fallback, `'manual'` there and `'watchdog'`
 * here: none of the three is actually a person invoking recovery by hand
 * (`'manual'` in THIS vocabulary means exactly that, `instance.restart`),
 * they are node health conditions the automatic watchdog layer surfaces,
 * which is the closer of the two available buckets. `renderer_hung` maps
 * to `'watchdog'` for the same reason: it is the renderer hang PROBE
 * (`core/src/session/target-activation.ts`'s watchdog machinery)
 * detecting the condition, not a frame staleness or a CDP transport
 * failure, which are the two signals this vocabulary gives their own
 * name.
 */
const RECOVERY_SIGNAL_TO_TRIGGER: Readonly<Record<RecoverySignal, RecoveryEvent['trigger']>> =
  Object.freeze({
    screencast_silent: 'frame_silence',
    cdp_detached: 'cdp_error',
    renderer_hung: 'watchdog',
    target_crashed: 'target_crashed',
    browser_dead: 'watchdog',
    profile_lease_lost: 'watchdog',
    node_lost: 'watchdog',
    disk_fatal: 'watchdog',
  });

/**
 * `core`'s `RecoveryRung` (`'R0'` to `'R4'`, this build never produces
 * `'R5'`/`'R6'`) to `RecoveryEvent.rung`'s numeric `0`-`4` and to
 * `RecoveryEvent.rungName`'s five word vocabulary
 * (`hooks/types.ts`). `R0`/`R1`/`R2` are exact: `R0` restarts the
 * screencast, `R1` recreates the CDP session, `R2` reloads the target
 * (`core/src/recovery/types.ts`'s per-rung doc comments, `:121` to `:125`).
 * `R4` is exact too: it is this codebase's real, named `instance.restart`
 * (`dispatchEffect`'s `'instance.restart.progress'` case below), so
 * `'restart_instance'` is the only honest name for it.
 *
 * `R3` does not have an exact match in `rungName`'s five names: its real
 * behaviour is closing and recreating the TARGET, not the whole instance
 * (`core/src/recovery/types.ts:128`, "best effort `Target.closeTarget`,
 * `Target.createTarget`"). `rungName` has exactly five values for exactly
 * five rungs (`0` to `4`) and `'restart_instance'` is already claimed by
 * `R4`, so by elimination `R3` is reported as `'relocate'` here, which is
 * ALSO not an accurate description (relocating to a different node is
 * `docs/cdp-and-interception.md`'s still-unbuilt R5, per
 * `core/src/recovery/types.ts`'s own "R5 and R6 are never reached by this
 * package"). Both readings of R3 are approximations; `'relocate'` was
 * chosen over reusing `'restart_instance'` a second time because
 * `RecoveryEvent.rung` (the numeric `3`) still disambiguates the two for
 * any handler that reads both fields rather than `rungName` alone, and a
 * collision would have made `rung: 3` and `rung: 4` indistinguishable by
 * name.
 */
const RECOVERY_RUNG_TO_NUMBER: Readonly<Record<string, RecoveryEvent['rung']>> = Object.freeze({
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
});
const RECOVERY_RUNG_TO_NAME: Readonly<Record<string, RecoveryEvent['rungName']>> = Object.freeze({
  R0: 'restart_stream',
  R1: 'recreate_cdp',
  R2: 'reload_target',
  R3: 'relocate',
  R4: 'restart_instance',
});

/**
 * Best-effort `download.started.mime`/`download.ready` `Content-Type` by
 * file extension. This is a "did not survive contact with reality" gap in
 * the declared wire shape, named plainly rather than quietly worked
 * around: neither `Browser.downloadWillBegin` nor `Browser.downloadProgress`
 * (confirmed against the CDP protocol spec this build targets) carries a
 * MIME type at all, only a `guid`, a `url`, and a `suggestedFilename`.
 * `DownloadStarted.mime`/the `Content-Type` header this store's REST route
 * ultimately sends are therefore both inferred from the sanitised
 * suggested filename's extension, never authoritative, and default to
 * `application/octet-stream` for anything unrecognised or extension-less.
 * A small, deliberately short table (the handful of types a download
 * feature actually needs to render correctly inline versus force a save
 * dialog) rather than a full MIME database dependency for one best-effort
 * field.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  html: 'text/html',
  xml: 'application/xml',
});

function guessMimeType(safeName: string): string {
  const dot = safeName.lastIndexOf('.');
  if (dot <= 0 || dot === safeName.length - 1) return 'application/octet-stream';
  const ext = safeName.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** A small fixed palette, chosen for contrast against both light and dark UI backgrounds, cycled by a stable hash of the viewer id so the same viewer always gets the same colour for the life of the session (`presence.state`'s `colour` field is documented as stable per viewer). Not cryptographic, just deterministic. */
const PRESENCE_COLOURS = Object.freeze([
  '#e57373',
  '#64b5f6',
  '#81c784',
  '#ffb74d',
  '#ba68c8',
  '#4db6ac',
  '#f06292',
  '#a1887f',
]);

/**
 * The synthetic viewer id `clickTarget()`/`typeTarget()`/`sendCdp()`'s
 * `Input.*` gate borrow a control lease under (see `withRestControl()`).
 * Never a real connected viewer: no `ConnectionSink` is ever registered
 * against it, so it never appears in `allConnections()` or a `viewerCount`.
 *
 * It DOES now appear in `presence.state`, as a synthetic `kind: 'service'`
 * row, for as long as (and only as long as) it actually holds a lease
 * (`broadcastPresence()`'s own comment on `connectionlessHolders` has the
 * full reasoning). This is a reversal of what this comment used to say
 * ("never appears in... presence"), because that was a defect, not a
 * design: the user's directive that who is driving must be clearly visible
 * does not carve out an exception for driving that happens to arrive over
 * REST or a peer-forwarded action rather than a live socket.
 */
const REST_VIEWER_ID = 'bgls:rest';

/** CDP's `Input.dispatchMouseEvent` `buttons` bitmask, `MouseEvent.buttons` semantics, for the one button `clickTarget()` presses. Matches `core/src/input/dispatcher.ts`'s own (unexported) `buttonBit()`; kept in sync by hand since that function is private to a package this file may only import from. */
function mouseButtonBit(button: 'left' | 'middle' | 'right'): number {
  return button === 'left' ? 1 : button === 'right' ? 2 : 4;
}

function coloursFor(viewerId: string): string {
  let hash = 0;
  for (let i = 0; i < viewerId.length; i += 1) hash = (hash * 31 + viewerId.charCodeAt(i)) | 0;
  const index = Math.abs(hash) % PRESENCE_COLOURS.length;
  return PRESENCE_COLOURS[index] as string;
}

/** Constructor options for {@link ManagedSession}. */
export interface ManagedSessionOptions {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly nodeId: string;
  readonly bridge: CdpBridge;
  readonly registry: TargetRegistry;
  readonly clock?: Clock;
  /** Called once this session has no viewers and no timers left; the owning `SessionRegistry` uses this to evict it. */
  readonly onIdle?: () => void;
  /** How long a disconnected viewer's subscription bookkeeping survives, waiting for a resume. Default 120000, matching `session.resumeWindowMs`'s own default. */
  readonly resumeWindowMs?: number;
  /**
   * `R4`'s real mechanism, threaded straight through to `core.Session`'s
   * own `SessionOptions.restartInstanceExecutor` (see that type's TSDoc for
   * the full contract). `packages/server/src/session/factory.ts` is the one
   * real caller that builds this against `BrowserRouter.restart()`.
   * Defaults to `core`'s own always-`{ ok: false }` stand-in when omitted.
   */
  readonly restartInstanceExecutor?: (
    lastUrl: string | null,
    preserveProfile: boolean,
  ) => Promise<
    | { readonly ok: false }
    | { readonly ok: true; readonly bridge: CdpBridge; readonly registry: TargetRegistry }
  >;
  /**
   * Whether a `target.new` that does not say `newWindow` itself should
   * default to opening one anyway. This is `Instance.spec.isolation ===
   * 'window'` (`BrowserSpec.isolation`, `packages/protocol/src/domain/entities.ts`),
   * resolved once by `session/factory.ts` rather than looked up here:
   * `ManagedSession` never sees an `Instance` or a `BrowserSpec`, only the
   * already-connected `CdpBridge`/`TargetRegistry` pair, since router
   * (where `Instance.spec` actually lives) is off limits to everything
   * except `session/factory.ts`'s own `router.describe()` call.
   * Threading the already-resolved boolean through here, rather than a
   * fresh dependency on router state, keeps that boundary intact.
   */
  readonly defaultNewWindow?: boolean;
  /**
   * Whether this instance was launched with a stealth level active
   * (`BrowserSpec.stealth !== 'off'`). Same shape and same reason as
   * {@link defaultNewWindow} immediately above: `ManagedSession` never sees
   * a `BrowserSpec` itself, so `session/factory.ts` resolves the one bit
   * this class actually needs (not the level, just whether one is active)
   * from `view.instance.spec.stealth` and passes it through already
   * decided. Used by {@link subscribeDiagnostics} to refuse a
   * `console`/`errors` request that would silently re-enable `Runtime` and
   * undo the operator's own stealth choice, unless the caller passes
   * `acknowledgeStealthRisk: true`. Defaults to `false`, matching every
   * existing test harness that builds a `ManagedSession` directly without
   * this field: an instance nothing told this class was stealth-launched is
   * treated as not stealth-launched, never the reverse (a default of `true`
   * would refuse ordinary diagnostics on every pre-existing caller of this
   * constructor).
   */
  readonly stealthActive?: boolean;
  /**
   * Called when a viewer does something that counts as real use of this
   * instance, so the router can keep `Instance.lastActivityAt` current and
   * its idle sweep can tell a busy instance from an abandoned one.
   *
   * Wired by `session/factory.ts` to `BrowserRouter.recordActivity()`, for
   * the same reason `defaultNewWindow` above is a plain boolean:
   * `ManagedSession` must not grow a router dependency, so the router hands
   * it a closure instead.
   *
   * Must be cheap and must not throw. The router side is already throttled
   * to one store write per instance per window (30s by default), so this
   * can be called on every input event without a second throttle here.
   */
  readonly onActivity?: () => void;
  /**
   * Control lease options, passed straight through to `core.Session`'s own
   * `SessionOptions.control` (`SessionControlOptions`) with no
   * reinterpretation here. `session/factory.ts` builds it from
   * `ResolvedConfig.session.control`; omitted means core's exclusive
   * defaults, which is what every existing caller of this constructor gets.
   *
   * Core's own type is passed through rather than a server-shaped
   * equivalent (a bare `leaseMode?: LeaseMode`, say) deliberately. `Session`
   * validates this object's KEY SET at construction and throws on a key it
   * does not know, so re-encoding the vocabulary here would put a second,
   * unvalidated spelling of the same options in the middle of the one path
   * that has a real check on it. Shared control shipped inert for exactly
   * that class of reason: `session.control.mode` was accepted by the server
   * config, mapped nowhere, and dropped.
   */
  readonly control?: SessionControlOptions;
  /**
   * Structured log sink, threaded from `session/factory.ts` (which already
   * holds one). Optional so every existing caller and every test harness
   * that constructs a `ManagedSession` directly keeps working unchanged; a
   * session without one simply does not log.
   *
   * Added for one specific purpose: {@link withRestControl} needs a way to
   * make a REST input that may have been discarded VISIBLE. See its own
   * comment for why silence there was the dangerous outcome.
   */
  readonly logger?: Logger;
  /**
   * Threaded from `session/factory.ts`, which already holds the process's
   * one `HookRegistry` (`packages/server/src/index.ts` builds it and hands
   * it to the factory). Used by `dispatchEffect`'s `recovery.*` cases below
   * to fire `onRecovery`: non-vetoing (`HOOK_TIMEOUTS.onRecovery`,
   * `hooks/types.ts`), so a missing or slow handler never delays the
   * `instance.recovering`/`instance.recovered` broadcast it runs alongside.
   * Optional for the same reason `logger` is: existing callers and test
   * harnesses that build a `ManagedSession` directly keep working with
   * `onRecovery` simply never firing.
   */
  readonly hooks?: HookRegistry;
  /**
   * The gateway's one `DownloadStore` (`../downloads/download-store.js`),
   * threaded from `session/factory.ts` for the same reason `hooks` is:
   * this class has no reach into the composition root that builds it
   * (see `defaultNewWindow`'s own doc comment). Optional so every
   * existing caller and test harness that builds a `ManagedSession`
   * directly keeps working with the download feature simply never
   * arming: `ensureDownloadCapture` checks this before calling
   * `Session.startDownloadCapture` at all.
   */
  readonly downloadStore?: DownloadStore;
  /** The directory `Session.startDownloadCapture` arms `Page.setDownloadBehavior` with; must be `downloadStore`'s own `root` (`session/factory.ts` always passes the two together). */
  readonly downloadDir?: string;
  /**
   * The root directory `startRecording()`'s `DiskRecordingSink`
   * (`../recording/disk-recording-sink.ts`) writes each recording's
   * `<recordingId>/` subdirectory under. Threaded from `session/factory.ts`
   * for the same reason `downloadStore`/`downloadDir` are.
   * Optional so every existing caller and test harness that builds a
   * `ManagedSession` directly keeps working, with `startRecording` simply
   * refusing (`E_RECORDING_UNAVAILABLE`) rather than throwing a type
   * error.
   */
  readonly recordingsDir?: string;
}

/**
 * One recording this session has started, live or stopped. `recorder` and
 * `sink` are retained even after `stoppedAtMs` is set, purely so
 * `stopRecording()` (idempotent) and a diagnostic read can still reach
 * `recorder.framesWritten`/`.failed`; neither is ever written to again
 * once `state.attachments` no longer contains `recorder.attachment`.
 */
interface RecordingState {
  readonly recorder: FrameRecorder;
  readonly sink: DiskRecordingSink;
  readonly targetId: string;
  readonly mode: 'live' | 'thumbnail';
  readonly startedAtMs: number;
  stoppedAtMs: number | undefined;
}

/** One target's tier-assignment and per-viewer attachment state. */
interface TargetTierState {
  readonly tierAssigner: TierAssigner;
  readonly attachments: Map<string, Attachment>;
  /** The encode-side bounding box `Attachment`s in this tier are built against; mutable, since `reconfigureStream()`'s `maxWidth`/`maxHeight` narrows or widens it in place. */
  ownerViewport: { width: number; height: number };
  /** Serialises this target's frame handling so a slow tier-1 encode of frame N cannot land after frame N+1's tier-0 passthrough. */
  chain: Promise<void>;
  lastAdaptiveStepMono: number;
  /**
   * The wire `QualityProfile` string each attached viewer last requested
   * (`subscribe()` or `reconfigureStream()`). `core`'s `Attachment` only
   * keeps the resolved numeric ladder level (`desiredLevel`), never the
   * profile string it was seeded from, so this is the one place that
   * survives to answer `stream.stats`'s own `quality` field.
   */
  readonly qualityProfiles: Map<string, QualityProfile>;
  /**
   * A rolling window of this target's most recent `buildTierPayloads`
   * durations (ms, monotonic clock), capped at {@link ENCODE_SAMPLE_CAP}
   * entries, feeding `stream.stats`'s `encodeMsP50`/`encodeMsP95`. Shared
   * across every attachment on this target: the encode itself is done once
   * per tier per frame, not once per attachment (see `frame-pipeline.ts`'s
   * own header comment).
   */
  readonly encodeMsSamples: number[];
  /**
   * Each attached viewer's cumulative-counter reading as of the previous
   * `stream.stats` tick, so {@link emitStreamStats} can report a genuine
   * per-interval rate (frames actually sent or backpressure-dropped this
   * interval, divided by the elapsed monotonic time) instead of a
   * since-attachment-creation total.
   */
  readonly statsPrev: Map<
    string,
    { mono: number; sentCount: number; bytesSentTotal: number; backpressureDropCount: number }
  >;
}

/** How many recent `buildTierPayloads` durations {@link TargetTierState.encodeMsSamples} retains per target. */
const ENCODE_SAMPLE_CAP = 64;

/**
 * How long {@link ManagedSession.promoteOnInput} refuses to RE-promote a
 * target it promoted very recently. See that method's doc for the full
 * reasoning; the short version is that two viewers driving two tabs of one
 * OS window would otherwise de-activate each other on every pointer event.
 *
 * 250ms is chosen against how the contest actually resolves rather than
 * against a frame budget: it has to be long enough that a burst of pointer
 * events at ~100/sec collapses into one promotion (10ms would not), and
 * short enough that a person switching panes deliberately never notices the
 * delay, which puts it comfortably under the ~400ms at which a UI response
 * starts reading as sluggish. Nothing downstream depends on the exact value.
 */
const PROMOTE_REPEAT_DAMP_MS = 250;

/**
 * How long {@link ManagedSession.reportInputSignal} waits before reporting
 * the same fault for the same `(viewer, target)` again, in the log and on
 * the wire alike.
 *
 * Five seconds is chosen against the flood rather than against human
 * patience. A control handoff turns a departing driver's in-flight moves
 * into a few hundred `stale_lease` drops a second; at this window that is
 * one line and one frame, with the swallowed count carried on it. It is also
 * short enough that a client which fixes its generation or re-acquires its
 * lease is not left waiting to find out whether it worked.
 */
const INPUT_SIGNAL_COALESCE_MS = 5_000;

/** See `seenNetworkRequestIds`'s own doc: the FIFO bound on remembered `requestId`s, per viewer per target. */
const MAX_SEEN_NETWORK_REQUEST_IDS_PER_TARGET = 500;

/**
 * Compiles one `GateRule.urlPattern` to a regexp.
 *
 * `*` is the only metacharacter, matching any run of characters including
 * `/`. Everything else is escaped, so a pattern carrying a `.` or a `?`
 * (which every real URL does) matches those characters literally instead
 * of quietly becoming a much broader regexp than its author intended.
 * Getting this backwards on a DENY rule fails safe, but on an ALLOW rule
 * it would widen the hole, which is the direction that matters.
 */
function gatePatternToRegExp(pattern: string): RegExp {
  // Escape EVERY regexp metacharacter, then re-open only `*`. Split into
  // two passes on purpose: escaping first means an author's literal `.`
  // or `?` (which every real URL carries) can never survive as a
  // metacharacter, and the second pass turns the now-escaped `\*` back
  // into `.*`. Doing it the other way round would let a `.` in the
  // pattern match any character, which on a DENY rule merely over-blocks
  // but on an ALLOW rule widens the hole.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * The first rule matching this request, or `undefined` for none.
 *
 * FIRST match wins, not most specific and not last: the caller supplied
 * an ordered array and order is the only precedence anyone can read off
 * it without knowing this function. An unmatched request is allowed,
 * because a rule set is a list of exceptions to ordinary traffic; a
 * caller wanting default-deny writes a trailing `{ urlPattern: '*',
 * verdict: 'deny' }` and can see that they did.
 */
function matchGateRule(
  rules: readonly GateRule[],
  url: string,
  method: string,
  resourceType: string,
): GateRule | undefined {
  for (const rule of rules) {
    if (
      rule.methods !== undefined &&
      !rule.methods.some((m) => m.toUpperCase() === method.toUpperCase())
    )
      continue;
    if (rule.resourceTypes !== undefined && !rule.resourceTypes.includes(resourceType)) continue;
    if (!gatePatternToRegExp(rule.urlPattern).test(url)) continue;
    return rule;
  }
  return undefined;
}

/** Exposed for direct unit testing of the matcher's precedence and escaping rules. */
export const __gateMatchForTests = { gatePatternToRegExp, matchGateRule };

/** The p50/p95 of `samples`, sorted ascending; `0` for an empty window (no frames encoded yet). */
function encodePercentiles(samples: readonly number[]): { p50: number; p95: number } {
  if (samples.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] as number;
  return { p50: at(0.5), p95: at(0.95) };
}

/**
 * Builds `page.map.got`'s `degraded` field off a finished
 * {@link PageMapCapture}. See `docs/page-map.md` on accessibility degradation:
 * a per-frame accessibility failure or a failed listener signal must never
 * be silently absorbed into a reply that otherwise looks complete.
 *
 * `framesFailed` and `failures` come straight off `capture.failures`
 * (`phase: 'accessibility'` entries), exact. `framesAttempted` does not:
 * `@browserglass/core`'s `capturePageMap` return type, `PageMapCapture`,
 * does not expose the frame list `capture.ts` resolved internally for its
 * own Phase B fan-out (`pagemap/capture.ts`/`pagemap/frames.ts`, both out
 * of this stage's file ownership), so there is no exact count to read here.
 * This derives one instead: every distinct `frameId` actually present on a
 * merged node (populated by the DOM tree walk regardless of whether that
 * frame's accessibility read later succeeded or failed), unioned with every
 * `frameId` an accessibility failure named (so a frame that failed AND
 * happened to contribute zero DOM nodes is still counted, keeping
 * `framesAttempted >= framesFailed` true by construction), plus one for the
 * main document when it produced any node at all. REPORTED, not silently
 * assumed exact: the one case this undercounts is a frame whose own
 * `DOM.getDocument` walk failed (a `phase: 'domTree'` failure, contributing
 * no nodes and no `frameId` of its own to lean on) while that SAME frame's
 * independent `Accessibility.getFullAXTree` read separately succeeded, so
 * neither its nodes nor an accessibility failure entry name it. That case
 * is narrow (two independent CDP reads on the same frame disagreeing on
 * success) and, when it happens, the frame in question already contributes
 * nothing else to the reply either, so it costs an undercount in a summary
 * count, never a wrong node. Closing it exactly would mean widening
 * `PageMapCapture` to carry the frame list, a `pagemap/types.ts`/`capture.ts`
 * change outside this stage's ownership.
 */
function pageMapDegradationFrom(
  capture: PageMapCapture,
  listenersRequested: boolean,
): PageMapDegradation {
  const frameIds = new Set<string>();
  let sawMainFrameNode = false;
  for (const node of capture.nodes.values()) {
    if (node.frameId === null) sawMainFrameNode = true;
    else frameIds.add(node.frameId);
  }

  const accessibilityFailures = capture.failures.filter((f) => f.phase === 'accessibility');
  for (const f of accessibilityFailures) {
    if (f.frameId !== undefined) frameIds.add(f.frameId);
    else sawMainFrameNode = true; // defensive: `ax-merge.ts` always sets `frameId` for this phase today.
  }

  const failures: PageMapFrameFailure[] = accessibilityFailures.map((f) => ({
    frameId: f.frameId ?? '',
    reason: f.reason,
  }));

  const listenersFailure = capture.failures.find((f) => f.phase === 'listeners');
  const listeners: PageMapDegradation['listeners'] = !listenersRequested
    ? 'skipped'
    : listenersFailure
      ? 'failed'
      : 'ok';

  return {
    framesAttempted: frameIds.size + (sawMainFrameNode ? 1 : 0),
    framesFailed: accessibilityFailures.length,
    failures,
    listeners,
    ...(listenersFailure !== undefined ? { listenersReason: listenersFailure.reason } : {}),
  };
}

/** One `stream.subscribed` response's fields, everything the wire message needs beyond the envelope wrapper. */
export interface SubscribedFields {
  readonly streamId: number;
  readonly targetId: string;
  readonly quality: QualityProfile;
  readonly codec: 'jpeg' | 'webp' | 'avif' | 'png' | 'h264' | 'vp9';
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly paused: boolean;
  readonly sidEpoch: number;
  readonly gen: number;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * Owns one Instance's live `core.Session` plus every connected viewer's
 * frame fan-out state. One instance per Instance (not per viewer): a
 * `SessionRegistry` (`./registry.js`) hands out shared references, join-in-flight.
 */
/**
 * Thrown by {@link ManagedSession.pdf} when a PDF too large to inline could
 * not be written into the download store. Its message is deliberately
 * fixed text plus the errno code: the underlying `fs` error, which embeds
 * the absolute server path, is logged and never forwarded.
 */
/** `nav.goto`'s `waitUntil` values this server implements. `'networkidle'` is declared on the wire but refused by the handler (`ws/connection.ts`). */
export type NavigateWaitUntil = 'commit' | 'load';

/** How long `nav.goto` with `waitUntil: 'load'` waits for the load event when the request names no `timeoutMs`. Matches the 30s page load budget the rest of the stack uses (`@browserglass/core`'s `cdp/timeouts.ts`). */
export const DEFAULT_NAV_LOAD_TIMEOUT_MS = 30_000;

/** Upper bound on a caller supplied `nav.goto` `timeoutMs`. */
export const MAX_NAV_LOAD_TIMEOUT_MS = 120_000;

export class PdfStagingError extends Error {
  readonly code = 'E_PDF_STAGING_FAILED';
  readonly fsCode: string | undefined;
  constructor(fsCode: string | undefined) {
    super(
      `The rendered PDF could not be written to the gateway's download store${fsCode !== undefined ? ` (${fsCode})` : ''}. The gateway log has the details.`,
    );
    this.name = 'PdfStagingError';
    this.fsCode = fsCode;
  }
}

export class ManagedSession {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly nodeId: string;

  /** Not `readonly`: swapped to the fresh pair `ManagedSessionOptions.restartInstanceExecutor` returns once `dispatchEffect`'s `'instance.restart.result'` case sees `ok: true`, so `navigate()`/`capture()`/`probe()`/`queryRealViewport()`/`ensureAttached()`/`emitNavState()` (every method below that reaches `this.bridge`/`this.registry` directly, not through `core.Session`) stop issuing commands against the terminated browser's dead WebSocket. */
  private bridge: CdpBridge;
  /** Not `readonly`; see {@link bridge}'s note. */
  private registry: TargetRegistry;
  /**
   * The per-target page map capture cache (`@browserglass/core`'s
   * `PageMapCache`), rebuilt against the fresh `bridge` in
   * {@link applyRestartResult} for the identical reason {@link bridge}
   * itself is not `readonly`: a cache entry's own `DOM.documentUpdated`/
   * `Page.frameNavigated` subscriptions are bound to the `CdpBridge` that
   * was live when `set()` ran, and a restart replaces that bridge outright.
   * See {@link pageMap}/{@link stampPageMap} for what this actually buys:
   * `stampPageMap`'s epoch freshness check (see `docs/page-map.md` on
   * indices and epochs) reads this cache rather than re-capturing, so "before any
   * CDP command goes out" is literally true, not merely "before any
   * mutating command".
   */
  private pageMapCache: PageMapCache;
  private readonly session: Session;
  private readonly onIdle: (() => void) | undefined;

  private readonly connections = new Map<string, ConnectionSink>();
  /** One entry per currently connected viewer, the fields `presence.state` needs that nothing else in this class tracks (`label`/`kind` from the identity `attachViewer`/`resumeViewer` received, a stable `colour`, and `joinedAt`). Removed in `detachViewer`, unlike `streamIndex`/`targetTier`'s per viewer entries: presence reflects who is connected right now, not who might resume. */
  private readonly presenceEntries = new Map<
    string,
    { label: string; kind: 'human' | 'agent' | 'service'; colour: string; joinedAt: number }
  >();
  /**
   * The granted capabilities of every currently connected viewer, refreshed
   * on attach, resume and reauth (`applyCapabilityShrink`). Diagnostics
   * delivery (`deliverDiagnostics`) reads this rather than trusting
   * `diagnosticsSubscribers` alone: a viewer that held `devtools` at
   * subscribe time but lost it on a reauth narrowing must stop receiving
   * console/network traffic immediately, not just fail a fresh
   * `diagnostics.subscribe`.
   */
  private readonly viewerCapabilities = new Map<string, ReadonlySet<Capability>>();
  private readonly targetTier = new Map<string, TargetTierState>();
  /**
   * Diagnostics feed requests, keyed by target then by the viewer that made
   * them. `core.Session` owns one
   * `TargetDiagnostics` PER TARGET, not per viewer, so when two viewers
   * subscribe to the same target with different feeds the shared collector
   * has to run the union of what either of them asked for; shrinking or
   * widening it as viewers join and leave is `subscribeDiagnostics`/`unsubscribeDiagnostics`'s
   * job, via `unionFeeds`.
   */
  private readonly diagnosticsSubscribers = new Map<string, Map<string, DiagnosticsFeeds>>();
  /**
   * The scoping bound `getResponseBody` enforces: `requestId`s ACTUALLY
   * DELIVERED to a viewer as a `network.request` envelope
   * (`deliverDiagnostics`'s own `diagnostics.networkRequest` case records
   * into this, never `getResponseBody` itself), keyed by viewer then by
   * target. See `@browserglass/protocol`'s `wire/messages/response-body.ts`,
   * "enforced in the SERVER": a `(viewerId, targetId, requestId)` triple
   * absent here is refused as `E_RESPONSE_BODY_UNKNOWN_REQUEST` before any
   * CDP command is sent, regardless of whether the id is real.
   *
   * Bounded per `(viewer, target)` by {@link MAX_SEEN_NETWORK_REQUEST_IDS_PER_TARGET},
   * FIFO once exceeded: a long-lived, chatty page would otherwise grow this
   * set forever, and a caller reading a response body only ever cares about
   * a request it JUST watched happen, never one from thousands of
   * navigations ago. Cleared per-viewer in `detachViewer`, mirroring
   * `streamIndex`'s own per-viewer cleanup, since nothing here needs to
   * survive a `pendingPurge` resume window the way stream attachments do.
   */
  private readonly seenNetworkRequestIds = new Map<string, Map<string, Set<string>>>();
  /** Unsubscribes for the `TargetRegistry` tab-lifecycle listeners this session fans out to every viewer. Rebound after a restart swaps the registry; see {@link wireTargetLifecycle}. */
  private targetLifecycleUnsubs: (() => void)[] = [];

  /** `streamId` (per viewer socket) -> `targetId`, for `unsubscribe`/`ack`/`stream.quality` lookups keyed only by the wire handle. */
  private readonly streamIndex = new Map<string, Map<number, string>>();
  /** Purge timers for disconnected-but-not-yet-expired viewers; see {@link detachViewer}. */
  private readonly pendingPurge = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Every `targetId` this session has ever seen a target-scoped action for
   * (subscribe, `control.request`, input, ...), a superset of
   * `targetTier`'s keys (stream-subscribed targets only). `core.Session`
   * exposes no way to enumerate its own lazily-created `ControlLeaseEngine`s,
   * so this is the closest thing to "every target that might have an active
   * lease" a caller outside `core` can maintain; `applyCapabilityShrink`
   * needs exactly that to find a lease to revoke.
   */
  private readonly knownTargetIds = new Set<string>();
  /**
   * Monotonic reading of the last time {@link promoteOnInput} promoted each
   * target, used only for the re-promotion damper that method documents. A
   * plain elapsed-time comparison against `monotonicNow()`, never a real
   * timer, so there is nothing here that needs `.unref?.()`. Never pruned
   * when a target closes, the same tolerated per-target growth
   * `ViewerRateLimiters.perScopeBuckets` accepts for the same reason: one
   * abandoned number per target that was ever driven is not worth a
   * teardown hook.
   */
  private readonly lastPromotionMono = new Map<string, number>();
  /**
   * The instance's real rendered viewport, resolved once per session by
   * {@link instanceViewport} and cached. `undefined` until the first
   * successful read; never re-read after one succeeds, because
   * `welcome.instance.viewport` describes the browser this session is
   * attached to rather than any one target's current geometry.
   */
  private cachedInstanceViewport: { width: number; height: number } | undefined;
  /**
   * Coalescing state for {@link reportInputSignal}, keyed by
   * `(viewerId, targetId, signal kind, wire code)`. Never pruned when a
   * viewer leaves, the same tolerated growth `lastPromotionMono` and
   * `ViewerRateLimiters.perScopeBuckets` accept: two numbers per distinct
   * fault a session ever saw is not worth a teardown hook.
   */
  private readonly inputSignalCoalesce = new Map<
    string,
    { lastReportedMono: number; suppressed: number }
  >();
  private readonly logger: Logger | undefined;
  /** See {@link ManagedSessionOptions.hooks}. */
  private readonly hooks: HookRegistry | undefined;
  /** See {@link ManagedSessionOptions.downloadStore}/`.downloadDir}. */
  private readonly downloadStore: DownloadStore | undefined;
  private readonly downloadDir: string | undefined;
  /** See {@link ManagedSessionOptions.recordingsDir}. */
  private readonly recordingsDir: string | undefined;
  /**
   * Every recording this session has ever started, keyed by `recordingId`,
   * kept after `stopRecording()` (with `stoppedAtMs` set) so
   * `listRecordings()` can still answer for it. Never pruned within a
   * session's lifetime: a session that records a lot is exactly the
   * session an operator most wants a complete `recording.list` history
   * from, and the entry itself is a few small numbers plus two ids, not
   * the recorded bytes.
   */
  private readonly recordings = new Map<string, RecordingState>();
  /** Targets `Session.startDownloadCapture` has already been armed for, so `ensureDownloadCapture` never re-sends `Page.setDownloadBehavior` for one it already covers. Mirrors `diagnosticsSubscribers`'s keying by target, but with no per-viewer feed union: download capture is a plain on/off, not a union of requested feeds (there is no `download.subscribe` wire message, unlike `diagnostics.subscribe`; see `ensureDownloadCapture`'s own doc). */
  private readonly downloadCaptureTargets = new Set<string>();
  /**
   * `downloadId` -> what `download.started` learned about it, so
   * `download.completed`'s handling (which core reports with no `url` of
   * its own, see `@browserglass/core`'s `DownloadCompletedPayload` doc for
   * why) can still fill `DownloadEvent.sourceUrl`. Entered on `download.started`,
   * removed on `download.completed` or `download.failed`: `DownloadBridge`
   * itself already bounds how many downloads can be simultaneously pending
   * per target (`MAX_PENDING_DOWNLOADS`, `download-bridge.ts`) and reports
   * an eviction as `download.failed`, which cleans up the matching entry
   * here the same way any other terminal event does, so this map cannot
   * outgrow that same bound.
   */
  private readonly downloadStarted = new Map<
    string,
    { readonly url: string; readonly suggestedName: string }
  >();
  private readonly resumeWindowMs: number;
  private disposed = false;
  /**
   * Drives {@link emitStreamStats} every `DEFAULT_LIMITS.statsIntervalMs`
   * (2000ms). `core`'s `Attachment` and this
   * class's own `frame-pipeline.ts`-driven fan-out already track every raw
   * counter `stream.stats` needs; this timer does the periodic packaging
   * and send on top of them. Real Node timer, `.unref?.()`'d immediately so a session with
   * no other pending work never keeps the process alive on its account
   * alone.
   */
  private readonly statsTimer: ReturnType<typeof setInterval>;
  /** See {@link ManagedSessionOptions.defaultNewWindow}. */
  private readonly defaultNewWindow: boolean;
  /** See {@link ManagedSessionOptions.stealthActive}. */
  private readonly stealthActive: boolean;
  private readonly onActivity: (() => void) | undefined;

  constructor(opts: ManagedSessionOptions) {
    this.instanceId = opts.instanceId;
    this.sessionId = opts.sessionId;
    this.tenantId = opts.tenantId;
    this.appId = opts.appId;
    this.nodeId = opts.nodeId;
    this.bridge = opts.bridge;
    this.registry = opts.registry;
    this.pageMapCache = new PageMapCache(this.bridge);
    this.onIdle = opts.onIdle;
    this.resumeWindowMs = opts.resumeWindowMs ?? 120_000;
    this.defaultNewWindow = opts.defaultNewWindow ?? false;
    this.stealthActive = opts.stealthActive ?? false;
    this.onActivity = opts.onActivity;
    this.logger = opts.logger;
    this.hooks = opts.hooks;
    this.downloadStore = opts.downloadStore;
    this.downloadDir = opts.downloadDir;
    this.recordingsDir = opts.recordingsDir;

    this.session = new Session({
      id: this.sessionId as never,
      instanceId: this.instanceId as never,
      tenantId: this.tenantId,
      nodeId: this.nodeId,
      bridge: this.bridge,
      registry: this.registry,
      clock: opts.clock ?? createSystemClock(),
      onEffect: (effect) => this.dispatchEffect(effect),
      onFrame: (targetId, frame, seq, gen, tsDeltaMs) => {
        void this.handleFrame(targetId, frame, seq, gen, tsDeltaMs);
      },
      ...(opts.restartInstanceExecutor
        ? { restartInstanceExecutor: opts.restartInstanceExecutor }
        : {}),
      ...(opts.control ? { control: opts.control } : {}),
    });
    this.session.provision();

    this.wireTargetLifecycle();

    this.statsTimer = setInterval(() => this.emitStreamStats(), DEFAULT_LIMITS.statsIntervalMs);
    this.statsTimer.unref?.();
  }

  /**
   * Fans `TargetRegistry`'s tab lifecycle out to every viewer on this
   * Instance.
   *
   * `target.created`, `target.updated` and `target.closed` used to be sent
   * only as a direct reply to whichever socket asked for the tab change, so
   * a second viewer of the same browser never learned about it. Its tab
   * strip stayed frozen at whatever `welcome.targets` said when it
   * connected, and `BrowserGlassClient.requestControl()`'s own
   * "no such target" guard then refused to let it touch a tab it had never
   * been told about. Tabs the page itself opened or closed (`window.open`,
   * a `target="_blank"` link, the user closing a tab in the real Chrome
   * window) were invisible to every viewer, including the one that caused
   * them, since no client request existed to reply to.
   *
   * The registry already emitted all three; nothing was listening.
   * Different clients on different tabs of the same browser need this to
   * be a broadcast, because the tab list is a property of the Instance
   * and not of whoever happened to ask.
   */
  private wireTargetLifecycle(): void {
    for (const off of this.targetLifecycleUnsubs.splice(0)) off();
    const registry = this.registry;

    /**
     * Only tabs are announced. `TargetRegistry` tracks everything CDP
     * reports (out of process iframes, dedicated and service workers,
     * extension background pages), and `classifyTarget` marks exactly one
     * of those kinds as belonging in a tab list. `listTargets()` already
     * filters to pages through `registry.tabs()`, so a broadcast that did
     * not would leave `client.targets` disagreeing with `target.list` on
     * the same session, and `useTargets()` (which renders `client.targets`
     * verbatim) would put a pane on screen for a service worker.
     */
    const isTab = (t: unknown): boolean => (t as { type?: string }).type === 'page';

    this.targetLifecycleUnsubs.push(
      registry.on('created', (t) => {
        if (!isTab(t)) return;
        const summary = this.getTargetSummary((t as { id: string }).id);
        if (summary) this.broadcast({ t: 'target.created', target: summary });
        // A target created AFTER a download-capable viewer already
        // attached is exactly the case `syncDownloadCapture`'s loop
        // (`this.listTargets()`, the CURRENT tab set) cannot react to on
        // its own: nothing re-runs that loop just because a new tab
        // appeared, so this call is the widen trigger for that one case.
        // Every OTHER case (a tab that already existed when a
        // download-capable viewer attaches, or capability changes) is
        // `syncDownloadCapture`'s job, from `this.listTargets()` rather
        // than a locally tracked set: `TargetRegistry.tabs()` is already
        // the live, current answer to "which targets exist right now"
        // (the same source `listTargets()`/`getTargetSummary` above both
        // read), so there is no separate "every target this session has
        // ever seen" bookkeeping to keep in sync with it.
        this.ensureDownloadCapture((t as { id: string }).id);
      }),
      registry.on('updated', (t) => {
        if (!isTab(t)) return;
        const summary = this.getTargetSummary((t as { id: string }).id);
        if (summary)
          this.broadcast({
            t: 'target.updated',
            targetId: summary.targetId,
            changed: {
              url: summary.url,
              title: summary.title,
              loading: summary.loading,
              active: summary.active,
            },
          });
      }),
      registry.on('closed', (t) => {
        if (!isTab(t)) return;
        this.broadcast({ t: 'target.closed', targetId: (t as { id: string }).id, reason: 'user' });
      }),
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  get coreSession(): Session {
    return this.session;
  }

  get viewerCount(): number {
    return this.connections.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.statsTimer);
    for (const off of this.targetLifecycleUnsubs.splice(0)) off();
    for (const timer of this.pendingPurge.values()) clearTimeout(timer);
    this.pendingPurge.clear();
    this.pageMapCache.dispose();
    this.session.dispose();
    void this.bridge.close('managed-session-disposed');
  }

  // ── viewers ──────────────────────────────────────────────────────────

  /**
   * `presenceLabel`, when given, overrides `presence.state`'s `label` for
   * this viewer (default: the bare `viewerId`, every other caller's
   * behaviour, unchanged). The one caller that needs this is
   * `ws/cdp-upgrade.ts`: a raw CDP client's `viewerId` is an opaque `vwr_`
   * id like any other, but `PresenceState.viewers[].label` is the ONE
   * field a UI actually renders, and "a `vwr_` id with no other marking"
   * gives a human looking at the roster no way to tell a Playwright/
   * Puppeteer/chrome-remote-interface driver apart from an ordinary
   * `bgls.v1` viewer, which is exactly the invisibility this closes. See that module's own `presenceLabelFor` for what it passes.
   */
  attachViewer(
    sink: ConnectionSink,
    identity: Omit<CoreViewerOptions, 'sessionId'>,
    presenceLabel?: string,
  ): CoreViewer {
    this.connections.set(sink.viewerId, sink);
    this.streamIndex.set(sink.viewerId, new Map());
    this.viewerCapabilities.set(sink.viewerId, new Set(identity.capabilities));
    this.presenceEntries.set(sink.viewerId, {
      label: presenceLabel ?? sink.viewerId,
      kind: identity.kind,
      colour: coloursFor(sink.viewerId),
      joinedAt: Date.now(),
    });
    // A fresh attach with `download` already granted must arm capture on
    // every target this session already knows about, not only ones
    // created from this point forward (`wireTargetLifecycle`'s own call
    // into `ensureDownloadCapture` only covers the latter).
    this.syncDownloadCapture();
    // Deliberately does not call broadcastPresence() here: this method runs
    // before ws/connection.ts's freshAttach() has sent welcome, and welcome
    // must be sq 1 (the wire protocol requires it, and the client's own
    // handshake state machine treats it as the first message). The caller
    // broadcasts once welcome (and, for a subscribed hello, stream.subscribed)
    // is already on the wire.
    return this.session.addViewer(identity);
  }

  /**
   * Re-attaches a resuming viewer: cancels the pending purge timer
   * `detachViewer` armed, and returns the `targetId`s the disconnected
   * socket was subscribed to (read from the `streamIndex` entry
   * `detachViewer` deliberately left in place rather than deleting), so
   * `ws/connection.ts`'s resume path can re-subscribe to each one with a
   * fresh `Attachment` and a bumped `sidEpoch`. The old `streamIndex`
   * entries are cleared here: the caller is expected to repopulate them via
   * ordinary `subscribe()` calls immediately after.
   */
  resumeViewer(
    sink: ConnectionSink,
    identity: Omit<CoreViewerOptions, 'sessionId'>,
  ): { readonly restoredTargetIds: readonly string[] } {
    const timer = this.pendingPurge.get(sink.viewerId);
    if (timer) {
      clearTimeout(timer);
      this.pendingPurge.delete(sink.viewerId);
    }
    const oldStreams = this.streamIndex.get(sink.viewerId);
    const restoredTargetIds = oldStreams ? [...new Set(oldStreams.values())] : [];
    for (const state of this.targetTier.values()) {
      state.attachments.delete(sink.viewerId);
      state.qualityProfiles.delete(sink.viewerId);
      state.statsPrev.delete(sink.viewerId);
    }
    this.connections.set(sink.viewerId, sink);
    this.streamIndex.set(sink.viewerId, new Map());
    this.viewerCapabilities.set(sink.viewerId, new Set(identity.capabilities));
    this.presenceEntries.set(sink.viewerId, {
      label: sink.viewerId,
      kind: identity.kind,
      colour: coloursFor(sink.viewerId),
      joinedAt: Date.now(),
    });
    this.session.addViewer(identity);
    // Same reasoning as `attachViewer`'s own call.
    this.syncDownloadCapture();
    // See attachViewer()'s note: the caller broadcasts once welcome and
    // resumed are already on the wire, not before.
    return { restoredTargetIds };
  }

  /**
   * Applies a capability shrink for `viewerId` (a `hello{reauth:true}`
   * narrowing what was granted), revoking any control lease this viewer
   * currently holds across every target in the same tick this call runs in.
   * `revoke()` requires
   * `isAdmin`; the synthetic system identity below is never a real viewer
   * and never appears on any connection.
   */
  applyCapabilityShrink(viewerId: string, newCaps: readonly Capability[]): void {
    this.viewerCapabilities.set(viewerId, new Set(newCaps));
    // A reauth that drops `download` must stop capture the instant nobody
    // left holds it, the same "gate two" `deliverDownload` already
    // enforces on the way OUT; this is the "gate one" (CDP-level) half of
    // the same story on the way IN.
    this.syncDownloadCapture();
    const stillHasControl = newCaps.includes('control');
    if (!stillHasControl) {
      for (const targetId of this.knownTargetIds) {
        const snapshot = this.session.leaseEngineFor(targetId).getSnapshot();
        // `isLeaseHolder`, not `snapshot.holder?.viewerId === viewerId`: in
        // shared mode this viewer is one of several drivers, and losing
        // `control` on reauth has to end THIS viewer's tenure without
        // disturbing anybody else's. `revoke()` already names the viewer to
        // remove, so the only thing that had to change here is the question
        // asked, not the action taken.
        if (isLeaseHolder(snapshot, viewerId)) {
          void this.session.leaseEngineFor(targetId).revoke(
            {
              viewerId: 'bgls:system',
              identity: 'bgls:system',
              label: 'system',
              kind: 'human',
              isAdmin: true,
            },
            viewerId,
            'capability_lost',
          );
        }
      }
    }
    this.connections
      .get(viewerId)
      ?.sendEnvelope({ t: 'capabilities.updated', granted: newCaps, reason: 'reauth' });
  }

  /**
   * Keeps `viewerCapabilities` current for `viewerId` on every reauth,
   * widen or shrink alike. Unlike {@link applyCapabilityShrink} this never
   * revokes a control lease or broadcasts `capabilities.updated`; those stay
   * gated on an actual shrink (`ws/connection.ts`'s own `isShrink` check,
   * which already calls `applyCapabilityShrink` and so already updates this
   * same map for that case; this is the widen-path counterpart).
   * Diagnostics delivery (`deliverDiagnostics`) needs a viewer's CURRENT
   * capabilities regardless of which direction they just changed: a viewer
   * that just gained `devtools` on reauth must start receiving diagnostics
   * traffic for a target it is already subscribed to, not wait for its next
   * reconnect.
   *
   * Also re-derives the viewer's KIND, because `automation` is a capability
   * and a reauth replaces the capability set wholesale.
   *
   * That matters more than it used to. `ws/connection.ts` decides
   * human-versus-agent in exactly one place, by absence:
   * `granted.has('automation') ? 'agent' : 'human'`. The inference itself is
   * sound, since `automation` is minted into the token by whoever issued it,
   * so its absence is an authenticated fact rather than a guess. It is also
   * read live on every `viewerIdentity()` call, so `control.request`,
   * `control.revoke` and `control.yield` all see a current answer even
   * straight after a reauth.
   *
   * What was NOT current is the copy taken at attach time. `presenceEntries`
   * recorded `kind` once, in `attachViewer`/`resumeViewer`, and a reauth
   * never touched it, so a viewer whose token gained or lost `automation`
   * mid session kept its old label in every `presence.state` broadcast until
   * it reconnected. Recomputed here from the capabilities actually in force,
   * for the same reason `refreshLeaseHolders` recomputes holder-ness from
   * the engine snapshot instead of patching it from events: derived state
   * belongs to its source, and a copy that only some paths update is a copy
   * that will be wrong on the paths nobody thought about.
   *
   * One copy is still beyond reach from here: `LeaseHolder.kind`, recorded
   * inside `@browserglass/core`'s engine at grant time. A viewer that holds
   * a lease ACROSS a reauth that flips `automation` keeps the kind their
   * tenure was granted under, and `control.yield` decides per holder on
   * exactly that field. The engine exposes no way to amend a live holder's
   * kind, and inventing the semantics for one (amend it, or end the tenure
   * the way `applyCapabilityShrink` ends a lease when `control` is lost) is
   * a behavioural decision for whoever owns the engine, so it is left
   * alone here.
   */
  setViewerCapabilities(viewerId: string, caps: readonly Capability[]): void {
    this.viewerCapabilities.set(viewerId, new Set(caps));
    const entry = this.presenceEntries.get(viewerId);
    if (entry) entry.kind = caps.includes('automation') ? 'agent' : 'human';
    // The widen path counterpart to `applyCapabilityShrink`'s own call:
    // this is the method a reauth that GAINS `download` actually runs
    // through (matching this method's own doc, which already makes the
    // same point for `deliverDiagnostics`).
    this.syncDownloadCapture();
  }

  /**
   * A disconnected socket's `streamIndex` entry (which target ids it was
   * subscribed to) is deliberately kept for {@link resumeWindowMs}, not
   * deleted immediately: it is the only record of "what to restore" a
   * later `resumeViewer` call has, since the resume token itself carries
   * no subscription snapshot. The attachment objects themselves are left alone too;
   * their `transport` is the now-closed `ConnectionSink`, so `isOpen()`
   * already reports `false` and the frame-emission fan-out skips them for
   * free. `pendingPurge`'s timer is the one place either gets deleted, once
   * the window lapses with no resume.
   */
  detachViewer(viewerId: string): void {
    this.connections.delete(viewerId);
    this.presenceEntries.delete(viewerId);
    this.viewerCapabilities.delete(viewerId);
    // The last `download`-holding viewer disconnecting must disarm
    // capture, the same way it must disarm on a capability shrink
    // (`applyCapabilityShrink`'s own call): a socket closing is not
    // different, for this purpose, from that socket's token narrowing to
    // nothing.
    this.syncDownloadCapture();
    // Dropped outright on disconnect, for the same reason diagnostics
    // subscriptions are, plus a sharper one: a gate whose owner is gone
    // can no longer be asked anything, so every `ask` rule on it would
    // hold each request for its full deadline and then apply the timeout
    // verdict. Leaving that in place would turn one dropped socket into a
    // page that loads at the speed of the hold timeout, which reads as
    // "the browser broke" rather than "the gate's owner left".
    this.releaseGatesOwnedBy(viewerId);
    // Diagnostics subscriptions are dropped outright on disconnect, unlike
    // `streamIndex`/`targetTier`'s attachments below (which survive until
    // `pendingPurge` lapses, so a resuming viewer's video picks up where it
    // left off): nothing in this build restores a diagnostics subscription
    // across a resume (`resumeInto` only rebuilds `restoredStreams`/the
    // control lease), so keeping the bookkeeping around would only ever be
    // read by `deliverDiagnostics`, whose `connections.get(viewerId)` is
    // already gone the instant this method runs regardless.
    // The `getResponseBody` scoping bound: nothing addresses this viewer's
    // own memory of what it was shown once its connection is gone, and
    // dropping it here (rather than at `pendingPurge` lapse, the way
    // `streamIndex` waits) costs a resuming viewer nothing, since a fresh
    // socket's own `network.request` deliveries repopulate it as they
    // arrive.
    this.seenNetworkRequestIds.delete(viewerId);
    for (const targetId of [...this.diagnosticsSubscribers.keys()]) {
      this.unsubscribeDiagnostics(viewerId, targetId);
    }
    this.session.removeViewer(viewerId);
    this.broadcastPresence();
    const timer = setTimeout(() => {
      this.pendingPurge.delete(viewerId);
      this.streamIndex.delete(viewerId);
      for (const state of this.targetTier.values()) {
        state.attachments.delete(viewerId);
        state.qualityProfiles.delete(viewerId);
        state.statsPrev.delete(viewerId);
      }
    }, this.resumeWindowMs);
    timer.unref?.();
    this.pendingPurge.set(viewerId, timer);
    if (this.connections.size === 0) this.onIdle?.();
  }

  connectionFor(viewerId: string): ConnectionSink | undefined {
    return this.connections.get(viewerId);
  }

  allConnections(): readonly ConnectionSink[] {
    return [...this.connections.values()];
  }

  /**
   * The full `presence.state.viewers` array, computed fresh from
   * `presenceEntries` and the control engine's own live holder lists.
   * Public, and the ONE place this array is built: `broadcastPresence()`
   * (below) calls this and sends the result over the wire, and
   * `rest/routes/presence.ts`'s `GET /v1/instances/:instanceId/viewers`
   * (`RestContext.sessionRegistry`) calls this and returns the result as
   * JSON. Before this existed, that REST route had no way to reach
   * `presenceEntries` at all (private, no accessor) and reported
   * `kind: null`/`joinedAt: null` with an honest
   * `presenceFieldsUnavailable` marker; routing both surfaces through one
   * method is what makes that marker unnecessary, not a second, hand
   * synced implementation of the same roster.
   *
   * A lease holder with no `presenceEntries` row at all: `REST_VIEWER_ID`
   * (`withRestControl`'s synthetic identity, borrowed by `clickTarget`/
   * `typeTarget`/`sendCdp`'s `Input.*` gate) and, through the same
   * identity, every peer-forwarded `cdp` action `node-action-executor.ts`
   * relays into `sendCdp`. Both drive real input into a real target while
   * this method runs, and until now both were invisible: `REST_VIEWER_ID`
   * carried a doc comment declaring it "never a real connected viewer...
   * never appears in `allConnections()`, presence, or a `viewerCount`",
   * which was true of the FIELD but wrong as a PRODUCT decision. The
   * user's directive is explicit that "who is driving" must be clear and
   * visible; a REST click landing on a page a human is watching, with the
   * viewer list showing only that human, is exactly the invisible driving
   * this whole change exists to end. Reversed here rather than left
   * contradicting the code: see that constant's own comment, updated to
   * match.
   *
   * `kind: 'service'` (not `'agent'`) for such a row: unlike an `'agent'`
   * presence row (a live, connected driver with its own socket and its
   * own tenure in this roster, whether a `bgls.v1` `AutomationClient` or a
   * raw CDP proxy client, `ws/cdp-upgrade.ts`), this row represents no
   * connection at all. It exists for the seconds `withRestControl` holds
   * the borrowed lease and vanishes the moment that call's `finally`
   * releases it; the NEXT call to this method simply omits it again,
   * because `REST_VIEWER_ID` is no longer among `leaseHoldersOf(...)` for
   * any known target. There is no `ConnectionSink` to register and none
   * is fabricated: this reads the engine's own holder list, which is
   * already authoritative for "who is driving right now", and projects a
   * row from it rather than inventing a fake socket to hang one off.
   */
  presenceSnapshot(): PresenceState['viewers'] {
    const viewers: PresenceState['viewers'] = [];
    const seenViewerIds = new Set<string>();
    for (const [viewerId, entry] of this.presenceEntries) {
      seenViewerIds.add(viewerId);
      const controlling: string[] = [];
      const watching: string[] = [];
      for (const [targetId, state] of this.targetTier) {
        if (state.attachments.has(viewerId)) watching.push(targetId);
      }
      for (const targetId of this.knownTargetIds) {
        const snapshot = this.session.leaseEngineFor(targetId).getSnapshot();
        // Shared mode puts several viewers in `controlling` for the SAME
        // targetId, which is the point: `presence.state` is how a viewer
        // finds out somebody else is driving the tab they are driving, and
        // a singular holder check would have shown at most one of them.
        if (isLeaseHolder(snapshot, viewerId)) controlling.push(targetId);
      }
      viewers.push({
        viewerId,
        label: entry.label,
        kind: entry.kind,
        colour: entry.colour,
        controlling,
        watching,
        idle: false,
        joinedAt: entry.joinedAt,
      });
    }
    const connectionlessHolders = new Map<
      string,
      { label: string; kind: 'service'; controlling: string[] }
    >();
    for (const targetId of this.knownTargetIds) {
      const snapshot = this.session.leaseEngineFor(targetId).getSnapshot();
      for (const holder of leaseHoldersOf(snapshot)) {
        if (seenViewerIds.has(holder.viewerId)) continue;
        let row = connectionlessHolders.get(holder.viewerId);
        if (!row) {
          row = { label: holder.label, kind: 'service', controlling: [] };
          connectionlessHolders.set(holder.viewerId, row);
        }
        row.controlling.push(targetId);
      }
    }
    for (const [viewerId, row] of connectionlessHolders) {
      viewers.push({
        viewerId,
        label: row.label,
        kind: row.kind,
        colour: coloursFor(viewerId),
        controlling: row.controlling,
        // No socket means no video subscription: `targetTier.attachments`
        // is keyed by a real `ConnectionSink`'s `viewerId`, and a
        // connection-less holder never appears there.
        watching: [],
        idle: false,
        // No real join time exists for a tenure this short lived; `Date.now()`
        // is honest about that (it is recomputed fresh on every call, never
        // cached), rather than implying a persistent presence that was
        // never there.
        joinedAt: Date.now(),
      });
    }
    return viewers;
  }

  /**
   * Sends a fresh `presence.state` to every currently connected viewer.
   * The browser client's own `welcome` handling only ever populates its
   * presence roster once, at construction; the React `usePresence()`
   * hook's live re-sync (and so `RequestControlButton`'s `myViewerId`
   * comparison, and `ViewerList`) depends entirely on a `presence.state`
   * broadcast actually arriving, which nothing sent before this method
   * existed (the client package's own source comments already documented this as expected
   * behaviour that the server side never implemented).
   * Called whenever the roster or any viewer's `controlling`/`watching`
   * set changes: once by `ws/connection.ts` right after a fresh or resumed
   * viewer's `welcome` (and `resumed`, on the resume path) is on the wire,
   * from `detachViewer`, and from every lease grant, release, revoke, or
   * preemption.
   */
  broadcastPresence(): void {
    if (this.connections.size === 0) return;
    const message = {
      t: 'presence.state' as const,
      viewers: this.presenceSnapshot(),
    } satisfies Pick<PresenceState, 't' | 'viewers'>;
    for (const sink of this.connections.values()) {
      sink.sendEnvelope(message as unknown as Record<string, unknown> & { t: string });
    }
  }

  /**
   * Relays one viewer's cursor position to every OTHER viewer on this
   * session.
   *
   * This existed on the wire and on both client halves and nowhere in
   * between. `packages/client/src/client/BrowserGlassClient.ts` sends
   * `presence.cursor` (throttled to one every 40ms alongside a mouse move)
   * and handles receiving one, reading the sender from the envelope's
   * `vid`. `packages/server/src/ws/connection.ts` even maps the type to its
   * own `cursor` rate limit bucket. But nothing ever handled it, so every
   * cursor a viewer sent came back as `bgls.error.protocol.unknown_type`:
   * shared cursor presence was dead, and moving the mouse produced a
   * steady stream of errors rather than one.
   *
   * Never echoed to the sender, who already knows where its own pointer is
   * and would otherwise fight its own local rendering.
   *
   * `vid` is stamped here rather than left to `sendEnvelope`, because the
   * receiving client identifies the cursor's owner from it and the relayed
   * message describes a DIFFERENT viewer than the one it is being sent to.
   */
  relayCursor(
    fromViewerId: string,
    cursor: {
      targetId: string;
      x: number;
      y: number;
      fw: number;
      fh: number;
      action?: string;
      label?: string;
    },
  ): void {
    const entry = this.presenceEntries.get(fromViewerId);
    if (!entry) return;
    const message = {
      t: 'presence.cursor' as const,
      vid: fromViewerId,
      targetId: cursor.targetId,
      x: cursor.x,
      y: cursor.y,
      fw: cursor.fw,
      fh: cursor.fh,
      ...(cursor.action !== undefined ? { action: cursor.action } : {}),
      label: cursor.label ?? entry.label,
    };
    for (const [viewerId, sink] of this.connections) {
      if (viewerId === fromViewerId) continue;
      if (!sink.isOpen()) continue;
      sink.sendEnvelope(message as unknown as Record<string, unknown> & { t: string });
    }
  }

  // ── targets ──────────────────────────────────────────────────────────

  listTargets(includeKinds?: readonly TargetKind[]): TargetSummary[] {
    const all = this.registry.tabs() as unknown as TargetRuntimeLike[];
    const activeTargetIds = this.activeTargetIdsSafe();
    const summaries = all.map((t) =>
      toTargetSummary(t, { activeTargetIds, viewerCount: this.viewerCountFor(t.id) }),
    );
    if (!includeKinds || includeKinds.length === 0) return summaries;
    return summaries.filter((s) => includeKinds.includes(s.kind));
  }

  getTargetSummary(targetId: string): TargetSummary | undefined {
    const t = this.registry.get(targetId as never) as unknown as TargetRuntimeLike | undefined;
    if (!t) return undefined;
    return toTargetSummary(t, {
      activeTargetIds: this.activeTargetIdsSafe(),
      viewerCount: this.viewerCountFor(targetId),
    });
  }

  /**
   * Every OS window's screencast backed target, which is what
   * `TargetSummary.active` means per-window and what a tab strip renders
   * as LIVE rather than POLLING.
   *
   * This used to return the first target that happened to have a stream
   * handle, which is not the same question at all: with three tabs
   * subscribed it named whichever was iterated first regardless of which
   * one Chrome was actually compositing, and when the iteration found
   * nothing it reported `null`, so every tab rendered as POLLING and none
   * ever showed LIVE. `Session` now exposes the policy's own answer.
   *
   * Window isolation replaced the single instance-wide active target with
   * one active target per OS window: a target
   * is LIVE exactly when it appears in this set, regardless of what is
   * active in any other window. `TargetActivationPolicy.activeTargetIds`
   * already returns one entry per window, so membership is the whole
   * per-window `active` computation; nothing here needs to know which
   * window a given target actually belongs to.
   */
  private activeTargetIdsSafe(): readonly string[] {
    return this.session.activeTargetIds;
  }

  private viewerCountFor(targetId: string): number {
    return this.targetTier.get(targetId)?.attachments.size ?? 0;
  }

  async newTarget(
    url: string | undefined,
    background: boolean | undefined,
    newWindow: boolean | undefined,
  ): Promise<TargetSummary> {
    const opts: { url?: string; background?: boolean; newWindow?: boolean } = {};
    if (url !== undefined) opts.url = url;
    if (background !== undefined) opts.background = background;
    // A caller that cares always says so explicitly; one that does not is
    // deferred to the Instance's own launch-time choice
    // (`BrowserSpec.isolation`, see `ManagedSessionOptions.defaultNewWindow`)
    // rather than silently landing as a tab of whatever window the first
    // target happened to open in.
    opts.newWindow = newWindow ?? this.defaultNewWindow;
    // Goes through `core.Session.createTarget()` rather than
    // `this.registry.create(opts)` directly: closing every pane under
    // `isolation: 'window'` closes every OS window, headful Chrome exits
    // the moment its last window closes, and the CDP endpoint dies with
    // it (see that method's own doc for the measured evidence and why the
    // ladder itself cannot cover this). `createTarget()` transparently
    // relaunches the browser first when it detects the bridge is already
    // dead, single-flighted across however many `target.new` calls race
    // here, and its own `restartInstance()` call drives the same
    // `dispatchEffect('instance.restart.result')` path a manual restart
    // does, which is what keeps this class's own `this.registry` (used by
    // every other method below) pointed at the fresh pair by the time this
    // await resolves.
    const t = (await this.session.createTarget(opts)) as unknown as TargetRuntimeLike;
    return toTargetSummary(t, { activeTargetIds: this.activeTargetIdsSafe(), viewerCount: 0 });
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.registry.close(targetId as never);
  }

  /**
   * Applies a caller supplied tab order.
   *
   * `TargetRegistry.reorder(id, beforeId)` moves one target immediately
   * before another using the sparse float ordering key, so a whole ordering
   * is expressed by walking the requested list backwards: each target is
   * placed before the one that should follow it, and the last entry, having
   * nothing after it, is moved to the end first. Anything the caller did not
   * name keeps its own relative position ahead of the reordered run.
   *
   * Ids that are not live tabs are skipped rather than throwing: a viewer's
   * list can legitimately name a tab that closed a moment ago.
   */
  reorderTargets(targetIds: readonly string[]): void {
    const live = new Set(this.listTargets().map((t) => t.targetId));
    const wanted = targetIds.filter((id) => live.has(id));
    if (wanted.length === 0) return;

    let after: string | null = null;
    for (let i = wanted.length - 1; i >= 0; i -= 1) {
      const id = wanted[i] as string;
      try {
        this.registry.reorder(id as never, after as never);
      } catch {
        // A target that vanished between the liveness check and this call.
        continue;
      }
      after = id;
    }

    // Every viewer needs the new indices, not just whoever dragged the tab.
    for (const summary of this.listTargets()) {
      this.broadcast({
        t: 'target.updated',
        targetId: summary.targetId,
        changed: { index: summary.index },
      });
    }
  }

  async activateTarget(targetId: string): Promise<void> {
    await this.session.activateTarget(targetId);
    this.broadcastActiveFlags();
  }

  /**
   * Broadcasts the current per-window `active` flags to every viewer.
   *
   * Public so `Connection.doSubscribe` can call it immediately AFTER
   * sending its `stream.subscribed` reply. See `subscribe()`'s own comment
   * for why the ordering is load bearing rather than incidental.
   */
  announceActiveFlags(): void {
    this.broadcastActiveFlags();
  }

  /**
   * Tells every viewer which tab is now the live one, per OS window.
   *
   * `TargetSummary.active` changes for two tabs at once (the newly promoted
   * one and the demoted one), and nothing recomputes it on its own: a client
   * only learns about it through `target.updated`. Without this the LIVE and
   * POLLING badges were whatever they happened to be when the tab list was
   * last fetched.
   *
   * One call here can carry flag flips for at most two windows (the target
   * that changed and, in the same window, whichever target it demoted);
   * every other window's active target is unaffected and gets re-sent the
   * same `active: true`/`false` it already had. That is deliberately not
   * special-cased: `activeTargetIdsSafe()` is one array-includes check per
   * target, cheap enough that recomputing every summary is simpler than
   * tracking which windows actually changed.
   */
  private broadcastActiveFlags(): void {
    const activeTargetIds = this.activeTargetIdsSafe();
    for (const summary of this.listTargets()) {
      this.broadcast({
        t: 'target.updated',
        targetId: summary.targetId,
        // `windowId` rides along with `active` because the two are learned
        // at the same moment and are meaningless apart. A target's window
        // is resolved lazily, on its first `Browser.getWindowForTarget`,
        // which for most targets is the subscribe that also promotes it: a
        // `welcome` or `target.list` built before that carries
        // `windowId: null`, and a client that cached that summary would
        // keep the null forever, since nothing else ever re-sent it. That
        // is not a cosmetic gap. `active` only means anything relative to a
        // window ("the live target OF ITS OWN window"), so a client holding
        // several `active: true` targets and no window ids cannot tell
        // genuine per-window isolation from a bug.
        changed: { active: activeTargetIds.includes(summary.targetId), windowId: summary.windowId },
      });
    }
  }

  // ── streams ──────────────────────────────────────────────────────────

  private async ensureTierState(targetId: string): Promise<TargetTierState> {
    this.knownTargetIds.add(targetId);
    let state = this.targetTier.get(targetId);
    if (state) return state;
    const target = this.registry.get(targetId as never) as unknown as
      | { readonly viewport: { width: number; height: number } | null }
      | undefined;
    const ownerViewport =
      target?.viewport ?? (await this.queryRealViewport(targetId)) ?? DEFAULT_VIEWPORT;
    state = {
      tierAssigner: new TierAssigner(2, () => monotonicNow()),
      attachments: new Map(),
      ownerViewport,
      chain: Promise.resolve(),
      lastAdaptiveStepMono: monotonicNow(),
      qualityProfiles: new Map(),
      encodeMsSamples: [],
      statsPrev: new Map(),
    };
    this.targetTier.set(targetId, state);
    return state;
  }

  /**
   * Reads the real, rendered CSS viewport size for `targetId` via
   * `Page.getLayoutMetrics`, or `null` (never throws) if the target has no
   * live CDP session or the command fails. `TargetRegistry.get(targetId).viewport`
   * (`packages/core/src/cdp/target-registry.ts`) is never populated: that
   * module's own doc records the full per-target domain-enable lifecycle as
   * not implemented, so `viewport` is always `null` for
   * every real target this build produces. `ensureTierState`'s previous
   * fallback (`DEFAULT_VIEWPORT`, 1440 by 900) was a guess that a real
   * launched browser's actual viewport can, and on this machine does,
   * genuinely differ from: `ManagedSession.subscribe()`'s own `SubscribedFields.width`/`.height`
   * become the client's `fw`/`fh` for every subsequent input message
   * (`packages/core/src/input/dispatcher.ts`'s `viewportFor()` falls back to
   * exactly those two fields when `target.viewport` is `null`, which it
   * always is), so a wrong guess here means every click the client sends
   * back gets scaled against the wrong viewport and can land outside the
   * page's actual content box entirely, producing no repaint and so no new
   * screencast frame. That was traced as the real root cause of clicks
   * that silently did nothing.
   */
  private async queryRealViewport(
    targetId: string,
  ): Promise<{ width: number; height: number } | null> {
    try {
      const handle = await this.registry.attach(targetId as never);
      const metrics = (await this.bridge.send('Page.getLayoutMetrics', {}, handle.id as never)) as {
        cssLayoutViewport?: { clientWidth: number; clientHeight: number };
        layoutViewport?: { clientWidth: number; clientHeight: number };
      };
      const vp = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
        return { width: vp.clientWidth, height: vp.clientHeight };
      }
      return null;
    } catch {
      return null;
    }
  }

  async subscribe(
    viewerId: string,
    targetId: string,
    req: {
      readonly quality?: QualityProfile;
      readonly thumbnail?: boolean;
      readonly paused?: boolean;
    },
  ): Promise<SubscribedFields> {
    const sink = this.connections.get(viewerId);
    if (!sink) throw new Error(`viewer ${viewerId} is not attached to this session`);
    const streamId = await this.session.subscribe(viewerId, targetId);
    const handle = this.session.streamHandleFor(targetId);
    const state = await this.ensureTierState(targetId);

    const qualityProfile = req.quality ?? 'auto';
    const mapping = QUALITY_PROFILE_MAP[qualityProfile];
    const attachment = new Attachment({
      viewerId,
      streamId,
      transport: sink,
      synthetic: false,
      desiredLevel: mapping.seed,
      ...(req.thumbnail ? { maxBacklog: 1 } : {}),
    });
    state.attachments.set(viewerId, attachment);
    state.qualityProfiles.set(viewerId, qualityProfile);
    this.streamIndex.get(viewerId)?.set(streamId, targetId);

    // A brand new subscriber to a static page would otherwise see nothing
    // until the page next changes (screencast is change-driven): force one
    // frame now: every new attachment gets one.
    await handle?.forceFrame().catch(() => false);

    // Subscribing can change which tab is `active`: a target that is the
    // first one subscribed in its own OS window becomes that window's live
    // screencast target. Every viewer needs to hear about that, which is
    // what lets a tab strip show LIVE on the right pane from the moment it
    // appears.
    //
    // The announcement is NOT sent from here. It is the caller's job,
    // after it has sent its own `stream.subscribed` reply, through
    // `announceActiveFlags()`. Broadcasting inline put an unsolicited
    // `target.updated` on the socket ahead of the correlated reply to the
    // very request that caused it, so a client reading the next message as
    // its reply got the broadcast instead. That was survivable while only
    // the first subscribe on an Instance ever flipped a flag; under
    // per-window activation every subscribe in a fresh window flips one,
    // so it went from a rare race to the normal case and broke three
    // previously green suites at once.
    return {
      streamId,
      targetId,
      quality: qualityProfile,
      codec: 'jpeg',
      fps: 30,
      width: state.ownerViewport.width,
      height: state.ownerViewport.height,
      dpr: 1,
      paused: req.paused ?? false,
      sidEpoch: handle?.stream.sidEpoch ?? 0,
      gen: handle?.stream.gen ?? 1,
    };
  }

  unsubscribe(viewerId: string, streamId: number): void {
    const targetId = this.streamIndex.get(viewerId)?.get(streamId);
    if (!targetId) return;
    this.streamIndex.get(viewerId)?.delete(streamId);
    const state = this.targetTier.get(targetId);
    state?.attachments.delete(viewerId);
    state?.qualityProfiles.delete(viewerId);
    state?.statsPrev.delete(viewerId);
    this.session.unsubscribe(viewerId, streamId, targetId);
  }

  targetIdForStream(viewerId: string, streamId: number): string | undefined {
    return this.streamIndex.get(viewerId)?.get(streamId);
  }

  /** Every live stream subscription across every connected viewer, for `SessionApi.streams`. */
  listStreams(): readonly {
    readonly streamId: number;
    readonly targetId: string;
    readonly viewerId: string;
  }[] {
    const out: { streamId: number; targetId: string; viewerId: string }[] = [];
    for (const [viewerId, byStream] of this.streamIndex) {
      for (const [streamId, targetId] of byStream) {
        out.push({ streamId, targetId, viewerId });
      }
    }
    return out;
  }

  ack(viewerId: string, streamId: number, seq: number, decodeMs?: number): void {
    const targetId = this.targetIdForStream(viewerId, streamId);
    if (!targetId) return;
    this.targetTier.get(targetId)?.attachments.get(viewerId)?.onAck(seq, decodeMs);
  }

  // ── recording ────────────────────────────────────────────────────────

  /**
   * `recording.start`: mints a fresh `recordingId`, builds a
   * `DiskRecordingSink` under `recordingsDir`, and a `core.FrameRecorder`
   * against `targetId`'s live `Stream`, then registers the recorder's
   * `Attachment` into the exact same `state.attachments` map a live
   * viewer's own subscription uses -- a recording IS just another
   * `synthetic` attachment on the fan-out path (`frame-recorder.ts`'s own
   * module doc).
   *
   * Ensuring `targetId` has a live `Stream` to attach to reuses
   * `core.Session.subscribe()`, the exact machinery `subscribe()` above
   * already leans on, rather than duplicating it: a synthetic `agent`-kind
   * `core.Viewer` is registered for this recording (id `recorder:<recordingId>`,
   * matching `FrameRecorder`'s own `attachment.viewerId` exactly) so
   * `Session.subscribe()` can ensure `PerTargetState`/`Stream` exist and
   * the target's CDP screencast is armed. This is deliberate, not
   * incidental: `PerTargetState.viewerIds` counting this recorder is what
   * keeps the target's capture alive for as long as the recording runs,
   * even with zero human viewers -- the whole point
   * (`frame-recorder.ts`'s module doc: "a recording that stops the moment
   * the last human closes their tab is not a recording") -- and it means
   * `stopRecording()` can tear down through the ordinary
   * `unsubscribe()`/`removeViewer()` path with no new teardown logic.
   *
   * Throws `E_RECORDING_UNAVAILABLE` if this session was built with no
   * `recordingsDir` (no operator opted this deployment in), and
   * `E_CDP_TARGET_NOT_FOUND` if `targetId` has no live CDP session to
   * attach to.
   */
  async startRecording(
    targetId: string,
    opts: { readonly mode?: 'live' | 'thumbnail' } = {},
  ): Promise<RecordingSummaryResult> {
    if (this.recordingsDir === undefined) {
      throw new BglsError(
        'E_RECORDING_UNAVAILABLE',
        'This gateway has no recordings directory configured.',
      );
    }
    const recordingId = newId('rec');
    const recorderViewerId = `recorder:${recordingId}`;
    const mode = opts.mode ?? 'live';

    this.session.addViewer({
      id: recorderViewerId,
      tenantId: this.tenantId,
      appId: this.appId,
      subject: recorderViewerId,
      capabilities: [],
      kind: 'agent',
      isAdmin: false,
      connectedAtMs: Date.now(),
    });
    let streamId: number;
    try {
      streamId = await this.session.subscribe(recorderViewerId, targetId);
    } catch (err) {
      this.session.removeViewer(recorderViewerId);
      throw err;
    }
    const handle = this.session.streamHandleFor(targetId);
    if (!handle) {
      // `subscribe()` above would already have thrown for a target with no
      // live CDP session; reaching here with no handle would mean
      // `PerTargetState` was torn down between those two calls, which
      // nothing in this class's synchronous-until-the-`await`-above
      // sequencing permits. Guarded anyway rather than asserted, since
      // `streamHandleFor` is a public, independently callable method.
      this.session.unsubscribe(recorderViewerId, streamId, targetId);
      this.session.removeViewer(recorderViewerId);
      throw new BglsError(
        'E_CDP_TARGET_NOT_FOUND',
        `target ${targetId} has no live stream to record`,
      );
    }
    const state = await this.ensureTierState(targetId);

    const sink = new DiskRecordingSink({ root: this.recordingsDir, recordingId });
    const recorder = new FrameRecorder({
      recordingId,
      streamId,
      stream: handle.stream,
      targetId: targetId as never,
      mode,
      sink,
      onError: (err) => this.handleRecordingFailure(recordingId, err),
    });
    // Must land before this method's next `await`: nothing else may
    // observe `this.recordings` without this entry once a `FrameRecorder`
    // exists (`handleRecordingFailure` reads it back), and everything
    // between `new FrameRecorder(...)` and here runs synchronously, ahead
    // of the microtask its own constructor schedules for `writeMeta`.
    const startedAtMs = Date.now();
    this.recordings.set(recordingId, {
      recorder,
      sink,
      targetId,
      mode,
      startedAtMs,
      stoppedAtMs: undefined,
    });
    state.attachments.set(recorderViewerId, recorder.attachment);

    // A recording started against a static page would otherwise capture
    // nothing until the page next changes (screencast is change-driven);
    // mirrors `subscribe()`'s own identical fix immediately above.
    await handle.forceFrame().catch(() => false);

    return this.recordingSummary(recordingId);
  }

  /**
   * `recording.stop`: idempotent (a second `recording.stop` for an
   * already-stopped `recordingId` returns the same summary rather than
   * erroring). Removes the recorder's `Attachment` from the live
   * fan-out set (so `handleFrame` never offers it another frame), then
   * unwinds the synthetic viewer `startRecording` registered through the
   * ordinary `unsubscribe()`/`removeViewer()` path -- the same teardown a
   * real viewer's last subscription leaving a target already triggers,
   * with nothing recording-specific added to `core.Session` for it.
   * Finally asks the sink to write `complete.json`
   * (`DiskRecordingSink.finalize`, not part of `RecordingSink` itself).
   */
  async stopRecording(recordingId: string): Promise<RecordingSummaryResult> {
    const rec = this.recordings.get(recordingId);
    if (!rec) {
      throw new BglsError('E_RECORDING_NOT_FOUND', `no recording ${recordingId} on this session`);
    }
    if (rec.stoppedAtMs === undefined) {
      rec.stoppedAtMs = Date.now();
      const recorderViewerId = rec.recorder.attachment.viewerId;
      const state = this.targetTier.get(rec.targetId);
      state?.attachments.delete(recorderViewerId);
      state?.qualityProfiles.delete(recorderViewerId);
      state?.statsPrev.delete(recorderViewerId);
      this.session.unsubscribe(recorderViewerId, rec.recorder.attachment.streamId, rec.targetId);
      this.session.removeViewer(recorderViewerId);

      const lastError = rec.recorder.lastError;
      await rec.sink
        .finalize({
          stoppedAtMs: rec.stoppedAtMs,
          framesWritten: rec.recorder.framesWritten,
          framesDropped: rec.recorder.framesDropped,
          failed: rec.recorder.failed,
          ...(lastError
            ? { errorMessage: sanitizeMessage(redactServerPaths(lastError.message)) }
            : {}),
        })
        .catch((err: unknown) => {
          this.logger?.error(
            { component: 'server', recordingId, targetId: rec.targetId },
            `recording ${recordingId} finalize failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    return this.recordingSummary(recordingId);
  }

  /** `recording.list`, optionally scoped to one `targetId`. */
  listRecordings(targetId?: string): readonly RecordingSummaryResult[] {
    const out: RecordingSummaryResult[] = [];
    for (const recordingId of this.recordings.keys()) {
      const rec = this.recordings.get(recordingId);
      if (!rec) continue;
      if (targetId !== undefined && rec.targetId !== targetId) continue;
      out.push(this.recordingSummary(recordingId));
    }
    return out;
  }

  private recordingSummary(recordingId: string): RecordingSummaryResult {
    const rec = this.recordings.get(recordingId);
    if (!rec) {
      throw new BglsError('E_RECORDING_NOT_FOUND', `no recording ${recordingId} on this session`);
    }
    return {
      recordingId,
      targetId: rec.targetId,
      mode: rec.mode,
      startedAtMs: rec.startedAtMs,
      ...(rec.stoppedAtMs !== undefined ? { stoppedAtMs: rec.stoppedAtMs } : {}),
      framesWritten: rec.recorder.framesWritten,
      framesDropped: rec.recorder.framesDropped,
      failed: rec.recorder.failed,
    };
  }

  /**
   * `FrameRecorder.onError`'s callback: fires at most once per recording
   * (that guarantee is `FrameRecorder`'s own, see `frame-recorder.ts`'s
   * "Degradation on failure"). Logs the failure (never the recorded
   * bytes, never page content: `err.message` here is always a
   * `RecordingSink` I/O failure, e.g. a disk write error) and, if any
   * viewer is still watching with the authority to have started this
   * recording, tells them too via `recording.failed` -- a recording must
   * never fail silently, only the live path is allowed to degrade quietly
   * (see this module's own header doc).
   */
  private handleRecordingFailure(recordingId: string, err: Error): void {
    const rec = this.recordings.get(recordingId);
    const message = sanitizeMessage(err.message);
    this.logger?.error(
      { component: 'server', recordingId, targetId: rec?.targetId },
      `recording ${recordingId} failed: ${message}`,
    );
    if (!rec) return;
    this.deliverRecording({ t: 'recording.failed', recordingId, targetId: rec.targetId, message });
  }

  /**
   * Sends one `recording.*` envelope to every currently connected viewer
   * holding BOTH `capture` and `download`, the same pair
   * `wire/capability-check.ts` requires to call `recording.start` in the
   * first place, mirroring {@link deliverDownload}'s own live capability
   * check.
   */
  private deliverRecording(env: Record<string, unknown> & { readonly t: string }): void {
    for (const [viewerId, caps] of this.viewerCapabilities) {
      if (!caps.has('capture') || !caps.has('download')) continue;
      const sink = this.connections.get(viewerId);
      if (sink?.isOpen()) sink.sendEnvelope(env);
    }
  }

  /**
   * `stream.quality`: reconfigures an existing subscription's quality
   * profile and/or encode-side bounding box, per `StreamQuality`'s own wire
   * doc comment (`packages/protocol/src/wire/messages/streams.ts`):
   * "Answered with a re-emitted `stream.subscribed` carrying a bumped
   * `sidEpoch`." Returns the fields for that re-emit, or `undefined` (never
   * throws) if `streamId` names no live attachment. Previously this method
   * (`setQuality`) only ever touched `att.adaptive.desiredLevel` and bailed
   * out entirely whenever `quality` was omitted, silently ignoring
   * `maxWidth`/`maxHeight`-only requests and never bumping `sidEpoch`,
   * re-emitting `stream.subscribed`, or forcing a fresh keyframe at the new
   * geometry: `packages/conformance/test/e2e/load-bearing.test.ts`'s `#39`
   * traced this gap directly.
   */
  async reconfigureStream(
    viewerId: string,
    streamId: number,
    req: {
      readonly quality?: QualityProfile;
      readonly maxWidth?: number;
      readonly maxHeight?: number;
    },
  ): Promise<SubscribedFields | undefined> {
    const targetId = this.targetIdForStream(viewerId, streamId);
    if (!targetId) return undefined;
    const state = this.targetTier.get(targetId);
    const att = state?.attachments.get(viewerId);
    const handle = this.session.streamHandleFor(targetId);
    if (!state || !att || !handle) return undefined;

    if (req.quality) {
      const mapping = QUALITY_PROFILE_MAP[req.quality];
      att.adaptive.desiredLevel = clampToProfile(mapping.seed, mapping);
      att.adaptive.lastLevelChangeAt = Number.NEGATIVE_INFINITY;
      state.qualityProfiles.set(viewerId, req.quality);
    }
    if (req.maxWidth !== undefined || req.maxHeight !== undefined) {
      state.ownerViewport = {
        width: req.maxWidth ?? state.ownerViewport.width,
        height: req.maxHeight ?? state.ownerViewport.height,
      };
    }

    handle.stream.bumpSidEpoch(Date.now());
    await handle.forceFrame().catch(() => false);

    return {
      streamId,
      targetId,
      quality: req.quality ?? 'auto',
      codec: 'jpeg',
      fps: 30,
      width: state.ownerViewport.width,
      height: state.ownerViewport.height,
      dpr: 1,
      paused: false,
      sidEpoch: handle.stream.sidEpoch,
      gen: handle.stream.gen,
    };
  }

  async requestKeyframe(viewerId: string, streamId: number): Promise<boolean> {
    const targetId = this.targetIdForStream(viewerId, streamId);
    if (!targetId) return false;
    const handle = this.session.streamHandleFor(targetId);
    if (!handle) return false;
    return handle.forceFrame();
  }

  // ── diagnostics ──────────────────────────────────────────────────────

  /** The union of every subscribed viewer's requested feeds for one target: what `core.Session`'s single, shared, per-target collector actually needs running. */
  private unionFeeds(byViewer: ReadonlyMap<string, DiagnosticsFeeds>): DiagnosticsFeeds {
    let console = false;
    let errors = false;
    let network = false;
    for (const feeds of byViewer.values()) {
      console ||= feeds.console;
      errors ||= feeds.errors;
      network ||= feeds.network;
    }
    return { console, errors, network };
  }

  /**
   * `diagnostics.subscribe`: records `viewerId`'s own feed request for
   * `targetId`, widens (or starts) the shared per-target collector to the
   * union of every subscriber's request, and returns what is actually
   * running, for the caller's `diagnostics.subscribed` reply. Defaults match
   * `DiagnosticsSubscribe`'s own wire doc: console and errors on, network off, unless the request says
   * otherwise.
   *
   * THE STEALTH GATE. `console`/`errors` need `Runtime.enable`
   * (`core`'s `TargetDiagnostics.applyFeeds`), which is the exact CDP
   * domain-enable pattern this build's stealth posture exists to avoid
   * (`packages/core/src/cdp/hit-test.ts`'s module doc measures it directly
   * against real Chrome). So when {@link stealthActive} is true and THIS
   * viewer's own request wants `console` and/or `errors`, it is refused
   * with `E_DIAGNOSTICS_STEALTH_CONFLICT` unless `req.acknowledgeStealthRisk`
   * is exactly `true`.
   *
   * Checked against THIS request alone, deliberately, never against
   * whether `Runtime` happens to be on already from an earlier viewer's own
   * acknowledged subscription: a second viewer asking to receive console
   * output needs its own conscious opt in, not a free ride on the first
   * viewer's. `network` alone never needs the flag at any point: it is
   * served entirely by the independent `Network` domain
   * (`applyFeeds`'s `needNetwork`/`needRuntime` are never combined), which
   * is this feature's own proof that network diagnostics can be had
   * without touching `Runtime` at all.
   *
   * Refusing, rather than silently downgrading `console`/`errors` to off,
   * is deliberate too: a caller that asked for console output and silently
   * got none back (with the reply still claiming success) would debug
   * against a browser that never told it anything went wrong, which is a
   * worse failure than an explicit, loud refusal naming the conflict.
   */
  async subscribeDiagnostics(
    viewerId: string,
    targetId: string,
    req: {
      readonly console?: boolean;
      readonly errors?: boolean;
      readonly network?: boolean;
      readonly acknowledgeStealthRisk?: boolean;
    },
  ): Promise<DiagnosticsStatus> {
    this.knownTargetIds.add(targetId);
    const requested: DiagnosticsFeeds = {
      console: req.console ?? true,
      errors: req.errors ?? true,
      network: req.network ?? false,
    };
    const needsRuntime = requested.console || requested.errors;
    if (this.stealthActive && needsRuntime && req.acknowledgeStealthRisk !== true) {
      throw new BglsError(
        'E_DIAGNOSTICS_STEALTH_CONFLICT',
        `instance ${this.instanceId} was launched with a stealth level active; diagnostics.subscribe({ console: ${requested.console}, errors: ${requested.errors} }) on target ${targetId} needs Runtime.enable, which reintroduces the CDP automation fingerprint that level exists to avoid. Pass acknowledgeStealthRisk: true to proceed, or subscribe with network only.`,
        { context: { targetId, console: requested.console, errors: requested.errors } },
      );
    }
    let byViewer = this.diagnosticsSubscribers.get(targetId);
    if (!byViewer) {
      byViewer = new Map();
      this.diagnosticsSubscribers.set(targetId, byViewer);
    }
    byViewer.set(viewerId, requested);
    const feeds = await this.session.setDiagnostics(targetId, this.unionFeeds(byViewer));
    // Logged, not broadcast: this is the audit trail an operator reads
    // after the fact ("who un-stealthed this browser and when"), not a
    // live warning to every other viewer (there is no generic wire-level
    // notice channel to carry one). The wire side of "loud" is the refusal above, which
    // cannot be missed, and `fingerprintActive` below, which every
    // `diagnostics.subscribe`/`diagnostics.status.get` caller can check.
    if (this.stealthActive && needsRuntime) {
      this.logger?.warn(
        { component: 'server', instanceId: this.instanceId, targetId, viewerId },
        `diagnostics.subscribe acknowledged the stealth conflict and enabled Runtime on target ${targetId}: the CDP automation fingerprint is now present on a stealth-launched instance`,
      );
    }
    return { ...feeds, fingerprintActive: this.session.fingerprintActive(targetId) };
  }

  /**
   * `diagnostics.status.get`: the read-only, side-effect-free counterpart to
   * {@link subscribeDiagnostics}. Answers "is this target quiet or loud"
   * (whether `Runtime` is enabled on it right now) without turning anything
   * on, so a caller can decide whether subscribing is worth the fingerprint
   * cost BEFORE paying it. `feeds` reflects whatever `console`/`errors`/
   * `network` this connection's own viewer is subscribed to, defaulting to
   * every-`false` when it has never called `subscribeDiagnostics` for this
   * target, mirroring `unionFeeds`'s own empty-map behaviour; `fingerprintActive`
   * is never scoped to one viewer, since `Runtime` either is or is not
   * enabled on the target's session regardless of who asked.
   */
  diagnosticsStatus(targetId: string): DiagnosticsStatus {
    const requested = this.diagnosticsSubscribers.get(targetId);
    return {
      ...(requested
        ? this.unionFeeds(requested)
        : { console: false, errors: false, network: false }),
      fingerprintActive: this.session.fingerprintActive(targetId),
    };
  }

  // ==================================================================
  // The outbound request gate (`request.gate.*`).
  //
  // ONE gate per target, owned by ONE viewer, unlike diagnostics above
  // which unions several subscribers' feeds into one collector. Feeds are
  // additive and a union of them is still a correct answer for everyone;
  // verdicts are not. Two callers with different opinions about the same
  // request cannot both be right, and inventing a precedence rule between
  // them (first wins? deny wins?) would be a policy nobody asked for and
  // nobody could see. So registering a gate on a target that already has
  // one is refused, loudly, rather than silently becoming a coalition.
  // ==================================================================

  /** By `targetId`: which viewer registered the gate, and its rule set. */
  private readonly gateOwners = new Map<string, { viewerId: string; rules: readonly GateRule[] }>();
  /** By `gateId`: resolve the promise the core gate is awaiting. */
  private readonly pendingVerdicts = new Map<string, (v: GateVerdict) => void>();
  private gateSeq = 0;

  /** Whether `targetId` already has a gate owned by someone other than `viewerId`. */
  gateOwnedByOther(targetId: string, viewerId: string): string | null {
    const owner = this.gateOwners.get(targetId);
    return owner !== undefined && owner.viewerId !== viewerId ? owner.viewerId : null;
  }

  /**
   * `request.gate.enable`: installs or replaces `viewerId`'s rule set for
   * `targetId` and arms the core gate.
   *
   * The handler below runs per request, inside `core`'s `RequestGate`. It
   * decides server side whenever a matching rule names `allow` or `deny`
   * outright, and only pauses for `verdict: 'ask'`. That asymmetry is the
   * throughput story: a caller that gates one URL pattern and allows the
   * rest pays one local comparison per request, not a round trip.
   */
  async enableRequestGate(
    viewerId: string,
    targetId: string,
    rules: readonly GateRule[],
  ): Promise<number> {
    this.gateOwners.set(targetId, { viewerId, rules });
    await this.session.setRequestGate(targetId, async (req) => {
      const owner = this.gateOwners.get(targetId);
      // The gate outliving its owner is not hypothetical: a viewer can
      // disconnect between a request being paused and the verdict being
      // asked for. Deny rather than allow, matching every other fail path
      // here: a gate whose owner is gone is not a gate that said yes.
      if (owner === undefined) return 'deny';
      const rule = matchGateRule(owner.rules, req.url, req.method, req.resourceType);
      if (rule === undefined) return 'allow';
      if (rule.verdict !== 'ask') return rule.verdict;

      const sink = this.connections.get(owner.viewerId);
      if (sink === undefined || !sink.isOpen()) return rule.onTimeout ?? 'deny';

      this.gateSeq += 1;
      const gateId = `gate_${this.gateSeq}`;
      const holdMs = Math.min(rule.holdMs ?? DEFAULT_GATE_HOLD_MS, MAX_GATE_HOLD_MS);
      const verdict = await new Promise<GateVerdict>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingVerdicts.delete(gateId);
          resolve(rule.onTimeout ?? 'deny');
        }, holdMs);
        timer.unref?.();
        this.pendingVerdicts.set(gateId, (v) => {
          clearTimeout(timer);
          this.pendingVerdicts.delete(gateId);
          resolve(v);
        });
        // Sent to the registering viewer ALONE, never broadcast. A paused
        // request's URL and headers are that caller's business: another
        // viewer on the same session has no standing to read them, and a
        // broadcast here would turn a gate into a traffic log for
        // everyone attached.
        sink.sendEnvelope({
          t: 'request.gate.paused',
          targetId,
          gateId,
          url: req.url,
          method: req.method,
          resourceType: req.resourceType,
          headers: req.headers,
          deadlineAt: Date.now() + holdMs,
          // Only when the matching rule asked for it, which additionally
          // required the `evaluate` capability at the wire layer. A POST
          // body carries whatever the user typed.
          ...(rule.includeRequestBody === true && req.postData !== undefined
            ? { postData: req.postData }
            : {}),
        });
      });
      return verdict;
    });
    return rules.length;
  }

  /** `request.gate.disable`: disarms `targetId`'s gate and fails every request still held. */
  async disableRequestGate(targetId: string): Promise<void> {
    this.gateOwners.delete(targetId);
    // Answered before the gate goes away, so a request paused right now is
    // resolved rather than left hanging until its own deadline. Denied,
    // not allowed: the caller asked to stop gating, which is not the same
    // as asking to let this particular request through.
    for (const [, resolve] of this.pendingVerdicts) resolve('deny');
    this.pendingVerdicts.clear();
    await this.session.setRequestGate(targetId, null);
  }

  /** `request.gate.resolve`: answers one held request. Unknown or already-answered ids are ignored, not errors: a verdict racing its own deadline is ordinary. */
  resolveRequestGate(
    viewerId: string,
    targetId: string,
    gateId: string,
    verdict: GateVerdict,
  ): void {
    const owner = this.gateOwners.get(targetId);
    if (owner === undefined || owner.viewerId !== viewerId) return;
    this.pendingVerdicts.get(gateId)?.(verdict);
  }

  /** Drops any gate `viewerId` owned. Called when a viewer detaches, so a gate never outlives the connection that registered it. */
  releaseGatesOwnedBy(viewerId: string): void {
    for (const [targetId, owner] of [...this.gateOwners]) {
      if (owner.viewerId !== viewerId) continue;
      void this.disableRequestGate(targetId);
    }
  }

  /**
   * `diagnostics.unsubscribe`: drops `viewerId`'s own feed request for
   * `targetId`, narrowing the shared collector to whatever the remaining
   * subscribers still need, or stopping it outright once nobody is left.
   * The same "last one out tears it down" shape `Session.unsubscribe`'s own
   * `teardownTarget` call already uses for streams. A no-op, not an error,
   * when `viewerId` was never subscribed to `targetId` (mirrors
   * `stream.unsubscribe`'s own tolerance of a stale/unknown handle).
   */
  unsubscribeDiagnostics(viewerId: string, targetId: string): void {
    const byViewer = this.diagnosticsSubscribers.get(targetId);
    if (!byViewer?.delete(viewerId)) return;
    if (byViewer.size === 0) {
      this.diagnosticsSubscribers.delete(targetId);
      void this.session.stopDiagnostics(targetId);
      return;
    }
    void this.session.setDiagnostics(targetId, this.unionFeeds(byViewer));
  }

  /**
   * Sends one diagnostics envelope to every viewer that both holds
   * `devtools` and has an active `diagnostics.subscribe` for `targetId`.
   * Gate one is `diagnosticsSubscribers`, gate two is `viewerCapabilities`;
   * a viewer failing either must never see page console output or network
   * activity, so both are checked here rather than trusted from whichever
   * moment the subscription or the capability grant was last touched.
   */
  private deliverDiagnostics(
    targetId: string,
    env: Record<string, unknown> & { readonly t: string },
  ): void {
    const subscribers = this.diagnosticsSubscribers.get(targetId);
    if (!subscribers || subscribers.size === 0) return;
    // Recorded only for a `network.request` envelope, and only for a
    // viewer this loop actually sends it to below: `getResponseBody`'s own
    // scoping bound is "was THIS viewer ACTUALLY SHOWN this requestId", not
    // "did a matching CDP event merely occur", so a viewer that lost
    // `devtools` on a reauth narrowing, or whose socket is not open, must
    // not have this id recorded on its behalf either.
    const requestId = env['t'] === 'network.request' ? env['requestId'] : undefined;
    for (const viewerId of subscribers.keys()) {
      if (!this.viewerCapabilities.get(viewerId)?.has('devtools')) continue;
      const sink = this.connections.get(viewerId);
      if (!sink?.isOpen()) continue;
      sink.sendEnvelope(env);
      if (typeof requestId === 'string')
        this.recordSeenNetworkRequestId(viewerId, targetId, requestId);
    }
  }

  /** Records that `viewerId` was actually delivered `requestId` as a `network.request` envelope for `targetId`. See `seenNetworkRequestIds`'s own doc for the bound this backs and the FIFO eviction below. */
  private recordSeenNetworkRequestId(viewerId: string, targetId: string, requestId: string): void {
    let byTarget = this.seenNetworkRequestIds.get(viewerId);
    if (!byTarget) {
      byTarget = new Map();
      this.seenNetworkRequestIds.set(viewerId, byTarget);
    }
    let ids = byTarget.get(targetId);
    if (!ids) {
      ids = new Set();
      byTarget.set(targetId, ids);
    }
    ids.add(requestId);
    if (ids.size > MAX_SEEN_NETWORK_REQUEST_IDS_PER_TARGET) {
      // `Set` iterates insertion order, so its first entry is the oldest.
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
  }

  /** Whether `viewerId` was actually shown `requestId` on `targetId`'s own `network.request` feed. See `seenNetworkRequestIds`'s own doc. */
  private hasSeenNetworkRequestId(viewerId: string, targetId: string, requestId: string): boolean {
    return this.seenNetworkRequestIds.get(viewerId)?.get(targetId)?.has(requestId) ?? false;
  }

  // ==================================================================
  // Downloads (`download.*`).
  //
  // Unlike diagnostics, there is no `download.subscribe` wire message: a
  // download is something the PAGE does, not something a viewer opts a
  // target into, so the wire protocol gives a caller no moment to say "I
  // want this target's downloads" the way `diagnostics.subscribe` does.
  // The nearest equivalent this build has is capability possession itself:
  // `Session.startDownloadCapture` is armed for a target the first time
  // this session has BOTH a configured `downloadDir`/`downloadStore` (the
  // feature is wired at all, `session/factory.ts`) AND at least one
  // currently connected viewer holding the `download` capability, and
  // disarmed again once the last such viewer leaves. `deliverDownload`
  // below is the second, matching gate on the way OUT: even while capture
  // is armed, only a `download`-holding viewer ever receives a `download.*`
  // envelope, mirroring `deliverDiagnostics`'s own `devtools` check.
  // ==================================================================

  private hasDownloadViewer(): boolean {
    for (const caps of this.viewerCapabilities.values()) {
      if (caps.has('download')) return true;
    }
    return false;
  }

  /**
   * Arms download capture for `targetId` if this session is both
   * configured for it and currently has a `download`-holding viewer.
   * Idempotent via {@link downloadCaptureTargets}. Called from
   * `wireTargetLifecycle`'s `created` listener for a target that appears
   * AFTER a download-capable viewer is already attached, and from
   * {@link syncDownloadCapture} (over `this.listTargets()`, the CURRENT
   * live tab set, so a target present before any viewer ever attached is
   * covered exactly as well as one created afterwards) when a viewer's
   * capabilities widen to include `download`.
   */
  private ensureDownloadCapture(targetId: string): void {
    if (this.downloadStore === undefined || this.downloadDir === undefined) return;
    if (this.downloadCaptureTargets.has(targetId)) return;
    if (!this.hasDownloadViewer()) return;
    this.downloadCaptureTargets.add(targetId);
    const downloadDir = this.downloadDir;
    void this.session.startDownloadCapture(targetId, downloadDir).catch((err: unknown) => {
      this.downloadCaptureTargets.delete(targetId);
      this.logger?.warn(
        { component: 'server', targetId, error: err instanceof Error ? err.message : String(err) },
        'failed to arm download capture',
      );
    });
  }

  /** Disarms download capture on every target this session armed it for. Called once nobody connected holds `download` any more. */
  private stopAllDownloadCapture(): void {
    for (const targetId of [...this.downloadCaptureTargets]) {
      this.downloadCaptureTargets.delete(targetId);
      void this.session.stopDownloadCapture(targetId).catch(() => undefined);
    }
  }

  /**
   * Re-evaluates download capture against the CURRENT capability roster:
   * arms every known target when a `download`-holding viewer is present
   * (widening, the same "gained `devtools` on reauth" case
   * `setViewerCapabilities`'s own doc names for diagnostics), disarms
   * everything the instant none is left. Called from `attachViewer`,
   * `resumeViewer`, `setViewerCapabilities`, `applyCapabilityShrink`, and
   * `detachViewer`: every place `viewerCapabilities` can change shape.
   */
  private syncDownloadCapture(): void {
    if (this.hasDownloadViewer()) {
      // `this.listTargets()` (`TargetRegistry.tabs()`), not a locally
      // tracked "targets ever seen" set: it is already the live, current
      // answer to "which tab targets exist right now", including ones
      // that existed before this `ManagedSession` (or this method) was
      // ever called, so there is no separate bookkeeping to keep in sync
      // with it and no gap for a pre-existing tab.
      for (const summary of this.listTargets()) this.ensureDownloadCapture(summary.targetId);
    } else {
      this.stopAllDownloadCapture();
    }
  }

  /**
   * Sends one `download.*` envelope to every currently connected viewer
   * holding the `download` capability, mirroring {@link deliverDiagnostics}'s
   * own live capability check (never trusted from an earlier moment,
   * always read off `viewerCapabilities` right now).
   */
  private deliverDownload(env: Record<string, unknown> & { readonly t: string }): void {
    for (const [viewerId, caps] of this.viewerCapabilities) {
      if (!caps.has('download')) continue;
      const sink = this.connections.get(viewerId);
      if (sink?.isOpen()) sink.sendEnvelope(env);
    }
  }

  /** The current sole (exclusive mode) or first (shared mode) control lease holder of `targetId`, or `''` when nobody holds it. The best-effort answer to "who is driving" a download's `DownloadEvent.viewerId` needs, since nothing in this protocol names a viewer as the one who STARTED a given download (a download is the PAGE's own act, not a wire command with a requester); see `dispatchEffect`'s `download.completed` case for the full caveat. */
  private currentDriverViewerId(targetId: string): string {
    const snapshot = this.session.leaseEngineFor(targetId).getSnapshot();
    return snapshot.holders[0]?.viewerId ?? '';
  }

  /**
   * `download.completed`: hashes and re-verifies the finished file
   * (`DownloadStore.finalize`), fires the `onDownload` hook, and either
   * mints a signed URL (`download.ready`) or discards the bytes and
   * reports `download.failed`. The central rule:
   * `onDownload` is a VETOING hook that FAILS CLOSED
   * (`hooks/types.ts`'s `HOOK_TIMEOUTS.onDownload`), and the file is
   * complete and hashable at exactly this point, which is why this is
   * the veto point rather than `download.started` (no `sha256`/`bytes`
   * yet, `DownloadEvent` requires both) or the REST fetch route (too
   * late: the bytes would already have left this process).
   */
  private async finalizeDownload(
    targetId: string,
    entry: {
      readonly downloadId: string;
      readonly suggestedName: string;
      readonly path: string;
      readonly sizeBytes: number;
    },
  ): Promise<void> {
    const started = this.downloadStarted.get(entry.downloadId);
    this.downloadStarted.delete(entry.downloadId);
    if (this.downloadStore === undefined) {
      this.deliverDownload({
        t: 'download.failed',
        downloadId: entry.downloadId,
        reason: 'downloads_unavailable',
      });
      return;
    }

    let finalized: FinalizedDownload;
    try {
      finalized = await this.downloadStore.finalize(entry.downloadId, entry.path);
    } catch (err) {
      this.logger?.error(
        {
          component: 'server',
          targetId,
          downloadId: entry.downloadId,
          error: err instanceof Error ? err.message : String(err),
        },
        'failed to finalize a completed download',
      );
      this.deliverDownload({
        t: 'download.failed',
        downloadId: entry.downloadId,
        reason: err instanceof DownloadStoreError ? err.code : 'finalize_failed',
      });
      return;
    }

    const safeName = safeFileName(entry.suggestedName);
    const mime = guessMimeType(safeName);

    if (this.hooks) {
      const event: DownloadEvent = {
        at: Date.now(),
        tenantId: this.tenantId,
        appId: this.appId,
        requestId: newId('evt'),
        sessionId: this.sessionId,
        targetId,
        viewerId: this.currentDriverViewerId(targetId),
        downloadId: entry.downloadId,
        suggestedName: safeName,
        bytes: finalized.sizeBytes,
        mimeType: mime,
        sha256: finalized.sha256,
        sourceUrl: started ? sanitizeUrl(started.url) : '',
      };
      const decision = await this.hooks.dispatch('onDownload', event);
      if (decision.vetoed) {
        await this.downloadStore.discard(entry.downloadId);
        this.deliverDownload({
          t: 'download.failed',
          downloadId: entry.downloadId,
          reason: decision.reason ?? 'Refused by onDownload.',
        });
        return;
      }
    }

    const issued = this.downloadStore.issueUrl(
      entry.downloadId,
      safeName,
      mime,
      finalized.sizeBytes,
    );
    this.deliverDownload({
      t: 'download.ready',
      downloadId: entry.downloadId,
      sizeBytes: finalized.sizeBytes,
      sha256: finalized.sha256,
      url: issued.url,
      expiresAt: issued.expiresAt,
    });
  }

  // ── input, control, nav (thin passthroughs) ─────────────────────────

  dispatchInput(viewerId: string, raw: unknown): void {
    this.session.dispatchInput(viewerId, raw);
    this.promoteOnInput(raw);
    // Driving a browser is the least ambiguous evidence there is that it is
    // in use. Without this the router's idle sweep only ever saw the
    // timestamp written when a viewer first attached, so an instance being
    // driven continuously was force released on the same schedule as one
    // nobody had touched since it launched.
    this.onActivity?.();
  }

  /**
   * Makes the tab a viewer is actually driving the live screencast target
   * of its own OS window, and nothing outside that window.
   *
   * A real OS window composites only its active tab, so exactly one
   * subscribed target per window streams continuous video and the rest are
   * served by periodic screenshots. Which one that is only ever
   * changed on an explicit `target.activate`, so clicking straight into a
   * polling pane drove the tab correctly but left it updating at roughly
   * one frame a second, with no way to make it live short of finding its
   * entry in a tab strip. Driving a tab is the clearest possible statement
   * of which tab the viewer is looking at, so it promotes.
   *
   * This used to compare `targetId` against `session.activeTargetId`, the
   * single instance-wide active target `TargetActivationPolicy` tracked
   * before window isolation. Every input event whose target was not THAT
   * one id, including a target living in an entirely different OS window,
   * called `activateTarget` on it, which is precisely the mechanism
   * a live trace caught stealing a second viewer's pane the
   * moment they touched their own tab: one active target meant one steal
   * target for the whole Instance. Each OS window now keeps its own active
   * target (`TargetActivationPolicy.activeTargetIds`, one entry per
   * window), so the no-op check here is membership in that set rather than
   * equality against a single id: a target that is already the active
   * target of its own window is left alone no matter what is active in any
   * other window, and driving it never touches another window's tab.
   *
   * `TargetActivationPolicy.activate()` also returns immediately when the
   * target is already active, so the common case (every subsequent event
   * of a drag, a burst of keystrokes) costs one array scan capped at the
   * window count, not the target count.
   *
   * ── What shared control changes, and what it deliberately does not ──
   *
   * Case 1, several viewers driving the SAME target. Nothing here needs to
   * change and nothing here should. Every one of them promotes the same
   * targetId, the first promotion makes it its window's active target, and
   * every subsequent call from every driver takes the
   * `activeTargetIds.includes` early return. Promotion is a statement about
   * WHICH TAB is being looked at, not about who is allowed to drive it, so
   * N drivers agreeing on one tab is the easy case.
   *
   * Case 2, two viewers driving two different targets in the SAME OS window.
   * This is the case that needed a decision, and the decision is that the
   * server does NOT arbitrate it. A real OS window composites exactly one
   * tab, so two live tabs in one window is not something the server can
   * grant however cleverly it schedules; last input wins is the only honest
   * answer, and it is also the one a person expects (the tab you just
   * touched is the tab that goes live). What the server must not do is spend
   * CDP round trips discovering that repeatedly, which is what the damper
   * below is for.
   *
   * Without damping, two viewers dragging simultaneously in two panes of one
   * window each de-activate the other's tab on every pointer event. At
   * roughly 100 events a second each that is ~200 `Page.bringToFront` calls
   * a second, plus a `target.updated` broadcast to every connected viewer
   * per call (`activateTarget` calls `broadcastActiveFlags`). That is the
   * same shape of failure as the ack limiter finding recorded in
   * `wire/rate-limit.ts`: nothing errors, the socket just fills with
   * self-inflicted traffic and the streams behind it stall. The damper caps
   * RE-promotion of one target at {@link PROMOTE_REPEAT_DAMP_MS}, which
   * leaves the contest resolving at about four times a second instead of two
   * hundred, and leaves the winner exactly as it was: whoever sent the most
   * recent input once the damper lapses.
   *
   * The damper is keyed by targetId and only ever suppresses re-promoting a
   * target that was ALREADY promoted very recently, so it cannot slow a
   * first promotion down: clicking into a polling pane still goes live on
   * the first event, which is the behaviour this method exists for. The one
   * case it does cost something is a single viewer deliberately switching
   * A -> B -> A inside 250ms in one window, where the final A is dropped;
   * the next input event after the damper lapses restores it, and nothing in
   * that sequence is a plausible deliberate action at that speed.
   *
   * Per window activation (`TargetActivationPolicy.activeTargetIds`, one
   * entry per OS window) is untouched by all of this. Two viewers driving
   * two targets in DIFFERENT windows never contend at all: neither one is
   * ever missing from `activeTargetIds`, so neither ever reaches the damper,
   * let alone `activateTarget`.
   */
  private promoteOnInput(raw: unknown): void {
    const targetId = (raw as { targetId?: unknown } | null)?.targetId;
    if (typeof targetId !== 'string' || targetId === '') return;
    if (this.session.activeTargetIds.includes(targetId)) return;
    const nowMono = monotonicNow();
    const lastPromotedMono = this.lastPromotionMono.get(targetId);
    if (lastPromotedMono !== undefined && nowMono - lastPromotedMono < PROMOTE_REPEAT_DAMP_MS) {
      return;
    }
    this.lastPromotionMono.set(targetId, nowMono);
    void this.activateTarget(targetId).catch(() => undefined);
  }

  /** `opts.requestId`, when given, is the wire `control.request`'s own `id`, echoed as `re` on whichever direct effect answers it; see `Session.requestControl()`'s doc. */
  requestControl(
    identity: SessionViewerIdentity,
    targetId: string,
    opts: {
      readonly reason?: string;
      readonly priority?: number;
      readonly force?: boolean;
      readonly queue?: boolean;
      readonly requestId?: string;
    },
  ): void {
    this.knownTargetIds.add(targetId);
    this.session.requestControl(identity, targetId, opts);
  }

  async renewControl(
    viewerId: string,
    targetId: string,
    leaseId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'not_held' | 'lease_stale' }> {
    return this.session.leaseEngineFor(targetId).renew(viewerId, leaseId);
  }

  async releaseControl(
    viewerId: string,
    targetId: string,
    leaseId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'not_held' }> {
    return this.session.leaseEngineFor(targetId).release(viewerId, leaseId);
  }

  async revokeControl(
    admin: SessionViewerIdentity,
    targetId: string,
    holderViewerId: string,
    reason?: string,
  ): Promise<{ ok: true } | { ok: false; error: 'not_held' | 'cap_missing' }> {
    return this.session.leaseEngineFor(targetId).revoke(
      {
        viewerId: admin.viewerId,
        identity: admin.identity,
        label: admin.label,
        kind: admin.kind,
        isAdmin: admin.isAdmin,
      },
      holderViewerId,
      reason,
    );
  }

  /**
   * The instance's real rendered viewport, for `welcome.instance.viewport`.
   *
   * That field was a hardcoded `1440x900` regardless of the browser behind
   * it, and it is not decorative. `AutomationClient` stamps it onto every
   * input envelope as `fw`/`fh` (its own doc says so: it sends the
   * "instance's real viewport dimensions" precisely so the server's
   * `frame space -> multiply by viewport.width/fw -> CSS px` transform comes
   * out as the identity, which lets its public API take plain CSS pixels).
   * The client was written correctly against that contract. The server was
   * the one lying.
   *
   * Measured in the agent-and-human e2e test against a real 762x427 page:
   * the agent aimed at the middle of a text box, computed 720 because it
   * believed the page was 1440 wide, and the press landed at 720 on a page
   * whose actual centre is 381, hitting the block below and blurring the
   * box. `inspectAt` never resolved a hit in sixty seconds of polling for
   * the same reason. A subscribed viewer is unaffected: its `fw` is its own
   * stream width, which really is the page width, so the identity transform
   * happens to be right for it.
   *
   * Read through `queryRealViewport` (`Page.getLayoutMetrics`), the same
   * call `ensureTierState` already uses and the same one whose doc records
   * why: a wrong viewport guess makes clicks land outside the content box
   * entirely. Resolved lazily rather than at construction because it needs a
   * live CDP session, and cached because it costs a round trip and every
   * handshake wants it. One round trip per session, not per connection.
   *
   * Falls back to {@link DEFAULT_VIEWPORT} when there is no target to ask
   * yet, which is the same guess as before but reached only when nothing
   * better exists rather than unconditionally. A session with no target has
   * nothing to click either, so the fallback cannot be the value an agent
   * actually aims with.
   */
  async instanceViewport(): Promise<{ width: number; height: number }> {
    if (this.cachedInstanceViewport) return this.cachedInstanceViewport;
    // `tabs()`, the same page-like set `listTargets()` reports, not `all()`:
    // a worker or an extension background page has no rendered viewport
    // worth reporting as the instance's.
    const tabs = this.registry.tabs() as unknown as readonly TargetRuntimeLike[];
    const targetId = tabs[0]?.id;
    if (targetId === undefined) return DEFAULT_VIEWPORT;
    const real = await this.queryRealViewport(targetId);
    if (!real) return DEFAULT_VIEWPORT;
    this.cachedInstanceViewport = real;
    return real;
  }

  /**
   * `welcome.lease.byTarget`: one {@link LeaseSummary} per target this
   * session has a lease engine for, projected for `viewerId` as the
   * RECIPIENT.
   *
   * This field was hardcoded `{}` since it was written, so a viewer joining
   * a session where somebody was already driving learned nothing about it
   * from the handshake and had to wait for whatever `control.state`
   * broadcast happened to fire next. Now that shared control ships, the
   * summary also carries `holderCount`, which is what a driver rail renders
   * before its first broadcast arrives.
   *
   * Built from the engine's own `projectSummary`, never assembled here from
   * a snapshot's fields. `LeaseSummary.expiresAt` needs the engine's
   * `computeExpiresAt`, which projects a MONOTONIC holder timestamp onto the
   * wall clock, and doing that arithmetic outside the engine that anchored
   * the monotonic reading drifts by however long the process has been up.
   * Going through the engine also means welcome and the first
   * `control.state` after it are the same projection narrowed two ways, so
   * they cannot disagree.
   *
   * Scoped to {@link knownTargetIds}, NOT to `listTargets()`, and that is
   * load bearing rather than incidental. `Session.leaseEngineFor` calls
   * `ensureTargetState`, which acquires an `InstanceStreamCounter` slot per
   * target; projecting every listed target would therefore acquire a stream
   * slot for every tab in the browser merely to build a handshake message,
   * and could exhaust `maxStreamsPerInstance` before the viewer subscribed
   * to anything. `knownTargetIds` is every target already through that path,
   * which is the same set `broadcastPresence` and `applyCapabilityShrink`
   * already iterate for the same reason.
   *
   * A target absent from the returned map therefore means "this session has
   * no lease engine for it at all", never "unheld": an unheld known target
   * is present, with `holderViewerId: null` and `holderCount: 0`. Absence
   * and emptiness saying different things is what lets a client tell "nobody
   * is driving" from "I have no information".
   */
  leaseSummariesFor(viewerId: string): Record<string, LeaseSummary> {
    const byTarget: Record<string, LeaseSummary> = {};
    for (const targetId of this.knownTargetIds) {
      byTarget[targetId] = this.session.leaseEngineFor(targetId).projectSummary(viewerId);
    }
    return byTarget;
  }

  /**
   * Restores every control lease `viewerId` still holds after a reconnect,
   * and returns the {@link LeaseState} for one of them (or `null` if none
   * came back), ready to be sent as `resumed.lease`.
   *
   * MUST BE CALLED BEFORE `resumeViewer` REGISTERS THE NEW CONNECTION, and
   * that is the whole reason this lives here rather than as a loop in
   * `ws/connection.ts`.
   *
   * `ControlLeaseEngine.handleReconnect` emits a BROADCAST `control.state`
   * (and, through `dispatchEffect`, a `presence.state` behind it) and no
   * direct message to the reconnecting viewer at all. Run with the resuming
   * socket already in `connections`, that broadcast is written to it ahead
   * of its own `welcome`: the resuming client saw `control.state` as the
   * first frame on a brand new socket, `welcome` lost its guaranteed `sq: 1`
   * (`docs/protocol/wire-spec.md`, "Transport and handshake"), and any
   * client reading the handshake
   * positionally read a broadcast where the handshake should be. It is the
   * same bug class as `subscribe()` broadcasting `target.updated` ahead of
   * its own `stream.subscribed` reply, which broke three suites earlier in
   * this work; the fix is the same discipline, announce strictly after.
   *
   * Restoring first, while the socket is still unregistered, gets the order
   * right without suppressing anything: the OTHER viewers get their
   * `control.state` immediately, which is correct, since a driver coming
   * back is exactly what they need to know. The reconnecting viewer is not
   * left guessing either, because it is told the same facts by the
   * handshake itself: `resumed.lease` carries the full projection for the
   * target it got back, and `welcome.lease.byTarget` carries a summary for
   * every target this session holds a lease engine for.
   *
   * Iterates {@link knownTargetIds}, not the resuming viewer's restored
   * SUBSCRIPTIONS as the old loop did. A lease and a subscription are
   * different things: a viewer can hold control of a target it never
   * subscribed to (REST drives one that way, and so does any client that
   * drives a tab it is not currently watching), and that lease was silently
   * not restored. `handleReconnect` returns `{ restored: false }` at once
   * for a viewer that holds nothing, so the wider sweep costs a map lookup
   * per known target.
   *
   * Returns ONE lease because `Resumed.lease` is singular
   * (`@browserglass/protocol`) while a viewer can hold several at once. The
   * last restored wins, matching the previous behaviour; the complete answer
   * is in `welcome.lease.byTarget`, sent immediately before `resumed` in the
   * same handshake.
   */
  restoreLeasesFor(viewerId: string): LeaseState | null {
    let restored: LeaseState | null = null;
    for (const targetId of this.knownTargetIds) {
      const engine = this.session.leaseEngineFor(targetId);
      if (!engine.handleReconnect(viewerId, true).restored) continue;
      restored = engine.projectState(viewerId);
    }
    return restored;
  }

  /**
   * `control.yield`: a person asks the AGENT holders of a shared target to
   * stand down, leaving every HUMAN holder driving.
   *
   * A thin passthrough to the engine, exactly like {@link revokeControl}
   * beside it, and for the same reason: `renewControl`, `releaseControl` and
   * `revokeControl` all reach `leaseEngineFor(targetId)` straight from here,
   * so `core.Session` needs no method of its own for any of them.
   *
   * Note what this does NOT do: it does not check capabilities. Neither does
   * `ControlLeaseEngine.requestAgentYield`, deliberately, matching
   * `requestControl`. Capability enforcement is the transport's job and
   * happens in `wire/capability-check.ts` before any handler runs, on every
   * message, every time. The gate for this one is `control`, NOT `admin`: a
   * person asking the robot driving their tab to stand down is an ordinary
   * act by someone who already holds control. `control.revoke` remains the
   * admin instrument and stays narrower still, since it names one holder of
   * any kind.
   *
   * The `kind` on `requester` is the single place the human/agent
   * distinction is made in this whole system, derived in
   * `ws/connection.ts`'s `viewerIdentity()` from whether the token carries
   * `automation`. The engine refuses a yield from an agent (`not_human`) on
   * the strength of it, so that derivation is load bearing here rather than
   * merely descriptive. See `setViewerCapabilities`'s own comment for the
   * one path where it could go stale and what is done about it.
   */
  async yieldControl(
    requester: SessionViewerIdentity,
    targetId: string,
    reason?: string,
  ): Promise<
    { ok: true; notified: readonly string[] } | { ok: false; error: 'not_shared' | 'not_human' }
  > {
    this.knownTargetIds.add(targetId);
    return this.session.leaseEngineFor(targetId).requestAgentYield(
      {
        viewerId: requester.viewerId,
        identity: requester.identity,
        label: requester.label,
        kind: requester.kind,
        isAdmin: requester.isAdmin,
      },
      reason !== undefined ? { reason } : {},
    );
  }

  /**
   * Runs one `nav.*` command and returns the `nav.state` payload that
   * describes where the Target ended up, so `connection.ts` can send the
   * requester a reply carrying its own `re` (`docs/protocol/wire-spec.md`,
   * "Envelope and correlation").
   *
   * Returning it, rather than only broadcasting it, is what makes
   * `BrowserGlassClient.navigate()`/`.back()`/`.forward()`/`.reload()`
   * resolve at all: every one of them is a `request()`, which correlates
   * strictly on `re`, and a broadcast never carries one. `null` comes back
   * only when the history read behind the payload genuinely failed, in
   * which case the caller still owes the requester an answer of some kind
   * rather than silence.
   */
  async navigate(
    targetId: string,
    kind: 'goto' | 'back' | 'forward' | 'reload' | 'stop',
    params: {
      readonly url?: string;
      readonly ignoreCache?: boolean;
      /** `goto` only. See {@link NavigateWaitUntil}. Default `'commit'`. */
      readonly waitUntil?: NavigateWaitUntil;
      /** `goto` with `waitUntil: 'load'` only: how long to wait for the load event before answering with `loading: true`. Default {@link DEFAULT_NAV_LOAD_TIMEOUT_MS}. */
      readonly timeoutMs?: number;
    },
  ): Promise<NavStatePayload | null> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) throw new Error(`target ${targetId} has no live CDP session`);
    const sessionId = handle.id as never;
    switch (kind) {
      case 'goto':
        return await this.navigateGoto(targetId, sessionId, params);
      case 'back':
      case 'forward': {
        await this.ensurePageEnabled(sessionId);
        const history = (await this.bridge.send('Page.getNavigationHistory', {}, sessionId)) as {
          currentIndex: number;
          entries: readonly { id: number }[];
        };
        const entry =
          history.entries[kind === 'back' ? history.currentIndex - 1 : history.currentIndex + 1];
        if (!entry) {
          // Nothing to go back or forward to. Still answers with the
          // Target's real current state: a client awaiting this call must
          // not hang just because the history end was already reached.
          return await this.emitNavState(targetId, sessionId, { loading: false });
        }
        await this.bridge.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId);
        return await this.emitNavState(targetId, sessionId, { loading: true });
      }
      case 'reload':
        await this.bridge.send(
          'Page.reload',
          { ignoreCache: params.ignoreCache ?? false },
          sessionId,
        );
        return await this.emitNavState(targetId, sessionId, { loading: true });
      case 'stop':
        await this.bridge.send('Page.stopLoading', {}, sessionId);
        return await this.emitNavState(targetId, sessionId, { loading: false });
    }
  }

  /**
   * `nav.goto`. With `waitUntil: 'commit'` (the wire default) this answers
   * as soon as `Page.navigate` returns, which is when the new document has
   * committed and is still loading: `loading: true`, and usually an empty
   * `title`. With `waitUntil: 'load'` it also waits for the new document's
   * `Page.loadEventFired` (the page's `load` event), so the reply carries
   * the loaded page's real title and `loading: false`.
   *
   * The listener goes on before `Page.navigate` is sent, so a fast page
   * cannot fire `load` in the gap, and any `load` that arrives before
   * `Page.navigate` has answered is ignored: that one belongs to whatever
   * document was loading before. A navigation with no `loaderId` is
   * same-document (a fragment change, a `pushState` URL): no new document,
   * no `load` event, nothing to wait for. If the load event does not come
   * within `timeoutMs` the reply is the honest current state with
   * `loading: true`, never an invented `false`.
   */
  private async navigateGoto(
    targetId: string,
    sessionId: never,
    params: {
      readonly url?: string;
      readonly waitUntil?: NavigateWaitUntil;
      readonly timeoutMs?: number;
    },
  ): Promise<NavStatePayload | null> {
    const waitForLoad = params.waitUntil === 'load';
    let navigated = false;
    let onLoad: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      onLoad = resolve;
    });
    let unsubscribe: (() => void) | undefined;
    if (waitForLoad) {
      // `Page.loadEventFired` is only delivered with the Page domain on.
      await this.ensurePageEnabled(sessionId);
      unsubscribe = this.bridge.on(
        'Page.loadEventFired',
        () => {
          if (navigated) onLoad?.();
        },
        sessionId,
      );
    }
    try {
      const result = (await this.bridge.send('Page.navigate', { url: params.url }, sessionId)) as {
        errorText?: string;
        loaderId?: string;
      };
      navigated = true;
      if (result.errorText) {
        return await this.emitNavState(targetId, sessionId, {
          loading: false,
          errorText: result.errorText,
        });
      }
      if (!waitForLoad) {
        return await this.emitNavState(targetId, sessionId, { loading: true });
      }
      if (result.loaderId === undefined) {
        return await this.emitNavState(targetId, sessionId, { loading: false });
      }
      const timeoutMs = params.timeoutMs ?? DEFAULT_NAV_LOAD_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        loaded.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      return await this.emitNavState(targetId, sessionId, { loading: timedOut });
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Broadcasts a best-effort `nav.state` envelope for `targetId`, built
   * from `Page.getNavigationHistory`'s own current entry: real `url` and
   * `title`, and real `canGoBack`/`canGoForward` from where `currentIndex`
   * sits in `entries`. This is not the full "every main-frame navigation,
   * title change, load-state change, and history-state change" feed
   * `NavState`'s own doc comment (`packages/protocol/src/wire/messages/navigation.ts`)
   * describes: that needs `Page.enable` plus live `Page.frameNavigated`/`Page.lifecycleEvent`
   * subscriptions, which `target-registry.ts`'s own module doc records as
   * not implemented (the full per-target domain-enable lifecycle depends on
   * `BrowserSpec` configuration this layer does not see). It is the minimal, honest
   * subset available from a command `navigate()` already sends for
   * `back`/`forward`: one confirmation per `nav.*` command, with real
   * (never fabricated) `url`/`title`/history fields, `loading` and
   * `errorText` supplied by the caller since only it knows which command
   * just ran and whether CDP reported a failure.
   *
   * `Page.getNavigationHistory` needs `ensurePageEnabled` first; see that
   * method's own doc for why.
   */
  private async emitNavState(
    targetId: string,
    sessionId: never,
    extra: { readonly loading: boolean; readonly errorText?: string },
  ): Promise<NavStatePayload | null> {
    try {
      await this.ensurePageEnabled(sessionId);
      const history = (await this.bridge.send('Page.getNavigationHistory', {}, sessionId)) as {
        currentIndex: number;
        entries: readonly { url: string; title: string }[];
      };
      const current = history.entries[history.currentIndex];
      const payload: NavStatePayload = {
        t: 'nav.state',
        targetId,
        url: current?.url ?? '',
        title: current?.title ?? '',
        loading: extra.loading,
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
        securityState: 'unknown',
        ...(extra.errorText !== undefined ? { errorText: extra.errorText } : {}),
      };
      // Every viewer on this session needs the new state, not only
      // whoever asked for it, so the broadcast stays; the return value is
      // what lets the requester also get a correlated copy.
      this.broadcast({ ...payload });
      return payload;
    } catch {
      // Best effort: a failed history read must not turn a navigation
      // command that otherwise succeeded into an error the caller sees.
      return null;
    }
  }

  /**
   * `target.capture`'s wire handler used to report `width: 0, height: 0,
   * dpr: 1` on every reply regardless of what was actually captured (found
   * while building the CLI). Fixed by reading the
   * dimensions back out of the encoded bytes with `readFrameDimensions`
   * (`packages/core/src/stream/frame-dimensions.ts`), the same decoder the
   * screencast and poll frame sources use for the identical problem: a
   * screenshot's real size cannot be assumed from what was requested.
   *
   * `dpr` has no CDP field to read directly: `Page.getLayoutMetrics` (see
   * `queryRealViewport()`'s comment on `TargetRegistry.viewport` always
   * being `null`) reports scroll and content size, never the device scale
   * factor, and `Runtime.evaluate`'s `window.devicePixelRatio` is off
   * limits (the CDP passthrough allowlist refuses the whole `Runtime`
   * domain as arbitrary script execution). `Page.captureScreenshot` is
   * called here without `scale: 'css'`, so it returns device pixels;
   * dividing that by the CSS viewport width from `queryRealViewport()`
   * recovers the real device scale factor honestly, from measurement
   * rather than assumption. Falls back to `1` only when the CSS viewport
   * cannot be read (no live session, or the command failed), matching the
   * previous default rather than reporting a number pulled from nowhere.
   */
  async capture(
    targetId: string,
    opts: {
      readonly format?: 'png' | 'jpeg';
      readonly quality?: number;
      readonly clip?: { x: number; y: number; width: number; height: number };
    },
  ): Promise<{ format: 'png' | 'jpeg'; data: string; width: number; height: number; dpr: number }> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) throw new Error(`target ${targetId} has no live CDP session`);
    const format = opts.format ?? 'jpeg';
    const params: Record<string, unknown> = {
      format,
      ...(format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}),
    };
    if (opts.clip) params['clip'] = { ...opts.clip, scale: 1 };
    const result = (await this.bridge.send(
      'Page.captureScreenshot',
      params,
      handle.id as never,
    )) as { data: string };
    const dims = readFrameDimensions(decodeBase64(result.data), format);
    const width = dims?.width ?? 0;
    const height = dims?.height ?? 0;
    const cssViewport = await this.queryRealViewport(targetId);
    const dpr = cssViewport && cssViewport.width > 0 ? width / cssViewport.width : 1;
    return { format, data: result.data, width, height, dpr };
  }

  /**
   * `page.pdf.get`'s server-side half: renders `targetId` as a PDF
   * (`@browserglass/core`'s `printToPdf`) and decides, from the REAL,
   * measured size of what came back, how it crosses the wire. See
   * `@browserglass/protocol`'s `wire/messages/pdf.ts` module doc, "the two
   * delivery shapes", for the full argument; this method is what actually
   * makes that decision.
   *
   * Below `MAX_INLINE_PDF_BYTES`: returns `kind: 'inline'` with the base64
   * bytes directly, the wire handler's `page.pdf.got.data`.
   *
   * At or above it: written to `this.downloadStore`'s own root under a
   * freshly minted id, then run through the IDENTICAL
   * `DownloadStore.finalize()` / `.issueUrl()` pair `finalizeDownload()`
   * above uses for a real browser download. Reusing that pair rather than
   * hand-rolling a second hash-and-sign path is deliberate: `finalize()`'s
   * own re-verification (the file really is a plain regular file at the
   * expected path, under the store's own size ceiling) and its SHA-256 are
   * exactly what this delivery needs too, and the REST route that later
   * serves the URL (`../rest/routes/downloads.ts`) already does not care
   * how a file arrived at `<root>/<downloadId>`, only that `takeToken()`
   * names it. What this path does NOT reuse from `finalizeDownload()` is
   * the `onDownload` hook / `download.ready` broadcast: those exist for a
   * download the PAGE initiated, answered to every viewer holding the
   * `download` capability, which is the wrong shape for a reply to ONE
   * caller's own `page.pdf.get` (the same single-viewer-reply reasoning
   * `target.captured` and `page.a11y.got` both already carry in their own
   * module docs).
   *
   * `kind: 'refused'` covers the two ways delivery can fail outright: no
   * download store configured at all (`reason: 'downloads_unavailable'`),
   * or the finished file exceeding the store's own `maxBytes` ceiling
   * (`reason: 'too_large'`, `DownloadStoreError`'s `E_DOWNLOAD_TOO_LARGE`,
   * which `DownloadStore.finalize()` has already removed the file for by
   * the time it throws). Both are reported to the caller as structured
   * `bgls.error.capture.too_large` data by the wire handler, never a
   * silently truncated PDF.
   */
  async pdf(
    targetId: string,
    opts: PrintToPdfOptions,
  ): Promise<
    | {
        readonly kind: 'inline';
        readonly pdfId: string;
        readonly sizeBytes: number;
        readonly gen: number;
        readonly data: string;
      }
    | {
        readonly kind: 'download';
        readonly pdfId: string;
        readonly sizeBytes: number;
        readonly gen: number;
        readonly downloadId: string;
        readonly url: string;
        readonly expiresAt: number;
        readonly sha256: string;
      }
    | {
        readonly kind: 'refused';
        readonly sizeBytes: number;
        readonly gen: number;
        readonly reason: 'downloads_unavailable' | 'too_large';
      }
  > {
    const handle = await this.ensureAttached(targetId);
    if (!handle) throw new Error(`target ${targetId} has no live CDP session`);
    const { data } = await printToPdf(this.bridge, handle.id as never, opts);
    const sizeBytes = Buffer.byteLength(data, 'base64');
    const gen = this.currentGenFor(targetId);

    if (sizeBytes <= MAX_INLINE_PDF_BYTES) {
      return {
        kind: 'inline',
        pdfId: `pdf_${randomBytes(12).toString('hex')}`,
        sizeBytes,
        gen,
        data,
      };
    }

    if (this.downloadStore === undefined) {
      return { kind: 'refused', sizeBytes, gen, reason: 'downloads_unavailable' };
    }

    const downloadId = `pdf_${randomBytes(16).toString('hex')}`;
    const path = join(this.downloadStore.root, downloadId);
    try {
      // The store never creates its own root (Chrome is normally the first
      // thing to write into it, and Chrome creates it on demand). A fresh
      // gateway that has not seen a real download yet has no such
      // directory, so this write would fail with ENOENT without this.
      await mkdir(this.downloadStore.root, { recursive: true });
      await writeFile(path, Buffer.from(data, 'base64'));
    } catch (err) {
      // The full path and the raw fs message go to the log only. What the
      // caller sees is a fixed sentence plus the errno code: the path names
      // the server's disk layout and usually the OS user.
      const code =
        err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string'
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      this.logger?.error(
        {
          component: 'server',
          targetId,
          path,
          error: err instanceof Error ? err.message : String(err),
        },
        'could not stage a large PDF in the download store',
      );
      throw new PdfStagingError(code);
    }

    let finalized: FinalizedDownload;
    try {
      finalized = await this.downloadStore.finalize(downloadId, path);
    } catch (err) {
      if (err instanceof DownloadStoreError && err.code === 'E_DOWNLOAD_TOO_LARGE') {
        return { kind: 'refused', sizeBytes, gen, reason: 'too_large' };
      }
      throw err;
    }

    const issued = this.downloadStore.issueUrl(
      downloadId,
      'page.pdf',
      'application/pdf',
      finalized.sizeBytes,
    );
    return {
      kind: 'download',
      pdfId: downloadId,
      sizeBytes: finalized.sizeBytes,
      gen,
      downloadId,
      url: issued.url,
      expiresAt: issued.expiresAt,
      sha256: finalized.sha256,
    };
  }

  /**
   * `target.probe`'s server-side half: hit-tests one point in one of THIS
   * session's targets and describes what is under it. Every mouse move
   * across a streamed pane produces one of these, so it is the CDP path a
   * HUMAN causes most traffic on, by a wide margin.
   *
   * WHY THIS SENDS NO `Runtime.evaluate`
   *
   * It used to. This method built an expression string around
   * `document.elementFromPoint(x, y)` and sent it as a raw
   * `Runtime.evaluate` on every hover, gated on nothing: not `devtools`,
   * not the `evaluate` capability, not a lease. It was reported as a
   * stealth defect on the grounds that the `Runtime` domain is what
   * patchright names as the fingerprinted signal, and it was measured
   * against a real headless Chrome before it was changed, because the
   * reported mechanism and the right fix turned out not to match.
   *
   * The measurement is written up in full in `@browserglass/core`'s
   * `cdp/hit-test.ts`. In short: `Runtime.evaluate` does NOT enable the
   * `Runtime` domain (five of them produced zero `Runtime.*` events; one
   * `Runtime.enable` on the same session immediately produced an
   * execution-context event and about 1500 console events), so the
   * domain-enable fingerprint was never being tripped here, and gating
   * this path on the `evaluate` capability would have closed nothing while
   * breaking hover for every existing viewer, `evaluate` being off by
   * default and in no role bundle. What it DID do was run script in the
   * page's own world, where a page can watch it (a reassigned
   * `Document.prototype.elementFromPoint` counted every hover, with the
   * coordinates) and, worse, answer it: a page returning its own detached
   * `<a href="https://attacker.example/paid">` made this method report that
   * href, and `@browserglass/react`'s `<ContextMenu/>` turns
   * `target.probed.href` into "open link in new tab". A capability gate
   * would have left that in place for anyone holding `evaluate`.
   *
   * So the hit test was reimplemented on `DOM.*` commands, which execute
   * nothing and are answered by Chrome out of the DOM agent. Under the
   * same page-side traps it moved no counter at all. It needs no
   * capability, because it grants none: `PROBE_CAPABILITY_RULE` still asks
   * for `view` alone at `detail: 'hover'`, unchanged.
   *
   * WHAT CHANGED IN THE REPLY
   *
   *  * `label` is unchanged for an element with an `aria-label` (that is
   *    an attribute, so `DOM.describeNode` still hands it over), and for
   *    everything else it is now `'tag#id.class.class'` rather than the
   *    element's text. Text is not readable without executing script, and
   *    the selector form is what `TargetProbed.label` has always been
   *    specified as in `@browserglass/protocol` and on the client's
   *    `ProbeResult` anyway. No shipped UI renders `label`;
   *    `<ContextMenu/>` reads only `href`.
   *  * `rect` is now OMITTED, rather than sent as `0,0,0,0`, for an
   *    element Chrome will not compute a box model for (`display: none`).
   *    It is optional on the wire, and a zero rect draws as a highlight of
   *    nothing in the corner of the page.
   *  * A point over a closed shadow root now reports the element INSIDE
   *    it rather than the host, and a point over a same-process iframe
   *    reports the element inside the frame. `elementFromPoint` could do
   *    neither. `rect` stays in top-viewport CSS px in both cases.
   *
   * `hrefFromAncestor` was never sent and still is not; see
   * `HitTestResult.href` for why the ancestor walk is not affordable on
   * this path.
   */
  async probe(
    targetId: string,
    x: number,
    y: number,
  ): Promise<{
    hit: boolean;
    rect?: { x: number; y: number; w: number; h: number };
    tagName?: string;
    label?: string;
    href?: string | null;
  }> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) return { hit: false };
    const found = await hitTestAtPoint(this.bridge, handle.id, { x, y });
    if (!found) return { hit: false };
    return {
      hit: true,
      ...(found.rect ? { rect: found.rect } : {}),
      tagName: found.tagName,
      label: found.label,
      href: found.href,
    };
  }

  /**
   * `page.evaluate`'s server-side half: runs a caller-supplied script in
   * ONE of THIS session's targets and returns a defined outcome
   * (`@browserglass/core`'s `EvaluateOutcome`) for every completion.
   *
   * This method IS the authorization boundary for page evaluation, and the
   * boundary is `ensureAttached(targetId)` on the line below. That call goes
   * through `TargetRegistry.attach()`, and the registry it reaches is
   * `this.registry`: the one belonging to this `ManagedSession`, which owns
   * exactly one Instance's targets. `TargetRegistry.require()` throws
   * `E_CDP_TARGET_NOT_FOUND` for an id it does not hold, so:
   *
   *  * a target id belonging to ANOTHER session (another Instance, another
   *    tenant) is simply not in this registry and is refused, exactly as a
   *    closed target would be. Guessing another tenant's `tgt_*` id buys
   *    nothing, because the id is looked up in the wrong map on purpose;
   *  * the CDP session id is DERIVED here from the target, never accepted
   *    from the caller, so there is no way to address a session directly;
   *  * the CDP command is always sent WITH that session id attached, so it
   *    can never fall through to the browser-level target the way a
   *    session-less `Runtime.evaluate` would.
   *
   * The one thing this method deliberately does NOT check is a held
   * `ControlLease`. Evaluation is a read of the page in the same sense
   * `capture()` and `probe()` above are, both of which need no lease either
   * (see `AutomationClient.screenshot()`'s own note on why), and requiring
   * one would mean a caller could not read a page while a human is driving
   * it, which is the case where reading it is most useful. Script that
   * WRITES to the page can of course be written, and that is what the
   * `evaluate` capability being off by default and separately grantable is
   * for; a lease check here would be a partial and misleading version of a
   * protection the capability model already provides properly.
   */
  async evaluate(targetId: string, req: EvaluateRequest): Promise<EvaluateOutcome> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) {
      // `E_CDP_TARGET_NOT_FOUND` rather than a bare `Error`, so the wire
      // layer answers `bgls.error.target.not_found` and a caller can tell
      // "that target is not mine, or is gone" apart from "the evaluation
      // itself failed". `ensureAttached` swallows the registry's own typed
      // throw (it is written to return null rather than throw, for the
      // benefit of `capture`/`probe`/`answerDialog`), so the distinction
      // has to be restored here.
      throw new BglsError(
        'E_CDP_TARGET_NOT_FOUND',
        `target ${targetId} is not in this session, or has no live CDP session`,
      );
    }
    // `world: 'isolated'` needs a frame, and the frame comes from OUR
    // registry entry for a target we just proved is ours, never from the
    // caller. That is what keeps escalation path 1 closed while still
    // letting a caller ask for a world a page cannot watch.
    if (req.world === 'isolated') {
      const frameId = this.registry.get(targetId as never)?.mainFrameId ?? undefined;
      if (frameId === undefined) {
        throw new BglsError(
          'E_CDP_TARGET_NOT_FOUND',
          `target ${targetId} has no known main frame yet, so it has no isolated world to run in`,
        );
      }
      return await evaluateInSession(this.bridge, handle.id, { ...req, frameId });
    }
    return await evaluateInSession(this.bridge, handle.id, req);
  }

  /**
   * `page.responsebody.get`'s server-side half: reads the response body
   * Chrome has buffered for `requestId`, for a viewer that already earned
   * the right to ask for it.
   *
   * `viewerId` is a parameter, not something this method infers, because
   * this IS the capability enforcement point for the one bound
   * `packages/server/src/wire/capability-check.ts` cannot express on its
   * own: `devtools` says a caller may use this door at all, never WHICH
   * `requestId`s it has actually been shown. That second check,
   * `hasSeenNetworkRequestId`, runs FIRST, before any CDP command goes out,
   * exactly as `@browserglass/protocol`'s `wire/messages/response-body.ts`
   * ("enforced in the SERVER") requires: a caller holding `devtools` and
   * willing to guess `requestId` strings gains nothing from guessing one
   * that happens to be real, because the bound is checked against what
   * THIS VIEWER was actually shown, never against what exists in Chrome's
   * buffer.
   *
   * `targetId` resolution then mirrors `evaluate()`'s own boundary,
   * `ensureAttached(targetId)` against `this.registry`: a target belonging
   * to another session is simply not in this registry, and the CDP session
   * id is derived here, never accepted from the caller.
   */
  async getResponseBody(
    viewerId: string,
    targetId: string,
    requestId: string,
    maxBytes: number,
  ): Promise<ResponseBodyOutcome> {
    if (!this.hasSeenNetworkRequestId(viewerId, targetId, requestId)) {
      throw new BglsError(
        'E_RESPONSE_BODY_UNKNOWN_REQUEST',
        `viewer ${viewerId} was never shown requestId ${requestId} on target ${targetId}`,
      );
    }
    const handle = await this.ensureAttached(targetId);
    if (!handle) {
      throw new BglsError(
        'E_CDP_TARGET_NOT_FOUND',
        `target ${targetId} is not in this session, or has no live CDP session`,
      );
    }
    return await getResponseBodyFromCdp(this.bridge, handle.id, requestId, maxBytes);
  }

  /**
   * `page.a11y.get`'s server-side half: reads (and, optionally, stamps)
   * Chrome's own accessibility tree for `targetId`.
   *
   * Unlike `getResponseBody` above, there is no second, per-viewer scoping
   * bound to enforce here: `devtools`, already checked at the wire layer
   * before this method is ever reached, is the whole authorization
   * argument (`@browserglass/protocol`'s `wire/messages/a11y.ts`, "gated on
   * `devtools`, not `evaluate` or a fresh capability"). What this method
   * owns is the ordinary CDP boundary `evaluate()` and `probe()` both use,
   * `ensureAttached(targetId)` against `this.registry`, and turning a
   * `stamp: true` request into the one `stampAccessibilityNodes` call that
   * follows the query, on the SAME session id, so a navigation landing
   * between the two fails the stamp the same way any other mid-navigation
   * CDP command would rather than silently stamping a different page.
   */
  async a11y(
    targetId: string,
    req: {
      readonly role?: string;
      readonly name?: string;
      readonly maxNodes: number;
      readonly stamp: boolean;
    },
  ): Promise<{ nodes: AxTreeNode[]; total: number; truncated: boolean; marker: string | null }> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) {
      throw new BglsError(
        'E_CDP_TARGET_NOT_FOUND',
        `target ${targetId} is not in this session, or has no live CDP session`,
      );
    }
    const outcome = await queryAccessibilityTree(this.bridge, handle.id, {
      ...(req.role !== undefined ? { role: req.role } : {}),
      ...(req.name !== undefined ? { name: req.name } : {}),
      maxNodes: req.maxNodes,
      maxResultBytes: MAX_A11Y_RESULT_BYTES,
    });
    if (!req.stamp || outcome.nodes.length === 0) {
      return {
        nodes: outcome.nodes,
        total: outcome.total,
        truncated: outcome.truncated,
        marker: null,
      };
    }
    const markerAttr = mintAxMarkerAttr();
    const stampOutcome = await stampAccessibilityNodes(
      this.bridge,
      handle.id,
      outcome.nodes.map((n) => n.backendNodeId),
      markerAttr,
    );
    const anyStamped = stampOutcome.stamped.some((s) => s);
    return {
      nodes: outcome.nodes,
      total: outcome.total,
      truncated: outcome.truncated,
      marker: anyStamped ? markerAttr : null,
    };
  }

  /**
   * `page.map.get`'s server-side half: runs `capturePageMap`
   * (`@browserglass/core`'s `pagemap/capture.ts`), caches the result for
   * {@link stampPageMap}'s epoch check, and reduces it to the wire shape
   * (`buildPageMapBudget` for `nodes`, `extractPageMapText` for `text`).
   *
   * Same authorization shape as {@link a11y} just above: `devtools`,
   * already checked at the wire layer, is the whole argument
   * (`@browserglass/protocol`'s `wire/messages/pagemap.ts`), so this method
   * owns only the ordinary CDP boundary (`ensureAttached(targetId)`) and
   * the reduction from `PageMapCapture` to what `page.map.got` sends.
   *
   * `req.timeoutMs` arrives already defaulted and clamped to
   * `MAX_PAGEMAP_TIMEOUT_MS`: the wire handler's job, mirroring
   * `page.a11y.get`'s own `maxNodes` clamp, per that handler's own doc
   * ("an over-large ask is optimism, not a typo").
   */
  async pageMap(
    targetId: string,
    req: {
      readonly include?: readonly PageMapInclude[];
      readonly listeners?: boolean;
      readonly timeoutMs: number;
    },
  ): Promise<{
    epoch: PageMapEpoch;
    nodes?: PageMapNode[];
    total?: number;
    truncated?: boolean;
    truncatedByReason?: Record<PageMapTruncationReason, number>;
    degraded?: PageMapDegradation;
    text?: PageMapTextBlock[];
  }> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) {
      throw new BglsError(
        'E_CDP_TARGET_NOT_FOUND',
        `target ${targetId} is not in this session, or has no live CDP session`,
      );
    }

    const capture = await capturePageMap(this.bridge, handle.id, this.registry, {
      ...(req.include !== undefined ? { include: req.include } : {}),
      ...(req.listeners !== undefined ? { listeners: req.listeners } : {}),
      timeoutMs: req.timeoutMs,
    });
    // Cached BEFORE this method can throw again, so a `page.map.stamp`
    // that follows a successful `page.map.get` always has something fresh
    // to check its epoch against. See {@link stampPageMap} and
    // `PageMapCache`'s own module doc for why caching here (rather than
    // re-deriving the epoch on stamp) is what makes "before any CDP
    // command goes out" literally true for a stale epoch.
    this.pageMapCache.set(targetId, handle.id, capture);

    const include = req.include ?? ['nodes'];
    const needsNodes = include.includes('nodes');
    const needsText = include.includes('text');

    const out: {
      epoch: PageMapEpoch;
      nodes?: PageMapNode[];
      total?: number;
      truncated?: boolean;
      truncatedByReason?: Record<PageMapTruncationReason, number>;
      degraded?: PageMapDegradation;
      text?: PageMapTextBlock[];
    } = { epoch: capture.epoch };

    if (needsNodes) {
      const budget = buildPageMapBudget(capture, { maxResultBytes: MAX_PAGEMAP_RESULT_BYTES });
      out.nodes = budget.nodes;
      out.total = budget.total;
      out.truncated = budget.truncated;
      out.truncatedByReason = budget.truncatedByReason;
      out.degraded = pageMapDegradationFrom(capture, req.listeners ?? true);
    }
    if (needsText) {
      // `extractPageMapText`'s own `total`/`truncated` are computed and
      // discarded here rather than dropped silently by accident: `page.map.got`
      // (`@browserglass/protocol`'s `wire/messages/pagemap.ts`) has no field
      // to carry text truncation on, unlike `nodes`' own `total`/`truncated`/
      // `truncatedByReason` trio. REPORTED to the pagemap lead: an
      // `include: ['text']` reply that gets cut by `MAX_PAGEMAP_RESULT_BYTES`
      // currently has no way to say so on the wire, which is a real gap
      // against this feature's own "truncation is never silent" rule for
      // exactly the text-only path. Closing it needs a wire type change
      // (for example `textTotal`/`textTruncated`) to a file marked complete
      // for this build stage, not a server-side fix.
      out.text = extractPageMapText(capture, { maxResultBytes: MAX_PAGEMAP_RESULT_BYTES }).blocks;
    }

    return out;
  }

  /**
   * `page.map.stamp`'s server-side half: checks the requested `epoch`
   * against the cached capture for `targetId` (see `docs/page-map.md` on
   * indices and epochs) and, only on a match, stamps the requested indices through
   * `stampAccessibilityNodes`, exactly the function {@link a11y}'s own
   * `stamp: true` path already uses with different backend node ids.
   *
   * The epoch check reads {@link pageMapCache} rather than issuing any CDP
   * command: no cached capture for `targetId` at all (nothing captured
   * yet, or the cache entry was invalidated by a navigation or a document
   * replacement since) is treated the same as a stale one, both refused as
   * `PageMapStaleEpochError` before `ensureAttached` or any other CDP call
   * runs, matching the design's own framing ("A mismatch is refused ...
   * before any CDP command goes out").
   */
  async stampPageMap(
    targetId: string,
    epoch: PageMapEpoch,
    indices: readonly number[],
  ): Promise<{
    results: { index: number; stamped: boolean; reason?: string }[];
    marker: string | null;
  }> {
    const cached = this.pageMapCache.get(targetId);
    if (cached === undefined || !isFreshEpoch(cached.epoch, epoch)) {
      throw new PageMapStaleEpochError(cached?.epoch ?? '', epoch);
    }

    if (indices.length === 0) {
      return { results: [], marker: null };
    }

    const handle = await this.ensureAttached(targetId);
    if (!handle) {
      throw new BglsError(
        'E_CDP_TARGET_NOT_FOUND',
        `target ${targetId} is not in this session, or has no live CDP session`,
      );
    }

    const markerAttr = mintAxMarkerAttr();
    const stampOutcome = await stampAccessibilityNodes(this.bridge, handle.id, indices, markerAttr);
    const results = indices.map((index, i) => {
      const stamped = stampOutcome.stamped[i] ?? false;
      return stamped
        ? { index, stamped }
        : {
            index,
            stamped,
            reason: 'Node not found, or detached between the capture and this stamp.',
          };
    });
    const anyStamped = stampOutcome.stamped.some((s) => s);
    return { results, marker: anyStamped ? markerAttr : null };
  }

  async answerDialog(targetId: string, accept: boolean, promptText?: string): Promise<void> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) return;
    const params: Record<string, unknown> = { accept };
    if (promptText !== undefined) params['promptText'] = promptText;
    await this.bridge.send('Page.handleJavaScriptDialog', params, handle.id as never);
  }

  /**
   * Actively ensures `targetId` has a live CDP session, returning its
   * session handle, or `null` (never throws) if the target is unknown or
   * cannot be attached. `TargetRegistry.attach()` (`packages/core/src/cdp/target-registry.ts`)
   * is idempotent: if `Target.setAutoAttach`'s own, asynchronous `Target.attachedToTarget`
   * event already landed for this target, it returns that session
   * immediately with no further CDP round trip; otherwise it actively sends
   * `Target.attachToTarget` and waits for a real response. Reading a
   * target's `cdpSessionId` field directly, as this method's callers used
   * to, instead raced that passive auto-attach event: a freshly discovered
   * target (one no viewer has ever called `stream.subscribe` for, which is
   * the only other path that calls `attach()`, via `Session.subscribe()`)
   * could still have a `null` `cdpSessionId` moments after being reported
   * to a client, well within the time a real caller might send `nav.goto`
   * or another per-target command for it.
   */
  private async ensureAttached(
    targetId: string,
  ): Promise<Awaited<ReturnType<TargetRegistry['attach']>> | null> {
    try {
      return await this.registry.attach(targetId as never);
    } catch {
      return null;
    }
  }

  /**
   * Sends `Page.enable` on `sessionId`. Confirmed directly against real
   * Chrome 151.0.7922.173: `Page.getNavigationHistory` (used by
   * `navigate()`'s `back`/`forward` case and by `emitNavState`) answers
   * `Not attached to an active page` on a session that has never had
   * `Page.enable` sent on it, which is every session this build produces on
   * its own: `target-registry.ts`'s own module doc records the whole
   * per-target domain-enable lifecycle (`Page.enable` among it) as
   * deliberately not implemented. This is the one corner
   * of that lifecycle `navigate()`'s own commands actually need; the rest
   * (`Runtime.enable`, `Emulation.*`, init scripts, file chooser and
   * download settings) stays out of scope, per that same module doc.
   *
   * Sent every call, not cached per session id: confirmed directly that
   * `Target.activateTarget`/`TargetActivationPolicy.activate()`'s own
   * `CdpScreencastSource` stop-then-restart (`packages/core/src/session/target-activation.ts`,
   * the active-target promotion) resets this same, still-alive
   * session's Page-domain-enabled state without ever detaching or
   * re-attaching it, so a `pageEnabledSessions`-style "already enabled"
   * cache keyed on session id goes stale exactly when a target is promoted
   * to screencast-active and then immediately navigated. `Page.enable` is
   * idempotent and cheap; resending it unconditionally is simpler and
   * strictly more correct than tracking a state that can silently expire
   * out from under the cache.
   */
  private async ensurePageEnabled(sessionId: never): Promise<void> {
    await this.bridge.send('Page.enable', {}, sessionId);
  }

  // ── REST driving surface ─────────────────────────────────────────────
  //
  // The four methods below back `RestSessionDriver`/`RestCdpSender`
  // (`packages/server/src/rest/types.ts`), wired up by
  // `session/rest-driver.ts`. `listTargets`/`createTarget`(`newTarget`)/
  // `closeTarget`/`navigate` already exist above and are called directly;
  // these are the ones that did not.

  /**
   * `RestSessionDriver.screenshot`. One-shot `Page.captureScreenshot` with
   * `scale: 'css'` mandatory, exactly like `cdp-screencast-source.ts`'s
   * `forceFrame()` (see that method's own doc): without it, screenshots
   * come back at device pixels, and on a 2x DPR profile the result
   * alternates between two sizes across calls. Deliberately not `capture()`
   * above (`target.capture`'s wire handler): that method predates this one,
   * lacks `scale: 'css'`, and changing its output shape would break its
   * existing callers.
   *
   * `fullPage`, when set, captures the full scrollable area instead of the
   * viewport: `Page.getLayoutMetrics`'s `cssContentSize` names that area in
   * the same CSS-pixel space `scale: 'css'` puts the screenshot in, so it
   * doubles as both the capture `clip` and the reported `width`/`height`.
   */
  async screenshotTarget(
    targetId: string,
    opts: {
      readonly format?: 'png' | 'jpeg';
      readonly quality?: number;
      readonly fullPage?: boolean;
    },
  ): Promise<{
    readonly format: 'png' | 'jpeg';
    readonly data: string;
    readonly width: number;
    readonly height: number;
  }> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) throw new Error(`target ${targetId} has no live CDP session`);
    const sessionId = handle.id as never;
    const format = opts.format ?? 'png';
    const params: Record<string, unknown> = {
      format,
      ...(format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}),
      scale: 'css',
    };
    let width = 0;
    let height = 0;
    if (opts.fullPage) {
      const metrics = (await this.bridge.send('Page.getLayoutMetrics', {}, sessionId)) as {
        cssContentSize?: { width: number; height: number };
      };
      if (metrics.cssContentSize) {
        width = metrics.cssContentSize.width;
        height = metrics.cssContentSize.height;
        params['captureBeyondViewport'] = true;
        params['clip'] = { x: 0, y: 0, width, height, scale: 1 };
      }
    }
    if (!width || !height) {
      const viewport = await this.queryRealViewport(targetId);
      width = viewport?.width ?? width;
      height = viewport?.height ?? height;
    }
    const result = (await this.bridge.send('Page.captureScreenshot', params, sessionId)) as {
      data: string;
    };
    return { format, data: result.data, width, height };
  }

  /**
   * `RestSessionDriver.click`/`.type`'s one CDP escape hatch:
   * `RestCdpSender.send`, scoped to exactly the `targetId` the caller
   * named. Resolves a live CDP session the same way `navigate()` does
   * (`ensureAttached`); the method allowlist itself
   * (`rest/cdp-passthrough-allowlist.ts`) is enforced by the route handler
   * before this is ever reached, and this method must never re-derive or
   * second-guess that decision, only make sure whatever method is handed to
   * it lands on the one target it was scoped to, never another target
   * under the same session.
   *
   * `Input.*` methods (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
   * `Input.dispatchTouchEvent`, `Input.insertText`, the same four the
   * allowlist grants) are routed through {@link withRestControl} rather
   * than straight to `rawSendCdp` below. Before this, they were not: this
   * method sent them straight to `this.bridge.send`, four lines with no
   * lease check at all, while `clickTarget`/`typeTarget` two screens down
   * borrow the SAME `REST_VIEWER_ID` lease for the exact same CDP domain.
   * `rest/cdp-passthrough-allowlist.ts`'s own doc comment on
   * `CDP_PASSTHROUGH_ALLOWLIST` claimed this method "grants no more input
   * reach than `control` already does over the WS input path"; that was
   * false, because the WS path is fenced on `leaseId` by
   * `resolveInputFencing` (`@browserglass/core`'s `control/fencing.ts`)
   * and this one was fenced on nothing. Concretely: a `cdp`-capable token
   * (the `agent` role bundle carries it, `protocol/wire/capabilities.ts`)
   * could POST `Input.dispatchKeyEvent` at a target a HUMAN currently holds
   * the lease on and type into whatever the human had focused, with no
   * presence row, no contention signal, and none of `InputDispatcher`'s
   * `held.buttons` bookkeeping (so an injected `mousePressed` with no
   * matching `mouseReleased` left a button stuck down for the human, the
   * same hazard `disconnectHygieneMs` exists to sweep for a departed
   * driver, except nothing swept THIS one). `withRestControl` closes it the
   * same way it already closes it for `clickTarget`/`typeTarget`: borrow
   * `REST_VIEWER_ID`'s lease, which throws immediately if another viewer
   * (of any priority) already holds the target, so an `Input.*` passthrough
   * call now shares the exact same control model every other input path in
   * this codebase does, rather than a side channel around it.
   *
   * Every other method (`Page.navigate`, `DOM.getDocument`,
   * `Page.captureScreenshot`, ...) is unchanged: none of them is `control`,
   * so gating them on a lease would refuse a harmless read merely because
   * somebody else is driving, which is not what the lease model protects.
   */
  async sendCdp(
    targetId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method.startsWith('Input.')) {
      return this.withRestControl(targetId, () => this.rawSendCdp(targetId, method, params));
    }
    return this.rawSendCdp(targetId, method, params);
  }

  private async rawSendCdp(
    targetId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) throw new Error(`target ${targetId} has no live CDP session`);
    return this.bridge.send(method, params, handle.id as never);
  }

  /**
   * The generation `getGeneration(targetId)` (`core/src/session/session.ts`'s
   * `buildInputDispatcher()`) would report right now, computed the same
   * way: `streamHandleFor(targetId)`'s `Stream.gen`, or `0` for a target
   * nobody has ever subscribed a stream to. A REST click/type has no prior
   * `nav.state`/`target.updated` to read a `gen` off of the way a WS client
   * does, so it asks for the live value fresh on every call instead.
   *
   * Public because `ws/connection.ts`'s `target.probe` handler needs the
   * same number, and needed it badly. `target.probed.gen` is specified as
   * "the generation it was computed against" and was a hardcoded `0`. A
   * subscribed viewer never noticed, because it reads its generation off
   * `stream.subscribed` and its `nav.state`/`target.updated` updates and
   * never consults a probe for it. An `AutomationClient` has no
   * subscription at all: `AutomationCore.ensureGen()` uses `target.probe` as
   * its ONLY source of the generation and caches the answer permanently, so
   * one wrong reply poisoned every input message that client would ever
   * send for that target. `Stream.gen` seeds at 1, so `0` matched nothing,
   * and `resolveGenFencing` error-dropped every `mouse.down`.
   */
  currentGenFor(targetId: string): number {
    return this.session.streamHandleFor(targetId)?.stream.gen ?? 0;
  }

  /**
   * Runs `fn` while holding `targetId`'s control lease under the synthetic
   * REST viewer identity, then releases it again. `InputDispatcher`'s
   * `leaseId` fencing (`core/src/control/fencing.ts`) drops every non-release
   * input message that does not name the CURRENT holder's `leaseId`, and a
   * REST call has no standing lease of its own the way a connected viewer
   * does, so one is borrowed for the duration of this call only.
   *
   * `requestControl(..., { queue: false })` grants synchronously
   * (`ControlLeaseEngine.requestWhileUnheld` -> `grant()`, both synchronous)
   * whenever the target is currently unheld, which is the only case this
   * throws past. If a real viewer already holds the target, this refuses
   * outright rather than preempting a live session: REST driving shares the
   * same control model everyone else does, it does not override it.
   *
   * `leaseEngineFor(targetId).release()` awaits the same input-dispatcher
   * drain the normal handoff path does (`ControlLeaseEngine`'s own doc,
   * "step 2 of the handoff drain"), so this does not return until whatever
   * `fn` dispatched has actually reached CDP.
   */
  private async withRestControl<T>(
    targetId: string,
    fn: (leaseId: string) => Promise<T>,
  ): Promise<T> {
    this.requestControl(
      {
        viewerId: REST_VIEWER_ID,
        identity: REST_VIEWER_ID,
        label: 'REST',
        kind: 'agent',
        capabilities: ['control'],
        isAdmin: false,
      },
      targetId,
      { queue: false },
    );
    const engine = this.session.leaseEngineFor(targetId);
    // `holderFor(REST_VIEWER_ID)`, the engine's own per holder lookup, NOT
    // `getSnapshot().leaseId`.
    //
    // `Lease.leaseId` is a getter over `holders[0].leaseId`, the PRIMARY
    // holder's id, and shared mode mints one leaseId PER HOLDER precisely so
    // that one driver can be revoked without invalidating anybody else's
    // in-flight input. So on a shared target where a person was granted
    // first, `snapshot.leaseId` was the PERSON's id, and REST then stamped
    // it onto its own input. `resolveInputFencing` matches an inbound
    // `leaseId` against the sender's own holder record, so every one of
    // those messages was dropped as stale.
    //
    // The shape of that failure is what makes it urgent rather than tidy:
    // the REST caller gets a 200, the page does not move, and nothing is
    // logged, because `InputDispatcher` reports the drop through `onSignal`
    // and `core`'s `Session` wires `onSignal` to an empty function. It is
    // the "agent fills the form while a person watches" flow failing
    // silently, which is the exact use case shared control exists for.
    //
    // Not `lease-holders.ts`'s `isLeaseHolder` here, deliberately, even
    // though that module was built for this same question on the ws path.
    // It answers a BOOLEAN, and that module's own doc says why it must not
    // be stretched further: fencing is by leaseId, and a viewerId comparison
    // cannot express it. What this call site needs is the leaseId itself, so
    // it asks the engine for the holder record rather than approximating one.
    const holder = engine.holderFor(REST_VIEWER_ID);
    if (!holder) {
      throw new Error(`target ${targetId} is currently controlled by another viewer`);
    }
    const leaseId = holder.leaseId;
    try {
      return await fn(leaseId);
    } finally {
      // Announce a lease that moved out from under this call before
      // releasing it. Between the grant above and the dispatches inside
      // `fn`, the tenure can end for reasons that have nothing to do with
      // REST (an admin `control.revoke`, a capability shrink, idle expiry),
      // and every input dispatched after that point was silently discarded.
      // The caller has already been told the call succeeded, so this log
      // line is the ONLY trace such a drop leaves anywhere in the system.
      // Both lease ids are named because "which one did the server think was
      // current" is the first question anybody debugging this asks.
      const after = engine.holderFor(REST_VIEWER_ID);
      if (after?.leaseId !== leaseId) {
        this.logger?.error(
          { component: 'session' },
          `REST input on target ${targetId} may have been discarded: the lease it was authorised under (${leaseId}) is no longer current (now ${after?.leaseId ?? 'unheld'}). Input dispatched after the lease moved is dropped by leaseId fencing without an error.`,
        );
      }
      await engine.release(REST_VIEWER_ID, leaseId);
    }
  }

  /**
   * `RestSessionDriver.click`: a move to `(x, y)` (so a hover-triggered
   * element sees the pointer arrive before the press, matching a real
   * mouse), then a down and an up at the same point. Goes through
   * `core.Session.dispatchInput()`, the exact entry point a WS client's own
   * `input.mouse` messages take, rather than sending `Input.dispatchMouseEvent`
   * directly: `InputDispatcher`'s `held.buttons` bookkeeping (that module's
   * own doc: a move sent with `button: 'none'` while a button is held reads
   * to Chrome as a hover, never a drag, so click-drag would select no text
   * and drag no element) only applies to messages that actually pass
   * through `enqueue()`.
   *
   * `x`/`y` are real CSS page pixels; sending the queried live viewport as
   * both `fw`/`fh` (the frame space the coordinates were computed against)
   * and the fallback CDP viewport makes `transformPoint()`'s scale factor
   * exactly 1 when nothing else has set an emulated viewport, and the
   * correct real-to-emulated scale when something has.
   */
  async clickTarget(
    targetId: string,
    opts: { readonly x: number; readonly y: number; readonly button?: 'left' | 'middle' | 'right' },
  ): Promise<void> {
    const viewport = (await this.queryRealViewport(targetId)) ?? DEFAULT_VIEWPORT;
    const button = opts.button ?? 'left';
    await this.withRestControl(targetId, async (leaseId) => {
      const base = {
        targetId,
        fw: viewport.width,
        fh: viewport.height,
        gen: this.currentGenFor(targetId),
        leaseId,
        modifiers: 0,
        x: opts.x,
        y: opts.y,
      };
      // `awaitFull: true`: a REST caller getting a 200 back reasonably
      // expects the click to have actually reached CDP, not merely been
      // queued (see `InputDispatcher.performDispatch`'s doc, `core/src/input/dispatcher.ts`,
      // for why the WS streaming path deliberately does NOT wait here, and
      // why that default is safe to override only from a call site that
      // never round-trips through parsed wire JSON). Without it, this
      // method could resolve before `Input.dispatchMouseEvent` was ever
      // sent, which is exactly what `withRestControl`'s own doc promises
      // does not happen: it awaits `engine.release()`'s drain of this
      // target's dispatch chain, and that drain is only meaningful if the
      // chain itself does not move on until the send has completed.
      this.session.dispatchInput(
        REST_VIEWER_ID,
        { ...base, t: 'input.mouse', kind: 'move', button: 'none', buttons: 0 },
        { awaitFull: true },
      );
      this.session.dispatchInput(
        REST_VIEWER_ID,
        {
          ...base,
          t: 'input.mouse',
          kind: 'down',
          button,
          buttons: mouseButtonBit(button),
          clickCount: 1,
        },
        { awaitFull: true },
      );
      this.session.dispatchInput(
        REST_VIEWER_ID,
        { ...base, t: 'input.mouse', kind: 'up', button, buttons: 0, clickCount: 1 },
        { awaitFull: true },
      );
    });
  }

  /** `RestSessionDriver.type`: one `Input.insertText`, via `core.Session.dispatchInput()` for the same reason `clickTarget()` does not send CDP directly (consistency with the WS input path, not a load-bearing need `insertText` itself has). */
  async typeTarget(targetId: string, text: string): Promise<void> {
    const viewport = (await this.queryRealViewport(targetId)) ?? DEFAULT_VIEWPORT;
    await this.withRestControl(targetId, async (leaseId) => {
      this.session.dispatchInput(REST_VIEWER_ID, {
        t: 'input.text',
        targetId,
        fw: viewport.width,
        fh: viewport.height,
        gen: this.currentGenFor(targetId),
        leaseId,
        text,
      });
    });
  }

  /**
   * `RestSessionDriver.setInputFiles`: attaches already-staged uploads to
   * an `<input type="file">`, the server side of Playwright's
   * `set_input_files`.
   *
   * `files` are absolute paths on THIS machine, and every one of them was
   * produced by `UploadStore.pathFor(uploadId, tenantId)`. That is the
   * whole path safety story in one sentence: the caller named ids, the
   * store turned ids into paths it had itself composed, and this method
   * never sees, and has no parameter for, a path a caller chose. Callers
   * of this method must preserve that property; see
   * `files/upload-store.ts`'s interface doc for the full argument.
   *
   * Deliberately NOT wrapped in `withRestControl` the way `clickTarget`
   * and `typeTarget` are. That helper exists because `InputDispatcher`
   * fences every `input.*` message on the current lease id, so a REST
   * click has to borrow a lease to get through at all. This sends no
   * input: it is a `DOM.*` call, in the same class as `navigate()`, which
   * also mutates the page hard and also takes no lease. Making upload the
   * one driving verb that competes for a lease would be an inconsistency
   * with no safety gained, since a caller who can attach a file can
   * already navigate the page out from under a human anyway. The privilege
   * is gated where the others are gated, on a capability (`upload`).
   */
  async setInputFiles(targetId: string, selector: string, files: readonly string[]): Promise<void> {
    const handle = await this.ensureAttached(targetId);
    if (!handle) throw new Error(`target ${targetId} has no live CDP session`);
    await setFileInputFiles(this.bridge, handle.id, { selector, files });
  }

  /** `instance.restart`: delegates to `core.Session.restartInstance()`, which drives `SESSION_TRANSITIONS`/`RecoveryRunner`'s instance-scope single flight and emits `instance.restart.progress`/`instance.restart.result` through `onEffect` (this class's `dispatchEffect`, below), whichever way it resolves. Returns whether it actually succeeded, so `ws/connection.ts` can tell, instead of the client hanging silently on a failed restart. */
  async restartInstance(
    opts: { readonly reason?: string; readonly preserveProfile?: boolean } = {},
  ): Promise<boolean> {
    return this.session.restartInstance(opts);
  }

  reportSignal(targetId: string, signal: RecoverySignal): void {
    this.session.reportSignal(targetId, signal);
  }

  /**
   * Recomputes, for every attachment on `targetId`, whether that viewer is
   * currently a control-lease holder. Holding pins the attachment to tier 0
   * and floors its AIMD level, so whoever is actually driving gets the best
   * picture the link will carry.
   *
   * This replaced a `setLeaseHolder(targetId, viewerId | null)` that PATCHED
   * the flag from whichever lease effect had just been sent: `control.granted`
   * set the named viewer and cleared everybody else, `control.revoked`/
   * `control.preempted` cleared everybody. That is correct only while a
   * target can have at most one holder. Under shared control it is actively
   * wrong in both directions: granting B control of a target A is already
   * driving would have cleared A's flag and dropped A to the shared tier
   * mid-drag, and B releasing would have cleared A's flag too, so the
   * remaining driver's picture quality would depend on what some other
   * driver did.
   *
   * The fix is not a more careful patch, it is to stop patching. Holder-ness
   * is DERIVED state: the lease engine already knows the answer, so this
   * reads it back from the current snapshot instead of trying to replay the
   * event stream into a mirror of it. That is automatically correct for one
   * holder, for N holders, and for every effect type without this method
   * having to enumerate which effects imply which transition.
   *
   * Touches nothing on the wire, so it is safe to call at any point in a
   * lease effect's handling without disturbing the reply-then-broadcast
   * ordering `dispatchEffect` is careful about.
   */
  refreshLeaseHolders(targetId: string): void {
    const state = this.targetTier.get(targetId);
    if (!state) return;
    const snapshot = this.session.leaseEngineFor(targetId).getSnapshot();
    for (const [vid, att] of state.attachments) {
      att.isLeaseHolder = isLeaseHolder(snapshot, vid);
    }
  }

  // ── frame emission ───────────────────────────────────────────────────

  private async handleFrame(
    targetId: string,
    frame: RawFrame,
    seq: number,
    gen: number,
    tsDeltaMs: number,
  ): Promise<void> {
    const state = this.targetTier.get(targetId);
    if (!state || state.attachments.size === 0) return;

    const run = async (): Promise<void> => {
      // `interactive` drives adaptation and tier assignment, and excluding
      // synthetic attachments from BOTH is correct: a recorder pinned to a
      // fixed tier must never drag the quality ladder for a live viewer.
      //
      // It does NOT drive delivery. That distinction was collapsed here
      // once, and the effect was that a synthetic attachment received
      // nothing at all: the list was also used to build `entries`, and an
      // empty list returned early. A recording that stops the moment the
      // last human closes their tab is not a recording, so the guard below
      // asks whether anything is attached, not whether a human is.
      const all = [...state.attachments.values()];
      const interactive = all.filter((a) => !a.synthetic);
      const synthetic = all.filter((a) => a.synthetic);
      if (all.length === 0) return;
      const nowMono = monotonicNow();
      if (nowMono - state.lastAdaptiveStepMono >= 1000) {
        state.lastAdaptiveStepMono = nowMono;
        for (const att of interactive) {
          att.sampleBufferedBytes();
          adaptiveStep(att, nowMono, { isLeaseHolder: att.isLeaseHolder });
        }
      }
      const levels = state.tierAssigner.evaluate(interactive) as readonly LadderLevel[];
      const effectiveLevels = levels.length > 0 ? levels : [DEFAULT_LADDER_LEVEL];
      const encodeStartMono = monotonicNow();
      const built = await buildTierPayloads(frame, effectiveLevels, state.ownerViewport);
      state.encodeMsSamples.push(monotonicNow() - encodeStartMono);
      if (state.encodeMsSamples.length > ENCODE_SAMPLE_CAP) state.encodeMsSamples.shift();
      const entries: FanOutEntry[] = [
        ...interactive.map((attachment) => ({
          attachment,
          tierIndex: nearestTierIndex(effectiveLevels, attachment.desiredLevel),
        })),
        // A synthetic attachment carries its own pinned `tierIndex` and is
        // never reassigned, so it is clamped into the range actually built
        // this frame rather than re-derived from a `desiredLevel` it does
        // not adapt. Clamping matters because `effectiveLevels` shrinks
        // with the live viewer set, and an out of range index would read
        // `built[i]` as undefined.
        ...synthetic.map((attachment) => ({
          attachment,
          tierIndex: Math.min(Math.max(attachment.tierIndex, 0), effectiveLevels.length - 1),
        })),
      ];
      frameOutAttachments(entries, built, {
        gen16: gen & 0xffff,
        seq,
        tsDeltaMs,
        payloadCodec: frame.codec === 'png' ? 4 : 1,
        keyframe: frame.keyframe,
        thumbnail: false,
      });
    };

    // A rejection must not be swallowed into a second `run()` invocation
    // (an earlier draft of this chain passed `run` as both the fulfilled
    // and rejected handler to `.then()`, which silently re-ran it with an
    // `Error` in place of its expected no-argument call); one bad frame is
    // dropped, the chain keeps going for the next one.
    state.chain = state.chain.then(run).catch(() => undefined);
    await state.chain;
  }

  /**
   * Packages and sends one `stream.stats` message per live, non-synthetic
   * attachment across every target this session tracks, at
   * `DEFAULT_LIMITS.statsIntervalMs` cadence (the {@link statsTimer}
   * driving this). Every raw number this needs is already genuinely tracked (`core`'s `Attachment` and this
   * class's own `frame-pipeline.ts`-driven fan-out), just never packaged
   * into the wire message the protocol already defines; this method is
   * that missing packaging step, not a new measurement system. `fpsSent`,
   * `fpsDropped`, `bytesPerSec`, and `avgFrameBytes` are derived by diffing
   * `Attachment`'s cumulative counters (`sentCount`, `bytesSentTotal`,
   * `backpressureDropCount`) against the previous tick's reading
   * ({@link TargetTierState.statsPrev}) over the actually elapsed monotonic
   * time, so a slow tick (GC pause, event-loop backlog) still reports a
   * correct rate rather than assuming exactly `statsIntervalMs` passed.
   * `backlog`, `bufferedBytes` (`bufferedBytesEma`), and `rttMs`
   * (`ackRttEmaMs`) are read live, no diffing needed. `encodeMsP50`/`P95`
   * come from {@link TargetTierState.encodeMsSamples}, the one counter that
   * did not already exist anywhere (`handleFrame` now times its own
   * `buildTierPayloads` call to populate it). A first-ever tick for a
   * brand new attachment has no prior reading to diff against and reports
   * `0` for every rate field rather than a spurious since-creation total.
   */
  private emitStreamStats(): void {
    if (this.connections.size === 0) return;
    const nowMono = monotonicNow();
    for (const state of this.targetTier.values()) {
      if (state.attachments.size === 0) continue;
      const { p50: encodeMsP50, p95: encodeMsP95 } = encodePercentiles(state.encodeMsSamples);
      for (const [viewerId, att] of state.attachments) {
        if (att.synthetic) continue;
        const sink = this.connections.get(viewerId);
        if (!sink || !sink.isOpen()) continue;

        const prev = state.statsPrev.get(viewerId);
        let fpsSent = 0;
        let fpsDropped = 0;
        let bytesPerSec = 0;
        let avgFrameBytes = 0;
        if (prev) {
          const elapsedSec = Math.max(0.001, (nowMono - prev.mono) / 1000);
          const sentDelta = Math.max(0, att.sentCount - prev.sentCount);
          const bytesDelta = Math.max(0, att.bytesSentTotal - prev.bytesSentTotal);
          fpsSent = sentDelta / elapsedSec;
          fpsDropped =
            Math.max(0, att.backpressureDropCount - prev.backpressureDropCount) / elapsedSec;
          bytesPerSec = bytesDelta / elapsedSec;
          avgFrameBytes = sentDelta > 0 ? bytesDelta / sentDelta : 0;
        }
        state.statsPrev.set(viewerId, {
          mono: nowMono,
          sentCount: att.sentCount,
          bytesSentTotal: att.bytesSentTotal,
          backpressureDropCount: att.backpressureDropCount,
        });

        sink.sendEnvelope({
          t: 'stream.stats',
          streamId: att.streamId,
          fpsSent,
          fpsDropped,
          bytesPerSec,
          avgFrameBytes,
          backlog: att.backlog,
          bufferedBytes: att.bufferedBytesEma,
          encodeMsP50,
          encodeMsP95,
          rttMs: att.ackRttEmaMs,
          quality: state.qualityProfiles.get(viewerId) ?? 'auto',
          codec: 'jpeg',
        });
      }
    }
  }

  /** Called after a recovery rung or resume bumps `gen`: resets every attachment's AIMD cooldown so the climb-back starts clean. */
  resetAdaptiveForTarget(targetId: string): void {
    const state = this.targetTier.get(targetId);
    if (!state) return;
    const nowMono = monotonicNow();
    for (const att of state.attachments.values()) resetForNewGeneration(att, nowMono);
  }

  /** Broadcasts one wire envelope to every currently connected viewer. */
  broadcast(env: Record<string, unknown> & { readonly t: string }): void {
    for (const conn of this.connections.values()) conn.sendEnvelope(env);
  }

  /**
   * How each {@link InputSignal} is reported: what to call it in a log, how
   * loudly, and which wire error (if any) the offending viewer is told
   * about.
   *
   * The four drop reasons map to four different codes on purpose. A caller
   * debugging "my clicks do nothing" gets a different instruction from each:
   * a stale generation means re-read the generation (from `stream.subscribed`
   * or `target.probed`), a denied fence with no lease means ask for control
   * first, a denied fence with the wrong id means use the newest
   * `control.granted`, and a malformed message means fix the payload. One
   * shared "input was dropped" code would have answered none of them.
   */
  private inputSignalReport(signal: InputSignal): {
    readonly level: 'debug' | 'warn' | 'error';
    readonly detail: string;
    readonly wireCode: string | null;
    readonly retryable?: boolean;
  } {
    switch (signal.kind) {
      case 'gen_stale':
        return {
          level: 'warn',
          detail: `stale target generation (expected ${signal.expectedGen}, received ${signal.receivedGen})`,
          wireCode: 'bgls.error.input.gen_stale',
        };
      case 'fence_denied':
        // `expectedLeaseId === null` means this viewer holds no lease on
        // this target at all, which is a different fault from holding one
        // and naming an outdated id, and the two need different advice.
        return signal.expectedLeaseId === null
          ? {
              level: 'warn',
              detail: `no control lease held (received leaseId ${signal.receivedLeaseId}, reason ${signal.reason})`,
              wireCode: 'bgls.error.control.not_held',
            }
          : {
              level: 'warn',
              detail: `lease id is not current (expected ${signal.expectedLeaseId}, received ${signal.receivedLeaseId}, reason ${signal.reason})`,
              wireCode: 'bgls.error.control.lease_stale',
            };
      case 'validation_error':
        return {
          level: 'warn',
          detail: `malformed input: ${signal.field}: ${signal.message}`,
          wireCode: 'bgls.error.input.malformed',
        };
      case 'queue_shed':
        // Not a fault. Debug so it is countable when somebody is looking at
        // a stuttering drag, and silent otherwise.
        return {
          level: 'debug',
          detail: `move shed under backpressure (chain depth ${signal.depth} over ${signal.maxDepth})`,
          wireCode: null,
        };
      case 'rate_limited':
        // The connection level limiter in `ws/connection.ts` already replies
        // to the client with a proper `retryAfterMs`; this is `core`'s own
        // second layer and would be a duplicate on the wire.
        return {
          level: 'debug',
          detail: `input rate limited (retry after ${signal.retryAfterMs}ms)`,
          wireCode: null,
        };
      case 'rate_limit_escalate':
        return {
          level: 'warn',
          detail: 'input rate limit escalated after sustained overrun',
          wireCode: null,
        };
      case 'dispatch_error':
        // Unlike an unattributed background CDP failure, `InputDispatcher`
        // now only raises this for a SPECIFIC viewer's OWN input message
        // (`packages/core/src/input/dispatcher.ts`'s `InputSignal.dispatch_error`
        // doc): either it never reached CDP within `sessionLookupTimeoutMs`,
        // or its send settled with an error after a raced dispatch had
        // already moved the chain on. Both are the exact "keystroke
        // silently vanished" shape a caller CAN act on (resend the input),
        // which is why this is put on the wire, unlike the other three
        // `wireCode: null` cases above that are either background noise or
        // already answered elsewhere. `retryable: true` because resending
        // the very same input is the actual fix here, the one case among
        // these four where that is true.
        return {
          level: 'error',
          detail: `CDP dispatch failed: ${signal.error instanceof Error ? signal.error.message : String(signal.error)}`,
          wireCode: 'bgls.error.input.dispatch_failed',
          retryable: true,
        };
    }
  }

  /**
   * Logs one dropped input and, for the reasons a client can actually act
   * on, tells that client once per {@link INPUT_SIGNAL_COALESCE_MS}.
   *
   * See `dispatchEffect`'s `input.signal` case for why this coalesces rather
   * than reporting every occurrence.
   */
  private reportInputSignal(signal: InputSignal): void {
    const viewerId = 'viewerId' in signal ? signal.viewerId : 'unknown';
    const report = this.inputSignalReport(signal);
    const key = `${viewerId}\0${signal.targetId}\0${signal.kind}\0${report.wireCode ?? ''}`;
    const nowMono = monotonicNow();
    const seen = this.inputSignalCoalesce.get(key);

    if (seen !== undefined && nowMono - seen.lastReportedMono < INPUT_SIGNAL_COALESCE_MS) {
      seen.suppressed += 1;
      return;
    }
    // The count of everything swallowed since the last line is carried on
    // the line that does get written, so a flood is still visible as a
    // flood rather than looking like a single stray event.
    const suppressed = seen?.suppressed ?? 0;
    this.inputSignalCoalesce.set(key, { lastReportedMono: nowMono, suppressed: 0 });

    const suffix =
      suppressed > 0
        ? ` (${suppressed} further occurrences suppressed in the last ${INPUT_SIGNAL_COALESCE_MS}ms)`
        : '';
    const line = `input dropped for viewer ${viewerId} on target ${signal.targetId}: ${report.detail}${suffix}`;
    if (report.level === 'error') this.logger?.error({ component: 'session' }, line);
    else if (report.level === 'warn') this.logger?.warn({ component: 'session' }, line);
    else this.logger?.debug({ component: 'session' }, line);

    if (report.wireCode === null) return;
    const sink = this.connections.get(viewerId);
    if (!sink?.isOpen()) return;
    // No `re`: input messages carry no `id` to correlate against, so this is
    // an uncorrelated push by necessity. `report.retryable` defaults to
    // false: `gen_stale`/`fence_denied` are not fixed by sending the same
    // message again, each needs the client to read a fresh value first.
    // `dispatch_error` is the one case that IS: see its own case in
    // `inputSignalReport` above.
    sink.sendEnvelope({
      t: 'error',
      code: report.wireCode,
      category: report.wireCode.startsWith('bgls.error.control.') ? 'control' : 'input',
      message: report.detail,
      fatal: false,
      retryable: report.retryable ?? false,
      context: { targetId: signal.targetId },
    });
  }

  /**
   * Fires `onRecovery`, non-vetoing (`HOOK_TIMEOUTS.onRecovery`,
   * `hooks/types.ts`) so this is a pure fire-and-forget: any failure or
   * timeout is already caught, logged, and swallowed inside
   * `HookRegistry.dispatch` itself, never rethrown here, and this method
   * is called from `dispatchEffect`, which is synchronous and must stay
   * that way (see that method's own doc: it is the direct callback
   * `core.Session`'s `emit` invokes). `rung`/`coreRung` is `RecoveryRung`
   * (the string `'R0'`-`'R4'` `core` and the wire both use) narrowed by
   * {@link RECOVERY_RUNG_TO_NUMBER}/{@link RECOVERY_RUNG_TO_NAME}; a rung
   * this build never produces (`'R5'`/`'R6'`) is dropped rather than
   * guessed, since `HookEventBase`'s `rung`/`rungName` fields have no
   * `undefined` case to report it honestly through.
   */
  private fireRecovery(
    coreRung: string,
    trigger: RecoveryEvent['trigger'],
    attempt: number,
    succeeded: boolean | null,
    detail: string,
  ): void {
    if (!this.hooks) return;
    const rung = RECOVERY_RUNG_TO_NUMBER[coreRung];
    const rungName = RECOVERY_RUNG_TO_NAME[coreRung];
    if (rung === undefined || rungName === undefined) return;
    const event: RecoveryEvent = {
      at: Date.now(),
      tenantId: this.tenantId,
      appId: this.appId,
      requestId: newId('evt'),
      instanceId: this.instanceId,
      sessionId: this.sessionId,
      rung,
      rungName,
      trigger,
      attempt,
      succeeded,
      detail,
    };
    void this.hooks.dispatch('onRecovery', event);
  }

  /**
   * Translates one `core.Session` effect into the wire message(s) it
   * implies, and sends them directly to the relevant connection(s). This is
   * the wiring of `Session` events to the wire: `core` produces typed
   * effects and knows nothing about sockets; this method is where they
   * become real outbound frames.
   */
  private dispatchEffect(effect: SessionEffect): void {
    switch (effect.kind) {
      case 'lease': {
        const leaseEffect = effect.effect;
        // `LeaseEffectTarget` (`LeaseDirectEffect.to`) is a plain `string`,
        // not narrowed to exclude the literal `'broadcast'`, so a
        // `to === 'broadcast'` check does not discriminate this union for
        // TypeScript; `'forViewer' in leaseEffect` does.
        if ('forViewer' in leaseEffect) {
          for (const [viewerId, conn] of this.connections) {
            conn.sendEnvelope(
              leaseEffect.forViewer(viewerId) as unknown as Record<string, unknown> & { t: string },
            );
          }
        } else {
          const conn = this.connections.get(leaseEffect.to);
          conn?.sendEnvelope(
            leaseEffect.message as unknown as Record<string, unknown> & { t: string },
          );
        }
        // Recomputed from the engine's own snapshot for EVERY lease effect,
        // broadcast and direct alike, rather than being patched from the
        // three message types (`control.granted`, `control.revoked`,
        // `control.preempted`) this used to enumerate. See
        // `refreshLeaseHolders()` for why deriving beats patching once a
        // target can have several holders at once. It runs after the
        // envelope is on the wire, not before, purely to keep this block's
        // one and only send at the top where it is easy to see; the call
        // itself produces no outbound traffic, so neither order is
        // observable to a client.
        this.refreshLeaseHolders(effect.targetId);
        this.broadcastPresence();
        break;
      }
      /**
       * One input message that did not reach CDP.
       *
       * Before this case existed the entire class was silent: `core`'s
       * `Session` wired `InputDispatcher.onSignal` to an empty function, so
       * a dropped input produced no error reply, no wire traffic and no log
       * line, and `bgls.error.input.gen_stale` sat in the error registry
       * having never been emitted by anything. Three separate defects that
       * stopped automation input dead were invisible for exactly that
       * reason, and the e2e suite took three failing cases to find one of
       * them by elimination.
       *
       * ── Why not simply send every drop to the wire ──
       *
       * Because a legitimate control handoff produces a burst of them. The
       * departing driver's in-flight `mouse.move`s are all `stale_lease` by
       * the time they arrive, and at input rates that is a few hundred a
       * second. Turning each into an `error` frame would put more traffic on
       * the socket than the input did, on precisely the socket already busy
       * carrying video, which is the same shape as the ack-limiter stall
       * recorded in `wire/rate-limit.ts`. Input messages also carry no `id`
       * (the client sends them with `trySend`, never `request()`), so there
       * is nothing to correlate an error against: it would arrive as an
       * uncorrelated frame the client can only log.
       *
       * So: LOG every drop, COALESCE both the log and the wire error to one
       * per `(viewer, target, code)` per {@link INPUT_SIGNAL_COALESCE_MS},
       * and carry a suppressed count so the volume stays visible in the one
       * line that does get written. A 300/sec flood becomes one line and one
       * frame every five seconds.
       *
       * `gen-fencing.ts`'s own doc already specified this shape ("signals a
       * throttled `bgls.error.input.gen_stale`"), so the throttled wire
       * error is the design as written, not an invention here. It was simply
       * never implemented.
       *
       * ── What deliberately never reaches the wire ──
       *
       * `queue_shed` is normal backpressure, not a fault: the cursor has
       * moved on and the shed frame would have been overwritten before it
       * painted. `rate_limited` is already answered by the connection level
       * limiter in `ws/connection.ts`, which replies properly with a
       * `retryAfterMs`. `dispatch_error` is a CDP failure, which is the
       * server's problem and not something the client can act on. All three
       * are logged and none is sent.
       */
      case 'input.signal': {
        this.reportInputSignal(effect.signal);
        break;
      }
      case 'recovery.progress': {
        const e = effect.event;
        this.broadcast({
          t: 'instance.recovering',
          instanceId: this.instanceId,
          rung: e.rung,
          signal: RECOVERY_SIGNAL_TO_WIRE[e.signal],
          attempt: e.attempt,
          estimatedMs: e.etaMs,
          message: `Recovering (${e.signal}), rung ${e.rung}, attempt ${e.attempt} of ${e.of}.`,
        });
        this.fireRecovery(
          e.rung,
          RECOVERY_SIGNAL_TO_TRIGGER[e.signal],
          e.attempt,
          null,
          `Recovering (${e.signal}), rung ${e.rung}, attempt ${e.attempt} of ${e.of}.`,
        );
        break;
      }
      case 'recovery.recovered': {
        const e = effect.event;
        this.resetAdaptiveForTarget(e.targetId);
        this.broadcast({
          t: 'instance.recovered',
          instanceId: this.instanceId,
          rung: e.rung,
          durationMs: 0,
          targetsPreserved: true,
          streamsResubscribed: [],
          streamsLost: [],
        });
        // `RecoveredEvent` carries no `attempt` of its own (`core/src/recovery/types.ts`);
        // `1` is reported rather than a fabricated count, since this is the
        // rung that actually confirmed the target live again, not
        // necessarily the first attempt at it.
        this.fireRecovery(
          e.rung,
          RECOVERY_SIGNAL_TO_TRIGGER[e.signal],
          1,
          true,
          `Recovered target ${e.targetId} at rung ${e.rung}.`,
        );
        break;
      }
      case 'recovery.unrecoverable': {
        // No message of its own: the accompanying `close_all_viewers` effect
        // (always emitted alongside this one by `core.Session`) is what
        // actually notifies viewers, via `goodbye` plus close `4004`.
        const e = effect.event;
        const lastRung = e.triedRungs[e.triedRungs.length - 1] ?? 'R0';
        this.fireRecovery(
          lastRung,
          RECOVERY_SIGNAL_TO_TRIGGER[e.signal],
          e.triedRungs.length,
          false,
          `Every recovery rung failed for target ${e.targetId} (tried ${e.triedRungs.join(', ')}).`,
        );
        break;
      }
      case 'notice': {
        const n = effect.notice;
        if (n.kind === 'session.expiring') {
          this.broadcast({
            t: 'error',
            code: 'bgls.error.instance.session_expiring',
            category: 'instance',
            message: `Session expiring (${n.reason}) in ${n.inMs}ms.`,
            fatal: false,
            retryable: false,
            context: { reason: n.reason, inMs: n.inMs },
          });
        } else if (n.kind === 'session.draining') {
          this.broadcast({
            t: 'error',
            code: 'bgls.error.instance.session_draining',
            category: 'instance',
            message: 'The server is draining this session.',
            fatal: false,
            retryable: false,
            context: { deadlineMs: n.deadlineMs, willRelocate: n.willRelocate },
          });
        } else {
          this.broadcast({
            t: 'error',
            code: 'bgls.error.instance.stream_rebound',
            category: 'instance',
            message: 'A stream was rebound to a newly recreated target.',
            fatal: false,
            retryable: false,
            context: {
              streamId: n.streamId,
              oldTargetId: n.oldTargetId,
              newTargetId: n.newTargetId,
            },
          });
        }
        break;
      }
      case 'close_viewer': {
        const conn = this.connections.get(effect.viewerId);
        conn?.sendEnvelope(buildGoodbye(effect.code, effect.reason));
        conn?.close(effect.code, effect.reason);
        break;
      }
      case 'close_all_viewers': {
        for (const conn of this.connections.values()) {
          conn.sendEnvelope(buildGoodbye(effect.code, effect.reason));
          conn.close(effect.code, effect.reason);
        }
        break;
      }
      case 'instance.restart.progress': {
        this.broadcast({
          t: 'instance.recovering',
          instanceId: this.instanceId,
          rung: 'R4',
          signal: 'manual',
          attempt: effect.attempt,
          estimatedMs: null,
          message: 'Restarting the instance (manual).',
        });
        this.fireRecovery(
          'R4',
          'manual',
          effect.attempt,
          null,
          'Restarting the instance (manual).',
        );
        break;
      }
      case 'instance.restart.result': {
        this.applyRestartResult(effect.result);
        this.fireRecovery(
          'R4',
          'manual',
          1,
          effect.result.ok,
          effect.result.ok
            ? 'instance.restart succeeded.'
            : 'instance.restart failed: the browser could not be relaunched.',
        );
        break;
      }
      case 'diagnostics.console': {
        const e = effect.entry;
        this.deliverDiagnostics(effect.targetId, {
          t: 'console.entry',
          targetId: effect.targetId,
          level: e.level,
          // UNTRUSTED page content (the module doc on `wire/sanitize.ts` names `console.entry.text` by
          // name as one of its byte-capped fields).
          text: sanitizeConsoleText(e.text),
          ...(e.url !== undefined ? { url: sanitizeUrl(e.url) } : {}),
          ...(e.line !== undefined ? { line: e.line } : {}),
          ...(e.column !== undefined ? { column: e.column } : {}),
          ...(e.stack !== undefined ? { stack: e.stack } : {}),
          count: e.count,
        });
        break;
      }
      case 'diagnostics.pageError': {
        const e = effect.entry;
        this.deliverDiagnostics(effect.targetId, {
          t: 'page.error',
          targetId: effect.targetId,
          name: e.name,
          // Also page-derived, same reasoning as `console.entry.text` above.
          message: sanitizeMessage(e.message),
          ...(e.stack !== undefined ? { stack: e.stack } : {}),
          ...(e.url !== undefined ? { url: sanitizeUrl(e.url) } : {}),
        });
        break;
      }
      case 'diagnostics.networkRequest': {
        const e = effect.entry;
        this.deliverDiagnostics(effect.targetId, {
          t: 'network.request',
          targetId: effect.targetId,
          requestId: e.requestId,
          method: e.method,
          // `url` is UNTRUSTED per the doc comment on `NetworkRequestEntry`.
          url: sanitizeUrl(e.url),
          resourceType: e.resourceType,
          status: e.status,
          errorText: e.errorText,
          fromCache: e.fromCache,
          durationMs: e.durationMs,
          encodedBytes: e.encodedBytes,
          startedAt: e.startedAt,
        });
        break;
      }
      case 'diagnostics.networkSummary': {
        const e = effect.entry;
        this.deliverDiagnostics(effect.targetId, {
          t: 'network.summary',
          targetId: effect.targetId,
          windowMs: e.windowMs,
          requests: e.requests,
          failed: e.failed,
          bytesIn: e.bytesIn,
          bytesOut: e.bytesOut,
          // Every `slowest[].url` is UNTRUSTED, same as `NetworkSummary`'s
          // existing wire doc already says for this field.
          slowest: e.slowest.map((s) => ({ ...s, url: sanitizeUrl(s.url) })),
          // The one GAUGE on this message, and the only field that answers
          // "is the page busy right now". Every other counter here is a
          // total for the window, and every other `network` signal fires on
          // a TERMINAL outcome, so without this a caller could see what had
          // ended and never what had started.
          //
          // Forwarded rather than recomputed: `core`'s `TargetDiagnostics`
          // owns the in-flight count (it already tracked it in
          // `pendingRequests` for terminal-event correlation) and clears it
          // on `rebind`, which is load bearing. A renderer swap kills the
          // CDP session, so a request that started under the dead renderer
          // can never receive its terminal event; carrying it across would
          // pin the count above zero and leave
          // `AutomationClient.waitForNetworkIdle()` hanging forever.
          //
          // Omitted rather than defaulted to 0 when core did not report
          // one. A client must be able to tell "nothing in flight" from
          // "this server does not report it", because reading an absent
          // field as idle resolves the wait on a page that is still
          // loading.
          ...(e.inFlight !== undefined ? { inFlight: e.inFlight } : {}),
        });
        break;
      }
      case 'download.started': {
        const e = effect.entry;
        // Tracked so `download.completed` (which core reports with no
        // `url` of its own) can still fill `DownloadEvent.sourceUrl`; see
        // `downloadStarted`'s own doc.
        this.downloadStarted.set(e.downloadId, { url: e.url, suggestedName: e.suggestedName });
        const suggestedName = sanitizeSuggestedName(e.suggestedName) ?? 'download';
        this.deliverDownload({
          t: 'download.started',
          downloadId: e.downloadId,
          targetId: effect.targetId,
          suggestedName,
          mime: guessMimeType(suggestedName),
          // CDP's `Browser.downloadWillBegin` carries no size at all; see
          // `MIME_BY_EXTENSION`'s doc for the matching gap on `mime`. A
          // later `download.progress` (below) carries the real total the
          // first time Chrome itself knows it.
          totalBytes: null,
          url: sanitizeUrl(e.url),
        });
        break;
      }
      case 'download.progress': {
        const e = effect.entry;
        this.deliverDownload({
          t: 'download.progress',
          downloadId: e.downloadId,
          receivedBytes: e.receivedBytes,
          totalBytes: e.totalBytes,
        });
        break;
      }
      case 'download.completed': {
        // Hashing and firing `onDownload` are both async; `dispatchEffect`
        // itself is not, matching `disableRequestGate`'s own fire-and-forget
        // precedent elsewhere in this class. `finalizeDownload` never
        // throws past its own try/catch, so this `.catch` only guards
        // against a genuinely unexpected bug, not an ordinary failure path.
        void this.finalizeDownload(effect.targetId, effect.entry).catch((err: unknown) => {
          this.logger?.error(
            {
              component: 'server',
              targetId: effect.targetId,
              error: err instanceof Error ? err.message : String(err),
            },
            'finalizeDownload threw',
          );
        });
        break;
      }
      case 'download.failed': {
        const e = effect.entry;
        this.downloadStarted.delete(e.downloadId);
        this.deliverDownload({ t: 'download.failed', downloadId: e.downloadId, reason: e.reason });
        break;
      }
    }
  }

  /**
   * Finishes what `dispatchEffect`'s `'instance.restart.result'` case
   * starts: on success, adopts the fresh `bridge`/`registry` `core.Session`
   * already swapped into itself, rebinds every surviving target's tier
   * state and stream subscriptions onto their new target ids (or drops them
   * if lost), and broadcasts the real `instance.recovered` this build
   * previously never sent for a manual restart. On failure, broadcasts a
   * real `error` instead of hanging silently.
   */
  private applyRestartResult(result: InstanceRestartResult): void {
    if (!result.ok) {
      this.broadcast({
        t: 'error',
        code: 'bgls.error.instance.unrecoverable',
        category: 'instance',
        message: 'instance.restart failed: the browser could not be relaunched.',
        fatal: false,
        retryable: true,
      });
      return;
    }

    this.bridge = result.bridge;
    this.registry = result.registry;
    // The old bridge died with the old browser process too: every cached
    // capture's `DOM.documentUpdated`/`Page.frameNavigated` subscription was
    // bound to it, and a `backendNodeId`/epoch minted against the dead
    // browser names nothing in the new one, so a survivor entry could not
    // be adopted, only correctly discarded. `dispose()` tears down its (now
    // moot) subscriptions before the fresh, empty cache replaces it, which
    // is honest: the next `page.map.stamp` for any target sees a genuine
    // cache miss and is refused as stale rather than validated against a
    // capture from a browser process that no longer exists.
    this.pageMapCache.dispose();
    this.pageMapCache = new PageMapCache(this.bridge);
    // The old registry died with the old browser process; its listeners
    // must be moved onto the fresh one or every viewer's tab strip stops
    // updating the moment an instance is restarted.
    this.wireTargetLifecycle();

    const streamsResubscribed: number[] = [];
    for (const rebind of result.targetRebinds) {
      this.rebindTargetTier(rebind.oldTargetId, rebind.newTargetId, streamsResubscribed);
    }
    const streamsLost: number[] = [];
    for (const oldTargetId of result.targetsLost) {
      streamsLost.push(...this.dropTargetTier(oldTargetId));
    }

    this.broadcast({
      t: 'instance.recovered',
      instanceId: this.instanceId,
      rung: 'R4',
      durationMs: result.durationMs,
      targetsPreserved: result.targetsLost.length === 0,
      streamsResubscribed,
      streamsLost,
    });
  }

  /**
   * Moves `oldTargetId`'s `TargetTierState` (attachments, tier assigner,
   * viewport, quality profiles, everything) to `newTargetId`, repoints
   * every `streamIndex` entry that named `oldTargetId`, forces a fresh
   * frame on the new target so a viewer's canvas is never left blank
   * post-restart, and sends each affected attachment a `stream.subscribed`
   * (bumped `sidEpoch`, matching `reconfigureStream()`'s own pattern) so
   * the client's own target bookkeeping follows the rebind. Appends every
   * rebound `streamId` to `resubscribed`.
   */
  private rebindTargetTier(oldTargetId: string, newTargetId: string, resubscribed: number[]): void {
    const state = this.targetTier.get(oldTargetId);
    if (state) {
      this.targetTier.delete(oldTargetId);
      this.targetTier.set(newTargetId, state);
    }
    this.knownTargetIds.delete(oldTargetId);
    this.knownTargetIds.add(newTargetId);

    for (const byStream of this.streamIndex.values()) {
      for (const [streamId, targetId] of byStream) {
        if (targetId === oldTargetId) {
          byStream.set(streamId, newTargetId);
          resubscribed.push(streamId);
        }
      }
    }

    if (!state) return;
    const handle = this.session.streamHandleFor(newTargetId);
    void handle?.forceFrame().catch(() => false);
    for (const [viewerId, att] of state.attachments) {
      const sink = this.connections.get(viewerId);
      if (!sink) continue;
      sink.sendEnvelope({
        t: 'stream.subscribed',
        streamId: att.streamId,
        targetId: newTargetId,
        quality: state.qualityProfiles.get(viewerId) ?? 'auto',
        codec: 'jpeg',
        fps: 30,
        width: state.ownerViewport.width,
        height: state.ownerViewport.height,
        dpr: 1,
        paused: false,
        sidEpoch: handle?.stream.sidEpoch ?? 0,
        gen: handle?.stream.gen ?? 1,
      });
    }
  }

  /** `oldTargetId` has no successor in the relaunched browser: drops its tier state and every `streamIndex` entry that named it, returning the `streamId`s that are now genuinely gone (for `instance.recovered`'s `streamsLost`). The viewer is left subscribed to nothing for that stream; it must issue a fresh `stream.subscribe` against a surviving target itself. */
  private dropTargetTier(oldTargetId: string): number[] {
    const lost: number[] = [];
    this.targetTier.delete(oldTargetId);
    this.knownTargetIds.delete(oldTargetId);
    for (const byStream of this.streamIndex.values()) {
      for (const [streamId, targetId] of [...byStream]) {
        if (targetId === oldTargetId) {
          byStream.delete(streamId);
          lost.push(streamId);
        }
      }
    }
    return lost;
  }
}

function nearestTierIndex(levels: readonly LadderLevel[], desired: LadderLevel): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levels.length; i += 1) {
    const dist = Math.abs((levels[i] as number) - desired);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Mints a fresh `vwr_` id. Re-exported so `ws/connection.ts` never needs a second `@browserglass/protocol` import purely for this. */
export function newViewerId(): string {
  return newId('vwr');
}
