import type {
  A11yNode,
  Capability,
  EvaluateWorld,
  PageMapDegradation,
  PageMapEpoch,
  PageMapInclude,
  PageMapNode,
  PageMapStampResult,
  PageMapTextBlock,
  PageMapTruncationReason,
  PdfPaperFormat,
  ProbeDetail,
  ProbeRect,
  RecoveryRung,
  TargetSummary,
} from '@browserglass/protocol';
export type { RecordingSummary } from '@browserglass/protocol';
import type { WebSocketConstructorLike } from '@browserglass/client';
import type { AutomationError, AutomationErrorCode } from './errors.js';

/**
 * Constructor options for {@link AutomationClient.connect}. `instanceId`/`targetId` are
 * validated against the connected session rather than sent on the wire:
 * `hello` carries no instance-selection field in this build's protocol, so
 * the token's own scope is what actually pins the instance server side.
 */
export interface AutomationClientOptions {
  /** Gateway base URL, e.g. `wss://host/browserglass/socket`. */
  endpoint: string;
  /** JWT with at least `automation` and `view`. */
  token: string;
  /** Validated against `welcome.instance.instanceId` once connected; a mismatch throws `INSTANCE_GONE`. */
  instanceId?: string;
  /** Defaults to the instance's active target. */
  targetId?: string;
  /** Default 15000. */
  defaultTimeoutMs?: number;
  /** Default `Infinity`. */
  stepBudget?: number;
  /** Validate and log, do not execute (Input.* dispatch is skipped; reads and navigation still happen). */
  dryRun?: boolean;
  /** Reserved: no wire message carries a confirmation request in this build pass. Accepted and typed for forward compatibility, never invoked. */
  onConfirm?: ConfirmHook;
  /** Fires after every action attempt, success or failure. */
  onAction?: (rec: ActionRecord) => void;
  /** How this client stands down when a human (or a higher-priority agent) asks for control back. See {@link YieldPolicy}; the default is the right behaviour for almost every agent. */
  yieldPolicy?: YieldPolicy;
  /** Socket-layer tuning, mirroring `BrowserGlassClientOptions.transport`. `WebSocketImpl` lets a test inject a scripted fake; production Node use relies on Node 22's global `WebSocket`. */
  transport?: { WebSocketImpl?: WebSocketConstructorLike };
}

/** A sensitive-action confirmation hook. See {@link AutomationClientOptions.onConfirm}: reserved, not wired in this build pass. */
export type ConfirmHook = (req: ConfirmRequest) => Promise<ConfirmDecision>;

/** The (currently unused) confirmation request shape, typed for forward compatibility. */
export interface ConfirmRequest {
  runId: string;
  action: string;
  sensitivity: 'normal' | 'sensitive' | 'blocked';
  reasons: string[];
  summary: string;
  args: Record<string, unknown>;
  expiresAt: number;
}

/** The (currently unused) confirmation decision shape, typed for forward compatibility. */
export interface ConfirmDecision {
  allow: boolean;
  remember?: boolean;
  note?: string;
}

/** One recorded action attempt, passed to {@link AutomationClientOptions.onAction}. */
export interface ActionRecord {
  action: string;
  targetId: string;
  args?: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: { code: AutomationErrorCode; message: string };
}

/**
 * One file for {@link AutomationClient.setInputFiles}.
 *
 * Bytes and a name, not a path, because the caller's filesystem is not the
 * browser's: see that method's own doc for the whole reasoning. `name` is
 * what the page's `File.name` reports, subject to the gateway's filename
 * sanitiser, and the sanitised form is what `setInputFiles` returns.
 */
export interface UploadFileInput {
  /** The filename the page should see, e.g. `'invoice.pdf'`. */
  name: string;
  /** The file's contents. */
  data: Uint8Array;
  /** MIME type, default `'application/octet-stream'`. Advisory: the page reads `File.type` from it, nothing enforces it. */
  mime?: string;
}

/** Options for {@link AutomationClient.acquireControl}. */
export interface AcquireControlOptions {
  /** Default 30000; `0` fails immediately if busy rather than queueing. */
  waitMs?: number;
  /** Default 60000. The server clamps to policy (120000 for an automation holder). */
  durationMs?: number;
  /** Default `true`. Automation lease priority is fixed at 50 (humans hold 100). */
  autoRenew?: boolean;
  /** Shown to a human viewer in the takeover prompt. */
  reason?: string;
}

/**
 * A held ControlLease. `priority` is fixed at 50 for every automation
 * holder (the per-holder-kind default); the wire's `control.granted`
 * carries no priority field of its own.
 */
export interface ControlLeaseHandle {
  readonly leaseId: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly priority: number;
  /** Subscribes to preemption step 1 (the lease is still held during the grace); returns its own unsubscribe. */
  onPreemptionRequested(cb: (req: PreemptionRequest) => void): () => void;
  /** Subscribes to the lease actually ending, for any reason; returns its own unsubscribe. */
  onRevoked(cb: (reason: RevokeReason) => void): () => void;
  renew(ms?: number): Promise<void>;
  release(): Promise<void>;
}

