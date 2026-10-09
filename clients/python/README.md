# `browserglass` (Python)

A Python SDK for BrowserGlass: drive a browser over the `bgls.v1` protocol,
the same wire a human's viewer and the TypeScript `@browserglass/automation`
package speak. Your agent's browsers go through the router instead of your
process spawning and owning Chrome, and a person can watch or take over a
live run at any point without your code doing anything special to allow it.

This package has no dependency on Playwright, Selenium, or any other
browser driver. It never launches a browser process itself; it only ever
speaks the wire protocol to a gateway that already has one running.

Ported from `packages/automation` (the TypeScript SDK) in this monorepo.
Method names are `snake_case`, every call is `async`/`await`, and every
public method is type hinted. A Python developer should not be able to
tell the server on the other end is written in TypeScript: wire fields are
camelCase on the socket and snake_case here, and every failure raises a
typed `AutomationError` carrying one of a closed set of codes rather than
a bare `Exception`.

## Install

```sh
pip install -e clients/python          # from this monorepo, editable
# or, once published:
pip install browserglass
```

Requires Python 3.10+. Runtime dependencies: `websockets` (the `bgls.v1`
socket) and `httpx` (the REST acquire/release calls). Dev dependencies
(`pip install -e "clients/python[dev]"`): `pytest`, `pytest-asyncio`.

## Quickstart

```python
import asyncio

from browserglass import AutomationClient, RestClient
from browserglass.types import UploadFileInput


async def main() -> None:
    # 1. Get a running browser instance without ever spawning Chrome
    #    yourself. `RestClient` authenticates with an App-level bearer
    #    token; `acquire()` launches one if nothing matches, or reuses a
    #    warm one.
    async with RestClient(base_url="https://gateway.example", token=APP_TOKEN) as rest:
        acquired = await rest.acquire(browser={"headless": True})

        # 2. Open the bgls.v1 socket. This is a SEPARATE, narrower
        #    credential from the REST token above: `acquired.attach.ticket`
        #    is scoped to this one instance and expires quickly.
        client = await AutomationClient.connect(
            endpoint=acquired.attach.ws_url,
            token=acquired.attach.ticket,
        )
        try:
            # 3. Ask for the control lease before driving anything. Every
            #    interaction method needs one, exactly like a human
            #    competing for the same target.
            lease = await client.acquire_control()
            try:
                await client.navigate("https://example.com/contact")
                await client.fill("#email", "ada@example.com")
                await client.fill("#full-name", "Ada Lovelace")

                # Attach a file: bytes and a name, never a path (the
                # caller's filesystem is not the browser's).
                with open("report.pdf", "rb") as f:
                    data = f.read()
                await client.set_input_files(
                    "#attachment", UploadFileInput(name="report.pdf", data=data)
                )

                await client.click(
                    "#submit",
                    verify="document.querySelector('.confirmation') !== null",
                )

                title = await client.evaluate("document.title")
                print("done:", title)
            finally:
                await lease.release()
        finally:
            await client.close()

        await rest.release(acquired.instance_id)


asyncio.run(main())
```

## When a human takes the browser back

An agent driving a browser a person can also see is the reason this
protocol exists, and the interesting moment is the one where the person
decides to take over. `AutomationClient` stands down on its own: the
instant the gateway asks for control back, every interaction method on
that target starts raising `LEASE_REVOKED` and no further input reaches
the browser.

```python
def on_yield(ev):
    if not ev.human:
        return  # another agent outranked us; the run can retry
    plan.abort(f"{ev.by_label} took over during {ev.in_flight[0].action if ev.in_flight else 'idle'}")

client.on_control_yield(on_yield)
```

`client.yield_status()` is the same information pulled rather than pushed.
Nothing in this SDK ever re-acquires control on its own, on a timer or
otherwise: `client.wait_for_resume()` waits for both the server's requeue
backoff to elapse AND the target to stop being held by somebody else, and
`acquire_control()` is the only thing that reopens dispatch.

### Shared vs exclusive control

