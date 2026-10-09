/**
 * `packages/server/src/session/factory.ts`'s two `createTargetRegistry`
 * call sites used to pass only four arguments, never the fifth
 * (`proxyAuthCredentials`), even though `BrowserSpec.proxy.username`/
 * `.password` reach this process on every `view.instance.spec` this file
 * already reads. `packages/runtime-host/src/runtime.ts`'s
 * `proxyAuthPerInstance: false` note names this exact gap. This test
 * drives a real `TargetRegistry` (via `createManagedSessionFactory`
 * against a `FakeChromeServer`, the same pattern
 * `factory-init-scripts.test.ts` uses) and asserts two things:
 *
 *  1. Credentials reach `core.ProxyAuthHandler` for real: attaching a
 *     target sends a real `Fetch.enable{handleAuthRequests: true}`, and a
 *     simulated `Fetch.authRequired{source: 'Proxy'}` challenge gets a
 *     real `Fetch.continueWithAuth` carrying the configured username and
 *     password.
 *  2. The password never appears ANYWHERE else: not in any other CDP
 *     call's params, not in a captured log line, and not in a thrown
 *     error's message. That "never leaks" guarantee needs a test of its
 *     own.
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

const PASSWORD = 'super-secret-proxy-password';

function fakeRouter(
  chrome: FakeChromeServer,
  sessionId: string,
  proxy: {
    server: string;
    bypass: string[];
    username: string | null;
    password: string | null;
  } | null,
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
          spec: { isolation: 'tab', initScripts: [], proxy },
          runtime: { cdpWsUrl: chrome.url },
        },
      };
    },
  } as unknown as BrowserRouter;
}

function capturingLogger(): { logger: unknown; lines: string[] } {
  const lines: string[] = [];
  const record = (msg: string): void => {
    lines.push(msg);
  };
  return {
    lines,
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (_f: unknown, m: string) => record(m),
      error: (_f: unknown, m: string) => record(m),
    },
  };
}

/** Polls `chrome.cdpCalls` until one matching `method` appears, or throws. */
async function waitForCdpCall(
  chrome: FakeChromeServer,
  method: string,
): Promise<{ method: string; params: Record<string, unknown>; sessionId: string | undefined }> {
  for (let i = 0; i < 200; i++) {
    const hit = chrome.cdpCalls.find((c) => c.method === method);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `no ${method} call observed; saw ${JSON.stringify(chrome.cdpCalls.map((c) => c.method))}`,
  );
}

let chrome: FakeChromeServer;

afterEach(async () => {
  await chrome?.close();
});

describe('createManagedSessionFactory: BrowserSpec.proxy.username/password reaches ProxyAuthHandler', () => {
  it('arms Fetch on attach, and a real auth challenge gets a real continueWithAuth carrying the configured credentials', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });

    const instanceId = newId('inst');
    const { logger, lines } = capturingLogger();
    const router = fakeRouter(chrome, newId('sess'), {
      server: 'http://proxy.example:8080',
      bypass: [],
      username: 'proxyuser',
      password: PASSWORD,
    });
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
      logger as never,
    );
    const managed = await factory(instanceId, ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      expect(targetId).toBeDefined();
      await managed.registry.attach(targetId as never);

      const enableCall = await waitForCdpCall(chrome, 'Fetch.enable');
      expect(enableCall.params['handleAuthRequests']).toBe(true);

      // `emitFetchAuthRequired` (like `emitDownloadWillBegin`/`emitScreencastFrame`)
      // keys its internal `sessionsByTargetId` map by the raw CDP
      // targetId this test registered ('cdp-a'), not the BrowserGlass
      // `tgt_...` id `listTargets()` reports.
      chrome.emitFetchAuthRequired('cdp-a', { requestId: 'auth-req-1' });
      const continueCall = await waitForCdpCall(chrome, 'Fetch.continueWithAuth');
      const response = continueCall.params['authChallengeResponse'] as Record<string, unknown>;
      expect(response['response']).toBe('ProvideCredentials');
      expect(response['username']).toBe('proxyuser');
      expect(response['password']).toBe(PASSWORD);

      // NEVER LEAKS: the password appears in exactly the one CDP call
      // that is its documented, correct carrier, and nowhere else -- not
      // in any other CDP call this attach produced, and not in anything
      // this factory logged.
      for (const call of chrome.cdpCalls) {
        if (call === continueCall) continue;
        expect(JSON.stringify(call.params)).not.toContain(PASSWORD);
      }
      expect(lines.join('\n')).not.toContain(PASSWORD);
    } finally {
      managed.dispose();
    }
  });

  it('arms nothing when the spec proxy has only one half of the credential pair', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
    });

    const instanceId = newId('inst');
    const router = fakeRouter(chrome, newId('sess'), {
      server: 'http://proxy.example:8080',
      bypass: [],
      username: 'proxyuser',
      password: null,
    });
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
    );
    const managed = await factory(instanceId, ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      expect(targetId).toBeDefined();
      await managed.registry.attach(targetId as never);

      // No proxy credentials means no reason to arm Fetch at all: no
      // `RequestGate` is active either in this test, so `Fetch.enable`
      // must not appear.
      const fetchEnableCalls = chrome.cdpCalls.filter((c) => c.method === 'Fetch.enable');
      expect(fetchEnableCalls).toHaveLength(0);
    } finally {
      managed.dispose();
    }
  });

  it('arms nothing when spec.proxy is null', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-c',
      type: 'page',
      title: 'C',
      url: 'https://c.example',
      attached: false,
    });

    const instanceId = newId('inst');
    const router = fakeRouter(chrome, newId('sess'), null);
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
    );
    const managed = await factory(instanceId, ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      expect(targetId).toBeDefined();
      await managed.registry.attach(targetId as never);
      expect(chrome.cdpCalls.filter((c) => c.method === 'Fetch.enable')).toHaveLength(0);
    } finally {
      managed.dispose();
    }
  });
});
