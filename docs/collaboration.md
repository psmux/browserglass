# Two or more people on one browser

This is the reference for the other half of control sharing: **two people
are looking at the same browser and both of them can type. Who gets the
wheel, what the other one sees, and what happens when one of them walks
away.**

[`agent-and-human.md`](./agent-and-human.md) answers the case where one of
the parties is software. Software is ranked below a person by default, so
that page is largely about a takeover that always succeeds. Nothing here
does. Two people carry the same `priority`, and every question changes as a
result.

Everything below is read from the source in this repository, and the file
and symbol behind each claim is named. Where the code does not do something
a reader will obviously want, it is under
[Gaps](#gaps-in-this-path-stated-rather-than-smoothed-over) rather than
described in the future tense.

## Before any of this: two people, one browser

Getting two viewers onto one instance is a separate mechanism, and
[`ownership.md`](./ownership.md) is the reference for it: two callers that
pass the **same subject** get the same browser. A shared workspace derives
that subject from the workspace (`workspace:acme`) rather than from the
signed-in user.

Each person then needs their own token, scoped to that instance and session:

```ts
const token = await bg.tokens.issue({
  sub: userId,                       // per person, not per workspace
  role: 'driver',                    // view, control, navigate, tabs.manage, clipboard.write, upload, download
  scope: { kind: 'instance', instanceId, targets: '*', sessionId },
  ttlSeconds: 300,
});
```

`role: 'driver'` is `DRIVER_BUNDLE` in
`packages/protocol/src/wire/capabilities.ts`. `control` is the capability
that matters here; a person issued `role: 'observer'` (`['view']`) is in the
room, visible on the roster, and cannot take the wheel at all.

## The one setting

Control mode is server side configuration, per session, and is the same
setting the agent page describes:

```ts
createBrowserGlass({
  session: { control: { mode: 'shared' } },   // default: 'exclusive'
});
```

It is also readable as `BGLS_CONTROL_MODE` (`packages/server/src/config/resolve.ts`).
The default is `'exclusive'` and stays there unless you change it.

| | `'exclusive'` (default) | `'shared'` |
| --- | --- | --- |
| Drivers per tab | 1 | N |
| Second person asking | queued | granted immediately |
| Queue exists | yes, FIFO within priority | no, `queue` is always `[]` |
| Preemption between peers | no (see below) | not applicable |
| Both people can type | no | yes, into the same field |

Mode is per session, not per target, but a lease is per `(sessionId,
targetId)`. Two people can drive two different tabs of one browser
concurrently under either mode.

## Exclusive: one driver and a line behind them

### Two people ask at the same moment

First come wins, and the second person is queued. There is no negotiation
and no notification to the person who won.

`EXCLUSIVE_POLICY.onRequestHeld` (`packages/core/src/control/policies.ts`)
returns `'preempt'` only when `force && admin`, or when
`request.priority > holder.priority`. Priority comes from `DEFAULT_PRIORITY`
in `packages/core/src/control/types.ts`, keyed by holder kind: `admin: 900`,
`owner: 200`, `human: 100`, `agent: 50`. Two people are both `human: 100`,
`100 > 100` is false, and `control.request` carries no priority field on the
wire at all (`packages/protocol/src/wire/messages/control.ts`, and
`packages/server/src/ws/connection.ts` never passes one). So:

**One person can never take a tab off another person in exclusive mode.**
They queue, and they wait for the holder to release, disconnect, or let the
lease lapse. The only exception is an admin, below.

Verified against `packages/core/dist` with `createManualClock`: Alice
requests and is granted; Bob requests 10 seconds later and receives
`control.queued{position: 1, estimatedWaitMs: null, holderLabel: "alice"}`;
Alice receives no `control.preempt.request` and the lease phase stays
`held`.

`estimatedWaitMs` is `null` until the engine has recorded ten completed
tenures (`MIN_HOLD_SAMPLES` in `packages/core/src/control/queue.ts`), after
which it is `position * min(idleExpiryMs, medianHoldMs)`. A fresh gateway
reports `null`, which is honest rather than useless: do not render "about 0
seconds".

### What the person waiting sees

Two things, and only two.

`control.queued`, sent once, directly to them. And every subsequent
`control.state` broadcast, whose `LeaseState` carries the full queue for
every recipient:

```ts
{
  targetId, holderViewerId: 'vwr_alice', holderLabel: 'vwr_alice',
  mode: 'exclusive', holders: [{ viewerId, label, grantedAt, expiresAt, connected }],
  holderCount: 1,
  queue: [{ viewerId, label, requestedAt, priority }],
  queueLength: 1,
  queuePosition: 1,          // this recipient's own position, 1-based
}
```

`queuePosition` is computed per recipient (`queuePositionFor`), so the same
logical broadcast says `1` to Bob and `null` to everyone else. The whole
`queue` array, by contrast, is identical for everyone, which is what lets a
UI show the room the entire waiting line.
`<RequestControlButton/>` finds its own "Waiting, 1 in queue" by searching
`lease.queue` for `myViewerId` rather than by reading `queuePosition`.

Sending `control.request{queue: false}` gets a refusal instead of a place in
line: `control.denied{reason: 'holder_pinned', holderLabel, retryAfterMs}`.
`retryAfterMs` falls back to `minHoldMs` (3000) until there are enough
samples to estimate.

### The one way a person takes a tab off another person

An admin token, and `force: true`:

```ts
await client.requestControl(targetId, { force: true, reason: 'incident 4471' });
```

`BrowserGlassClient.requestControl()` refuses locally without `admin`.
Server side it enters the two step preemption machine, and because the
holder is a person rather than an agent the grace is `forceClaimNoticeMs`,
3000ms, not the 2000ms an agent gets. The holder receives
`control.preempt.request{reason: 'force_claim', graceMs: 3000, deadline}`,
**keeps their lease and keeps driving for the whole window**, and can end it
early by releasing. At the deadline they receive
`control.preempted{released: false, lastDispatchedInputSeq, mayRequeue: true,
requeueAfterMs: 30000}` and the admin is granted.

Verified: with Alice holding for 5 seconds and Carol force claiming as
admin, Alice gets `control.preempt.request` at once with `graceMs: 3000`,
and the holder list becomes `carol` at 3001ms.

`control.revoke{targetId, holderViewerId}` is the other admin instrument. No
warning, no grace, and it names one holder, which is what makes it the right
tool on a shared target. Naming a viewer who is not currently holding
returns `bgls.error.control.not_held` rather than revoking whoever holds it
now.

## Shared: everyone who asks is driving

`requestShared` (`packages/core/src/control/lease-engine.ts`) does not
consult `onRequestHeld` at all. A viewer with `control` who asks is granted,
synchronously, with their **own** `leaseId` and their **own** expiry.

Verified: two people, both granted, `holders: ['alice', 'bob']`,
`holderCount: 2`, `queueLength: 0`, `queuePosition: null`.

The lease also broadcasts `control.contention` once when the holder count
crosses from one to two or more, and once again when it drops back:

```ts
{
  t: 'control.contention', targetId, contended: true, holderCount: 2,
  mostRecentViewerId: 'vwr_bob',
  holders: [{ viewerId, label, kind: 'human', priority: 100, grantedAt, connected }],
}
```

Unlike `LeaseHolderState`, this one carries `kind` and `priority` already
joined, so a client can answer "who am I now co-driving with" from a single
message without waiting for the presence roster to catch up.

Two people typing into the same focused field interleave their characters
and nothing arbitrates it. That hazard is identical whether the second
writer is a person or a robot, and
[`agent-and-human.md`](./agent-and-human.md#the-interleaving-hazard-stated-plainly)
states it in full rather than repeating it here. The one difference worth
adding: two people usually notice within a word, and a robot never does.

`control.yield` is no help here. `requestAgentYield` skips every holder
whose `kind` is not `'agent'`, so a person sending it into a room of people
is accepted and notifies nobody: `client.yieldControl()` resolves with
`agentsAsked: 0`. Asking another person to stop driving is a conversation
your application has to carry, not a message this protocol has.

## What the rest of the room sees

### The roster

`presence.state` is broadcast to every connected viewer whenever the roster
or anyone's `controlling`/`watching` set changes: on join, on leave, and on
every grant, release, revoke and preemption
(`ManagedSession.broadcastPresence`).

```ts
{
  viewerId, label, kind: 'human' | 'agent' | 'service',
  colour: '#64b5f6',        // stable per viewer, from an 8 entry palette
  controlling: [targetId],  // several viewers can name the same targetId in shared mode
  watching: [targetId],     // targets this viewer has a stream for
  idle: false,
  joinedAt,
}
```

A UI can honestly render four things from this: who is in the room, which
tabs each of them is driving, which tabs each of them is watching, and a
stable colour per person. `colour` is a hash of the `viewerId` over the
eight values in `PRESENCE_COLOURS`
(`packages/server/src/session/managed-session.ts`), so a ninth viewer shares
a colour with the first. It cannot render names or idleness. Both are gaps
and both are below.

### Cursors

Set `presenceCursor: true` on the client (or `sendCursor` on
`<BrowserGlass/>`) and this viewer publishes `presence.cursor`, throttled to
one every 40ms, piggybacked on outgoing `input.mouse` moves in
`BrowserGlassClient.sendInput()`. That piggyback is not gated on holding the
lease, so **a watcher's cursor is visible to everyone even though their
clicks are being fenced off**. The server relays it to every other viewer
and never echoes it back to the sender (`ManagedSession.relayCursor`), and
it needs no capability beyond being connected.

`usePresence(client).cursors` is a `Map` keyed by `viewerId`. The hook joins
each cursor against the roster to recover `label` and `colour`, because the
client drops both off the wire message. Draw them with `<CursorLayer/>`,
which takes `drivingViewerIds` and renders a driver's cursor solid and a
watcher's hollow.

### The lease, per recipient

One trap, and it costs an afternoon if you hit it. In `mode: 'shared'`,
`LeaseState.holderViewerId` is a **per recipient projection**: it reports
the recipient's own holding, or `null`. Verified: with Alice and Bob both
driving, Alice's copy says `alice`, Bob's copy says `bob`, and a watcher's
copy says `null`, while `holders` says `['alice', 'bob']` in all three.

So `holderViewerId === myViewerId` is the right test for "am I driving" and
the wrong one for anything else. `holders` is the complete, recipient
independent answer. The same trap applies to `useControlLease().holder`,
which is built from `holderViewerId`: in shared mode it is you or nobody,
never your colleague.

`driversOf(lease, viewers, targetId, myViewerId)` from
`@browserglass/react` is the join you actually want. It reads `holders`,
falls back to the roster's `controlling` in the window before the first
`control.state` arrives, and returns `{ viewerId, label, colour, isMe,
connected, kind }` per driver.

## Handing over

**Exclusive, voluntary.** The holder sends `control.release`. The lease
enters `handing-over`, drains the input dispatcher (bounded at
`handoverDrainMs`, 2000), sweeps the departing driver's held buttons and
modifiers, then grants the queue head a **fresh** `leaseId`. Verified: Bob's
`control.granted` carries a different `leaseId` from Alice's.

The person losing control this way is told nothing. No `control.revoked` is
sent for a voluntary release; they simply stop being in `holders` on the
next `control.state`. That is correct (they asked for it) and it does mean a
UI should update from the broadcast rather than waiting for an
acknowledgement.

**Shared, voluntary.** Same call, and only that holder's tenure ends. The
lease stays `held`, the other drivers' deadlines are untouched, and
`<RequestControlButton/>` correctly labels the action "Stop controlling"
rather than "Release control", because nobody is next in line.

**Whichever way control goes away, releases still dispatch.** `mouse.up`,
`key.up`, `touch.end` and `touch.cancel` go through on a dead or stale
`leaseId` and are attributed to the previous holder
(`ALWAYS_DISPATCHED_KINDS` in `packages/core/src/control/fencing.ts`), so a
departing driver cannot leave a button or a modifier stuck down inside a
page other people are still typing into.

**Someone closes their laptop.** The socket closes and the tenure survives
`disconnectGraceMs`, 30 seconds, so a reconnect inside the window resumes
the **same** `leaseId` rather than re-requesting and re-queuing.

The two modes handle it differently, and the difference matters:

* Exclusive: the lease enters `held-grace`. Nobody else can drive for those
  30 seconds. A queued waiter is granted at the end of them. Verified: at
  29999ms the phase is still `held-grace` and Bob has nothing; at 30001ms
  the phase is `held` and Bob holds it.
* Shared: the lease stays `held` and only that one holder is on the clock,
  marked `connected: false` in `holders` while everyone else carries on. But
  their held pointer state is swept after `disconnectHygieneMs`, 1500ms,
  not 30 seconds, because a jammed mouse button belongs to everyone looking
  at the page and their seat belongs only to them. Measured before that
  split existed: a hard close left a button down for 30514ms.

A queued viewer who disconnects is simply dropped from the queue.

## Someone holds the lease and walks away

This is the question every shared browsing app hits in its first week, and
the honest answer is that **the code has an idle expiry and it does not fire
in practice.**

The mechanism reads well on paper. `idleReleaseMs` (20000) arms a timer per
holder; when it fires with a non-empty queue the holder is revoked
`reason: 'idle'` and the queue head is granted. `idleExpiryMs` (30000) and
`leaseTtlMs` (60000) feed `expiresAt`, and `renewGraceMs` (12000) drops a
holder who stops renewing.

What defeats it is the client. `BrowserGlassClient.scheduleLeaseRenew()`
sends `control.renew` when `expiresAt - now` falls to `renewWithinMs`
(15000), unconditionally, for as long as it holds the lease. And
`ControlLeaseEngine.renew()` sets `holder.lastInputAt = now` as well as
`lastRenewAt`. So every renewal resets the idle clock, the 20 second timer
is rearmed every 15 seconds, and it never fires. Verified by driving exactly
that loop against the real engine: 400 renewal cycles, roughly 100 minutes
of clock, no input at any point, and in both modes the holder who walked
away is still holding.

What actually recovers a tab from an absent person today:

* They close the browser tab, which starts the 30 second disconnect grace.
* An admin sends `control.revoke` naming them.
* An admin disconnects them entirely:
  `DELETE /v1/sessions/:sessionId/viewers/:viewerId` (capability `admin`).
  `<ViewerList onKick={...} canKick/>` is the affordance for it.

Build the admin path. Do not build a UI whose recovery story is "the lease
will time out", because it will not.

## Gaps in this path, stated rather than smoothed over

**A queued person is dropped after two minutes and never told.**
`queueTtlMs` is 120000, and `expireQueue` runs only at handoff settlement,
so nothing fires at the deadline. Verified: Alice holds and renews for 180
seconds, Alice releases, and Bob is **not** granted. The lease goes
`unheld`, Bob's `control.granted` count is zero, and the only signal he ever
gets is his `queuePosition` quietly becoming `null` on the next broadcast.
Poll `queuePosition` and re-request when it disappears.

**There is no way to leave a queue except by disconnecting.**
`ControlLeaseEngine.withdrawRequest()` exists and is called from nothing in
`packages/server`. There is no `control.cancel` on the wire. A "never mind"
button has nothing to send.

**`control.request.reason` is stored and never shown.** The field is
documented as "shown to the current holder". `enqueueOrDeny` copies it onto
the `QueueEntry` and no wire message reads it back: `LeaseState.queue`
carries `viewerId`, `label`, `requestedAt` and `priority` only. If you want
"Bob is asking because X" on the holder's screen, carry it in your own
application channel. (`control.yield`'s reason **is** delivered, on
`control.yield.request`.)

**Nobody has a name.** `presence.state.viewers[].label` and
`LeaseHolderState.label` are both the raw `viewerId`.
`ManagedSession.attachViewer` sets `label: presenceLabel ?? sink.viewerId`,
and the only caller that passes `presenceLabel` is the raw CDP upgrade path;
`viewerIdentity()` in `ws/connection.ts` sets the lease side label the same
way. `BrowserGlassClientOptions.label` is accepted by the client and never
reaches either. `<ViewerList/>` renders `vwr_01J...`, and the demo says "You
are vwr_...". Map `viewerId` to a display name in your own app.

**`idle` is always `false`.** `presenceSnapshot()` hardcodes it. No idle
tracking exists anywhere in the codebase, so `<ViewerList/>`'s
`data-bgls-idle` attribute is currently a constant.

**`<BrowserGlass showCursors>` does nothing.** The prop is declared in
`packages/react/src/types.ts` and read nowhere. Render `<CursorLayer/>`
yourself through the `overlay` prop, as the demo does: `OverlayContext.toClient`
is the only place the frame to screen mapping exists.

**Cursors do not survive a quality mismatch.** `presence.cursor` carries
`fw`/`fh` (the frame dimensions its coordinates were measured against) and
`BrowserGlassClient`'s handler drops them, along with `label` and `colour`.
Two viewers at the same quality share a frame space and land correctly, two
at different qualities do not, and there is nothing left to rescale with.

**Four of the five `session.control` config keys go nowhere.**
`packages/server/src/index.ts` threads only `{ mode }` into the session
factory. `leaseMs`, `graceMs`, `queueMax` and `allowForceClaim` are resolved
by `config/resolve.ts`, validated, and read by nothing. Tune timings through
`SessionOptions.control.timing` when you construct the session yourself, not
through gateway config. `forceClaimAfterMs` (20000, "how long a queued
viewer waits before force claim is offered") is declared in `CONTROL_TIMING`
and read nowhere at all: there is no such offer. And
`DELETE /v1/sessions/:sessionId/control/:targetId` is a 501 stub, so
`control.revoke` over the WebSocket is the only way to take a lease off
somebody.

## A component that shows the room and takes the wheel

```tsx
'use client';

import { driversOf, useBrowserGlass, useControlLease, usePresence } from '@browserglass/react';
import { ControlBadge, RequestControlButton, ViewerList } from '@browserglass/react/ui';

export function SharedTab({ url, ticket, targetId }: { url: string; ticket: string; targetId: string }) {
  const bg = useBrowserGlass({ url, ticket, presenceCursor: true });
  const presence = usePresence(bg.client);
  const lease = useControlLease(bg.client, targetId);

  const myViewerId = bg.client?.viewerId ?? null;
  // `useControlLease` deliberately does not expose the whole `LeaseState`.
  // `client.leases` is the map it is projected from, and `holders` is the
  // only field that answers "who is driving" under shared control.
  const leaseState = bg.client?.leases.get(targetId) ?? null;
  const drivers = driversOf(leaseState, presence.viewers, targetId, myViewerId);
  const iAmDriving = drivers.some((d) => d.isMe);

  return (
    <>
      <ViewerList viewers={presence.viewers} myViewerId={myViewerId} compact />

      <ControlBadge
        lease={leaseState}
        myViewerId={myViewerId}
        drivers={drivers}
        showMode
      />

      <RequestControlButton
        lease={leaseState}
        myViewerId={myViewerId}
        canRequest={lease.canRequest}
        requesting={lease.requesting}
        iAmDriving={iAmDriving}
        onRequest={() => void lease.request({ reason: 'taking a look' }).catch(console.error)}
        onRelease={() => void lease.release().catch(console.error)}
      />

      {drivers.length > 1 && (
        <p>
          {drivers.filter((d) => !d.isMe).map((d) => d.label).join(', ')} are
          typing into this tab as well.
        </p>
      )}
    </>
  );
}
```

Three things about that sketch are load bearing.

`leaseState` comes from `client.leases`, not from the hook, because
`useControlLease().holder` is built from `holderViewerId` and so cannot tell
you about your colleagues. Subscribe to the client's `'control'` event if
you want the full `LeaseState` in React state rather than read during
render.

`iAmDriving` is passed explicitly. `<RequestControlButton/>` otherwise falls
back to `lease.holderViewerId === myViewerId`, which is wrong for every
driver but one in shared mode.

`drivers.length > 1` is the interleaving warning, and it belongs on the
pane. A person whose keystrokes come out shuffled concludes the keyboard is
broken long before they conclude somebody else is typing.

## Where this differs from the agent case

Read [`agent-and-human.md`](./agent-and-human.md) for anything involving
software, and expect these four differences:

| | Person over person | Person over agent |
| --- | --- | --- |
| Priority | equal (`human: 100` both sides) | `human: 100` beats `agent: 50` |
| Preemption in exclusive mode | never, without `admin` and `force` | automatic, and `minHoldMs` is lifted |
| Asking the other to stop, shared mode | no message exists | `control.yield`, gated on `control` |
| Grace when displaced | `forceClaimNoticeMs`, 3000ms | `agentPreemptGraceMs`, 2000ms |

The pattern that catches people out: a takeover button that works perfectly
against an agent does nothing against a colleague. It is the same
`requestControl()` call, and in exclusive mode it silently becomes a queue
join. Read `ControlOutcome`, which distinguishes the three answers, rather
than treating the promise resolving as success:

```ts
const outcome = await client.requestControl(targetId);
if (outcome.granted) { /* driving */ }
else if (outcome.queued) { /* position N, and see the two minute gap above */ }
else { /* denied: reason is one of cap_missing, queue_full, policy, holder_pinned, target_gone, session_readonly */ }
```

## Seeing it run

`examples/nextjs-demo` runs the shared case with real people.

```
cd examples/nextjs-demo
npm install
node server.mjs
```

Open `http://localhost:3000/browser`, press "Start a shared workspace", then
"Copy workspace link", and open that link in a second browser profile. Two
viewers, one Chrome, both able to type. It is configured
`session: { control: { mode: 'shared' } }`, and its posture switch ("watch"
against "drive") is the honest UI for that mode: watching is a choice each
person makes, not a permission somebody grants, because in shared mode there
is nothing to grant.

Change that one line in `server.mjs` to `mode: 'exclusive'` and the same
page becomes the queue: the second person's button reads "Waiting, 1 in
queue" and stays there until the first person releases.
