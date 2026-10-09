/**
 * WebSocket close codes for `bgls.v1`. Never reuse a numeric code across
 * bands: the band structure lets a client make a correct decision from the
 * band alone, even for a code it has never seen. This is the single
 * frozen object every other file must reference; no numeric close-code
 * literal may appear outside it (invariant INV-25).
 */
export const CloseCode = Object.freeze({
  NormalClosure: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  AbnormalClosure: 1006,
  InternalError: 1011,

  // 4000 to 4099: session lifecycle
  SessionEnded: 4000,
  IdleTimeout: 4001,
  MaxDuration: 4002,
  Kicked: 4003,
  Unrecoverable: 4004,
  ServerShutdown: 4005,
  InstanceReleased: 4006,

  // 4100 to 4199: policy
  PolicyViolation: 4100,
  RateLimited: 4101,
  QuotaExceeded: 4102,
  SlowConsumer: 4103,
  IncompatibleVersion: 4104,
  MessageTooLarge: 4105,

  // 4200 to 4299: auth
  InvalidAuth: 4200,
  TokenExpired: 4201,
  MissingParams: 4202,
  Forbidden: 4203,
  TenantSuspended: 4204,

  // 4300 to 4399: connection replacement
  Replaced: 4300,
  ResumeRejected: 4301,

  // 4400 to 4499: routing
  NoCapacity: 4400,
  NodeDraining: 4401,
  NodeLost: 4402,
  Relocate: 4403,
} as const);

/** Name of a {@link CloseCode} entry. */
export type CloseCodeName = keyof typeof CloseCode;
/** Numeric value of a {@link CloseCode} entry. */
export type CloseCodeValue = (typeof CloseCode)[CloseCodeName];

/**
 * The named close-code bands. `'host'` is the reserved 4900 to 4999 range
 * for application-defined codes; `'ws'` is the plain WebSocket range below
 * 3000.
 */
export type CloseCodeBand =
  | 'ws'
  | 'session'
  | 'policy'
  | 'auth'
  | 'replacement'
  | 'routing'
  | 'host'
  | 'unknown';

/**
 * Resolves the band a numeric close code falls in. Every band is a
 * disjoint numeric range, so every code is in exactly one band; codes
 * outside every known range resolve to `'unknown'`, which a conforming
 * client treats as reconnectable (see {@link reconnectPolicy}).
 */
export function closeCodeBand(code: number): CloseCodeBand {
  if (code < 4000) return 'ws';
  if (code >= 4000 && code <= 4099) return 'session';
  if (code >= 4100 && code <= 4199) return 'policy';
  if (code >= 4200 && code <= 4299) return 'auth';
  if (code >= 4300 && code <= 4399) return 'replacement';
  if (code >= 4400 && code <= 4499) return 'routing';
  if (code >= 4900 && code <= 4999) return 'host';
  return 'unknown';
}

/**
 * Close codes a conforming client must never automatically reconnect
 * after, regardless of band-default behaviour.
 */
export const NEVER_RECONNECT_CODES: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    CloseCode.Kicked,
    CloseCode.InstanceReleased,
    CloseCode.PolicyViolation,
    CloseCode.QuotaExceeded,
    CloseCode.IncompatibleVersion,
    CloseCode.InvalidAuth,
    CloseCode.MissingParams,
    CloseCode.Forbidden,
    CloseCode.TenantSuspended,
    CloseCode.Replaced,
  ]),
);

/**
 * Reason strings carried on `goodbye.reason` and the WS close reason,
 * snake_case, at most 123 bytes (the WS spec's own cap).
 */
export type CloseReason =
  | 'session_ended'
  | 'idle_timeout'
  | 'max_duration'
  | 'kicked'
  | 'unrecoverable'
  | 'server_shutdown'
  | 'instance_released'
  | 'policy_violation'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'slow_consumer'
  | 'incompatible_version'
  | 'message_too_large'
  | 'invalid_auth'
  | 'token_expired'
  | 'missing_params'
  | 'forbidden'
  | 'tenant_suspended'
  | 'replaced'
  | 'resume_rejected'
  | 'no_capacity'
  | 'node_draining'
  | 'node_lost'
  | 'relocate';