A target's `ControlLease` is either `exclusive` (the default: one holder
at a time, everyone else queues) or `shared` (several concurrent holders,
each with their own lease id, granted immediately with no queue). The
mode is a property of the target, configured server side, not something a
caller requests:

```python
lease = await client.acquire_control()
print(lease.mode)  # "exclusive" or "shared"
```

On a shared target there is no preemption queue and nobody's lease is
ever silently displaced; instead, a person can ask the automation holders
to stand down while the other people driving the target keep going. That
arrives as the same `on_control_yield` event, with `reason ==
"human_takeover"`. See `packages/protocol/src/wire/messages/control.ts`
in this monorepo for the full `LeaseMode` contract this SDK reflects
rather than re-decides.

## The method surface

Every method mirrors its TypeScript counterpart
(`packages/automation/src/client/AutomationClient.ts`) unless noted
below. Grouped, not exhaustive; see each method's own docstring for
options.

* **Connect**: `AutomationClient.connect(endpoint=, token=, ...)`,
  `client.close()`, `client.for_target(target_id)`,
  `client.use_target(target_id)`.
* **REST (no Chrome spawned by you)**: `RestClient.acquire()`,
  `.release()`, `.attach()`.
* **Control lease**: `client.acquire_control()`, `client.release_control()`,
  `lease.renew()`, `lease.release()`, `lease.on_revoked()`,
  `lease.on_preemption_requested()`.
* **Standing down**: `client.on_control_yield()`, `client.yield_status()`,
  `client.yield_control()`, `client.wait_for_resume()`.
* **Navigation**: `client.navigate()`, `client.go_back()`,
  `client.go_forward()`, `client.reload()`, `client.stop()`,
  `client.status()`, `client.wait_for_navigation()`,
  `client.wait_for_network_idle()`. `navigate()` returns after the new
  page's `load` event (`wait_until="load"`, the default), so the page can
  be read on the next line; `wait_until="commit"` returns as soon as the
  navigation commits. A page that has not loaded within `timeout_ms`
  (default 30000) comes back with `loading` True instead of raising.
* **Downloads**: `client.wait_for_download(timeout_ms=, trigger=)`. See
  "Downloads: `wait_for_download()`" below.
* **Tabs**: `client.tabs.list()`, `client.tabs.open(url=, background=)`,
  `client.tabs.close(target_id)`, `client.tabs.activate(target_id)`,
  `client.tabs.active()`. Gated on the `tabs.manage` capability.
* **Evaluate**: `client.evaluate(expression)`,
  `client.evaluate_function(source, *args)`,
  `client.wait_for_function(predicate)`, `client.text()`, `client.html()`.
  See "`evaluate()` and Python functions" below for why this is two
  methods rather than TypeScript's one overloaded `evaluate()`, and
  "Which world your JavaScript runs in" for the `world` option and the
  one place its default is not the page's own world.
* **The locator surface**: `client.resolve()`, `client.wait_for()` /
  `client.wait_for_selector()`, `client.click()`, `client.fill()`,
  `client.select()`, `client.inner_text()`, `client.get_attribute()`,
  `client.is_checked()`, `client.scroll_into_view()`,
  `client.wait_for_text()`.
* **Uploads**: `client.set_input_files(selector, files)`.
* **Reading**: `client.screenshot()`, `client.inspect_at()`,
  `client.rect()`, `client.status()`.
* **Diagnostics**: `client.diagnostics.subscribe()`,
  `client.diagnostics.unsubscribe()`, `client.diagnostics.response_body()`,
  `client.on("console"/"pageerror"/"network"/"networksummary", callback)`.
* **The request gate**: `client.gate.enable(rules)`, `client.gate.disable()`,
  `client.gate.resolve(gate_id, verdict)`, `client.gate.on_paused(handler)`.
  See "The outbound request gate" below.
* **Coordinate-level interaction**: `client.click_at()`, `client.move_to()`,
  `client.type_text()`, `client.insert_text()`, `client.press_key()`,
  `client.scroll()`, `client.human_type()`.
