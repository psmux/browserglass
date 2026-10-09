# BrowserGlass

[![CI](https://github.com/psmux/browserglass/actions/workflows/ci.yml/badge.svg)](https://github.com/psmux/browserglass/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Real Chrome browsers you can drive from code, hand to an AI agent, and watch live in any web page. When the script gets stuck, a person clicks into the stream and takes over. When they let go, the script carries on.

![An agent drives a browser in a web page while a person watches, then the person takes over the same tab](docs/media/agent-and-human.gif)

*Above: the Next.js demo in this repo. An agent called Scout types into the middle tab on its own. Then a person clicks Take control and both drive the same tab. Recorded with BrowserGlass's own session recorder.*

## Showcase

Every clip below is a real run, recorded by BrowserGlass itself, and every one is a script you can run: click a clip to open it. They all use throwaway browsers and public demo sites.

<table>
<tr>
<td width="33%" valign="top"><a href="examples/showcase/books-to-csv.mjs"><img src="docs/media/showcase/books-to-csv.gif" alt="Export a book catalog to CSV" width="100%"></a><br><b>Export a book catalog to CSV</b><br><sub>books.toscrape.com · 0:11 · Data extraction</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/demo-shop-checkout.mjs"><img src="docs/media/showcase/demo-shop-checkout.gif" alt="Log in, fill a cart, check out" width="100%"></a><br><b>Log in, fill a cart, check out</b><br><sub>saucedemo.com · 0:17 · Forms and checkout</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/nine-browsers-live.mjs"><img src="docs/media/showcase/nine-browsers-live.gif" alt="Nine browsers live in one page" width="100%"></a><br><b>Nine browsers live in one page</b><br><sub>9 sites at once · 0:19 · Parallel</sub></td>
</tr>
<tr>
<td width="33%" valign="top"><a href="examples/showcase/mcp-agent.mjs"><img src="docs/media/showcase/mcp-agent.gif" alt="An MCP agent drives the browser" width="100%"></a><br><b>An MCP agent drives the browser</b><br><sub>wikipedia.org · 0:12 · Agent workflows</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/wikipedia-research.mjs"><img src="docs/media/showcase/wikipedia-research.gif" alt="Research a topic into notes" width="100%"></a><br><b>Research a topic into notes</b><br><sub>wikipedia.org · 0:13 · Research</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/infobox-table.mjs"><img src="docs/media/showcase/infobox-table.gif" alt="Compare four languages in a table" width="100%"></a><br><b>Compare four languages in a table</b><br><sub>wikipedia.org · 0:13 · Data extraction</sub></td>
</tr>
<tr>
<td width="33%" valign="top"><a href="examples/showcase/todo-app.mjs"><img src="docs/media/showcase/todo-app.gif" alt="Add, complete and filter todos" width="100%"></a><br><b>Add, complete and filter todos</b><br><sub>TodoMVC demo · 0:16 · Testing and QA</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/file-upload.mjs"><img src="docs/media/showcase/file-upload.gif" alt="Upload a file through a form" width="100%"></a><br><b>Upload a file through a form</b><br><sub>the-internet.herokuapp.com · 0:07 · Forms and checkout</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/quotes-by-tag.mjs"><img src="docs/media/showcase/quotes-by-tag.gif" alt="Collect every quote for a tag" width="100%"></a><br><b>Collect every quote for a tag</b><br><sub>quotes.toscrape.com · 0:11 · Data extraction</sub></td>
</tr>
<tr>
<td width="33%" valign="top"><a href="examples/showcase/github-releases.mjs"><img src="docs/media/showcase/github-releases.gif" alt="Pull the latest releases" width="100%"></a><br><b>Pull the latest releases</b><br><sub>github.com/microsoft/vscode · 0:11 · Research</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/typing-test.mjs"><img src="docs/media/showcase/typing-test.gif" alt="Take a typing test, key by key" width="100%"></a><br><b>Take a typing test, key by key</b><br><sub>typings.gg · 0:18 · Games and real time</sub></td>
<td width="33%" valign="top"><a href="examples/showcase/play-2048.mjs"><img src="docs/media/showcase/play-2048.gif" alt="Play 2048 with arrow keys" width="100%"></a><br><b>Play 2048 with arrow keys</b><br><sub>play2048.co · 0:19 · Games and real time</sub></td>
</tr>
<tr>
<td width="33%" valign="top"><a href="examples/showcase/block-images.mjs"><img src="docs/media/showcase/block-images.gif" alt="Block images and CSS for a faster crawl" width="100%"></a><br><b>Block images and CSS, crawl 2.3x faster</b><br><sub>books.toscrape.com · 0:12 · Data extraction</sub></td>
<td width="33%" valign="top"><a href="docs/media/agent-and-human.gif"><img src="docs/media/agent-and-human.gif" alt="An agent drives, a person takes over" width="100%"></a><br><b>An agent drives, a person takes over</b><br><sub>Next.js demo in this repo · 0:33 · Agent workflows</sub></td>
<td width="33%" valign="top"><a href="docs/media/page-map-and-typing.gif"><img src="docs/media/page-map-and-typing.gif" alt="Map the page, then type like a person" width="100%"></a><br><b>Map the page, then type like a person</b><br><sub>wikipedia.org · 0:09 · Research</sub></td>
</tr>
</table>

More about each run, with its output: [`docs/showcase.md`](docs/showcase.md).

## What it does

| | |
|---|---|
| Automate | Navigate, click, type, fill forms, upload files, read text, take screenshots and PDFs. Selectors understand CSS, `label=`, `text=` and `role=`. Clicks and keystrokes are real input events, not `element.click()`. |
| See the page like an agent | `pageMap()` returns every element you can act on, numbered, with its box on screen and whether something covers it. One call instead of guessing selectors. |
| Stream it live | Any tab, streamed into your web page through a React component, a `<browser-glass>` tag, or a plain JS client. Many people can watch one tab. |
| Hand control back and forth | Every tab has a control lease. A script, an agent, or a person holds it. People outrank agents by default, and the agent gets told when someone takes over. |
| Give an AI agent a browser | `bgls mcp` exposes 41 tools over MCP, for Claude Code, Claude Desktop and any other MCP host. |
| Run many at once | `BrowserSwarm` opens ten or a hundred browsers and runs one function on all of them in parallel. |
| Keep logins | Persistent profiles keep cookies and storage between runs. |
| Control the network | Pause, inspect, block or allow requests before they leave the browser. |
| Record sessions | Record a tab to disk and export it as images or a video. |
| Use any language | Node and Python clients, a REST API, a CLI, and a documented wire protocol for anything else. |

## Quick start

You need Node 22+, pnpm (through corepack) and Google Chrome or Chromium.

```sh
git clone https://github.com/psmux/browserglass.git
cd browserglass
corepack enable
pnpm install
pnpm -r build
pnpm bgls serve --listen 127.0.0.1:7799
```

```
✔ bgls gateway listening at http://127.0.0.1:7799
ℹ data directory: ./bgls-data
ℹ ws endpoint:    ws://127.0.0.1:7799/browserglass/socket
```

That is the gateway. It launches and supervises the Chrome processes. Leave it running and open a second terminal in the same folder:

```sh
export BGLS_ADMIN_TOKEN=$(pnpm -s bgls token --ttl 900)
```

Now drive a browser. Save this as `hello.mjs` in the repo folder and run `node hello.mjs`:

```js
import { AutomationClient } from '@browserglass/automation';

const browser = await AutomationClient.launch(); // reads BGLS_ADMIN_TOKEN
try {
  await browser.navigate('https://en.wikipedia.org/wiki/Web_browser');
  await browser.fill('input[name="search"]', 'Headless browser');
  await browser.pressKey('Enter');
  await browser.waitFor('text="Headless browser"');
  console.log(await browser.text());
} finally {
  await browser.release(); // ends the browser
}
```

![The browser maps the page, clicks into the search box and types like a person](docs/media/page-map-and-typing.gif)

No code at all? The CLI does the common things:

```sh
pnpm bgls swarm run --size 5 --action navigate --value https://example.com   # five browsers at once
pnpm bgls instances list
pnpm bgls instances screenshot <instanceId> --out shot.png
pnpm bgls doctor --deep                                                      # checks Chrome, the store, a real launch
```

The token from `bgls token` lasts 15 minutes at most. Run the export line again when a script says `UNAUTHENTICATED`.

## Use cases

Each one links to a runnable script in [`examples/recipes`](examples/recipes). Every recipe was run against a real gateway before it went in.

### Give Claude (or any MCP agent) a real browser

```sh
claude mcp add browserglass \
  -e BGLS_DATA_DIR=/path/to/browserglass/bgls-data \
  -- node /path/to/browserglass/packages/cli/dist/bin.mjs mcp --endpoint http://127.0.0.1:7799 --headless
```

Then ask it things like *"Open five browsers with bg_swarm_open, send each to the Wikipedia page of a different programming language, and tell me the year each first appeared."* The agent gets tools for navigating, clicking, filling forms, reading the page, the page map, screenshots, PDFs, console and network logs, recording and swarms. Drop `--headless` to watch the window. Claude Desktop config and more prompts: [`examples/recipes/mcp.md`](examples/recipes/mcp.md).

### Let a person step in: logins, 2FA, CAPTCHAs, approvals

The script does the boring part, stops, and waits for a human. The human opens the same browser in a web page, does the part only a person can do, and lets go. The script picks up where it stopped.

```js
await browser.fill('label=Username', 'tomsmith');
await browser.yieldControl('need a person to enter the password');
await browser.waitForResume({ timeoutMs: 10 * 60_000 }); // a person took over and handed back
await browser.acquireControl();
await browser.click('role=button[name="Login"]');
```

Show the browser to the person with the React component or the `<browser-glass>` tag below. Recipe: [`human-in-the-loop.mjs`](examples/recipes/human-in-the-loop.mjs).

### Screenshot many pages in parallel

```js
import { BrowserSwarm } from '@browserglass/automation';

const urls = ['https://example.com', 'https://news.ycombinator.com', /* ... */];
const swarm = await BrowserSwarm.open({ size: urls.length, launch: {} });
await swarm.all(async (member, i) => {
  await member.client.navigate(urls[i]);
  const shot = await member.client.screenshot();
  writeFileSync(`shot-${i}.png`, Buffer.from(shot.data, 'base64'));
});
await swarm.close();
```

![Nine screenshots from nine browsers that ran at the same time](docs/media/swarm-9-browsers.png)

*Nine browsers, nine sites, one run: about 20 seconds on a laptop.* Recipe: [`parallel-screenshots.mjs`](examples/recipes/parallel-screenshots.mjs).

### Scrape without fighting selectors

`pageMap()` gives you every clickable and fillable element, numbered, with its text, role and position. Pick what you want by name, then act on it.

![Every actionable element on a page, numbered by the page map](docs/media/page-map.png)

```js
const map = await browser.pageMap();
const next = map.nodes.find((n) => n.role === 'link' && n.name === 'Next →');
```

Or just read the text: `await browser.text()`. Recipe: [`scrape-quotes.mjs`](examples/recipes/scrape-quotes.mjs) collects quotes and authors across pages and prints JSON.

### Fill and submit forms

```js
await browser.navigate('https://httpbin.org/forms/post');
await browser.fill('label=Customer name', 'Ada Lovelace');
await browser.fill('label=Telephone', '555 0100');
await browser.click('label=Medium');
await browser.click('role=button[name="Submit order"]');
```

File inputs work too: `await browser.setInputFiles('input[type=file]', ['./invoice.pdf'])`. Recipe: [`fill-form.mjs`](examples/recipes/fill-form.mjs).

### Stay logged in between runs

```js
const browser = await AutomationClient.launch({ profileKey: 'work-account' });
```

Same key, same cookies and local storage next time. Log in once (or let a person log in, see above) and every later run starts signed in. Recipe: [`persistent-login.mjs`](examples/recipes/persistent-login.mjs).

### Block images, ads or trackers

![The same page with and without images and stylesheets](docs/media/block-requests.png)

```js
browser.gate.onPaused((req) => 'deny');
await browser.gate.enable([
  { urlPattern: '*', resourceTypes: ['Image'], verdict: 'ask' },
  { urlPattern: '*doubleclick.net*', verdict: 'deny' },
]);
```

`ask` hands each matching request to your function; `allow` and `deny` are decided inside the gateway with no round trip. Recipe: [`block-requests.mjs`](examples/recipes/block-requests.mjs).

### Save pages as PDF

<img src="docs/media/pdf-page1.png" alt="Page one of a Wikipedia article saved as PDF" width="360" align="right">

```js
const pdf = await browser.pdf({ format: 'A4' });
```

Small PDFs come back inline as base64; large ones as a download link. Chrome's own print engine renders them, so they look like printing the page. Recipe: [`save-pdf.mjs`](examples/recipes/save-pdf.mjs).

<br clear="right">

### Record a session

```js
const rec = await browser.startRecording();
// ... do things ...
await browser.stopRecording(rec.recordingId);
```

```sh
pnpm bgls record export <recordingId> --out frames/   # JPEG frames plus timing
```

The GIFs on this page were made this way. Recipe: [`record-session.mjs`](examples/recipes/record-session.mjs).

### Put a live browser in your own app

Your server starts a browser and mints a short lived token for it. The page shows the stream, and the user can click into it.

```tsx
import { BrowserGlass } from '@browserglass/react';

<BrowserGlass url="ws://127.0.0.1:7799/browserglass/socket" token={token} style={{ width: 960, height: 600 }} />
```

No React? Use the custom element:

```html
<script src="browserglass-embed.global.js"></script>
<browser-glass url="ws://127.0.0.1:7799/browserglass/socket" token="eyJ..."></browser-glass>
```

Build it with `pnpm --filter @browserglass/embed build`. The token comes from two REST calls on your server; see [`docs/quickstart.md`](docs/quickstart.md). If the page is on another origin, start the gateway with `--cors http://localhost:3000`. The React package also has hooks (`useTargets`, `useNav`, `useControlLease`, `usePresence`, `useConsole`, `useNetwork`) and ready made controls under `@browserglass/react/ui`.

### Python

```sh
pip install -e clients/python
```

```python
import asyncio
from browserglass import AutomationClient

async def main():
    browser = await AutomationClient.launch()  # reads BGLS_ADMIN_TOKEN
    try:
        await browser.navigate("https://example.com")
        print(await browser.text())
    finally:
        await browser.release()

asyncio.run(main())
```

Same API in snake case, including `BrowserSwarm`. See [`clients/python`](clients/python). Recipe: [`python/quickstart.py`](examples/recipes/python/quickstart.py).

## How it fits together

```mermaid
flowchart LR
  subgraph you[Your side]
    W["Web page<br/>React, &lt;browser-glass&gt;, plain JS"]
    A["Code and agents<br/>Node, Python, MCP, REST, CLI"]
  end
  subgraph gw["bgls gateway"]
    S["server<br/>WebSocket, REST, auth"]
    R["router<br/>placement, quotas, pools, profiles"]
    C["core<br/>CDP, streaming, input, leases, recovery"]
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

Everything talks to the gateway. Your code never touches Chrome directly, which is what lets a person and a script share a tab safely, and lets the gateway restart a crashed page without your script noticing much.

## Running it bigger

* Postgres instead of SQLite: `pnpm bgls serve --store postgres://user:pass@host/db`.
* Chrome on other machines or in containers: `BGLS_REMOTE_ENDPOINTS=box1=http://10.0.0.5:9222,box2=http://10.0.0.6:9222 pnpm bgls serve --runtime remote`.
* Limits: tenant, app, pool and per user ceilings. A full pool rejects, evicts an idle browser, or queues.
* Several gateways: point them at one shared store. See [`docs/scaling.md`](docs/scaling.md) for what works across nodes today.
* Embed the gateway in your own Node server instead of running `bgls serve`: [`examples/minimal/server.mjs`](examples/minimal/server.mjs). Adapters for Express, Fastify, Hono and Next.js are in `@browserglass/server`.
* Playwright and Puppeteer can connect through an optional CDP proxy: [`docs/cdp-and-interception.md`](docs/cdp-and-interception.md).

## Packages

| Package | What it is |
|---|---|
| `@browserglass/automation` | `AutomationClient`, `BrowserSwarm`, and the MCP server. Start here for scripts. |
| `@browserglass/react` | `<BrowserGlass />`, hooks and UI pieces for showing a live browser. |
| `@browserglass/embed` | The `<browser-glass>` custom element. |
| `@browserglass/client` | The framework free browser client underneath both. |
| `@browserglass/cli` | The `bgls` command. |
| `@browserglass/server` | The gateway, to embed in your own Node process. |
| `@browserglass/core`, `router`, `protocol` | Session engine, control plane, wire types. |
| `@browserglass/runtime-host`, `runtime-remote` | Launch Chrome locally, or attach to a remote CDP endpoint. |
| `@browserglass/store-sqlite`, `store-postgres` | Persistence. |
| `@browserglass/plugin-api` | Types for writing plugins. |
| [`clients/python`](clients/python) | The Python client. |

## Examples

| | |
|---|---|
| [`examples/recipes`](examples/recipes) | Small scripts, one job each. The use cases above. |
| [`examples/nextjs-demo`](examples/nextjs-demo) | The app in the GIF at the top: an agent drives, people watch and take over. `cd examples/nextjs-demo && npm install && npm run dev` |
| [`examples/minimal`](examples/minimal) | The smallest app that shows a live browser: one Node file, one HTML page. |
| [`examples/embed-demo`](examples/embed-demo) | Three live `<browser-glass>` panes on a static page. |

All of them expect `pnpm install && pnpm -r build` at the repo root first.

## Limits

* Alpha. Nothing is on npm or PyPI yet, so you run it from a clone.
* `bgls serve` only does dev auth, with a key generated per run. For real identity, embed `@browserglass/server` and configure `auth` yourself.
* The Docker and Kubernetes runtimes are placeholders. Use `host` for local Chrome, or `remote` for Chrome you run in containers yourself.
* Several gateways can share placement through one store, but a viewer cannot yet attach to a browser on another node.
* Some CLI commands (`profiles`, `sessions`, `tenants`, `pools`, `backup` and a few more) print "not implemented".

## Guides

| Guide | Covers |
|---|---|
| [`docs/quickstart.md`](docs/quickstart.md) | Ten browsers in parallel four ways: CLI, Node, MCP, REST. Minting viewer tokens. |
| [`docs/agent-and-human.md`](docs/agent-and-human.md) | How control passes between an agent and a person. |
| [`docs/collaboration.md`](docs/collaboration.md) | Several people on one browser. |
| [`docs/ownership.md`](docs/ownership.md) | Getting the same browser back instead of a new one. |
| [`docs/page-map.md`](docs/page-map.md) | What the page map returns and what it promises. |
| [`docs/cdp-and-interception.md`](docs/cdp-and-interception.md) | The CDP proxy and request interception. |
| [`docs/recording.md`](docs/recording.md), [`docs/pdf.md`](docs/pdf.md) | Recording and PDF. |
| [`docs/stealth.md`](docs/stealth.md) | What the default launch does about automation signals, and what it does not. |
| [`docs/scaling.md`](docs/scaling.md) | More than one gateway. |
| [`docs/plugins.md`](docs/plugins.md) | Plugins, such as video export. |
| [`docs/protocol/wire-spec.md`](docs/protocol/wire-spec.md) | The `bgls.v1` protocol, for writing a client in another language. |

## Development

```sh
pnpm install
pnpm -r build
pnpm typecheck
pnpm lint
pnpm test
```

Tests that need a real Chrome skip themselves when none is installed. CI runs the full suite on Linux, Windows and macOS.

## License

Apache 2.0. See [LICENSE](LICENSE).
