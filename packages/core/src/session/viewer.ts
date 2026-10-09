/**
 * `Viewer`: one connected socket's view of a `Session`, entirely in
 * memory. Owns its own u16 `nextStreamId` allocator (it lives on `Viewer`,
 * not `Session`, because a stream handle is unique within one viewer's
 * socket, never a session). Drives `@browserglass/protocol`'s
 * `VIEWER_TRANSITIONS` table through the shared `transition()` runtime
 * helper, so the illegal-transition contract (terminal-from-terminal
 * ignored, live-state illegal throws, guard failure ignored) is exactly
 * the protocol package's, not reimplemented here.
 */

import {
  type Capability,
  type InvalidStateTransition,
  type TransitionOutcome,
  VIEWER_TRANSITIONS,
  type ViewerEvent,
  type ViewerState,
  transition,
} from '@browserglass/protocol';

/** The u16 wire stream-id space. `0` is reserved for session-scoped binary messages; the allocator starts at 1. */
export const MAX_STREAM_ID = 0xffff;

/** Constructor options for {@link Viewer}. */
export interface ViewerOptions {
  readonly id: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly subject: string;
  readonly displayName?: string | null;
  readonly capabilities: readonly Capability[];
  readonly kind: 'human' | 'agent';
  readonly isAdmin: boolean;
  readonly connectedAtMs: number;
}

/** Thrown by {@link Viewer.allocateStreamId} once the u16 space is exhausted (the documented outcome: the session ends). */
export class StreamIdSpaceExhaustedError extends Error {
  constructor(readonly viewerId: string) {
    super(
      `viewer ${viewerId} has exhausted its u16 streamId space (65535 handles issued); the session must end`,
    );
    this.name = 'StreamIdSpaceExhaustedError';
  }
}

/**
 * One connected viewer socket. Everything here is in-memory only: no
 * `Viewer` field survives a process restart (the resume token, not the
 * store, is what lets a client recover its subscription set).
 */
export class Viewer {
  readonly id: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly kind: 'human' | 'agent';
  readonly isAdmin: boolean;

  private _capabilities: readonly Capability[];
  private _state: ViewerState = 'connecting';

  /** u16 allocator for this viewer's binary header stream handles, monotonic, never reused. */
  private _nextStreamId = 1;

  /** Every `streamId` currently subscribed on this viewer's socket. */
  readonly subscriptions = new Set<number>();
  /** Every `targetId` this viewer currently holds the `ControlLease` for. */
  readonly heldLeases = new Set<string>();

  readonly connectedAtMs: number;
  disconnectedAtMs: number | null = null;
  lastMessageAtMs: number;

  constructor(opts: ViewerOptions) {
    this.id = opts.id;
    this.sessionId = opts.sessionId;
    this.tenantId = opts.tenantId;
    this.appId = opts.appId;
    this.subject = opts.subject;
    this.displayName = opts.displayName ?? null;
    this._capabilities = opts.capabilities;
    this.kind = opts.kind;
    this.isAdmin = opts.isAdmin;
    this.connectedAtMs = opts.connectedAtMs;
    this.lastMessageAtMs = opts.connectedAtMs;
  }

  get state(): ViewerState {
    return this._state;
  }

  get capabilities(): readonly Capability[] {
    return this._capabilities;
  }

  /** Narrows granted capabilities mid-session (a token refresh or admin action); never widens. */
  setCapabilities(caps: readonly Capability[]): void {
    this._capabilities = caps;
  }

  /**
   * Allocates the next u16 `streamId` for this viewer's socket. Throws
   * {@link StreamIdSpaceExhaustedError} at exhaustion (handles are never
   * reused within a session, so exhaustion ends the session, not a
   * silent wraparound).
   */
  allocateStreamId(): number {
    if (this._nextStreamId > MAX_STREAM_ID) {
      throw new StreamIdSpaceExhaustedError(this.id);
    }
    const id = this._nextStreamId;
    this._nextStreamId += 1;
    return id;
  }

  /** Applies one `ViewerEvent` through the shared `transition()` helper against `VIEWER_TRANSITIONS`. Mutates `state` on `'ok'`; throws {@link InvalidStateTransition} for an illegal transition from a live state. */
  applyEvent(event: ViewerEvent, ctx: unknown = {}): TransitionOutcome<ViewerState> {
    const outcome = transition(VIEWER_TRANSITIONS, 'Viewer', this.id, this._state, event, ctx);
    if (outcome.kind === 'ok') {
      this._state = outcome.to;
    }
    return outcome;
  }
}

/** Constructs a fresh, `connecting` {@link Viewer}. */
export function createViewer(opts: ViewerOptions): Viewer {
  return new Viewer(opts);
}