/** Preemption step 1: `control.preempt.request`. The lease is still held; input still dispatches until `deadline`. */
export interface PreemptionRequest {
  targetId: string;
  byLabel: string;
  /** Resolved from the last `presence.state` roster; `'human'` when the requester is not yet known in presence. */
  byKind: 'human' | 'automation';
  reason: 'priority' | 'force_claim' | 'human_takeover';
  /** 2000 for an automation holder by default. */
  graceMs: number;
  /** Wall-clock Unix ms, authoritative over `graceMs`. */
  deadline: number;
}

/**
 * Why a lease ended, surfaced to {@link ControlLeaseHandle.onRevoked}.
 *
 * `preempted_by_agent` distinguishes "another automation holder outranked
 * me" from "a person took over". Both used to arrive as
 * `preempted_by_human`, because the wire's own `reason` was hardcoded to
 * `priority` for every non-admin preemption and this client mapped
 * everything that was not `force_claim` onto the human case. An agent
 * cannot make a sensible decision from a reason that is wrong half the
 * time: standing down for a colleague agent and standing down for a person
 * are different obligations (see {@link ControlYieldEvent.human}).
 */
export type RevokeReason =
  | 'preempted_by_human'
  | 'preempted_by_agent'
  | 'expired'
  | 'force_claimed'
  | 'admin_revoked'
  | 'session_ended'
  | 'instance_released';

// ==================================================================
// Standing down. An agent that yields must not silently keep sending
// input; a half yielded agent is worse than no yield at all. A human watching a browser an agent is driving needs to take
// it over the moment they want to, and the agent has to actually stop,
// not merely be told to.
// ==================================================================

/**
 * Where in the two-step preemption handshake a {@link ControlYieldEvent}
 * was raised.
 *
 * `'requested'` is step 1, `control.preempt.request`: the lease is still
 * held and the server would still dispatch this client's input for another
 * `graceMs`. This client stops anyway. That window exists so a holder can
 * hand over EARLY and cleanly, not so it can squeeze in a few more clicks
 * while a person is already reaching for the mouse.
 *
 * `'taken'` is step 2, `control.preempted`: the lease is gone. It also
 * covers a lease that ends without a step 1 at all (a `control.revoked`
 * this client never got a grace window for), and a deliberate
 * {@link AutomationClient.yieldControl} call.
 */
export type ControlYieldPhase = 'requested' | 'taken';

/**
 * One action this client had running when a yield arrived. The point of
 * reporting these is that an agent author's next question after "control
 * was taken" is always "taken in the middle of what?", and nothing else in
 * the SDK can answer it: `onAction` fires only once an action has already
 * finished.
 *
 * An entry here means the action had started and had not yet returned. It
 * does NOT mean every frame it intended to send reached the browser: the
 * yield is what stops the rest of them.
 */
export interface InFlightAction {
  /** The method name, as `onAction` reports it: `'clickAt'`, `'humanType'`, `'navigate'`, and so on. */
  readonly action: string;
  readonly targetId: string;
  /** Wall-clock Unix ms at which the action began. */
  readonly startedAt: number;
}

/**
 * Control is being taken away, or has been. Delivered to every
 * {@link AutomationClient.onControlYield} listener on the connection, and
 * readable afterwards through {@link AutomationClient.yieldStatus}.
 *
 * This is the surface an agent author is meant to use. The common case is
 * a few lines:
 *
 * ```ts
 * client.onControlYield((ev) => {
 *   if (!ev.human) return;              // another agent outranked us; the run can retry
 *   abortMyPlan(`${ev.byLabel} took over`, ev.inFlight);
 * });
 * ```
 *
 * By the time a listener runs, this client has ALREADY stopped
 * dispatching input on `targetId`; nothing the listener does or fails to
 * do can let another click through. A listener that throws is swallowed,
 * for the same reason `onAction`'s is: an application's own callback must
 * never be able to break the stand-down it is being notified about.
 */
export interface ControlYieldEvent {
  readonly targetId: string;
  readonly phase: ControlYieldPhase;
  /**
   * Why, straight off the wire (`'voluntary'` for a
   * {@link AutomationClient.yieldControl} call, which has no wire
   * message behind it).
   *
   * Read {@link human} rather than comparing against `'human_takeover'`
   * directly: the engine hardcoded this field to `'priority'` for every
   * non-admin preemption for most of this codebase's life, so a client
   * that trusts it alone mistakes a person for a colleague agent on any
   * gateway that has not shipped the honest value yet.
   */
  readonly reason: 'priority' | 'force_claim' | 'human_takeover' | 'voluntary';
  /** The requester's display label, or `''` for a voluntary yield. */
  readonly byLabel: string;
  /** The requester's kind, resolved from the last `presence.state` roster. `'automation'` for a voluntary yield: this client is the one standing down. */
  readonly byKind: 'human' | 'automation';
  /**
   * A PERSON is taking over, as opposed to another agent outranking this
   * one or an admin force-claiming. This is the flag to branch on, and it
   * is deliberately derived from two independent signals rather than one:
   * the wire `reason` being `'human_takeover'`, OR the requester being a
   * `human` in the presence roster. Either alone is enough. The two
   * disagree only on a gateway old enough to still hardcode
   * `reason: 'priority'`, and there the presence roster is the one telling
   * the truth.
   */
  readonly human: boolean;
  /** Wall-clock Unix ms by which the server will take the lease regardless, during a `'requested'` phase. `null` once the lease is already gone. */
  readonly deadline: number | null;
  /** What this client had running on `targetId` when the yield arrived. Empty when it was sitting idle. */
  readonly inFlight: readonly InFlightAction[];
  /**
   * The earliest wall-clock Unix ms at which
   * {@link AutomationClient.acquireControl} will stop refusing on this
   * target, from the wire's own `requeueAfterMs` (30000 for an automation
   * viewer by default). `null` while it is not yet known, i.e. during a
   * `'requested'` phase before `control.preempted` has arrived with the
   * real number.
   *
   * Reaching this time does not mean the agent may drive again; it means
   * it may ASK again. {@link AutomationClient.waitForResume} waits for
   * both this and the target actually being free.
   */
  readonly resumeNotBefore: number | null;
}

