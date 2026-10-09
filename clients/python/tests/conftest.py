from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import time
from typing import Any, Dict, Optional

import pytest

from browserglass.client import AutomationClient

from fake_gateway import FakeGatewaySocket, hello_then_welcome_handlers, socket_factory_for


async def connect_client(handlers: Optional[Dict[str, Any]] = None, **welcome_overrides: Any):
    """Connects an :class:`AutomationClient` against a fresh
    :class:`FakeGatewaySocket`, returning ``(client, socket)``."""
    all_handlers = hello_then_welcome_handlers(**welcome_overrides)
    all_handlers.update(handlers or {})
    socket = FakeGatewaySocket(all_handlers)
    client = await AutomationClient.connect(
        endpoint="wss://fake.example/socket",
        token="tok",
        socket_factory=socket_factory_for(socket),
        ping_interval_s=None,
    )
    return client, socket


def control_granted_handler(mode: str = "exclusive", ttl_ms: float = 60000):
    def handler(msg: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "t": "control.granted",
            "targetId": msg["targetId"],
            "leaseId": "lease_1",
            "expiresAt": time.time() * 1000 + ttl_ms,
            "renewWithinMs": 5000,
            "idleReleaseMs": 300000,
            "mode": mode,
        }

    return handler
