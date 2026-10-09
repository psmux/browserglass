import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/control/clock.js';
import { DEFAULT_WATCHDOG_TIMING, FrameStalenessWatchdog } from '../../src/recovery/watchdog.js';

interface Harness {
  watchdog: FrameStalenessWatchdog;
  clock: ReturnType<typeof createManualClock>;
  staleCount: () => number;
  forceFrameCount: () => number;
  state: {
    participants: number;
    lastFrameAtMs: number;
    lastInputAtMs: number;
    busy: boolean;
    loading: boolean;
    dialogOpen: boolean;
  };
}

function makeHarness(overrides: Partial<Harness['state']> = {}): Harness {
  const clock = createManualClock();
  let stale = 0;
  let forced = 0;
  const state: Harness['state'] = {
    participants: 1,
    lastFrameAtMs: 0,
    lastInputAtMs: -DEFAULT_WATCHDOG_TIMING.watchdogInputGraceMs - 1, // outside the input grace by default
    busy: false,
    loading: false,
    dialogOpen: false,
    ...overrides,
  };
  const watchdog = new FrameStalenessWatchdog({
    clock,
    participantCount: () => state.participants,
    lastFrameAtMs: () => state.lastFrameAtMs,
    lastInputAtMs: () => state.lastInputAtMs,
    isBusy: () => state.busy,
    isLoading: () => state.loading,
    isDialogOpen: () => state.dialogOpen,
    forceFrame: async () => {
      forced += 1;
      return true;
    },
    onStale: () => {
      stale += 1;
    },
  });
  return { watchdog, clock, staleCount: () => stale, forceFrameCount: () => forced, state };
}

describe('FrameStalenessWatchdog', () => {
  it('does not fire with zero participants, even when everything else looks stale', async () => {
    const { watchdog, state, staleCount } = makeHarness({
      participants: 0,
      lastFrameAtMs: -1_000_000,
      loading: true,
    });
    await watchdog.tick();
    expect(staleCount()).toBe(0);
    void state;
  });

  it('does not fire within the input grace window', async () => {
    const { watchdog, clock, state, staleCount } = makeHarness({
      lastFrameAtMs: -1_000_000,
      loading: true,
    });
    state.lastInputAtMs = clock.monotonicNow(); // input just happened.
    await watchdog.tick();
    expect(staleCount()).toBe(0);
  });

  it('does not fire while an active session.busy declaration is in effect', async () => {
    const { watchdog, staleCount } = makeHarness({
      lastFrameAtMs: -1_000_000,
      loading: true,
      busy: true,
    });
    await watchdog.tick();
    expect(staleCount()).toBe(0);
  });

  it('self-heals with a forced frame instead of alarming when the target is not loading', async () => {
    const { watchdog, staleCount, forceFrameCount } = makeHarness({
      lastFrameAtMs: -1_000_000,
      loading: false,
    });
    await watchdog.tick();
    expect(staleCount()).toBe(0);
    expect(forceFrameCount()).toBe(1);
  });

  it('does not fire with an open JS dialog blocking the renderer by design', async () => {
    const { watchdog, staleCount } = makeHarness({
      lastFrameAtMs: -1_000_000,
      loading: true,
      dialogOpen: true,
    });
    await watchdog.tick();
    expect(staleCount()).toBe(0);
  });

  it('fires only once every guard has passed and the frame is genuinely stale', async () => {
    const { watchdog, staleCount } = makeHarness({
      lastFrameAtMs: -(DEFAULT_WATCHDOG_TIMING.watchdogSilenceMs + 1),
      loading: true,
      dialogOpen: false,
      busy: false,
    });
    await watchdog.tick();
    expect(staleCount()).toBe(1);
  });

  it('does not fire when the frame is recent, even while loading', async () => {
    const { watchdog, staleCount } = makeHarness({ lastFrameAtMs: -1000, loading: true });
    await watchdog.tick();
    expect(staleCount()).toBe(0);
  });

  it('post-recovery cooldown suppresses the watchdog after a successful screencast_silent R0, until it elapses', async () => {
    const { watchdog, clock, staleCount } = makeHarness({
      lastFrameAtMs: -(DEFAULT_WATCHDOG_TIMING.watchdogSilenceMs + 1),
      loading: true,
    });
    watchdog.noteRecoverySuccess('R0', 'screencast_silent');
    await watchdog.tick();
    expect(staleCount()).toBe(0); // suppressed by cooldown, even though the raw staleness check would otherwise fire.

    await clock.advance(DEFAULT_WATCHDOG_TIMING.watchdogPostRecoveryCooldownMs + 1);
    await watchdog.tick();
    expect(staleCount()).toBe(1); // cooldown elapsed; the watchdog is live again.
  });

  it('a successful rung other than R0, or a signal other than screencast_silent, does not arm the cooldown', async () => {
    const { watchdog, staleCount } = makeHarness({
      lastFrameAtMs: -(DEFAULT_WATCHDOG_TIMING.watchdogSilenceMs + 1),
      loading: true,
    });
    watchdog.noteRecoverySuccess('R2', 'target_crashed');
    await watchdog.tick();
    expect(staleCount()).toBe(1);
  });
});
