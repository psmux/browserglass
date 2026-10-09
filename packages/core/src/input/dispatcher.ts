/**
 * `InputDispatcher`: one promise chain per `(sessionId, targetId)`, keyed
 * straight off `msg.targetId` with no lookup (this dispatcher is
 * constructed per session, so `targetId` alone is the chain key). It wires
 * together the key builder (`key-events.ts`), the coordinate transform
 * (`coordinates.ts`), `gen` fencing (`gen-fencing.ts`), `leaseId` fencing
 * (`../control/fencing.ts`'s `resolveInputFencing`), the rate limiter
 * (`rate-limit.ts`), pointer/key hygiene (`held-state.ts`), and the CDP
 * allowlist (`cdp-allowlist.ts`).
 *
 * `tailFor` and `releaseHeld` match, field for field, the shape
 * `ControlLeaseEngineOptions.drainInput`/`.releaseHeld` expect
 * (`../control/lease-engine.ts`): whoever assembles a Session wires this
 * dispatcher's methods directly into those two injection points.
 *
 * `getGeneration` is a required injection point rather than a real lookup
 * against `TargetRegistry`: neither this module nor `../cdp/**` tracks a
 * target's navigate/viewport-reconfigure generation counter. The streaming
 * pipeline's `Stream` owns that counter, so the caller passes it in.
 */

import type { InputDrag, InputMouse, InputTouch } from '@browserglass/protocol';
import { CdpError } from '../cdp/errors.js';
import { monotonicNow, scheduleTimer } from '../cdp/platform.js';
import type { CdpSessionId } from '../cdp/types.js';
import type { FenceCheckInput, FenceDecision, InputFenceKind } from '../control/fencing.js';
import { type AllowedInputMethod, type InputCdpSender, sendInputCommand } from './cdp-allowlist.js';
import { transformPoint } from './coordinates.js';
import { resolveGenFencing } from './gen-fencing.js';
import {
  type HeldState,
  buildReleaseCommands,
  createHeldState,
  primaryHeldButtonName,
} from './held-state.js';
import { buildKeyEvent } from './key-events.js';
import {
  type AdmissionClass,
  CriticalStarvationTracker,
  type CriticalStarvationTracker as CriticalStarvationTrackerType,
  RATE_DEFAULTS,
  type TokenBucket,
  admit,
  classifyAdmission,
  createTokenBucket,
} from './rate-limit.js';
import {
  fenceKindOf,
  validateComposition,
  validateDrag,
  validateKey,
  validateMouse,
  validateText,
  validateTouch,
} from './validation.js';

/** One `(sessionId, targetId)` snapshot the dispatcher needs from the target registry. Deliberately narrower than the full `TargetRegistry` interface. */
export interface InputTargetSnapshot {
  readonly viewport: { readonly width: number; readonly height: number } | null;
}

/** The minimal target resolution surface the dispatcher needs, structurally satisfied by `../cdp/target-registry.ts`'s `TargetRegistry`. */
export interface InputTargetResolver {
  get(targetId: string): InputTargetSnapshot | undefined;
  attach(targetId: string): Promise<{ readonly id: CdpSessionId }>;
}

/**
 * Every observable outcome the dispatcher reports through `onSignal`, in
 * place of throwing or logging directly (this module owns no logger).
 *
 * EVERY MEMBER CARRIES THE VALUES THAT PRODUCED IT, and that is the point of
 * the type rather than a convenience. `gen_stale` and `fence_denied` used to
 * name only the viewer and the target, which answers "something was dropped"
 * and not "why", and "why" is a comparison between two numbers or two ids
 * that only this module can see. A caller debugging "my clicks do nothing"
 * needs the pair, not the verdict.
 *
 * The four drop reasons are deliberately four members and not one with a
 * string, because they are four different facts with four different fixes:
 * a stale generation is a client using coordinates from before a resize or a
 * navigation, a denied fence is a client driving without the current lease,
 * a shed queue is the server protecting itself under load and is not a fault
 * at all, and a validation error is a malformed message.
 *
 * What is NOT in here matters just as much. `resolveInputFencing`'s release
 * asymmetry (`ALWAYS_DISPATCHED_KINDS`: mouse up, key up, touch end, touch
 * cancel, drag drop, drag leave) and `resolveGenFencing`'s `dispatch_at_last_position` both
 * DISPATCH on a stale lease or a stale generation rather than dropping, so
 * neither produces a signal. A departing driver's release is correct
 * behaviour, and reporting it as a failure would teach whoever reads these
 * to ignore them.
 */
export type InputSignal =
  | {
      readonly kind: 'validation_error';
      readonly viewerId: string;
      readonly targetId: string;
      readonly field: string;
      readonly message: string;
    }
  /** Coordinates computed against a superseded target generation. `expected` is what the target is on now; `received` is what the message claimed. */
  | {
      readonly kind: 'gen_stale';
      readonly viewerId: string;
      readonly targetId: string;
      readonly expectedGen: number;
      readonly receivedGen: number;
    }
  /** The message named a `leaseId` that is not this viewer's current one. `expectedLeaseId` is `null` when the viewer holds no lease on this target at all, which is the `no_lease` case and a different fault from naming an outdated id. */
  | {
      readonly kind: 'fence_denied';
      readonly viewerId: string;
      readonly targetId: string;
      readonly reason: string;
      readonly expectedLeaseId: string | null;
      readonly receivedLeaseId: string;
    }
  /** A `mouse.move` shed because the per-target dispatch chain is already backed up. Normal backpressure, never a fault: the cursor has moved on and the shed frame would have been overwritten anyway. Reported so it is countable, not so it is alarming. */
  | {
      readonly kind: 'queue_shed';
      readonly viewerId: string;
      readonly targetId: string;
      readonly depth: number;
      readonly maxDepth: number;
    }
  | {
      readonly kind: 'rate_limited';
      readonly viewerId: string;
      readonly targetId: string;
      readonly retryAfterMs: number;
    }
  | { readonly kind: 'rate_limit_escalate'; readonly viewerId: string; readonly targetId: string }
  /**
   * One input message that reached this dispatcher, passed every fencing
   * and rate-limit check, and still never got confirmed delivered to CDP:
   * the underlying `send()` rejected (whether synchronously, awaited-full,
   * or asynchronously after a raced dispatch had already moved the chain
   * on), OR `resolveSession()` gave up because `targets.attach()` did not
   * resolve within `sessionLookupTimeoutMs`. `viewerId` is the sender of
   * the message that failed to dispatch, not an unrelated background CDP
   * fault, which is what makes this actionable by that caller (resend the
   * input) rather than merely informational.
   */
  | {
      readonly kind: 'dispatch_error';
      readonly viewerId: string;
      readonly targetId: string;
      readonly error: unknown;
    };

