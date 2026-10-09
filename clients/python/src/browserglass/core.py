"""Shared internal state and wire plumbing for one `bgls.v1` connection.

Mirrors ``packages/automation/src/client/core.ts``'s ``AutomationCore``:
the default client and every ``for_target()`` sub-client share exactly one
``AutomationCore`` (and therefore one socket, one lease table, one step
budget). Not part of the public surface; a caller only ever sees
:class:`~browserglass.client.AutomationClient`.
"""

from __future__ import annotations

import asyncio
import math
import time
import uuid
from urllib.parse import urljoin, urlsplit, urlunsplit
from typing import Any, Callable, Dict, List, Mapping, Optional, Set

from .errors import AutomationError
from .lease import ControlLeaseHandle
from .transport import Envelope, Transport, ClientIdentity, SocketFactory
from .types import (
    ActionRecord,
    ConsoleEntry,
    ControlYieldEvent,
    InFlightAction,
    NetworkRequestEntry,
    NetworkSummaryEntry,
    PageErrorEntry,
    PreemptionRequest,
    RequestGatePausedEvent,
)


class Emitter:
    """A tiny synchronous pub/sub, mirroring `@browserglass/client`'s
    ``Emitter``: used for the diagnostics broadcasts (``console``,
    ``pageerror``, ``network``, ``networksummary``) and the request gate's
    ``gatepaused``."""

    def __init__(self) -> None:
        self._listeners: Dict[str, List[Callable[[Any], None]]] = {}

    def on(self, event: str, cb: Callable[[Any], None]) -> Callable[[], None]:
        self._listeners.setdefault(event, []).append(cb)

        def off() -> None:
            try:
                self._listeners[event].remove(cb)
            except (KeyError, ValueError):
                pass

        return off

    def emit(self, event: str, payload: Any) -> None:
        for cb in list(self._listeners.get(event, [])):
            try:
                cb(payload)
            except Exception:
                pass

    def clear(self) -> None:
        self._listeners.clear()


def new_id() -> str:
    return f"c_{uuid.uuid4().hex}"


