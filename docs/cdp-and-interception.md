# CDP passthrough, request interception, user agent, and router CDP routing

This document answers four questions with the code as it actually is on
`main` today. Every claim below cites the file and line it came from.

The four questions:

1. Where does the CDP deny list live and what does it really block.
2. What did the `evaluate` capability do, and how is that the template for
   adding a narrow door.
3. How do we give a caller a request gate without handing it an egress
   bypass.
4. Where does a per instance user agent belong, and does the router
   already route CDP.

---

## 0. What has since been built

This section was added after the plan below was acted on. Steps 1 to 4
are done, plus most of step 5. The plan is left intact underneath because
its reasoning is still the reasoning; this is only a record of what is now
real, with the tests that say so.

| Step | State | Evidence |
|---|---|---|
| 1. `BrowserSpec.userAgent` on `runtime-host` | Done | `--user-agent=` emitted in `packages/runtime-host/src/flags.ts`; `flags.test.ts` covers set and unset |
| 2. Client hints alignment | Done at the store and `runtime-remote` | migration `0005_browser_spec_client_hints`, folded into the spec digest; `router`'s `specMapping` now carries the field |
| 3. Fire the hooks | Done, nine of ten | `HookRegistry.dispatch` now has call sites for `onInstanceLaunched`, `onSessionStarted`, `onViewerJoined`, `onControlGranted`, `onNavigation`, `onDownload` (`managed-session.ts:1980`), `onRecovery`, `onInstanceReleased`, `onQuotaExceeded`; `onRequest` deliberately has none, see the correction below |
| 4. `onRequest` in process gate | Superseded by the wire gate | the engine below serves both |
| 5. `request.gate.*` wire gate | Done | `packages/core/src/interception/request-gate.ts`, 20 unit tests; live proof in `examples/nextjs-demo/gate-probe.mjs`, 7/7 against real Chrome |
| 6. Cross node placement | Done | `remoteNodeSnapshots` feeds real placement candidates; `buildRouterWiring` (`packages/server/src/lifecycle/wiring.ts:1170` to `:1222`) dials them with a `WebSocketNodeTransport` once `peer.sharedSecret` is configured; `packages/router/test/router/cross-node-placement.test.ts` |
| 7. Cross node viewer attach | Not started | `BrowserRouter.attach()` still returns a placeholder `wsUrl` (`BrowserRouter.ts:1063`, `:1925`), never resolved against the owning node's `peer.dataPlaneUrl`; no redirect logic in `packages/server/src/ws/upgrade.ts` |

Two corrections to the plan as written:

* Step 4 assumed the caller could embed the gateway. Many callers are
  written in Python or run in a separate process, and an in process hook
  can never serve them. The engine was built once and exposed through the
  wire messages instead, which is step 5. `onRequest` exists as a hook TYPE
  (`packages/server/src/hooks/types.ts`) and is available to an embedding
  host, but the wire path is what an out of process caller uses.
