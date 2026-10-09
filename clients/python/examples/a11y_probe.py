#!/usr/bin/env python3
"""Proves the accessibility tree bridge (``AutomationClient.a11y()`` and
the ``role=`` locator selector) against real Chrome, on real markup, from
Python. Python port of ``examples/nextjs-demo/a11y-probe.mjs``; same
markup, same assertions, so a pass here is the same parity claim the Node
probe makes, just exercised through this SDK instead.

A ``<button>`` with no ``role`` attribute, an ``<a>`` with no ``href`` at
all, an ``<a href="">`` (still a link per the HTML spec), and an
``aria-label`` overriding text content: each is a case a
``[role="x"]``/attribute-only lookalike gets wrong and Chrome's own
``Accessibility.queryAXTree`` gets right.

Navigates to ``data:text/html,...`` URLs rather than mutating a live
page, for the same reason the Node probe does: a fresh document each time
is a real readiness signal (``wait_for('#btn')``, an ordinary DOM wait)
rather than a race against however far the accessibility tree has caught
up. Also proves the cross-origin case: ``a11y()``/``role=`` never hold
the CDP ``Accessibility`` domain open across a call, so navigating
between two calls here needs no rebind step to keep working.

    BASE=http://localhost:3001 python examples/a11y_probe.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import List, Optional
from urllib.parse import quote

import httpx

from browserglass import AutomationClient
from browserglass.types import A11yNode

BASE = os.environ.get("BASE", "http://localhost:3001")
WS = os.environ.get("WS", "ws://localhost:3001/browserglass/socket")

PAGE = """<!doctype html><meta charset=utf8><title>a11y probe</title><body>
<button id="btn">Save changes</button>
<a id="fake-link" href="">looks like a link</a>
<a id="real-link" href="https://example.test/">real link</a>
<a id="no-href-at-all">no href attribute at all</a>
<span id="unlinked">not a link at all</span>
<div id="labeled" aria-label="Close dialog">X</div>
</body>"""

AFTER_NAV_PAGE = """<!doctype html><meta charset=utf8><title>after nav</title><body>
<button id="btn2">After nav</button>
</body>"""


def data_url(html: str) -> str:
    return f"data:text/html,{quote(html)}"


results: List[bool] = []


def check(label: str, got: object, want: object) -> None:
    ok = got == want
    results.append(ok)
    tail = "" if ok else f" want={want!r}"
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<66} got={got!r}{tail}")


def check_true(label: str, ok: bool) -> None:
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")


def find_by_name(nodes: List[A11yNode], name: str) -> Optional[A11yNode]:
    return next((n for n in nodes if n.name == name), None)


async def main() -> None:
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.post(f"{BASE}/api/browser", json={"fresh": True})
        cred = resp.json()
        print(f"\ninstance {cred.get('instanceId')}")
        caps = cred.get("caps") or []
        print(f"caps include devtools+evaluate: {'devtools' in caps and 'evaluate' in caps}\n")

        c = await AutomationClient.connect(endpoint=WS, token=cred["token"])
        await c.acquire_control()

        await c.navigate(data_url(PAGE), wait_until="load")
        # The real readiness gate: an ordinary DOM wait, independent of
        # whatever the accessibility tree happens to have caught up to.
        await c.wait_for("#btn")

        print("=== a11y(): real markup ===")

        try:
            button_attr = await c.get_attribute("#btn", "role")
        except Exception:
            button_attr = None
        check("the <button> element genuinely has no role attribute", button_attr, None)

        tree = await c.a11y()
        check_true("a11y() returns at least one node", len(tree.nodes) > 0)
        btn_node = find_by_name(tree.nodes, "Save changes")
        check_true("a11y() found the button by its accessible name", btn_node is not None)
        check("Chrome computes role 'button' for a <button> with no role attribute", btn_node.role if btn_node else None, "button")

        close_node = find_by_name(tree.nodes, "Close dialog")
        check_true("aria-label overrides text content in the computed accessible name", close_node is not None)
        if close_node:
            check("the overridden name is exactly the aria-label, not 'X'", close_node.name, "Close dialog")

        real_link_node = find_by_name(tree.nodes, "real link")
        check("an <a href> gets role 'link'", real_link_node.role if real_link_node else None, "link")

        # An empty href="" is still a navigable href per the HTML spec (it
        # resolves to the current page), so Chrome DOES treat it as a link.
        fake_link_node = find_by_name(tree.nodes, "looks like a link")
        check(
            "an <a> with an empty (but present) href still gets role 'link' from Chrome",
            fake_link_node.role if fake_link_node else None,
            "link",
        )

        # The real "not a link" case: an <a> with NO href attribute at all
        # is not a link, exactly what a [role="x"]/attribute-presence
        # lookalike would get wrong, since neither approach has an actual
        # attribute to read.
        no_href_is_link = any(n.name == "no href attribute at all" and n.role == "link" for n in tree.nodes)
        check_true("an <a> with NO href attribute at all does NOT get role 'link'", not no_href_is_link)

        print("\n=== role= selector, on top of the same CDP call ===")

        by_role = await c.resolve("role=button")
        check("role=button matches exactly the one <button>", [m.tag_name for m in by_role.matches], ["button"])

        by_role_name = await c.resolve('role=button[name="Save changes"]')
        check("role=button[name=\"...\"] narrows by exact accessible name", by_role_name.total, 1)

        by_role_wrong_name = await c.resolve('role=button[name="nope"]')
        check("role= with a name that matches nothing is an ordinary empty answer, not an error", by_role_wrong_name.total, 0)

        clicked = await c.click('role=button[name="Save changes"]')
        check_true("click() drives role= through the ordinary actionability pipeline", clicked.ok is True)

        print("\n=== cross-origin: a11y() and role= after a navigation ===")

        # A second data: document is Chrome's own opaque-origin case;
        # whether or not it swaps the underlying renderer process, this
        # proves the claim that matters: no rebind step was written, and
        # none was needed, because neither call ever holds the
        # Accessibility domain open between calls in the first place.
        await c.navigate(data_url(AFTER_NAV_PAGE), wait_until="load")
        await c.wait_for("#btn2")

        after_nav_tree = await c.a11y(role="button")
        after_btn = find_by_name(after_nav_tree.nodes, "After nav")
        check_true("a11y() works on the NEW page after navigation, no rebind code required", after_btn is not None)

        after_nav_role = await c.resolve('role=button[name="After nav"]')
        check("role= also works on the new page after navigation", after_nav_role.total, 1)

        await c.close()
        await http.delete(f"{BASE}/api/browser", params={"instanceId": cred["instanceId"]})

        passed = sum(1 for r in results if r)
        print(f"\n=== {passed}/{len(results)} passed ===")
        if passed != len(results):
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
