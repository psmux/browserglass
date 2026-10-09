# BrowserGlass Next.js demo

This is the end to end demo for the whole BrowserGlass project: concurrent,
parallel browser tabs visually in front of the user, with the user able to
control them, all through one WebSocket. If this app works, the SDK works.

If you want the smallest possible starting point instead of this full
demo, see `examples/minimal`: one Node file and one HTML page.

It is a real, separate npm workspace with its own `package.json` and
lockfile, deliberately excluded from the root `pnpm-workspace.yaml`. Its
`@browserglass/*` dependencies point at `file:../../packages/<name>`, which
resolves through each package's real `exports` map exactly the way an
actual user's `npm install @browserglass/server` would once the package is
published (see `docs/installing.md`), not through a workspace shortcut.

## Run it

The `@browserglass/*` dependencies are `file:` links to the packages in
this repository, and they resolve to each package's built `dist/` output.
So build the workspace once, from the repository root, before anything
else:

```bash
pnpm install
pnpm -r build
```

Then, from this directory:

```bash
npm install
npm run dev
```

Rebuild with `pnpm -r build` at the root whenever you change a package's
source; this demo does not see source edits until the package is rebuilt.

Then open <http://localhost:3000>. There is no login screen; clicking
"Open the browser wall" (or going straight to `/browser`) launches a real,
visible Chrome window on this machine (`headless: 'off'`) and streams three
of its tabs into the page.

Stop it with `Ctrl+C`: the SIGTERM handler closes the HTTP server, then
awaits `bg.stop()`, which releases every live instance and terminates its
Chrome process before the command exits.

`npm run dev` and `npm run start` both run `node server.mjs` (`start` sets
`NODE_ENV=production` first); there is no `next dev`/`next start` path,
since neither of those ever executes a custom server file at all.

## Watch a browser drive itself, then take it off it

This is the thing most people actually want from this SDK: **software
drives a browser, a person watches, and the person takes over when they
want to.** Press **"Start the agent"** in the strip under the header.

What starts is a real `@browserglass/automation` client, running inside
this Next server's own process (`lib/agent.ts`). It opens the same
`bgls.v1` socket your browser tab is on, appears in the viewer list as an
ordinary viewer, asks for a `ControlLease` like a person does, and its
keystrokes go through the same dispatcher and the same fencing check. There
is no animation anywhere. Kill the loop and the pane stops moving.

It works the middle tab, in a visible loop: opens `/agent-lab` (a page this
same app serves, deliberately, so the demo works on a plane), clicks into
the field, types a phrase a word at a time, presses Enter, reads down the
page, scrolls back up, and lets go of the tab between loops. The strip
narrates each step as it happens.

**Telling a robot from a person, without a legend.** Round is somebody,
square is something. The agent's dot on the control badge has square
corners where a person's is a circle; its segment of the driver rail under
the pane header is dashed where a person's is solid; the pane it is on
carries an `AGENT` tag next to `LIVE`/`POLLING`. The colour is unchanged in
every case, because a driver's colour is what ties their dot to their
cursor on the canvas. None of this is guessed: `ViewerPresence.kind` is the
server's own answer, derived from the `automation` capability on the
agent's token, and `driversOf()` in `@browserglass/react` joins it to the
lease. A holder the presence roster does not describe is drawn as a plain
driver and claims nothing.

**The takeover.** Press **"Take control"**, on the strip or on the pane
itself. Two things happen, in this order, and both are on the wire:

1. `client.requestControl(targetId)`. In this demo's shared mode that is
   granted on the spot, with no queue and nobody evicted, so your claim does
   not depend on the agent agreeing to anything. That is why it goes first.
2. `client.yieldControl(targetId, reason)`, which sends the protocol's own
   `control.yield`. It asks only the AGENT holders of that tab and leaves
   every person driving it alone.

This used to be an HTTP call to the demo's own server, because no client
could send `control.yield`. That is gone, and so is the route.

The strip prints how long the agent took to leave `holders[]`, measured by
the PAGE off `control.state` rather than reported by the agent about itself.
It reads **about 2008ms**, and the reason is worth knowing:
`@browserglass/automation` has no case for `control.yield.request` in its
message switch, so the agent is not notified and does not release early. The
engine takes the lease at the grace deadline instead. The takeover happens
either way and the agent does stop typing mid-word, because `humanType()`
re-checks whether it still holds control before every character. When that
case is added the number drops on its own, with nothing changed in this
demo. See `docs/agent-and-human.md`.