/** Constructor options for {@link InputDispatcher}. */
export interface InputDispatcherOptions {
  readonly sessionId: string;
  readonly bridge: InputCdpSender;
  readonly targets: InputTargetResolver;
  /** Pure fencing decision for one inbound input message; normally `ControlLeaseEngine.checkFencing`. */
  readonly checkFencing: (
    input: FenceCheckInput,
    opts?: { readonly lastHolderViewerId?: string | null },
  ) => FenceDecision;
  /** Default: always `0` (never stale). See the module doc for why this is a required-shape, defaulted injection point. */
  readonly getGeneration?: (targetId: string) => number;
  /** Who held the lease immediately before the current tenure, for attributing a stale-lease release. Default: always `null`. */
  readonly lastHolderViewerId?: (targetId: string) => string | null;
  /** Default 100. */
  readonly cdpDispatchRaceMs?: number;
  /** Mouse moves shed above this queue depth. Default 10. */
  readonly maxQueueDepth?: number;
  /** Default 300, per viewer per target. */
  readonly inputRatePerSec?: number;
  /** Default 60. */
  readonly reserveTokens?: number;
  /** Default 10000ms. */
  readonly criticalOverrunMs?: number;
  /** Default 1000ms. */
  readonly sessionLookupTimeoutMs?: number;
  /**
   * The `leaseId` `viewerId` currently holds on `targetId`, or `null` if it
   * holds none. Used ONLY to populate {@link InputSignal}'s
   * `expectedLeaseId` for diagnostics; the dispatch decision itself is
   * `checkFencing`'s and is never taken from this.
   *
   * A separate injection point rather than a field on `FenceDecision`
   * because `FenceDecision` belongs to `../control/fencing.ts`, whose job is
   * to be a pure decision function, and because the honest answer is PER
   * VIEWER: under shared control a target has several holders each with
   * their own id, so "the lease id" is not a property of the target.
   * Default: always `null`, which reports the fault without the comparison.
   */
  readonly currentLeaseIdFor?: (targetId: string, viewerId: string) => string | null;
  readonly onSignal?: (signal: InputSignal) => void;
}

interface ChainState {
  tail: Promise<void>;
  depth: number;
}

function raceTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    scheduleTimer(() => resolve(), ms);
  });
}

function isSessionClosedError(err: unknown): boolean {
  return err instanceof CdpError && (err.kind === 'detached' || err.kind === 'closed');
}

function targetIdOf(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const t = (raw as Record<string, unknown>)['targetId'];
    if (typeof t === 'string') {
      return t;
    }
  }
  return '';
}

function mouseCdpType(kind: InputMouse['kind']): string {
  switch (kind) {
    case 'move':
      return 'mouseMoved';
    case 'down':
      return 'mousePressed';
    case 'up':
      return 'mouseReleased';
    case 'wheel':
      return 'mouseWheel';
    default:
      return 'mouseMoved'; // unreachable: InputMouse.kind is exhaustively covered above
  }
}

function touchCdpType(kind: InputTouch['kind']): string {
  switch (kind) {
    case 'start':
      return 'touchStart';
    case 'move':
      return 'touchMove';
    case 'end':
      return 'touchEnd';
    case 'cancel':
      return 'touchCancel';
    default:
      return 'touchCancel'; // unreachable: InputTouch.kind is exhaustively covered above
  }
}

/**
 * `InputDrag.kind` follows DOM drag event naming (`enter`/`over`/`drop`/
 * `leave`); CDP `Input.dispatchDragEvent`'s own `type` enum is
 * `dragEnter`/`dragOver`/`drop`/`dragCancel`. `leave` maps to `dragCancel`:
 * CDP has no "left the drop zone without dropping" verb, and that is
 * exactly what a cancelled drag is.
 */
function dragCdpType(kind: InputDrag['kind']): string {
  switch (kind) {
    case 'enter':
      return 'dragEnter';
    case 'over':
      return 'dragOver';
    case 'drop':
      return 'drop';
    case 'leave':
      return 'dragCancel';
    default:
      return 'dragCancel'; // unreachable: InputDrag.kind is exhaustively covered above
  }
}

function buttonBit(button: InputMouse['button']): number {
  switch (button) {
    case 'left':
      return 1;
    case 'right':
      return 2;
    case 'middle':
      return 4;
    case 'back':
      return 8;
    case 'forward':
      return 16;
    default:
      return 0;
  }
}

/**
 * Drives per-target input dispatch for one Session end to end: validation,
 * `gen` and `leaseId` fencing, rate limiting, pointer/key hygiene, and the
 * ordered, never-poisoned CDP dispatch chain. See the module doc for the
 * injection points a Session wires this up with.
 */
export class InputDispatcher {
  readonly sessionId: string;

