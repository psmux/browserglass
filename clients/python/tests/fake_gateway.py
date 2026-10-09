"""A scripted, fully async ``WebSocketLike`` test double, playing the
server's side of a ``bgls.v1`` connection.

Modelled on ``packages/automation/test/fake-gateway.ts`` from the
TypeScript SDK's own test suite: there is no live gateway to test
against, so :class:`~browserglass.client.AutomationClient` is driven end
to end against this fake instead, speaking just enough of ``bgls.v1`` to
exercise connect, control leases, navigation, evaluate, and the wire
framing generally.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Union

Handler = Callable[[Dict[str, Any]], Optional[Union[Dict[str, Any], List[Dict[str, Any]]]]]


class FakeGatewaySocket:
    """A ``WebSocketLike`` double. ``send()`` decodes JSON, dispatches to
    a registered handler for that message's ``t``, and queues whatever
    the handler returns (one envelope, several, or nothing) for the next
    ``recv()``. A handler's return value has ``re`` filled in
    automatically from the request's ``id`` when the reply omits it, and
    ``v``/``ts`` filled in the same way."""

    def __init__(self, handlers: Optional[Dict[str, Handler]] = None) -> None:
        self.handlers: Dict[str, Handler] = dict(handlers or {})
        self.sent: List[Union[str, bytes]] = []
        self._incoming: "asyncio.Queue[Union[str, bytes]]" = asyncio.Queue()
        self.closed = False

    def sent_json_messages(self) -> List[Dict[str, Any]]:
        return [json.loads(d) for d in self.sent if isinstance(d, str)]

    def last_sent_json(self) -> Dict[str, Any]:
        msgs = self.sent_json_messages()
        if not msgs:
            raise AssertionError("no JSON message sent yet")
        return msgs[-1]

    async def send(self, data: Union[str, bytes]) -> None:
        if self.closed:
            raise RuntimeError("FakeGatewaySocket.send() called after close()")
        self.sent.append(data)
        if isinstance(data, (bytes, bytearray)):
            return  # binary frames (upload chunks) have no scripted reply by default
        msg = json.loads(data)
        handler = self.handlers.get(msg.get("t"))
        if handler is None:
            return
        reply = handler(msg)
        if reply is None:
            return
        replies = reply if isinstance(reply, list) else [reply]
        for r in replies:
            envelope = {"v": 1, "ts": time.time() * 1000, **r}
            if "re" not in envelope and "id" in msg:
                envelope["re"] = msg["id"]
            await self.push(envelope)

    async def push(self, envelope: Dict[str, Any]) -> None:
        """Delivers ``envelope`` to the client as if the server sent it
        unprompted (a broadcast) or in reply to a request."""
        await self._incoming.put(json.dumps(envelope))

    async def recv(self) -> Union[str, bytes]:
        if self.closed and self._incoming.empty():
            raise ConnectionError("FakeGatewaySocket closed")
        return await self._incoming.get()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True
        await self._incoming.put(b"")  # unblock a pending recv(); pump treats bytes as a no-op frame


def make_welcome(hello_id: str, **overrides: Any) -> Dict[str, Any]:
    """A complete, realistic ``welcome`` envelope, with sane defaults for
    every field :class:`browserglass.transport.Welcome` and
    :class:`browserglass.core.AutomationCore` read, overridable per test."""
    base: Dict[str, Any] = {
        "t": "welcome",
        "re": hello_id,
        "sq": 1,
        "version": 1,
        "serverVersion": "test",
        "downgraded": False,
        "viewerId": "v_test",
        "sessionId": "s_test",
        "tenantId": "ten_test",
        "appId": "app_test",
        "instance": {
            "instanceId": "i_test",
            "state": "ready",
            "engine": "chromium",
            "channel": "stable",
            "engineVersion": "128.0",
            "headless": True,
            "runtime": "host",
            "nodeId": None,
            "profile": {"mode": "ephemeral", "key": "k", "sizeBytes": 0},
            "viewport": {"width": 1280, "height": 800, "dpr": 1},
            "startedAt": time.time() * 1000,
        },
        "targets": [
            {"targetId": "t1", "type": "page", "url": "about:blank", "title": "", "active": True, "loading": False, "canGoBack": False, "canGoForward": False}
        ],
        "granted": ["view", "control", "navigate", "evaluate", "upload", "devtools", "capture", "automation", "probe"],
        "lease": {"byTarget": {}, "defaultTtlMs": 60000, "renewWithinMs": 5000, "idleReleaseMs": 300000, "maxQueue": 8},
        "presence": {"viewers": []},
        "limits": {
            "maxStreams": 8, "maxBacklog": 100, "maxBufferedBytes": 1_000_000, "maxControlMsgBytes": 65536,
            "maxUploadBytes": 100_000_000, "maxUploadChunkBytes": 262144, "inputRatePerSec": 100,
            "controlRatePerSec": 20, "navRatePerSec": 5, "maxTargets": 16, "maxSessionDurationMs": 3_600_000, "idleTimeoutMs": 300_000,
        },
        "ack": {"policy": "per-stream", "everyNFrames": 30, "maxAckIntervalMs": 500, "required": False},
        "streaming": {"codec": "jpeg", "fallbackCodec": "jpeg", "maxFps": 30, "keyframeIntervalMs": 2000, "adaptive": True, "qualityProfiles": []},
        "resume": {"token": "r_test", "windowMs": 30000, "issuedAt": time.time() * 1000},
        "sessionToken": "st_test",
        "sessionTokenExpiresAt": time.time() * 1000 + 3_600_000,
        "resumed": False,
        "reauth": False,
        "serverTime": time.time() * 1000,
        "notices": [],
    }
    base.update(overrides)
    return base


def hello_then_welcome_handlers(**welcome_overrides: Any) -> Dict[str, Handler]:
    """The one handler every test needs: answer ``hello`` with a scripted
    ``welcome``."""

    def on_hello(msg: Dict[str, Any]) -> Dict[str, Any]:
        return make_welcome(msg["id"], **welcome_overrides)

    return {"hello": on_hello}


def socket_factory_for(socket: FakeGatewaySocket):
    """Builds a ``socket_factory`` (the shape
    :class:`browserglass.transport.Transport` takes) that always hands
    back the given, already-configured fake socket."""

    async def factory(url: str, subprotocols: List[str]) -> FakeGatewaySocket:
        return socket

    return factory
