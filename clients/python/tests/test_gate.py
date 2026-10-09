"""``client.gate``: the outbound request gate, against the scripted fake
gateway.

There is no gate test in the TypeScript SDK's own suite yet (the fake
gateway there has no ``request.gate.*`` handling either), so this suite
has no sibling to mirror line for line; it follows the same shape every
other test in this package uses instead: connect, script a handler,
assert on what went out and what came back.
"""

from __future__ import annotations

import asyncio

import pytest

from browserglass.errors import AutomationError
from browserglass.types import GateRule

from conftest import connect_client

GRANTED_WITH_INTERCEPT = ["view", "control", "navigate", "evaluate", "upload", "devtools", "capture", "automation", "probe", "intercept"]


@pytest.mark.asyncio
async def test_gate_enable_refuses_locally_without_intercept_capability():
    client, socket = await connect_client({})  # default granted set has no 'intercept'
    try:
        before = len(socket.sent_json_messages())
        with pytest.raises(AutomationError) as excinfo:
            await client.gate.enable([GateRule(url_pattern="*", verdict="deny")])
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "intercept"
        assert len(socket.sent_json_messages()) == before
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_enable_with_include_request_body_needs_evaluate_too():
    granted = [c for c in GRANTED_WITH_INTERCEPT if c != "evaluate"]
    client, socket = await connect_client({}, granted=granted)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.gate.enable([GateRule(url_pattern="*", verdict="ask", include_request_body=True)])
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["required"] == "evaluate"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_enable_sends_rules_and_resolves_rule_count():
    def handler(msg):
        return {"t": "request.gate.enabled", "targetId": msg["targetId"], "ruleCount": len(msg["rules"])}

    client, socket = await connect_client({"request.gate.enable": handler}, granted=GRANTED_WITH_INTERCEPT)
    try:
        result = await client.gate.enable(
            [
                GateRule(url_pattern="*", verdict="ask", methods=["POST"], resource_types=["XHR", "Fetch"], hold_ms=2000, on_timeout="deny"),
                GateRule(url_pattern="https://cdn.example/*", verdict="allow"),
            ]
        )
        sent = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.enable"][-1]
        assert sent["targetId"] == client.target_id
        assert sent["rules"][0] == {"urlPattern": "*", "verdict": "ask", "methods": ["POST"], "resourceTypes": ["XHR", "Fetch"], "holdMs": 2000, "onTimeout": "deny"}
        assert sent["rules"][1] == {"urlPattern": "https://cdn.example/*", "verdict": "allow"}
        assert result.target_id == client.target_id
        assert result.rule_count == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_disable_sends_request_gate_disable():
    client, socket = await connect_client({"request.gate.disable": lambda msg: {"t": "request.gate.disabled", "targetId": msg["targetId"]}}, granted=GRANTED_WITH_INTERCEPT)
    try:
        await client.gate.disable()
        sent = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.disable"]
        assert sent[-1]["targetId"] == client.target_id
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_resolve_sends_verdict_fire_and_forget():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        await client.gate.resolve("gate_1", "allow")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"]
        assert sent[-1]["targetId"] == client.target_id
        assert sent[-1]["gateId"] == "gate_1"
        assert sent[-1]["verdict"] == "allow"
    finally:
        await client.close()


async def _push_paused(socket, target_id: str, *, gate_id: str = "gate_1", post_data=None):
    envelope = {
        "t": "request.gate.paused", "targetId": target_id, "gateId": gate_id, "url": "https://shop.example.com/checkout",
        "method": "POST", "resourceType": "fetch", "headers": {"content-type": "application/json"}, "deadlineAt": 9999999999999,
    }
    if post_data is not None:
        envelope["postData"] = post_data
    await socket.push(envelope)


@pytest.mark.asyncio
async def test_gate_on_paused_answers_allow_from_the_handler():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        seen = []

        def handler(ev):
            seen.append(ev)
            return "allow"

        unsubscribe = client.gate.on_paused(handler)
        await _push_paused(socket, client.target_id)
        await asyncio.sleep(0.05)

        assert len(seen) == 1
        assert seen[0].url == "https://shop.example.com/checkout"
        assert seen[0].gate_id == "gate_1"
        assert seen[0].post_data is None
        resolves = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"]
        assert resolves[-1]["verdict"] == "allow"
        assert resolves[-1]["gateId"] == "gate_1"
        unsubscribe()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_on_paused_supports_an_async_handler():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        async def handler(ev):
            await asyncio.sleep(0)
            return "deny"

        client.gate.on_paused(handler)
        await _push_paused(socket, client.target_id)
        await asyncio.sleep(0.05)

        resolves = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"]
        assert resolves[-1]["verdict"] == "deny"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_on_paused_answers_deny_when_handler_raises():
    """A handler nobody wrote defensively must not leave a paused request
    holding a real Chrome network slot forever: a raising handler still
    gets answered, and fails closed."""
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        def handler(ev):
            raise RuntimeError("boom")

        client.gate.on_paused(handler)
        await _push_paused(socket, client.target_id)
        await asyncio.sleep(0.05)

        resolves = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"]
        assert resolves[-1]["verdict"] == "deny"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_on_paused_answers_deny_when_async_handler_raises():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        async def handler(ev):
            await asyncio.sleep(0)
            raise RuntimeError("boom")

        client.gate.on_paused(handler)
        await _push_paused(socket, client.target_id)
        await asyncio.sleep(0.05)

        resolves = [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"]
        assert resolves[-1]["verdict"] == "deny"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_on_paused_ignores_pauses_for_other_targets():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        seen = []
        client.gate.on_paused(lambda ev: seen.append(ev) or "allow")
        await _push_paused(socket, "some_other_target")
        await asyncio.sleep(0.05)

        assert seen == []
        assert [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"] == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_on_paused_unsubscribe_stops_answering_but_does_not_disable_the_gate():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        seen = []
        unsubscribe = client.gate.on_paused(lambda ev: seen.append(ev) or "allow")
        unsubscribe()

        await _push_paused(socket, client.target_id)
        await asyncio.sleep(0.05)

        assert seen == []
        assert [m for m in socket.sent_json_messages() if m["t"] == "request.gate.resolve"] == []
        assert [m for m in socket.sent_json_messages() if m["t"] == "request.gate.disable"] == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_gate_on_paused_includes_post_data_when_the_rule_asked_for_it():
    client, socket = await connect_client({}, granted=GRANTED_WITH_INTERCEPT)
    try:
        seen = []
        client.gate.on_paused(lambda ev: seen.append(ev) or "deny")
        await _push_paused(socket, client.target_id, post_data='{"email":"ada@example.com"}')
        await asyncio.sleep(0.05)

        assert seen[0].post_data == '{"email":"ada@example.com"}'
    finally:
        await client.close()