* **The accessibility tree**: `client.a11y(role=, name=, max_nodes=, timeout_ms=)`
  reads Chrome's own accessibility tree. See "`a11y()` and the `role=`
  selector" below.
* **Driving many browsers at once**: `BrowserSwarm.open(size=, acquire=, ...)`,
  `swarm.members`, `swarm.all(fn)`, `swarm.grow()`, `swarm.shrink()`,
  `swarm.close()`. See "Parallel browsers with `BrowserSwarm`" below.
* **Refused by design, not by omission**: `client.elements()` raises
  `NOT_IMPLEMENTED` naming why (there is no element-handle API on this
  wire, permanently; see its docstring).

### `resolve()`: the locator primitive

There is no `Locator` object on this surface, and there will not be one:
page evaluation on this wire returns by value and never a live handle, so
a lazy locator that re-queries the page on every property access cannot
exist. `resolve()` answers everything in one round trip instead:

```python
r = await client.resolve('[data-testid="dropdown"]')
r.total                          # what .count() was for
r.matches[0]                     # what .first was for
[m for m in r.matches if m.visible]
r.matches[2].occluded_by         # what would take a click aimed here
```

Selectors are CSS by default. `text=`, `xpath=`, `label=`, `ref=`,
`visible=` and `role=` are explicit prefixes, and segments chain with
`>>`: `'input#first >> xpath=ancestor::label[1]'`. There is no strict
mode: a selector matching several elements is a fact about the page, not
an error; only the acting verbs choose one, and they say which they chose
and out of how many. Every one of `RESOLVE_SCRIPT`, `WAIT_SCRIPT`,
`READ_SCRIPT`, `CLEAR_SCRIPT`, `SELECT_SCRIPT`, and `DISPATCH_CLICK_SCRIPT`
in `browserglass/locator/script.py` is the SAME JavaScript source string
the TypeScript SDK sends (verified byte-for-byte identical, module doc
included there), because the selector engine and every actionability
check run in the browser, not in this client: sending a different
implementation from Python would make the two SDKs quietly diverge on
what "visible" or "occluded" means.

### `a11y()` and the `role=` selector

`client.a11y()` reads Chrome's OWN accessibility tree, through CDP's
`Accessibility.queryAXTree`, not a hand rolled ARIA table:

```python
tree = await client.a11y(role="button")
[n.name for n in tree.nodes]        # every button's accessible name
tree.total, tree.truncated          # the real count, and whether the reply was capped
```

`role=<role>` or `role=<role>[name="<exact name>"]` is a locator selector
built on the same CDP call, so it composes with `resolve()`/`click()`/`fill()`
like any other selector, and chains: `'div.form >> role=button'`.
Both need the `devtools` capability in addition to `evaluate`, checked
locally so a caller missing it fails fast:

```python
await client.click('role=button[name="Save changes"]')
```

The distinction that matters: `role=` matches Chrome's COMPUTED role and
name, not the `role` HTML attribute. A `<button>` with no `role`
attribute matches `role=button`; an `<a>` with no `href` does NOT match
`role=link`, because it genuinely is not a link, which is exactly the
case a `[role="x"]` CSS lookalike gets wrong. See
`examples/a11y_probe.py` for a runnable proof against real Chrome markup,
including the cross-origin case: neither `a11y()` nor `role=` holds the
`Accessibility` domain open across a call, so navigating between two
calls needs no rebind step.

### Downloads: `wait_for_download()`

Downloads never stream over the `bgls.v1` socket. `wait_for_download()`
waits for the next download on the bound target to finish and hands back
a signed, short lived, single use HTTP URL plus the file's own `sha256`,
gated on the `download` capability:

```python
result = await client.wait_for_download(trigger=lambda: client.click("#download-link"))
async with httpx.AsyncClient() as http:
    fetched = await http.get(result.url)
assert hashlib.sha256(fetched.content).hexdigest() == result.sha256
```

