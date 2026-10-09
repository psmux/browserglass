# The page map: what is on this page, and where

This is the reference for one question: **an agent has never seen this
page. How does it find out what is on it, without guessing selectors from a
screenshot?**

`page.map.get` and `page.map.stamp` are the wire messages behind it,
surfaced as `AutomationClient.pageMap()` / `AutomationClient.stampPageMap()`
in `@browserglass/automation`, and as the `bg_page_map` MCP tool. Everything
below is read from the source in this repository; the file and symbol
behind each claim is named so it can be re-derived when a later change
makes it stale.

This page covers how to call it and what to do with the answer.

## The gap this closes

Before this, BrowserGlass resolved one selector at a time.
`AutomationClient.resolve()` (`packages/automation/src/locator/engine.ts`)
takes a selector you already have and returns its matches. `client.a11y()`
returns accessibility roles and names with no geometry and no occlusion
answer. Neither gives an agent that has never seen the page a way to form
that first selector, or to know whether the button it wants to click is
actually the topmost thing at its own coordinates.

`page.map.get` is the answer: one call, one round trip, an indexed list of
every element the interactivity cascade
(`packages/core/src/pagemap/interactivity.ts`) judged actionable, each with
a tag, a computed role and accessible name, a rect, a tristate occlusion
answer, and a small fixed attribute subset. An agent reads the map once,
picks an index, and either clicks its rect directly or stamps the index
into an ordinary selector.

## Calling it

```ts
import { AutomationClient } from '@browserglass/automation';

const client = await AutomationClient.connect({ endpoint, token });

const map = await client.pageMap();
// map.epoch:  this capture's index space, mint id
// map.nodes:  PageMapNode[]: tag, role, name, rect, occluded, attributes
// map.total:  candidates before truncation
// map.truncated / map.truncatedByReason
// map.degraded: per-frame accessibility read failures, and the listener signal's own status
```

`pageMap()` needs the `devtools` capability, not `evaluate`
(`AutomationClient.pageMap`, `packages/automation/src/client/AutomationClient.ts`).
Every CDP command behind the capture, `DOMSnapshot.captureSnapshot`,
`DOM.getDocument`, `Page.getFrameTree`, `Accessibility.getFullAXTree`, and
`DOMDebugger.getEventListeners`, is a domain read. None of them runs page
script, so a page map costs nothing on the `evaluate` budget and needs
nothing granted beyond what reading a target's structure already requires.

Over MCP, the same capture is `bg_page_map` with `action: "capture"`
(the default). The tool's own manifest description in
`packages/automation/src/mcp/server.ts` is written to be read by the model
calling it, and it states the occlusion tristate, the truncation reasons
and the listener signal's limit inline, not only in this document.

```jsonc
{ "name": "bg_page_map", "arguments": { "targetId": "tgt_abc123" } }
```

### `include: ['nodes', 'text']`

`page.map.get`'s `include` field defaults to `['nodes']`. Add `'text'` to
also get headings, paragraphs, list items and link text
(`packages/core/src/pagemap/text.ts`) in the same round trip, sharing the
one `DOM.getDocument` walk rather than paying for a second capture:

```ts
const map = await client.pageMap({ include: ['nodes', 'text'] });
map.text; // PageMapTextBlock[]: heading/paragraph/listItem/link, in document order
```

Asking for `['text']` alone skips the snapshot, the per-frame accessibility
reads, the listener signal and most of the merge and occlusion work, so it
is the cheap option when an agent only wants to read the page rather than
act on it. A table's cells come back as plain text blocks in document
order, not reassembled into a markdown table, in this version.

## What an index and an epoch mean

**The index is Chrome's own `backendNodeId`**
(`PageMapNode.index`, `packages/protocol/src/wire/messages/pagemap.ts`),
falling back to a synthetic id above every reserved backend id on the rare
collision. It costs no DOM mutation to assign, unlike the locator engine's
`data-bgls-ref` stamp, and it is already public on this wire as
`A11yNode.backendNodeId`.