/** Maps every {@link CloseCodeName} that has a reason string to its {@link CloseReason}. */
export const CLOSE_REASON_BY_CODE_NAME: Readonly<Partial<Record<CloseCodeName, CloseReason>>> =
  Object.freeze({
    SessionEnded: 'session_ended',
    IdleTimeout: 'idle_timeout',
    MaxDuration: 'max_duration',
    Kicked: 'kicked',
    Unrecoverable: 'unrecoverable',
    ServerShutdown: 'server_shutdown',
    InstanceReleased: 'instance_released',
    PolicyViolation: 'policy_violation',
    RateLimited: 'rate_limited',
    QuotaExceeded: 'quota_exceeded',
    SlowConsumer: 'slow_consumer',
    IncompatibleVersion: 'incompatible_version',
    MessageTooLarge: 'message_too_large',
    InvalidAuth: 'invalid_auth',
    TokenExpired: 'token_expired',
    MissingParams: 'missing_params',
    Forbidden: 'forbidden',
    TenantSuspended: 'tenant_suspended',
    Replaced: 'replaced',
    ResumeRejected: 'resume_rejected',
    NoCapacity: 'no_capacity',
    NodeDraining: 'node_draining',
    NodeLost: 'node_lost',
    Relocate: 'relocate',
  });

/** The backoff family a client applies before reconnecting. */
export type ReconnectBackoff = 'normal' | 'slow' | 'retryAfter' | 'immediate';

/** What a conforming client does after a socket closes with a given code. */
export interface ReconnectPolicy {
  /** Whether the client should attempt to reconnect at all. */
  reconnect: boolean;
  /** Which backoff schedule to apply, when {@link reconnect} is true. */
  backoff?: ReconnectBackoff;
  /** Whether the existing ticket or resume token may be reused. */
  sameToken?: boolean;
  /** Whether the client should proactively degrade quality on reconnect. */
  degrade?: boolean;
  /** Whether the client must discard its resume token even though `sameToken` covers the ticket. */
  dropResume?: boolean;
  /** Whether the client should follow `goodbye.redirect.url` rather than its own URL. */
  useRedirect?: boolean;
}

/**
 * The reference reconnect algorithm, decided purely
 * from the numeric close code. The default for a code this function does
 * not recognise is to reconnect, because the cost of being wrong is
 * asymmetric.
 */
export function reconnectPolicy(code: number): ReconnectPolicy {
  if (code === CloseCode.NormalClosure) return { reconnect: false };
  if (code < 3000) return { reconnect: true, backoff: 'normal', sameToken: true };
  if (code === CloseCode.Kicked || code === CloseCode.InstanceReleased) return { reconnect: false };
  if (code >= 4000 && code <= 4099) return { reconnect: true, backoff: 'normal', sameToken: true };
  if (code === CloseCode.RateLimited)
    return { reconnect: true, backoff: 'retryAfter', sameToken: true };
  if (code === CloseCode.SlowConsumer || code === CloseCode.MessageTooLarge) {
    return { reconnect: true, backoff: 'slow', sameToken: true, degrade: true };
  }
  if (code >= 4100 && code <= 4199) return { reconnect: false };
  if (code === CloseCode.TokenExpired)
    return { reconnect: true, backoff: 'immediate', sameToken: false };
  if (code >= 4200 && code <= 4299) return { reconnect: false };
  if (code === CloseCode.ResumeRejected) {
    return { reconnect: true, backoff: 'immediate', sameToken: true, dropResume: true };
  }
  if (code >= 4300 && code <= 4399) return { reconnect: false };
  if (code === CloseCode.Relocate) {
    return { reconnect: true, backoff: 'immediate', sameToken: false, useRedirect: true };
  }
  if (code >= 4400 && code <= 4499) return { reconnect: true, backoff: 'normal', sameToken: true };
  if (code >= 4900 && code <= 4999) return { reconnect: false };
  return { reconnect: true, backoff: 'normal', sameToken: true };
}
