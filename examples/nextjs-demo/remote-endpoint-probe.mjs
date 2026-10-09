import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
/**
 * Proves `runtime-remote` is actually reachable: launches Chrome itself
 * (an "externally launched" browser, exactly as a project migrating to
 * BrowserGlass incrementally would already have running), registers
 * that Chrome's CDP endpoint with a `RemoteRuntime`, acquires a
 * BrowserGlass instance whose pool spec names that endpoint via
 * `BrowserSpec.remoteEndpointName`, then drives it with a real
 * `AutomationClient`: navigate, then read text back out of the page.
 *
 * Does NOT use the shared demo gateway on :3000 (which server.mjs wires to
 * `createHostRuntime`, never `runtime-remote`, and which this probe must
 * not disturb). Instead this
 * builds its own throwaway, in-process embedded `BrowserGlass` on an
 * ephemeral port, following the same shape `packages/cli/src/gateway.ts`'s
 * `buildEmbeddedGateway` uses, with a `RemoteRuntime` in place of that
 * file's `HostRuntime`.
 *
 * Before the fix this repo's `browserglass` HEAD carried (`StoredBrowserSpec`
 * had no `remoteEndpointName` column, so the value never survived the
 * `store.upsertBrowserSpec` -> `Pool.template` round trip), `bg.router.acquire()`
 * below throws `E_SPEC_CONFLICT` from `RemoteRuntime.launch`'s preflight:
 * `LaunchRequest.labels` arrives with no `browserglass.remoteEndpointName`
 * key at all, because `Pool.template.remoteEndpointName` came back
 * `undefined` from a stored row that was never asked to carry it. After the
 * fix, the label survives and the acquire lands on the Chrome this probe
 * launched.
 *
 * `@browserglass/runtime-remote` is imported by relative path to its own
 * build output rather than as a bare specifier: this demo's package.json
 * never declared it as a dependency (nothing else here needed it), and
 * this probe would rather read straight from `packages/runtime-remote/dist`
 * than mutate a shared `package.json`/lockfile that seven other agents are
 * concurrently editing in this same working tree.
 */
import { createServer } from 'node:http';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutomationClient } from '@browserglass/automation';
import { createProfileFs, killProcessTree, resolveChromeBinary } from '@browserglass/runtime-host';
import {
  InProcessJtiCache,
  createBrowserGlass,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '@browserglass/server';
import { createSqliteStore } from '@browserglass/store-sqlite';

const { RemoteRuntime } = await import(
  new URL('../../packages/runtime-remote/dist/index.mjs', import.meta.url)
);

// A random high port, not the conventional 9222: anything else on the
// machine may already have a Chrome listening on the conventional
// debugging port, and a collision there silently hands this probe someone
// else's browser instead of the one it just spawned. Any port works equally
// well to prove the same thing.
const CDP_PORT = 20000 + Math.floor(Math.random() * 20000);
const ENDPOINT_NAME = 'external-chrome';
const PROBE_TEXT = 'BrowserGlass remote endpoint probe OK';
const PROBE_CAPS = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'evaluate',
  'automation',
  'devtools',
];

const results = [];
function check(label, got, want) {
  const ok = got === want;
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)} got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`,
  );
}

/** Races `promise` against a hard deadline, so a hung CDP/WS call cannot strand this probe's Chrome forever on a shared machine; the outer `finally` still runs and kills it. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForCdp(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/json/version`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `CDP endpoint at ${origin} never answered /json/version within ${timeoutMs}ms: ${lastErr}`,
  );
}

async function main() {
  // Keeps the event loop alive for this whole call, the same workaround
  // `packages/cli/src/gateway.ts`'s `buildEmbeddedGateway` documents
  // needing: if every timer this call chain schedules downstream happens
  // to be `.unref()`'d at the moment the loop would otherwise go idle,
  // Node treats it as drained and exits early, code 0, abandoning whatever
  // promise this script is still awaiting -- observed directly against
  // this build (`AutomationClient.connect()` never even reaching its own
  // 20s `withTimeout` guard). `clearInterval` in the outer `finally` below
  // releases it whether this probe succeeds or throws.
  const keepAlive = setInterval(() => undefined, 2_147_483_647);
  try {
    await runProbe();
  } finally {
    clearInterval(keepAlive);
  }
}

