import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type AppId, type Store, type TenantId, newId } from '@browserglass/protocol';

/**
 * Everything needed to redeem a minted ticket, held in process memory only.
 * The ticket string itself never carries this: it carries only the id
 * (a DB lookup key) and a random secret whose hash is compared here. This
 * is why a ticket cannot be forged from its id alone, and why redemption
 * needs no DB round trip to check the Origin/appId binding.
 */
interface TicketRecord {
  readonly secretHash: Buffer;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly origin: string;
  readonly nodeId: string;
  readonly instanceId: string;
  readonly viewerId: string;
  readonly epoch: number;
  readonly sessionId: string | undefined;
  readonly expiresAt: number;
}

/** Result of {@link mintTicket}. */
export interface MintedTicket {
  /** `tkt_<ULID>.<32 byte base64url random>`, opaque, not a JWT. Never logged; redact before any log line. */
  readonly token: string;
  readonly ticketId: string;
  readonly expiresAt: number;
}

export interface MintTicketRequest {
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly origin: string;
  readonly nodeId: string;
  readonly instanceId: string;
  readonly viewerId: string;
  readonly epoch: number;
  readonly sessionId?: string;
  readonly ttlMs: number;
}

/**
 * Result of {@link redeemTicket}. On failure, `reason` is deliberately
 * spelled to match the suffix of the corresponding `bgls.error.auth.*`
 * wire code in `protocol`'s `ERROR_REGISTRY` (`invalid_ticket`,
 * `ticket_expired`, `origin_mismatch`, `ticket_consumed`), so the WS
 * upgrade handler can map this result straight onto the close
 * reason without a second lookup table.
 */
export type RedeemTicketResult =
  | { readonly ok: true; readonly record: TicketRecord; readonly ticketId: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid_ticket' | 'ticket_expired' | 'origin_mismatch' | 'ticket_consumed';
    };

/**
 * In process, single node store for ticket secrets, mirroring the jti
 * cache's own tradeoff (per-process, not shared across a multi-process
 * gateway). The atomic single-use guarantee this class alone cannot
 * provide is enforced separately by {@link redeemTicket} against the real
 * store's `attach_tickets` table (see that function's TSDoc for why that
 * table, built for the deferred node-bound `AttachTicket`, is reused here).
 */
export class TicketRegistry {
  private readonly records = new Map<string, TicketRecord>();

  set(ticketId: string, record: TicketRecord): void {
    this.records.set(ticketId, record);
  }

  get(ticketId: string): TicketRecord | undefined {
    return this.records.get(ticketId);
  }

  delete(ticketId: string): void {
    this.records.delete(ticketId);
  }

  /** Drops every record whose `expiresAt` has passed. Call periodically; not required for correctness (redemption re-checks expiry). */
  sweepExpired(now: number): number {
    let dropped = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  size(): number {
    return this.records.size;
  }
}

/**
 * Mints a ticket: `tkt_<ULID>.<32 byte
 * base64url random>`, opaque, never a JWT. The ULID half is a `Store`
 * managed lookup key; the random half is a bearer secret whose SHA-256
 * hash is kept in `registry`, never persisted. A single row is inserted
 * into the `attach_tickets` table so the single-use guarantee at
 * {@link redeemTicket} is a real atomic compare-and-set against
 * `store-sqlite`, not an in-process check alone.
 */
export async function mintTicket(
  store: Store,
  registry: TicketRegistry,
  req: MintTicketRequest,
): Promise<MintedTicket> {
  const ticketId = newId('tkt');
  const secret = randomBytes(32);
  const now = Date.now();
  const expiresAt = now + req.ttlMs;

  await store.transaction((tx) => {
    tx.insert('attach_tickets', {
      id: ticketId,
      tenant_id: req.tenantId,
      node_id: req.nodeId,
      instance_id: req.instanceId,
      viewer_id: req.viewerId,
      epoch: req.epoch,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  registry.set(ticketId, {
    secretHash: createHash('sha256').update(secret).digest(),
    tenantId: req.tenantId,
    appId: req.appId,
    origin: req.origin,
    nodeId: req.nodeId,
    instanceId: req.instanceId,
    viewerId: req.viewerId,
    epoch: req.epoch,
    sessionId: req.sessionId,
    expiresAt,
  });

  return { token: `${ticketId}.${secret.toString('base64url')}`, ticketId, expiresAt };
}

/**
 * Redeems a ticket, consuming it. `Store.redeemAttachTicket` performs a
 * conditional `UPDATE ... WHERE redeemed_at IS NULL` inside `store-sqlite`,
 * which is the atomic boundary: two genuinely concurrent redemptions of the
 * same ticket race on that single UPDATE statement and exactly one sees
 * `changes > 0`. This is the mechanism a "redeemed twice" test exercises
 * directly.
 *
 * This reuses the `attach_tickets` table, which `store-sqlite` built for
 * the deferred `AttachTicket` (node bound, epoch fenced). The viewer's
 * simpler Ticket (Origin and appId bound, no node fencing concept) does
 * not need a dedicated table: its Origin/appId/session binding is checked
 * entirely from `registry`, an in-process record keyed by the ticket id,
 * so the `attach_tickets` row exists purely to provide the atomic
 * single-use guard the store already builds and verifies.
 */
export async function redeemTicket(
  store: Store,
  registry: TicketRegistry,
  token: string,
  opts: { readonly origin: string; readonly appId: AppId; readonly tenantId: TenantId },
): Promise<RedeemTicketResult> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid_ticket' };
  const ticketId = token.slice(0, dot);
  const secretB64url = token.slice(dot + 1);

  const record = registry.get(ticketId);
  if (record === undefined) return { ok: false, reason: 'invalid_ticket' };

  const now = Date.now();
  if (record.expiresAt <= now) {
    registry.delete(ticketId);
    return { ok: false, reason: 'ticket_expired' };
  }

  let secret: Buffer;
  try {
    secret = Buffer.from(secretB64url, 'base64url');
  } catch {
    return { ok: false, reason: 'invalid_ticket' };
  }
  const presentedHash = createHash('sha256').update(secret).digest();
  if (
    presentedHash.length !== record.secretHash.length ||
    !timingSafeEqual(presentedHash, record.secretHash)
  ) {
    return { ok: false, reason: 'invalid_ticket' };
  }

  if (
    record.origin !== opts.origin ||
    record.appId !== opts.appId ||
    record.tenantId !== opts.tenantId
  ) {
    return { ok: false, reason: 'origin_mismatch' };
  }

  const redeemed = await store.redeemAttachTicket({
    id: ticketId,
    tenantId: record.tenantId,
    nodeId: record.nodeId,
    instanceId: record.instanceId,
    viewerId: record.viewerId,
    epoch: record.epoch,
    redeemedAt: new Date(now).toISOString(),
  });

  if (!redeemed) {
    return { ok: false, reason: 'ticket_consumed' };
  }

  registry.delete(ticketId);
  return { ok: true, record, ticketId };
}
