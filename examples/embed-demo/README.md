# `<browser-glass>` embed demo

A single static HTML file, `index.html`, showing three live, independently
drivable `<browser-glass>` panes sharing one gateway connection, plus a
fourth pane that deliberately points at the same target as the first one
to demonstrate the duplicate-target queue. No React, no bundler, no build
step for this file itself.

## Running it

1. Build the widget once, from the repo root:

   ```sh
   pnpm --filter @browserglass/embed build
   ```

   This produces `packages/embed/dist/browserglass-embed.global.js`, the
   one script tag `index.html` loads by relative path
   (`../../packages/embed/dist/browserglass-embed.global.js`). There is
   no published CDN build yet; see `packages/embed/README.md` for the
   full explanation and for the snippet a real app uses once one exists.

2. Serve this directory (or open `index.html` directly with `file://`,
   which also works, since nothing here needs a server of its own). Any
   static file server is fine, for example:

   ```sh
   npx serve examples/embed-demo
   ```

3. Start a BrowserGlass gateway this page can reach, and tell it to allow
   this page's origin. The gateway allows no origin at all by default
   (`security.allowedOrigins`, `packages/server/src/config/resolve.ts`),
   so both the WebSocket the widget opens and any REST call from this
   origin are refused until you say otherwise:

   ```sh
   pnpm bgls serve --cors http://localhost:3000
   # or, for local throwaway testing only, never in production:
   pnpm bgls serve --cors "*"
   ```

   Match whatever origin this page actually loads from (`file://` pages
   have no meaningful origin to allow; serve this directory over
   `http://localhost:<port>` instead if you hit that).

4. Fill in the gateway's WebSocket URL and a bearer token in the fields
   at the top of the page, and up to three target ids on the panes
   themselves, then click "Connect all panes".

Where the URL, token, and target ids actually come from in a real app
(this page has no backend of its own to produce them, so you paste them
in by hand) is `packages/embed/README.md`'s job to explain, not this
file's; start there.

## What this demo is showing

* **One socket, three panes.** All three widgets share one
  `BrowserGlassClient` and one WebSocket, reference counted by
  `packages/embed/src/client-pool.ts`, as long as they share the same
  `url` and `token`.
* **The duplicate-target queue.** The fourth widget names Pane 1's own
  target id on purpose. Since one `StreamHandle` can paint exactly one
  canvas, it starts in the `duplicate-target` error state and attaches
  automatically the moment Pane 1 disconnects, using the wire
  subscription that was kept alive for it the whole time. Use the
  "Disconnect Pane 1" / "Reconnect Pane 1" buttons to watch this happen.
* **Drive all three at once.** The navigate/reload/screenshot row below
  the panes calls each widget's imperative API
  (`el.navigate()`/`el.reload()`/`el.screenshot()`) in a loop; nothing
  here is widget-specific, it is exactly what a host page's own script
  would call.

Token refresh (a bearer token expires after 900 seconds server side) is
deliberately NOT wired up in this demo, since it would need a backend to
mint a second token from, which this page does not have. See
`packages/embed/README.md`'s "Token refresh" section for `onTokenExpired`
and `token-endpoint`, the two ways `<browser-glass>` actually supports it.
