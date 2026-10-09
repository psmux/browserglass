/** Shared test doubles for the `TargetDiagnostics` suite, matching `packages/core/test/input/test-helpers.ts`'s `FakeCdpSender` pattern: a scripted double exposing just the `send`/`on` surface the class under test actually calls, not the full `CdpBridge` interface. */

import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../../src/cdp/types.js';

/** One recorded call to {@link FakeCdpBridge.send}. */
export interface RecordedSend {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly sessionId: CdpSessionId | undefined;
}

type CdpHandler = (params: Record<string, unknown>, sessionId: CdpSessionId | null) => void;

/** One `on()` registration, kept even after the caller unsubscribes, so a test can invoke a handler directly to simulate an event that was already in flight before the unsubscribe took effect (see `target-diagnostics.test.ts`'s stale-listener guard test). */
interface Registration {
  readonly event: string;
  readonly sessionId: CdpSessionId | undefined;
  readonly handler: CdpHandler;
}

/**
 * A scripted `CdpBridge` double implementing only `send` and `on`, exactly
 * the two members `TargetDiagnostics` calls. `TargetDiagnostics`'s own
 * constructor is typed against the full `CdpBridge`, so every call site casts this through `unknown`, the same
 * technique `packages/core/test/cdp/registry.test.ts` uses for `id: 'tgt_x'
 * as never`.
 */
export class FakeCdpBridge {
  readonly sent: RecordedSend[] = [];
  readonly registrations: Registration[] = [];
  /** method -> error to reject the next `send()` for that method with, consumed once. */
  private readonly rejectNextFor = new Map<string, unknown>();
  private readonly active = new Map<string, Set<CdpHandler>>();

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: CdpSessionId,
  ): Promise<unknown> {
    this.sent.push({ method, params, sessionId });
    const err = this.rejectNextFor.get(method);
    if (err !== undefined) {
      this.rejectNextFor.delete(method);
      return Promise.reject(err);
    }
    return Promise.resolve(undefined);
  }

  on(event: string, handler: CdpHandler, sessionId?: CdpSessionId): Unsubscribe {
    const key = sessionId ? `${sessionId} ${event}` : event;
    let set = this.active.get(key);
    if (!set) {
      set = new Set();
      this.active.set(key, set);
    }
    set.add(handler);
    this.registrations.push({ event, sessionId, handler });
    return () => {
      set?.delete(handler);
    };
  }

  /** Dispatches a fake CDP event exactly like the real bridge's dispatch loop would: only handlers currently (not previously) registered for this `(sessionId, event)` pair fire. */
  emit(event: string, params: Record<string, unknown>, sessionId: CdpSessionId): void {
    const key = `${sessionId} ${event}`;
    for (const h of this.active.get(key) ?? []) h(params, sessionId);
  }

  /** The next `send(method, ...)` call rejects with `error`, once. */
  rejectNext(method: string, error: unknown): void {
    this.rejectNextFor.set(method, error);
  }

  sendCountFor(method: string): number {
    return this.sent.filter((s) => s.method === method).length;
  }

  /** The first still-tracked registration for `event` on `sessionId`, including one already unsubscribed from `active` dispatch (see {@link Registration}'s doc). Used to simulate an event already in flight when a `rebind()` unsubscribes it. */
  firstRegistration(event: string, sessionId: CdpSessionId): CdpHandler {
    const reg = this.registrations.find((r) => r.event === event && r.sessionId === sessionId);
    if (!reg) throw new Error(`no registration found for ${event} on ${sessionId}`);
    return reg.handler;
  }
}

/** Casts a {@link FakeCdpBridge} to the full `CdpBridge` type `TargetDiagnostics` is constructed with; only `send`/`on` are ever actually called. */
export function asFakeBridge(fake: FakeCdpBridge): CdpBridge {
  return fake as unknown as CdpBridge;
}
