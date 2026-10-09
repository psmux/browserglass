#!/usr/bin/env python3
"""Acceptance probe for the documented Python quickstart, and ONLY that
path: ``RestClient.acquire()`` for the browser, then
``AutomationClient.connect(endpoint=acquired.attach.ws_url,
token=acquired.attach.ticket)`` for the socket, exactly as
``clients/python/README.md`` and ``browserglass/__init__.py``'s own module
docstring show it. No bespoke route, no hand-rolled JWT, no bypass: this
is the thing a fresh Python developer following the README would actually
type.

Before the fix this probe exists to verify, this could never work:
``BrowserRouter.attach()``/``acquire()`` (``packages/router/src/router/BrowserRouter.ts``)
fabricated ``attach.ticket`` as a bare ``newId('tkt')`` (never registered
anywhere a socket could redeem it) and ``attach.wsUrl`` as the literal
string ``ws://local/<nodeId>`` (not a resolvable host). Both are real now:
the ticket is a signed, verifiable bearer credential
(``lifecycle/wiring.ts``'s ``attachCredentialIssuerFor``, minted through
this process's own ``TokenApi``), and the URL is completed against the
live gateway's own address (``rest/routes/instances.ts``'s
``resolveAttachUrl``).

Needs a running gateway (``cd examples/nextjs-demo && node server.mjs``)
and an App-level bearer token. This demo has no persisted signing key and
no other way to hand one out to an external script, so it borrows
``GET /api/browser/bootstrap-token`` (added alongside this probe,
``examples/nextjs-demo/app/api/browser/bootstrap-token/route.ts``, see
that file's own doc for why a real deployment does this differently). Set
``APP_TOKEN`` yourself to skip the bootstrap call entirely.

    BASE=http://localhost:3000 python examples/quickstart_probe.py
"""

from __future__ import annotations

import asyncio
import os
import sys

import httpx

from browserglass import AutomationClient, RestClient

BASE = os.environ.get("BASE", "http://localhost:3000")
# This demo mounts BrowserGlass under `/browserglass` (`server.mjs`'s
# `basePath`), so the REST surface `RestClient` talks to lives there, not
# at the app root.
REST_BASE = f"{BASE}/browserglass"


async def bootstrap_app_token() -> str:
    token = os.environ.get("APP_TOKEN")
    if token:
        return token
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.get(f"{BASE}/api/browser/bootstrap-token")
        resp.raise_for_status()
        return resp.json()["token"]


async def main() -> int:
    app_token = await bootstrap_app_token()
    print(f"[1/6] have an App token ({len(app_token)} chars)")

    async with RestClient(base_url=REST_BASE, token=app_token) as rest:
        # 1. Get a running browser instance without ever spawning Chrome
        #    ourselves. THIS is the call that used to hand back a ticket
        #    and wsUrl no client could ever use.
        acquired = await rest.acquire(pool="demo", profile={"mode": "ephemeral"})
        print(f"[2/6] rest.acquire() -> instance {acquired.instance_id}, state={acquired.state}")
        if acquired.attach is None:
            print("FAIL: acquire() returned no attach credential at all (state was not ready)")
            return 1
        print(f"       attach.ws_url = {acquired.attach.ws_url}")
        print(f"       attach.ticket = {acquired.attach.ticket[:24]}... ({len(acquired.attach.ticket)} chars)")

        try:
            # 2. Open the bgls.v1 socket with EXACTLY what acquire() handed
            #    back. No substitution, no fallback endpoint.
            client = await AutomationClient.connect(
                endpoint=acquired.attach.ws_url,
                token=acquired.attach.ticket,
            )
            print("[3/6] AutomationClient.connect() succeeded: the credential was real")
            try:
                lease = await client.acquire_control()
                print(f"[4/6] acquire_control() -> mode={lease.mode}")
                try:
                    await client.navigate("https://example.com/")
                    text = await client.evaluate("document.querySelector('h1')?.textContent ?? ''")
                    print(f"[5/6] navigated and read back: {text!r}")
                    if "Example Domain" not in text:
                        print(f"FAIL: expected 'Example Domain' in the read-back text, got {text!r}")
                        return 1
                finally:
                    await lease.release()
            finally:
                await client.close()
        finally:
            release_result = await rest.release(acquired.instance_id)
            print(f"[6/6] rest.release() -> outcome={release_result.outcome}")

    print("\nPASS: the documented quickstart (RestClient.acquire -> AutomationClient.connect) works as written.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
