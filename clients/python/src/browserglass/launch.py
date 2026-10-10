"""The REST half of :meth:`browserglass.AutomationClient.launch`: start a
browser on a running gateway, wait for it, get a socket ticket for it, and
end it again.

Mirrors ``packages/automation/src/launch.ts``. The flow:

1. ``POST /v1/instances`` with a fresh ``requestId``. The gateway dedupes a
   repeated id for five minutes and would hand back the same browser.
2. ``GET /v1/instances/:id`` until ``state`` is ``ready``. An acquire can
   answer ``launching`` or ``queued`` before Chrome is up.
3. ``POST /v1/instances/:id/attach`` with the caps we want. The ticket the
   acquire itself returns carries every cap the admin token holds (for a
   ``bgls token`` token that is the whole ``owner`` bundle, ``admin``
   included), so we ask for a narrowed one. The attach route only narrows:
   a cap the admin token lacks is dropped, never added.
4. On release, ``DELETE /v1/instances/:id?force=true`` (without ``force``
   for a shareable launch, see :attr:`LaunchedInstance.release`), retried
   on ``E_TERMINATE_FAILED`` and treated as done on a 404.

The admin token only ever travels as a header. It never appears in an
error message or anything this module returns.
"""

from __future__ import annotations

import asyncio
import itertools
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Sequence

from .errors import AutomationError

DEFAULT_GATEWAY_URL = "http://127.0.0.1:7799/browserglass"

DEFAULT_LAUNCH_CAPS: Sequence[str] = (
    # The `agent` role bundle from packages/protocol/src/wire/capabilities.ts:
    # every capability that means "operate this one browser" and none of the
    # fleet management ones. With these every AutomationClient method works,
    # including the selector verbs, which need `evaluate`.
    "view",
    "control",
    "navigate",
    "tabs.manage",
    "capture",
    "probe",
    "clipboard.read",
    "clipboard.write",
    "upload",
    "download",
    "devtools",
    "automation",
    "instance.create",
    "instance.restart",
    "instance.destroy",
    "evaluate",
    "cdp",
    "intercept",
)

TOKEN_HELP = (
    "Get one by running `pnpm bgls token` in the directory where `bgls serve` runs, "
    "then pass it as admin_token or set BGLS_ADMIN_TOKEN."
)

RELEASE_ATTEMPTS = 3
RELEASE_RETRY_S = 1.0

_counter = itertools.count(1)


def _fresh_request_id() -> str:
    return f"launch-{os.getpid()}-{int(time.time() * 1000)}-{next(_counter)}-{secrets.token_hex(4)}"


@dataclass(frozen=True)
class LaunchedInstance:
    """What :func:`launch_instance` hands back: enough to connect, and a way to end the browser."""

    instance_id: str
    ws_url: str
    ticket: str
    release: Callable[[], Awaitable[None]]
    """Ends the browser. A throwaway launch (no ``profile_key``, no ``subject``)
    ends it with ``force=true``. A launch other callers can share, by profile
    key or by subject, releases without force, so the gateway ends the
    browser only when this was the last viewer on it and otherwise just
    detaches. Retries ``E_TERMINATE_FAILED``; a 404 counts as done."""


class _Rest:
    def __init__(self, base: str, token: str, http_client: Optional[Any]) -> None:
        self._base = base
        self._token = token
        self._http = http_client
        self._owns = http_client is None

    def _client(self) -> Any:
        if self._http is None:
            import httpx

            self._http = httpx.AsyncClient(timeout=30.0)
        return self._http

    async def aclose(self) -> None:
        if self._owns and self._http is not None:
            await self._http.aclose()
            self._http = None

    async def call(self, method: str, path: str, body: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]:
        url = f"{self._base}{path}"
        try:
            resp = await self._client().request(
                method, url, json=body, headers={"authorization": f"Bearer {self._token}"}
            )
        except Exception as err:  # connection refused, DNS, timeout
            raise AutomationError(
                "GATEWAY_ERROR",
                f"{method} {url} failed: {err}. Is `bgls serve` running there?",
                {"method": method, "path": path},
            ) from None
        if resp.status_code >= 400:
            raise _to_error(method, path, resp)
        if not resp.content:
            return {}
        return resp.json()


def _to_error(method: str, path: str, resp: Any) -> AutomationError:
    code = "E_UNKNOWN"
    message = (resp.text or "")[:300] or f"HTTP {resp.status_code}"
    try:
        err = resp.json().get("error", {})
        code = err.get("code", code)
        message = err.get("message", message)
    except Exception:
        pass
    details = {"status": resp.status_code, "gateway_code": code, "method": method, "path": path}
    if resp.status_code == 401:
        why = (
            "The admin token has expired (they last 10 minutes by default)."
            if code == "E_TOKEN_EXPIRED"
            else f"The gateway refused the admin token ({code})."
        )
        return AutomationError("UNAUTHENTICATED", f"{why} {TOKEN_HELP}", details)
    if resp.status_code == 403:
        return AutomationError(
            "POLICY_DENIED",
            f"{method} {path}: the admin token lacks the capability for this call ({code}: {message}). {TOKEN_HELP}",
            details,
        )
    return AutomationError("GATEWAY_ERROR", f"{method} {path} -> HTTP {resp.status_code} {code}: {message}", details)


