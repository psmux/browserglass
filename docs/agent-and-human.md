# An agent and a person on one browser

This is the reference for one question: **an AI agent is driving a browser
and a person is watching it. What happens when the person wants the wheel?**

There are three answers, and you choose between them with one server side
setting and one decision about what is on the person's token. This page is
the three patterns, when to use each, what you pass to get it, and what it
costs in milliseconds. Everything below is read from the source in this
repository; the file and symbol behind each claim is named so it can be
re-derived when a later change makes it stale.

Companion page: [`ownership.md`](./ownership.md), which answers "whose
browser is this" rather than "who is driving it". For the other half of
control sharing, two or more people on one browser with no agent involved,
see [`collaboration.md`](./collaboration.md).

## The framing that makes all of this tractable

**An agent is a viewer.** Not a privileged side channel, not a second wire
path, not a special case in the dispatcher.

`AutomationClient.connect()`
(`packages/automation/src/client/AutomationClient.ts`) opens one `bgls.v1`
socket, the same one `@browserglass/client` opens for a person's browser
tab. It appears in `presence.state` like anybody else. It asks for a
`ControlLease` with `control.request` like anybody else. Its clicks and
keystrokes are `input.mouse` and `input.key` messages that go through the
same `InputDispatcher` and the same `resolveInputFencing` check a person's
input goes through. Kill the process and the tab simply stops moving.

Two things distinguish it, and both come from the token:

* **Its kind.** A viewer whose token carries the `automation` capability is
  recorded as `kind: 'agent'`; everybody else is `kind: 'human'`
  (`packages/server/src/ws/connection.ts`, `this.granted.has('automation')
  ? 'agent' : 'human'`). This lands on the presence roster, which is where
  a UI reads it back from.
* **Its priority.** `DEFAULT_PRIORITY`
  (`packages/core/src/control/types.ts`) ranks holders: `admin: 900`,
  `owner: 200`, `human: 100`, `agent: 50`. A person outranks an agent by
  default, which is the whole reason pattern 2 below works without any
  application code.

The `agent` role bundle is `['view', 'control', 'navigate', 'tabs.manage',
'automation']` (`packages/protocol/src/wire/capabilities.ts`), so
`role: 'agent'` on a token issue is shorthand for exactly that set.

## The one setting: `mode`

Control mode is **server side configuration, per session**, and deliberately
not a field on `control.request`:

```ts
createBrowserGlass({
  // ...
  session: { control: { mode: 'shared' } },
});
```

It threads `SessionOptions.control.mode` -> `Session.leaseEngineFor()` ->
`ControlLeaseEngineOptions.mode` -> `Lease.mode`, and comes back out on the
wire as `LeaseState.mode` and `ControlGranted.mode`, so a UI can read which
mode a target is in rather than assuming.

**The default is `'exclusive'`, and upgrading never changes it.** Some
automation treats exclusivity as a safety property, and nothing existing
should lose it by accident.

Arbitration has to be single valued for a contended resource: with a per
request mode, "Alice holds exclusively, Bob asks for shared" has no honest
answer. What a caller genuinely chooses is whether to ask for control at
all, which they already do by sending `control.request` or not sending it.

`SessionOptions.control` accepts exactly four keys (`mode`, `timing`,
`maxQueueDepth`, `policyName`) and throws at construction on anything else,
naming the key. A deployment can also veto shared mode outright with
`control.timing.allowShared: false`, which downgrades a shared session to
exclusive and records a `control.sharedNotAllowed` audit note rather than
doing it silently.

---

## Pattern 1: agent drives, person watches

**Use it when** the person is supervising rather than collaborating: a
run-watching dashboard, a QA replay, a demo, a customer support view of a
bot working a case. Nobody is going to touch anything, and the fact that
they cannot is a feature you want to be able to state.

**How you get it:** leave `mode` at its default, and **do not put `control`
on the watcher's token**. That is the whole of it.

