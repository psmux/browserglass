from __future__ import annotations

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client


@pytest.mark.asyncio
async def test_connect_sends_hello_with_bearer_token_and_subprotocol():
    client, socket = await connect_client()
    try:
        hello = socket.sent_json_messages()[0]
        assert hello["t"] == "hello"
        assert hello["auth"] == {"scheme": "bearer", "token": "tok"}
        assert hello["versions"] == [1]
        assert hello["client"]["runtime"] == "agent"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_welcome_populates_core_state():
    client, socket = await connect_client()
    try:
        assert client.viewer_id == "v_test"
        assert client.session_id == "s_test"
        assert client.instance_id == "i_test"
        assert "control" in client.granted
        assert client.target_id == "t1"
        assert len(client.targets) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_connect_binds_to_explicit_target_id():
    client, socket = await connect_client(
        targets=[
            {"targetId": "a", "type": "page", "url": "about:blank", "title": "", "active": False, "loading": False, "canGoBack": False, "canGoForward": False},
            {"targetId": "b", "type": "page", "url": "about:blank", "title": "", "active": True, "loading": False, "canGoBack": False, "canGoForward": False},
        ]
    )
    try:
        assert client.target_id == "b"  # the active one, absent an explicit choice
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_connect_rejects_instance_id_mismatch():
    from browserglass.client import AutomationClient
    from fake_gateway import FakeGatewaySocket, hello_then_welcome_handlers, socket_factory_for

    socket = FakeGatewaySocket(hello_then_welcome_handlers())
    with pytest.raises(AutomationError) as excinfo:
        await AutomationClient.connect(
            endpoint="wss://fake.example/socket",
            token="tok",
            instance_id="not-the-real-one",
            socket_factory=socket_factory_for(socket),
            ping_interval_s=None,
        )
    assert excinfo.value.code == "INSTANCE_GONE"


@pytest.mark.asyncio
async def test_connect_with_no_targets_raises_not_found():
    from browserglass.client import AutomationClient
    from fake_gateway import FakeGatewaySocket, hello_then_welcome_handlers, socket_factory_for

    socket = FakeGatewaySocket(hello_then_welcome_handlers(targets=[]))
    with pytest.raises(AutomationError) as excinfo:
        await AutomationClient.connect(
            endpoint="wss://fake.example/socket", token="tok", socket_factory=socket_factory_for(socket), ping_interval_s=None
        )
    assert excinfo.value.code == "NOT_FOUND"
