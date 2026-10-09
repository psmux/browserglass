"""The low-level `bgls.v1` connection: opens the socket, sends `hello`,
waits for `welcome`, and pumps every subsequent frame to whoever is
listening.

This is deliberately thin and deliberately NOT the place capability
checks, lease bookkeeping, or the stand-down gate live; that is
:mod:`browserglass.core`. `Transport` only knows how to get JSON envelopes
on and off one socket and how to answer "what came back for id X". It
mirrors the split between `@browserglass/client`'s `Transport` and
`@browserglass/automation`'s `AutomationCore` in the TypeScript SDK,
minus that class's reconnect/resume state machine: a first, honest
Python port ships a single connection that raises when it drops rather
than silently reconnecting behind the caller's back. See this package's
README, "Not implemented yet", for what reconnect would need.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Protocol,
    Union,
)

from .errors import AutomationError

Envelope = Dict[str, Any]


class WebSocketLike(Protocol):
    """The minimal socket surface :class:`Transport` needs. A test double
    only has to implement this; production code gets it from
    :func:`default_socket_factory`, backed by the ``websockets`` package."""

    async def send(self, message: Union[str, bytes]) -> None: ...

    async def recv(self) -> Union[str, bytes]: ...

    async def close(self, code: int = 1000, reason: str = "") -> None: ...


SocketFactory = Callable[[str, List[str]], Awaitable[WebSocketLike]]


async def default_socket_factory(url: str, subprotocols: List[str]) -> WebSocketLike:
    """Opens a real `bgls.v1` socket with the ``websockets`` package.

    Imported lazily so a caller who only needs the pure orchestration
    logic (tested against a scripted socket) never pays for importing a
    real network library.
    """
    import websockets

    return await websockets.connect(url, subprotocols=subprotocols)  # type: ignore[return-value]


@dataclass
class ClientIdentity:
    name: str = "browserglass-python"
    version: str = "0.1.0"
    runtime: str = "agent"


@dataclass
class Welcome:
    """The parsed `welcome` envelope. Every field on the wire message is
    kept, since :mod:`browserglass.core` reads several of them
    (``lease``, ``limits``, ``granted``) that a thinner shape would have
    dropped."""

    raw: Envelope
    viewer_id: str
    session_id: str
    tenant_id: str
    app_id: str
    instance: Mapping[str, Any]
    targets: List[Mapping[str, Any]]
    granted: List[str]
    lease: Mapping[str, Any]
    presence: Mapping[str, Any]
    limits: Mapping[str, Any]
    session_token: str
    session_token_expires_at: float

    @staticmethod
    def from_envelope(msg: Envelope) -> "Welcome":
        return Welcome(
            raw=msg,
            viewer_id=msg["viewerId"],
            session_id=msg["sessionId"],
            tenant_id=msg.get("tenantId", ""),
            app_id=msg.get("appId", ""),
            instance=msg["instance"],
            targets=list(msg.get("targets", [])),
            granted=list(msg.get("granted", [])),
            lease=msg.get("lease", {}),
            presence=msg.get("presence", {}),
            limits=msg.get("limits", {}),
            session_token=msg.get("sessionToken", ""),
            session_token_expires_at=msg.get("sessionTokenExpiresAt", 0),
        )


def new_correlation_id() -> str:
    """Mints an opaque correlation id for ``Envelope.id``. Never the
    ``<prefix>_<ULID>`` shape the server mints for its own ids."""
    return f"c_{uuid.uuid4().hex}"


class Transport:
    """One `bgls.v1` connection.

    ``connect()`` opens the socket, sends `hello`, and resolves once
    `welcome` has arrived. After that, :meth:`send` fires a message with
    no reply expected, :meth:`request` sends one and awaits the envelope
    whose ``re`` matches, and :meth:`await_message` awaits the next
    envelope satisfying an arbitrary predicate (broadcasts like
    ``target.created`` or ``control.state`` have no ``re`` and can only be
    picked up this way).
    """

    def __init__(
        self,
        *,
        endpoint: str,
        token: str,
        default_timeout_ms: float = 15000,
        client_identity: Optional[ClientIdentity] = None,
        socket_factory: Optional[SocketFactory] = None,
        ping_interval_s: Optional[float] = 5.0,
    ) -> None:
        self._endpoint = endpoint
        self._token = token
        self.default_timeout_ms = default_timeout_ms
        self._identity = client_identity or ClientIdentity()
        self._socket_factory = socket_factory or default_socket_factory
        self._ping_interval_s = ping_interval_s

        self._ws: Optional[WebSocketLike] = None
        self._pump_task: Optional[asyncio.Task[None]] = None
        self._ping_task: Optional[asyncio.Task[None]] = None
        self._closed = False
        self._welcome: Optional[Welcome] = None

        # Every listener registered through `on_message`. Kept as a plain
        # list rather than an asyncio.Queue per waiter, because a single
        # incoming frame commonly has to satisfy more than one predicate
        # (an `await_message` waiter AND a connection-wide subscriber).
        self._message_listeners: List[Callable[[Envelope], None]] = []
        self._closed_listeners: List[Callable[[BaseException], None]] = []

    @property
    def welcome(self) -> Optional[Welcome]:
        return self._welcome

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and not self._closed

    def on_message(self, cb: Callable[[Envelope], None]) -> Callable[[], None]:
        """Subscribes to every inbound envelope. Returns an unsubscribe."""
        self._message_listeners.append(cb)

        def unsubscribe() -> None:
            try:
                self._message_listeners.remove(cb)
            except ValueError:
                pass

        return unsubscribe

    def on_closed(self, cb: Callable[[BaseException], None]) -> Callable[[], None]:
        """Fires once, when the pump loop ends (socket closed or errored)."""
        self._closed_listeners.append(cb)

        def unsubscribe() -> None:
            try:
                self._closed_listeners.remove(cb)
            except ValueError:
                pass

        return unsubscribe

    async def connect(self) -> Welcome:
        if self._ws is not None:
            raise RuntimeError("Transport.connect() called twice")
        self._ws = await self._socket_factory(self._endpoint, ["bgls.v1"])

        hello_id = new_correlation_id()
        hello: Envelope = {
            "v": 1,
            "t": "hello",
            "id": hello_id,
            "ts": _now_ms(),
            "versions": [1],
            "minVersion": 1,
            "client": {
                "name": self._identity.name,
                "version": self._identity.version,
                "runtime": self._identity.runtime,
            },
            "capabilities": {
                "codecs": [],
                "binaryFrames": False,
                "input": ["mouse", "key", "text"],
            },
            "viewport": {"width": 0, "height": 0, "dpr": 1, "visible": False, "fitMode": "contain"},
            "auth": {"scheme": "bearer", "token": self._token},
        }

        # The pump has to be running before `hello` goes out: a fake or a
        # very fast real gateway can answer within the same event-loop
        # tick, and a listener registered afterwards would miss it.
        self._pump_task = asyncio.create_task(self._pump())

        welcome_fut: "asyncio.Future[Envelope]" = asyncio.get_event_loop().create_future()

        def on_msg(msg: Envelope) -> None:
            # A real gateway's own `welcome.re` does not always echo this
            # `hello.id` back (observed directly against a live gateway:
            # it can arrive empty). The TypeScript `Transport`'s own
            # `handleWelcome` tolerates the same mismatch (a warning log,
            # not a failure): the first `welcome` on a connection that has
            # sent exactly one `hello` and received no `welcome` yet is
            # unambiguously the answer to it, `re` notwithstanding.
            if msg.get("t") == "welcome" and not welcome_fut.done():
                welcome_fut.set_result(msg)

        unsubscribe = self.on_message(on_msg)
        try:
            await self._ws.send(json.dumps(hello))
            welcome_msg = await asyncio.wait_for(welcome_fut, timeout=self.default_timeout_ms / 1000)
        finally:
            unsubscribe()

        self._welcome = Welcome.from_envelope(welcome_msg)
        if self._ping_interval_s is not None:
            self._ping_task = asyncio.create_task(self._ping_loop())
        return self._welcome

    async def _pump(self) -> None:
        assert self._ws is not None
        exc: BaseException = RuntimeError("transport closed")
        try:
            while True:
                raw = await self._ws.recv()
                if isinstance(raw, (bytes, bytearray)):
                    # Binary frames (video, downloads) are out of this
                    # client's scope; see README "Not implemented yet".
                    continue
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                for listener in list(self._message_listeners):
                    listener(msg)
        except asyncio.CancelledError:
            exc = asyncio.CancelledError()
            raise
        except BaseException as err:  # noqa: BLE001 - reported to listeners, not swallowed
            exc = err
        finally:
            self._closed = True
            for cb in list(self._closed_listeners):
                cb(exc)

    async def _ping_loop(self) -> None:
        assert self._ping_interval_s is not None
        try:
            while True:
                await asyncio.sleep(self._ping_interval_s)
                if self._closed or self._ws is None:
                    return
                await self._ws.send(json.dumps({"v": 1, "t": "ping", "ts": _now_ms(), "cts": _now_ms()}))
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 - a failed ping surfaces through the pump loop's own close
            return

    async def send(self, t: str, payload: Mapping[str, Any]) -> None:
        """Fires one envelope with no reply expected. Raises if not
        connected.

        Awaited, unlike a browser's synchronous ``WebSocket.send()``:
        Python's ``websockets`` package exposes an async ``send()``, and
        awaiting it here (rather than firing it into the background with
        ``ensure_future``) is what keeps two messages sent back to back
        landing on the wire in the order this SDK called them in, which
        matters for `input.*` frame pairs and for a caller reading its
        own write straight back out of a test double."""
        if self._ws is None or self._closed:
            raise AutomationError("INSTANCE_GONE", f"cannot send '{t}': the transport is not connected")
        envelope: Envelope = {"v": 1, "t": t, "ts": _now_ms(), **payload}
        await self._ws.send(json.dumps(envelope))

    async def send_binary(self, data: bytes) -> None:
        if self._ws is None or self._closed:
            raise AutomationError("INSTANCE_GONE", "cannot send a binary frame: the transport is not connected")
        await self._ws.send(data)

    async def request(
        self,
        t: str,
        payload: Mapping[str, Any],
        timeout_ms: Optional[float] = None,
    ) -> Envelope:
        """Sends ``t`` with a fresh correlation id and awaits the first
        reply whose ``re`` matches it. A server ``error`` reply raises
        :class:`AutomationError` via :meth:`AutomationError.from_error_msg`."""
        if self._ws is None or self._closed:
            raise AutomationError("INSTANCE_GONE", f"cannot send '{t}': the transport is not connected")
        cid = new_correlation_id()
        # `begin_wait()` registers its listener SYNCHRONOUSLY, before
        # `send()` goes out. This matters: a fake or a very fast real
        # gateway can answer within the same event-loop turn our own
        # `send()` runs in, and a listener registered only once its
        # waiter coroutine is awaited would be registered too late to
        # see it. See `begin_wait()`'s own doc for why a plain
        # `async def` here would not give the same guarantee in Python.
        waiter = self.begin_wait(lambda m: m.get("re") == cid, timeout_ms)
        envelope: Envelope = {"v": 1, "t": t, "id": cid, "ts": _now_ms(), **payload}
        await self._ws.send(json.dumps(envelope))
        msg = await waiter
        if msg.get("t") == "error":
            raise AutomationError.from_error_msg(msg)
        return msg

    def begin_wait(
        self,
        predicate: Callable[[Envelope], bool],
        timeout_ms: Optional[float] = None,
    ) -> Awaitable[Envelope]:
        """Registers a listener for the next envelope satisfying
        ``predicate`` RIGHT NOW, synchronously, and returns an awaitable
        that resolves to it (or raises ``TIMEOUT``/``INSTANCE_GONE``).

        This is a plain function, not ``async def``, and that is the
        whole point of it. A Python coroutine does not run a single line
        of its body until something actually awaits it: writing
        ``waiter = self.await_message(...)`` creates an inert object, and
        the registration this method exists to guarantee would not
        happen until the caller reached its own ``await waiter``, by
        which point a reply that arrived in between could already have
        been dispatched to no listener at all and lost. Splitting
        "subscribe" (synchronous, happens on this call) from "wait"
        (the coroutine this returns) is what lets a caller subscribe,
        THEN send, THEN await, with the middle step unable to race the
        first. :meth:`await_message` is the same operation spelled as a
        single ``async def`` for a caller that has no send to place
        in between and does not care about the distinction.
        """
        loop = asyncio.get_event_loop()
        fut: "asyncio.Future[Envelope]" = loop.create_future()

        def on_msg(msg: Envelope) -> None:
            if fut.done():
                return
            try:
                if predicate(msg):
                    fut.set_result(msg)
            except Exception:  # noqa: BLE001 - a bad predicate must not wedge the pump
                pass

        unsubscribe = self.on_message(on_msg)

        def on_closed(exc: BaseException) -> None:
            if not fut.done():
                fut.set_exception(
                    AutomationError(
                        "INSTANCE_GONE",
                        "the connection closed while this request was still in flight, so no reply can arrive",
                    )
                )

        unsubscribe_closed = self.on_closed(on_closed)

        async def waiter() -> Envelope:
            try:
                if timeout_ms is None:
                    return await fut
                try:
                    return await asyncio.wait_for(fut, timeout=timeout_ms / 1000)
                except asyncio.TimeoutError as err:
                    raise AutomationError("TIMEOUT", f"timed out after {timeout_ms}ms waiting for a reply") from err
            finally:
                unsubscribe()
                unsubscribe_closed()

        return waiter()

    async def await_message(
        self,
        predicate: Callable[[Envelope], bool],
        timeout_ms: Optional[float] = None,
    ) -> Envelope:
        """Awaits the next envelope satisfying ``predicate``, or raises
        ``TIMEOUT`` after ``timeout_ms`` (``None`` waits forever). For a
        caller with no ``send()`` to place in between subscribing and
        waiting; see :meth:`begin_wait` when there is one (every request
        that expects a reply)."""
        return await self.begin_wait(predicate, timeout_ms)

    async def close(self) -> None:
        if self._closed and self._ws is None:
            return
        self._closed = True
        if self._ping_task is not None:
            self._ping_task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001 - already gone is fine
                pass
        if self._pump_task is not None:
            try:
                await asyncio.wait_for(self._pump_task, timeout=1)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._pump_task.cancel()


def _now_ms() -> float:
    return time.time() * 1000
