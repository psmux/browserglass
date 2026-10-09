/**
 * `acquire`'s full error table, including `E_LAUNCH_ADMISSION`. Every code is thrown as a {@link RouterError}, `BglsError`'s
 * router specialisation, carrying the HTTP status, optional close code, and
 * retry hint the table specifies, so a caller (the server package, later)
 * never has to re-derive them from the bare `E_*` string.
 */

import { BglsError } from '@browserglass/protocol';

/** Every code `acquire`, `attach`, and `release` may throw. */
export type AcquireErrorCode =
  | 'E_UNAUTHENTICATED'
  | 'E_FORBIDDEN'
  | 'E_TENANT_SUSPENDED'
  | 'E_POOL_NOT_FOUND'
  | 'E_POOL_PAUSED'
  | 'E_INSTANCE_NOT_FOUND'
  | 'E_INSTANCE_NOT_READY'
  | 'E_INSTANCE_GONE'
  | 'E_CONFLICTING_SELECTORS'
  | 'E_SPEC_INVALID'
  | 'E_PROFILE_NOT_FOUND'
  | 'E_PROFILE_BUSY'
  | 'E_PROFILE_QUARANTINED'
  | 'E_PROFILE_EXPIRED'
  | 'E_PROFILE_STORAGE'
  | 'E_QUOTA_INSTANCES'
  | 'E_QUOTA_RATE'
  | 'E_QUOTA_MINUTES'
  | 'E_NO_CAPACITY'
  | 'E_QUEUE_FULL'
  | 'E_QUEUE_TIMEOUT'
  | 'E_AFFINITY_UNSATISFIABLE'
  | 'E_LAUNCH_FAILED'
  | 'E_LAUNCH_TIMEOUT'
  | 'E_LAUNCH_ADMISSION'
  | 'E_NODE_LOST'
  | 'E_ROUTER_UNAVAILABLE'
  | 'E_IDEMPOTENCY_CONFLICT'
  | 'E_TERMINATE_FAILED';

/** One row of the `acquire` error table: the fixed shape for one {@link AcquireErrorCode}. */
export interface AcquireErrorTableRow {
  httpStatus: number;
  closeCode: number | null;
  retryable: boolean;
}

/**
 * The full `acquire` error table, including `E_LAUNCH_ADMISSION` (HTTP 503, retryable, no close
 * code, since a node refusing a launch for being at
 * `maxConcurrentLaunches` is a soft, retry shortly signal, not a hard
 * failure).
 */
export const ACQUIRE_ERROR_TABLE: Readonly<Record<AcquireErrorCode, AcquireErrorTableRow>> =
  Object.freeze({
    E_UNAUTHENTICATED: { httpStatus: 401, closeCode: 4200, retryable: false },
    E_FORBIDDEN: { httpStatus: 403, closeCode: 4203, retryable: false },
    E_TENANT_SUSPENDED: { httpStatus: 403, closeCode: 4204, retryable: false },
    E_POOL_NOT_FOUND: { httpStatus: 404, closeCode: null, retryable: false },
    E_POOL_PAUSED: { httpStatus: 409, closeCode: null, retryable: true },
    E_INSTANCE_NOT_FOUND: { httpStatus: 404, closeCode: null, retryable: false },
    E_INSTANCE_NOT_READY: { httpStatus: 409, closeCode: null, retryable: true },
    E_INSTANCE_GONE: { httpStatus: 410, closeCode: 4006, retryable: false },
    E_CONFLICTING_SELECTORS: { httpStatus: 400, closeCode: null, retryable: false },
    E_SPEC_INVALID: { httpStatus: 400, closeCode: null, retryable: false },
    E_PROFILE_NOT_FOUND: { httpStatus: 404, closeCode: null, retryable: false },
    E_PROFILE_BUSY: { httpStatus: 409, closeCode: null, retryable: true },
    E_PROFILE_QUARANTINED: { httpStatus: 409, closeCode: null, retryable: true },
    E_PROFILE_EXPIRED: { httpStatus: 410, closeCode: null, retryable: false },
    E_PROFILE_STORAGE: { httpStatus: 507, closeCode: null, retryable: true },
    E_QUOTA_INSTANCES: { httpStatus: 429, closeCode: 4102, retryable: true },
    E_QUOTA_RATE: { httpStatus: 429, closeCode: 4101, retryable: true },
    E_QUOTA_MINUTES: { httpStatus: 429, closeCode: 4102, retryable: true },
    E_NO_CAPACITY: { httpStatus: 503, closeCode: 4400, retryable: true },
    E_QUEUE_FULL: { httpStatus: 503, closeCode: 4400, retryable: true },
    E_QUEUE_TIMEOUT: { httpStatus: 504, closeCode: 4400, retryable: true },
    E_AFFINITY_UNSATISFIABLE: { httpStatus: 409, closeCode: null, retryable: false },
    E_LAUNCH_FAILED: { httpStatus: 502, closeCode: null, retryable: true },
    E_LAUNCH_TIMEOUT: { httpStatus: 504, closeCode: null, retryable: true },
    E_LAUNCH_ADMISSION: { httpStatus: 503, closeCode: null, retryable: true },
    E_NODE_LOST: { httpStatus: 503, closeCode: 4402, retryable: true },
    E_ROUTER_UNAVAILABLE: { httpStatus: 503, closeCode: null, retryable: true },
    E_IDEMPOTENCY_CONFLICT: { httpStatus: 409, closeCode: null, retryable: false },
    // Not an `acquire`/`attach` error: `release()`'s own addition, thrown
    // when both the graceful and forced terminate ladder rungs fail. Retryable because
    // the instance row is put back into `live` rather than `released` for
    // exactly this reason: a later reaper sweep or `stop()` gets another
    // chance at the same terminate.
    E_TERMINATE_FAILED: { httpStatus: 502, closeCode: null, retryable: true },
  });

/**
 * Thrown by every `BrowserRouter` method. Extends the shared `BglsError`
 * (internal `E_*` vocabulary, `@browserglass/protocol`) with the router's
 * own error table lookup, plus `retryAfterMs` and structured `details`
 * (`AcquireError.details`).
 */
export class RouterError extends BglsError {
  readonly httpStatus: number;
  readonly closeCode: number | null;
  override readonly context: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: AcquireErrorCode,
    message: string,
    opts?: { details?: Readonly<Record<string, unknown>>; retryAfterMs?: number; cause?: unknown },
  ) {
    const row = ACQUIRE_ERROR_TABLE[code];
    super(
      code,
      message,
      opts?.cause === undefined
        ? { context: opts?.details ?? {} }
        : { context: opts?.details ?? {}, cause: opts.cause },
    );
    this.name = 'RouterError';
    this.httpStatus = row.httpStatus;
    this.closeCode = row.closeCode;
    this.context = opts?.details ?? {};
    this.retryAfterMs = opts?.retryAfterMs;
  }

  /** This error's declared retryability, from {@link ACQUIRE_ERROR_TABLE}. */
  get retryable(): boolean {
    return ACQUIRE_ERROR_TABLE[this.code as AcquireErrorCode].retryable;
  }
}

/** Constructs a {@link RouterError} for `code`. Shorthand used throughout the router. */
export function routerErr(
  code: AcquireErrorCode,
  message: string,
  opts?: { details?: Readonly<Record<string, unknown>>; retryAfterMs?: number; cause?: unknown },
): RouterError {
  return new RouterError(code, message, opts);
}
