# BrowserGlass

[![CI](https://github.com/psmux/browserglass/actions/workflows/ci.yml/badge.svg)](https://github.com/psmux/browserglass/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

BrowserGlass runs real Chrome browsers behind a gateway and streams their tabs live into any web page. A person watching can take the mouse and keyboard at any moment. Code can drive the same browsers through the same protocol, from Node, Python, an MCP capable AI agent, plain REST, or the `bgls` CLI.

Every browser tab has a control lease, so the gateway always knows who is driving: a script, an agent, or a person. A person outranks an agent by default. The gateway also recovers on its own from page crashes, lost CDP connections and stalled video streams.

```mermaid
flowchart LR
  subgraph clients[Your side]
    W["Web page<br/>React, &lt;browser-glass&gt;, plain JS"]
    A["Automation<br/>Node, Python, MCP, REST, CLI"]
  end
  subgraph gw["bgls gateway"]
    S["server<br/>WebSocket + REST + auth"]
    R["router<br/>placement, quotas, pools, profiles"]
    C["core<br/>CDP bridge, streaming, input, leases"]
    DB[("SQLite or Postgres")]
  end
  CH1["Chrome"]
  CH2["Chrome"]
  CH3["Remote Chrome<br/>(any CDP endpoint)"]
  W -- "bgls.v1 over WebSocket" --> S
  A -- "bgls.v1 / REST" --> S
  S --> R --> C
  R --- DB
  C --> CH1 & CH2 & CH3
```

## Status

Alpha. The code works end to end and has a large test suite, but nothing is on npm or PyPI yet, so you run it from a clone. Things that are not there yet are listed under [Limits](#limits) so you do not have to find them the hard way.

## Quick start

You need Node 22 or newer, pnpm (through corepack), and Google Chrome or Chromium installed.

```sh
git clone https://github.com/psmux/browserglass.git
cd browserglass
corepack enable
pnpm install
pnpm -r build
pnpm bgls doctor          # checks Chrome, the store, the port
pnpm bgls serve --listen 127.0.0.1:7799
```

You should see:

```
✔ bgls gateway listening at http://127.0.0.1:7799
ℹ data directory: ./bgls-data
ℹ ws endpoint:    ws://127.0.0.1:7799/browserglass/socket
```

Leave that running. In a second terminal, from the same directory, open ten browsers and send all of them to a page at once:

```sh
pnpm bgls swarm run --size 10 --action navigate --value https://example.com
```

Then look at what is running:

```sh
pnpm bgls instances list
pnpm bgls instances screenshot <instanceId> --out shot.png
```

The gateway starts in dev auth mode. It generates a signing key for this run and writes it to `bgls-data/dev-session.json`, which every other `bgls` command in the same directory reads to mint its own token. When a script or app needs an admin token of its own:

```sh
export ADMIN_TOKEN=$(pnpm bgls token)
```

If `--listen` is left out the gateway binds `127.0.0.1:7443`. The examples below all use 7799.

## Scenarios

### 1. Show a live browser in your web app

Your server creates a browser and mints a short lived token scoped to it. The page renders the stream and the user can click into it and type.

Server side (any language, it is two REST calls):

```js
const base = 'http://127.0.0.1:7799/browserglass';
const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' };

const instance = await fetch(`${base}/v1/instances`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ requestId: `demo-${Date.now()}`, browser: { headless: 'new' } }),
}).then((r) => r.json());

const { token } = await fetch(`${base}/v1/tokens`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    sub: 'user-42',
    subKind: 'service',
    scope: { kind: 'instance', instanceId: instance.instanceId, targets: '*' },
    caps: ['view', 'control', 'navigate'],
    ttlSeconds: 300,
  }),
}).then((r) => r.json());
// send `token` to the browser
```

Browser side, with React:

```tsx
import { BrowserGlass } from '@browserglass/react';

export function RemoteTab({ token }: { token: string }) {
  return (
    <BrowserGlass
      url="ws://127.0.0.1:7799/browserglass/socket"
      token={token}
      style={{ width: 960, height: 600 }}
    />
  );
}
```

Leave out `targetId` and the component follows whichever tab is active. Tokens are capped at 900 seconds; pass `onTicketExpired` to hand the component a fresh one. The package also has hooks (`useTargets`, `useNav`, `useControlLease`, `usePresence`, `useConsole`, `useNetwork` and more) and ready made controls under `@browserglass/react/ui`.

If the page is served from another origin, start the gateway with `--cors http://localhost:3000`.

### 2. Drop it into any page without React

`@browserglass/embed` is a custom element. Build it once, serve the file, and use it like any tag:

```sh
pnpm --filter @browserglass/embed build
# serves packages/embed/dist/browserglass-embed.global.js
```

```html
<script src="browserglass-embed.global.js"></script>
<browser-glass
  url="ws://127.0.0.1:7799/browserglass/socket"
  token="eyJ..."
  fit="contain"
  style="width: 960px; height: 600px">
</browser-glass>
```

Several `<browser-glass>` elements on one page share one connection. [`examples/embed-demo`](examples/embed-demo) shows three at once.

For a framework of your own, `@browserglass/client` is the plain TypeScript client underneath both: `new BrowserGlassClient({ url, token })`, `connect()`, then `subscribe(targetId, { canvas })`.

### 3. Drive a browser from Node

```ts
import { AutomationClient } from '@browserglass/automation';

const client = await AutomationClient.connect({
  endpoint: 'ws://127.0.0.1:7799/browserglass/socket',
  token, // instance scoped, with the "automation" and "evaluate" caps
});

const lease = await client.acquireControl();
await client.navigate('https://example.com/signup');
await client.fill('label=Email address', 'ada@example.com');
await client.click('role=button[name="Create account"]');
console.log(await client.text());
await lease.release();
client.close();
```

Locators accept CSS, `label=`, `text=`, `role=` and more. Clicks are real mouse events at real coordinates, typing sends real key events, and every action checks that the element is visible and not covered first. Also on the client: `waitFor`, `pageMap()` (an indexed inventory of everything clickable or fillable on the page), `screenshot()`, `pdf()`, `a11y()`, `setInputFiles`, request interception through `client.gate`, and session recording.

### 4. Drive a browser from Python

```sh
pip install -e clients/python
```

```python
import asyncio, os
from browserglass import AutomationClient, RestClient

async def main():
    rest = RestClient(base_url="http://127.0.0.1:7799/browserglass", token=os.environ["ADMIN_TOKEN"])
    acquired = await rest.acquire(browser={"headless": True})
    client = await AutomationClient.connect(endpoint=acquired.attach.ws_url, token=acquired.attach.ticket)

    await client.acquire_control()
    await client.navigate("https://example.com")
    print(await client.text())

    await client.close()
    await rest.release(acquired.instance_id)
    await rest.aclose()

asyncio.run(main())
```

The Python client speaks the same wire protocol and has no dependency on the Node build. It mirrors the Node API in snake case and includes its own `BrowserSwarm`. See [`clients/python`](clients/python).

### 5. Give an AI agent a browser over MCP

`bgls mcp` starts an MCP server over stdio. Add it to Claude Desktop, Claude Code, or any other MCP host:

```json
{
  "mcpServers": {
    "browserglass": {
      "command": "node",
      "args": [
        "/absolute/path/to/browserglass/packages/cli/dist/bin.mjs",
        "mcp",
        "--endpoint", "http://127.0.0.1:7799"
      ],
      "env": { "BGLS_ADMIN_TOKEN": "paste the output of pnpm bgls token" }
    }
  }
}
```

The agent gets tools for navigation, clicking, typing, filling forms, reading the page, the page map, screenshots, PDF, console and network logs, recording, and `bg_swarm_*` for opening many browsers at once. Point the host at `node` and the built `dist/bin.mjs` as above; MCP hosts spawn the command without a shell, so a bare `bgls` will not resolve.

While the agent works, you can watch the same browser live in a page from scenario 1 or 2.

### 6. An agent drives, a person takes over

The agent holds the control lease. When a person clicks into the stream, they outrank the agent (human priority 100, agent 50), the agent receives a yield event, and the person drives until they hand control back.

```ts
client.onControlYield((ev) => {
  if (ev.human) {
    // a person took over: stop issuing actions
  }
});

await client.waitForResume();   // the person released control
await client.acquireControl();  // carry on
```

The default is exclusive control: one driver at a time, everyone else watches. Set `session: { control: { mode: 'shared' } }` on the server to let both drive at once. [`docs/agent-and-human.md`](docs/agent-and-human.md) covers the three patterns and when each one bites. [`examples/nextjs-demo`](examples/nextjs-demo) is a complete app built on this.

### 7. Several people on one browser

Any number of viewers can watch one tab. In exclusive mode there is a queue for control; in shared mode everyone drives. The React package ships presence, a viewer list, live cursors and a control badge. See [`docs/collaboration.md`](docs/collaboration.md).

### 8. A swarm: many browsers in parallel

From the CLI:

```sh
pnpm bgls swarm run --size 10 --action navigate --value https://example.com --headless
pnpm bgls swarm run --size 10 --action screenshot
```

From Node, `BrowserSwarm` runs one callback against every member concurrently. You supply `acquire()`, so you decide where each browser comes from:

```ts
import { BrowserSwarm } from '@browserglass/automation';

const base = 'http://127.0.0.1:7799/browserglass';
const headers = { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' };

async function acquire(index: number) {
  const inst = await fetch(`${base}/v1/instances`, {
    method: 'POST', headers,
    body: JSON.stringify({ requestId: `swarm-${Date.now()}-${index}`, browser: { headless: 'new' } }),
  }).then((r) => r.json());
  const { token } = await fetch(`${base}/v1/tokens`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sub: 'swarm', subKind: 'service',
      scope: { kind: 'instance', instanceId: inst.instanceId, targets: '*' },
      caps: ['view', 'control', 'navigate', 'automation'], ttlSeconds: 300,
    }),
  }).then((r) => r.json());
  return { instanceId: inst.instanceId, wsUrl: 'ws://127.0.0.1:7799/browserglass/socket', token };
}

const swarm = await BrowserSwarm.open({ size: 10, url: 'https://example.com', acquire });
const results = await swarm.all((member) => member.client.status());
await swarm.grow(5);
await swarm.shrink(3);
await swarm.close();
```

Use a fresh `requestId` per member. The router deduplicates repeat requests inside a 300 second window, so reusing one id gives you the same browser ten times. To get the same browsers back on the next run instead of new ones, pass a sticky subject (`--sticky-subject` on the CLI, `subject` in code). [`packages/automation/PARALLELISM.md`](packages/automation/PARALLELISM.md) lists the limits a swarm actually runs into.

### 9. Embed the gateway in your own Node server

Skip the CLI and run the gateway inside your process:

```js
import { createServer } from 'node:http';
import { createBrowserGlass, generateEd25519KeyMaterial } from '@browserglass/server';

const signingKey = { kid: 'dev', alg: 'EdDSA', ...generateEd25519KeyMaterial() };
const bg = createBrowserGlass({
  mode: 'embedded',
  basePath: '/browserglass',
  tenantId, appId,
  store, runtime,
  profiles: { dir: profilesDir, fs: createProfileFs({ root: profilesDir }) },
  auth: { keys: [signingKey], issuer: appId },
});

const server = createServer((req, res) =>
  bg.handleRequest(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); }));
bg.attach(server);
await bg.start();
server.listen(7500);
```

[`examples/minimal/server.mjs`](examples/minimal/server.mjs) is the full, runnable version, including the store and runtime setup. Adapters for Express, Fastify, Hono and Next.js live in `@browserglass/server`.

### 10. Run it bigger

* **Postgres instead of SQLite:** `pnpm bgls serve --store postgres://user:pass@host/db`.
* **Remote Chrome:** attach to browsers you already run elsewhere, in containers or on other machines, through their CDP endpoint:
  `BGLS_REMOTE_ENDPOINTS=box1=http://10.0.0.5:9222,box2=http://10.0.0.6:9222 pnpm bgls serve --runtime remote`
* **Limits and pools:** admission checks tenant, app, pool and per user ceilings. When a pool is full it rejects, evicts an idle browser, or queues, depending on its `onFull` policy.
* **Several gateways:** point them at one shared store and give each a peer secret. Placement then spans nodes. See [`docs/scaling.md`](docs/scaling.md) for what works across nodes today and what does not.
* **Playwright or Puppeteer:** an optional CDP proxy (`BGLS_CDP_PROXY_ENABLED=1`) lets existing Playwright or Puppeteer code connect to a BrowserGlass browser. See [`docs/cdp-and-interception.md`](docs/cdp-and-interception.md).

## Other features

| Feature | Where |
|---|---|
| Session recording, export to video through an ffmpeg plugin | `bgls record start/stop/list/export`, [`docs/recording.md`](docs/recording.md) |
| Render a tab to PDF | `client.pdf()`, `bg_pdf`, [`docs/pdf.md`](docs/pdf.md) |
| Page map: everything an agent can act on, in one call | `client.pageMap()`, `bg_page_map`, [`docs/page-map.md`](docs/page-map.md) |
| Pause, inspect and modify network requests | `client.gate`, [`docs/cdp-and-interception.md`](docs/cdp-and-interception.md) |
| Persistent browser profiles (cookies and logins survive) | `--profile-key`, [`docs/ownership.md`](docs/ownership.md) |
| Reduced automation fingerprint | [`docs/stealth.md`](docs/stealth.md) |
| Attach to a Chrome you already have open | `bgls attach` |
| Plugins, installed on purpose and loaded only by the CLI | `bgls plugins add/list/remove`, [`docs/plugins.md`](docs/plugins.md) |
| Health checks, including a real launch and click round trip | `bgls doctor --deep` |

## Packages

| Package | What it does |
|---|---|
| `@browserglass/protocol` | Wire types, binary frame codec, capabilities. No runtime dependencies. |
| `@browserglass/core` | The live session engine: CDP bridge, streaming, input, control leases, recovery. |
| `@browserglass/router` | Control plane: placement, admission, quotas, pools, warm pool, profiles. |
| `@browserglass/server` | The gateway: `createBrowserGlass()`, WebSocket protocol, JWT auth, REST, framework adapters. |
| `@browserglass/client` | Framework agnostic browser client: transport, canvas renderer, input capture. |
| `@browserglass/react` | `<BrowserGlass />`, hooks, and UI primitives. |
| `@browserglass/embed` | The `<browser-glass>` custom element. |
| `@browserglass/automation` | `AutomationClient`, `BrowserSwarm`, and the MCP server. |
| `@browserglass/cli` | The `bgls` command. |
| `@browserglass/plugin-api` | Plugin manifest types and validators. |
| `@browserglass/store-sqlite`, `store-postgres` | Persistence. |
| `@browserglass/runtime-host`, `runtime-remote` | Launch Chrome locally, or attach to a remote CDP endpoint. |
| `@browserglass/runtime-docker`, `runtime-k8s` | Placeholders, see Limits. |
| `@browserglass/conformance` | Protocol vectors, store contract tests, end to end tests. Not published. |

## Examples

| Example | Run it |
|---|---|
| [`examples/minimal`](examples/minimal): one Node file and one HTML page | `node examples/minimal/server.mjs`, open http://localhost:7500 |
| [`examples/embed-demo`](examples/embed-demo): three live panes on a static page | see its README |
| [`examples/nextjs-demo`](examples/nextjs-demo): an agent drives, a person watches and takes over | `cd examples/nextjs-demo && npm install && npm run dev` |

All three expect `pnpm install && pnpm -r build` at the repo root first.

## Limits

Read this before you plan around a feature.

* Platforms: Windows is the most tested. Linux runs the full suite apart from a few browser lifecycle tests. On macOS, launching a local Chrome does not work yet. Fixes are in progress; until then, macOS users can attach to a Chrome they start themselves with `--runtime remote`.
* Nothing is published to npm or PyPI yet. Use a clone.
* `bgls serve` only supports dev auth. For real identity (JWKS or HMAC), embed `@browserglass/server` and configure `auth` yourself.
* The Docker and Kubernetes runtimes are placeholders. Use `host` for local Chrome, or `remote` to attach to Chrome you run in containers yourself.
* Several gateways can share placement through one store, but a viewer cannot attach to a browser on another node yet.
* Some CLI commands (`profiles`, `sessions`, `tenants`, `pools`, `backup` and a few others) are registered but print "not implemented".

## Guides

| Guide | Covers |
|---|---|
| [`docs/quickstart.md`](docs/quickstart.md) | Ten browsers in parallel, four ways: CLI, Node, MCP, REST plus WebSocket. |
| [`docs/installing.md`](docs/installing.md) | Installing from a clone. |
| [`docs/adopting.md`](docs/adopting.md) | Ways to adopt BrowserGlass and what each costs. |
| [`docs/agent-and-human.md`](docs/agent-and-human.md) | Handoff between an agent and a person. |
| [`docs/collaboration.md`](docs/collaboration.md) | Several people on one browser. |
| [`docs/ownership.md`](docs/ownership.md) | Getting the same browser back instead of a new one. |
| [`docs/scaling.md`](docs/scaling.md) | More than one gateway. |
| [`docs/cdp-and-interception.md`](docs/cdp-and-interception.md) | CDP proxy and request interception. |
| [`docs/stealth.md`](docs/stealth.md) | What the default launch does about automation signals, and what it does not. |
| [`docs/recording.md`](docs/recording.md), [`docs/pdf.md`](docs/pdf.md), [`docs/page-map.md`](docs/page-map.md) | Recording, PDF, page map. |
| [`docs/plugins.md`](docs/plugins.md) | Writing and installing plugins. |
| [`docs/protocol/wire-spec.md`](docs/protocol/wire-spec.md) | The `bgls.v1` wire protocol, for writing a client in another language. |

## Development

```sh
pnpm install
pnpm -r build
pnpm typecheck
pnpm lint
pnpm test
```

Tests that need a real Chrome skip themselves when none is installed.

## License

Apache 2.0. See [LICENSE](LICENSE).
