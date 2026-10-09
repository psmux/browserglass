# `@browserglass/automation`

A programmatic control surface over a `bgls.v1` session: click, type,
navigate, screenshot, and read a page's console and network activity, from
a script rather than a browser tab. `AutomationClient` is an ordinary
Viewer on the same socket a human's `@browserglass/client` connects over;
`BrowserSwarm` is `size` of those, opened together and driven together.
Neither is a second wire path into BrowserGlass.

See `PARALLELISM.md` in this package for the window-isolation, rate-limit,
and browser-lifetime numbers that matter once you are driving more than
one browser at once, and this package's `types.ts`/`swarm.ts`/
`client/AutomationClient.ts` for the full method surface: this README
covers the swarm entry point and a runnable example, not every call.

## One browser: `AutomationClient`

With a gateway running (`bgls serve`), one call gets you a browser:

```ts
import { AutomationClient } from '@browserglass/automation';

const browser = await AutomationClient.launch();
try {
  await browser.navigate('https://example.com');
  console.log(await browser.text());
  const shot = await browser.screenshot(); // shot.data is base64 PNG
} finally {
  await browser.release(); // ends the browser and closes the socket
}
```

`launch()` reads two environment variables. `BGLS_URL` is the gateway
base URL and defaults to `http://127.0.0.1:7799/browserglass`.
`BGLS_ADMIN_TOKEN` is an admin token; get one by running `pnpm bgls token`
in the directory where `bgls serve` runs. It lasts ten minutes, and when
it is missing or expired `launch()` throws `UNAUTHENTICATED` with that
same instruction. Both can be passed directly instead:

```ts
const browser = await AutomationClient.launch({
  gateway: 'http://127.0.0.1:7799/browserglass',
  adminToken: process.env.BGLS_ADMIN_TOKEN,
  headless: true,                          // default
  viewport: { width: 1280, height: 800 },
  profileKey: 'my-account',                // persistent profile; omit for a throwaway one
  caps: ['view', 'control', 'navigate'],   // default: the agent bundle, see below
  control: true,                           // default
});
```

What it does for you: acquires an instance with a fresh `requestId`,
polls until it is `ready` (`readyTimeoutMs`, default 60000), asks the
instance's `attach` route for a socket ticket carrying `caps`, connects,
and takes the control lease. If any step after the acquire fails, the
browser is ended before the error reaches you. `release()` closes the
socket and ends the browser with `force=true`, retrying a couple of times
on `E_TERMINATE_FAILED`, which Windows sometimes answers once. Calling it
twice is fine.

`caps` defaults to `DEFAULT_LAUNCH_CAPS`, the `agent` role bundle:
`evaluate`, `capture`, `devtools`, `intercept`, `download`, `cdp`,
`instance.restart` and the rest of what it takes to operate one browser,
so every method on `AutomationClient` works, the selector verbs included.
It leaves out `admin` and the profile management caps. The ticket the
acquire call itself returns would carry everything the admin token holds,
`admin` included, which is why `launch()` asks for a narrower one. The
attach route only narrows: a cap your admin token does not hold is
dropped, not added, and the method that needs it fails with
`POLICY_DENIED`. `client.granted` shows what you actually got.

`control: true` is the default because almost every script wants to
drive, and without the lease the first `navigate()` fails with
`LEASE_NOT_HELD`. The lease auto renews. Pass `control: false` for a
client that only watches, or when you want to call `acquireControl()`
yourself with your own `waitMs` or `reason`. `client.holdsControl` says
which state you are in.

`launch()` talks to the gateway with the global `fetch` (Node 22). The
admin token goes in the `authorization` header and never into an error
message.

### Connecting to a browser someone else started

When your own server mints the token (the usual shape in production,
where the script never sees an admin token), connect directly:

```ts
const client = await AutomationClient.connect({
  endpoint: 'wss://your-gateway.example/browserglass/socket',
  token: automationToken, // minted server side, scoped to one instance
});

const lease = await client.acquireControl();
await client.navigate('https://example.com');
await client.clickAt(200, 300);
await lease.release();
client.close();
```

## Finding things on the page: `resolve` and the verbs on top of it

There is no `Locator` object here, and there is not going to be one. Page
evaluation returns by value and never a handle, deliberately, so a lazy
locator that re-queries the page on every property access cannot exist on
this wire. What replaces it is one call that answers everything at once.

