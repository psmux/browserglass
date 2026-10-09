"""``AutomationClient``: a programmatic control surface over one ``bgls.v1``
session.

Mirrors ``packages/automation/src/client/AutomationClient.ts``. The
framing that matters is the same one the TypeScript SDK documents:
automation is a Viewer. ``connect()`` opens one ``bgls.v1`` socket and
registers as a Viewer with ``kind: 'automation'``, exactly like a human's
client. Every interaction method needs the same ``ControlLease`` a human
competes for, and every dispatched event is the same ``input.*`` message a
human's input capture would send. There is no back door.

A Python developer should not be able to tell the server is TypeScript:
every wire field is camelCase on the socket and snake_case on this
surface, and every failure raises a typed :class:`~browserglass.errors.AutomationError`
carrying one of the taxonomy codes rather than a bare exception.
"""

from __future__ import annotations

import asyncio
import inspect
import math
import time
import uuid
import weakref
from typing import Any, Awaitable, Callable, List, Mapping, Optional, Sequence, Union

from .binary import (
    HEADER_BYTES,
    MSG_TYPE_UPLOAD_CHUNK,
    PAYLOAD_CODEC_NONE,
    UPLOAD_CHUNK_ID_BYTES,
    encode_binary_header,
    encode_upload_chunk_payload,
)
from .core import AutomationCore
from .errors import AutomationError
from .keys import named_key_code, printable_key_code
from .launch import launch_instance
from .lease import ControlLeaseHandle
from .locator.engine import ENGINE_WORLD, LocatorEngine, LocatorRuntime
from .locator.types import ClickResult, FillResult, LocatorMatch, ResolveResult, SelectResult, WaitForResult
from .transport import SocketFactory
from .types import (
    A11yNode,
    A11yResult,
    ActionRecord,
    ConsoleEntry,
    ControlYieldEvent,
    DiagnosticsSubscription,
    DownloadResult,
    EvaluateWorld,
    GateEnableResult,
    GateRule,
    GateVerdict,
    InspectResult,
    NetworkRequestEntry,
    NetworkSummaryEntry,
    PageErrorEntry,
    RequestGatePausedEvent,
    ResponseBodyResult,
    ScreenshotResult,
    StatusResult,
    UploadFileInput,
)
from .worlds import check_world, guard_page_arguments

DEFAULT_EVALUATE_TIMEOUT_MS = 30000
MAX_EVALUATE_TIMEOUT_MS = 120000


def _pack_modifiers(mods: Optional[Sequence[str]]) -> int:
    """Packs a named modifier list into the CDP bit order (Alt 1, Ctrl 2,
    Meta 4, Shift 8)."""
    if not mods:
        return 0
    m = 0
    if "Alt" in mods:
        m |= 0x1
    if "Control" in mods:
        m |= 0x2
    if "Meta" in mods:
        m |= 0x4
    if "Shift" in mods:
        m |= 0x8
    return m


def _hex_to_bytes(hex_str: str) -> bytes:
    return bytes.fromhex(hex_str)


async def _sleep_ms(ms: float) -> None:
    await asyncio.sleep(max(0.0, ms) / 1000)


def build_wait_for_text_predicate(selector: str, text: str, exact: bool) -> str:
    """The page-side predicate :meth:`AutomationClient.wait_for_text` hands
    to :meth:`AutomationClient.wait_for_function`. ``selector`` and
    ``text`` are embedded as JSON literals, never string-concatenated, so
    a caller's text containing a quote or a backslash cannot break out of
    the generated expression."""
    import json

    sel_json = json.dumps(selector)
    text_json = json.dumps(text)
    cmp = "norm === needle" if exact else "norm.indexOf(needle) >= 0"
    return "\n".join(
        [
            "(function () {",
            f"  var els = document.querySelectorAll({sel_json});",
            f"  var needle = {text_json}.replace(/\\s+/g, ' ').trim().toLowerCase();",
            "  for (var i = 0; i < els.length; i++) {",
            "    var norm = (els[i].textContent || \"\").replace(/\\s+/g, \" \").trim().toLowerCase();",
            f"    if ({cmp}) return norm;",
            "  }",
            "  return false;",
            "})()",
        ]
    )


class Diagnostics:
    """``client.diagnostics.subscribe()``/``unsubscribe()``: console,
    page-error and network capture for the bound target. Not gated by a
    held :class:`~browserglass.lease.ControlLeaseHandle`: reading a
    target's console is not an interaction with it."""

    def __init__(self, client: "AutomationClient") -> None:
        self._client = client

    async def subscribe(
        self, *, console: Optional[bool] = None, errors: Optional[bool] = None, network: Optional[bool] = None
    ) -> DiagnosticsSubscription:
        c = self._client
        target_id = c.target_id
        if not c._core.has_capability("devtools"):
            raise AutomationError("POLICY_DENIED", "diagnostics.subscribe() needs the 'devtools' capability", {"required": "devtools"})
        payload: dict = {"targetId": target_id}
        if console is not None:
            payload["console"] = console
        if errors is not None:
            payload["errors"] = errors
        if network is not None:
            payload["network"] = network
        reply = await c._core.request("diagnostics.subscribe", payload)
        # Read from the reply, not the request: what the server actually
        # turned on can differ from what was asked, and this is exactly
        # the value wait_for_network_idle() needs to fail fast on rather
        # than trusting the request.
        c._core.set_network_feed_subscribed(target_id, reply["network"])
        return DiagnosticsSubscription(target_id=reply["targetId"], console=reply["console"], errors=reply["errors"], network=reply["network"])

    async def unsubscribe(self) -> None:
        c = self._client
        target_id = c.target_id
        c._core.set_network_feed_subscribed(target_id, False)
        await c._core.send("diagnostics.unsubscribe", {"targetId": target_id})

    async def response_body(self, request_id: str, *, timeout_ms: Optional[float] = None) -> ResponseBodyResult:
        """Reads the response body Chrome already buffered for
        ``request_id``, the id off a ``network`` event this client was
        actually sent for this target (``client.on("network", ...)``,
        after ``diagnostics.subscribe(network=True)``). Requires
        ``devtools``, checked locally so a caller lacking it fails fast
        rather than paying a round trip for the server to refuse it.
        There is no other source for a ``request_id``: a guessed one
        (real or not) is refused server side regardless of what this
        local check lets through.

        Motivating case: a single page application form submission
        whose only visible outcome IS the submit response's own body,
        with nothing on screen changing either way. Subscribe to
        ``network``, click submit, read the matching ``network`` event's
        ``request_id`` off the submit URL, then read its body here to
        learn what actually happened.

        The body is not durable: it lives only as long as Chrome's own
        per-request buffer does, which a navigation clears outright. A
        read attempted too late (or of a request that never had a body,
        a redirect or a ``204``) raises :class:`~browserglass.errors.AutomationError`
        with code ``NOT_FOUND`` rather than resolving with an empty
        string, so "gone" and "empty" stay two different,
        distinguishable answers. A body larger than the server's own
        ceiling raises code ``POLICY_DENIED`` rather than arriving
        truncated.
        """
        c = self._client
        target_id = c.target_id
        if not c._core.has_capability("devtools"):
            raise AutomationError("POLICY_DENIED", "diagnostics.response_body() needs the 'devtools' capability", {"required": "devtools"})

        async def fn() -> ResponseBodyResult:
            reply = await c._core.request("page.responsebody.get", {"targetId": target_id, "requestId": request_id}, timeout_ms)
            return ResponseBodyResult(body=reply["body"], base64_encoded=reply["base64Encoded"], size_bytes=reply["sizeBytes"])

        return await c._run("responseBody", target_id, [], False, {"requestId": request_id}, False, fn)


def _gate_rule_to_wire(rule: GateRule) -> dict:
    wire: dict = {"urlPattern": rule.url_pattern, "verdict": rule.verdict}
    if rule.methods is not None:
        wire["methods"] = list(rule.methods)
    if rule.resource_types is not None:
        wire["resourceTypes"] = list(rule.resource_types)
    if rule.include_request_body:
        wire["includeRequestBody"] = True
    if rule.on_timeout is not None:
        wire["onTimeout"] = rule.on_timeout
    if rule.hold_ms is not None:
        wire["holdMs"] = rule.hold_ms
    return wire


class Gate:
    """``client.gate``: a say in whether each outbound request the bound
    target makes is allowed to leave. Requires the ``intercept``
    capability, plus ``evaluate`` when a rule sets
    ``include_request_body``.

    Mirrors ``AutomationClient.gate`` in the TypeScript SDK. Read
    ``packages/protocol/src/wire/messages/interception.ts``'s module doc
    before changing anything here: the safety of this feature rests on
    the SHAPE of what crosses the wire, not on a runtime check somewhere
    that has to be right every time. ``Fetch`` stays refused on the CDP
    passthrough deny list and this is not a hole in it: the gateway owns
    the domain, enables it at the Request stage only, and the vocabulary
    a caller gets is exactly two words (:data:`~browserglass.types.GateVerdict`,
    ``'allow'`` or ``'deny'``). There is deliberately nowhere on this
    surface to put a rewritten URL, method, header or body, and that
    absence is the entire security argument, not an oversight to be
    tidied up later.
    """

    def __init__(self, client: "AutomationClient") -> None:
        self._client = client

    async def enable(self, rules: Sequence[GateRule]) -> GateEnableResult:
        """Installs, or replaces, the rule set for the bound target.

        Replaces wholesale rather than merging, so a caller always knows
        the complete set in force. Prefer rules that name ``verdict``
        ``'allow'`` or ``'deny'`` outright: those are decided server
        side with no round trip and cannot time out. ``verdict='ask'``
        is what produces a pause, and a pause holds a real Chrome
        network slot until it is answered.

        Read ``rule_count`` on the result rather than assuming your own
        list length survived.
        """
        c = self._client
        target_id = c.target_id
        if not c._core.has_capability("intercept"):
            raise AutomationError("POLICY_DENIED", "gate.enable() needs the 'intercept' capability", {"required": "intercept"})
        # Checked locally so a caller fails fast rather than paying a
        # round trip to be refused. The server checks it again
        # regardless: a client side capability check is a courtesy,
        # never an authority.
        if any(r.include_request_body for r in rules) and not c._core.has_capability("evaluate"):
            raise AutomationError(
                "POLICY_DENIED",
                "gate.enable() with include_request_body needs the 'evaluate' capability as well as 'intercept': a "
                "request body carries whatever the user typed, and a caller who can already run script in the page "
                "can already read it",
                {"required": "evaluate"},
            )
        reply = await c._core.request("request.gate.enable", {"targetId": target_id, "rules": [_gate_rule_to_wire(r) for r in rules]})
        return GateEnableResult(target_id=reply["targetId"], rule_count=reply["ruleCount"])

    async def disable(self) -> None:
        """Removes the rule set and disables the gate for the bound
        target."""
        c = self._client
        await c._core.request("request.gate.disable", {"targetId": c.target_id})

    async def resolve(self, gate_id: str, verdict: GateVerdict) -> None:
        """Answers one held request.

        Takes a verdict and nothing else, permanently. See this class's
        own docstring.
        """
        c = self._client
        await c._core.send("request.gate.resolve", {"targetId": c.target_id, "gateId": gate_id, "verdict": verdict})

    def on_paused(self, handler: Callable[[RequestGatePausedEvent], Union[GateVerdict, Awaitable[GateVerdict]]]) -> Callable[[], None]:
        """Registers ``handler`` for every held request on the bound
        target and answers each one with what it returns, which is the
        shape almost every caller actually wants: it removes the chance
        of forgetting to resolve a pause, which is how a page ends up
        hanging on a request nobody is ever going to answer, holding a
        real Chrome network slot until its deadline.

        ``handler`` may be a plain function or a coroutine function. A
        handler that raises (or whose awaited result raises) answers
        ``'deny'``, matching the server side default for a rule's
        ``on_timeout`` and the gate's own policy: a gate that fails open
        is not a gate. Returns its own unsubscribe, which does NOT
        disable the gate; call :meth:`disable` for that.
        """
        c = self._client
        target_id = c.target_id

        def _on(ev: RequestGatePausedEvent) -> None:
            if ev.target_id != target_id:
                return

            async def _answer() -> None:
                try:
                    result = handler(ev)
                    if inspect.isawaitable(result):
                        result = await result
                    verdict: GateVerdict = "allow" if result == "allow" else "deny"
                except Exception:
                    verdict = "deny"
                await c._core.send("request.gate.resolve", {"targetId": target_id, "gateId": ev.gate_id, "verdict": verdict})

            asyncio.ensure_future(_answer())

        return c._core.emitter.on("gatepaused", _on)


