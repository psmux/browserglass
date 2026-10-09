# `@browserglass/client`

The framework agnostic BrowserGlass browser client: the `bgls.v1`
WebSocket transport state machine, binary frame decode, a canvas
renderer, and mouse/keyboard/touch input capture. Zero Node builtins; runs
in a browser, a Web Worker, or Node 22+ with a `ws` peer dependency passed
as `transport.WebSocketImpl`.

Most apps do not use this package directly. A React app wants
`@browserglass/react`'s `<BrowserGlass />`; a plain HTML page wants
`@browserglass/embed`'s `<browser-glass>` custom element. Both are thin
wrappers over this exact client. Reach for this package directly when you
are building one of those wrappers for a different framework, or when you
want the raw connection and stream handles with no canvas/DOM wrapper at
all (a headless Node client, a custom renderer).

## Install

Nothing under `@browserglass/*` is on npm yet: `npm view @browserglass/client`
returns a 404, and so does every sibling package. The only way to get this
package today is cloning the repository and building it; see
[`docs/quickstart.md`](../../docs/quickstart.md) for the exact commands.

Once a version is published, every package here will use the `alpha` npm
dist-tag, never `latest`, so a plain `npm install @browserglass/client`
still will not resolve. You will ask for the alpha explicitly:

```sh
npm install @browserglass/client@alpha
```

See [`docs/installing.md`](../../docs/installing.md) for the full plan,
and for the pnpm/yarn equivalents.

## A minimal working example

```ts
import { BrowserGlassClient } from '@browserglass/client';

const client = new BrowserGlassClient({
  url: 'wss://your-gateway.example/browserglass/socket',
  token, // a bearer JWT your OWN backend minted; this client never mints one
});

await client.connect();

const canvas = document.querySelector('canvas')!;
const container = canvas.parentElement!;
const handle = await client.subscribe(targetId, { canvas, container, quality: 'auto' });

client.on('fatal', (info) => console.error('BrowserGlass connection failed:', info.message));
```

That paints frames and starts input capture as soon as the target's own
capabilities allow it (readonly viewers only ever get the picture). See
`StreamHandle` (returned by `subscribe()`) for `detach()`, `setQuality()`,
and reading the renderer's own frame size directly.

A bearer token is capped at 900 seconds server side. Pass `credentials`
instead of a static `token` to refresh it without tearing down the
connection:

```ts
const client = new BrowserGlassClient({
  url: 'wss://your-gateway.example/browserglass/socket',
  credentials: async () => {
    const res = await fetch('/api/browserglass-token', { credentials: 'include' });
    const { token } = await res.json();
    return { token };
  },
});
```

`token`/`ticket` are used for the first connect if given; `credentials()`
is called for every reconnect that needs a fresh one afterward, including
close code 4201 (token expired).

## Where to go next

[`docs/quickstart.md`](../../docs/quickstart.md) covers the server side:
starting a gateway and minting a token. `packages/react/README.md` and
`packages/embed/README.md` show the two higher level wrappers built on
this package, if a raw `BrowserGlassClient` is more control than your app
actually needs.
