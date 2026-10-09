"""The REST half of BrowserGlass: acquiring and releasing a browser
instance without ever spawning Chrome yourself.

Mirrors ``packages/server/src/rest/routes/instances.ts`` (``POST
/v1/instances``, ``DELETE /v1/instances/:instanceId``, ``POST
/v1/instances/:instanceId/attach``) and the request/result shapes in
``packages/router/src/router/types.ts``. This is a SEPARATE credential
from the one :meth:`browserglass.client.AutomationClient.connect` takes:
the REST calls here authenticate with an App-level bearer token
(``Authorization: Bearer <app token>``), and the result's
``attach.ticket`` is what you then hand to ``AutomationClient.connect``
as ITS token, over the ``bgls.v1`` WebSocket. Two tokens, two protocols,
by design: the REST token can create and destroy browsers; the WS ticket
is scoped to one instance and expires quickly.

    rest = RestClient(base_url="https://gateway.example", token=app_token)
    result = await rest.acquire(browser={"headless": True})
    client = await AutomationClient.connect(
        endpoint=result.attach.ws_url, token=result.attach.ticket
    )
    ...
    await client.close()
    await rest.release(result.instance_id)
    await rest.aclose()
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .errors import RestError


@dataclass(frozen=True)
class AttachInfo:
    ws_url: str
    ticket: str
    expires_at: float
    proxy_ws_url: Optional[str] = None

    @staticmethod
    def from_wire(m: Mapping[str, Any]) -> "AttachInfo":
        return AttachInfo(ws_url=m["wsUrl"], ticket=m["ticket"], expires_at=m["expiresAt"], proxy_ws_url=m.get("proxyWsUrl"))


@dataclass(frozen=True)
class AcquireResult:
    instance_id: str
    session_id: str
    state: str
    """``'ready'``, ``'launching'``, or ``'queued'``."""
    attach: Optional[AttachInfo]
    node: Mapping[str, Any]
    reused: bool
    reuse_reason: Optional[str]
    profile: Mapping[str, Any]
    expires_at: float
    fence: int
    raw: Mapping[str, Any]
    """Every field the server sent, for anything not surfaced above (``targets``, ``queue``, ``timings``, ``effectiveSpec``, ...)."""

    @staticmethod
    def from_wire(m: Mapping[str, Any]) -> "AcquireResult":
        attach = m.get("attach")
        return AcquireResult(
            instance_id=m["instanceId"],
            session_id=m["sessionId"],
            state=m["state"],
            attach=AttachInfo.from_wire(attach) if attach else None,
            node=m.get("node", {}),
            reused=m.get("reused", False),
            reuse_reason=m.get("reuseReason"),
            profile=m.get("profile", {}),
            expires_at=m.get("expiresAt", 0),
            fence=m.get("fence", 0),
            raw=m,
        )


@dataclass(frozen=True)
class AttachResult:
    instance_id: str
    session_id: str
    attach: AttachInfo
    node: Mapping[str, Any]
    targets: List[Mapping[str, Any]]
    fence: int
    raw: Mapping[str, Any]

    @staticmethod
    def from_wire(m: Mapping[str, Any]) -> "AttachResult":
        return AttachResult(
            instance_id=m["instanceId"],
            session_id=m["sessionId"],
            attach=AttachInfo.from_wire(m["attach"]),
            node=m.get("node", {}),
            targets=list(m.get("targets", [])),
            fence=m.get("fence", 0),
            raw=m,
        )


@dataclass(frozen=True)
class ReleaseResult:
    released: bool
    outcome: str
    """``'terminated'``, ``'browser_detached'``, ``'detached'``, or ``'already_released'``."""
    raw: Mapping[str, Any]

    @staticmethod
    def from_wire(m: Mapping[str, Any]) -> "ReleaseResult":
        return ReleaseResult(released=m.get("released", False), outcome=m.get("outcome", ""), raw=m)


def _camel(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Converts the snake_case kwargs this module's methods accept into
    the camelCase JSON keys the wire actually uses, dropping ``None``
    values so an unset optional field is omitted rather than sent as
    ``null``."""
    out: Dict[str, Any] = {}
    for key, value in payload.items():
        if value is None:
            continue
        parts = key.split("_")
        camel_key = parts[0] + "".join(p.title() for p in parts[1:])
        out[camel_key] = value
    return out