It is exact within one capture, and stable across a capture-then-act step
if the node survives. It is **not** stable across a navigation: a new
document reuses the id space, so a raw `backendNodeId` used after a
navigation does not fail, it silently names a different element. That is
what the epoch is for.

**The epoch is minted per capture**, from the CDP session id and the main
frame's `loaderId` (`PageMapGot.epoch`). Every call that acts on an index,
today only `page.map.stamp`, must echo it back. A mismatch is refused with
`bgls.error.pagemap.stale_epoch` before any CDP command goes out. This is
strictly better than the locator engine's own `ref`, whose documented
limitation is that staleness is only ever discovered on use
(`LocatorMatch.ref`, `packages/automation/src/locator/types.ts`): an epoch
mismatch is caught **before** the action, which is the difference between
"the click failed" and "the click landed on something else."

The epoch does not cover a same-document re-render. A React re-render that
replaces a subtree without navigating keeps the `loaderId` and kills the
backend node ids underneath it. That case is not caught up front; it fails
per index instead, at stamp time, reported in `StampPageMapResult.results`
rather than losing the whole batch over one detached element.

## How to act on an index

There is no index-addressed input message, and there will not be one. The
locator engine's own `LocatorRuntime` doc
(`packages/automation/src/locator/engine.ts`) makes the argument: a second
way into `InputDispatcher` would throw away the one thing this surface has
that a Playwright port cannot, the shared control model, meaning the lease,
the generation stamp, and the fencing every other click already goes
through. So acting on an index is two calls, not one:

```ts
const map = await client.pageMap();
const target = map.nodes!.find((n) => n.name === 'Submit');

const stamped = await client.stampPageMap(map.epoch, [target!.index]);
// stamped.marker: the DOM attribute name every succeeded index was stamped with, or null

await client.click(`css=[${stamped.marker}]`);
```

`stampPageMap()` calls `stampAccessibilityNodes`
(`packages/core/src/cdp/accessibility.ts`), the exact function `role=`
locator stamping already uses, with different arguments: a one-off marker
attribute written through `DOM.setAttributeValue`, no script, no object id.
The caller then addresses it through the ordinary `resolve()`/`click()`
path, so the actual click goes through the same lease and the same fencing
a person's click does.

Over MCP this is `bg_page_map` with `action: "stamp"`, `epoch` and
`indices` both required, followed by `bg_resolve` or `bg_click` against
`css=[<marker>]`.

## The three occlusion states, and why the middle one exists

`PageMapNode.occluded` is `boolean | null`, and the null case is the one
worth understanding before acting on this data at all.

* **`false`** (rendered with no marker): the paint-order occlusion pass
  (`packages/core/src/pagemap/occlusion.ts`) actually checked this node's
  rect against everything painted above it, in document space, and found
  it clear.
* **`true`** (rendered `|occluded|`): the pass checked and found the rect
  fully covered by something on top of it.
* **`null`** (rendered `|occlusion?|`): the pass **did not answer**. Three
  cases produce it: the node has no rect, the node never reaches the
  viewport, or the node was tested after the disjoint-rectangle union the
  pass builds had already hit its own cap. Past that cap the pass answers
  null rather than guessing, because a wrong `false` there would hide an
  element that is actually clickable.

**`null` means the pass could not answer. It never means the element is
clickable.** An agent that reads `occluded == null` as "not occluded, so
safe to click" and collapses it into the same bucket as `false` will click
through a modal, a cookie banner, or an overlay the occlusion pass simply
never got to test. This is the specific reason the field is tristate on
the wire rather than a plain boolean:
`packages/core/src/pagemap/occlusion.ts` and the wire doc in
`packages/protocol/src/wire/messages/pagemap.ts` both state it as the
whole point of the design. `formatPageMapNodes()`
(`packages/automation/src/mcp/format.ts`) renders the three states as three
distinct markers on every line for the same reason: an agent reading the
tool result in prose sees `|occluded|`, `|occlusion?|`, or nothing, never a
collapsed "probably fine."