  private readonly bridge: InputCdpSender;
  private readonly targets: InputTargetResolver;
  private readonly checkFencing: InputDispatcherOptions['checkFencing'];
  private readonly getGeneration: (targetId: string) => number;
  private readonly lastHolderViewerIdOf: (targetId: string) => string | null;
  private readonly raceMs: number;
  private readonly maxQueueDepth: number;
  private readonly ratePerSec: number;
  private readonly reserveTokens: number;
  private readonly criticalOverrunMs: number;
  private readonly sessionLookupTimeoutMs: number;
  private readonly currentLeaseIdFor: (targetId: string, viewerId: string) => string | null;
  private readonly onSignal: (signal: InputSignal) => void;

  private readonly chains = new Map<string, ChainState>();
  /**
   * Pointer and key hygiene state, keyed per `(targetId, viewerId)`.
   *
   * `held-state.ts` has always documented this as per `(target, viewer)`;
   * it was implemented per target, which is only equivalent while exactly
   * one viewer can ever be dispatching to a target. Shared control breaks
   * that assumption outright (N drivers on one tab), and it was already
   * wrong in a narrower way under exclusive control: the release asymmetry
   * dispatches a departed viewer's `mouse.up`/`key.up` even on a dead
   * lease, and each of those cleared a bit out of the CURRENT holder's
   * button mask and overwrote their modifier state.
   *
   * Keyed per viewer, two drivers can hold different mouse buttons and
   * different modifier keys on the same page without corrupting each
   * other's state, and `releaseHeld(targetId, viewerId)` releases exactly
   * what the departing driver was holding and nothing anybody else holds.
   */
  private readonly heldByTargetViewer = new Map<string, Map<string, HeldState>>();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly starvation = new Map<string, CriticalStarvationTrackerType>();

  constructor(options: InputDispatcherOptions) {
    this.sessionId = options.sessionId;
    this.bridge = options.bridge;
    this.targets = options.targets;
    this.checkFencing = options.checkFencing;
    this.getGeneration = options.getGeneration ?? (() => 0);
    this.lastHolderViewerIdOf = options.lastHolderViewerId ?? (() => null);
    this.raceMs = options.cdpDispatchRaceMs ?? 100;
    this.maxQueueDepth = options.maxQueueDepth ?? 10;
    this.ratePerSec = options.inputRatePerSec ?? RATE_DEFAULTS.inputRatePerSec;
    this.reserveTokens = options.reserveTokens ?? RATE_DEFAULTS.reserveTokens;
    this.criticalOverrunMs = options.criticalOverrunMs ?? RATE_DEFAULTS.criticalOverrunMs;
    this.sessionLookupTimeoutMs = options.sessionLookupTimeoutMs ?? 1000;
    this.currentLeaseIdFor = options.currentLeaseIdFor ?? (() => null);
    this.onSignal = options.onSignal ?? (() => {});
  }

  /**
   * Enqueues one raw inbound input message from `viewerId`. Returns
   * nothing; callers do NOT await this, or a slow page applies backpressure
   * to the WebSocket read loop and stalls every message type.
   *
   * `opts.awaitFull`, when `true`, is threaded down to `handleMouse`/
   * `handleKey`/`handleTouch`/`handleDrag`'s own `this.dispatch(..., awaitFull)` call
   * (`input.text`/`input.composition` already hardcode `true` there, for
   * the reason given at their own call sites). This is a TypeScript-level
   * argument, never a field read off `raw`: `raw` is attacker-controlled
   * wire JSON on the WS path (`ws/connection.ts`'s parsed message), and
   * every target's dispatch chain is shared across every viewer of that
   * target (this class's own header doc, "one promise chain per
   * `(sessionId, targetId)`"), so an `awaitFull` a client could set on its
   * own message would stall everyone else's input on that same target,
   * exactly the self-inflicted chain stall `performDispatch`'s doc comment
   * describes fixing. Only server code that never round-trips through
   * `JSON.parse` (`ManagedSession.clickTarget`'s REST driving path,
   * `packages/server/src/session/managed-session.ts`) may pass this.
   */
  enqueue(viewerId: string, raw: unknown, opts?: { readonly awaitFull?: boolean }): void {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const awaitFull = opts?.awaitFull ?? false;
    const t = (raw as Record<string, unknown>)['t'];
    if (t === 'input.mouse') {
      this.handleMouse(viewerId, raw, awaitFull);
    } else if (t === 'input.key') {
      this.handleKey(viewerId, raw, awaitFull);
    } else if (t === 'input.text') {
      this.handleText(viewerId, raw);
    } else if (t === 'input.touch') {
      this.handleTouch(viewerId, raw, awaitFull);
    } else if (t === 'input.composition') {
      this.handleComposition(viewerId, raw);
    } else if (t === 'input.drag') {
      this.handleDrag(viewerId, raw, awaitFull);
    }
  }

  /** The current tail promise for one target's dispatch chain. Matches `ControlLeaseEngineOptions.drainInput`'s shape. */
  tailFor(targetId: string): Promise<void> {
    return this.chainState(targetId).tail;
  }

