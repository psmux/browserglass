/**
 * The smallest honest BrowserGlass backend: one Node file that builds a
 * gateway, launches one real Chrome, and serves both the page that displays
 * it and the short lived token that page connects with. Run it with
 * `node server.mjs` from this directory. Ctrl+C kills the Chrome it launched.
 *
 * Everything here is the same wiring examples/nextjs-demo/server.mjs does,
 * with the parts that only matter to that demo removed: no Next.js, no
 * per visitor ownership, no profile garbage reaper, no CDP proxy.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserGlassClient } from '../../packages/client/dist/index.mjs';
import { createHostRuntime, createProfileFs } from '../../packages/runtime-host/dist/index.mjs';
// In your own app these are four ordinary npm dependencies and you write
// `import { createBrowserGlass } from '@browserglass/server'`. This example
// imports the workspace build by path so it needs no install of its own and
// runs straight from a fresh checkout of this repo.
import {
  createBrowserGlass,
  generateEd25519KeyMaterial,
} from '../../packages/server/dist/index.mjs';
import { createSqliteStore } from '../../packages/store-sqlite/dist/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7500);

// Fixed ids so restarts reuse the same SQLite rows. The format is checked:
// a 26 character uppercase Crockford base32 body starting with 0 to 7.
const TENANT_ID = 'ten_0MIN0000000000000000000000';
const APP_ID = 'app_0MIN0000000000000000000000';
// Who the tokens say is connecting. A real app puts its own user id here.
const SUBJECT = 'minimal-example';

// Nothing here belongs in the repo, so it lives under the OS temp directory.
// Chrome profile paths nest about 80 characters below the profile root and
// runtime-host refuses a root that would push the total past Windows'
// MAX_PATH budget. The temp directory is already too deep for that on
// Windows, so the default there is a short path on the same drive. Set
// BGLS_PROFILES_DIR to put it somewhere else, keeping it short.
const dataDir = join(tmpdir(), 'bgls-minimal');
const defaultProfilesDir =
  process.platform === 'win32'
    ? join(parse(tmpdir()).root, 'bgls-minimal')
    : join(dataDir, 'profiles');
const profilesDir = process.env.BGLS_PROFILES_DIR ?? defaultProfilesDir;
mkdirSync(dataDir, { recursive: true });
mkdirSync(profilesDir, { recursive: true });

// 'off' opens a Chrome window you can watch alongside the streamed pane.
// Set BGLS_HEADLESS=1 on a machine with no display.
const HEADLESS = process.env.BGLS_HEADLESS === '1' ? 'new' : 'off';

const store = await createSqliteStore(join(dataDir, 'bgls.db'));
if ((await store.getTenant(TENANT_ID)) === null) {
  await store.createTenant({ id: TENANT_ID, name: 'minimal example' });
}
if ((await store.getApp(TENANT_ID, APP_ID)) === null) {
  await store.createApp({ id: APP_ID, tenantId: TENANT_ID, name: 'minimal example' });
}

// acquire() looks its pool up in the store by name and falls back to the one
// named 'default'. The `router.pools` config field does not create it, it is
// report only, so the pool and the spec it points at must exist before the
// first acquire or you get E_POOL_NOT_FOUND. Upserting on every boot means a
// change here lands on the next restart instead of needing the database
// deleted by hand. isolation 'window' gives every tab its own OS window;
// Chromium composites only a window's visible tab, so under 'tab' isolation
// one pane per instance can ever produce frames.
const spec = await store.upsertBrowserSpec(TENANT_ID, {
  engine: 'chromium',
  channel: 'chrome',
  headless: HEADLESS,
  isolation: 'window',
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
  limits: {},
});
const pool = await store.getPoolByName(TENANT_ID, 'default');
if (pool === null)
  await store.createPool({ tenantId: TENANT_ID, name: 'default', specId: spec.id });
else if (pool.specId !== spec.id) await store.updatePool(TENANT_ID, pool.id, { specId: spec.id });

const { runtime } = await createHostRuntime({
  nodeId: 'nod_0MIN0000000000000000000000',
  stateDir: join(dataDir, 'runtime-host'),
  profileRoot: profilesDir,
  // The backstop for every exit that is not graceful. An app's browsers
  // should not outlive the app.
  killOnShutdown: true,
});

// A dev only signing key, regenerated on every boot, so a token minted before
// a restart stops verifying. A real deployment uses an operator held secret.
const signingKey = { kid: 'dev', alg: 'EdDSA', ...generateEd25519KeyMaterial() };

const bg = createBrowserGlass({
  mode: 'embedded',
  basePath: '/browserglass',
  tenantId: TENANT_ID,
  appId: APP_ID,
  store,
  runtime,
  profiles: { dir: profilesDir, fs: createProfileFs({ root: profilesDir }) },
  auth: { keys: [signingKey], issuer: APP_ID },
  // No security.allowedOrigins on purpose. The gateway allows no cross origin
  // caller until you configure one, and this process serves the page and the
  // socket from one origin, so there is no cross origin request to allow.
  // Serve index.html elsewhere and you must add
  // security: { allowedOrigins: ['http://wherever-the-page-is'] }.
});

const embedBundle = readFileSync(
  join(here, '..', '..', 'packages', 'embed', 'dist', 'browserglass-embed.global.js'),
);

const server = createServer((req, res) => {
  // The gateway claims /browserglass/* first; everything else is ours.
  bg.handleRequest(req, res)
    .then(async (handled) => {
      if (handled) return;
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(here, 'index.html')));
      } else if (path === '/embed.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(embedBundle);
      } else if (path === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await session()));
      } else {
        res.writeHead(404).end('not found');
      }
    })
    .catch((err) => {
      console.error('[minimal] request failed:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    });
});
bg.attach(server); // wires the WebSocket upgrade path onto the same server

// Every timer the gateway schedules is unref'd, correctly. Until the listening
// socket exists nothing else holds the event loop open either, so Node decides
// the loop has drained and exits with "Detected unsettled top-level await" in
// the middle of start(). This ref'd handle covers that gap.
const keepAlive = setInterval(() => undefined, 2_147_483_647);

// start() runs migrations, registers the local node and preflight checks
// Chrome before the port opens, so a broken Chrome install fails here rather
// than as the first request's mysterious 500.
await bg.start();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, () => {
    server.off('error', reject);
    resolve();
  });
});
clearInterval(keepAlive);

// The server's own authority, used to acquire the instance below. A real app
// builds this from its session or its API key, not from a constant.
const principal = bg.principalFromClaims({
  tenantId: TENANT_ID,
  appId: APP_ID,
  sub: SUBJECT,
  subKind: 'user',
  caps: ['view', 'control', 'navigate', 'instance.create', 'instance.destroy'],
  scope: { kind: 'tenant' },
});

// One browser, launched now, thrown away on shutdown. `handle.ready` resolves
// once Chrome is up; `handle.result` alone can still say 'launching'. lifetime
// 'explicit' keeps it alive until this process releases it, where the default
// 'viewer-bound' would end it in any gap between page loads.
console.log('[minimal] launching Chrome...');
const acquired = await (
  await bg.router.acquire({ profile: { mode: 'ephemeral' }, lifetime: 'explicit' }, principal)
).ready;
const instanceId = acquired.instanceId;

/** A short lived credential for our one browser. The scope, not the caps alone, is what stops it reaching any other instance. */
async function mintToken(caps, ttlSeconds) {
  // AcquireResult.sessionId reads back empty because the SQLite instances
  // table has no session_id column, so ask the registry that does keep it.
  const sessionId = (await bg.sessions.list({ instanceId })).items[0]?.sessionId ?? '';
  return bg.tokens.issueWithMeta({
    sub: SUBJECT,
    caps,
    scope: { kind: 'instance', instanceId, targets: '*', sessionId },
    ttlSeconds,
  });
}

