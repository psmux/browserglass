# `@browserglass/embed`

`<browser-glass>`: a live, drivable BrowserGlass pane as one custom
element, dropped into any HTML page with a single `<script>` tag. No
React, no bundler, no build step for the page using it.

`@browserglass/react`'s `<BrowserGlass/>` is still the right choice inside
a React app. This package exists for everywhere else: a plain server-side
template, a CMS-authored page, a Vue/Svelte/Angular app that would rather
not add React just to embed one remote browser pane, or a static HTML
file like `examples/embed-demo/index.html` in this repo.

## Copy-pasteable

```html
<script src="/vendor/browserglass-embed.global.js"></script>

<browser-glass
  url="wss://your-gateway.example/ws"
  token="the-bearer-token-your-backend-minted"
  target-id="tgt_01M0..."
  fit="contain"
></browser-glass>
```

That is the entire integration. The element connects, subscribes, paints
frames onto an internal canvas, and captures mouse/wheel/keyboard input
back to the remote page, all on its own.

`/vendor/browserglass-embed.global.js` above is a file YOU serve, not a
URL that exists on its own. Two ways to get it there, in order of how
much you have to trust:

**Build it and host it yourself** (works today, no dependency on npm
publishing having actually happened for the version you want):

```sh
pnpm --filter @browserglass/embed build
# -> packages/embed/dist/browserglass-embed.global.js, an IIFE that
#    bundles its own @browserglass/client and @browserglass/protocol.
#    Nothing else to load. Copy this one file to wherever your own
#    static assets or CDN already serve from.
```

**Point at a public npm CDN**, once a version of `@browserglass/embed`
has actually been published (`docs/installing.md` explains why every
package here publishes under the `alpha` dist-tag, never `latest`, and
why that means you always pin an exact version rather than trusting a
tag to resolve):

```html
<script src="https://cdn.jsdelivr.net/npm/@browserglass/embed@0.1.0-alpha.0/dist/browserglass-embed.global.js"></script>
```

That exact URL 404s today (`npm view @browserglass/embed` returns a 404;
jsdelivr has nothing to mirror until npm does). It is written as it will
read once a version is actually published, not as something to paste in
right now; use the build-it-yourself path above until then.

jsdelivr and unpkg both mirror every published npm package automatically;
there is nothing BrowserGlass-specific to configure. Pin the exact
version, not `@alpha` or `@latest`, since a bare tag can move out from
under a `<script>` tag with no warning.

A consumer with a bundler already in the page (Vite, webpack, esbuild,
Rollup) should import the package instead of loading either build as a
script tag:

```js
import '@browserglass/embed'; // registers <browser-glass> as a side effect
```

`packages/embed/dist/index.mjs` is what that import resolves to: ESM,
`@browserglass/client`/`@browserglass/protocol` left as real dependencies
rather than bundled in, so a bundler that already has them elsewhere in
the page does not ship them twice.

## What a host page has to provide

Three things, none of which this package can produce for you:

1. **A gateway WebSocket URL** (`wss://.../ws`, or `ws://localhost:.../ws`
   for local development). This is the address of a running
   `@browserglass/server` instance, e.g. one started with `bgls serve`
   (see `@browserglass/cli`'s own README) or embedded directly into your
   own Node backend via `createBrowserGlass()`.
2. **A bearer token**, minted by *your* backend, not by this widget. The
   gateway's `POST /v1/tokens` REST route (or, from a Node backend that
   embeds the gateway directly, `bg.tokens.issueWithMeta()`) mints a
   short-lived token scoped to one session and one set of capabilities.
   Your backend hands that token to the page rendering `<browser-glass>`,
   the same way it would hand out any other short-lived credential; this
   widget never talks to your authentication system itself, and never
   should, since it runs entirely in the viewer's own browser.
3. **A target id** (`tgt_...`), naming which browser tab within a running
   instance to show. Your backend gets this from the gateway too (a
   `stream.subscribe`-eligible target only exists once an instance is
   running and has at least one open tab); `examples/nextjs-demo` shows
   one complete, working version of "acquire an instance, mint a token,
   hand both to the page" if you want a reference implementation, even
   though that example is React and this package is not.

