"""Exercises `LocatorEngine` (the port of `locator/engine.ts`) directly
against a scripted `LocatorRuntime`, standing in for the page-side
JavaScript resolver (`locator/script.py`, verified byte-identical to the
TypeScript source separately; see the executor's own report). This is a
unit test of the ORCHESTRATION: retries, staleness re-resolves, the
error taxonomy, not of real DOM matching (which needs a real browser and
is out of this build's scope; see the README).
"""

from __future__ import annotations

import pytest

from browserglass.errors import AutomationError
from browserglass.locator.engine import LocatorEngine
from browserglass.locator.selector import parse_role_value, parse_selector, split_segments


def make_match(**overrides):
    base = {
        "index": 0, "ref": "bgabc123_0", "tagName": "input", "type": "text", "id": None, "name": "email",
        "role": None, "rect": {"x": 10, "y": 10, "w": 100, "h": 20}, "center": {"x": 60, "y": 20},
        "attached": True, "visible": True, "enabled": True, "disabledReason": None, "editable": True,
        "stable": True, "hitTestOk": True, "occludedBy": None, "hitReason": None, "inViewport": True,
        "opacity": 1, "pointerEvents": "auto", "text": None, "value": "", "checked": None, "readValue": None,
        "describe": "input#email",
    }
    base.update(overrides)
    return base


def make_wire_resolve(matches, *, total=None, engine="css", segments=1, selector_error=None, scope_missing=False):
    return {
        "matches": matches, "total": total if total is not None else len(matches), "truncated": False,
        "engine": engine, "segments": segments, "scopeMissing": scope_missing, "selectorError": selector_error,
        "url": "https://example.com", "title": "Example",
        "viewport": {"w": 1280, "h": 800, "scrollX": 0, "scrollY": 0},
    }


class FakeRuntime:
    """A scripted `LocatorRuntime`. `evaluate_function` replies are
    queued per script source (`resolve_replies`, `wait_replies`,
    `read_replies`, `select_replies`); `click_point`/`type_chars`/
    `insert_text`/`prepare_dispatch` just record calls.

    Both evaluate methods take `world` as a REQUIRED keyword argument,
    exactly as the `LocatorRuntime` protocol declares it, and every call
    is appended to `evaluations` with the world it named. That list is
    what `describe('the world the locator engine evaluates in')` reads
    back. Keeping the parameter required here is not incidental: a fake
    that accepted `world=None` would go on passing every existing test on
    the day somebody dropped the argument from a real call site, which is
    the silent failure this whole change exists to stop."""

    def __init__(self):
        self.default_timeout_ms = 8000
        self.resolve_replies = []
        self.wait_replies = []
        self.read_replies = []
        self.select_replies = []
        self.dispatch_click_replies = []
        self.clear_replies = []
        self.clicks = []
        self.typed = []
        self.inserted = []
        self.sleeps = []
        self.expression_replies = []
        self.role_replies = []
        self.role_calls = []
        self.resolve_calls = []
        self.wait_calls = []
        self.evaluations = []

    async def evaluate_function(self, target_id, source, args, timeout_ms, *, world):
        from browserglass.locator.script import CLEAR_SCRIPT, DISPATCH_CLICK_SCRIPT, READ_SCRIPT, RESOLVE_SCRIPT, SELECT_SCRIPT, WAIT_SCRIPT

        names = {
            RESOLVE_SCRIPT: "resolve",
            WAIT_SCRIPT: "wait",
            READ_SCRIPT: "read",
            SELECT_SCRIPT: "select",
            DISPATCH_CLICK_SCRIPT: "dispatchClick",
            CLEAR_SCRIPT: "clear",
        }
        self.evaluations.append({"kind": "function", "script": names.get(source, "unknown"), "world": world})
        if source == RESOLVE_SCRIPT:
            self.resolve_calls.append(args[0])
            return self.resolve_replies.pop(0)
        if source == WAIT_SCRIPT:
            self.wait_calls.append(args[0])
            return self.wait_replies.pop(0)
        if source == READ_SCRIPT:
            return self.read_replies.pop(0)
        if source == SELECT_SCRIPT:
            return self.select_replies.pop(0)
        if source == DISPATCH_CLICK_SCRIPT:
            return self.dispatch_click_replies.pop(0)
        if source == CLEAR_SCRIPT:
            return self.clear_replies.pop(0)
        raise AssertionError("unexpected evaluate_function source")

    async def evaluate_expression(self, target_id, expression, timeout_ms, *, world):
        self.evaluations.append({"kind": "expression", "script": "verify", "world": world})
        return self.expression_replies.pop(0)

    async def prepare_dispatch(self, target_id):
        return None

    async def click_point(self, target_id, x, y, opts):
        self.clicks.append((target_id, x, y, dict(opts)))

    async def type_chars(self, target_id, text, delay_ms):
        self.typed.append((target_id, text, delay_ms))

    async def insert_text(self, target_id, text):
        self.inserted.append((target_id, text))

    async def sleep(self, ms):
        self.sleeps.append(ms)

    async def query_and_stamp_by_role(self, target_id, role, name, timeout_ms):
        self.role_calls.append((target_id, role, name, timeout_ms))
        return self.role_replies.pop(0)