```ts
// The person's token: they can see, and that is all.
const viewerToken = await bg.tokens.issue({
  sub: userId,
  role: 'observer',                  // ['view'], and nothing else
  scope: { kind: 'instance', instanceId, targets: '*', sessionId },
  ttlSeconds: 120,
});

// The agent's token: it can drive.
const agentToken = await bg.tokens.issue({
  sub: `agent:${runId}`,
  subKind: 'agent',
  role: 'agent',                     // includes `automation`, which is what makes it an agent
  scope: { kind: 'instance', instanceId, targets: '*', sessionId },
  ttlSeconds: 3600,
});

const agent = await AutomationClient.connect({ endpoint, token: agentToken });
await agent.acquireControl();
await agent.navigate('https://example.com/orders');
await agent.clickAt(412, 318);
await agent.humanType('order 4471');
```

This is enforced by the token, not by the UI. A watcher without `control`
who somehow sends an `input.*` message has it dropped server side before it
reaches CDP; `requestControl()` on the client refuses locally with
`"requestControl() needs the 'control' capability"` before it even reaches
the socket.

The one asymmetry worth knowing: **releases still dispatch.** `mouse.up`,
`key.up`, `touch.end` and `touch.cancel` go through even on a dead or stale
lease, so a departing driver cannot leave a mouse button or a modifier key
stuck down inside a page other people are still looking at.

Give the person `control` and you have pattern 2 instead, with no other
change. That is deliberate: "watching" and "watching, and could step in"
should be one decision, taken at token issue time, not two subsystems.

---

## Pattern 2: agent drives, person takes it over cleanly (the default)

**Use it when** the agent is doing the work and a person steps in on
exception: an assistant that fills a form and asks for help at the payment
step, an operator watching six bots and rescuing whichever one is stuck.
One writer at a time, and the handover is clean.

**How you get it:** the default. `mode: 'exclusive'`, both tokens carry
`control`, the agent's also carries `automation`.

The person just asks. The engine does the rest, because `human: 100` beats
`agent: 50`:

```tsx
// The person's side. This is the same button any exclusive-mode app has.
const lease = useControlLease(client, targetId);
<RequestControlButton
  lease={leaseState}
  myViewerId={myViewerId}
  canRequest={lease.canRequest}
  requesting={lease.requesting}
  onRequest={() => void lease.request({ reason: 'stepping in' })}
  onRelease={() => void lease.release()}
/>
```

```ts
// The agent's side. Registered ONCE, at connect time, and never again.
const agent = await AutomationClient.connect({ endpoint, token, targetId });

agent.onControlYield((ev) => {
  if (!ev.human) return;               // outranked by another agent; the run can retry
  plan.abort(`${ev.byLabel} took over mid-${ev.inFlight[0]?.action ?? 'idle'}`);
});

await agent.acquireControl({ reason: 'filling the order form' });
```

By the time that listener runs, **the client has already stopped
dispatching input on that target.** Nothing the listener does or fails to do
can let another click through, and a listener that throws is swallowed. The
callback is for deciding what the agent does NEXT, never for stopping it.

Use `onControlYield` rather than `ControlLeaseHandle.onPreemptionRequested`.
The per-lease handle has to be re-registered after every `acquireControl()`,
on every target, and it goes quiet exactly when the interesting thing
happens, because the handle it hangs off is the thing being revoked. An
agent driving twenty browsers would need twenty registrations refreshed on
every acquire.

Branch on `ev.human`, not on `ev.reason === 'human_takeover'`. `human` is
derived from two independent signals: the wire reason, OR the requester
being a `human` on the presence roster. The engine hardcoded
`reason: 'priority'` for every non-admin preemption for most of this
codebase's life, so a client trusting the reason alone mistakes a person for
a colleague agent on any gateway that has not shipped the honest value yet.

### What the takeover costs, in milliseconds

Two windows used to stack, and the sum was the thing people noticed.

| Window | Default | Applies to a person taking over from an agent? |
| --- | --- | --- |
| `minHoldMs` | 3000 | **No.** Lifted for exactly this pairing. |
| `agentPreemptGraceMs` | 2000 | Yes, as a ceiling, not as a wait. |