/**
 * How an {@link AutomationClient} behaves when something asks for control
 * back. There is exactly one knob here, and it is not "whether to stop":
 * stopping is unconditional. See {@link AutomationClientOptions.yieldPolicy}.
 */
export interface YieldPolicy {
  /**
   * Default `true`: on preemption step 1, release the lease as soon as
   * this client has stopped dispatching, instead of sitting out the rest
   * of the grace window.
   *
   * The grace window is for handing over early. A holder that releases
   * inside it hands the person the pointer in milliseconds; a holder that
   * waits for the deadline makes them wait the full `graceMs` (2000 for
   * an automation holder) staring at a browser that is not yet theirs,
   * for no gain, since the outcome is identical either way.
   *
   * Set `false` only when the agent genuinely needs the grace window to
   * finish something the page would be left inconsistent without (a
   * half-submitted form, a modal it opened). It buys time to CLEAN UP,
   * never time to keep working: input dispatch is already refused by the
   * time this option is consulted.
   */
  releaseOnYield?: boolean;
}

/** Options for {@link AutomationClient.waitForResume}. */
export interface WaitForResumeOptions {
  /** Default `Infinity`, i.e. wait as long as the person takes. A finite value throws `TIMEOUT` rather than resolving early: resolving early would be the SDK telling an agent it may drive while a person still is. */
  timeoutMs?: number;
}

/** Options for {@link AutomationClient.clickAt}. Coordinate delivery only: the `strategy`/`visibleCursor`/hit-test ladder lives in the selector-based verbs instead. */
export interface ClickAtOptions {
  button?: 'left' | 'right' | 'middle';
  /** Default 1. */
  clickCount?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
}

/** Options for {@link AutomationClient.mouseDown} and {@link AutomationClient.mouseUp}. */
export interface MouseButtonOptions {
  /** Default `'left'`. */
  button?: 'left' | 'right' | 'middle';
  /** Default 1. Only meaningful on `mouseDown`; a double click is two down/up pairs with clickCount 1 then 2. */
  clickCount?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
}

/** Options for {@link AutomationClient.moveTo}. */
export interface MoveToOptions {
  /**
   * DOM `MouseEvent.buttons` bitmask to report on the move (1 left, 2 right,
   * 4 middle). Default 0. The gateway tracks the buttons this viewer holds
   * and reports a move made between `mouseDown` and `mouseUp` as a drag
   * either way, so this only matters to a page that reads `buttons` off a
   * move it did not see the press for.
   */
  buttons?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
}

/** One end of a {@link AutomationClient.drag}: a viewport CSS pixel, or a selector whose first match's centre is used. */
export type DragPoint = { x: number; y: number } | string;

/** Options for {@link AutomationClient.drag}. */
export interface DragOptions {
  /** How many interpolated moves between the press and the release. Default 10, minimum 1. */
  steps?: number;
  /** Pause between moves, in ms. Default 16 (about one frame), which canvas apps such as Excalidraw need to see a drag rather than a jump. */
  delayMs?: number;
  /** Default `'left'`. */
  button?: 'left' | 'right' | 'middle';
  /** Held for the whole drag, e.g. `['Shift']` to constrain a shape. */
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
}

/** What {@link AutomationClient.drag} reports: the two points it actually pressed and released at. */
export interface DragResult {
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
}

/** Options for {@link AutomationClient.scroll}. */
export interface ScrollOptions {
  /** CSS px. Point the wheel event is dispatched at; default the viewport centre. */
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
}

/** Options for {@link AutomationClient.pressKey}. */
export interface PressKeyOptions {
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
}

/** Options for {@link AutomationClient.humanType}. */
export interface HumanTypeOptions {
  /** Milliseconds between keystrokes; default 60. Chunk boundaries (checked for preemption) are at most 400ms apart regardless. */
  delayMs?: number;
}

/** Result of a partially typed `humanType()` call interrupted by preemption; carried in the thrown `AutomationError`'s `details`. */
export interface HumanTypePartialResult {
  lastCompletedStep: number;
  partial: true;
  charsTyped: number;
  charsTotal: number;
}

/** Options for {@link AutomationClient.screenshot}. */
export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  maxDimension?: number;
}

