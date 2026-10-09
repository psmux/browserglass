"""The automation error taxonomy.

Mirrors ``packages/automation/src/errors.ts`` in the TypeScript SDK: one
exception type, ``AutomationError``, carrying a closed set of string codes
(``AutomationErrorCode``) rather than a different Python exception class per
failure. A caller branches on ``err.code``, the same way a TypeScript caller
branches on ``err.code``.

Three codes are not in the wire taxonomy doc and exist only in this SDK
layer, matching the TypeScript build's own extension: ``NOT_IMPLEMENTED``
(a stubbed method names what it needs), ``PROTOCOL_ERROR`` (the fallback
for a wire ``bgls.error.*`` code with no closer match here), and
``INVALID_ARGUMENT`` (a value that is wrong on its face, before the server
ever gets a chance to refuse it).
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

AutomationErrorCode = str
"""One of the string literals documented on :class:`AutomationError`.

Kept as a plain ``str`` alias rather than a ``Literal``/``Enum`` so a
gateway that adds a wire error code this SDK does not yet know about still
produces a value a caller can compare and log, instead of raising at the
boundary. The known codes are listed in :data:`KNOWN_CODES` for anyone who
wants to validate against them.
"""

KNOWN_CODES = frozenset(
    {
        "NOT_FOUND",
        "AMBIGUOUS",
        "NOT_VISIBLE",
        "OCCLUDED",
        "NOT_STABLE",
        "DISABLED",
        "DETACHED",
        "FRAME_DETACHED",
        "TARGET_CLOSED",
        "NAVIGATION_ABORTED",
        "TIMEOUT",
        "LEASE_NOT_HELD",
        "LEASE_REVOKED",
        "BUDGET_EXHAUSTED",
        "CONFIRM_DENIED",
        "POLICY_DENIED",
        "DRY_RUN",
        "INSTANCE_GONE",
        "NOT_IMPLEMENTED",
        "PROTOCOL_ERROR",
        "INVALID_ARGUMENT",
        # The two codes AutomationClient.launch() adds for its REST calls:
        # the admin token is missing, expired or refused, or the gateway
        # answered something else that was not a success.
        "UNAUTHENTICATED",
        "GATEWAY_ERROR",
    }
)

# Maps a wire `bgls.error.*` code to the closest AutomationErrorCode. Codes
# with no obvious equivalent fall through to PROTOCOL_ERROR, never to
# `None`: an unmapped wire error must still surface as something a caller
# can branch on. Kept in lockstep with the TypeScript build's own
# `WIRE_ERROR_MAP` in `packages/automation/src/errors.ts`.
_WIRE_ERROR_MAP: Mapping[str, str] = {
    "bgls.error.target.not_found": "TARGET_CLOSED",
    "bgls.error.target.limit": "POLICY_DENIED",
    "bgls.error.target.last_target": "POLICY_DENIED",
    "bgls.error.control.not_held": "LEASE_NOT_HELD",
    "bgls.error.control.lease_stale": "LEASE_REVOKED",
    "bgls.error.control.queue_full": "POLICY_DENIED",
    "bgls.error.control.shared_not_allowed": "POLICY_DENIED",
    "bgls.error.input.gen_stale": "NOT_STABLE",
    "bgls.error.input.malformed": "PROTOCOL_ERROR",
    "bgls.error.nav.blocked": "NAVIGATION_ABORTED",
    "bgls.error.nav.invalid_url": "NAVIGATION_ABORTED",
    "bgls.error.nav.no_history": "NAVIGATION_ABORTED",
    "bgls.error.capture.no_match": "NOT_FOUND",
    "bgls.error.capture.too_large": "POLICY_DENIED",
    "bgls.error.capture.failed": "PROTOCOL_ERROR",
    # Page evaluation. There is deliberately no entry for "the page threw":
    # a page-side exception is not a wire error, it arrives as
    # `page.evaluated` with `ok: false`, and the client's own evaluate path
    # turns it into a PROTOCOL_ERROR carrying the page's own message and
    # stack in `details["page_exception"]`. These four are the cases where
    # the evaluation never ran to completion.
    "bgls.error.evaluate.timeout": "TIMEOUT",
    "bgls.error.evaluate.result_too_large": "POLICY_DENIED",
    "bgls.error.evaluate.invalid_request": "INVALID_ARGUMENT",
    "bgls.error.evaluate.failed": "PROTOCOL_ERROR",
    # The response-body join. `unknown_request` is the scoping refusal (a
    # requestId this client was never actually shown, whether guessed or
    # stale), which reads as a policy refusal for the same reason
    # `cap.missing` does. `unavailable` is NOT_FOUND: CDP's own "no
    # resource with given identifier found" for a body Chrome no longer
    # has buffered, the closest existing taxonomy entry to "the thing you
    # asked for is not there any more" (`capture.no_match` uses the same
    # code for the same shape of absence). `too_large` mirrors
    # `evaluate.result_too_large`.
    "bgls.error.responsebody.invalid_request": "INVALID_ARGUMENT",
    "bgls.error.responsebody.unknown_request": "POLICY_DENIED",
    "bgls.error.responsebody.unavailable": "NOT_FOUND",
    "bgls.error.responsebody.too_large": "POLICY_DENIED",
    "bgls.error.responsebody.timeout": "TIMEOUT",
    "bgls.error.responsebody.failed": "PROTOCOL_ERROR",
    "bgls.error.probe.no_element": "NOT_FOUND",
    "bgls.error.probe.detail_unavailable": "PROTOCOL_ERROR",
    "bgls.error.instance.not_found": "INSTANCE_GONE",
    "bgls.error.instance.unrecoverable": "INSTANCE_GONE",
    "bgls.error.instance.recovering": "PROTOCOL_ERROR",
    "bgls.error.instance.restart_busy": "POLICY_DENIED",
    "bgls.error.cap.missing": "POLICY_DENIED",
    "bgls.error.limit.rate": "POLICY_DENIED",
    "bgls.error.limit.size": "POLICY_DENIED",
    "bgls.error.limit.value": "PROTOCOL_ERROR",
}


class AutomationError(Exception):
    """Raised by every :class:`~browserglass.client.AutomationClient` method
    that can fail.

    Carries the taxonomy ``code`` (one of :data:`KNOWN_CODES`, though the
    field is typed as a plain string so an unrecognised wire code still
    reaches the caller rather than being swallowed), a human-readable
    ``message``, and an optional ``details`` dict. ``LEASE_REVOKED`` uses
    it for ``last_completed_step``/``partial``; ``NOT_IMPLEMENTED`` uses it
    to name what the stub needs; ``POLICY_DENIED`` uses it for
    ``retry_after_ms`` on the requeue-backoff refusal.
    """

    def __init__(
        self,
        code: AutomationErrorCode,
        message: str,
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details: Mapping[str, Any] = dict(details) if details is not None else {}

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"AutomationError(code={self.code!r}, message={self.message!r})"

    @staticmethod
    def from_error_msg(msg: Mapping[str, Any]) -> "AutomationError":
        """Wraps a server ``error`` envelope, mapping its wire ``code``
        through :data:`_WIRE_ERROR_MAP`."""
        wire_code = str(msg.get("code", ""))
        code = _WIRE_ERROR_MAP.get(wire_code, "PROTOCOL_ERROR")
        details: dict[str, Any] = {"wire_code": wire_code, "category": msg.get("category")}
        if "context" in msg and msg["context"] is not None:
            details["context"] = msg["context"]
        return AutomationError(code, str(msg.get("message", wire_code)), details)

    @staticmethod
    def not_implemented(method: str, needs: str) -> "AutomationError":
        """Convenience constructor for a stubbed method: names what it needs."""
        return AutomationError(
            "NOT_IMPLEMENTED",
            f"{method}() is not implemented in this build: it needs {needs}",
            {"method": method, "needs": needs},
        )


class RestError(Exception):
    """Raised by :class:`~browserglass.rest.RestClient` for a non-2xx REST
    response.

    A distinct exception type from :class:`AutomationError` on purpose:
    a REST failure carries an ``E_*`` code from
    ``packages/server/src/rest/errors.ts``'s ``RestErrorBody``, a
    completely different namespace from the wire's ``bgls.error.*``
    taxonomy, and conflating the two would let a caller's ``except
    AutomationError`` silently catch a REST admission failure it was never
    written to handle.
    """

    def __init__(
        self,
        http_status: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        retry_after_ms: Optional[int] = None,
        details: Optional[Mapping[str, Any]] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms
        self.details: Mapping[str, Any] = dict(details) if details is not None else {}
        self.request_id = request_id

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"RestError(http_status={self.http_status}, code={self.code!r}, message={self.message!r})"