`minHoldMs` exists so a person mid drag is not yanked out from under
themselves a moment after they got control. An agent has no equivalent claim
on those three seconds: it is not halfway through a gesture it can feel
being interrupted, and it already has a dedicated, shorter window for the
actual handover. So the floor is lifted for one combination only, a `human`
REQUESTER against an `agent` HOLDER (`minHoldSatisfied` in
`packages/core/src/control/policies.ts`, which carries the full table).
Every other pairing keeps it, human over human included.

Lifting the floor grants no new preemption RIGHT. The priority test still
has to pass on its own, so a deployment that has configured an agent above a
human still sees that agent keep the lease. Only the wait is removed, never
the arbitration.

`agentPreemptGraceMs` is a ceiling on how long the agent MAY take, not a
duration anybody waits out. An agent that releases as soon as it is asked
hands over in the time it takes to send one message; one that ignores the
notice waits out the whole ceiling. Which of those you get is currently
decided by the gap described under pattern 3, and this repository's demo
measures **2008ms** because of it.

Whichever way the lease goes away, the agent stops typing immediately rather
than finishing the word: `humanType()` re-checks `hasControl()` before every
single character.

### Asking for it back

A preempted agent is put in a backoff window and `acquireControl()` refuses
inside it, with `POLICY_DENIED` and a `retryAfterMs`. This is the SDK
enforcing the preemption contract rather than trusting the caller. Wait it
out properly:

```ts
await agent.waitForResume();     // resolves when it MAY ask again, and the target is free
await agent.acquireControl();    // asking is still a separate act
```

`agent.yieldStatus(targetId)` is the pull-based half of the same
information, for a caller with nowhere good to put a callback: an MCP tool
handler, a polling loop, an error path deciding whether a failure was a
takeover or a genuine fault.

---

## Pattern 3: agent and person both driving (shared)

**Use it when** they are working the page together rather than taking turns:
pair-driving a booking flow, an agent scrolling a long document while a
person highlights, a demo of collaborative control. Nobody waits, nobody is
evicted, and both writers reach the page.

**How you get it:** one server side setting.

```ts
createBrowserGlass({
  // ...
  session: { control: { mode: 'shared' } },
});
```

Both sides then ask for control the ordinary way and are **both granted,
immediately**. There is no queue: `control.queued` is never emitted for a
shared target, `LeaseState.queue` is always `[]`, and `queuePosition` is
always `null`. `force: true` and `queue: false` are both no-ops against a
shared target, because there is nothing to displace and nothing to queue
behind.

Every holder gets their **own** `leaseId` and their **own** expiry. Renewal,
idle and TTL are all per holder, so one driver failing to renew loses only
their own tenure and the others keep driving.

### The interleaving hazard, stated plainly

**Two writers on one focused input interleave their characters, and an agent
will not notice a person has started typing.**

This is inherent to control without a queue, not a defect waiting to be
fixed. Any lock that prevented it would put back exactly the waiting that
shared mode exists to remove. Type `hello` into a field while an agent types
`world` into the same field and the page receives something like `hweolrllod`.
Both writers are behaving correctly. The field is the shared resource, and
nothing arbitrates it.

What this means in practice:

* **Do not run pattern 3 over a form the agent is filling in.** Shared mode
  is for a page two parties work on in different places: one scrolling, one
  clicking, one reading. It is not for one text field.
* **Tell the person, in the moment.** A person whose keystrokes are coming
  out shuffled will conclude the keyboard is broken long before they
  conclude two writers are typing. Read `LeaseState.holders`, and when there
  is more than one, say so on that pane. The demo does this.
* **An agent cannot detect it.** There is no signal. `humanType()` checks
  whether it still HOLDS control before each character, which catches a
  takeover; it cannot check whether somebody else is also typing, because
  nothing on the wire reports that.
* **If the agent needs the field to itself, use pattern 2.** Exclusive mode
  is the answer to "one writer at a time", and it is the default for that
  reason.

### Taking the agent off a shared target

Shared mode has a dedicated message, because preemption is not available
there: the whole preemption machine is an exclusive mode concept, and
`control.preempt.request`, `control.preempt.cancelled` and
`control.preempted` are never emitted for a shared target.

`control.yield` is what a person sends instead, and from a browser that is
one call:

```ts
const { agentsAsked } = await client.yieldControl(targetId, 'stepping in');
```

