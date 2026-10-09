"""``client.wait_for_download()`` and ``client.wait_for_network_idle()``
against the scripted fake gateway.

There is no sibling suite in the TypeScript SDK's own tests to mirror
line for line (its ``AutomationClient.test.ts`` has no ``download.*`` or
``network.summary`` scripting either), so this follows the same shape
every other test in this package uses instead: connect, script a
handler or push a broadcast, assert on what went out and what came
back.
"""

from __future__ import annotations

import asyncio

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client

GRANTED_WITH_DOWNLOAD = ["view", "control", "navigate", "evaluate", "upload", "devtools", "capture", "automation", "probe", "download"]

SUBSCRIBE_NETWORK_HANDLER = {
    "diagnostics.subscribe": lambda msg: {
        "t": "diagnostics.subscribed", "targetId": msg["targetId"], "console": False, "errors": False, "network": True,
    }
}


def _network_summary(target_id: str, *, in_flight) -> dict:
    envelope = {
        "t": "network.summary", "targetId": target_id, "windowMs": 5000, "requests": 1, "failed": 0,
        "bytesIn": 0, "bytesOut": 0, "slowest": [],
    }
    if in_flight is not None:
        envelope["inFlight"] = in_flight
    return envelope


# ----------------------------------------------------------------------
# wait_for_download
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wait_for_download_refuses_locally_without_download_capability():
    client, socket = await connect_client({})  # default granted set has no 'download'
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_download(timeout_ms=50)
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "download"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_download_resolves_a_relative_url_against_the_gateway_origin():
    client, socket = await connect_client({}, granted=GRANTED_WITH_DOWNLOAD)
    try:
        async def push_ready():
            await asyncio.sleep(0.01)
            await socket.push(
                {"t": "download.ready", "downloadId": "dl_2", "sizeBytes": 1, "sha256": "x", "url": "/browserglass/v1/downloads/tok", "expiresAt": 1}
            )

        task = asyncio.ensure_future(push_ready())
        result = await client.wait_for_download(timeout_ms=2000)
        await task
        # conftest dials wss://fake.example/socket, so the download is https on the same host.
        assert result.url == "https://fake.example/browserglass/v1/downloads/tok"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_download_resolves_on_download_ready():
    client, socket = await connect_client({}, granted=GRANTED_WITH_DOWNLOAD)
    try:
        async def push_ready():
            await asyncio.sleep(0.01)
            await socket.push(
                {"t": "download.ready", "downloadId": "dl_1", "sizeBytes": 1234, "sha256": "abc123", "url": "https://gw.example/d/dl_1", "expiresAt": 999999999999}
            )

        task = asyncio.ensure_future(push_ready())
        result = await client.wait_for_download(timeout_ms=2000)
        await task

        assert result.download_id == "dl_1"
        assert result.size_bytes == 1234
        assert result.sha256 == "abc123"
        assert result.url == "https://gw.example/d/dl_1"
        assert result.expires_at == 999999999999
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_download_raises_protocol_error_on_download_failed():
    client, socket = await connect_client({}, granted=GRANTED_WITH_DOWNLOAD)
    try:
        async def push_failed():
            await asyncio.sleep(0.01)
            await socket.push({"t": "download.failed", "downloadId": "dl_2", "reason": "network_error"})

        task = asyncio.ensure_future(push_failed())
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_download(timeout_ms=2000)
        await task

        assert excinfo.value.code == "PROTOCOL_ERROR"
        assert "network_error" in excinfo.value.message
        assert excinfo.value.details["downloadId"] == "dl_2"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_download_times_out_when_nothing_arrives():
    client, socket = await connect_client({}, granted=GRANTED_WITH_DOWNLOAD)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_download(timeout_ms=30)
        assert excinfo.value.code == "TIMEOUT"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_download_runs_trigger_after_subscribing_not_before():
    """The listener has to be live before `trigger` runs: a download that
    completes synchronously inside `trigger` must still be observed,
    which is only possible if the subscription was already in place."""
    client, socket = await connect_client({}, granted=GRANTED_WITH_DOWNLOAD)
    order = []
    try:
        async def trigger():
            order.append("trigger")
            # Completes the download from inside the trigger itself, the
            # tightest possible race: this only works if the listener was
            # already attached.
            await socket.push({"t": "download.ready", "downloadId": "dl_3", "sizeBytes": 1, "sha256": "x", "url": "https://gw.example/d/dl_3", "expiresAt": 1})

        result = await client.wait_for_download(timeout_ms=2000, trigger=trigger)
        assert order == ["trigger"]
        assert result.download_id == "dl_3"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_download_supports_a_sync_trigger():
    client, socket = await connect_client({}, granted=GRANTED_WITH_DOWNLOAD)
    calls = []
    try:
        def trigger():
            calls.append(1)

        async def push_ready():
            await asyncio.sleep(0.01)
            await socket.push({"t": "download.ready", "downloadId": "dl_4", "sizeBytes": 1, "sha256": "x", "url": "https://gw.example/d/dl_4", "expiresAt": 1})

        task = asyncio.ensure_future(push_ready())
        result = await client.wait_for_download(timeout_ms=2000, trigger=trigger)
        await task
        assert calls == [1]
        assert result.download_id == "dl_4"
    finally:
        await client.close()


