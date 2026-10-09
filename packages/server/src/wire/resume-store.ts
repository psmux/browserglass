/**
 * Server-side resume record store: an opaque `rsm_<ULID>` handle plus an HMAC over
 * the {@link ResumeSnapshot} it protects, stored server-side keyed by the
 * handle. Single use: `verifyAndConsume` deletes the record on a successful
 * verification, so a replay of the same token finds nothing and the caller
 * closes `4301`. Rotated on every accepted resume: `mint()` is called again
 * in the next `welcome`/`resumed`, issuing a fresh handle and HMAC.
 *
 * The HMAC key is generated once per process (`crypto.randomBytes`), never
 * persisted: a process restart invalidates every outstanding resume token,
 * which is correct, since a restarted process has no live `Session`s left
 * for a resume to attach to anyway.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from '@browserglass/protocol';

/**
 * What one resume token protects: enough to identify which session and
 * viewer identity a resume attempt is allowed to reattach to. It
 * deliberately does not carry a subscription or lease snapshot: those are
 * read from `ManagedSession`'s own bookkeeping at resume time (kept alive
 * for `session.resumeWindowMs` after a disconnect, see
 * `session/managed-session.ts`'s `detachViewer`/`resumeViewer`), which is
 * live state and therefore authoritative, unlike a snapshot frozen at the
 * moment the token was minted.
 */
export interface ResumeSnapshot {
  readonly sessionId: string;
  readonly viewerId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly lastControlSq: number;
}

/** A minted, not-yet-consumed resume token. */
export interface MintedResumeToken {
  readonly token: string;
  readonly windowMs: number;
  readonly issuedAt: number;
}

interface StoredRecord {
  readonly snapshot: ResumeSnapshot;
  readonly hmac: Buffer;
  readonly expiresAt: number;
}

function hmacFor(secret: Buffer, tokenId: string, snapshot: ResumeSnapshot): Buffer {
  return createHmac('sha256', secret).update(tokenId).update(JSON.stringify(snapshot)).digest();
}

/** Outcome of {@link ResumeStore.verifyAndConsume}. */
export type ResumeVerifyResult =
  | { readonly ok: true; readonly snapshot: ResumeSnapshot }
  | { readonly ok: false; readonly reason: 'not_found' | 'expired' | 'bad_signature' };

/**
 * The single-use, HMAC-protected resume token store for one process. One
 * instance is shared by every {@link ManagedSession}/connection in the
 * gateway, since a resume can arrive on a brand new socket with no relation
 * to the one that minted the token.
 */
export class ResumeStore {
  private readonly secret: Buffer;
  private readonly records = new Map<string, StoredRecord>();

  constructor(secret: Buffer = randomBytes(32)) {
    this.secret = secret;
  }

  /** Mints a fresh, single-use resume token for `snapshot`, valid for `windowMs`. */
  mint(snapshot: ResumeSnapshot, windowMs: number, nowMs: number): MintedResumeToken {
    const tokenId = newId('rsm');
    const hmac = hmacFor(this.secret, tokenId, snapshot);
    this.records.set(tokenId, { snapshot, hmac, expiresAt: nowMs + windowMs });
    return { token: `${tokenId}.${hmac.toString('base64url')}`, windowMs, issuedAt: nowMs };
  }

  /**
   * Verifies and, on success, immediately consumes (deletes) `token`.
   * A replay of an already-consumed or never-issued token returns
   * `not_found`; an expired-but-still-present one is deleted here and
   * returns `expired`; a token whose HMAC does not match its own record
   * (payload tampering, or a token from a different process generation)
   * returns `bad_signature` without deleting anything else.
   */
  verifyAndConsume(token: string, nowMs: number): ResumeVerifyResult {
    const dot = token.indexOf('.');
    if (dot < 0) return { ok: false, reason: 'not_found' };
    const tokenId = token.slice(0, dot);
    const macB64 = token.slice(dot + 1);
    const record = this.records.get(tokenId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.expiresAt <= nowMs) {
      this.records.delete(tokenId);
      return { ok: false, reason: 'expired' };
    }
    let suppliedMac: Buffer;
    try {
      suppliedMac = Buffer.from(macB64, 'base64url');
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    if (suppliedMac.length !== record.hmac.length || !timingSafeEqual(suppliedMac, record.hmac)) {
      return { ok: false, reason: 'bad_signature' };
    }
    this.records.delete(tokenId);
    return { ok: true, snapshot: record.snapshot };
  }

  /** Discards every record for `sessionId` (e.g. the session itself ended; an old resume token must not outlive it). */
  invalidateSession(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.snapshot.sessionId === sessionId) this.records.delete(id);
    }
  }

  /** Sweeps expired records. Call periodically; not itself a timer. */
  sweepExpired(nowMs: number): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= nowMs) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.records.size;
  }
}
