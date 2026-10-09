# Quickstart: ten browsers, driven concurrently

This walks a newcomer from nothing to ten real Chrome browsers running at
once, driven concurrently, shown four ways: the `bgls` CLI, Node's
`BrowserSwarm`, MCP, and plain REST plus a WebSocket for any other
language. Every command and code snippet below was actually run against a
live gateway on this machine while writing this doc, not copied from a
design note. Where something in this build does not work the way you
might expect, that is written down here rather than papered over.

## 1. Install and build

This repository is not yet cut into small standalone installs for every
piece; the fastest path today is a full workspace build. `pnpm install` is
also what puts `bgls` within reach: the root `package.json` depends on
`@browserglass/cli` and defines a `bgls` script, so once install finishes,
`pnpm bgls <command>` resolves. Every command below is run from the
repository root, using that exact form.

```sh
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm -r build
```

You need a real Chrome or Chromium on this machine. `pnpm bgls doctor`
(below) tells you if it cannot find one.

If you only want the packages, not this monorepo: nothing is on the npm
registry yet, alpha tagged or otherwise. See
[`installing.md`](./installing.md) for the plan (`@browserglass/server`,
`@browserglass/react`, `@browserglass/automation`, `@browserglass/cli`, and
so on) and for what actually works today, which is cloning this repository.

## 2. Start a gateway

```sh
pnpm bgls serve --listen 127.0.0.1:7799
```

Real output from this exact command:

```
✔ bgls gateway listening at http://127.0.0.1:7799
ℹ data directory: ./bgls-data
ℹ ws endpoint:    ws://127.0.0.1:7799/browserglass/socket
ℹ Press Ctrl+C to stop.
```

Without `--listen` the gateway binds `127.0.0.1:7443`. Every example on
this page uses port 7799 because the command above asked for it.

This is `--auth dev`, the default: an ephemeral signing key generated for
this one run and written into `<data-dir>/dev-session.json`, alongside the
endpoint and the WebSocket URL. Every `bgls` command run from the same
directory afterward (`instances`, `swarm run`, `mcp`, `doctor`) finds that
file and mints its own admin-scoped token from it locally, with no
separate login step. This is what makes every CLI and MCP example below
work with no `--token` flag: they are all reading the same session file.
`bgls serve --help` lists `--auth jwks`, `--auth hmac` and `--auth custom`,
but this build of the CLI only implements `dev` and refuses to start with
any other value. For a real deployment with your own identity provider,
embed `@browserglass/server` in your own process and pass it an
`auth.resolver`, the way `examples/nextjs-demo/server.mjs` does.
`pnpm bgls doctor` is worth running once here too: it checks Chrome, the
store, the network, and (with `--deep`) does one real launch-and-click round
trip.

## 3. Minting a token

Everything downstream needs a bearer token scoped to one instance, minted
through `POST /v1/tokens`. That call needs a more privileged credential to
authorise it, which is what `$ADMIN_TOKEN` is below. Run this from the
same directory the gateway is running in:

```sh
export ADMIN_TOKEN=$(pnpm bgls token)
```

`pnpm bgls token` reads the `dev-session.json` that `pnpm bgls serve`
wrote and mints locally from the same dev signing key, no network round
trip, printing the bare token on stdout and nothing else. Every other
`bgls` command has always done this internally; the command exists so a
script in any language can get the same credential. In a real deployment
the admin token comes from your own identity provider instead and
everything downstream is unchanged.

With that in hand, the scoped mint looks like this. Real output from this
exact call, against a real instance already created:

```sh
curl -s -X POST http://127.0.0.1:7799/browserglass/v1/tokens \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "sub": "my-script",
        "subKind": "service",
        "scope": { "kind": "instance", "instanceId": "'"$INSTANCE_ID"'", "targets": "*" },
        "caps": ["view", "control", "navigate", "automation", "evaluate"],
        "ttlSeconds": 300
      }'
```

```json
{"token":"eyJhbGciOiJFZERTQSIs...","jti":"jti_01M10ZCCK1KSZEJKX3NMER2J35","expiresAt":1787813348000,"caps":["view","control","navigate","automation","evaluate"],"narrowed":[]}
```