async function runProbe() {
  // ---- 1. Launch Chrome ourselves: exactly what an externally managed
  // project migrating incrementally would already have running, well before BrowserGlass ever hears about it. ----
  const chromeUserDataDir = mkdtempSync(join(tmpdir(), 'bgls-remote-probe-chrome-'));
  const binary = resolveChromeBinary('chrome');
  console.log(`launching Chrome: ${binary.path} (${binary.version})`);
  const chrome = spawn(
    binary.path,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeUserDataDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  chrome.on('error', (err) => console.error('chrome spawn error:', err));

  // `runtime-host` refuses a profile root whose materialised path would
  // exceed `WINDOWS_MAX_PROFILE_ROOT_CHARS` (`E_PROFILE_ROOT_TOO_LONG`),
  // and a profile's own suffix under it (`tenants/<id>/profiles/<id>`) is
  // already ~80 characters on its own; the default `%TEMP%` on this
  // machine is deep enough that a `mkdtemp`-generated subdirectory under
  // it blows that budget before a single profile is added, confirmed
  // directly against a real `E_PROFILE_ROOT_TOO_LONG`. Matches
  // `server.mjs`'s own `BGLS_DEMO_PROFILES_DIR` short-path workaround: a
  // short, drive-root path on Windows, the ordinary temp dir everywhere
  // else, since only Windows has this constraint. RemoteRuntime never
  // reads a profile's materialised path at all (`applyResolvedSpec`
  // ignores `req.profile` entirely), so this directory exists only to
  // satisfy `ProfileService` bookkeeping and is never touched by the
  // browser this probe actually drives.
  const gatewayDataDir = mkdtempSync(join(tmpdir(), 'bgls-remote-probe-gw-'));
  const profilesDir =
    platform() === 'win32'
      ? join('C:\\bgls-remote-probe-profiles', randomBytes(4).toString('hex'))
      : join(gatewayDataDir, 'profiles');
  mkdirSync(profilesDir, { recursive: true });

  let bg;
  let httpServer;
  let remoteRuntime;
  let exitCode = 0;

  try {
    const version = await waitForCdp(`http://127.0.0.1:${CDP_PORT}`, 20_000);
    console.log(`Chrome CDP is up: ${version.Browser}`);

    // ---- 2. Register that Chrome's endpoint with a RemoteRuntime, and
    // build a throwaway embedded gateway around it. ----
    const store = await createSqliteStore(join(gatewayDataDir, 'bgls.db'));
    const tenant = await store.createTenant({ name: 'remote endpoint probe tenant' });
    const app = await store.createApp({ tenantId: tenant.id, name: 'remote endpoint probe app' });

    // The one field this whole probe is about: an operator naming which
    // registered RemoteEndpoint this pool's spec attaches to, set the same
    // way `examples/nextjs-demo/server.mjs` sets every other pool-level-only
    // field (`proxy`, `extraArgs`, `extensions`) today, directly on the
    // BrowserSpecInput handed to `upsertBrowserSpec`. `PoolDefinition`
    // (`packages/server/src/config/types.ts`) deliberately has no
    // convenience field for this.
    const spec = await store.upsertBrowserSpec(tenant.id, {
      engine: 'chromium',
      channel: 'chrome',
      headless: 'off',
      isolation: 'tab',
      viewportW: 1024,
      viewportH: 768,
      dpr: 1,
      locale: null,
      timezone: null,
      userAgent: null,
      clientHints: null,
      initScripts: [],
      remoteEndpointName: ENDPOINT_NAME,
      proxy: null,
      args: [],
      extensions: [],
      stealth: 'off',
      limits: {},
    });
    const pool = await store.createPool({
      tenantId: tenant.id,
      name: 'remote-probe',
      specId: spec.id,
    });
    void pool;

    const key = generateEd25519KeyMaterial();
    const signingKey = { kid: 'probe-1', appId: app.id, alg: 'EdDSA', status: 'active', ...key };
    const authResolver = jwtAuthResolver({
      keys: [signingKey],
      tenantId: tenant.id,
      appId: app.id,
      issuer: app.id,
      clockSkewSeconds: 30,
      jtiCache: new InProcessJtiCache(1_000),
      store,
    });

    remoteRuntime = new RemoteRuntime({
      endpoints: [
        {
          name: ENDPOINT_NAME,
          tenantId: tenant.id,
          url: `http://127.0.0.1:${CDP_PORT}`,
          auth: null,
        },
      ],
    });
    const profileFs = createProfileFs({ root: profilesDir });

    bg = createBrowserGlass({
      mode: 'embedded',
      basePath: '/browserglass',
      tenantId: tenant.id,
      appId: app.id,
      store,
      runtime: remoteRuntime,
      profiles: { dir: profilesDir, fs: profileFs },
      auth: { keys: [signingKey], issuer: app.id, resolver: authResolver },
    });

    const startReport = await bg.start();
    for (const node of startReport.nodes) {
      if ((await store.getNode(node.nodeId)) === null) {
        await store.registerNode({
          id: node.nodeId,
          name: 'remote-probe-node',
          runtime: 'remote',
          address: '127.0.0.1',
          registrationSecretEnc: 'probe',
        });
      }
    }

    // A SEPARATE, already-known `packages/router` limitation, unrelated to
    // `remoteEndpointName`:
    // `BrowserRouter.placeAndLaunch` discards the real `LaunchedBrowser` its
    // own runtime hands back, so `instance.runtime` (which `session/factory.ts`
    // reads to wire a WS session's CDP bridge) stays
    // `null` forever, and no session can go live without it. Confirmed
    // directly: `AutomationClient.connect()` below hangs until the socket's
    // own deadline without this. `packages/cli/src/gateway.ts`'s own
    // `buildEmbeddedGateway` hit exactly this and works around it the same
    // way, backfilling `instance.runtime` from the runtime's own `list()`
    // inventory on `bg.router`'s `describe()` -- reused here verbatim
    // (`RemoteRuntime.list()` in place of that file's `HostRuntime.list()`)
    // rather than re-deriving it.
    if (bg.router !== undefined) {
      const router = bg.router;
      const realDescribe = router.describe.bind(router);
      router.describe = async (describeInstanceId, describePrincipal) => {
        const view = await realDescribe(describeInstanceId, describePrincipal);
        if (view.instance.runtime !== null) return view;
        const entry = (await remoteRuntime.list()).find((e) => e.instanceId === describeInstanceId);
        if (entry === undefined) return view;
        return {
          ...view,
          instance: {
            ...view.instance,
            runtime: {
              kind: entry.runtimeKind,
              pid: entry.pid,
              containerId: entry.containerId,
              podName: entry.podName,
              cdpWsUrl: `${entry.cdpUrl.replace(/^http/, 'ws')}/devtools/browser/${entry.browserGuid}`,
              cdpPort: null,
              chromeVersion: entry.engineVersion,
              profilePath: entry.profilePath,
              startedAt: entry.startedAt,
              stealthProfile: null,
            },
          },
        };
      };
    }

    httpServer = createServer((req, res) => {
      bg.handleRequest(req, res)
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
        });
    });
    bg.attach(httpServer);
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    const port = httpServer.address().port;
    const wsUrl = `ws://127.0.0.1:${port}${bg.config.wsPath}`;
    console.log(`embedded gateway listening at 127.0.0.1:${port}, ws ${wsUrl}`);

    // ---- 3. Acquire an instance from the 'remote-probe' pool. This is
    // the call that throws E_SPEC_CONFLICT before the fix. ----
    const principal = bg.principalFromClaims({
      tenantId: tenant.id,
      appId: app.id,
      sub: 'probe-user',
      subKind: 'user',
      caps: [...PROBE_CAPS, 'instance.create', 'instance.destroy'],
      scope: { kind: 'tenant' },
    });

    let instanceId;
    let client;
    try {
      const handle = await withTimeout(
        bg.router.acquire(
          {
            requestId: `probe:${Date.now()}`,
            pool: 'remote-probe',
            profile: { mode: 'ephemeral' },
            subject: 'probe-user',
          },
          principal,
        ),
        30_000,
        'bg.router.acquire()',
      );
      const result = handle.result;
      if (result.state === 'queued' || result.instanceId === null) {
        throw new Error(`acquire did not return a live instance (state=${result.state})`);
      }
      instanceId = result.instanceId;
      console.log(
        `acquired instance ${instanceId} on the 'remote-probe' pool (attached to ${ENDPOINT_NAME})`,
      );

      const sessionId =
        result.sessionId !== ''
          ? result.sessionId
          : ((await bg.sessions.list({ instanceId })).items[0]?.sessionId ?? '');
      const issued = await bg.tokens.issueWithMeta({
        sub: 'probe-user',
        caps: PROBE_CAPS,
        scope: { kind: 'instance', instanceId, targets: '*', sessionId },
        ttlSeconds: 120,
      });

      // ---- 4. Drive it with a real AutomationClient: navigate, then read
      // text back out of the page. ----
      console.log('connecting AutomationClient...');
      client = await withTimeout(
        AutomationClient.connect({ endpoint: wsUrl, token: issued.token }),
        20_000,
        'AutomationClient.connect()',
      );
      console.log('connected; listing tabs...');
      const tabs = await withTimeout(client.tabs.list(), 20_000, 'client.tabs.list()');
      console.log(`tabs: ${JSON.stringify(tabs)}`);
      check('at least one tab reported', tabs.length > 0, true);
      const c = client.forTarget(tabs[0].targetId);
      console.log('acquiring control...');
      await withTimeout(c.acquireControl(), 20_000, 'acquireControl()');
      console.log('control acquired; navigating...');

      await withTimeout(
        c.navigate(`data:text/html,${encodeURIComponent(`<h1 id="x">${PROBE_TEXT}</h1>`)}`, {
          waitUntil: 'load',
        }),
        20_000,
        'navigate()',
      );
      console.log('navigated; evaluating...');
      const text = await withTimeout(
        c.evaluate("document.getElementById('x').textContent"),
        20_000,
        'evaluate()',
      );
      console.log(`evaluated: ${JSON.stringify(text)}`);
      check('page text read back after navigate matches what was set', text, PROBE_TEXT);
    } finally {
      client?.close();
      if (instanceId !== undefined) {
        await bg.router
          .release(instanceId, { reason: 'probe_done', profile: 'destroy' }, principal)
          .catch(() => {});
      }
    }

    const passed = results.filter(Boolean).length;
    console.log(`\n=== ${passed}/${results.length} assertions passed ===`);
    if (passed !== results.length || results.length === 0) exitCode = 1;
  } catch (err) {
    console.error('\nremote endpoint probe FAILED:');
    console.error(`  code: ${err?.code ?? '(none)'}`);
    console.error(`  message: ${err?.message ?? err}`);
    if (err?.context) console.error(`  context: ${JSON.stringify(err.context)}`);
    if (err?.cause) console.error(`  cause: ${err.cause?.message ?? err.cause}`);
    exitCode = 1;
  } finally {
    // ---- 5. Clean up: stop the gateway, then kill the Chrome this probe
    // launched. Never leaves a browser behind. ----
    if (httpServer) await new Promise((resolve) => httpServer.close(() => resolve()));
    if (bg) await bg.stop({ instances: 'release', deadlineMs: 10_000 }).catch(() => {});
    if (remoteRuntime) await remoteRuntime.dispose().catch(() => {});
    if (chrome.pid) await killProcessTree(chrome.pid).catch(() => {});
    // `killProcessTree`'s `taskkill /T /F /PID <chrome.pid>` alone was not
    // enough: measured directly, it left every renderer/GPU/utility child
    // Chrome forks (8 `chrome.exe` processes per run) still running,
    // because the pid `spawn()` hands back is not always the parent of the
    // whole tree taskkill's own `/T` walks by the time this runs. Sweeping
    // by `--user-data-dir` (unique to this run's temp directory, never
    // reused) catches every one of them regardless of which process
    // taskkill's tree walk missed.
    if (platform() === 'win32') {
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like ('*' + $env:BGLS_PROBE_KILL_DIR + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        ],
        { env: { ...process.env, BGLS_PROBE_KILL_DIR: chromeUserDataDir }, stdio: 'ignore' },
      );
    }
    try {
      rmSync(chromeUserDataDir, { recursive: true, force: true });
      rmSync(gatewayDataDir, { recursive: true, force: true });
      rmSync(profilesDir, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp dir is not worth failing the probe over.
    }
  }

  process.exitCode = exitCode;
}

main();
