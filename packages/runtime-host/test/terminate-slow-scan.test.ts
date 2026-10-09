/**
 * `confirmProfileClear` against a fake process table whose scans are slow.
 *
 * Under load a full process scan on Windows was seen at about 5 s. With a
 * fixed 15 s budget that left room for two kill rounds at most, and a
 * plain release then answered E_TERMINATE_FAILED while Chrome was still
 * on its way out. These tests run on a virtual clock: a scan advances it
 * by a scripted amount, so a 5 s scan costs no real time.
 */
import { describe, expect, it } from 'vitest';
import type { ChromeProcessInfo } from '../src/process-table.js';
import { type ProfileClearDeps, confirmProfileClear } from '../src/terminate.js';

const PROFILE = 'C:\\fake\\profile';

interface FakeProc {
  pid: number;
  /** Kill attempts this process survives before it dies. */
  survivesKills: number;
  /** Virtual time at which it exits on its own, if ever. */
  exitsAt?: number;
}

/** A process table on a virtual clock. Scans see the table as it was when they started. */
function fakeTable(procs: FakeProc[], scanMs: (scanIndex: number) => number) {
  let now = 0;
  let scans = 0;
  let kills = 0;
  const alive = new Map(procs.map((p) => [p.pid, { ...p }]));
  const isAlive = (pid: number): boolean => {
    const p = alive.get(pid);
    if (!p) return false;
    if (p.exitsAt !== undefined && now >= p.exitsAt) {
      alive.delete(pid);
      return false;
    }
    return true;
  };
  const deps: ProfileClearDeps = {
    scan: async (): Promise<ChromeProcessInfo[]> => {
      const snapshot = [...alive.keys()].filter(isAlive).map((pid) => ({
        pid,
        ppid: 1,
        commandLine: `"C:\\chrome.exe" --user-data-dir=${PROFILE}`,
      }));
      now += scanMs(scans);
      scans += 1;
      return snapshot;
    },
    kill: async (pid) => {
      kills += 1;
      now += 50;
      const p = alive.get(pid);
      if (!p) return;
      if (p.survivesKills > 0) p.survivesKills -= 1;
      else alive.delete(pid);
    },
    pidAlive: isAlive,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    budgetMs: 15_000,
    hardCapMs: 60_000,
    minKillRounds: 3,
  };
  return {
    deps,
    stats: () => ({ now, scans, kills }),
  };
}

describe('confirmProfileClear: slow scans', () => {
  it('keeps going past the 15 s base budget while 5 s scans leave room for too few kill rounds', async () => {
    // Survives two kills, dies on the third. With 5 s scans the old loop
    // gave up after its third scan at about 15 s, before the third kill.
    const table = fakeTable([{ pid: 100, survivesKills: 2 }], () => 5_000);
    const result = await confirmProfileClear(PROFILE, () => undefined, table.deps);
    expect(result.clear).toBe(true);
    expect(result.rounds).toBe(3);
    expect(table.stats().now).toBeGreaterThan(15_000);
    expect(table.stats().now).toBeLessThan(60_000);
  });

  it('does not count a process that died while the scan was running as a straggler', async () => {
    // Chrome exits on its own 2 s into an 8 s scan. The scan still lists it.
    const table = fakeTable([{ pid: 200, survivesKills: 99, exitsAt: 2_000 }], () => 8_000);
    const result = await confirmProfileClear(PROFILE, () => undefined, table.deps);
    expect(result.clear).toBe(true);
    expect(result.rounds).toBe(0);
    expect(table.stats().kills).toBe(0);
  });

  it('extends while stragglers keep changing, then clears', async () => {
    // Chrome hands the profile from one process to the next: each kill
    // works, but a new holder shows up behind it. Progress every round.
    const procs: FakeProc[] = [
      { pid: 301, survivesKills: 0 },
      { pid: 302, survivesKills: 1 },
      { pid: 303, survivesKills: 3 },
    ];
    const table = fakeTable(procs, () => 4_000);
    const result = await confirmProfileClear(PROFILE, () => undefined, table.deps);
    expect(result.clear).toBe(true);
    expect(result.rounds).toBe(4);
  });

  it('still gives up on a process that never dies, within the hard cap, after the minimum rounds', async () => {
    const table = fakeTable([{ pid: 400, survivesKills: Number.POSITIVE_INFINITY }], () => 6_000);
    const result = await confirmProfileClear(PROFILE, () => undefined, table.deps);
    expect(result.clear).toBe(false);
    if (!result.clear) expect(result.lastSeen.map((p) => p.pid)).toEqual([400]);
    expect(result.rounds).toBeGreaterThanOrEqual(3);
    expect(table.stats().now).toBeLessThanOrEqual(60_000 + 6_000);
  });

  it('a fast scan and a process that never dies still gives up near the base budget', async () => {
    const table = fakeTable([{ pid: 500, survivesKills: Number.POSITIVE_INFINITY }], () => 100);
    const result = await confirmProfileClear(PROFILE, () => undefined, table.deps);
    expect(result.clear).toBe(false);
    expect(table.stats().now).toBeGreaterThanOrEqual(15_000);
    expect(table.stats().now).toBeLessThan(16_000);
  });

  it('never runs past the hard cap even when every scan is slower than the cap allows', async () => {
    const table = fakeTable([{ pid: 600, survivesKills: Number.POSITIVE_INFINITY }], () => 25_000);
    const result = await confirmProfileClear(PROFILE, () => undefined, table.deps);
    expect(result.clear).toBe(false);
    expect(table.stats().now).toBeLessThanOrEqual(60_000 + 25_000);
  });
});
