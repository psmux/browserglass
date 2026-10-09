"""The locator verbs, composed from one resolver script (``script.py``)
and the client's existing input path. Mirrors
``packages/automation/src/locator/engine.ts``.

The verb list is short and every entry earned its place against measured
call counts in real automation scripts rather than against Playwright's
surface. What is deliberately absent is
as much of the design as what is present: no ``count()``, no ``first``,
no ``nth()``, no ``is_visible()``, because :meth:`LocatorEngine.resolve`
already answers all four in one round trip and shipping them as aliases
would only reintroduce the four-round-trip shape a lazy ``Locator``
forces; no frame locators; no strict mode, because a page matching a
selector twice is a fact about the page, not an error.

``role=`` IS here, on top of ``resolve`` rather than as a fourth thing to
keep in sync with it. An earlier pass over this file refused a
``get_by_role``-style verb on the grounds that it is an ARIA
specification rather than a function, and that hand rolled role
computations in real automation code are known to fail in practice. Both objections were really about one mistake,
reimplementing WAI-ARIA role and accessible-name computation in page
JavaScript by hand, and ``role=`` does not make it: it asks Chrome's own
accessibility engine, through ``Accessibility.queryAXTree``, for the same
answer :meth:`browserglass.client.AutomationClient.a11y` reads, then
stamps the matches with a DOM attribute and rewrites the segment to an
ordinary ``css=[...]`` selector before ``RESOLVE_SCRIPT`` ever sees it.
See :meth:`LocatorEngine._prepare_selector` for the mechanics. A
``<button>`` with no ``role`` attribute, or an ``<a>`` with no ``href``,
are exactly the markup a ``[role="x"]`` CSS lookalike gets wrong.
"""

from __future__ import annotations

import asyncio
import random
import re
import string
import time
from dataclasses import replace
from typing import Any, Awaitable, Callable, List, Mapping, Optional, Protocol, Sequence, Union

from ..errors import AutomationError
from ..types import EvaluateWorld
from ..worlds import check_world
from .script import CLEAR_SCRIPT, DISPATCH_CLICK_SCRIPT, READ_SCRIPT, RESOLVE_SCRIPT, SELECT_SCRIPT, WAIT_SCRIPT
from .selector import (
    STALE_RESOLVE_WINDOW_MS,
    actionability_error,
    parse_role_value,
    parse_selector,
    split_segments,
    terminal_engine,
)
from .selector import SelectorSegment
from .types import ClickResult, FillResult, LocatorMatch, ResolveResult, SelectResult, WaitForResult

MAX_EVALUATE_TIMEOUT_MS = 120000

# How much longer the transport/server deadline is than the in-page
# wait's own deadline. The page must be the one that gives up, because
# only the page can say what the element looked like when it did.
WAIT_EVALUATE_MARGIN_MS = 2000

# Default overall deadline for click/fill/select.
DEFAULT_ACT_TIMEOUT_MS = 8000

# How long one in-page wait slice runs when the selector has a ``role=``
# segment, before the accessibility query is repeated. See ``wait_for``.
ROLE_REQUERY_MS = 1000

_TRANSIENT_NAVIGATION = re.compile(
    r"Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id"
    r"|Cannot find default execution context|Could not find node with given id|No frame with given id|frame (was )?detached",
    re.IGNORECASE,
)


