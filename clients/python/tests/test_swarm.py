"""``BrowserSwarm`` driven against several independent
:class:`fake_gateway.FakeGatewaySocket` doubles, one per member: each
member is its own ``bgls.v1`` connection, so proving the swarm needs
proving that N independent sockets really do get opened, addressed, and
torn down as a unit. Mirrors the shape of
``packages/automation/test`` would exercise for ``swarm.ts``, adapted to
this SDK's fake gateway rather than a mocked ``AutomationClient``.
"""

from __future__ import annotations

import asyncio

import pytest

from browserglass.errors import AutomationError
from browserglass.swarm import BrowserSwarm, SwarmAcquireResult, swarm_member_subject

from fake_gateway import FakeGatewaySocket, hello_then_welcome_handlers, make_welcome


def swarm_test_kit(fail_indexes=frozenset()):
    """One shared ``socket_factory`` plus an ``acquire()`` that mints a
    fresh, independent :class:`FakeGatewaySocket` per member index (its
    own ``instanceId`` and its own single target), keyed by a per-member
    ``ws_url`` the factory looks up by. Returns ``(acquire, socket_factory, sockets)``."""
    sockets: dict = {}
    base_instance = make_welcome("ignored")["instance"]

    async def socket_factory(url, subprotocols):
        return sockets[url]

    async def acquire(index, ctx):
        if index in fail_indexes:
            raise AutomationError("PROTOCOL_ERROR", f"member {index} refused to open")
        url = f"wss://fake.example/{index}"
        instance = {**base_instance, "instanceId": f"i_{index}"}
        targets = [
            {
                "targetId": f"t_{index}",
                "type": "page",
                "url": "about:blank",
                "title": "",
                "active": True,
                "loading": False,
                "canGoBack": False,
                "canGoForward": False,
            }
        ]
        sockets[url] = FakeGatewaySocket(hello_then_welcome_handlers(instance=instance, targets=targets))
        return SwarmAcquireResult(instance_id=f"i_{index}", ws_url=url, token="tok")

    return acquire, socket_factory, sockets


@pytest.mark.asyncio
async def test_open_opens_size_members_concurrently():
    acquire, socket_factory, sockets = swarm_test_kit()
    swarm = await BrowserSwarm.open(size=3, acquire=acquire, socket_factory=socket_factory)
    try:
        assert len(swarm.members) == 3
        assert [m.index for m in swarm.members] == [0, 1, 2]
        assert [m.instance_id for m in swarm.members] == ["i_0", "i_1", "i_2"]
        assert [m.target_id for m in swarm.members] == ["t_0", "t_1", "t_2"]
        assert all(m.subject is None for m in swarm.members)
    finally:
        await swarm.close()


@pytest.mark.asyncio
async def test_open_rejects_a_non_positive_size():
    acquire, socket_factory, _ = swarm_test_kit()
    with pytest.raises(AutomationError) as excinfo:
        await BrowserSwarm.open(size=0, acquire=acquire, socket_factory=socket_factory)
    assert excinfo.value.code == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_subject_derives_one_affinity_per_member_slot():
    seen_contexts = []

    async def acquire(index, ctx):
        seen_contexts.append((index, ctx.subject, ctx.sticky_within_ms))
        url = f"wss://fake.example/{index}"
        instance = {**make_welcome("ignored")["instance"], "instanceId": f"i_{index}"}
        targets = [{"targetId": f"t_{index}", "type": "page", "url": "about:blank", "title": "", "active": True, "loading": False, "canGoBack": False, "canGoForward": False}]
        sockets[url] = FakeGatewaySocket(hello_then_welcome_handlers(instance=instance, targets=targets))
        return SwarmAcquireResult(instance_id=f"i_{index}", ws_url=url, token="tok")

    sockets: dict = {}

    async def socket_factory(url, subprotocols):
        return sockets[url]

    swarm = await BrowserSwarm.open(size=2, acquire=acquire, subject="nightly-crawler", sticky_within_ms=60000, socket_factory=socket_factory)
    try:
        assert seen_contexts == [(0, "nightly-crawler#0", 60000), (1, "nightly-crawler#1", 60000)]
        assert [m.subject for m in swarm.members] == ["nightly-crawler#0", "nightly-crawler#1"]
    finally:
        await swarm.close()


def test_swarm_member_subject_helper():
    assert swarm_member_subject(None, 3) is None
    assert swarm_member_subject("tenant-42", 3) == "tenant-42#3"


