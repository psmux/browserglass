"""The REST half of ``AutomationClient.launch()`` against an
``httpx.MockTransport``. No socket is opened: ``launch_instance()`` stops
at the attach ticket, and the connect step is the same
``AutomationClient.connect()`` the rest of this suite covers."""

from __future__ import annotations

import json

import httpx
import pytest

import browserglass.launch as launch_mod
from browserglass import AutomationClient, AutomationError, BrowserSwarm, DEFAULT_LAUNCH_CAPS, launch_instance

GW = "http://gw.test/browserglass"
TOKEN = "secret-admin-token-value"


class FakeGateway:
    """Launches ``inst_1``, answers ``launching`` ``pending_polls`` times, then ``ready``."""

    def __init__(self, pending_polls=0, override=None):
        self.pending_polls = pending_polls
        self.override = override
        self.calls = []
        self.polls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        call = {"method": request.method, "url": str(request.url), "body": body, "auth": request.headers.get("authorization")}
        self.calls.append(call)
        if self.override is not None:
            r = self.override(call)
            if r is not None:
                return r
        path = request.url.path
        if request.method == "POST" and path == "/browserglass/v1/instances":
            return httpx.Response(201, json={"instanceId": "inst_1", "state": "launching"})
        if request.method == "GET" and path == "/browserglass/v1/instances/inst_1":
            self.polls += 1
            state = "ready" if self.polls > self.pending_polls else "launching"
            return httpx.Response(200, json={"instance": {"state": state}})
        if request.method == "POST" and path == "/browserglass/v1/instances/inst_1/attach":
            return httpx.Response(200, json={"attach": {"wsUrl": "ws://gw.test/browserglass/socket", "ticket": "tkt"}})
        if request.method == "DELETE":
            return httpx.Response(200, json={"released": True})
        return httpx.Response(404, json={"error": {"code": "E_NOT_FOUND", "message": "no route"}})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


@pytest.fixture(autouse=True)
def fast_release_retry(monkeypatch):
    monkeypatch.setattr(launch_mod, "RELEASE_RETRY_S", 0.001)


async def test_launch_polls_until_ready_and_narrows_caps():
    gw = FakeGateway(pending_polls=2)
    async with gw.client() as http:
        a = await launch_instance(
            gateway=GW + "/",
            admin_token=TOKEN,
            viewport={"width": 1280, "height": 800},
            profile_key="acct",
            poll_interval_s=0.001,
            http_client=http,
        )
        assert (a.instance_id, a.ws_url, a.ticket) == ("inst_1", "ws://gw.test/browserglass/socket", "tkt")

        acquire = gw.calls[0]
        assert acquire["auth"] == f"Bearer {TOKEN}"
        assert acquire["body"]["browser"] == {"headless": "new", "viewport": {"width": 1280, "height": 800, "deviceScaleFactor": 1}}
        assert acquire["body"]["profile"] == {"mode": "persistent", "key": "acct"}
        assert len([c for c in gw.calls if c["method"] == "GET"]) == 3
        attach = next(c for c in gw.calls if c["url"].endswith("/attach"))
        assert attach["body"]["capabilities"] == list(DEFAULT_LAUNCH_CAPS)
        for cap in ("evaluate", "capture", "devtools", "intercept", "download"):
            assert cap in DEFAULT_LAUNCH_CAPS
        assert "admin" not in DEFAULT_LAUNCH_CAPS

        await launch_instance(gateway=GW, admin_token=TOKEN, http_client=http)
        ids = [c["body"]["requestId"] for c in gw.calls if c["method"] == "POST" and c["url"] == f"{GW}/v1/instances"]
        assert len(ids) == 2 and ids[0] != ids[1]


@pytest.mark.parametrize("share_by", [{"profile_key": "acct"}, {"subject": "user:42"}])
async def test_shareable_launch_releases_without_force(share_by):
    # A second launch of the same profile key or subject gets the same
    # running browser. Forcing the release would end it under the others.
    gw = FakeGateway()
    async with gw.client() as http:
        a = await launch_instance(gateway=GW, admin_token=TOKEN, http_client=http, **share_by)
        await a.release()
    assert gw.calls[-1]["method"] == "DELETE"
    assert gw.calls[-1]["url"] == f"{GW}/v1/instances/inst_1"


async def test_headless_false_and_custom_caps():
    gw = FakeGateway()
    async with gw.client() as http:
        await launch_instance(gateway=GW, admin_token=TOKEN, headless=False, caps=["view", "control"], http_client=http)
    assert gw.calls[0]["body"]["browser"]["headless"] == "off"
    assert next(c for c in gw.calls if c["url"].endswith("/attach"))["body"]["capabilities"] == ["view", "control"]


