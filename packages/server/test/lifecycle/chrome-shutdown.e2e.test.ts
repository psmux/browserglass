/**
 * The guarantee this shutdown path exists for: every browser the app
 * launched dies when the app exits. Launches the actual
 * Chrome installed on this machine through the real `@browserglass/router`
 * and `@browserglass/runtime-host` (not a fake `NodeTransport`, unlike
 * `stop.test.ts`'s phase-ordering unit tests in this same directory), then
 * calls `bg.stop()` and asserts the OS process is actually gone.
 *
 * Exercises `runStop`'s new `runtime.dispose()` backstop and the
 * parallel, correctly-budgeted phase 5 terminate end to end, against a real terminate ladder rather than a stub that always
 * resolves instantly.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppId,
  CAPABILITIES,
  type Capability,
  type Principal,
  type TenantId,
  newId,
} from '@browserglass/protocol';
import {
  type HostRuntime,
  chromeProcsForDataDir,
  createHostRuntime,
  createProfileFs,
  killProcessTree,
} from '@browserglass/runtime-host';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { generateEd25519KeyMaterial } from '../../src/auth/jwt.js';
import type { AppSigningKey } from '../../src/config/types.js';
import { type BrowserGlass, createBrowserGlass } from '../../src/index.js';

/**
 * A short-path temp root. Mirrors `packages/conformance/test/e2e/support/real-gateway.ts`'s
 * `shortTempRoot`: `ProfileFs`'s canonical layout
 * (`<profileRoot>/tenants/<tenantId>/profiles/<profileId>/udd`) alone runs
 * past 80 characters once the ULIDs are in it, and `runtime-host` refuses
 * anything over 120 characters on Windows, so the OS default temp dir is
 * too deep on its own. Reimplemented locally rather than imported:
 * `packages/conformance` is a separate package, and this file
 * cannot depend on its `test/**` (nothing outside that package can).
 */
function shortTempRoot(prefix: string): string {
  if (process.platform === 'win32') {
    const base = join(process.env['SystemDrive'] ?? 'C:', 'bglstmp');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }
  return mkdtempSync(join(tmpdir(), prefix));
}

function launcherPrincipal(tenantId: TenantId, appId: AppId): Principal {
  return {
    tenantId,
    appId,
    sub: 'test:launcher',
    subKind: 'service',
    caps: [...CAPABILITIES] as Capability[],
    scope: { kind: 'tenant' },
    jti: 'test-launcher',
    exp: Number.MAX_SAFE_INTEGER,
  };
}

const workDirsToClean: string[] = [];
const runtimesToDispose: HostRuntime[] = [];
const bgsToStop: BrowserGlass[] = [];

