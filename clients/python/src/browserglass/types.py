"""Plain-data shapes shared across the SDK.

Options are deliberately NOT modelled as dataclasses here: every
:class:`~browserglass.client.AutomationClient` method takes its options as
keyword arguments directly (``client.acquire_control(wait_ms=0)`` rather
than ``client.acquire_control(AcquireControlOptions(wait_ms=0))``), which
is the idiomatic Python shape for what TypeScript spells as an options
bag. What lives here are the RESULT shapes and the small event/record
types that get passed to callbacks, where a named, documented type earns
its place.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Literal, Mapping, Optional, Sequence, Union

RevokeReason = Literal[
    "preempted_by_human",
    "preempted_by_agent",
    "expired",
    "force_claimed",
    "admin_revoked",
    "session_ended",
    "instance_released",
]

LeaseMode = Literal["exclusive", "shared"]

#: Which JavaScript world an evaluate runs in.
#:
#: ``"main"`` is the page's own world: the page's globals are visible, and
#: everything the script does is visible to the page in return. ``"isolated"``
#: is a separate world that shares the DOM and nothing else, which is
#: Chrome's own isolated-world mechanism (the one extensions run content
#: scripts in) reached through ``Page.createIsolatedWorld``.
#:
#: Absent on the wire means ``"main"``, which is why the caller facing
#: :meth:`browserglass.client.AutomationClient.evaluate` sends no ``world``
#: field at all when nobody asked for one. The locator engine does not
#: inherit that default: see ``locator/engine.py``'s ``ENGINE_WORLD``.
#:
#: This is a two member set and it will stay a two member set. It is
#: validated on the way out (``_check_world``) rather than only by the
#: server, because a typo like ``world="isolate"`` reaching the server as an
#: unknown string is a round trip spent to learn something the caller could
#: have been told at the call site.
EvaluateWorld = Literal["main", "isolated"]

#: The two legal values, as a runtime set. ``typing.Literal`` cannot be
#: iterated portably, and the validator needs to iterate.
EVALUATE_WORLDS = ("main", "isolated")


@dataclass(frozen=True)
class UploadFileInput:
    """One file for :meth:`AutomationClient.set_input_files`. Bytes and a
    name, never a path: the caller's filesystem is not the browser's, and
    a path from this process would mean nothing on the machine actually
    running Chrome (or worse, mean something else entirely)."""

    name: str
    data: bytes
    mime: str = "application/octet-stream"


@dataclass(frozen=True)
class ActionRecord:
    """One recorded action attempt, passed to the ``on_action`` hook."""

    action: str
    target_id: str
    ok: bool
    duration_ms: float
    args: Optional[Mapping[str, Any]] = None
    error: Optional[Mapping[str, Any]] = None


@dataclass(frozen=True)
class InFlightAction:
    action: str
    target_id: str
    started_at: float


@dataclass(frozen=True)
class PreemptionRequest:
    target_id: str
    by_label: str
    by_kind: Literal["human", "automation"]
    reason: Literal["priority", "force_claim", "human_takeover"]
    grace_ms: float
    deadline: float


@dataclass(frozen=True)
class ControlYieldEvent:
    """Control is being taken away, or has been. See
    :meth:`AutomationClient.on_control_yield`."""

    target_id: str
    phase: Literal["requested", "taken"]
    reason: Literal["priority", "force_claim", "human_takeover", "voluntary"]
    by_label: str
    by_kind: Literal["human", "automation"]
    human: bool
    deadline: Optional[float]
    in_flight: Sequence[InFlightAction]
    resume_not_before: Optional[float]


@dataclass(frozen=True)
class StatusResult:
    target_id: str
    url: str
    title: str
    loading: bool
    can_go_back: bool
    can_go_forward: bool
    lease_holder_viewer_id: Optional[str]
    lease_holder_label: Optional[str]


@dataclass(frozen=True)
class ScreenshotResult:
    capture_id: str
    target_id: str
    format: str
    width: int
    height: int
    size_bytes: int
    data: str
    """Base64, no ``data:`` prefix, matching the wire field."""


@dataclass(frozen=True)
class InspectResult:
    hit: bool
    gen: int
    rect: Optional[Mapping[str, float]] = None
    label: Optional[str] = None
    tag_name: Optional[str] = None
    href: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None


@dataclass(frozen=True)
class DiagnosticsSubscription:
    target_id: str
    console: bool
    errors: bool
    network: bool


@dataclass(frozen=True)
class ConsoleEntry:
    target_id: str
    level: str
    text: str
    url: Optional[str] = None
    line: Optional[int] = None
    column: Optional[int] = None
    stack: Optional[str] = None
    count: Optional[int] = None


@dataclass(frozen=True)
class PageErrorEntry:
    target_id: str
    name: str
    message: str
    stack: Optional[str] = None
    url: Optional[str] = None


@dataclass(frozen=True)
class NetworkRequestEntry:
    target_id: str
    request_id: str
    method: str
    url: str
    resource_type: str
    status: Optional[int]
    error_text: Optional[str]
    from_cache: bool
    duration_ms: Optional[float]
    encoded_bytes: Optional[int]
    started_at: float


@dataclass(frozen=True)
class NetworkSummaryEntry:
    target_id: str
    window_ms: float
    requests: int
    failed: int
    bytes_in: int
    bytes_out: int
    slowest: Sequence[Mapping[str, Any]]


# ==================================================================
# The response body join (`devtools` capability, not a capability of
# its own; `packages/protocol/src/wire/messages/response-body.ts`).
#
# A `request_id` reaches this client in exactly one way: the `network`
# event delivered through `AutomationClient.on("network", ...)`, which
# only ever fires for a target this client has called
# `diagnostics.subscribe(network=True)` on. There is no other method on
# this class that mints or accepts one; guessing a `request_id` string
# buys nothing, because the server checks it against what THIS client
# was actually shown, not against what exists in Chrome's buffer.
# ==================================================================


@dataclass(frozen=True)
class ResponseBodyResult:
    """The buffered response body for one request, resolved by
    :meth:`~browserglass.client.Diagnostics.response_body`.

    ``body`` is UTF-8 text when ``base64_encoded`` is false, and
    base64-encoded bytes when true, exactly as CDP's own
    ``Network.getResponseBody`` splits it (binary responses, images,
    PDFs, and anything Chrome could not decode as text arrive with
    ``base64_encoded=True``). ``size_bytes`` is the DECODED byte length
    either way, which is what a caller comparing against a size limit of
    its own actually wants.
    """

    body: str
    base64_encoded: bool
    size_bytes: int


# ==================================================================
# The outbound request gate (`intercept` capability, plus `evaluate`
# when a rule sets `include_request_body`).
#
# Read `packages/protocol/src/wire/messages/interception.ts`'s module
# doc before changing anything here: the safety of this feature rests
# on the SHAPE of what crosses the wire, not on a runtime check
# somewhere that has to be right every time. There is deliberately
# nowhere on this surface to put a rewritten URL, method, header or
# body, and a verdict is exactly two words; that absence is the entire
# security argument, not an oversight to be tidied up later.
# ==================================================================

GateVerdict = Literal["allow", "deny"]
"""The only two answers a gate may give. See this module's request gate
section: there is nowhere on this surface to put a rewritten URL, and a
future change that adds one is reopening a hole the protocol closed on
purpose."""


@dataclass(frozen=True)
class GateRule:
    """One matching rule for :meth:`~browserglass.client.Gate.enable`.
    Mirrors ``GateRule`` in
    ``packages/protocol/src/wire/messages/interception.ts``.

    A rule that names ``verdict='allow'`` or ``verdict='deny'`` is
    decided server side with no round trip and never pauses anything,
    which is the shape to prefer: it costs no round trip and cannot time
    out. A rule with ``verdict='ask'`` is the one that produces a
    :class:`RequestGatePausedEvent`.
    """

    url_pattern: str
    """Glob style URL pattern, ``*`` matching any run of characters.
    Matched against the full request URL."""
    verdict: Literal["allow", "deny", "ask"]
    methods: Optional[Sequence[str]] = None
    """Restricts the rule to these HTTP methods. ``None`` means every
    method."""
    resource_types: Optional[Sequence[str]] = None
    """Restricts the rule to these Chrome resource types (``Document``,
    ``XHR``, ``Fetch``, ``Script``, and so on). ``None`` means every
    type."""
    include_request_body: bool = False
    """Includes the request body on the :class:`RequestGatePausedEvent`
    this rule produces. Only meaningful with ``verdict='ask'``.
    Additionally requires the ``evaluate`` capability: a caller who can
    already run script in the page can already read anything the page is
    about to send, so this flag grants nothing new to a token that holds
    ``evaluate``, and grants something significant to one that does
    not."""
    on_timeout: Optional[GateVerdict] = None
    """What an unanswered or late verdict counts as for this rule.
    Defaults server side to ``'deny'``: a gate that fails open is not a
    gate."""
    hold_ms: Optional[float] = None
    """How long to hold a request matched by this rule before the
    server applies ``on_timeout`` on its own. Defaults server side to
    ``DEFAULT_GATE_HOLD_MS``."""


@dataclass(frozen=True)
class GateEnableResult:
    """Resolves :meth:`~browserglass.client.Gate.enable`. ``rule_count``
    echoes what the server actually accepted, which is what a caller
    should assert against rather than assuming its own list length
    survived."""

    target_id: str
    rule_count: int


# ==================================================================
# The accessibility tree read (`devtools` capability, NOT `evaluate`,
# deliberately: `AutomationClient.a11y()` runs no page script, only
# `Accessibility.queryAXTree`. See
# `packages/protocol/src/wire/messages/a11y.ts` in the monorepo for the
# full design argument, and `locator/selector.py`'s `role=` engine for
# the other thing built on the same CDP call.
# ==================================================================


@dataclass(frozen=True)
class A11yNode:
    """One accessibility node, shaped for an LLM reader rather than a raw
    CDP ``AXNode`` dump: role, name, and only the properties that decide
    whether it is actionable."""

    role: str
    """Chrome's own computed role string (``'button'``, ``'link'``,
    ``'textbox'``, ...). Never the literal ``role`` HTML attribute; see
    :class:`~browserglass.locator.types.LocatorMatch`'s own ``role`` field
    for that distinction."""
    name: str
    """Chrome's own computed accessible name, already resolved through
    ``aria-label``/``aria-labelledby``/native labelling/text content, in
    that priority order, by Chrome's engine rather than by this
    codebase's own ``label=`` four-rule approximation."""
    backend_node_id: int
    """CDP's own ``backendDOMNodeId``. Meaningful only for correlating
    within one reply (never sent back to the server as an argument to
    anything) and specifically NOT a handle."""
    ignored: bool
    focusable: Optional[bool]
    disabled: Optional[bool]
    hidden: Optional[bool]
    expanded: Optional[bool]
    checked: Union[bool, str, None]
    """``'mixed'`` for a tri-state checkbox in its indeterminate state."""
    pressed: Union[bool, str, None]
    selected: Optional[bool]
    required: Optional[bool]
    readonly: Optional[bool]
    invalid: Union[bool, str, None]
    level: Optional[int]

    @staticmethod
    def from_wire(m: Mapping[str, Any]) -> "A11yNode":
        return A11yNode(
            role=m["role"],
            name=m["name"],
            backend_node_id=m["backendNodeId"],
            ignored=m["ignored"],
            focusable=m.get("focusable"),
            disabled=m.get("disabled"),
            hidden=m.get("hidden"),
            expanded=m.get("expanded"),
            checked=m.get("checked"),
            pressed=m.get("pressed"),
            selected=m.get("selected"),
            required=m.get("required"),
            readonly=m.get("readonly"),
            invalid=m.get("invalid"),
            level=m.get("level"),
        )


