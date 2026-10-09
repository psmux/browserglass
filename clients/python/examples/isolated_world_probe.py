#!/usr/bin/env python3
"""The isolated world probe, from Python.

Port of ``examples/nextjs-demo/isolated-world-probe.mjs``: same page, same
assertions, same order, so a pass here is the same claim the Node probe
makes and the two counts are directly comparable. The Node run reports
14/14.

It proves WHERE the locator surface runs, which is the thing no unit test
can settle. A unit test asserts that the string ``"isolated"`` was passed
to a fake; only a real page can say whether the world boundary was
actually there.

The page it loads patches ``Document.prototype.querySelector`` and
``querySelectorAll`` from its own inline script, which by definition runs
in the main world, and counts every call. The locator engine's
``RESOLVE_SCRIPT`` is built on exactly those two methods
(``locator/script.py``). So:

  * if ``resolve()`` runs in the MAIN world, the page's counter goes up
    and the page could have returned anything it liked;
  * if ``resolve()`` runs in the ISOLATED world, the counter stays at zero
    and the resolve still finds the element, because an isolated world
    gets clean prototypes over the same shared DOM.

That is a difference a page can produce and a driver cannot fake, which is
what makes it a proof rather than a restatement of the code.

THE NEGATIVE CONTROL is not optional and is the reason the last two steps
exist. A counter that stayed at zero because the page's patch never
installed looks exactly like a counter that stayed at zero because the
locator ran out of its reach. So the probe then calls
``document.querySelector`` from the main world and watches the counter
move, and calls it again from the isolated world and watches it stay put.
Two zeroes on their own prove nothing.

NOTE ON THE OPTIONS BAG. The Node probe carries a warning here that every
read must go through ``evaluateWith(source, args, opts)`` and never
``evaluate(source, ...args)``, because the TypeScript ``evaluate`` is
variadic in its ARGUMENTS and ``evaluate('expr', {world: 'isolated'})``
hands the bag to the page and runs in the default world, silently. The
first version of that probe did exactly that and reported that the
isolated world could see the page's globals, which was the probe being
wrong and not the SDK. In this client that line does not compile past the
call: ``evaluate`` takes one positional parameter and ``world`` is keyword
only. See ``browserglass/worlds.py``.

Run it against the Next.js demo gateway::

    cd examples/nextjs-demo && npm run dev
    BASE=http://localhost:3000 python examples/isolated_world_probe.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any, Awaitable, Callable, List, Optional
from urllib.parse import quote

import httpx

from browserglass import AutomationClient

BASE = os.environ.get("BASE", "http://localhost:3000")
WS = os.environ.get("WS", "ws://localhost:3000/browserglass/socket")

PAGE = """<!doctype html><meta charset=utf8><title>World probe</title>
<body style="font:16px system-ui;padding:24px">
<h1 id=h>World probe</h1>
<input id=name placeholder="Full name">
<button id=go type=button>Go</button>
<script>
  // Everything in this block runs in the MAIN world. It is the page, and
  // the page is the adversary the isolated world exists to keep out.
  window.__mainWorldMarker = 'set-by-the-page';
  window.__qsaCalls = 0;
  window.__qsCalls = 0;
  const origAll = Document.prototype.querySelectorAll;
  const origOne = Document.prototype.querySelector;
  Document.prototype.querySelectorAll = function (...a) { window.__qsaCalls++; return origAll.apply(this, a); };
  Document.prototype.querySelector = function (...a) { window.__qsCalls++; return origOne.apply(this, a); };
