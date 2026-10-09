/**
 * The custom server. A Next.js App Router app cannot host a WebSocket
 * upgrade on its own, so this file
 * plays the same role every BrowserGlass Next.js integration needs: it
 * builds one real `BrowserGlass` gateway, hands the WebSocket upgrade to it
 * first, and falls through to Next for everything else.
 *
 * Run with `node server.mjs`, never `next dev` or `next start` directly:
 * neither of those ever executes this file, so `globalThis.__bg` (which
 * every app/api/** route reads via lib/bgls.ts) is never set. See
 * getBg()'s own error message for the same point.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHostRuntime,
  createProfileFs,
  reapAbandonedProfileDirs,
} from '@browserglass/runtime-host';
import {
  InProcessJtiCache,
  createBrowserGlass,
  createUpgradeDispatcher,
  defineGlobalBg,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '@browserglass/server';
import { createSqliteStore } from '@browserglass/store-sqlite';
import next from 'next';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixed, stable ids so the demo's SQLite store is the same tenant and app
// across restarts. `ID_RE` (`@browserglass/protocol`'s `packages/protocol/
// src/wire/ids.ts`) requires a 26 character, uppercase-only Crockford
// base32 body whose first character is `0` to `7`; these are not derived
// from any real request, just fixed, valid looking placeholders.
const TENANT_ID = 'ten_0DEM0000000000000000000000';
const APP_ID = 'app_0APP0000000000000000000000';
const POOL_NAME = 'demo';

// `BGLS_DEMO_DATA_DIR` lets a second copy of this demo run beside a first
// one (a different PORT, a different SQLite file, a different node state
// directory) instead of two processes fighting over one `data/bgls.db` and
// one registered node id. Useful for testing an instance sharing or
// workspace change without disturbing whatever is already running. The
// default is the ordinary project relative path, so nobody has to know
// this exists.
const dataDir = process.env.BGLS_DEMO_DATA_DIR ?? join(__dirname, 'data');
const dbPath = join(dataDir, 'bgls.db');
const stateDir = join(dataDir, 'runtime-host');
const sessionPath = join(dataDir, 'dev-session.json');

// Chrome profile directories nest deeply under the profile root
// (`tenants/<tenantId>/profiles/<profileId>/udd`, roughly 80 characters of
// suffix on their own), and `runtime-host` deliberately refuses a profile
// root producing a total path over 120 characters on Windows rather than
// letting Chrome fail silently near MAX_PATH (`WINDOWS_MAX_PROFILE_ROOT_CHARS`,
// `packages/runtime-host`). A checkout a few directories deep
// (`.../<some>/<nested>/browserglass/examples/nextjs-demo/data/profiles`)
// is already too long on its own once that suffix is added, and the
// acquire fails with `E_PROFILE_ROOT_TOO_LONG`. `BGLS_DEMO_PROFILES_DIR` overrides this; the default is a
// short, drive root path on Windows and the ordinary project relative one
// everywhere else, since only Windows has this constraint.
const profilesDir =
  process.env.BGLS_DEMO_PROFILES_DIR ??
  (platform() === 'win32' ? 'C:\\bgls-demo-profiles' : join(dataDir, 'profiles'));

mkdirSync(dataDir, { recursive: true });
mkdirSync(profilesDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? 'localhost';

const nextApp = next({ dev, hostname, port });
const nextHandle = nextApp.getRequestHandler();

// Reuses the same Ed25519 signing key across a restart of this process (so
// a token minted before a restart, if still within its 120 second TTL,
// keeps verifying); a fresh dev-only key is generated otherwise. Never do
// this for a real deployment: `auth.keys` there comes from an operator
// managed secret, not a file dropped next to the SQLite database.
function loadOrCreateDevKey() {
  if (existsSync(sessionPath)) {
    try {
      const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
      if (saved.key?.publicKey && saved.key?.privateKey) return saved.key;
    } catch {
      // Corrupt or from an older shape; fall through and regenerate.
    }
  }
  const key = generateEd25519KeyMaterial();
  writeFileSync(sessionPath, JSON.stringify({ key }, null, 2));
  return key;
}

async function main() {
  await nextApp.prepare();
  // Only available after prepare(): Next throws "prepare() must be called
  // before performing this operation" if this is read any earlier.
  const nextUpgrade = nextApp.getUpgradeHandler();

  const store = await createSqliteStore(dbPath);

  if ((await store.getTenant(TENANT_ID)) === null) {
    await store.createTenant({ id: TENANT_ID, name: 'BrowserGlass demo tenant' });
  }
  if ((await store.getApp(TENANT_ID, APP_ID)) === null) {
    await store.createApp({ id: APP_ID, tenantId: TENANT_ID, name: 'BrowserGlass Next.js demo' });
  }

  // `BrowserRouter.acquire()` looks up its pool by name via
  // `store.getPoolByName`; `ResolvedConfig.router.pools` (the `router:
  // { pools: [...] }` config field) is report only, it never writes a
  // store row (`packages/server/src/lifecycle/start.ts` step 5 only
  // reconciles it into `StartReport.pools`). The pool, and the stored
  // `BrowserSpec` it points at, must exist before the very first acquire.
  // The spec is upserted on every boot, not only when the pool is missing.
  // The pool row survives in `data/bgls.db` across restarts, so the old
  // "create it once, never look at it again" shape meant any change here
  // (a viewport, a headless mode, the isolation mode below) silently did
  // nothing until someone deleted the database by hand. Upserting, then
  // pointing the pool at whatever came back, makes this file the single
  // source of truth for the demo's browser spec.
  //
  // `headless: 'off'` is the point of this demo: real, visible Chrome
  // windows sit alongside the streamed panes, so anyone watching this
  // process can see with their own eyes that the panes are not a recording
  // or a mock, they are the same browsers Chrome is showing.
  //
  // `isolation: 'window'` is what makes several panes drivable at once.
  // Chromium composites only a window's visible tab, so with every target
  // a tab of one window (the old default, `'tab'`) exactly one pane could
  // ever produce continuous frames and every other pane sat frozen, and
  // clicking any pane stole the live slot from whichever pane held it.
  // `packages/runtime-host/test/spike/spike-window-isolation.ts` measured
  // the difference against real Chrome: 4 tabs in one window gave
  // [0, 0, 0, 98.9] fps, the same 4 tabs in 4 windows gave [81.6, 81.8,
  // 82.4, 81.0], unchanged when OS focus was forced onto one of them.
  const spec = await store.upsertBrowserSpec(TENANT_ID, {
    engine: 'chromium',
    channel: 'chrome',
    headless: 'off',
    viewportW: 1280,
    viewportH: 800,
    dpr: 1,
    locale: null,
    timezone: null,
    userAgent: null,
    proxy: null,
    args: [],
    extensions: [],
    stealth: 'off',
    isolation: 'window',
    limits: {},
  });

  const existingPool = await store.getPoolByName(TENANT_ID, POOL_NAME);
  if (existingPool === null) {
    await store.createPool({ tenantId: TENANT_ID, name: POOL_NAME, specId: spec.id });
  } else if (existingPool.specId !== spec.id) {
    await store.updatePool(TENANT_ID, existingPool.id, { specId: spec.id });
  }

  const key = loadOrCreateDevKey();
  const signingKey = { kid: 'demo-1', appId: APP_ID, alg: 'EdDSA', status: 'active', ...key };

  const { runtime } = await createHostRuntime({
    nodeId: 'nod_0ND10000000000000000000000',
    stateDir,
    profileRoot: profilesDir,
    // Kill every browser this process launched when it exits.
    //
    // This used to be `false`, so that a dev restart could reattach to a
    // still-running Chrome. In practice it meant every restart, crash, or
    // hard kill stranded a full Chrome (and its renderer and GPU children)
    // holding an ephemeral profile nothing would ever reclaim: a handful of
    // restarts left a row of orphaned browser windows on the desktop and a
    // pile of processes competing for the machine. An app's browsers should
    // not outlive the app. The SIGTERM/SIGINT handler below still does the
    // graceful thing first (`bg.stop()` releases each instance and
    // terminates its browser deliberately); this is the backstop for every
    // exit that is not graceful.
    killOnShutdown: true,
  });

  const profileFs = createProfileFs({ root: profilesDir });

  // `createBrowserGlass` only builds its own internal resolver (used by
  // REST's `principalFor`/`bg.tokens`) when `auth.resolver` is unset, and
  // never writes that resolver back onto `ResolvedConfig.auth.resolver`,
  // which is the field the WebSocket upgrade path reads to verify a
  // `hello.auth` bearer token. Passing `keys` alone leaves the socket path
  // with no resolver at all. Building and passing one explicitly is the
  // documented workaround `packages/cli/src/gateway.ts` also uses.
  const authResolver = jwtAuthResolver({
    keys: [signingKey],
    tenantId: TENANT_ID,
    appId: APP_ID,
    issuer: APP_ID,
    clockSkewSeconds: 30,
    jtiCache: new InProcessJtiCache(10_000),
    store,
  });

  const bg = createBrowserGlass({
    mode: 'embedded',
    basePath: '/browserglass',
    tenantId: TENANT_ID,
    appId: APP_ID,
    store,
    runtime,
    profiles: { dir: profilesDir, fs: profileFs },
    limits: { maxInstances: 20 },
    // `allowQueryToken: true`: required for the raw CDP attach proxy below,
    // since a real CDP client (Playwright's `connect_over_cdp`, Puppeteer's
    // `connect`, chrome-remote-interface, ...) offers no way to set an
    // `Authorization` header on a WebSocket handshake. See
    // `SecurityConfig.cdpProxyEnabled`'s doc comment
    // (`packages/server/src/config/types.ts`) for the full argument.
    auth: { keys: [signingKey], issuer: APP_ID, resolver: authResolver, allowQueryToken: true },
    // Opts into the raw CDP WebSocket attach proxy
    // (`packages/server/src/ws/cdp-upgrade.ts`), OFF by default because it
    // is a deliberate relaxation of the allowlisted REST CDP passthrough:
    // a caller holding the `cdp` capability gets Chrome's real DevTools
    // Protocol, unfiltered, the same way a bare `chromium.connect_over_cdp`
    // would. This demo enables it because proving that a Playwright/
    // Puppeteer-driven project can point at BrowserGlass and migrate
    // incrementally is exactly what this SDK is for; `cdp` itself is
    // granted to no ordinary demo token (`lib/bgls.ts`'s `DEMO_CAPS`), only
    // to the dedicated probe token `app/api/browser/cdp-token/route.ts`
    // mints.
    // No `allowedOrigins` override needed: `resolveConfig`'s own default
    // (`packages/server/src/config/resolve.ts`) denies a genuinely CROSS
    // ORIGIN caller until an operator configures one explicitly, but
    // `ws/origin-check.ts` (the WS upgrade path this demo's browser UI and
    // its Python/curl clients both go through) allows two cases with zero
    // configuration: no `Origin` header at all (exactly what
    // `clients/python`'s `websockets` socket sends, and what any bare curl
    // call sends, since neither is a browser and neither has a page origin
    // to report), and an `Origin` that matches the request's own `Host`
    // (this demo's browser UI at `/browser`, served by this same Next.js
    // custom server, connecting back to its own origin). Both this demo's
    // callers land in one of those two buckets, so the zero-config default
    // is already correct for it; `allowedOrigins: '*'` used to be needed
    // here as a workaround for an earlier, broken version of that default
    // that 403'd the no-Origin-header case too, and is no longer.
    security: { cdpProxyEnabled: true },
    // Several people drive the SAME tab at once, with no queue and no
    // waiting. The SDK default is `'exclusive'` (one holder per target,
    // everybody else queues behind a FIFO), and that default is deliberate:
    // an automation run that assumes it is the only thing touching a page
    // should not lose that assumption because it upgraded. This demo opts
    // in because collaborating on a browser is the thing it exists to
    // show, and because view-or-view-and-control is how people actually
    // use a shared browser.
    //
    // The two modes are a per target property of the lease, so the UI
    // reads `lease.mode` and says which one a pane is in rather than
    // assuming. `packages/core`'s `assertKnownControlOptions` throws at
    // construction on an unknown key or an unrecognised mode, and
    // `resolveConfig` validates this value against a frozen list, so a
    // typo here fails loudly at boot instead of silently running
    // exclusive. That matters more than it sounds: `session.control.mode`
    // shipped inert precisely because the server accepted the key,
    // resolved it, froze it into `ResolvedConfig`, and then no consumer
    // ever read it.
    // `BGLS_CONTROL_MODE`, when set, overrides the demo's own default:
    // `cdp-collab-probe.mjs` (`packages/server/src/ws/cdp-upgrade.ts`'s
    // verification bar) needs `'exclusive'` to prove PREEMPTION at all,
    // since shared mode admits both drivers at once by design and nothing
    // is ever preempted there (`ControlLeaseEngine`'s own module doc). The
    // demo's own default stays `'shared'`, untouched, unless this is set.
    session: { control: { mode: process.env.BGLS_CONTROL_MODE ?? 'shared' } },
  });

  // Immediately after construction, before start(): app/api/** route
  // handlers run inside Next's own module graph, not this file's, so
  // lib/bgls.ts's getBg() is the only way they can reach this instance.
  defineGlobalBg(bg);

  const server = createServer((req, res) => {
    bg.handleRequest(req, res)
      .then((handled) => {
        if (!handled) return nextHandle(req, res);
      })
      .catch((err) => {
        console.error('[server.mjs] request handler error:', err);
        if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      });
  });

  // BrowserGlass claims its own upgrade path first; anything that is not
  // `/browserglass/socket` falls through to Next's own upgrade handler
  // (Fast Refresh's HMR socket in dev). This dispatcher pattern is the one
  // to use whenever an existing upgrade chain exists, which Next's dev
  // server always does.
  server.on('upgrade', createUpgradeDispatcher(bg, nextUpgrade));

  // Runs migrations, opens the store, registers the local node, reconciles
  // any surviving instances, and preflight checks Chrome, all before the
  // port opens, so a broken Chrome install or a locked database fails here
  // instead of as the first request's mysterious 500.
  await bg.start();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`> BrowserGlass Next.js demo ready on http://${hostname}:${port}`);
  console.log(`> Open http://${hostname}:${port}/browser to see it`);

  // ── profile directory garbage reaper ─────────────────────────────────
  //
  // Measured directly against this checkout before this reaper existed:
  // `GET /api/browser/instances` listed 73 rows (63 released, 8 failed, 2
  // ready), and `C:\bgls-demo-profiles\tenants\*\profiles\*` held 71
  // directories, almost a 1:1 match between terminal instances and
  // undestroyed bytes on disk. Most of that predates a real fix, not a
  // still-open bug: `packages/router/src/profiles/adapter.ts`'s
  // `applyReleaseAction` used to drop the request's `tenantId` on the
  // floor and fall back to an in-memory lease lookup that is empty after
  // any restart, which made the call a silent no-op for every release
  // whose granting process had since restarted, so `BrowserRouter.release()`
  // moved the instance row to `released` while the profile directory sat
  // there untouched. That path now passes `tenantId` explicitly
  // (`BrowserRouter.release()` step 6) and `ProfileFs.trash()` retries the
  // Windows rename race and falls back to an in place delete, so a FRESH
  // release reclaims its own directory correctly. This reaper is the
  // backstop for the backlog a buggier build already left behind, and for
  // whatever a future defect leaves behind again; it is not load bearing
  // for the ordinary release path, which needs no help.
  //
  // The three env vars make the sweep window configurable
  // without a code change:
  //
  // - `BGLS_DEMO_GC_INTERVAL_MS` (default 10 minutes): how often a sweep
  //   runs.
  // - `BGLS_DEMO_GC_MIN_AGE_MS` (default 30 minutes): how old an
  //   unprotected directory must be before this reaper will touch it. Kept
  //   well above `reapAbandonedProfileDirs`'s own 15 minute default (which
  //   matches the ephemeral trash retention) so a directory has already
  //   missed two chances to be cleaned up the ordinary way before this
  //   backstop ever considers it.
  // - `BGLS_DEMO_GC_MAX_REMOVALS` (default 50): the most directories one
  //   tick unlinks, so a large backlog is worked off over several ticks
  //   instead of blocking one of them for its whole length.
  //
  // `protectedProfileIds` is rebuilt from the store on every tick, never
  // cached across ticks: a profile's state can change between runs (a
  // fresh acquire, a lease renewal), and a stale protected set could let
  // this reaper race a profile that has since become live again.
  // `reapAbandonedProfileDirs`'s own `minAgeMs` gate is the second,
  // independent safety margin against that same race, and its exact
  // `--user-data-dir` liveness check (never the sync process-table
  // variant, one snapshot for every candidate directory, not one scan
  // each) is what actually decides whether a directory is safe to remove;
  // see that function's own doc comment in `@browserglass/runtime-host`.
  const gcIntervalMs = Number(process.env.BGLS_DEMO_GC_INTERVAL_MS ?? 10 * 60_000);
  const gcMinAgeMs = Number(process.env.BGLS_DEMO_GC_MIN_AGE_MS ?? 30 * 60_000);
  const gcMaxRemovals = Number(process.env.BGLS_DEMO_GC_MAX_REMOVALS ?? 50);

  async function runProfileGarbageSweep() {
    try {
      // `state !== 'deleting' && state !== 'deleted'` is the whole
      // ownership rule: those two states are the store's own admission
      // that the directory should already be gone (`ProfileService.
      // applyReleaseAction`/`gc()` set them right before calling
      // `ProfileFs.trash()`), so a directory still on disk under one of
      // them is exactly the leak this reaper exists to close. Every other
      // state (`free`, `leased`, `creating`, `snapshotting`, `migrating`,
      // `quarantined`) is left alone. A directory with NO row at all
      // (never listed here, so never added to the protected set) is
      // caught by the same filter from the other side: `runtime-host`'s
      // `reapAbandonedProfileDirs` treats "absent from protectedProfileIds"
      // as one undifferentiated candidate set, which is correct here
      // because both cases mean the same thing on disk: nothing currently
      // vouches for these bytes.
      const profiles = await store.listProfiles(TENANT_ID, { limit: 10_000 });
      const protectedProfileIds = new Set(
        profiles.filter((p) => p.state !== 'deleting' && p.state !== 'deleted').map((p) => p.id),
      );
      const report = await reapAbandonedProfileDirs({
        profileRoot: profilesDir,
        protectedProfileIds,
        minAgeMs: gcMinAgeMs,
        maxRemovals: gcMaxRemovals,
      });
      if (report.removed.length > 0 || report.refusedLive.length > 0 || report.failed.length > 0) {
        console.log(
          `[server.mjs] profile gc: scanned ${report.scanned} directories, ${report.candidates} unprotected, ` +
            `removed ${report.removed.length}, refused-live ${report.refusedLive.length}, failed ${report.failed.length}, ` +
            `too-recent ${report.skippedTooRecent} (${Math.round(report.durationMs)}ms)`,
        );
        for (const r of report.removed) console.log(`[server.mjs] profile gc: removed ${r.dir}`);
        for (const r of report.refusedLive) {
          console.warn(
            `[server.mjs] profile gc: left ${r.dir} alone, chrome pid ${r.pid} still holds it`,
          );
        }
        for (const f of report.failed)
          console.warn(`[server.mjs] profile gc: could not remove ${f.dir}: ${f.error}`);
      }
    } catch (err) {
      console.error('[server.mjs] profile gc: sweep failed, will retry next tick:', err);
    }
  }

  // Deferred 30 seconds past `server.listen`, for the same reason
  // `packages/server/src/lifecycle/wiring.ts`'s `scheduleOrphanSweep`
  // defers its own destructive sweep: a process that starts, runs this
  // immediately, and then dies (a config error, `EADDRINUSE`) must not
  // have deleted anything on its way out. The delay here is a fixed
  // margin rather than derived from a lease TTL the way that sweep's is,
  // because `gcMinAgeMs` (30 minutes by default) is already the real
  // safety margin against touching anything recent; this is only about
  // not racing this process's own startup.
  const gcStartTimer = setTimeout(() => void runProfileGarbageSweep(), 30_000);
  gcStartTimer.unref?.();
  const gcIntervalTimer = setInterval(() => void runProfileGarbageSweep(), gcIntervalMs);
  gcIntervalTimer.unref?.();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n> ${signal} received, shutting down`);
    clearTimeout(gcStartTimer);
    clearInterval(gcIntervalTimer);
    server.close();
    await bg.stop({ deadlineMs: 20_000 });
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server.mjs] fatal error during startup:', err);
  process.exit(1);
});
