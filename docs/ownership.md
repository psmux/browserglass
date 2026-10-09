# Who owns a browser: reusing your instances instead of launching new ones

This is the reference for one question: **when I ask BrowserGlass for a
browser, do I get a brand new one, or the one I had last time?**

The short answer is that a bare acquire always launches a new browser. If
you want the one you had before, you have to say so, and this page is what
you say on each on-ramp. Everything below is read from the source in this
repository; the file and symbol behind each claim is named so it can be
re-derived when a later change makes it stale.

## The default, stated plainly

`POST /v1/instances` with no selector launches a new browser every time.
So does `pnpm bgls instances create` with no flags,
`BrowserSwarm.open({ size })` with no subject, and `bg_swarm_open` with no
subject. Nothing in the acquire path adopts a running browser on its own.

That default is deliberate rather than an oversight. Two unrelated runs of
the same script, or two unrelated users of the same app, must not silently
land on each other's browsers, and an acquire that adopted whatever
happened to be running would be a far worse surprise than one that costs a
few seconds of launch time.

There is one exception that is not really an exception: `requestId`.
`BrowserRouter.acquire()` runs every request through an idempotency table
keyed by `(tenant, app, requestId)` with a 300 second window
(`packages/router/src/router/config.ts`, `idempotencyWindowMs: 300_000`),
so repeating the exact same `requestId` inside that window returns the
identical result. That is a retry-safety mechanism, not an ownership one.
It expires, it is keyed to a request rather than to a person or a job, and
building "give me my browser back" on top of it is how a demo in this very
repository ended up opening a fresh set of three Chrome windows on every
page load.

## The one concept: a subject

Ownership is expressed by a **subject**: an opaque string naming who a
browser belongs to. A user id, a tenant id, an email address, a job name,
a workspace id. BrowserGlass never interprets it; it only compares it.

Two fields carry it, and a request that wants reuse needs **both**:

* `sticky.subject` is the **selector**. It is what makes the router look
  for an existing instance whose subject matches, rather than launching
  one (`packages/router/src/router/reuse.ts`, `findReusable` step 2).
* `subject` is the **tag**. `BrowserRouter.doAcquire` stores it on the
  instance it creates, falling back to the calling token's own `sub` when
  it is absent.

Send the selector without the tag and the first call launches a browser
filed under your gateway token's subject, which the second call then does
not find. You get a 201 and a working browser every time, and the feature
silently does nothing. This is the single easiest way to get affinity
wrong, which is why every helper in this repository that builds an acquire
request sets both from one input (`buildAcquireRequest` in
`packages/cli/src/util/drive.ts`), and why `POST /v1/instances` now
rejects a malformed `sticky` with a 400 rather than quietly launching.

The same concept appears under a different spelling on each on-ramp, and
it is the same field underneath in every case:

| On-ramp | How you say it |
| --- | --- |
| REST | `sticky.subject` plus `subject` in the `POST /v1/instances` body |
| CLI | `--sticky-subject` (sets both fields for you) |
| `BrowserSwarm` | `BrowserSwarmOptions.subject` |
| MCP | `bg_swarm_open`'s `subject` argument |
| `<browser-glass>` embed | Nothing: the widget attaches, it never acquires. Your backend passes `sticky.subject` on the acquire it already does. See below. |

## Reuse is offered, not guaranteed

A matching subject makes an instance a *candidate*. `canShare()`
(`packages/router/src/router/reuse.ts`) then decides, and it refuses in
five cases: the instance belongs to another tenant; it is not `ready` or
`degraded`; it expires within `shareMinRemainingMs` (default 60000, so a
browser with under a minute left is deliberately not handed out); it
belongs to another app with no share grant; its browser spec disagrees
with the request on a share-significant field (channel, headless, proxy
server, user agent, locale, timezone, stealth, and a few more); or it is
already at its viewer limit.

When it refuses, acquire launches a fresh browser rather than failing.
So the honest promise is "reuse when it is safe to, launch otherwise",
and a caller that needs to know which one it got should read `reused` and
`reuseReason` on the acquire result. `reuseReason: 'sticky'` is the one
this page is about.

Keep two consequences in mind. A browser near the end of its TTL will not
be reattached to, so a long-lived subject sees an occasional relaunch;
that is correct behaviour, not flakiness. And a request that changes a
share-significant field (asking for headless when the running instance is
headful, say) will not reuse, because a running browser cannot change
those retroactively for everyone already attached to it.

## One subject means one browser