`examples/embed-demo/index.html` in this repo is a working, static
three-pane demo; it asks you to paste in a URL, token, and target ids by
hand for exactly this reason, since it has no backend of its own to mint
a token with.

### Making the widget show the SAME browser on the next page load

This is worth stating plainly, because the obvious guess is wrong: there
is no attribute on `<browser-glass>` that makes it reattach to a browser
it showed before. The widget attaches to a target that already exists. It
never acquires an instance, so there is nothing here for an ownership
selector to attach to, and adding an attribute that pretended otherwise
would be inventing a second mechanism for something this package does not
do.

Ownership for an embed lives one layer up, in the backend that already
mints the widget's token (item 2 above). BrowserGlass's acquire call takes
a `subject`, and passing the same one on every page load is what makes the
same browser come back:

```js
// Your backend, per page load. Same user, same browser, no new Chrome.
const acquired = await fetch(`${GATEWAY}/v1/instances`, {
  method: 'POST',
  headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    profile: { mode: 'ephemeral' },
    subject: `user:${session.userId}`,                          // tags the instance
    sticky: { subject: `user:${session.userId}`, withinMs: 900000 }, // finds it next time
  }),
}).then((r) => r.json());

// On a reattach, acquired.targets lists the tabs that browser already has
// open, which is where the widget's target-id comes from. On a fresh
// launch there is normally one about:blank tab.
const targetId = acquired.targets[0].targetId;
```

Both fields are needed. `sticky.subject` is what searches; `subject` is
what tags the instance so the search finds it next time. Send only the
first and every page load launches a new browser while appearing to work.

Use a per-user value for private browsers and a per-workspace value for a
browser several people share; the mechanism is identical and only the
value differs. Full model, and the same concept on the REST, CLI, and MCP
on-ramps: [`docs/ownership.md`](../../docs/ownership.md).

## The element

### Attributes

| Attribute        | Meaning                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| `url`            | Gateway WebSocket URL. Required.                                       |
| `token`          | Bearer token. Required by any gateway that isn't wide open.            |
| `target-id`      | Which target this pane shows. Required.                                |
| `readonly`       | Boolean, presence-only. View without ever taking control: no pointer/keyboard capture, and `clickAt`/`type`/`takeControl` all throw. `navigate`/`reload`/`screenshot` still work, since those are gateway-capability-gated actions, not canvas ownership. |
| `fit`            | `"contain"` (default) or `"cover"`.                                    |
| `token-endpoint` | A URL this element `fetch()`es for a fresh token when the current one expires. See "Token refresh" below. |

Changing `url` or `token` reconnects from scratch. Changing `target-id`
alone re-subscribes on the existing connection without reconnecting; see
`src/element.ts`'s `#syncIdentity` if you want the exact reasoning.

### Token refresh

A bearer token is capped at 900 seconds server side, regardless of what
your backend asked for (`docs/protocol/wire-spec.md`). A widget left open
longer than that needs a way to get a new one without the host page
polling the `token` attribute itself. Two ways, since a custom element
attribute cannot carry a function:

```js
// A plain JS property on the element instance. Read fresh on every
// refresh, so setting it before OR after appending the element works.
document.querySelector('browser-glass').onTokenExpired = async () => {
  const res = await fetch('/api/browserglass-token', { credentials: 'include' });
  const { token } = await res.json();
  return token;
};
```

```html
<!-- Or: an endpoint this element fetches itself, returning { "token": "..." }. -->
<browser-glass
  url="wss://your-gateway.example/ws"
  token="the-first-token"
  token-endpoint="/api/browserglass-token"
  target-id="tgt_01M0..."
></browser-glass>
```

`onTokenExpired` wins when both are set. With neither, an expired token
takes the element to `state="fatal"` with a clear `bgls:error` message
instead of retrying a token the gateway already refused.

Either path refreshes the SAME underlying connection: no re-subscribe, no
new canvas attach, the picture keeps painting straight through the token
swap. `src/client-pool.ts`'s `acquireClient` doc comment explains the one
edge case worth knowing: when several `<browser-glass>` elements share one
connection (see "Multiple widgets on one page" below), only the FIRST
one's refresh callback is ever used, since the underlying client is
constructed once.