</script>"""

URL = "data:text/html;charset=utf-8," + quote(PAGE)

results: List[bool] = []


async def step(name: str, fn: Callable[[], Awaitable[Any]], expect: Any = None) -> None:
    t0 = time.time()
    try:
        value = await fn()
        if expect is not None:
            ok = expect(value) if callable(expect) else value == expect
            if not ok:
                want = "predicate to hold" if callable(expect) else json.dumps(expect)
                raise AssertionError(f"expected {want}, got {json.dumps(value)}")
        results.append(True)
        print(f"  PASS  {name:<70} {int((time.time() - t0) * 1000):>5}ms  {json.dumps(value)}")
    except Exception as err:  # noqa: BLE001
        results.append(False)
        code = getattr(err, "code", "")
        print(f"  FAIL  {name:<70} {int((time.time() - t0) * 1000):>5}ms  {code} {err}")


async def main() -> None:
    async with httpx.AsyncClient(timeout=60.0) as http:
        resp = await http.post(f"{BASE}/api/browser", json={"fresh": True})
        resp.raise_for_status()
        cred = resp.json()
        print(f"\ninstance {cred.get('instanceId')}\n")

        c = await AutomationClient.connect(endpoint=WS, token=cred["token"])
        await c.acquire_control()

        print("=== the two worlds are really two worlds ===")
        await c.navigate(URL, wait_until="load")

        await step("evaluate() default sees the page's own global", lambda: c.evaluate("window.__mainWorldMarker"), "set-by-the-page")
        await step("evaluate(world='main') sees it too", lambda: c.evaluate("window.__mainWorldMarker", world="main"), "set-by-the-page")
        await step(
            "evaluate(world='isolated') cannot see it",
            lambda: c.evaluate("typeof window.__mainWorldMarker", world="isolated"),
            "undefined",
        )
        await step(
            "the isolated world still shares the DOM",
            lambda: c.evaluate('document.getElementById("h").textContent', world="isolated"),
            "World probe",
        )

        async def isolated_global_is_invisible() -> Any:
            await c.evaluate("window.__isolatedOnly = 42", world="isolated")
            return await c.evaluate("typeof window.__isolatedOnly", world="main")

        await step("a global set from the isolated world is invisible to the page", isolated_global_is_invisible, "undefined")
        await step(
            "and is visible to the next isolated evaluate, so it is one persistent world",
            lambda: c.evaluate("window.__isolatedOnly", world="isolated"),
            42,
        )

        print("\n=== the locator surface runs where it says it does ===")
        await step(
            "the page has counted no querySelector calls yet",
            lambda: c.evaluate('[window.__qsCalls, window.__qsaCalls].join(",")', world="main"),
            "0,0",
        )

        async def resolve_total() -> Any:
            return (await c.resolve("#name")).total

        async def fill_actual() -> Any:
            return (await c.fill("#name", "Ada Lovelace")).actual

        async def click_ok() -> Any:
            return (await c.click("#go")).ok

        await step("resolve() finds the element", resolve_total, 1)
        await step("fill() writes through it", fill_actual, "Ada Lovelace")
        await step("click() dispatches through it", click_ok, True)

        # The whole point. Three locator verbs have now run, every one of
        # them built on document.querySelector/querySelectorAll, and the
        # page's own patched copies of those two methods were never called
        # once. There is no way to get that reading from a main world
        # evaluate.
        await step(
            "the page's patched querySelector was never called, so none of that ran in its world",
            lambda: c.evaluate('[window.__qsCalls, window.__qsaCalls].join(",")', world="main"),
            "0,0",
        )
        await step(
            "and the page can still see the value the isolated world typed into its DOM",
            lambda: c.evaluate('document.getElementById("name").value', world="main"),
            "Ada Lovelace",
        )

        # The negative control. See this module's own doc for why the two
        # zeroes above prove nothing without it.
        async def main_world_moves_the_counter() -> Any:
            await c.evaluate('document.querySelector("#name") !== null', world="main")
            return await c.evaluate("window.__qsCalls", world="main")

        await step(
            "a main world querySelector DOES move the counter, so the patch was live all along",
            main_world_moves_the_counter,
            lambda v: v >= 1,
        )

        async def isolated_world_does_not() -> Any:
            before = await c.evaluate("window.__qsCalls", world="main")
            await c.evaluate('document.querySelector("#name") !== null', world="isolated")
            after = await c.evaluate("window.__qsCalls", world="main")
            return f"{before} -> {after}"

        await step(
            "the same call from the isolated world does not move it",
            isolated_world_does_not,
            lambda v: v.split(" -> ")[0] == v.split(" -> ")[1],
        )

        await c.close()
        await http.delete(f"{BASE}/api/browser", params={"instanceId": cred["instanceId"]})

        passed = sum(1 for r in results if r)
        print(f"\n=== {passed}/{len(results)} passed ===")
        if passed != len(results):
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