## Truncation, reported by reason

`page.map.got` reports `truncated`, the real `total`, and a count broken
down by `truncatedByReason`
(`PageMapTruncationReason`, `packages/protocol/src/wire/messages/pagemap.ts`):

* **`offscreen`**: outside the viewport at capture time, the lowest
  priority tier. Scrolling and re-capturing is likely to surface it.
* **`onscreen`**: dropped even though it was in the viewport, meaning the
  byte budget (`MAX_PAGEMAP_RESULT_BYTES`, double `page.a11y.get`'s own
  cap) was spent on visible content alone. Scrolling will not help.
* **`unpositioned`**: the cascade judged the node actionable but the
  capture never resolved it a rect, so there is nowhere to click. This is
  not a budget decision, and re-capturing will not change it. A shadow DOM
  form control the snapshot passes over is the main real-world case; a node
  inside a cross-origin iframe is not, any more, now that both the layout
  and the enumeration gaps in Gaps below are closed.

An agent told only "truncated" cannot decide whether to scroll or give up.
An agent told the reason can.

## Accessibility degradation, and the `role=? "?"` line

A per-frame `Accessibility.getFullAXTree` failure degrades that one frame
only: its nodes keep their `tag`, `rect` and `attributes`, and lose `role`
and `name` to `null`. This is reported in `PageMapGot.degraded`
(`framesAttempted`, `framesFailed`, `failures`) even when the reply
otherwise looks complete, and `formatPageMapNodes()` renders a degraded
node as `role=? "?"` rather than omitting it or guessing. A `null` role
here means one specific thing: this node's frame's accessibility read
failed, never that the node genuinely has no role. A control that really
has no accessible name still renders `role=generic ""`, a real empty
string, not `?`.

## The listener signal: what it proves and what it does not

`listeners: true` is the default on `page.map.get`. It adds
`DOMDebugger.getEventListeners` to the interactivity cascade, catching an
element whose only actionability signal is a JavaScript click handler with
no ARIA role, no `tabindex`, and no pointer cursor
(`packages/core/src/pagemap/listeners.ts`).

**What was measured, not assumed.** All of the following came from
a measurement script run against a real, directly launched Chrome (`Chrome/152.0.7977.64`, headless) over a
hand-rolled raw CDP client, printing a PASS/FAIL table: 20 of 20 checks
passed, twice in a row.

* **It runs no page script.** The whole sequence is
  `DOM.getDocument({depth: 0})`, `DOM.resolveNode`,
  `DOMDebugger.getEventListeners({depth: -1, pierce: true})`, then
  `Runtime.releaseObject` in a `finally`. None of the three CDP methods
  emits a page-visible side effect: the probe's own negative control, a
  page script patching `addEventListener`/`removeEventListener` and
  attaching a `MutationObserver` before the sequence runs, recorded zero
  calls and zero mutation records afterward.
* **It emits zero `DOM.*` and zero `Runtime.*` events.** `DOMDebugger` has
  no `enable` method at all (Chrome answers `-32601` if you try), and
  `Runtime.releaseObject` was checked independently and enables nothing
  either: five object ids minted via `DOM.resolveNode` and released with
  `Runtime.enable` never sent produced zero `Runtime.executionContextCreated`
  and zero `Runtime.consoleAPICalled` events, against a positive control on
  the same session that did move those counters once `Runtime.enable` was
  actually sent.
* **It crosses closed shadow roots.** `pierce: true` found a button inside
  a closed shadow root, whose reference lives nowhere page script can reach
  it, as reliably as one inside an open shadow root. A page's own
  `querySelectorAll`, by contrast, does not enter a shadow root at all.
* **`backendNodeId` comes back populated and correct.** Every listener
  record in the probe's fixture carried a numeric `backendNodeId`, and each
  one was independently resolved back through `DOM.describeNode` to confirm
  it named the right element, not merely a non-null value.