class Tabs:
    """``client.tabs``: list, open, close, and activate tabs (Targets),
    gated on the ``tabs.manage`` capability.

    Mirrors ``AutomationClient.tabs`` in the TypeScript SDK. Each verb is
    one ``target.*`` request/reply with no orchestration beyond the
    capability check, run through :meth:`AutomationClient._run` (unlike
    :class:`Diagnostics`/:class:`Gate` above, which skip it): the
    TypeScript ``tabs`` object does the same, so a tab operation shows up
    in ``on_action`` and counts against the step budget the way
    ``navigate()`` does, while a diagnostics subscribe or a gate verdict
    does not.

    A tab is reported here exactly as the wire's own ``TargetSummary``
    (``targetId``, ``kind``, ``title``, ``url``, ``active``, ...): a plain
    ``Mapping``, the same shape :attr:`AutomationClient.targets` already
    uses, rather than a dedicated dataclass this package would then have
    to keep in lockstep with the wire by hand.
    """

    def __init__(self, client: "AutomationClient") -> None:
        self._client = client

    async def list(self) -> List[Mapping[str, Any]]:
        """Every Target on this connection's instance, via ``target.list``."""
        c = self._client

        async def fn() -> List[Mapping[str, Any]]:
            reply = await c._core.request("target.list", {})
            return list(reply["targets"])

        return await c._run("tabs.list", c.target_id, ["tabs.manage"], False, None, False, fn)

    async def open(self, *, url: Optional[str] = None, background: Optional[bool] = None) -> Mapping[str, Any]:
        """Opens a new tab (``target.new``), returning its
        ``TargetSummary``. The one non-idempotent tab verb: calling it
        again opens a second tab, never reuses the first."""
        c = self._client
        payload: dict = {}
        if url is not None:
            payload["url"] = url
        if background is not None:
            payload["background"] = background

        async def fn() -> Mapping[str, Any]:
            reply = await c._core.request("target.new", payload)
            return reply["target"]

        return await c._run("tabs.open", c.target_id, ["tabs.manage"], False, dict(payload) if payload else None, False, fn)

    async def close(self, target_id: str) -> None:
        """Closes ``target_id`` (``target.close``)."""
        c = self._client

        async def fn() -> None:
            await c._core.request("target.close", {"targetId": target_id})

        await c._run("tabs.close", target_id, ["tabs.manage"], False, None, False, fn)

    async def activate(self, target_id: str) -> None:
        """Brings ``target_id`` to the front (``target.activate``)."""
        c = self._client

        async def fn() -> None:
            await c._core.request("target.activate", {"targetId": target_id})

        await c._run("tabs.activate", target_id, ["tabs.manage"], False, None, False, fn)

    async def active(self) -> Optional[Mapping[str, Any]]:
        """The Target currently ``active`` in its own window, or ``None``.
        No wire round trip: read off this connection's own cached target
        list, same as :attr:`AutomationClient.targets`."""
        c = self._client

        async def fn() -> Optional[Mapping[str, Any]]:
            return next((t for t in c._core.targets if t.get("active")), None)

        return await c._run("tabs.active", c.target_id, ["tabs.manage"], False, None, False, fn)


class _ReleaseState:
    """What ``release()`` needs for a client that ``launch()`` opened, keyed
    by the shared core so a ``for_target()`` sub-client releases the same
    browser. A client from ``connect()`` has no entry, and its
    ``release()`` only closes the socket."""

    def __init__(self, end_browser: Callable[[], Awaitable[None]]) -> None:
        self.end_browser = end_browser
        self.done: Optional["asyncio.Task[None]"] = None


_launched: "weakref.WeakKeyDictionary[AutomationCore, _ReleaseState]" = weakref.WeakKeyDictionary()