class AutomationCore:
    def resolve_gateway_url(self, url: str) -> str:
        """Turns a URL the gateway handed back (a download URL, root
        relative and base path inclusive unless the gateway has
        ``publicUrl`` set) into an absolute ``http(s)`` URL on the origin
        this client's socket dialed. Already absolute URLs pass through."""
        try:
            parts = urlsplit(self.endpoint)
            scheme = {"ws": "http", "wss": "https"}.get(parts.scheme, parts.scheme)
            if not scheme or not parts.netloc:
                return url
            base = urlunsplit((scheme, parts.netloc, parts.path, "", ""))
            return urljoin(base, url)
        except ValueError:
            return url

    def __init__(
        self,
        *,
        endpoint: str,
        token: str,
        default_timeout_ms: float = 15000,
        dry_run: bool = False,
        step_budget: float = math.inf,
        on_action: Optional[Callable[[ActionRecord], None]] = None,
        release_on_yield: bool = True,
        socket_factory: Optional[SocketFactory] = None,
        ping_interval_s: Optional[float] = 5.0,
    ) -> None:
        self.endpoint = endpoint
        self.default_timeout_ms = default_timeout_ms
        self.dry_run = dry_run
        self.step_budget = step_budget
        self._on_action_hook = on_action
        self.release_on_yield = release_on_yield

        self.transport = Transport(
            endpoint=endpoint,
            token=token,
            default_timeout_ms=default_timeout_ms,
            client_identity=ClientIdentity(name="browserglass-python", version="0.1.0", runtime="agent"),
            socket_factory=socket_factory,
            ping_interval_s=ping_interval_s,
        )

        self.viewer_id: Optional[str] = None
        self.session_id: Optional[str] = None
        self.instance_id: Optional[str] = None
        self.granted: Set[str] = set()
        self.targets: List[Mapping[str, Any]] = []
        self.viewport: Dict[str, Any] = {"width": 1280, "height": 800, "dpr": 1}

        self.leases: Dict[str, ControlLeaseHandle] = {}
        self.lease_state_by_target: Dict[str, Mapping[str, Any]] = {}
        self.pending_preempt: Dict[str, PreemptionRequest] = {}
        self.requeue_blocked_until: Dict[str, float] = {}
        self.gen_by_target: Dict[str, int] = {}
        self.nav_state_by_target: Dict[str, Mapping[str, Any]] = {}
        self.viewers_by_id: Dict[str, Mapping[str, str]] = {}
        self._network_feed_by_target: Dict[str, bool] = {}
        self.emitter = Emitter()

        self.yield_by_target: Dict[str, ControlYieldEvent] = {}
        self.yield_cbs: Set[Callable[[ControlYieldEvent], None]] = set()

        self._in_flight_actions: Set[InFlightAction] = set()
        self._steps_used = 0
        self._destroyed = False

        self.transport.on_message(self._handle_message)

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        welcome = await self.transport.connect()
        self.viewer_id = welcome.viewer_id
        self.session_id = welcome.session_id
        self.instance_id = welcome.instance.get("instanceId")
        self.granted = set(welcome.granted)
        self.targets = list(welcome.targets)
        vp = welcome.instance.get("viewport") or {}
        if vp:
            self.viewport = dict(vp)

    def _handle_message(self, msg: Envelope) -> None:  # noqa: C901 - one dispatch table, mirrors core.ts
        t = msg.get("t")
        if t == "presence.state":
            for v in msg.get("viewers", []):
                self.viewers_by_id[v["viewerId"]] = {"kind": v.get("kind", "human"), "label": v.get("label", "")}
        elif t == "target.created":
            self.targets = [*self.targets, msg["target"]]
        elif t == "target.updated":
            changed = msg.get("changed", {})
            self.targets = [{**x, **changed} if x.get("targetId") == msg.get("targetId") else x for x in self.targets]
        elif t == "target.closed":
            target_id = msg["targetId"]
            self.targets = [x for x in self.targets if x.get("targetId") != target_id]
            lease = self.leases.get(target_id)
            if lease is not None:
                lease._mark_revoked("instance_released")
            self.leases.pop(target_id, None)
        elif t == "nav.state":
            self.nav_state_by_target[msg["targetId"]] = msg
        elif t == "control.state":
            self.lease_state_by_target = {}
            for l in msg.get("leases", []):
                self.lease_state_by_target[l["targetId"]] = l
        elif t == "control.preempt.request":
            target_id = msg["targetId"]
            by_kind = self._requester_kind(msg["byViewerId"])
            req = PreemptionRequest(
                target_id=target_id,
                by_label=msg.get("byLabel", ""),
                by_kind=by_kind,
                reason=msg["reason"],
                grace_ms=msg.get("graceMs", 0),
                deadline=msg.get("deadline", 0),
            )
            self.pending_preempt[target_id] = req
            ev = ControlYieldEvent(
                target_id=target_id,
                phase="requested",
                reason=msg["reason"],
                by_label=msg.get("byLabel", ""),
                by_kind=by_kind,
                human=(msg["reason"] == "human_takeover" or by_kind == "human"),
                deadline=msg.get("deadline"),
                in_flight=self.in_flight_for(target_id),
                resume_not_before=None,
            )
            self._enter_stand_down(ev)
            lease = self.leases.get(target_id)
            if lease is not None:
                lease._fire_preemption_requested(req)
            self._complete_stand_down(ev)
        elif t == "control.yield.request":
            target_id = msg["targetId"]
            ev = ControlYieldEvent(
                target_id=target_id,
                phase="requested",
                reason="human_takeover",
                by_label=msg.get("byLabel", ""),
                by_kind="human",
                human=True,
                deadline=msg.get("deadline"),
                in_flight=self.in_flight_for(target_id),
                resume_not_before=None,
            )
            self._enter_stand_down(ev)
            self._complete_stand_down(ev)
        elif t == "control.preempt.cancelled":
            target_id = msg["targetId"]
            self.pending_preempt.pop(target_id, None)
            self._end_stand_down(target_id)
        elif t == "control.preempted":
            target_id = msg["targetId"]
            self.pending_preempt.pop(target_id, None)
            requeue_after_ms = msg.get("requeueAfterMs", 30000)
            self.requeue_blocked_until[target_id] = time.time() * 1000 + requeue_after_ms
            by_kind = self._requester_kind(msg["byViewerId"])
            human = msg["reason"] == "human_takeover" or by_kind == "human"
            self._stand_down(
                ControlYieldEvent(
                    target_id=target_id,
                    phase="taken",
                    reason=msg["reason"],
                    by_label=msg.get("byLabel", ""),
                    by_kind=by_kind,
                    human=human,
                    deadline=None,
                    in_flight=self.in_flight_for(target_id),
                    resume_not_before=time.time() * 1000 + requeue_after_ms,
                )
            )
            lease = self.leases.get(target_id)
            if lease is not None and lease.lease_id == msg["leaseId"]:
                self.leases.pop(target_id, None)
                reason = "force_claimed" if msg["reason"] == "force_claim" else ("preempted_by_human" if human else "preempted_by_agent")
                lease._mark_revoked(reason)  # type: ignore[arg-type]
        elif t == "control.revoked":
            target_id = msg["targetId"]
            lease = self.leases.get(target_id)
            if lease is not None and lease.lease_id == msg["leaseId"]:
                self.leases.pop(target_id, None)
                reason = msg["reason"]
                mapped = (
                    "admin_revoked"
                    if reason in ("admin", "capability_lost")
                    else "session_ended"
                    if reason in ("target_gone", "session_ended")
                    else "expired"
                )
                lease._mark_revoked(mapped)  # type: ignore[arg-type]
        elif t == "instance.released":
            for lease in list(self.leases.values()):
                lease._mark_revoked("instance_released")
            self.leases.clear()
        elif t == "request.gate.paused":
            self.emitter.emit(
                "gatepaused",
                RequestGatePausedEvent(
                    target_id=msg["targetId"],
                    gate_id=msg["gateId"],
                    url=msg["url"],
                    method=msg["method"],
                    resource_type=msg["resourceType"],
                    headers=msg.get("headers") or {},
                    deadline_at=msg["deadlineAt"],
                    post_data=msg.get("postData"),
                ),
            )
        elif t == "console.entry":
            self.emitter.emit(
                "console",
                ConsoleEntry(
                    target_id=msg["targetId"], level=msg["level"], text=msg["text"],
                    url=msg.get("url"), line=msg.get("line"), column=msg.get("column"),
                    stack=msg.get("stack"), count=msg.get("count"),
                ),
            )
        elif t == "page.error":
            self.emitter.emit(
                "pageerror",
                PageErrorEntry(
                    target_id=msg["targetId"], name=msg["name"], message=msg["message"],
                    stack=msg.get("stack"), url=msg.get("url"),
                ),
            )
        elif t == "network.request":
            self.emitter.emit(
                "network",
                NetworkRequestEntry(
                    target_id=msg["targetId"], request_id=msg["requestId"], method=msg["method"], url=msg["url"],
                    resource_type=msg["resourceType"], status=msg.get("status"), error_text=msg.get("errorText"),
                    from_cache=msg.get("fromCache", False), duration_ms=msg.get("durationMs"),
                    encoded_bytes=msg.get("encodedBytes"), started_at=msg.get("startedAt", 0.0),
                ),
            )
        elif t == "network.summary":
            self.emitter.emit(
                "networksummary",
                NetworkSummaryEntry(
                    target_id=msg["targetId"], window_ms=msg["windowMs"], requests=msg["requests"], failed=msg["failed"],
                    bytes_in=msg["bytesIn"], bytes_out=msg["bytesOut"], slowest=msg.get("slowest", []),
                ),
            )
        # every other broadcast is not needed by this build's surface

    # ------------------------------------------------------------------
    # Standing down: a human watching a
    # browser an agent is driving has to be able to take it, and the
    # agent has to actually stop, not merely be told.
    # ------------------------------------------------------------------

    def _requester_kind(self, by_viewer_id: str) -> str:
        entry = self.viewers_by_id.get(by_viewer_id)
        return "automation" if entry is not None and entry.get("kind") == "agent" else "human"

    def _stand_down(self, ev: ControlYieldEvent) -> None:
        self._enter_stand_down(ev)
        self._complete_stand_down(ev)

    def _enter_stand_down(self, ev: ControlYieldEvent) -> None:
        self.yield_by_target[ev.target_id] = ev
        lease = self.leases.get(ev.target_id)
        if lease is not None:
            lease._suspend_auto_renew()
        if ev.resume_not_before is not None:
            prior = self.requeue_blocked_until.get(ev.target_id, 0)
            self.requeue_blocked_until[ev.target_id] = max(prior, ev.resume_not_before)

    def _complete_stand_down(self, ev: ControlYieldEvent) -> None:
        for cb in list(self.yield_cbs):
            try:
                cb(ev)
            except Exception:
                pass
        lease = self.leases.get(ev.target_id)
        if ev.phase == "requested" and self.release_on_yield and lease is not None:
            reason = "force_claimed" if ev.reason == "force_claim" else ("preempted_by_human" if ev.human else "preempted_by_agent")
            asyncio.ensure_future(lease._release_yielding(reason))  # type: ignore[arg-type]

    def _end_stand_down(self, target_id: str) -> None:
        if self.yield_by_target.pop(target_id, None) is None:
            return
        self.requeue_blocked_until.pop(target_id, None)
        lease = self.leases.get(target_id)
        if lease is not None:
            lease._resume_auto_renew()

    def yield_for(self, target_id: str) -> Optional[ControlYieldEvent]:
        return self.yield_by_target.get(target_id)

    def assert_may_dispatch(self, target_id: str, action: str) -> None:
        ev = self.yield_by_target.get(target_id)
        if ev is None:
            return
        who = "this client yielded control" if ev.reason == "voluntary" else f"{ev.by_label or 'another viewer'} ({'a person' if ev.human else 'an agent'}) took control"
        raise AutomationError(
            "LEASE_REVOKED",
            f"{action}() refused: {who} on {target_id}. This client has stood down and will not dispatch input until control is granted again.",
            {
                "yielded": True,
                "phase": ev.phase,
                "reason": ev.reason,
                "human": ev.human,
                "byLabel": ev.by_label,
                **({"resumeNotBefore": ev.resume_not_before} if ev.resume_not_before is not None else {}),
            },
        )

    def begin_in_flight(self, action: str, target_id: str) -> InFlightAction:
        entry = InFlightAction(action=action, target_id=target_id, started_at=time.time() * 1000)
        self._in_flight_actions.add(entry)
        return entry

    def end_in_flight(self, entry: InFlightAction) -> None:
        self._in_flight_actions.discard(entry)

    def in_flight_for(self, target_id: str) -> List[InFlightAction]:
        return [e for e in self._in_flight_actions if e.target_id == target_id]

    def someone_else_holds(self, target_id: str) -> bool:
        state = self.lease_state_by_target.get(target_id)
        holder = state.get("holderViewerId") if state else None
        return holder is not None and holder != self.viewer_id

    def has_capability(self, cap: str) -> bool:
        return cap in self.granted

    def set_network_feed_subscribed(self, target_id: str, on: bool) -> None:
        """Records whether ``target_id`` currently has the ``network``
        diagnostics feed on, read only by
        :meth:`~browserglass.client.AutomationClient.wait_for_network_idle`
        to fail fast when nobody subscribed rather than waiting silently
        on a feed nobody turned on.

        Mirrors the TypeScript SDK's ``networkFeedByCore``, a module-level
        ``WeakMap<AutomationCore, Map<string, boolean>>`` kept OUTSIDE
        ``AutomationCore`` there (that file's own doc: this state belongs
        to one verb, not to every method the class's own fields serve). A
        plain instance field here instead: Python has no built-in
        weak-map-keyed-by-object idiom as unremarkable as a
        ``WeakMap``, and every other per-connection table this class
        tracks (``nav_state_by_target``, ``lease_state_by_target``, ...)
        is already an ordinary field, so a second data structure bolted on
        beside this class for one boolean would buy nothing."""
        self._network_feed_by_target[target_id] = on

    def is_network_feed_subscribed(self, target_id: str) -> bool:
        return self._network_feed_by_target.get(target_id) is True

    def has_control(self, target_id: str) -> bool:
        lease = self.leases.get(target_id)
        return lease is not None and lease.is_valid

    def consume_step(self) -> None:
        if self._steps_used >= self.step_budget:
            raise AutomationError("BUDGET_EXHAUSTED", f"step budget of {self.step_budget} exhausted", {"stepBudget": self.step_budget})
        self._steps_used += 1

    def record_action(self, rec: ActionRecord) -> None:
        if self._on_action_hook is None:
            return
        try:
            self._on_action_hook(rec)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Wire plumbing
    # ------------------------------------------------------------------

    async def send(self, t: str, payload: Mapping[str, Any]) -> None:
        if t.startswith("input."):
            target_id = payload.get("targetId")
            if isinstance(target_id, str):
                self.assert_may_dispatch(target_id, t)
        await self.transport.send(t, payload)

    async def request(self, t: str, payload: Mapping[str, Any], timeout_ms: Optional[float] = None) -> Envelope:
        return await self.transport.request(t, payload, timeout_ms if timeout_ms is not None else self.default_timeout_ms)

    async def await_message(self, predicate: Callable[[Envelope], bool], timeout_ms: float) -> Envelope:
        return await self.transport.await_message(predicate, timeout_ms)

    def begin_wait(self, predicate: Callable[[Envelope], bool], timeout_ms: Optional[float] = None):
        """Registers synchronously, before any `send()` placed after this
        call can race it. See `Transport.begin_wait`'s own doc."""
        return self.transport.begin_wait(predicate, timeout_ms)

    def new_id(self) -> str:
        return new_id()

    def remember_gen(self, target_id: str, gen: int) -> None:
        """Refuses to cache 0: it is what a server-side fallback produces
        for a target with no per-target state yet, never a real
        generation. See the TypeScript `AutomationCore.rememberGen`'s own
        long comment for exactly what caching a stray 0 breaks (every
        `input.*` for that target, silently, for the life of the
        client)."""
        if not isinstance(gen, int) or gen < 1:
            return
        self.gen_by_target[target_id] = gen

    def forget_gen(self, target_id: str) -> None:
        self.gen_by_target.pop(target_id, None)

    async def ensure_gen(self, target_id: str) -> int:
        known = self.gen_by_target.get(target_id)
        if known is not None:
            return known
        reply = await self.request(
            "target.probe",
            {"targetId": target_id, "x": 0, "y": 0, "fw": self.viewport["width"], "fh": self.viewport["height"], "detail": "hover"},
        )
        gen = reply["gen"]
        self.remember_gen(target_id, gen)
        return gen

    async def close(self) -> None:
        if self._destroyed:
            return
        self._destroyed = True
        for target_id, lease in list(self.leases.items()):
            try:
                await self.transport.send("control.release", {"targetId": target_id, "leaseId": lease.lease_id})
            except Exception:
                pass
        for lease in self.leases.values():
            lease._mark_revoked("session_ended")
        self.leases.clear()
        self.emitter.clear()
        self.yield_cbs.clear()
        await self.transport.close()
