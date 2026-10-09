/**
 * `onSessionStarted`, fired from `session/factory.ts`'s
 * `createManagedSessionFactory` right before it constructs the fresh
 * `ManagedSession` it is about to return. This is the one and only place
 * it can honestly fire: `SessionRegistry.getOrCreate` (`registry.ts`) calls
 * this factory exactly once per genuinely NEW session, never on a second
 * viewer joining an already-live one (`registry.ts`'s own join-in-flight
 * doc). `ws/connection.ts`'s own test harness (`test/ws/support/test-gateway.ts`)
 * deliberately bypasses this factory (its own module doc: it builds
 * `ManagedSession` directly against a fake Chrome server, skipping
 * `@browserglass/router` entirely), so `onSessionStarted` cannot be
 * exercised end to end from a WS test the way `onViewerJoined`/
 * `onControlGranted`/`onNavigation` are; this suite drives
 * `createManagedSessionFactory` directly instead, against a minimal fake
 * router exposing only the two methods the factory calls
 * (`driveInstance`, `describe`), the same style `test/rest/instances-affinity.test.ts`'s
 * own `fakeRouter` uses.
 *
 * Non-vetoing (`HOOK_TIMEOUTS.onSessionStarted`), so there is no veto case;
 * the fail-open timeout policy is covered generically in
 * `dispatch-policy.test.ts`.
 */

import { newId } from '@browserglass/protocol';
import type { BrowserRouter } from '@browserglass/router';
import { afterEach, describe, expect, it } from 'vitest';
import { HookRegistry } from '../../src/hooks/dispatch.js';
import type { SessionStartedEvent } from '../../src/hooks/types.js';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';
import { createManagedSessionFactory } from '../../src/session/factory.js';
import type { ManagedSessionFactoryContext } from '../../src/session/registry.js';
import { type FakeChromeServer, startFakeChromeServer } from '../ws/support/fake-chrome-server.js';

function silentLogger() {
  const fn = () => undefined;
  return { trace: fn, debug: fn, info: fn, warn: fn, error: fn } as never;
}

function fakeRouter(chrome: FakeChromeServer, sessionId: string): BrowserRouter {
  return {
    async driveInstance() {
      return { local: true, nodeId: 'nod_test' };
    },
    async describe(instanceId: unknown) {
      return {
        instance: {
          id: instanceId,
          sessionId,
          spec: { isolation: 'tab' },
          runtime: { cdpWsUrl: chrome.url },
        },
      };
    },
  } as unknown as BrowserRouter;
}

const ctx: ManagedSessionFactoryContext = {
  tenantId: 'ten_test',
  appId: 'app_test',
  onIdle: () => undefined,
};

let chrome: FakeChromeServer;

afterEach(async () => {
  await chrome?.close();
});

describe('onSessionStarted: fire', () => {
  it('fires exactly once, with the real instanceId/sessionId, right before the ManagedSession is handed back', async () => {
    chrome = await startFakeChromeServer();
    const sessionId = newId('sess');
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
    const seen: SessionStartedEvent[] = [];
    hooks.on('onSessionStarted', (e) => {
      seen.push(e);
    });

    const instanceId = newId('inst');
    const router = fakeRouter(chrome, sessionId);
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
      undefined,
      undefined,
      hooks,
    );
    const managed = await factory(instanceId, ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.instanceId).toBe(instanceId);
    expect(seen[0]!.sessionId).toBe(sessionId);
    expect(seen[0]!.tenantId).toBe('ten_test');
    expect(managed.sessionId).toBe(sessionId);
    managed.dispose();
  });

  it('a handler that throws is swallowed: session construction still succeeds', async () => {
    chrome = await startFakeChromeServer();
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 0, logger: silentLogger() });
    hooks.on('onSessionStarted', () => {
      throw new Error('boom');
    });

    const instanceId = newId('inst');
    const router = fakeRouter(chrome, newId('sess'));
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
      undefined,
      undefined,
      hooks,
    );
    const managed = await factory(instanceId, ctx);
    expect(managed.instanceId).toBe(instanceId);
    managed.dispose();
  });
});
