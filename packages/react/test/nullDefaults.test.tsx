import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConsole } from '../src/useConsole.js';
import { useControlLease } from '../src/useControlLease.js';
import { useInstanceStats } from '../src/useInstanceStats.js';
import { useNav } from '../src/useNav.js';
import { useNetwork } from '../src/useNetwork.js';
import { usePresence } from '../src/usePresence.js';
import { useTargets } from '../src/useTargets.js';

/**
 * Every hook returns usable defaults for `client: null`. `useBrowserGlass` is covered separately (its `client:
 * null` default is exercised throughout `strictmode.test.tsx`); the other
 * seven all accept `client | null` directly and are asserted here.
 */
describe('hooks return sensible defaults for client: null', () => {
  it('useTargets', async () => {
    const { result } = renderHook(() => useTargets(null));
    expect(result.current.targets).toEqual([]);
    expect(result.current.activeTargetId).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.canManage).toBe(false);
    await expect(result.current.open()).rejects.toThrow();
  });

  it('useNav', () => {
    const { result } = renderHook(() => useNav(null, null));
    expect(result.current.url).toBe('');
    expect(result.current.loading).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.canNavigate).toBe(false);
    expect(result.current.blocked).toBeNull();
    expect(() => result.current.dismissBlocked()).not.toThrow();
  });

  it('useControlLease', () => {
    const { result } = renderHook(() => useControlLease(null, null));
    expect(result.current.hasControl).toBe(false);
    expect(result.current.holder).toBeNull();
    expect(result.current.queuePosition).toBeNull();
    expect(result.current.queueLength).toBe(0);
    expect(result.current.canRequest).toBe(false);
    expect(result.current.requesting).toBe(false);
  });

  it('usePresence', () => {
    const { result } = renderHook(() => usePresence(null));
    expect(result.current.viewers).toEqual([]);
    expect(result.current.me).toBeNull();
    expect(result.current.others).toEqual([]);
    expect(result.current.cursors.size).toBe(0);
  });

  it('useInstanceStats', () => {
    const { result } = renderHook(() => useInstanceStats(null));
    expect(result.current.fps).toBe(0);
    expect(result.current.rttMs).toBe(0);
    expect(result.current.backlog).toBe(0);
    expect(result.current.droppedFrames).toBe(0);
    expect(result.current.codec).toBeNull();
    expect(result.current.quality).toBeNull();
    expect(result.current.streams).toEqual([]);
  });

  it('useConsole', () => {
    const { result } = renderHook(() => useConsole(null, null));
    expect(result.current.entries).toEqual([]);
    expect(() => result.current.clear()).not.toThrow();
  });

  it('useNetwork', () => {
    const { result } = renderHook(() => useNetwork(null, null));
    expect(result.current.entries).toEqual([]);
    expect(() => result.current.clear()).not.toThrow();
  });
});
