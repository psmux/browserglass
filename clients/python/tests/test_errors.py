from __future__ import annotations

from browserglass.errors import AutomationError, RestError


def test_known_wire_code_maps_to_taxonomy():
    err = AutomationError.from_error_msg(
        {"t": "error", "code": "bgls.error.control.not_held", "category": "control", "message": "no lease"}
    )
    assert err.code == "LEASE_NOT_HELD"
    assert err.message == "no lease"
    assert err.details["wire_code"] == "bgls.error.control.not_held"


def test_unmapped_wire_code_falls_through_to_protocol_error():
    err = AutomationError.from_error_msg({"t": "error", "code": "bgls.error.totally_new_thing", "message": "?"})
    assert err.code == "PROTOCOL_ERROR"


def test_context_carried_when_present():
    err = AutomationError.from_error_msg(
        {"t": "error", "code": "bgls.error.limit.rate", "message": "slow down", "context": {"limit": 100}}
    )
    assert err.details["context"] == {"limit": 100}


def test_not_implemented_names_method_and_needs():
    err = AutomationError.not_implemented("elements", "element handles")
    assert err.code == "NOT_IMPLEMENTED"
    assert "elements()" in err.message
    assert "element handles" in err.message
    assert err.details["method"] == "elements"


def test_automation_error_is_a_real_exception():
    try:
        raise AutomationError("TIMEOUT", "took too long")
    except AutomationError as err:
        assert err.code == "TIMEOUT"
        assert str(err) == "took too long"


def test_rest_error_carries_rest_fields():
    err = RestError(429, "E_RATE_LIMITED", "slow down", retryable=True, retry_after_ms=500, request_id="req_1")
    assert err.http_status == 429
    assert err.retryable is True
    assert err.retry_after_ms == 500
    assert err.request_id == "req_1"
