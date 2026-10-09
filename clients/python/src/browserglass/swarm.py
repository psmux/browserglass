"""``BrowserSwarm``: N browsers, opened, driven, and torn down through one
documented entry point, rather than a caller hand rolling
``asyncio.gather()`` over several ``RestClient.acquire()`` plus
``AutomationClient.connect()`` calls.

Mirrors ``packages/automation/src/swarm.ts``. The framing does not change
for a swarm: every member is an ordinary :class:`~browserglass.client.AutomationClient`,
i.e. an ordinary Viewer on its own ``bgls.v1`` socket. A swarm is ``size``
of those, opened together and addressed together; there is no separate
multi-browser wire path underneath it, and no method here does anything a
caller could not already do by calling ``AutomationClient.connect()``
``size`` times itself. What this class buys is doing that concurrently,
correctly, and with one place to close it all again.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, List, Mapping, Optional, Sequence, Set, TypeVar

from .client import AutomationClient
from .errors import AutomationError
from .transport import SocketFactory
from .types import ControlYieldEvent

T = TypeVar("T")


@dataclass(frozen=True)
class SwarmAcquireResult:
    """One Instance's connection coordinates, exactly what
    :meth:`~browserglass.client.AutomationClient.connect` needs for
    ``endpoint``/``token``/``instance_id``. ``acquire()`` mints these
    however the caller's own deployment does it (an embedded router, a
    remote gateway's own REST endpoint, a pool with its own admission
    policy); see :attr:`BrowserSwarm.open`'s ``acquire`` parameter.

    ``acquire()`` has no paired ``release()`` in this contract, which is a
    real boundary, not an oversight: :class:`BrowserSwarm` only ever
    closes what IT opened, the ``AutomationClient`` connections it
    created. It never reaches back into whatever ``acquire()`` reserved on
    the router/gateway side of ``instance_id``. If the caller's own
    admission layer needs an explicit release call (most do), that is the
    caller's own responsibility, keyed by ``instance_id`` and ``index``
    from every :class:`SwarmMember`, including in an ``except`` around
    ``open()``/``grow()``.
    """

    instance_id: str
    ws_url: str
    token: str


@dataclass(frozen=True)
class SwarmAcquireContext:
    """The second argument every ``acquire()`` call receives, carrying the
    ownership decision :attr:`BrowserSwarm.subject` expresses.

    The per-member derivation matters because the router's sticky reuse
    resolves one subject to at most ONE instance, the most recently active
    one that is still shareable. Hand the same subject to all 20 members
    of a swarm and the 20 concurrent acquires do not produce 20 reattached
    browsers; they converge, nondeterministically, onto whichever
    instances happen to be visible when each call runs its reuse check, so
    a swarm asked for 20 comes back holding 20 clients pointed at a
    handful of browsers. So one subject per MEMBER SLOT
    (``<swarm subject>#<index>``, see :func:`swarm_member_subject`) is the
    only derivation that makes "give me my 20 browsers back" mean what a
    caller reading it thinks it means.
    """

    subject: Optional[str]
    """This member slot's affinity subject, ``<swarm subject>#<index>``,
    or ``None`` when the swarm was opened without one (the default: every
    member launches a fresh browser). An ``acquire()`` that honours this
    must put it on BOTH the acquire request's ``subject`` (which tags the
    instance it creates, so a later call can find it) and its
    ``sticky.subject`` (which is what finds it). Setting only one of the
    two silently degrades to "always launch"."""

    sticky_within_ms: Optional[float]
    """Passed straight through from :meth:`BrowserSwarm.open`'s
    ``sticky_within_ms``: how stale a member's previous browser may be and
    still be reattached to. ``None`` means no window, i.e. any still-live
    instance for that subject qualifies."""


def swarm_member_subject(subject: Optional[str], index: int) -> Optional[str]:
    """This swarm's per-member-slot affinity subject, or ``None`` when the
    swarm was opened without one. A standalone function (rather than
    inlined at its one call site) because the value has to be reproducible
    from outside: a caller releasing what it acquired, or a second process
    deliberately targeting the same browser set, needs the exact same
    string this swarm would have produced for that slot."""
    return None if subject is None else f"{subject}#{index}"


@dataclass
class SwarmMember:
    """One member of a :class:`BrowserSwarm`. ``index`` is an identity
    assigned once at acquisition, not a live list position: it stays with
    a member across ``grow()``/``shrink()`` rather than being renumbered
    when the swarm's size changes."""

    index: int
    instance_id: str
    target_id: str
    subject: Optional[str]
    """The affinity subject this slot was acquired under, or ``None`` if
    the swarm has none. Reported so a caller can see, from the member
    itself, whether this browser is one it can expect back next time."""
    client: AutomationClient
    """The bound client for this member. ``swarm.all(lambda m, i: m.client.navigate(url))``
    driving every member at once is the entire reason ``SwarmMember``
    carries more than an id."""


