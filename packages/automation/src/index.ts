/**
 * `@browserglass/automation`: a programmatic control surface over a
 * `bgls.v1` session, plus an MCP server an agent can drive a whole swarm
 * through (`mcp/server.ts`). That started as a five tool stub and is now
 * sixteen: the original five single target tools, navigation and
 * screenshot, swarm lifecycle and fan out, and the three diagnostics
 * readers.
 *
 * The framing that matters: automation is a Viewer. `AutomationClient`
 * connects over the same socket a human's `@browserglass/client` connects
 * over, with `kind: 'automation'`, acquires a `ControlLease` exactly like a
 * human, and its input flows through the same `InputDispatcher`. There is
 * no back door.
 *
 * `BrowserSwarm` keeps that same framing at N: it is `size` ordinary
 * `AutomationClient`s, opened together and driven together, not a second
 * multi-browser wire path. See `README.md` for a runnable example and
 * `PARALLELISM.md` for the window-isolation and rate-limit numbers a
 * caller driving more than one browser at once actually needs.
 */
export { AutomationClient } from './client/AutomationClient.js';
export { AutomationError } from './errors.js';
export type { AutomationErrorCode } from './errors.js';
export type {
  A11yNode,
  A11yOptions,
  A11yResult,
  AcquireControlOptions,
  ActionRecord,
  AutomationEvents,
  ClickAtOptions,
  ConfirmDecision,
  ConfirmHook,
  ConfirmRequest,
  ControlLeaseHandle,
  ControlYieldEvent,
  ControlYieldPhase,
  DiagnosticsFeeds,
  DiagnosticsSubscription,
  EvaluateOptions,
  HumanTypeOptions,
  HumanTypePartialResult,
  InFlightAction,
  InspectAtOptions,
  InspectResult,
  OpenTabOptions,
  PressKeyOptions,
  PreemptionRequest,
  RestartInstanceOptions,
  RestartInstanceResult,
  ResponseBodyOptions,
  ResponseBodyResult,
  RevokeReason,
  ScreenshotOptions,
  ScreenshotResult,
  ScrollOptions,
  StatusResult,
  TabSummary,
  Unsubscribe,
  UploadFileInput,
  WaitForFunctionOptions,
  WaitForNavigationOptions,
  WaitForResumeOptions,
  WaitForTextOptions,
  YieldPolicy,
} from './types.js';
export type { AutomationClientOptions } from './types.js';

// ---- One call launch against a running gateway ----
export { DEFAULT_GATEWAY_URL, DEFAULT_LAUNCH_CAPS, launchInstance } from './launch.js';
export type { LaunchOptions, LaunchedInstance } from './launch.js';

// ---- The locator surface (`resolve` plus thin verbs) ----
export { LOCATOR_REF_ATTRIBUTE } from './locator/script.js';
export {
  STALE_RESOLVE_WINDOW_MS,
  MAX_FRAME_SEGMENTS,
  splitSegments,
  parseSelector,
  parseRoleValue,
  refSelector,
} from './locator/selector.js';
export type { RoleFilter, SelectorSegment } from './locator/selector.js';
export type {
  ClickResult,
  ClickVia,
  DropdownOption,
  FillMode,
  FillResult,
  FindInPageMatch,
  FindInPageOptions,
  FindInPageResult,
  HoverResult,
  LocatorClickOptions,
  LocatorEngine as LocatorSelectorEngine,
  LocatorFillOptions,
  LocatorHoverOptions,
  LocatorMatch,
  LocatorRect,
  LocatorScrollContainerOptions,
  LocatorSelectOptions,
  LocatorState,
  ResolveOptions,
  ResolveResult,
  ScrollContainerResult,
  ScrollToTextOptions,
  SelectOptionSpec,
  SelectResult,
  WaitForOptions,
  WaitForResult,
} from './locator/types.js';

// ---- Swarm (api-contract-diagnostics.md section 5) ----
export { BrowserSwarm, swarmMemberSubject } from './swarm.js';
export type {
  BrowserSwarmOptions,
  SwarmAcquireContext,
  SwarmAcquireResult,
  SwarmMember,
  SwarmYieldEvent,
} from './swarm.js';

// ---- MCP server stub ----
export { createAutomationMcpServer } from './mcp/server.js';
export type { AutomationMcpServerOptions } from './mcp/server.js';