```ts
const r = await client.resolve('[data-testid="dropdown"]');
r.total;                          // what .count() was for
r.matches[0];                     // what .first was for
r.matches.filter((m) => m.visible);
r.matches[0].occludedBy;          // what would take a click aimed here
```

Each match carries its rect, its centre, and all five actionability
answers: attached, visible, enabled, stable and whether a click at its
centre would actually reach it. One round trip, not four.

The verbs are thin composition on top of that, and a click drives the same
real CDP input path a person's click takes, through the same control lease:

```ts
const lease = await client.acquireControl();

await client.waitFor('#form', { state: 'visible' });
await client.fill('label=Email address', 'ada@example.com');
await client.click('[data-testid="submit"]', {
  verify: 'document.querySelectorAll("[role=option]").length > 0',
});
```

`verify` is the part Playwright has no equivalent for. Without it a click
verb can only report that a click was delivered, which is a different
claim from "the click worked", and the difference is a transparent overlay
swallowing the click while the menu never opens. With it, the failure says
what took the click:

```
OCCLUDED: click('[data-testid="submit"]'): 3 clicks were delivered at
(612, 448) and the verify predicate never passed;
div[data-testid="click_filter"] is on top of the element at that point.
```

Selectors are CSS by default. `text=`, `xpath=`, `label=`, `ref=`,
`visible=` and `role=` are explicit prefixes, and segments chain with `>>`:
`'input#first >> xpath=ancestor::label[1]'`. XPath is accepted only as a
chained segment. There is no strict mode: a selector matching three
elements is a fact about the page, not an error, and the acting verbs say
which one they chose and out of how many.

`role=button` or `role=button[name="Submit"]` matches the real accessible
role and name, computed by Chrome's own accessibility engine
(`Accessibility.queryAXTree`), not a `role` attribute lookalike: a
`<button>` with no `role` attribute matches `role=button`, and an `<a>`
with no `href` does not match `role=link`, because it genuinely is not a
link. `client.a11y()` reads the same tree directly, for an LLM agent that
wants the page's roles, names and actionable state without a selector at
all. Both need `devtools` in addition to `evaluate`.

A `frame=` segment enters an `<iframe>`/`<frame>` the chain resolved so
far, and the rest of the selector, including a further `frame=`, resolves
inside it: `'iframe#checkout >> frame= >> [data-testid="pay"]'`. Same
process frames resolve in one evaluation; a cross-origin frame crosses to
its own out-of-process CDP session, with the frame's offset accumulated
into top-document coordinates either way, so the returned rect is always
in the same space a click, a hover, or `pageMap()` expects.

`fill` types real per-character key events by default, because
`Input.insertText` fires no `keydown` and the filtering comboboxes worth
caring about open and filter on `keydown`. It also stands down mid-word
when a person takes the browser, and tells you which character it stopped
on.

Beyond `click`/`fill`/`resolve`, the locator surface also has `hover()`
(moves the pointer, for a `:hover` menu with nothing to click),
`scrollToText()` and `scrollContainer()` (scroll a virtualised list or a
modal body by dispatching a real wheel event at its centre, rather than at
a fixed page point), `dropdownOptions()` (every `<option>` on a `<select>`:
value, label, position, selected/disabled, in one round trip), and
`findInPage()` (a full-text search over the page's own visible text,
returning a `ref=` token per match to act on without re-searching).
`click()` and the other acting verbs also forward `modifiers:
['Alt' | 'Control' | 'Meta' | 'Shift']` to the underlying CDP input event,
for a control-click or a shift-click. See each method's own doc comment in
`src/client/AutomationClient.ts` for the full contract.

## When a human takes the browser back

An agent driving a browser a person can also see is the case this package
is actually for, and the interesting moment is the one where the person
decides to take over. `AutomationClient` stands down on its own: the
instant the gateway asks for control back, every interaction method on
that target starts throwing `LEASE_REVOKED` and no further input frame
reaches the browser. There is nothing to switch on, and no window in which
the client keeps clicking while a person is already reaching for the
mouse. A half yielded agent, still sending a few more clicks, is worse
than no yield at all, because the person is now fighting an invisible
second pointer.

