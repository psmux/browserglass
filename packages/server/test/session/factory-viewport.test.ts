/**
 * `spec.viewport` is the page viewport, exactly. A host launched headless
 * Chrome used to size its page from `--window-size`, which is the outer
 * window: 1280x860 came out as a 1280x718 page and `deviceScaleFactor` was
 * ignored. `factory.ts` now forces the spec viewport on every page target
 * with `Emulation.setDeviceMetricsOverride`, and tells `ManagedSession`
 * the size so it reads the exact viewport back.
 */

import { type BrowserSpec, type StealthTargetContext, newId } from '@browserglass/protocol';
import type { BrowserRouter } from '@browserglass/router';
import { afterEach, describe, expect, it } from 'vitest';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';
import {
  createManagedSessionFactory,
  emulatedViewportFor,
  resolveViewportHook,
} from '../../src/session/factory.js';
import type { ManagedSessionFactoryContext } from '../../src/session/registry.js';
import { type FakeChromeServer, startFakeChromeServer } from '../ws/support/fake-chrome-server.js';

const ctx: ManagedSessionFactoryContext = {
  tenantId: 'ten_test',
  appId: 'app_test',
  onIdle: () => undefined,
};

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3 };

function spec(viewport: BrowserSpec['viewport'] = VIEWPORT): BrowserSpec {
  return { isolation: 'tab', initScripts: [], viewport } as unknown as BrowserSpec;
}

function fakeRouter(chrome: FakeChromeServer): BrowserRouter {
  return {
    async driveInstance() {
      return { local: true, nodeId: 'nod_test' };
    },
    async describe(instanceId: unknown) {
      return {
        instance: {
          id: instanceId,
          sessionId: newId('sess'),
          spec: spec(),
          runtime: { kind: 'host', cdpWsUrl: chrome.url, stealthProfile: null },
        },
      };
    },
  } as unknown as BrowserRouter;
}

function hookContext(targetType: 'page' | 'iframe') {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const c: StealthTargetContext = {
    cdpSessionId: 's1',
    targetId: 't1',
    targetType,
    evaluate: async () => undefined,
    send: async (method, params) => {
      sent.push({ method, ...(params ? { params } : {}) });
      return {};
    },
  };
  return { c, sent };
}

let chrome: FakeChromeServer | undefined;
const savedEnv = process.env['BGLS_REMOTE_NO_EMULATION'];

afterEach(async () => {
  const running = chrome;
  chrome = undefined;
  await running?.close();
  if (savedEnv === undefined) delete process.env['BGLS_REMOTE_NO_EMULATION'];
  else process.env['BGLS_REMOTE_NO_EMULATION'] = savedEnv;
});

describe('resolveViewportHook', () => {
  it('forces the spec viewport, scale factor included, on a page target', async () => {
    const hook = resolveViewportHook(spec(), 'host');
    const { c, sent } = hookContext('page');
    await hook?.onTargetAttached(c);
    expect(sent).toEqual([
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: false },
      },
    ]);
  });

  it('leaves an out of process iframe alone, since the override would resize the frame', async () => {
    const hook = resolveViewportHook(spec(), 'host');
    const { c, sent } = hookContext('iframe');
    await hook?.onTargetAttached(c);
    expect(sent).toEqual([]);
  });

  it('honours BGLS_REMOTE_NO_EMULATION=1 for a remote browser only', () => {
    process.env['BGLS_REMOTE_NO_EMULATION'] = '1';
    expect(resolveViewportHook(spec(), 'remote')).toBeNull();
    expect(emulatedViewportFor(spec(), 'remote')).toBeNull();
    expect(resolveViewportHook(spec(), 'host')).not.toBeNull();
  });

  it('does nothing for a spec without a usable viewport', () => {
    expect(emulatedViewportFor({ initScripts: [] } as unknown as BrowserSpec, 'host')).toBeNull();
    expect(
      emulatedViewportFor(spec({ width: 0, height: 0, deviceScaleFactor: 1 }), 'host'),
    ).toBeNull();
  });
});

describe('createManagedSessionFactory: the spec viewport reaches every page', () => {
  it('sends the override on attach and reports the spec size as the viewport', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    // What real Chrome reports with a vertical scrollbar: 15px narrower.
    chrome.setLayoutViewport(375, 844);
    const router = fakeRouter(chrome);
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
    );
    const managed = await factory(newId('inst'), ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      await managed.registry.attach(targetId as never);
      const override = chrome.cdpCalls.find(
        (c) => c.method === 'Emulation.setDeviceMetricsOverride',
      );
      expect(override?.params).toMatchObject({ width: 390, height: 844, deviceScaleFactor: 3 });
      expect(await managed.instanceViewport()).toEqual({ width: 390, height: 844 });
    } finally {
      managed.dispose();
    }
  });
});