Press **"Hand the tab back"** and it picks its loop up again.

**The interleaving hazard, in front of you.** Do not take control. Instead,
click into the agent's pane while it is typing and type into the same field
alongside it. Your characters and its characters interleave, because two
writers on one focused input is what shared control means and an agent
cannot tell you have started. The pane says so in amber the moment there is
more than one driver, and `/agent-lab` flags any line whose keystroke
rhythm says two people produced it. This is not a defect the demo hides: it
is the cost of the pattern, which is why `mode: 'exclusive'` is the SDK's
default and why `docs/agent-and-human.md` tells you when to pick which.

All three patterns, and how to switch this demo between them, are in
[`docs/agent-and-human.md`](../../docs/agent-and-human.md).

## What to click, and what each panel proves

* **The three panes.** One real Chrome window, three tabs, three
  independent panes, one socket. Click into any pane: your click lands in
  the real Chrome window (proven by whichever tab you clicked navigating,
  scrolling, or reacting exactly as it would in a normal, local Chrome).
  Attaching at the granularity of a single tab is what the whole
  architecture is built around.
* **The LIVE / POLLING badge** on each pane. Real Chrome only pushes a
  continuous, smooth video stream for the one tab that is currently the
  window's active tab; every other subscribed tab still updates, but from
  periodic on demand screenshots instead (confirmed empirically against
  real Chrome). This is genuine Chromium behaviour, not a
  bug in this build: only one `RenderWidgetHost` per window is ever
  composited. Click a POLLING pane (or its tab in the strip above the
  grid) and watch it promote to LIVE within a second or two.
* **The address bar, back, forward, and reload** in each pane's header are
  wired to that pane's own tab through `useNav`, independent of every
  other pane.
* **The control badge and "Request control" button** in each pane's
  footer. Click into a pane to take control of that tab (and only that
  tab); a second viewer clicking "Request control" on the same tab starts
  the real two step handshake (`control.request` then, from the current
  holder, either a release or a timeout, then `control.preempted`), and
  the badge updates for both viewers as it happens.
* **"Copy link for a second viewer"** puts the current instance id into
  the URL (`?instanceId=...`). Paste that into a second browser, or a
  second window, and it attaches to the exact same running instance as a
  second Viewer rather than launching a new Chrome (`AcquireRequest.
  instanceId`, "attach to a known instance, never launches"): same three
  panes, same sockets worth of frames, independently controllable. See
  `docs/collaboration.md` for the model behind two or more people sharing
  one browser this way.
* **The viewer list**, top right, lists everyone currently connected.
* **The debug overlay**, bottom right, shows live fps, RTT, backlog, and
  dropped frames for the whole session. Backlog should stay low (at or
  below 3) on every stream; fps on the LIVE pane should be well above
  zero, and non-zero (if lower) on the POLLING panes too, since they are
  still genuinely updating.
* **Kill Chrome** from Task Manager (or `taskkill /IM chrome.exe /F` on
  Windows) while the page is open. The connection banner and debug overlay
  will show the disruption; the recovery ladder restarts the browser and
  the panes come back on their own, rather than staying blank forever.

## Whose browsers are these

Opening `/browser` used to launch a brand new set of three Chrome windows
every single time, because the acquire named no selector at all: there was
one hardcoded demo user, so "my browsers" was not a thing the demo could
say. It can now say it, and it can say "our browsers" too.

* **Solo (the default).** Every visitor gets a stable id in an httpOnly
  cookie on their first request. The acquire sends
  `sticky: { subject: <that id> }`, so a reload, a second tab, or a visit
  the next morning all reattach to the same browsers. Nothing new is
  launched. The header says which happened, in words.
* **Shared (`?workspace=<id>`).** The sticky subject becomes the workspace
  id instead of the personal one, so everybody holding that link
  collaborates on one set of browsers. "Start a shared workspace" mints an
  id and navigates; "Copy workspace link" hands it out. It is a separate
  set from your solo one, and "Back to my own browsers" returns to yours.
* **`?instanceId=<id>`** still means what it always meant: join this exact
  running instance, never launch. It is the immediate escape hatch, where
  a workspace link is the durable one.
* **"New browser set"** releases the current instance and launches a
  genuinely new one. Reuse by default is only safe if there is a visible
  way out of it.

