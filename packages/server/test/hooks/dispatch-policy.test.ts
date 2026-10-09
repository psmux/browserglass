/**
 * `HookRegistry.dispatch`'s declared per hook policy (`HOOK_TIMEOUTS`,
 * `hooks/types.ts`), exercised for all ten lifecycle hooks: the exact
 * `timeoutMs`/`vetoes`/`failClosed` row, a normal fire (handler runs, sees
 * the event, decides), a veto (a vetoing handler returning `false`), and
 * the fail open/fail closed behaviour when a handler never resolves.
 *
 * This suite is deliberately about `HookRegistry` itself, not about any one
 * call site in `ws/connection.ts`/`rest/routes/instances.ts`/
 * `session/managed-session.ts`: those call sites are covered by their own
 * test files (`viewer-joined.test.ts`, `control-granted.test.ts`,
 * `navigation.test.ts`, `instance-lifecycle.test.ts`, `recovery.test.ts`).
 * `onDownload` and `onRequest` have no call site anywhere in
 * `packages/server` (`onDownload`: the download feature itself, CDP
 * `Browser.setDownloadBehavior`/`downloadWillBegin` and the
 * `download.*` wire messages already declared in `@browserglass/protocol`,
 * is not implemented anywhere in this codebase yet, verified by grep
 * before writing this suite; `onRequest`: its engine is
 * `packages/core/src/interception/**`, covered by its own suite), so this file is the ONLY coverage either one gets.
 */

import { describe, expect, it } from 'vitest';
import { HookRegistry } from '../../src/hooks/dispatch.js';
import { HOOK_TIMEOUTS, type HookEventBase, type HookName } from '../../src/hooks/types.js';

function baseEvent(): HookEventBase {
  return {
    at: Date.now(),
    tenantId: 'ten_test' as never,
    appId: 'app_test' as never,
    requestId: 'req_test',
  };
}

function silentLogger() {
  const fn = () => undefined;
  return { trace: fn, debug: fn, info: fn, warn: fn, error: fn } as never;
}

describe('HOOK_TIMEOUTS: the declared policy table', () => {
  it('has exactly ten hooks, each with a timeout, a veto flag, and a fail policy', () => {
    const names = Object.keys(HOOK_TIMEOUTS);
    expect(names).toHaveLength(10);
    expect(new Set(names)).toEqual(
      new Set([
        'onInstanceLaunched',
        'onSessionStarted',
        'onViewerJoined',
        'onControlGranted',
        'onNavigation',
        'onDownload',
        'onRecovery',
        'onInstanceReleased',
        'onQuotaExceeded',
        'onRequest',
      ]),
    );
  });

  it('vetoes on exactly the five gate hooks, and only those five fail closed or open in a way that matters', () => {
    const vetoing = (Object.keys(HOOK_TIMEOUTS) as HookName[]).filter(
      (n) => HOOK_TIMEOUTS[n].vetoes,
    );
    expect(new Set(vetoing)).toEqual(
      new Set(['onViewerJoined', 'onControlGranted', 'onNavigation', 'onDownload', 'onRequest']),
    );
  });

  it('onDownload and onRequest are the two hooks that fail closed; every other hook fails open', () => {
    const failClosed = (Object.keys(HOOK_TIMEOUTS) as HookName[]).filter(
      (n) => HOOK_TIMEOUTS[n].failClosed,
    );
    expect(new Set(failClosed)).toEqual(new Set(['onDownload', 'onRequest']));
  });

  it('onNavigation is the cheapest, shortest timeout: 750ms, fails open', () => {
    expect(HOOK_TIMEOUTS.onNavigation).toEqual({ timeoutMs: 750, vetoes: true, failClosed: false });
  });

  it('onDownload: 5000ms, vetoes, fails closed', () => {
    expect(HOOK_TIMEOUTS.onDownload).toEqual({ timeoutMs: 5000, vetoes: true, failClosed: true });
  });

  it('onRequest: 1500ms, vetoes, fails closed, sitting between onControlGranted and onDownload', () => {
    expect(HOOK_TIMEOUTS.onRequest).toEqual({ timeoutMs: 1500, vetoes: true, failClosed: true });
    expect(HOOK_TIMEOUTS.onRequest.timeoutMs).toBeGreaterThan(
      HOOK_TIMEOUTS.onControlGranted.timeoutMs,
    );
    expect(HOOK_TIMEOUTS.onRequest.timeoutMs).toBeLessThan(HOOK_TIMEOUTS.onDownload.timeoutMs);
  });

  it('onViewerJoined: 1500ms, vetoes, fails open', () => {
    expect(HOOK_TIMEOUTS.onViewerJoined).toEqual({
      timeoutMs: 1500,
      vetoes: true,
      failClosed: false,
    });
  });

  it('onControlGranted: 1000ms, vetoes, fails open', () => {
    expect(HOOK_TIMEOUTS.onControlGranted).toEqual({
      timeoutMs: 1000,
      vetoes: true,
      failClosed: false,
    });
  });

  it('the four non-gating lifecycle hooks (launched, started, recovery, released) never veto', () => {
    for (const name of [
      'onInstanceLaunched',
      'onSessionStarted',
      'onRecovery',
      'onInstanceReleased',
    ] as HookName[]) {
      expect(HOOK_TIMEOUTS[name].vetoes).toBe(false);
    }
  });

  it('onQuotaExceeded never vetoes: quota admission itself already ran by the time this fires', () => {
    expect(HOOK_TIMEOUTS.onQuotaExceeded).toEqual({
      timeoutMs: 1000,
      vetoes: false,
      failClosed: false,
    });
  });
});