/** Resolves {@link AutomationClient.screenshot}. Bytes are base64, matching the wire's inline delivery; the (unimplemented) URL-delivery path throws `NOT_IMPLEMENTED`. */
export interface ScreenshotResult {
  captureId: string;
  targetId: string;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  sizeBytes: number;
  /** Base64, no `data:` prefix. */
  data: string;
}

/**
 * Options for {@link AutomationClient.pdf}. Mirrors
 * `@browserglass/protocol`'s `PagePdfGet` field for field; see that
 * message's own doc (`wire/messages/pdf.ts`) for the full argument behind
 * each default.
 */
export interface PdfOptions {
  /** A named paper size. Mutually exclusive with `widthInches`/`heightInches`. Default `'Letter'`. */
  format?: PdfPaperFormat;
  /** Explicit paper width, inches. Must be given together with `heightInches`. */
  widthInches?: number;
  /** Explicit paper height, inches. Must be given together with `widthInches`. */
  heightInches?: number;
  /** Default false (portrait). */
  landscape?: boolean;
  /** Default false, matching Chrome's own print dialog. */
  printBackground?: boolean;
  /** 0.1 to 2. Default 1. */
  scale?: number;
  marginTopInches?: number;
  marginBottomInches?: number;
  marginLeftInches?: number;
  marginRightInches?: number;
  /** CDP's own page-range syntax, e.g. `'1-5, 8, 11-13'`. Default every page. */
  pageRanges?: string;
  headerTemplate?: string;
  footerTemplate?: string;
  /**
   * Overrides this call's own wait for the `page.pdf.got` reply. Default
   * 45000: the server's own `Page.printToPDF` CDP budget is 30s
   * (`@browserglass/core`'s `cdp/timeouts.ts`), plus headroom for the
   * disk write and SHA-256 hash a large PDF's download delivery does
   * before it can reply at all (`ManagedSession.pdf()`).
   */
  timeoutMs?: number;
}

/**
 * Resolves {@link AutomationClient.pdf}.
 *
 * UNLIKE {@link ScreenshotResult}, the large-delivery case is fully
 * implemented rather than refused: `screenshot()`'s own doc explains why
 * an unbuilt URL-fetch path was an acceptable gap THERE (large images are
 * the exception), and that argument does not transfer here (a PDF of any
 * real page is routinely megabytes; the download path is the common
 * case, not a rare overflow). Rather than pull the bytes through this
 * process a second time, this mirrors {@link DownloadResult}'s own
 * already-established shape (`waitForDownload()`): `data` is set for a
 * small PDF that fit inline, and `downloadId`/`url`/`expiresAt`/`sha256`
 * are set instead for one that did not, leaving the actual HTTP fetch of
 * `url` to the caller, exactly like `waitForDownload()` already does for
 * a real browser download.
 */
export interface PdfResult {
  pdfId: string;
  targetId: string;
  sizeBytes: number;
  /** Base64, no `data:` prefix. Set only when the PDF was small enough to inline; see this type's own doc. */
  data?: string;
  /** Set only when `data` is absent: the signed URL delivery, `DownloadResult`'s own shape. */
  downloadId?: string;
  /**
   * Absolute `http(s)` URL of the file, ready to GET with no further
   * joining. The gateway itself sends a path that already includes its
   * base path (`/browserglass/v1/downloads/<token>` by default), or a full
   * URL when it has `publicUrl` configured; this client resolves the path
   * form against the origin its socket dialed. Single use: the first GET
   * consumes it. No auth header is needed, the token in the URL is the
   * credential.
   */
  url?: string;
  /** Epoch ms after which `url` stops working. Set alongside `url`. */
  expiresAt?: number;
  /** Lowercase hex SHA-256 of the finished file. Set alongside `url`. */
  sha256?: string;
}

/**
 * Options for {@link AutomationClient.startRecording}. Mirrors
 * `@browserglass/protocol`'s `RecordingStart` field for field; see that
 * message's own doc (`wire/messages/recording.ts`) for the capability
 * reasoning this method enforces (`capture` AND `download` together).
 */
export interface StartRecordingOptions {
  /** Default `'live'` (the full screencast). `'thumbnail'` pins the recording to the low-cost polling tier instead. */
  mode?: 'live' | 'thumbnail';
  /** Overrides this call's own wait for the `recording.started` reply. Default the client's own `defaultTimeoutMs`. */
  timeoutMs?: number;
}

/** Resolves {@link AutomationClient.startRecording}. The recording itself is written to the gateway's own disk, never returned here; this is only the handle {@link AutomationClient.stopRecording} needs later. */
export interface RecordingHandle {
  recordingId: string;
  targetId: string;
  mode: 'live' | 'thumbnail';
  startedAtMs: number;
}

/** Resolves {@link AutomationClient.stopRecording}. */
export interface StopRecordingResult {
  recordingId: string;
  targetId: string;
  startedAtMs: number;
  stoppedAtMs: number;
  /** How many frames actually reached the sink; see `RecordingStopped.framesWritten`'s own doc (attempted, not necessarily all durable if the process crashes mid write). */
  framesWritten: number;
  /** Frames skipped because the gateway's disk writes fell behind the stream. Zero on a healthy recording. Absent from a gateway that predates the field. */
  framesDropped?: number;
  /** True if the recording degraded to a no-op before this stop (a sink failure mid recording). `framesWritten` still counts whatever reached disk before that happened. */
  failed: boolean;
}

