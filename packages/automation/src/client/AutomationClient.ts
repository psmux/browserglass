import type { Unsubscribe } from '@browserglass/client';
import {
  type Capability,
  type ControlDenied,
  type ControlGranted,
  type ControlQueued,
  DEFAULT_EVALUATE_TIMEOUT_MS,
  EVALUATE_USER_GESTURE_CAPABILITY_RULE,
  type Envelope,
  type ErrorMsg,
  type EvaluateWorld,
  type FilesSetResult,
  type GateRule,
  type GateVerdict,
  type InstanceRecovered,
  MsgType,
  type NavState,
  PROBE_CAPABILITY_RULE,
  type PageA11yGot,
  type PageEvaluated,
  type PageMapGot,
  type PageMapStamped,
  type PagePdfGot,
  type PageResponseBodyGot,
  PayloadCodec,
  type RecordingListed,
  type RecordingStarted,
  type RecordingStopped,
  type TargetCaptured,
  type TargetCreated,
  type TargetListed,
  type TargetProbed,
  type UploadAccepted,
  type UploadDone,
  encodeBinaryHeader,
  encodeUploadChunkPayload,
} from '@browserglass/protocol';
import { AutomationError } from '../errors.js';
import { namedKeyCode, printableKeyCode } from '../keys.js';
import { type LaunchOptions, launchInstance } from '../launch.js';
import { ENGINE_WORLD, LocatorEngine } from '../locator/engine.js';
import type {
  ClickResult,
  DropdownOption,
  FillResult,
  FindInPageOptions,
  FindInPageResult,
  HoverResult,
  LocatorClickOptions,
  LocatorFillOptions,
  LocatorHoverOptions,
  LocatorMatch,
  LocatorScrollContainerOptions,
  LocatorSelectOptions,
  ResolveOptions,
  ResolveResult,
  ScrollContainerResult,
  ScrollToTextOptions,
  SelectOptionSpec,
  SelectResult,
  WaitForOptions,
  WaitForResult,
} from '../locator/types.js';
import type {
  A11yOptions,
  A11yResult,
  AcquireControlOptions,
  AutomationClientOptions,
  AutomationEvents,
  ClickAtOptions,
  ControlLeaseHandle,
  ControlYieldEvent,
  DiagnosticsFeeds,
  DiagnosticsSubscription,
  DownloadResult,
  DragOptions,
  DragPoint,
  DragResult,
  EvaluateOptions,
  HumanTypeOptions,
  InspectAtOptions,
  InspectResult,
  ListRecordingsOptions,
  MouseButtonOptions,
  MoveToOptions,
  NavigateOptions,
  OpenTabOptions,
  PageMapEpoch,
  PageMapOptions,
  PageMapResult,
  PdfOptions,
  PdfResult,
  PressKeyOptions,
  RecordingHandle,
  RecordingSummary,
  RequestGatePausedEvent,
  ResponseBodyOptions,
  ResponseBodyResult,
  RestartInstanceOptions,
  RestartInstanceResult,
  ScreenshotOptions,
  ScreenshotResult,
  ScrollOptions,
  StampPageMapResult,
  StartRecordingOptions,
  StatusResult,
  StopRecordingResult,
  TabSummary,
  UploadFileInput,
  WaitForDownloadOptions,
  WaitForFunctionOptions,
  WaitForNavigationOptions,
  WaitForNetworkIdleOptions,
  WaitForResumeOptions,
  WaitForTextOptions,
} from '../types.js';
import { AutomationCore } from './core.js';
import { ControlLeaseHandleImpl } from './leaseHandle.js';

/** Packs a named modifier array into the CDP bit order (Alt 1, Ctrl 2, Meta 4, Shift 8), the same order `@browserglass/client`'s own `modMask` uses. */
function packModifiers(mods?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): number {
  if (!mods) return 0;
  let m = 0;
  if (mods.includes('Alt')) m |= 0x1;
  if (mods.includes('Control')) m |= 0x2;
  if (mods.includes('Meta')) m |= 0x4;
  if (mods.includes('Shift')) m |= 0x8;
  return m;
}

/** DOM `MouseEvent.buttons` bit for a named button (left 1, right 2, middle 4). */
function buttonMask(button: 'left' | 'right' | 'middle'): number {
  return button === 'left' ? 1 : button === 'right' ? 2 : 4;
}

/** Decodes a lowercase hex string to bytes. Hand rolled rather than `Buffer.from(hex, 'hex')` because this package runs in a browser as well as in Node, and `Buffer` is not there. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Resolves after `ms`, honouring `.unref?.()` so a pending typing delay never keeps a Node process alive on its own. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Per-connection record of which targets currently have the `network`
 * diagnostics feed on, read only by {@link AutomationClient.waitForNetworkIdle}
 * to fail fast when nobody subscribed rather than waiting silently on a
 * feed nobody turned on. Keyed off the shared `AutomationCore` (a
 * `WeakMap`, not a field on `AutomationCore` itself) rather than on `this`:
 * `forTarget()` sub-clients share one `AutomationCore` (one socket, one
 * step budget), so a sub-client bound to the same
 * target as the one that actually called `diagnostics.subscribe()` must
 * see the same answer. Module scope rather than a class field because this
 * state belongs to one verb, not to every `AutomationClient` method the
 * way `core.leases`/`core.granted`/etc. do.
 */
const networkFeedByCore = new WeakMap<AutomationCore, Map<string, boolean>>();

function setNetworkFeedSubscribed(core: AutomationCore, targetId: string, on: boolean): void {
  let byTarget = networkFeedByCore.get(core);
  if (!byTarget) {
    byTarget = new Map();
    networkFeedByCore.set(core, byTarget);
  }
  byTarget.set(targetId, on);
}

function isNetworkFeedSubscribed(core: AutomationCore, targetId: string): boolean {
  return networkFeedByCore.get(core)?.get(targetId) === true;
}

/**
 * The page-side predicate {@link AutomationClient.waitForText} hands to
 * {@link AutomationClient.waitForFunction}. Pulled out to a standalone,
 * exported function (rather than an inline template inside `waitForText`
 * itself) for the same reason `locator/script.ts` exports `SELECT_SCRIPT`
 * and its siblings as named constants instead of burying them in the
 * methods that use them: it is real page-side JavaScript, authored as
 * text for the same reason those are (`page.evaluate` takes an
 * `expression` or a `functionDeclaration`, never a live closure over this
 * process's bindings), and it deserves to be run against a real DOM in a
 * test rather than only ever exercised through a mocked evaluate reply.
 * `test/client/wait-for-text.test.ts` does exactly that under
 * `@vitest-environment jsdom`.
 *
 * `selector` and `text` are embedded as JSON literals, never
 * string-concatenated: a caller's text containing a quote or a backslash
 * must not be able to break out of the generated expression, the same
 * reasoning `select()`'s own doc gives for building `SELECT_SCRIPT`'s spec
 * as a JSON argument rather than as interpolated source.
 *
 * Matching mirrors the `text=` locator engine's own documented behaviour
 * (`locator/script.ts`'s `bglsMatchesNeedle`): normalised (whitespace
 * collapsed, trimmed) `textContent`, case-insensitive, substring by
 * default and a whole-string match when `exact` is true. `textContent`
 * rather than `innerText` for the same reason the `text=` engine gives:
 * `innerText` forces layout for every candidate element, and this predicate
 * runs on a poll.
 */
export function buildWaitForTextPredicate(selector: string, text: string, exact: boolean): string {
  return [
    '(function () {',
    `  var els = document.querySelectorAll(${JSON.stringify(selector)});`,
    `  var needle = ${JSON.stringify(text)}.replace(/\\s+/g, ' ').trim().toLowerCase();`,
    '  for (var i = 0; i < els.length; i++) {',
    '    var norm = (els[i].textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();',
    `    if (${exact ? 'norm === needle' : 'norm.indexOf(needle) >= 0'}) return norm;`,
    '  }',
    '  return false;',
    '})()',
  ].join('\n');
}

/** How long {@link AutomationClient.navigate} lets the gateway wait for the `load` event by default. */
const DEFAULT_NAVIGATE_LOAD_TIMEOUT_MS = 30_000;

/**
 * Programmatic control surface over a `bgls.v1` session.
 *
 * The framing that matters: automation is a Viewer. `connect()` opens one
 * `bgls.v1` socket and registers as a Viewer with `kind: 'automation'`,
 * exactly like `@browserglass/client`'s `BrowserGlassClient`; every
 * interaction method requires the same `ControlLease` a human competes for,
 * and every dispatched event is the same `input.*` message a human's
 * `InputCapture` would send. There is no back door: this class is built
 * directly on `@browserglass/client`'s exported `Transport` (the same
 * connection-lifecycle class `BrowserGlassClient` itself is built on), not
 * on a private or parallel wire path.
 *
 * A method that needs something this wire cannot carry (an element handle,
 * for one) throws a typed `NOT_IMPLEMENTED` naming what it would need.
 */
/**
 * What `release()` needs for a client that `launch()` opened, keyed by the
 * shared core so a `forTarget()` sub-client releases the same browser.
 * A client from `connect()` has no entry, and its `release()` only closes
 * the socket.
 */
interface ReleaseState {
  readonly endBrowser: () => Promise<void>;
  done: Promise<void> | undefined;
}
const launched = new WeakMap<AutomationCore, ReleaseState>();

export class AutomationClient {
  private constructor(
    private readonly core: AutomationCore,
    private _targetId: string,
  ) {}

  /**
   * Opens one `bgls.v1` connection and binds to a target. Resolves once
   * `welcome` has been processed. `options.instanceId`, when given, is
   * validated against `welcome.instance.instanceId` (this build's `hello`
   * carries no instance-selection field of its own; the token's scope is
   * what actually pins the instance server side).
   */
  static async connect(options: AutomationClientOptions): Promise<AutomationClient> {
    const core = new AutomationCore(options);
    await core.transport.connect();

    if (options.instanceId !== undefined && core.instanceId !== options.instanceId) {
      core.destroy();
      throw new AutomationError(
        'INSTANCE_GONE',
        `connected instance '${core.instanceId}' does not match requested instanceId '${options.instanceId}'`,
      );
    }

    const targetId =
      options.targetId ?? core.targets.find((t) => t.active)?.targetId ?? core.targets[0]?.targetId;
    if (targetId === undefined) {
      core.destroy();
      throw new AutomationError(
        'NOT_FOUND',
        'no target available to bind to; pass options.targetId',
      );
    }
    return new AutomationClient(core, targetId);
  }

  /**
   * Starts a browser on a running gateway and returns a client connected
   * to it, in one call. Does the REST plumbing a script would otherwise
   * carry by hand: acquire with a fresh `requestId`, wait for `ready`,
   * mint a socket ticket with `caps`, connect, and (with `control`, the
   * default) take the control lease so the first `navigate()` just works.
   *
   * Call {@link release} when done; it ends the browser. Every option has
   * a default: the gateway comes from `BGLS_URL` or
   * `http://127.0.0.1:7799/browserglass`, the admin token from
   * `BGLS_ADMIN_TOKEN`. See {@link LaunchOptions}.
   *
   * ```ts
   * const browser = await AutomationClient.launch();
   * try {
   *   await browser.navigate('https://example.com');
   *   console.log(await browser.text());
   * } finally {
   *   await browser.release();
   * }
   * ```
   *
   * If anything fails after the browser was started (the connect, the
   * lease), the browser is ended again before this rethrows.
   */
  static async launch(opts: LaunchOptions = {}): Promise<AutomationClient> {
    const instance = await launchInstance(opts);
    let client: AutomationClient;
    try {
      client = await AutomationClient.connect({
        endpoint: instance.wsUrl,
        token: instance.ticket,
        instanceId: instance.instanceId,
        ...(opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
        ...(opts.stepBudget !== undefined ? { stepBudget: opts.stepBudget } : {}),
        ...(opts.yieldPolicy !== undefined ? { yieldPolicy: opts.yieldPolicy } : {}),
        ...(opts.onAction !== undefined ? { onAction: opts.onAction } : {}),
        ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
      });
    } catch (err) {
      await instance.release().catch(() => {});
      throw err;
    }
    launched.set(client.core, { endBrowser: instance.release, done: undefined });
    if (opts.control !== false) {
      try {
        await client.acquireControl();
      } catch (err) {
        await client.release().catch(() => {});
        throw err;
      }
    }
    return client;
  }

  /**
   * Closes the socket and, for a client from {@link launch}, ends the
   * browser (`DELETE /v1/instances/:id?force=true`, retried once or twice
   * on `E_TERMINATE_FAILED`). A launch with `profileKey` or `subject` may
   * be sharing its browser with other clients, so it releases without
   * `force`: the browser ends when the last client releases it, and an
   * earlier release only detaches. Idempotent: a second call waits on the
   * first. If ending the browser fails, the error is thrown and the next
   * call tries again. For a client from {@link connect} this is the same
   * as {@link close}, since this client did not start the browser.
   */
  async release(): Promise<void> {
    const state = launched.get(this.core);
    this.core.destroy();
    if (state === undefined) return;
    if (state.done === undefined) {
      state.done = state.endBrowser().catch((err: unknown) => {
        state.done = undefined;
        throw err;
      });
    }
    return state.done;
  }

  /** Whether this client holds the control lease on {@link targetId} right now. */
  get holdsControl(): boolean {
    return this.core.hasControl(this._targetId);
  }

  // ==================================================================
  // Binding and lease
  // ==================================================================

  /** The target this client currently addresses. */
  get targetId(): string {
    return this._targetId;
  }

  /** This connection's viewer id, or `null` before `connect()` resolves (never observed by a caller, since `connect()` only resolves after it is set). */
  get viewerId(): string | null {
    return this.core.viewerId;
  }

  /** This connection's session id. */
  get sessionId(): string | null {
    return this.core.sessionId;
  }

  /** The bound instance id. */
  get instanceId(): string | null {
    return this.core.instanceId;
  }

  /** Capabilities actually granted to this token, per `welcome.granted`. */
  get granted(): ReadonlySet<Capability> {
    return this.core.granted;
  }

  /** The current target list, from `welcome.targets` plus every `target.*` broadcast since. */
  get targets(): readonly TabSummary[] {
    return this.core.targets;
  }

  /** Rebinds this client to a different target on the same socket. Does not affect any lease already held on another target. */
  useTarget(targetId: string): void {
    this._targetId = targetId;
  }

  /** A sub-client bound to a different target, sharing this client's socket, capability grants, and step budget. */
  forTarget(targetId: string): AutomationClient {
    return new AutomationClient(this.core, targetId);
  }

  /**
   * Requests the `ControlLease` on {@link targetId}. Refuses immediately
   * with `POLICY_DENIED` when called inside the `requeueAfterMs` backoff
   * window left by a prior preemption on this target: agent obligations on
   * preemption require never re-requesting control before that window
   * elapses, and this is the SDK enforcing that contract rather
   * than trusting the caller.
   */
  async acquireControl(opts?: AcquireControlOptions): Promise<ControlLeaseHandle> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('control')) {
      throw new AutomationError(
        'POLICY_DENIED',
        "acquireControl() needs the 'control' capability",
        { required: 'control' },
      );
    }
    // A preemption in progress on this target refuses an acquire outright,
    // before the backoff check below, because at that moment there IS no
    // backoff yet: `requeueAfterMs` only arrives with `control.preempted`,
    // one message later. Without this an agent could answer a takeover
    // request by immediately asking for the lease back, which cancels its
    // own stand-down (`acquireControl()` being the one thing that reopens
    // dispatch), and the person who asked for the browser would watch the
    // agent hand it over and take it straight back. Not hypothetical:
    // `bg_swarm_run`'s acquire-do-release shape did exactly that to a
    // member being taken over, until this check existed.
    const pendingYield = this.core.yieldFor(targetId);
    if (pendingYield !== undefined && pendingYield.phase === 'requested') {
      throw new AutomationError(
        'POLICY_DENIED',
        `acquireControl() refused: ${pendingYield.byLabel || 'another viewer'} is taking control of ${targetId} right now and this client has stood down`,
        {
          yielded: true,
          phase: pendingYield.phase,
          reason: pendingYield.reason,
          human: pendingYield.human,
          byLabel: pendingYield.byLabel,
          ...(pendingYield.deadline !== null ? { retryAfter: pendingYield.deadline } : {}),
        },
      );
    }
    const blockedUntil = this.core.requeueBlockedUntil.get(targetId);
    if (blockedUntil !== undefined && Date.now() < blockedUntil) {
      // The refusal carries WHO took control and whether they were a
      // person, not just a number of milliseconds. An agent that only
      // learns "wait 28400ms" has no way to decide between retrying later
      // and abandoning the run, and the difference between a colleague
      // agent's priority win and a person putting their hand on the mouse
      // is exactly the input that decision needs.
      const ev = this.core.yieldFor(targetId);
      throw new AutomationError(
        'POLICY_DENIED',
        'acquireControl() refused: still inside the requeueAfterMs backoff window from a recent preemption',
        {
          retryAfterMs: blockedUntil - Date.now(),
          retryAfter: blockedUntil,
          ...(ev !== undefined
            ? { yielded: true, reason: ev.reason, human: ev.human, byLabel: ev.byLabel }
            : {}),
        },
      );
    }
    this.core.consumeStep();

    const waitMs = opts?.waitMs ?? 30000;
    const durationMs = opts?.durationMs ?? 60000;
    const autoRenew = opts?.autoRenew ?? true;
    const startedAt = Date.now();
    const id = this.core.newId();

