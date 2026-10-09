import type { ConnectionState } from './types.js';

/**
 * Thrown by {@link ConnectionStateMachine.transition} when asked to move
 * to a state the transition table does not allow from the current state. A caller
 * hitting this is a transport bug, not a protocol event: every legal
 * server behaviour maps to an allowed transition.
 */
export class InvalidConnectionTransition extends Error {
  constructor(
    readonly from: ConnectionState,
    readonly to: ConnectionState,
    readonly reason: string,
  ) {
    super(`illegal connection transition: ${from} --(${reason})--> ${to}`);
    this.name = 'InvalidConnectionTransition';
  }
}

/**
 * The full connection transition table, including two rows a simpler
 * table would omit: `handshaking` to `fatal` on the full permanent close
 * set, not only the five handshake specific codes, and `degraded` to
 * `fatal` for a permanent close arriving while degraded. `idle` and
 * `terminal` (`destroy()`) are reachable from every state; `terminal` is not a {@link ConnectionState}
 * value at all (the component is simply gone), so it is not represented
 * here: `Transport.destroy()` bypasses this table entirely.
 *
 * Two more rows fill structural gaps the basic table leaves implicit:
 *
 * - `handshaking` to `reconnecting`: the table's own `connecting` to
 *   `reconnecting` row lists `handshakeTimeoutMs elapsed` as a trigger,
 *   but that timer can only fire after `hello` has been sent, which is
 *   the same instant `connecting` to `handshaking` already happened. A
 *   transient close arriving after the socket opens but before `welcome`
 *   needs the same landing state.
 * - `resuming` to `reconnecting` and `resuming` to `fatal`: `resuming` is
 *   a live, open socket waiting on its first post-resume frame; a close
 *   arriving during that window is handled exactly like a close during
 *   `live`.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ConnectionState, ReadonlySet<ConnectionState>>> =
  Object.freeze({
    idle: new Set<ConnectionState>(['connecting']),
    connecting: new Set<ConnectionState>(['handshaking', 'reconnecting', 'fatal', 'idle']),
    handshaking: new Set<ConnectionState>(['live', 'resuming', 'fatal', 'reconnecting', 'idle']),
    resuming: new Set<ConnectionState>(['live', 'reconnecting', 'fatal', 'idle']),
    live: new Set<ConnectionState>(['degraded', 'reconnecting', 'fatal', 'idle']),
    degraded: new Set<ConnectionState>(['live', 'reconnecting', 'fatal', 'idle']),
    reconnecting: new Set<ConnectionState>(['connecting', 'fatal', 'idle']),
    fatal: new Set<ConnectionState>(['idle']),
  });

/**
 * Drives the eight-state connection machine. Owns nothing about sockets,
 * timers, or the wire protocol: `Transport` decides *when* a transition
 * is warranted, this class only validates that the transition is legal
 * per {@link ALLOWED_TRANSITIONS} and notifies subscribers. A same-state
 * request (for example calling `disconnect()` while already `idle`) is a
 * silent no-op, never an error and never an emitted event.
 */
export class ConnectionStateMachine {
  private current: ConnectionState;
  private readonly onTransition: (
    from: ConnectionState,
    to: ConnectionState,
    reason: string,
  ) => void;

  constructor(
    initial: ConnectionState,
    onTransition: (from: ConnectionState, to: ConnectionState, reason: string) => void,
  ) {
    this.current = initial;
    this.onTransition = onTransition;
  }

  /** The current {@link ConnectionState}. */
  get state(): ConnectionState {
    return this.current;
  }

  /**
   * Moves to `to`, given `reason` (a short, human-readable trigger name
   * used in the emitted `state` event and in log lines). Throws
   * {@link InvalidConnectionTransition} if `to` is not reachable from the
   * current state. Requesting the current state again is a no-op.
   */
  transition(to: ConnectionState, reason: string): void {
    if (to === this.current) return;
    const allowed = ALLOWED_TRANSITIONS[this.current];
    if (!allowed.has(to)) {
      throw new InvalidConnectionTransition(this.current, to, reason);
    }
    const from = this.current;
    this.current = to;
    this.onTransition(from, to, reason);
  }
}