`trigger`, when given, runs AFTER the download listener is attached and
BEFORE the wait begins: put the click that starts the download there
rather than calling it first, or a small file can finish before a
listener attached afterwards ever runs. There is deliberately no
"give me the bytes" method on this surface, on this client or the
TypeScript one: fetch `result.url` with whatever HTTP client you
already have (this package already depends on `httpx` for
`RestClient`), the same way `elements()` above refuses to invent an
element-handle API rather than approximate one. See
`examples/download_probe.py` for a runnable proof against real Chrome,
including a byte-for-byte hash check of what was actually written to
disk on the other end.

## Parallel browsers with `BrowserSwarm`

`BrowserSwarm` opens, drives, and tears down N browsers as one unit,
rather than a caller hand rolling `asyncio.gather()` over several
`RestClient.acquire()` plus `AutomationClient.connect()` calls:

```python
import asyncio

from browserglass import BrowserSwarm, RestClient, SwarmAcquireResult


async def main() -> None:
    async with RestClient(base_url="https://gateway.example", token=APP_TOKEN) as rest:

        async def acquire(index, ctx):
            # `ctx.subject` is this member SLOT's own affinity subject
            # (`<swarm subject>#<index>`); pass it through to both
            # `subject=` and `sticky=` so a repeat run reattaches to the
            # same 10 browsers instead of launching 10 more.
            result = await rest.acquire(
                browser={"headless": True},
                subject=ctx.subject,
                sticky={"subject": ctx.subject} if ctx.subject else None,
            )
            return SwarmAcquireResult(
                instance_id=result.instance_id,
                ws_url=result.attach.ws_url,
                token=result.attach.ticket,
            )

        async with await BrowserSwarm.open(size=10, acquire=acquire, subject="nightly-crawler") as swarm:
            results = await swarm.all(lambda member, i: member.client.navigate(f"https://example.com/{i}"))
            for r in results:
                print("ok" if r.ok else f"failed: {r.error}", r.value if r.ok else "")


asyncio.run(main())
```

Ten members means ten distinct sockets, ten distinct browsers, opened and
driven concurrently: `swarm.all(fn)` runs `fn` against every member at
once (`asyncio.gather`, never a loop that awaits one member before
starting the next) and returns one `SwarmCallResult` per member, in
member order, so one member's page raising or timing out never stops its
siblings. `async with` releases every connection `BrowserSwarm` opened on
exit, so browsers do not outlive the block that opened them; it does not,
and cannot, release whatever `acquire()` reserved on the router side
(call your own `rest.release(member.instance_id)` for that, keyed by
`member.instance_id`/`member.index`). See `examples/parallel_probe.py`
for a runnable measurement of real overlap, not just wall clock.

### `evaluate()` and Python functions

TypeScript's `evaluate()` accepts either a string or a live function,
because `Function.prototype.toString()` can turn a JavaScript function
back into its own source text. Python has no equivalent: there is no way
to serialise a Python `lambda` or `def` into JavaScript source. So this
SDK splits the one TypeScript method into two:

```python
title = await client.evaluate('document.title')  # a JS expression string

