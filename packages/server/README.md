# `@browserglass/server`

The transport gateway: `createBrowserGlass()`, the `bgls.v1` WebSocket
protocol loop, JWT auth, capability enforcement, and the REST surface
(instances, targets, tokens, uploads, downloads). This is the one package
an app's Node backend actually needs; the browser side is
`@browserglass/react`, `@browserglass/client`, or `@browserglass/embed`,
never this one.

## Install

Nothing under `@browserglass/*` is on npm yet: `npm view @browserglass/server`
returns a 404, and so does every sibling package. The only way to get this
package today is cloning the repository and building it; see
[`docs/quickstart.md`](../../docs/quickstart.md) for the exact commands.

Once a version is published, every package here will use the `alpha` npm
dist-tag, never `latest`, so a plain `npm install @browserglass/server`
still will not resolve. You will ask for the alpha explicitly:

```sh
npm install @browserglass/server@alpha
```

See [`docs/installing.md`](../../docs/installing.md) for the full plan,
and for the pnpm/yarn equivalents.

## The fastest path: no code at all

```sh
pnpm bgls serve --listen 127.0.0.1:7799
```

Run from the repository root, after `pnpm install` (the root
`package.json` depends on `@browserglass/cli` and defines the `bgls`
script that makes this resolve; see
[`docs/quickstart.md`](../../docs/quickstart.md) for the full setup). Once
a version of `@browserglass/cli` is published, `npx @browserglass/cli
serve --listen 127.0.0.1:7799` will do the same thing with no clone
required.

`bgls serve` wraps this exact package: a real gateway, an ephemeral dev
signing key, and a WebSocket endpoint printed to your terminal, with
nothing to write. Reach for this first if you are exploring, writing a
script against the REST API, or driving browsers from the CLI/MCP rather
than embedding the gateway in your own server process.

## A minimal working example

Embedding `createBrowserGlass()` directly into your own Node server, the
way an app that already has one usually wants to. This is the short shape
of it; `examples/nextjs-demo/server.mjs` is the same wiring in full, as a
real file you can run rather than only read, including the parts trimmed
out here (a Chrome pool, a profile filesystem, graceful shutdown):

```js
import { createServer } from 'node:http';
import {
  createBrowserGlass,
  generateEd25519KeyMaterial,
  InProcessJtiCache,
  jwtAuthResolver,
} from '@browserglass/server';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { createHostRuntime } from '@browserglass/runtime-host';

const TENANT_ID = 'ten_0YOURTENANT00000000000000';
const APP_ID = 'app_0YOURAPP000000000000000000';

const store = await createSqliteStore('./bgls-data/bgls.db');
const { runtime } = await createHostRuntime({
  nodeId: 'nod_0YOURNODE00000000000000000',
  stateDir: './bgls-data/state',
  profileRoot: './bgls-data/profiles',
  killOnShutdown: true, // every browser this process launched dies with it
});
const signingKey = generateEd25519KeyMaterial();

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
  auth: { keys: [signingKey], issuer: APP_ID, resolver: authResolver },
});

const server = createServer(async (req, res) => {
  const handled = await bg.handleRequest(req, res);
  if (!handled) res.writeHead(404).end();
});
bg.attach(server); // wires the WebSocket upgrade path onto the same server

server.listen(7799);
```

Minting a token and acquiring an instance are the next two things a real
app needs, once a request comes in that actually needs a browser:

```js
// A broad credential this backend holds for itself and never hands to a
// browser. 'owner' expands to the 'admin' capability, which is why
// issueWithMeta refuses it without the acknowledgement flag below.
const service = await bg.tokens.issueWithMeta({
  sub: 'svc_backend',
  role: 'owner',
  iUnderstandAdmin: true,
  scope: { kind: 'tenant' },
  ttlSeconds: 3600,
});

// Acquire a browser instance over the real REST surface: the same
// POST /v1/instances a CLI, an MCP server, or any other client calls.
const acquired = await fetch('http://127.0.0.1:7799/browserglass/v1/instances', {
  method: 'POST',
  headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ profile: { mode: 'ephemeral' } }),
}).then((r) => r.json());

const targetId = acquired.targets?.[0]?.targetId; // the tab a fresh instance opens

// The narrow, short-lived credential the BROWSER gets, never the service
// token above. Capped at 900 seconds server side regardless of ttlSeconds.
const viewer = await bg.tokens.issueWithMeta({
  sub: userId,
  role: 'observer', // 'driver' instead if this viewer should be allowed to drive
  scope: { kind: 'instance', instanceId: acquired.instanceId, targets: '*', sessionId: acquired.sessionId },
  ttlSeconds: 900,
});

// Hand { token: viewer.token, targetId } to the page rendering
// <BrowserGlass /> (`@browserglass/react`) or <browser-glass>
// (`@browserglass/embed`).
```

`examples/minimal` is this same shape as a small, runnable app.
`examples/nextjs-demo/server.mjs` is the production shaped version of it:
a Chrome pool, a profile filesystem, graceful shutdown, and workspace
sharing, all of which are left out here to keep this short.

## Where to go next

[`docs/quickstart.md`](../../docs/quickstart.md) covers starting a
gateway, minting a token, and driving browsers four ways (CLI, Node's
`BrowserSwarm`, MCP, and raw REST plus WebSocket). Cross origin access
from a browser page (CORS, and the same origin list the WebSocket upgrade
checks) is `security.allowedOrigins` and `security.corsCredentials`,
resolved in `src/config/resolve.ts` and enforced in `src/rest/cors.ts`;
nothing is allowed until you configure it.