Setting a brand new `token` attribute value yourself, from your own
refresh loop, works too: `url` and `token` already reconnect from scratch
on change (the general rule above), and that path is what guarantees a
stale, dead-token socket is never handed back from the pool.

### Reflected state

`<browser-glass>` writes its own status back as attributes, so a host page
can style or observe it with nothing fancier than CSS or a
`MutationObserver`:

- `state`: mirrors the underlying connection state (`connecting`, `live`,
  `degraded`, `reconnecting`, `resuming`, `fatal`).
- `has-control`: present exactly while this element holds the target's
  control lease.
- `error`: a stable code (see `BrowserGlassErrorDetail['code']` in
  `src/events.ts`) whenever something is wrong, including
  `duplicate-target` (see below).

CSS `::part()` names: `container`, `canvas`, `placeholder`, `badge`. Shadow
DOM keeps everything else out of reach in both directions: a host page's
CSS cannot break the canvas layout, and this element's own styles cannot
leak onto the host page.

```css
browser-glass { width: 480px; aspect-ratio: 16/10; }
browser-glass::part(placeholder) { font-family: monospace; }
browser-glass[state="fatal"] { outline: 2px solid red; }
```

### Imperative API

```js
const pane = document.querySelector('browser-glass');
await pane.navigate('https://example.com/');
await pane.reload();
const result = await pane.screenshot();      // CaptureResult, .blob is a PNG/JPEG Blob
await pane.clickAt(120, 40);                 // CSS px from this element's own top-left
await pane.type('hello');                    // one input.text insertion, not per-key events
await pane.takeControl();
await pane.releaseControl();
```

`clickAt`, not `click`: `HTMLElement` already has a native zero-argument
`click()`, and this element does not override it.

### Events

Every event is a `CustomEvent`, `bubbles: true, composed: true`, prefixed
`bgls:` so it cannot collide with anything else already on a plain HTML
page:

`bgls:connected`, `bgls:disconnected`, `bgls:controlgained`,
`bgls:controllost`, `bgls:console`, `bgls:pageerror`, `bgls:navigation`,
`bgls:error`. Detail payload shapes are in `src/events.ts`.

```js
document.addEventListener('bgls:error', (e) => {
  console.warn(e.target, e.detail.code, e.detail.message);
});
```

## Multiple widgets on one page

This is the whole point of the package, and the part most likely to go
wrong, so it gets its own section rather than a footnote.

**Sharing a connection.** Several `<browser-glass>` elements pointed at
the same `url` and `token` share one `BrowserGlassClient`, and therefore
one WebSocket, reference counted (`src/client-pool.ts`'s `acquireClient`).
Three panes into one gateway session means one socket, not three: that is
what "one gateway session" means at the wire level, and opening N
redundant sockets for N panes would just be wrong.

**Two widgets on the same target.** `BrowserGlassClient.subscribe()`
dedupes strictly by target id, and a `StreamHandle` can paint exactly one
`<canvas>` at a time (confirmed by reading
`packages/client/src/client/BrowserGlassClient.ts` and
`StreamHandleImpl.ts` directly, not assumed). So two elements naming the
same target on the same connection cannot both show a live picture at
once. Rather than silently letting the second one steal the first one's
canvas (what would happen if this package used the client's built-in
`subscribe({canvas, container})` convenience path directly), the second
element enters a `duplicate-target` state instead: `error="duplicate-target"`,
a `bgls:error` event, a console warning, and no picture, but it stays
registered. If the first element disconnects, the second is promoted
automatically and starts painting, using the wire subscription that was
kept alive for it the whole time; no second `stream.subscribe` is ever
sent. See `src/client-pool.ts`'s own doc comment for the full mechanism,
and `examples/embed-demo/index.html`'s "duplicate-target queue" section
to watch this happen live.

## Development

```sh
pnpm --filter @browserglass/embed build
pnpm --filter @browserglass/embed typecheck
pnpm --filter @browserglass/embed test
```
