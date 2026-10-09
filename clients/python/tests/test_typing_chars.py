"""Every printable character has to reach the page.

A live run lost ``#`` from every field and ``!`` from a password field,
so a login with "SuperSecretPassword!" failed with no exception. The
client half is tested here: each ASCII printable character goes out as
its own key event carrying the character as ``key`` and ``text``, and a
character with no key definition goes out as ``input.text``. The gateway
half (the virtual key code Chrome receives) is tested in
``packages/core/test/input/key-events.test.ts``.
"""

from __future__ import annotations

import pytest

from browserglass.errors import AutomationError
from browserglass.keys import printable_key_code
from browserglass.locator.engine import LocatorEngine

from conftest import connect_client, control_granted_handler
from test_locator_engine import FakeRuntime, make_match, wait_success

ASCII = "".join(chr(c) for c in range(32, 127))
NON_ASCII = "\u00e9\u00fc\u00f1\u65e5\U0001F600"


def test_every_ascii_printable_character_has_a_key_definition():
    for ch in ASCII:
        kc = printable_key_code(ch)
        assert kc is not None, repr(ch)
        assert kc.key == ch
        assert kc.code
    for ch in NON_ASCII:
        assert printable_key_code(ch) is None



@pytest.mark.asyncio
async def test_typing_sends_one_key_pair_per_ascii_character_and_input_text_for_the_rest():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        client._core.remember_gen("t1", 1)
        await client.acquire_control()
        text = ASCII + NON_ASCII
        await client._type_chars_with_preemption("fill", "t1", text, 0)
        sent = [m for m in socket.sent_json_messages() if m["t"] in ("input.key", "input.text")]
        typed = ""
        for m in sent:
            if m["t"] == "input.text":
                typed += m["text"]
            elif m["kind"] == "down":
                assert m["key"] == m["text"]
                assert m["modifiers"] == 0
                typed += m["text"]
        assert typed == text
        downs = [m for m in sent if m["t"] == "input.key" and m["kind"] == "down"]
        ups = [m for m in sent if m["t"] == "input.key" and m["kind"] == "up"]
        assert len(downs) == len(ASCII)
        assert len(ups) == len(ASCII)
        assert [m["text"] for m in sent if m["t"] == "input.text"] == list(NON_ASCII)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_fill_strict_raises_on_a_value_that_did_not_stick_without_echoing_it():
    rt = FakeRuntime()
    rt.wait_replies.append(wait_success([make_match(value="")]))
    for _ in range(7):
        rt.read_replies.append({"found": True, "value": "SuperSecretPassword"})
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.fill("t1", "#password", "SuperSecretPassword!", {"strict": True})
    err = excinfo.value
    assert err.code == "TIMEOUT"
    assert err.details["expectedLength"] == 20
    assert err.details["actualLength"] == 19
    assert err.details["firstMismatchAt"] == 19
    assert "SuperSecret" not in err.message