def wait_success(match_list, **kw):
    return {"timedOut": False, "result": make_wire_resolve(match_list, **kw), "waitedMs": 5, "checks": 1, "wakes": 0}


# ----------------------------------------------------------------------
# resolve
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_returns_matches_and_totals():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([make_match(), make_match(index=1, ref="bgabc123_1")]))
    engine = LocatorEngine(rt)
    result = await engine.resolve("t1", "#email")
    assert result.total == 2
    assert len(result.matches) == 2
    assert result.matches[0].tag_name == "input"
    assert result.selector == "#email"


@pytest.mark.asyncio
async def test_resolve_nothing_matched_is_not_an_error():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([]))
    engine = LocatorEngine(rt)
    result = await engine.resolve("t1", "#nope")
    assert result.total == 0
    assert result.matches == []


@pytest.mark.asyncio
async def test_resolve_selector_error_raises_invalid_argument():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([], selector_error="SyntaxError: bad selector"))
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.resolve("t1", "[[[")
    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert "bad selector" in excinfo.value.message


# ----------------------------------------------------------------------
# role= selector
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_rewrites_role_segment_to_a_css_marker():
    rt = FakeRuntime()
    rt.role_replies.append({"attr": "data-bg-role-abc123"})
    rt.resolve_replies.append(make_wire_resolve([make_match(tagName="button")]))
    engine = LocatorEngine(rt)

    result = await engine.resolve("t1", 'role=button[name="Save changes"]')

    assert rt.role_calls == [("t1", "button", "Save changes", rt.default_timeout_ms)]
    assert rt.resolve_calls[0]["selector"] == "css=[data-bg-role-abc123]"
    assert result.total == 1
    # The reported selector is the caller's original text, not the rewrite.
    assert result.selector == 'role=button[name="Save changes"]'


@pytest.mark.asyncio
async def test_resolve_role_matching_nothing_short_circuits_without_a_round_trip():
    rt = FakeRuntime()
    rt.role_replies.append({"attr": None})
    engine = LocatorEngine(rt)

    result = await engine.resolve("t1", "role=button")

    assert result.total == 0
    assert result.matches == []
    # RESOLVE_SCRIPT was never called: popping an empty list would raise.
    assert rt.resolve_calls == []


@pytest.mark.asyncio
async def test_resolve_role_chained_after_css_rewrites_only_the_role_segment():
    rt = FakeRuntime()
    rt.role_replies.append({"attr": "data-bg-role-xyz"})
    rt.resolve_replies.append(make_wire_resolve([make_match(tagName="button")]))
    engine = LocatorEngine(rt)

    await engine.resolve("t1", "div.form >> role=button")

    assert rt.resolve_calls[0]["selector"] == "div.form >> css=[data-bg-role-xyz]"


@pytest.mark.asyncio
async def test_wait_for_rewrites_role_segment_too():
    rt = FakeRuntime()
    rt.role_replies.append({"attr": "data-bg-role-def"})
    rt.wait_replies.append(wait_success([make_match(tagName="button")]))
    engine = LocatorEngine(rt)

    await engine.wait_for("t1", "role=button", {"state": "visible"})

    assert rt.wait_calls[0]["check"]["selector"] == "css=[data-bg-role-def]"


@pytest.mark.asyncio
async def test_wait_for_role_matching_nothing_and_state_detached_succeeds_immediately():
    rt = FakeRuntime()
    rt.role_replies.append({"attr": None})
    engine = LocatorEngine(rt)

    result = await engine.wait_for("t1", "role=button", {"state": "detached"})

    assert result.total == 0
    assert rt.wait_calls == []


