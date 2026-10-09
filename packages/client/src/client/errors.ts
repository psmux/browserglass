import type { ErrorCategory, ErrorMsg } from '@browserglass/protocol';

/** Fields {@link BrowserGlassError} is built from, either from a wire {@link ErrorMsg} or synthesised locally. */
export interface BrowserGlassErrorInit {
  code: string;
  category: ErrorCategory;
  message: string;
  detail?: string;
  remediation?: string;
  retryable: boolean;
  context?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Thrown by every {@link BrowserGlassClient} request/response method that
 * fails, carrying the protocol `error` message's fields verbatim:
 * `code`, `category`,
 * `message`, `detail`, `remediation`, `retryable`, `context`, and the
 * request `id` that provoked it (`requestId`). Also used for a purely
 * client-side failure (a request timeout, a malformed local argument) with
 * a synthesised `code`/`category` and `retryable: false`.
 */
export class BrowserGlassError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly detail: string | undefined;
  readonly remediation: string | undefined;
  readonly retryable: boolean;
  readonly context: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(init: BrowserGlassErrorInit) {
    super(init.message);
    this.name = 'BrowserGlassError';
    this.code = init.code;
    this.category = init.category;
    this.detail = init.detail;
    this.remediation = init.remediation;
    this.retryable = init.retryable;
    this.context = init.context;
    this.requestId = init.requestId;
  }

  /** Builds a {@link BrowserGlassError} from a wire {@link ErrorMsg}, keying `requestId` off the message's own `re`. */
  static fromErrorMsg(msg: ErrorMsg): BrowserGlassError {
    return new BrowserGlassError({
      code: msg.code,
      category: msg.category,
      message: msg.message,
      retryable: msg.retryable,
      ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
      ...(msg.remediation !== undefined ? { remediation: msg.remediation } : {}),
      ...(msg.context !== undefined ? { context: msg.context } : {}),
      ...(msg.re !== undefined ? { requestId: msg.re } : {}),
    });
  }

  /** Builds a purely client-side {@link BrowserGlassError} (a request timeout, a local argument problem) with no server `error` message behind it. */
  static local(
    category: ErrorCategory,
    code: string,
    message: string,
    requestId?: string,
  ): BrowserGlassError {
    return new BrowserGlassError({
      code,
      category,
      message,
      retryable: false,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
}