    try {
      // The awaited promise MUST be constructed (its `message` listener
      // subscribed) before `send()` goes out: a scripted or real gateway
      // can reply synchronously within the `send()` call itself, and a
      // listener registered afterwards would miss it, hanging until the
      // timeout instead.
      const firstReplyPromise = this.core.awaitMessage<
        ControlGranted | ControlDenied | ControlQueued | ErrorMsg
      >((m) => m.re === id, waitMs === 0 ? this.core.defaultTimeoutMs : waitMs);
      this.core.transport.send({
        v: 1,
        t: 'control.request',
        id,
        ts: Date.now(),
        targetId,
        ttlMs: durationMs,
        queue: waitMs !== 0,
        ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      });
      let reply = await firstReplyPromise;

      if (reply.t === 'control.queued') {
        const remaining =
          waitMs === 0
            ? this.core.defaultTimeoutMs
            : Math.max(0, waitMs - (Date.now() - startedAt));
        reply = await this.core.awaitMessage<ControlGranted | ErrorMsg>(
          (m) => m.re === id && (m.t === 'control.granted' || m.t === 'error'),
          remaining,
        );
      }

      if (reply.t === 'error') throw AutomationError.fromErrorMsg(reply as ErrorMsg);
      if (reply.t === 'control.denied') {
        const d = reply as ControlDenied;
        throw new AutomationError('POLICY_DENIED', d.message, {
          reason: d.reason,
          ...(d.holderLabel !== undefined ? { holderLabel: d.holderLabel } : {}),
        });
      }

      const granted = reply as ControlGranted;
      const lease = new ControlLeaseHandleImpl(this.core, targetId, granted, autoRenew);
      this.core.leases.set(targetId, lease);
      // A grant is the one thing that ends a stand-down. Not the backoff
      // window elapsing, not the human's own lease expiring: the server
      // saying "this target is yours again". Until then every interaction
      // method on this target keeps refusing, which is what stops an agent
      // resuming on a timer while a person is still working.
      this.core.endStandDown(targetId);
      this.core.recordAction({
        action: 'acquireControl',
        targetId,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return lease;
    } catch (err) {
      const wrapped =
        err instanceof AutomationError
          ? err
          : new AutomationError('PROTOCOL_ERROR', err instanceof Error ? err.message : String(err));
      this.core.recordAction({
        action: 'acquireControl',
        targetId,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { code: wrapped.code, message: wrapped.message },
      });
      throw wrapped;
    }
  }

  /** Releases the lease this client holds on {@link targetId}, if any. A no-op if no lease is held. */
  async releaseControl(): Promise<void> {
    const lease = this.core.leases.get(this._targetId);
    if (!lease) return;
    await lease.release();
  }

  // ==================================================================
  // Standing down: a human takes the browser back.
  // Three pieces, and they are deliberately
  // separate calls rather than one option bag: knowing you were
  // interrupted, seeing the state afterwards, and deciding to start
  // again are three different decisions, and only the third is one an
  // agent may make on a timer.
  // ==================================================================

  /**
   * Fires whenever this connection stands down on any target: a human (or
   * a higher-priority agent) asked for control, control was actually
   * taken, or {@link yieldControl} was called.
   *
   * Connection-wide on purpose, and this is the difference between it and
   * `ControlLeaseHandle.onPreemptionRequested()`. That one exists per
   * lease, so using it means re-registering after every
   * `acquireControl()`, on every target, and it goes quiet exactly when
   * the interesting thing happens: the handle it hangs off is the thing
   * being revoked. An agent driving twenty browsers would need twenty
   * registrations refreshed on every acquire. This fires for every target
   * on the socket, keeps firing across acquires, and carries the
   * `human` flag and the in-flight list. Registered once, at
   * connect time, it stays correct.
   *
   * By the time a listener runs, input dispatch on that target is already
   * refused (see `AutomationCore.standDown()`), so a listener is for
   * deciding what the AGENT does next, never for stopping the client.
   * Returns its own unsubscribe.
   *
   * ```ts
   * client.onControlYield((ev) => {
   *   if (ev.human) plan.abort(`${ev.byLabel} took over mid-${ev.inFlight[0]?.action ?? 'idle'}`);
   * });
   * ```
   */
  onControlYield(cb: (ev: ControlYieldEvent) => void): Unsubscribe {
    this.core.yieldCbs.add(cb);
    return () => {
      this.core.yieldCbs.delete(cb);
    };
  }

  /**
   * The stand-down currently in force on `targetId` (default
   * {@link targetId}), or `null` when this client is free to drive it.
   *
   * The pull-based half of {@link onControlYield}, for a caller with no
   * good place to put a callback: an MCP tool handler, a polling loop, an
   * error path deciding whether a failure was a takeover or a genuine
   * fault. Survives the lease it started under, so it still answers "who
   * took this, and when may I ask for it back" long after the handle is
   * gone.
   */
  yieldStatus(targetId?: string): ControlYieldEvent | null {
    return this.core.yieldFor(targetId ?? this._targetId) ?? null;
  }

  /**
   * Stands down on {@link targetId} deliberately: stops dispatching and
   * releases the lease, without waiting to be asked.
   *
   * For an agent that has decided by itself that a person should have the
   * browser (it hit something it cannot handle, its plan finished, it was
   * told to hand over out of band), and for a caller wiring up a
   * shared-mode yield, where a person asks the agent holders on a target
   * to stop without evicting the other people driving it.
   *
   * Unlike a preemption this sets no backoff window: nobody imposed one,
   * and the agent that chose to stop is trusted to choose when to start
   * again. It still has to ASK again, though; `acquireControl()` is the
   * only thing that reopens dispatch.
   */
  async yieldControl(reason?: string): Promise<void> {
    const targetId = this._targetId;
    await this.releaseControl();
    this.core.standDown({
      targetId,
      phase: 'taken',
      reason: 'voluntary',
      byLabel: '',
      byKind: 'automation',
      human: false,
      deadline: null,
      inFlight: this.core.inFlightFor(targetId),
      resumeNotBefore: null,
    });
    this.core.recordAction({
      action: 'yieldControl',
      targetId,
      ...(reason !== undefined ? { args: { reason } } : {}),
      ok: true,
      durationMs: 0,
    });
  }

  /**
   * Waits until this client would be allowed to ask for control of
   * {@link targetId} again, then resolves. While this client is stood down
   * on the target (after {@link yieldControl}, or after somebody took the
   * browser over), "allowed again" means somebody else has had control
   * since the stand-down began and has since let it go. Does NOT acquire anything: the
   * caller still has to call `acquireControl()`, and that call is what
   * ends the stand-down.
   *
   * This is the resume policy, and it is manual by design. Nothing in
   * this SDK ever re-acquires control on its own, on a timer or otherwise.
   * An agent that came back automatically after the backoff elapsed would
   * be resuming while the person who took over is, in the overwhelmingly
   * likely case, still working: thirty seconds is how long the server
   * makes an agent wait, not how long a human takes to finish. So the
   * resumption is a call an agent has to make, in its own code, where a
   * reader can see it.
   *
   * What this method adds over `sleep(requeueAfterMs)` is the second
   * condition. It waits for BOTH: the backoff window to elapse, AND the
   * target to stop being held by somebody else. Waiting out only the
   * clock is the mistake that produces the exact failure this API
   * exists to remove, an agent queueing up behind a person who is still
   * mid-task and taking the pointer back the moment their lease lapses.
   *
   * The handover has to have actually happened. Straight after
   * `yieldControl()` the lease table can still name this client, and a
   * moment later it names nobody, so a check for "nobody else holds it"
   * passes before any person has had the browser at all. While a
   * stand-down is in force this therefore waits until a different viewer
   * has held control at some point since it began, and only then for
   * that viewer to let go. If nobody ever takes control it keeps waiting,
   * until `timeoutMs` (default: forever), and then throws `TIMEOUT`; it
   * never decides on its own that nobody is coming. With no stand-down in
   * force (this client never yielded, or has already re-acquired) it
   * waits only for the backoff and for nobody else to hold the target.
   *
   * ```ts
   * await client.yieldControl('need a person to solve the captcha');
   * await client.waitForResume({ timeoutMs: 10 * 60_000 });
   * await client.acquireControl();
   * ```
   */
  async waitForResume(opts?: WaitForResumeOptions): Promise<void> {
    const targetId = this._targetId;
    const timeoutMs = opts?.timeoutMs ?? Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    const remaining = (): number => timeoutMs - (Date.now() - startedAt);

    const blockedUntil = this.core.requeueBlockedUntil.get(targetId);
    if (blockedUntil !== undefined && Date.now() < blockedUntil) {
      const waitMs = blockedUntil - Date.now();
      if (waitMs > remaining()) {
        throw new AutomationError(
          'TIMEOUT',
          `waitForResume() timed out after ${timeoutMs}ms: ${waitMs}ms of requeue backoff still to run`,
          { retryAfter: blockedUntil },
        );
      }
      await sleepMs(waitMs);
    }

    // Then the holder condition. `control.state` is the session-wide lease
    // table broadcast on every lease change, so waiting for the next one
    // and re-checking is exactly "wake me when something about control
    // changed", with no polling interval to tune.
    const awaitingHandover = (): boolean =>
      this.core.yieldFor(targetId) !== undefined && !this.core.otherHolderSeen.has(targetId);
    while (awaitingHandover() || this.core.someoneElseHolds(targetId)) {
      const left = remaining();
      if (left <= 0) {
        if (awaitingHandover()) {
          throw new AutomationError(
            'TIMEOUT',
            `waitForResume() timed out after ${timeoutMs}ms: nobody else took control of ${targetId} after this client stood down`,
          );
        }
        const holder = this.core.leaseStateByTarget.get(targetId)?.holderLabel ?? 'someone else';
        throw new AutomationError(
          'TIMEOUT',
          `waitForResume() timed out after ${timeoutMs}ms: ${holder} still holds control of ${targetId}`,
        );
      }
      try {
        await this.core.awaitMessage((m) => m.t === 'control.state', left);
      } catch (err) {
        // Out of time with no new broadcast: go round once more so the
        // error names what was still missing.
        if (err instanceof AutomationError && err.code === 'TIMEOUT' && remaining() <= 0) continue;
        throw err;
      }
    }
  }

  /**
   * Manual recovery rung R4: destroys and relaunches every target in the
   * bound instance, not just this client's own target. Gated behind
   * `instance.restart` (never in the default `agent` role bundle), plus
   * `profile.write` when `preserveProfile: false`.
   */
  async restartInstance(opts?: RestartInstanceOptions): Promise<RestartInstanceResult> {
    if (!this.core.hasCapability('instance.restart')) {
      throw new AutomationError(
        'POLICY_DENIED',
        "restartInstance() needs the 'instance.restart' capability",
        { required: 'instance.restart' },
      );
    }
    if (opts?.preserveProfile === false && !this.core.hasCapability('profile.write')) {
      throw new AutomationError(
        'POLICY_DENIED',
        "restartInstance({preserveProfile:false}) needs the 'profile.write' capability",
        { required: 'profile.write' },
      );
    }
    const instanceId = this.core.instanceId;
    if (!instanceId) throw new AutomationError('INSTANCE_GONE', 'no connected instance');
    this.core.consumeStep();

    const timeoutMs = opts?.timeoutMs ?? 60000;
    const startedAt = Date.now();
    const id = this.core.newId();
    try {
      // See the matching comment in `acquireControl()`: the listener must
      // be subscribed before `send()`, since a reply can arrive
      // synchronously within that call.
      const replyPromise = this.core.awaitMessage<InstanceRecovered | ErrorMsg>(
        (m) =>
          (m.t === 'instance.recovered' && m['instanceId'] === instanceId) ||
          (m.t === 'error' && m.re === id),
        timeoutMs,
      );
      this.core.transport.send({
        v: 1,
        t: 'instance.restart',
        id,
        ts: Date.now(),
        instanceId,
        ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
        ...(opts?.preserveProfile !== undefined ? { preserveProfile: opts.preserveProfile } : {}),
      });
      const reply = await replyPromise;
      if (reply.t === 'error') throw AutomationError.fromErrorMsg(reply as ErrorMsg);
      const r = reply as InstanceRecovered;
      const result: RestartInstanceResult = {
        rung: r.rung,
        durationMs: Date.now() - startedAt,
        streamsResubscribed: r.streamsResubscribed,
        streamsLost: r.streamsLost,
      };
      this.core.recordAction({
        action: 'restartInstance',
        targetId: this._targetId,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      const wrapped =
        err instanceof AutomationError
          ? err
          : new AutomationError('PROTOCOL_ERROR', err instanceof Error ? err.message : String(err));
      this.core.recordAction({
        action: 'restartInstance',
        targetId: this._targetId,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { code: wrapped.code, message: wrapped.message },
      });
      throw wrapped;
    }
  }

  /** Closes the connection. Best-effort releases every lease this client holds first. Terminal. */
  close(): void {
    this.core.destroy();
  }

  // ==================================================================
  // Navigation (requires `navigate` AND the held lease)
  // ==================================================================

  /**
   * Navigates {@link targetId} to `url` and resolves once the page has
   * loaded, so reading the page straight after `await navigate(url)` sees
   * the new document (its real `title`, `loading: false`).
   *
   * `waitUntil` picks when this resolves:
   *
   * * `'load'` (the default): after the new document's `load` event. If
   *   the page has not loaded within `timeoutMs` (default 30000) this still
   *   resolves, with `loading: true`, rather than throwing; check
   *   `loading` when it matters.
   * * `'commit'`: as soon as the navigation commits, with the page still
   *   loading (`loading: true`, usually an empty `title`). The old
   *   behaviour; use it when you will wait some other way.
   * * `'networkidle'`: not implemented by the gateway, which refuses it.
   *
   * Requires `navigate` and a held control lease.
   */
  async navigate(url: string, opts?: NavigateOptions): Promise<StatusResult> {
    const waitUntil = opts?.waitUntil ?? 'load';
    const loadTimeoutMs = opts?.timeoutMs ?? DEFAULT_NAVIGATE_LOAD_TIMEOUT_MS;
    return this.run('navigate', this._targetId, ['navigate'], true, { url }, false, async () => {
      const reply = await this.core.request<NavState>(
        'nav.goto',
        {
          targetId: this._targetId,
          url,
          ...(opts?.referrer !== undefined ? { referrer: opts.referrer } : {}),
          waitUntil,
          ...(waitUntil === 'load' ? { timeoutMs: loadTimeoutMs } : {}),
        },
        // The server answers by `timeoutMs` at the latest when waiting for
        // load; this client waits a little longer so the honest
        // `loading: true` reply wins over a client side TIMEOUT.
        waitUntil === 'load'
          ? Math.max(this.core.defaultTimeoutMs, loadTimeoutMs + 5000)
          : undefined,
      );
      return this.navStateToStatus(reply);
    });
  }

  async goBack(): Promise<StatusResult> {
    return this.run('goBack', this._targetId, ['navigate'], true, undefined, false, async () =>
      this.navStateToStatus(
        await this.core.request<NavState>('nav.back', { targetId: this._targetId }),
      ),
    );
  }

  async goForward(): Promise<StatusResult> {
    return this.run('goForward', this._targetId, ['navigate'], true, undefined, false, async () =>
      this.navStateToStatus(
        await this.core.request<NavState>('nav.forward', { targetId: this._targetId }),
      ),
    );
  }

  async reload(opts?: { ignoreCache?: boolean }): Promise<StatusResult> {
    return this.run('reload', this._targetId, ['navigate'], true, undefined, false, async () =>
      this.navStateToStatus(
        await this.core.request<NavState>('nav.reload', {
          targetId: this._targetId,
          ...(opts?.ignoreCache !== undefined ? { ignoreCache: opts.ignoreCache } : {}),
        }),
      ),
    );
  }

  async stop(): Promise<void> {
    return this.run('stop', this._targetId, ['navigate'], true, undefined, false, async () => {
      this.core.send('nav.stop', { targetId: this._targetId });
    });
  }

  /** URL, title, loading state, history, and the current lease holder for {@link targetId}. No CDP traffic: built entirely from cached broadcasts. Requires only `view`. */
  async status(): Promise<StatusResult> {
    const targetId = this._targetId;
    return this.run('status', targetId, ['view'], false, undefined, false, async () => {
      const target = this.core.targets.find((t) => t.targetId === targetId);
      const nav = this.core.navStateByTarget.get(targetId);
      if (!target && !nav)
        throw new AutomationError('TARGET_CLOSED', `no such target: ${targetId}`);
      const holder = this.leaseHolderFor(targetId);
      return {
        targetId,
        url: nav?.url ?? target?.url ?? '',
        title: nav?.title ?? target?.title ?? '',
        loading: nav?.loading ?? target?.loading ?? false,
        canGoBack: nav?.canGoBack ?? target?.canGoBack ?? false,
        canGoForward: nav?.canGoForward ?? target?.canGoForward ?? false,
        leaseHolderViewerId: holder.viewerId,
        leaseHolderLabel: holder.label,
      };
    });
  }

  /**
   * Resolves the current lease holder for `targetId`. Prefers a lease this
   * client itself holds (known with certainty the instant `acquireControl()`
   * resolves) over the session-wide `control.state` broadcast cache, which
   * may not have arrived yet even though this client's own grant already
   * did (each is delivered by an independent wire message).
   */
  private leaseHolderFor(targetId: string): { viewerId: string | null; label: string | null } {
    if (this.core.hasControl(targetId)) return { viewerId: this.core.viewerId, label: null };
    const lease = this.core.leaseStateByTarget.get(targetId);
    return { viewerId: lease?.holderViewerId ?? null, label: lease?.holderLabel ?? null };
  }

  private navStateToStatus(n: NavState): StatusResult {
    const holder = this.leaseHolderFor(n.targetId);
    return {
      targetId: n.targetId,
      url: n.url,
      title: n.title,
      loading: n.loading,
      canGoBack: n.canGoBack,
      canGoForward: n.canGoForward,
      leaseHolderViewerId: holder.viewerId,
      leaseHolderLabel: holder.label,
    };
  }

  // ==================================================================
  // Reading (view + automation, NOT a lease)
  // ==================================================================

  /** A full-resolution screenshot via `target.capture`. Only the inline-delivery wire path is implemented; a reply carrying `downloadId` instead of `data` (very large images) throws `NOT_IMPLEMENTED`. */
  async screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    const targetId = this._targetId;
    return this.run(
      'screenshot',
      targetId,
      ['view', 'automation', 'capture'],
      false,
      opts as Record<string, unknown> | undefined,
      false,
      async () => {
        const reply = await this.core.request<TargetCaptured>('target.capture', {
          targetId,
          delivery: 'inline',
          ...(opts?.format !== undefined ? { format: opts.format } : {}),
          ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
          ...(opts?.fullPage !== undefined ? { fullPage: opts.fullPage } : {}),
          ...(opts?.maxDimension !== undefined ? { maxDimension: opts.maxDimension } : {}),
        });
        if (reply.data === undefined)
          throw AutomationError.notImplemented(
            'screenshot (url delivery)',
            'a download-fetch path for large captures, not built in this pass',
          );
        this.core.rememberGen(targetId, reply.gen);
        return {
          captureId: reply.captureId,
          targetId: reply.targetId,
          format: reply.format,
          width: reply.width,
          height: reply.height,
          sizeBytes: reply.sizeBytes,
          data: reply.data,
        };
      },
    );
  }

  /**
   * Renders the target as a PDF via `page.pdf.get`. Only the `capture`
   * capability is needed, the same as {@link screenshot}: a PDF is a
   * render of the page the caller can already see, not a new privilege.
   *
   * DIVERGES from {@link screenshot}'s own refusal of large-capture URL
   * delivery, deliberately: see {@link PdfResult}'s own doc for why an
   * unbuilt download-fetch path is an acceptable gap for a screenshot
   * (large images are the rare case) but not for a PDF (large is the
   * common case for any real page). This method never throws
   * `NOT_IMPLEMENTED` for delivery shape; it returns whichever of `data`
   * or `downloadId`/`url` the server produced, mirroring
   * {@link waitForDownload}'s own already-established "hand back the
   * signed URL, let the caller fetch it" contract rather than pulling
   * potentially many megabytes through this process a second time.
   */
  async pdf(opts?: PdfOptions): Promise<PdfResult> {
    const targetId = this._targetId;
    return this.run(
      'pdf',
      targetId,
      ['capture'],
      false,
      opts as Record<string, unknown> | undefined,
      false,
      async () => {
        const reply = await this.core.request<PagePdfGot>(
          'page.pdf.get',
          {
            targetId,
            ...(opts?.format !== undefined ? { format: opts.format } : {}),
            ...(opts?.widthInches !== undefined ? { widthInches: opts.widthInches } : {}),
            ...(opts?.heightInches !== undefined ? { heightInches: opts.heightInches } : {}),
            ...(opts?.landscape !== undefined ? { landscape: opts.landscape } : {}),
            ...(opts?.printBackground !== undefined
              ? { printBackground: opts.printBackground }
              : {}),
            ...(opts?.scale !== undefined ? { scale: opts.scale } : {}),
            ...(opts?.marginTopInches !== undefined
              ? { marginTopInches: opts.marginTopInches }
              : {}),
            ...(opts?.marginBottomInches !== undefined
              ? { marginBottomInches: opts.marginBottomInches }
              : {}),
            ...(opts?.marginLeftInches !== undefined
              ? { marginLeftInches: opts.marginLeftInches }
              : {}),
            ...(opts?.marginRightInches !== undefined
              ? { marginRightInches: opts.marginRightInches }
              : {}),
            ...(opts?.pageRanges !== undefined ? { pageRanges: opts.pageRanges } : {}),
            ...(opts?.headerTemplate !== undefined ? { headerTemplate: opts.headerTemplate } : {}),
            ...(opts?.footerTemplate !== undefined ? { footerTemplate: opts.footerTemplate } : {}),
          },
          opts?.timeoutMs ?? 45000,
        );
        this.core.rememberGen(targetId, reply.gen);
        return {
          pdfId: reply.pdfId,
          targetId: reply.targetId,
          sizeBytes: reply.sizeBytes,
          ...(reply.data !== undefined ? { data: reply.data } : {}),
          ...(reply.downloadId !== undefined ? { downloadId: reply.downloadId } : {}),
          ...(reply.url !== undefined ? { url: this.core.resolveGatewayUrl(reply.url) } : {}),
          ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}),
          ...(reply.sha256 !== undefined ? { sha256: reply.sha256 } : {}),
        };
      },
    );
  }

