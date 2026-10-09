# Driving several browsers at once

This is the reference for anyone hooking `BrowserSwarm` (or several hand
rolled `AutomationClient`s) up to a real BrowserGlass deployment and
expecting them to run in parallel. Everything below was measured against
this codebase, not assumed from a flag name or a doc comment, and every
number carries the file it came from so you can re-derive it yourself if a
future change makes it stale.

This file covers driving several browsers at once from one process.
For running more than one BrowserGlass gateway process against a shared
store, what the router is the authority for, and what is still single
node today, see `docs/scaling.md`.

## Window isolation is not optional

If you want more than one target to stream live video at the same time,
the Instance those targets belong to must be launched with
`BrowserSpec.isolation: 'window'`. Under the default, `'tab'`, Chromium
only composites the window's visible tab: every other tab in that window
produces exactly zero screencast frames, not a reduced rate. That ceiling
is per Instance, not per target, so it does not matter how many targets a
viewer opens if they all share one window.

The numbers, from `packages/runtime-host/test/spike/spike-window-isolation.ts`
(run against real Chrome, four tabs showing the same animated canvas):

* Four tabs in one window: `[0, 0, 0, 98.9]` fps. Three of the four tabs
  are completely dead; only the one Chrome had actually focused is live.
* The same four tabs, each given its own OS window: `[81.6, 81.8, 82.4, 81.0]`
  fps. All four live, and close enough to each other that none of them is
  starving its siblings.
* Forcing OS focus onto the first of those four windows changes nothing:
  the other three keep their frame rate. `isolation: 'window'` does not
  need the window to be visually on top, only to exist as a real OS
  window at all.

