/**
 * `ProfileService`'s error table and thrown error class, in the same shape
 * as `../router/errors.ts`'s `RouterError`, so a caller handles both
 * uniformly.
 */

import { BglsError } from '@browserglass/protocol';
import type { ProfileErrorCode } from './types.js';

/** One row of the `ProfileService` error table. */
export interface ProfileErrorTableRow {
  httpStatus: number;
  retryable: boolean;
}

/** The full `ProfileService` error table. `E_NOT_IMPLEMENTED` is 501, never retryable. */
export const PROFILE_ERROR_TABLE: Readonly<Record<ProfileErrorCode, ProfileErrorTableRow>> =
  Object.freeze({
    E_PROFILE_NOT_FOUND: { httpStatus: 404, retryable: false },
    E_PROFILE_BUSY: { httpStatus: 409, retryable: true },
    E_PROFILE_QUARANTINED: { httpStatus: 409, retryable: false },
    E_PROFILE_UNREACHABLE: { httpStatus: 503, retryable: true },
    E_PROFILE_KEY_RESERVED: { httpStatus: 400, retryable: false },
    E_PROFILE_KEY_INVALID: { httpStatus: 400, retryable: false },
    E_PROFILE_CREATE_TIMEOUT: { httpStatus: 504, retryable: true },
    E_PROFILE_SPEC_INVALID: { httpStatus: 400, retryable: false },
    E_TEMPLATE_INVALID: { httpStatus: 400, retryable: false },
    E_TEMPLATE_CHROME_DRIFT: { httpStatus: 409, retryable: false },
    E_TEMPLATE_CHROME_NEWER: { httpStatus: 409, retryable: false },
    E_BUNDLE_CORRUPT: { httpStatus: 422, retryable: false },
    E_BUNDLE_PLATFORM_MISMATCH: { httpStatus: 409, retryable: false },
    E_BUNDLE_CHROME_NEWER: { httpStatus: 409, retryable: false },
    E_QUOTA_EXCEEDED: { httpStatus: 429, retryable: false },
    E_DISK_FULL: { httpStatus: 507, retryable: false },
    E_COPY_TOO_SLOW: { httpStatus: 409, retryable: true },
    E_FENCE_STALE: { httpStatus: 409, retryable: false },
    E_SEED_INVALID_COOKIE: { httpStatus: 400, retryable: false },
    E_SEED_UNSUPPORTED_VALUE: { httpStatus: 400, retryable: false },
    E_NOT_IMPLEMENTED: { httpStatus: 501, retryable: false },
  });

/** Thrown by every `ProfileService` method. Extends the shared `BglsError`. */
export class ProfileServiceError extends BglsError {
  readonly httpStatus: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ProfileErrorCode,
    message: string,
    opts?: { details?: Readonly<Record<string, unknown>>; retryAfterMs?: number; cause?: unknown },
  ) {
    super(
      code,
      message,
      opts?.cause === undefined
        ? { context: opts?.details ?? {} }
        : { context: opts?.details ?? {}, cause: opts.cause },
    );
    this.name = 'ProfileServiceError';
    this.httpStatus = PROFILE_ERROR_TABLE[code].httpStatus;
    this.retryAfterMs = opts?.retryAfterMs;
  }

  /** This error's declared retryability, from {@link PROFILE_ERROR_TABLE}. */
  get retryable(): boolean {
    return PROFILE_ERROR_TABLE[this.code as ProfileErrorCode].retryable;
  }
}

/** Constructs a {@link ProfileServiceError} for `code`. Shorthand used throughout this module. */
export function profileErr(
  code: ProfileErrorCode,
  message: string,
  opts?: { details?: Readonly<Record<string, unknown>>; retryAfterMs?: number; cause?: unknown },
): ProfileServiceError {
  return new ProfileServiceError(code, message, opts);
}

/** Throws `E_NOT_IMPLEMENTED` for a stubbed method, naming it in the message. */
export function notImplemented(method: string): never {
  throw profileErr(
    'E_NOT_IMPLEMENTED',
    `ProfileService.${method} is not implemented in this build`,
    { details: { method } },
  );
}
