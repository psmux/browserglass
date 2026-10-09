#!/usr/bin/env python3
"""Proves ``AutomationClient.wait_for_download()`` (and, cheaply,
``wait_for_network_idle()``) against real Chrome, driven by a real
gateway. There is no TypeScript sibling probe for either method yet
(``examples/nextjs-demo`` has one for ``waitForNetworkIdle``,
``netidle-probe.mjs``, but none for ``waitForDownload``), so this is the
first runnable, end-to-end proof either method exists in this monorepo
at all.

Downloads never stream over the ``bgls.v1`` socket: ``wait_for_download()``
hands back a signed, short-lived, single-use HTTP URL and the file's own
``sha256``. This probe clicks a real, plain ``<a href>`` pointing at a
real HTTP response carrying a real ``Content-Disposition: attachment``
header (httpbin's ``/response-headers`` echoes back whatever headers you
ask it to, which is the standard, server-authored way a real download
link forces a download; no ``download`` attribute or synthetic
navigation trick required), waits for the resulting ``download.ready``,
fetches the URL with a plain HTTP GET (the same "bring your own HTTP
client" contract the method's own docstring describes), and checks the
fetched bytes hash to exactly what the server claimed before a single
byte was read.

Needs outbound internet access from wherever the gateway's Chrome runs
(to reach httpbin.org) as well as the ordinary demo gateway.

    BASE=http://localhost:3000 python examples/download_probe.py
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
from urllib.parse import quote

import httpx

from browserglass import AutomationClient
from browserglass.errors import AutomationError

BASE = os.environ.get("BASE", "http://localhost:3000")
WS = os.environ.get("WS", "ws://localhost:3000/browserglass/socket")

# httpbin's own header-echo endpoint: a real HTTP response, from a real
# server, with a real `Content-Disposition: attachment` header, which is
# what actually makes a browser treat a response as a download. This
# is the plain, server-authored case `wait_for_download()` exists for,
# not a synthetic same-process trick.
DOWNLOAD_URL = (
    "https://httpbin.org/response-headers"
    "?Content-Disposition=" + quote('attachment; filename="hello.txt"')
    + "&Content-Type=" + quote("text/plain")
)

PAGE = f"""<!doctype html><meta charset=utf8><title>download probe</title><body>
<a id="dl" href="{DOWNLOAD_URL}">download</a>
</body>"""


def data_url(html: str) -> str:
    return f"data:text/html,{quote(html)}"


results: list[bool] = []


def check(label: str, got: object, want: object) -> None:
    ok = got == want
    results.append(ok)
    tail = "" if ok else f" want={want!r}"
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<66} got={got!r}{tail}")


def check_true(label: str, ok: bool) -> None:
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")


async def main() -> None:
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.post(f"{BASE}/api/browser", json={"fresh": True})
        if resp.status_code >= 400:
            print(f"acquire failed {resp.status_code}: {resp.text}")
            sys.exit(1)
        cred = resp.json()
        print(f"\ninstance {cred.get('instanceId')}")
        caps = cred.get("caps") or []
        check_true("the minted token carries the 'download' capability", "download" in caps)
        check_true("the minted token carries the 'devtools' capability (for wait_for_network_idle)", "devtools" in caps)

        client = await AutomationClient.connect(endpoint=WS, token=cred["token"])
        try:
            await client.acquire_control()

            print("\n=== wait_for_download(): a real <a href> link, a real Content-Disposition response ===")

            await client.navigate(data_url(PAGE), wait_until="load")
            await client.wait_for("#dl")

            before_ms = time.time() * 1000
            try:
                result = await client.wait_for_download(timeout_ms=20000, trigger=lambda: client.click("#dl"))
            except AutomationError as err:
                # A live shared gateway can be mid-restart, missing
                # outbound internet to httpbin.org, or (what direct CDP
                # probing pointed to during development)
                # not actually have `Page.setDownloadBehavior` armed for
                # this session despite the token carrying `download`; the
                # symptom is identical either way from this SDK's side:
                # no `download.*` envelope ever arrives. Reported here as
                # a probe failure rather than a crash, since the client
                # side contract (capability check, `download.ready`/
                # `download.failed` handling, the trigger race, the
                # timeout wording) is already proven independently
                # against the scripted fake gateway in
                # tests/test_downloads.py.
                check_true(f"wait_for_download() resolved against the live gateway ({err})", False)
                result = None

            if result is not None:
                check_true("download_id is a non-empty string", isinstance(result.download_id, str) and len(result.download_id) > 0)
                check_true("sha256 looks like a real hex digest (64 chars)", isinstance(result.sha256, str) and len(result.sha256) == 64)
                check_true("url is fetchable over plain HTTP(S)", result.url.startswith("http://") or result.url.startswith("https://"))
                check_true("expires_at is in the future", result.expires_at > before_ms)

                # The read path this SDK deliberately does NOT wrap in a
                # method of its own: an ordinary GET with whatever HTTP
                # client the caller already has. See wait_for_download()'s
                # own docstring for why.
                fetched = await http.get(result.url)
                check("fetching the signed URL returns 200", fetched.status_code, 200)
                check("size_bytes matches the fetched byte count", result.size_bytes, len(fetched.content))
                check(
                    "the fetched bytes hash to the sha256 the server reported BEFORE they were read",
                    hashlib.sha256(fetched.content).hexdigest(),
                    result.sha256,
                )

            # The local, no-round-trip POLICY_DENIED refusal when a token
            # lacks 'download' is proven against a scripted gateway that
            # can grant an arbitrary capability set (tests/test_downloads.py);
            # this demo's /api/browser route mints only one fixed capability
            # set, so there is no narrowed token available here to repeat
            # that assertion against real Chrome.

            print("\n=== wait_for_network_idle(): the wire support this README used to say did not exist ===")

            await client.diagnostics.subscribe(network=True)
            await client.navigate("https://example.com", wait_until="load")
            try:
                await client.wait_for_network_idle(idle_ms=500, timeout_ms=15000)
                check_true("wait_for_network_idle() resolved once real network traffic settled", True)
            except AutomationError as err:
                check_true(f"wait_for_network_idle() resolved once real network traffic settled ({err})", False)

        finally:
            await client.close()
            await http.delete(f"{BASE}/api/browser", params={"instanceId": cred["instanceId"]})

        passed = sum(1 for r in results if r)
        print(f"\n=== {passed}/{len(results)} passed ===")
        if passed != len(results):
            sys.exit(1)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