async def test_ready_timeout_ends_the_browser():
    gw = FakeGateway(pending_polls=10**9)
    async with gw.client() as http:
        with pytest.raises(AutomationError) as ei:
            await launch_instance(gateway=GW, admin_token=TOKEN, ready_timeout_s=0.03, poll_interval_s=0.005, http_client=http)
    assert ei.value.code == "TIMEOUT"
    assert gw.calls[-1]["method"] == "DELETE"
    assert gw.calls[-1]["url"] == f"{GW}/v1/instances/inst_1?force=true"


async def test_missing_token_explains_how_to_get_one(monkeypatch):
    monkeypatch.delenv("BGLS_ADMIN_TOKEN", raising=False)
    gw = FakeGateway()
    async with gw.client() as http:
        with pytest.raises(AutomationError) as ei:
            await launch_instance(gateway=GW, http_client=http)
    assert ei.value.code == "UNAUTHENTICATED"
    assert "pnpm bgls token" in ei.value.message
    assert gw.calls == []


async def test_env_supplies_gateway_and_token(monkeypatch):
    monkeypatch.setenv("BGLS_URL", GW)
    monkeypatch.setenv("BGLS_ADMIN_TOKEN", TOKEN)
    gw = FakeGateway()
    async with gw.client() as http:
        await launch_instance(http_client=http)
    assert gw.calls[0]["url"] == f"{GW}/v1/instances"
    assert gw.calls[0]["auth"] == f"Bearer {TOKEN}"


async def test_expired_token_is_explained_and_never_echoed():
    gw = FakeGateway(override=lambda c: httpx.Response(401, json={"error": {"code": "E_TOKEN_EXPIRED", "message": "token expired"}}))
    async with gw.client() as http:
        with pytest.raises(AutomationError) as ei:
            await launch_instance(gateway=GW, admin_token=TOKEN, http_client=http)
    assert ei.value.code == "UNAUTHENTICATED"
    assert "expired" in ei.value.message
    assert "pnpm bgls token" in ei.value.message
    assert TOKEN not in ei.value.message
    assert TOKEN not in json.dumps(dict(ei.value.details))


async def test_release_retries_terminate_failed():
    deletes = {"n": 0}

    def override(c):
        if c["method"] != "DELETE":
            return None
        deletes["n"] += 1
        if deletes["n"] < 3:
            return httpx.Response(502, json={"error": {"code": "E_TERMINATE_FAILED", "message": "nope"}})
        return httpx.Response(200, json={"released": True})

    gw = FakeGateway(override=override)
    async with gw.client() as http:
        a = await launch_instance(gateway=GW, admin_token=TOKEN, http_client=http)
        await a.release()
    assert deletes["n"] == 3
    assert all(c["url"] == f"{GW}/v1/instances/inst_1?force=true" for c in gw.calls if c["method"] == "DELETE")


async def test_release_gives_up_after_three_attempts():
    gw = FakeGateway(
        override=lambda c: httpx.Response(502, json={"error": {"code": "E_TERMINATE_FAILED", "message": "nope"}})
        if c["method"] == "DELETE"
        else None
    )
    async with gw.client() as http:
        a = await launch_instance(gateway=GW, admin_token=TOKEN, http_client=http)
        with pytest.raises(AutomationError) as ei:
            await a.release()
    assert ei.value.details["gateway_code"] == "E_TERMINATE_FAILED"
    assert len([c for c in gw.calls if c["method"] == "DELETE"]) == 3


async def test_release_treats_404_as_done():
    gw = FakeGateway(
        override=lambda c: httpx.Response(404, json={"error": {"code": "E_INSTANCE_NOT_FOUND", "message": "gone"}})
        if c["method"] == "DELETE"
        else None
    )
    async with gw.client() as http:
        a = await launch_instance(gateway=GW, admin_token=TOKEN, http_client=http)
        await a.release()


async def test_client_launch_ends_browser_when_connect_fails():
    gw = FakeGateway()

    async def refusing_socket(url, subprotocols=None, **kwargs):
        raise OSError("connect refused")

    async with gw.client() as http:
        with pytest.raises(Exception):
            await AutomationClient.launch(gateway=GW, admin_token=TOKEN, http_client=http, socket_factory=refusing_socket)
    assert gw.calls[-1]["method"] == "DELETE"
    assert gw.calls[-1]["url"] == f"{GW}/v1/instances/inst_1?force=true"


async def test_swarm_needs_exactly_one_of_acquire_or_launch():
    with pytest.raises(AutomationError) as ei:
        await BrowserSwarm.open(size=1)
    assert ei.value.code == "INVALID_ARGUMENT"

    async def acquire(index, ctx):  # pragma: no cover - never called
        raise AssertionError

    with pytest.raises(AutomationError):
        await BrowserSwarm.open(size=1, acquire=acquire, launch={})