**The real limit, stated plainly.** `DOMDebugger.getEventListeners` reports
a listener on the element it is attached **to**. A framework that delegates
event handling to one ancestor, which is exactly what React 17 and later do
by default, attaches a single delegated listener at the root container, not
one per interactive element. The probe reproduced this directly: a
container with one delegated `click` listener and a child inside it with no
listener of its own resolved the listener to the container's
`backendNodeId`, never the child's. So on a modern React page this signal
is close to blind. A delegated child is indexed only when it carries some
other signal, an ARIA role, a `tabindex`, or a pointer cursor from the
computed-style read the cascade already does. This is not a defect to work
around; it is the honest shape of what the signal can see, and
`degraded.listeners !== 'ok'` (skipped, or failed) is the field that says
whether the signal ran at all versus ran and simply found nothing.

## Gaps

Stated in the present tense, so nobody has to discover them by surprise.

**Out-of-process iframe content now has real layout, and is now actually
enumerated.** This closed in two steps, and the second one mattered more
than the first. Step one: `DOMSnapshot.captureSnapshot` used to run only on
the main session, so a cross-origin iframe's nodes always carried
`rect: null` and were dropped as `unpositioned`; `snapshot.ts` now runs
once per out-of-process session too, paired with that session's own DOM
read, and every rect is composed into top-document space using the
additive offsets `frames.ts` already computes
(`PageMapFrame.offsetX`/`offsetY`). Step two, found while measuring the
first one: the PARENT session's own `Page.getFrameTree` never lists an
out-of-process child in `childFrames` at all, on every run measured
against real Chrome, not as an empty
entry, simply absent. `frames.ts`'s `flattenFrameTree()` walks exactly
that field, so before this was fixed an out-of-process frame was never
enumerated in the first place, and step one's layout work had no frame to
place. `captureFrameTree()` now recovers the missing subtree from the
child's own side: an out-of-process frame's own session answers
`Page.getFrameTree` with a root carrying `parentId`, naming the frame that
owns it, so one call per registered out-of-process session splices the
subtree back into the flattened list, to a fixpoint (an out-of-process
frame can itself contain another one), bounded by the same
`PAGE_MAP_MAX_FRAME_DEPTH`/`PAGE_MAP_MAX_FRAME_COUNT` caps the main
flatten already enforces. A frame whose own tree cannot be read, or whose
parent was never enumerated, degrades that one frame and is named in
`CaptureFrameTreeOutcome.failures` rather than vanishing silently.

The remaining scroll caveat closed too. `frames.ts`'s `scrollOffsetKnown`
used to default to `false` for any frame nested inside an out-of-process
parent, because that parent's own `Page.getLayoutMetrics` scroll read was
unmeasured. It is now measured trustworthy (a genuine cross-origin
fixture, `window.scrollTo` inside the child's own context, three
independent readings agreeing exactly on every run) and the code loosened
to match: nothing in the placed-frame path sets the flag `false` for a
frame that actually reaches `page.map.got` any more, so a node from a
nested out-of-process frame is trusted the same way a same-process node
is. `PageMapNodeRecord`/`PageMapNode` still carry no per-node "position
confidence" field a caller could branch on regardless, which was true
before this fix and stays true after it.

A second, related gap closed in the same change: `backendNodeId` is unique
only within the CDP session that minted it (confirmed by reading
Chromium's own id counter, `third_party/blink/renderer/core/dom/dom_node_ids.cc`,
not merely assumed), so merging more than one session's nodes into one
flat map, the ordinary case now for any page with a cross-origin iframe,
used to risk one session's node silently overwriting another's under the
same numeric id. A second session reporting an id another session already
claimed is now dropped rather than overwritten, first writer wins, and
reported as a `PageMapPhaseFailure` naming both sessions and the colliding
id; `ax-merge.ts`'s own independent join by `backendNodeId` is guarded the
same way, so a losing session's role and name cannot clobber the winning
node's either.