What you do have to write is what your AGENT does about it:

```ts
client.onControlYield((ev) => {
  if (!ev.human) return;            // another agent outranked us; the run can retry
  plan.abort(`${ev.byLabel} took over during ${ev.inFlight[0]?.action ?? 'idle'}`);
});
```

`ev.human` is the flag to branch on. It means a PERSON, as opposed to a
higher-priority agent or an admin force-claim, and it is derived from both
the wire's `reason` and the presence roster so it stays right on a gateway
that has not shipped the honest `human_takeover` reason yet.

`client.yieldStatus()` is the same information pulled rather than pushed,
for an error path or a polling loop. `client.yieldControl()` stands down
deliberately, when the agent itself decides a person should have the
browser.

### Resuming

Nothing here ever re-acquires control on its own, on a timer or otherwise.
That is deliberate, not an omission. The server's requeue backoff (30
seconds by default) is how long an agent is made to wait, not how long a
person takes to finish, so an agent that came back automatically when it
elapsed would be resuming while the human who took over is almost
certainly still working. Resumption is a call you make, in your own code,
where a reader can see it:

```ts
await client.waitForResume();       // backoff elapsed AND nobody else is driving
const lease = await client.acquireControl();
```

`waitForResume()` waits for both conditions, which is the part worth not
hand-rolling: sleeping out only the backoff puts the agent in the queue
behind a person who is still mid-task, ready to take the pointer the moment
their lease lapses. `acquireControl()` is the only thing that reopens
input dispatch, so an agent cannot drift back into driving by accident.

Set `yieldPolicy: { releaseOnYield: false }` at connect time if the agent
genuinely needs the grace window to clean something up (a half-submitted
form, a modal it opened). It buys time to tidy, never time to keep
working: input is already refused by then. The default hands the lease back
immediately, so the person waits milliseconds rather than the full grace.

## Gating what the page is allowed to send

`client.gate` decides whether each outbound request leaves the browser.
It exists for the case where an automation is filling a form it must not
accidentally submit, and it is the piece a submit gate is built from.

```ts
await client.gate.enable([
  { urlPattern: '*/checkout/submit*', methods: ['POST'], verdict: 'ask', holdMs: 5000 },
  { urlPattern: '*', verdict: 'allow' },
]);

const off = client.gate.onPaused(async (req) => {
  return (await humanApproved(req.url)) ? 'allow' : 'deny';
});
```

Rules are ordered and the first match wins. A rule naming `allow` or
`deny` is decided on the server with no round trip; only `ask` pauses a
request, and a paused request holds a real Chrome network slot until it
is answered or its `holdMs` lapses. An unmatched request is allowed, so
default-deny is spelled with a trailing `{ urlPattern: '*', verdict:
'deny' }` and is visible in the rule list rather than implied.

`onPaused` answers for you, which is safer than calling
`gate.resolve(gateId, verdict)` by hand: a pause nobody answers stalls
the page until its deadline. A handler that throws answers `deny`.

Requires the `intercept` capability. `includeRequestBody` additionally
requires `evaluate`, because a POST body carries whatever the user typed,
and a caller who can already run script in the page can already read it.
Neither capability is in any role bundle, `owner` included; both have to
be named in the token.

Two things worth knowing before you build on it. A gate can only ever say
allow or deny: there is no way to rewrite a URL, a method, a header or a
body, and that is deliberate rather than unfinished (see
`@browserglass/protocol`'s `wire/messages/interception.ts` for the
argument). And one target has one gate with one owner, so registering a
gate on a target another viewer already gated is refused rather than
silently sharing.

## Several browsers at once: `BrowserSwarm`

Against a running `bgls serve`, pass `launch` and the swarm starts its
own browsers with `AutomationClient.launch()`, one fresh `requestId` per
member:

```ts
import { BrowserSwarm } from '@browserglass/automation';

const swarm = await BrowserSwarm.open({
  size: 10,
  url: 'https://example.com',
  launch: { headless: true }, // any AutomationClient.launch() option
});
const texts = await swarm.all((m) => m.client.text());
await swarm.close(); // ends all ten browsers
```

In this mode the swarm owns the browsers. `close()` and `shrink()` end
them, and if some members fail to open, the ones that did open are ended
too. With a `subject` it is different: the point of a subject is getting
the same browsers back next run, so `close()` only closes the sockets and
leaves the browsers running.