// A viewer connection of the server's own, held open for the life of the
// process. It renders nothing. It exists because the tab list can only be read
// over the wire: AcquireResult.targets is always empty, and the REST target
// list refuses with E_SESSION_NOT_LIVE until some viewer has connected and the
// gateway has built a session. Holding it open also keeps the list fresh, which
// matters: Chrome swaps its startup tab a second or two after launch, so a list
// read once at boot hands out a target id that is already dead. The React demo
// reads the same list from the page, through @browserglass/react's useTargets.
const lister = new BrowserGlassClient({
  url: `ws://localhost:${PORT}${bg.config.wsPath}`,
  // Called again on every reconnect, so this connection outlives any single
  // token's 15 minute ceiling.
  credentials: async () => ({ token: (await mintToken(['view', 'tabs.manage'], 900)).token }),
});
await lister.connect();

/**
 * What the page fetches on load, and again whenever its token expires. Minted
 * per request and never written into the HTML: it is a credential, it expires,
 * and a page asking for its own is the shape a real app already has.
 */
async function session() {
  const tabs = await lister.tabs.list({ includeKinds: ['page'] });
  const target = tabs[0] ?? (await lister.tabs.new({ url: 'https://example.com' }));
  const issued = await mintToken(['view', 'control', 'navigate'], 900);
  return { wsPath: bg.config.wsPath, token: issued.token, targetId: target.targetId };
}

console.log(`[minimal] open http://localhost:${PORT}`);
console.log(`[minimal] instance ${instanceId}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[minimal] ${signal}, shutting down`);
    server.close();
    lister.destroy();
    // Releases the instance, terminates Chrome, disposes the runtime.
    bg.stop({ deadlineMs: 15_000 }).finally(() => process.exit(0));
  });
}