`caps` is a ceiling, not a guarantee: `POST /v1/tokens` always narrows the
result to whatever `ADMIN_TOKEN` itself actually holds (it never widens
it), so a token minted from a narrower credential quietly drops whatever
it is not allowed to grant, and reports it under `narrowed`. `evaluate`
specifically is absent from every convenience role bundle on purpose
(anything that runs script in the page is treated as the largest single
privilege this protocol grants); ask for it by name, as above, whenever a
caller needs `bg_evaluate`/`bg_resolve`/`bg_fill`/`bg_read_page` or the
equivalent `AutomationClient` methods.

The full model, including the `sticky.subject`/`subject` pair that gets
you the SAME browser back on a later acquire instead of a new one every
time, is [`ownership.md`](./ownership.md).

## 4. The same task, four ways

The task: open ten browsers, navigate all of them to the same page,
concurrently, not in a loop.

### CLI

```sh
pnpm bgls swarm run --size 10 --action navigate --value https://example.com --headless
```

Real output, ten real Chromes, this exact command, this machine:

```
ℹ member 0 (inst_01M10ZHSMTWNGYZZ0A251Q62MR): {"targetId":"tgt_01M10ZJ24VVE7YTE2BTJ3E5J39","url":"https://example.com/","title":"Example Domain", ...}
ℹ member 1 (inst_01M10ZHSNNV63M0X5S4FMMFSXE): {"targetId":"tgt_01M10ZJ3FNR67M0S17JNMM2W28","url":"https://example.com/","title":"Example Domain", ...}
...
ℹ member 9 (inst_01M10ZHSRN4QPAPS4Q3MZXMKRD): {"targetId":"tgt_01M10ZJ2A1PKWVZA0KXV148F97","url":"https://example.com/","title":"Example Domain", ...}
ℹ 10/10 member(s) succeeded.
```

All ten launched and navigated concurrently: `--size 10` opened ten
instances at once (a fresh `requestId` per member so the router's
idempotency window cannot dedupe two of them onto the same browser), then
ran `navigate` on all ten through `BrowserSwarm.all()`, which is
`Promise.allSettled`, not a loop. `--headless` here only because this
machine has no display attached; drop it for headful. Pass
`--sticky-subject <name>` to get the SAME ten browsers back on the next
run instead of ten more; see `pnpm bgls swarm run --help` and
`ownership.md`.

### Node: `BrowserSwarm`

```ts
import { BrowserSwarm } from '@browserglass/automation';

async function acquireOne(index: number) {
  const created = await fetch('http://127.0.0.1:7799/browserglass/v1/instances', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `swarm-${Date.now()}-${index}`, browser: { headless: 'new' } }),
  }).then((r) => r.json());

  const minted = await fetch('http://127.0.0.1:7799/browserglass/v1/tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sub: 'quickstart-script',
      subKind: 'service',
      scope: { kind: 'instance', instanceId: created.instanceId, targets: '*' },
      caps: ['view', 'control', 'navigate', 'automation'],
      ttlSeconds: 300,
    }),
  }).then((r) => r.json());

  return { instanceId: created.instanceId, wsUrl: 'ws://127.0.0.1:7799/browserglass/socket', token: minted.token };
}

const swarm = await BrowserSwarm.open({ size: 10, url: 'https://example.com', acquire: acquireOne });

const results = await swarm.all((member) => member.client.status());
for (const [i, r] of results.entries()) {
  console.log(i, r.status === 'fulfilled' ? r.value.url : r.reason);
}

await swarm.close();
```

Run at `size: 3` while writing this doc (the code above is identical
except for the number), real output:

```
0 https://example.com/
1 https://example.com/
2 https://example.com/
done
```

`BrowserSwarm` never launches a browser itself: `acquire()` is the one
function you supply, and everything else (opening `size` of them
concurrently, running one callback against every member at once, growing
or shrinking, closing them all) is generic over it. The full surface,
including the shared subject derivation for reattaching to the SAME
browsers on a later run, is in
[`packages/automation/README.md`](../packages/automation/README.md) and
[`PARALLELISM.md`](../packages/automation/PARALLELISM.md) in the same
package.

### MCP