When your deployment mints credentials its own way, pass `acquire`
instead. Exactly one of the two is required.

With `acquire`, `BrowserSwarm` never launches a browser itself. `acquire()` is the one
piece you supply: a function that gets you from "I want another browser"
to one Instance's `{ instanceId, wsUrl, token }`, however your own
deployment does that (an embedded `@browserglass/router`, a REST endpoint
your own server exposes, a pool with its own admission policy). Everything
else, opening `size` of those concurrently, running your own callback
against every member at once, growing or shrinking the swarm, and closing
it all again, is generic over that one function.

The example below is complete and reflects the real API surface: every
call in it is a real method, and `acquire()` is written the way this
repository's own demo mints a credential (`examples/nextjs-demo/app/api/browser/route.ts`),
against a REST endpoint your own server exposes rather than the router
directly, since `BrowserSwarm` runs wherever your script runs, not
necessarily inside the same process as your gateway.

```ts
import { BrowserSwarm } from '@browserglass/automation';

const GATEWAY_HOST = 'your-gateway.example';

async function acquireOne(index: number) {
  // Mints a fresh requestId per call: reusing one across every acquire()
  // call would dedupe them inside the router's idempotency window and
  // hand every member the SAME instance instead of size distinct ones.
  // See PARALLELISM.md's "distinct requestIds" gotcha.
  const res = await fetch(`https://${GATEWAY_HOST}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `swarm-${Date.now()}-${index}` }),
  });
  if (!res.ok) throw new Error(`acquire() failed for member ${index}: ${res.status}`);
  const body = (await res.json()) as { instanceId: string; wsPath: string; token: string };
  return { instanceId: body.instanceId, wsUrl: `wss://${GATEWAY_HOST}${body.wsPath}`, token: body.token };
}

const swarm = await BrowserSwarm.open({
  size: 4,
  url: 'https://example.com',
  acquire: acquireOne,
});

// Drive every member at once. all() uses Promise.allSettled: one member's
// page throwing does not take the others down with it.
const results = await swarm.all(async (member) => {
  const lease = await member.client.acquireControl();
  try {
    await member.client.clickAt(100, 100);
    await member.client.type('hello from a swarm');
    return await member.client.status();
  } finally {
    await lease.release();
  }
});

results.forEach((r, i) => {
  if (r.status === 'fulfilled') console.log(`member ${i}: ${r.value.url}`);
  else console.error(`member ${i} failed:`, r.reason);
});

// Read each member's console. diagnostics.subscribe() needs the
// `devtools` capability on the token acquire() minted; console/pageerror/
// network/networksummary arrive through client.on(), scoped to whichever
// member's own client you subscribe on (see PARALLELISM.md if this
// capability is missing from your own token).
await swarm.all(async (member) => {
  member.client.on('console', (entry) => console.log(`[member ${member.index}] ${entry.level}: ${entry.text}`));
  await member.client.diagnostics.subscribe();
});

// Grow the swarm by two more members, mid-run.
await swarm.grow(2);

// Shrink it back down; shrink() closes the most recently added members.
await swarm.shrink(2);

// Close every connection this swarm opened. It does not release whatever
// acquire() reserved on the router side; that is your own release call,
// keyed by member.instanceId, per your own admission layer's contract
// (PARALLELISM.md's "release instances when you are done" gotcha).
// members is read BEFORE close(): close() empties swarm.members as part
// of closing, so there is nothing left to iterate afterward.
const closingMembers = swarm.members;
await swarm.close();
for (const member of closingMembers) {
  await fetch(`https://${GATEWAY_HOST}/api/browser?instanceId=${member.instanceId}`, { method: 'DELETE' });
}
```

A caller who wants raw values back rather than settlement records can
unwrap the result of `all()` itself:

```ts
const values = (await swarm.all(fn)).map((r) => (r.status === 'fulfilled' ? r.value : undefined));
```

### The `BrowserSwarm` surface

```ts
interface BrowserSwarmOptions {
  size: number;
  url?: string;
  isolation?: 'tab' | 'window'; // informational; see PARALLELISM.md
  subject?: string;             // ownership; see below
  stickyWithinMs?: number;
  acquire(index: number, ctx: SwarmAcquireContext): Promise<{ instanceId: string; wsUrl: string; token: string }>;
  transport?: { WebSocketImpl?: WebSocketConstructorLike }; // test-double injection
}

