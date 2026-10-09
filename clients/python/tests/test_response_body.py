"""``client.diagnostics.response_body()`` against the scripted fake
gateway.

Mirrors ``packages/automation/test/client/response-body.test.ts`` in the
TypeScript SDK's own suite: mostly error mapping, since
``wire/messages/response-body.ts`` exists specifically to refuse a
``requestId`` a caller was not shown, to refuse an oversized body rather
than truncate it, and to say a body is gone rather than answer with an
empty one, and each of those has to surface through ``AutomationClient``
as a distinguishable ``AutomationError``.
"""

from __future__ import annotations

import asyncio

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client


@pytest.mark.asyncio
async def test_response_body_refuses_locally_without_devtools_capability():
    client, socket = await connect_client({}, granted=["view", "control", "evaluate"])
    try:
        before = len(socket.sent_json_messages())
        with pytest.raises(AutomationError) as excinfo:
            await client.diagnostics.response_body("req_1")
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "devtools"
        # No round trip: the refusal happens before anything is sent.
        assert len(socket.sent_json_messages()) == before
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_response_body_sends_target_and_request_id_and_resolves_body():
    def handler(msg):
        return {
            "t": "page.responsebody.got",
            "targetId": msg["targetId"],
            "requestId": msg["requestId"],
            "body": '{"ok":true}',
            "base64Encoded": False,
            "sizeBytes": 11,
        }

    client, socket = await connect_client({"page.responsebody.get": handler})
    try:
        result = await client.diagnostics.response_body("req_42")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.responsebody.get"]
        assert sent[-1]["targetId"] == client.target_id
        assert sent[-1]["requestId"] == "req_42"
        assert result.body == '{"ok":true}'
        assert result.base64_encoded is False
        assert result.size_bytes == 11
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_response_body_carries_base64_binary_body_unchanged():
    def handler(msg):
        return {
            "t": "page.responsebody.got",
            "targetId": msg["targetId"],
            "requestId": msg["requestId"],
            "body": "ZmFrZQ==",
            "base64Encoded": True,
            "sizeBytes": 4,
        }

    client, socket = await connect_client({"page.responsebody.get": handler})
    try:
        result = await client.diagnostics.response_body("req_bin")
        assert result.base64_encoded is True
        assert result.body == "ZmFrZQ=="
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_response_body_unknown_request_surfaces_as_policy_denied():
    def handler(msg):
        return {
            "t": "error",
            "code": "bgls.error.responsebody.unknown_request",
            "category": "responsebody",
            "message": "This requestId was never sent to you as a network.request on this target.",
            "fatal": False,
            "retryable": False,
        }

    client, socket = await connect_client({"page.responsebody.get": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.diagnostics.response_body("guessed")
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["wire_code"] == "bgls.error.responsebody.unknown_request"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_response_body_too_large_surfaces_as_policy_denied_with_sizes():
    def handler(msg):
        return {
            "t": "error",
            "code": "bgls.error.responsebody.too_large",
            "category": "responsebody",
            "message": "The response body is 5000000 bytes, over the 4194304 byte ceiling.",
            "fatal": False,
            "retryable": False,
            "context": {"sizeBytes": 5000000, "maxBytes": 4194304},
        }

    client, socket = await connect_client({"page.responsebody.get": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.diagnostics.response_body("req_big")
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["wire_code"] == "bgls.error.responsebody.too_large"
        assert excinfo.value.details["context"] == {"sizeBytes": 5000000, "maxBytes": 4194304}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_response_body_unavailable_surfaces_as_not_found_not_empty_body():
    def handler(msg):
        return {
            "t": "error",
            "code": "bgls.error.responsebody.unavailable",
            "category": "responsebody",
            "message": "Chrome no longer has this body buffered.",
            "fatal": False,
            "retryable": False,
        }

    client, socket = await connect_client({"page.responsebody.get": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.diagnostics.response_body("req_gone")
        assert excinfo.value.code == "NOT_FOUND"
        assert excinfo.value.details["wire_code"] == "bgls.error.responsebody.unavailable"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_response_body_request_id_comes_from_a_network_event():
    """The end-to-end shape a caller actually uses: subscribe to
    network, watch a submit request happen, and read its body off the
    request_id that event carried, snake_case, matching this SDK's own
    naming rule.
    """

    def responsebody_handler(msg):
        return {
            "t": "page.responsebody.got",
            "targetId": msg["targetId"],
            "requestId": msg["requestId"],
            "body": "<html>confirmed</html>",
            "base64Encoded": False,
            "sizeBytes": 23,
        }

    client, socket = await connect_client(
        {
            "diagnostics.subscribe": lambda msg: {"t": "diagnostics.subscribed", "targetId": msg["targetId"], "console": False, "errors": False, "network": True},
            "page.responsebody.get": responsebody_handler,
        }
    )
    try:
        seen = []
        client.on("network", lambda ev: seen.append(ev))
        await client.diagnostics.subscribe(network=True)

        await socket.push(
            {
                "t": "network.request", "targetId": client.target_id, "requestId": "req_submit", "method": "POST",
                "url": "https://shop.example.com/checkout", "resourceType": "fetch", "status": 200, "errorText": None,
                "fromCache": False, "durationMs": 40, "encodedBytes": 23, "startedAt": 0,
            }
        )
        await asyncio.sleep(0.05)

        assert len(seen) == 1
        assert seen[0].request_id == "req_submit"

        result = await client.diagnostics.response_body(seen[0].request_id)
        assert result.body == "<html>confirmed</html>"
    finally:
        await client.close()