* `onDownload` DOES have a call site now, at `managed-session.ts:1980`. This
  paragraph used to claim the download feature it gates "does not exist
  anywhere in `packages/server` or `packages/core`"; that is no longer
  true, and this replaces it with what is actually built, again cited to
  file and line:
  * `packages/core/src/downloads/download-bridge.ts` is the CDP side.
    It deliberately sends `Page.setDownloadBehavior`
    (`download-bridge.ts:194-198`), not `Browser.setDownloadBehavior`: the
    `Browser` method is browser (or `browserContextId`) scoped, carries no
    session id to bind to a per target `CdpBridge.send(method, params,
    sessionId)` call, and real Chrome 151 rejects it outright when sent
    with a target session id (`download-bridge.ts:10-33`, the module doc's
    "Domain ownership" section). `Page.setDownloadBehavior` is the only
    session scoped way to reach the same switch, matching
    `DownloadBridge`'s per session enable/rebind model.
  * `Browser.downloadWillBegin`/`Browser.downloadProgress` ARE handled
    (`download-bridge.ts:209-277`, `onDownloadWillBegin`/
    `onDownloadProgress`), despite living in the `Browser` event namespace
    while the enabling call is `Page.setDownloadBehavior`: CDP consolidated
    download events under `Browser` some versions ago and never gave `Page`
    its own copy back, but they still arrive scoped to the session that
    called `Page.setDownloadBehavior` (`download-bridge.ts:35-41`).
  * The `download.*` wire messages ARE sent, not merely declared:
    `packages/server/src/session/managed-session.ts`'s `deliverDownload`
    (`managed-session.ts:1908`) sends `download.started` (`:3794`),
    `download.progress`, `download.ready` (`:1994`) and `download.failed`
    (`:1941`, `:1954`, `:1984`, `:1986`) to every connected viewer holding
    the `download` capability.
  * `onDownload` fires at `finalizeDownload` (`managed-session.ts:1934`
    to `:1990`), after the finished file is hashed and re-verified
    (`DownloadStore.finalize`) but before a signed URL is issued: the file
    is complete and hashable at exactly that point, which is why this is
    the veto point rather than `download.started` (no `sha256`/`bytes` yet)
    or the REST fetch route (too late, the bytes would already have left
    this process). It is a VETOING hook that FAILS CLOSED
    (`hooks/types.ts`'s `HOOK_TIMEOUTS.onDownload`, `:192`): a timeout is
    treated as a refusal, and a veto discards the bytes
    (`DownloadStore.discard`) and reports `download.failed` rather than
    ever issuing a URL.

### The shape of the gate, in one paragraph

The gateway owns `Fetch` and enables it at `requestStage: 'Request'`
only. A caller registers ordered rules and answers `'allow'` or `'deny'`.
There is no field anywhere in the wire messages, the capability, the
client API or the core class through which a URL, method, header or body
could be supplied, so `Fetch.fulfillRequest` and a rewritten
`Fetch.continueRequest` are unreachable by construction rather than by
rule. `Fetch` stays in `REFUSED_DOMAINS` and the passthrough allowlist is
untouched. Verified: the only `Fetch` methods reachable from the source
are `enable`, `disable`, `continueRequest` (sent with `{requestId}` and
nothing else) and `failRequest`.

### What an operator gives up, unchanged from section 3

A holder of `intercept` can refuse any request the page makes, including
the operator's own telemetry or consent scripts. That is an egress veto.
It is real, it cannot be withheld while still offering a useful gate, and
the capability is absent from every role bundle (`owner` included) so it
can only ever be granted by naming it in a token. Nothing enables `Fetch`
for a target nobody registered a gate on, so the feature costs nothing
until it is used.

### The failure mode that was designed against

CDP domain enables are per session, and a cross origin navigation swaps
the renderer and takes `Fetch.enable` with it. A gate that misses that
swap fails OPEN, silently. `RequestGate.rebind` is wired into the same
`rebuildCaptureAndDiagnostics` seam diagnostics uses, and there are two
tests specifically for it: one asserting `Fetch` is re-enabled on the new
session, and one asserting a request on the NEW session is still denied
rather than waved through.


## 1. The deny list, quoted from the code

There is one file: `packages/server/src/rest/cdp-passthrough-allowlist.ts`.
It has three parts, checked in this order by `isCdpMethodAllowed`
(`cdp-passthrough-allowlist.ts:101`):

```ts
export function isCdpMethodAllowed(method: string): boolean {
  const domain = method.split('.', 1)[0];
  if (domain === undefined || domain.length === 0) return false;
  if (REFUSED_DOMAINS.has(domain)) return false;
  if (REFUSED_METHODS.has(method)) return false;
  return ALLOWED_SET.has(method);
}
```

**`REFUSED_DOMAINS`** (`cdp-passthrough-allowlist.ts:30` to `:72`), twelve
entries, each with a written justification in the source:

`Target`, `Browser`, `IO`, `Runtime`, `Debugger`, `Fetch`, `Security`,
`Profiler`, `HeapProfiler`, `Memory`, `SystemInfo`, `Tracing`.

**`REFUSED_METHODS`** (`cdp-passthrough-allowlist.ts:79` to `:98`), five
entries whose domain is otherwise open:

`Page.setDownloadBehavior`, `Page.setBypassCSP`,
`Page.addScriptToEvaluateOnNewDocument`,
`Page.removeScriptToEvaluateOnNewDocument`, `Page.setDocumentContent`.

**`CDP_PASSTHROUGH_ALLOWLIST`** (`cdp-passthrough-allowlist.ts:120` to
`:138`), seventeen methods and nothing else:

```
Page.navigate             Page.reload              Page.stopLoading
Page.getNavigationHistory Page.navigateToHistoryEntry
Page.captureScreenshot    Page.getLayoutMetrics
DOM.getDocument           DOM.querySelector        DOM.querySelectorAll
DOM.getBoxModel           DOM.getOuterHTML
Input.dispatchMouseEvent  Input.dispatchKeyEvent   Input.dispatchTouchEvent
Input.insertText          Network.getResponseBody
```

The gate is `POST /v1/instances/:instanceId/targets/:targetId/cdp`,
registered at `packages/server/src/rest/router.ts:114` with
`capability: 'cdp'`. The handler is `sendCdpCommand`
(`packages/server/src/rest/routes/targets.ts:272`), and the allowlist check
at `targets.ts:284` runs before `requireCdp(ctx)` at `:291` and before
`resolveDrive(...)` at `:292`, so a refused method never learns whether a
live CDP sender exists.

The `cdp` capability is defined at
`packages/protocol/src/wire/capabilities.ts:38`, is absent from every entry
of `ROLE_BUNDLES` (`capabilities.ts:131` to `:181`, `owner` included), and
is therefore only ever granted by a token that lists the literal string
`cdp` in its `caps` claim.

### What is refused by name, and what is refused by omission

**It is easy to assume `Fetch.enable` and
`Network.setRequestInterception` are both blocked by name. Only half of that is true.**
`Fetch` is refused as a whole domain (`cdp-passthrough-allowlist.ts:60`).
`Network.setRequestInterception` is not in `REFUSED_METHODS` and `Network`
is not in `REFUSED_DOMAINS`. It is refused only because it is absent from
`CDP_PASSTHROUGH_ALLOWLIST`, which is deny by default. The prose comment at
`cdp-passthrough-allowlist.ts:55` mentions it, but the mechanism that
actually stops it is the allowlist, not the denylist. `Network` is a
partially open domain today: `Network.getResponseBody` is allowed
(`:137`).

This matters for the design. Removing the `Fetch` denylist entry is a
deliberate weakening of a hard refusal that outranks the allowlist by
construction, and the source comment at `:13` to `:22` says explicitly why
that layer exists: so a careless allowlist widening cannot reopen one of
these on its own. Adding a `Network.*` method is only an allowlist edit.
They are not the same size of change and should not be argued for the same
way.

**`Emulation.setUserAgentOverride` is not on any denylist at all.**
`Emulation` is not in `REFUSED_DOMAINS`, and no `Emulation.*` method is in
`REFUSED_METHODS`. It is refused purely because the whole `Emulation`
domain is absent from the seventeen entry allowlist. The test suite bears
this out: `packages/server/test/rest/targets.test.ts:510` to `:530`
enumerates seven methods that are explicitly refused, and
`Emulation.setUserAgentOverride` is not among them. `Fetch.enable` is
(`targets.test.ts:516`).

So the user agent question is a much smaller policy question than the
interception question. It was never a named refusal. That does not mean
the answer is to add it to the allowlist, and section 4 argues it should
not be, but the argument has to be made on its own merits rather than by
appealing to a denylist entry that does not exist.

---

## 2. The `evaluate` precedent

`packages/protocol/src/wire/messages/evaluate.ts` is the worked example of
adding capability that the deny list forbids, without weakening the deny
list. Its module doc (`evaluate.ts:1` to `:80`) makes the argument in full.
The load bearing paragraph is `evaluate.ts:9` to `:16`:

> `packages/server/src/rest/cdp-passthrough-allowlist.ts` refuses the whole
> `Runtime` domain on the raw CDP passthrough [...] That refusal is correct
> for an untrusted tenant of a shared gateway and it STAYS EXACTLY AS IT
> IS. This message pair does not widen it, does not carve an exception into
> it, and does not require the `cdp` capability at all.

And `evaluate.ts:17` to `:24` names the trust model split that justified the
feature: the denylist was serving two trust models with one policy, and an
application running its own browsers for its own users is not a tenant of
anyone else's gateway.

The mechanics, which are what to copy:

* Its own message pair, not a CDP method. `page.evaluate` /
  `page.evaluated` (`evaluate.ts:150`, `:259`). The wire shape carries no
  `executionContextId`, no `objectId`, no `uniqueContextId`, no CDP
  `sessionId` (`evaluate.ts:36` to `:55`). The escalations are closed by the
  SHAPE of the message, not by a runtime check a later edit could forget.
  That sentence is the whole design rule.
* Its own capability, off by default: `evaluate`
  (`capabilities.ts:75`), absent from every role bundle, not implied by
  `cdp` and not implying it (`capabilities.ts:59` to `:66`).
* A parameter dependent escalation. `userGesture: true` additionally
  requires `control` (`EVALUATE_USER_GESTURE_CAPABILITY_RULE`,
  `capabilities.ts:281` to `:286`), expressed as data in
  `PARAMETER_DEPENDENT_CAPABILITY_RULES` (`capabilities.ts:292`) rather than
  as an `if` chain in a handler.
* Hard, non negotiable bounds. `MAX_EVALUATE_SOURCE_BYTES` 32768
  (`evaluate.ts:97`), `MAX_EVALUATE_RESULT_BYTES` 1 MiB (`:117`),
  `MAX_EVALUATE_ARGS` 16 (`:125`), `DEFAULT_EVALUATE_TIMEOUT_MS` 30000
  (`:134`), `MAX_EVALUATE_TIMEOUT_MS` 120000 (`:142`). Over the limit is a
  refusal, never a truncation, and the source says why (`:110` to `:116`).
* The server owns the CDP addressing. It maps `targetId` to a CDP session
  through the caller's own `ManagedSession` registry
  (`evaluate.ts:36` to `:47`).
* Wired into the generic machinery, not special cased:
  `REQUIRED_CAPABILITY['page.evaluate'] = 'evaluate'`
  (`packages/server/src/wire/capability-check.ts:103`), handler at
  `packages/server/src/ws/connection.ts:1365`, its own rate limit bucket
  (`connection.ts:1919`), its own audit line (`connection.ts:1837` to
  `:1855`).

Anything proposed below that does not do all seven of these is not
following the precedent, whatever it claims.

---

## 3. Request interception

### The threat, stated without softening

Request interception genuinely is the largest privilege in this protocol,
larger than `evaluate`. `evaluate` is one shot, scoped to one target, and
returns results by value with no handles. `Fetch.enable` is persistent,
applies to every load the target makes including all future navigations,
and specifically:

* `Fetch.fulfillRequest` lets the caller author the response body for any
  URL the page requests. A fulfilled script response is arbitrary code
  execution in the page's origin, which subsumes `evaluate` entirely and
  also defeats Content Security Policy, subresource integrity, mixed
  content blocking and certificate pinning, because every one of those
  inspects a response the caller now writes. That is exactly the reasoning
  already recorded at `cdp-passthrough-allowlist.ts:55` to `:59`.
* `Fetch.continueRequest` accepts a rewritten `url`, `method`, `headers`
  and `postData`. Any outbound request can be redirected to a collector the
  caller controls, carrying whatever cookies the browser attaches. A network
  layer egress allowlist does not help: the rewrite happens inside Chrome,
  and the request that leaves the box is already the rewritten one.
* Pausing at the response stage plus `Fetch.getResponseBody` reads every
  response before the page does, which is a bulk read of page content.
* `Fetch.enable` with `handleAuthRequests: true` puts proxy and HTTP auth
  challenges in the caller's hands.

A tenant that can rewrite responses can exfiltrate. There is no version of
this feature where that stops being true if raw `Fetch` is exposed. So the
design question is not whether to accept that risk. It is how to give a
caller the thing it actually needs while never handing over the pieces
that carry it.

### What a caller actually needs

A typical Playwright script installs `page.route("**/*", self._gate_request)`
and uses it to gate form submissions. That is an allow or deny decision on
an outbound request, made before it leaves. It is not response mocking,
not header injection, not URL rewriting. Every dangerous primitive in the
list above is something that script does not use.

### The two honest options

**Option A: a scoped declarative request gate. The gateway owns the CDP
domain and the caller never touches it.**

A new wire message family, following the `evaluate` template exactly:

* `request.gate.set` (C to S): the caller registers an ordered rule table
  against one `targetId`. Each rule is `{ urlPattern, methods,
  resourceTypes, verdict }` where `verdict` is one of `'allow'`, `'deny'`,
  `'hold'`. Bounded rule count, bounded pattern length, same shape as
  `MAX_EVALUATE_ARGS` and `MAX_EVALUATE_SOURCE_BYTES`.
* `request.gate.paused` (S to C, addressed to the registering viewer only,
  never broadcast, the same rule `PageEvaluated` follows at
  `evaluate.ts:253` to `:258`): fires for a `'hold'` match, carrying
  `gateRequestId`, `url`, `method`, `resourceType`.
* `request.gate.resolve` (C to S): carries `gateRequestId` and a verdict
  that is only ever `'allow'` or `'deny'`. Nothing else. No body, no
  headers, no URL, no status code, no `postData`.

The gateway calls `Fetch.enable` itself, with `patterns` derived from the
rules and with `requestStage: 'Request'` only. This one restriction is what
makes the option defensible: at Request stage Chrome never pauses a
response, so `Fetch.fulfillRequest` with a body, `Fetch.continueResponse`
and `Fetch.getResponseBody` are unreachable for anybody, caller and gateway
alike. The gateway sends exactly two CDP methods in response to a paused
request: `Fetch.continueRequest` with no modification fields at all, or
`Fetch.failRequest` with `errorReason: 'BlockedByClient'`.

The escalations are closed by the shape of the wire message. There is no
field on `request.gate.resolve` in which a body, a header or a URL could be
spelled, in the same way there is no `objectId` field on `page.evaluated`.

Capability: a new `intercept` capability, off by default, in no role
bundle, not implied by `cdp`, `devtools`, `automation` or `evaluate`, and
not implying any of them.

One parameter dependent rule, mapping onto the existing mechanism at
`capabilities.ts:292`: `request.gate.set` with `includeRequestBody: true`
additionally requires `evaluate`. A form submit's `postData` is the form
contents, which is page content, and `capabilities.ts:43` to `:47` already
establishes that reading page content is what `evaluate` gates. A caller
that only needs to gate on the URL does not pay that price.

The `Fetch` domain stays in `REFUSED_DOMAINS`, unmodified, and the doc
comment for the new message says so in the same words `evaluate.ts:9` uses.

**Option B: raw `Fetch` passthrough behind a separate capability plus an
egress allowlist.**

Delete `'Fetch'` from `REFUSED_DOMAINS`, add `Fetch.enable`,
`Fetch.continueRequest`, `Fetch.failRequest`, `Fetch.fulfillRequest` and
`Fetch.disable` to `CDP_PASSTHROUGH_ALLOWLIST`, gate them on a new
capability, and have the gateway check every `continueRequest`'s rewritten
URL against an operator configured egress allowlist.

### Recommendation: Option A. Here is why B does not work

The egress allowlist in Option B is only enforceable on fields the gateway
can see and re check. `Fetch.fulfillRequest` names no egress destination at
all. A caller that fulfills a script response with an exfiltrating script
needs no hole in the egress allowlist, because the page itself then makes
the request, as a fresh request the gateway would also have to intercept
and check, from a script running inside an origin the allowlist already
trusts. Closing that requires inspecting every request and every fulfilled
body, which is Option A with extra steps and a false claim of coverage.

The second reason is internal consistency. `Page.setBypassCSP` and
`Page.addScriptToEvaluateOnNewDocument` are already in `REFUSED_METHODS`
(`cdp-passthrough-allowlist.ts:86`, `:92`). `Fetch.fulfillRequest` achieves
both by other means. Admitting it while refusing those two is precisely the
drift that the layered denylist at `cdp-passthrough-allowlist.ts:13` to
`:22` exists to prevent, and it would be this codebase's first
self contradicting security rule.

### Before either: there is a cheaper answer that may be the right one

`packages/server/src/hooks/types.ts` already declares nine lifecycle hooks,
four of which veto (`types.ts:127` to `:137`), with per hook timeouts and
an explicit fail open or fail closed policy (`HOOK_TIMEOUTS`,
`types.ts:147` to `:162`). `onNavigation` vetoes with a 750ms timeout and
fails open (`types.ts:157`). `onDownload` vetoes with a 5000ms timeout and
fails closed (`types.ts:158`). `HookRegistry` is constructed at
`packages/server/src/index.ts:158` and injected into `RestContext.hooks`
(`packages/server/src/rest/types.ts:116`) and `ConnectionDeps.hooks`
(`packages/server/src/ws/connection.ts:69`).

**`HookRegistry.dispatch` has no call site anywhere in
`packages/server/src`.** The whole veto system is built, typed, and wired
for injection, and nothing ever fires it. So the in process navigation veto
that looks like it exists does not exist at runtime.

That is directly relevant here, because an in process `onRequest` hook is
cheaper and safer than any wire level gate:

* It runs inside the gateway operator's own process. There is no new
  tenant facing capability, no new wire message, no new denylist question,
  and nothing a remote caller can reach.
* The hold deadline problem below mostly disappears, because
  `HOOK_TIMEOUTS` already implements bounded timeouts with a stated fail
  policy, and the handler is a local call rather than a network round trip.
* It solves the submit gate case completely IF the caller
  embeds the gateway in its own process, the way
  `examples/nextjs-demo/server.mjs` does. That is exactly the first party
  operator trust model `evaluate.ts:17` to `:24` carved the `evaluate`
  capability out for.

If the caller instead talks to a gateway it does not operate, the hook
does not help it and the wire level `request.gate.*` of Option A is required.
Confirm which before committing engineering time; the two answers differ by
about a week and a half of work.

### What Option A costs, and what an operator loses

Stated plainly, because none of these go away:

1. A gate is an egress veto, and the tenant now holds it. Interception at
   Request stage cannot ADD an egress path, but it can suppress one. A
   tenant holding `intercept` can silently `deny` an operator's own
   telemetry beacon, a consent script, or an audit pixel, and the operator
   sees a page that loaded fine. There is no way to grant a useful gate and
   withhold this. An operator who cannot accept it should not grant the
   capability.

2. Held requests are a resource hold. A paused request occupies a real
   Chrome network slot and blocks that page's load. A caller that holds and
   never resolves stalls every page it drives up to the deadline, per
   request. Bound it two ways: a hard maximum hold deadline (mirroring
   `MAX_EVALUATE_TIMEOUT_MS`'s reasoning at `evaluate.ts:138` to `:142`)
   and a per target cap on concurrent holds. Even bounded, a caller can
   sustain a self inflicted slowdown that burns node capacity. That is
   accepted cost, not a bug.

3. Throughput. `Fetch.enable` at Request stage round trips every matching
   request through the gateway. A `**/*` pattern, which is what most
   Playwright scripts write, means every image, font and stylesheet
   pays the round trip.
   Mitigation that does not require refusing the pattern: default
   `resourceTypes` to `Document`, `XHR` and `Fetch`, the three that carry
   form submissions, and require a caller to name a wider set explicitly.
   The common case then stays cheap and the expensive case is a visible
   choice.

4. CDP domain enables are scoped to the CDP session, not the target. This
   is the single most important implementation detail and it is already
   documented in this codebase, at
   `packages/core/src/session/session.ts:508` to `:519`: a cross origin
   navigation tears down the renderer's session, Chrome mints a fresh
   `CdpSessionId` for the same live target, and everything
   `Runtime.enable` / `Log.enable` / `Network.enable` turned on is silently
   dropped. `TargetDiagnostics` hit exactly this and fixed it by rebinding
   through one seam, `rebuildCaptureAndDiagnostics`
   (`session.ts:521` to `:528`), which every recovery rung already funnels
   through. A request gate MUST rebind on the same seam. If it does not, a
   submit gate stops gating at the first cross origin navigation, and it
   fails OPEN with no error anywhere. For a gate whose job is to stop a form
   submission, silently failing open is the worst available failure.

5. Fail closed on disconnect, and tear down. If the viewer socket that
   registered the gate drops, pending holds must resolve to a configured
   default and the rules must be torn down with `Fetch.disable`.
   `onDownload`'s `failClosed: true` (`hooks/types.ts:158`) is the existing
   precedent for "this is the one that fails closed"; a submit gate belongs
   in the same category. Without the teardown, a dead socket leaves every
   subsequent page load frozen for the full hold deadline.

6. Fidelity loss against Playwright. No `route.fulfill()` with a mock body,
   no `route.continue({ headers })`, no reading response bodies through the
   gate. A caller that mocks network responses in tests cannot port that
   code and will need a different approach. A submit gate
   does port cleanly, because allow or deny on a URL pattern
   is all it uses.

7. The cluster boundary gives no second check. See section 5 item 6: the
   allowlist is enforced once, at the receiving gateway's REST handler.
   Anything admitted at one edge is admitted cluster wide.

---

## 4. User agent override

### The current state, which is worse than "policy forbids it"

`BrowserSpec` already carries the field:

```ts
userAgent: string | null;
/** Derived from `userAgent` when null. */
clientHints: ClientHintsSpec | null;
```

(`packages/protocol/src/domain/entities.ts:337` to `:339`.) Both default to
`null` (`packages/protocol/src/domain/settings.ts:116`, `:117`). Both are in
`FREELY_OVERRIDABLE` under `STRICT_OVERRIDE_POLICY`
(`settings.ts:59` to `:73`, `:86` to `:90`), so a caller may already set
them on `acquire` today with no capability change. `userAgent` is
share significant (`packages/router/src/router/reuse.ts:28`), so two callers
wanting different user agents correctly get different browsers rather than
one shared one with the wrong header. `examples/nextjs-demo/server.mjs:152`
passes `userAgent: null`, which is just the demo not setting it.

The field survives the store. `packages/router/src/router/specMapping.ts:47`
maps it in, `packages/store-sqlite/src/store.ts:644` writes it, and
`packages/store-sqlite/src/mappers.ts:212` reads it back.

Two defects sit underneath that:

* `runtime-host` never applies it. `buildLaunchArgs`
  (`packages/runtime-host/src/flags.ts:112` to `:164`) is the entire Chrome
  command line composition. It emits `--lang` from `spec.locale`
  (`flags.ts:132`) and sets `TZ` in the child environment from
  `spec.timezoneId` (`flags.ts:161`). There is no `--user-agent` anywhere in
  the file, and no `Emulation.setUserAgentOverride` anywhere in
  `packages/runtime-host/src`. `HostRuntime.capabilities()`
  (`packages/runtime-host/src/runtime.ts:130` to `:147`) advertises
  `timezonePerInstance: true` and `localePerInstance: true` and its `notes`
  array (`runtime.ts:116` to `:120`) does not mention the user agent gap at
  all. So on the default local runtime, `BrowserSpec.userAgent` is accepted,
  validated, stored, compared for reuse, and then silently dropped.
* Client hints never survive the store round trip.
  `packages/store-sqlite/src/mappers.ts:213` hardcodes `clientHints: null`
  when expanding a stored spec back into a `BrowserSpec`, regardless of what
  was set.

There is also no workaround. `--user-agent=` is not on `ARG_ALLOW`
(`packages/protocol/src/domain/arg-lists.ts:47` to `:58`), and
`isArgAllowed` rejects anything matching neither list (`arg-lists.ts:64` to
`:68`), so it cannot be smuggled through `extraArgs`.

`runtime-remote` does apply it, at
`packages/runtime-remote/src/spec-apply.ts:175` to `:184`, via
`Emulation.setUserAgentOverride` with `userAgentMetadata` built from
`spec.clientHints` (`spec-apply.ts:108` to `:122`), with a test at
`packages/runtime-remote/test/spec-apply.test.ts:72` to `:82`.

### Is setting it at LAUNCH sufficient for Cloudflare clearance cookies?

Yes, and it is strictly better than a runtime override. Three reasons.

It has no race. `cf_clearance` is bound to the user agent that was present
when the challenge was solved, and Cloudflare re challenges when a request
carrying the cookie presents a different one. What matters is that every
request from that profile, from the very first one, carries the same correct
string. `--user-agent=` is set on the process before Chrome makes any
request at all, and it governs both the outbound header and
`navigator.userAgent` with no window in which the two disagree.
`Emulation.setUserAgentOverride` applies from the moment it lands, so any
request the target issued before that carries the real Chrome user agent. On
the very first navigation of a fresh browser, that window is exactly where
the challenge happens.

It does not evaporate. `Emulation.setUserAgentOverride` is scoped to the CDP
session, and the same teardown documented at
`packages/core/src/session/session.ts:508` to `:519` applies: a cross origin
navigation mints a fresh session and drops it. A user agent override that
silently reverts mid flow is precisely how a clearance cookie gets
invalidated, and it reverts with no error to observe. A launch flag cannot
do this.

Reuse already agrees with it. `userAgent` being in
`SHARE_SIGNIFICANT_FIELDS` (`reuse.ts:23` to `:35`) means the router will
never hand a caller a shared browser whose user agent disagrees with what it
asked for. That guarantee only means something if the field is applied at
launch. If it were a runtime override, "the instance's user agent" would not
be a property of the instance at all, and the reuse check would be comparing
a value nobody had honoured.

When is a runtime override genuinely required? Only when the user agent must
change on an already running browser that BrowserGlass did not launch. That
is `runtime-remote`'s entire situation, and it is exactly why
`spec-apply.ts:175` exists there and nowhere else. On `runtime-host`, a user
agent change means a new instance, which the router already handles.

### The client hints half, which the flag alone does not cover

`--user-agent` changes the `User-Agent` header and `navigator.userAgent`. It
does not change the `Sec-CH-UA`, `Sec-CH-UA-Platform` or
`Sec-CH-UA-Full-Version-List` client hints, which keep reporting the real
Chrome brand and version. Any check that compares the two sees an
inconsistency. Chrome has no launch flag for client hints; the only way in is
`Emulation.setUserAgentOverride`'s `userAgentMetadata`, which is precisely
what `spec-apply.ts:180` already passes.

So the complete answer is: `--user-agent` at launch for the header and
`navigator.userAgent`, plus one gateway sent
`Emulation.setUserAgentOverride` carrying `userAgentMetadata` per target at
attach time to align the hints, rebound on the same seam as diagnostics
(`session.ts:521`). The gateway sends it because it is applying a
`BrowserSpec` field it owns. The tenant never sends it.

### Recommendation

Keep `Emulation` off `CDP_PASSTHROUGH_ALLOWLIST` entirely. Make
`BrowserSpec.userAgent` actually work instead. This is not a policy change,
it is a defect fix in `runtime-host` plus a mapper fix in `store-sqlite`.
A caller gets a per instance user agent through the field that was
designed for it, the router's reuse logic stays correct, the clearance
cookie stays valid across cross origin navigations, and no new capability is
granted to anybody.

What an operator loses by refusing the runtime override: nothing on
`runtime-host`. On `runtime-remote` an operator already has it, applied by
the gateway rather than by the tenant. A tenant that wants to change user
agent mid session must release and acquire a new instance, which is one
extra call and a cold Chrome start.

---

## 5. Router CDP routing

### Per target CDP sessions are already multiplexed

This is done, at the right layer, and has been for a while.

`packages/core/src/cdp/bridge.ts` holds one WebSocket to one Chrome and
multiplexes every target's CDP session over it, flattened:

* `Target.attachToTarget` with `{ targetId, flatten: true }`
  (`bridge.ts:377` to `:381`), returning a `sessionId` tracked in
  `sessionsBySessionId` (`bridge.ts:476`).
* `registerAutoAttachedSession` (`bridge.ts:412`) for sessions Chrome
  attaches on its own.
* Every outbound command carries its `sessionId` in the JSON-RPC frame
  (`bridge.ts:517`).
* Inbound events are demultiplexed by a `${sessionId} ${method}` key
  (`bridge.ts:589`), with per session handler sets (`bridge.ts:662` to
  `:667`) so a detach drops exactly that session's listeners.
* `detach(sessionId)` sends `Target.detachFromTarget`
  (`bridge.ts:721` to `:727`) and rejects that session's pending commands
  (`bridge.ts:748` to `:751`).

Above it, `SessionRegistry` (`packages/server/src/session/registry.ts`) maps
`instanceId` to one `ManagedSession`, with join in flight construction so
"two viewers attaching to the same Instance in the same tick share one
`CdpBridge`/`TargetRegistry`/`Session` triple, never race to build two"
(`registry.ts:1` to `:9`, `getOrCreate` at `:35`).

`ManagedSession.sendCdp(targetId, method, params)`
(`packages/server/src/session/managed-session.ts:2155` to `:2159`) resolves
the named target's live CDP session via `ensureAttached` and sends on it,
and deliberately does not re derive the allowlist decision
(`managed-session.ts:2148` to `:2153`).

### Multi tenant CDP routing already reaches across nodes

The full path exists today:

1. `BrowserRouter.driveInstance(instanceId, principal)`
   (`packages/router/src/router/BrowserRouter.ts:984` to `:1027`) is the
   authority gate. Tenant is checked structurally through the cache key
   (`driveCacheKey`, `BrowserRouter.ts:169`), scope through
   `assertScopeAllowsInstance` on both the cached path (`:995`) and the
   fresh path (`:1006`), drivability at `:1007` to `:1008`, activity touch
   at `:1025`, and an `instance.drive` audit event at `:1024`.
2. `BrowserRouter.dispatchAction` (`BrowserRouter.ts:1042` to `:1045`)
   resolves through that gate and calls
   `this.nodes.dispatch(resolution.nodeId, req)`.
3. `NodeActionRequest` already carries a scoped CDP variant:
   `{ kind: 'cdp'; instanceId; targetId; method; params }`
   (`packages/protocol/src/domain/extension-points.ts:357`), inside a
   deliberately small eight member vocabulary
   (`extension-points.ts:337` to `:348`).
4. `LocalNode.dispatch` (`packages/router/src/node/LocalNode.ts:317` to
   `:322`) delegates to an injected `NodeActionExecutor`
   (`LocalNode.ts:68` to `:70`), which is
   `packages/server/src/session/node-action-executor.ts`; its `cdp` case
   (`node-action-executor.ts:109` to `:117`) calls `managed.sendCdp`.
5. `WebSocketNodeTransport`
   (`packages/router/src/node/WebSocketNodeTransport.ts`) is the dial half,
   `packages/server/src/ws/peer-upgrade.ts:247` to `:248` is the accept half.
6. The REST CDP sender is wired at `packages/server/src/index.ts:261`.

So the answer to "should the router expose CDP routing" is that it already
does. A CDP command addressed to instance X target T reaches the correct
Chrome on the correct node, through the tenant and scope checks, whether the
instance is local or on a peer.

### What is genuinely missing

Taken from `docs/scaling.md:274` to `:311`, verified against the code:

1. Placement now crosses nodes, once a deployment is configured for it.
   `BrowserRouter.doAcquire`'s placement step merges this process's own
   live snapshot with every other live node the shared store reports
   (`remoteNodeSnapshots`), and `@browserglass/server`'s `buildRouterWiring`
   (`packages/server/src/lifecycle/wiring.ts:1170` to `:1222`) now builds a
   real `WebSocketNodeTransport` for `nodes:` whenever `config.peer
   .sharedSecret` is set, rather than always a bare `LocalNodeTransport`.
   Left unset, a deployment stays single node, which is the safe default,
   not a remaining ceiling; `NodeRegistry`'s own module doc, "the single
   node registry for an embedded, single node build"
   (`packages/router/src/node/NodeRegistry.ts:1` to `:9`), describes
   exactly that default case. See `scaling.md`'s "`buildRouterWiring` now
   dials a peer instead of only accepting one" for the full account.
2. `launch` forwarding now works too, under that same configuration.
   `BrowserRouter.doAcquire`'s candidate loop calls `NodeTransport.launch`
   with a foreign `nodeId` once `remoteNodeSnapshots` has put one in
   `candidates` and placement has picked it, and with `peer.sharedSecret`
   set, `WebSocketNodeTransport` and the peer listener's `launch` case
   carry that call to the peer instead of `LocalNodeTransport` rejecting it
   (`scaling.md:410` to `:436`).
3. A WS viewer cannot attach across nodes (`scaling.md:301` to `:306`). The
   streaming data path deliberately does not go through the router, so a
   viewer that connects to a gateway which does not own the instance has no
   redirect. This is the real ceiling for "collaborating". Two people on
   different gateway processes cannot watch the same browser today.
4. No browser exit push frame (`scaling.md:293` to `:300`).
   `onUnexpectedExit` is a documented no op for a remote instance.
5. Flat cluster trust. One shared secret, no per node credential, no TLS, no
   rotation without a coordinated restart (`scaling.md:307` to `:311`). This
   is deliberate, documented in `peer-upgrade.ts`'s own `handleHello` doc
   comment, and out of scope for item 6 below: a hello whose MAC verifies is
   accepted regardless of which node id it claims, and closing that would
   need a per node credential table this build does not have.
6. ~~The CDP allowlist was an edge check, not defence in depth~~, now fixed.
   `isCdpMethodAllowed` still runs at `targets.ts:296`, in the gateway that
   received the REST call, but `node-action-executor.ts`'s `cdp` case
   (`node-action-executor.ts:110` to `:150`) now calls the same
   `isCdpMethodAllowed` a second time, immediately before `managed.sendCdp`,
   and refuses when it fails. The refusal travels as `E_FORBIDDEN`, not the
   REST edge's own `E_CDP_METHOD_NOT_ALLOWED`: that code is a `RestError`
   only vocabulary, and this error instead crosses the peer wire through
   `WebSocketNodeTransport`'s `codeFromWire`
   (`packages/router/src/node/WebSocketNodeTransport.ts:96` to `:98`), which
   narrows any code outside `AcquireErrorCode`
   (`packages/router/src/router/errors.ts:13` to `:38`) down to
   `E_NODE_LOST`, discarding a bespoke code entirely; `E_FORBIDDEN` is that
   table's own 403, not retryable entry, the same semantics as the REST
   edge's 403, and the message (preserved verbatim, unlike the code) still
   names the refused method. So a peer's `dispatch` frame
   (`peer-upgrade.ts:247` to `:248`, `nodes.dispatch(nodeId, req)`) can no
   longer reach `Runtime.evaluate` or any other `REFUSED_DOMAINS`/
   `REFUSED_METHODS` entry on an instance this node owns, even though it
   still holds `peer.sharedSecret` and is still trusted to dispatch at all.
   The flat trust model itself (item 5) is unchanged: this only makes sure
   the allowlist decision is honoured on both doors into
   `ManagedSession.sendCdp`, not that a peer needs a distinct identity to
   dispatch in the first place.

### Where the concurrency ceiling actually is

In the order a growing deployment hits them:

| Ceiling | Value | Where |
|---|---|---|
| Event loop blocking | fixed, 1.45s to 0.59s per scan | measured locally during development |
| Streams per instance under `isolation: 'tab'` | exactly 1 | `entities.ts:324` to `:336`, `scaling.md:187` to `:204` |
| CDP commands per instance | one WebSocket, serialized | `bridge.ts:517`, `registry.ts:26` |
| Pool `maxInstances` | default 10, demo 20 | `scaling.md:138` to `:139`, `:148` |
| Tenant and app quota | whatever the `QuotaProvider` returns | `scaling.md:144` to `:150` |
| `maxConcurrentBrowsers` per node | default 64 | `runtime-host/src/runtime.ts:144` |
| Nodes usable for new instances | 1 by default, more once `peer.sharedSecret` is configured | `remoteNodeSnapshots` in `BrowserRouter.ts`; `wiring.ts:1170` to `:1222` |

The measured parallelism, from a local run against real Chrome:
three browsers at 2.96x speedup with 3 of 3 pairs overlapping, eight
browsers at 7.90x with 28 of 28 pairs overlapping, running navigate, reload,
evaluate and text concurrently. The core streaming, input and evaluate path
is genuinely parallel. The ceiling is not the CDP layer.

Per instance, all of one instance's targets share one WebSocket to Chrome,
so CDP commands across that instance's targets serialize on one socket. For
current workloads that is not the binding constraint, and it should not be
sharded speculatively; if it ever becomes one, the fix is more instances
rather than more sockets per instance.

---

## 6. Implementation plan

Ordered by ratio of value to risk. Each step is independently shippable.

### Step 1: make `BrowserSpec.userAgent` work on `runtime-host`

Effort: half a day. Impact: unblocks a per instance user agent and its
clearance cookies with no policy change at all.

* `packages/runtime-host/src/flags.ts`: in `buildLaunchArgs` (`:112`), emit
  a `--user-agent=` argument carrying `spec.userAgent` when it is non null,
  next to the existing `--lang` at `:132`. Validate the string (reject CR,
  LF and NUL, cap the length) before it reaches the command line.
* `packages/protocol/src/domain/arg-lists.ts`: add a `--user-agent` pattern
  to `ARG_DENY` (`:17`), so the spec field is the only way to set it and an
  `extraArgs` entry can never fight the resolved spec. It is already
  effectively denied by `ARG_ALLOW` omission; making it explicit puts it in
  the same category as `--proxy-server` and `--user-data-dir`, the other
  fields `BrowserSpec` owns.
* `packages/store-sqlite/src/mappers.ts:213`: stop hardcoding
  `clientHints: null`. Persist and rehydrate it, alongside the existing
  `user_agent` column handling at `:212`.
* `packages/runtime-host/src/runtime.ts`: add `userAgentPerInstance: true`
  to `capabilities()` (`:130`), matching the existing `timezonePerInstance`
  and `localePerInstance` pair, and extend `RuntimeCapabilities` in
  `packages/protocol/src/domain/runtime.ts`.
* Tests: `packages/runtime-host/test/` for flag composition;
  `packages/store-sqlite/test/store-crud.test.ts` for the client hints round
  trip.

### Step 2: gateway applied client hints alignment

Effort: 1 day. Impact: removes the user agent versus `Sec-CH-UA`
inconsistency that any modern anti bot check looks for.

* `packages/server/src/session/managed-session.ts`: on target attach, when
  the instance's resolved spec has a non null `userAgent`, send
  `Emulation.setUserAgentOverride` with `userAgentMetadata` derived from
  `spec.clientHints`. Reuse `toUserAgentMetadata` from
  `packages/runtime-remote/src/spec-apply.ts:108`, lifted into `protocol` so
  both runtimes share one mapping.
* Rebind it through `rebuildCaptureAndDiagnostics`
  (`packages/core/src/session/session.ts:521`), the same seam
  `TargetDiagnostics.rebind` uses, so a cross origin navigation does not
  silently drop it.
* `CDP_PASSTHROUGH_ALLOWLIST` is not touched. The gateway sends this; the
  tenant cannot.

### Step 3: fire the hooks that already exist

Effort: 2 to 3 days. Impact: makes four declared veto points real, and is a
prerequisite for step 4.

* Add `HookRegistry.dispatch(...)` call sites for `onInstanceLaunched`,
  `onSessionStarted`, `onViewerJoined`, `onControlGranted`, `onNavigation`,
  `onDownload`, `onRecovery`, `onInstanceReleased`, `onQuotaExceeded`. The
  natural homes are `packages/server/src/ws/connection.ts` (viewer join,
  control grant, navigation),
  `packages/server/src/session/managed-session.ts` (navigation, download),
  and `packages/server/src/lifecycle/` (launch, release).
* Honour the veto: `onNavigation` returning false must actually stop the
  navigation, not log and continue.
* Tests: one per hook, covering the timeout and the fail open or fail closed
  policy already declared at `packages/server/src/hooks/types.ts:147` to
  `:162`.

### Step 4: `onRequest`, the in process request gate

Effort: 3 to 4 days on top of step 3. Impact: solves the submit gate
case completely for a caller that embeds the gateway. No new capability, no wire change, no denylist
change.

* `packages/server/src/hooks/types.ts`: add `RequestEvent` (`sessionId`,
  `targetId`, `url`, `method`, `resourceType`, optional `postData`) and an
  `onRequest` veto hook to `Hooks` (`:127`). Add its `HOOK_TIMEOUTS` row
  (`:152`) with `vetoes: true, failClosed: true`, following `onDownload`'s
  precedent at `:158`, and a timeout in the 1000ms to 2000ms range.
* `packages/core/src/session/session.ts` plus a new
  `packages/core/src/interception/request-gate.ts`, modelled on
  `packages/core/src/diagnostics/target-diagnostics.ts`: own the `Fetch`
  domain, enable it at `requestStage: 'Request'` only, track enabled domains
  and disable exactly what it enabled (`target-diagnostics.ts:331` to
  `:355`), and expose `rebind(sessionId)` so `rebuildCaptureAndDiagnostics`
  (`session.ts:521`) can call it.
* The gate sends only `Fetch.continueRequest` with no modification fields,
  or `Fetch.failRequest` with `BlockedByClient`. Nothing else.
* Enable `Fetch` lazily, only when at least one `onRequest` handler is
  registered, mirroring the "opt in per target, do not pay for
  `Network.enable` unless asked" rule at
  `packages/protocol/src/wire/messages/diagnostics.ts:65`.
* `CDP_PASSTHROUGH_ALLOWLIST` and `REFUSED_DOMAINS` are not touched.

### Step 5: `request.gate.*`, the wire level gate

Effort: 1.5 to 2 weeks. Impact: the same capability for a caller that does
not operate the gateway. Only build this once step 4 is proven, and only if
callers need it from outside the gateway process.

* `packages/protocol/src/wire/messages/interception.ts`, new: the three
  message types, the bound constants (rule count, pattern length, hold
  deadline default and maximum, concurrent hold cap), and a module doc
  making the same argument `evaluate.ts:1` to `:80` makes, including the
  explicit sentence that `Fetch` stays in `REFUSED_DOMAINS`.
* `packages/protocol/src/wire/messages/index.ts`: export it, next to the
  existing `evaluate.js` export.
* `packages/protocol/src/wire/capabilities.ts`: add `'intercept'` to the
  `Capability` union (`:75`) and to `CAPABILITIES` (`:82`), raise `MAX_CAPS`
  from 20 to 21 (`:108`), leave every `ROLE_BUNDLES` entry unchanged
  (`:187`), and add an `INTERCEPT_BODY_CAPABILITY_RULE` to
  `PARAMETER_DEPENDENT_CAPABILITY_RULES` (`:292`) requiring `evaluate` when
  `includeRequestBody: true`.
* `packages/server/src/wire/capability-check.ts`: three
  `REQUIRED_CAPABILITY` rows (`:22`).
* `packages/server/src/ws/connection.ts`: three handlers next to
  `'page.evaluate'` (`:1365`), a rate limit bucket (`:1919`), and an audit
  line following `auditEvaluate`'s shape (`:1837`).
* `packages/server/src/session/managed-session.ts`: translate rules into the
  step 4 gate and route `request.gate.paused` to the registering viewer
  only.
* `packages/conformance/src/protocol/schema/wire-messages.schema.json`: the
  three new message schemas.
* Tests: `packages/server/test/ws/request-gate.test.ts` modelled on
  `packages/server/test/ws/page-evaluate.test.ts`, a capability denial case
  in `packages/protocol/test/wire/capabilities.test.ts`, and one test that
  proves the gate still gates after a cross origin navigation. That last one
  is the test that matters most; it is the fail open case.

### Step 6: cross node placement (done)

`packages/router/src/router/BrowserRouter.ts`'s `doAcquire` now merges
this process's own live snapshot with every other live node the shared
store reports (`remoteNodeSnapshots`/`persistNodeState`), and
`@browserglass/server`'s `buildRouterWiring`
(`packages/server/src/lifecycle/wiring.ts:1170` to `:1222`) now constructs
a real `WebSocketNodeTransport` for `nodes:` whenever `config.peer
.sharedSecret` is set, instead of always a bare `LocalNodeTransport`. This
makes `WebSocketNodeTransport.launch` genuinely reachable from production
wiring (`docs/scaling.md:425` to `:436`), not merely from
`placementCandidates` in isolation; the missing exit push frame
(`docs/scaling.md:437` to `:444`) is the one thing this closed step still
leaves unhandled. See `docs/scaling.md`'s "`buildRouterWiring` now dials a
peer instead of only accepting one" for the full account, and
`packages/router/test/router/cross-node-placement.test.ts` for coverage.

### Step 7: cross node viewer attach

Effort: 1 to 2 weeks. Impact: the actual ceiling on collaboration.

A viewer connecting to a gateway that does not own the instance needs a
redirect to the one that does. `BrowserRouter.attach`
(`BrowserRouter.ts:1050` to `:1069`, and the same placeholder again at
`:1925`) still returns an `attach.wsUrl` that is a `ws://local/`
placeholder built from the node id. Resolve it against the owning node's
`peer.dataPlaneUrl` (the same store read `resolveEndpoint` uses for the
control path, `wiring.ts:1216` to `:1220`) and have the client follow it;
`packages/server/src/ws/upgrade.ts` has no redirect logic for this today.
Documented as missing at `docs/scaling.md:445` to `:455`.

---

## Summary of recommendations

| Ask | Recommendation | Denylist change? | New capability? |
|---|---|---|---|
| Request interception | Gateway owned gate at Request stage. `onRequest` hook first, `request.gate.*` wire messages for a caller outside the gateway process. | No | `intercept`, only for step 5 |
| Raw `Fetch` passthrough | Refuse. The egress allowlist cannot cover `fulfillRequest`, and admitting it contradicts two existing `REFUSED_METHODS` entries. | n/a | n/a |
| User agent override | Fix `BrowserSpec.userAgent` on `runtime-host`, plus gateway applied client hints. Keep `Emulation` off the allowlist. | No | No |
| Router CDP routing | Already exists end to end. Cross node placement is done too, once `peer.sharedSecret` is configured; the remaining gap is cross node viewer attach, which is not a CDP problem. | No | No |
