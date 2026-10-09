/**
 * `Session.createTarget()`'s transparent relaunch path (see that method's
 * own doc in `../../src/session/session.ts` for the full reasoning).
 *
 * The defect this covers: under `isolation: 'window'` every streamed
 * target is a whole OS window, so closing every pane closes every window,
 * and headful Chrome exits the moment its last window closes, taking the
 * CDP WebSocket down with it (measured directly, not assumed, in
 * `packages/runtime-host/test/spike/spike-keep-alive.ts`). The very next
 * `target.new` used to fail outright with `CdpError: Target.createTarget
 * rejected, the bridge closed`, because `TargetRegistryImpl.create()` was
 * called against a bridge whose WebSocket no longer existed. These tests
 * use the same fake CDP endpoint the rest of `test/cdp/**` and
 * `test/session/session.test.ts` already use, so no real Chrome process is
 * needed to prove the bridge-dead detection and single-flighted relaunch
 * work.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge, CdpBridgeOptions } from '../../src/cdp/bridge.js';
import type { TargetRegistry } from '../../src/cdp/target-registry.js';
import { createManualClock } from '../../src/control/clock.js';
import { CrashBudget } from '../../src/recovery/crash-budget.js';
import { Session } from '../../src/session/session.js';
import { type StartedFakeRegistry, startFakeRegistry } from '../cdp/test-helpers.js';

/**
 * `CdpBridgeImpl` no longer finalizes an unexpected socket close
 * synchronously (`../../src/cdp/reconnect.ts`): it first spends a bounded
 * budget trying to reconnect the same transport, and only reaches `'closed'`
 * once that budget gives up. This suite is about `Session.createTarget()`'s
 * OWN dead-bridge detection and relaunch, layered on top of, not
 * instead of, that reconnect attempt, so its fake bridges are built with a
 * zero-attempt budget: the reconnect loop gives up on the very first check,
 * with no real dial and no backoff wait, so `state` still reaches `'closed'`
 * deterministically fast, just not in the same synchronous tick as
 * `simulateClose` (an unexpected close always finalizes asynchronously now,
 * even with nothing left to retry).
 */
const NO_RECONNECT_ATTEMPTS: CdpBridgeOptions = {
  reconnect: { budget: new CrashBudget(600_000, 0) },
};

/** Flushes the microtask queue: a `setTimeout` callback always runs after every currently queued microtask has drained, regardless of how many `await` hops separate `simulateClose()` from `finalizeClose()`. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Scripts `Target.createTarget`/`Target.getTargetInfo` on `fake`'s socket so `TargetRegistry.create()` can actually succeed against it, matching what a real relaunched browser answers. `installDefaultResponder` (`../cdp/fake-cdp-endpoint.ts`) leaves both unhandled (a bare `{}`), which is fine for every existing test that never calls `registry.create()`, but this suite does. */
function scriptTargetCreation(fake: StartedFakeRegistry): { createdCount: () => number } {
  let created = 0;
  const original = fake.socket.autoRespond;
  fake.socket.autoRespond = (msg, socket) => {
    if (msg.method === 'Target.createTarget') {
      created += 1;
      socket.emitResult(msg.id, { targetId: `cdp-new-${created}` });
      return;
    }
    if (msg.method === 'Target.getTargetInfo') {
      const targetId = msg.params?.['targetId'] as string;
      socket.emitResult(msg.id, {
        targetInfo: { targetId, type: 'page', title: '', url: 'about:blank', attached: false },
      });
      return;
    }
    original?.(msg, socket);
  };
  return { createdCount: () => created };
}

