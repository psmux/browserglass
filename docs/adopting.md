# Adopting BrowserGlass

You already drive browsers somehow. This page is the eight ways to adopt BrowserGlass on top of what you have, what each costs you, and which tells you to say no.

If you just want to see something running before picking a route, `examples/minimal` is the smallest version: one Node file and one HTML page, nothing else.

## Adoption paths at a glance

| Route | Language | What you bring | What you keep | Setup cost | Driver cost | Where it runs | Control sharing |
|---|---|---|---|---|---|---|---|
| **Native SDK** | TypeScript / Python | None | Your code is the driver | Minutes | Zero | Your app server / script | Full |
| **Playwright/Puppeteer via CDP proxy** | Any | Playwright or Puppeteer | Existing code mostly unchanged | 30 seconds | Medium (token + URL) | Your Playwright code | Full |
| **Bring your own Chrome** | Any | External Chrome binary | That Chrome's process | Five minutes | Zero | Separate machine | Full |
| **MCP** | Any (via Claude) | None | Claude drives it for you | Five minutes | Zero | Claude's own process | Full |
| **REST API** | Any | None | One HTTP library | Minutes | High (verbose, no lease) | Any HTTP client | Blocked for driving |
| **CLI** | Shell / JavaScript | None | `bgls` binary | 30 seconds | Zero | Host running bgls | Limited |
| **Embedded widget** | React / HTML | React or vanilla JS | Browser tab | Minutes | Zero | User's browser | Full |

---

## 1. Native SDK: TypeScript

**What you get.** The full `AutomationClient` surface in your own code. Type safety, every method the protocol offers, and the control lease model that prevents collisions with humans who might take the tab back.

**What you give up.** Nothing. This is the reference implementation.

**The catch.** You need Node.js (or a V8-based runtime). For a web page or a CLI in another language, reach for one of the others.

**How it works.** Install `@browserglass/automation`, open a socket to the gateway, and call methods. `endpoint` is the gateway's WebSocket URL (the `ws endpoint:` line `bgls serve` prints), not its HTTP base URL. The token needs at least `view` and `automation`; [`quickstart.md`](./quickstart.md) shows how to mint one.

```typescript
import { AutomationClient } from '@browserglass/automation';

const client = await AutomationClient.connect({
  endpoint: 'ws://127.0.0.1:7799/browserglass/socket',
  token: 'eyJhbGc...',
  targetId: 'tgt_...', // optional; defaults to the instance's active tab
});

await client.acquireControl();
await client.navigate('https://example.com');
await client.clickAt(412, 318);
await client.humanType('search query');

const text = await client.text(); // document.body.innerText
console.log(text);

await client.releaseControl();
await client.close();
```

Every method is async/await. Control acquisition is explicit: `acquireControl()` before any driving action, `releaseControl()` after, and if a person takes the browser back while you are mid-action, that action throws `LEASE_REVOKED`.

---

## 2. Native SDK: Python

**What you get.** The same full surface, but from Python, without a Node dependency.

**What you give up.** Nothing.

**The catch.** The Python client is in `clients/python` and needs to be packaged separately for your environment. Alpha tag today.

**How it works.** Same socket connection, same contract.

```python
import asyncio
from browserglass import AutomationClient

async def main():
    client = await AutomationClient.connect(
        endpoint='ws://127.0.0.1:7799/browserglass/socket',
        token='eyJhbGc...',
        target_id='tgt_...',
    )
    
    await client.acquire_control()
    await client.navigate('https://example.com')
    await client.click_at(412, 318)
    await client.human_type('search query')
    
    text = await client.text()
    print(text)
    
    await client.release_control()
    await client.close()

asyncio.run(main())
```

See `clients/python/README.md` for install and full API.

---

## 3. Playwright or Puppeteer via CDP proxy

**What you get.** Point Playwright's `connectOverCDP()` (or Puppeteer's `connect()`) at a BrowserGlass gateway and drive a BrowserGlass-hosted browser the same way you would drive bare Chrome. Your script needs almost no changes.