@pytest.mark.asyncio
async def test_open_partial_failure_closes_survivors_and_raises():
    acquire, socket_factory, sockets = swarm_test_kit(fail_indexes={1})
    with pytest.raises(AutomationError) as excinfo:
        await BrowserSwarm.open(size=3, acquire=acquire, socket_factory=socket_factory)
    assert "1/3" in excinfo.value.message
    assert excinfo.value.details["failedCount"] == 1
    assert excinfo.value.details["requested"] == 3
    # Members 0 and 2 opened, then had to be torn down again; member 1
    # never got as far as creating a socket at all.
    assert sockets["wss://fake.example/0"].closed is True
    assert sockets["wss://fake.example/2"].closed is True
    assert "wss://fake.example/1" not in sockets


@pytest.mark.asyncio
async def test_grow_reuses_the_freed_slot_under_a_subject():
    acquire, socket_factory, sockets = swarm_test_kit()
    swarm = await BrowserSwarm.open(size=3, acquire=acquire, subject="s", socket_factory=socket_factory)
    try:
        assert [m.index for m in swarm.members] == [0, 1, 2]
        await swarm.shrink(1)  # drops index 2 (LIFO)
        assert [m.index for m in swarm.members] == [0, 1]
        added = await swarm.grow(1)
        # The freed slot (2) is reused, not a brand new index 3: the same
        # subject-derived slot means the same browser next time.
        assert [m.index for m in added] == [2]
        assert [m.index for m in swarm.members] == [0, 1, 2]
    finally:
        await swarm.close()


@pytest.mark.asyncio
async def test_grow_without_a_subject_numbers_monotonically():
    acquire, socket_factory, sockets = swarm_test_kit()
    swarm = await BrowserSwarm.open(size=2, acquire=acquire, socket_factory=socket_factory)
    try:
        await swarm.shrink(1)  # drops index 1
        added = await swarm.grow(1)
        # No subject: an index is pure bookkeeping and stays monotonic.
        assert [m.index for m in added] == [2]
    finally:
        await swarm.close()


@pytest.mark.asyncio
async def test_shrink_rejects_shrinking_by_more_than_the_swarm_holds():
    acquire, socket_factory, _ = swarm_test_kit()
    swarm = await BrowserSwarm.open(size=2, acquire=acquire, socket_factory=socket_factory)
    try:
        with pytest.raises(AutomationError) as excinfo:
            await swarm.shrink(5)
        assert excinfo.value.code == "INVALID_ARGUMENT"
    finally:
        await swarm.close()


@pytest.mark.asyncio
async def test_close_closes_every_member_and_is_idempotent():
    acquire, socket_factory, sockets = swarm_test_kit()
    swarm = await BrowserSwarm.open(size=2, acquire=acquire, socket_factory=socket_factory)
    await swarm.close()
    assert swarm.members == []
    assert sockets["wss://fake.example/0"].closed is True
    assert sockets["wss://fake.example/1"].closed is True
    await swarm.close()  # idempotent: closing an already-empty swarm is a no-op


@pytest.mark.asyncio
async def test_async_context_manager_closes_on_exit():
    acquire, socket_factory, sockets = swarm_test_kit()
    async with await BrowserSwarm.open(size=2, acquire=acquire, socket_factory=socket_factory) as swarm:
        assert len(swarm.members) == 2
    assert sockets["wss://fake.example/0"].closed is True
    assert sockets["wss://fake.example/1"].closed is True


@pytest.mark.asyncio
async def test_all_runs_concurrently_and_isolates_one_members_failure():
    acquire, socket_factory, sockets = swarm_test_kit()
    swarm = await BrowserSwarm.open(size=3, acquire=acquire, socket_factory=socket_factory)
    try:
        # Member 0 waits on a gate only member 2 ever sets. If `all()`
        # awaited each member one at a time (a `for` loop instead of a
        # real fan-out), member 0 would never see member 2 run and this
        # would time out instead of resolving almost instantly.
        gate = asyncio.Event()

        async def fn(member, index):
            if index == 0:
                await asyncio.wait_for(gate.wait(), timeout=2.0)
                return "ok-0"
            if index == 1:
                raise RuntimeError("boom")
            gate.set()
            return f"ok-{index}"

        results = await swarm.all(fn)

        assert results[0].ok is True
        assert results[0].value == "ok-0"
        assert results[1].ok is False
        assert isinstance(results[1].error, RuntimeError)
        assert results[2].ok is True
        assert results[2].value == "ok-2"
    finally:
        await swarm.close()