interface SwarmAcquireContext {
  readonly subject: string | undefined;      // '<subject>#<index>' for this member slot
  readonly stickyWithinMs: number | undefined;
}

interface SwarmMember {
  readonly index: number;
  readonly instanceId: string;
  readonly targetId: string;
  readonly subject: string | undefined;
  readonly client: AutomationClient;
}

class BrowserSwarm {
  static open(opts: BrowserSwarmOptions): Promise<BrowserSwarm>;
  readonly members: readonly SwarmMember[];
  readonly isolation: 'tab' | 'window' | undefined;
  readonly subject: string | undefined;
  all<T>(fn: (member: SwarmMember, index: number) => Promise<T>): Promise<PromiseSettledResult<T>[]>;
  grow(n: number): Promise<readonly SwarmMember[]>;
  shrink(n: number): Promise<void>;
  close(): Promise<void>;
}

function swarmMemberSubject(subject: string | undefined, index: number): string | undefined;
```

### Does a swarm launch new browsers or reuse mine?

**The default is launch.** `BrowserSwarm.open({ size: 20 })` calls your
`acquire()` twenty times with no ownership attached, so unless your own
`acquire()` does something clever on its own, that is twenty new Chromes,
every run. That default is on purpose: two unrelated runs of the same
script must not fight over one set of browsers.

Pass `subject` to get the other behaviour. Each member slot then asks for
the browser that slot had last time and launches only if there is none, so
running the same job twice does not put another twenty browsers on the
machine:

```ts
const swarm = await BrowserSwarm.open({
  size: 20,
  subject: 'nightly-crawler',   // name the OWNER, not the run
  stickyWithinMs: 900_000,
  async acquire(index, ctx) {
    // ctx.subject is 'nightly-crawler#<index>'. Put it on BOTH fields of
    // the acquire request, or the reuse silently never happens:
    //   { subject: ctx.subject, sticky: { subject: ctx.subject } }
    ...
  },
});
```

The subject is per member SLOT, not per swarm, and that is not cosmetic.
The router resolves one subject to at most one instance, so twenty
concurrent acquires all carrying `nightly-crawler` would converge onto a
handful of browsers rather than twenty, quietly. `<subject>#<index>` is
what makes slot 3 reattach to slot 3's browser. Use
`swarmMemberSubject()` to reproduce a slot's subject from outside the
swarm, for your own release calls.

Pick a value that names an owner (`nightly-crawler`, `tenant-42`,
`alice@example.com`). A value that changes per run, a timestamp or a uuid,
is the same as omitting it, with extra steps. Two processes passing the
same subject address the same browser set; two passing different subjects
stay isolated.

Full model, including what it becomes on the REST, CLI, MCP, and embed
on-ramps: [`docs/ownership.md`](../../docs/ownership.md).

## MCP: driving a swarm of browsers from an agent

`createAutomationMcpServer()` (`src/mcp/server.ts`) builds an MCP `Server` an agent process can talk to over stdio. It wraps one bound `AutomationClient` for single-target work, and, if given a way to open browsers, `BrowserSwarm` for driving several at once.

```ts
import { createAutomationMcpServer } from '@browserglass/automation';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createAutomationMcpServer({
  client: boundClient, // an already connected AutomationClient
  swarm: {
    // Enables bg_swarm_open/bg_swarm_grow. Omit this and those tools still
    // list, but every call reports cleanly that no way to open browsers
    // was configured, rather than failing further down.
    acquire: acquireOne, // same shape as BrowserSwarm's own acquire(), see above
  },
});
await server.connect(new StdioServerTransport());
```

`bg_swarm_open` takes a `subject` argument, and your `acquire` receives it
per member slot as `ctx.subject`. An `acquire` that ignores that argument
accepts the tool parameter and does nothing with it, so an agent asking to
reattach silently launches instead; wire it through.