It asks the **agent** holders of a target to stand down and leaves every
human holder driving: shared stays shared between people. It is not an admin
act, and it is gated on `control` rather than `admin`, because asking a
robot to stop sharing your tab is an ordinary thing for somebody already
driving that tab to want.

`yieldControl()` decides both of the server's refusals locally and throws,
rather than sending a message it knows will be refused:

* `bgls.error.control.not_shared` when the client positively knows the
  target is exclusive. Only when it KNOWS: a target with no `control.state`
  yet has an unknown mode, and refusing on an unknown would make the button
  fail at random in the window between connecting and the first broadcast.
* `bgls.error.control.not_human` when the token carries `automation`. That
  capability is exactly what makes a viewer `kind: 'agent'` server side, so
  the two checks cannot disagree.

`agentsAsked` is the client's own count of agent holders at the moment it
sent, from its last `control.state` joined to its last `presence.state`. It
is **not an acknowledgement**, and the honest gap is stated below. The
message is sent even when that count is zero: suppressing it on a local
count would let a grant the client has not been told about yet silently
swallow a person's takeover, and a redundant yield costs one frame.

Each notified agent gets `control.yield.request` carrying **its own**
`leaseId`, keeps its lease and its dispatch for `agentPreemptGraceMs`, and is
expected to answer with `control.release`. One that has not released by the
deadline has its tenure ended for it and receives
`control.revoked{reason:'human_takeover'}`.

On the agent side this needs no new code at all: `onControlYield` fires for
it exactly as it does for an exclusive preemption, with `human: true`.

```ts
// Same listener, both patterns.
agent.onControlYield((ev) => {
  if (ev.human) plan.abort(`${ev.byLabel} wants the tab`);
});
```

An agent can also stand down without being asked, when it has decided by
itself that a person should have the browser:

```ts
await agent.yieldControl('handing over: I cannot read this captcha');
```

Unlike a preemption this sets no backoff window. Nobody imposed one, and an
agent that chose to stop is trusted to choose when to start again. It still
has to `acquireControl()` again, though: that call is the only thing that
reopens dispatch.

### Two gaps in this path, stated rather than smoothed over

**The agent is not notified yet, so the handover takes the full grace.**
`@browserglass/automation`'s inbound message switch has no case for
`control.yield.request`; it falls through `default: break`. So an agent
asked to stand down on a shared target is not told, does not release early,
and keeps its lease until the engine ends the tenure at the deadline. The
takeover still happens and the agent does stop, but it stops at
`agentPreemptGraceMs` rather than at once, and it learns about it from
`control.revoked` instead of from the yield.

Measured in this repository's own demo, taking a tab off an agent caught
mid-word: **2008ms**, which is the 2000ms grace plus the round trip. When
that case is added, an agent that already subscribes to `onControlYield`
releases on the notice instead and the number becomes the cost of one
message. Nothing on the calling side changes.

Practical consequence for an agent author today: handle `LEASE_NOT_HELD` as
well as `LEASE_REVOKED`. `humanType()` throws the second when control goes
away mid word; the NEXT action throws the first when the lease went away
between actions, which is what a grace-deadline takeover looks like. An
agent that catches only `LEASE_REVOKED` reports a successful takeover as
`navigate() requires a held ControlLease`, in red.

**A success is answered by silence.** The server's success path for
`control.yield` sends nothing, matching every other control message except
`control.request`. So a yield that reaches a target with no agent driving
looks identical on the wire to a yield that went nowhere.
`ControlYieldResult.agentsAsked` narrows that honestly from the client side
and does not pretend to close it: a local count says nothing about
delivery. Closing it properly needs a `control.yielded` ack from the server.

Both are known gaps and not fixed yet.

---

## Choosing between them

| | Pattern 1 | Pattern 2 | Pattern 3 |
| --- | --- | --- | --- |
| Person can drive | no | yes, one at a time | yes, at the same time |
| `mode` | `'exclusive'` (default) | `'exclusive'` (default) | `'shared'` |
| Person's token | no `control` | `control` | `control` |
| Person waits | n/a | no (`minHoldMs` lifted) | no (granted immediately) |
| Agent is told | n/a | `onControlYield`, `human: true` | `control.yield` (see the gaps below) |
| Person sends | n/a | `requestControl()` | `requestControl()` then `yieldControl()` |
| Interleaving possible | no | no | **yes** |