def _resolve_token(admin_token: Optional[str]) -> str:
    token = admin_token if admin_token is not None else os.environ.get("BGLS_ADMIN_TOKEN")
    if token is None or token.strip() == "":
        raise AutomationError("UNAUTHENTICATED", f"AutomationClient.launch(): no admin token. {TOKEN_HELP}")
    return token.strip()


async def launch_instance(
    *,
    gateway: Optional[str] = None,
    admin_token: Optional[str] = None,
    headless: bool = True,
    viewport: Optional[Mapping[str, Any]] = None,
    profile_key: Optional[str] = None,
    caps: Optional[Sequence[str]] = None,
    ready_timeout_s: float = 60.0,
    poll_interval_s: float = 0.25,
    browser: Optional[Mapping[str, Any]] = None,
    subject: Optional[str] = None,
    sticky_within_ms: Optional[float] = None,
    http_client: Optional[Any] = None,
) -> LaunchedInstance:
    """Starts a browser, waits for it, mints a narrowed socket ticket. Ends
    the browser again if any step after the acquire fails.

    ``http_client`` is an ``httpx.AsyncClient`` to use instead of a fresh
    one (a test passes one over ``httpx.MockTransport``). When given, the
    caller owns it; otherwise this module opens one and closes it once the
    browser has been released.
    """
    token = _resolve_token(admin_token)
    base = (gateway or os.environ.get("BGLS_URL") or DEFAULT_GATEWAY_URL).rstrip("/")
    wanted = list(caps) if caps is not None else list(DEFAULT_LAUNCH_CAPS)
    if not wanted:
        raise AutomationError("INVALID_ARGUMENT", "AutomationClient.launch(): caps is empty")
    rest = _Rest(base, token, http_client)

    spec: Dict[str, Any] = dict(browser or {})
    spec["headless"] = "new" if headless else "off"
    if viewport is not None:
        spec["viewport"] = {
            "width": viewport["width"],
            "height": viewport["height"],
            "deviceScaleFactor": viewport.get("deviceScaleFactor", viewport.get("device_scale_factor", 1)),
        }
    body: Dict[str, Any] = {"requestId": _fresh_request_id(), "browser": spec}
    if profile_key is not None:
        body["profile"] = {"mode": "persistent", "key": profile_key}
    if subject is not None:
        sticky: Dict[str, Any] = {"subject": subject}
        if sticky_within_ms is not None:
            sticky["withinMs"] = sticky_within_ms
        body["subject"] = subject
        body["sticky"] = sticky

    try:
        created = await rest.call("POST", "/v1/instances", body)
    except BaseException:
        await rest.aclose()
        raise
    instance_id = created["instanceId"]
    # A second launch of the same profile key or subject gets the SAME
    # running browser back. Forcing the release would end it under every
    # other client still using it, so a shareable launch leaves the call to
    # the gateway's viewer count instead.
    force = profile_key is None and subject is None

    async def release() -> None:
        try:
            await _release(rest, instance_id, force)
        finally:
            await rest.aclose()

    try:
        await _wait_for_ready(rest, instance_id, created.get("state", "unknown"), ready_timeout_s, poll_interval_s)
        attached = await rest.call(
            "POST",
            f"/v1/instances/{instance_id}/attach",
            {"capabilities": wanted, "ticketTtlMs": 300_000},
        )
    except BaseException:
        try:
            await release()
        except Exception:
            pass
        raise
    attach = attached["attach"]
    return LaunchedInstance(instance_id=instance_id, ws_url=attach["wsUrl"], ticket=attach["ticket"], release=release)


async def _wait_for_ready(rest: _Rest, instance_id: str, state: str, timeout_s: float, interval_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while True:
        if state in ("ready", "degraded"):
            return
        if state in ("failed", "released", "releasing"):
            raise AutomationError(
                "INSTANCE_GONE",
                f"browser {instance_id} ended up '{state}' before it was ready",
                {"instance_id": instance_id, "state": state},
            )
        if time.monotonic() >= deadline:
            raise AutomationError(
                "TIMEOUT",
                f"browser {instance_id} was still '{state}' after {timeout_s}s; raise ready_timeout_s or check the gateway's log",
                {"instance_id": instance_id, "state": state},
            )
        await asyncio.sleep(interval_s)
        view = await rest.call("GET", f"/v1/instances/{instance_id}")
        state = (view.get("instance") or {}).get("state", "unknown")


async def _release(rest: _Rest, instance_id: str, force: bool = True) -> None:
    path = f"/v1/instances/{instance_id}" + ("?force=true" if force else "")
    attempt = 0
    while True:
        attempt += 1
        try:
            await rest.call("DELETE", path)
            return
        except AutomationError as err:
            status = err.details.get("status")
            gateway_code = err.details.get("gateway_code")
            if status == 404 or gateway_code == "E_INSTANCE_GONE":
                return
            retryable = gateway_code == "E_TERMINATE_FAILED" or (err.code == "GATEWAY_ERROR" and status is None)
            if not retryable or attempt >= RELEASE_ATTEMPTS:
                raise
            await asyncio.sleep(RELEASE_RETRY_S)