An agent driving through these tools sees no callbacks, so the stand-down
is surfaced in tool results instead. `bg_control` takes `action: "yield"`
(stand down now) and `action: "yield_status"` (has this browser been taken
over, by whom, was it a person, when may control be requested again).
`bg_status` says so in its own summary line, every yielded tool failure
carries a hint that distinguishes a person from a rival agent, and
`bg_swarm_list` marks exactly which members have been taken over so the
rest of the swarm can carry on.

Forty tools, in five groups:

* Single target driving and locomotion: `bg_status`, `bg_read_page`, `bg_click`, `bg_type`, `bg_set_input_files`, `bg_control`, `bg_navigate`, `bg_back`, `bg_forward`, `bg_reload`, `bg_stop`, `bg_press_key`, `bg_scroll`, `bg_screenshot`, `bg_pdf`, `bg_wait_for_navigation`, `bg_tabs`, `bg_recording`. Every one of these accepts `swarmId`/`member` alongside its usual `targetId`, so the same tool acts on one member of an open swarm instead of the bound client when asked to. `bg_click` also accepts a `selector`, in which case it goes through the locator surface below rather than dispatching at a raw coordinate. `bg_pdf` renders through Chrome's own print pipeline (`Page.printToPDF`) rather than stitching screenshots together, and needs no held lease; a small result comes back inline as base64, anything larger as a short-lived, single-use download URL.
* The locator surface: `bg_evaluate`, `bg_resolve`, `bg_wait_for`, `bg_wait_for_text`, `bg_get_text`, `bg_get_attribute`, `bg_is_checked`, `bg_get_html`, `bg_scroll_into_view`, `bg_fill`, `bg_select`. Thin wrappers over the `AutomationClient` methods of the same name; see that class's own doc comments for exactly what each one does. `bg_resolve` is the one to reach for first: there is no element-handle API on this surface, so it is how an agent driving over MCP finds out where an element is and whether it is actually clickable or fillable (rect, the five actionability answers, and what is occluding it) in one round trip, rather than guessing from a screenshot. Every tool in this group needs the `evaluate` capability, which is not in any role bundle and has to be granted on the token explicitly. (`hover`, `scrollToText`, `scrollContainer`, `dropdownOptions` and `findInPage` are on `AutomationClient` but not, as of this manifest, individually exposed as MCP tools.)
* `bg_page_map`: a flat, indexed inventory of every element the interactivity cascade judges actionable, in one round trip, gated on `devtools` rather than `evaluate` because it runs no page script. `action: "capture"` (the default) reads the map; `action: "stamp"` writes a one-off marker attribute onto chosen indices from an earlier capture so `bg_resolve`/`bg_click` can address them as `css=[<marker>]` afterward. See [`docs/page-map.md`](../../docs/page-map.md) for the occlusion tristate, the truncation reasons, and the click-listener signal's own limit.
* Swarm lifecycle and fan-out: `bg_swarm_open` (with `subject`/`stickyWithinMs` for ownership; its result states in prose whether the browsers were launched fresh or reattached), `bg_swarm_list` (reports each swarm's subject), `bg_swarm_grow` (inherits the swarm's subject), `bg_swarm_shrink`, `bg_swarm_close`, and `bg_swarm_run`. `bg_swarm_run` is the tool for driving more than one browser at once: it runs `navigate`, `click`, `type`, `screenshot`, or `status` on every member of a swarm through `BrowserSwarm.all()`, genuinely concurrently, and reports each member's own success or failure without one member's failure taking down the call.
* Diagnostics: `bg_diagnostics_subscribe`, `bg_read_console`, `bg_read_network`, `bg_wait_for_network_idle`. Console entries, page errors, and network rows only ever cover what was collected after `bg_diagnostics_subscribe` was called on a target, capped at the most recent 200 entries per feed; this server buffers them itself, since neither `AutomationClient` nor the wire protocol keeps any history of its own.

An agent that opens a swarm and forgets to call `bg_swarm_close` is the expected failure mode, not an edge case: `createAutomationMcpServer()` sets `server.onclose` to close every swarm it opened, so the leak lasts only as long as the MCP connection itself, not the life of whatever process hosts it. A caller that also needs its own `onclose` should chain it rather than overwrite this one; see the doc comment on `createAutomationMcpServer` for how.

## Development

```sh
pnpm --filter @browserglass/automation build
pnpm --filter @browserglass/automation typecheck
pnpm --filter @browserglass/automation test
```