`findReusable`'s sticky branch resolves a subject to at most **one**
instance, the most recently active one that is still shareable. This is
the single most important thing to know before using a subject with more
than one browser.

Hand the same subject to twenty concurrent acquires and you do not get
twenty reattached browsers. Each call runs its own reuse check against
whatever is visible at that moment, so they converge, nondeterministically,
onto a handful. A swarm asked for twenty comes back holding twenty clients
pointed at fewer browsers than that, and the failure is quiet: every call
returned 201 and every client works.

The rule that falls out of this: **one subject per browser you want to
own.** For a set of N, derive N subjects from one name. `BrowserSwarm`
does exactly that for you, `<subject>#<index>`, one per member slot, which
is why `BrowserSwarmOptions.subject` takes the owner's name rather than
the per-browser value. `swarmMemberSubject(subject, index)` is exported so
you can reproduce a slot's subject from outside the swarm, for a release
call or for a second process deliberately addressing the same set.

## Sharing on purpose

The mechanism that makes two callers collide by accident is the same one
that makes them collaborate on purpose. Two processes, two browser tabs,
or two agents that pass the *same* subject get the *same* browser. Two
that pass *different* subjects stay isolated. That is the whole model.

A per-user app therefore derives the subject from the signed-in user
(`user:42`), and a shared workspace derives it from the workspace
(`workspace:acme`), and switching between the two is a change of value,
not a change of mechanism.

## Releasing a shared browser

Once a subject hands one instance to more than one viewer, a release is no
longer guaranteed to end the browser. `BrowserRouter.release()` returns a
`ReleaseResult` with `outcome: 'terminated' | 'detached' |
'already_released'` and terminates only when the caller is the last viewer
out, unless `force: true` is passed. `DELETE /v1/instances/:id` reports
that result, accepts `?force=true`, and `pnpm bgls instances release` prints
which of the three happened and takes `--force`.

One caveat, true at the time of writing: `LiveViewerPort` is not wired up
in `@browserglass/server` yet, so the router's viewer count reads a
constant zero and every release through a stock gateway terminates. The
`detached` outcome is part of the contract and is reported correctly; it
just cannot occur yet. Do not build a deployment on the assumption that
another viewer's presence will protect a browser from your release today.

## By on-ramp

### REST

The acquire body is forwarded to the router as-is. A malformed `sticky` is
rejected with `400 E_INVALID_BODY` rather than launching a browser and
reporting success.

```bash
# First call: nothing exists for this subject, so a browser launches.
# Second call, minutes later: the same browser comes back, reused true.
curl -sS -X POST "$GATEWAY/v1/instances" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "pool": "default",
        "profile": { "mode": "ephemeral" },
        "sticky": { "subject": "user:42", "withinMs": 900000 },
        "subject": "user:42"
      }' | jq '{instanceId, reused, reuseReason, targets}'
```

`withinMs` is optional and bounds how stale the browser may be: with it,
an instance whose last activity is older than the window is skipped and a
fresh one launches.

To find out what a subject already owns without acquiring anything:

```bash
curl -sS "$GATEWAY/v1/instances?subject=user:42" \
  -H "authorization: Bearer $TOKEN" | jq '.items[].instance.id'
```

An ephemeral profile alongside `sticky` is legal and is the common case: a
throwaway browser that is nonetheless the same throwaway browser as last
time. A **persistent** profile key alongside `sticky` is rejected with
`E_CONFLICTING_SELECTORS`, because a profile key already names which
instance is wanted and two selectors would be ambiguous.

### CLI

```bash
# Same browser back on every run of this script, launching only the first time.
pnpm bgls instances create --sticky-subject user:42 --sticky-within-ms 900000

# What does that subject own right now?
pnpm bgls instances list --subject user:42 --json | jq '.items[].instance.id'

# Release it. Prints "detached" instead of "released" when other viewers remain.
pnpm bgls instances release "$INSTANCE_ID"
pnpm bgls instances release "$INSTANCE_ID" --force   # end it regardless
```

`--sticky-subject` sets both request fields for you. Omit it and every run
launches a new browser.

### A swarm of N, from the CLI

```bash
# Run this once: 5 browsers launch. Run it again tomorrow: the same 5 come back.
pnpm bgls swarm run --size 5 --sticky-subject nightly-crawler \
  --action navigate --value https://example.com
```