@pytest.mark.asyncio
async def test_wait_for_role_matching_nothing_and_state_visible_times_out_immediately():
    rt = FakeRuntime()
    rt.role_replies.append({"attr": None})
    engine = LocatorEngine(rt)

    with pytest.raises(AutomationError) as excinfo:
        await engine.wait_for("t1", "role=button", {"state": "visible"})
    assert excinfo.value.code == "NOT_FOUND"
    assert rt.wait_calls == []


def test_parse_role_value_accepts_bare_role():
    filt = parse_role_value("button", "role=button")
    assert filt.role == "button"
    assert filt.name is None


def test_parse_role_value_accepts_role_with_exact_name():
    filt = parse_role_value('button[name="Save changes"]', 'role=button[name="Save changes"]')
    assert filt.role == "button"
    assert filt.name == "Save changes"


def test_parse_role_value_rejects_malformed_filter():
    with pytest.raises(AutomationError) as excinfo:
        parse_role_value("", "role=")
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_parse_selector_validates_role_segments_eagerly():
    with pytest.raises(AutomationError) as excinfo:
        parse_selector("role=")
    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert excinfo.value.details["engine"] == "role"


def test_parse_selector_accepts_role_segment():
    segments = parse_selector('role=button[name="Submit"]')
    assert segments[0].engine == "role"
    assert segments[0].value == 'button[name="Submit"]'


# ----------------------------------------------------------------------
# click
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_click_dispatches_at_the_actionable_matchs_centre():
    rt = FakeRuntime()
    rt.wait_replies.append(wait_success([make_match()]))
    engine = LocatorEngine(rt)
    result = await engine.click("t1", "#submit")
    assert result.ok is True
    assert result.via == "coordinates"
    assert result.point == {"x": 60, "y": 20}
    assert rt.clicks == [("t1", 60, 20, {})]


@pytest.mark.asyncio
async def test_click_with_verify_retries_then_succeeds():
    rt = FakeRuntime()
    rt.wait_replies.append(wait_success([make_match()]))
    rt.wait_replies.append(wait_success([make_match()]))
    rt.expression_replies.append(False)
    rt.expression_replies.append(True)
    engine = LocatorEngine(rt)
    result = await engine.click("t1", "#submit", {"verify": "document.title === 'ok'", "verify_delay_ms": 0})
    assert result.verified is True
    assert result.attempts == 2
    assert len(rt.clicks) == 2


@pytest.mark.asyncio
async def test_click_unverified_and_occluded_raises_occluded_with_blocker_named():
    rt = FakeRuntime()
    occluded = make_match(occludedBy='div[data-testid="overlay"]')
    rt.wait_replies.append(wait_success([occluded]))
    rt.expression_replies.append(False)
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.click("t1", "#submit", {"verify": "false", "verify_delay_ms": 0, "retries": 0})
    assert excinfo.value.code == "OCCLUDED"
    assert 'div[data-testid="overlay"]' in excinfo.value.message


@pytest.mark.asyncio
async def test_click_nothing_matched_raises_not_found():
    rt = FakeRuntime()
    rt.wait_replies.append({"timedOut": True, "result": make_wire_resolve([]), "waitedMs": 8000, "checks": 3, "wakes": 0})
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.click("t1", "#does-not-exist")
    assert excinfo.value.code == "NOT_FOUND"


@pytest.mark.asyncio
async def test_click_disabled_element_raises_disabled():
    rt = FakeRuntime()
    disabled = make_match(enabled=False, disabledReason="element.disabled")
    rt.wait_replies.append({"timedOut": True, "result": make_wire_resolve([disabled]), "waitedMs": 8000, "checks": 1, "wakes": 0})
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.click("t1", "#submit")
    assert excinfo.value.code == "DISABLED"


# ----------------------------------------------------------------------
# fill
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fill_clicks_clears_types_and_verifies():
    rt = FakeRuntime()
    field = make_match(value="old")
    rt.wait_replies.append(wait_success([field]))
    rt.clear_replies.append({"found": True, "cleared": True})
    rt.read_replies.append({"found": True, "value": "ada@example.com"})
    engine = LocatorEngine(rt)
    result = await engine.fill("t1", "#email", "ada@example.com")
    assert result.ok is True
    assert result.verified is True
    assert result.actual == "ada@example.com"
    assert rt.typed == [("t1", "ada@example.com", 0)]
    assert len(rt.clicks) == 1


@pytest.mark.asyncio
async def test_fill_not_editable_raises_invalid_argument():
    rt = FakeRuntime()
    div = make_match(tagName="div", editable=False)
    rt.wait_replies.append(wait_success([div]))
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.fill("t1", "#not-a-field", "x")
    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert "not editable" in excinfo.value.message


