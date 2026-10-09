"""Which JavaScript world each evaluate actually ran in, asserted three
ways: at the runtime protocol, at the socket, and at the signature.

This is the Python counterpart of ``packages/automation/test/client/
locator.test.ts``'s ``describe('the world the locator engine evaluates
in')``. It has to exist separately, and that is the point of the whole
change it covers: the TypeScript side made ``world`` a required parameter
so the compiler asks at every call site, and none of that reached this
client, so every one of the locator engine's six fixed scripts went out
with no ``world`` field and ran in the page's own world. A page could
watch every ``resolve``, ``fill``, ``click`` and ``select``.

The assertions here are deliberately written as "nothing was anything
else" rather than "these six were isolated". A seventh fixed script added
later is then covered on the day it is written, instead of on the day
somebody notices.
"""

from __future__ import annotations

import inspect

import pytest

from browserglass.client import AutomationClient, _ClientLocatorRuntime
from browserglass.errors import AutomationError
from browserglass.locator.engine import ENGINE_WORLD, LocatorEngine

from conftest import connect_client, control_granted_handler
from test_locator_engine import FakeRuntime, make_match, make_wire_resolve, wait_success


# ----------------------------------------------------------------------
# The engine's own scripts
# ----------------------------------------------------------------------


def test_engine_world_is_isolated():
    assert ENGINE_WORLD == "isolated"


@pytest.mark.asyncio
async def test_every_fixed_script_the_engine_sends_names_the_isolated_world():
    """Drives one of each of the six scripts through the engine and reads
    back the world every one of them asked for."""
    rt = FakeRuntime()
    engine = LocatorEngine(rt)

    # resolve
    rt.resolve_replies.append(make_wire_resolve([make_match()]))
    await engine.resolve("t1", "#email")

    # wait
    rt.wait_replies.append(wait_success([make_match()]))
    await engine.wait_for("t1", "#email", {"state": "visible"})

    # dispatchClick
    rt.wait_replies.append(wait_success([make_match()]))
    rt.dispatch_click_replies.append({"found": True, "clicked": True})
    await engine.click("t1", "#email", {"via": "dispatch"})

    # clear + read (fill)
    rt.wait_replies.append(wait_success([make_match(value="old")]))
    rt.clear_replies.append({"found": True})
    rt.read_replies.append({"found": True, "value": "Ada"})
    await engine.fill("t1", "#email", "Ada")

    # select
    rt.wait_replies.append(wait_success([make_match(tagName="select", value="us")]))
    rt.select_replies.append({"found": True, "values": ["us"], "labels": ["United States"]})
    await engine.select("t1", "#country", "us")

    ran = {e["script"] for e in rt.evaluations}
    assert ran == {"resolve", "wait", "dispatchClick", "clear", "read", "select"}, ran
    # The assertion that matters, phrased so a seventh script is covered
    # the day it is added rather than the day it is noticed.
    assert [e for e in rt.evaluations if e["world"] != "isolated"] == []


@pytest.mark.asyncio
async def test_the_verify_predicate_defaults_to_the_isolated_world():
    rt = FakeRuntime()
    engine = LocatorEngine(rt)
    rt.wait_replies.append(wait_success([make_match()]))
    rt.expression_replies.append(True)
    await engine.click("t1", "#email", {"verify": "document.querySelector('#done') !== null"})

    verify = [e for e in rt.evaluations if e["kind"] == "expression"]
    assert len(verify) == 1
    assert verify[0]["world"] == "isolated"


@pytest.mark.asyncio
async def test_verify_world_main_is_honoured_and_scoped_to_the_predicate():
    """The escape hatch moves the PREDICATE and nothing else. If it moved
    the engine's own scripts too, a caller reaching for one page global
    would silently expose every locator script in the same call."""
    rt = FakeRuntime()
    engine = LocatorEngine(rt)
    rt.wait_replies.append(wait_success([make_match()]))
    rt.expression_replies.append(True)
    await engine.click("t1", "#email", {"verify": "window.__pageSaidDone === true", "verify_world": "main"})

    verify = [e for e in rt.evaluations if e["kind"] == "expression"]
    assert [e["world"] for e in verify] == ["main"]
    engine_scripts = [e for e in rt.evaluations if e["kind"] == "function"]
    assert engine_scripts, "the click still ran the engine's own scripts"
    assert [e for e in engine_scripts if e["world"] != "isolated"] == []


