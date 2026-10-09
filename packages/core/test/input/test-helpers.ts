/** Shared test doubles for the input dispatch test suite. */

import { CdpError } from '../../src/cdp/errors.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import type { InputCdpSender } from '../../src/input/cdp-allowlist.js';
import type { InputTargetResolver, InputTargetSnapshot } from '../../src/input/dispatcher.js';

/** One recorded call to {@link FakeCdpSender.send}. */
export interface RecordedSend {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId;
}

/** A scripted {@link InputCdpSender}: records every call, and can be told to reject, delay, or throw a session-closed error for a given method. */
export class FakeCdpSender implements InputCdpSender {
  readonly calls: RecordedSend[] = [];
  /** When set, the next `send()` for this method rejects with a plain error instead of resolving. */
  rejectNextFor: string | null = null;
  /** When set, every `send()` for this method rejects with a session-closed `CdpError` exactly once, then behaves normally. */
  sessionClosedOnceFor: string | null = null;
  /** Extra delay, in ms, before every send resolves (via a real `setTimeout`, for race-timing tests). */
  delayMs = 0;

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: CdpSessionId,
  ): Promise<unknown> {
    this.calls.push({ method, params: params ?? {}, sessionId: sessionId ?? ('' as CdpSessionId) });
    if (this.sessionClosedOnceFor === method) {
      this.sessionClosedOnceFor = null;
      return Promise.reject(
        new CdpError('E_CDP_DETACHED', { kind: 'detached', retryable: true, method }),
      );
    }
    if (this.rejectNextFor === method) {
      this.rejectNextFor = null;
      return Promise.reject(new Error(`scripted rejection for ${method}`));
    }
    if (this.delayMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(undefined), this.delayMs));
    }
    return Promise.resolve(undefined);
  }
}

/** A scripted {@link InputTargetResolver} backed by an in-memory map of target snapshots and a fixed session id per target. */
export class FakeTargetResolver implements InputTargetResolver {
  private readonly snapshots = new Map<string, InputTargetSnapshot>();
  private readonly sessionIds = new Map<string, CdpSessionId>();
  attachDelayMs = 0;
  /** When set, `attach()` for this target rejects once with the given error, then behaves normally. */
  rejectOnceFor: { targetId: string; error: unknown } | null = null;

  setViewport(targetId: string, width: number, height: number): void {
    this.snapshots.set(targetId, { viewport: { width, height } });
    if (!this.sessionIds.has(targetId)) {
      this.sessionIds.set(targetId, `sess-${targetId}` as CdpSessionId);
    }
  }

  get(targetId: string): InputTargetSnapshot | undefined {
    return this.snapshots.get(targetId);
  }

  async attach(targetId: string): Promise<{ id: CdpSessionId }> {
    if (this.rejectOnceFor && this.rejectOnceFor.targetId === targetId) {
      const error = this.rejectOnceFor.error;
      this.rejectOnceFor = null;
      throw error;
    }
    if (this.attachDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.attachDelayMs));
    }
    if (!this.snapshots.has(targetId)) {
      this.snapshots.set(targetId, { viewport: null });
    }
    let sessionId = this.sessionIds.get(targetId);
    if (!sessionId) {
      sessionId = `sess-${targetId}` as CdpSessionId;
      this.sessionIds.set(targetId, sessionId);
    }
    return { id: sessionId };
  }
}

/** Waits for every pending microtask (repeatedly) so a promise chain built from several `.then`s settles before assertions run. */
export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
