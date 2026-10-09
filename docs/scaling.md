# Scaling BrowserGlass past one node

This is the reference for anyone deploying more than one BrowserGlass
gateway process and expecting them to cooperate. Everything below is read
from the source in this repository or from measurements against real
Chrome, not assumed from a design doc. Where a fact is a measurement, the
setup is described so it can be re-derived if a later change makes it
stale.

## Control path and data path are different things

Every action against an instance goes through `BrowserRouter`
(`packages/router/src/router/BrowserRouter.ts`), but "goes through the
router" does not mean the router proxies every byte a browser produces or
receives. It is split into two paths on purpose.

The control path runs strictly through the router: resolving an instance
to a node and a session, checking it is live and admissible, recording
activity, and emitting audit. `BrowserRouter.driveInstance()` is this
path's single gate, cached per instance and invalidated on release or
restart.

The data path is established through the router and then run direct.
Once `driveInstance()` has resolved an instance and told the caller
whether it is local, a driving surface that already holds its own session
machinery (a `ManagedSession` in `packages/server`'s `SessionRegistry`,
for instance) drives it directly, without a further round trip through
the router for every frame or every input event.

The reason is throughput, not convenience. Input runs at up to 300
events per second per target, and a stream produces frames at roughly
100 per second. A store round trip on every one of those would make the
system dramatically less scalable, which is the opposite of what routing
through a control plane is meant to achieve. So the router authorises and
resolves once, and the session it points at keeps moving bytes without
asking again until something about the instance's lifecycle actually
changes.

This split also shows up in `packages/server/src/wire/rate-limit.ts`'s
own rate limits, which sit on the data path, not the router:

* `input` and `control` are scoped per `(viewer, targetId)`, not once per
  connection, specifically so driving two or three panes hard at once
  cannot starve a fourth.
* `ack` is scoped per stream, 200 per second with a burst of 400
  (`DEFAULT_LIMITS.ackRate`, `packages/protocol/src/wire/limits.ts`).
  Scoped per connection instead, three streams at roughly 100fps each
  would produce roughly 300 acks per second against a 200 per second
  refill, and the 400 token burst drains in about four seconds before one
  stream goes to zero and never recovers.
* `probeFull` is scoped per target, 2 per second with a burst of 4
  (`DEFAULT_LIMITS.probeFullRate`). Scoped per connection instead, three
  panes doing their own hit testing would get 0.67 per second each.
* `nav`, `cursor`, and `capture` stay connection wide: their ceilings are
  already generous relative to how often a caller actually navigates or
  captures.

(`packages/automation/PARALLELISM.md` covers this same rate limit table
from the driving side, for anyone hooking up `BrowserSwarm`.)

## What the router is the authority for