value = await client.evaluate_function(          # JS function source, literal text
    "(sel) => document.querySelector(sel)?.textContent", "#name"
)
```

`evaluate_function`'s first argument is JavaScript source you write as a
Python string; it cannot close over anything in your Python process
(exactly like TypeScript's own rule: the function is re-parsed inside the
page). Pass what it needs through the positional `*args`, which are sent
as JSON.

### Which world your JavaScript runs in

Every evaluate runs in one of two JavaScript worlds. `"main"` is the
page's own: the page's globals are visible, and everything your script
does is visible to the page in return. `"isolated"` is a separate world
that shares the DOM and nothing else, so a page cannot hook the functions
your script calls, cannot see the globals it defines, and cannot tamper
with what it returns.

Two different defaults, and the difference is deliberate:

* `client.evaluate(...)`, `client.evaluate_function(...)` and
  `client.wait_for_function(...)` default to the **main** world, which
  means no `world` field goes on the wire at all and the server applies
  its own main-world default. A caller who asked for nothing keeps
  getting what they always got. Ask for the other one explicitly:
  `client.evaluate('document.title', world='isolated')`.
* **The whole locator surface** (`resolve`, `wait_for`, `click`, `fill`,
  `select`, and everything built on them) runs **isolated**, always, with
  no way to ask otherwise. That matches patchright, whose Python client
  defaults `isolatedContext=True` on every evaluate, and it is what keeps
  a page from watching the automation work. See `ENGINE_WORLD` in
  `browserglass/locator/engine.py` for the full argument.

The one exception inside the locator surface is `click`'s `verify`
predicate, which is the only script there whose text you wrote. It
defaults to isolated too, and `client.click(sel, verify=..., verify_world='main')`
is the explicit opt out for a predicate that has to read a global the page
itself defined. You need it more rarely than you think: in the isolated
world `window.somethingThePageSet` is `undefined`, and `undefined` is
indistinguishable from "not set yet", so such a predicate quietly never
passes rather than failing loudly.

**Options are keyword only, and that is load bearing.** The TypeScript
SDK's `evaluate(source, ...args)` is variadic, so
`evaluate('expr', {world: 'isolated'})` there hands the options bag to
the page as argument zero and runs in the default world, silently, with
no error. Here `evaluate` takes exactly one positional parameter, so the
same line is a `TypeError` before anything is sent. `evaluate_function`
IS variadic (passing arguments to the page is its job), so it refuses a
first argument that is a mapping whose every key is an option name,
naming the correct spelling. See `browserglass/worlds.py`.

`examples/isolated_world_probe.py` is the runnable proof against real
Chrome: a page that counts its own `querySelector` calls, so an isolated
locator call leaves the counter at zero and a main world one moves it.

### `set_input_files`: a file upload

```python
from browserglass.types import UploadFileInput

names = await client.set_input_files(
    "#attachment", UploadFileInput(name="invoice.pdf", data=pdf_bytes)
)
```

Takes bytes and a name, never a filesystem path: your process and the
machine actually running Chrome are not the same machine, so a path from
here would mean nothing there (or, worse, mean something else). The bytes
are staged over the socket first (`upload.begin`, `UPLOAD_CHUNK` binary
frames, `upload.complete`) and then attached in one `files.set`. Needs no
held `ControlLease`: attaching a file sends no `input.*` message, so
there is no lease fencing to satisfy, only the `upload` capability.

### The outbound request gate

`client.gate` is the direct replacement for a Playwright style
`page.route("**/*", gate)` submit gate: a say in whether each outbound
request the bound target makes is allowed to leave, which is often the
one thing standing between an automation and accidentally submitting a
real form to a real service.

It answers with exactly two words, `"allow"` or `"deny"`, and nothing
else. There is deliberately no field anywhere on this surface for a
rewritten URL, method, header, or body: read
`packages/protocol/src/wire/messages/interception.ts` in this monorepo
for the full argument, but the short version is that a caller who could
rewrite a request's destination could send it somewhere the inspection
never saw. This SDK will not add a convenience for that; the absence is
the security property, not a gap waiting to be filled in.

```python
from browserglass.types import GateRule

# Every request the target makes pauses and asks this handler for a
# verdict. An unanswered pause holds a real Chrome network slot until
# its deadline, so on_paused() answers every one of them for you,
# including the ones a handler forgets, or throws on: a raising handler
# still resolves with "deny", never leaves a request hanging.
def submit_gate(ev):
    if ev.method == "POST" and "/signup" in ev.url:
        print("blocked an actual submit:", ev.url)
        return "deny"
    return "allow"

client.gate.on_paused(submit_gate)
await client.gate.enable(
    [GateRule(url_pattern="*", verdict="ask", resource_types=["Document", "Fetch", "XHR"])]
)

# ... drive the page, fill the form, click things ...

