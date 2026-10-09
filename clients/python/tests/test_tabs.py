"""``client.tabs``: list/open/close/activate/active, against the scripted
fake gateway.

Mirrors the shape of ``AutomationClient.tabs`` in the TypeScript SDK
(``packages/automation/src/client/AutomationClient.ts``); there is no
sibling test file there either (its own fake gateway has no
``target.list``/``target.new`` scripting), so this follows the same
connect/script/assert shape every other test in this package uses.
"""

from __future__ import annotations

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client

GRANTED_WITH_TABS = ["view", "control", "navigate", "evaluate", "upload", "devtools", "capture", "automation", "probe", "tabs.manage"]

TARGET_1 = {
    "targetId": "t1", "kind": "page", "title": "One", "url": "https://example.test/one", "faviconUrl": None,
    "index": 0, "windowId": 1, "active": True, "audible": False, "muted": False, "loading": False,
    "canGoBack": False, "canGoForward": False, "openerTargetId": None, "viewers": 0, "createdAt": 0,
}
TARGET_2 = {
    "targetId": "t2", "kind": "page", "title": "Two", "url": "https://example.test/two", "faviconUrl": None,
    "index": 1, "windowId": 1, "active": False, "audible": False, "muted": False, "loading": False,
    "canGoBack": False, "canGoForward": False, "openerTargetId": None, "viewers": 0, "createdAt": 0,
}


@pytest.mark.asyncio
async def test_tabs_list_refuses_locally_without_tabs_manage_capability():
    client, socket = await connect_client({})  # default granted set has no 'tabs.manage'
    try:
        before = len(socket.sent_json_messages())
        with pytest.raises(AutomationError) as excinfo:
            await client.tabs.list()
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "tabs.manage"
        assert len(socket.sent_json_messages()) == before
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_tabs_list_sends_target_list_and_returns_targets():
    def handler(msg):
        return {"t": "target.listed", "targets": [TARGET_1, TARGET_2]}

    client, socket = await connect_client({"target.list": handler}, granted=GRANTED_WITH_TABS)
    try:
        tabs = await client.tabs.list()
        sent = [m for m in socket.sent_json_messages() if m["t"] == "target.list"]
        assert len(sent) == 1
        assert [t["targetId"] for t in tabs] == ["t1", "t2"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_tabs_open_sends_target_new_with_url_and_background():
    def handler(msg):
        assert msg["url"] == "https://example.test/new"
        assert msg["background"] is True
        return {"t": "target.created", "target": TARGET_2}

    client, socket = await connect_client({"target.new": handler}, granted=GRANTED_WITH_TABS)
    try:
        tab = await client.tabs.open(url="https://example.test/new", background=True)
        assert tab["targetId"] == "t2"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_tabs_open_with_no_options_sends_an_empty_payload():
    def handler(msg):
        assert "url" not in msg and "background" not in msg
        return {"t": "target.created", "target": TARGET_1}

    client, socket = await connect_client({"target.new": handler}, granted=GRANTED_WITH_TABS)
    try:
        await client.tabs.open()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_tabs_close_sends_target_close_with_the_given_target_id():
    def handler(msg):
        return {"t": "target.closed_ack", "targetId": msg["targetId"]}

    client, socket = await connect_client({"target.close": handler}, granted=GRANTED_WITH_TABS)
    try:
        await client.tabs.close("t2")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "target.close"]
        assert sent[-1]["targetId"] == "t2"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_tabs_activate_sends_target_activate_with_the_given_target_id():
    def handler(msg):
        return {"t": "target.activated", "targetId": msg["targetId"]}

    client, socket = await connect_client({"target.activate": handler}, granted=GRANTED_WITH_TABS)
    try:
        await client.tabs.activate("t2")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "target.activate"]
        assert sent[-1]["targetId"] == "t2"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_tabs_active_reads_the_cached_target_list_with_no_round_trip():
    client, socket = await connect_client({}, granted=GRANTED_WITH_TABS)
    try:
        before = len(socket.sent_json_messages())
        active = await client.tabs.active()
        assert active is not None
        assert active["targetId"] == client.target_id
        # No wire message needed: this reads the welcome-supplied target
        # list straight out of AutomationCore.
        assert len(socket.sent_json_messages()) == before
    finally:
        await client.close()