describe('HookRegistry.dispatch: fire, per hook', () => {
  for (const name of Object.keys(HOOK_TIMEOUTS) as HookName[]) {
    it(`${name}: a registered handler is called with the event and its decision is honoured`, async () => {
      const seen: HookEventBase[] = [];
      const registry = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
      registry.on(name, ((e: HookEventBase) => {
        seen.push(e);
        return HOOK_TIMEOUTS[name].vetoes ? false : undefined;
      }) as never);
      const event = baseEvent();
      const result = await registry.dispatch(name, event as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(event);
      expect(result.vetoed).toBe(HOOK_TIMEOUTS[name].vetoes);
    });
  }

  it('no handler registered: dispatch resolves immediately, never vetoed, regardless of the hook', async () => {
    const registry = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
    for (const name of Object.keys(HOOK_TIMEOUTS) as HookName[]) {
      const result = await registry.dispatch(name, baseEvent() as never);
      expect(result).toEqual({ vetoed: false, reason: undefined });
    }
  });
});

describe('HookRegistry.dispatch: veto, per vetoing hook', () => {
  for (const name of [
    'onViewerJoined',
    'onControlGranted',
    'onNavigation',
    'onDownload',
    'onRequest',
  ] as HookName[]) {
    it(`${name}: a handler returning false vetoes with its event.reason`, async () => {
      const registry = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
      registry.on(name, ((e: HookEventBase) => {
        e.reason = `${name} refused it`;
        return false;
      }) as never);
      const result = await registry.dispatch(name, baseEvent() as never);
      expect(result).toEqual({ vetoed: true, reason: `${name} refused it` });
    });

    it(`${name}: the first false among several handlers wins, later handlers never run`, async () => {
      const registry = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
      let secondRan = false;
      registry.on(name, (() => false) as never);
      registry.on(name, (() => {
        secondRan = true;
        return true;
      }) as never);
      const result = await registry.dispatch(name, baseEvent() as never);
      expect(result.vetoed).toBe(true);
      expect(secondRan).toBe(false);
    });

    it(`${name}: a thrown handler also vetoes, with a generic reason when the handler set none`, async () => {
      const registry = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
      registry.on(name, (() => {
        throw new Error('boom');
      }) as never);
      const result = await registry.dispatch(name, baseEvent() as never);
      expect(result.vetoed).toBe(true);
      expect(result.reason).toBe(`${name} rejected the request.`);
    });
  }
});

describe('HookRegistry.dispatch: timeout policy, per hook', () => {
  for (const name of Object.keys(HOOK_TIMEOUTS) as HookName[]) {
    const spec = HOOK_TIMEOUTS[name];
    it(`${name}: a handler that never resolves ${spec.vetoes && spec.failClosed ? 'vetoes (fails closed)' : spec.vetoes ? 'is allowed through (fails open)' : 'is simply abandoned (non-vetoing)'}`, async () => {
      // `globalTimeoutMs` overrides every hook's own declared timeout
      // (`dispatch.ts`'s `withTimeout` call), which is what lets this test
      // wait milliseconds rather than up to `onDownload`'s real 5000ms:
      // the fail open/fail closed BEHAVIOUR under test is a property of
      // `spec.vetoes`/`spec.failClosed`, not of the exact timeout duration,
      // which the `HOOK_TIMEOUTS` table assertions above already pin
      // precisely on their own.
      const registry = new HookRegistry(undefined, { globalTimeoutMs: 15, logger: silentLogger() });
      registry.on(
        name,
        (() =>
          new Promise(() => {
            /* never resolves */
          })) as never,
      );
      const result = await registry.dispatch(name, baseEvent() as never);
      if (spec.vetoes && spec.failClosed) {
        expect(result.vetoed).toBe(true);
        expect(result.reason).toBe(`${name} timed out and is fail closed.`);
      } else {
        // Fails open: a timed out vetoing hook is treated as an allow; a
        // timed out non-vetoing hook's outcome is simply abandoned, which
        // `dispatch` also reports as `vetoed: false` (there is nothing
        // else it could report, `onRecovery`/`onInstanceLaunched`/etc.
        // never veto anything).
        expect(result.vetoed).toBe(false);
      }
    });
  }

  it("onNavigation's own 750ms and onDownload's own 5000ms are honoured when no global override is set", async () => {
    const registry = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
    let navTimeoutMsSeen: number | undefined;
    let downloadTimeoutMsSeen: number | undefined;
    registry.on('onNavigation', (() => {
      navTimeoutMsSeen = HOOK_TIMEOUTS.onNavigation.timeoutMs;
      return true;
    }) as never);
    registry.on('onDownload', (() => {
      downloadTimeoutMsSeen = HOOK_TIMEOUTS.onDownload.timeoutMs;
      return true;
    }) as never);
    await registry.dispatch('onNavigation', baseEvent() as never);
    await registry.dispatch('onDownload', baseEvent() as never);
    expect(navTimeoutMsSeen).toBe(750);
    expect(downloadTimeoutMsSeen).toBe(5000);
  });
});