@dataclass(frozen=True)
class A11yResult:
    """What :meth:`~browserglass.client.AutomationClient.a11y` read.

    ``nodes`` is bounded and ``truncated`` says so honestly rather than
    silently. Empty is an ordinary answer, never an error: a role/name
    filter matching nothing is information, the same rule
    :class:`~browserglass.locator.types.ResolveResult` already follows.
    """

    nodes: Sequence[A11yNode]
    total: int
    """How many nodes matched before either bound was applied."""
    truncated: bool
    """True when ``len(nodes) < total``."""


# ==================================================================
# Downloads (`download` capability;
# `packages/protocol/src/wire/messages/files.ts`'s `download.*` messages,
# `packages/core/src/downloads/*`). Bytes never travel over this
# control socket: a finished download is reported as a signed,
# short-lived, single-use HTTP URL, fetched with an ordinary GET using
# whatever HTTP client the caller already has (this package already
# depends on `httpx` for `RestClient`). There is deliberately no
# "give me the bytes" method on this surface, on this client or the
# TypeScript one: see `AutomationClient.wait_for_download`'s own
# docstring for the argument, which is the same one `elements()` makes
# for refusing an element-handle API rather than inventing one.
# ==================================================================


@dataclass(frozen=True)
class DownloadResult:
    """A finished download, resolved by
    :meth:`~browserglass.client.AutomationClient.wait_for_download`.

    ``url`` is a signed, short lived, SINGLE USE HTTP URL, not the
    page's own download address: fetch it with an ordinary GET before
    ``expires_at``. ``sha256`` is of the file as written, so a caller
    can verify what it fetched.
    """

    download_id: str
    size_bytes: int
    sha256: str
    url: str
    expires_at: float
    """Epoch ms after which ``url`` stops working."""


@dataclass(frozen=True)
class RequestGatePausedEvent:
    """One outbound request held by the gate, awaiting a verdict.
    Delivered only to the connection that registered the rule set.

    ``post_data`` is present only when the matching rule set
    ``include_request_body``, which additionally requires the
    ``evaluate`` capability: a POST body carries whatever the user
    typed.
    """

    target_id: str
    gate_id: str
    """Echo this back on the verdict."""
    url: str
    method: str
    resource_type: str
    headers: Mapping[str, str]
    deadline_at: float
    """Epoch ms after which the server applies the rule's own
    ``on_timeout`` without waiting further."""
    post_data: Optional[str] = None
