import type { HelloResume } from '@browserglass/protocol';
import type { DesiredSubscription, ResumeRecord } from './types.js';

/**
 * Whether a {@link ResumeRecord} issued at `record.issuedAt` is still
 * inside the effective resume window at `nowMs`. The effective window is
 * `min(record.windowMs, clientResumeWindowMs)` (the client's
 * `resumeWindowMs` option): the server's own window is
 * authoritative for whether a resume attempt will be accepted, but the
 * client additionally gives up early against its own ceiling so it does
 * not keep declaring `usingResume: true` on an outage the server would
 * reject anyway.
 */
export function isResumeWithinWindow(
  record: ResumeRecord,
  nowMs: number,
  clientResumeWindowMs: number,
): boolean {
  const effectiveWindowMs = Math.min(record.windowMs, clientResumeWindowMs);
  return nowMs - record.issuedAt < effectiveWindowMs;
}

/**
 * Builds the `hello.resume` block from a {@link ResumeRecord}. Folding
 * `resume` into `hello` (rather than sending it as a standalone message)
 * saves a round trip; it is what `@browserglass/client` always does.
 */
export function toHelloResume(record: ResumeRecord): HelloResume {
  return {
    token: record.token,
    sessionId: record.sessionId,
    viewerId: record.viewerId,
    lastSeq: record.lastSeq,
    lastControlSq: record.lastControlSq,
  };
}

/**
 * Builds a fresh {@link ResumeRecord} from a `welcome` message's `resume`
 * block plus the session identity it carries. Called both on a first
 * connect (starting a brand new record) and after a successful resume
 * (the token rotates on every use: the previous token
 * is burned the moment this one is accepted).
 */
export function resumeRecordFromWelcome(params: {
  token: string;
  windowMs: number;
  issuedAt: number;
  sessionId: string;
  viewerId: string;
  desired: DesiredSubscription[];
  /** Carried forward across a resume; empty on a fresh (non-resumed) connect. */
  lastSeq?: Record<string, number> | undefined;
  lastControlSq?: number | undefined;
  leases?: Record<string, { leaseId: string; expiresAt: number }> | undefined;
}): ResumeRecord {
  return {
    token: params.token,
    sessionId: params.sessionId,
    viewerId: params.viewerId,
    issuedAt: params.issuedAt,
    windowMs: params.windowMs,
    lastSeq: params.lastSeq ?? {},
    lastControlSq: params.lastControlSq ?? 0,
    desired: params.desired,
    leases: params.leases ?? {},
  };
}