  /**
   * Pointer and key hygiene: sends the ordered release
   * commands (touches, drag, buttons, keys) for whatever THIS VIEWER is
   * currently holding on `targetId`, then clears that viewer's held state.
   * Matches `ControlLeaseEngineOptions.releaseHeld`'s shape; queues behind
   * whatever is already in that target's dispatch chain, same as every
   * other event.
   *
   * Scoped to one viewer, which matters in both directions once a target
   * can have several drivers: a departing driver must not leave a button or
   * a modifier stuck down for the people still driving, and must not lift
   * the button somebody else is mid-drag with either.
   */
  releaseHeld(targetId: string, viewerId: string): Promise<void> {
    const perViewer = this.heldByTargetViewer.get(targetId);
    const held = perViewer?.get(viewerId);
    if (!perViewer || !held) {
      return Promise.resolve();
    }
    const commands = buildReleaseCommands(held);
    perViewer.delete(viewerId);
    if (perViewer.size === 0) this.heldByTargetViewer.delete(targetId);
    if (commands.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.enqueueOnChain(targetId, viewerId, async () => {
        const handle = await this.resolveSession(targetId);
        if (handle) {
          for (const cmd of commands) {
            try {
              await sendInputCommand(this.bridge, cmd.method, cmd.params, handle.id);
            } catch {
              // Best-effort cleanup: one failed release command must not block the rest.
            }
          }
        }
        resolve();
      });
    });
  }

  /** Drops every tracked chain, held-state, bucket, and starvation entry for `targetId`. Call when the target is gone for good. Every viewer's held state for that target goes with it, however many drivers it had. */
  disposeTarget(targetId: string): void {
    this.chains.delete(targetId);
    this.heldByTargetViewer.delete(targetId);
  }

  // ── per-message-type handlers ───────────────────────────────────────

  private handleMouse(viewerId: string, raw: unknown, awaitFull: boolean): void {
    const result = validateMouse(raw);
    if (!result.ok) {
      this.onSignal({
        kind: 'validation_error',
        viewerId,
        targetId: targetIdOf(raw),
        field: result.field,
        message: result.message,
      });
      return;
    }
    const msg = result.value;
    const targetId = msg.targetId;
    const fenceKind = fenceKindOf(msg);

    if (msg.kind === 'move' && this.chainState(targetId).depth > this.maxQueueDepth) {
      // Stale move: the cursor has already moved on and this frame would
      // have been overwritten before it painted. Still reported, because
      // "dropped silently" was the whole problem: a caller watching a drag
      // stutter needs to be able to tell backpressure from a fencing fault,
      // and those look identical from outside. Not an error, and the
      // transport is expected to log it at debug.
      this.onSignal({
        kind: 'queue_shed',
        viewerId,
        targetId,
        depth: this.chainState(targetId).depth,
        maxDepth: this.maxQueueDepth,
      });
      return;
    }

    const genDecision = resolveGenFencing(this.getGeneration(targetId), msg.gen, fenceKind);
    if (genDecision.action === 'drop') {
      return;
    }
    if (genDecision.action === 'drop_with_error') {
      this.onSignal({
        kind: 'gen_stale',
        viewerId,
        targetId,
        expectedGen: this.getGeneration(targetId),
        receivedGen: msg.gen,
      });
      return;
    }

    const fenceDecision = this.checkFencing(
      { viewerId, leaseId: msg.leaseId, kind: fenceKind },
      { lastHolderViewerId: this.lastHolderViewerIdOf(targetId) },
    );
    if (!fenceDecision.dispatch) {
      this.onSignal({
        kind: 'fence_denied',
        viewerId,
        targetId,
        reason: fenceDecision.reason ?? 'stale_lease',
        expectedLeaseId: this.currentLeaseIdFor(targetId, viewerId),
        receivedLeaseId: msg.leaseId,
      });
      return;
    }

    if (!this.admitOrSignal(viewerId, targetId, fenceKind)) {
      return;
    }

    const held = this.heldFor(targetId, viewerId);
    let point: { x: number; y: number };
    if (genDecision.action === 'dispatch_at_last_position') {
      point = held.lastPos;
    } else {
      const viewport = this.viewportFor(targetId, msg.fw, msg.fh);
      const transformed = transformPoint(
        msg.x,
        msg.y,
        msg.fw,
        msg.fh,
        viewport.width,
        viewport.height,
      );
      if (!transformed) {
        return; // NaN/Infinity already rejected by validation; defence in depth only.
      }
      point = transformed;
      held.lastPos = point;
    }

    if (msg.kind === 'down') {
      held.buttons |= buttonBit(msg.button);
    } else if (msg.kind === 'up') {
      held.buttons &= ~buttonBit(msg.button);
    }
    held.modifiers = msg.modifiers;

    // A move that happens while a button is held is a DRAG, and Chrome only
    // treats it as one when `button` names the held button. Sending
    // `'none'` (which is what `msg.button ?? 'none'` produced, because a
    // client has no reason to repeat `button` on every move of a drag)
    // makes `Input.dispatchMouseEvent` deliver a plain hover instead, so
    // click-drag selected no text, dragged no element, and resized no
    // splitter. Measured against the running demo: the identical gesture
    // changed 0 pixels with `'none'` and roughly 500,000 with `'left'`.
    //
    // `held.buttons` is this dispatcher's own tracked state, updated by the
    // `down`/`up` branches just above and cleared by `held-state.ts` when a
    // lease is lost, so it is authoritative in a way the client's own
    // `msg.buttons` is not: it survives a client that forgets to set it,
    // and it cannot be used to claim a button is held that this dispatcher
    // never saw pressed. Both fields are therefore derived from it for a
    // move, while `down`/`up` keep naming their own button, which is the
    // one thing they are authoritative about.
    const isDragMove = msg.kind === 'move' && held.buttons !== 0;
    const params: Record<string, unknown> = {
      type: mouseCdpType(msg.kind),
      x: point.x,
      y: point.y,
      button: isDragMove ? primaryHeldButtonName(held.buttons) : (msg.button ?? 'none'),
      buttons: isDragMove ? held.buttons : msg.buttons,
      modifiers: msg.modifiers,
      ...(msg.kind === 'down' || msg.kind === 'up'
        ? { clickCount: Math.max(1, msg.clickCount ?? 1) }
        : {}),
      ...(msg.kind === 'wheel' ? { deltaX: msg.dx ?? 0, deltaY: msg.dy ?? 0 } : {}),
    };

    this.dispatch(viewerId, targetId, 'Input.dispatchMouseEvent', params, awaitFull);
  }

  private handleKey(viewerId: string, raw: unknown, awaitFull: boolean): void {
    const result = validateKey(raw);
    if (!result.ok) {
      this.onSignal({
        kind: 'validation_error',
        viewerId,
        targetId: targetIdOf(raw),
        field: result.field,
        message: result.message,
      });
      return;
    }
    const msg = result.value;
    const targetId = msg.targetId;
    const fenceKind = fenceKindOf(msg);

    const fenceDecision = this.checkFencing(
      { viewerId, leaseId: msg.leaseId, kind: fenceKind },
      { lastHolderViewerId: this.lastHolderViewerIdOf(targetId) },
    );
    if (!fenceDecision.dispatch) {
      this.onSignal({
        kind: 'fence_denied',
        viewerId,
        targetId,
        reason: fenceDecision.reason ?? 'stale_lease',
        expectedLeaseId: this.currentLeaseIdFor(targetId, viewerId),
        receivedLeaseId: msg.leaseId,
      });
      return;
    }

    if (!this.admitOrSignal(viewerId, targetId, fenceKind)) {
      return;
    }

    const held = this.heldFor(targetId, viewerId);
    held.modifiers = msg.modifiers;
    if (msg.kind === 'down') {
      held.keysDown.add(msg.code);
    } else if (msg.kind === 'up') {
      held.keysDown.delete(msg.code);
    }

    const params = buildKeyEvent(msg);
    if (!params) {
      return; // char already carried by the preceding keyDown, or nothing to send.
    }
    this.dispatch(
      viewerId,
      targetId,
      'Input.dispatchKeyEvent',
      params as unknown as Record<string, unknown>,
      awaitFull,
    );
  }

  private handleText(viewerId: string, raw: unknown): void {
    const result = validateText(raw);
    if (!result.ok) {
      this.onSignal({
        kind: 'validation_error',
        viewerId,
        targetId: targetIdOf(raw),
        field: result.field,
        message: result.message,
      });
      return;
    }
    const msg = result.value;
    const targetId = msg.targetId;
    const fenceKind: InputFenceKind = 'other';

    const fenceDecision = this.checkFencing(
      { viewerId, leaseId: msg.leaseId, kind: fenceKind },
      { lastHolderViewerId: this.lastHolderViewerIdOf(targetId) },
    );
    if (!fenceDecision.dispatch) {
      this.onSignal({
        kind: 'fence_denied',
        viewerId,
        targetId,
        reason: fenceDecision.reason ?? 'stale_lease',
        expectedLeaseId: this.currentLeaseIdFor(targetId, viewerId),
        receivedLeaseId: msg.leaseId,
      });
      return;
    }

    if (!this.admitOrSignal(viewerId, targetId, fenceKind)) {
      return;
    }

    // Awaited fully (never raced): truncation here is a correctness bug, not a latency issue (the one exception to racing).
    this.dispatch(viewerId, targetId, 'Input.insertText', { text: msg.text }, true);
  }

  private handleTouch(viewerId: string, raw: unknown, awaitFull: boolean): void {
    const result = validateTouch(raw);
    if (!result.ok) {
      this.onSignal({
        kind: 'validation_error',
        viewerId,
        targetId: targetIdOf(raw),
        field: result.field,
        message: result.message,
      });
      return;
    }
    const msg = result.value;
    const targetId = msg.targetId;
    const fenceKind = fenceKindOf(msg);

    const genDecision = resolveGenFencing(this.getGeneration(targetId), msg.gen, fenceKind);
    if (genDecision.action === 'drop') {
      return;
    }
    if (genDecision.action === 'drop_with_error') {
      this.onSignal({
        kind: 'gen_stale',
        viewerId,
        targetId,
        expectedGen: this.getGeneration(targetId),
        receivedGen: msg.gen,
      });
      return;
    }

    const fenceDecision = this.checkFencing(
      { viewerId, leaseId: msg.leaseId, kind: fenceKind },
      { lastHolderViewerId: this.lastHolderViewerIdOf(targetId) },
    );
    if (!fenceDecision.dispatch) {
      this.onSignal({
        kind: 'fence_denied',
        viewerId,
        targetId,
        reason: fenceDecision.reason ?? 'stale_lease',
        expectedLeaseId: this.currentLeaseIdFor(targetId, viewerId),
        receivedLeaseId: msg.leaseId,
      });
      return;
    }

    if (!this.admitOrSignal(viewerId, targetId, fenceKind)) {
      return;
    }

    const held = this.heldFor(targetId, viewerId);
    held.modifiers = msg.modifiers;

    let touchPoints: Array<Record<string, unknown>>;
    if (genDecision.action === 'dispatch_at_last_position') {
      // An empty touchPoints array on touchEnd/touchCancel lifts every active contact at once; no per-point position is needed.
      touchPoints = [];
      held.touchIds.clear();
    } else {
      const viewport = this.viewportFor(targetId, msg.fw, msg.fh);
      touchPoints = [];
      for (const p of msg.points) {
        const transformed = transformPoint(
          p.x,
          p.y,
          msg.fw,
          msg.fh,
          viewport.width,
          viewport.height,
        );
        if (!transformed) {
          continue;
        }
        touchPoints.push({ x: transformed.x, y: transformed.y, id: p.id });
      }
      if (msg.kind === 'start' || msg.kind === 'move') {
        held.touchIds = new Set(msg.points.map((p) => p.id));
      } else {
        held.touchIds.clear();
      }
    }

    const params: Record<string, unknown> = {
      type: touchCdpType(msg.kind),
      touchPoints,
      modifiers: msg.modifiers,
    };
    this.dispatch(viewerId, targetId, 'Input.dispatchTouchEvent', params, awaitFull);
  }

  private handleComposition(viewerId: string, raw: unknown): void {
    const result = validateComposition(raw);
    if (!result.ok) {
      this.onSignal({
        kind: 'validation_error',
        viewerId,
        targetId: targetIdOf(raw),
        field: result.field,
        message: result.message,
      });
      return;
    }
    const msg = result.value;
    const targetId = msg.targetId;
    const fenceKind: InputFenceKind = 'other';

    const fenceDecision = this.checkFencing(
      { viewerId, leaseId: msg.leaseId, kind: fenceKind },
      { lastHolderViewerId: this.lastHolderViewerIdOf(targetId) },
    );
    if (!fenceDecision.dispatch) {
      this.onSignal({
        kind: 'fence_denied',
        viewerId,
        targetId,
        reason: fenceDecision.reason ?? 'stale_lease',
        expectedLeaseId: this.currentLeaseIdFor(targetId, viewerId),
        receivedLeaseId: msg.leaseId,
      });
      return;
    }

    if (!this.admitOrSignal(viewerId, targetId, fenceKind)) {
      return;
    }

    if (msg.kind === 'end') {
      this.dispatch(viewerId, targetId, 'Input.insertText', { text: msg.text }, true);
      return;
    }
    const params: Record<string, unknown> = { text: msg.text };
    if (msg.selectionStart !== undefined) {
      params['selectionStart'] = msg.selectionStart;
    }
    if (msg.selectionEnd !== undefined) {
      params['selectionEnd'] = msg.selectionEnd;
    }
    this.dispatch(viewerId, targetId, 'Input.imeSetComposition', params, true);
  }

  /**
   * Native drag via `Input.dispatchDragEvent`: the piece browser-use's own
   * drag lacks entirely (its `element.py` drag is press, one intermediate
   * `mouse.move`, release; no drag event ever fires). This is a SECOND,
   * SIBLING path to the "HTML5 fallback" already available for free through
   * `handleMouse`: a plain `down`/several `move`s/`up` sequence, which
   * `isDragMove` above already dispatches with the correct held `button`
   * for pages that implement drag purely on mouse events and never fire a
   * native drag at all. A client picks whichever path matches what the
   * page actually does; this dispatcher does not choose for it.
   *
   * Held state and fencing follow the same rules as every other input kind:
   * `enter`/`over` are fenced and rate-limited normally (`drag.enter`
   * `critical`, `drag.over` `droppable`, same class as a mouse move,
   * `rate-limit.ts`); `drop`/`leave` are the release class
   * (`ALWAYS_DISPATCHED_KINDS`, `fencing.ts`), dispatched even under a
   * stale lease so a departing driver cannot leave a drag stuck open, and
   * `held.dragActive` (`held-state.ts`) makes an in-progress drag survive a
   * lease loss or disconnect the same way a held button does: swept by the
   * ordered `dragCancel` `buildReleaseCommands` already emits.
   */
  private handleDrag(viewerId: string, raw: unknown, awaitFull: boolean): void {
    const result = validateDrag(raw);
    if (!result.ok) {
      this.onSignal({
        kind: 'validation_error',
        viewerId,
        targetId: targetIdOf(raw),
        field: result.field,
        message: result.message,
      });
      return;
    }
    const msg = result.value;
    const targetId = msg.targetId;
    const fenceKind = fenceKindOf(msg);

    if (msg.kind === 'over' && this.chainState(targetId).depth > this.maxQueueDepth) {
      // Same reasoning as a shed mouse move (see handleMouse above): a
      // dragOver is a continuous positional stream, and a shed frame would
      // have been superseded before it painted. A drag produces a lot of
      // these, which is exactly why this check, and `drag.over`'s
      // `droppable` admission class below, both matter for it.
      this.onSignal({
        kind: 'queue_shed',
        viewerId,
        targetId,
        depth: this.chainState(targetId).depth,
        maxDepth: this.maxQueueDepth,
      });
      return;
    }

    const genDecision = resolveGenFencing(this.getGeneration(targetId), msg.gen, fenceKind);
    if (genDecision.action === 'drop') {
      return;
    }
    if (genDecision.action === 'drop_with_error') {
      this.onSignal({
        kind: 'gen_stale',
        viewerId,
        targetId,
        expectedGen: this.getGeneration(targetId),
        receivedGen: msg.gen,
      });
      return;
    }

    const fenceDecision = this.checkFencing(
      { viewerId, leaseId: msg.leaseId, kind: fenceKind },
      { lastHolderViewerId: this.lastHolderViewerIdOf(targetId) },
    );
    if (!fenceDecision.dispatch) {
      this.onSignal({
        kind: 'fence_denied',
        viewerId,
        targetId,
        reason: fenceDecision.reason ?? 'stale_lease',
        expectedLeaseId: this.currentLeaseIdFor(targetId, viewerId),
        receivedLeaseId: msg.leaseId,
      });
      return;
    }

    if (!this.admitOrSignal(viewerId, targetId, fenceKind)) {
      return;
    }

    const held = this.heldFor(targetId, viewerId);
    held.modifiers = msg.modifiers;

    let point: { x: number; y: number };
    if (genDecision.action === 'dispatch_at_last_position') {
      point = held.lastPos;
    } else {
      const viewport = this.viewportFor(targetId, msg.fw, msg.fh);
      const transformed = transformPoint(
        msg.x,
        msg.y,
        msg.fw,
        msg.fh,
        viewport.width,
        viewport.height,
      );
      if (!transformed) {
        return; // NaN/Infinity already rejected by validation; defence in depth only.
      }
      point = transformed;
      held.lastPos = point;
    }

    // `enter` opens the held-drag window and `over` keeps it open (in case
    // an `enter` was itself dropped as stale, `over` still marks the drag
    // live rather than leaving it permanently unswept); `drop`/`leave`
    // close it. This is what makes `buildReleaseCommands`' `dragCancel`
    // fire on a lease loss or disconnect exactly when a drag is actually in
    // progress, and never otherwise.
    if (msg.kind === 'enter' || msg.kind === 'over') {
      held.dragActive = true;
    } else {
      held.dragActive = false;
    }

    const params: Record<string, unknown> = {
      type: dragCdpType(msg.kind),
      x: point.x,
      y: point.y,
      modifiers: msg.modifiers,
      ...(msg.data ? { data: msg.data } : {}),
    };

    this.dispatch(viewerId, targetId, 'Input.dispatchDragEvent', params, awaitFull);
  }

  // ── rate limiting ────────────────────────────────────────────────────

  /** Admits one event of `fenceKind`'s admission class, signalling `rate_limited`/`rate_limit_escalate` and returning `false` on denial. Always admits the exempt (release) class. */
  private admitOrSignal(viewerId: string, targetId: string, fenceKind: InputFenceKind): boolean {
    const cls: AdmissionClass = classifyAdmission(fenceKind);
    if (cls === 'exempt') {
      return true;
    }
    const nowMono = monotonicNow();
    const bucket = this.bucketFor(viewerId, targetId, nowMono);
    const admitted = admit(bucket, cls, this.ratePerSec, this.reserveTokens, nowMono);
    const streak = this.starvationFor(viewerId, targetId);
    const outcome =
      cls === 'critical' ? streak.note(admitted, nowMono, this.criticalOverrunMs) : 'ok';
    if (!admitted) {
      this.onSignal({
        kind: 'rate_limited',
        viewerId,
        targetId,
        retryAfterMs: Math.ceil(1000 / this.ratePerSec),
      });
      if (outcome === 'escalate') {
        this.onSignal({ kind: 'rate_limit_escalate', viewerId, targetId });
      }
      return false;
    }
    return true;
  }

  // ── the promise chain ────────────────────────────────────────────────

  private chainState(targetId: string): ChainState {
    let c = this.chains.get(targetId);
    if (!c) {
      c = { tail: Promise.resolve(), depth: 0 };
      this.chains.set(targetId, c);
    }
    return c;
  }

  private enqueueOnChain(targetId: string, viewerId: string, fn: () => Promise<void>): void {
    const chain = this.chainState(targetId);
    chain.depth += 1;
    chain.tail = chain.tail.then(async () => {
      chain.depth = Math.max(0, chain.depth - 1);
      try {
        await fn();
      } catch (err) {
        // MUST catch inside the chained function: an uncaught rejection
        // poisons `chain.tail` forever, and every subsequent `.then` short
        // circuits, silently stopping all input for this target.
        this.onSignal({ kind: 'dispatch_error', viewerId, targetId, error: err });
      }
    });
  }

  private dispatch(
    viewerId: string,
    targetId: string,
    method: AllowedInputMethod,
    params: Record<string, unknown>,
    awaitFull: boolean,
  ): void {
    this.enqueueOnChain(targetId, viewerId, () =>
      this.performDispatch(viewerId, targetId, method, params, awaitFull, 0),
    );
  }

  /**
   * Resolves the live session, then sends. `input.text`/`input.composition`
   * are always awaited to completion (`handleText`/`handleComposition` hardcode
   * `awaitFull: true`, truncation there being a correctness bug, not a latency
   * one). `input.mouse`/`input.key`/`input.touch` default to firing the send
   * and returning immediately on the WS streaming path (`awaitFull: false`,
   * the normal case, chosen by every real `handleMouse`/`handleKey`/`handleTouch`
   * caller reachable from a wire message): CDP guarantees wire ordering (the
   * write already happened inside `sendInputCommand`, synchronously, before
   * this method returns, since `CdpBridgeImpl.send()`'s `this.ws?.send(payload)`
   * runs inside its `Promise` executor, before `send()` itself returns), so
   * this dispatcher does not need the RESPONSE to know the next queued event
   * may already be written.
   *
   * That "the write is synchronous" fact answers a narrower question than it
   * sounds like it does, and conflating the two is exactly what caused a
   * regression here once already: the write reaching THIS PROCESS's outbound
   * socket buffer synchronously says nothing about when the peer (real Chrome,
   * or a test double sitting behind an actual `ws` connection) has received
   * and acted on it, which is inherently a future event-loop turn away, no
   * matter how fast. A caller that genuinely needs "already landed" (not just
   * "already written"), like `ManagedSession.clickTarget`/`typeTarget`'s REST
   * one-shot driving path in `packages/server/src/session/managed-session.ts`,
   * passes `awaitFull: true` through `enqueue()`'s `opts` (never through a
   * field on the message itself, see `enqueue()`'s own doc for why), which
   * makes THIS call await `sendPromise` below and, by construction, makes
   * `enqueueOnChain`'s `chain.tail` (what `tailFor()`/`drainInput` wait on)
   * not resolve until the response has actually come back.
   *
   * That last part used to be aspirational rather than true: this method
   * used to `await Promise.race([sendPromise, raceTimeout(cdpDispatchRaceMs)])`
   * before returning, which sounds like a bounded wait but is really a
   * bounded STALL of the whole per-target chain, because `enqueueOnChain`
   * does not start the NEXT queued event's `performDispatch` until this
   * one's promise settles. Whenever the real CDP round trip for one event
   * exceeds `cdpDispatchRaceMs` (100ms default), which a gateway serving
   * several concurrent browsers routinely does, confirmed directly against
   * `input-concurrency-probe.mjs`, every single raced event on that
   * target's chain now costs at least the full `cdpDispatchRaceMs`, not
   * because Chrome needed that long, but because this method waited that
   * long before letting the chain move on. A `click()` (2 events) or a
   * `scroll()` (1 event) absorbs that fine; a `type()` of a real word (2
   * CDP calls per character) does not, and the last few characters missed
   * every reasonable read-back window even though nothing was ever
   * actually dropped, only delayed by a wait this dispatcher itself was
   * imposing on itself. Not awaiting the race here removes that
   * self-inflicted throttle; the retry-once-on-a-fast-session-closed-error
   * optimisation and the dispatch_error report for a raced send that later
   * fails both still happen, just off the chain's own critical path (see
   * {@link watchRacedDispatch}).
   *
   * Every way this can end without the command reaching CDP reports
   * through `onSignal` as `dispatch_error`, which used to not be true in
   * two places: a `resolveSession()` timeout returned silently (not even
   * logged), and a raced dispatch (the `awaitFull: false` branch) that
   * lost its race against `cdpDispatchRaceMs` and then FAILED asynchronously
   * afterward had nothing left checking `fastError`, since that check only
   * ran once, synchronously, right after the race settled. Both are the
   * exact "returns success, drops the input" shape a caller cannot tell
   * apart from a page that is simply slow; a saturated gateway serving
   * several concurrent connections at once is precisely what makes both
   * paths reachable (measured directly against the running demo, see
   * `input-concurrency-probe.mjs`).
   */
  private async performDispatch(
    viewerId: string,
    targetId: string,
    method: AllowedInputMethod,
    params: Record<string, unknown>,
    awaitFull: boolean,
    attempt: number,
  ): Promise<void> {
    const handle = await this.resolveSession(targetId);
    if (!handle) {
      // Session lookup timed out; a stale event, dropped rather than
      // queued further behind. Still reported: the class's own contract
      // is that no drop is silent, and this one used to be the one
      // exception to it.
      this.onSignal({
        kind: 'dispatch_error',
        viewerId,
        targetId,
        error: new Error(
          `session lookup for ${targetId} exceeded ${this.sessionLookupTimeoutMs}ms`,
        ),
      });
      return;
    }

    const sendPromise = sendInputCommand(this.bridge, method, params, handle.id);

    if (awaitFull) {
      try {
        await sendPromise;
      } catch (err) {
        if (attempt === 0 && isSessionClosedError(err)) {
          return this.performDispatch(viewerId, targetId, method, params, awaitFull, attempt + 1);
        }
        throw err;
      }
      return;
    }

    // Deliberately not awaited: see this method's own doc comment for why
    // the chain must not stall on this. `watchRacedDispatch` runs the same
    // fast-retry/late-error bookkeeping the chain used to wait for, just
    // detached from this call's own return.
    this.watchRacedDispatch(viewerId, targetId, method, params, sendPromise, attempt);
  }

  /**
   * The fast-failure watch a raced {@link performDispatch} call used to run
   * inline (blocking the per-target chain for up to `cdpDispatchRaceMs`).
   * Same two outcomes, now off the chain's critical path: a session-closed
   * error that arrives within `cdpDispatchRaceMs` gets one retry, enqueued
   * as a fresh chain step (attempt 1) rather than resuming the original
   * step in place, since the original step has already let the chain move
   * on by the time this observes the failure; any other failure, fast or
   * late, is reported once through `onSignal` as `dispatch_error`.
   */
  private watchRacedDispatch(
    viewerId: string,
    targetId: string,
    method: AllowedInputMethod,
    params: Record<string, unknown>,
    sendPromise: Promise<unknown>,
    attempt: number,
  ): void {
    let settled = false;
    let fastError: unknown;
    sendPromise.then(
      () => {
        settled = true;
      },
      (e: unknown) => {
        settled = true;
        fastError = e;
      },
    );
    void Promise.race([sendPromise.catch(() => {}), raceTimeout(this.raceMs)]).then(() => {
      if (settled && attempt === 0 && isSessionClosedError(fastError)) {
        this.enqueueOnChain(targetId, viewerId, () =>
          this.performDispatch(viewerId, targetId, method, params, false, attempt + 1),
        );
        return;
      }
      if (!settled) {
        // Lost the race: the chain has already moved on to the next queued
        // event. If this send goes on to fail anyway, nothing else will
        // ever look at it again, so attach the one report it will ever get
        // here rather than letting a late rejection vanish into an
        // already-decided `Promise.race`.
        sendPromise.catch((err: unknown) => {
          this.onSignal({ kind: 'dispatch_error', viewerId, targetId, error: err });
        });
      }
    });
  }

  private async resolveSession(targetId: string): Promise<{ id: CdpSessionId } | null> {
    const attachPromise = this.targets.attach(targetId);
    attachPromise.catch(() => {}); // prevents an unhandled rejection if the timeout wins the race below.
    try {
      return await Promise.race([
        attachPromise,
        new Promise<null>((resolve) =>
          scheduleTimer(() => resolve(null), this.sessionLookupTimeoutMs),
        ),
      ]);
    } catch {
      return null;
    }
  }

  // ── held state / viewport lookup ─────────────────────────────────────

  /**
   * This viewer's own held state for this target, created on first use.
   *
   * Per `(targetId, viewerId)`, not per target: see
   * {@link InputDispatcher.heldByTargetViewer}. Every caller passes the
   * viewerId of the message being dispatched, which for a release
   * dispatched under the fencing asymmetry is the sender, not whoever
   * currently holds a lease. That is the point: the sender is the one whose
   * button is coming up.
   */
  private heldFor(targetId: string, viewerId: string): HeldState {
    let perViewer = this.heldByTargetViewer.get(targetId);
    if (!perViewer) {
      perViewer = new Map<string, HeldState>();
      this.heldByTargetViewer.set(targetId, perViewer);
    }
    let h = perViewer.get(viewerId);
    if (!h) {
      h = createHeldState();
      perViewer.set(viewerId, h);
    }
    return h;
  }

  private viewportFor(
    targetId: string,
    fallbackWidth: number,
    fallbackHeight: number,
  ): { width: number; height: number } {
    const target = this.targets.get(targetId);
    return target?.viewport ?? { width: fallbackWidth, height: fallbackHeight };
  }

  private bucketFor(viewerId: string, targetId: string, nowMono: number): TokenBucket {
    const key = `${viewerId}\0${targetId}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = createTokenBucket(this.ratePerSec, nowMono);
      this.buckets.set(key, b);
    }
    return b;
  }

  private starvationFor(viewerId: string, targetId: string): CriticalStarvationTrackerType {
    const key = `${viewerId}\0${targetId}`;
    let s = this.starvation.get(key);
    if (!s) {
      s = new CriticalStarvationTracker();
      this.starvation.set(key, s);
    }
    return s;
  }
}