await client.gate.disable()  # stop gating once the run is done driving forms
```

Prefer a rule that names `verdict="allow"` or `verdict="deny"` outright
over `"ask"` wherever the decision does not need a caller's own logic:
those are decided server side with no round trip and cannot time out.
`"ask"` is the one that produces a pause and needs `on_paused()` (or a
manual `client.gate.resolve(gate_id, verdict)`) to answer it.
`include_request_body=True` on a rule additionally needs the `evaluate`
capability, not just `intercept`: a caller who can already run script in
the page can already read whatever the page is about to send, so the
flag grants nothing new to a token that holds `evaluate`.

### Reading a response body: "did the form actually submit"

A lot of real form submissions render nothing new on screen either way;
the only place that answers "did this actually work" is the response
body of the submit request itself. `client.diagnostics.response_body()`
reads it, for exactly one request: one your own `network` diagnostics
feed already showed you happening on this target.

```python
await client.diagnostics.subscribe(network=True)

submitted = []
client.on("network", lambda ev: submitted.append(ev) if "/signup" in ev.url else None)

await client.click("#submit")
await client.wait_for_function("document.readyState === 'complete'")

request_id = submitted[-1].request_id  # snake_case: this is Python, not the wire
result = await client.diagnostics.response_body(request_id)
print("confirmed" if "Thank you" in result.body else "did not confirm:", result.body[:200])
```

There is no other way to get a `request_id`: guessing one, real or not,
is refused server side, because the bound is "a request THIS client's
own diagnostics feed already delivered to it", checked against what was
actually sent, not against what exists in Chrome's buffer. The body is
not durable either: it lives only as long as Chrome's own per-request
buffer does, which a navigation clears outright, so read it before
navigating away. A read that is too late, or of a request that never had
a body (a redirect, a `204`), raises `AutomationError` with code
`NOT_FOUND` rather than resolving with an empty string, so "gone" and
"empty" stay two different, distinguishable answers.

### Errors

Every failing call raises `browserglass.AutomationError`, never a bare
`Exception`, carrying `.code` (one of a closed taxonomy: `NOT_FOUND`,
`OCCLUDED`, `LEASE_NOT_HELD`, `LEASE_REVOKED`, `POLICY_DENIED`, `TIMEOUT`,
`NOT_IMPLEMENTED`, and others; see `browserglass/errors.py`), `.message`,
and `.details` (a dict; carries context specific to the code, such as
`retry_after_ms` on a `POLICY_DENIED` backoff refusal, or `stack` on a
page-side exception). REST failures raise the separate
`browserglass.RestError` (an `E_*` code, a different namespace from the
wire's `bgls.error.*` taxonomy) rather than being folded into
`AutomationError`, so an `except AutomationError` written for socket
failures does not silently also swallow a REST admission failure it was
never written to handle.

```python
from browserglass import AutomationError

try:
    await client.click("#submit", verify="pageChangedSomehow()")
except AutomationError as err:
    if err.code == "OCCLUDED":
        print("blocked by:", err.details["occludedBy"])
    elif err.code == "LEASE_REVOKED":
        print("a person took over mid-run")
    else:
        raise