def _normalize_for_text_match(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _partial_text_needle(selector: str) -> Optional[str]:
    """The normalised needle when ``selector`` ends in an unquoted
    (partial) ``text=`` segment, otherwise ``None``."""
    try:
        segments = parse_selector(selector)
    except AutomationError:
        return None
    if not segments or segments[-1].engine != "text":
        return None
    value = segments[-1].value
    if re.match(r'^"[\s\S]*"$', value):
        return None
    needle = _normalize_for_text_match(value)
    return needle or None


def is_transient_navigation_error(err: BaseException) -> bool:
    """Whether ``err`` is the page changing under a query (a navigation
    replaced the document, or the execution context went away) rather than
    an answer about it. A wait keeps polling through these and nothing
    else. Mirrors ``isTransientNavigationError`` in engine.ts."""
    if isinstance(err, AutomationError) and err.code in (
        "TARGET_CLOSED", "INSTANCE_GONE", "LEASE_REVOKED", "POLICY_DENIED", "INVALID_ARGUMENT",
    ):
        return False
    message = err.message if isinstance(err, AutomationError) else str(err)
    return bool(_TRANSIENT_NAVIGATION.search(message))

# The world every one of this engine's own six fixed scripts runs in.
#
# ``"isolated"``, and this is the single most consequential default in the
# locator surface. Three separate reasons. It is the Python counterpart
# of ``packages/automation/src/locator/engine.ts``'s ``ENGINE_WORLD``, and
# it has to be, because the two clients drive the same wire and a caller
# that switched from one to the other would otherwise switch worlds
# without being told.
#
# 1. PARITY. patchright's Python client declares
#    ``isolatedContext: Optional[bool] = True`` on ``page.evaluate``,
#    ``frame.evaluate``, ``locator.evaluate`` and ``handle.evaluate``
#    (``patchright/_impl/_page.py:452``, ``_frame.py:313``,
#    ``_locator.py:168``, ``_js_handle.py:58``), which its server side maps
#    to ``world: 'utility'``. So every read an automation script written
#    against patchright takes comes from an isolated world. A main world
#    default here is not a neutral choice; it is a behaviour change for
#    anybody porting such a script.
#
# 2. THE PAGE CANNOT WATCH. An isolated world shares the DOM and nothing
#    else. A page cannot hook the functions these scripts call, cannot see
#    the globals they define, and cannot tamper with what they return. On
#    a site looking for automation that is the whole point. Under
#    patchright, an invisible hCaptcha on a real world form stops
#    challenging, and the single difference is the isolated world and the
#    absent ``Runtime.enable``.
#
# 3. THE BOUNDARY IS LOAD BEARING FOR CODE THAT IS NOT OURS. Automation
#    scripts written against patchright often carry callback branches
#    reaching for ``window.hcaptcha``, ``window.hcaptchaOnLoad`` and other
#    named page callbacks, each wrapped in an empty ``except``. That code
#    is dead under an isolated world, precisely because the isolated world
#    makes those globals undefined. Run the same evaluate in the main
#    world and it comes back to life, silently, on every page whose
#    hCaptcha challenge was already solved. The rule also holds the other
#    way round: after the hCaptcha frames are removed, calling into
#    ``window.hcaptcha`` crashes the renderer, and the world boundary is
#    what enforces that for free.
#    A submit blocker that monkeypatches ``HTMLFormElement.prototype.submit``
#    is page-visible from the main world and invisible from here.
#
# The cost is real and is stated here so nobody has to rediscover it: a
# script running in this world reading ``window.somethingThePageSet`` gets
# ``undefined``, every time, and that is indistinguishable from the value
# not existing. None of the six scripts in ``script.py`` reads a page
# global. They read and write the DOM, which is shared, and that is all an
# isolated world needs to be able to do.
#
# A caller who genuinely needs a page global has one door, and it is
# explicit: ``click(verify_world="main")``. See :meth:`LocatorEngine.click`.
ENGINE_WORLD: EvaluateWorld = "isolated"


class LocatorRuntime(Protocol):
    """Everything the locator engine needs from
    :class:`~browserglass.client.AutomationClient`'s own internals,
    passed in rather than reached for. Every one of these is the RAW form
    of a method the client already has: no capability/lease wrapper, so
    one locator verb costs one step rather than one per composed
    sub-action, and no second input path. In particular ``click_point``
    is the same body ``click_at()`` runs, so a locator click inherits the
    generation stamp, the stand-down gate, the lease id and the fencing
    exactly as a human's click does."""

    async def evaluate_function(
        self, target_id: str, source: str, args: Sequence[Any], timeout_ms: float, *, world: EvaluateWorld
    ) -> Any:
        """Runs a ``functionDeclaration`` with JSON args, returning by
        value, in the named world.

        ``world`` is REQUIRED, and it is required on purpose. The
        TypeScript side added it as an optional trailing parameter first
        and then made it mandatory, because an optional parameter here is
        a parameter a future call site forgets, and the failure mode is
        silent: the script runs in the main world and the page can see
        everything the locator surface does. There is no compiler here to
        ask the question at every call site, so this signature asks it
        twice over. The parameter has no default, so a call site that
        omits it raises ``TypeError`` on its first execution rather than
        running in the wrong world for ever; and it is KEYWORD ONLY, so it
        can never be confused with ``timeout_ms`` by position, and a
        reader of any call site can see which world was chosen without
        counting arguments.

        See :data:`ENGINE_WORLD` for what this engine's own scripts pass
        and why.
        """
        ...

    async def evaluate_expression(
        self, target_id: str, expression: str, timeout_ms: float, *, world: EvaluateWorld
    ) -> Any:
        """Runs a bare expression, for the caller-supplied ``verify``
        predicate. Same required, keyword only ``world`` as
        :meth:`evaluate_function`."""
        ...

    async def prepare_dispatch(self, target_id: str) -> None: ...

    async def click_point(self, target_id: str, x: float, y: float, opts: Mapping[str, Any]) -> None: ...

    async def type_chars(self, target_id: str, text: str, delay_ms: float) -> None: ...

    async def insert_text(self, target_id: str, text: str) -> None: ...

    async def sleep(self, ms: float) -> None: ...

    @property
    def default_timeout_ms(self) -> float: ...

    async def query_and_stamp_by_role(
        self, target_id: str, role: Optional[str], name: Optional[str], timeout_ms: float
    ) -> Mapping[str, Any]:
        """Resolves a ``role=`` segment's role/name filter through
        ``Accessibility.queryAXTree`` and stamps every match with a fresh
        DOM attribute, so the segment can be rewritten into an ordinary
        ``css=`` selector before it ever reaches ``RESOLVE_SCRIPT``.
        Returns a mapping with key ``attr``: the stamped attribute name
        (addressable as ``[<attr>]``, a presence selector, no value to
        escape), or ``None`` when nothing matched, in which case the
        caller should short-circuit to an empty result rather than
        running a doomed round trip through the page's own resolver.

        This is the one place a ``resolve()`` call reaches outside the
        page evaluation path: see
        :meth:`browserglass.client.AutomationClient.a11y`'s own doc for
        why ``role=`` is built on the SAME CDP call ``a11y()`` is, rather
        than a second, hand rolled implementation of "what is this
        element's role".
        """
        ...


def _check_verify_world(asked: Any) -> EvaluateWorld:
    """Resolves ``click(verify_world=...)`` to a world, defaulting to
    :data:`ENGINE_WORLD`.

    It validates rather than passing the string through, and the reason is
    the shape of the mistake it catches. ``verify_world`` arrives inside a
    plain options mapping (``click()`` takes ``**opts``), so a
    misspelling has no signature to fail against; and if a bad value
    reached the wire, the predicate would come back as a protocol error
    from a call the caller believes was about their predicate. Refusing it
    here says which key was wrong.
    """
    resolved = check_world(asked, where="click(verify_world=...)")
    return resolved if resolved is not None else ENGINE_WORLD


def _is_actionable(m: LocatorMatch) -> bool:
    return m.attached and m.visible and m.enabled and m.hit_test_ok is not False and m.stable is not False


def _empty_result(selector: str) -> ResolveResult:
    return ResolveResult(
        matches=[],
        total=0,
        truncated=False,
        engine="css",
        segments=1,
        selector=selector,
        resolved_at_ms=time.time() * 1000,
        url="",
        title="",
        viewport={"w": 0, "h": 0, "scrollX": 0, "scrollY": 0},
        scope_missing=False,
    )


def _mint_ref_prefix() -> str:
    """A random per-call prefix, so two concurrent resolves on one page
    cannot mint the same ref."""
    alphabet = string.ascii_lowercase + string.digits
    return "bg" + "".join(random.choice(alphabet) for _ in range(8))


def _normalize_select_option(spec: Union[str, Mapping[str, Any]]) -> Mapping[str, Any]:
    return {"value": spec} if isinstance(spec, str) else dict(spec)


def _wire_to_resolve_result(wire: Mapping[str, Any], selector: str) -> ResolveResult:
    return ResolveResult(
        matches=[LocatorMatch.from_wire(m) for m in wire.get("matches", [])],
        total=wire["total"],
        truncated=wire["truncated"],
        engine=wire.get("engine") or "css",
        segments=wire["segments"],
        selector=selector,
        resolved_at_ms=time.time() * 1000,
        url=wire.get("url", ""),
        title=wire.get("title", ""),
        viewport=wire.get("viewport", {}),
        scope_missing=wire.get("scopeMissing", False),
    )


class LocatorEngine:
    def __init__(self, rt: LocatorRuntime) -> None:
        self._rt = rt

    # ------------------------------------------------------------------
    # resolve: the primitive
    # ------------------------------------------------------------------

    async def resolve(self, target_id: str, selector: str, opts: Optional[Mapping[str, Any]] = None) -> ResolveResult:
        opts = opts or {}
        segments = parse_selector(selector)
        timeout_ms = opts.get("timeout_ms", self._rt.default_timeout_ms)
        effective = await self._prepare_selector(target_id, selector, segments, timeout_ms)
        if effective is None:
            # A `role=` segment matched nothing: nothing downstream of an
            # empty segment can ever match either, the same short-circuit
            # the page's own resolver loop already applies to an ordinary
            # CSS segment matching nothing. Reported without spending the
            # round trip to RESOLVE_SCRIPT to prove it again.
            return replace(_empty_result(selector), engine=terminal_engine(segments), segments=len(segments))
        spec = self._build_resolve_spec(effective, opts)
        wire = await self._rt.evaluate_function(target_id, RESOLVE_SCRIPT, [spec], timeout_ms, world=ENGINE_WORLD)
        if wire.get("selectorError"):
            raise AutomationError(
                "INVALID_ARGUMENT",
                f"resolve('{selector}'): the page could not evaluate the selector: {wire['selectorError']}",
                {"selector": selector, "pageError": wire["selectorError"]},
            )
        result = _wire_to_resolve_result(wire, selector)
        if not wire.get("engine"):
            result = replace(result, engine=terminal_engine(segments))
        return result

    async def _prepare_selector(
        self, target_id: str, selector: str, segments: List[SelectorSegment], timeout_ms: float
    ) -> Optional[str]:
        """Resolves every ``role=`` segment in ``selector`` (there may be
        more than one, and each may be anywhere in a ``>>`` chain) and
        returns the selector a page-side round trip should actually run:
        ``selector`` unchanged when it has no ``role=`` segment, or a
        rewritten copy with each ``role=...`` replaced by
        ``css=[<marker>]``, a plain presence selector addressing exactly
        the elements :meth:`LocatorRuntime.query_and_stamp_by_role` just
        stamped. ``None`` when ANY role= segment matched nothing, which
        the caller should treat as "short-circuit to an empty result"
        rather than run a round trip that cannot produce one.

        Independent role= segments are resolved concurrently
        (``asyncio.gather``): none of them depends on another's answer.
        """
        role_indexes = [i for i, seg in enumerate(segments) if seg.engine == "role"]
        if not role_indexes:
            return selector

        results = await asyncio.gather(
            *(self._query_role_segment(target_id, segments[i], selector, timeout_ms) for i in role_indexes)
        )

        raw = split_segments(selector)
        for k, i in enumerate(role_indexes):
            attr = results[k].get("attr")
            if attr is None:
                return None
            raw[i] = f"css=[{attr}]"
        return " >> ".join(raw)

    async def _query_role_segment(
        self, target_id: str, seg: SelectorSegment, selector: str, timeout_ms: float
    ) -> Mapping[str, Any]:
        filt = parse_role_value(seg.value, selector)
        return await self._rt.query_and_stamp_by_role(target_id, filt.role, filt.name, timeout_ms)

    def _build_resolve_spec(self, selector: str, opts: Mapping[str, Any]) -> Mapping[str, Any]:
        spec: dict[str, Any] = {
            "selector": selector,
            "limit": opts.get("limit", 50),
            "stamp": opts.get("stamp", True) is not False,
            "stable": opts.get("stable", True) is not False,
            "hitTest": opts.get("hit_test", True) is not False,
            "scroll": opts.get("scroll", False) is True,
            "scrollIndex": opts.get("scroll_index", 0),
            "refPrefix": _mint_ref_prefix(),
            "textLimit": opts.get("text_limit", 200),
        }
        if "within" in opts and opts["within"] is not None:
            spec["withinRef"] = opts["within"]
        if "read" in opts and opts["read"] is not None:
            spec["read"] = opts["read"]
        return spec

    # ------------------------------------------------------------------
    # wait_for: one evaluate, held in the page
    # ------------------------------------------------------------------

    async def wait_for(self, target_id: str, selector: str, opts: Optional[Mapping[str, Any]] = None) -> WaitForResult:
        opts = opts or {}
        segments = parse_selector(selector)
        state = opts.get("state", "visible")
        asked_ms = opts.get("timeout_ms", self._rt.default_timeout_ms)
        budget_ms = max(0.0, min(asked_ms, MAX_EVALUATE_TIMEOUT_MS - WAIT_EVALUATE_MARGIN_MS))
        poll_ms = opts.get("poll_ms", 100)
        started = time.time() * 1000
        overall_deadline = started + budget_ms
        # A ``role=`` segment is resolved by an accessibility query BEFORE
        # the in-page wait, which then watches only the elements that query
        # stamped. An element that appears later has no stamp, so with a
        # role segment the in-page wait runs in slices and each slice starts
        # with a fresh query. See engine.ts's ``waitForHop``.
        has_role = any(seg.engine == "role" for seg in segments)
        slice_ms = ROLE_REQUERY_MS if has_role else float("inf")
        # Bounded by a count as well as the clock, so a fake clock that does
        # not move cannot spin this forever.
        max_rounds = int(budget_ms / min(poll_ms, 250)) + 2
        checks = 0
        wakes = 0
        last_observed: Optional[ResolveResult] = None
        round_no = 0

        while True:
            deadline_ms = max(0.0, overall_deadline - time.time() * 1000)
            out_of_time = deadline_ms <= 0 or round_no >= max_rounds
            round_no += 1

            try:
                effective = await self._prepare_selector(target_id, selector, segments, deadline_ms)
            except Exception as err:
                if not out_of_time and is_transient_navigation_error(err):
                    await self._rt.sleep(min(poll_ms, deadline_ms))
                    continue
                # The accessibility query runs with what is left of the
                # deadline as its own timeout; when that is what ran out,
                # report it as this wait timing out.
                if (
                    isinstance(err, AutomationError)
                    and err.code == "TIMEOUT"
                    and time.time() * 1000 >= overall_deadline - WAIT_EVALUATE_MARGIN_MS
                ):
                    observed = last_observed or replace(
                        _empty_result(selector), engine=terminal_engine(segments), segments=len(segments)
                    )
                    raise self._wait_timeout_error(
                        selector, state, observed, {"checks": checks, "wakes": wakes}, time.time() * 1000 - started
                    )
                raise

            if effective is None:
                # A ``role=`` segment matched nothing. ``detached`` and
                # ``hidden`` are satisfied by an empty match set; every other
                # state keeps polling until the deadline, like a CSS selector
                # that matches nothing yet.
                checks += 1
                observed = replace(_empty_result(selector), engine=terminal_engine(segments), segments=len(segments))
                if state in ("detached", "hidden"):
                    return WaitForResult(
                        **{f.name: getattr(observed, f.name) for f in observed.__dataclass_fields__.values()},  # type: ignore[attr-defined]
                        waited_ms=time.time() * 1000 - started,
                        checks=checks,
                        wakes=wakes,
                    )
                if out_of_time:
                    raise self._wait_timeout_error(
                        selector, state, last_observed or observed, {"checks": checks, "wakes": wakes}, time.time() * 1000 - started
                    )
                await self._rt.sleep(min(max(poll_ms, 250), deadline_ms))
                continue

            wants_full_measure = state == "actionable"
            check = self._build_resolve_spec(
                effective,
                {
                    **opts,
                    "stamp": False,
                    "stable": wants_full_measure and opts.get("stable", True) is not False,
                    "hit_test": wants_full_measure and opts.get("hit_test", True) is not False,
                },
            )
            stamp_spec = None if opts.get("stamp") is False else self._build_resolve_spec(effective, {**opts, "stamp": True})

            slice_deadline_ms = min(deadline_ms, slice_ms)
            try:
                wire = await self._rt.evaluate_function(
                    target_id,
                    WAIT_SCRIPT,
                    [
                        {
                            "check": check,
                            "stamp": stamp_spec,
                            "state": state,
                            "deadlineMs": slice_deadline_ms,
                            "pollMs": poll_ms,
                            "index": opts.get("index"),
                        }
                    ],
                    slice_deadline_ms + WAIT_EVALUATE_MARGIN_MS,
                    world=ENGINE_WORLD,
                )
            except Exception as err:
                # The document the wait ran in went away (a click that
                # submitted a form, say). The deadline is the caller's, so
                # keep polling the new document.
                if not out_of_time and time.time() * 1000 < overall_deadline and is_transient_navigation_error(err):
                    await self._rt.sleep(min(poll_ms, max(0.0, overall_deadline - time.time() * 1000)))
                    continue
                raise

            if wire.get("failed") is True:
                raise AutomationError(
                    "INVALID_ARGUMENT",
                    f"waitFor('{selector}'): the page could not evaluate the selector: {wire.get('error', 'unknown')}",
                    {"selector": selector, "state": state, "pageError": wire.get("error")},
                )

            checks += wire.get("checks", 0)
            wakes += wire.get("wakes", 0)
            observed = _wire_to_resolve_result(wire["result"], selector) if wire.get("result") else _empty_result(selector)
            last_observed = observed

            if wire.get("timedOut"):
                if not out_of_time and has_role and time.time() * 1000 < overall_deadline:
                    continue
                raise self._wait_timeout_error(
                    selector, state, observed, {**wire, "checks": checks, "wakes": wakes}, time.time() * 1000 - started
                )

            return WaitForResult(
                **{f.name: getattr(observed, f.name) for f in observed.__dataclass_fields__.values()},  # type: ignore[attr-defined]
                waited_ms=wire["waitedMs"] if round_no == 1 else time.time() * 1000 - started,
                checks=checks,
                wakes=wakes,
            )

    def _wait_timeout_error(
        self,
        selector: str,
        state: str,
        observed: ResolveResult,
        wire: Mapping[str, Any],
        elapsed_ms: float,
    ) -> AutomationError:
        base = {
            "selector": selector,
            "state": state,
            "matchCount": observed.total,
            "checks": wire["checks"],
            "wakes": wire["wakes"],
            "elapsedMs": elapsed_ms,
            "url": observed.url,
        }
        if state == "detached":
            return AutomationError(
                "TIMEOUT",
                f"waitFor('{selector}', 'detached'): {observed.total} element(s) were still in the document after {elapsed_ms}ms.",
                {**base, "state": "detached"},
            )
        if state == "hidden":
            visible = [m for m in observed.matches if m.visible]
            return AutomationError(
                "TIMEOUT",
                f"waitFor('{selector}', 'hidden'): {len(visible)} of {observed.total} match(es) were still visible after {elapsed_ms}ms.",
                {**base, "stillVisible": len(visible)},
            )
        if observed.total == 0:
            return AutomationError(
                "NOT_FOUND",
                f"waitFor('{selector}', '{state}'): nothing matched in {elapsed_ms}ms ({wire['checks']} checks, {wire['wakes']} DOM mutations). The page is at {observed.url}.",
                base,
            )
        return actionability_error(f"waitFor(..., '{state}')", selector, observed, observed.matches[0], elapsed_ms)

    # ------------------------------------------------------------------
    # The choosing rule, shared by every acting verb
    # ------------------------------------------------------------------

    def _pick(self, result: ResolveResult, index: Optional[int], selector: Optional[str] = None) -> Optional[LocatorMatch]:
        if index is not None:
            return result.matches[index] if 0 <= index < len(result.matches) else None
        # A partial ``text=`` selector prefers an actionable match whose whole
        # text equals the needle over one that only contains it, so
        # ``text=Logout`` acts on the Logout link rather than on a heading
        # earlier in the page that mentions logging out. See engine.ts's
        # ``pick``.
        needle = _partial_text_needle(selector) if selector is not None else None
        if needle is not None:
            for m in result.matches:
                if _is_actionable(m) and _normalize_for_text_match(m.text or "") == needle:
                    return m
        for m in result.matches:
            if _is_actionable(m):
                return m
        return None

    def _require_actionable(
        self, verb: str, selector: str, result: ResolveResult, index: Optional[int], elapsed_ms: float
    ) -> LocatorMatch:
        if index is not None and (index < 0 or index >= len(result.matches)):
            what = "nothing matched" if result.total == 0 else f"only {result.total} element(s) matched"
            raise AutomationError(
                "NOT_FOUND",
                f"{verb}('{selector}'): index {index} was asked for and {what}. The page is at {result.url}.",
                {"verb": verb, "selector": selector, "index": index, "matchCount": result.total, "engine": result.engine, "url": result.url},
            )
        chosen = self._pick(result, index, selector)
        if chosen is None or not _is_actionable(chosen):
            raise actionability_error(verb, selector, result, chosen if chosen is not None else self._best(result, index), elapsed_ms)
        return chosen

    def _best(self, result: ResolveResult, index: Optional[int]) -> Optional[LocatorMatch]:
        if index is not None and 0 <= index < len(result.matches):
            return result.matches[index]
        return result.matches[0] if result.matches else None

    # ------------------------------------------------------------------
    # click
    # ------------------------------------------------------------------

    async def click(self, target_id: str, selector: str, opts: Optional[Mapping[str, Any]] = None) -> ClickResult:
        """Options, beyond the ones the TypeScript ``LocatorClickOptions``
        already documents: ``verify_world``, ``"main"`` or ``"isolated"``,
        default ``"isolated"``.

        It is the Python counterpart of ``LocatorClickOptions.verifyWorld``
        and it is the ONLY way any caller of this engine can move a script
        off :data:`ENGINE_WORLD`. Set it to ``"main"`` only for a
        ``verify`` predicate that has to read a global the page itself
        defined; see the comment at the predicate's own call site below
        for what goes wrong if you need it and do not pass it.
        """
        opts = opts or {}
        parse_selector(selector)
        started = time.time() * 1000
        deadline = started + opts.get("timeout_ms", DEFAULT_ACT_TIMEOUT_MS)
        via = opts.get("via", "coordinates")
        retries = 0 if opts.get("verify") is None else opts.get("retries", 2)
        stamp = opts.get("stamp", True) is not False
        attempts = 0
        re_resolved = False

        while True:
            attempts += 1
            remaining = deadline - time.time() * 1000
            if remaining <= 0:
                raise actionability_error("click", selector, _empty_result(selector), None, time.time() * 1000 - started)

            result = await self.wait_for(
                target_id,
                selector,
                {
                    "state": "actionable",
                    "timeout_ms": remaining,
                    "scroll": opts.get("scroll", True) is not False,
                    "scroll_index": opts.get("index", 0),
                    "stamp": stamp,
                    **({"index": opts["index"], "limit": max(50, opts["index"] + 1)} if "index" in opts and opts["index"] is not None else {}),
                },
            )
            chosen = self._require_actionable("click", selector, result, opts.get("index"), time.time() * 1000 - started)

            await self._rt.prepare_dispatch(target_id)

            if time.time() * 1000 - result.resolved_at_ms > STALE_RESOLVE_WINDOW_MS:
                result = await self.resolve(
                    target_id,
                    selector,
                    {"scroll": opts.get("scroll", True) is not False, "scroll_index": opts.get("index", 0), "stamp": stamp},
                )
                re_resolved = True
                chosen = self._require_actionable("click", selector, result, opts.get("index"), time.time() * 1000 - started)

            point: Optional[Mapping[str, float]] = None
            if via == "dispatch":
                if chosen.ref is None:
                    raise AutomationError(
                        "INVALID_ARGUMENT",
                        "click(via='dispatch') needs a stamp to address the element by; it cannot be combined with stamp=False",
                        {"selector": selector},
                    )
                res = await self._rt.evaluate_function(
                    target_id, DISPATCH_CLICK_SCRIPT, [{"ref": chosen.ref}], self._rt.default_timeout_ms, world=ENGINE_WORLD
                )
                if not res.get("found"):
                    raise self._stale_ref_error("click", selector, chosen.ref)
            else:
                point = {"x": chosen.center["x"], "y": chosen.center["y"]}
                click_opts: dict[str, Any] = {}
                if "button" in opts:
                    click_opts["button"] = opts["button"]
                if "click_count" in opts:
                    click_opts["clickCount"] = opts["click_count"]
                if "modifiers" in opts:
                    click_opts["modifiers"] = opts["modifiers"]
                await self._rt.click_point(target_id, point["x"], point["y"], click_opts)

            if opts.get("verify") is None:
                return ClickResult(
                    ok=True, via=via, ref=chosen.ref, point=point, match_count=result.total, index=chosen.index,
                    verified=None, attempts=attempts, elapsed_ms=time.time() * 1000 - started, re_resolved=re_resolved,
                )

            await self._rt.sleep(opts.get("verify_delay_ms", 250))
            # The one caller-authored script the locator surface runs, and
            # the one place a caller can move off ENGINE_WORLD. It still
            # DEFAULTS to the isolated world: a predicate is almost always
            # a DOM read ("did the button go away", "is the error box
            # showing"), the safe world does that perfectly, and a script
            # ported from patchright already ran every one of its
            # predicates in an isolated world, so defaulting to main would
            # be the behaviour CHANGE.
            #
            # `verify_world="main"` is the explicit opt out, for a
            # predicate that genuinely has to read a global the page
            # itself defined. It is spelled out rather than defaulted the
            # other way because the main world is observable: a page can
            # hook what the predicate calls, and a predicate is the one
            # script here whose text the page's operator did not write but
            # whose effects they can watch. In the isolated world
            # `window.somethingThePageSet` is `undefined`, and `undefined`
            # is indistinguishable from "not set yet", so such a predicate
            # would quietly never pass rather than failing loudly.
            passed = await self._rt.evaluate_expression(
                target_id,
                opts["verify"],
                self._rt.default_timeout_ms,
                world=_check_verify_world(opts.get("verify_world")),
            )
            if passed:
                return ClickResult(
                    ok=True, via=via, ref=chosen.ref, point=point, match_count=result.total, index=chosen.index,
                    verified=True, attempts=attempts, elapsed_ms=time.time() * 1000 - started, re_resolved=re_resolved,
                )

            if attempts > retries or time.time() * 1000 >= deadline:
                raise self._unverified_click_error(selector, chosen, result, opts["verify"], attempts, time.time() * 1000 - started)

    def _unverified_click_error(
        self, selector: str, chosen: LocatorMatch, result: ResolveResult, verify: str, attempts: int, elapsed_ms: float
    ) -> AutomationError:
        detail = {
            "selector": selector, "verify": verify, "attempts": attempts, "elapsedMs": elapsed_ms,
            "delivered": True, "verified": False, "matchCount": result.total, "index": chosen.index,
            "point": chosen.center, "occludedBy": chosen.occluded_by, "describe": chosen.describe, "url": result.url,
        }
        cx, cy = round(chosen.center["x"]), round(chosen.center["y"])
        if chosen.occluded_by is not None:
            return AutomationError(
                "OCCLUDED",
                f"click('{selector}'): {attempts} click(s) were delivered at ({cx}, {cy}) and the verify predicate "
                f"never passed; {chosen.occluded_by} is on top of the element at that point.",
                detail,
            )
        return AutomationError(
            "TIMEOUT",
            f"click('{selector}'): {attempts} click(s) were delivered at ({cx}, {cy}) in {elapsed_ms}ms and the "
            f"verify predicate '{verify}' never passed. The click reached the element; the page did not do what "
            "was expected of it.",
            detail,
        )

    def _stale_ref_error(self, verb: str, selector: str, ref: str) -> AutomationError:
        return AutomationError(
            "DETACHED",
            f"{verb}('{selector}'): the element stamped {ref} is gone. A ref is valid until its subtree "
            "re-renders and no longer, so this is a re-render, not a missing element: resolve again.",
            {"verb": verb, "selector": selector, "ref": ref, "stale": True},
        )

    # ------------------------------------------------------------------
    # fill
    # ------------------------------------------------------------------

    async def fill(self, target_id: str, selector: str, value: str, opts: Optional[Mapping[str, Any]] = None) -> FillResult:
        opts = opts or {}
        parse_selector(selector)
        started = time.time() * 1000
        deadline = started + opts.get("timeout_ms", DEFAULT_ACT_TIMEOUT_MS)
        mode = opts.get("mode", "keys")

        result = await self.wait_for(
            target_id,
            selector,
            {
                "state": "actionable",
                "timeout_ms": max(0.0, deadline - time.time() * 1000),
                "scroll": opts.get("scroll", True) is not False,
                "scroll_index": opts.get("index", 0),
                "stamp": True,
                **({"index": opts["index"], "limit": max(50, opts["index"] + 1)} if "index" in opts and opts["index"] is not None else {}),
            },
        )
        chosen = self._require_actionable("fill", selector, result, opts.get("index"), time.time() * 1000 - started)
        if not chosen.editable:
            raise AutomationError(
                "INVALID_ARGUMENT",
                f"fill('{selector}'): <{chosen.tag_name}> is not editable (it is neither an input, a textarea, "
                f"nor contenteditable, or it is readOnly). Matched {result.total} element(s); acted on index "
                f"{chosen.index} ({chosen.describe or chosen.tag_name}).",
                {"selector": selector, "index": chosen.index, "tagName": chosen.tag_name, "describe": chosen.describe, "matchCount": result.total},
            )
        if chosen.ref is None:
            raise AutomationError(
                "INVALID_ARGUMENT",
                "fill() addresses the field by stamp between its click and its read-back, so it cannot run with "
                "stamp=False. Use resolve() plus click_at()/type() to drive an unstamped field by coordinates.",
                {"selector": selector},
            )

        await self._rt.prepare_dispatch(target_id)
        if time.time() * 1000 - result.resolved_at_ms > STALE_RESOLVE_WINDOW_MS:
            result = await self.resolve(
                target_id, selector, {"scroll": opts.get("scroll", True) is not False, "scroll_index": opts.get("index", 0), "stamp": True}
            )
            chosen = self._require_actionable("fill", selector, result, opts.get("index"), time.time() * 1000 - started)
            if chosen.ref is None:
                raise actionability_error("fill", selector, result, chosen, time.time() * 1000 - started)
        ref = chosen.ref

        if opts.get("click", True) is not False:
            await self._rt.click_point(target_id, chosen.center["x"], chosen.center["y"], {})

        if opts.get("clear", True) is not False and (chosen.value or "") != "":
            cleared = await self._rt.evaluate_function(
                target_id, CLEAR_SCRIPT, [{"ref": ref}], self._rt.default_timeout_ms, world=ENGINE_WORLD
            )
            if not cleared.get("found"):
                raise self._stale_ref_error("fill", selector, ref)

        if mode == "insert":
            await self._rt.insert_text(target_id, value)
        else:
            await self._rt.type_chars(target_id, value, opts.get("delay_ms", 0))

        actual: Optional[str] = None
        verified: Optional[bool] = None
        if opts.get("verify", True) is not False:
            read = await self._rt.evaluate_function(
                target_id, READ_SCRIPT, [{"ref": ref, "what": "value"}], self._rt.default_timeout_ms, world=ENGINE_WORLD
            )
            if not read.get("found"):
                raise self._stale_ref_error("fill", selector, ref)
            actual = read.get("value")
            verified = actual == value

            # Backed off, not a tight poll: `fill` types real per-character
            # key events through a fire-and-forget send path, so the last
            # character can still be in flight to Chrome when this method
            # would otherwise read the field. See engine.ts's own long
            # comment on `VERIFY_BACKOFF_MS` for the measured miss this
            # avoids and the rate-limit trap a tighter poll fell into.
            verify_backoff_ms = [25, 50, 100, 200, 400, 800]
            verify_deadline = time.time() * 1000 + 2000
            poll = 0
            while not verified and poll < len(verify_backoff_ms) and time.time() * 1000 < verify_deadline:
                await self._rt.sleep(verify_backoff_ms[poll])
                poll += 1
                try:
                    nxt = await self._rt.evaluate_function(
                        target_id, READ_SCRIPT, [{"ref": ref, "what": "value"}], self._rt.default_timeout_ms, world=ENGINE_WORLD
                    )
                except Exception:
                    break
                if not nxt or not nxt.get("found"):
                    break
                actual = nxt.get("value")
                verified = actual == value

            # ``strict=True`` turns a mismatch into an exception. Off by
            # default because a masked field legitimately rewrites what was
            # typed, which leaves a dropped character visible only in
            # ``verified``. The values stay out of the error, since this is
            # the path a password takes.
            if verified is False and opts.get("strict", False) is True:
                got = actual or ""
                first = 0
                while first < len(got) and first < len(value) and got[first] == value[first]:
                    first += 1
                raise AutomationError(
                    "TIMEOUT",
                    f"fill('{selector}', strict): the field holds {len(got)} character(s) after typing, expected "
                    f"{len(value)}, first difference at index {first}. The keys were delivered; the page did not "
                    "end up with the value.",
                    {
                        "selector": selector, "index": chosen.index, "delivered": True, "verified": False,
                        "expectedLength": len(value), "actualLength": len(got), "firstMismatchAt": first,
                    },
                )

        return FillResult(
            ok=True, ref=ref, match_count=result.total, index=chosen.index, mode=mode,
            actual=actual, verified=verified, elapsed_ms=time.time() * 1000 - started,
        )

    # ------------------------------------------------------------------
    # select
    # ------------------------------------------------------------------

    async def select(
        self,
        target_id: str,
        selector: str,
        options: Union[Any, Sequence[Any]],
        opts: Optional[Mapping[str, Any]] = None,
    ) -> SelectResult:
        opts = opts or {}
        parse_selector(selector)
        wanted = [_normalize_select_option(o) for o in (options if isinstance(options, (list, tuple)) else [options])]
        if not wanted:
            raise AutomationError("INVALID_ARGUMENT", f"select('{selector}') needs at least one option to select", {"selector": selector})
        started = time.time() * 1000
        deadline = started + opts.get("timeout_ms", DEFAULT_ACT_TIMEOUT_MS)

        result = await self.wait_for(
            target_id,
            selector,
            {
                "state": "actionable",
                "timeout_ms": max(0.0, deadline - time.time() * 1000),
                "scroll": opts.get("scroll", True) is not False,
                "scroll_index": opts.get("index", 0),
                "stamp": True,
                **({"index": opts["index"], "limit": max(50, opts["index"] + 1)} if "index" in opts and opts["index"] is not None else {}),
            },
        )
        chosen = self._require_actionable("select", selector, result, opts.get("index"), time.time() * 1000 - started)
        self._require_select_element(selector, result, chosen)

        await self._rt.prepare_dispatch(target_id)
        if time.time() * 1000 - result.resolved_at_ms > STALE_RESOLVE_WINDOW_MS:
            result = await self.resolve(
                target_id, selector, {"scroll": opts.get("scroll", True) is not False, "scroll_index": opts.get("index", 0), "stamp": True}
            )
            chosen = self._require_actionable("select", selector, result, opts.get("index"), time.time() * 1000 - started)
            self._require_select_element(selector, result, chosen)
        ref = chosen.ref
        assert ref is not None

        wire = await self._rt.evaluate_function(
            target_id, SELECT_SCRIPT, [{"ref": ref, "options": wanted}], self._rt.default_timeout_ms, world=ENGINE_WORLD
        )
        if not wire.get("found"):
            raise self._stale_ref_error("select", selector, ref)
        if wire.get("notMultiple") is True:
            raise AutomationError(
                "INVALID_ARGUMENT",
                f"select('{selector}'): {len(wanted)} options were asked for but the <select> at index "
                f"{chosen.index} has no 'multiple' attribute, so it can hold only one selection.",
                {"selector": selector, "index": chosen.index, "requested": len(wanted)},
            )
        missing = wire.get("missing") or []
        if missing:
            raise self._option_not_found_error(selector, chosen, missing, wire.get("available") or [])

        return SelectResult(
            ok=True, ref=ref, match_count=result.total, index=chosen.index,
            values=list(wire.get("values") or []), labels=list(wire.get("labels") or []),
            elapsed_ms=time.time() * 1000 - started,
        )

    def _require_select_element(self, selector: str, result: ResolveResult, chosen: LocatorMatch) -> None:
        if chosen.tag_name != "select":
            raise AutomationError(
                "INVALID_ARGUMENT",
                f"select('{selector}'): <{chosen.tag_name}> is not a <select>. Matched {result.total} element(s); "
                f"acted on index {chosen.index} ({chosen.describe or chosen.tag_name}).",
                {"selector": selector, "index": chosen.index, "tagName": chosen.tag_name, "describe": chosen.describe, "matchCount": result.total},
            )
        if chosen.ref is None:
            raise AutomationError(
                "INVALID_ARGUMENT",
                "select() addresses the element by stamp between its resolve and its mutation, so it cannot run with stamp=False.",
                {"selector": selector},
            )

    def _option_not_found_error(
        self, selector: str, chosen: LocatorMatch, missing: Sequence[Mapping[str, Any]], available: Sequence[Mapping[str, Any]]
    ) -> AutomationError:
        def describe_spec(m: Mapping[str, Any]) -> str:
            if "value" in m:
                return f"value '{m['value']}'"
            if "label" in m:
                return f"label '{m['label']}'"
            return f"index {m.get('index')}"

        shown = list(available)[:20]
        options_desc = ", ".join(f"'{o['value']}'" + (f" ({o['label']})" if o.get("label") and o["label"] != o["value"] else "") for o in shown)
        suffix = f", ... {len(available) - len(shown)} more" if len(available) > len(shown) else ""
        return AutomationError(
            "NOT_FOUND",
            f"select('{selector}'): no option matched {', '.join(describe_spec(m) for m in missing)} on the "
            f"<select> at index {chosen.index}. Available: {options_desc or '(none)'}{suffix}.",
            {"selector": selector, "index": chosen.index, "missing": list(missing), "available": list(available)},
        )

    # ------------------------------------------------------------------
    # The read verbs. One round trip each: the read rides on the resolver.
    # ------------------------------------------------------------------

    async def inner_text(self, target_id: str, selector: str, opts: Optional[Mapping[str, Any]] = None) -> str:
        opts = opts or {}
        read: dict[str, Any] = {"what": "innerText"}
        if "limit" in opts:
            read["limit"] = opts["limit"]
        v = await self._read_one(target_id, "innerText", selector, read, opts)
        return v if isinstance(v, str) else ""

    async def get_attribute(self, target_id: str, selector: str, name: str, opts: Optional[Mapping[str, Any]] = None) -> Optional[str]:
        opts = opts or {}
        if not isinstance(name, str) or name == "":
            raise AutomationError("INVALID_ARGUMENT", "get_attribute() needs an attribute name")
        v = await self._read_one(target_id, "getAttribute", selector, {"what": "attribute", "name": name}, opts)
        return v if isinstance(v, str) else None

    async def is_checked(self, target_id: str, selector: str, opts: Optional[Mapping[str, Any]] = None) -> bool:
        opts = opts or {}
        v = await self._read_one(target_id, "isChecked", selector, {"what": "checked"}, opts)
        return v is True

    async def _read_one(
        self, target_id: str, verb: str, selector: str, read: Mapping[str, Any], opts: Mapping[str, Any]
    ) -> Union[str, bool, None]:
        index = opts.get("index", 0)
        resolve_opts: dict[str, Any] = {
            "limit": max(1, index + 1), "stamp": False, "stable": False, "hit_test": False, "read": read,
        }
        if "timeout_ms" in opts:
            resolve_opts["timeout_ms"] = opts["timeout_ms"]
        result = await self.resolve(target_id, selector, resolve_opts)
        if index < 0 or index >= len(result.matches):
            what = "nothing matched" if result.total == 0 else f"only {result.total} element(s) matched, so there is no index {index}"
            raise AutomationError(
                "NOT_FOUND",
                f"{verb}('{selector}'): {what}. The page is at {result.url}.",
                {"verb": verb, "selector": selector, "index": index, "matchCount": result.total, "engine": result.engine, "url": result.url},
            )
        return result.matches[index].read_value

    # ------------------------------------------------------------------
    # scroll_into_view
    # ------------------------------------------------------------------

    async def scroll_into_view(self, target_id: str, selector: str, opts: Optional[Mapping[str, Any]] = None) -> LocatorMatch:
        opts = opts or {}
        index = opts.get("index", 0)
        resolve_opts: dict[str, Any] = {"limit": max(1, index + 1), "scroll": True, "scroll_index": index}
        if "timeout_ms" in opts:
            resolve_opts["timeout_ms"] = opts["timeout_ms"]
        result = await self.resolve(target_id, selector, resolve_opts)
        if index < 0 or index >= len(result.matches):
            raise actionability_error("scrollIntoView", selector, result, self._best(result, opts.get("index")), 0)
        return result.matches[index]