@pytest.mark.asyncio
async def test_a_misspelled_verify_world_is_refused_rather_than_sent():
    rt = FakeRuntime()
    engine = LocatorEngine(rt)
    rt.wait_replies.append(wait_success([make_match()]))
    with pytest.raises(AutomationError) as excinfo:
        await engine.click("t1", "#email", {"verify": "true", "verify_world": "utility"})
    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert "isolated" in excinfo.value.message
    # Nothing reached the wire for the predicate.
    assert [e for e in rt.evaluations if e["kind"] == "expression"] == []


# ----------------------------------------------------------------------
# `world` is REQUIRED on the runtime, and that is the whole guarantee
# ----------------------------------------------------------------------


def test_world_is_required_and_keyword_only_on_the_locator_runtime():
    """The parameter has no default and cannot be passed by position.

    No default, so a call site that forgets it raises ``TypeError`` on its
    first execution instead of running in the page's world for ever.
    Keyword only, so it can never be swapped with ``timeout_ms`` and a
    reader of any call site can see which world was chosen without
    counting arguments. Asserted with :mod:`inspect` on the concrete
    adapter rather than only on the ``Protocol``, because the ``Protocol``
    is not what runs.
    """
    for name in ("evaluate_function", "evaluate_expression"):
        sig = inspect.signature(getattr(_ClientLocatorRuntime, name))
        world = sig.parameters["world"]
        assert world.kind is inspect.Parameter.KEYWORD_ONLY, name
        assert world.default is inspect.Parameter.empty, name


@pytest.mark.asyncio
async def test_a_runtime_that_forgets_world_fails_loudly_on_the_first_call():
    """The negative control for the paragraph above. A fake runtime whose
    ``evaluate_function`` predates this change does not quietly run in the
    main world; it cannot run at all."""

    class OldRuntime(FakeRuntime):
        async def evaluate_function(self, target_id, source, args, timeout_ms):  # noqa: D102
            return make_wire_resolve([make_match()])

    engine = LocatorEngine(OldRuntime())
    with pytest.raises(TypeError) as excinfo:
        await engine.resolve("t1", "#email")
    assert "world" in str(excinfo.value)


# ----------------------------------------------------------------------
# The caller facing evaluate(): still main, and the options bag cannot be
# passed by position
# ----------------------------------------------------------------------


def evaluate_ok_handler(value):
    def handler(msg):
        return {"t": "page.evaluated", "targetId": msg["targetId"], "ok": True, "resultType": "value", "value": value, "sizeBytes": 0}

    return handler