/** Options for {@link AutomationClient.listRecordings}. */
export interface ListRecordingsOptions {
  /** Scope the list to one target. Omit to list every recording this session's socket is aware of. */
  targetId?: string;
  timeoutMs?: number;
}

/** Options for {@link AutomationClient.inspectAt}. */
export interface InspectAtOptions {
  /** Default `'hover'`. */
  detail?: ProbeDetail;
}

/** Resolves {@link AutomationClient.inspectAt}. */
export interface InspectResult {
  hit: boolean;
  gen: number;
  rect?: ProbeRect;
  label?: string;
  tagName?: string;
  href?: string | null;
  name?: string;
  role?: string;
}

/** Resolves {@link AutomationClient.status}. Built entirely from cached broadcasts, no CDP traffic. */
export interface StatusResult {
  targetId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  leaseHolderViewerId: string | null;
  leaseHolderLabel: string | null;
}

/** Options for {@link AutomationClient.restartInstance} (manual recovery rung R4). */
export interface RestartInstanceOptions {
  reason?: string;
  /** Default `true`; `false` additionally needs `profile.write`. */
  preserveProfile?: boolean;
  /** Default 60000. */
  timeoutMs?: number;
}

/** Resolves {@link AutomationClient.restartInstance}. */
export interface RestartInstanceResult {
  rung: RecoveryRung;
  durationMs: number;
  streamsResubscribed: number[];
  streamsLost: number[];
}

/** Options for {@link AutomationClient.navigate}. */
export interface NavigateOptions {
  referrer?: string;
  /**
   * When `navigate()` resolves. Default `'load'`: after the new document's
   * `load` event, so the page can be read straight away. `'commit'`
   * resolves as soon as the navigation commits, with the page still
   * loading. `'networkidle'` is declared on the wire but the gateway
   * refuses it.
   */
  waitUntil?: 'commit' | 'load' | 'networkidle';
  /** With `waitUntil: 'load'`: how long the gateway waits for `load` before answering with `loading: true`. Default 30000, capped at 120000 by the gateway. */
  timeoutMs?: number;
}

/** Options for {@link AutomationClient.waitForNavigation}. */
export interface WaitForNavigationOptions {
  /** Default `defaultTimeoutMs`. */
  timeoutMs?: number;
}

/**
 * Options for {@link AutomationClient.waitForNetworkIdle}.
 *
 * Built on `networksummary`'s `inFlight` gauge
 * (`packages/core/src/diagnostics/target-diagnostics.ts`'s
 * `TargetDiagnostics`, `pendingRequests.size`), which requires an active
 * `network` diagnostics subscription on the target; see that method's own
 * doc for the local, fail-fast check this SDK makes for that before
 * waiting on anything.
 */
export interface WaitForNetworkIdleOptions {
  /** Requests still allowed to be outstanding and the target still counted as idle. Default 0. */
  maxInflight?: number;
  /** How long the in-flight count must stay at or below `maxInflight`, continuously, before this resolves. Default 500. */
  idleMs?: number;
  /** Overall deadline; rejects with `TIMEOUT` past this regardless of activity. Default `defaultTimeoutMs`. */
  timeoutMs?: number;
}

/** One entry in {@link AutomationClient.tabs}'s `list()`. Re-exports the wire's own `TargetSummary`; automation adds no fields. */
export type TabSummary = TargetSummary;

/** Options for {@link AutomationClient.tabs}'s `open()`. */
export interface OpenTabOptions {
  url?: string;
  background?: boolean;
}

// ==================================================================
// Page evaluation (`evaluate` capability; `@browserglass/protocol`'s
// `wire/messages/evaluate.ts`). Off by default and never implied by
// `automation`: an `AutomationClient` built from an `agent` role token
// can click and type all day and still be refused here, which is the
// intended asymmetry, not an oversight.
// ==================================================================

/** Options for {@link AutomationClient.evaluate}. */
export interface EvaluateOptions {
  /** Default `DEFAULT_EVALUATE_TIMEOUT_MS` (30s), capped server side at `MAX_EVALUATE_TIMEOUT_MS` (120s). */
  timeoutMs?: number;
  /**
   * Default true. Settle a returned promise and give back the settled
   * value; a rejection surfaces as a thrown `AutomationError` exactly like
   * a synchronous throw. Set false to get the promise object's description
   * back instead, which is almost never what a caller wants.
   */
  awaitPromise?: boolean;
  /**
   * Default false. Run with a transient user activation. Requires the
   * `control` capability ON TOP of `evaluate`
   * (`EVALUATE_USER_GESTURE_CAPABILITY_RULE`), because it is a claim to be
   * acting as the person at the keyboard.
   */
  userGesture?: boolean;
  /**
   * Which JavaScript world to run in. Default `'main'`.
   *
   * `'isolated'` gets a private world that shares the DOM and nothing else.
   * The page cannot observe the script, hook what it calls, or tamper with
   * its result, which is what you want when driving a site that is looking
   * for automation.
   *
   * The trade is that page globals are invisible: a script reading
   * `window.somethingThePageSet` in the isolated world gets `undefined`
   * every time, which is indistinguishable from the value not existing.
   * Read the DOM from the isolated world, and switch to `'main'` on the
   * rare call that genuinely needs a page global.
   */
  world?: EvaluateWorld;
}