describe('Session.createTarget: transparent relaunch after the browser process exits', () => {
  it('a target.new against a still-open bridge never touches restartInstanceExecutor', async () => {
    const fake = await startFakeRegistry();
    scriptTargetCreation(fake);
    let executorCalls = 0;
    const session = new Session({
      id: 'sess_live' as never,
      instanceId: fake.instanceId,
      tenantId: 't',
      nodeId: 'n',
      bridge: fake.bridge,
      registry: fake.registry,
      clock: createManualClock(),
      onEffect: () => {},
      restartInstanceExecutor: async () => {
        executorCalls += 1;
        return { ok: true, bridge: fake.bridge, registry: fake.registry };
      },
    });
    session.provision();

    const target = await session.createTarget({});
    expect(target.type).toBe('page');
    expect(executorCalls).toBe(0);
  });

  it('a dead bridge (every window already closed) is relaunched exactly once even when three target.new calls race, and every caller gets a real target back', async () => {
    const dead = await startFakeRegistry(undefined, undefined, NO_RECONNECT_ATTEMPTS);
    // Every pane closed already took the browser process, and so this
    // WebSocket, down with it; no viewer or `PerTargetState` needs setting
    // up first, since `createTarget()`'s own check is on `bridge.state`
    // directly, matching the real defect (the browser has zero targets and
    // zero windows at the moment `target.new` next arrives).
    dead.socket.simulateClose(1006, 'abnormal closure');
    await flushMicrotasks();
    expect(dead.bridge.state).toBe('closed');

    const relaunched = await startFakeRegistry();
    relaunched.world.targetInfos = [];
    const { createdCount } = scriptTargetCreation(relaunched);

    let executorCalls = 0;
    const restartInstanceExecutor = async (): Promise<
      | { readonly ok: false }
      | { readonly ok: true; readonly bridge: CdpBridge; readonly registry: TargetRegistry }
    > => {
      executorCalls += 1;
      return { ok: true, bridge: relaunched.bridge, registry: relaunched.registry };
    };

    const session = new Session({
      id: 'sess_dead' as never,
      instanceId: dead.instanceId,
      tenantId: 't',
      nodeId: 'n',
      bridge: dead.bridge,
      registry: dead.registry,
      clock: createManualClock(),
      onEffect: () => {},
      restartInstanceExecutor,
    });
    session.provision();

    // Three panes opened at once: three `target.new` calls racing with no
    // await between them, exactly the concurrency the original bug report
    // ("opens three panes at once") describes. `Promise.all` starts all
    // three synchronously, matching the single-flight guard's own
    // requirement that the check-and-set in `createTarget()` never yields
    // before the second and third callers see `relaunchInFlight` already
    // set.
    const results = await Promise.all([
      session.createTarget({}),
      session.createTarget({}),
      session.createTarget({}),
    ]);

    expect(executorCalls).toBe(1);
    expect(createdCount()).toBe(3);
    expect(results.map((t) => t.type)).toEqual(['page', 'page', 'page']);
    // Three distinct targets, not the same one handed back three times.
    expect(new Set(results.map((t) => t.id)).size).toBe(3);
  });

  it('a relaunch that genuinely fails leaves the bridge dead and target.new fails honestly, without ever calling registry.create() a second time', async () => {
    const dead = await startFakeRegistry(undefined, undefined, NO_RECONNECT_ATTEMPTS);
    dead.socket.simulateClose(1006, 'abnormal closure');
    await flushMicrotasks();

    let executorCalls = 0;
    const session = new Session({
      id: 'sess_fail' as never,
      instanceId: dead.instanceId,
      tenantId: 't',
      nodeId: 'n',
      bridge: dead.bridge,
      registry: dead.registry,
      clock: createManualClock(),
      onEffect: () => {},
      restartInstanceExecutor: async () => {
        executorCalls += 1;
        return { ok: false };
      },
    });
    session.provision();

    await expect(session.createTarget({})).rejects.toBeTruthy();
    expect(executorCalls).toBe(1);
    expect(dead.bridge.state).toBe('closed');
  });
  it('a target.new that reaches a browser mid-quit (no windows left, socket not yet dropped) waits for the drop, relaunches once, and succeeds', async () => {
    // The race a slow machine hits: every window closed, Chrome is quitting,
    // but its WebSocket is still up, so `bridge.state` is still 'open' and
    // `Target.createTarget` reaches a browser that answers "Failed to open
    // a new tab". The socket drops a moment later.
    const quitting = await startFakeRegistry(undefined, undefined, NO_RECONNECT_ATTEMPTS);
    expect(quitting.registry.tabs()).toEqual([]);
    const original = quitting.socket.autoRespond;
    quitting.socket.autoRespond = (msg, socket) => {
      if (msg.method === 'Target.createTarget') {
        socket.emitError(msg.id, { code: -32000, message: 'Failed to open a new tab' });
        setTimeout(() => socket.simulateClose(1006, 'browser quit'), 0);
        return;
      }
      original?.(msg, socket);
    };

    const relaunched = await startFakeRegistry();
    relaunched.world.targetInfos = [];
    const { createdCount } = scriptTargetCreation(relaunched);

    let executorCalls = 0;
    const session = new Session({
      id: 'sess_quitting' as never,
      instanceId: quitting.instanceId,
      tenantId: 't',
      nodeId: 'n',
      bridge: quitting.bridge,
      registry: quitting.registry,
      clock: createManualClock(),
      onEffect: () => {},
      restartInstanceExecutor: async () => {
        executorCalls += 1;
        return { ok: true, bridge: relaunched.bridge, registry: relaunched.registry };
      },
    });
    session.provision();

    const target = await session.createTarget({});
    expect(target.type).toBe('page');
    expect(executorCalls).toBe(1);
    expect(createdCount()).toBe(1);
  });

  it('a target.new that fails on a browser with no windows whose socket stays open is reported as the real failure, with no relaunch', async () => {
    const live = await startFakeRegistry();
    expect(live.registry.tabs()).toEqual([]);
    const original = live.socket.autoRespond;
    live.socket.autoRespond = (msg, socket) => {
      if (msg.method === 'Target.createTarget') {
        socket.emitError(msg.id, { code: -32000, message: 'Failed to open a new tab' });
        return;
      }
      original?.(msg, socket);
    };

    const clock = createManualClock();
    let executorCalls = 0;
    const session = new Session({
      id: 'sess_real_failure' as never,
      instanceId: live.instanceId,
      tenantId: 't',
      nodeId: 'n',
      bridge: live.bridge,
      registry: live.registry,
      clock,
      onEffect: () => {},
      restartInstanceExecutor: async () => {
        executorCalls += 1;
        return { ok: false };
      },
    });
    session.provision();

    const pending = session.createTarget({});
    const settled = pending.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await flushMicrotasks();
    await clock.advance(5000);
    expect(await settled).toMatch(/Failed to open a new tab/);
    expect(executorCalls).toBe(0);
    expect(live.bridge.state).toBe('open');
  });
});