@pytest.mark.asyncio
async def test_a_plain_evaluate_still_sends_no_world_field_at_all():
    """The caller facing default is unchanged and must stay unchanged. A
    caller who asked for nothing keeps getting what they always got, and
    absent-means-main is the wire's own rule, so the field is not sent
    rather than sent as ``'main'``."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("Example")})
    try:
        await client.evaluate("document.title")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert "world" not in sent
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_evaluate_world_isolated_reaches_the_wire():
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("Example")})
    try:
        await client.evaluate("document.title", world="isolated")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert sent["world"] == "isolated"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_the_locator_surface_puts_world_isolated_on_the_message_that_goes_out():
    """End to end over the socket, not against a fake runtime: the
    ``page.evaluate`` the client actually emits for a ``resolve()`` names
    the isolated world."""
    resolved = {
        "matches": [make_match()],
        "total": 1,
        "truncated": False,
        "engine": "css",
        "segments": 1,
        "scopeMissing": False,
        "selectorError": None,
        "url": "https://example.com",
        "title": "Example",
        "viewport": {"w": 1280, "h": 800, "scrollX": 0, "scrollY": 0},
    }
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler(resolved)})
    try:
        await client.resolve("#email")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"]
        assert sent, "a page.evaluate went out"
        assert [m for m in sent if m.get("world") != "isolated"] == []
    finally:
        await client.close()


def test_evaluate_takes_exactly_one_positional_parameter():
    """The structural half of the fix for the variadic trap.

    The TypeScript ``evaluate(source, ...args)`` is variadic, so
    ``evaluate('expr', {world: 'isolated'})`` hands the options bag to the
    PAGE and runs in the default world, silently. Here that line is a
    ``TypeError`` before anything is sent, because ``expression`` is the
    only positional parameter. This test exists so an edit that widens the
    signature back out fails here rather than in production.
    """
    sig = inspect.signature(AutomationClient.evaluate)
    positional = [
        p
        for name, p in sig.parameters.items()
        if name != "self" and p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    assert [p.name for p in positional] == ["expression"]
    assert not any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in sig.parameters.values())
    for opt in ("world", "timeout_ms", "await_promise", "user_gesture"):
        assert sig.parameters[opt].kind is inspect.Parameter.KEYWORD_ONLY, opt


def test_wait_for_function_options_are_keyword_only_too():
    sig = inspect.signature(AutomationClient.wait_for_function)
    for opt in ("world", "polling_ms", "poll_timeout_ms"):
        assert sig.parameters[opt].kind is inspect.Parameter.KEYWORD_ONLY, opt


@pytest.mark.asyncio
async def test_evaluate_refuses_an_options_bag_passed_as_a_page_argument():
    """``evaluate_function`` IS variadic, because its job is passing
    arguments to the page, so no signature can close this one. The guard
    reads the CONTENT: a mapping whose every key is an option name is an
    options bag somebody meant to pass by keyword."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler(None)})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.evaluate_function("() => 1", {"world": "isolated"})
        assert excinfo.value.code == "INVALID_ARGUMENT"
        assert "world=..." in excinfo.value.message
        # And it was refused BEFORE anything went out.
        assert [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"] == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_the_guard_is_narrow_enough_to_let_real_data_through():
    """A page argument that merely happens to carry a key called ``world``
    is data, not an options bag, and must go through. The guard fires only
    when EVERY key is an option name."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("ok")})
    try:
        result = await client.evaluate_function("(o) => o.world", {"world": "middle earth", "ref": "ap-1"})
        assert result == "ok"
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert sent["args"] == [{"world": "middle earth", "ref": "ap-1"}]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a_world_that_is_not_a_world_is_refused_at_the_call_site():
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler(None)})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.evaluate("1+1", world="utility")
        assert excinfo.value.code == "INVALID_ARGUMENT"
        # patchright's own spelling is named, because it is the typo
        # anybody porting from patchright will make.
        assert "patchright" in excinfo.value.message
        assert [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"] == []
    finally:
        await client.close()


# ----------------------------------------------------------------------
# The three SDK-authored scripts that were still reaching the main world
# ----------------------------------------------------------------------
#
# These were missed when the six fixed locator scripts were threaded, and
# they were missed for the same reason in both clients: they are built on
# the CALLER-FACING evaluate/wait_for_function, whose main-world default is
# correct for a caller and wrong for a script the SDK wrote itself. Each was
# measured leaking against real Chrome before the fix. See the module doc of
# `examples/isolated_world_probe.py`.


@pytest.mark.asyncio
async def test_text_reads_the_page_from_the_isolated_world():
    """Measured before the fix: one `text()` moved the page's own
    `innerText` getter counter from 0 to 1. A page that defines that getter
    both sees the read and chooses what it returns."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("hello")})
    try:
        await client.text()
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert sent["world"] == "isolated"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_html_reads_the_page_from_the_isolated_world():
    """Measured before the fix: one `html()` moved the page's own
    `outerHTML` getter counter from 0 to 1."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("<html></html>")})
    try:
        await client.html()
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert sent["world"] == "isolated"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_text_polls_in_the_isolated_world():
    """The sharpest of the three, because it repeats. The predicate calls
    `document.querySelectorAll` once per POLL, so before the fix a wait that
    took four seconds at the default 100ms interval handed the page forty
    observations of the automation looking for its text."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler("some text")})
    try:
        await client.wait_for_text("#h", "some text")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"]
        assert sent, "a page.evaluate went out"
        assert [m for m in sent if m.get("world") != "isolated"] == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_function_itself_still_defaults_to_main():
    """The counterweight to the three above. `wait_for_function` takes a
    predicate the CALLER wrote, so it keeps the caller-facing default and
    sends no `world` field. Only the SDK's own predicates were moved."""
    client, socket = await connect_client({"page.evaluate": evaluate_ok_handler(True)})
    try:
        await client.wait_for_function("window.__ready === true")
        sent = [m for m in socket.sent_json_messages() if m["t"] == "page.evaluate"][0]
        assert "world" not in sent
    finally:
        await client.close()
