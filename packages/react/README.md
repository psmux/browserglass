# `@browserglass/react`

`<BrowserGlass />`, eight hooks, and (under the `./ui` subpath) a set of
unstyled UI primitives, all built on `@browserglass/client` underneath.
This is the browser half of a BrowserGlass app; the server half is
`@browserglass/server`.

## Install

Nothing under `@browserglass/*` is on npm yet: `npm view @browserglass/react`
returns a 404, and so does every sibling package. The only way to get this
package today is cloning the repository and building it; see
[`docs/quickstart.md`](../../docs/quickstart.md) for the exact commands.

Once a version is published, every package here will use the `alpha` npm
dist-tag, never `latest`, so a plain `npm install @browserglass/react`
still will not resolve. You will ask for the alpha explicitly, and install
`@browserglass/server` alongside it, since one is not useful without the
other:

```sh
npm install @browserglass/react@alpha @browserglass/server@alpha
```

See [`docs/installing.md`](../../docs/installing.md) for the full plan,
and for the pnpm/yarn equivalents.

## A minimal working example

```tsx
import { BrowserGlass } from '@browserglass/react';

function RemoteTab({ token }: { token: string }) {
  return (
    <BrowserGlass
      url="wss://your-gateway.example/browserglass/socket"
      token={token}
      targetId="tgt_01M0..."
      style={{ width: 960, height: 600 }}
    />
  );
}
```

`token` above is a bearer JWT your OWN backend minted (`POST /v1/tokens`,
or `bg.tokens.issueWithMeta()` server side); this component never talks to
your auth system itself. `targetId` names which browser tab to show,
which your backend also hands you, from acquiring an instance
(`POST /v1/instances`) first. `@browserglass/server`'s own README shows
both of those server side calls in full, against the real API.
`examples/minimal` is the smallest complete app wiring them together, and
`examples/nextjs-demo` is the same wiring at production scale.

A bearer token is capped at 900 seconds server side. `<BrowserGlass />`
refreshes it through `onTicketExpired`:

```tsx
<BrowserGlass
  url="wss://your-gateway.example/browserglass/socket"
  token={token}
  targetId={targetId}
  onTicketExpired={async () => {
    const res = await fetch('/api/browserglass-token', { credentials: 'include' });
    const { token } = await res.json();
    return token;
  }}
/>
```

## Beyond the one component

`useBrowserGlass({ url, token, ... })` is what `<BrowserGlass />` is built
on, for an app that wants the raw connection state and stream handles
without the component's own canvas/overlay/input-capture wrapper. It takes
one options object and returns `{ client, state, connected, ... }`:

```tsx
const { client, state } = useBrowserGlass({
  url: 'wss://your-gateway.example/browserglass/socket',
  token,
});
const { targets } = useTargets(client);
```
 `useTargets`,
`useNav`, `useControlLease`, `usePresence`, `useInstanceStats`,
`useConsole`, and `useNetwork` are the other seven hooks, each scoped to
one slice of what a live client exposes. Every hook accepts
`client: BrowserGlassClient | null` and returns sensible empty defaults for
`null`, so no guard clause is needed before render.

The `./ui` subpath exports unstyled primitives (`AddressBar`, `TabStrip`,
`ControlBadge`, `RequestControlButton`, and others) for a host app assembling
its own chrome around the canvas rather than using `<BrowserGlass />`'s
built-in overlay.

## Where to go next

[`docs/quickstart.md`](../../docs/quickstart.md) covers starting a gateway
and minting a token end to end. `docs/agent-and-human.md` covers the
control lease model (`useControlLease`, shared vs. exclusive driving) this
package's hooks surface directly.
