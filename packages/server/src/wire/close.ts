/**
 * `goodbye` construction. A writable
 * `4xxx` close is always preceded by `goodbye`. `reasonForCloseCode` mirrors
 * `@browserglass/protocol`'s `CloseCode`/reason-string tables as a direct code-to-reason map, since the protocol package
 * exports the frozen `CloseCode` values and the reason-string union but no
 * single code-to-reason lookup function.
 */

import { reconnectPolicy } from '@browserglass/protocol';

/**
 * `Omit<Goodbye, 'v' | 'ts' | 'sq'>` looks like the obvious return type
 * here, but `Envelope`'s `[k: string]: unknown` index signature makes
 * `keyof Envelope` (and therefore `keyof Goodbye`) resolve to `string`
 * rather than the named field list, which makes `Omit`/`Pick` silently
 * lose every literal-typed field (including `t: 'goodbye'` itself) instead
 * of narrowing them. A hand-written local type sidesteps that pitfall.
 */
export interface GoodbyeFields {
  readonly t: 'goodbye';
  readonly reason: string;
  readonly code: number;
  readonly message: string;
  readonly reconnect: boolean;
  readonly retryAfterMs?: number;
  readonly redirect?: { readonly url: string; readonly ticket?: string };
}

const REASON_BY_CODE: Readonly<Record<number, string>> = Object.freeze({
  1000: 'normal_closure',
  4000: 'session_ended',
  4001: 'idle_timeout',
  4002: 'max_duration',
  4003: 'kicked',
  4004: 'unrecoverable',
  4005: 'server_shutdown',
  4006: 'instance_released',
  4100: 'policy_violation',
  4101: 'rate_limited',
  4102: 'quota_exceeded',
  4103: 'slow_consumer',
  4104: 'incompatible_version',
  4105: 'message_too_large',
  4200: 'invalid_auth',
  4201: 'token_expired',
  4202: 'missing_params',
  4203: 'forbidden',
  4204: 'tenant_suspended',
  4300: 'replaced',
  4301: 'resume_rejected',
  4400: 'no_capacity',
  4401: 'node_draining',
  4402: 'node_lost',
  4403: 'relocate',
});

/** The snake_case reason string for `code`, or `'unknown'` for a code this table does not name. */
export function reasonForCloseCode(code: number): string {
  return REASON_BY_CODE[code] ?? 'unknown';
}

/** Builds a `goodbye` envelope for `code`, deriving `reconnect` from `@browserglass/protocol`'s `reconnectPolicy`. */
export function buildGoodbye(
  code: number,
  message: string,
  extra?: {
    readonly retryAfterMs?: number;
    readonly redirect?: { readonly url: string; readonly ticket?: string };
  },
): GoodbyeFields {
  const policy = reconnectPolicy(code);
  return {
    t: 'goodbye',
    reason: reasonForCloseCode(code),
    code,
    message,
    reconnect: policy.reconnect,
    ...(extra?.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    ...(extra?.redirect !== undefined ? { redirect: extra.redirect } : {}),
  };
}