  /**
   * Starts a durable, disk-persisted recording of {@link targetId}'s
   * stream, via `recording.start`. Requires BOTH `capture` AND `download`
   * together, checked locally (in `caps` order, so a token missing both
   * is told about `capture` first) before any round trip: `capture` is
   * the momentary-render half every other reader of this target already
   * needs, and `download` is the durable-artifact half, the identical
   * authority {@link waitForDownload} already gates for a real browser
   * download. A recording is exactly that kind of artifact: a file that
   * outlives this socket, this viewer, and this session itself, not a
   * frame that is gone once sent. See
   * `@browserglass/protocol`'s `wire/messages/recording.ts` module doc for
   * the full argument for why neither capability alone is honest about
   * what this grants.
   *
   * THE RECORDING ITSELF NEVER TRAVELS OVER THIS SOCKET. It is written by
   * the gateway process to whatever `--recordings-dir` it was started
   * with; this method returns only {@link RecordingHandle.recordingId},
   * the handle {@link stopRecording} needs later. Reading the finished
   * recording back is the `bgls` CLI's job (`bgls record list`/`bgls
   * record export`, pointed at that same directory), never this SDK's:
   * see `packages/cli/src/commands/record.ts`'s own module doc for why it
   * reads the on-disk layout directly rather than asking a live socket.
   */
  async startRecording(opts?: StartRecordingOptions): Promise<RecordingHandle> {
    const targetId = this._targetId;
    return this.run(
      'startRecording',
      targetId,
      ['capture', 'download'],
      false,
      opts as Record<string, unknown> | undefined,
      false,
      async () => {
        const reply = await this.core.request<RecordingStarted>(
          'recording.start',
          { targetId, ...(opts?.mode !== undefined ? { mode: opts.mode } : {}) },
          opts?.timeoutMs,
        );
        return {
          recordingId: reply.recordingId,
          targetId: reply.targetId,
          mode: reply.mode,
          startedAtMs: reply.startedAtMs,
        };
      },
    );
  }

  /**
   * Stops a recording started with {@link startRecording}, via
   * `recording.stop`. Requires the identical `capture` AND `download`
   * double gate {@link startRecording} does; see that method's own doc.
   *
   * Answered even for a recording that had already degraded to a no-op
   * after a sink failure ({@link StopRecordingResult.failed}):
   * `framesWritten` still counts whatever reached disk before that
   * happened, so this never throws merely because the recording stopped
   * writing early.
   */
  async stopRecording(
    recordingId: string,
    opts?: { timeoutMs?: number },
  ): Promise<StopRecordingResult> {
    const targetId = this._targetId;
    return this.run(
      'stopRecording',
      targetId,
      ['capture', 'download'],
      false,
      { recordingId },
      false,
      async () => {
        const reply = await this.core.request<RecordingStopped>(
          'recording.stop',
          { recordingId },
          opts?.timeoutMs,
        );
        return {
          recordingId: reply.recordingId,
          targetId: reply.targetId,
          startedAtMs: reply.startedAtMs,
          stoppedAtMs: reply.stoppedAtMs,
          framesWritten: reply.framesWritten,
          ...(reply.framesDropped !== undefined ? { framesDropped: reply.framesDropped } : {}),
          failed: reply.failed,
        };
      },
    );
  }

  /**
   * Lists recordings THIS SESSION'S SOCKET currently knows about, via
   * `recording.list`. Requires the identical `capture` AND `download`
   * double gate {@link startRecording} does.
   *
   * This is an in-memory view that forgets everything the instant the
   * socket that started a recording closes; it does not, and cannot,
   * answer "what recordings exist on this gateway" or "did that recording
   * finish cleanly", because there is no socket left to ask once a
   * session ends. `bgls record list`, reading the on-disk layout
   * directly, is the only way to answer either question after the fact;
   * see `packages/cli/src/commands/record.ts`'s own module doc for why.
   */
  async listRecordings(opts?: ListRecordingsOptions): Promise<readonly RecordingSummary[]> {
    const targetId = this._targetId;
    return this.run(
      'listRecordings',
      targetId,
      ['capture', 'download'],
      false,
      opts as Record<string, unknown> | undefined,
      false,
      async () => {
        const reply = await this.core.request<RecordingListed>(
          'recording.list',
          { ...(opts?.targetId !== undefined ? { targetId: opts.targetId } : {}) },
          opts?.timeoutMs,
        );
        return reply.recordings;
      },
    );
  }

  /**
   * Hit-tests one point via `target.probe`. Coordinates are viewport CSS
   * pixels: this client stamps `fw`/`fh` as the instance's real viewport
   * dimensions (`welcome.instance.viewport`), which makes the server's own
   * `frame space -> multiply by viewport.width/fw -> CSS px` transform an
   * identity, so the `x`/`y` this method (and every interaction method)
   * takes ARE viewport CSS pixels directly, with no separate wire message
   * needed.
   */
  async inspectAt(x: number, y: number, opts?: InspectAtOptions): Promise<InspectResult> {
    const targetId = this._targetId;
    const detail = opts?.detail ?? 'hover';
    const caps: Capability[] = ['view', 'automation'];
    if (PROBE_CAPABILITY_RULE.appliesWhen({ detail }))
      caps.push(PROBE_CAPABILITY_RULE.additionalCapability);
    return this.run('inspectAt', targetId, caps, false, { x, y, detail }, false, async () => {
      const reply = await this.core.request<TargetProbed>('target.probe', {
        targetId,
        x,
        y,
        fw: this.core.viewport.width,
        fh: this.core.viewport.height,
        detail,
      });
      this.core.rememberGen(targetId, reply.gen);
      return {
        hit: reply.hit,
        gen: reply.gen,
        ...(reply.rect !== undefined ? { rect: reply.rect } : {}),
        ...(reply.label !== undefined ? { label: reply.label } : {}),
        ...(reply.tagName !== undefined ? { tagName: reply.tagName } : {}),
        ...(reply.href !== undefined ? { href: reply.href } : {}),
        ...(reply.name !== undefined ? { name: reply.name } : {}),
        ...(reply.role !== undefined ? { role: reply.role } : {}),
      };
    });
  }

  /** Convenience wrapper over {@link inspectAt}: just the hit rect, or `null` when nothing was hit. */
  async rect(x: number, y: number): Promise<import('@browserglass/protocol').ProbeRect | null> {
    const r = await this.inspectAt(x, y, { detail: 'hover' });
    return r.rect ?? null;
  }

