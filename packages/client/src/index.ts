/**
 * `@browserglass/client`: the framework-agnostic BrowserGlass browser
 * client. Zero Node builtins;
 * runs in a browser, a Web Worker, or Node 22+ with a `ws` peer dependency
 * passed as `transport.WebSocketImpl`.
 *
 * `BrowserGlassClient` is the public entry point most apps use. The
 * `Transport`, `CanvasRenderer`, and `InputCapture` classes it is built
 * from are also exported directly, for advanced use (a headless Node
 * client that never paints, a custom renderer built on the same
 * coordinate transform, and so on); see `./transport`, `./render`, and
 * `./input` for their own documentation.
 */

// ---- client assembly ----
export { BrowserGlassClient, BrowserGlassError } from './client/index.js';
export type {
  BrowserGlassClientOptions,
  BrowserGlassErrorInit,
  CaptureOptions,
  CaptureResult,
  ClientEvents,
  ClientStats,
  ClientTransportOptions,
  ControlDeniedReason,
  ControlOutcome,
  ControlRequestOptions,
  ControlYieldResult,
  DiagnosticsSubscribeOptions,
  DiagnosticsSubscription,
  OverlayContext,
  ProbeOptions,
  ProbeResult,
  QualityOptions,
  RestartOptions,
  RestartResult,
  StreamEvents,
  StreamHandle,
  StreamInfo,
  StreamStats,
  SubscribeOptions,
  UploadHandle,
  UploadOptions,
  ViewerPresence,
} from './client/index.js';

// ---- transport ----
export { Transport } from './transport/index.js';
export { Emitter, type Unsubscribe } from './transport/index.js';
export {
  ALLOWED_TRANSITIONS,
  ConnectionStateMachine,
  DEFAULT_BACKOFF_SCHEDULES,
  DEFAULT_RECONNECT_OPTIONS,
  InvalidConnectionTransition,
  NOOP_LOGGER,
  ReconnectController,
  backoffScheduleFor,
  computeBackoffDelayMs,
  computeSilentDelayMs,
  isResumeWithinWindow,
  resumeRecordFromWelcome,
  toHelloResume,
} from './transport/index.js';
export type {
  BackoffSchedule,
  ClientStats as TransportStats,
  CloseInfo,
  ConnectedEvent,
  ConnectionState,
  DegradedEvent,
  DelayInput,
  DesiredSubscription,
  DisconnectedEvent,
  FatalInfo,
  Logger,
  ReconnectingEvent,
  ReconnectOptions,
  ResumedEvent,
  ResumeRecord,
  ScheduleResult,
  TransportEvents,
  TransportHelloOptions,
  TransportOptions,
  TransportSocketOptions,
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from './transport/index.js';

// ---- renderer ----
export { CanvasRenderer } from './render/index.js';
export type {
  AckInfo,
  CanvasFit,
  CanvasRendererOptions,
  ClientPoint,
  DprMode,
  FramePoint,
  FrameSize,
  PaintInfo,
  RendererStats,
  RendererStreamInfo,
} from './render/index.js';

// ---- input capture ----
export {
  ClickCounter,
  InputCapture,
  buttonName,
  modMask,
  normalizeWheelDelta,
} from './input/index.js';
export type {
  HeldButton,
  InputCaptureOptions,
  InputCoordinateSource,
  SendableInputMessage,
} from './input/index.js';

// ---- selected wire types (`@browserglass/protocol`), re-exported so a
// consumer typing this client's own public surface (`granted`, `leases`,
// `targets`, `subscribe()`'s `quality`, and so on) never needs its own
// direct dependency on `@browserglass/protocol` just for annotations ----
export type {
  Capability,
  Codec,
  LeaseState,
  ProbeDetail,
  ProbeRect,
  QualityProfile,
  TargetKind,
  TargetSummary,
  WelcomeInstance,
  WelcomeLimits,
} from '@browserglass/protocol';