**What you give up.** Nothing at the method level. The WebSocket proxy forwards every CDP message unchanged and does not filter methods, which is exactly why it is off by default. See `security.cdpProxyEnabled` in `packages/server/src/config/types.ts` for the security argument. The proxy only reaches instances launched by the gateway you connect to, not ones another node in a cluster launched.

**The catch.** One: the gateway must opt in (`security.cdpProxyEnabled: true` in config), and the token needs the `cdp` capability, which no role bundle grants, so it has to be named explicitly. Two: you pass the token as `?token=` in the WebSocket URL, not as a header, because a raw CDP client cannot carry headers on a WebSocket upgrade. Three: control sharing with humans works, but bluntly. The proxy takes the control lease on the instance's first tab when you connect, and if a person takes it back the gateway closes your CDP socket (close code 4611). Your script sees a disconnect it can catch.

**How it works.** The gateway serves a WebSocket proxy at `<basePath>/cdp/<instanceId>`. It also answers `GET /json/version` and `GET /json/list` at the origin root, like bare Chrome does, but because one gateway fronts many browsers those two need an explicit `?instanceId=` as well as `?token=`. The simplest path is to skip discovery and hand Playwright the WebSocket URL directly:

```javascript
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(
  'ws://127.0.0.1:7799/browserglass/cdp/inst_01M16...?token=eyJhbGc...'
);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

await page.goto('https://example.com');
await page.click('button[type=submit]');
console.log(await page.title());

await browser.close();
```

The proxy joins you to the same presence roster and lease model every other viewer follows. You show up with `kind: 'agent'` and a `cdp:` label, so a person watching can see that a program is driving.

**Tested against real Chrome.** `examples/nextjs-demo/cdp-attach-probe.mjs` drives a BrowserGlass browser through this proxy with a hand written CDP client (`/json/version`, `Target.attachToTarget`, `Page.navigate`, `Runtime.evaluate`) and checks that Chrome's real debugging URL never leaks.

---

## 4. Bring your own Chrome

**What you get.** You launch Chrome on your own machine (or any machine you can reach), and the gateway attaches to it instead of launching its own. This is the route for patchright users who want patchright's launch patches plus BrowserGlass's router, leases, and multi-viewer presence on top.

**What you give up.** You own the Chrome process. You handle all the startup flags yourself; the gateway will not add any.

**The catch.** The Chrome you attach must already have `--remote-debugging-port` open, and the gateway has to be able to reach that port. The attachment is configured on the gateway, not in the client. No client option points at a debugging port.