# ----------------------------------------------------------------------
# wait_for_network_idle
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wait_for_network_idle_refuses_locally_without_devtools_capability():
    granted = ["view", "control", "navigate", "evaluate"]
    client, socket = await connect_client({}, granted=granted)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_network_idle(timeout_ms=50)
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "devtools"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_network_idle_refuses_without_an_active_subscription():
    client, socket = await connect_client({})  # devtools granted, but never subscribed
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_network_idle(timeout_ms=50)
        assert excinfo.value.code == "POLICY_DENIED"
        assert "diagnostics.subscribe" in excinfo.value.message
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_network_idle_resolves_once_in_flight_settles():
    client, socket = await connect_client(SUBSCRIBE_NETWORK_HANDLER)
    try:
        await client.diagnostics.subscribe(network=True)

        async def push_idle():
            await asyncio.sleep(0.01)
            await socket.push(_network_summary(client.target_id, in_flight=0))

        task = asyncio.ensure_future(push_idle())
        await client.wait_for_network_idle(idle_ms=20, timeout_ms=2000)
        await task
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_network_idle_ignores_summaries_for_other_targets():
    client, socket = await connect_client(SUBSCRIBE_NETWORK_HANDLER)
    try:
        await client.diagnostics.subscribe(network=True)

        async def push_both():
            await asyncio.sleep(0.01)
            await socket.push(_network_summary("some_other_target", in_flight=999))
            await socket.push(_network_summary(client.target_id, in_flight=0))

        task = asyncio.ensure_future(push_both())
        await client.wait_for_network_idle(idle_ms=20, timeout_ms=2000)
        await task
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_network_idle_disarms_when_activity_resumes():
    client, socket = await connect_client(SUBSCRIBE_NETWORK_HANDLER)
    try:
        await client.diagnostics.subscribe(network=True)

        async def push_busy_then_idle():
            await asyncio.sleep(0.01)
            await socket.push(_network_summary(client.target_id, in_flight=0))
            await asyncio.sleep(0.01)  # inside the idle window
            await socket.push(_network_summary(client.target_id, in_flight=3))  # disarms it
            await asyncio.sleep(0.01)
            await socket.push(_network_summary(client.target_id, in_flight=0))

        started = asyncio.get_event_loop().time()
        task = asyncio.ensure_future(push_busy_then_idle())
        await client.wait_for_network_idle(idle_ms=20, timeout_ms=2000)
        await task
        # Resolved off the SECOND idle reading, not the first: at least
        # ~30ms (two 0.01s sleeps plus the 20ms idle window) must have
        # elapsed.
        assert asyncio.get_event_loop().time() - started >= 0.03
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_network_idle_times_out_when_gateway_never_reports_inflight():
    """A `network.summary` with no `inFlight` field at all (an older
    gateway) must never be treated as idle: it should time out honestly
    rather than fabricate a reading."""
    client, socket = await connect_client(SUBSCRIBE_NETWORK_HANDLER)
    try:
        await client.diagnostics.subscribe(network=True)

        async def push_no_inflight_field():
            await asyncio.sleep(0.01)
            await socket.push(_network_summary(client.target_id, in_flight=None))

        task = asyncio.ensure_future(push_no_inflight_field())
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_network_idle(idle_ms=20, timeout_ms=60)
        await task
        assert excinfo.value.code == "TIMEOUT"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_diagnostics_unsubscribe_clears_the_network_feed_flag():
    client, socket = await connect_client(SUBSCRIBE_NETWORK_HANDLER)
    try:
        await client.diagnostics.subscribe(network=True)
        await client.diagnostics.unsubscribe()

        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_network_idle(timeout_ms=50)
        assert excinfo.value.code == "POLICY_DENIED"
        assert "diagnostics.subscribe" in excinfo.value.message
    finally:
        await client.close()
