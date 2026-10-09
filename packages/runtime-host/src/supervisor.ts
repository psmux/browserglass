/**
 * `BrowserSupervisor`: one per
 * launched browser, does not restart browsers (that is a router decision,
 * a self-restarting supervisor fights the router during drain), holds a
 * bounded stderr ring buffer, and detects exit via a stats-tick liveness
 * poll rather than solely trusting the child process's own `exit` event.
 *
 * The poll-based detection is load bearing on Windows, not just a fallback
 * for the adopted case: empirically (see `spawn.ts`'s `resolveBrowserPid`
 * doc comment),
 * the `ChildProcess` handle `spawnDetachedChrome` returns tracks Chrome's
 * transient Windows bootstrap process, which exits within a second of a
 * successful launch regardless of whether the real, long-lived browser
 * process is still running. Trusting that handle's own `exit` event as
 * "the browser died" would be a false crash report on every single
 * successful Windows launch. The stats-tick `pidAlive(realPid)` check
 * against the resolved browser-main pid is the one signal this module
 * treats as authoritative on every platform; the `ChildProcess` exit event
 * is kept only as a fast, non-authoritative hint on platforms where it
 * happens to line up with reality.
 */

import type { ChildProcess } from 'node:child_process';
import type { ExitInfo } from '@browserglass/protocol';
import { pidAlive } from './process-table.js';

/** A bounded ring buffer for a browser's stderr, feeding `ExitInfo.lastStderr`. Default 16 KiB, the top of an 8 to 16 KiB range that keeps the last useful lines without holding much memory. */
export class StderrRingBuffer {
  private buffer = '';
  constructor(private readonly maxBytes = 16 * 1024) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxBytes);
    }
  }

  get contents(): string {
    return this.buffer;
  }

  /** Best-effort GPU init failure sniff, feeding the node's remembered `disableGpu` flag for future launches. */
  looksLikeGpuInitFailure(): boolean {
    return /GPU process (isn't usable|exited unexpectedly)|Passthrough is not supported, GL is disabled|Exiting GPU process/i.test(
      this.buffer,
    );
  }
}

/** `BrowserSupervisor` construction options. */
export interface BrowserSupervisorOptions {
  instanceId: string;
  /** The resolved, long-lived browser-main pid, never the transient spawn pid on Windows. */
  pid: number;
  /** Present only for a freshly spawned (not adopted) browser; used only for best-effort stderr capture. */
  child?: ChildProcess | null;
  /** Whatever stderr the launch already read off `child` before this supervisor existed, so the ring buffer and the GPU sniff still see Chrome's earliest lines. */
  launchStderr?: string;
  statsIntervalMs: number;
  unhealthyProbes: number;
  onExit: (info: ExitInfo) => void;
  onGpuInitFailure?: () => void;
}

/**
 * One per launched browser. Watches `pid` on a fixed tick, feeds a bounded
 * stderr ring buffer when a `ChildProcess` is available, and fires
 * `onExit` exactly once when the process is confirmed gone. Never
 * restarts anything; `stop()` only stops watching, it does not touch the
 * browser process.
 */
export class BrowserSupervisor {
  readonly instanceId: string;
  readonly pid: number;
  private readonly stderrRing = new StderrRingBuffer();
  private readonly opts: BrowserSupervisorOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private exitFired = false;
  private consecutiveUnhealthy = 0;
  private lastKnownHealthy = true;

  constructor(opts: BrowserSupervisorOptions) {
    this.opts = opts;
    this.instanceId = opts.instanceId;
    this.pid = opts.pid;

    if (opts.launchStderr) this.pushStderr(opts.launchStderr);
    if (opts.child?.stderr) {
      opts.child.stderr.on('data', (chunk: Buffer) => this.pushStderr(chunk.toString('utf8')));
    }
  }

  private pushStderr(text: string): void {
    this.stderrRing.push(text);
    if (this.opts.onGpuInitFailure && this.stderrRing.looksLikeGpuInitFailure()) {
      this.opts.onGpuInitFailure();
    }
  }

  /** Starts the stats-tick liveness watch. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.opts.statsIntervalMs);
    this.timer.unref?.();
  }

  /** Stops watching. Does not touch the browser process; that is the terminate ladder's job. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The current bounded stderr contents, for `ExitInfo.lastStderr`. */
  get lastStderr(): string {
    return this.stderrRing.contents;
  }

  /** `true` once `unhealthyProbes` consecutive liveness checks have failed without yet confirming exit. */
  get degraded(): boolean {
    return (
      this.consecutiveUnhealthy >= this.opts.unhealthyProbes &&
      this.lastKnownHealthy === false &&
      !this.exitFired
    );
  }

  private tick(): void {
    if (this.stopped || this.exitFired) return;
    const alive = pidAlive(this.pid);
    if (alive) {
      this.consecutiveUnhealthy = 0;
      this.lastKnownHealthy = true;
      return;
    }
    this.consecutiveUnhealthy += 1;
    this.lastKnownHealthy = false;
    if (this.consecutiveUnhealthy >= this.opts.unhealthyProbes) {
      this.fireExit();
    }
  }

  private fireExit(): void {
    if (this.exitFired) return;
    this.exitFired = true;
    this.stop();
    const cause = this.stderrRing.looksLikeGpuInitFailure() ? 'crash' : 'unknown';
    this.opts.onExit({
      at: Date.now(),
      code: null,
      signal: null,
      cause,
      lastStderr: this.stderrRing.contents || null,
    });
  }
}
