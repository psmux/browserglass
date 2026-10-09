"""The locator surface's public types. Mirrors
``packages/automation/src/locator/types.ts``.

Nothing here is a handle and nothing here is lazy. Every field is a value
read at a known instant, and ``ResolveResult.resolved_at_ms`` says which
instant. See ``script.py``'s module doc for the round-trip arithmetic
behind that design.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Literal, Mapping, Optional, Sequence, Union

LocatorEngineName = Literal["css", "text", "xpath", "label", "ref", "visible", "role"]


@dataclass(frozen=True)
class LocatorRect:
    x: float
    y: float
    w: float
    h: float


@dataclass(frozen=True)
class LocatorMatch:
    """One resolved element, measured at ``ResolveResult.resolved_at_ms``.
    The five actionability answers (``attached``, ``visible``, ``enabled``,
    ``stable``, ``hit_test_ok``) are pure DOM reads computed in the same
    evaluation that produced the rect."""

    index: int
    ref: Optional[str]
    tag_name: str
    type: Optional[str]
    id: Optional[str]
    name: Optional[str]
    role: Optional[str]
    rect: LocatorRect
    center: Mapping[str, float]
    attached: bool
    visible: bool
    enabled: bool
    disabled_reason: Optional[str]
    editable: bool
    stable: Optional[bool]
    hit_test_ok: Optional[bool]
    occluded_by: Optional[str]
    hit_reason: Optional[str]
    in_viewport: bool
    opacity: Optional[float]
    pointer_events: Optional[str]
    text: Optional[str]
    value: Optional[str]
    checked: Optional[bool]
    read_value: Union[str, bool, None]
    describe: Optional[str]

    @staticmethod
    def from_wire(m: Mapping[str, Any]) -> "LocatorMatch":
        rect = m["rect"]
        return LocatorMatch(
            index=m["index"],
            ref=m.get("ref"),
            tag_name=m["tagName"],
            type=m.get("type"),
            id=m.get("id"),
            name=m.get("name"),
            role=m.get("role"),
            rect=LocatorRect(x=rect["x"], y=rect["y"], w=rect["w"], h=rect["h"]),
            center=m["center"],
            attached=m["attached"],
            visible=m["visible"],
            enabled=m["enabled"],
            disabled_reason=m.get("disabledReason"),
            editable=m["editable"],
            stable=m.get("stable"),
            hit_test_ok=m.get("hitTestOk"),
            occluded_by=m.get("occludedBy"),
            hit_reason=m.get("hitReason"),
            in_viewport=m["inViewport"],
            opacity=m.get("opacity"),
            pointer_events=m.get("pointerEvents"),
            text=m.get("text"),
            value=m.get("value"),
            checked=m.get("checked"),
            read_value=m.get("readValue"),
            describe=m.get("describe"),
        )


@dataclass(frozen=True)
class ResolveResult:
    matches: Sequence[LocatorMatch]
    total: int
    truncated: bool
    engine: str
    segments: int
    selector: str
    resolved_at_ms: float
    url: str
    title: str
    viewport: Mapping[str, float]
    scope_missing: bool


@dataclass(frozen=True)
class WaitForResult(ResolveResult):
    waited_ms: float = 0
    checks: int = 0
    wakes: int = 0


ClickVia = Literal["coordinates", "dispatch"]


@dataclass(frozen=True)
class ClickResult:
    ok: bool
    via: ClickVia
    ref: Optional[str]
    point: Optional[Mapping[str, float]]
    match_count: int
    index: int
    verified: Optional[bool]
    attempts: int
    elapsed_ms: float
    re_resolved: bool


FillMode = Literal["keys", "insert"]


@dataclass(frozen=True)
class FillResult:
    ok: bool
    ref: Optional[str]
    match_count: int
    index: int
    mode: FillMode
    actual: Optional[str]
    verified: Optional[bool]
    elapsed_ms: float


SelectOptionSpec = Union[str, Mapping[str, Any]]


@dataclass(frozen=True)
class SelectResult:
    ok: bool
    ref: Optional[str]
    match_count: int
    index: int
    values: List[str]
    labels: List[str]
    elapsed_ms: float
