/**
 * `toTargetSummary`'s per-window `active` computation.
 * `broadcastActiveFlags()` sets `active` per window, from
 * `activeTargetIds`, and `wire/target-summary.ts` populates `windowId` and
 * the per-window `active`. `active` is membership in `activeTargetIds`
 * (one entry per OS window under window isolation), not equality against
 * a single instance-wide id, so two targets in two different windows can
 * both be `active: true` at once.
 */
import { describe, expect, it } from 'vitest';
import { type TargetRuntimeLike, toTargetSummary } from '../../src/wire/target-summary.js';

function target(overrides: Partial<TargetRuntimeLike> & { id: string }): TargetRuntimeLike {
  return {
    type: 'page',
    title: 'Example',
    url: 'https://example.com/',
    faviconUrl: null,
    openerId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    order: 0,
    createdAt: 0,
    windowId: null,
    ...overrides,
  };
}

describe('toTargetSummary: per-window active', () => {
  it('is active when the target is a member of activeTargetIds, regardless of order', () => {
    const t = target({ id: 'tgt_a', windowId: 1 });
    const summary = toTargetSummary(t, { activeTargetIds: ['tgt_z', 'tgt_a'], viewerCount: 0 });
    expect(summary.active).toBe(true);
  });

  it('is not active when absent from activeTargetIds', () => {
    const t = target({ id: 'tgt_a', windowId: 1 });
    const summary = toTargetSummary(t, { activeTargetIds: ['tgt_z'], viewerCount: 0 });
    expect(summary.active).toBe(false);
  });

  it('two targets in two different windows can both be active at once (the window-isolation fix itself)', () => {
    const inWindow1 = target({ id: 'tgt_1', windowId: 1 });
    const inWindow2 = target({ id: 'tgt_2', windowId: 2 });
    const activeTargetIds = ['tgt_1', 'tgt_2'];
    expect(toTargetSummary(inWindow1, { activeTargetIds, viewerCount: 0 }).active).toBe(true);
    expect(toTargetSummary(inWindow2, { activeTargetIds, viewerCount: 0 }).active).toBe(true);
  });

  it('a background tab sharing an active window with another target is not active', () => {
    const active = target({ id: 'tgt_live', windowId: 1 });
    const background = target({ id: 'tgt_poll', windowId: 1 });
    const activeTargetIds = ['tgt_live'];
    expect(toTargetSummary(active, { activeTargetIds, viewerCount: 0 }).active).toBe(true);
    expect(toTargetSummary(background, { activeTargetIds, viewerCount: 0 }).active).toBe(false);
  });

  it('passes windowId through unchanged, including null for an unresolved window', () => {
    expect(
      toTargetSummary(target({ id: 'tgt_a', windowId: 7 }), { activeTargetIds: [], viewerCount: 0 })
        .windowId,
    ).toBe(7);
    expect(
      toTargetSummary(target({ id: 'tgt_b', windowId: null }), {
        activeTargetIds: [],
        viewerCount: 0,
      }).windowId,
    ).toBeNull();
  });
});