Closing a tab no longer destroys anything. A reload and a close look
identical to a page script, so releasing on `pagehide` would have torn
down the very browsers a reload is supposed to give back. Instead:
"Close browsers" is a button; an abandoned instance is reclaimed by the
router's idle reaper (15 minutes idle plus a 10 minute grace); and killing
the demo server closes every browser it launched, through `bg.stop()` on
SIGINT/SIGTERM and `killOnShutdown: true` for every exit that is not
graceful. `BrowserRouter.release` terminates only when no viewers remain,
and this demo never passes `force`, so no path here can take a shared
browser away from somebody who is still watching it.

## Files

* `server.mjs`: the custom server. Builds one real `BrowserGlass` gateway
  (SQLite store, a real Chrome host runtime, an ephemeral Ed25519 dev
  signing key), starts it before the HTTP server ever listens, and hands
  the `/browserglass/socket` WebSocket upgrade to it first in the chain,
  before falling through to Next's own upgrade handler (Fast Refresh's HMR
  socket in dev).
* `lib/bgls.ts`: the one piece of glue an App Router app needs to reach a
  custom server's `BrowserGlass` instance from a route handler, plus this
  demo's ownership model (the per visitor owner cookie, the workspace id
  normaliser, and the one function that turns either of them into a sticky
  subject) and its capability granting `Principal`.
* `app/api/browser/route.ts`: `POST` acquires and mints a fresh bearer
  token. Four ways in, differing only in the selection fields they send:
  nothing (solo, sticky to the visitor), `{workspace}` (sticky to the
  workspace), `{instanceId}` (attach, never launch), `{fresh: true}`
  (bypass reuse). `DELETE` releases one.
* `app/api/browser/token/route.ts`: `POST` refreshes that token, since it
  expires after 120 seconds.
* `app/api/browser/release/route.ts`: `POST` releases an instance and
  reports what actually happened (`terminated`, or `detached` with a
  remaining viewer count when other people are still watching). It never
  passes `force`.
* `app/api/browser/instances/route.ts`: `GET`, proxying `bg.router.list()`
  directly: the REST replacement for the `useBrowserInstances` hook that
  deliberately does not exist in `@browserglass/react` (a hook for tabs
  inside one connected instance is `useTargets`; listing separate browser
  instances across a deployment stays ordinary REST app code).
* `lib/agent.ts`: the demo's agent. A real `AutomationClient` in this
  server's process, one per instance, kept on `globalThis` so a dev hot
  reload does not strand a socket that is still typing. Its header
  documents which half of the stand-down is the SDK's and which half is
  this application's, and why.
* `lib/agent-lab.ts`: the two things the agent and the page it drives have
  to agree on: where the field is, in viewport CSS pixels, and the shape of
  the status the wall page polls.
* `app/agent-lab/page.tsx`: the page the agent drives. Everything on it is
  three times the size you would normally write, because it is read through
  a pane a third of life size, and its one field is at a fixed coordinate
  because the locator engine (`click('#q')`) is not built in this pass.
* `app/api/browser/agent/route.ts`: start, hand back, stop. Lifecycle only,
  and deliberately not part of the protocol: nothing in `bgls.v1` grants an
  agent permission to drive, so whether this agent should be running is a
  question for the application rather than for the browser. There is no
  stand-down action, because standing the agent down is `control.yield` on
  the wire.
* `app/browser/page.tsx`: the wall itself.
* `isolated-world-probe.mjs`: proves WHERE the locator surface runs, which
  is the one thing a unit test cannot settle. It loads a page that patches
  `Document.prototype.querySelector` from its own inline script, runs
  `resolve`, `fill` and `click`, and asserts the page's counter never
  moved, with a main world call afterwards to show the counter does move
  when something really is running in the page's world. Run it the way you
  run `form-parity-probe.mjs`: `npm run dev`, then
  `node isolated-world-probe.mjs`.

## A note on how this demo authenticates

BrowserGlass also has an opaque, single use
`ticket` (`tkt_...`) that a page can pass to `<BrowserGlass ticket={...}>`. This
demo mints a signed bearer token instead (`bg.tokens.issueWithMeta()`,
passed as `<BrowserGlass token={...}>` with an explicit `credentials`
refresh callback), because the real, atomic ticket minting machinery
(`mintTicket()`/`TicketRegistry`) has no entry point reachable from
`createBrowserGlass()`'s exported `BrowserGlass` interface: it is only
ever called from its own definition file and its own unit test. The
bearer token path is fully wired end to end (an explicit `auth.resolver`
verifies it on every `hello.auth`), so that is what this demo uses.