/** Options for {@link AutomationClient.waitForFunction}. */
export interface WaitForFunctionOptions extends EvaluateOptions {
  /**
   * Overall deadline for the whole poll, milliseconds. Default
   * `defaultTimeoutMs`. Distinct from {@link EvaluateOptions.timeoutMs},
   * which bounds ONE evaluation: a predicate that hangs is a different
   * failure from a predicate that keeps honestly returning false.
   */
  pollTimeoutMs?: number;
  /** Milliseconds between polls. Default 100. */
  pollingMs?: number;
}

/** Options for {@link AutomationClient.waitForText}. */
export interface WaitForTextOptions {
  /** Overall deadline for the whole poll, milliseconds. Default `defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Milliseconds between polls. Default 100. */
  pollingMs?: number;
  /**
   * Exact match after whitespace normalisation, rather than substring.
   * Default false. Both modes are case-insensitive, matching the `text=`
   * locator engine's own documented behaviour (`locator/script.ts`'s
   * `bglsMatchesNeedle`): a caller who has already learned that a text
   * match on this surface ignores case should not have to relearn it here.
   */
  exact?: boolean;
}

// ==================================================================
// Diagnostics (api-contract-diagnostics.md section 1/4): the same
// `devtools`-gated console/error/network feeds `@browserglass/client`
// exposes as `client.diagnostics`/`ClientEvents`, mirrored here so an
// `AutomationClient` (and a `BrowserSwarm` member) can read what a page
// is doing without a second connection.
// ==================================================================

/** Options for {@link AutomationClient.diagnostics}'s `subscribe()`. Default: console and errors on, network off, matching the wire message's own default: `Network.enable` is not free, and a swarm of many members must not pay for it on every one of them unless asked. */
export interface DiagnosticsFeeds {
  console?: boolean;
  errors?: boolean;
  network?: boolean;
}

/** Resolves {@link AutomationClient.diagnostics}'s `subscribe()`, echoing what the server actually turned on for this target. Read this, not the `feeds` passed in: the server can turn on less than asked. */
export interface DiagnosticsSubscription {
  targetId: string;
  console: boolean;
  errors: boolean;
  network: boolean;
}

// ==================================================================
// The response-body join (`devtools` capability, NOT a capability of its
// own; `@browserglass/protocol`'s `wire/messages/response-body.ts`).
//
// A `requestId` reaches this client in exactly one way: the `network`
// event `AutomationEvents.network` delivers, which only ever fires for a
// target this client has called `diagnostics.subscribe({ network: true
// })` on. There is no other method on this class that mints or accepts
// one; guessing a `requestId` string buys nothing, because the server
// checks it against what THIS client was actually shown, not against
// what exists in Chrome's buffer.
// ==================================================================

/** Options for {@link AutomationClient.diagnostics}'s `responseBody()`. */
export interface ResponseBodyOptions {
  /** Overall deadline for this one round trip, milliseconds. Default `defaultTimeoutMs`. */
  timeoutMs?: number;
}

/**
 * The buffered response body for one request, resolved by
 * {@link AutomationClient.diagnostics}'s `responseBody()`.
 *
 * `body` is UTF-8 text when `base64Encoded` is false, and base64-encoded
 * bytes when true, exactly as `Network.getResponseBody` itself splits it
 * (binary responses, images, PDFs, and anything Chrome could not decode as
 * text arrive with `base64Encoded: true`). `sizeBytes` is the DECODED byte
 * length either way, which is what a caller comparing against a size limit
 * of its own actually wants.
 */
export interface ResponseBodyResult {
  body: string;
  base64Encoded: boolean;
  sizeBytes: number;
}

// ==================================================================
// The accessibility tree read (`devtools` capability; NOT `evaluate`,
// deliberately: `AutomationClient.a11y()` runs no page script, only
// `Accessibility.queryAXTree` (`packages/core/src/cdp/accessibility.ts`).
// See `@browserglass/protocol`'s `wire/messages/a11y.ts` for the full
// design argument, and `locator/selector.ts`'s `role=` engine for the
// OTHER thing built on the same CDP call.
// ==================================================================

/** Re-exported verbatim: the shape is already right for a caller of {@link AutomationClient.a11y}, and duplicating it here under a different name would just be a second thing to keep in sync with the wire type. */
export type { A11yNode };