The honest default for "an agent works, a person supervises" is **pattern
2**, and it is also the SDK's default, so it costs nothing to set up. Reach
for pattern 3 only when you genuinely want two writers on one page at once
and have somewhere to put the warning.

---

## Telling an agent driver from a person, in your UI

The lease record does not carry it. `LeaseHolderState` is `{ viewerId,
label, grantedAt, expiresAt, connected }`: a control record, not a presence
record. The answer lives on the presence roster, as
`ViewerPresence.kind`, and the two have to be joined by `viewerId`.

`@browserglass/react` does that join for you:

```tsx
import { driversOf } from '@browserglass/react';

const drivers = driversOf(leaseState, presence.viewers, targetId, myViewerId);
// each driver: { viewerId, label, colour, isMe, connected, kind }
const anAgentIsDriving = drivers.some((d) => d.kind === 'agent');
```

`Driver.kind` is `'human' | 'agent' | 'service' | 'unknown'`. **`'unknown'`
is not a synonym for `'human'`** and should not be rendered as one. A holder
with no roster entry has two real causes: the fraction of a second between a
grant and the presence rebroadcast, and the synthetic viewer the REST
control path borrows a lease under, which never appears in presence at all.
Render an unknown holder as a plain driver and claim nothing about what it
is.

`useControlLease()` carries the other half. `request()` takes control and
`yieldAgents()` asks the agents to stop; they are deliberately two calls
rather than one, because they are two acts and a caller wants both orders
available. A takeover button usually wants both, in that order, so the
person's claim never depends on the agent agreeing to anything:

```tsx
const lease = useControlLease(client, targetId);
async function takeOver() {
  await lease.request();              // granted on the spot in shared mode
  await lease.yieldAgents('stepping in');
}
```

`<ControlBadge drivers={drivers}/>` uses `kind` in two places. The sentence
counts agents apart from people ("You and 1 agent are driving", not "You and
1 other"), because a person decides whether to type into a page a colleague
is typing into and decides differently when the other writer is software
that will not notice them. And each driver's dot carries
`data-bgls-driver-kind`, which the shipped stylesheet uses to square off an
agent's corners.

Shape, not colour, and that is deliberate: the dot's colour is already
spoken for as that viewer's presence colour, the one their cursor is drawn
in, and recolouring an agent would break the tie between a dot on the badge
and a pointer moving on the canvas. Two circles and a square reads as "two
people and a script" without a legend anywhere on the page.

---

## A working example of all three

`examples/nextjs-demo` runs a real agent against a real browser, with a real
person able to take it over.

```
cd examples/nextjs-demo
npm install
node server.mjs
# open http://localhost:3000/browser and press "Start the agent"
```

The demo is configured `session: { control: { mode: 'shared' } }`, so what
you see by default is pattern 3: the agent holds the middle tab, and you can
click into the same tab and type alongside it. Its own `/agent-lab` page
flags a line whose keystroke rhythm says two writers produced it, which is
the interleaving hazard happening in front of you rather than described.

Press "Take control" and you get the pattern 3 handover: the page calls
`requestControl()` and then `yieldControl()`, both on the wire, and prints
how long the agent took to leave `holders[]`. That number is measured by the
PAGE, off `control.state`, rather than reported by the agent about itself:
what a person cares about is when the robot actually stopped holding the tab
they are now in, and the lease broadcast is the authority on that.

For pattern 2, change one line in `server.mjs`:

```diff
- session: { control: { mode: 'shared' } },
+ session: { control: { mode: 'exclusive' } },
```

Now the same "Take control" button preempts instead: you are queued for
nothing, `minHoldMs` does not apply to you, and the agent receives a real
`control.preempt.request` over the wire.

For pattern 1, drop `'control'` from `DEMO_CAPS` in
`examples/nextjs-demo/lib/bgls.ts`. Every per-pane control button disables
itself, the panes stop taking your input, and you are watching a browser
drive itself with no way to interfere.
