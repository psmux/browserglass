import type { Store } from '@browserglass/protocol';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TicketRegistry, mintTicket, redeemTicket } from '../../src/auth/tickets.js';

describe('tickets: mint and redeem', () => {
  let store: Store;

  beforeEach(async () => {
    store = await createSqliteStore(':memory:', { memory: true, migrate: 'auto' });
  });

  afterEach(async () => {
    await store.close();
  });

  it('redeems once and reports a bound token, origin, and expiry', async () => {
    const registry = new TicketRegistry();
    const minted = await mintTicket(store, registry, {
      tenantId: 'ten_00000000000000000000000000' as never,
      appId: 'app_00000000000000000000000000' as never,
      origin: 'https://app.example.com',
      nodeId: 'nod_local',
      instanceId: 'inst_1',
      viewerId: 'vwr_1',
      epoch: 0,
      ttlMs: 30000,
    });

    expect(minted.token).toMatch(/^tkt_[0-7][0-9A-HJKMNP-TV-Z]{25}\.[A-Za-z0-9_-]{43}$/);

    const result = await redeemTicket(store, registry, minted.token, {
      origin: 'https://app.example.com',
      appId: 'app_00000000000000000000000000' as never,
      tenantId: 'ten_00000000000000000000000000' as never,
    });
    expect(result.ok).toBe(true);
  });

  it('a ticket redeemed twice returns ticket_consumed, driven by real concurrent redemption against store-sqlite', async () => {
    const registry = new TicketRegistry();
    const minted = await mintTicket(store, registry, {
      tenantId: 'ten_00000000000000000000000000' as never,
      appId: 'app_00000000000000000000000000' as never,
      origin: 'https://app.example.com',
      nodeId: 'nod_local',
      instanceId: 'inst_1',
      viewerId: 'vwr_1',
      epoch: 0,
      ttlMs: 30000,
    });

    const redeemOpts = {
      origin: 'https://app.example.com',
      appId: 'app_00000000000000000000000000' as never,
      tenantId: 'ten_00000000000000000000000000' as never,
    };

    // Fire both redemption attempts without awaiting the first: this races
    // them through the async store.redeemAttachTicket() call, which is
    // where the real compare-and-set against store-sqlite happens.
    const [a, b] = await Promise.all([
      redeemTicket(store, registry, minted.token, redeemOpts),
      redeemTicket(store, registry, minted.token, redeemOpts),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { ok: false; reason: string }).reason).toBe('ticket_consumed');
  });

  it('rejects a ticket presented with a different secret than was minted', async () => {
    const registry = new TicketRegistry();
    const minted = await mintTicket(store, registry, {
      tenantId: 'ten_00000000000000000000000000' as never,
      appId: 'app_00000000000000000000000000' as never,
      origin: 'https://app.example.com',
      nodeId: 'nod_local',
      instanceId: 'inst_1',
      viewerId: 'vwr_1',
      epoch: 0,
      ttlMs: 30000,
    });
    const forged = `${minted.token.split('.')[0]}.${'A'.repeat(43)}`;
    const result = await redeemTicket(store, registry, forged, {
      origin: 'https://app.example.com',
      appId: 'app_00000000000000000000000000' as never,
      tenantId: 'ten_00000000000000000000000000' as never,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a ticket presented with the wrong Origin', async () => {
    const registry = new TicketRegistry();
    const minted = await mintTicket(store, registry, {
      tenantId: 'ten_00000000000000000000000000' as never,
      appId: 'app_00000000000000000000000000' as never,
      origin: 'https://app.example.com',
      nodeId: 'nod_local',
      instanceId: 'inst_1',
      viewerId: 'vwr_1',
      epoch: 0,
      ttlMs: 30000,
    });
    const result = await redeemTicket(store, registry, minted.token, {
      origin: 'https://evil.example.com',
      appId: 'app_00000000000000000000000000' as never,
      tenantId: 'ten_00000000000000000000000000' as never,
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe('origin_mismatch');
  });
});
