/**
 * The fourth argument of `createTargetRegistry`, which
 * `packages/server/src/session/factory.ts` never passed.
 *
 * `TargetRegistryImpl`'s constructor takes
 * `(instanceId, bridge, initScripts, stealth)`. Both call sites in that
 * file passed three arguments, and the fourth defaults to `null`, so a
 * `StealthProfile` registered with `runtime-host` had its `launchArgs`
 * applied to the Chrome command line and its `initScripts(spec)` and
 * `onTargetAttached` resolved and then thrown away. Nothing said so. The
 * launch reported the profile as having run, `LaunchedBrowser.stealthProfile`
 * recorded its name and version, and no patch reached a page.
 *
 * Two halves are asserted here, and the second matters more than the
 * first:
 *
 *  1. A registered profile's per target work now actually happens.
 *  2. `stealth: 'off'` still means off. Fixing (1) is the change that
 *     could turn a previously inert profile live on a browser that never
 *     wanted one, and the profile that ships in this repo
 *     (`BASIC_STEALTH_PROFILE`) injects the exact `navigator.webdriver`
 *     getter that, stacked on `--disable-blink-features=AutomationControlled`,
 *     has been seen to retrigger an hCaptcha challenge on real world forms.
 *     So "off is off" is tested directly rather than assumed from the null
 *     default.
 */

import { type BrowserSpec, type StealthProfile, newId } from '@browserglass/protocol';
import type { BrowserRouter } from '@browserglass/router';
import { afterEach, describe, expect, it } from 'vitest';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';
import { createManagedSessionFactory, resolveStealthHooks } from '../../src/session/factory.js';
import type { ManagedSessionFactoryContext } from '../../src/session/registry.js';
import { type FakeChromeServer, startFakeChromeServer } from '../ws/support/fake-chrome-server.js';

const ctx: ManagedSessionFactoryContext = {
  tenantId: 'ten_test',
  appId: 'app_test',
  onIdle: () => undefined,
};

const STEALTH_SOURCE = 'window.__bgls_stealth_ran__ = 1;';

/** A minimal profile whose three members are all observable from the fake Chrome's CDP call log. */
function testProfile(over: Partial<StealthProfile> = {}): StealthProfile {
  return {
    name: 'test-profile',
    level: 'basic',
    version: '1.0.0',
    validatedChromeMajors: [],
    launchArgs: () => [],
    initScripts: () => [{ name: 'test-stealth', source: STEALTH_SOURCE }],
    onTargetAttached: async (c) => {
      await c.send('Emulation.setAutomationOverride', { enabled: false });
    },
    selfTest: async () => [],
    ...over,
  } as StealthProfile;
}

function fakeRouter(
  chrome: FakeChromeServer,
  sessionId: string,
  stealthRef: { name: string; level: 'basic' | 'full'; version: string } | null,
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
          spec: { isolation: 'tab', initScripts: [] },
          runtime: { cdpWsUrl: chrome.url, stealthProfile: stealthRef },
        },
      };
    },
  } as unknown as BrowserRouter;
}

let chrome: FakeChromeServer | undefined;

afterEach(async () => {
  // Cleared as well as closed. The pure-function describe below runs after
  // the session tests and starts no server of its own, and closing an
  // already closed one throws "The server is not running", which fails a
  // test that never touched a socket.
  const running = chrome;
  chrome = undefined;
  await running?.close();
});

