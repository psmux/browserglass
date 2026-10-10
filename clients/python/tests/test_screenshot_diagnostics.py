from __future__ import annotations

import asyncio

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client


def capture_handler(data="aGVsbG8=", fmt="png"):
    def handler(msg):
        return {
            "t": "target.captured", "captureId": "cap_1", "targetId": msg["targetId"], "format": fmt,
            "width": 1280, "height": 800, "dpr": 1, "sizeBytes": 6, "gen": 3, "fullPage": False, "data": data, "downscaled": False,
        }

    return handler


@pytest.mark.asyncio
async def test_screenshot_returns_inline_data():
    client, socket = await connect_client({"target.capture": capture_handler()})
    try:
        shot = await client.screenshot(format="png")
        assert shot.format == "png"
        assert shot.data == "aGVsbG8="
        assert shot.width == 1280
    finally:
        await client.close()


def rate_limited_then(handler, refusals, retry_after_ms=50):
    """Refuses the first ``refusals`` captures with ``bgls.error.limit.rate``."""
    calls = []

    def wrapped(msg):
        calls.append(msg)
        if len(calls) <= refusals:
            reply = {
                "t": "error", "code": "bgls.error.limit.rate", "category": "limit",
                "message": "Rate limit exceeded for target.capture.", "fatal": False, "retryable": True,
            }
            if retry_after_ms is not None:
                reply["retryAfterMs"] = retry_after_ms
            return reply
        return handler(msg)

    return wrapped, calls


@pytest.mark.asyncio
async def test_screenshot_retries_once_after_rate_limit():
    handler, calls = rate_limited_then(capture_handler(), refusals=1, retry_after_ms=50)
    client, socket = await connect_client({"target.capture": handler})
    try:
        loop = asyncio.get_running_loop()
        started = loop.time()
        shot = await client.screenshot()
        assert shot.data == "aGVsbG8="
        assert len(calls) == 2
        assert loop.time() - started >= 0.045
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_screenshot_second_rate_limit_refusal_raises_policy_denied():
    handler, calls = rate_limited_then(capture_handler(), refusals=2, retry_after_ms=20)
    client, socket = await connect_client({"target.capture": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.screenshot()
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["retry_after_ms"] == 20
        assert len(calls) == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_screenshot_does_not_wait_for_a_long_retry_hint():
    handler, calls = rate_limited_then(capture_handler(), refusals=1, retry_after_ms=60_000)
    client, socket = await connect_client({"target.capture": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.screenshot()
        assert excinfo.value.code == "POLICY_DENIED"
        assert len(calls) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_screenshot_without_inline_data_is_not_implemented():
    def handler(msg):
        return {
            "t": "target.captured", "captureId": "cap_2", "targetId": msg["targetId"], "format": "png",
            "width": 1280, "height": 800, "dpr": 1, "sizeBytes": 999_999, "gen": 3, "fullPage": False,
            "downloadId": "dl_1", "downscaled": False,
        }

    client, socket = await connect_client({"target.capture": handler})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.screenshot()
        assert excinfo.value.code == "NOT_IMPLEMENTED"
        assert "download" in excinfo.value.message
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_diagnostics_subscribe_needs_devtools_capability():
    client, socket = await connect_client({}, granted=["view", "control", "evaluate"])
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.diagnostics.subscribe()
        assert excinfo.value.code == "POLICY_DENIED"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_diagnostics_subscribe_reports_what_the_server_actually_turned_on():
    def handler(msg):
        return {"t": "diagnostics.subscribed", "targetId": msg["targetId"], "console": True, "errors": True, "network": False}

    client, socket = await connect_client({"diagnostics.subscribe": handler})
    try:
        sub = await client.diagnostics.subscribe(network=True)
        # The request asked for network, but the reply is what's trusted.
        assert sub.network is False
        assert sub.console is True
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_console_and_network_events_reach_on_handler():
    client, socket = await connect_client({"diagnostics.subscribe": lambda msg: {"t": "diagnostics.subscribed", "targetId": msg["targetId"], "console": True, "errors": True, "network": True}})
    try:
        console_entries = []
        network_entries = []
        client.on("console", lambda ev: console_entries.append(ev))
        client.on("network", lambda ev: network_entries.append(ev))
        await client.diagnostics.subscribe()

        await socket.push({"t": "console.entry", "targetId": "t1", "level": "error", "text": "boom"})
        await socket.push({"t": "network.request", "targetId": "t1", "requestId": "r1", "method": "GET", "url": "https://x", "resourceType": "xhr", "status": 200, "errorText": None, "fromCache": False, "durationMs": 12, "encodedBytes": 100, "startedAt": 0})
        await asyncio.sleep(0.05)

        assert len(console_entries) == 1
        assert console_entries[0].text == "boom"
        assert len(network_entries) == 1
        assert network_entries[0].url == "https://x"
        assert network_entries[0].request_id == "r1"
    finally:
        await client.close()
