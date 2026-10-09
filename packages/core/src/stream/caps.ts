/**
 * Stream count caps. `maxStreamsPerInstance`: how many concurrent
 * screencasts one Chrome instance can sustain is unknown and not resolvable
 * by judgement, so the default is deliberately conservative.
 *
 * The screencast limit first looked like an architectural ceiling of one
 * live screencast per Instance, which made this counter dead code: nothing
 * ever constructed or called it, since a hard cap of one made a separate
 * resource guard pointless. `runtime-host/test/spike/spike-window-isolation.ts`
 * found that ceiling was really per OS *window*, not per Instance: one target per window, not one per Instance, so an Instance
 * with several targets in several windows can genuinely stream all of them
 * at once. This counter is now wired into `Session.subscribe`/its teardown
 * path for exactly that reason: with no per-Instance limit at all, nothing
 * stops a caller from opening far more targets than the demo, or the host
 * machine, can sustain. It is a resource guard against that, not an
 * architectural wall.
 */

import { BglsError, type InstanceId } from '@browserglass/protocol';

/**
 * Default cap on concurrent (live plus thumbnail) streams per browser
 * Instance. Raised from the original 4 (a per-Instance figure
 * that made sense when at most one target could ever stream live at once)
 * to 8, comfortably above the three panes `examples/nextjs-demo` drives
 * today, now that per-window isolation lets every streamed target be
 * genuinely live at the same time rather than mostly polling.
 */
export const DEFAULT_MAX_STREAMS_PER_INSTANCE =
  Number(process.env['BGLS_MAX_STREAMS_PER_INSTANCE'] ?? '') > 0
    ? Number(process.env['BGLS_MAX_STREAMS_PER_INSTANCE'])
    : 8; // BGLS_MAX_STREAMS_PER_INSTANCE overrides the default; the server never forwards limits.* here

/** Constructor options for {@link InstanceStreamCounter}. */
export interface InstanceStreamCounterOptions {
  maxStreamsPerInstance?: number;
}

/**
 * Tracks how many `Stream`s are currently live per Instance, and enforces
 * {@link DEFAULT_MAX_STREAMS_PER_INSTANCE} (or an override) with a typed
 * `E_STREAM_LIMIT` `BglsError` carrying the current count and the cap.
 */
export class InstanceStreamCounter {
  private readonly max: number;
  private readonly counts = new Map<InstanceId, number>();

  constructor(opts: InstanceStreamCounterOptions = {}) {
    this.max = opts.maxStreamsPerInstance ?? DEFAULT_MAX_STREAMS_PER_INSTANCE;
  }

  count(instanceId: InstanceId): number {
    return this.counts.get(instanceId) ?? 0;
  }

  /** Throws `E_STREAM_LIMIT` if `instanceId` is already at the cap; otherwise increments and returns the new count. */
  acquire(instanceId: InstanceId): number {
    const current = this.count(instanceId);
    if (current >= this.max) {
      throw new BglsError(
        'E_STREAM_LIMIT',
        `instance ${instanceId} is already streaming ${current} of ${this.max} permitted concurrent streams`,
        {
          context: { instanceId, current, cap: this.max },
        },
      );
    }
    const next = current + 1;
    this.counts.set(instanceId, next);
    return next;
  }

  /** Decrements the count for `instanceId`; a no-op below zero. */
  release(instanceId: InstanceId): void {
    const current = this.count(instanceId);
    if (current <= 1) {
      this.counts.delete(instanceId);
    } else {
      this.counts.set(instanceId, current - 1);
    }
  }
}