class AutomationClient:
    def __init__(self, core: AutomationCore, target_id: str) -> None:
        self._core = core
        self._target_id = target_id
        self.diagnostics = Diagnostics(self)
        self.gate = Gate(self)
        self.tabs = Tabs(self)
        self._locator_engine: Optional[LocatorEngine] = None

    # ------------------------------------------------------------------
    # Connect
    # ------------------------------------------------------------------

    @classmethod
    async def connect(
        cls,
        *,
        endpoint: str,
        token: str,
        instance_id: Optional[str] = None,
        target_id: Optional[str] = None,
        default_timeout_ms: float = 15000,
        step_budget: float = math.inf,
        dry_run: bool = False,
        on_action: Optional[Callable[[ActionRecord], None]] = None,
        release_on_yield: bool = True,
        socket_factory: Optional[SocketFactory] = None,
        ping_interval_s: Optional[float] = 5.0,
    ) -> "AutomationClient":
        """Opens one ``bgls.v1`` connection and binds to a target.
        Resolves once ``welcome`` has been processed.

        ``instance_id``, when given, is validated against
        ``welcome.instance.instanceId``: this build's ``hello`` carries no
        instance-selection field of its own, so the token's own scope is
        what actually pins the instance server side.
        """
        core = AutomationCore(
            endpoint=endpoint,
            token=token,
            default_timeout_ms=default_timeout_ms,
            dry_run=dry_run,
            step_budget=step_budget,
            on_action=on_action,
            release_on_yield=release_on_yield,
            socket_factory=socket_factory,
            ping_interval_s=ping_interval_s,
        )
        await core.connect()

        if instance_id is not None and core.instance_id != instance_id:
            await core.close()
            raise AutomationError(
                "INSTANCE_GONE",
                f"connected instance '{core.instance_id}' does not match requested instance_id '{instance_id}'",
            )

        tid = target_id
        if tid is None:
            active = next((t for t in core.targets if t.get("active")), None)
            if active is not None:
                tid = active["targetId"]
            elif core.targets:
                tid = core.targets[0]["targetId"]
        if tid is None:
            await core.close()
            raise AutomationError("NOT_FOUND", "no target available to bind to; pass target_id")

        return cls(core, tid)

    @classmethod
    async def launch(
        cls,
        *,
        gateway: Optional[str] = None,
        admin_token: Optional[str] = None,
        headless: bool = True,
        viewport: Optional[Mapping[str, Any]] = None,
        profile_key: Optional[str] = None,
        caps: Optional[Sequence[str]] = None,
        control: bool = True,
        ready_timeout_s: float = 60.0,
        poll_interval_s: float = 0.25,
        browser: Optional[Mapping[str, Any]] = None,
        subject: Optional[str] = None,
        sticky_within_ms: Optional[float] = None,
        default_timeout_ms: float = 15000,
        step_budget: float = math.inf,
        on_action: Optional[Callable[[ActionRecord], None]] = None,
        release_on_yield: bool = True,
        socket_factory: Optional[SocketFactory] = None,
        http_client: Optional[Any] = None,
    ) -> "AutomationClient":
        """Starts a browser on a running gateway and returns a client
        connected to it, in one call. Does the REST plumbing a script would
        otherwise carry by hand: acquire with a fresh ``requestId``, wait
        for ``ready``, mint a socket ticket with ``caps``, connect, and
        (with ``control``, the default) take the control lease so the first
        ``navigate()`` just works.

        ``gateway`` defaults to ``BGLS_URL``, then
        ``http://127.0.0.1:7799/browserglass``. ``admin_token`` defaults to
        ``BGLS_ADMIN_TOKEN``; get one with ``pnpm bgls token`` where
        ``bgls serve`` runs. ``caps`` defaults to the ``agent`` bundle
        (:data:`browserglass.launch.DEFAULT_LAUNCH_CAPS`), which makes every
        method on this class usable. Pass ``control=False`` for a client
        that watches rather than drives, or that wants to call
        ``acquire_control()`` itself with its own options.

        Call :meth:`release` when done; it ends the browser. If anything
        fails after the browser was started, the browser is ended again
        before this raises::

            client = await AutomationClient.launch()
            try:
                await client.navigate("https://example.com")
                print(await client.text())
            finally:
                await client.release()
        """
        instance = await launch_instance(
            gateway=gateway,
            admin_token=admin_token,
            headless=headless,
            viewport=viewport,
            profile_key=profile_key,
            caps=caps,
            ready_timeout_s=ready_timeout_s,
            poll_interval_s=poll_interval_s,
            browser=browser,
            subject=subject,
            sticky_within_ms=sticky_within_ms,
            http_client=http_client,
        )
        try:
            client = await cls.connect(
                endpoint=instance.ws_url,
                token=instance.ticket,
                instance_id=instance.instance_id,
                default_timeout_ms=default_timeout_ms,
                step_budget=step_budget,
                on_action=on_action,
                release_on_yield=release_on_yield,
                socket_factory=socket_factory,
            )
        except BaseException:
            try:
                await instance.release()
            except Exception:
                pass
            raise
        _launched[client._core] = _ReleaseState(instance.release)
        if control:
            try:
                await client.acquire_control()
            except BaseException:
                try:
                    await client.release()
                except Exception:
                    pass
                raise
        return client

    async def release(self) -> None:
        """Closes the socket and, for a client from :meth:`launch`, ends the
        browser (``DELETE /v1/instances/:id?force=true``, retried on
        ``E_TERMINATE_FAILED``). Idempotent: a second call waits on the
        first. If ending the browser fails, the error is raised and the
        next call tries again. For a client from :meth:`connect` this is
        the same as :meth:`close`, since this client did not start the
        browser."""
        state = _launched.get(self._core)
        try:
            await self._core.close()
        except Exception:
            pass
        if state is None:
            return
        if state.done is None:
            state.done = asyncio.ensure_future(state.end_browser())
        task = state.done
        try:
            await asyncio.shield(task)
        except BaseException:
            if task.done() and state.done is task:
                state.done = None
            raise

    @property
    def holds_control(self) -> bool:
        """Whether this client holds the control lease on :attr:`target_id` right now."""
        return self._core.has_control(self._target_id)

    # ------------------------------------------------------------------
    # Binding and lease
    # ------------------------------------------------------------------

    @property
    def target_id(self) -> str:
        return self._target_id

    @property
    def viewer_id(self) -> Optional[str]:
        return self._core.viewer_id

    @property
    def session_id(self) -> Optional[str]:
        return self._core.session_id

    @property
    def instance_id(self) -> Optional[str]:
        return self._core.instance_id

    @property
    def granted(self) -> frozenset:
        return frozenset(self._core.granted)

    @property
    def targets(self) -> Sequence[Mapping[str, Any]]:
        return self._core.targets

    def use_target(self, target_id: str) -> None:
        """Rebinds this client to a different target on the same socket.
        Does not affect any lease already held on another target."""
        self._target_id = target_id

    def for_target(self, target_id: str) -> "AutomationClient":
        """A sub-client bound to a different target, sharing this
        client's socket, capability grants, and step budget."""
        return AutomationClient(self._core, target_id)

    async def acquire_control(
        self,
        *,
        wait_ms: float = 30000,
        duration_ms: float = 60000,
        auto_renew: bool = True,
        reason: Optional[str] = None,
    ) -> ControlLeaseHandle:
        """Requests the ``ControlLease`` on :attr:`target_id`.

        Refuses immediately with ``POLICY_DENIED`` when called inside the
        ``requeueAfterMs`` backoff window left by a prior preemption on
        this target, or while a preemption request is in progress: agent
        obligations on preemption require never re-requesting control
        before that window elapses, and this is the SDK enforcing that
        contract rather than trusting the caller.

        The returned handle's ``mode`` is ``'exclusive'`` or ``'shared'``,
        echoing the wire's ``control.granted.mode``: a shared target has
        no queue and grants immediately, and a person taking over on it
        surfaces through :meth:`on_control_yield` instead of the
        exclusive-mode preemption handshake. See ``LeaseMode`` in the
        protocol's ``control.ts`` for the full contract this SDK does not
        re-decide, only reflects.
        """
        target_id = self._target_id
        if not self._core.has_capability("control"):
            raise AutomationError("POLICY_DENIED", "acquire_control() needs the 'control' capability", {"required": "control"})

        pending_yield = self._core.yield_for(target_id)
        if pending_yield is not None and pending_yield.phase == "requested":
            raise AutomationError(
                "POLICY_DENIED",
                f"acquire_control() refused: {pending_yield.by_label or 'another viewer'} is taking control of "
                f"{target_id} right now and this client has stood down",
                {
                    "yielded": True,
                    "phase": pending_yield.phase,
                    "reason": pending_yield.reason,
                    "human": pending_yield.human,
                    "byLabel": pending_yield.by_label,
                    **({"retryAfter": pending_yield.deadline} if pending_yield.deadline is not None else {}),
                },
            )
        blocked_until = self._core.requeue_blocked_until.get(target_id)
        if blocked_until is not None and time.time() * 1000 < blocked_until:
            ev = self._core.yield_for(target_id)
            raise AutomationError(
                "POLICY_DENIED",
                "acquire_control() refused: still inside the requeueAfterMs backoff window from a recent preemption",
                {
                    "retryAfterMs": blocked_until - time.time() * 1000,
                    "retryAfter": blocked_until,
                    **({"yielded": True, "reason": ev.reason, "human": ev.human, "byLabel": ev.by_label} if ev is not None else {}),
                },
            )
        self._core.consume_step()

        started_at = time.time() * 1000
        cid = self._core.new_id()
        try:
            # `begin_wait()`, not `await_message()`: it subscribes
            # synchronously, before `transport.send()` below can race it.
            # See `Transport.begin_wait`'s own doc for why the plain
            # `async def` form does not give that guarantee in Python.
            wait_for = self._core.begin_wait(lambda m: m.get("re") == cid, wait_ms if wait_ms != 0 else self._core.default_timeout_ms)
            await self._core.transport.send(
                "control.request",
                {"id": cid, "targetId": target_id, "ttlMs": duration_ms, "queue": wait_ms != 0, **({"reason": reason} if reason is not None else {})},
            )
            reply = await wait_for

            if reply.get("t") == "control.queued":
                remaining = self._core.default_timeout_ms if wait_ms == 0 else max(0.0, wait_ms - (time.time() * 1000 - started_at))
                reply = await self._core.await_message(lambda m: m.get("re") == cid and m.get("t") in ("control.granted", "error"), remaining)

            if reply.get("t") == "error":
                raise AutomationError.from_error_msg(reply)
            if reply.get("t") == "control.denied":
                raise AutomationError(
                    "POLICY_DENIED",
                    reply.get("message", "control request denied"),
                    {"reason": reply.get("reason"), **({"holderLabel": reply["holderLabel"]} if "holderLabel" in reply else {})},
                )

            lease = ControlLeaseHandle(self._core, target_id, reply, auto_renew)
            self._core.leases[target_id] = lease
            self._core._end_stand_down(target_id)
            self._core.record_action(ActionRecord(action="acquireControl", target_id=target_id, ok=True, duration_ms=time.time() * 1000 - started_at))
            return lease
        except Exception as err:
            wrapped = err if isinstance(err, AutomationError) else AutomationError("PROTOCOL_ERROR", str(err))
            self._core.record_action(
                ActionRecord(
                    action="acquireControl", target_id=target_id, ok=False, duration_ms=time.time() * 1000 - started_at,
                    error={"code": wrapped.code, "message": wrapped.message},
                )
            )
            raise wrapped

    async def release_control(self) -> None:
        """Releases the lease this client holds on :attr:`target_id`, if
        any. A no-op if no lease is held."""
        lease = self._core.leases.get(self._target_id)
        if lease is None:
            return
        await lease.release()

    # ------------------------------------------------------------------
    # Standing down: a human takes the browser back
    # ------------------------------------------------------------------

    def on_control_yield(self, cb: Callable[[ControlYieldEvent], None]) -> Callable[[], None]:
        """Fires whenever this connection stands down on any target: a
        human (or a higher-priority agent) asked for control, control was
        actually taken, or :meth:`yield_control` was called.

        Connection-wide on purpose: registered once, at connect time, it
        keeps firing across every ``acquire_control()`` on every target,
        which is what an agent driving many browsers actually needs.
        Returns its own unsubscribe.
        """
        self._core.yield_cbs.add(cb)
        return lambda: self._core.yield_cbs.discard(cb)

    def yield_status(self, target_id: Optional[str] = None) -> Optional[ControlYieldEvent]:
        """The stand-down currently in force on ``target_id`` (default
        :attr:`target_id`), or ``None`` when this client is free to drive
        it."""
        return self._core.yield_for(target_id if target_id is not None else self._target_id)

    async def yield_control(self, reason: Optional[str] = None) -> None:
        """Stands down on :attr:`target_id` deliberately: stops
        dispatching and releases the lease, without waiting to be asked."""
        target_id = self._target_id
        await self.release_control()
        self._core._stand_down(
            ControlYieldEvent(
                target_id=target_id, phase="taken", reason="voluntary", by_label="", by_kind="automation",
                human=False, deadline=None, in_flight=self._core.in_flight_for(target_id), resume_not_before=None,
            )
        )
        self._core.record_action(
            ActionRecord(action="yieldControl", target_id=target_id, ok=True, duration_ms=0, args={"reason": reason} if reason is not None else None)
        )

    async def wait_for_resume(self, *, timeout_ms: Optional[float] = None) -> None:
        """Waits until this client would be allowed to ask for control of
        :attr:`target_id` again, then resolves. Does NOT acquire
        anything: :meth:`acquire_control` is what ends the stand-down.

        Waits for BOTH: the backoff window to elapse, AND the target to
        stop being held by somebody else. Nothing in this SDK ever
        re-acquires control on its own, on a timer or otherwise.

        The handover has to have actually happened. Straight after
        :meth:`yield_control` the lease table can still name this client,
        and a moment later it names nobody, so "nobody else holds it" is
        true before any person has had the browser. While a stand-down is
        in force this therefore waits until a different viewer has held
        control at some point since it began, and only then for that viewer
        to let go. If nobody ever takes control it keeps waiting until
        ``timeout_ms`` (default: forever) and then raises ``TIMEOUT``; it
        never decides on its own that nobody is coming. With no stand-down
        in force it waits only for the backoff and for nobody else to hold
        the target::

            await client.yield_control("need a person to solve the captcha")
            await client.wait_for_resume(timeout_ms=10 * 60_000)
            await client.acquire_control()
        """
        target_id = self._target_id
        deadline_ms = math.inf if timeout_ms is None else timeout_ms
        started_at = time.time() * 1000

        def remaining() -> float:
            return deadline_ms - (time.time() * 1000 - started_at)

        blocked_until = self._core.requeue_blocked_until.get(target_id)
        if blocked_until is not None and time.time() * 1000 < blocked_until:
            wait_ms = blocked_until - time.time() * 1000
            if wait_ms > remaining():
                raise AutomationError(
                    "TIMEOUT", f"wait_for_resume() timed out after {timeout_ms}ms: {wait_ms}ms of requeue backoff still to run", {"retryAfter": blocked_until}
                )
            await _sleep_ms(wait_ms)

        def awaiting_handover() -> bool:
            return self._core.yield_for(target_id) is not None and target_id not in self._core.other_holder_seen

        while awaiting_handover() or self._core.someone_else_holds(target_id):
            left = remaining()
            if left <= 0:
                if awaiting_handover():
                    raise AutomationError(
                        "TIMEOUT", f"wait_for_resume() timed out after {timeout_ms}ms: nobody else took control of {target_id} after this client stood down"
                    )
                state = self._core.lease_state_by_target.get(target_id)
                holder = state.get("holderLabel") if state else None
                raise AutomationError("TIMEOUT", f"wait_for_resume() timed out after {timeout_ms}ms: {holder or 'someone else'} still holds control of {target_id}")
            try:
                await self._core.await_message(lambda m: m.get("t") == "control.state", left)
            except AutomationError as err:
                # Out of time with no new broadcast: go round once more so
                # the error names what was still missing.
                if err.code == "TIMEOUT" and remaining() <= 0:
                    continue
                raise

    async def close(self) -> None:
        """Closes the connection. Best-effort releases every lease this
        client holds first. Terminal."""
        await self._core.close()

    # ------------------------------------------------------------------
    # Navigation
    # ------------------------------------------------------------------

    async def navigate(
        self,
        url: str,
        *,
        referrer: Optional[str] = None,
        wait_until: str = "load",
        timeout_ms: float = 30000,
    ) -> StatusResult:
        """Navigates :attr:`target_id` to ``url`` and returns once the page
        has loaded, so reading the page straight after ``await
        navigate(url)`` sees the new document (its real ``title``,
        ``loading`` False).

        ``wait_until`` picks when this returns:

        * ``"load"`` (the default): after the new document's ``load``
          event. If the page has not loaded within ``timeout_ms`` this
          still returns, with ``loading`` True, rather than raising.
        * ``"commit"``: as soon as the navigation commits, with the page
          still loading (``loading`` True, usually an empty ``title``).
        * ``"networkidle"``: not implemented by the gateway, which refuses
          it.

        Needs ``navigate`` and a held control lease.
        """
        payload: dict = {"targetId": self._target_id, "url": url, "waitUntil": wait_until}
        if referrer is not None:
            payload["referrer"] = referrer
        if wait_until == "load":
            payload["timeoutMs"] = timeout_ms

        async def fn() -> StatusResult:
            # When waiting for load the gateway answers by timeout_ms at the
            # latest; wait a little longer here so its honest loading=True
            # reply wins over a client side TIMEOUT.
            reply = await self._core.request(
                "nav.goto",
                payload,
                max(self._core.default_timeout_ms, timeout_ms + 5000) if wait_until == "load" else None,
            )
            return self._nav_state_to_status(reply)

        return await self._run("navigate", self._target_id, ["navigate"], True, {"url": url}, False, fn)

    async def go_back(self) -> StatusResult:
        async def fn() -> StatusResult:
            return self._nav_state_to_status(await self._core.request("nav.back", {"targetId": self._target_id}))

        return await self._run("goBack", self._target_id, ["navigate"], True, None, False, fn)

    async def go_forward(self) -> StatusResult:
        async def fn() -> StatusResult:
            return self._nav_state_to_status(await self._core.request("nav.forward", {"targetId": self._target_id}))

        return await self._run("goForward", self._target_id, ["navigate"], True, None, False, fn)

    async def reload(self, *, ignore_cache: Optional[bool] = None) -> StatusResult:
        async def fn() -> StatusResult:
            payload = {"targetId": self._target_id}
            if ignore_cache is not None:
                payload["ignoreCache"] = ignore_cache
            return self._nav_state_to_status(await self._core.request("nav.reload", payload))

        return await self._run("reload", self._target_id, ["navigate"], True, None, False, fn)

    async def stop(self) -> None:
        async def fn() -> None:
            await self._core.send("nav.stop", {"targetId": self._target_id})

        await self._run("stop", self._target_id, ["navigate"], True, None, False, fn)

    async def status(self) -> StatusResult:
        """URL, title, loading state, history, and the current lease
        holder for :attr:`target_id`. No CDP traffic: built entirely from
        cached broadcasts. Requires only ``view``."""
        target_id = self._target_id

        async def fn() -> StatusResult:
            target = next((t for t in self._core.targets if t.get("targetId") == target_id), None)
            nav = self._core.nav_state_by_target.get(target_id)
            if target is None and nav is None:
                raise AutomationError("TARGET_CLOSED", f"no such target: {target_id}")
            holder_id, holder_label = self._lease_holder_for(target_id)
            return StatusResult(
                target_id=target_id,
                url=(nav or {}).get("url", (target or {}).get("url", "")),
                title=(nav or {}).get("title", (target or {}).get("title", "")),
                loading=(nav or {}).get("loading", (target or {}).get("loading", False)),
                can_go_back=(nav or {}).get("canGoBack", (target or {}).get("canGoBack", False)),
                can_go_forward=(nav or {}).get("canGoForward", (target or {}).get("canGoForward", False)),
                lease_holder_viewer_id=holder_id,
                lease_holder_label=holder_label,
            )

        return await self._run("status", target_id, ["view"], False, None, False, fn)

    def _lease_holder_for(self, target_id: str) -> tuple:
        if self._core.has_control(target_id):
            return self._core.viewer_id, None
        state = self._core.lease_state_by_target.get(target_id)
        if state is None:
            return None, None
        return state.get("holderViewerId"), state.get("holderLabel")

    def _nav_state_to_status(self, n: Mapping[str, Any]) -> StatusResult:
        holder_id, holder_label = self._lease_holder_for(n["targetId"])
        return StatusResult(
            target_id=n["targetId"], url=n["url"], title=n["title"], loading=n["loading"],
            can_go_back=n["canGoBack"], can_go_forward=n["canGoForward"],
            lease_holder_viewer_id=holder_id, lease_holder_label=holder_label,
        )

    # ------------------------------------------------------------------
    # Reading (view + automation, NOT a lease)
    # ------------------------------------------------------------------

    async def screenshot(
        self, *, format: Optional[str] = None, quality: Optional[int] = None, full_page: Optional[bool] = None, max_dimension: Optional[int] = None
    ) -> ScreenshotResult:
        """A full-resolution screenshot via ``target.capture``. Only the
        inline-delivery wire path is implemented; a reply carrying
        ``downloadId`` instead of ``data`` (very large images) raises
        ``NOT_IMPLEMENTED``."""
        target_id = self._target_id

        async def fn() -> ScreenshotResult:
            payload: dict = {"targetId": target_id, "delivery": "inline"}
            if format is not None:
                payload["format"] = format
            if quality is not None:
                payload["quality"] = quality
            if full_page is not None:
                payload["fullPage"] = full_page
            if max_dimension is not None:
                payload["maxDimension"] = max_dimension
            reply = await self._core.request("target.capture", payload)
            if reply.get("data") is None:
                raise AutomationError.not_implemented("screenshot (url delivery)", "a download-fetch path for large captures, not built in this pass")
            self._core.remember_gen(target_id, reply["gen"])
            return ScreenshotResult(
                capture_id=reply["captureId"], target_id=reply["targetId"], format=reply["format"],
                width=reply["width"], height=reply["height"], size_bytes=reply["sizeBytes"], data=reply["data"],
            )

        return await self._run("screenshot", target_id, ["view", "automation", "capture"], False, None, False, fn)

    async def inspect_at(self, x: float, y: float, *, detail: str = "hover") -> InspectResult:
        """Hit-tests one point via ``target.probe``. Coordinates are
        viewport CSS pixels."""
        target_id = self._target_id
        caps = ["view", "automation"]
        if detail == "full":
            caps.append("probe")

        async def fn() -> InspectResult:
            reply = await self._core.request(
                "target.probe", {"targetId": target_id, "x": x, "y": y, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "detail": detail}
            )
            self._core.remember_gen(target_id, reply["gen"])
            return InspectResult(
                hit=reply["hit"], gen=reply["gen"], rect=reply.get("rect"), label=reply.get("label"),
                tag_name=reply.get("tagName"), href=reply.get("href"), name=reply.get("name"), role=reply.get("role"),
            )

        return await self._run("inspectAt", target_id, caps, False, {"x": x, "y": y, "detail": detail}, False, fn)

    async def rect(self, x: float, y: float) -> Optional[Mapping[str, float]]:
        """Convenience wrapper over :meth:`inspect_at`: just the hit rect,
        or ``None`` when nothing was hit."""
        r = await self.inspect_at(x, y, detail="hover")
        return r.rect

    async def elements(self) -> List[Any]:
        """Refused, and the refusal is the design rather than a gap: an
        element-handle API cannot exist on this wire, because page
        evaluation returns by value and never an object id, permanently.
        Use :meth:`resolve`, which returns every match with its rect and
        actionability state in one round trip."""
        raise AutomationError.not_implemented(
            "elements",
            "element handles, which this wire refuses to carry by design (page evaluation returns by value and "
            "never an objectId). Use resolve(selector), which returns every match with its rect and "
            "actionability state",
        )

    async def a11y(
        self,
        *,
        role: Optional[str] = None,
        name: Optional[str] = None,
        max_nodes: Optional[int] = None,
        timeout_ms: Optional[float] = None,
    ) -> A11yResult:
        """Reads Chrome's OWN accessibility tree for this target: every
        node's role, computed accessible name, and the handful of
        properties that decide whether an LLM agent reading this list
        should treat a node as actionable (``focusable``, ``disabled``,
        ``expanded``, ``checked``, ...).

        Bounded, and truncation reported honestly: ``nodes`` is capped
        (``max_nodes``, default 200, at most 1000) and additionally byte
        capped server side; either bound sets
        :attr:`~browserglass.types.A11yResult.truncated` rather than
        silently cutting the reply. Pass ``role``/``name`` when you know
        what you want: ``client.a11y(role='button')`` is both a narrower
        CDP query and a smaller reply than reading everything and
        filtering client side.

        Gated on ``devtools``, not ``evaluate``. This method runs no page
        script at all: ``Accessibility.queryAXTree`` is a CDP domain
        call, the same kind of read ``diagnostics.subscribe()`` and
        ``response_body()`` already make under ``devtools``, not the page
        authorship privilege ``evaluate`` guards. Checked locally so a
        caller lacking it fails fast rather than paying a round trip for
        the server to refuse it.

            tree = await client.a11y(role='button')
            [n.name for n in tree.nodes]  # every button's accessible name
        """
        target_id = self._target_id
        if not self._core.has_capability("devtools"):
            raise AutomationError("POLICY_DENIED", "a11y() needs the 'devtools' capability", {"required": "devtools"})

        async def fn() -> A11yResult:
            reply = await self._send_a11y(target_id, {"role": role, "name": name, "max_nodes": max_nodes}, timeout_ms)
            return A11yResult(
                nodes=[A11yNode.from_wire(n) for n in reply["nodes"]],
                total=reply["total"],
                truncated=reply["truncated"],
            )

        args: dict = {}
        if role is not None:
            args["role"] = role
        if name is not None:
            args["name"] = name
        return await self._run("a11y", target_id, [], False, args, False, fn)

    async def _send_a11y(
        self, target_id: str, req: Mapping[str, Any], timeout_ms: Optional[float] = None
    ) -> Mapping[str, Any]:
        """The shared round trip behind :meth:`a11y` and the locator
        engine's ``role=`` selector: one ``page.a11y.get`` request, with
        or without ``stamp: true``. Kept as one method for the same reason
        ``_send_evaluate_source`` is one method behind two callers: there
        is exactly one wire shape to get right, not two that could drift
        apart."""
        payload: dict = {"targetId": target_id}
        if req.get("role") is not None:
            payload["role"] = req["role"]
        if req.get("name") is not None:
            payload["name"] = req["name"]
        if req.get("max_nodes") is not None:
            payload["maxNodes"] = req["max_nodes"]
        if req.get("stamp") is not None:
            payload["stamp"] = req["stamp"]
        return await self._core.request("page.a11y.get", payload, timeout_ms)

    def on(self, event_type: str, fn: Callable[[Any], None]) -> Callable[[], None]:
        """Subscribes to ``console``/``pageerror``/``network``/``networksummary``,
        delivered for whichever targets this connection has called
        ``diagnostics.subscribe()`` on. Global to the connection, not
        scoped to :attr:`target_id`: filter on the event's ``targetId``
        yourself if more than one sub-client on this connection has
        diagnostics on. Returns its own unsubscribe."""
        return self._core.emitter.on(event_type, fn)

    # ------------------------------------------------------------------
    # Interaction (ALL require a held ControlLease)
    # ------------------------------------------------------------------

    async def click_at(
        self, x: float, y: float, *, button: Optional[str] = None, click_count: Optional[int] = None, modifiers: Optional[Sequence[str]] = None
    ) -> None:
        target_id = self._target_id
        opts = {"button": button, "clickCount": click_count, "modifiers": modifiers}

        async def fn() -> None:
            await self._dispatch_click_at("clickAt", target_id, x, y, button=button, click_count=click_count, modifiers=modifiers)

        await self._run("clickAt", target_id, ["control"], True, {"x": x, "y": y, **{k: v for k, v in opts.items() if v is not None}}, True, fn)

    async def _dispatch_click_at(
        self, name: str, target_id: str, x: float, y: float, *, button: Optional[str] = None, click_count: Optional[int] = None, modifiers: Optional[Sequence[str]] = None
    ) -> None:
        """The raw down/up pair, without the ``_run()`` pipeline. This is
        what the locator engine's ``click``/``fill`` drive too, so a
        locator click inherits the same lease fencing, generation
        stamping and stand-down gate a coordinate click gets: there is
        one input path, and everything above it composes."""
        gen = await self._core.ensure_gen(target_id)
        self._core.assert_may_dispatch(target_id, name)
        lease = self._core.leases.get(target_id)
        if lease is None:
            raise AutomationError("LEASE_NOT_HELD", f"{name}() requires a held ControlLease")
        btn = button or "left"
        count = click_count or 1
        mods = _pack_modifiers(modifiers)
        base = {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id}
        await self._core.send("input.mouse", {**base, "kind": "down", "x": x, "y": y, "button": btn, "buttons": 1, "modifiers": mods, "clickCount": count})
        await self._core.send("input.mouse", {**base, "kind": "up", "x": x, "y": y, "button": btn, "buttons": 0, "modifiers": mods})

    async def move_to(self, x: float, y: float) -> None:
        target_id = self._target_id

        async def fn() -> None:
            gen = await self._core.ensure_gen(target_id)
            self._core.assert_may_dispatch(target_id, "moveTo")
            lease = self._core.leases.get(target_id)
            if lease is None:
                raise AutomationError("LEASE_NOT_HELD", "moveTo() requires a held ControlLease")
            await self._core.send(
                "input.mouse",
                {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id, "kind": "move", "x": x, "y": y, "button": "none", "buttons": 0, "modifiers": 0},
            )

        await self._run("moveTo", target_id, ["control"], True, {"x": x, "y": y}, True, fn)

    async def type_text(self, text: str, *, modifiers: Optional[Sequence[str]] = None) -> None:
        """Types ``text`` as real per-character ``keydown``/``keyup``
        pairs (falling back to ``input.text`` for a character with no
        known DOM code). No inter-key delay; for anti-bot-style paced
        typing use :meth:`human_type`."""
        target_id = self._target_id

        async def fn() -> None:
            gen = await self._core.ensure_gen(target_id)
            self._core.assert_may_dispatch(target_id, "type")
            lease = self._core.leases.get(target_id)
            if lease is None:
                raise AutomationError("LEASE_NOT_HELD", "type_text() requires a held ControlLease")
            mods = _pack_modifiers(modifiers)
            base = {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id}
            for ch in text:
                self._core.assert_may_dispatch(target_id, "type")
                kc = printable_key_code(ch)
                if kc is not None:
                    await self._core.send("input.key", {**base, "kind": "down", "key": kc.key, "code": kc.code, "modifiers": mods, "text": ch})
                    await self._core.send("input.key", {**base, "kind": "up", "key": kc.key, "code": kc.code, "modifiers": mods})
                else:
                    await self._core.send("input.text", {**base, "text": ch})

        await self._run("type", target_id, ["control"], True, {"length": len(text)}, True, fn)

    async def insert_text(self, text: str) -> None:
        """Inserts ``text`` in one ``input.text`` message, bypassing key
        events entirely (no ``keydown``/``keyup`` fires on the page)."""
        target_id = self._target_id

        async def fn() -> None:
            gen = await self._core.ensure_gen(target_id)
            self._core.assert_may_dispatch(target_id, "insertText")
            lease = self._core.leases.get(target_id)
            if lease is None:
                raise AutomationError("LEASE_NOT_HELD", "insert_text() requires a held ControlLease")
            await self._core.send("input.text", {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id, "text": text})

        await self._run("insertText", target_id, ["control"], True, {"length": len(text)}, True, fn)

    async def press_key(self, name: str, *, modifiers: Optional[Sequence[str]] = None) -> None:
        """Presses one key or combo (e.g. ``'Enter'``, ``'Control+A'``);
        the final ``+``-separated segment names the key."""
        target_id = self._target_id

        async def fn() -> None:
            gen = await self._core.ensure_gen(target_id)
            self._core.assert_may_dispatch(target_id, "pressKey")
            lease = self._core.leases.get(target_id)
            if lease is None:
                raise AutomationError("LEASE_NOT_HELD", "press_key() requires a held ControlLease")
            parts = name.split("+")
            main_name = parts[-1] if parts else name
            kc = named_key_code(main_name) or printable_key_code(main_name)
            if kc is None:
                raise AutomationError("NOT_FOUND", f"press_key(): unrecognised key name '{name}'")
            mods = _pack_modifiers(modifiers)
            base = {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id}
            down: dict = {**base, "kind": "down", "key": kc.key, "code": kc.code, "modifiers": mods}
            if len(kc.key) == 1:
                down["text"] = kc.key
            await self._core.send("input.key", down)
            await self._core.send("input.key", {**base, "kind": "up", "key": kc.key, "code": kc.code, "modifiers": mods})

        await self._run("pressKey", target_id, ["control"], True, {"name": name}, True, fn)

    async def scroll(self, *, x: Optional[float] = None, y: Optional[float] = None, dx: float = 0, dy: float = 0) -> None:
        target_id = self._target_id

        async def fn() -> None:
            gen = await self._core.ensure_gen(target_id)
            self._core.assert_may_dispatch(target_id, "scroll")
            lease = self._core.leases.get(target_id)
            if lease is None:
                raise AutomationError("LEASE_NOT_HELD", "scroll() requires a held ControlLease")
            sx = x if x is not None else round(self._core.viewport["width"] / 2)
            sy = y if y is not None else round(self._core.viewport["height"] / 2)
            await self._core.send(
                "input.mouse",
                {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id, "kind": "wheel", "x": sx, "y": sy, "button": "none", "buttons": 0, "modifiers": 0, "dx": dx, "dy": dy},
            )

        await self._run("scroll", target_id, ["control"], True, {"x": x, "y": y, "dx": dx, "dy": dy}, True, fn)

    async def human_type(self, text: str, *, delay_ms: float = 60) -> None:
        """Paced, per-character typing. Checks for an outstanding
        preemption and the lease's own validity before every character,
        and never sleeps more than 400ms without re-checking. On
        preemption it abandons the call immediately (never pauses and
        resumes later) and raises ``LEASE_REVOKED`` carrying
        ``details['last_completed_step']``, ``details['partial']``,
        ``details['chars_typed']`` and ``details['chars_total']``."""
        target_id = self._target_id
        if not self._core.has_capability("control"):
            raise AutomationError("POLICY_DENIED", "human_type() needs the 'control' capability", {"required": "control"})
        self._core.assert_may_dispatch(target_id, "humanType")
        if not self._core.has_control(target_id):
            raise AutomationError("LEASE_NOT_HELD", "human_type() requires a held ControlLease on this target; call acquire_control() first")
        self._core.consume_step()

        started_at = time.time() * 1000
        if self._core.dry_run:
            self._core.record_action(ActionRecord(action="humanType", target_id=target_id, ok=True, duration_ms=time.time() * 1000 - started_at, args={"length": len(text), "dryRun": True}))
            return

        in_flight = self._core.begin_in_flight("humanType", target_id)
        try:
            await self._type_chars_with_preemption("humanType", target_id, text, delay_ms)
            self._core.record_action(ActionRecord(action="humanType", target_id=target_id, ok=True, duration_ms=time.time() * 1000 - started_at, args={"length": len(text)}))
        except Exception as err:
            wrapped = err if isinstance(err, AutomationError) else AutomationError("PROTOCOL_ERROR", str(err))
            self._core.record_action(
                ActionRecord(action="humanType", target_id=target_id, ok=False, duration_ms=time.time() * 1000 - started_at, args={"length": len(text)}, error={"code": wrapped.code, "message": wrapped.message})
            )
            raise wrapped
        finally:
            self._core.end_in_flight(in_flight)

    async def _type_chars_with_preemption(self, name: str, target_id: str, text: str, delay_ms: float) -> None:
        """Per-character ``keydown``/``keyup`` pairs with an optional
        inter-key delay, standing down the instant a person asks for the
        browser. Shared by :meth:`human_type` and the locator engine's
        ``fill``."""
        chars = list(text)
        last_completed_step = -1

        def abandoned_error(chars_typed: int) -> AutomationError:
            ev = self._core.yield_for(target_id)
            return AutomationError(
                "LEASE_REVOKED",
                f"{name}() abandoned: control was preempted",
                {
                    "lastCompletedStep": last_completed_step, "partial": True, "charsTyped": chars_typed, "charsTotal": len(chars),
                    **({"yielded": True, "reason": ev.reason, "human": ev.human, "byLabel": ev.by_label} if ev is not None else {}),
                },
            )

        for i, ch in enumerate(chars):
            if self._core.yield_for(target_id) is not None or target_id in self._core.pending_preempt or not self._core.has_control(target_id):
                raise abandoned_error(i)

            gen = await self._core.ensure_gen(target_id)
            lease = self._core.leases.get(target_id)
            if lease is None:
                raise abandoned_error(i)
            if self._core.yield_for(target_id) is not None:
                raise abandoned_error(i)

            base = {"targetId": target_id, "fw": self._core.viewport["width"], "fh": self._core.viewport["height"], "gen": gen, "leaseId": lease.lease_id}
            kc = printable_key_code(ch)
            if kc is not None:
                await self._core.send("input.key", {**base, "kind": "down", "key": kc.key, "code": kc.code, "modifiers": 0, "text": ch})
                await self._core.send("input.key", {**base, "kind": "up", "key": kc.key, "code": kc.code, "modifiers": 0})
            else:
                await self._core.send("input.text", {**base, "text": ch})
            last_completed_step = i

            if delay_ms > 0:
                await self._sleep_checking_preemption(delay_ms, target_id, lambda i=i: abandoned_error(i + 1))

    async def _sleep_checking_preemption(self, total_ms: float, target_id: str, build_error: Callable[[], AutomationError]) -> None:
        """Sleeps ``total_ms``, but in increments of at most 400ms,
        re-checking preemption after every increment."""
        remaining = total_ms
        while remaining > 0:
            step = min(400, remaining)
            await _sleep_ms(step)
            remaining -= step
            if self._core.yield_for(target_id) is not None or target_id in self._core.pending_preempt or not self._core.has_control(target_id):
                raise build_error()

    # ------------------------------------------------------------------
    # The locator surface
    # ------------------------------------------------------------------

    @property
    def _locators(self) -> LocatorEngine:
        if self._locator_engine is None:
            self._locator_engine = LocatorEngine(_ClientLocatorRuntime(self))
        return self._locator_engine

    async def resolve(self, selector: str, **opts: Any) -> ResolveResult:
        """Finds every element ``selector`` matches and reports, for
        each, its rect and all five actionability answers, in ONE round
        trip. See ``locator/engine.py`` and ``locator/script.py`` module
        docs for the selector dialect and the actionability contract."""
        target_id = self._target_id

        async def fn() -> ResolveResult:
            return await self._locators.resolve(target_id, selector, opts)

        return await self._run("resolve", target_id, ["evaluate"], False, {"selector": selector}, False, fn)

    async def wait_for(self, selector: str, **opts: Any) -> WaitForResult:
        target_id = self._target_id

        async def fn() -> WaitForResult:
            return await self._locators.wait_for(target_id, selector, opts)

        return await self._run("waitFor", target_id, ["evaluate"], False, {"selector": selector, "state": opts.get("state", "visible")}, False, fn)

    async def wait_for_selector(self, selector: str, **opts: Any) -> WaitForResult:
        """Playwright's spelling of :meth:`wait_for`. Defaults to
        ``state='visible'``."""
        return await self.wait_for(selector, **opts)

    async def click(self, selector: str, **opts: Any) -> ClickResult:
        target_id = self._target_id

        async def fn() -> ClickResult:
            return await self._locators.click(target_id, selector, opts)

        args = {"selector": selector}
        if "index" in opts and opts["index"] is not None:
            args["index"] = opts["index"]
        return await self._run("click", target_id, ["evaluate", "control"], True, args, True, fn)

    async def fill(self, selector: str, value: str, **opts: Any) -> FillResult:
        target_id = self._target_id

        async def fn() -> FillResult:
            return await self._locators.fill(target_id, selector, value, opts)

        return await self._run("fill", target_id, ["evaluate", "control"], True, {"selector": selector, "length": len(value)}, True, fn)

    async def select(self, selector: str, options: Any, **opts: Any) -> SelectResult:
        """``select_option``: sets a ``<select>``'s selection by value, by
        visible label, or by index, and reports what actually ended up
        selected."""
        target_id = self._target_id

        async def fn() -> SelectResult:
            return await self._locators.select(target_id, selector, options, opts)

        args = {"selector": selector}
        if "index" in opts and opts["index"] is not None:
            args["index"] = opts["index"]
        return await self._run("select", target_id, ["evaluate", "control"], True, args, True, fn)

    async def inner_text(self, selector: str, **opts: Any) -> str:
        target_id = self._target_id

        async def fn() -> str:
            return await self._locators.inner_text(target_id, selector, opts)

        return await self._run("innerText", target_id, ["evaluate"], False, {"selector": selector}, False, fn)

    async def get_attribute(self, selector: str, name: str, **opts: Any) -> Optional[str]:
        """Throws ``NOT_FOUND`` when the SELECTOR matched nothing, which
        is different from the attribute being absent (that returns
        ``None``)."""
        target_id = self._target_id

        async def fn() -> Optional[str]:
            return await self._locators.get_attribute(target_id, selector, name, opts)

        return await self._run("getAttribute", target_id, ["evaluate"], False, {"selector": selector, "name": name}, False, fn)

    async def is_checked(self, selector: str, **opts: Any) -> bool:
        target_id = self._target_id

        async def fn() -> bool:
            return await self._locators.is_checked(target_id, selector, opts)

        return await self._run("isChecked", target_id, ["evaluate"], False, {"selector": selector}, False, fn)

    async def scroll_into_view(self, selector: str, **opts: Any) -> LocatorMatch:
        target_id = self._target_id

        async def fn() -> LocatorMatch:
            return await self._locators.scroll_into_view(target_id, selector, opts)

        return await self._run("scrollIntoView", target_id, ["evaluate"], False, {"selector": selector}, False, fn)

    # ------------------------------------------------------------------
    # set_input_files: file uploads
    # ------------------------------------------------------------------

    async def set_input_files(self, selector: str, files: Union[UploadFileInput, Sequence[UploadFileInput]]) -> List[str]:
        """Attaches files to an ``<input type="file">``, the equivalent
        of Playwright's ``set_input_files``. Needs the ``upload``
        capability.

        Takes bytes and a name, not a path: the caller's process and the
        machine running Chrome are not the same machine, so a path from
        this process would mean nothing there (or, worse, mean something
        else). The bytes are staged across the socket first
        (``upload.begin``, then ``UPLOAD_CHUNK`` binary frames, then
        ``upload.complete``) before being named in one ``files.set``.

        Takes no :class:`~browserglass.lease.ControlLeaseHandle`.
        Attaching a file sends no ``input.*`` message, so there is no
        lease fencing to satisfy; it is gated on the ``upload`` capability
        alone.
        """
        target_id = self._target_id
        file_list = list(files) if isinstance(files, (list, tuple)) else [files]

        async def fn() -> List[str]:
            if not file_list:
                raise AutomationError("INVALID_ARGUMENT", "set_input_files() needs at least one file")
            upload_ids: List[str] = []
            try:
                for f in file_list:
                    upload_ids.append(await self._stage_upload(target_id, f))
                reply = await self._core.request("files.set", {"targetId": target_id, "selector": selector, "uploadIds": upload_ids})
                return list(reply["files"])
            except Exception:
                for uid in upload_ids:
                    try:
                        await self._core.transport.send("upload.cancel", {"uploadId": uid})
                    except Exception:
                        pass
                raise

        return await self._run("setInputFiles", target_id, ["upload"], False, {"selector": selector, "count": len(file_list)}, False, fn)

    async def _stage_upload(self, target_id: str, file: UploadFileInput) -> str:
        """Stages one file and returns its ``uploadId``. Three steps,
        matching the ``upload.*`` message set: negotiate, send bytes on
        the binary channel, finalise."""
        upload_id = self._core.new_id()
        accepted = await self._core.request(
            "upload.begin",
            {"uploadId": upload_id, "targetId": target_id, "name": file.name, "sizeBytes": len(file.data), "mime": file.mime, "purpose": "input"},
        )
        binary_id = accepted.get("binaryId")
        if not isinstance(binary_id, str):
            raise AutomationError.not_implemented(
                "set_input_files",
                "a gateway that returns upload.accepted.binaryId; this one accepted the upload but named no binary channel id, so there is no way to send the bytes",
            )
        id_bytes = bytes.fromhex(binary_id)
        chunk_bytes = accepted.get("chunkBytes", 0) or 256 * 1024

        data = file.data
        offset = 0
        seq = 0
        while offset < len(data):
            chunk = data[offset : min(offset + chunk_bytes, len(data))]
            payload = encode_upload_chunk_payload(id_bytes, chunk)
            header = encode_binary_header(
                version=1, msg_type=MSG_TYPE_UPLOAD_CHUNK, stream_id=0, seq=seq, ts_delta_ms=0, payload_codec=PAYLOAD_CODEC_NONE, flags=0, gen16=0
            )
            await self._core.transport.send_binary(header + payload)
            offset += chunk_bytes
            seq += 1

        await self._core.request("upload.complete", {"uploadId": upload_id})
        return upload_id

    # ------------------------------------------------------------------
    # Waiting
    # ------------------------------------------------------------------

    async def sleep(self, ms: float) -> None:
        async def fn() -> None:
            await _sleep_ms(ms)

        await self._run("sleep", self._target_id, [], False, {"ms": ms}, False, fn)

    async def wait_for_navigation(self, *, timeout_ms: Optional[float] = None) -> StatusResult:
        """Awaits the next ``nav.state`` for :attr:`target_id` with
        ``loading: false``."""
        target_id = self._target_id

        async def fn() -> StatusResult:
            t_ms = timeout_ms if timeout_ms is not None else self._core.default_timeout_ms
            nav = await self._core.await_message(lambda m: m.get("t") == "nav.state" and m.get("targetId") == target_id and m.get("loading") is False, t_ms)
            return self._nav_state_to_status(nav)

        return await self._run("waitForNavigation", target_id, ["view"], False, None, False, fn)

    async def wait_for_text(self, selector: str, text: str, *, exact: bool = False, timeout_ms: Optional[float] = None, polling_ms: Optional[float] = None) -> str:
        """Waits until some element matching ``selector`` (a plain CSS
        selector, not the locator surface's chained dialect) contains
        ``text`` in its rendered text, then returns the normalised text
        that matched. Requires ``evaluate``."""
        predicate = build_wait_for_text_predicate(selector, text, exact)
        try:
            # ``ENGINE_WORLD``, for the same reason the six fixed scripts in
            # ``locator/engine.py`` pass it, and this one was MISSED when
            # they were done. ``wait_for_function`` is caller facing and
            # rightly defaults to the main world; this predicate is not
            # caller authored. ``build_wait_for_text_predicate`` writes every
            # character of it, ``selector`` and ``text`` reach it only as
            # JSON literals, and it reads ``document.querySelectorAll`` and
            # ``textContent`` and nothing else, so it has no more use for a
            # page global than ``RESOLVE_SCRIPT`` does.
            #
            # Measured before the fix, against real Chrome, on a page
            # counting its own calls: one ``wait_for_text`` moved the page's
            # ``querySelectorAll`` counter from 0 to 1, and it moves it once
            # per POLL, so a wait that takes four seconds at the default
            # 100ms interval hands the page forty observations of the
            # automation looking for its text. That is the leak the whole
            # world discipline exists to close, arriving through the one
            # locator-surface verb that is built on the caller-facing poller
            # instead of on the engine.
            return await self.wait_for_function(
                predicate, poll_timeout_ms=timeout_ms, polling_ms=polling_ms, world=ENGINE_WORLD
            )
        except AutomationError as err:
            if err.code == "TIMEOUT":
                raise AutomationError(
                    "TIMEOUT",
                    f"wait_for_text('{selector}', '{text}'): no element matched by '{selector}' had text "
                    f"{'equal to' if exact else 'containing'} '{text}' within the deadline.",
                    {**err.details, "selector": selector, "text": text, "exact": exact},
                ) from err
            raise

    async def wait_for_network_idle(
        self, *, max_inflight: int = 0, idle_ms: float = 500, timeout_ms: Optional[float] = None
    ) -> None:
        """Resolves once :attr:`target_id`'s in-flight request count has
        stayed at or below ``max_inflight`` continuously for ``idle_ms``,
        or raises ``TIMEOUT`` after ``timeout_ms`` (default
        ``default_timeout_ms``) regardless of activity.

        Requires an active ``network`` diagnostics subscription on
        :attr:`target_id` (``client.diagnostics.subscribe(network=True)``),
        checked locally so a caller who forgot fails fast rather than
        sitting on the full ``timeout_ms`` waiting for a feed nobody
        turned on.

        Reads the ``inFlight`` gauge straight off the raw
        ``network.summary`` envelope (``self._core.transport.on_message``,
        not the parsed :class:`~browserglass.types.NetworkSummaryEntry`
        broadcast, which does not carry this field), mirroring the
        TypeScript SDK's own reasoning for doing the same: a gateway that
        predates this field simply never reports one, and this method
        times out honestly rather than treating a missing gauge as
        "idle". ``inFlight`` is an addition to the wire message this
        client's :mod:`~browserglass.types` shapes have not been given a
        matching field for; reading it off the envelope directly, here,
        is deliberate rather than an oversight, for that same reason.
        """
        target_id = self._target_id
        if not self._core.has_capability("devtools"):
            raise AutomationError("POLICY_DENIED", "wait_for_network_idle() needs the 'devtools' capability", {"required": "devtools"})
        if not self._core.is_network_feed_subscribed(target_id):
            raise AutomationError(
                "POLICY_DENIED",
                f"wait_for_network_idle() requires an active network diagnostics subscription on {target_id}; "
                "call diagnostics.subscribe(network=True) first",
            )
        deadline_ms = timeout_ms if timeout_ms is not None else self._core.default_timeout_ms

        async def fn() -> None:
            loop = asyncio.get_event_loop()
            fut: "asyncio.Future[None]" = loop.create_future()
            idle_handle: Optional[asyncio.TimerHandle] = None

            def disarm() -> None:
                nonlocal idle_handle
                if idle_handle is not None:
                    idle_handle.cancel()
                    idle_handle = None

            def on_idle_elapsed() -> None:
                if not fut.done():
                    fut.set_result(None)

            def on_msg(msg: Mapping[str, Any]) -> None:
                nonlocal idle_handle
                if fut.done() or msg.get("t") != "network.summary" or msg.get("targetId") != target_id:
                    return
                in_flight = msg.get("inFlight")
                if not isinstance(in_flight, (int, float)):
                    return  # gateway does not carry this field yet; nothing to act on
                if in_flight <= max_inflight:
                    if idle_handle is None:
                        idle_handle = loop.call_later(idle_ms / 1000, on_idle_elapsed)
                else:
                    disarm()

            off = self._core.transport.on_message(on_msg)
            try:
                await asyncio.wait_for(fut, timeout=deadline_ms / 1000)
            except asyncio.TimeoutError as err:
                raise AutomationError(
                    "TIMEOUT",
                    f"wait_for_network_idle() timed out after {deadline_ms}ms waiting for {target_id}'s in-flight "
                    f"request count to reach {max_inflight} and stay there for {idle_ms}ms",
                ) from err
            finally:
                disarm()
                off()

        return await self._run(
            "waitForNetworkIdle", target_id, [], False, {"maxInflight": max_inflight, "idleMs": idle_ms}, False, fn
        )

    async def wait_for_download(
        self,
        *,
        timeout_ms: float = 60000,
        trigger: Optional[Callable[[], Union[None, Awaitable[None]]]] = None,
    ) -> DownloadResult:
        """Waits for the next download on :attr:`target_id` to finish, and
        returns how to fetch it. Needs the ``download`` capability.

        Downloads never stream through this socket. The result carries a
        signed, short lived, single use HTTP URL and the file's
        ``sha256``; fetching it is an ordinary HTTP GET the caller makes
        itself with whatever HTTP client it already has (this package
        already depends on ``httpx`` for :class:`~browserglass.rest.RestClient`).
        That is deliberate, the same way :meth:`elements` refuses to
        invent an element-handle API this wire cannot carry rather than
        approximating one: a multi-hundred-megabyte file has no business
        travelling over the control channel, competing with input and
        frames, and there is deliberately no ``download_bytes()``-style
        convenience method here either, on this client or the TypeScript
        one, to fetch it for you.

        The download bridge is opt in per target the same way diagnostics
        is: nothing enables download events for a target nobody asked
        about. If no download arrives within ``timeout_ms`` this raises
        ``TIMEOUT`` rather than returning nothing, because "no download
        happened" and "a download happened and this call missed it" are
        different facts and only one of them is worth continuing on.

        ``trigger``, when given, runs AFTER the download listener is
        attached and BEFORE the wait begins: put the click that starts
        the download there rather than calling it first. A small file
        served locally can finish before a listener attached afterwards
        ever runs, and that lost race looks exactly like a download that
        never happened.

            result = await client.wait_for_download(trigger=lambda: client.click("#download-link"))
        """
        target_id = self._target_id
        if not self._core.has_capability("download"):
            raise AutomationError("POLICY_DENIED", "wait_for_download() needs the 'download' capability", {"required": "download"})

        loop = asyncio.get_event_loop()
        fut: "asyncio.Future[DownloadResult]" = loop.create_future()

        def on_msg(msg: Mapping[str, Any]) -> None:
            if fut.done():
                return
            t = msg.get("t")
            if t == "download.ready":
                fut.set_result(
                    DownloadResult(
                        download_id=msg["downloadId"], size_bytes=msg["sizeBytes"], sha256=msg["sha256"],
                        url=self._core.resolve_gateway_url(msg["url"]), expires_at=msg["expiresAt"],
                    )
                )
            elif t == "download.failed":
                # PROTOCOL_ERROR rather than a download specific code: the
                # download did not merely time out, the server actively
                # reported it failed, and the reason string is the useful
                # part.
                fut.set_exception(
                    AutomationError(
                        "PROTOCOL_ERROR",
                        f"wait_for_download(): the download failed: {msg.get('reason')}",
                        {"downloadId": msg.get("downloadId"), "reason": msg.get("reason"), "targetId": target_id},
                    )
                )

        # One subscription covering both terminal outcomes. `download.started`
        # is deliberately NOT waited on: a caller asking to wait for a
        # download wants the file, and a started download that then fails
        # is a failure, not a success that never resolved.
        off = self._core.transport.on_message(on_msg)
        try:
            if trigger is not None:
                # Fired only after the listener above is live. See this
                # method's own docstring.
                result = trigger()
                if inspect.isawaitable(result):
                    await result
            try:
                return await asyncio.wait_for(fut, timeout=timeout_ms / 1000)
            except asyncio.TimeoutError as err:
                raise AutomationError(
                    "TIMEOUT",
                    f"wait_for_download(): no download completed on {target_id} within {timeout_ms}ms. A download "
                    "only reports here when the instance was launched with a downloadDir and the token carries "
                    "'download'.",
                    {"targetId": target_id, "timeoutMs": timeout_ms},
                ) from err
        finally:
            off()

    # ------------------------------------------------------------------
    # Page evaluation
    # ------------------------------------------------------------------

    async def evaluate(
        self,
        expression: str,
        *,
        await_promise: Optional[bool] = None,
        user_gesture: Optional[bool] = None,
        timeout_ms: Optional[float] = None,
        world: Optional[EvaluateWorld] = None,
    ) -> Any:
        """Runs a JavaScript EXPRESSION in this target's own page context
        and returns the result by value.

        ``world`` DEFAULTS TO THE PAGE'S OWN, and that is deliberate and
        settled. A caller who asked for nothing must keep getting what
        they always got, so when ``world`` is ``None`` no ``world`` field
        goes on the wire at all and the server applies its own main-world
        default. This is the one place BrowserGlass and patchright
        disagree on purpose: patchright's ``page.evaluate`` defaults
        ``isolatedContext=True``. A shim reconciling the two should map
        its ``page.evaluate`` to ``evaluate(..., world="isolated")``
        explicitly rather than relying on this default. The locator
        surface does NOT inherit this default: every one of its own
        scripts is isolated with no way to ask otherwise
        (``locator/engine.py``'s ``ENGINE_WORLD``).

        Note the signature: ``expression`` is the only positional
        parameter and every option after it is keyword only. That closes
        the trap the TypeScript SDK documents on ``evaluate(source,
        ...args)``, where ``evaluate('expr', {world: 'isolated'})`` passes
        the options bag to the page as argument zero and runs in the
        default world with no error anywhere. Here the same line is a
        ``TypeError`` before anything is sent. See :mod:`browserglass.worlds`.

        Unlike the TypeScript SDK, this method cannot accept a Python
        callable: there is no way to serialise a Python function into
        JavaScript source the way ``Function.prototype.toString()`` does
        in TypeScript. Pass a JavaScript expression string, e.g.
        ``client.evaluate('document.title')``. Use
        :meth:`evaluate_function` for the function-plus-arguments form.

        The result must be JSON-representable: this wire never returns a
        live object handle. A page-side throw raises an
        :class:`~browserglass.errors.AutomationError` whose message is
        the page's own message, with the page's stack in
        ``details['stack']``.
        """
        target_id = self._target_id
        opts = {
            "await_promise": await_promise,
            "user_gesture": user_gesture,
            "timeout_ms": timeout_ms,
            "world": check_world(world, where="evaluate(world=...)"),
        }
        caps = ["evaluate"]
        if user_gesture is True:
            caps.append("control")

        async def fn() -> Any:
            return await self._send_evaluate_source(target_id, "expression", expression, [], opts)

        return await self._run("evaluate", target_id, caps, False, None, False, fn)

    async def evaluate_function(
        self,
        source: str,
        *args: Any,
        await_promise: Optional[bool] = None,
        user_gesture: Optional[bool] = None,
        timeout_ms: Optional[float] = None,
        world: Optional[EvaluateWorld] = None,
    ) -> Any:
        """Runs a JavaScript FUNCTION DECLARATION (literal source text,
        e.g. ``"(sel) => document.querySelector(sel)?.textContent"``) in
        the page with ``args`` passed as JSON, the ``page.evaluate``
        function-form directly.

        The function body cannot close over anything in this Python
        process: it is re-parsed inside the page, so a variable captured
        from the enclosing Python scope is simply not there. Pass what it
        needs through ``args``.

        ``world`` is keyword only, because everything after ``*args`` is.
        That closes half of the trap; the other half is that ``args`` is
        variadic, so ``evaluate_function(src, {"world": "isolated"})`` is
        a syntactically perfect call that hands the options bag to the
        PAGE and runs in the default world. Nothing in a signature can
        tell that apart from a legitimate mapping argument, so
        :func:`browserglass.worlds.guard_page_arguments` tells it apart by
        content and refuses it by name.
        """
        target_id = self._target_id
        guard_page_arguments(args, where="evaluate_function(...)")
        opts = {
            "await_promise": await_promise,
            "user_gesture": user_gesture,
            "timeout_ms": timeout_ms,
            "world": check_world(world, where="evaluate_function(world=...)"),
        }
        caps = ["evaluate"]
        if user_gesture is True:
            caps.append("control")

        async def fn() -> Any:
            return await self._send_evaluate_source(target_id, "function", source, list(args), opts)

        return await self._run("evaluate", target_id, caps, False, None, False, fn)

    async def _send_evaluate_source(self, target_id: str, kind: str, source: str, args: Sequence[Any], opts: Mapping[str, Any]) -> Any:
        as_function = kind == "function"
        payload: dict = {"targetId": target_id}
        if as_function:
            payload["functionDeclaration"] = source
            if args:
                payload["args"] = list(args)
        else:
            payload["expression"] = source
        if opts.get("await_promise") is not None:
            payload["awaitPromise"] = opts["await_promise"]
        if opts.get("user_gesture") is not None:
            payload["userGesture"] = opts["user_gesture"]
        if opts.get("timeout_ms") is not None:
            payload["timeoutMs"] = opts["timeout_ms"]
        if opts.get("world") is not None:
            payload["world"] = opts["world"]

        timeout_ms = (opts.get("timeout_ms") or DEFAULT_EVALUATE_TIMEOUT_MS) + self._core.default_timeout_ms
        reply = await self._core.request("page.evaluate", payload, timeout_ms)

        if reply.get("ok") is False:
            ex = reply.get("exception") or {}
            raise AutomationError(
                "PROTOCOL_ERROR",
                ex.get("message", "the page threw"),
                {
                    "pageException": True,
                    **({"name": ex["name"]} if "name" in ex else {}),
                    **({"stack": ex["stack"]} if "stack" in ex else {}),
                    **({"lineNumber": ex["lineNumber"]} if "lineNumber" in ex else {}),
                    **({"columnNumber": ex["columnNumber"]} if "columnNumber" in ex else {}),
                },
            )
        result_type = reply.get("resultType")
        if result_type == "undefined":
            return None
        if result_type == "unserializable":
            what = reply.get("unserializableValue") or reply.get("description") or "a value"
            raise AutomationError(
                "PROTOCOL_ERROR",
                f"evaluate() produced {what}, which cannot be returned by value; narrow the expression to a JSON-representable result",
                {"unserializable": True, **({"description": reply["description"]} if "description" in reply else {})},
            )
        return reply.get("value")

    async def text(self) -> str:
        """The page's rendered text, ``document.body.innerText``.

        Runs in :data:`~browserglass.locator.engine.ENGINE_WORLD`, not the
        caller-facing main-world default of :meth:`evaluate`. ``text()``
        and :meth:`html` look like caller-facing conveniences and are not:
        the caller supplies no JavaScript at all, so every character of
        what runs is written here, which is the same test ``ENGINE_WORLD``
        applies to the six fixed locator scripts.

        Measured against real Chrome on a page that patched the
        ``innerText`` and ``outerHTML`` GETTERS on ``HTMLElement.prototype``
        and ``Element.prototype``: before this change, one ``text()`` moved
        the page's innerText counter from 0 to 1 and one ``html()`` moved
        its outerHTML counter from 0 to 1. A page that wants to know
        whether it is being scraped only has to define those two getters.
        It also gets to CHOOSE WHAT THEY RETURN, which is worse than being
        seen: every downstream decision made on that text was made on a
        value the page handed back knowing it was being read.

        patchright, the baseline this surface is measured against, ran the
        equivalent reads with ``isolatedContext=True``, so isolated is both
        the safe answer and the parity answer.
        """
        return await self.evaluate('document.body ? document.body.innerText : ""', world=ENGINE_WORLD)

    async def html(self) -> str:
        """The page's full serialised markup,
        ``document.documentElement.outerHTML``. Isolated for the reason
        given on :meth:`text`."""
        return await self.evaluate(
            'document.documentElement ? document.documentElement.outerHTML : ""', world=ENGINE_WORLD
        )

    async def wait_for_function(
        self,
        predicate: str,
        *,
        poll_timeout_ms: Optional[float] = None,
        polling_ms: Optional[float] = None,
        await_promise: Optional[bool] = None,
        user_gesture: Optional[bool] = None,
        world: Optional[EvaluateWorld] = None,
    ) -> Any:
        """Polls a JavaScript expression string in the page until it
        returns a truthy value, and returns that value.

        Polling is on a fixed interval (``polling_ms``, default 100ms),
        not tied to the page's paint cycle: each poll is a round trip, so
        a tighter interval would spend more time on the socket than in
        the page. A page-side throw inside the predicate is NOT swallowed
        as "not ready yet": it propagates.
        """
        target_id = self._target_id
        caps = ["evaluate"]
        if user_gesture is True:
            caps.append("control")
        deadline_ms = poll_timeout_ms if poll_timeout_ms is not None else self._core.default_timeout_ms
        interval_ms = polling_ms if polling_ms is not None else 100
        opts = {
            "await_promise": await_promise,
            "user_gesture": user_gesture,
            "world": check_world(world, where="wait_for_function(world=...)"),
        }

        async def fn() -> Any:
            started_at = time.time() * 1000
            polls = 0
            while True:
                polls += 1
                value = await self._send_evaluate_source(target_id, "expression", predicate, [], opts)
                if value:
                    return value
                elapsed = time.time() * 1000 - started_at
                if elapsed >= deadline_ms:
                    raise AutomationError(
                        "TIMEOUT",
                        f"wait_for_function() gave up after {elapsed}ms and {polls} polls; the predicate never returned a truthy value",
                        {"pollTimeoutMs": deadline_ms, "polls": polls},
                    )
                await _sleep_ms(min(interval_ms, deadline_ms - elapsed))

        return await self._run("waitForFunction", target_id, caps, False, {"pollTimeoutMs": deadline_ms, "pollingMs": interval_ms}, False, fn)

    # ------------------------------------------------------------------
    # Internal: the shared action pipeline (capability check, lease
    # check, step budget, dry-run skip, audit record).
    # ------------------------------------------------------------------

    async def _run(
        self,
        name: str,
        target_id: str,
        caps: Sequence[str],
        needs_lease: bool,
        args: Optional[Mapping[str, Any]],
        dry_run_skip: bool,
        fn: Callable[[], Awaitable[Any]],
    ) -> Any:
        started_at = time.time() * 1000
        in_flight = self._core.begin_in_flight(name, target_id)
        try:
            for cap in caps:
                if not self._core.has_capability(cap):
                    raise AutomationError("POLICY_DENIED", f"{name}() needs the '{cap}' capability", {"required": cap})

            if needs_lease:
                self._core.assert_may_dispatch(target_id, name)
            if needs_lease and not self._core.has_control(target_id):
                raise AutomationError("LEASE_NOT_HELD", f"{name}() requires a held ControlLease on {target_id}; call acquire_control() first")
            self._core.consume_step()

            result = None if (dry_run_skip and self._core.dry_run) else await fn()

            self._core.record_action(ActionRecord(action=name, target_id=target_id, ok=True, duration_ms=time.time() * 1000 - started_at, args=dict(args) if args else None))
            return result
        except Exception as err:
            wrapped = err if isinstance(err, AutomationError) else AutomationError("PROTOCOL_ERROR", str(err))
            self._core.record_action(
                ActionRecord(action=name, target_id=target_id, ok=False, duration_ms=time.time() * 1000 - started_at, args=dict(args) if args else None, error={"code": wrapped.code, "message": wrapped.message})
            )
            raise wrapped
        finally:
            self._core.end_in_flight(in_flight)


