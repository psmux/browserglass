# Minimal example

The shortest path from a checkout to a live, drivable browser on a web
page: one Node file, one HTML file, two commands, no build step for the
page itself.

`server.mjs` builds a gateway with `createBrowserGlass()`, launches one
real Chrome, and serves three things on one port: the page, the widget
script, and a `/session` endpoint the page fetches its token and target id
from. `index.html` is a plain page with one `<browser-glass>` element on
it.

## Running it

From the repo root, on a fresh clone:

```sh
pnpm install
pnpm -r build                              # this example imports the workspace builds
node examples/minimal/server.mjs
```

If you have already built the workspace, only the widget bundle is needed:

```sh
pnpm --filter @browserglass/embed build
node examples/minimal/server.mjs
```

Then open <http://localhost:7500>. A Chrome window opens next to your own
browser and that same browser appears in the page. Type a URL and press
Go, or click inside the pane to drive it. Ctrl+C shuts down and kills the
Chrome it launched. Set `BGLS_HEADLESS=1` if you have no display.

Nothing is written into the repo. State goes under the OS temp directory,
except Chrome's profile root on Windows, which has to be short enough that
the profile paths nested below it stay inside the MAX_PATH budget, so it
defaults to `bgls-minimal` at the root of the temp drive. Set
`BGLS_PROFILES_DIR` to move it, keeping the path short.

Both modes were verified on Windows 11 with Chrome 152: frames painting,
navigation, the control lease taken on click, nothing left running after
Ctrl+C.

## What it leaves out

No ownership, so every restart launches a fresh browser instead of
reattaching to yours. One tab, not a tab list. No CORS configuration,
because the page and the gateway share an origin, which is the one reason
this file serves its own HTML. One dev signing key per boot, generated in
process, which a real deployment must not do.

## Where to go next

`examples/nextjs-demo` is the full version: React, several concurrent
panes, sticky ownership, shared workspaces, agent and human collaboration.
`packages/react/README.md` is the React path if you already have a
bundler. `packages/embed/README.md` documents every `<browser-glass>`
attribute, event and method.
