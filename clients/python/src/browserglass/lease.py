"""``ControlLeaseHandle``: a held lease on one target.

Mirrors ``packages/automation/src/client/leaseHandle.ts``. Owned by
:class:`~browserglass.core.AutomationCore`, which calls the ``_*``
methods below as the matching wire messages arrive; nothing outside this
SDK constructs or mutates one directly.
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Callable, List, Optional, Set

from .types import LeaseMode, PreemptionRequest, RevokeReason

if TYPE_CHECKING:  # pragma: no cover
    from .core import AutomationCore

# Every automation-held lease carries this fixed priority (human 100, agent
# 50). `control.granted` carries no priority field of its own.
AUTOMATION_LEASE_PRIORITY = 50


class ControlLeaseHandle:
    """A held ``ControlLease``. ``priority`` is fixed at 50 for every
    automation holder; the wire's ``control.granted`` carries no priority
    field of its own.

    ``mode`` is ``'exclusive'`` (the default everywhere in this SDK) or
    ``'shared'``, echoing ``control.granted.mode``: a shared target has no
    queue and no preemption machine, and a person taking over on it is
    surfaced instead through :meth:`AutomationClient.on_control_yield`
    with ``reason == 'human_takeover'``. See ``LeaseMode`` in the wire
    protocol's own ``control.ts`` for the full contract.
    """

    def __init__(
        self,
        core: "AutomationCore",
        target_id: str,
        granted: dict,
        auto_renew: bool,
    ) -> None:
        self._core = core
        self.target_id = target_id
        self.lease_id: str = granted["leaseId"]
        self.granted_at: float = time.time() * 1000
        self.priority: int = AUTOMATION_LEASE_PRIORITY
        self.mode: LeaseMode = granted.get("mode", "exclusive")
        self._expires_at: float = granted["expiresAt"]
        self._renew_within_ms: float = granted["renewWithinMs"]

        self._preemption_cbs: Set[Callable[[PreemptionRequest], None]] = set()
        self._revoked_cbs: Set[Callable[[RevokeReason], None]] = set()
        self._revoked = False
        self._auto_renew_task: Optional[asyncio.Task[None]] = None
        self._auto_renew_wanted = auto_renew

        if auto_renew:
            self._schedule_auto_renew()

    @property
    def expires_at(self) -> float:
        return self._expires_at

    @property
    def is_valid(self) -> bool:
        """``False`` once revoked or past ``expires_at``."""
        return not self._revoked and time.time() * 1000 < self._expires_at

    def on_preemption_requested(self, cb: Callable[[PreemptionRequest], None]) -> Callable[[], None]:
        self._preemption_cbs.add(cb)
        return lambda: self._preemption_cbs.discard(cb)

    def on_revoked(self, cb: Callable[[RevokeReason], None]) -> Callable[[], None]:
        self._revoked_cbs.add(cb)
        return lambda: self._revoked_cbs.discard(cb)

    async def renew(self, ms: Optional[float] = None) -> None:
        if self._revoked:
            return
        payload = {"targetId": self.target_id, "leaseId": self.lease_id}
        if ms is not None:
            payload["ttlMs"] = ms
        reply = await self._core.request("control.renew", payload)
        self._expires_at = reply["expiresAt"]

    async def release(self) -> None:
        await self._release_now(None)

    async def _release_yielding(self, reason: RevokeReason) -> None:
        """Releases as part of a stand-down, firing ``on_revoked`` with
        ``reason`` on the way out. A plain :meth:`release` does not fire
        it: the caller asked and already knows. Yielding is the opposite
        case, and the notification must survive even though the well
        behaved client (the one that hands over promptly) has already
        deleted its own handle by the time ``control.preempted`` lands."""
        await self._release_now(reason)

    async def _release_now(self, revoke_reason: Optional[RevokeReason]) -> None:
        if self._revoked:
            return
        self._stop_auto_renew()
        try:
            await self._core.send("control.release", {"targetId": self.target_id, "leaseId": self.lease_id})
        except Exception:
            pass
        self._core.leases.pop(self.target_id, None)
        self._revoked = True
        if revoke_reason is not None:
            for cb in list(self._revoked_cbs):
                try:
                    cb(revoke_reason)
                except Exception:
                    pass

    def _fire_preemption_requested(self, req: PreemptionRequest) -> None:
        for cb in list(self._preemption_cbs):
            try:
                cb(req)
            except Exception:
                pass

    def _suspend_auto_renew(self) -> None:
        self._stop_auto_renew()

    def _resume_auto_renew(self) -> None:
        if not self._auto_renew_wanted or self._revoked:
            return
        self._schedule_auto_renew()

    def _mark_revoked(self, reason: RevokeReason) -> None:
        if self._revoked:
            return
        self._revoked = True
        self._stop_auto_renew()
        for cb in list(self._revoked_cbs):
            try:
                cb(reason)
            except Exception:
                pass

    def _schedule_auto_renew(self) -> None:
        self._stop_auto_renew()
        if self._revoked:
            return

        async def _loop() -> None:
            try:
                while True:
                    delay_ms = max(1000.0, self._expires_at - time.time() * 1000 - self._renew_within_ms)
                    await asyncio.sleep(delay_ms / 1000)
                    if self._revoked:
                        return
                    try:
                        await self.renew()
                    except Exception:
                        # A failed renew is surfaced through the normal
                        # control.revoked/preempted path, not raised out
                        # of a background task.
                        pass
            except asyncio.CancelledError:
                return

        self._auto_renew_task = asyncio.ensure_future(_loop())

    def _stop_auto_renew(self) -> None:
        if self._auto_renew_task is not None:
            self._auto_renew_task.cancel()
            self._auto_renew_task = None
