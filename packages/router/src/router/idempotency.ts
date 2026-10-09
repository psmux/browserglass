/**
 * `acquire`'s idempotency table, consulted before anything else in
 * `acquire`. Keyed on `(tenantId, appId, requestId)` for
 * `idempotencyWindowMs`. A repeat call within the window returns the
 * identical `AcquireResult`; a repeat call while the first is still in
 * flight joins it rather than duplicating the launch, which is what stops
 * a client retry during a cold launch from leaking a Chrome process.
 */

import type { Clock } from './clock.js';
import { routerErr } from './errors.js';
import type { AcquireRequest, AcquireResult } from './types.js';

/** One entry in the idempotency table. */
interface IdempotencyEntry {
  request: AcquireRequest;
  /** Set while the original call has not yet settled; every joiner awaits this. */
  promise: Promise<AcquireResult>;
  /** Set once the original call settles successfully. `null` while in flight or after a failure. */
  result: AcquireResult | null;
  expiresAt: number;
}

/**
 * Compares two `AcquireRequest` bodies for the purpose of
 * `E_IDEMPOTENCY_CONFLICT`: the same `requestId` reused with a
 * meaningfully different body is a caller bug, not a legitimate retry.
 * `requestId` itself and `async` (a client side polling preference, not
 * part of what is being requested) are excluded from the comparison.
 */
export function requestsMatch(a: AcquireRequest, b: AcquireRequest): boolean {
  const strip = (r: AcquireRequest): unknown => {
    const { requestId: _requestId, async: _async, ...rest } = r;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * The in memory idempotency table `BrowserRouter` consults at the top of
 * `acquire`. Single process only, which is sufficient for the embedded
 * single node build; a multi node build would back this with a durable,
 * shared table instead (a `Store.idempotency` that is not part of the
 * `Store` interface `protocol` defines yet; a durable idempotency table
 * would be additive).
 */
export class IdempotencyTable {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(private readonly clock: Clock) {}

  private key(tenantId: string, appId: string, requestId: string): string {
    return `${tenantId}\u0000${appId}\u0000${requestId}`;
  }

  /** Sweeps expired entries. Cheap; called opportunistically rather than on a timer. */
  private sweep(): void {
    const now = this.clock.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /**
   * Runs `run` under idempotency protection for `req.requestId`. When
   * `req.requestId` is unset, always runs `run` fresh. When a prior call
   * for the same key is in flight, returns its promise (join, not
   * duplicate). When a prior call already completed within the window,
   * returns its result immediately. Throws `E_IDEMPOTENCY_CONFLICT` when
   * the same `requestId` is reused with a materially different request.
   */
  async withIdempotency(
    tenantId: string,
    appId: string,
    req: AcquireRequest,
    windowMs: number,
    run: () => Promise<AcquireResult>,
  ): Promise<AcquireResult> {
    if (!req.requestId) return run();
    this.sweep();
    const key = this.key(tenantId, appId, req.requestId);
    const existing = this.entries.get(key);
    if (existing) {
      if (!requestsMatch(existing.request, req)) {
        throw routerErr(
          'E_IDEMPOTENCY_CONFLICT',
          `requestId ${req.requestId} was already used with a different request body`,
        );
      }
      if (existing.result) return existing.result;
      return existing.promise;
    }

    const promise = run();
    const entry: IdempotencyEntry = {
      request: req,
      promise,
      result: null,
      expiresAt: this.clock.now() + windowMs,
    };
    this.entries.set(key, entry);
    try {
      const result = await promise;
      entry.result = result;
      entry.expiresAt = this.clock.now() + windowMs;
      return result;
    } catch (e) {
      // A failed attempt does not poison the key: a retry with the same
      // requestId after a failure is expected to try again, not replay a
      // stale rejection.
      this.entries.delete(key);
      throw e;
    }
  }

  /** Test and diagnostic helper: the number of live (non expired) entries. */
  size(): number {
    this.sweep();
    return this.entries.size;
  }
}