afterEach(async () => {
  // Belt and suspenders, same reasoning as `runtime.e2e.test.ts`'s shared
  // `afterEach`: a failed assertion above must never leave a real Chrome
  // window on this machine.
  for (const bg of bgsToStop.splice(0)) {
    await bg.stop({ deadlineMs: 20_000, instances: 'release' }).catch(() => undefined);
  }
  for (const runtime of runtimesToDispose.splice(0)) {
    await runtime.dispose().catch(() => undefined);
  }
  for (const dir of workDirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

describe('bg.stop() and real Chrome', () => {
  it('a Chrome instance launched through the real router does not survive bg.stop()', async () => {
    const tenantId = newId('ten') as TenantId;
    const appId = newId('app') as AppId;
    const workDir = shortTempRoot('bgls-stop-e2e-');
    workDirsToClean.push(workDir);
    const dbPath = join(workDir, 'control.db');
    const profileRoot = join(workDir, 'p');
    const stateDir = join(workDir, 's');
    mkdirSync(profileRoot, { recursive: true });

    const store = await createSqliteStore(dbPath, { migrate: 'auto' });
    await store.createTenant({ id: tenantId, name: 'Test Tenant' });
    await store.createApp({ id: appId, tenantId, name: 'Test App' });

    // `killOnShutdown: true`, exactly what the demo sets, and an option that
    // used to be dead code: nothing in `@browserglass/server` ever called
    // `dispose()` before `runStop`'s new backstop. This test would fail
    // without that fix if phase 5's own terminate call somehow missed the
    // instance; with the fix in place it is redundant with phase 5's own
    // terminate, which is exactly the "backstop" relationship this
    // asserts.
    const { runtime } = await createHostRuntime({
      nodeId: `nod_test_${Math.random().toString(36).slice(2, 10)}`,
      stateDir,
      profileRoot,
      killOnShutdown: true,
    });
    runtimesToDispose.push(runtime);
    const fs = createProfileFs({ root: profileRoot });

    const spec = await store.upsertBrowserSpec(tenantId, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'new',
      viewportW: 1280,
      viewportH: 720,
      dpr: 1,
      locale: null,
      timezone: null,
      userAgent: null,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off',
      isolation: 'tab',
      limits: {},
    });
    await store.createPool({ tenantId, name: 'default', specId: spec.id });

    // `router.acquire()` below uses `launcherPrincipal`, whose `sub`
    // ('test:launcher') is not `SYSTEM_PRINCIPAL.sub`. `BrowserRouter.buildResult`
    // (`router/src/router/BrowserRouter.ts:2024-2035`) mints an attach
    // credential for exactly that case, and `@browserglass/server`'s own
    // wiring always supplies a real `AttachCredentialIssuer` backed by
    // this config's `TokenApi` (`lifecycle/wiring.ts`), unlike the
    // router's own bare unit-test double, which falls back to a
    // placeholder credential when nothing is wired at all
    // (`mintAttachCredential`'s own doc comment). Without a signing key
    // here, `TokenApiImpl.activeSigningKey` throws `E_NO_SIGNING_KEY`
    // (`src/auth/tokens.ts:50-63`), which `placeAndLaunch`'s catch treats
    // as an ordinary launch-attempt failure: it throws BEFORE this test
    // ever calls `bg.stop()`, so nothing below this line asserting on
    // `bg.stop()` killing Chrome was ever actually exercised. Every other
    // server test that acquires with a non-system principal already
    // configures a real key this same way, e.g.
    // `test/hooks/instance-lifecycle.test.ts`'s `buildHarness` and
    // `test/rest/targets.test.ts`.
    const keyMaterial = generateEd25519KeyMaterial();
    const signingKey: AppSigningKey = {
      kid: 'test-key',
      alg: 'EdDSA',
      publicKey: keyMaterial.publicKey,
      privateKey: keyMaterial.privateKey,
      status: 'active',
    };

    const bg = createBrowserGlass({
      mode: 'embedded',
      tenantId,
      appId,
      store,
      runtime,
      profiles: { dir: profileRoot, fs },
      auth: { keys: [signingKey], issuer: appId },
    });
    bgsToStop.push(bg);
    await bg.start();

    const router = bg.router;
    if (!router) throw new Error('bg.router is undefined after bg.start()');
    const principal = launcherPrincipal(tenantId, appId);

    const handle = await router.acquire({ profile: { mode: 'ephemeral' } }, principal);
    const acquired = await handle.ready;
    expect(acquired.state).toBe('ready');

    const view = await router.describe(acquired.instanceId, principal);
    const profilePath = view.instance.runtime?.profilePath;
    expect(profilePath).toBeTruthy();

    // Confirm the real Chrome process actually exists before asserting it
    // is gone: a false pass (nothing ever running) would be worthless.
    const beforeStop = chromeProcsForDataDir(profilePath as string);
    expect(beforeStop.length).toBeGreaterThan(0);

    const report = await bg.stop({ deadlineMs: 20_000, instances: 'release' });
    // Already stopped; drop it from the afterEach safety net so a second,
    // redundant `bg.stop()` there does not log a harmless but confusing
    // "database connection is not open" (the store already closed in
    // phase 6 above).
    const idx = bgsToStop.indexOf(bg);
    if (idx !== -1) bgsToStop.splice(idx, 1);
    expect(report.deadlineExceeded).toBe(false);

    const afterStop = chromeProcsForDataDir(profilePath as string);
    if (afterStop.length > 0) {
      // Do not leave it running just because the assertion below is about
      // to fail this test.
      for (const proc of afterStop) killProcessTree(proc.pid, 'SIGKILL');
    }
    expect(afterStop).toEqual([]);
  }, 60_000);
});