class _ClientLocatorRuntime:
    """Wires :class:`browserglass.locator.engine.LocatorEngine` to this
    client's own internals, satisfying the ``LocatorRuntime`` protocol.
    A separate object rather than the client implementing the protocol
    itself, so the locator engine's method names (``click_point``,
    ``type_chars``) never collide with the client's public,
    differently-shaped verbs (``click``, ``type_text``)."""

    def __init__(self, client: AutomationClient) -> None:
        self._client = client

    async def evaluate_function(
        self, target_id: str, source: str, args: Sequence[Any], timeout_ms: float, *, world: EvaluateWorld
    ) -> Any:
        """``world`` is forwarded, not defaulted here. The engine decides
        it (``locator/engine.py``'s ``ENGINE_WORLD``, ``"isolated"``) and
        the protocol makes it a required keyword argument, so this adapter
        has nothing to choose and no way to drop it silently.

        Nothing below this line needed to change:
        :meth:`AutomationClient._send_evaluate_source` already emitted
        ``world`` when the options mapping carried one, and
        ``page.evaluate`` has accepted it on the wire since it was built
        (``PageEvaluateInternal.world`` in ``@browserglass/protocol``,
        validated by ``handlePageEvaluate`` in
        ``packages/server/src/ws/connection.ts``). The gap was only ever
        that the locator surface never asked.
        """
        return await self._client._send_evaluate_source(
            target_id, "function", source, args, {"timeout_ms": timeout_ms, "world": world}
        )

    async def evaluate_expression(
        self, target_id: str, expression: str, timeout_ms: float, *, world: EvaluateWorld
    ) -> Any:
        return await self._client._send_evaluate_source(
            target_id, "expression", expression, [], {"timeout_ms": timeout_ms, "world": world}
        )

    async def prepare_dispatch(self, target_id: str) -> None:
        await self._client._core.ensure_gen(target_id)

    async def click_point(self, target_id: str, x: float, y: float, opts: Mapping[str, Any]) -> None:
        await self._client._dispatch_click_at(
            "click", target_id, x, y, button=opts.get("button"), click_count=opts.get("clickCount"), modifiers=opts.get("modifiers")
        )

    async def type_chars(self, target_id: str, text: str, delay_ms: float) -> None:
        await self._client._type_chars_with_preemption("fill", target_id, text, delay_ms)

    async def insert_text(self, target_id: str, text: str) -> None:
        gen = await self._client._core.ensure_gen(target_id)
        self._client._core.assert_may_dispatch(target_id, "fill")
        lease = self._client._core.leases.get(target_id)
        if lease is None:
            raise AutomationError("LEASE_NOT_HELD", "fill() requires a held ControlLease")
        core = self._client._core
        await core.send("input.text", {"targetId": target_id, "fw": core.viewport["width"], "fh": core.viewport["height"], "gen": gen, "leaseId": lease.lease_id, "text": text})

    async def sleep(self, ms: float) -> None:
        await _sleep_ms(ms)

    @property
    def default_timeout_ms(self) -> float:
        return self._client._core.default_timeout_ms

    async def query_and_stamp_by_role(
        self, target_id: str, role: Optional[str], name: Optional[str], timeout_ms: float
    ) -> Mapping[str, Any]:
        """``role=``'s CDP half. ``devtools`` is checked HERE, not by
        ``_run()``'s own ``caps`` list on ``resolve()``/``click()``/etc.,
        because those verbs need it only conditionally (a selector with no
        ``role=`` segment never reaches this method at all): a blanket
        capability requirement on every locator verb would demand
        something most calls never use. A caller with ``evaluate`` but not
        ``devtools`` learns the truth here, before the ``page.evaluate``
        round trip ``resolve()`` would otherwise still make with a
        rewritten, working selector."""
        core = self._client._core
        if not core.has_capability("devtools"):
            raise AutomationError(
                "POLICY_DENIED",
                "a 'role=' selector needs the 'devtools' capability (for the underlying accessibility tree read), "
                "in addition to 'evaluate' (for the resolve() round trip that runs afterward)",
                {"required": "devtools"},
            )
        reply = await self._client._send_a11y(target_id, {"role": role, "name": name, "stamp": True}, timeout_ms)
        return {"attr": reply.get("marker")}