This is a per-Instance setting your own `acquire()` implementation has to
ask for; `BrowserSwarm` itself never launches anything, so it has no way
to request `'window'` on your behalf (`BrowserSwarmOptions.isolation` on
the swarm is informational for exactly this reason: it records what you
told it, it does not enforce it). If you are driving a swarm and also
watching it (a human viewer alongside your automation, or a debugging UI
showing every member's stream at once), and more than one target per
Instance needs to be live, set `isolation: 'window'` when you acquire that
Instance. If every member of your swarm is its own Instance (the pattern
`BrowserSwarm`'s own README example uses), this does not apply to you at
all: one target per Instance never hits the tab ceiling in the first
place, because there is only ever one tab.

Do not confuse this with swarm size. `size: N` in `BrowserSwarm.open()`
means N calls to your own `acquire()`, and whether that gives you N
separate Chrome processes or N attachments to the same one is entirely
your `acquire()` implementation's decision. `isolation: 'window'` is a
setting on ONE already-acquired Instance, about how many of ITS OWN tabs
can stream at once. N Chrome processes is N `acquire()` calls; N live
streams from one process is `isolation: 'window'` on that one call. They
are different axes and it is easy to reach for the wrong one.

## Closing every pane kills the browser, and that is expected

Headful Chrome exits the instant its last window closes. Under
`isolation: 'window'`, every streamed target is a whole OS window, so
closing every pane your swarm has open closes every window, and the last
one to close takes the whole browser process with it. Measured directly
in `packages/runtime-host/test/spike/spike-keep-alive.ts`
against Chrome 151.0.7922.174 on Windows 11:

* Headless, no flag: the browser survives having zero windows.
* Headful, no flag: it does not. The next attempt to create a target
  fails with "the bridge closed", because the CDP endpoint died with the
  process.
* Headful, launched with `--keep-alive-for-test`: still does not survive.
  That flag was the obvious candidate and it does nothing here; whatever
  it keeps alive, it is not a headful process past its last window.

BrowserGlass does not fight this. `core/src/session/session.ts`'s
`createTarget()` (see its own long comment for the reasoning) relaunches
the browser transparently on the next `target.new` if it finds the bridge
already closed, single flighted so three panes reopening at once cannot
each trigger their own restart, all under the same `instanceId`. From the
caller's side this is invisible: reopen a target on an Instance that has
zero windows left and it works, just slightly slower the first time
(relaunch plus a fresh CDP round trip) than a target created on an
Instance that already has windows open. Nothing in `BrowserSwarm` needs to
know this happened; `grow()` after every member closed its own last
window behaves the same as `grow()` on a freshly acquired Instance.

## Every rate limit that matters for N panes is per target or per stream

`packages/server/src/wire/rate-limit.ts` learned this the hard way three
times over, and its own comments are worth reading directly. The short
version, from that file:

* `input` and `control` are scoped per `(viewer, targetId)`, not once per
  connection. A connection wide budget here meant driving two or three
  panes hard at once starved a fourth, which is the exact "several
  browsers can never be driven at once" symptom this whole isolation
  effort exists to fix, just from a different mechanism than the
  active-target steal that isolation itself solved.
* `ack` is scoped per STREAM. It is 200/sec with a burst of 400
  (`DEFAULT_LIMITS.ackRate`, `packages/protocol/src/wire/limits.ts`).
  Connection wide, three streams at roughly 100fps each produce roughly
  300 acks/sec against that 200/sec refill: the 400 token burst drains in
  about four seconds, and then one of the three streams goes to a hard
  zero and never recovers, because the frame backlog that would let it
  resume is only drained by the acks that are now being refused. The
  other two streams look completely fine while this happens, which is
  what makes it easy to misdiagnose as something else.
* `probeFull` is scoped per TARGET, at 2/sec with a burst of 4
  (`DEFAULT_LIMITS.probeFullRate`). Connection wide, that 2/sec is shared
  across every pane doing its own hit testing, so three panes get 0.67/sec
  each and the third to ask in any given moment is simply refused. This
  reads as "the page stopped responding to hover", not as a rate limit,
  unless you already know to look for it.
* `nav`, `cursor`, `capture` stay connection wide; their ceilings are
  already generous relative to how often a caller actually navigates or
  captures, and per-target scoping was not worth the extra bookkeeping for
  them.

If you are driving N members of a swarm at once and see exactly one of
them stall while its siblings look fine, this is the first thing to check,
not a bug in your own driving code.

## Browser lifetime and `bg.stop()`

A browser your app started lives until something explicitly ends it.
`bg.stop()` (the embedded server SDK's own shutdown, `packages/server/src/lifecycle/stop.ts`)
releases every live instance's profile lease and terminates every
instance's browser process, in parallel across every instance rather than
one at a time, specifically so a deployment with several instances running
does not overrun its shutdown deadline waiting on them serially. Call it,
or your process's own equivalent teardown, when your application exits;
do not rely on Chrome exiting on its own, since (see above) it only does
that when its last window closes, and an Instance with zero windows left
open is not the same thing as an Instance that has been released.

A hard kill of your server process (not `bg.stop()`, a `SIGKILL` or a
crash) strands whatever browsers were live at that moment: nothing runs
their terminate ladder. This is recoverable, not silently lost:
`runtime-host/src/reconcile.ts`'s reconciliation step, run at your next
process start, finds every survivor the state file and the runtime can
both see and decides, per instance, whether to adopt it back into service
or terminate it. You do not have to hunt down orphaned Chrome processes by
hand after a crash; the next clean start does that for you.

## Gotchas a swarm caller will actually hit

**Distinct `requestId`s, or none at all.** `BrowserRouter.acquire()` runs
every request through an idempotency table keyed by `(tenant, app,
request)`, with a 300 second window by default
(`packages/router/src/router/config.ts`'s `idempotencyWindowMs: 300_000`).
A `requestId` you compute the same way on every call (or, worse, hardcode)
means every call inside that five minute window returns the SAME instance
you already got the first time, not a new one. `BrowserSwarmOptions.acquire`
is called with the member's own `index` for exactly this reason: mint your
`requestId` from it (or from a fresh id per call, or omit `requestId`
entirely if your own admission layer does not need one), and a `size: 5`
swarm actually gets five instances instead of five connections to the
same one.

**A pool's `maxInstances` is the real ceiling, not `size`.** Nothing about
`BrowserSwarm.open({size: N})` checks N against how many instances a pool
is actually configured to allow; that is entirely your `acquire()`
implementation's job, and the refusal (whatever shape your own admission
layer gives it) surfaces as an `acquire()` rejection, which the swarm's
partial-open cleanup will unwind. The demo pool this repository ships sets
`limits: { maxInstances: 20 }` (`examples/nextjs-demo/server.mjs:210`);
your own deployment's number is whatever your own pool config says, and it
is worth checking before asking a swarm to open more members than the
pool will admit.

**Release instances when you are done with them.** `BrowserSwarm.close()`
closes every `AutomationClient` connection it opened; it does not, and
structurally cannot, release whatever `acquire()` reserved on the
router or gateway side, because `acquire()` has no paired release call in
this package's contract (see `SwarmAcquireResult`'s own doc comment for
why that boundary is deliberate). If your admission layer needs an
explicit release, call it yourself, keyed by each member's `instanceId`,
including in a `catch` around `open()`/`grow()`: a failed member during
either of those has its own SOCKET cleaned up automatically, but whatever
your `acquire()` already reserved for it on the router side is still
reserved until you release it.

**A swarm launches new browsers unless you say otherwise, and the same
subject on every member is not how you say it.** `BrowserSwarm.open({size:
20})` with no `subject` calls your `acquire()` twenty times with no
ownership attached: twenty new Chromes, on every run. Pass
`BrowserSwarmOptions.subject` and each member slot reattaches to the
browser that slot had last time instead. What you must not do is take that
subject and put it verbatim on all twenty acquire requests: the router
resolves one subject to at most one instance
(`packages/router/src/router/reuse.ts`, `findReusable` step 2), so twenty
concurrent requests carrying one subject converge, nondeterministically,
onto a handful of browsers, and every one of them still returns 201 with a
working client. The swarm derives `<subject>#<index>` per slot for exactly
this reason and hands it to your `acquire()` as `ctx.subject`; use that
value rather than the bare one. Full model:
[`docs/ownership.md`](../../docs/ownership.md).

**The CLI drives browsers now, and `pnpm bgls swarm run` is the fan-out.** An
earlier version of this page said there was no `bgls` verb that opens or
drives a browser. That is no longer true: `pnpm bgls instances create/navigate/
click/type/screenshot/console/network` are real, and `pnpm bgls swarm run
--size N --action ...` opens N instances and runs one action across all of
them concurrently, built on this package's own `BrowserSwarm`. It takes
`--sticky-subject` for the ownership behaviour above. Reach for this
package directly when you are writing a program; reach for the CLI when
you are writing a shell script.
