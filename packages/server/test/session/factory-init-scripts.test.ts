/**
 * `packages/server/src/session/factory.ts`'s two `createTargetRegistry`
 * call sites (fresh attach, and `buildRestartInstanceExecutor`'s restart)
 * used to pass only `(instanceId, bridge)`, never a third argument, even
 * though `createTargetRegistry`'s own doc comment
 * (`core/src/cdp/target-registry.ts`) says the caller assembling a fresh
 * `CdpBridge`/registry pair owns passing `BrowserSpec.initScripts` through.
 * The parameter defaults to `[]` precisely so a caller that forgets this
 * keeps compiling, which is exactly what made the gap silent: an
 * operator's `spec.initScripts` was accepted, stored, and never once
 * reached a real page through the server path, on every gateway this
 * build could run.
 *
 * This test drives a real `TargetRegistry` (via `createManagedSessionFactory`
 * against a `FakeChromeServer`, the same pattern `session-started.test.ts`
 * uses) and asserts the init script actually reaches Chrome: the fake
 * records every CDP call it receives (`chrome.cdpCalls`), so a real
 * `Page.addScriptToEvaluateOnNewDocument` with the right `source` is
 * observable without reaching into `TargetRegistry`'s own internals.
 */

import { newId } from '@browserglass/protocol';
import type { BrowserRouter } from '@browserglass/router';
import { afterEach, describe, expect, it } from 'vitest';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';
import { createManagedSessionFactory } from '../../src/session/factory.js';
import type { ManagedSessionFactoryContext } from '../../src/session/registry.js';
import { type FakeChromeServer, startFakeChromeServer } from '../ws/support/fake-chrome-server.js';

const ctx: ManagedSessionFactoryContext = {
  tenantId: 'ten_test',
  appId: 'app_test',
  onIdle: () => undefined,
};

const INIT_SCRIPT = { name: 'test-marker', source: 'window.__bgls_test_marker__ = 1;' };

function fakeRouter(
  chrome: FakeChromeServer,
  sessionId: string,
  initScripts: readonly { name: string; source: string }[],
): BrowserRouter {
  return {
    async driveInstance() {
      return { local: true, nodeId: 'nod_test' };
    },
    async describe(instanceId: unknown) {
      return {
        instance: {
          id: instanceId,
          sessionId,
          spec: { isolation: 'tab', initScripts },
          runtime: { cdpWsUrl: chrome.url },
        },
      };
    },
  } as unknown as BrowserRouter;
}

let chrome: FakeChromeServer;

afterEach(async () => {
  await chrome?.close();
});

describe('createManagedSessionFactory: spec.initScripts reaches the TargetRegistry', () => {
  it('installs spec.initScripts once the target is actually attached, via a real Page.addScriptToEvaluateOnNewDocument call', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });

    const instanceId = newId('inst');
    const router = fakeRouter(chrome, newId('sess'), [INIT_SCRIPT]);
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
    );
    const managed = await factory(instanceId, ctx);
    try {
      // `TargetRegistry.attach()` is the explicit, on-demand attach path
      // (`core/src/cdp/target-registry.ts`'s own doc: "the second of the
      // two places a page session comes into existence", the other being
      // Chrome's own auto-attach push, which this fake harness does not
      // simulate for a pre-existing target, `session-started.test.ts`'s
      // own `fakeRouter` never needing one is why). It awaits
      // `installInitScripts` before returning, so every real caller that
      // needs a live session for a target (`ManagedSession.navigate`/
      // `.capture`/`.probe`, all via `ensureAttached`) goes through the
      // exact code path this test drives directly.
      const targetId = managed.listTargets()[0]?.targetId;
      expect(targetId).toBeDefined();
      await managed.registry.attach(targetId as never);

      const installed = chrome.cdpCalls.filter(
        (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument',
      );
      expect(installed.length).toBeGreaterThan(0);
      expect(installed.some((c) => c.params['source'] === INIT_SCRIPT.source)).toBe(true);
    } finally {
      managed.dispose();
    }
  });

  it('installs no scripts when spec.initScripts is empty, matching pre-fix behaviour for that case', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
    });

    const instanceId = newId('inst');
    const router = fakeRouter(chrome, newId('sess'), []);
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
    );
    const managed = await factory(instanceId, ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      expect(targetId).toBeDefined();
      await managed.registry.attach(targetId as never);

      const installed = chrome.cdpCalls.filter(
        (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument',
      );
      expect(installed).toHaveLength(0);
    } finally {
      managed.dispose();
    }
  });
});