Each member acquires under `nightly-crawler#0` through
`nightly-crawler#4`, so member 3 reattaches to member 3's browser rather
than all five racing for one. Note that `--sticky-subject` also flips the
teardown default: without a subject the command releases every instance it
acquired, and with one it keeps them, because releasing browsers you just
claimed ownership of would make the next run relaunch them. Pass
`--no-keep` to release anyway.

### `BrowserSwarm`

```ts
import { BrowserSwarm } from '@browserglass/automation';

const swarm = await BrowserSwarm.open({
  size: 5,
  subject: 'nightly-crawler',   // omit this and all 5 launch fresh, every run
  stickyWithinMs: 900_000,
  async acquire(index, ctx) {
    // ctx.subject is 'nightly-crawler#<index>', already derived per slot.
    // Put it on BOTH fields, or the reuse silently never happens.
    const res = await fetch(`${gateway}/v1/instances`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: `crawler-${Date.now()}-${index}`,
        profile: { mode: 'ephemeral' },
        ...(ctx.subject === undefined
          ? {}
          : { subject: ctx.subject, sticky: { subject: ctx.subject, withinMs: ctx.stickyWithinMs } }),
      }),
    });
    const { instanceId } = await res.json();
    return { instanceId, wsUrl, token: await mintToken(instanceId) };
  },
});

await swarm.all((m) => m.client.navigate('https://example.com'));
await swarm.close();   // closes connections; your own release is separate
```

`swarm.subject` and `member.subject` report what the swarm actually
acquired under, so a caller can assert on it rather than assume.

### MCP

```jsonc
// Opens 3 browsers the first time, reattaches to the same 3 afterwards.
{ "name": "bg_swarm_open", "arguments": { "size": 3, "subject": "agent-alpha" } }
```

The result names which of the two behaviours you got, in prose, because an
agent cannot tell from the instance ids alone:

```
Opened swarm swarm_1 with 3 member(s), owned by "agent-alpha", so the same
subject reattaches to these same browsers next time.
```

Omit `subject` and it says `owned by no one, gone after bg_swarm_close`
instead. `bg_swarm_grow` inherits the swarm's subject, so growing an owned
set does not start mixing in unowned browsers; there is nothing extra to
pass. `bg_swarm_list` reports each swarm's subject and each member's slot
subject.

This works only if the MCP server was constructed with a `swarm.acquire`
that honours `ctx.subject`. An `acquire` that ignores it accepts the
argument and does nothing with it. See
`AutomationMcpServerOptions.swarm.acquire`.

### The `<browser-glass>` embed widget

The widget takes `url`, `token`, and `target-id`, attaches to a target
that already exists, and never acquires anything. There is no attribute
that could make it reattach, and adding one would be inventing a second
mechanism for something the widget does not do.

Affinity for an embed therefore lives one layer up, in the backend that
already mints the widget's token. That backend passes `sticky.subject`
on the acquire it already performs, and the widget follows:

```js
// Your backend, per page load. Same user, same browser, no new Chrome.
const acquired = await fetch(`${GATEWAY}/v1/instances`, {
  method: 'POST',
  headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    profile: { mode: 'ephemeral' },
    subject: `user:${session.userId}`,
    sticky: { subject: `user:${session.userId}`, withinMs: 900_000 },
  }),
}).then((r) => r.json());

// acquired.targets carries the tabs that instance already has open, which
// is where the widget's target-id comes from on a REATTACH. On a fresh
// launch there is normally one about:blank tab.
const targetId = acquired.targets[0].targetId;
const token = await mintViewerToken(acquired.instanceId);
```

```html
<browser-glass url="wss://gateway.example.com/browserglass/socket"
               token="..." target-id="tgt_..."></browser-glass>
```

Two browser tabs of the same signed-in user, rendering that same page,
both resolve to the same instance and the same running browser. Note that
two `<browser-glass>` elements pointed at one target cannot both paint at
once, by design: the second is queued and told so. See
`packages/embed/README.md`'s "Multiple widgets on one page".

## Checklist for getting this right

1. Pick a subject that names an **owner**, not a run. `user:42` and
   `nightly-crawler` are subjects. A timestamp or a fresh uuid is not; it
   is the default behaviour with extra steps.
2. Set **both** `subject` and `sticky.subject`, or use a helper that does.
3. For N browsers, use N subjects. Let `BrowserSwarm` derive them, or
   derive them the same way it does.
4. Read `reused` and `reuseReason` if you need to know which you got.
5. Do not release a browser you intend to have back, and do not assume
   somebody else's viewer will stop your release today.