  /**
   * Refused, and the refusal is the design rather than a gap.
   *
   * An `elements()` that returned handles cannot exist on this wire:
   * `PageEvaluate` returns by value and never an `objectId`, permanently
   * (see its module doc, escalation path 5). {@link resolve} is the answer,
   * and it returns strictly more than a handle list would: rects, all five
   * actionability answers, and what is sitting on top of each match.
   */
  async elements(): Promise<never[]> {
    throw AutomationError.notImplemented(
      'elements',
      'element handles, which this wire refuses to carry by design (page evaluation returns by value and never an objectId). Use resolve(selector), which returns every match with its rect and actionability state',
    );
  }
  /**
   * Reads Chrome's OWN accessibility tree for this target: every node's
   * role, computed accessible name, and the handful of properties that
   * decide whether an LLM agent reading this list should treat a node as
   * actionable (`focusable`, `disabled`, `expanded`, `checked`, ...).
   * Shaped for that reader rather than a raw CDP `AXNode` dump: no
   * `nodeId`/`parentId`/`childIds` tree-walking machinery, no
   * `ignoredReasons`, just the facts worth reading.
   *
   * This method used to refuse outright, saying plainly that CDP's
   * `Accessibility` domain was never enabled anywhere in this build,
   * confirmed by grepping
   * `packages/core/src` and `packages/server/src` for `'Accessibility.'`
   * and finding nothing. That premise is gone: `packages/core/src/cdp/accessibility.ts`
   * is now the one place in this build that sends `Accessibility.queryAXTree`,
   * and this method is its read-only caller. Confirm it yourself with the
   * identical grep; the only other caller is the `role=` locator selector
   * (`resolve()`'s own doc, and `locator/engine.ts`'s module doc), which
   * asks the SAME question with a role/name filter rather than reading it
   * by hand a second way.
   *
   * BOUNDED, and truncation reported honestly. `Accessibility.queryAXTree`
   * with no filter walks the whole page, so `nodes` is capped (`maxNodes`,
   * default 200, at most 1000) and additionally byte-capped server side
   * (`@browserglass/protocol`'s `wire/messages/a11y.ts`,
   * `MAX_A11Y_RESULT_BYTES`); either bound sets {@link A11yResult.truncated}
   * rather than silently cutting the reply. Pass `role`/`name` when you
   * know what you want: `client.a11y({ role: 'button' })` is both a
   * narrower CDP query and a smaller reply than reading everything and
   * filtering client side.
   *
   * GATED ON `devtools`, not `evaluate`. This method runs no page script
   * at all: `Accessibility.queryAXTree` is a CDP domain call, the same
   * kind of read `diagnostics.subscribe()` and `responseBody()` already
   * make under `devtools`, not the page-authorship privilege `evaluate`
   * guards. Checked locally so a caller lacking it fails fast rather than
   * paying a round trip for the server to refuse it.
   *
   * ```ts
   * const tree = await client.a11y({ role: 'button' });
   * tree.nodes.map(n => n.name); // every button's accessible name
   * ```
   */
  async a11y(opts?: A11yOptions): Promise<A11yResult> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('devtools')) {
      throw new AutomationError('POLICY_DENIED', "a11y() needs the 'devtools' capability", {
        required: 'devtools',
      });
    }
    return this.run(
      'a11y',
      targetId,
      [],
      false,
      {
        ...(opts?.role !== undefined ? { role: opts.role } : {}),
        ...(opts?.name !== undefined ? { name: opts.name } : {}),
      },
      false,
      async () => {
        const reply = await this.sendA11y(
          targetId,
          {
            ...(opts?.role !== undefined ? { role: opts.role } : {}),
            ...(opts?.name !== undefined ? { name: opts.name } : {}),
            ...(opts?.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
          },
          opts?.timeoutMs,
        );
        return { nodes: reply.nodes, total: reply.total, truncated: reply.truncated };
      },
    );
  }

  /**
   * The shared round trip behind {@link a11y} and the locator engine's
   * `role=` selector (`this.locators`'s `queryAndStampByRole`): ONE
   * `page.a11y.get` request, with or without `stamp: true`. Kept as one
   * method for the same reason `sendEvaluateSource` is one method behind
   * two callers: there is exactly one wire shape to get right, not two
   * that could drift apart.
   */
  private async sendA11y(
    targetId: string,
    req: { role?: string; name?: string; maxNodes?: number; stamp?: boolean },
    timeoutMs?: number,
  ): Promise<PageA11yGot> {
    return this.core.request<PageA11yGot>(
      'page.a11y.get',
      {
        targetId,
        ...(req.role !== undefined ? { role: req.role } : {}),
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.maxNodes !== undefined ? { maxNodes: req.maxNodes } : {}),
        ...(req.stamp !== undefined ? { stamp: req.stamp } : {}),
      },
      timeoutMs,
    );
  }

  /**
   * Captures an indexed page map: every element the interactivity cascade
   * judged actionable, with a rect, an occlusion answer, and the fixed
   * LLM-priced attribute subset, in ONE round trip. This is the bigger
   * sibling {@link a11y} names in its own doc: `page.a11y.get` returns role
   * and name with no geometry and no occlusion answer, so an agent that has
   * never seen the page cannot form a selector from it alone. A page map
   * closes that gap.
   *
   * Answers are FLAT, not a tree: `nodes` is the curated, indexed subset an
   * agent can act on, in priority order (in-viewport first, then
   * descending paint order, then document order), not a DOM walk with
   * every uninteresting container
   * still present. There is no parent/child linkage to reconstruct.
   *
   * GATED ON `devtools`, not `evaluate`, for the identical reason
   * {@link a11y} is: the capture runs no page script at all
   * (`DOMSnapshot.captureSnapshot`, `DOM.getDocument`,
   * `Page.getFrameTree`, `Accessibility.getFullAXTree`, and, when
   * `listeners` is left at its default, `DOMDebugger.getEventListeners`,
   * every one a CDP domain read). Checked locally so a caller lacking it
   * fails fast rather than paying a round trip for the server to refuse it.
   *
   * TRUNCATION AND DEGRADATION ARE DATA, never a silently smaller answer.
   * {@link PageMapResult.truncatedByReason} says not just how many nodes
   * were cut but WHY: `offscreen` means scrolling and re-capturing is
   * likely to surface more, `onscreen` means the byte budget was spent on
   * visible content alone and scrolling will not help, `unpositioned` means
   * the cascade judged the node actionable but the snapshot gave it no
   * layout, so there is nowhere to click and re-capturing will not change
   * that either. {@link PageMapResult.degraded} reports, per frame, which
   * accessibility reads failed (a node from a failed frame keeps its `tag`,
   * `rect` and `attributes`, and loses `role`/`name` to `null`) and,
   * separately, whether the listener signal ran across the WHOLE capture:
   * `'skipped'` when `listeners: false` was requested, `'failed'` when it
   * was asked for and could not run. There is no per-node listener flag on
   * the wire; the signal's only visible effect is which elements got
   * INDEXED AT ALL (an element with no ARIA role, no `tabindex` and no
   * pointer cursor is included only because a listener was found on it).
   * `degraded.listeners !== 'ok'` means that inclusion channel did not run,
   * so a smaller-than-expected `nodes` list on a JS-heavy page proves
   * nothing by itself; check `degraded.listeners` before reading absence as
   * evidence.
   *
   * THE LISTENER SIGNAL'S OWN LIMIT, stated plainly rather than oversold:
   * `DOMDebugger.getEventListeners` reports a listener on the ELEMENT IT IS
   * ATTACHED TO. A framework that delegates event handling to one ancestor
   * (React 17 and later attach a single delegated listener at the root
   * container, not one per element, measured directly in
   * `examples/nextjs-demo/pagemap-listeners-probe.mjs`) reports the
   * listener on that container, never on the child that actually reacts to
   * the click, so a delegated child is indexed only if it carries some OTHER
   * signal (role, `tabindex`, pointer cursor). This build cannot and does
   * not claim otherwise.
   *
   * ACTING ON AN INDEX: {@link PageMapNode.index} is Chrome's own
   * `backendNodeId`, stable for the life of the node but silently reused
   * across a navigation. {@link PageMapResult.epoch} is minted per capture
   * so a caller can detect a stale index BEFORE acting rather than after,
   * which a `ref` from {@link resolve} can never do (a `ref`'s staleness is
   * only ever discovered on use). Pass the epoch and the chosen indices to
   * {@link stampPageMap}, then act through the ordinary
   * `resolve()`/`click()` path on the marker it returns: there is no
   * index-addressed input message on this wire, deliberately, so an index
   * click goes through the identical lease, generation stamp and fencing
   * every other click does.
   */
  async pageMap(opts?: PageMapOptions): Promise<PageMapResult> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('devtools')) {
      throw new AutomationError('POLICY_DENIED', "pageMap() needs the 'devtools' capability", {
        required: 'devtools',
      });
    }
    return this.run(
      'pageMap',
      targetId,
      [],
      false,
      {
        ...(opts?.include !== undefined ? { include: opts.include } : {}),
        ...(opts?.listeners !== undefined ? { listeners: opts.listeners } : {}),
      },
      false,
      async () => {
        const reply = await this.core.request<PageMapGot>(
          'page.map.get',
          {
            targetId,
            ...(opts?.include !== undefined ? { include: opts.include } : {}),
            ...(opts?.listeners !== undefined ? { listeners: opts.listeners } : {}),
          },
          opts?.timeoutMs,
        );
        return {
          epoch: reply.epoch,
          ...(reply.nodes !== undefined ? { nodes: reply.nodes } : {}),
          ...(reply.total !== undefined ? { total: reply.total } : {}),
          ...(reply.truncated !== undefined ? { truncated: reply.truncated } : {}),
          ...(reply.truncatedByReason !== undefined
            ? { truncatedByReason: reply.truncatedByReason }
            : {}),
          ...(reply.degraded !== undefined ? { degraded: reply.degraded } : {}),
          ...(reply.text !== undefined ? { text: reply.text } : {}),
        };
      },
    );
  }

  /**
   * Writes a fresh, per-request DOM attribute onto the given
   * {@link PageMapNode.index} values from an earlier {@link pageMap}
   * capture, so an ordinary `resolve()`/`click()` selector can address them
   * afterward: `css=[<marker>]`, exactly the way `A11yResult`'s own
   * `role=` locator marker works. This is the whole "acting on an index"
   * story {@link pageMap}'s own doc points at; there is no other way in.
   *
   * `epoch` MUST equal the {@link PageMapResult.epoch} the indices were
   * read from. A mismatch is refused with a stale-epoch error before any
   * CDP command goes out, which is the point of carrying an epoch at all:
   * a navigation reuses `backendNodeId`s silently, so an unchecked stamp
   * after one would write onto whatever element happens to hold that id
   * now, not the element the caller means. A same-document re-render (the
   * epoch unchanged, the backend node ids gone) is NOT caught here; it
   * fails per index instead, reported in {@link StampPageMapResult.results}
   * rather than losing the whole batch over one detached element.
   *
   * GATED ON `devtools`, the same as {@link pageMap}: the write goes
   * through `DOM.setAttributeValue`, never through page script.
   */
  async stampPageMap(epoch: PageMapEpoch, indices: number[]): Promise<StampPageMapResult> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('devtools')) {
      throw new AutomationError('POLICY_DENIED', "stampPageMap() needs the 'devtools' capability", {
        required: 'devtools',
      });
    }
    return this.run('stampPageMap', targetId, [], false, { epoch, indices }, false, async () => {
      const reply = await this.core.request<PageMapStamped>('page.map.stamp', {
        targetId,
        epoch,
        indices,
      });
      return { results: reply.results, marker: reply.marker };
    });
  }

  // ==================================================================
  // Diagnostics (`devtools` capability; api-contract-diagnostics.md
  // section 1/4). Not gated by a held ControlLease: reading a target's
  // console is not an interaction with it, the same reason `screenshot()`
  // and `inspectAt()` above need only `view`/`automation`/`capture`.
  // ==================================================================

  readonly diagnostics = {
    /**
     * Starts console/error/network capture for {@link targetId}. Requires
     * `devtools`, checked locally so a caller lacking it fails fast rather
     * than waiting a round trip for the server to refuse it. `feeds`
     * mirrors the wire message's own default (console and errors on,
     * network off): `Network.enable` is not free, and a swarm of many
     * members must not pay for it on every one of them unless asked,
     * which is why diagnostics are opt in per target. The
     * reply echoes what the server actually turned on, which can differ
     * from what was requested, so read the return value rather than
     * `feeds` to know what is really live.
     */
    subscribe: async (feeds?: DiagnosticsFeeds): Promise<DiagnosticsSubscription> => {
      const targetId = this._targetId;
      if (!this.core.hasCapability('devtools')) {
        throw new AutomationError(
          'POLICY_DENIED',
          "diagnostics.subscribe() needs the 'devtools' capability",
          { required: 'devtools' },
        );
      }
      const reply = await this.core.request<
        Envelope & { targetId: string; console: boolean; errors: boolean; network: boolean }
      >('diagnostics.subscribe', {
        targetId,
        ...(feeds?.console !== undefined ? { console: feeds.console } : {}),
        ...(feeds?.errors !== undefined ? { errors: feeds.errors } : {}),
        ...(feeds?.network !== undefined ? { network: feeds.network } : {}),
      });
      // Read from the reply, not the request: what the server actually
      // turned on can differ from what was asked (a domain that failed to
      // enable), and this is exactly the value {@link waitForNetworkIdle}
      // needs to fail fast on rather than trusting the request.
      setNetworkFeedSubscribed(this.core, targetId, reply.network);
      return {
        targetId: reply.targetId,
        console: reply.console,
        errors: reply.errors,
        network: reply.network,
      };
    },

    /** Stops diagnostics for {@link targetId}. Fire and forget on the wire, like `stream.unsubscribe`: the contract defines no reply for it, so there is nothing to correlate against. `async` only for call-site symmetry with `subscribe()`. */
    unsubscribe: async (): Promise<void> => {
      const targetId = this._targetId;
      setNetworkFeedSubscribed(this.core, targetId, false);
      this.core.send('diagnostics.unsubscribe', { targetId });
    },

    /**
     * Reads the response body Chrome already buffered for `requestId`,
     * the id off a `network` event this client was actually sent for this
     * target (`client.on('network', ev => ...)`, after
     * `diagnostics.subscribe({ network: true })`). Requires `devtools`,
     * checked locally so a caller lacking it fails fast rather than
     * paying a round trip for the server to refuse it. There is no other
     * source for a `requestId`: `@browserglass/protocol`'s
     * `wire/messages/response-body.ts` module doc explains why that is
     * the entire scoping argument, and why a guessed `requestId` (real or
     * not) is refused server side regardless of what this local check
     * lets through.
     *
     * Motivating case: a single page application form submission whose
     * only visible outcome IS the submit response's own body, with
     * nothing on screen changing either way. Subscribe to `network`,
     * click submit, read the matching `network` event's `requestId` off
     * the submit URL, then read its body here to learn what actually
     * happened.
     *
     * The body is not durable: it lives only as long as Chrome's own
     * per-request buffer does, which a navigation clears outright. A read
     * attempted too late (or of a request that never had a body, a
     * redirect or a `204`) throws `AutomationError('NOT_FOUND', ...)`
     * rather than resolving with an empty string, so "gone" and "empty"
     * stay two different, distinguishable answers. A body larger than the
     * server's own ceiling throws `AutomationError('POLICY_DENIED', ...)`
     * rather than arriving truncated.
     */
    responseBody: async (
      requestId: string,
      opts?: ResponseBodyOptions,
    ): Promise<ResponseBodyResult> => {
      const targetId = this._targetId;
      if (!this.core.hasCapability('devtools')) {
        throw new AutomationError(
          'POLICY_DENIED',
          "responseBody() needs the 'devtools' capability",
          { required: 'devtools' },
        );
      }
      return this.run('responseBody', targetId, [], false, { requestId }, false, async () => {
        const reply = await this.core.request<PageResponseBodyGot>(
          'page.responsebody.get',
          { targetId, requestId },
          opts?.timeoutMs,
        );
        return { body: reply.body, base64Encoded: reply.base64Encoded, sizeBytes: reply.sizeBytes };
      });
    },
  };

  // ==================================================================
  // The outbound request gate (`intercept` capability, plus `evaluate`
  // when a rule asks for request bodies).
  //
  // Read `@browserglass/protocol`'s `wire/messages/interception.ts`
  // module doc before changing anything here. The short version: `Fetch`
  // stays on the CDP passthrough deny list and this is not a hole in it.
  // The gateway owns the domain, enables it at the Request stage only,
  // and the vocabulary a caller gets is two words. There is deliberately
  // nowhere in `resolve()` to put a rewritten URL, method, header or
  // body, and that absence is the entire security argument, not an
  // oversight to be tidied up later.
  // ==================================================================

  readonly gate = {
    /**
     * Installs, or replaces, the rule set for {@link targetId}.
     *
     * Replaces wholesale rather than merging, so a caller always knows
     * the complete set in force. Prefer rules that name `allow` or `deny`
     * outright: those are decided server side with no round trip and
     * cannot time out. `verdict: 'ask'` is what produces a pause, and a
     * pause holds a real Chrome network slot until it is answered.
     *
     * Read `ruleCount` on the reply rather than assuming your own array
     * length survived.
     */
    enable: async (
      rules: readonly GateRule[],
    ): Promise<{ targetId: string; ruleCount: number }> => {
      const targetId = this._targetId;
      if (!this.core.hasCapability('intercept')) {
        throw new AutomationError(
          'POLICY_DENIED',
          "gate.enable() needs the 'intercept' capability",
          { required: 'intercept' },
        );
      }
      // Checked locally so a caller fails fast rather than paying a round
      // trip to be refused. The server checks it again regardless: a
      // client side capability check is a courtesy, never an authority.
      if (
        rules.some((r) => r.includeRequestBody === true) &&
        !this.core.hasCapability('evaluate')
      ) {
        throw new AutomationError(
          'POLICY_DENIED',
          "gate.enable() with includeRequestBody needs the 'evaluate' capability as well as 'intercept': a request body carries whatever the user typed, and a caller who can already run script in the page can already read it",
          { required: 'evaluate' },
        );
      }
      const reply = await this.core.request<Envelope & { targetId: string; ruleCount: number }>(
        'request.gate.enable',
        { targetId, rules },
      );
      return { targetId: reply.targetId, ruleCount: reply.ruleCount };
    },

    /** Removes the rule set and disables the gate for {@link targetId}. */
    disable: async (): Promise<void> => {
      const targetId = this._targetId;
      await this.core.request<Envelope>('request.gate.disable', { targetId });
    },

    /**
     * Answers one held request.
     *
     * Takes a verdict and nothing else, permanently. See this section's
     * header.
     */
    resolve: async (gateId: string, verdict: GateVerdict): Promise<void> => {
      this.core.send('request.gate.resolve', { targetId: this._targetId, gateId, verdict });
    },

    /**
     * Registers `handler` for every held request and answers each one
     * with what it returns, which is the shape almost every caller
     * actually wants: it removes the chance of forgetting to resolve a
     * pause, which is how a page ends up hanging on a request nobody is
     * ever going to answer.
     *
     * A handler that throws answers `'deny'`, matching the server side
     * default in `GateRule.onTimeout` and `RequestGate`'s own policy: a
     * gate that fails open is not a gate. Returns its own unsubscribe,
     * which does NOT disable the gate; call {@link disable} for that.
     */
    onPaused: (
      handler: (ev: RequestGatePausedEvent) => GateVerdict | Promise<GateVerdict>,
    ): Unsubscribe => {
      const targetId = this._targetId;
      return this.core.emitter.on('gatepaused', (ev: RequestGatePausedEvent) => {
        if (ev.targetId !== targetId) return;
        void (async () => {
          let verdict: GateVerdict;
          try {
            verdict = (await handler(ev)) === 'allow' ? 'allow' : 'deny';
          } catch {
            verdict = 'deny';
          }
          this.core.send('request.gate.resolve', { targetId, gateId: ev.gateId, verdict });
        })();
      });
    },
  };

  /**
   * Subscribes to `console`/`pageerror`/`network`/`networksummary`,
   * delivered for whichever targets this connection has called
   * {@link diagnostics}'s `subscribe()` on. Global to the connection
   * (every `forTarget()` sub-client shares one socket and therefore one
   * emitter), not scoped to {@link targetId}: filter on `ev.targetId`
   * yourself if more than one sub-client on this connection has
   * diagnostics on. Returns its own unsubscribe.
   */
  on<K extends keyof AutomationEvents>(
    type: K,
    fn: (ev: AutomationEvents[K]) => void,
  ): Unsubscribe {
    return this.core.emitter.on(type, fn);
  }

  // ==================================================================
  // Interaction (ALL require a held ControlLease)
  // ==================================================================

  async clickAt(x: number, y: number, opts?: ClickAtOptions): Promise<void> {
    const targetId = this._targetId;
    return this.run('clickAt', targetId, ['control'], true, { x, y, ...opts }, true, async () =>
      this.dispatchClickAt('clickAt', targetId, x, y, opts),
    );
  }

  /**
   * The raw down/up pair, without the `run()` pipeline.
   *
   * Extracted so that the locator engine's `click`/`fill` drive THIS and
   * not a copy of it. A locator that resolved to coordinates and then
   * opened its own path into `InputDispatcher` would inherit none of the
   * lease fencing, none of the generation stamping and none of the
   * stand-down gate, and would quietly become a way for an agent to keep
   * clicking on a browser a person had taken over. There is one input
   * path; everything above it composes.
   *
   * Also the reason a locator verb costs exactly one step: it does its own
   * `run()` once and calls this for the dispatch, rather than paying the
   * budget for every composed sub-action.
   */
  private async dispatchClickAt(
    name: string,
    targetId: string,
    x: number,
    y: number,
    opts?: ClickAtOptions,
  ): Promise<void> {
    const gen = await this.core.ensureGen(targetId);
    // The second, load-bearing half of the dispatch gate (see `run()`):
    // `ensureGen()` above is a round trip, and a takeover arriving during
    // it must stop this call rather than being noticed only by the call
    // after it. Before the lease lookup, for the reason `run()` gives:
    // standing down releases the lease, so a lease-first order would
    // report the wrong one of the two true things.
    this.core.assertMayDispatch(targetId, name);
    const lease = this.core.leases.get(targetId);
    if (!lease)
      throw new AutomationError('LEASE_NOT_HELD', `${name}() requires a held ControlLease`);
    const button = opts?.button ?? 'left';
    const clickCount = opts?.clickCount ?? 1;
    const modifiers = packModifiers(opts?.modifiers);
    const base = {
      targetId,
      fw: this.core.viewport.width,
      fh: this.core.viewport.height,
      gen,
      leaseId: lease.leaseId,
    };
    this.core.send('input.mouse', {
      ...base,
      kind: 'down',
      x,
      y,
      button,
      buttons: 1,
      modifiers,
      clickCount,
    });
    this.core.send('input.mouse', { ...base, kind: 'up', x, y, button, buttons: 0, modifiers });
  }

  /**
   * The raw pointer move, without the `run()` pipeline.
   *
   * Extracted for the same reason `dispatchClickAt` is: so the locator
   * engine's `hover` drives THIS and not a copy of it, inheriting the
   * lease fencing, the generation stamp and the stand-down gate rather
   * than opening a second way into `InputDispatcher`.
   */
  private async dispatchMoveTo(
    name: string,
    targetId: string,
    x: number,
    y: number,
    opts?: MoveToOptions,
  ): Promise<void> {
    const gen = await this.core.ensureGen(targetId);
    // The second, load-bearing half of the dispatch gate (see `run()`):
    // `ensureGen()` above is a round trip, and a takeover arriving during
    // it must stop this call rather than being noticed only by the call
    // after it. Before the lease lookup, for the reason `run()` gives:
    // standing down releases the lease, so a lease-first order would
    // report the wrong one of the two true things.
    this.core.assertMayDispatch(targetId, name);
    const lease = this.core.leases.get(targetId);
    if (!lease)
      throw new AutomationError('LEASE_NOT_HELD', `${name}() requires a held ControlLease`);
    this.core.send('input.mouse', {
      targetId,
      fw: this.core.viewport.width,
      fh: this.core.viewport.height,
      gen,
      leaseId: lease.leaseId,
      kind: 'move',
      x,
      y,
      button: 'none',
      buttons: opts?.buttons ?? 0,
      modifiers: packModifiers(opts?.modifiers),
    });
  }

  /**
   * Moves the pointer to a viewport CSS pixel. Between {@link mouseDown}
   * and {@link mouseUp} this is a drag: the gateway tracks which buttons
   * this viewer holds and reports the move with them, whatever
   * `opts.buttons` says.
   */
  async moveTo(x: number, y: number, opts?: MoveToOptions): Promise<void> {
    const targetId = this._targetId;
    return this.run(
      'moveTo',
      targetId,
      ['control'],
      true,
      { x, y, ...(opts?.buttons !== undefined ? { buttons: opts.buttons } : {}) },
      true,
      async () => this.dispatchMoveTo('moveTo', targetId, x, y, opts),
    );
  }

  /**
   * Presses a mouse button at a viewport CSS pixel and leaves it held.
   * Pair it with {@link moveTo} and {@link mouseUp} for a hand built
   * drag, or use {@link drag}. A button still held when the lease ends is
   * released by the gateway, so a crashed script cannot leave a page
   * stuck mid drag.
   */
  async mouseDown(x: number, y: number, opts?: MouseButtonOptions): Promise<void> {
    const targetId = this._targetId;
    return this.run('mouseDown', targetId, ['control'], true, { x, y, ...opts }, true, async () =>
      this.dispatchMouseButton('mouseDown', 'down', targetId, x, y, opts),
    );
  }

  /** Releases a mouse button at a viewport CSS pixel. See {@link mouseDown}. */
  async mouseUp(x: number, y: number, opts?: MouseButtonOptions): Promise<void> {
    const targetId = this._targetId;
    return this.run('mouseUp', targetId, ['control'], true, { x, y, ...opts }, true, async () =>
      this.dispatchMouseButton('mouseUp', 'up', targetId, x, y, opts),
    );
  }

  /**
   * Presses at `from`, moves to `to` in `steps` evenly spaced moves with
   * the button held, and releases at `to`. Either end may be a selector,
   * in which case the centre of its first match is used (`from` is
   * scrolled into view first; `to` is measured where it is, since
   * scrolling in the middle of a drag would move the target under the
   * pointer).
   *
   * Costs one step, like every other verb, and checks for a takeover
   * before every move: a person taking the browser stops the drag where
   * it is, and the gateway releases the held button along with the lease.
   */
  async drag(from: DragPoint, to: DragPoint, opts?: DragOptions): Promise<DragResult> {
    const targetId = this._targetId;
    const caps: Capability[] =
      typeof from === 'string' || typeof to === 'string' ? ['evaluate', 'control'] : ['control'];
    return this.run(
      'drag',
      targetId,
      caps,
      true,
      {
        from: typeof from === 'string' ? from : { ...from },
        to: typeof to === 'string' ? to : { ...to },
        ...(opts?.steps !== undefined ? { steps: opts.steps } : {}),
      },
      true,
      async () => {
        const start = await this.dragPoint(targetId, from, true);
        const end = await this.dragPoint(targetId, to, false);
        const steps = Math.max(1, Math.floor(opts?.steps ?? 10));
        const delayMs = Math.max(0, opts?.delayMs ?? 16);
        const button = opts?.button ?? 'left';
        const held = buttonMask(button);
        const mods = opts?.modifiers !== undefined ? { modifiers: opts.modifiers } : {};
        await this.dispatchMoveTo('drag', targetId, start.x, start.y, mods);
        await this.dispatchMouseButton('drag', 'down', targetId, start.x, start.y, {
          button,
          ...mods,
        });
        let released = false;
        try {
          for (let i = 1; i <= steps; i++) {
            if (delayMs > 0) await sleepMs(delayMs);
            const t = i / steps;
            await this.dispatchMoveTo(
              'drag',
              targetId,
              start.x + (end.x - start.x) * t,
              start.y + (end.y - start.y) * t,
              { buttons: held, ...mods },
            );
          }
          if (delayMs > 0) await sleepMs(delayMs);
          await this.dispatchMouseButton('drag', 'up', targetId, end.x, end.y, {
            button,
            ...mods,
          });
          released = true;
        } finally {
          // Best effort: a drag that failed part way through should not
          // leave the button held while the lease is still ours. When the
          // lease is gone the gateway has already released the button, and
          // the dispatch below throws, which is ignored.
          if (!released && this.core.hasControl(targetId)) {
            try {
              await this.dispatchMouseButton('drag', 'up', targetId, end.x, end.y, { button });
            } catch {
              // ignored, see above
            }
          }
        }
        return { from: start, to: end, steps };
      },
    );
  }

  /** Resolves one end of a {@link drag} to a viewport CSS pixel. */
  private async dragPoint(
    targetId: string,
    point: DragPoint,
    scroll: boolean,
  ): Promise<{ x: number; y: number }> {
    if (typeof point !== 'string') return { x: point.x, y: point.y };
    const res = await this.locators.resolve(targetId, point, {
      limit: 1,
      stamp: false,
      stable: false,
      scroll,
    });
    const match = res.matches[0];
    if (!match) {
      throw new AutomationError('NOT_FOUND', `drag() found nothing matching ${point}`, {
        selector: point,
      });
    }
    if (!match.visible) {
      throw new AutomationError('NOT_VISIBLE', `drag() target ${point} is not visible`, {
        selector: point,
      });
    }
    return { x: match.center.x, y: match.center.y };
  }

  /**
   * One `down` or `up`, without the `run()` pipeline. Same gate order as
   * {@link dispatchClickAt}: generation first, then the stand-down check,
   * then the lease lookup.
   */
  private async dispatchMouseButton(
    name: string,
    kind: 'down' | 'up',
    targetId: string,
    x: number,
    y: number,
    opts?: MouseButtonOptions,
  ): Promise<void> {
    const gen = await this.core.ensureGen(targetId);
    this.core.assertMayDispatch(targetId, name);
    const lease = this.core.leases.get(targetId);
    if (!lease)
      throw new AutomationError('LEASE_NOT_HELD', `${name}() requires a held ControlLease`);
    const button = opts?.button ?? 'left';
    this.core.send('input.mouse', {
      targetId,
      fw: this.core.viewport.width,
      fh: this.core.viewport.height,
      gen,
      leaseId: lease.leaseId,
      kind,
      x,
      y,
      button,
      buttons: kind === 'down' ? buttonMask(button) : 0,
      modifiers: packModifiers(opts?.modifiers),
      ...(kind === 'down' ? { clickCount: opts?.clickCount ?? 1 } : {}),
    });
  }

  /** Types `text` as real per-character `keydown`/`keyup` pairs (falling back to `input.text` for a character with no known DOM code). No inter-key delay; for anti-bot-style paced typing use {@link humanType}. */
  async type(
    text: string,
    opts?: { modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> },
  ): Promise<void> {
    const targetId = this._targetId;
    return this.run(
      'type',
      targetId,
      ['control'],
      true,
      { length: text.length },
      true,
      async () => {
        const gen = await this.core.ensureGen(targetId);
        this.core.assertMayDispatch(targetId, 'type');
        const lease = this.core.leases.get(targetId);
        if (!lease)
          throw new AutomationError('LEASE_NOT_HELD', 'type() requires a held ControlLease');
        const modifiers = packModifiers(opts?.modifiers);
        const base = {
          targetId,
          fw: this.core.viewport.width,
          fh: this.core.viewport.height,
          gen,
          leaseId: lease.leaseId,
        };
        for (const ch of [...text]) {
          // Checked per character, not once for the whole string. `type()`
          // has no inter-key delay, but a long string is still hundreds of
          // frames, and a takeover landing partway through must stop the
          // rest of them: this is the same obligation `humanType()` has,
          // and the only reason it looks different there is that its
          // per-character sleep gives it somewhere obvious to check. One
          // character is the atomic unit here (a keydown and its keyup),
          // so this never splits a pair.
          this.core.assertMayDispatch(targetId, 'type');
          const kc = printableKeyCode(ch);
          if (kc) {
            this.core.send('input.key', {
              ...base,
              kind: 'down',
              key: kc.key,
              code: kc.code,
              modifiers,
              text: ch,
            });
            this.core.send('input.key', {
              ...base,
              kind: 'up',
              key: kc.key,
              code: kc.code,
              modifiers,
            });
          } else {
            this.core.send('input.text', { ...base, text: ch });
          }
        }
      },
    );
  }

  /** Inserts `text` in one `input.text` message, bypassing key events entirely (no `keydown`/`keyup` fires on the page). */
  async insertText(text: string): Promise<void> {
    const targetId = this._targetId;
    return this.run(
      'insertText',
      targetId,
      ['control'],
      true,
      { length: text.length },
      true,
      async () => {
        const gen = await this.core.ensureGen(targetId);
        // The second, load-bearing half of the dispatch gate (see `run()`):
        // `ensureGen()` above is a round trip, and a takeover arriving during
        // it must stop this call rather than being noticed only by the call
        // after it. Before the lease lookup, for the reason `run()` gives:
        // standing down releases the lease, so a lease-first order would
        // report the wrong one of the two true things.
        this.core.assertMayDispatch(targetId, 'insertText');
        const lease = this.core.leases.get(targetId);
        if (!lease)
          throw new AutomationError('LEASE_NOT_HELD', 'insertText() requires a held ControlLease');
        this.core.send('input.text', {
          targetId,
          fw: this.core.viewport.width,
          fh: this.core.viewport.height,
          gen,
          leaseId: lease.leaseId,
          text,
        });
      },
    );
  }

  /** Presses one key or combo (e.g. `'Enter'`, `'Control+A'`); the final `+`-separated segment names the key, resolved against a small named-key table, then a single printable character. */
  async pressKey(name: string, opts?: PressKeyOptions): Promise<void> {
    const targetId = this._targetId;
    return this.run('pressKey', targetId, ['control'], true, { name }, true, async () => {
      const gen = await this.core.ensureGen(targetId);
      // The second, load-bearing half of the dispatch gate (see `run()`):
      // `ensureGen()` above is a round trip, and a takeover arriving during
      // it must stop this call rather than being noticed only by the call
      // after it. Before the lease lookup, for the reason `run()` gives:
      // standing down releases the lease, so a lease-first order would
      // report the wrong one of the two true things.
      this.core.assertMayDispatch(targetId, 'pressKey');
      const lease = this.core.leases.get(targetId);
      if (!lease)
        throw new AutomationError('LEASE_NOT_HELD', 'pressKey() requires a held ControlLease');
      const parts = name.split('+');
      const mainName = parts[parts.length - 1] ?? name;
      const kc = namedKeyCode(mainName) ?? printableKeyCode(mainName);
      if (!kc)
        throw new AutomationError('NOT_FOUND', `pressKey(): unrecognised key name '${name}'`);
      const modifiers = packModifiers(opts?.modifiers);
      const base = {
        targetId,
        fw: this.core.viewport.width,
        fh: this.core.viewport.height,
        gen,
        leaseId: lease.leaseId,
      };
      this.core.send('input.key', {
        ...base,
        kind: 'down',
        key: kc.key,
        code: kc.code,
        modifiers,
        ...([...kc.key].length === 1 ? { text: kc.key } : {}),
      });
      this.core.send('input.key', { ...base, kind: 'up', key: kc.key, code: kc.code, modifiers });
    });
  }

  /**
   * The raw wheel dispatch, without the `run()` pipeline.
   *
   * Extracted for the same reason `dispatchClickAt` is: so the locator
   * engine's `scrollContainer` drives THIS and not a copy of it,
   * inheriting the lease fencing, the generation stamp and the stand-down
   * gate rather than opening a second way into `InputDispatcher`.
   */
  private async dispatchWheelAt(
    name: string,
    targetId: string,
    x: number,
    y: number,
    dx: number,
    dy: number,
  ): Promise<void> {
    const gen = await this.core.ensureGen(targetId);
    // The second, load-bearing half of the dispatch gate (see `run()`):
    // `ensureGen()` above is a round trip, and a takeover arriving during
    // it must stop this call rather than being noticed only by the call
    // after it. Before the lease lookup, for the reason `run()` gives:
    // standing down releases the lease, so a lease-first order would
    // report the wrong one of the two true things.
    this.core.assertMayDispatch(targetId, name);
    const lease = this.core.leases.get(targetId);
    if (!lease)
      throw new AutomationError('LEASE_NOT_HELD', `${name}() requires a held ControlLease`);
    this.core.send('input.mouse', {
      targetId,
      fw: this.core.viewport.width,
      fh: this.core.viewport.height,
      gen,
      leaseId: lease.leaseId,
      kind: 'wheel',
      x,
      y,
      button: 'none',
      buttons: 0,
      modifiers: 0,
      dx,
      dy,
    });
  }

  async scroll(opts?: ScrollOptions): Promise<void> {
    const targetId = this._targetId;
    return this.run(
      'scroll',
      targetId,
      ['control'],
      true,
      opts as Record<string, unknown> | undefined,
      true,
      async () => {
        const x = opts?.x ?? Math.round(this.core.viewport.width / 2);
        const y = opts?.y ?? Math.round(this.core.viewport.height / 2);
        await this.dispatchWheelAt('scroll', targetId, x, y, opts?.dx ?? 0, opts?.dy ?? 0);
      },
    );
  }

  /**
   * Paced, per-character typing (anti-bot-detection pacing). The
   * preemption contract's load-bearing case: checks
   * for an outstanding `control.preempt.request` and the lease's own
   * validity before every character, and never sleeps more than 400ms
   * without re-checking, regardless of `opts.delayMs`. On preemption it
   * abandons the call immediately (never pauses and resumes later) and
   * throws `LEASE_REVOKED` carrying `details.lastCompletedStep`,
   * `details.partial: true`, `details.charsTyped`, and `details.charsTotal`.
   */
  async humanType(text: string, opts?: HumanTypeOptions): Promise<void> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('control')) {
      throw new AutomationError('POLICY_DENIED', "humanType() needs the 'control' capability", {
        required: 'control',
      });
    }
    // Stand-down before lease, the same order and for the same reason as
    // `run()`. No partial-progress details here on purpose: nothing has
    // been typed yet, so there is no partial anything to report, and the
    // gate's own error says who took the browser, which is what a caller
    // at this point actually needs.
    this.core.assertMayDispatch(targetId, 'humanType');
    if (!this.core.hasControl(targetId)) {
      throw new AutomationError(
        'LEASE_NOT_HELD',
        'humanType() requires a held ControlLease on this target; call acquireControl() first',
      );
    }
    this.core.consumeStep();

    const startedAt = Date.now();
    if (this.core.dryRun) {
      this.core.recordAction({
        action: 'humanType',
        targetId,
        args: { length: text.length, dryRun: true },
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const delayMs = opts?.delayMs ?? 60;
    const inFlight = this.core.beginInFlight('humanType', targetId);
    try {
      await this.typeCharsWithPreemption('humanType', targetId, text, delayMs);
      this.core.recordAction({
        action: 'humanType',
        targetId,
        args: { length: text.length },
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const wrapped =
        err instanceof AutomationError
          ? err
          : new AutomationError('PROTOCOL_ERROR', err instanceof Error ? err.message : String(err));
      this.core.recordAction({
        action: 'humanType',
        targetId,
        args: { length: text.length },
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { code: wrapped.code, message: wrapped.message },
      });
      throw wrapped;
    } finally {
      this.core.endInFlight(inFlight);
    }
  }

  /**
   * Per-character `keydown`/`keyup` pairs with an optional inter-key delay,
   * standing down the instant a person asks for the browser.
   *
   * Extracted from {@link humanType} so the locator engine's `fill` can
   * reuse it rather than reimplementing the preemption contract, which is
   * the part of this method that is easy to get subtly wrong and expensive
   * to get wrong: it re-checks before every character, re-checks again
   * after `ensureGen()`'s round trip, never sleeps more than 400ms without
   * re-checking whatever `delayMs` says (the chunk bound), and
   * abandons rather than pausing, carrying how far it actually got.
   *
   * That last part is the multi-user model expressed as an API. Playwright
   * cannot do it, not because nobody thought of it but because Playwright
   * has no concept of a second driver. A locator `fill` that stops
   * mid-word when a human takes the wheel, and tells the caller which
   * character it stopped on, is the thing this surface has that a port
   * would not.
   *
   * Does no capability check, no lease check, no step accounting and no
   * action record: its two callers do all of that around it.
   */
  private async typeCharsWithPreemption(
    name: string,
    targetId: string,
    text: string,
    delayMs: number,
  ): Promise<void> {
    const chars = [...text];
    let lastCompletedStep = -1;

    const abandonedError = (charsTyped: number): AutomationError => {
      // The yield notice, when there is one, is what the caller actually
      // needs: it names who took over and whether they were a person. The
      // partial-progress fields stay exactly as they were, since a caller
      // resuming a half-typed field still needs them.
      const ev = this.core.yieldFor(targetId);
      return new AutomationError('LEASE_REVOKED', `${name}() abandoned: control was preempted`, {
        lastCompletedStep,
        partial: true,
        charsTyped,
        charsTotal: chars.length,
        ...(ev !== undefined
          ? { yielded: true, reason: ev.reason, human: ev.human, byLabel: ev.byLabel }
          : {}),
      });
    };

    for (let i = 0; i < chars.length; i++) {
      if (
        this.core.yieldFor(targetId) !== undefined ||
        this.core.pendingPreempt.has(targetId) ||
        !this.core.hasControl(targetId)
      )
        throw abandonedError(i);

      const ch = chars[i];
      if (ch === undefined) continue;
      const gen = await this.core.ensureGen(targetId);
      const lease = this.core.leases.get(targetId);
      if (!lease) throw abandonedError(i);
      // Re-checked after `ensureGen()`'s round trip, and thrown as an
      // `abandonedError` rather than through `assertMayDispatch()` so a
      // yield landing inside that await still reports how far the typing
      // actually got. Losing the partial-progress fields to a
      // late-arriving takeover would be worse than useless: that is
      // exactly the case a caller needs them for.
      if (this.core.yieldFor(targetId) !== undefined) throw abandonedError(i);

      const base = {
        targetId,
        fw: this.core.viewport.width,
        fh: this.core.viewport.height,
        gen,
        leaseId: lease.leaseId,
      };
      const kc = printableKeyCode(ch);
      if (kc) {
        this.core.send('input.key', {
          ...base,
          kind: 'down',
          key: kc.key,
          code: kc.code,
          modifiers: 0,
          text: ch,
        });
        this.core.send('input.key', {
          ...base,
          kind: 'up',
          key: kc.key,
          code: kc.code,
          modifiers: 0,
        });
      } else {
        this.core.send('input.text', { ...base, text: ch });
      }
      lastCompletedStep = i;

      if (delayMs > 0)
        await this.sleepCheckingPreemption(delayMs, targetId, () => abandonedError(i + 1));
    }
  }

  /**
   * Sleeps `totalMs`, but in increments of at most 400ms, re-checking
   * preemption after every increment (the chunk bound) rather than
   * only once per full inter-keystroke delay: a caller-configured
   * `delayMs` above 400 must not let a preemption sit unnoticed for the
   * whole delay.
   */
  private async sleepCheckingPreemption(
    totalMs: number,
    targetId: string,
    buildError: () => AutomationError,
  ): Promise<void> {
    let remaining = totalMs;
    while (remaining > 0) {
      const step = Math.min(400, remaining);
      await sleepMs(step);
      remaining -= step;
      if (
        this.core.yieldFor(targetId) !== undefined ||
        this.core.pendingPreempt.has(targetId) ||
        !this.core.hasControl(targetId)
      )
        throw buildError();
    }
  }

  /**
   * `select_option`: sets a `<select>`'s selection by value, by visible
   * label, or by index, and reports what actually ended up selected.
   *
   * SHIPPED, WHERE AN EARLIER PASS REFUSED IT
   *
   * The refusal this replaces argued that two call sites do not justify
   * Playwright's `select_option` semantics, and that the whole thing is
   * one line of `evaluate`. That is true of any one call site in
   * isolation and false of the surface as a whole: every caller writing
   * that line has to independently decide what "select by label" means,
   * whether `input` and `change` both need dispatching (React listens to
   * one, a native form listens to the other), and what happens when the
   * option it asked for is not there. Getting the option-not-found case
   * wrong is not a hypothetical: it is exactly the kind of thing a caller
   * discovers in production when the choices on a `<select>` change under
   * them, and it is precisely the case a library exists to get right once
   * rather than leaving every call site to get it wrong independently. So
   * this ships with real semantics rather than staying a one-line refusal.
   *
   * `options` is a bare string (shorthand for `{ value }`, the common
   * case), or `{ value }` / `{ label }` / `{ index }` for the other two
   * ways Playwright lets a caller name an option, or an array of any of
   * those for a `<select multiple>`. Matching and mutating happen inside
   * ONE evaluate (`locator/script.ts`'s `SELECT_SCRIPT`): every requested
   * option is resolved against `el.options` before anything is written, so
   * an option list that re-renders between two round trips (an async
   * combobox backed by a native `<select>`, common on real world forms)
   * cannot make this select the wrong entry. Nothing is
   * mutated when any requested option is missing; the thrown error names
   * every option asked for that did not match AND every option the
   * `<select>` actually offers, which is the diagnostic the hand-rolled
   * version would not have bothered to build.
   *
   * Requires a held `ControlLease`, the same as `click`/`fill`: changing a
   * form's selection is exactly the kind of interaction a person could be
   * mid-way through on the same page, even though the mutation itself runs
   * over `evaluate` rather than through a dispatched `input.*` frame.
   *
   * ```ts
   * await client.select('#country', 'US');
   * await client.select('#country', { label: 'United States' });
   * await client.select('#sizes', [{ value: 'S' }, { value: 'M' }]); // <select multiple>
   * ```
   */
  async select(
    selector: string,
    options: SelectOptionSpec | readonly SelectOptionSpec[],
    opts?: LocatorSelectOptions,
  ): Promise<SelectResult> {
    const targetId = this._targetId;
    return this.run(
      'select',
      targetId,
      ['evaluate', 'control'],
      true,
      { selector, ...(opts?.index !== undefined ? { index: opts.index } : {}) },
      true,
      async () => this.locators.select(targetId, selector, options, opts),
    );
  }

  // ==================================================================
  // The locator surface (`evaluate` capability, plus `control` for the
  // verbs that dispatch input).
  //
  // Read `locator/script.ts`'s module doc before changing anything here.
  // The short version: there is no `Locator` object and there will not be
  // one, because `PageEvaluate` returns by value and never an `objectId`,
  // and that refusal is permanent. The primitive is `resolve`, which
  // answers in one round trip everything a lazy locator would have asked
  // four times, and the verbs below are thin composition on top of it plus
  // the input path this client already owns.
  // ==================================================================

  /** Built on first use. Holds no state of its own; it is the verbs, given the raw hooks they need. */
  private locatorEngine: LocatorEngine | undefined;

  private get locators(): LocatorEngine {
    if (this.locatorEngine === undefined) {
      this.locatorEngine = new LocatorEngine({
        defaultTimeoutMs: this.core.defaultTimeoutMs,
        // `internal: true`: every real call here is one of the locator
        // engine's own fixed scripts (`RESOLVE_SCRIPT`, `WAIT_SCRIPT`,
        // `READ_SCRIPT`, `CLEAR_SCRIPT`, `SELECT_SCRIPT`,
        // `DISPATCH_CLICK_SCRIPT`), never caller-authored text, so it is
        // charged to the `evaluateInternal` bucket rather than the
        // caller's own `evaluate` one. See `sendEvaluateSource`'s own doc.
        //
        // `world` is forwarded, not defaulted here. The engine decides it
        // (`locator/engine.ts`'s `ENGINE_WORLD`, `'isolated'`) and the
        // interface makes it a required argument, so this adapter has
        // nothing to choose and no way to drop it silently.
        // `sendEvaluateSource` already emits `world` when the options
        // object carries one, and both `page.evaluate` and
        // `page.evaluate.internal` accept it
        // (`@browserglass/protocol`'s `PageEvaluateInternal.world`,
        // validated at `packages/server/src/ws/connection.ts`'s
        // `handlePageEvaluate`), so nothing below this line changes.
        evaluateFunction: <T>(
          targetId: string,
          source: string,
          args: readonly unknown[],
          timeoutMs: number,
          world: EvaluateWorld,
        ) =>
          this.sendEvaluateSource<T>(
            targetId,
            'function',
            source,
            args,
            { timeoutMs, world },
            true,
          ),
        // `internal` left at its default (false): this is the locator
        // surface's one caller-content evaluate, `click()`'s `verify`
        // predicate, and it must keep spending from the caller's own
        // budget exactly as an ordinary `evaluate()` call would.
        evaluateExpression: <T>(
          targetId: string,
          expression: string,
          timeoutMs: number,
          world: EvaluateWorld,
        ) =>
          this.sendEvaluateSource<T>(targetId, 'expression', expression, [], { timeoutMs, world }),
        // The generation learn, which is a real round trip the first time
        // it runs on a target. Hoisted out of the dispatch so the locator
        // engine can check its measurement is still fresh AFTER paying for
        // it rather than before: a staleness check placed before the only
        // thing that consumes time would always see a gap of zero.
        prepareDispatch: async (targetId) => {
          await this.core.ensureGen(targetId);
        },
        clickPoint: (targetId, x, y, opts) => this.dispatchClickAt('click', targetId, x, y, opts),
        movePoint: (targetId, x, y) => this.dispatchMoveTo('hover', targetId, x, y),
        wheelAt: (targetId, x, y, dx, dy) =>
          this.dispatchWheelAt('scrollContainer', targetId, x, y, dx, dy),
        typeChars: (targetId, text, delayMs) =>
          this.typeCharsWithPreemption('fill', targetId, text, delayMs),
        insertText: async (targetId, text) => {
          const gen = await this.core.ensureGen(targetId);
          this.core.assertMayDispatch(targetId, 'fill');
          const lease = this.core.leases.get(targetId);
          if (!lease)
            throw new AutomationError('LEASE_NOT_HELD', 'fill() requires a held ControlLease');
          this.core.send('input.text', {
            targetId,
            fw: this.core.viewport.width,
            fh: this.core.viewport.height,
            gen,
            leaseId: lease.leaseId,
            text,
          });
        },
        sleep: sleepMs,
        // `role=`'s CDP half. See `locator/engine.ts`'s `LocatorRuntime.queryAndStampByRole`
        // doc for the mechanics; this closure owns the ONE thing that
        // interface cannot express on its own, the capability check.
        // `devtools` is checked HERE, not by `run()`'s own `caps` array on
        // `resolve()`/`click()`/etc., because those verbs need it only
        // conditionally (a selector with no `role=` segment never reaches
        // this method at all): a blanket `['evaluate', 'devtools']` on
        // every locator verb would demand a capability most calls never
        // use. A caller with `evaluate` but not `devtools` learns the
        // truth here, before the `page.evaluate` round trip `resolve()`
        // would otherwise still make with a rewritten, working selector.
        queryAndStampByRole: async (targetId, role, name, timeoutMs) => {
          if (!this.core.hasCapability('devtools')) {
            throw new AutomationError(
              'POLICY_DENIED',
              "a 'role=' selector needs the 'devtools' capability (for the underlying accessibility tree read), in addition to 'evaluate' (for the resolve() round trip that runs afterward)",
              { required: 'devtools' },
            );
          }
          const reply = await this.sendA11y(
            targetId,
            {
              ...(role !== undefined ? { role } : {}),
              ...(name !== undefined ? { name } : {}),
              stamp: true,
            },
            timeoutMs,
          );
          return { attr: reply.marker };
        },
        // `frame=`'s cross-origin half. See `LocatorRuntime.listFrameTargets`'s
        // own doc for what this is and is not: a plain, synchronous read of
        // `this.core.targets` (kept in sync from `welcome.targets` plus every
        // `target.*` broadcast since, the SAME cache `this.targets`/
        // `tabs.active()` already read), narrowed to `kind: 'iframe'`. No
        // round trip and no capability check, because listing a cache this
        // client already holds asks nothing of the server that `evaluate`
        // has not already been granted for the resolve this is one step of.
        listFrameTargets: () =>
          this.core.targets
            .filter((t) => t.kind === 'iframe')
            .map((t) => ({ targetId: t.targetId, url: t.url })),
      });
    }
    return this.locatorEngine;
  }

  /**
   * Finds every element a selector matches and reports, for each, its rect
   * and all five actionability answers, in ONE round trip.
   *
   * This is the primitive, and it is the one place this surface is better
   * than a Playwright port rather than merely equivalent. A Playwright
   * `Locator` is lazy and re-queries the page on every property access,
   * which is correct when the driver shares a process with the browser and
   * wrong when a socket sits between them. So `count()`, `first`, `nth()`
   * and `is_visible()` are not shipped as verbs at all: `resolve` already
   * answered all four, and offering them as aliases would guarantee that
   * ported code kept the four-round-trip shape the port was supposed to
   * fix.
   *
   * ```ts
   * const r = await client.resolve('[data-testid="dropdown"]');
   * r.total;                       // what .count() was for
   * r.matches[0];                  // what .first was for
   * r.matches.filter(m => m.visible);
   * await client.click(`ref=${r.matches[2].ref}`);
   * ```
   *
   * SELECTOR DIALECT. An explicit `engine=` prefix always wins:
   * `css=`, `text=`, `xpath=`, `label=`, `ref=`, `visible=`, `role=`. With
   * no prefix, a selector starting with `/` or `(` is XPath and everything
   * else is CSS, which is the same auto-detection Playwright uses and the
   * only unambiguous one. Segments chain with `>>`, each resolved against
   * the matches of the one before it:
   * `'input#first >> xpath=ancestor::label[1]'`,
   * `'button >> visible=true'`.
   *
   *  * `css=` is the default because it is what real call sites are:
   *    attribute selectors, overwhelmingly.
   *  * `text=` matches on normalised `textContent` (substring and
   *    case-insensitive; `text="exact phrase"` matches the whole text,
   *    still ignoring case) and
   *    returns only the innermost matching elements, since every ancestor
   *    contains the text too. It reads `textContent` rather than
   *    `innerText` because `innerText` forces layout for every element in
   *    the document; chain `>> visible=true` when text CSS has hidden
   *    matters.
   *  * `xpath=` is accepted only as a CHAINED segment, evaluated against an
   *    element another engine already found. That covers what CSS cannot
   *    express (`ancestor::label[1]`, `..`) and refuses the absolute XPath
   *    that reads as noise in a log and breaks first when markup shifts.
   *  * `label=` is FOUR RULES and not the ARIA accessible-name
   *    computation: `aria-labelledby`, then `aria-label`, then
   *    `<label for>`, then a wrapping `<label>`, first non-empty wins. It
   *    is deliberately not called `getByLabel`, because a caller who reads
   *    that name assumes parity with a specification this does not
   *    implement.
   *  * `role=<role>` or `role=<role>[name="<exact name>"]` DOES match the
   *    real accessible role and name, computed by Chrome's OWN
   *    accessibility engine (`Accessibility.queryAXTree`), the one case
   *    where this dialect asks a CDP domain rather than reading the DOM in
   *    the page. Requires `devtools` IN ADDITION to `evaluate`; see
   *    `a11y()`'s own doc for why. A `<button>` with no `role` attribute
   *    matches `role=button`; an `<a>` with no `href` does NOT match
   *    `role=link`, because it genuinely is not a link. This is precisely
   *    what `LocatorMatch.role` (the `role` ATTRIBUTE) gets wrong, and why
   *    `role=` matches against Chrome's computed answer instead of that
   *    field.
   *
   * MATCHING NOTHING, ONE, OR MANY. Nothing is an ordinary answer:
   * `matches: []`, `total: 0`, no throw, because "how many are there" is
   * a question and zero is a valid reply. Many is also an ordinary answer:
   * there is no strict mode here and there will not be one. Real pages
   * ship duplicate ids and repeated names, and automation code written
   * against Playwright spends a lot of effort working around its strict
   * mode. Only the ACTING verbs have to choose one, and they say which they
   * chose and out of how many.
   */
  async resolve(selector: string, opts?: ResolveOptions): Promise<ResolveResult> {
    const targetId = this._targetId;
    return this.run('resolve', targetId, ['evaluate'], false, { selector }, false, async () =>
      this.locators.resolve(targetId, selector, opts),
    );
  }

  /**
   * Waits for a selector to reach a state, as ONE evaluate that holds in
   * the page for the whole deadline.
   *
   * Not a client-side poll loop, and the arithmetic is why. An 8 second
   * wait polled at 100ms is 80 round trips per wait, and a poll loop
   * cannot see a state that appears and disappears between two polls,
   * which is the exact shape of a validation message or an autocomplete
   * list. Here a `MutationObserver` in the page wakes the check the
   * instant the DOM changes, with a 100ms in-page interval as the backstop
   * for the changes a MutationObserver cannot see (a transition
   * finishing, a scroll, a property assignment that does not reflect to an
   * attribute). In-page polling is free; it is only polling across a
   * socket that is expensive.
   *
   * The long evaluate does NOT pin the renderer. It awaits a promise; it
   * does not spin. A reviewer will assume the opposite, which is why this
   * paragraph is here.
   *
   * On its deadline it throws with the last observation attached: which
   * check failed, what the element's rect and state were, and what was on
   * top of it. That is the whole point of holding the state in the page
   * rather than throwing from it.
   */
  async waitFor(selector: string, opts?: WaitForOptions): Promise<WaitForResult> {
    const targetId = this._targetId;
    return this.run(
      'waitFor',
      targetId,
      ['evaluate'],
      false,
      { selector, state: opts?.state ?? 'visible' },
      false,
      async () => this.locators.waitFor(targetId, selector, opts),
    );
  }

  /**
   * Playwright's spelling of {@link waitFor}, kept so ported code keeps
   * working. Defaults to `state: 'visible'`, as Playwright's does.
   */
  async waitForSelector(selector: string, opts?: WaitForOptions): Promise<WaitForResult> {
    return this.waitFor(selector, opts);
  }

  /**
   * Clicks the element a selector resolves to, through the same real CDP
   * input path a person's click takes.
   *
   * WHY COORDINATES AND NOT `element.click()`. A dispatched click carries
   * `isTrusted: false` and some widgets ignore it, which is why
   * hand-built click fallbacks usually put that route LAST. So the
   * default resolves to a point and drives `InputDispatcher`, which means
   * the click inherits the control lease, the generation stamp, the
   * held-state hygiene and the stand-down gate. `via: 'dispatch'` is the
   * explicit escape hatch, never the default.
   *
   * WHY THERE IS A `verify` OPTION. Without one this method can only
   * report that a click was DELIVERED, which is not the same claim as
   * "the click worked". The difference shows up in practice as a reported
   * success on a click that landed on a transparent overlay, with the menu
   * never having opened. Pass a page expression and
   * a failure says so, retries, and then names what was on top of the
   * element:
   *
   * ```ts
   * await client.click('[data-testid="submit"]', {
   *   verify: 'document.querySelectorAll("[role=option]").length > 0',
   * });
   * // On failure: OCCLUDED, "would land on
   * // div[data-testid="click_filter"], not on the element"
   * ```
   *
   * Requires a held `ControlLease`, like every other interaction method.
   * It does not acquire one itself: a form of forty fields driven by a
   * verb that took and released a lease per call would broadcast a hundred
   * and twenty grant-and-release effects to every watching human, whose UI
   * would show control changing hands several times a second. Hold the
   * lease across the sequence with `acquireControl()`.
   */
  async click(selector: string, opts?: LocatorClickOptions): Promise<ClickResult> {
    const targetId = this._targetId;
    return this.run(
      'click',
      targetId,
      ['evaluate', 'control'],
      true,
      { selector, ...(opts?.index !== undefined ? { index: opts.index } : {}) },
      true,
      async () => this.locators.click(targetId, selector, opts),
    );
  }

  /**
   * Moves the pointer to the element a selector resolves to, through the
   * same real CDP input path a person's mouse move takes.
   *
   * Waits for `'actionable'`, the same state `click` waits for, and fails
   * with the same named taxonomy (`NOT_FOUND`, `NOT_VISIBLE`, `DISABLED`,
   * `OCCLUDED`, `NOT_STABLE`, `DETACHED`) when it cannot be reached: a
   * hover that silently landed on a covered or disabled element would be
   * strictly less honest than `click`'s own contract, for no reason a
   * caller could see. For the menus and tooltips that open only on
   * `:hover`, with nothing to click.
   *
   * Requires a held `ControlLease`, like every other interaction method.
   */
  async hover(selector: string, opts?: LocatorHoverOptions): Promise<HoverResult> {
    const targetId = this._targetId;
    return this.run(
      'hover',
      targetId,
      ['evaluate', 'control'],
      true,
      { selector, ...(opts?.index !== undefined ? { index: opts.index } : {}) },
      true,
      async () => this.locators.hover(targetId, selector, opts),
    );
  }

  /**
   * Types a value into the field a selector resolves to: click to focus,
   * clear, then real per-character key events.
   *
   * WHY REAL KEYS BY DEFAULT. `Input.insertText` fires `beforeinput` and
   * `input` and no `keydown` at all, and many filtering comboboxes
   * (react-select style widgets, some enterprise form widgets) open and
   * filter on `keydown`. A `fill` that defaulted to `insertText` would pass every
   * test written against a plain `<input>` and fail on the sites that
   * matter. `mode: 'insert'` is available and is faster; it is opt-in.
   *
   * WHY IT STANDS DOWN MID-WORD. The typing runs through the same
   * preemption-checked loop `humanType()` uses, so a person taking the
   * browser stops it between two characters and the thrown
   * `LEASE_REVOKED` carries `charsTyped` and `charsTotal`. Playwright
   * cannot do this, having no concept of a second driver, and it is the
   * reason this is the default rather than an option.
   *
   * The value is read back afterwards and reported as `verified`, for the
   * same reason `click` has a `verify`: delivery is not success.
   *
   * CHECK `verified`. A mismatch does NOT throw by default, because a
   * masked or reformatting field (a phone number coming back as
   * "(555) 010-9999") is a legitimate result the caller has to look at.
   * The cost of that default is that a dropped character also comes back
   * as `ok: true, verified: false`, and a login whose password lost a
   * character fails without an exception. Pass `strict: true` to make any
   * mismatch throw `TIMEOUT` instead; that is the right setting for
   * credentials and for any field you do not expect the page to rewrite.
   */
  async fill(selector: string, value: string, opts?: LocatorFillOptions): Promise<FillResult> {
    const targetId = this._targetId;
    return this.run(
      'fill',
      targetId,
      ['evaluate', 'control'],
      true,
      { selector, length: value.length },
      true,
      async () => this.locators.fill(targetId, selector, value, opts),
    );
  }

  /** The rendered text of the element a selector resolves to, Playwright's `inner_text`. One round trip: the read rides along on the resolver rather than following it. */
  async innerText(
    selector: string,
    opts?: { index?: number; timeoutMs?: number; limit?: number },
  ): Promise<string> {
    const targetId = this._targetId;
    return this.run('innerText', targetId, ['evaluate'], false, { selector }, false, async () =>
      this.locators.innerText(targetId, selector, opts),
    );
  }

  /** One attribute of the element a selector resolves to, or `null` when the attribute is absent. Throws `NOT_FOUND` when the SELECTOR matched nothing, which is a different thing and must not be confused with it. */
  async getAttribute(
    selector: string,
    name: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<string | null> {
    const targetId = this._targetId;
    return this.run(
      'getAttribute',
      targetId,
      ['evaluate'],
      false,
      { selector, name },
      false,
      async () => this.locators.getAttribute(targetId, selector, name, opts),
    );
  }

  /** Whether the element a selector resolves to is checked, reading `element.checked` and falling back to `aria-checked` for the widgets that are not real inputs. */
  async isChecked(
    selector: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<boolean> {
    const targetId = this._targetId;
    return this.run('isChecked', targetId, ['evaluate'], false, { selector }, false, async () =>
      this.locators.isChecked(targetId, selector, opts),
    );
  }

  /**
   * Every `<option>` on the `<select>` a selector resolves to: value,
   * visible label, position, and whether each is selected or disabled.
   * Read-only, one round trip: the read rides along on the resolver, the
   * same way `innerText()`/`getAttribute()`/`isChecked()` do. Throws
   * `INVALID_ARGUMENT` when the match is not a `<select>`, naming what it
   * found instead, the same contract `select()` itself gives.
   *
   * `select()`'s own option-not-found error already had to enumerate a
   * `<select>`'s options; this reads off the SAME page-side enumeration
   * (`locator/script.ts`'s `bglsListOptions`) rather than a second one.
   */
  async dropdownOptions(
    selector: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<DropdownOption[]> {
    const targetId = this._targetId;
    return this.run(
      'dropdownOptions',
      targetId,
      ['evaluate'],
      false,
      { selector },
      false,
      async () => this.locators.dropdownOptions(targetId, selector, opts),
    );
  }

  /**
   * Scrolls the element into view and returns it as measured AFTER the
   * scroll, in the same evaluation.
   *
   * The two halves of that sentence are one requirement. A rect read while
   * the control was below the fold gives coordinates that point at
   * whatever happens to be at that spot on screen, which is how a mouse
   * driven click ends up hitting empty page in production. Every acting
   * verb here scrolls inside its own measuring evaluation for that reason;
   * this method exists for the caller that wants the post-scroll rect
   * without acting.
   */
  async scrollIntoView(
    selector: string,
    opts?: { index?: number; timeoutMs?: number },
  ): Promise<LocatorMatch> {
    const targetId = this._targetId;
    return this.run(
      'scrollIntoView',
      targetId,
      ['evaluate'],
      false,
      { selector },
      false,
      async () => this.locators.scrollIntoView(targetId, selector, opts),
    );
  }

  /**
   * Scrolls the element whose normalised text contains (or, with
   * `{ exact: true }`, equals) `text` into view, and returns it as
   * measured after the scroll.
   *
   * Composes over {@link scrollIntoView} and the `text=` selector engine
   * already documented on {@link resolve}, rather than adding a second way
   * to find text on a page. `exact: true` wraps `text` in the quoting
   * `text=` already understands (`text="exact phrase"`).
   */
  async scrollToText(text: string, opts?: ScrollToTextOptions): Promise<LocatorMatch> {
    const targetId = this._targetId;
    return this.run('scrollToText', targetId, ['evaluate'], false, { text }, false, async () =>
      this.locators.scrollToText(targetId, text, opts),
    );
  }

  /**
   * Scrolls INSIDE the element a selector resolves to, by dispatching a
   * real wheel event at its centre rather than at a fixed page point.
   *
   * `scroll()` already dispatches a wheel event through the held lease at
   * a caller-named point; this resolves a scroll region first (a
   * virtualised list, a modal body, any element with its own
   * `overflow: auto`) and aims the same dispatch at ITS centre, which is
   * what a person's mouse wheel would do positioned over that element.
   * Takes the same actionability check every other acting verb takes, and
   * fails with the same named taxonomy when it cannot be reached.
   *
   * Requires a held `ControlLease`, like every other interaction method.
   */
  async scrollContainer(
    selector: string,
    delta: { dx?: number; dy?: number },
    opts?: LocatorScrollContainerOptions,
  ): Promise<ScrollContainerResult> {
    const targetId = this._targetId;
    return this.run(
      'scrollContainer',
      targetId,
      ['evaluate', 'control'],
      true,
      { selector, ...delta },
      true,
      async () => this.locators.scrollContainer(targetId, selector, delta, opts),
    );
  }

  /**
   * Searches the page's VISIBLE rendered text for `pattern`, a literal
   * string or a `RegExp`, and returns every match with a window of
   * surrounding text (browser-use's `search_page`). Requires only
   * `evaluate`, not `control`: reading what a page says is not driving it.
   *
   * ONE evaluate covers the whole page: text hidden by CSS is filtered out
   * the same way {@link resolve} filters it, and each match's containing
   * element is stamped (`ref=<token>`) so it can be acted on afterward
   * without re-searching for it, unless `stamp: false`.
   *
   * ```ts
   * const hits = await client.findInPage('confirmation number');
   * await client.click(`ref=${hits.matches[0].ref}`);
   * ```
   */
  async findInPage(pattern: string | RegExp, opts?: FindInPageOptions): Promise<FindInPageResult> {
    const targetId = this._targetId;
    return this.run(
      'findInPage',
      targetId,
      ['evaluate'],
      false,
      { pattern: String(pattern) },
      false,
      async () => this.locators.findInPage(targetId, pattern, opts),
    );
  }

  /**
   * Attaches files to an `<input type="file">`, the equivalent of
   * Playwright's `set_input_files`. Needs the `upload` capability.
   *
   * WHY THIS TAKES BYTES AND NOT A PATH
   *
   * Playwright hands `set_input_files` a path because Playwright's client
   * and its browser are on the same machine. Here they are not: the file
   * has to reach the machine running Chrome before Chrome can open it, and
   * a path from this process would either mean nothing there or, worse,
   * mean something. So the caller supplies the bytes and the name, and
   * this method stages them across the socket first (`upload.begin`, then
   * `UPLOAD_CHUNK` binary frames, then `upload.complete`) before naming
   * the resulting ids in one `files.set`.
   *
   * A Node caller with a local path reads it first:
   * `setInputFiles('#attachment', { name: 'report.pdf', data: await readFile(p) })`.
   * This package does not do that read itself, because it also runs where
   * there is no filesystem.
   *
   * Takes no `ControlLease`. Attaching a file sends no `input.*` message,
   * so there is no lease fencing to satisfy; it is gated on the `upload`
   * capability, the same as the staging messages. See
   * `@browserglass/server`'s `ManagedSession.setInputFiles` for the
   * server-side half of that argument.
   *
   * Returns the names the page will actually see, which can differ from
   * the names given if a name had to be sanitised.
   */
  async setInputFiles(
    selector: string,
    files: UploadFileInput | readonly UploadFileInput[],
  ): Promise<string[]> {
    const targetId = this._targetId;
    const list = Array.isArray(files)
      ? (files as readonly UploadFileInput[])
      : [files as UploadFileInput];
    return this.run(
      'setInputFiles',
      targetId,
      ['upload'],
      false,
      { selector, count: list.length },
      false,
      async () => {
        if (list.length === 0)
          throw new AutomationError('INVALID_ARGUMENT', 'setInputFiles() needs at least one file');
        const uploadIds: string[] = [];
        try {
          for (const file of list) uploadIds.push(await this.stageUpload(targetId, file));
          const reply = await this.core.request<FilesSetResult>('files.set', {
            targetId,
            selector,
            uploadIds,
          });
          return [...reply.files];
        } catch (err) {
          // Every id staged so far is cancelled before rethrowing.
          // Otherwise a `files.set` that fails on a bad selector (the
          // overwhelmingly common failure, since the selector is the part a
          // caller gets wrong) leaves the bytes on the gateway's disk until
          // its retention window expires, and an agent retrying in a loop
          // would stage the same file a hundred times. The server's TTL
          // and its own disconnect cleanup are the backstops; this is the
          // tidy path.
          for (const uploadId of uploadIds) {
            try {
              this.core.transport.send({ v: 1, t: 'upload.cancel', ts: Date.now(), uploadId });
            } catch {
              // The socket is already gone, which cleans up server side anyway.
            }
          }
          throw err;
        }
      },
    );
  }

  /**
   * Stages one file and returns its `uploadId`. Three steps, matching the
   * `upload.*` message set: negotiate, send bytes on the binary channel,
   * finalise.
   *
   * `seq` is the zero-based chunk index, which is what the binary header's
   * `seq` field means for `UPLOAD_CHUNK` specifically (`binary.ts`'s own
   * doc: "byte offset equals `seq * upload.accepted.chunkBytes`"), and not
   * the from-one per-stream counter it means for a frame. `streamId` is 0
   * because an upload is session scoped, not attached to a stream.
   */
  private async stageUpload(targetId: string, file: UploadFileInput): Promise<string> {
    const uploadId = this.core.newId();
    const accepted = await this.core.request<UploadAccepted>('upload.begin', {
      uploadId,
      targetId,
      name: file.name,
      sizeBytes: file.data.byteLength,
      mime: file.mime ?? 'application/octet-stream',
      purpose: 'input',
    });
    const binaryId = accepted.binaryId;
    if (typeof binaryId !== 'string') {
      throw AutomationError.notImplemented(
        'setInputFiles',
        'a gateway that returns upload.accepted.binaryId; this one accepted the upload but named no binary channel id, so there is no way to send the bytes',
      );
    }
    const idBytes = hexToBytes(binaryId);
    const chunkBytes = accepted.chunkBytes > 0 ? accepted.chunkBytes : 256 * 1024;

    for (let offset = 0, seq = 0; offset < file.data.byteLength; offset += chunkBytes, seq += 1) {
      const chunk = file.data.subarray(offset, Math.min(offset + chunkBytes, file.data.byteLength));
      const payload = encodeUploadChunkPayload(idBytes, chunk);
      const header = encodeBinaryHeader({
        version: 1,
        msgType: MsgType.UPLOAD_CHUNK,
        streamId: 0,
        seq,
        tsDeltaMs: 0,
        payloadCodec: PayloadCodec.NONE,
        flags: 0,
        gen16: 0,
      });
      const frame = new Uint8Array(header.byteLength + payload.byteLength);
      frame.set(header, 0);
      frame.set(payload, header.byteLength);
      this.core.transport.sendBinary(frame);
    }

    // A zero-byte file sends no chunks at all and still completes, which
    // is correct: an empty file is a legal upload and the server's size
    // check (received must equal declared) is satisfied by 0 === 0.
    await this.core.request<UploadDone>('upload.complete', { uploadId });
    return uploadId;
  }

  // ==================================================================
  // Waiting
  // ==================================================================

  async sleep(ms: number): Promise<void> {
    return this.run('sleep', this._targetId, [], false, { ms }, false, async () => {
      await sleepMs(ms);
    });
  }

  /** Awaits the next `nav.state` for {@link targetId} with `loading: false`. */
  async waitForNavigation(opts?: WaitForNavigationOptions): Promise<StatusResult> {
    const targetId = this._targetId;
    return this.run('waitForNavigation', targetId, ['view'], false, undefined, false, async () => {
      const timeoutMs = opts?.timeoutMs ?? this.core.defaultTimeoutMs;
      const nav = await this.core.awaitMessage<NavState>(
        (m) => m.t === 'nav.state' && m['targetId'] === targetId && m['loading'] === false,
        timeoutMs,
      );
      return this.navStateToStatus(nav);
    });
  }

  /**
   * Waits until some element matching `selector` contains `text` in its
   * rendered text, then returns the normalised text that matched.
   *
   * Built directly on {@link waitForFunction} rather than as a second poll
   * loop of its own. A typical "wait for a status banner" or "wait for a
   * toast to say Saved" call site is "evaluate, check text, sleep,
   * repeat" hand-rolled at each site, which is exactly the
   * round-trip arithmetic {@link waitForFunction} already exists to fix
   * (one `run()` for the whole wait, not one per poll; see that method's
   * own doc). This method contributes nothing but the predicate string and
   * a timeout message that names what it was looking for.
   *
   * MATCHING. Every element `document.querySelectorAll(selector)` finds is
   * checked (not only the first), against its normalised `textContent`
   * (whitespace collapsed, trimmed), matched case-insensitively by
   * default: the same rule the `text=` locator engine documents
   * (`locator/script.ts`'s `bglsMatchesNeedle`), so a caller who already
   * learned that engine's behaviour is not surprised by a different one
   * here. `opts.exact: true` requires the WHOLE normalised text to equal
   * `text` rather than merely contain it.
   *
   * `selector` is a PLAIN CSS selector passed straight to
   * `querySelectorAll`, not the locator surface's `>>`-chained,
   * multi-engine dialect ({@link resolve}'s own doc). The two things this
   * method needs from a selector, find some elements and check their text,
   * have no use for the extra engines, and splicing the whole resolver
   * script into what is meant to be a thin wrapper over
   * {@link waitForFunction} would be exactly the "invent a second poller"
   * this method exists to avoid.
   *
   * Requires `evaluate`, like every other method built on it.
   */
  async waitForText(selector: string, text: string, opts?: WaitForTextOptions): Promise<string> {
    const exact = opts?.exact === true;
    const predicate = buildWaitForTextPredicate(selector, text, exact);

    try {
      return await this.waitForFunction<string>(predicate, {
        ...(opts?.timeoutMs !== undefined ? { pollTimeoutMs: opts.timeoutMs } : {}),
        ...(opts?.pollingMs !== undefined ? { pollingMs: opts.pollingMs } : {}),
        // `ENGINE_WORLD`, for the same reason the six fixed scripts in
        // `locator/engine.ts` pass it, and this one was MISSED when they
        // were done. `waitForFunction` is caller facing and rightly
        // defaults to the main world; this predicate is not caller
        // authored. `buildWaitForTextPredicate` writes every character of
        // it, `selector` and `text` reach it only as JSON literals, and it
        // reads `document.querySelectorAll` and `textContent` and nothing
        // else, so it has no more use for a page global than `RESOLVE_SCRIPT`
        // does.
        //
        // Measured before the fix, against real Chrome, on a page counting
        // its own calls: one `waitForText` moved the page's
        // `querySelectorAll` counter from 0 to 1, and it moves it once per
        // POLL, so a wait that takes four seconds at the default 100ms
        // interval hands the page forty observations of the automation
        // looking for its text. That is the leak the whole world discipline
        // exists to close, arriving through the one locator-surface verb
        // that is built on the caller-facing poller instead of on the
        // engine.
        world: ENGINE_WORLD,
      });
    } catch (err) {
      // `waitForFunction`'s own timeout message ("the predicate never
      // returned a truthy value") is honest but generic: it was written
      // for an arbitrary caller-supplied predicate, not for this specific
      // one. Naming the selector and the text here is the entire value
      // this wrapper adds over calling `waitForFunction` directly.
      if (err instanceof AutomationError && err.code === 'TIMEOUT') {
        throw new AutomationError(
          'TIMEOUT',
          `waitForText('${selector}', '${text}'): no element matched by '${selector}' had text ${exact ? 'equal to' : 'containing'} '${text}' within the deadline.`,
          { ...err.details, selector, text, exact },
        );
      }
      throw err;
    }
  }

  /**
   * Resolves once {@link targetId}'s in-flight request count has stayed at
   * or below `opts.maxInflight` (default 0) continuously for `opts.idleMs`
   * (default 500ms), or rejects `TIMEOUT` after `opts.timeoutMs` (default
   * `defaultTimeoutMs`) regardless of activity.
   *
   * This used to refuse outright: `packages/core/src/diagnostics/target-diagnostics.ts`'s
   * `TargetDiagnostics` reported a request only on a TERMINAL event
   * (`Network.loadingFinished`/`loadingFailed`, or its own
   * `RESPONSE_FALLBACK_MS` 1500ms fallback) and never on
   * `Network.requestWillBeSent`, so there was no signal anywhere for "how
   * many requests are outstanding right now", which is what "idle" means.
   * `TargetDiagnostics` already tracked exactly that count internally
   * (`pendingRequests`, kept for terminal-event correlation, not for
   * counting) and simply never published it; it now does, as
   * `NetworkSummaryPayload.inFlight` on the periodic `network.summary`
   * feed this method reads through {@link diagnostics}'s `network` event
   * (`packages/core/src/diagnostics/types.ts`), read live off
   * `pendingRequests.size` rather than accumulated per window, since "how
   * many right now" is a gauge and everything else on that payload is a
   * rollup of the window just closed.
   *
   * Extending the existing periodic payload was chosen over a dedicated
   * `network.inflight`-style event: it needed no new wire message, no new
   * capability gate, and no new subscription lifecycle, all of which
   * `network.summary` already has. The cost is latency: the feed's own
   * cadence is `NETWORK_SUMMARY_WINDOW_MS` (5000ms), so absent traffic to
   * react to, a caller could learn "went idle" up to 5 seconds after the
   * fact. `TargetDiagnostics` narrows exactly the one case this method
   * lives for, "the last outstanding request just finished", to an
   * immediate out-of-cycle emission (`flushIfNowIdle`, that file's own
   * doc); every other transition still waits for the next tick.
   *
   * `waitForNetworkIdle()` itself adds nothing clever on top: it watches
   * `inFlight` on every `network.summary` for this target and starts a
   * timer the moment a reading is at or below `maxInflight`, cancelling it
   * the moment one is not, resolving when that timer reaches `idleMs`
   * uninterrupted. Requires an active `network` diagnostics subscription
   * on {@link targetId} (`diagnostics.subscribe({ network: true })`),
   * checked locally so a caller who forgot fails fast rather than sitting
   * on the full `timeoutMs` waiting for a feed nobody turned on, exactly
   * as {@link diagnostics}'s own `subscribe()` checks `devtools` before
   * any round trip.
   *
   * One gap remains outside this package's scope: the wire message
   * `network.summary` actually travels as
   * (`packages/protocol/src/wire/messages/diagnostics.ts`'s
   * `NetworkSummary`) and the server code that builds it
   * (`packages/server/src/session/managed-session.ts`) still enumerate
   * only `windowMs`/`requests`/`failed`/`bytesIn`/`bytesOut`/`slowest`;
   * neither carries `inFlight` yet. This method reads `inFlight` off
   * whatever the wire actually sends and simply never resolves it from a
   * gateway that has not been updated to include it, timing out instead:
   * it does not fabricate a value. `navigate()`'s own `waitUntil:
   * 'networkidle'` remains unimplemented server side for the same reason.
   */
  async waitForNetworkIdle(opts?: WaitForNetworkIdleOptions): Promise<void> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('devtools')) {
      throw new AutomationError(
        'POLICY_DENIED',
        "waitForNetworkIdle() needs the 'devtools' capability",
        { required: 'devtools' },
      );
    }
    if (!isNetworkFeedSubscribed(this.core, targetId)) {
      throw new AutomationError(
        'POLICY_DENIED',
        `waitForNetworkIdle() requires an active network diagnostics subscription on ${targetId}; call diagnostics.subscribe({ network: true }) first`,
      );
    }
    return this.run(
      'waitForNetworkIdle',
      targetId,
      [],
      false,
      opts as Record<string, unknown> | undefined,
      false,
      async () => {
        const maxInflight = opts?.maxInflight ?? 0;
        const idleMs = opts?.idleMs ?? 500;
        const timeoutMs = opts?.timeoutMs ?? this.core.defaultTimeoutMs;

        await new Promise<void>((resolve, reject) => {
          let idleTimer: ReturnType<typeof setTimeout> | null = null;

          const disarmIdleTimer = (): void => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = null;
          };
          const cleanup = (): void => {
            disarmIdleTimer();
            clearTimeout(deadlineTimer);
            off();
          };
          // `transport.on('message', ...)` directly, the same pattern
          // `@browserglass/client`'s `BrowserGlassClient.awaitInitialSubscriptions`
          // uses for a raw, unparsed wait: this reads `inFlight` straight off
          // the envelope rather than through `core`'s own `networksummary`
          // emitter event, so a build of this SDK against an OLDER
          // `@browserglass/automation` `core.ts` (which does not forward
          // `inFlight` onto that event) still works correctly here.
          const off = this.core.transport.on('message', (msg) => {
            if (msg.t !== 'network.summary' || msg['targetId'] !== targetId) return;
            const inFlight = msg['inFlight'];
            if (typeof inFlight !== 'number') return; // gateway does not carry this field yet; nothing to act on
            if (inFlight <= maxInflight) {
              if (!idleTimer) {
                idleTimer = setTimeout(() => {
                  cleanup();
                  resolve();
                }, idleMs);
                idleTimer.unref?.();
              }
            } else {
              disarmIdleTimer();
            }
          });
          const deadlineTimer = setTimeout(() => {
            cleanup();
            reject(
              new AutomationError(
                'TIMEOUT',
                `waitForNetworkIdle() timed out after ${timeoutMs}ms waiting for ${targetId}'s in-flight request count to reach ${maxInflight} and stay there for ${idleMs}ms`,
              ),
            );
          }, timeoutMs);
          deadlineTimer.unref?.();
        });
      },
    );
  }

  /**
   * Waits for the next download on this target to finish, and returns how
   * to fetch it.
   *
   * Downloads never stream through this socket. `DownloadReady` carries a
   * signed, short lived, single use HTTP URL and the file's `sha256`, and
   * fetching it is an ordinary HTTP GET the caller makes itself. That is
   * deliberate: a multi hundred megabyte file has no business travelling
   * over the control channel, competing with input and frames.
   *
   * The download bridge is opt in per target for the same reason
   * diagnostics is: nothing enables download events for a target nobody
   * asked about. If no download arrives within `timeoutMs` this rejects
   * rather than resolving with nothing, because "no download happened" and
   * "a download happened and I missed it" are different facts and only one
   * of them is worth continuing on.
   *
   * Subscribes BEFORE returning to the caller's trigger, which is the
   * whole reason this takes an optional `trigger` rather than being called
   * after the click. A download started by a click can complete before a
   * listener attached afterwards ever runs, and that race is not
   * theoretical on a small file served locally.
   */
  async waitForDownload(opts?: WaitForDownloadOptions): Promise<DownloadResult> {
    const targetId = this._targetId;
    if (!this.core.hasCapability('download')) {
      throw new AutomationError(
        'POLICY_DENIED',
        "waitForDownload() needs the 'download' capability",
        { required: 'download' },
      );
    }
    const timeoutMs = opts?.timeoutMs ?? 60_000;

    let settle: ((r: DownloadResult) => void) | null = null;
    let fail: ((e: unknown) => void) | null = null;
    const result = new Promise<DownloadResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    // One subscription covering both terminal outcomes. `download.started`
    // is deliberately NOT waited on: a caller asking to wait for a download
    // wants the file, and a started download that then fails is a failure,
    // not a success that never resolved.
    const off = this.core.transport.on('message', (msg: Envelope) => {
      if (msg.t === 'download.ready') {
        const m = msg as unknown as {
          downloadId: string;
          sizeBytes: number;
          sha256: string;
          url: string;
          expiresAt: number;
        };
        settle?.({
          downloadId: m.downloadId,
          sizeBytes: m.sizeBytes,
          sha256: m.sha256,
          url: this.core.resolveGatewayUrl(m.url),
          expiresAt: m.expiresAt,
        });
      } else if (msg.t === 'download.failed') {
        const m = msg as unknown as { downloadId: string; reason: string };
        // `PROTOCOL_ERROR` rather than a download specific code: the
        // download did not merely time out, the server actively reported
        // it failed, and the reason string is the useful part.
        fail?.(
          new AutomationError(
            'PROTOCOL_ERROR',
            `waitForDownload(): the download failed: ${m.reason}`,
            { downloadId: m.downloadId, reason: m.reason, targetId },
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      fail?.(
        new AutomationError(
          'TIMEOUT',
          `waitForDownload(): no download completed on ${targetId} within ${timeoutMs}ms. A download only reports here when the instance was launched with a downloadDir and the token carries 'download'.`,
          { targetId, timeoutMs },
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    try {
      // Fired only after the listener above is live. See this method's doc.
      if (opts?.trigger) await opts.trigger();
      return await result;
    } finally {
      clearTimeout(timer);
      off();
    }
  }

  // ==================================================================
  // Tabs (require `tabs.manage`)
  // ==================================================================

  readonly tabs = {
    list: async (): Promise<TabSummary[]> =>
      this.run('tabs.list', this._targetId, ['tabs.manage'], false, undefined, false, async () => {
        const reply = await this.core.request<TargetListed>('target.list', {});
        return reply.targets;
      }),

    open: async (opts?: OpenTabOptions): Promise<TabSummary> =>
      this.run(
        'tabs.open',
        this._targetId,
        ['tabs.manage'],
        false,
        opts as Record<string, unknown> | undefined,
        false,
        async () => {
          const reply = await this.core.request<TargetCreated>('target.new', {
            ...(opts?.url !== undefined ? { url: opts.url } : {}),
            ...(opts?.background !== undefined ? { background: opts.background } : {}),
          });
          return reply.target;
        },
      ),

    close: async (targetId: string): Promise<void> =>
      this.run('tabs.close', targetId, ['tabs.manage'], false, undefined, false, async () => {
        await this.core.request('target.close', { targetId });
      }),

    activate: async (targetId: string): Promise<void> =>
      this.run('tabs.activate', targetId, ['tabs.manage'], false, undefined, false, async () => {
        await this.core.request('target.activate', { targetId });
      }),

    active: async (): Promise<TabSummary | null> =>
      this.run(
        'tabs.active',
        this._targetId,
        ['tabs.manage'],
        false,
        undefined,
        false,
        async () => this.core.targets.find((t) => t.active) ?? null,
      ),
  };

  // ==================================================================
  // Page evaluation (`evaluate` capability, `page.evaluate`)
  // ==================================================================

  /**
   * Runs JavaScript in this target's own page context and returns the
   * result by value.
   *
   * Two spellings, matching Playwright's `page.evaluate` closely enough
   * that code moving across needs no rethinking:
   *
   * ```ts
   * await page.evaluate('document.title');
   * await page.evaluate(() => document.title);
   * await page.evaluate((sel: string) => document.querySelector(sel)?.textContent, '#name');
   * ```
   *
   * A function is serialised with `Function.prototype.toString()` and
   * called in the page with the JSON `args`, which means the same rule
   * Playwright has: the function body CANNOT close over anything in this
   * process. A variable captured from the enclosing scope is not there when
   * the source is re-parsed inside the page, and the result is a
   * `ReferenceError` from the page rather than a silent wrong answer. Pass
   * what it needs through `args`.
   *
   * Differences from Playwright worth knowing before relying on them:
   *
   *  * The result must be JSON-representable. Playwright returns a
   *    `JSHandle` for a live object; this returns a thrown
   *    `NOT_IMPLEMENTED`-free but explicit `PROTOCOL_ERROR` naming what the
   *    value was, because handles are exactly the escalation the wire
   *    refuses to carry (see `PageEvaluate`'s module doc, path 5). Narrow
   *    the expression: `el.textContent`, never `el`.
   *  * `await` works. `awaitPromise` defaults to true here and false in
   *    raw CDP.
   *  * A page-side throw arrives as an `AutomationError` whose message is
   *    the PAGE's own message, with the page's stack in `details.stack`,
   *    distinguishable from a transport failure by `code`.
   */
  async evaluate<T = unknown>(
    script: string | ((...args: never[]) => unknown),
    ...args: readonly unknown[]
  ): Promise<T> {
    return this.evaluateWithOptions<T>(script, args, undefined);
  }

  /** {@link evaluate} with {@link EvaluateOptions}; the variadic overload above cannot also take an options bag without ambiguity. */
  async evaluateWith<T = unknown>(
    script: string | ((...args: never[]) => unknown),
    args: readonly unknown[],
    opts?: EvaluateOptions,
  ): Promise<T> {
    return this.evaluateWithOptions<T>(script, args, opts);
  }

  private async evaluateWithOptions<T>(
    script: string | ((...args: never[]) => unknown),
    args: readonly unknown[],
    opts: EvaluateOptions | undefined,
  ): Promise<T> {
    const targetId = this._targetId;
    // `userGesture` needs `control` as well as `evaluate`
    // (`EVALUATE_USER_GESTURE_CAPABILITY_RULE`). Checked locally so a
    // caller lacking it fails fast rather than paying a round trip for the
    // server to refuse it, exactly as `inspectAt()` does with
    // `PROBE_CAPABILITY_RULE`.
    const caps: Capability[] = [EVALUATE_USER_GESTURE_CAPABILITY_RULE.baseCapability];
    if (EVALUATE_USER_GESTURE_CAPABILITY_RULE.appliesWhen({ userGesture: opts?.userGesture })) {
      caps.push(EVALUATE_USER_GESTURE_CAPABILITY_RULE.additionalCapability);
    }
    // No lease is required, and none is taken. Reading a page is not
    // driving it; see `ManagedSession.evaluate()`'s own note for why a
    // lease check there would be the wrong protection in the wrong place.
    return this.run('evaluate', targetId, caps, false, undefined, false, async () =>
      this.sendEvaluate<T>(targetId, script, args, opts),
    );
  }

  /**
   * The raw round trip behind {@link evaluate}, without the `run()`
   * pipeline. Called directly by {@link waitForFunction}, which polls: one
   * `run()` for the whole wait costs one step, whereas routing every poll
   * through `run()` would burn the caller's step budget at 10 steps a
   * second for doing nothing but waiting.
   */
  private async sendEvaluate<T>(
    targetId: string,
    script: string | ((...args: never[]) => unknown),
    args: readonly unknown[],
    opts: EvaluateOptions | undefined,
  ): Promise<T> {
    const asFunction = typeof script === 'function';
    return this.sendEvaluateSource<T>(
      targetId,
      asFunction ? 'function' : 'expression',
      asFunction ? script.toString() : script,
      args,
      opts,
    );
  }

  /**
   * The same round trip as {@link sendEvaluate}, but taking the function
   * SOURCE as text rather than as a live function.
   *
   * The locator engine needs this because its resolver is authored as text
   * and never compiled: passing a real TypeScript function through
   * `Function.prototype.toString()` would work only until the build
   * pipeline renamed a binding or injected a helper shim, and it would
   * break silently rather than loudly. See `locator/script.ts`'s module
   * doc. Nothing else about the call differs, so the two spellings share
   * one implementation and one set of failure semantics.
   *
   * `internal`, default false, is what the `locators` getter's
   * `evaluateFunction` port sets to true: it sends `page.evaluate.internal`
   * instead of `page.evaluate`, so the locator engine's own resolve/verify
   * bookkeeping is charged to its own smaller `evaluateInternal` bucket
   * rather than the caller's own `evaluate` one (`@browserglass/protocol`'s
   * `PageEvaluateInternal`, `packages/server/src/wire/rate-limit.ts`'s
   * `evaluateInternal`). Every internal call is `kind: 'function'`: the
   * locator engine's ONE caller-content evaluate, the `verify` predicate
   * `click()` accepts, reaches this method through `evaluateExpression`
   * (below), which never sets `internal`, so a caller-authored predicate
   * always still spends from the caller's own bucket.
   */
  private async sendEvaluateSource<T>(
    targetId: string,
    kind: 'expression' | 'function',
    source: string,
    args: readonly unknown[],
    opts: EvaluateOptions | undefined,
    internal = false,
  ): Promise<T> {
    const asFunction = kind === 'function';
    const reply = await this.core.request<PageEvaluated>(
      internal ? 'page.evaluate.internal' : 'page.evaluate',
      {
        targetId,
        ...(asFunction ? { functionDeclaration: source } : { expression: source }),
        ...(asFunction && args.length > 0 ? { args } : {}),
        ...(opts?.awaitPromise !== undefined ? { awaitPromise: opts.awaitPromise } : {}),
        // `PageEvaluateInternal` has no `userGesture` field; an internal
        // bookkeeping read never needs one, so it is never sent here.
        ...(!internal && opts?.userGesture !== undefined ? { userGesture: opts.userGesture } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.world !== undefined ? { world: opts.world } : {}),
      },
      // The transport deadline must outlive the server's own evaluation
      // deadline, or a slow-but-honest script produces a client-side
      // TIMEOUT that hides the server's real, more specific answer.
      (opts?.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS) + this.core.defaultTimeoutMs,
    );
    if (reply.ok === false) {
      const ex = reply.exception;
      throw new AutomationError('PROTOCOL_ERROR', ex?.message ?? 'the page threw', {
        pageException: true,
        ...(ex?.name !== undefined ? { name: ex.name } : {}),
        ...(ex?.stack !== undefined ? { stack: ex.stack } : {}),
        ...(ex?.lineNumber !== undefined ? { lineNumber: ex.lineNumber } : {}),
        ...(ex?.columnNumber !== undefined ? { columnNumber: ex.columnNumber } : {}),
      });
    }
    if (reply.resultType === 'undefined') return undefined as T;
    if (reply.resultType === 'unserializable') {
      const what = reply.unserializableValue ?? reply.description ?? 'a value';
      throw new AutomationError(
        'PROTOCOL_ERROR',
        `evaluate() produced ${what}, which cannot be returned by value; narrow the expression to a JSON-representable result`,
        {
          unserializable: true,
          ...(reply.description !== undefined ? { description: reply.description } : {}),
        },
      );
    }
    return reply.value as T;
  }

  /**
   * The page's rendered text, `document.body.innerText`. Requires `evaluate`.
   *
   * Runs in {@link ENGINE_WORLD}, not the caller-facing main-world default
   * of {@link evaluate}. `text()` and {@link html} look like caller-facing
   * conveniences and are not: the caller supplies no JavaScript at all, so
   * every character of what runs is written here, which is the same test
   * `ENGINE_WORLD` applies to the six fixed locator scripts.
   *
   * Measured against real Chrome on a page that patched the `innerText`
   * and `outerHTML` GETTERS on `HTMLElement.prototype` and
   * `Element.prototype`: before this change, one `text()` moved the page's
   * innerText counter from 0 to 1 and one `html()` moved its outerHTML
   * counter from 0 to 1. A page that wants to know whether it is being
   * scraped only has to define those two getters. It also gets to CHOOSE
   * WHAT THEY RETURN, which is worse than being seen: every downstream
   * decision made on that text was made on a value the page handed back
   * knowing it was being read.
   *
   * patchright, the baseline this surface is measured against, ran the
   * equivalent reads with `isolatedContext=True`, so isolated is both the
   * safe answer and the parity answer.
   */
  async text(): Promise<string> {
    return this.evaluateWith<string>('document.body ? document.body.innerText : ""', [], {
      world: ENGINE_WORLD,
    });
  }

  /** The page's full serialised markup, `document.documentElement.outerHTML`. Requires `evaluate`. */
  async html(): Promise<string> {
    // Isolated for the reason given on `text()` just above.
    return this.evaluateWith<string>(
      'document.documentElement ? document.documentElement.outerHTML : ""',
      [],
      { world: ENGINE_WORLD },
    );
  }

  /**
   * Polls `predicate` in the page until it returns a truthy value, and
   * returns that value. Requires `evaluate`.
   *
   * Playwright-recognisable semantics, with the two differences spelled
   * out rather than left to be discovered:
   *
   *  * It returns the truthy VALUE, not a `JSHandle`. Handles do not cross
   *    this wire at all (`PageEvaluate`'s module doc, path 5), so a
   *    predicate that returns an element resolves as an error, not as a
   *    handle. Return something serialisable: `!!el`, `el.textContent`.
   *  * Polling is on a fixed interval (`pollingMs`, default 100ms), not
   *    `requestAnimationFrame` and not `MutationObserver`. Each poll is a
   *    round trip, so an interval materially tighter than this would spend
   *    more time on the socket than in the page, and a raf-paced poll would
   *    additionally stop firing on a backgrounded tab, which is exactly the
   *    tab an unattended agent is most likely to be waiting on.
   *
   * A page-side throw inside the predicate is NOT swallowed as "not ready
   * yet": it propagates. A predicate that throws is a predicate that is
   * wrong, and retrying it for the full timeout before reporting a
   * `ReferenceError` that was true on the first poll wastes the caller's
   * time and buries the cause.
   */
  async waitForFunction<T = unknown>(
    predicate: string | ((...args: never[]) => unknown),
    opts?: WaitForFunctionOptions,
  ): Promise<T> {
    const targetId = this._targetId;
    const caps: Capability[] = [EVALUATE_USER_GESTURE_CAPABILITY_RULE.baseCapability];
    if (EVALUATE_USER_GESTURE_CAPABILITY_RULE.appliesWhen({ userGesture: opts?.userGesture })) {
      caps.push(EVALUATE_USER_GESTURE_CAPABILITY_RULE.additionalCapability);
    }
    const deadlineMs = opts?.pollTimeoutMs ?? this.core.defaultTimeoutMs;
    const pollingMs = opts?.pollingMs ?? 100;
    // One `run()` for the whole wait: see `sendEvaluate`'s own note on the
    // step budget.
    return this.run(
      'waitForFunction',
      targetId,
      caps,
      false,
      { pollTimeoutMs: deadlineMs, pollingMs },
      false,
      async () => {
        const startedAt = Date.now();
        let polls = 0;
        for (;;) {
          polls += 1;
          const value = await this.sendEvaluate<T>(targetId, predicate, [], opts);
          if (value) return value;
          const elapsed = Date.now() - startedAt;
          if (elapsed >= deadlineMs) {
            throw new AutomationError(
              'TIMEOUT',
              `waitForFunction() gave up after ${elapsed}ms and ${polls} polls; the predicate never returned a truthy value`,
              { pollTimeoutMs: deadlineMs, polls },
            );
          }
          // Never sleep past the deadline: a 100ms interval against a 50ms
          // remainder would otherwise report the timeout 50ms late, which is
          // small here and is the kind of drift that compounds in a caller
          // that wraps this in its own budget.
          await sleepMs(Math.min(pollingMs, deadlineMs - elapsed));
        }
      },
    );
  }

  // ==================================================================
  // Internal: the shared action pipeline (capability check, lease check,
  // step budget, dry-run skip, audit record) that every `AutomationClient`
  // call goes through.
  // ==================================================================

  private async run<T>(
    name: string,
    targetId: string,
    caps: Capability[],
    needsLease: boolean,
    args: Record<string, unknown> | undefined,
    dryRunSkip: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const inFlight = this.core.beginInFlight(name, targetId);
    try {
      for (const cap of caps) {
        if (!this.core.hasCapability(cap))
          throw new AutomationError('POLICY_DENIED', `${name}() needs the '${cap}' capability`, {
            required: cap,
          });
      }
      // The stand-down check runs BEFORE the lease-held check, not after,
      // and the order is the whole point. This client releases its lease
      // as soon as it stands down (that is the polite thing to do), so by
      // the time a caller's next call arrives there IS no lease, and a
      // lease-first order would answer every post-takeover call with
      // "you hold no lease" while never mentioning that a person took the
      // browser. That is the strictly less useful of the two true things
      // that can be said, and it is the one an agent cannot act on.
      //
      // It covers navigation as well as pointer and key input: driving a
      // page a person has just taken over to a different URL is every bit
      // as disruptive as clicking on it, and worse, since it throws away
      // whatever they were about to do.
      //
      // This is the fast, cheap half of the gate. It refuses before a step
      // is spent and before any round trip. The load-bearing half is the
      // second check each interaction body makes after `ensureGen()`,
      // because a yield can and does arrive during that round trip.
      if (needsLease) this.core.assertMayDispatch(targetId, name);
      if (needsLease && !this.core.hasControl(targetId)) {
        throw new AutomationError(
          'LEASE_NOT_HELD',
          `${name}() requires a held ControlLease on ${targetId}; call acquireControl() first`,
        );
      }
      this.core.consumeStep();

      const result = dryRunSkip && this.core.dryRun ? (undefined as T) : await fn();

      this.core.recordAction({
        action: name,
        targetId,
        ...(args !== undefined ? { args } : {}),
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      const wrapped =
        err instanceof AutomationError
          ? err
          : new AutomationError('PROTOCOL_ERROR', err instanceof Error ? err.message : String(err));
      this.core.recordAction({
        action: name,
        targetId,
        ...(args !== undefined ? { args } : {}),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { code: wrapped.code, message: wrapped.message },
      });
      throw wrapped;
    } finally {
      this.core.endInFlight(inFlight);
    }
  }
}