`@browserglass/automation` ships a 41-tool MCP server
(`createAutomationMcpServer()`), and `pnpm bgls mcp` is the launcher: it
constructs that server, wires the SDK's own `StdioServerTransport`, and
connects it, reusing the exact REST acquire-and-mint plumbing `swarm run`
above uses. An MCP host spawns the `command` in its config directly, with
no shell and no workspace `PATH`, so `bgls` alone will not resolve there
even though `pnpm bgls` resolves at a terminal in this repo. Point the host
straight at Node and the CLI's built entry point instead, with an absolute
path (adjust it to where you cloned this repository). Paste this into an
MCP client's config (Claude Desktop's `claude_desktop_config.json`, Claude
Code's own MCP config, or any other MCP host):

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
      "env": { "BGLS_ADMIN_TOKEN": "your-admin-token" }
    }
  }
}
```

An absolute path to `node_modules/.bin/bgls` works too, but that file is a
shim pnpm generates at install time, and its exact form differs by
platform (a POSIX shell script, a `.CMD`, and a `.ps1` all sit next to each
other on Windows); pointing at `dist/bin.mjs` through `node` is the form
verified above and the same on every platform.

Run from the same directory `pnpm bgls serve` was started in (or with
`--endpoint`/`--token`, or the `BGLS_ENDPOINT`/`BGLS_ADMIN_TOKEN` env
vars), `pnpm bgls mcp` opens one instance up front to bind its
single-target tools (`bg_status`, `bg_click`, ...), then serves.
`bg_swarm_open` mints as many further browsers as an agent asks for, on
demand, through the same acquire function. Output from an MCP client
that connected to `pnpm bgls mcp`, listed tools, and called three of them:

```
tool count: 41
tool names: bg_status, bg_read_page, bg_click, bg_type, bg_control, bg_set_input_files,
bg_navigate, bg_screenshot, bg_pdf, bg_recording, bg_back, bg_forward, bg_reload, bg_stop, bg_press_key,
bg_scroll, bg_drag, bg_wait_for_navigation, bg_tabs, bg_evaluate, bg_resolve, bg_wait_for,
bg_wait_for_text, bg_get_text, bg_get_attribute, bg_is_checked, bg_get_html,
bg_scroll_into_view, bg_fill, bg_select, bg_diagnostics_subscribe, bg_read_console,
bg_read_network, bg_wait_for_network_idle, bg_page_map, bg_swarm_open, bg_swarm_list,
bg_swarm_grow, bg_swarm_shrink, bg_swarm_close, bg_swarm_run

bg_status: "Example Domain, still loading, no one holds control."
bg_read_page: "Example Domain\n\nThis domain is for use in documentation
examples without needing permission. Avoid use in operations.\n\nLearn more"
bg_swarm_open (size 2): "Opened swarm swarm_1 with 2 member(s), freshly
launched, owned by no one, gone after bg_swarm_close."
```

Call `bg_swarm_open` with `{"size": 10}` for the same ten-browser task as
the other three columns; `bg_swarm_run` then runs one action (`navigate`,
`click`, `type`, `screenshot`, or `status`) on every member at once,
genuinely concurrently, exactly like `swarm.all()` above.

`bg_read_page` needs calling out on its own: it reads
`document.body.innerText` through the evaluate surface, and `evaluate` is
the one capability absent from every convenience role bundle (see step 3
above), so `pnpm bgls mcp` asks for it explicitly when it mints its own
tokens.
A hand-rolled MCP launcher that mints tokens itself, or a deployment whose
admin credential does not itself hold `evaluate`, will see `bg_read_page`,
`bg_evaluate`, `bg_resolve`, `bg_fill`, and `bg_select` answer a clean
`POLICY_DENIED` instead, naming exactly what capability is missing.

Run `pnpm bgls mcp --help` for the full flag list (`--instance-id` to bind to
an already-running instance instead of opening a new one, `--pool`,
`--profile-key`, `--headless`, `--viewport`, `--sticky-subject`, `--url`).

### REST plus a WebSocket, for any other language

REST alone opens the ten browsers. Ten real, concurrent
`POST /v1/instances` calls against a live gateway, real output:

```sh
for i in 0 1 2 3 4 5 6 7 8 9; do
  curl -s -X POST http://127.0.0.1:7799/browserglass/v1/instances \
    -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
    -d "{\"requestId\":\"quickstart-rest-$i\",\"browser\":{\"headless\":\"new\"}}" \
    -o "resp-$i.json" -w "member $i: HTTP %{http_code}\n" &
