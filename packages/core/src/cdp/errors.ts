/**
 * `CdpError`, the one error class every failure from `CdpBridge` surfaces
 * as, and the mapping table from a raw Chrome DevTools Protocol error (or a
 * local condition such as a timeout or a closed socket) to it. Never
 * string-match a Chrome error message anywhere outside {@link mapCdpJsonRpcError}.
 */

import type { CdpSessionId } from './types.js';

/** The seven broad families a {@link CdpError} falls into. */
export type CdpErrorKind =
  | 'protocol'
  | 'timeout'
  | 'detached'
  | 'closed'
  | 'crashed'
  | 'transport'
  | 'version';

/** Constructor options for {@link CdpError}. */
export interface CdpErrorInit {
  kind: CdpErrorKind;
  method?: string;
  sessionId?: CdpSessionId | null;
  targetId?: string | null;
  retryable?: boolean;
  cdpCode?: number;
  elapsedMs?: number;
  message?: string;
  cause?: unknown;
}

/**
 * The one error class every `CdpBridge` failure surfaces as. `code` is a
 * stable `E_CDP_*` identifier a caller can switch on; `kind` is the coarser
 * family; `retryable` is advisory only, the bridge itself never retries a
 * command (the one exception is `sessionFor()` retrying once on
 * `E_CDP_DETACHED`, since attach is idempotent by construction).
 */
export class CdpError extends Error {
  readonly kind: CdpErrorKind;
  readonly code: string;
  readonly cdpCode: number | undefined;
  readonly method: string;
  readonly sessionId: CdpSessionId | null;
  readonly targetId: string | null;
  readonly retryable: boolean;
  readonly elapsedMs: number;
  override readonly cause: unknown;

  constructor(code: string, init: CdpErrorInit) {
    super(
      init.message ?? `${code}: ${init.kind}`,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'CdpError';
    this.code = code;
    this.kind = init.kind;
    this.cdpCode = init.cdpCode;
    this.method = init.method ?? '';
    this.sessionId = init.sessionId ?? null;
    this.targetId = init.targetId ?? null;
    this.retryable = init.retryable ?? false;
    this.elapsedMs = init.elapsedMs ?? 0;
    this.cause = init.cause;
  }
}

/** A raw `{code, message}` error object as Chrome sends it in a command response. */
export interface CdpJsonRpcError {
  code: number;
  message: string;
}

/** Context {@link mapCdpJsonRpcError} attaches to the {@link CdpError} it builds. */
export interface MapCdpErrorContext {
  method: string;
  sessionId: CdpSessionId | null;
  targetId?: string | null;
  elapsedMs: number;
}

/**
 * Maps a raw Chrome JSON RPC error to a {@link CdpError}. This is the one place in
 * the whole system permitted to inspect `error.message` text; every other
 * module reacts to `CdpError.code` only.
 */
export function mapCdpJsonRpcError(error: CdpJsonRpcError, ctx: MapCdpErrorContext): CdpError {
  const base = {
    method: ctx.method,
    sessionId: ctx.sessionId,
    targetId: ctx.targetId ?? null,
    elapsedMs: ctx.elapsedMs,
    cdpCode: error.code,
    message: error.message,
  };

  if (error.code === -32601) {
    return new CdpError('E_CDP_METHOD_UNSUPPORTED', { ...base, kind: 'version', retryable: false });
  }
  if (error.code === -32602) {
    return new CdpError('E_CDP_INVALID_PARAMS', { ...base, kind: 'protocol', retryable: false });
  }
  if (error.code === -32700) {
    return new CdpError('E_CDP_PARSE', { ...base, kind: 'transport', retryable: false });
  }
  if (error.code === -32000) {
    if (error.message.includes('Session with given id not found')) {
      return new CdpError('E_CDP_DETACHED', { ...base, kind: 'detached', retryable: true });
    }
    if (error.message.includes('Target closed')) {
      return new CdpError('E_CDP_TARGET_CLOSED', { ...base, kind: 'detached', retryable: false });
    }
    if (error.message.includes('Inspected target navigated or closed')) {
      return new CdpError('E_CDP_NAVIGATED_AWAY', { ...base, kind: 'detached', retryable: true });
    }
    return new CdpError('E_CDP_SERVER_ERROR', { ...base, kind: 'protocol', retryable: false });
  }
  return new CdpError('E_CDP_SERVER_ERROR', { ...base, kind: 'protocol', retryable: false });
}

/** Builds the {@link CdpError} for a locally fired command timeout. */
export function timeoutError(ctx: MapCdpErrorContext): CdpError {
  return new CdpError('E_CDP_TIMEOUT', {
    kind: 'timeout',
    method: ctx.method,
    sessionId: ctx.sessionId,
    targetId: ctx.targetId ?? null,
    elapsedMs: ctx.elapsedMs,
    retryable: true,
    message: `${ctx.method} timed out after ${ctx.elapsedMs}ms`,
  });
}

/** Builds the {@link CdpError} for every in-flight request rejected by a socket close. */
export function closedError(ctx: MapCdpErrorContext): CdpError {
  return new CdpError('E_CDP_CLOSED', {
    kind: 'closed',
    method: ctx.method,
    sessionId: ctx.sessionId,
    targetId: ctx.targetId ?? null,
    elapsedMs: ctx.elapsedMs,
    retryable: true,
    message: `${ctx.method} rejected, the bridge closed`,
  });
}

/** Builds the {@link CdpError} for every in-flight request rejected by a session detach. */
export function detachedError(ctx: MapCdpErrorContext, reason: string): CdpError {
  return new CdpError('E_CDP_DETACHED', {
    kind: 'detached',
    method: ctx.method,
    sessionId: ctx.sessionId,
    targetId: ctx.targetId ?? null,
    elapsedMs: ctx.elapsedMs,
    retryable: true,
    message: `${ctx.method} rejected, session detached: ${reason}`,
  });
}

/** Builds the {@link CdpError} for a target crash. */
export function crashedError(ctx: MapCdpErrorContext): CdpError {
  return new CdpError('E_CDP_TARGET_CRASHED', {
    kind: 'crashed',
    method: ctx.method,
    sessionId: ctx.sessionId,
    targetId: ctx.targetId ?? null,
    elapsedMs: ctx.elapsedMs,
    retryable: false,
    message: `${ctx.method} rejected, target crashed`,
  });
}

/**
 * Builds the {@link CdpError} for `sessionFor()` refusing an attach while a
 * target's per-target circuit breaker is backing off (`E_CDP_BACKOFF`).
 */
export function backoffError(targetId: string, backoffUntil: number, now: number): CdpError {
  return new CdpError('E_CDP_BACKOFF', {
    kind: 'detached',
    method: 'Target.attachToTarget',
    sessionId: null,
    targetId,
    elapsedMs: 0,
    retryable: true,
    message: `target ${targetId} is backing off for ${backoffUntil - now}ms more`,
  });
}