**How it works.** Start Chrome with a debugging port, then start the gateway with the `remote` runtime and name the endpoint in `BGLS_REMOTE_ENDPOINTS` (comma separated `name=url` pairs; the first one becomes the default pool's endpoint):

```bash
# Your Chrome, launched however you like
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/my-chrome

# A gateway that attaches to it instead of launching Chrome itself
BGLS_REMOTE_ENDPOINTS=mychrome=http://127.0.0.1:9222 \
  pnpm bgls serve --runtime remote --listen 127.0.0.1:7799

# Acquire an instance; it lands on your Chrome
pnpm bgls instances create
```

From there it is an ordinary instance. Connect with the SDK exactly as in route 1, and the presence roster and lease model apply as usual. By default the gateway applies a device metrics override so the viewport matches the pool spec. Set `BGLS_REMOTE_NO_EMULATION=1` to keep the real window size of a Chrome that sits on a real screen.

If you embed `@browserglass/server` yourself, the same thing is `new RemoteRuntime({ endpoints: [...] })` from `@browserglass/runtime-remote`, plus `remoteEndpointName` on the browser spec.

**Tested against real Chrome.** `examples/nextjs-demo/remote-endpoint-probe.mjs` launches its own Chrome, registers it with a `RemoteRuntime` in an embedded gateway, acquires an instance on it, and drives it with `AutomationClient`.

---

## 5. MCP: Claude driving it for you

**What you get.** Claude reads the `pnpm bgls mcp` tool manifest and gets 40 tools covering the driving surface, the locator engine, a whole-page `bg_page_map` inventory, and swarm operations. You write a prompt, Claude drives a browser or a swarm of browsers, and you get the results back.

**What you give up.** Nothing about what BrowserGlass does. You give up code ownership: Claude is the driver, and you read logs to understand what it did.

**The catch.** MCP is a one-way pipe: Claude calls tools, the tools return results, but the tools never loop back to Claude to ask "should I click the thing I just found". Your prompt has to be clear enough that Claude makes the right call on first sight. For the rare case where Claude needs more information before deciding (a verification screenshot, a second locator check), it can call tools to get it, but it is your job to ask for that in the prompt.

**How it works.** Run `pnpm bgls mcp` in your terminal, connect it to Claude, and give Claude a task. The server exports these 40 tools:

**Driving and locomotion:** `bg_status`, `bg_navigate`, `bg_back`, `bg_forward`, `bg_reload`, `bg_stop`, `bg_click`, `bg_type`, `bg_press_key`, `bg_scroll`, `bg_control`, `bg_screenshot`, `bg_pdf`, `bg_recording`, `bg_set_input_files`, `bg_wait_for_navigation`, `bg_tabs`

**Locators and inspection:** `bg_resolve`, `bg_evaluate`, `bg_wait_for`, `bg_wait_for_text`, `bg_get_text`, `bg_get_attribute`, `bg_is_checked`, `bg_get_html`, `bg_scroll_into_view`, `bg_read_page`

**Form filling:** `bg_fill`, `bg_select`

**Whole-page inventory:** `bg_page_map`, a flat, indexed map of every actionable element (tag, role, name, rect, occlusion), gated on `devtools` rather than `evaluate` because it runs no page script; see [`../docs/page-map.md`](../docs/page-map.md).

**Diagnostics:** `bg_diagnostics_subscribe`, `bg_read_console`, `bg_read_network`, `bg_wait_for_network_idle`

**Swarms:** `bg_swarm_open`, `bg_swarm_list`, `bg_swarm_grow`, `bg_swarm_shrink`, `bg_swarm_close`, `bg_swarm_run`

Run it from the directory `bgls serve` was started in and `bgls mcp` finds the gateway on its own, through `dev-session.json`. Against any other gateway, give it the HTTP base URL and an admin token:

```bash
export BGLS_ENDPOINT=http://127.0.0.1:7799
export BGLS_ADMIN_TOKEN=eyJhbGc...
pnpm bgls mcp
```

The admin token is only used to mint narrower, per instance tokens. `bgls mcp` opens one instance at startup (or binds to `--instance-id`) and mints more when `bg_swarm_open` asks for them.

Then in Claude, add the MCP server (its own instructions will walk you through this), and ask Claude to do something. Example: "Navigate to example.com, find the login form, fill it with user@example.com and password-here, then take a screenshot."

Claude acquires control, fills the form, releases control, and you get back the screenshot base64.

See `packages/automation/PARALLELISM.md` for the swarm surface and how to drive many browsers concurrently.

---

## 6. REST API

**What you get.** HTTP POST and GET to every browser operation. No WebSocket, no long-lived connection, just stateless HTTP requests.

**What you give up.** Leases and control sharing in the usual sense. A pure REST caller has no socket, so it cannot be told when a person takes the browser back. Driving routes refuse with `E_SESSION_NOT_LIVE` (409, retryable) when the gateway holds no live session for the instance yet, for example right after a gateway restart before any viewer has reconnected. If you want a lease you hold across calls, use one of the routes above.

**The catch.** The REST surface is small. There is no locator engine, no text read, and no evaluate over REST. What exists: create, list, describe and release instances; list, open and close targets; `navigate` (`goto`, `back`, `forward`, `reload`, `stop`); a `screenshot`; raw `input` (a `click` at a point, or `type` text); file upload; and an allowlisted CDP passthrough behind the `cdp` capability. Every call is one HTTP round trip.

**How it works.** Routes live under `<basePath>/v1/instances/:instanceId/targets/:targetId/...`, with no session id in the path. Pass a bearer token in the `Authorization` header. The full route table is in `packages/server/src/rest/router.ts`.

```bash
# Mint a token. $ADMIN_TOKEN can come from `pnpm bgls token`, run where the gateway was started.
TOKEN=$(curl -s -X POST http://127.0.0.1:7799/browserglass/v1/tokens \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "sub": "my-rest-caller",
    "scope": { "kind": "instance", "instanceId": "inst_01M16..." },
    "caps": ["view", "control", "navigate", "capture"]
  }' | jq -r .token)

# Navigate
curl -X POST http://127.0.0.1:7799/browserglass/v1/instances/inst_01M16.../targets/tgt_01M16.../navigate \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"url": "https://example.com"}'

# Click at a point
curl -X POST http://127.0.0.1:7799/browserglass/v1/instances/inst_01M16.../targets/tgt_01M16.../input \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"action": "click", "x": 412, "y": 318}'

# Screenshot (JSON with base64 image data)
curl "http://127.0.0.1:7799/browserglass/v1/instances/inst_01M16.../targets/tgt_01M16.../screenshot?format=png" \
  -H "authorization: Bearer $TOKEN"
```

Every operation returns a JSON object. `GET /v1/instances/:instanceId/targets` lists the target ids.

---

## 7. CLI: bgls commands

**What you get.** Shell commands that drive a browser or a swarm of browsers.

**What you give up.** No real give-up, but the CLI is the thinnest layer: most commands are read-only or query-only. Driving verbs are limited.

**The catch.** Much of the CLI is still stubs. Real commands include `bgls serve`, `bgls doctor`, `bgls token`, `bgls mcp`, `bgls swarm run`, and under `bgls instances`: `list`, `describe`, `create`, `release`, `targets`, `open-target`, `close-target`, `navigate`, `click`, `type`, `screenshot`, `console`, and `network`. Stub commands (registered but not implemented) include everything under `bgls nodes`, `bgls profiles`, and `bgls sessions`.

**How it works.** You have already used it in `docs/quickstart.md`: run `pnpm bgls serve` to start a gateway, then `pnpm bgls instances create` and `pnpm bgls instances click` to drive a browser. Run these from the same directory as `bgls serve`, or pass `--endpoint` and `--token` (env `BGLS_ENDPOINT`, `BGLS_ADMIN_TOKEN`).

```bash
pnpm bgls instances create
# Shows: created inst_01M16...  [ready]

pnpm bgls instances navigate inst_01M16... --url https://example.com

pnpm bgls instances click inst_01M16... --x 412 --y 318

pnpm bgls instances screenshot inst_01M16... --out screenshot.png
```

`--target tgt_...` picks a tab; without it each command acts on the instance's active tab. `bgls instances create` takes `--pool`, `--profile-key`, `--headless`, `--viewport WxH`, and `--dry-run`.

The CLI does not hold control across commands: each one acquires, runs, and releases. This means a person watching the session will see the actions but not be blocked if they want to type something in.

---

## 8. Embedded widget: React and HTML

**What you get.** Drop `<BrowserGlass />` into a React component, or embed `<browser-glass />` as a custom element in any HTML page, and you have a live browser streaming in a pane on that page. Users can click, type, and take over if an agent is driving. Humans and agents share control the same way they do in the NextJS demo.

**What you give up.** The widget streams video and captures input, but you drive it with the APIs above (native SDK, Playwright, MCP, etc.). The widget is the viewer side, not the driver side.

**The catch.** Token expiry. Tokens are capped at 900 seconds server side. You need to refresh before the token dies, or the widget stops streaming and shows a disconnection state. Set `el.onTokenExpired = async () => newToken` as a JS property (checked live on every refresh), or set `token-endpoint="..."` to a URL the widget fetches from, or replace the `token` attribute yourself. None of the three is required; without one, an expired token shows a fatal error.

**How it works.** In React:

```tsx
import { BrowserGlass } from '@browserglass/react';

export function BrowserTab({ gatewayUrl, token, targetId }) {
  // Your backend mints the token and passes all three to this page
  return (
    <BrowserGlass
      url={gatewayUrl}
      token={token}
      targetId={targetId}
    />
  );
}
```

In HTML:

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Build: pnpm --filter @browserglass/embed build -->
    <!-- Serve the built file yourself (not on a CDN until published) -->
    <script src="/vendor/browserglass-embed.global.js"></script>
  </head>
  <body>
    <browser-glass
      id="pane"
      url="wss://your-gateway/browserglass/socket"
      token="token-your-backend-minted"
      target-id="tgt_01M16..."
      fit="contain"
    ></browser-glass>

    <script>
      const pane = document.getElementById('pane');
      
      // Token refresh option 1: JS property (read live)
      pane.onTokenExpired = async () => {
        const res = await fetch('/api/token');
        return (await res.json()).token;
      };
      
      // Token refresh option 2: URL (fetches {token: "..."})
      // pane.setAttribute('token-endpoint', '/api/token');
      
      // Token refresh option 3: Manually update the attribute
      // setInterval(async () => {
      //   const res = await fetch('/api/token');
      //   pane.setAttribute('token', (await res.json()).token);
      // }, 600000);
      
      // Listen to events
      pane.addEventListener('bgls:connected', (e) => {
        console.log('connected, viewer:', e.detail.viewerId);
      });
      pane.addEventListener('bgls:disconnected', (e) => {
        console.log('disconnected:', e.detail.reason);
      });
      pane.addEventListener('bgls:controlgained', () => {
        console.log('control gained');
      });
      pane.addEventListener('bgls:controllost', (e) => {
        console.log('control lost:', e.detail.reason);
      });
      pane.addEventListener('bgls:navigation', (e) => {
        console.log('navigated to:', e.detail.url);
      });
      pane.addEventListener('bgls:error', (e) => {
        console.log('error:', e.detail.code);
      });
      
      // Call methods
      pane.navigate('https://example.com').catch(console.error);
      pane.takeControl().catch(console.error);
    </script>
  </body>
</html>
```

**Element attributes:** `url` (WebSocket URL), `token`, `target-id` (required); `fit` (contain or cover), `readonly` (if present, blocks input capture). Element reflects `state` (connecting/live/degraded/reconnecting/fatal), `has-control` (present when holding lease), `error` (error code if something is wrong).

**Methods:** `navigate(url)`, `reload()`, `screenshot()`, `takeControl()`, `releaseControl()`, `clickAt(x, y)`, `type(text)`.

**Events:** `bgls:connected`, `bgls:disconnected`, `bgls:controlgained`, `bgls:controllost`, `bgls:navigation`, `bgls:console`, `bgls:pageerror`, `bgls:error`.

**Install:** Build `packages/embed` with `pnpm --filter @browserglass/embed build`, then serve `packages/embed/dist/browserglass-embed.global.js` from your own static files (not a CDN until the package is published to npm). See `packages/embed/README.md` for alternatives.

For control-sharing, see `docs/agent-and-human.md` (an agent and a person on one browser) and `docs/collaboration.md` (two or more people on one browser). A person clicking or typing in the widget takes control over an agent-driven browser; the agent receives an `onControlYield` event.

---

## Choosing

* **You own a Node.js app server:** Native SDK (TypeScript). You get the full surface, type safety, and control sharing without extra work. Python SDK if it is Python.
* **You already use Playwright or Puppeteer:** Route 3 (CDP proxy). Almost no code changes; you keep everything you have.
* **You want to launch and manage Chrome yourself:** Route 4 (bring your own Chrome). Pair it with patchright if you want its launch-time patches too.
* **You want Claude to drive it:** Route 5 (MCP). Give it a prompt, it handles the locators, filling, and clicking.
* **You need to call from a language we do not have an SDK for:** Route 6 (REST). It is verbose but it works.
* **You are operating it from the shell:** Route 7 (CLI). Great for one-off testing and ops.
* **You are building a web page where users see the browser:** Route 8 (embedded widget). Use it with any of the routes above to drive it (usually Native SDK or MCP from the backend).