done
wait
```

```
member 6: HTTP 201
member 0: HTTP 201
member 2: HTTP 201
member 1: HTTP 201
member 4: HTTP 201
member 3: HTTP 201
member 5: HTTP 201
member 7: HTTP 201
member 8: HTTP 201
member 9: HTTP 201
```

Ten `201`s, ten real Chromes. BrowserGlass also offers REST routes for
driving: `POST /v1/instances/:id/targets/:id/navigate`, `POST .../input`
for click and type, `GET .../page` for reading page text, and screenshot.
The catch: a driving verb will refuse with `E_SESSION_NOT_LIVE` if no
WebSocket viewer is connected to the session, because a pure REST caller
has no presence and cannot be told when a human takes control back. For
resilient automation, use the WebSocket-based routing above or the native
SDKs in TypeScript or Python. For one-off curl commands, REST works when
a viewer is live. See [`docs/adopting.md`](./adopting.md) for the full
adoption routing table.

Two ready-made clients for the WebSocket protocol exist today,
`@browserglass/automation` (Node, used above) and
[`clients/python`](../clients/python) (an async `AutomationClient` with no
dependency on this monorepo's Node build); for a third language, here is
the minimum viable exchange, written with nothing but a plain WebSocket
and JSON, no SDK at all, and actually run against a live gateway while
writing this doc:

```js
// Any language with a WebSocket client and JSON works the same way; this
// happens to be JS because that is what was on hand to verify it with.
const ws = new WebSocket('ws://127.0.0.1:7799/browserglass/socket', ['bgls.v1']);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    v: 1, t: 'hello', id: 'req_0001', ts: Date.now(),
    versions: [1], minVersion: 1,
    client: { name: 'my-client', version: '0.1.0', runtime: 'other' },
    capabilities: { codecs: ['jpeg'], binaryFrames: false, input: ['mouse', 'key', 'text'] },
    viewport: { width: 800, height: 600, dpr: 1, visible: true, fitMode: 'contain' },
    auth: { scheme: 'bearer', token: SCOPED_TOKEN }, // from POST /v1/tokens, step 3
  }));
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.t === 'welcome') {
    const targetId = msg.targets[0].targetId;
    ws.send(JSON.stringify({ v: 1, t: 'nav.goto', id: 'req_0002', ts: Date.now(), targetId, url: 'https://example.com/', waitUntil: 'load' }));
  }
  if (msg.t === 'nav.state' && msg.re === 'req_0002') {
    console.log('navigated:', msg.url, msg.title); // "navigated: https://example.com/ Example Domain"
    ws.close(1000);
  }
});
```

Real output from exactly this exchange:

```
<- welcome {"v":1,"t":"welcome", ... }
targetId from welcome: tgt_01M10ZFKN5004W06XQ5JEHCSPD
<- presence.state {...}
<- target.updated {"url":"chrome://newtab/","title":"New Tab","loading":true, ...}
<- nav.state {"url":"https://example.com/","title":"Example Domain","loading":true, ...}
<- nav.state {"url":"https://example.com/","title":"Example Domain", ..., "re":"req_0002"}
navigate confirmed: https://example.com/ Example Domain
closed 1000
```

Repeat the connect-and-`nav.goto` step once per instance (once per scoped
token from step 3) to drive all ten concurrently; nothing above is
specific to one connection. The credential can also ride as an
`Authorization: Bearer` header or a `bgls.token.<jwt>` entry in the
offered `Sec-WebSocket-Protocol` list instead of `hello.auth.token`, and
the full message catalogue, the capability table, the rate limits, and
which message types are typed but not actually wired in this build are
all in [`protocol/wire-spec.md`](./protocol/wire-spec.md), which exists
specifically for a client written in a language neither SDK covers yet.

## Where to go next

* [`adopting.md`](./adopting.md): seven ways to integrate BrowserGlass
  with what you already have: native SDKs, Playwright over CDP, external
  Chrome, MCP, REST, CLI, and embedded widget. What each costs and which
  tells you to say no.
* [`stealth.md`](./stealth.md): what BrowserGlass does by default to
  reduce automation signals, what it closes, what it does not, and what
  you should not believe about it.
* [`ownership.md`](./ownership.md): getting the SAME browsers back on a
  later run instead of new ones every time, on every on-ramp above.
* [`agent-and-human.md`](./agent-and-human.md): a person and an agent on
  the same browser, and what happens when the person wants the wheel.
* [`scaling.md`](./scaling.md): more than one gateway process, placement,
  and the admission ceilings.
* [`packages/automation/PARALLELISM.md`](../packages/automation/PARALLELISM.md):
  the window-isolation and rate-limit numbers that matter once you are
  actually driving ten browsers at once rather than just opening them.
* [`packages/embed/README.md`](../packages/embed/README.md): showing one
  of these browsers live in a plain HTML page with a single `<script>`
  tag, no React, no build step.
