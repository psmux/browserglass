from __future__ import annotations

import asyncio
import time

import pytest

from browserglass.errors import AutomationError

from conftest import connect_client, control_granted_handler


@pytest.mark.asyncio
async def test_acquire_control_exclusive_by_default():
    client, socket = await connect_client({"control.request": control_granted_handler(mode="exclusive")})
    try:
        lease = await client.acquire_control()
        assert lease.mode == "exclusive"
        assert lease.lease_id == "lease_1"
        assert lease.is_valid
        req = socket.sent_json_messages()[-1]
        assert req["t"] == "control.request"
        assert req["targetId"] == "t1"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_acquire_control_shared_mode_is_reflected_on_the_handle():
    client, socket = await connect_client({"control.request": control_granted_handler(mode="shared")})
    try:
        lease = await client.acquire_control()
        assert lease.mode == "shared"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_release_control_sends_control_release():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        lease = await client.acquire_control()
        await lease.release()
        last = socket.sent_json_messages()[-1]
        assert last["t"] == "control.release"
        assert last["leaseId"] == "lease_1"
        assert not lease.is_valid
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_acquire_control_without_capability_fails_fast_locally():
    client, socket = await connect_client({"control.request": control_granted_handler()}, granted=["view"])
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.acquire_control()
        assert excinfo.value.code == "POLICY_DENIED"
        # No round trip was made: nothing beyond `hello` was sent.
        assert len(socket.sent_json_messages()) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_control_denied_raises_policy_denied():
    def deny(msg):
        return {"t": "control.denied", "targetId": msg["targetId"], "reason": "holder_pinned", "message": "someone else has it", "holderLabel": "Alice"}

    client, socket = await connect_client({"control.request": deny})
    try:
        with pytest.raises(AutomationError) as excinfo:
            await client.acquire_control()
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["holderLabel"] == "Alice"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_preemption_stands_the_client_down_and_refuses_further_input():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        lease = await client.acquire_control()

        events = []
        client.on_control_yield(lambda ev: events.append(ev))

        # Server side: a human asks for control back. `enterStandDown`
        # closes the dispatch gate synchronously; `completeStandDown`
        # (releaseOnYield defaults True) sends `control.release` back.
        await socket.push(
            {"t": "control.preempt.request", "targetId": "t1", "leaseId": "lease_1", "byViewerId": "v_human", "byLabel": "A Person", "reason": "human_takeover", "graceMs": 2000, "deadline": time.time() * 1000 + 2000}
        )
        # Let the event loop deliver the pushed message to the pump.
        await asyncio.sleep(0.05)

        assert len(events) == 1
        assert events[0].human is True
        assert events[0].by_label == "A Person"

        with pytest.raises(AutomationError) as excinfo:
            await client.click_at(1, 1)
        assert excinfo.value.code == "LEASE_REVOKED"

        release_msgs = [m for m in socket.sent_json_messages() if m["t"] == "control.release"]
        assert len(release_msgs) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_requeue_backoff_refuses_reacquire_until_it_elapses():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        await client.acquire_control()

        await socket.push(
            {
                "t": "control.preempted", "targetId": "t1", "leaseId": "lease_1", "byViewerId": "v_2", "byLabel": "Bob",
                "reason": "priority", "released": True, "lastDispatchedInputSeq": 0, "mayRequeue": True, "requeueAfterMs": 30000,
            }
        )
        await asyncio.sleep(0.05)

        with pytest.raises(AutomationError) as excinfo:
            await client.acquire_control()
        assert excinfo.value.code == "POLICY_DENIED"
        assert excinfo.value.details["retryAfterMs"] > 0
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_yield_control_is_voluntary_and_sets_no_backoff():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        await client.acquire_control()
        await client.yield_control(reason="done for now")
        assert client.yield_status() is not None
        assert client.yield_status().reason == "voluntary"
        assert "t1" not in client._core.requeue_blocked_until
    finally:
        await client.close()


def _control_state(holder_viewer_id, label=None):
    return {
        "t": "control.state",
        "leases": [
            {
                "targetId": "t1",
                "holderViewerId": holder_viewer_id,
                "holderLabel": label,
                "mode": "exclusive",
                "holders": [] if holder_viewer_id is None else [{"viewerId": holder_viewer_id, "label": label}],
                "queue": [],
            }
        ],
    }


@pytest.mark.asyncio
async def test_wait_for_resume_after_yield_ignores_a_broadcast_that_still_names_this_client():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        await client.acquire_control()
        await client.yield_control("need a person")
        waiting = asyncio.ensure_future(client.wait_for_resume())

        # The broadcast crossing the release still names the agent, the next
        # names nobody. Neither is a handover.
        await socket.push(_control_state("v_test", "agent"))
        await socket.push(_control_state(None))
        await asyncio.sleep(0.05)
        assert not waiting.done()

        # A person takes it, and is still working.
        await socket.push(_control_state("v_human", "Alice"))
        await asyncio.sleep(0.05)
        assert not waiting.done()

        # They let go.
        await socket.push(_control_state(None))
        await asyncio.wait_for(waiting, timeout=1)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_resume_after_yield_resolves_when_the_person_came_and_went_first():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        await client.acquire_control()
        await client.yield_control("need a person")
        await socket.push(_control_state("v_human", "Alice"))
        await socket.push(_control_state(None))
        await asyncio.sleep(0.05)
        await client.wait_for_resume(timeout_ms=1000)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_wait_for_resume_after_yield_times_out_when_nobody_takes_control():
    client, socket = await connect_client({"control.request": control_granted_handler()})
    try:
        await client.acquire_control()
        await client.yield_control("need a person")
        await socket.push(_control_state(None))
        with pytest.raises(AutomationError) as excinfo:
            await client.wait_for_resume(timeout_ms=200)
        assert excinfo.value.code == "TIMEOUT"
        assert "nobody else took control" in excinfo.value.message
    finally:
        await client.close()


def _uncorrelated_renew_handler(ttl_ms: float = 90000):
    """Answers ``control.renew`` the way the real gateway does: a fresh
    ``control.granted`` for the lease with no ``re`` on it."""

    def handler(msg):
        return {
            "t": "control.granted",
            "re": None,
            "targetId": msg["targetId"],
            "leaseId": msg["leaseId"],
            "expiresAt": time.time() * 1000 + ttl_ms,
            "renewWithinMs": 5000,
            "idleReleaseMs": 300000,
            "mode": "exclusive",
        }

    return handler


@pytest.mark.asyncio
async def test_renew_takes_the_new_expiry_from_an_uncorrelated_control_granted():
    client, socket = await connect_client(
        {
            "control.request": control_granted_handler(ttl_ms=30000),
            "control.renew": _uncorrelated_renew_handler(ttl_ms=90000),
        }
    )
    try:
        lease = await client.acquire_control(auto_renew=False)
        before = lease.expires_at
        await asyncio.wait_for(lease.renew(), timeout=2)
        assert lease.expires_at > before + 30000
        assert lease.is_valid
        assert socket.sent_json_messages()[-1]["t"] == "control.renew"
    finally:
        await client.close()