class RestClient:
    """A thin async wrapper over BrowserGlass's REST API. Every method is
    a single HTTP call; nothing here is retried or polled automatically.
    A caller whose ``acquire()`` comes back ``state='queued'`` is
    responsible for polling ``GET /v1/instances/:id`` itself (not yet
    wrapped by this SDK; see the README's "Not implemented yet")."""

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        http_client: Optional[Any] = None,
        timeout_s: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._owns_client = http_client is None
        self._timeout_s = timeout_s
        self._http = http_client

    def _client(self) -> Any:
        if self._http is None:
            import httpx

            self._http = httpx.AsyncClient(timeout=self._timeout_s)
        return self._http

    async def _request(self, method: str, path: str, *, json_body: Optional[Mapping[str, Any]] = None, params: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]:
        client = self._client()
        url = f"{self._base_url}{path}"
        headers = {"authorization": f"Bearer {self._token}"}
        resp = await client.request(method, url, json=json_body, params=params, headers=headers)
        request_id = resp.headers.get("x-bgls-request-id")
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = {}
            err = body.get("error", {}) if isinstance(body, dict) else {}
            raise RestError(
                resp.status_code,
                err.get("code", "E_UNKNOWN"),
                err.get("message", resp.text or f"HTTP {resp.status_code}"),
                retryable=err.get("retryable", resp.status_code >= 500),
                retry_after_ms=err.get("retryAfterMs"),
                details=err.get("details"),
                request_id=err.get("requestId", request_id),
            )
        if not resp.content:
            return {}
        return resp.json()

    async def acquire(
        self,
        *,
        request_id: Optional[str] = None,
        instance_id: Optional[str] = None,
        pool: Optional[str] = None,
        profile: Optional[Mapping[str, Any]] = None,
        sticky: Optional[Mapping[str, Any]] = None,
        browser: Optional[Mapping[str, Any]] = None,
        affinity: Optional[Mapping[str, Any]] = None,
        ttl_ms: Optional[float] = None,
        idle_ms: Optional[float] = None,
        release_policy: Optional[str] = None,
        on_full: Optional[str] = None,
        max_wait_ms: Optional[float] = None,
        async_: Optional[bool] = None,
        metadata: Optional[Mapping[str, str]] = None,
        subject: Optional[str] = None,
    ) -> AcquireResult:
        """``POST /v1/instances``: get a running browser instance, launching
        one if nothing matches. Never touches Chrome directly; the router
        on the other end owns that.

        ``request_id`` is the idempotency key: a repeat call within the
        server's idempotency window returns the identical result rather
        than a second instance. Mint a fresh one per logical acquisition;
        see :class:`browserglass.swarm.BrowserSwarm`'s own doc for why
        reusing one across N concurrent acquires collapses them onto one
        instance instead of N.
        """
        payload = _camel(
            {
                "request_id": request_id,
                "instance_id": instance_id,
                "pool": pool,
                "profile": profile,
                "sticky": sticky,
                "browser": browser,
                "affinity": affinity,
                "ttl_ms": ttl_ms,
                "idle_ms": idle_ms,
                "release_policy": release_policy,
                "on_full": on_full,
                "max_wait_ms": max_wait_ms,
                "async": async_,
                "metadata": metadata,
                "subject": subject,
            }
        )
        body = await self._request("POST", "/v1/instances", json_body=payload)
        return AcquireResult.from_wire(body)

    async def release(
        self,
        instance_id: str,
        *,
        reason: Optional[str] = None,
        profile: Optional[str] = None,
        force: Optional[bool] = None,
    ) -> ReleaseResult:
        """``DELETE /v1/instances/:instanceId``. Ends this caller's use of
        the instance; whether the browser process itself stops depends on
        whether anyone else is still attached (``ReleaseResult.outcome``
        says which happened), unless ``force=True``."""
        params: Dict[str, Any] = {}
        if reason is not None:
            params["reason"] = reason
        if profile is not None:
            params["profile"] = profile
        if force is not None:
            params["force"] = "true" if force else "false"
        body = await self._request("DELETE", f"/v1/instances/{instance_id}", params=params)
        return ReleaseResult.from_wire(body)

    async def attach(
        self,
        instance_id: str,
        *,
        capabilities: Optional[Sequence[str]] = None,
        ticket_ttl_ms: Optional[float] = None,
        subject: Optional[str] = None,
    ) -> AttachResult:
        """``POST /v1/instances/:instanceId/attach``: mint a fresh WS
        ticket for an instance you already know the id of, without
        launching or queueing. ``capabilities``, when given, may only
        narrow what the new ticket can do relative to your REST token,
        never widen it."""
        payload = _camel({"capabilities": capabilities, "ticket_ttl_ms": ticket_ttl_ms, "subject": subject})
        body = await self._request("POST", f"/v1/instances/{instance_id}/attach", json_body=payload)
        return AttachResult.from_wire(body)

    async def aclose(self) -> None:
        if self._owns_client and self._http is not None:
            await self._http.aclose()

    async def __aenter__(self) -> "RestClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()
