from __future__ import annotations

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client, control_granted_handler


def probe_handler(msg):
    return {"t": "target.probed", "targetId": msg["targetId"], "detail": "hover", "gen": 1, "hit": True, "rect": {"x": 0, "y": 0, "w": 10, "h": 10}}


def mouse(socket):
    return [m for m in socket.sent_json_messages() if m["t"] == "input.mouse"]


def match(center):
    return {
        "index": 0, "ref": None, "tagName": "div", "type": None, "id": None, "name": None, "role": None,
        "rect": {"x": center["x"] - 5, "y": center["y"] - 5, "w": 10, "h": 10}, "center": center,
        "attached": True, "visible": True, "enabled": True, "disabledReason": None, "editable": False,
        "stable": None, "hitTestOk": None, "occludedBy": None, "hitReason": None, "inViewport": True,
        "opacity": 1, "pointerEvents": "auto", "text": None, "value": None, "checked": None,
        "readValue": None, "describe": "div",
    }


def resolve_handler(msg):
    import json

    center = {"x": 400, "y": 50} if "#drop" in json.dumps(msg) else {"x": 20, "y": 50}
    value = {
        "matches": [match(center)], "total": 1, "truncated": False, "engine": "css", "segments": 1,
        "scopeMissing": False, "selectorError": None, "url": "https://example.test/", "title": "t",
        "viewport": {"w": 1280, "h": 800, "scrollX": 0, "scrollY": 0},
    }
    return {"t": "page.evaluated", "targetId": msg["targetId"], "ok": True, "resultType": "value", "value": value, "sizeBytes": 0}


@pytest.mark.asyncio
async def test_mouse_down_move_up_need_a_lease_and_send_nothing_without_one():
    client, socket = await connect_client({"target.probe": probe_handler})
    try:
        for call in (client.mouse_down(1, 1), client.mouse_up(1, 1), client.move_to(1, 1, buttons=1), client.drag({"x": 0, "y": 0}, {"x": 5, "y": 5})):
            with pytest.raises(AutomationError) as excinfo:
                await call
            assert excinfo.value.code == "LEASE_NOT_HELD"
        assert mouse(socket) == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_mouse_down_move_up_carry_the_held_button():
    client, socket = await connect_client({"control.request": control_granted_handler(), "target.probe": probe_handler})
    try:
        await client.acquire_control()
        await client.mouse_down(10, 20)
        await client.move_to(30, 40, buttons=1)
        await client.mouse_up(30, 40)
        sent = mouse(socket)
        assert [m["kind"] for m in sent] == ["down", "move", "up"]
        assert sent[0]["buttons"] == 1 and sent[0]["button"] == "left" and sent[0]["clickCount"] == 1
        assert sent[1]["buttons"] == 1
        assert sent[2]["buttons"] == 0 and "clickCount" not in sent[2]
        assert all(m["leaseId"] == "lease_1" for m in sent)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_drag_interpolates_moves_with_the_button_held():
    client, socket = await connect_client({"control.request": control_granted_handler(), "target.probe": probe_handler})
    try:
        await client.acquire_control()
        result = await client.drag({"x": 100, "y": 100}, {"x": 200, "y": 300}, steps=4, delay_ms=0)
        assert result == {"from": {"x": 100.0, "y": 100.0}, "to": {"x": 200.0, "y": 300.0}, "steps": 4}
        sent = mouse(socket)
        assert [m["kind"] for m in sent] == ["move", "down", "move", "move", "move", "move", "up"]
        assert [(m["x"], m["y"], m["buttons"]) for m in sent[2:6]] == [(125, 150, 1), (150, 200, 1), (175, 250, 1), (200, 300, 1)]
        assert sent[6]["x"] == 200 and sent[6]["y"] == 300 and sent[6]["buttons"] == 0
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_drag_resolves_selector_ends_to_match_centres():
    client, socket = await connect_client(
        {"control.request": control_granted_handler(), "target.probe": probe_handler, "page.evaluate": resolve_handler}
    )
    try:
        await client.acquire_control()
        result = await client.drag("#card", "#drop", steps=2, delay_ms=0)
        assert result["from"] == {"x": 20.0, "y": 50.0}
        assert result["to"] == {"x": 400.0, "y": 50.0}
        sent = mouse(socket)
        assert sent[1]["kind"] == "down" and sent[1]["x"] == 20
        assert sent[-1]["kind"] == "up" and sent[-1]["x"] == 400
    finally:
        await client.close()