/** Options for {@link AutomationClient.a11y}. */
export interface A11yOptions {
  /** Restrict to nodes whose computed role EXACTLY equals this. Omit for every role. Narrowing here, rather than reading the whole tree and filtering client side, is the same advice this codebase already gives about narrowing an `evaluate()` expression: see `@browserglass/protocol`'s `wire/messages/a11y.ts`, "why `queryAXTree`, not `getFullAXTree`". */
  role?: string;
  /** Restrict to nodes whose computed accessible name EXACTLY equals this. Exact, not substring: Chrome's own `queryAXTree` matching, not Playwright's normalised-and-substring default. */
  name?: string;
  /** Cap on returned nodes, before the server's own byte ceiling is also applied. Default `DEFAULT_A11Y_MAX_NODES` (200), capped server side at `MAX_A11Y_MAX_NODES` (1000). `A11yResult.total` still reports the real match count. */
  maxNodes?: number;
  /** Overall deadline for this one round trip, milliseconds. Default `defaultTimeoutMs`. */
  timeoutMs?: number;
}

/**
 * What {@link AutomationClient.a11y} read, resolved by {@link AutomationClient.a11y}.
 *
 * `nodes` is bounded and `truncated` says so honestly rather than
 * silently: see `@browserglass/protocol`'s `wire/messages/a11y.ts`,
 * "bounded, and truncation reported as data, not refused". Empty is an
 * ordinary answer, never an error, the same rule {@link ResolveResult}
 * already follows: a role/name filter matching nothing is information.
 */
export interface A11yResult {
  nodes: A11yNode[];
  /** How many nodes matched before either bound was applied. */
  total: number;
  /** True when `nodes.length < total`. */
  truncated: boolean;
}

// ==================================================================
// The page map (`devtools` capability; NOT `evaluate`, the identical
// reasoning `a11y()` above already gives for itself): an indexed, flat
// map of every element the interactivity cascade judged actionable, with
// a rect, a tristate occlusion answer, and a fixed attribute subset. See
// `@browserglass/protocol`'s `wire/messages/pagemap.ts` and
// `docs/page-map.md` for the full design, and
// `AutomationClient.pageMap`'s own doc for what truncation, degradation
// and the listener signal do and do not prove.
// ==================================================================

/** Re-exported verbatim, the same reasoning {@link A11yNode} gets above. */
export type {
  PageMapNode,
  PageMapDegradation,
  PageMapTruncationReason,
  PageMapTextBlock,
  PageMapEpoch,
  PageMapInclude,
  PageMapStampResult,
};

/** Options for {@link AutomationClient.pageMap}. */
export interface PageMapOptions {
  /** What to capture. Default `['nodes']`. Pass `['nodes', 'text']` to also get {@link PageMapTextBlock}s in the same round trip. */
  include?: PageMapInclude[];
  /** Default true. Adds the `DOMDebugger.getEventListeners` signal to the interactivity cascade, catching an element whose only actionability signal is a JavaScript handler. Runs no page script; see {@link AutomationClient.pageMap}'s own doc for its measured limit against a delegated listener. */
  listeners?: boolean;
  /** Overall deadline for this one round trip, milliseconds. Default the server's own `DEFAULT_PAGEMAP_TIMEOUT_MS` (15000), clamped server side at `MAX_PAGEMAP_TIMEOUT_MS` (60000). */
  timeoutMs?: number;
}

/**
 * What {@link AutomationClient.pageMap} read, resolved by {@link AutomationClient.pageMap}.
 *
 * `nodes`/`total`/`truncated`/`truncatedByReason`/`degraded` are present
 * exactly when `include` asked for `'nodes'` (the default); `text` exactly
 * when it asked for `'text'`. An omitted field is not an empty answer, it
 * is "not asked for": do not read a missing `nodes` as zero interactive
 * elements.
 */
export interface PageMapResult {
  /** Mint id for this capture's index space. Echo it back on {@link AutomationClient.stampPageMap}; a mismatch is refused before any CDP command goes out. */
  epoch: PageMapEpoch;
  nodes?: PageMapNode[];
  /** How many candidate nodes existed before the byte cap, independent of how many are actually in `nodes`. */
  total?: number;
  /** True when `nodes.length < total`. */
  truncated?: boolean;
  /** Counts of dropped nodes by {@link PageMapTruncationReason}. Both counts are 0 when `truncated` is false. */
  truncatedByReason?: Record<PageMapTruncationReason, number>;
  /** Per-frame accessibility failures, plus whether the listener signal ran. See {@link AutomationClient.pageMap}'s own doc for what a degraded read does and does not let a caller conclude. */
  degraded?: PageMapDegradation;
  text?: PageMapTextBlock[];
}

/** What {@link AutomationClient.stampPageMap} wrote, resolved by {@link AutomationClient.stampPageMap}. */
export interface StampPageMapResult {
  /** One entry per requested index, same order as the request. */
  results: PageMapStampResult[];
  /** The attribute name every succeeded entry was stamped with, addressable as `css=[<marker>]`. `null` when nothing was actually stamped. */
  marker: string | null;
}

/**
 * Events {@link AutomationClient.on} delivers, over the same socket every
 * other automation call uses. Only the `devtools`-gated diagnostics feeds:
 * automation has no renderer and subscribes to no video stream, so none of
 * `@browserglass/client`'s other `ClientEvents` (frames, cursors,
 * presence) have an automation equivalent to mirror.
 */