@dataclass(frozen=True)
class SwarmYieldEvent:
    """One member of a swarm stood down. Delivered to
    :meth:`BrowserSwarm.on_control_yield`.

    The whole point of surfacing this at the swarm level is the "twenty
    browsers, a person looking over the shoulder of ONE of them" case.
    Each member is its own connection with its own lease, so the yield is
    already isolated: nineteen members keep driving, untouched. What a
    caller cannot easily work out for itself is WHICH one was taken,
    because a fan-out over every member reports failures by list position
    and says nothing about who did the taking. That is what ``member`` is
    here for.
    """

    member: SwarmMember
    notice: ControlYieldEvent


@dataclass(frozen=True)
class SwarmCallResult(Generic[T]):
    """One member's outcome from :meth:`BrowserSwarm.all`, the Python
    analogue of a JavaScript ``Promise.allSettled`` settlement record.
    ``ok`` true means ``value`` is the call's return; ``ok`` false means
    the call raised and ``error`` holds what it raised."""

    ok: bool
    value: Optional[T] = None
    error: Optional[BaseException] = None


AcquireFn = Callable[[int, SwarmAcquireContext], Awaitable[SwarmAcquireResult]]


async def _close_members(members: Sequence[SwarmMember]) -> None:
    """Closes every member's client. Best effort, concurrently: one
    member's socket already being dead must not stop its siblings from
    closing, and one member's close taking a while must not hold up the
    others."""

    async def _one(m: SwarmMember) -> None:
        try:
            await m.client.close()
        except Exception:
            pass

    if members:
        await asyncio.gather(*(_one(m) for m in members))


