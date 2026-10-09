"""The client-side half of selector handling: the same split and the same
prefix rules the page-side resolver applies (``script.py``), duplicated
here so a selector that is wrong on its face fails locally, before a step
is spent and before a round trip. Mirrors
``packages/automation/src/locator/selector.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

from ..errors import AutomationError
from .types import LocatorMatch, ResolveResult

# How many milliseconds a measured rect is trusted for before an acting
# verb re-resolves it.
STALE_RESOLVE_WINDOW_MS = 250

_ENGINE_PREFIX = re.compile(r"^(css|text|xpath|label|ref|visible|role)=([\s\S]*)$")


@dataclass(frozen=True)
class SelectorSegment:
    engine: str
    value: str
    source: str


def split_segments(selector: str) -> List[str]:
    """Splits on the ``>>`` chain combinator, ignoring one inside a quoted
    string or inside brackets."""
    out: List[str] = []
    buf = ""
    quote: Optional[str] = None
    depth = 0
    i = 0
    n = len(selector)
    while i < n:
        c = selector[i]
        if quote is not None:
            buf += c
            if c == quote and (i == 0 or selector[i - 1] != "\\"):
                quote = None
            i += 1
            continue
        if c in ('"', "'"):
            quote = c
            buf += c
            i += 1
            continue
        if c in ("[", "("):
            depth += 1
        if c in ("]", ")"):
            depth -= 1
        if depth <= 0 and c == ">" and i + 1 < n and selector[i + 1] == ">":
            out.append(buf)
            buf = ""
            i += 2
            continue
        buf += c
        i += 1
    out.append(buf)
    return [s.strip() for s in out if s.strip()]


def _parse_one(source: str) -> SelectorSegment:
    m = _ENGINE_PREFIX.match(source)
    if m:
        return SelectorSegment(engine=m.group(1), value=m.group(2) or "", source=source)
    c0 = source[0] if source else ""
    if c0 in ("/", "("):
        return SelectorSegment(engine="xpath", value=source, source=source)
    return SelectorSegment(engine="css", value=source, source=source)


def parse_selector(selector: str) -> List[SelectorSegment]:
    """Parses and validates a selector, raising ``INVALID_ARGUMENT`` on the
    two shapes that are wrong rather than merely unmatched."""
    if not isinstance(selector, str) or selector.strip() == "":
        raise AutomationError("INVALID_ARGUMENT", "a locator selector must be a non-empty string")
    segments = [_parse_one(s) for s in split_segments(selector)]
    if not segments:
        raise AutomationError("INVALID_ARGUMENT", f"selector '{selector}' has no segments")

    first = segments[0]
    if first.engine == "xpath":
        raise AutomationError(
            "INVALID_ARGUMENT",
            f"selector '{selector}' starts with XPath. XPath is supported only as a chained segment, evaluated "
            "against an element another engine already found: write 'input#name >> xpath=ancestor::label[1]'. "
            "An absolute XPath as the primary selector is refused because it is the selector form that breaks "
            "first when markup shifts, and it reads as noise in a failure log.",
            {"selector": selector, "engine": "xpath", "position": "first"},
        )
    if first.engine == "visible":
        raise AutomationError(
            "INVALID_ARGUMENT",
            f"selector '{selector}' starts with 'visible='. It is a filter, not a matcher: chain it after "
            "something that selects, as 'button >> visible=true'.",
            {"selector": selector, "engine": "visible", "position": "first"},
        )

    # Every `role=` segment's value is validated here, eagerly, for the same
    # reason the xpath/visible checks above run before any round trip: a
    # malformed filter is wrong on its face and the caller should not pay a
    # CDP round trip (the client's own `query_and_stamp_by_role`, layered
    # underneath `resolve()`) to be told so. Every occurrence is checked,
    # not just the first, because a later segment in a chain is validated no
    # less than the first one is anywhere else in this function.
    for seg in segments:
        if seg.engine == "role":
            parse_role_value(seg.value, selector)

    return segments


@dataclass(frozen=True)
class RoleFilter:
    """One ``role=`` segment's filter: an exact role, and an optional exact
    accessible name."""

    role: str
    name: Optional[str]


_ROLE_VALUE = re.compile(r'^([^[\s]+)(?:\[name="([\s\S]*)"\])?$')


def parse_role_value(value: str, selector: str) -> RoleFilter:
    """``role=<role>`` or ``role=<role>[name="<exact name>"]``, mirroring
    the string shape Playwright's own ``role=`` selector engine uses,
    chosen deliberately: a caller already fluent in Playwright's own role
    syntax reads this one for free rather than learning a third spelling
    for the same idea ``get_by_role(role, name=...)`` already gave them.

    The quoted name is taken literally between the first and last ``"``,
    with no escape processing, one quoting rule for an exact match value
    used everywhere this engine has one.

    Both ``role`` and ``name``, when matched, are handed to
    ``Accessibility.queryAXTree`` unchanged: this function does not
    validate ``role`` against a table of known ARIA roles, on purpose.
    Chrome's own answer, not a copy of the spec this codebase would have
    to keep in sync by hand, is the only thing that ever decides whether a
    role string is valid. A misspelled role matches nothing and is
    reported exactly like any other selector that matches nothing:
    ``total: 0``, no throw.
    """
    m = _ROLE_VALUE.match(value.strip())
    role = m.group(1) if m else None
    if not m or not role:
        raise AutomationError(
            "INVALID_ARGUMENT",
            f"selector '{selector}': 'role={value}' is not a role filter. Write 'role=button' or "
            "'role=button[name=\"Submit\"]'.",
            {"selector": selector, "engine": "role", "value": value},
        )
    return RoleFilter(role=role, name=m.group(2) if m.group(2) is not None else None)


def terminal_engine(segments: List[SelectorSegment]) -> str:
    """The engine of the last segment, which is the one that produced the
    matches."""
    return segments[-1].engine if segments else "css"


def ref_selector(ref: str) -> str:
    """The ``ref=`` spelling for a stamp, for threading one match into the
    next call."""
    return f"ref={ref}"


def actionability_error(
    verb: str,
    selector: str,
    result: ResolveResult,
    chosen: Optional[LocatorMatch],
    elapsed_ms: float,
) -> AutomationError:
    """The one place a locator failure becomes an error, so every verb
    fails the same way and says the same amount: name the check that
    failed, name what the element looked like when it failed, and when
    the failure is occlusion, name what took the click."""
    base = {
        "verb": verb,
        "selector": selector,
        "engine": result.engine,
        "matchCount": result.total,
        "elapsedMs": elapsed_ms,
        "url": result.url,
    }

    if result.scope_missing:
        return AutomationError(
            "DETACHED",
            f"{verb}('{selector}'): the 'within' element is gone from the page. A ref is valid until its "
            "subtree re-renders and no longer; re-resolve the container and try again.",
            {**base, "stale": True},
        )

    if chosen is None:
        return AutomationError(
            "NOT_FOUND",
            f"{verb}('{selector}'): nothing matched after {elapsed_ms}ms. The page is at {result.url}.",
            base,
        )

    state = {
        "index": chosen.index,
        "ref": chosen.ref,
        "describe": chosen.describe,
        "rect": chosen.rect,
        "attached": chosen.attached,
        "visible": chosen.visible,
        "enabled": chosen.enabled,
        "disabledReason": chosen.disabled_reason,
        "editable": chosen.editable,
        "stable": chosen.stable,
        "hitTestOk": chosen.hit_test_ok,
        "occludedBy": chosen.occluded_by,
        "inViewport": chosen.in_viewport,
        "opacity": chosen.opacity,
        "pointerEvents": chosen.pointer_events,
    }
    plural = "" if result.total == 1 else "s"
    where = f"matched {result.total} element{plural}; acted on index {chosen.index} ({chosen.describe or chosen.tag_name})"

    if not chosen.attached:
        return AutomationError(
            "DETACHED",
            f"{verb}('{selector}'): the element left the document before it could be acted on. {where}.",
            {**base, "check": "attached", "state": state, "stale": True},
        )
    if not chosen.visible:
        why = f"its rect is {chosen.rect.w}x{chosen.rect.h}" if chosen.rect.w <= 0 or chosen.rect.h <= 0 else "computed visibility hides it"
        return AutomationError(
            "NOT_VISIBLE",
            f"{verb}('{selector}'): the element is not visible after {elapsed_ms}ms ({why}). {where}.",
            {**base, "check": "visible", "state": state},
        )
    if not chosen.enabled:
        return AutomationError(
            "DISABLED",
            f"{verb}('{selector}'): the element is disabled ({chosen.disabled_reason or 'reason unknown'}) after {elapsed_ms}ms. {where}.",
            {**base, "check": "enabled", "state": state},
        )
    if chosen.hit_test_ok is False:
        by = chosen.occluded_by or chosen.hit_reason or "something"
        return AutomationError(
            "OCCLUDED",
            f"{verb}('{selector}'): a click at ({round(chosen.center['x'])}, {round(chosen.center['y'])}) would land on {by}, not on the element. {where}.",
            {**base, "check": "receivesEvents", "state": state, "occludedBy": chosen.occluded_by},
        )
    if chosen.stable is False:
        return AutomationError(
            "NOT_STABLE",
            f"{verb}('{selector}'): the element was still moving after {elapsed_ms}ms (its rect changed between two animation frames). {where}.",
            {**base, "check": "stable", "state": state},
        )

    return AutomationError(
        "TIMEOUT",
        f"{verb}('{selector}'): gave up after {elapsed_ms}ms. Every actionability check passed, so the failure "
        f"is elsewhere in the verb; the element's state is in details.state. {where}.",
        {**base, "check": None, "state": state},
    )