`BrowserRouter` is the authority for four things, and only four things:
resolution (which node and which session an instance lives on),
admission (whether a new instance is allowed to exist at all, and
whether an already-resolved one is still live and drivable), activity
(keeping `Instance.lastActivityAt` current so the idle reaper can tell a
browser somebody is using from one nobody has touched), and audit
(one `instance.acquired` or `instance.drive` event per meaningful thing
that happened to an instance, `BrowserRouter`'s own `audit.emit` calls).

It does not carry CDP traffic, it does not hold a WebSocket connection to
a viewer, and it does not decide what a page is allowed to navigate to.
Those are the driving surface's job, and by design the router has no way
to do them: it depends only on `@browserglass/protocol`
(`BrowserRouter.ts`'s own top comment states this as an architectural
constraint, enforced by `scripts/check-deps.mjs`'s layer gate), so it
cannot even import the CDP or session code that would let it act as a
data-plane proxy.

Before `driveInstance()` existed, this authority was inconsistently
applied. `packages/server/src/rest/routes/targets.ts` used to resolve an
instance by reading `store.getInstance()` directly, bypassing the router
entirely, and its own comment admitted "none of these routes have a
router handle to call `describe()` through". `packages/server/src/session/rest-driver.ts`
resolved a session by scanning `SessionRegistry.all()`, which only ever
holds sessions the current process itself built. Neither of those checked
whether an instance was actually admissible, and neither of them recorded
activity, which is why a REST-only driven instance used to go idle from
the reaper's point of view no matter how hard it was actually being
used. `driveInstance()` is now the one place every driving surface is
meant to resolve an instance through instead.

## How an instance is placed, and how an action reaches it

Placement happens once, in `BrowserRouter.acquire()`'s nine step flow.
Step 7 asks `placementCandidates()` for every node that could host the
requested spec, scores them with a `PlacementPolicy`, and step 8 tries
each candidate in score order, calling `this.nodes.launch(nodeId, req)`
on the winner. `req.nodeId` becomes `Instance.nodeId`, the durable record
of which node owns that instance from then on.

Once an instance exists, a driving surface (REST, CLI, MCP, the CDP
passthrough) resolves it by calling `router.driveInstance(instanceId,
principal)`. That call reads `Instance.nodeId` from the store, compares
it against this router process's own node id, and returns a
`DriveResolution` carrying that node id, the instance's session id, and a
`local` boolean.

* When `local` is `true`, the driving surface uses its own session
  machinery directly (the data path described above): no further router
  involvement for that particular action.
* When `local` is `false`, the driving surface calls
  `router.dispatchAction(instanceId, req, principal)`, which resolves the
  instance again (the same cached call) and then calls
  `this.nodes.dispatch(resolution.nodeId, req)` on the router's injected
  `NodeTransport`. `req` is one of a small, explicit vocabulary
  (`NodeActionRequest` in `packages/protocol/src/domain/extension-points.ts`:
  navigate, screenshot, click, type, target list/create/close, and one
  scoped CDP passthrough), never an arbitrary "run this on another node"
  RPC.

This is the mechanism that used to be missing entirely. Before it, an
instance whose owning node was not the process handling the request had
no path forward at all: the REST/CLI/CDP surface would read a `sessionId`
from the store, fail to find a matching live session in its own process,
and answer 409 with `E_SESSION_NOT_LIVE`, even though the instance was
alive and well on its actual owning node. That is the wall anyone hits
the day they scale past one node, and `dispatchAction()` is what removes
it, by forwarding the action instead of refusing it.

### Step 7's candidate pool is no longer just this process

Originally, step 7 above read `[this.nodeRegistry.snapshot()]` in
`BrowserRouter.doAcquire`: exactly one candidate, this router process's own
in-memory view of itself, no matter how many other gateway processes were
running against the same shared store. `placementCandidates()` and
`ScoredPlacementPolicy.place()` were already written to score MANY
candidates (`PlacementRequest.candidates: readonly NodeSnapshot[]`,
`extension-points.ts`); they were simply being fed one. That, not CDP
(per target CDP sessions were already multiplexed over one socket, and
`driveInstance()` already enforced tenant and scope across gateways), was
the real ceiling on how many concurrent users a deployment could serve:
every `acquire()`, on every gateway process, could only ever land on the
gateway that happened to receive it.

Two things had to exist, and did not, for a wider candidate pool to be
safe rather than merely wider:

1. **A durable node registry other processes can actually read.**
   `store-sqlite`'s schema already had it: a `nodes` table and a
   `node_heartbeats` table, `Store.registerNode`/`getNode`/`listNodes`/
   `setNodeStatus`/`heartbeatNode`/`findStaleNodes`, all present from
   the start. What was missing was a writer: nothing in this
   codebase ever called `setNodeStatus` or `heartbeatNode`, so every
   node's row sat at `status = 'joining'` forever (`registerNode` resets
   it there on every registration, by design, "a node that just started
   has not gone through `setNodeStatus('ready')`/a heartbeat again yet"),
   and `placementCandidates`'s own `n.state !== 'ready'` check correctly
   refused to ever treat one as a candidate. `BrowserRouter.tickHeartbeat`
   (`persistNodeState`, its own new private half) now writes both, on the
   same `heartbeatIntervalMs` tick that already existed for the in-memory
   half, so a node's row genuinely reflects whether it is ready, draining,
   and how loaded it is, from every OTHER gateway's point of view.
2. **`placementCandidates`'s existing feasibility filter, read rather than
   duplicated.** It already excluded a node that is not `'ready'`, whose
   heartbeat is older than `RouterConfig.nodeStaleMs`, or that has no
   memory/disk/launch-concurrency headroom (`packages/router/src/placement/candidates.ts`).
   The only defect that mattered for a REMOTE node specifically was
   `store-sqlite`'s own `rowToNode` (`mappers.ts`) hardcoding
   `NodeLoad.memoryUsedMb`/`profileDiskUsedMb` to `0` regardless of what a
   heartbeat reported (the DDL stores them FREE, `mem_free_mib`/
   `disk_free_mib`; `NodeLoad` wants them USED), which silently defeated
   the memory/disk half of that check for every node read back through
   the store. Fixed as a straight inversion against that node's own
   `capacity`; no schema change, since the columns already existed.
   `launchingInstances`/`warmInstances`/`loadAvg1` have no DDL column at
   all and ride in `node_heartbeats.detail`, the JSON escape hatch
   `NodeHeartbeat.detail?: Json` already provided for exactly this.

`BrowserRouter.doAcquire`'s step 7 now reads
`placementCandidates([this.nodeRegistry.snapshot(), ...(await this.remoteNodeSnapshots())], ...)`.
This process's own candidacy is still always drawn from its own live,
in-memory `NodeRegistry`, never a round trip through its own store write:
reading it back would reintroduce the exact startup race the fix above
closes for OTHER nodes (a freshly registered node reads `'joining'` until
its first heartbeat tick) into this node's OWN candidacy, and a single
node deployment with nothing else registered gets back exactly
`[this.nodeRegistry.snapshot()]`, byte for byte what this line produced
before, which is what makes this change additive rather than a rewrite of
existing behaviour.

Once a REMOTE candidate can win, one more thing had to be true that was
not: `Instance.nodeId`. The nine step flow inserts the instance row
BEFORE placement runs (step 6, "a later failure updates a `failed` row,
never nothing"), stamped with `nodeId: this.nodeRegistry.id()` because at
that point no candidate has been chosen yet. With exactly one candidate
ever possible, that stamp was always coincidentally correct. Step 8's
successful `transitionInstance` call now also patches `nodeId: cand.nodeId`,
correcting it to whichever candidate actually launched the browser. This
is not cosmetic: the idle reaper, `bg.stop()`, and every drive/terminate
call all trust `instances.node_id` to find the instance again, and
`@browserglass/server`'s own orphan sweep (`lifecycle/wiring.ts`'s
`orphanSweepScope`) is scoped to `instance.node_id === ourNodeId`
specifically so it never touches a healthy instance another node owns.
Leaving the pre-placement stamp uncorrected would, the moment a remote
candidate actually won, retire a live browser out from under whichever
node really launched it, or silently exclude a foreign-owned row from
ever being investigated by anyone: exactly the "placement bug that does
not throw, it strands a Chrome nobody will ever reap" failure mode this
whole feature has to be built around avoiding.

The other side of that same danger was `LocalNodeTransport`
(`packages/router/src/node/LocalNodeTransport.ts`), the `NodeTransport`
every embedded, single node build (and, see below, every build today)
constructs. Its `launch()`/`terminate()`/`list()` methods used to accept
ANY `nodeId` argument and always execute against `this.node` (this
process's own runtime) regardless, unlike `dispatch()`, which already
rejected a foreign `nodeId` with `E_NODE_LOST`. Before `remoteNodeSnapshots()`
existed that was harmless: nothing could ever hand `launch()` a `nodeId`
other than this process's own. Once a real remote candidate exists in
`candidates`, a placement decision naming it and a `NodeTransport` that
silently executes every `launch()` locally regardless of `nodeId` is
precisely the stranding failure mode above, so all three methods now
reject a foreign `nodeId` the same way `dispatch()` always did.

### `buildRouterWiring` now dials a peer instead of only accepting one

Cross node placement's read side (`remoteNodeSnapshots`) and its safety
net (`LocalNodeTransport`'s guard) are both real and covered by this
package's own tests
(`packages/router/test/router/cross-node-placement.test.ts`,
`packages/router/test/node/LocalNode.test.ts`'s `foreign nodeId guard`
block). This section used to record a real gap: `@browserglass/server`'s
`buildRouterWiring` (`lifecycle/wiring.ts`) always constructed `nodes: new
LocalNodeTransport(localNode, nodeRegistry, clock)`, unconditionally,
regardless of `peer.*` configuration, so a real two gateway deployment
could ACCEPT a peer connection (`index.ts` wires the peer listener
whenever `peer.sharedSecret` is set) but could never DIAL one: the object
passed to `BrowserRouter`'s own `nodes:` option was the same single
`LocalNodeTransport` either way.

That is fixed. `buildRouterWiring` (`lifecycle/wiring.ts:1170` to `:1222`)
now builds a real `WebSocketNodeTransport` for `nodes:` whenever
`config.peer.sharedSecret` is set (the same gate the peer listener already
uses, so the dial half and the accept half turn on together), with
`resolveEndpoint` reading the target node's `dataPlaneUrl` straight from
the store (a `null` row or an unset `dataPlaneUrl` resolves to `null`,
which the transport turns into `E_NODE_LOST` rather than dialling
`undefined`) and `local` set to the same `LocalNodeTransport` this process
already builds, for the case where placement picks this node itself.
`config.peer.sharedSecret` left unset falls back to the same bare
`LocalNodeTransport` as before: a deployment that never configures peering
stays local only, which is the safe default, not a remaining defect.

With that wired up, a placement decision naming a live peer's node
genuinely reaches it: `this.nodes.launch(peerNodeId, ...)` dials the peer
listener instead of being rejected locally, and the peer listener's
`launch` case (`packages/server/src/ws/peer-upgrade.ts`) executes it
against that node's own `LocalNode`. The `LocalNodeTransport` foreign
`nodeId` guard still applies wherever `WebSocketNodeTransport` is not
wired in (no `peer.sharedSecret` configured), so an unconfigured
deployment still fails a foreign placement decision safely, with
`E_NODE_LOST`, rather than launching on the wrong node.

## The ceilings a real deployment hits

Four independent admission ceilings are checked, in this order, by
`admit()` (`packages/router/src/admission/admit.ts`): the tenant's
`limits.maxInstances`, the app's `limits.maxInstancesPerApp`, the pool's
own `maxInstances` (`Pool.limits.maxInstances`, set at `NewPool.maxInstances`,
default 10 if unset, `packages/store-sqlite/src/store.ts`'s `createPool`),
and the pool's `maxInstancesPerUser`. Whichever is hit first decides what
happens next, governed by the pool's own `onFull` policy: `reject`,
`evictIdle`, or `queue`.

`limits.maxInstances` comes from whatever `QuotaProvider` the deployment
wired up, not from the pool row itself; the two are separate ceilings
that both have to be raised if a deployment wants more concurrent
instances than either currently allows. This repository's own demo pool
sets `limits: { maxInstances: 20 }` (`examples/nextjs-demo/server.mjs:210`);
a real deployment's actual number is whatever its own `QuotaProvider`
returns.

A request that hits a `queue` policy does not hang forever waiting on
nothing: `acquire()` returns `state: 'queued'` and the caller's `ready`
promise resolves once `processQueue()` places it. `processQueue()` itself
is not on its own schedule; it is piggybacked on the reaper's own
interval tick (`BrowserRouter.start()`'s own comment on this: nothing
called `processQueue()` on any schedule before this, so a queued request
used to simply hang). This means a queued acquire's actual wait time is
bounded by how often the reaper tick runs (`config.reaperIntervalMs`),
not by anything faster.

## The cheapest capacity is the browser you already have

Every ceiling above is about admitting NEW instances, so the first
question to ask of a deployment that keeps hitting them is whether it is
launching browsers it already owns. A bare acquire always launches: no
selector means no reuse, on every on-ramp. An app that acquires once per
page load, once per job run, or once per agent turn, without saying who
the browser belongs to, adds a Chrome every time and then runs into
`maxInstances` for reasons that have nothing to do with its real
concurrency.

Reuse is expressed with a subject: `sticky.subject` selects an existing
instance for that owner and `subject` tags the one that gets created, so a
request that wants reuse sends both. One subject resolves to at most one
instance, so a caller that wants N reusable browsers needs N subjects,
derived from one owner name (`BrowserSwarm` does this per member slot).
Reuse is offered rather than guaranteed: `canShare()` still refuses across
tenants, on a not-ready instance, on one expiring within
`shareMinRemainingMs`, on a share-significant spec disagreement, or at the
viewer limit, and acquire then launches instead.

The full model, with a runnable example on each of REST, the CLI,
`BrowserSwarm`, MCP, and the embed widget, is
[`ownership.md`](./ownership.md).

## `isolation: 'window'` is required for more than one live stream per instance

If more than one target belonging to the same instance needs to stream
live video at once, that instance has to be launched with
`BrowserSpec.isolation: 'window'`. Under the default, `'tab'`, Chromium
only composites the window's currently visible tab; every other tab in
that window produces zero screencast frames, not a reduced rate. This
ceiling is per instance, not per target, so it does not matter how many
targets a viewer opens if they all share one window.

The numbers, from a spike against real Chrome with four tabs showing the
same animated canvas:

* Four tabs in one window: `[0, 0, 0, 98.9]` fps. Three of the four are
  completely dead; only the one Chrome had actually focused is live.
* The same four tabs, each given its own OS window: `[81.6, 81.8, 82.4,
  81.0]` fps. All four live, close enough to each other that none is
  starving its siblings.

This was also verified live, not only in the spike: three panes with
`isolation: 'window'`, three distinct `windowId`s, all `active: true`,
all badged LIVE, driven simultaneously (navigation, clicks, drag
selection, typing) with no cross contamination between them, and round
trip time falling from 1223ms to 12ms once the fixes behind this
capability landed.

`packages/automation/PARALLELISM.md` covers this same requirement from
`BrowserSwarm`'s side, including the distinction between `isolation:
'window'` (how many of one instance's own tabs can stream at once) and
swarm size (how many separate `acquire()` calls a swarm makes): they are
different axes, and it is easy to reach for the wrong one.

## Two gateways can now reach each other's instances

The routing gate correctly forwards a driving action to an instance's
real owning node rather than refusing it, and there is now a real,
networked carrier for that forward to travel over: `WebSocketNodeTransport`
(`packages/router/src/node/WebSocketNodeTransport.ts`), the DIAL half, and
`@browserglass/server`'s peer listener (`packages/server/src/ws/peer-upgrade.ts`),
the ACCEPT half. A gateway process dispatching an action against an
instance a different, correctly configured gateway process owns now
genuinely reaches it: the peer listener verifies the connection's `hello`
against the deployment's shared secret, translates the incoming request
into a real call against that node's own `LocalNode` (a `target.list`,
`navigate`, `click`, `type`, `target.create`, `target.close`, or scoped
`cdp` action reaches a real `ManagedSession` via `session/node-action-executor.ts`;
`terminate`/`heartbeat`/`list` reach `LocalNode` directly), and replies
over the same connection. `packages/server/test/cluster/peer-listener.test.ts`
proves this with two real node-side stacks in one process (real HTTP
server, real WebSocket connection, real hello handshake, real fake-Chrome
CDP session on the receiving side) rather than the scripted fake peer
`WebSocketNodeTransport`'s own suite uses.

### What an operator must configure

Every gateway process in the deployment needs, under `peer.*`
(`@browserglass/server`'s `PeerConfig`, `config/types.ts`):

* `peer.sharedSecret`: the SAME value on every gateway. Required for a
  gateway to run a peer listener at all, or to dial another gateway's
  listener. See `nodeAuth.ts`'s own top comment for exactly what this
  protects (an arbitrary network client cannot impersonate a second
  router node) and what it does not (no transport encryption, no per node
  credential, no rotation without a coordinated restart of every node).
* `peer.dataPlaneUrl`: the `ws://`/`wss://` URL OTHER gateways should
  dial to reach THIS gateway's peer listener. A process cannot learn its
  own externally reachable address (a NAT, a load balancer, a container
  network all sit in the way), so this is never inferred; leave it unset
  and this gateway still runs a listener, it simply never advertises an
  address anything else can resolve it at, so nothing can dial it.
* `peer.nodeId`: a stable id, the SAME value across restarts, if this
  gateway is expected to keep owning its already-placed instances after
  a restart. Left unset, a fresh id is minted every start (the pre-existing
  behaviour, unchanged), and a restarted process's instances become
  unreachable under its old id; `Store.registerNode` (`store-sqlite`'s
  `registerNode`, now an upsert on `id`) is what makes a stable configured
  id safe to reuse instead of colliding on the primary key.
* Every gateway must share the SAME durable `Store` (the same underlying
  database): `resolveNode()` reads `Node` rows other gateways registered
  into that one shared store, it has no other way to learn a peer's
  address.
* Transport security is the deployment's own responsibility. Neither the
  peer listener nor `WebSocketNodeTransport` add TLS; a `wss://`
  `dataPlaneUrl` behind a real certificate, or a private network the
  shared secret is the only thing guarding, is the operator's call to
  make, not something this build decides for them.

### What is still not supported

* **Placement candidate selection crosses nodes, and production wiring can
  now dial the winner, once a deployment is actually configured as a
  cluster.** `BrowserRouter.acquire()`'s placement step merges this
  process's own live snapshot with every other live node the shared store
  reports (`remoteNodeSnapshots`/`persistNodeState`, "Step 7's candidate
  pool is no longer just this process" above), and `@browserglass/server`'s
  `buildRouterWiring` (`packages/server/src/lifecycle/wiring.ts:1170` to
  `:1222`) now constructs a real `WebSocketNodeTransport` for `nodes:`
  whenever `config.peer.sharedSecret` is set, rather than always a bare
  `LocalNodeTransport`; see "`buildRouterWiring` now dials a peer instead
  of only accepting one" above for exactly what that wiring does. A
  deployment that never sets `peer.sharedSecret` stays local only, safely:
  `NodeRegistry`'s own top comment (still "the single node registry for an
  embedded, single node build") describes exactly that default case, not a
  ceiling on the router's candidate pool in general any more.
* **`launch` forwarding is real, and now reachable from production wiring
  too, under that same configuration.** `WebSocketNodeTransport.launch()`
  and the peer listener's `launch` case both work, matching the DIAL
  side's own contract, and `BrowserRouter.doAcquire`'s candidate loop
  genuinely calls `NodeTransport.launch(nodeId, ...)` with a foreign
  `nodeId` once `remoteNodeSnapshots` has put one in `candidates` and
  `ScoredPlacementPolicy` has picked it. With `peer.sharedSecret` set, that
  call now actually reaches the peer instead of being rejected; without
  it, `LocalNodeTransport`'s own foreign `nodeId` guard still applies, so
  an unconfigured deployment fails a foreign placement decision safely
  (`E_NODE_LOST`, retryable, falling back to a local candidate) rather
  than launching on the wrong node.
* **A live browser exit notification does not cross the wire.**
  `WebSocketNodeTransport.launch()`'s returned handle's `onUnexpectedExit`
  is a documented no-op for a remote instance (that class's own
  `hydrateLaunchedBrowser` comment): there is no frame kind in this
  minimal protocol for a peer to PUSH an unsolicited "this instance's
  browser just died" notification. Worth knowing before relying on it once
  a deployment has `peer.sharedSecret` configured and `buildRouterWiring`
  is genuinely dialling a peer for a launch.
* **A WS viewer still cannot attach across nodes.** The streaming data
  path deliberately does not go through the router (see "Control path and
  data path are different things", above), so a viewer connecting to a
  gateway that does not own the instance still needs to be told which
  gateway to connect to instead, and nothing builds that redirect today:
  `BrowserRouter.attach()` (`packages/router/src/router/BrowserRouter.ts:1063`
  and `:1925`) always returns a placeholder `attach.wsUrl: ws://local/${nodeId}`,
  never resolved against the owning node's `peer.dataPlaneUrl` the way
  `resolveEndpoint` above resolves one for the control path, and
  `packages/server/src/ws/upgrade.ts` has no redirect logic to act on it
  even if it were.
* **No per node credential, no encryption, no graceful secret rotation.**
  Restated from `nodeAuth.ts`'s own doc because it is easy to miss: every
  node in a deployment that knows `peer.sharedSecret` is fully trusted to
  dispatch to every other node that shares it. That is the whole trust
  model; there is no finer grain than "in the cluster" or "not".
