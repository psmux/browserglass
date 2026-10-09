#!/usr/bin/env python3
"""Measures whether N browsers really are driven at the same time from
Python, or only look like it. Talks to the already running demo gateway
exactly the way any third-party SDK user would: mint a token over
REST, open a socket, drive. Python port of
``examples/nextjs-demo/parallel-probe.mjs``; run it against the same
gateway to compare the two SDKs directly.

The interesting number is not total wall clock. It is OVERLAP: if the
gateway serialises work, each browser's busy window sits end to end and
the union of the windows equals their sum. If it is genuinely parallel,
the windows sit on top of each other and the union is close to the
longest single one.

    BASE=http://localhost:3000 N=5 python examples/parallel_probe.py
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Dict, List, Optional

import httpx

from browserglass import AutomationClient

BASE = os.environ.get("BASE", "http://localhost:3000")
N = int(os.environ.get("N", "3"))
WS = os.environ.get("WS", "ws://localhost:3000/browserglass/socket")


async def mint(http: httpx.AsyncClient, workspace: Optional[str] = None) -> Dict[str, Any]:
    body = {"workspace": workspace} if workspace else {"fresh": True}
    resp = await http.post(f"{BASE}/api/browser", json=body)
    if resp.status_code >= 400:
        raise RuntimeError(f"acquire failed {resp.status_code}: {resp.text}")
    return resp.json()


async def open_member(http: httpx.AsyncClient, i: int) -> Dict[str, Any]:
    """One member: its own instance, its own socket, its own browser."""
    t0 = time.monotonic()
    cred = await mint(http)
    client = await AutomationClient.connect(endpoint=WS, token=cred["token"])
    return {"i": i, "cred": cred, "client": client, "acquired_ms": (time.monotonic() - t0) * 1000}


async def main() -> None:
    async with httpx.AsyncClient(timeout=60.0) as http:
        print(f"\n=== spinning up {N} members ===")
        t_spin = time.monotonic()

        async def safe_open(i: int) -> Dict[str, Any]:
            try:
                return await open_member(http, i)
            except Exception as e:
                return {"i": i, "error": str(e)}

        raw_members = await asyncio.gather(*(safe_open(i) for i in range(N)))
        spin_ms = (time.monotonic() - t_spin) * 1000
        members = [m for m in raw_members if "error" not in m]
        for m in raw_members:
            if "error" in m:
                print(f"  member {m['i']}: FAILED {m['error']}")
            else:
                cred = m["cred"]
                print(f"  member {m['i']}: instance {cred.get('instanceId')} reused={cred.get('reused')} in {m['acquired_ms']:.0f}ms")
        print(f"all {len(members)}/{N} up in {spin_ms:.0f}ms (sum of individual: {sum(m['acquired_ms'] for m in members):.0f}ms)")
        if not members:
            return

        # --- targets + control ---------------------------------------------
        print("\n=== targets and control ===")
        # `tabs.*` has no port in this SDK yet (see the README's "Not
        # implemented yet"), so this reads the snapshot `connect()` already
        # took rather than calling `tabs.list()` the way the Node probe does.
        for m in members:
            targets = list(m["client"].targets)
            m["targets"] = targets
            print(f"  member {m['i']}: {len(targets)} target(s), bound to {m['client'].target_id}")

        for m in members:
            try:
                await m["client"].acquire_control()
                print(f"  member {m['i']} target {m['client'].target_id}: control OK")
            except Exception as e:
                print(f"  member {m['i']} target {m['client'].target_id}: control FAILED code={getattr(e, 'code', '')} msg={e}")

        # --- the parallelism measurement -------------------------------------
        print(f"\n=== driving all {len(members)} at once ===")
        marks: List[tuple] = []

        def mark(who: int, phase: str) -> None:
            marks.append((who, phase, time.monotonic()))

        async def drive(m: Dict[str, Any]) -> Dict[str, Any]:
            started = time.monotonic()
            mark(m["i"], "start")
            errors: List[str] = []
            try:
                await m["client"].navigate("https://example.com", wait_until="load")
                mark(m["i"], "navigated")
                await m["client"].reload()
                mark(m["i"], "reloaded")
                title = await m["client"].evaluate("document.title")
                mark(m["i"], "evaluated")
                text = await m["client"].text()
                mark(m["i"], "read")
                return {"i": m["i"], "title": title, "text_len": len(text), "ms": (time.monotonic() - started) * 1000, "errors": errors}
            except Exception as e:
                errors.append(f"{getattr(e, 'code', '')} {e}")
                return {"i": m["i"], "ms": (time.monotonic() - started) * 1000, "errors": errors}
            finally:
                mark(m["i"], "end")

        t_drive = time.monotonic()
        results = await asyncio.gather(*(drive(m) for m in members))
        drive_ms = (time.monotonic() - t_drive) * 1000

        for r in results:
            extra = f" ERRORS={r['errors']}" if r["errors"] else ""
            print(f"  member {r['i']}: {r['ms']:.0f}ms title={r.get('title')!r} textLen={r.get('text_len', 0)}{extra}")

        sum_ms = sum(r["ms"] for r in results)
        max_ms = max(r["ms"] for r in results)
        print(f"\n  wall clock for all {len(members)}: {drive_ms:.0f}ms")
        print(f"  sum of individual:     {sum_ms:.0f}ms")
        print(f"  slowest individual:    {max_ms:.0f}ms")
        ratio = sum_ms / drive_ms if drive_ms else 0.0
        print(f"  parallel speedup:      {ratio:.2f}x  ({len(members)}x would be perfect, 1.0x means fully serialised)")

        # Interleaving proof: did the busy windows actually overlap?
        windows = []
        for m in members:
            s = next((t for who, phase, t in marks if who == m["i"] and phase == "start"), 0.0)
            e = next((t for who, phase, t in marks if who == m["i"] and phase == "end"), 0.0)
            windows.append((s, e))
        overlapped = 0
        for a in range(len(windows)):
            for b in range(a + 1, len(windows)):
                if min(windows[a][1], windows[b][1]) - max(windows[a][0], windows[b][0]) > 0:
                    overlapped += 1
        pairs = len(windows) * (len(windows) - 1) // 2
        print(f"  overlapping pairs:     {overlapped}/{pairs}")

        # --- teardown ---------------------------------------------------------
        print("\n=== closing ===")
        t_close = time.monotonic()

        async def teardown(m: Dict[str, Any]) -> None:
            try:
                await m["client"].close()
                await http.delete(f"{BASE}/api/browser", params={"instanceId": m["cred"]["instanceId"]})
            except Exception as e:
                print(f"  member {m['i']} close failed: {e}")

        await asyncio.gather(*(teardown(m) for m in members))
        print(f"  closed in {(time.monotonic() - t_close) * 1000:.0f}ms")


if __name__ == "__main__":
    asyncio.run(main())
