import type { LeaseState, ViewerPresence } from '@browserglass/client';
import { describe, expect, it } from 'vitest';
import { driversOf } from '../src/usePresence.js';

/**
 * `driversOf` is the whole multi-driver story in one pure function, so it
 * is tested without a client, a socket, or a render.
 *
 * The two branches under test are the two sources of truth and the order
 * of preference between them: `LeaseState.holders`, which is complete and
 * identical for every recipient, and `ViewerPresence.controlling`, which
 * covers the window before the first `control.state` arrives.
 */
function viewer(overrides: Partial<ViewerPresence> & { viewerId: string }): ViewerPresence {
  return {
    label: overrides.viewerId,
    kind: 'human',
    colour: '#64b5f6',
    controlling: [],
    watching: [],
    idle: false,
    joinedAt: 0,
    ...overrides,
  };
}

function holder(viewerId: string, connected = true): LeaseState['holders'][number] {
  return { viewerId, label: viewerId, grantedAt: 0, expiresAt: 0, connected };
}

function lease(holders: LeaseState['holders']): Pick<LeaseState, 'holders'> {
  return { holders };
}

describe('driversOf()', () => {
  describe('from the lease, which is the authority', () => {
    it('returns nobody for an unheld lease, whatever presence still claims', () => {
      const viewers = [viewer({ viewerId: 'stale', controlling: ['tgt_1'] })];
      expect(driversOf(lease([]), viewers, 'tgt_1', 'me')).toEqual([]);
    });

    it('returns every concurrent holder, not just the first', () => {
      const drivers = driversOf(lease([holder('a'), holder('c')]), [], 'tgt_1', null);
      expect(drivers.map((d) => d.viewerId)).toEqual(['a', 'c']);
    });

    /**
     * Grant order, longest tenured first, is what the server sends and what
     * this preserves. Re-sorting so that this viewer came first would make
     * every other driver's segment of the demo's driver rail jump the
     * moment somebody took control.
     */
    it('keeps the server order rather than promoting this viewer', () => {
      const drivers = driversOf(lease([holder('a'), holder('me'), holder('b')]), [], 'tgt_1', 'me');
      expect(drivers.map((d) => d.viewerId)).toEqual(['a', 'me', 'b']);
      expect(drivers.map((d) => d.isMe)).toEqual([false, true, false]);
    });

    it('joins each holder to their presence colour, which the cursor and the badge both draw from', () => {
      const viewers = [
        viewer({ viewerId: 'a', colour: '#e57373' }),
        viewer({ viewerId: 'b', colour: '#81c784' }),
      ];
      const drivers = driversOf(lease([holder('a'), holder('b')]), viewers, 'tgt_1', null);
      expect(drivers.map((d) => d.colour)).toEqual(['#e57373', '#81c784']);
    });

    it('gives a holder with no presence entry a neutral colour rather than a colour belonging to somebody else', () => {
      const viewers = [viewer({ viewerId: 'a', colour: '#e57373' })];
      const drivers = driversOf(lease([holder('ghost')]), viewers, 'tgt_1', null);
      expect(drivers[0]?.colour).toBe('#7d8590');
    });

    it('carries the disconnect grace through, so a driver whose socket dropped is not shown as present', () => {
      const drivers = driversOf(lease([holder('a', false)]), [], 'tgt_1', null);
      expect(drivers[0]?.connected).toBe(false);
    });
  });

  /**
   * The agent-versus-person distinction, which is the whole reason the
   * roster is joined in rather than the lease read alone.
   * `LeaseState.holders` carries viewerId, label, two timestamps and
   * `connected`, and nothing that says what is behind the lease, so a UI
   * wanting to draw a robot driver differently had nowhere honest to read
   * it from. `ViewerPresence.kind` is the server's own answer.
   */
  describe('what is driving, not just who', () => {
    it('reports an automation holder as an agent, from the roster', () => {
      const viewers = [viewer({ viewerId: 'bot', kind: 'agent' })];
      expect(driversOf(lease([holder('bot')]), viewers, 'tgt_1', null)[0]?.kind).toBe('agent');
    });

    it('reports a person as human', () => {
      const viewers = [viewer({ viewerId: 'a' })];
      expect(driversOf(lease([holder('a')]), viewers, 'tgt_1', null)[0]?.kind).toBe('human');
    });

    /**
     * The honest degrade, and the reason this is not defaulted to
     * `'human'`. A holder with no roster entry is either a grant the
     * presence rebroadcast has not caught up with yet or the synthetic
     * viewer the REST control path borrows a lease under, and calling
     * either one a person would put a person's mark on something that is
     * not one.
     */
    it('says unknown, not human, for a holder the roster does not describe', () => {
      expect(driversOf(lease([holder('ghost')]), [], 'tgt_1', null)[0]?.kind).toBe('unknown');
    });

    it('reads the kind straight off the roster on the presence fallback path', () => {
      const viewers = [
        viewer({ viewerId: 'bot', kind: 'agent', controlling: ['tgt_1'] }),
        viewer({ viewerId: 'a', controlling: ['tgt_1'] }),
      ];
      expect(driversOf(null, viewers, 'tgt_1', null).map((d) => d.kind)).toEqual([
        'agent',
        'human',
      ]);
    });

    it('keeps kind and colour on the same holder when a person and an agent share a tab', () => {
      const viewers = [
        viewer({ viewerId: 'bot', kind: 'agent', colour: '#c0a3ff' }),
        viewer({ viewerId: 'a', colour: '#81c784' }),
      ];
      const drivers = driversOf(lease([holder('bot'), holder('a')]), viewers, 'tgt_1', 'a');
      expect(drivers.map((d) => [d.kind, d.colour])).toEqual([
        ['agent', '#c0a3ff'],
        ['human', '#81c784'],
      ]);
    });
  });

  describe('from presence, before the first control.state arrives', () => {
    it('falls back to controlling when there is no lease record yet', () => {
      const viewers = [
        viewer({ viewerId: 'a', controlling: ['tgt_1'] }),
        viewer({ viewerId: 'b', controlling: ['tgt_2'] }),
        viewer({ viewerId: 'c', controlling: ['tgt_1', 'tgt_2'] }),
      ];
      expect(driversOf(null, viewers, 'tgt_1', null).map((d) => d.viewerId)).toEqual(['a', 'c']);
    });

    it('marks this viewer on the fallback path too', () => {
      const viewers = [viewer({ viewerId: 'me', controlling: ['tgt_1'] })];
      expect(driversOf(null, viewers, 'tgt_1', 'me')[0]?.isMe).toBe(true);
    });

    it('returns nobody when no viewer is controlling the target', () => {
      const viewers = [
        viewer({ viewerId: 'a', controlling: ['tgt_2'] }),
        viewer({ viewerId: 'b' }),
      ];
      expect(driversOf(null, viewers, 'tgt_1', 'a')).toEqual([]);
    });
  });
});
