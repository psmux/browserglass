"""``AutomationClient.a11y()`` and the ``role=`` locator selector's CDP
half (``query_and_stamp_by_role``), driven end to end against
:class:`fake_gateway.FakeGatewaySocket`. Mirrors the shape of
``test_navigate_evaluate.py``: script the one wire message each call
makes and assert on the client-side result and the outbound frame.
"""

from __future__ import annotations

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client


def a11y_got_handler(nodes, *, total=None, truncated=False, marker=None):
    def handler(msg):
        return {
            "t": "page.a11y.got",
            "targetId": msg["targetId"],
            "nodes": nodes,
            "total": total if total is not None else len(nodes),
            "truncated": truncated,
            "marker": marker,
        }

    return handler


def make_node(**overrides):
    base = {
        "role": "button",
        "name": "Save changes",
        "backendNodeId": 7,
        "ignored": False,
        "focusable": True,
        "disabled": False,
        "hidden": False,
        "expanded": None,
        "checked": None,
        "pressed": None,
        "selected": None,
        "required": None,
        "readonly": None,
        "invalid": None,
        "level": None,
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_a11y_needs_devtools_capability():
    granted = ["view", "control", "navigate", "evaluate", "upload", "capture", "automation", "probe"]
    client, socket = await connect_client(granted=granted)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.a11y()
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "devtools"
        # Refused locally: no page.a11y.get frame should have been sent.
        assert [m for m in socket.sent_json_messages() if m["t"] == "page.a11y.get"] == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a11y_returns_typed_nodes_from_the_wire():
    node = make_node()
    client, socket = await connect_client({"page.a11y.get": a11y_got_handler([node])})
    try:
        result = await client.a11y()
        assert result.total == 1
        assert result.truncated is False
        assert len(result.nodes) == 1
        assert result.nodes[0].role == "button"
        assert result.nodes[0].name == "Save changes"
        assert result.nodes[0].backend_node_id == 7
        assert result.nodes[0].focusable is True
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a11y_reports_truncation_honestly():
    client, socket = await connect_client({"page.a11y.get": a11y_got_handler([make_node()], total=500, truncated=True)})
    try:
        result = await client.a11y()
        assert result.total == 500
        assert result.truncated is True
        assert len(result.nodes) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a11y_no_match_is_an_ordinary_empty_answer():
    client, socket = await connect_client({"page.a11y.get": a11y_got_handler([])})
    try:
        result = await client.a11y(role="button", name="nope")
        assert result.total == 0
        assert result.nodes == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a11y_sends_role_name_and_max_nodes_never_stamp():
    client, socket = await connect_client({"page.a11y.get": a11y_got_handler([])})
    try:
        await client.a11y(role="button", name="Save changes", max_nodes=10)
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.a11y.get"][0]
        assert sent["role"] == "button"
        assert sent["name"] == "Save changes"
        assert sent["maxNodes"] == 10
        assert "stamp" not in sent
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_role_selector_needs_devtools_in_addition_to_evaluate():
    granted = ["view", "control", "navigate", "evaluate", "upload", "capture", "automation", "probe"]
    client, socket = await connect_client(granted=granted)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.resolve("role=button")
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "devtools"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_role_selector_stamps_through_page_a11y_get_then_resolves():
    calls = []

    def a11y_handler(msg):
        calls.append(dict(msg))
        return {
            "t": "page.a11y.got",
            "targetId": msg["targetId"],
            "nodes": [],
            "total": 0,
            "truncated": False,
            "marker": "data-bg-role-42",
        }

    def resolve_handler(msg):
        assert msg["args"][0]["selector"] == "css=[data-bg-role-42]"
        return {
            "t": "page.evaluated",
            "targetId": msg["targetId"],
            "ok": True,
            "resultType": "value",
            "sizeBytes": 0,
            "value": {
                "matches": [],
                "total": 0,
                "truncated": False,
                "engine": "css",
                "segments": 1,
                "scopeMissing": False,
                "selectorError": None,
                "url": "https://example.com",
                "title": "Example",
                "viewport": {"w": 1280, "h": 800, "scrollX": 0, "scrollY": 0},
            },
        }

    client, socket = await connect_client({"page.a11y.get": a11y_handler, "page.evaluate": resolve_handler})
    try:
        result = await client.resolve('role=button[name="Save changes"]')
        assert result.total == 0
        assert len(calls) == 1
        assert calls[0]["role"] == "button"
        assert calls[0]["name"] == "Save changes"
        assert calls[0]["stamp"] is True
    finally:
        await client.close()