describe('createManagedSessionFactory: a registered stealth profile reaches the page', () => {
  it("installs the profile's init scripts and runs onTargetAttached on a real attach", async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });

    const profile = testProfile();
    const router = fakeRouter(chrome, newId('sess'), {
      name: 'test-profile',
      level: 'basic',
      version: '1.0.0',
    });
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
      undefined,
      undefined,
      undefined,
      undefined,
      [profile],
    );
    const managed = await factory(newId('inst'), ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      await managed.registry.attach(targetId as never);

      const installed = chrome.cdpCalls.filter(
        (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument',
      );
      expect(installed.some((c) => c.params['source'] === STEALTH_SOURCE)).toBe(true);
      expect(chrome.cdpCalls.some((c) => c.method === 'Emulation.setAutomationOverride')).toBe(
        true,
      );
    } finally {
      managed.dispose();
    }
  });

  /**
   * The regression guard. `spec.stealth: 'off'` resolves no profile in
   * `runtime-host` (`resolveRequiredStealthProfile` returns null for it),
   * so the launch records none, so nothing here has anything to look up,
   * EVEN THOUGH a profile is registered on this gateway. If this test ever
   * fails, a browser that asked for no stealth is running
   * `BASIC_STEALTH_PROFILE`'s `navigator.webdriver` getter on top of
   * `--disable-blink-features=AutomationControlled`, a combination that
   * can score worse on bot checks than plain Playwright does.
   */
  it('applies nothing at all when the launch recorded no profile, even with profiles registered', async () => {
    chrome = await startFakeChromeServer();
    chrome.targetInfos.push({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
    });

    const router = fakeRouter(chrome, newId('sess'), null);
    const factory = createManagedSessionFactory(
      () => ({ router, nodeId: 'nod_test' }) as unknown as RouterWiring,
      undefined,
      undefined,
      undefined,
      undefined,
      [testProfile()],
    );
    const managed = await factory(newId('inst'), ctx);
    try {
      const targetId = managed.listTargets()[0]?.targetId;
      await managed.registry.attach(targetId as never);

      expect(
        chrome.cdpCalls.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'),
      ).toHaveLength(0);
      expect(chrome.cdpCalls.some((c) => c.method === 'Emulation.setAutomationOverride')).toBe(
        false,
      );
    } finally {
      managed.dispose();
    }
  });
});

/**
 * The lookup itself, tested directly, because its failure cases are the
 * ones a session test cannot show cleanly: they throw before a session
 * exists.
 */
describe('resolveStealthHooks', () => {
  const spec = { stealth: 'basic' } as unknown as BrowserSpec;

  it('returns null for a launch that recorded no profile', () => {
    expect(resolveStealthHooks(null, spec, [testProfile()])).toBeNull();
    expect(resolveStealthHooks(undefined, spec, [testProfile()])).toBeNull();
  });

  it('resolves the live initScripts and onTargetAttached for an exact name, level and version match', () => {
    const hooks = resolveStealthHooks(
      { name: 'test-profile', level: 'basic', version: '1.0.0' },
      spec,
      [testProfile()],
    );
    expect(hooks?.initScripts).toEqual([{ name: 'test-stealth', source: STEALTH_SOURCE }]);
    expect(typeof hooks?.onTargetAttached).toBe('function');
  });

  it('refuses a name this gateway has never heard of, rather than applying nothing quietly', () => {
    expect(() =>
      resolveStealthHooks({ name: 'somebody-elses', level: 'basic', version: '1.0.0' }, spec, [
        testProfile(),
      ]),
    ).toThrow(/has no profile registered under that name/);
  });

  /**
   * `StealthProfile.version` is semver for the profile's own CONTENT (its
   * own doc says to bump it whenever a patch changes), so two processes
   * holding different revisions of one name hold two different sets of
   * patches. Applying the gateway's revision to a browser launched under
   * the runtime's would produce an environment neither side described, and
   * would do it silently, which is the failure this whole change exists to
   * stop happening.
   */
  it('refuses a version mismatch on a name it does have', () => {
    expect(() =>
      resolveStealthHooks({ name: 'test-profile', level: 'basic', version: '2.0.0' }, spec, [
        testProfile(),
      ]),
    ).toThrow(/refusing to apply a different revision/);
  });

  it('refuses a level mismatch on the same name and version', () => {
    expect(() =>
      resolveStealthHooks({ name: 'test-profile', level: 'full', version: '1.0.0' }, spec, [
        testProfile(),
      ]),
    ).toThrow(/refusing to apply a different revision/);
  });
});