```

## Development

```sh
cd clients/python
python -m venv .venv
./.venv/Scripts/python -m pip install -e ".[dev]"   # Windows
# source .venv/bin/activate && pip install -e ".[dev]"  # macOS/Linux
python -m pytest
```

There is no live gateway to test against (this SDK ships ahead of, and
independent of, any particular gateway deployment), so the test suite
drives `AutomationClient` end to end against `tests/fake_gateway.py`, a
scripted `WebSocketLike` double that plays the server's side of a
`bgls.v1` connection: it answers `hello` with a real `welcome`, and each
test scripts the replies for whatever wire messages it cares about. This
mirrors `packages/automation/test/fake-gateway.ts` in the TypeScript
SDK's own suite. `tests/test_locator_engine.py` additionally exercises
`LocatorEngine`'s retry/staleness/error-taxonomy orchestration directly
against a scripted `LocatorRuntime`, independent of the socket layer.

137 tests, covering: the `hello`/`welcome` handshake and bearer auth; the
wire error taxonomy mapping (including the unmapped-code fallback);
control lease acquire/release/renew, the `shared` vs `exclusive` mode
distinction, preemption stand-down (a client refuses further input the
instant a takeover is requested, before the lease is even gone), and the
requeue backoff; navigate and evaluate round trips including page-side
exceptions; the full locator surface (`resolve`, `click` with `verify`
and occlusion reporting, `fill` with masked-input handling, `select` with
its option-not-found diagnostics, the read verbs) plus selector parsing
edge cases; the binary upload framing (header byte layout, chunking,
cancel-on-failure) end to end through `set_input_files`; screenshots and
typed diagnostics event delivery; the request gate's capability checks,
rule serialisation, `on_paused()` answering allow/deny/raise/async
handlers and ignoring other targets, and unsubscribe leaving the gate
itself untouched; `diagnostics.response_body()`'s capability check, body
and base64 round trips, and its `unknown_request`/`too_large`/`unavailable`
error mapping; the REST client's request shaping and error-envelope
mapping; `a11y()`'s capability check, node round trip, and truncation
reporting; the `role=` selector's rewrite into a `css=[...]` marker
(including chained and no-match cases) and its own capability check;
`BrowserSwarm`'s concurrent open/grow/shrink, per-member subject
derivation, slot reuse under a subject, and partial-failure cleanup;
`wait_for_download()`'s capability check, `download.ready`/`download.failed`
handling, timeout wording, and the trigger-runs-after-subscribing race;
`wait_for_network_idle()`'s capability and subscription checks, the
`inFlight`-settles-then-stays-settled timing, ignoring another target's
summaries, disarming on renewed activity, and timing out honestly when a
gateway reports no `inFlight` field at all; and `client.tabs`'
list/open/close/activate/active verbs and their shared capability check.

## Not implemented yet

Being explicit about what this build leaves out: a
correct, tested core beats a broad surface where half the verbs are
untested stubs.

* **Reconnection.** `AutomationClient.connect()` opens one connection and
  raises if it drops; there is no backoff/resume state machine the way
  `@browserglass/client`'s `Transport` has. A dropped socket needs a fresh
  `connect()` call from your own code today. Building this needs the
  `resume`/`resumed` wire messages wired through (they are defined on the
  wire; this client does not send or handle them) plus a reconnect policy
  decision (backoff schedule, when to give up) that has not been made yet.
* **`restart_instance`.** The `instance.restart` wire message and its
  `instance.recovered` reply are defined and used by the TypeScript SDK;
  this port does not send them. A caller that needs manual recovery has
  to drop to the REST `POST /v1/instances/:id/recover` route directly
  (not wrapped by `RestClient` either).
* **Large screenshots.** `client.screenshot()` only implements the inline
  (base64-in-JSON) delivery path, exactly like the TypeScript SDK: a
  reply carrying `downloadId` instead of `data` raises `NOT_IMPLEMENTED`
  naming what a download-fetch path would need.
* **An MCP server** (`createAutomationMcpServer` in the TypeScript
  package). Not built here. `BrowserSwarm`, the other half of what that
  package offers on top of `AutomationClient`/`RestClient`, IS ported
  (see "Parallel browsers with `BrowserSwarm`" above).
* **Presence roster as a public read.** `AutomationCore` tracks
  `presence.state` internally (it needs to, to resolve who a preemption
  request came from), but there is no public
  `client.presence`/`client.viewers` accessor yet. Small addition; simply
  not exposed yet.
* **`BrowserSpec.initScripts` (per-document init scripts).** Not
  something this client sends directly: it is a launch-time field, set
  through `RestClient.acquire(browser={...})`, not a post-connect wire
  message. It is defined in `packages/protocol/src/domain/entities.ts`
  and needs no SDK change on this side: `RestClient.acquire()`
  passes its `browser=` argument through opaquely (an arbitrary mapping,
  never a hardcoded set of fields), so `rest.acquire(browser={"initScripts": [...]})`
  already works against a gateway that supports the field.

A stub that silently returns `None` is worse than an obvious gap:
`client.elements()` above is a method this build actively refuses (it
raises `AutomationError` with code `NOT_IMPLEMENTED`, naming the real
alternative) rather than leaves unbuilt, because there is nothing a
future pass could wire up for it on this protocol; see its own
docstring for why.
