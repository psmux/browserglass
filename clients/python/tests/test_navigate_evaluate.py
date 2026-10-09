from __future__ import annotations

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client, control_granted_handler


def nav_state_handler(url="https://example.com", title="Example"):
    def handler(msg):
        return {
            "t": "nav.state", "targetId": msg["targetId"], "url": url, "title": title, "loading": False,
            "canGoBack": True, "canGoForward": False, "securityState": "secure",
        }

    return handler


@pytest.mark.asyncio
async def test_navigate_requires_a_held_lease():
    client, socket = await connect_client()
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.navigate("https://example.com")
        assert excinfo.value.code == "LEASE_NOT_HELD"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_navigate_returns_status_and_sends_nav_goto():
    client, socket = await connect_client({"control.request": control_granted_handler(), "nav.goto": nav_state_handler()})
    try:
        await client.acquire_control()
        status = await client.navigate("https://example.com")
        assert status.url == "https://example.com"
        assert status.title == "Example"
        assert status.can_go_back is True

        goto = [m for m in socket.sent_json_messages() if m["t"] == "nav.goto"][0]
        assert goto["url"] == "https://example.com"
        assert goto["targetId"] == "t1"
        # Waits for load by default, so the page can be read straight away.
        assert goto["waitUntil"] == "load"
        assert goto["timeoutMs"] == 30000
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_navigate_wait_until_commit_sends_no_load_timeout():
    client, socket = await connect_client({"control.request": control_granted_handler(), "nav.goto": nav_state_handler()})
    try:
        await client.acquire_control()
        await client.navigate("https://example.com", wait_until="commit")
        goto = [m for m in socket.sent_json_messages() if m["t"] == "nav.goto"][-1]
        assert goto["waitUntil"] == "commit"
        assert "timeoutMs" not in goto
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_status_needs_no_lease():
    client, socket = await connect_client()
    try:
        status = await client.status()
        assert status.target_id == "t1"
        assert status.url == "about:blank"
    finally:
        await client.close()


def evaluate_ok_handler(value):
    def handler(msg):
        return {"t": "page.evaluated", "targetId": msg["targetId"], "ok": True, "resultType": "value", "value": value, "sizeBytes": 0}

    return handler


def evaluate_throw_handler(msg):
    return {
        "t": "page.evaluated", "targetId": msg["targetId"], "ok": False, "resultType": "value", "sizeBytes": 0,
        "exception": {"message": "ReferenceError: nope is not defined", "name": "ReferenceError", "stack": "at <anonymous>"},
    }


@pytest.mark.asyncio
async def test_evaluate_returns_value_and_needs_no_lease():
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("Example Domain")})
    try:
        result = await client.evaluate("document.title")
        assert result == "Example Domain"
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert sent["expression"] == "document.title"
        assert "functionDeclaration" not in sent
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_evaluate_function_passes_args():
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("hi")})
    try:
        result = await client.evaluate_function("(sel) => document.querySelector(sel)", "#foo")
        assert result == "hi"
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert sent["functionDeclaration"] == "(sel) => document.querySelector(sel)"
        assert sent["args"] == ["#foo"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_evaluate_page_exception_raises_protocol_error_with_stack():
    client, socket = await connect_client({"page.evaluate": evaluate_throw_handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.evaluate("nope()")
        assert excinfo.value.code == "PROTOCOL_ERROR"
        assert "ReferenceError" in excinfo.value.message
        assert excinfo.value.details["pageException"] is True
        assert excinfo.value.details["stack"] == "at <anonymous>"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_evaluate_without_capability_fails_locally():
    client, socket = await connect_client({}, granted=["view", "control"])
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.evaluate("1+1")
        assert excinfo.value.code == "POLICY_DENIED"
        assert len(socket.sent_json_messages()) == 1  # only hello
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wire_error_reply_maps_to_automation_error():
    def handler(msg):
        return {"t": "error", "code": "bgls.error.evaluate.timeout", "category": "evaluate", "message": "took too long"}

    client, socket = await connect_client({"page.evaluate": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.evaluate("while(true){}")
        assert excinfo.value.code == "TIMEOUT"
    finally:
        await client.close()