class BrowserSwarm:
    """N browsers, opened, driven, and torn down through one entry point,
    rather than a caller reverse engineering how to acquire N instances
    and connect N clients by hand.

    Use :meth:`BrowserSwarm.open` to create one; the plain constructor is
    an implementation detail. Supports the async context manager protocol,
    so browsers do not outlive the block that opened them::

        async def acquire(index, ctx):
            result = await rest.acquire(subject=ctx.subject)
            return SwarmAcquireResult(
                instance_id=result.instance_id,
                ws_url=result.attach.ws_url,
                token=result.attach.ticket,
            )

        async with await BrowserSwarm.open(size=10, acquire=acquire) as swarm:
            results = await swarm.all(lambda m, i: m.client.navigate("https://example.com"))

    Or, against a running ``bgls serve``, with no ``acquire`` at all::

        async with await BrowserSwarm.open(size=10, launch={"headless": True}) as swarm:
            ...
    """

    def __init__(
        self,
        *,
        size: int,
        acquire: Optional[AcquireFn] = None,
        launch: Optional[Mapping[str, Any]] = None,
        url: Optional[str] = None,
        isolation: Optional[str] = None,
        subject: Optional[str] = None,
        sticky_within_ms: Optional[float] = None,
        socket_factory: Optional[SocketFactory] = None,
    ) -> None:
        self._acquire = acquire
        self._launch = dict(launch) if launch is not None else None
        self._url = url
        self.isolation = isolation
        """See ``open()``'s own ``isolation`` parameter: recorded, not
        enforced."""
        self.subject = subject
        """See ``open()``'s own ``subject`` parameter. ``None`` means this
        swarm launches fresh browsers and reattaches to nothing."""
        self._sticky_within_ms = sticky_within_ms
        self._socket_factory = socket_factory

        self._members: List[SwarmMember] = []
        # The next index `_acquire_members()` hands out in the
        # subject-less case; monotonic across the swarm's lifetime so a
        # member's `index` stays a stable identity through
        # `grow()`/`shrink()` rather than becoming a renumbered list
        # position.
        self._next_index = 0
        # Every index currently spoken for: live members, plus the ones an
        # in-flight `_acquire_members()` has reserved but not yet opened.
        self._claimed: Set[int] = set()
        self._yield_cbs: Set[Callable[[SwarmYieldEvent], None]] = set()

    @classmethod
    async def open(
        cls,
        *,
        size: int,
        acquire: Optional[AcquireFn] = None,
        launch: Optional[Mapping[str, Any]] = None,
        url: Optional[str] = None,
        isolation: Optional[str] = None,
        subject: Optional[str] = None,
        sticky_within_ms: Optional[float] = None,
        socket_factory: Optional[SocketFactory] = None,
    ) -> "BrowserSwarm":
        """Opens ``size`` members concurrently (``asyncio.gather``, not a
        loop awaiting one before starting the next): opening N browsers
        one at a time defeats the entire point of a swarm before a caller
        even gets to drive one. If any member fails to open, whichever
        siblings DID succeed are closed again before this raises: a
        partially failed ``open()`` must not leak connections the caller
        never received a handle to.

        ``url``, if given, is navigated on every member before the caller
        ever sees it: ``open()`` acquires a lease, navigates, and releases
        the lease again, so no member is left holding control it never
        asked to keep. Omit it to bind a member to whatever page its
        Instance already has open, and navigate it yourself inside
        :meth:`all`.

        ``subject``, if given, is who this swarm's browsers belong to:
        every member slot asks for the browser that slot had last time,
        and launches only if there is none. Omitted (the default), every
        member launches a brand new browser and abandons it at
        :meth:`close`, which is the right default for a batch job. Pick a
        value that names the OWNER, not the run: ``'nightly-crawler'``,
        ``'tenant-42'``, ``'alice@example.com'``.

        ``acquire`` is called once per member, concurrently: mint a fresh
        idempotency key per call (from ``index``, or omit one entirely) or
        every member collapses onto the same instance inside the router's
        idempotency window.

        ``launch`` is the no plumbing alternative to ``acquire``: a dict of
        :meth:`AutomationClient.launch` keyword arguments (``gateway``,
        ``admin_token``, ``headless``, ``viewport``, ``caps``, ...), used
        once per member, each with its own fresh ``requestId``. Pass one of
        ``acquire`` or ``launch``, not both. The swarm then owns those
        browsers: :meth:`close` and :meth:`shrink` end them, and a
        partially failed ``open()`` or ``grow()`` ends the ones that did
        start. The exception is a swarm with a ``subject``: there the point
        is getting the same browsers back next run, so close and shrink
        only close the sockets and leave the browsers running.
        """
        if (acquire is None) == (launch is None):
            raise AutomationError("INVALID_ARGUMENT", "BrowserSwarm.open(): pass exactly one of `acquire` or `launch`")
        if not isinstance(size, int) or size < 1:
            raise AutomationError("INVALID_ARGUMENT", f"BrowserSwarm.open(): size must be a positive integer, got {size}")
        swarm = cls(
            size=size,
            acquire=acquire,
            launch=launch,
            url=url,
            isolation=isolation,
            subject=subject,
            sticky_within_ms=sticky_within_ms,
            socket_factory=socket_factory,
        )
        swarm._members = await swarm._acquire_members(size)
        return swarm

    @property
    def members(self) -> Sequence[SwarmMember]:
        """Every currently open member, in the order ``open()``/``grow()``
        produced them."""
        return list(self._members)

    def on_control_yield(self, cb: Callable[[SwarmYieldEvent], None]) -> Callable[[], None]:
        """Fires when any member of this swarm stands down, with the
        member attached. Registered once, it covers members ``grow()``
        opens later too. Returns its own unsubscribe.

        A yield on one member disturbs no other member: every member is a
        separate ``AutomationClient`` on a separate socket holding a
        separate lease, and this callback is a notification, not a
        coordination point. Nothing in this class stops, pauses, or
        re-plans the siblings, and that is deliberate.
        """
        self._yield_cbs.add(cb)
        return lambda: self._yield_cbs.discard(cb)

    def yielded(self) -> List[SwarmYieldEvent]:
        """Every member currently stood down, with the notice that put it
        there. The pull-based counterpart to :meth:`on_control_yield`.
        Empty when nobody has taken anything."""
        out: List[SwarmYieldEvent] = []
        for member in self._members:
            notice = member.client.yield_status(member.target_id)
            if notice is not None:
                out.append(SwarmYieldEvent(member=member, notice=notice))
        return out

    def _emit_yield(self, ev: SwarmYieldEvent) -> None:
        for cb in list(self._yield_cbs):
            try:
                cb(ev)
            except Exception:
                # a caller's own handler raising must not break the member
                # that is standing down, nor any sibling
                pass

    async def all(self, fn: Callable[[SwarmMember, int], Awaitable[T]]) -> List[SwarmCallResult[T]]:
        """Runs ``fn`` against every member CONCURRENTLY
        (``asyncio.gather(..., return_exceptions=True)``, never a bare
        ``asyncio.gather`` and never a ``for`` loop with an ``await``
        inside it) and returns one :class:`SwarmCallResult` per member, in
        member order. A swarm's whole point is driving unrelated browsers
        at once, so one member's page raising, timing out, or losing its
        lease must not cancel the call for every sibling still running.

        A caller that wants the raw values back rather than settlement
        records can unwrap the result itself:
        ``[r.value for r in await swarm.all(fn) if r.ok]``.
        """
        settled = await asyncio.gather(
            *(fn(member, index) for index, member in enumerate(self._members)),
            return_exceptions=True,
        )
        return [
            SwarmCallResult(ok=False, error=r) if isinstance(r, BaseException) else SwarmCallResult(ok=True, value=r)
            for r in settled
        ]

    async def grow(self, n: int) -> Sequence[SwarmMember]:
        """Opens ``n`` more members, appended after the current ones, and
        returns just the new ones. Same concurrency and same
        partial-failure cleanup as :meth:`open`."""
        if not isinstance(n, int) or n < 1:
            raise AutomationError("INVALID_ARGUMENT", f"BrowserSwarm.grow(): n must be a positive integer, got {n}")
        added = await self._acquire_members(n)
        self._members = [*self._members, *added]
        return added

    async def shrink(self, n: int) -> None:
        """Closes the ``n`` most recently added members (LIFO, the mirror
        of ``grow()`` appending) and drops them from :attr:`members`.
        Raises ``INVALID_ARGUMENT`` rather than silently clamping: asking
        to shrink by more than the swarm currently holds is a bug at the
        call site, not a size this method should quietly round down to."""
        if not isinstance(n, int) or n < 1:
            raise AutomationError("INVALID_ARGUMENT", f"BrowserSwarm.shrink(): n must be a positive integer, got {n}")
        if n > len(self._members):
            raise AutomationError(
                "INVALID_ARGUMENT",
                f"BrowserSwarm.shrink(): cannot shrink by {n}, the swarm only holds {len(self._members)} member(s)",
            )
        removed = self._members[len(self._members) - n :]
        self._members = self._members[: len(self._members) - n]
        for m in removed:
            self._claimed.discard(m.index)
        await self._dispose(removed)

    async def close(self) -> None:
        """Closes every member and releases everything ``open()``/``grow()``
        opened, i.e. every ``AutomationClient`` connection this
        ``BrowserSwarm`` itself created. It does not, and cannot, release
        whatever ``acquire()`` reserved on the router/gateway side (see
        :class:`SwarmAcquireResult`'s own doc): call your own release for
        every ``member.instance_id`` first, or after, per your own
        admission layer's contract. Idempotent: a second call closes an
        already empty member list."""
        members = self._members
        self._members = []
        self._claimed.clear()
        await self._dispose(members)

    async def __aenter__(self) -> "BrowserSwarm":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @property
    def _owns_browsers(self) -> bool:
        """Whether this swarm started its members' browsers and so must end
        them: ``launch`` mode without a subject."""
        return self._launch is not None and self.subject is None

    async def _dispose(self, members: Sequence[SwarmMember]) -> None:
        """Closes ``members``, and ends their browsers when this swarm owns
        them. Every member is tried even if one fails; a failed browser
        release is then raised, because a browser left running is a leak
        the caller needs to hear about."""
        if not self._owns_browsers:
            await _close_members(members)
            return
        settled = await asyncio.gather(*(m.client.release() for m in members), return_exceptions=True)
        failed = [(m, r) for m, r in zip(members, settled) if isinstance(r, BaseException)]
        if failed:
            first_member, first_err = failed[0]
            raise AutomationError(
                "GATEWAY_ERROR",
                f"BrowserSwarm: {len(failed)}/{len(members)} browser(s) could not be ended; "
                f"first failure (instance {first_member.instance_id}): {first_err}",
                {"instance_ids": [m.instance_id for m, _ in failed]},
            )

    async def _connect_member(self, index: int, subject: Optional[str]) -> "tuple[AutomationClient, str]":
        if self._launch is not None:
            kwargs = dict(self._launch)
            if subject is not None:
                kwargs["subject"] = subject
            if self._sticky_within_ms is not None:
                kwargs["sticky_within_ms"] = self._sticky_within_ms
            if self._socket_factory is not None and "socket_factory" not in kwargs:
                kwargs["socket_factory"] = self._socket_factory
            client = await AutomationClient.launch(**kwargs)
            return client, client.instance_id or ""
        if self._acquire is None:
            raise AutomationError("INVALID_ARGUMENT", "BrowserSwarm: no `acquire` or `launch` given")
        acquired = await self._acquire(index, SwarmAcquireContext(subject=subject, sticky_within_ms=self._sticky_within_ms))
        client = await AutomationClient.connect(
            endpoint=acquired.ws_url,
            token=acquired.token,
            instance_id=acquired.instance_id,
            socket_factory=self._socket_factory,
        )
        return client, acquired.instance_id

    def _reserve_indexes(self, n: int) -> List[int]:
        """Reserves ``n`` member indexes, synchronously, before this
        swarm's first ``await`` in :meth:`_acquire_members`, so two
        overlapping calls (``grow()`` invoked again before an earlier one
        has resolved) can never claim the same index range: a coroutine
        runs its synchronous prefix to completion before yielding control
        at the first real ``await``, so the reservation itself is atomic
        without a lock.

        Two strategies, and the split is deliberate. Without a subject an
        index is pure bookkeeping, so it stays monotonic: ``grow()`` after
        ``shrink()`` numbers the new members after every index this swarm
        has ever used. WITH a subject an index is not bookkeeping any
        more: it selects which browser this member gets, through
        ``<subject>#<index>``. Monotonic numbering there would mean
        ``shrink(1)`` then ``grow(1)`` abandons slot 4's still-running
        browser and launches a fresh one for slot 5, i.e. the exact "why
        do I keep getting new browsers" failure this option exists to
        remove. So the subject case refills the lowest free slot first.
        Existing members are never renumbered either way; only which index
        a NEW member receives differs.
        """
        reserved: List[int] = []
        if self.subject is None:
            for offset in range(n):
                reserved.append(self._next_index + offset)
            self._next_index += n
        else:
            candidate = 0
            while len(reserved) < n:
                if candidate not in self._claimed:
                    reserved.append(candidate)
                candidate += 1
            highest = reserved[-1] if reserved else -1
            self._next_index = max(self._next_index, highest + 1)
        for index in reserved:
            self._claimed.add(index)
        return reserved

    async def _acquire_members(self, n: int) -> List[SwarmMember]:
        """Acquires and connects ``n`` new members on freshly reserved
        indexes, concurrently; see :meth:`open`'s own doc for the
        partial-failure cleanup."""
        indexes = self._reserve_indexes(n)
        settled = await asyncio.gather(
            *(self._open_one_member(index) for index in indexes), return_exceptions=True
        )

        opened: List[SwarmMember] = []
        failures: List[BaseException] = []
        for offset, result in enumerate(settled):
            if isinstance(result, BaseException):
                failures.append(result)
                # A member that never opened is holding a slot nothing can
                # reach. Release the reservation so the next `grow()` can
                # retry that same slot, which under a subject is the same
                # browser, rather than stepping over it for good.
                self._claimed.discard(indexes[offset])
            else:
                opened.append(result)

        if not failures:
            return opened

        for m in opened:
            self._claimed.discard(m.index)
        try:
            await self._dispose(opened)
        except Exception:
            pass
        first = failures[0]
        wrapped = first if isinstance(first, AutomationError) else AutomationError("PROTOCOL_ERROR", str(first))
        raise AutomationError(
            wrapped.code,
            f"BrowserSwarm: {len(failures)}/{n} member(s) failed to open; first failure: {wrapped.message}",
            {
                "failedCount": len(failures),
                "requested": n,
                "firstError": {"code": wrapped.code, "message": wrapped.message},
            },
        )

    async def _open_one_member(self, index: int) -> SwarmMember:
        """A connect that then fails its own post-connect setup (the
        ``url`` navigate below) must not leak the socket it just opened:
        that client is not yet in ``opened`` for ``_acquire_members()``'s
        own partial-failure cleanup to find (this call has not returned
        yet), so closing it is this method's own responsibility before the
        error propagates."""
        subject = swarm_member_subject(self.subject, index)
        client, instance_id = await self._connect_member(index, subject)
        try:
            if self._url is not None and client.holds_control:
                # A launched member already holds the lease (launch's
                # `control` defaults to True), and it keeps it: that is
                # what the caller asked launch() for.
                await client.navigate(self._url)
            elif self._url is not None:
                # Acquire, navigate, release: exactly what a caller would
                # do by hand, so a member fresh out of `open()` is not left
                # holding control it never asked to keep.
                lease = await client.acquire_control()
                try:
                    await client.navigate(self._url)
                finally:
                    await lease.release()
            member = SwarmMember(index=index, instance_id=instance_id, target_id=client.target_id, subject=subject, client=client)
            # Wired unconditionally at open time, not when the first
            # `on_control_yield()` subscriber appears. A takeover can land
            # in the gap between `open()` resolving and a caller getting
            # round to subscribing, and a swarm that silently missed the
            # first yield because of registration order would be a nasty
            # thing to debug.
            client.on_control_yield(lambda notice: self._emit_yield(SwarmYieldEvent(member=member, notice=notice)))
            return member
        except Exception:
            if self._owns_browsers:
                try:
                    await client.release()
                except Exception:
                    pass
            else:
                await client.close()
            raise