/**
 * One outbound request held by the gate, awaiting a verdict.
 *
 * `postData` is present only when the matching rule set
 * `includeRequestBody`, which additionally requires the `evaluate`
 * capability: a POST body carries whatever the user typed. See
 * `@browserglass/protocol`'s `wire/messages/interception.ts`,
 * escalation path 5.
 */
export interface RequestGatePausedEvent {
  targetId: string;
  /** Echo this back on the verdict. */
  gateId: string;
  url: string;
  method: string;
  resourceType: string;
  headers: Readonly<Record<string, string>>;
  postData?: string;
  /** Epoch ms after which the server applies the rule's own `onTimeout` without waiting further. */
  deadlineAt: number;
}

/** Options for {@link AutomationClient.waitForDownload}. */
export interface WaitForDownloadOptions {
  /** How long to wait for a download to COMPLETE, not to start. Default 60000. */
  timeoutMs?: number;
  /**
   * Runs after the download listener is attached and before the wait
   * begins.
   *
   * Put the click that starts the download here rather than calling it
   * first. A small file served locally can finish before a listener
   * attached afterwards ever runs, and that lost race looks exactly like a
   * download that never happened.
   */
  trigger?: () => void | Promise<void>;
}

/**
 * A finished download.
 *
 * `url` is a signed, short lived, SINGLE USE HTTP URL, not the page's own
 * download address: fetch it with an ordinary GET. Bytes never travel over
 * the control socket, which is why a large file does not compete with
 * input and frames for the same connection. `sha256` is of the file as
 * written, so a caller can verify what it fetched.
 */
export interface DownloadResult {
  downloadId: string;
  sizeBytes: number;
  sha256: string;
  /** Absolute `http(s)` URL of the file. Same rules as {@link PdfResult.url}: resolved against the origin this client's socket dialed, base path included, single use. */
  url: string;
  /** Epoch ms after which `url` stops working. */
  expiresAt: number;
}

export interface AutomationEvents {
  [key: string]: unknown;
  /**
   * A request matched an `ask` rule and is held. Delivered only to the
   * connection that registered the rule set. Answer it with
   * `client.gate.resolve(gateId, verdict)`, or let
   * `client.gate.onPaused(handler)` answer it for you, which is safer
   * because a pause nobody answers holds a real Chrome network slot
   * until its deadline.
   */
  gatepaused: RequestGatePausedEvent;
  console: {
    targetId: string;
    level: string;
    text: string;
    url?: string;
    line?: number;
    column?: number;
    stack?: string;
    count?: number;
  };
  pageerror: { targetId: string; name: string; message: string; stack?: string; url?: string };
  /** One completed or failed request; `url` is UNTRUSTED. */
  network: {
    targetId: string;
    requestId: string;
    method: string;
    url: string;
    resourceType: string;
    status: number | null;
    errorText: string | null;
    fromCache: boolean;
    durationMs: number | null;
    encodedBytes: number | null;
    startedAt: number;
  };
  /** Periodic rollup, the same target as the `network` entries it summarises. */
  networksummary: {
    targetId: string;
    windowMs: number;
    requests: number;
    failed: number;
    bytesIn: number;
    bytesOut: number;
    slowest: Array<{ url: string; ms: number; status: number }>;
    /**
     * Requests outstanding right now (a gauge, not a rollup of this
     * window): `packages/core/src/diagnostics/types.ts`'s
     * `NetworkSummaryPayload.inFlight`, read live from `TargetDiagnostics`'s
     * `pendingRequests.size`. Optional because a gateway that has not yet
     * updated its own `network.summary` wire message
     * (`packages/protocol/src/wire/messages/diagnostics.ts`'s
     * `NetworkSummary`) to carry this field simply never sends it; this
     * client forwards whatever the wire actually had rather than assuming
     * a value. {@link AutomationClient.waitForNetworkIdle} is the caller
     * that needs it.
     */
    inFlight?: number;
  };
  /**
   * A server-pushed `error` envelope with no `re`, i.e. not the reply to
   * one of this client's own `request()` calls (those reject that call's
   * own promise directly and are never delivered here). Every input
   * dispatch (`type()`, `insertText()`, `click()`, `scroll()`, ...) sends
   * fire-and-forget with nothing to await, so this is the ONLY way a
   * caller can ever learn that a keystroke or click it sent did not
   * actually reach the page: `bgls.error.input.dispatch_failed` names
   * that case specifically (`code === 'PROTOCOL_ERROR'` maps back to it
   * via `AutomationError`'s own wire-code taxonomy), and `retryable` says
   * whether resending the same input is the fix. A control-lease push
   * (`bgls.error.control.not_held`/`lease_stale`) or an instance-lifecycle
   * notice (session expiring/draining, a stream rebound) arrives here too,
   * for the same reason: both used to be silently discarded.
   */
  protocolerror: AutomationError;
}

/** Re-exported so a user of this package's public surface never needs a direct `@browserglass/protocol` dependency for annotations. */
export type { Capability, ProbeDetail, ProbeRect, RecoveryRung, TargetSummary };
export type { TargetKind } from '@browserglass/protocol';
/** Re-exported so a caller can type an `AutomationClient.on()` unsubscribe function without a direct `@browserglass/client` dependency for just this one type. */
export type { Unsubscribe } from '@browserglass/client';
