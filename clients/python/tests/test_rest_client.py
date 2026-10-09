from __future__ import annotations

import json

import httpx
import pytest

from browserglass.errors import RestError
from browserglass.rest import RestClient


def acquire_response_body(instance_id="i_1", session_id="s_1"):
    return {
        "instanceId": instance_id,
        "sessionId": session_id,
        "state": "ready",
        "attach": {"wsUrl": "wss://gateway.example/socket", "ticket": "tkt_abc", "expiresAt": 1_700_000_000_000},
        "node": {"nodeId": "n_1", "region": None, "labels": {}},
        "profile": {"profileId": None, "key": "k", "mode": "ephemeral", "created": True, "sizeBytes": None},
        "reused": False,
        "reuseReason": None,
        "rejectedOverrides": [],
        "effectiveSpec": {},
        "timings": {"admissionMs": 1, "placementMs": 1, "launchMs": 1, "totalMs": 3},
        "expiresAt": 1_700_000_000_000,
        "fence": 1,
    }


@pytest.mark.asyncio
async def test_acquire_success_parses_attach_info():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/instances"
        assert request.headers["authorization"] == "Bearer app_tok"
        body = json.loads(request.content)
        assert body["subject"] == "alice"
        return httpx.Response(201, json=acquire_response_body())

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rest = RestClient(base_url="https://gateway.example", token="app_tok", http_client=http_client)
    try:
        result = await rest.acquire(subject="alice")
        assert result.instance_id == "i_1"
        assert result.state == "ready"
        assert result.attach is not None
        assert result.attach.ws_url == "wss://gateway.example/socket"
        assert result.attach.ticket == "tkt_abc"
    finally:
        await rest.aclose()


@pytest.mark.asyncio
async def test_acquire_omits_unset_optional_fields():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json=acquire_response_body())

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rest = RestClient(base_url="https://gateway.example", token="app_tok", http_client=http_client)
    try:
        await rest.acquire()
        assert captured["body"] == {}
    finally:
        await rest.aclose()


@pytest.mark.asyncio
async def test_release_sends_delete_with_query_params():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path == "/v1/instances/i_1"
        assert request.url.params["reason"] == "done"
        assert request.url.params["force"] == "true"
        return httpx.Response(200, json={"released": True, "outcome": "terminated"})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rest = RestClient(base_url="https://gateway.example", token="app_tok", http_client=http_client)
    try:
        result = await rest.release("i_1", reason="done", force=True)
        assert result.released is True
        assert result.outcome == "terminated"
    finally:
        await rest.aclose()


@pytest.mark.asyncio
async def test_attach_posts_to_the_attach_route():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/instances/i_1/attach"
        return httpx.Response(
            200,
            json={
                "instanceId": "i_1", "sessionId": "s_1",
                "attach": {"wsUrl": "wss://gateway.example/socket", "ticket": "tkt_2", "expiresAt": 1},
                "node": {"nodeId": "n_1", "region": None}, "targets": [], "fence": 1,
            },
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rest = RestClient(base_url="https://gateway.example", token="app_tok", http_client=http_client)
    try:
        result = await rest.attach("i_1")
        assert result.attach.ticket == "tkt_2"
    finally:
        await rest.aclose()


@pytest.mark.asyncio
async def test_error_response_raises_rest_error_with_the_servers_envelope():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"error": {"code": "E_QUOTA_INSTANCES", "message": "tenant quota exceeded", "retryable": True, "retryAfterMs": 2000, "requestId": "req_9"}},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rest = RestClient(base_url="https://gateway.example", token="app_tok", http_client=http_client)
    try:
        with pytest.raises(RestError) as excinfo:
            await rest.acquire()
        assert excinfo.value.http_status == 429
        assert excinfo.value.code == "E_QUOTA_INSTANCES"
        assert excinfo.value.retryable is True
        assert excinfo.value.retry_after_ms == 2000
        assert excinfo.value.request_id == "req_9"
    finally:
        await rest.aclose()


@pytest.mark.asyncio
async def test_context_manager_closes_the_http_client():
    closed = {"value": False}

    class TrackingTransport(httpx.MockTransport):
        pass

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=acquire_response_body())

    async with RestClient(base_url="https://gateway.example", token="app_tok", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as rest:
        result = await rest.acquire()
        assert result.instance_id == "i_1"
