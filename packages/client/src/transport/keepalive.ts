import { type CancellableTimer, now, scheduleTimer } from './env.js';

/** Which of the two independent liveness signals crossed its silence threshold, and did so last. */
export type DegradeReason = 'no-frames' | 'no-pong';

/** {@link KeepaliveManager} constructor options. */
export interface KeepaliveOptions {
  /** Application `ping` interval. Default 5000ms. */
  pingIntervalMs: number;
  /** Silence threshold for both the pong and frame watchdogs. Default 5000ms. */
  healthTimeoutMs: number;
  /** Sends one application `ping{cts}` envelope. */
  sendPing: (cts: number) => void;
  /** `live` to `degraded`: both the pong and frame channels have been silent for `healthTimeoutMs`. */
  onDegrade: (reason: DegradeReason) => void;
  /** `degraded` to `live`: a pong, a frame, or a control message arrived. */
  onRecover: (signal: 'pong' | 'frame' | 'control') => void;
  /** One `pong` was matched against the `ping` it answers. */
  onPong?: (rttMs: number) => void;
}

/**
 * Runs the application-level keepalive (the `live` to `degraded` and
 * `degraded` to `live` transitions):
 * a `ping` every `pingIntervalMs`, and two independent silence watchdogs
 * (one for `pong`, one for a binary frame) whose *conjunction* is the
 * degrade trigger. The degraded state's `reason` is whichever of the two
 * watchdogs fires last, since a degrade can only happen once both are
 * already silent, and that is unambiguous: the one that fires last is the
 * one that "crossed".
 *
 * Recovering from `degraded` is looser than degrading into it: any one
 * of a pong, a frame, or a control message is enough, even though control messages alone do
 * not reset the two watchdogs.
 */
export class KeepaliveManager {
  private readonly opts: KeepaliveOptions;
  private pingTimer: CancellableTimer | null = null;
  private pongWatchdog: CancellableTimer | null = null;
  private frameWatchdog: CancellableTimer | null = null;
  private pongStale = false;
  private frameStale = false;
  private degraded = false;
  private lastPingCts: number | null = null;

  constructor(opts: KeepaliveOptions) {
    this.opts = opts;
  }

  /** Starts pinging and arms both watchdogs. Call once when the socket reaches `live` (or `resuming`). */
  start(): void {
    this.pongStale = false;
    this.frameStale = false;
    this.degraded = false;
    this.sendPingNow();
    this.armPingTimer();
    this.armPongWatchdog();
    this.armFrameWatchdog();
  }

  /** Cancels every timer. Call when leaving `live`/`degraded`/`resuming` for any reason. */
  stop(): void {
    this.pingTimer?.cancel();
    this.pongWatchdog?.cancel();
    this.frameWatchdog?.cancel();
    this.pingTimer = null;
    this.pongWatchdog = null;
    this.frameWatchdog = null;
  }

  /** Call when a `pong` arrives. Resolves RTT against the most recent `ping.cts` sent, if it matches. */
  onPongReceived(cts: number): void {
    if (this.lastPingCts !== null && cts === this.lastPingCts) {
      this.opts.onPong?.(now() - this.lastPingCts);
    }
    this.pongStale = false;
    this.armPongWatchdog();
    this.maybeRecover('pong');
  }

  /** Call when any binary frame arrives, decoded or not: its mere arrival is the liveness signal. */
  onFrameReceived(): void {
    this.frameStale = false;
    this.armFrameWatchdog();
    this.maybeRecover('frame');
  }

  /** Call on any control-channel (JSON) message: does not reset either watchdog, but does recover from `degraded`. */
  onControlMessageReceived(): void {
    this.maybeRecover('control');
  }

  private maybeRecover(signal: 'pong' | 'frame' | 'control'): void {
    if (this.degraded) {
      this.degraded = false;
      this.opts.onRecover(signal);
    }
  }

  private sendPingNow(): void {
    this.lastPingCts = now();
    this.opts.sendPing(this.lastPingCts);
  }

  private armPingTimer(): void {
    this.pingTimer?.cancel();
    this.pingTimer = scheduleTimer(() => {
      this.sendPingNow();
      this.armPingTimer();
    }, this.opts.pingIntervalMs);
  }

  private armPongWatchdog(): void {
    this.pongWatchdog?.cancel();
    this.pongWatchdog = scheduleTimer(() => {
      this.pongStale = true;
      this.maybeDegrade('no-pong');
    }, this.opts.healthTimeoutMs);
  }

  private armFrameWatchdog(): void {
    this.frameWatchdog?.cancel();
    this.frameWatchdog = scheduleTimer(() => {
      this.frameStale = true;
      this.maybeDegrade('no-frames');
    }, this.opts.healthTimeoutMs);
  }

  private maybeDegrade(justCrossed: DegradeReason): void {
    if (this.pongStale && this.frameStale && !this.degraded) {
      this.degraded = true;
      this.opts.onDegrade(justCrossed);
    }
  }
}