**`proxyAuthPerInstance` is now `true`.** The CDP layer that answers a
proxy's auth challenge (`Fetch.enable` with `handleAuthRequests`,
`Fetch.continueWithAuth`) was real and tested on `runtime-host` before this
paragraph was first written; what closed since is the wiring that feeds
it. `BrowserSpec.proxy.username`/`.password` now reach
`createTargetRegistry`'s `proxyAuthCredentials` argument at both call
sites in `packages/server/src/session/factory.ts` (the fresh attach and
the restart), through `resolveProxyAuthCredentials`, which treats a
half-configured proxy (one of username/password set, not both) the same
as no proxy at all rather than sending a partial credential. The password
reaches exactly one CDP call, `Fetch.continueWithAuth`, and
`packages/server/test/session/factory-proxy-auth.test.ts` drives a real
`Fetch.authRequired` challenge and asserts it, proving it appears nowhere
else: no other CDP call, no log line. `runtime-host/src/runtime.ts`'s own
`capabilities()` now reports `proxyAuthPerInstance: true` and its `notes`
say where the wiring lives instead of what is missing, matching
`runtime-remote`, `runtime-docker` and `runtime-k8s`, which already
reported `true`.

**The frame recorder is drivable at the wire protocol level; starting one
still needs a raw socket.** `FrameRecorder`
(`packages/core/src/recording/frame-recorder.ts`) is a real, working
`synthetic` attachment that receives encoded frames through the same
fan-out a live viewer uses, and `recording.start`/`.stop`/`.list`
(`packages/protocol/src/wire/messages/recording.ts`) are real, handled
wire messages, gated on `capture` AND `download` together. See
[`docs/recording.md`](recording.md) for the full account, including why
those two capabilities are both required and what "no video muxing"
means. `bgls record list` and `bgls record export` (`packages/cli/src
/commands/record.ts`) can read a finished recording back off disk, verified
by actually running them while writing this page; `bgls record replay` is
deliberately left an honest stub, since playing frames back on a timeline
needs a decoding viewer this CLI does not have. What stays open: no
`AutomationClient` method, no MCP tool, and no `bgls record start`/`stop`
either, so driving a recording (as opposed to reading one back afterward)
still means sending the three wire messages over a raw `bgls.v1` socket.

**`bgls attach` now composes local Chrome discovery with a real attach;
the permission choreography it stops short of is still not built.**
`discoverLocalBrowser()`
(`packages/runtime-host/src/local-browser-discovery.ts`) finds a Chrome
the user already has open, distinguishes "nothing running" from "running
with remote debugging off" from "reachable but waiting on the
per-session Allow popup" (`LocalBrowserPermissionBlockedError`), and hands
back something actionable; `packages/cli/src/commands/attach.ts` is the
CLI command that composes it with a real `HostRuntime.attach()` call
(`discovery.candidate.wsUrl` becomes `endpoint.url`,
`discovery.candidate.userDataDir` becomes `recovered.profilePath`) and
then immediately detaches again, so the human's browser is left exactly as
found. `--list` scans every candidate profile and reports each one's
status without attaching to anything. It still does not open
`chrome://inspect` or click Chrome's own "Allow remote debugging" popup
for the user the way browser-harness's `daemon.py` does; that choreography
is deliberately not built, and every attached result says so in plain
prose (`ATTACH_LIMITATIONS` in `attach.ts`): no control over channel,
headless mode, launch args, profile, extensions, or proxy, because the
browser was already running and those were somebody else's choices.

**No recall number exists for the interactivity cascade or the listener
signal.** There is no measurement in this repository of how many
actionable elements a page map finds versus how many exist on a fixed set
of real pages. Every claim above about what the signal catches is a claim
about mechanism, verified against a controlled fixture; it is not a claim
about outcome on an arbitrary page.
