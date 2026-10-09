/**
 * `session/lease-holders.ts` is the single place the server asks "is this
 * viewer ONE OF the holders" instead of "is this viewer THE holder", and it
 * is deliberately the only place that will have to change when
 * `@browserglass/core`'s `Lease` grows its shared-mode holders collection.
 *
 * These tests pin both halves of that: the exclusive behaviour every call
 * site had before (so the refactor cannot have quietly changed today's
 * answers), and the plural behaviour those call sites need the day the
 * collection arrives. The second group is what stops the seam being written
 * and then found, months later, to have been a passthrough that never
 * actually handled more than one holder.
 */
import { describe, expect, it } from 'vitest';
import { isLeaseHolder, leaseHoldersOf } from '../../src/session/lease-holders.js';

const alice = { viewerId: 'vwr_alice', label: 'Alice' };
const bob = { viewerId: 'vwr_bob', label: 'Bob' };

describe('lease-holders: exclusive leases behave exactly as the inline checks did', () => {
  it('an unheld lease has no holders', () => {
    expect(leaseHoldersOf({ holder: null })).toEqual([]);
    expect(isLeaseHolder({ holder: null }, 'vwr_alice')).toBe(false);
  });

  it('a singular holder reads back as a one-element list', () => {
    expect(leaseHoldersOf({ holder: alice })).toEqual([alice]);
    expect(isLeaseHolder({ holder: alice }, 'vwr_alice')).toBe(true);
    expect(isLeaseHolder({ holder: alice }, 'vwr_bob')).toBe(false);
  });
});

describe('lease-holders: shared leases admit several holders at once', () => {
  it('every holder in the collection is a holder', () => {
    const lease = { holder: alice, holders: [alice, bob] };
    expect(leaseHoldersOf(lease)).toEqual([alice, bob]);
    expect(isLeaseHolder(lease, 'vwr_alice')).toBe(true);
    expect(isLeaseHolder(lease, 'vwr_bob')).toBe(true);
    expect(isLeaseHolder(lease, 'vwr_carol')).toBe(false);
  });

  it('an empty holders collection means unheld, whatever the singular holder says', () => {
    // The collection is authoritative once present, and this is a defensive
    // contract rather than a shape the engine can currently produce:
    // `@browserglass/core` defines `Lease.holder` as a getter over
    // `holders[0]`, so the two cannot disagree there. The server reads
    // SNAPSHOTS, though, and a snapshot is a spread that materialises those
    // getters into plain fields, which is exactly the kind of copy that can
    // drift from its source later. Stating which side wins costs nothing
    // now and removes the question entirely.
    const lease = { holder: alice, holders: [] };
    expect(leaseHoldersOf(lease)).toEqual([]);
    expect(isLeaseHolder(lease, 'vwr_alice')).toBe(false);
  });
});