@pytest.mark.asyncio
async def test_fill_mismatched_verify_retries_reads_then_reports_unverified_without_raising():
    """A masked/reformatting input (a phone field) is a legitimate
    outcome, not an error: `verified: False` is returned, never raised."""
    rt = FakeRuntime()
    field = make_match(value="")
    rt.wait_replies.append(wait_success([field]))
    rt.clear_replies.append({"found": False})  # value was already '', so clear() is skipped; not consulted
    rt.read_replies.append({"found": True, "value": "55"})  # sampled mid-type
    for _ in range(6):
        rt.read_replies.append({"found": True, "value": "(555) 010-9999"})  # settles into a masked format that never equals the raw input
    engine = LocatorEngine(rt)
    result = await engine.fill("t1", "#phone", "5550109999")
    assert result.ok is True
    assert result.verified is False
    assert result.actual == "(555) 010-9999"


# ----------------------------------------------------------------------
# select
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_select_by_bare_string_shorthand_for_value():
    rt = FakeRuntime()
    sel = make_match(tagName="select")
    rt.wait_replies.append(wait_success([sel]))
    rt.select_replies.append({"found": True, "values": ["US"], "labels": ["United States"]})
    engine = LocatorEngine(rt)
    result = await engine.select("t1", "#country", "US")
    assert result.values == ["US"]
    assert result.labels == ["United States"]


@pytest.mark.asyncio
async def test_select_missing_option_names_available_options():
    rt = FakeRuntime()
    sel = make_match(tagName="select")
    rt.wait_replies.append(wait_success([sel]))
    rt.select_replies.append(
        {"found": True, "missing": [{"value": "ZZ"}], "available": [{"value": "US", "label": "United States", "index": 0}, {"value": "CA", "label": "Canada", "index": 1}]}
    )
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.select("t1", "#country", "ZZ")
    assert excinfo.value.code == "NOT_FOUND"
    assert "'US'" in excinfo.value.message
    assert "'CA'" in excinfo.value.message


@pytest.mark.asyncio
async def test_select_on_non_select_element_raises_invalid_argument():
    rt = FakeRuntime()
    div = make_match(tagName="div")
    rt.wait_replies.append(wait_success([div]))
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.select("t1", "#not-a-select", "US")
    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert "is not a <select>" in excinfo.value.message


# ----------------------------------------------------------------------
# read verbs
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inner_text_reads_from_the_resolver_in_one_round_trip():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([make_match(readValue="Hello world")]))
    engine = LocatorEngine(rt)
    text = await engine.inner_text("t1", "#banner")
    assert text == "Hello world"


@pytest.mark.asyncio
async def test_get_attribute_returns_none_for_absent_attribute():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([make_match(readValue=None)]))
    engine = LocatorEngine(rt)
    value = await engine.get_attribute("t1", "#thing", "data-missing")
    assert value is None


@pytest.mark.asyncio
async def test_get_attribute_not_found_when_selector_matches_nothing():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([]))
    engine = LocatorEngine(rt)
    with pytest.raises(AutomationError) as excinfo:
        await engine.get_attribute("t1", "#nope", "href")
    assert excinfo.value.code == "NOT_FOUND"


@pytest.mark.asyncio
async def test_is_checked():
    rt = FakeRuntime()
    rt.resolve_replies.append(make_wire_resolve([make_match(readValue=True)]))
    engine = LocatorEngine(rt)
    assert await engine.is_checked("t1", "#agree") is True


# ----------------------------------------------------------------------
# selector parsing (the client-side half; script.py applies the same
# rules in the page)
# ----------------------------------------------------------------------


def test_split_segments_respects_quotes_and_brackets():
    assert split_segments('input#first >> xpath=ancestor::label[1]') == ["input#first", "xpath=ancestor::label[1]"]
    assert split_segments('[value=">>"]') == ['[value=">>"]']


def test_parse_selector_rejects_leading_xpath():
    with pytest.raises(AutomationError) as excinfo:
        parse_selector("//div")
    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert "XPath" in excinfo.value.message


def test_parse_selector_rejects_leading_visible_filter():
    with pytest.raises(AutomationError) as excinfo:
        parse_selector("visible=true")
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_parse_selector_rejects_empty_string():
    with pytest.raises(AutomationError):
        parse_selector("   ")


def test_parse_selector_accepts_chained_xpath():
    segments = parse_selector("input#first >> xpath=ancestor::label[1]")
    assert segments[0].engine == "css"
    assert segments[1].engine == "xpath"
