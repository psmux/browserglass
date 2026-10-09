"""The world discipline: one validator, and one refusal that makes a
particular wrong call impossible to write.

Every evaluate this SDK sends runs in one of two JavaScript worlds. The
page's own (``"main"``), where the page's globals are visible and the page
can watch everything the script does, or a separate one (``"isolated"``)
that shares the DOM and nothing else. Which one a given call used is not a
detail: it decides whether a site looking for automation can see the
locator surface work, and it decides whether code that reaches for a page
global finds one.

Two things live here, and both exist because of a specific mistake that
was made and cost a probe run rather than because of tidiness.

THE OPTIONS BAG THAT BECAME A PAGE ARGUMENT
-------------------------------------------

The TypeScript SDK's ``evaluate(source, ...args)`` is variadic in its
ARGUMENTS. So this, written by somebody who reasonably expected an options
bag to be an options bag::

    client.evaluate('window.__x', { world: 'isolated' })   // WRONG

hands ``{ world: 'isolated' }`` to the PAGE as argument zero and runs in
the default world, silently, with no error anywhere. The first version of
``examples/nextjs-demo/isolated-world-probe.mjs`` did exactly that and
reported that the isolated world could see the page's globals, which was
the probe being wrong and not the SDK. Options reach the TypeScript wire
only through ``evaluateWith``.

This client is structurally safer already: :meth:`AutomationClient.evaluate`
takes exactly one positional parameter and every option after it is keyword
only, so the wrong call above is a ``TypeError`` at the call site rather
than a silent wrong world at runtime. That is not luck, and
``tests/test_evaluate_worlds.py`` pins it with :mod:`inspect` so a later
edit that widens the signature fails a test instead of reintroducing the
trap.

But :meth:`AutomationClient.evaluate_function` IS variadic, because its
whole job is to pass arguments to the page, and there ``{"world":
"isolated"}`` is a perfectly well formed page argument. Nothing in the
signature can tell the two apart. :func:`guard_page_arguments` tells them
apart by CONTENT: a mapping every one of whose keys is an option name this
surface knows is refused, loudly, naming the correct spelling. It is
deliberately narrow. ``{"world": "isolated", "ref": "ap-1"}`` goes through
as data, because a caller mixing real data in with an option name is
passing data, and refusing that would break page arguments that happen to
carry a key called ``world``.

THE WORLD THAT WAS NOT A WORLD
------------------------------

``world="isolate"`` (or ``"utility"``, patchright's own server side
spelling, which is the likeliest typo anyone porting from it will make)
used to travel all the way to the server before anything objected. That is
a round trip spent to learn something the caller could have been told at
the call site, and on a wire where the answer comes back as a generic
protocol error it is a round trip that teaches very little.
:func:`check_world` refuses it here, by name.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from .errors import AutomationError
from .types import EVALUATE_WORLDS, EvaluateWorld

#: Every keyword option name on this SDK's evaluate surface. A mapping
#: whose keys are ALL drawn from this set, passed where a page argument was
#: expected, is an options bag somebody meant to pass by keyword. Kept in
#: one place so a new option added to ``evaluate_function`` is covered by
#: the guard the day it is written rather than the day somebody trips over
#: it.
EVALUATE_OPTION_NAMES = frozenset(
    {
        "world",
        "timeout_ms",
        "timeoutMs",
        "await_promise",
        "awaitPromise",
        "user_gesture",
        "userGesture",
        "polling_ms",
        "pollingMs",
        "poll_timeout_ms",
        "pollTimeoutMs",
    }
)


def check_world(world: Optional[str], *, where: str) -> Optional[EvaluateWorld]:
    """Returns ``world`` unchanged when it is legal, ``None`` when it was
    not asked for, and raises ``INVALID_ARGUMENT`` otherwise.

    ``None`` is a real answer and is not the same as ``"main"``: it means
    the caller asked for nothing, so nothing is put on the wire, and the
    server applies its own default (which is main). Sending ``"main"``
    explicitly would be a behaviour-identical but louder message, and the
    TypeScript SDK does not send it either. A test pins the absence.
    """
    if world is None:
        return None
    if world in EVALUATE_WORLDS:
        return world  # type: ignore[return-value]
    hint = ""
    if world == "utility":
        # patchright's server side name for the same thing. Anybody porting
        # from it will reach for this word, and it is worth naming.
        hint = " ('utility' is patchright's own spelling for the isolated world; here it is 'isolated')"
    raise AutomationError(
        "INVALID_ARGUMENT",
        f"{where}: world={world!r} is not a world. It is 'main' (the page's own context) or "
        f"'isolated' (a context that shares the DOM and nothing else){hint}.",
        {"world": world, "allowed": list(EVALUATE_WORLDS)},
    )


def guard_page_arguments(args: Sequence[Any], *, where: str) -> None:
    """Refuses an options bag wearing a page argument's clothes.

    See this module's own doc for the mistake and for why the test is on
    CONTENT rather than on position: the position is legitimate, the
    content is what gives the intent away. Only the FIRST argument is
    checked, because that is the slot an options bag lands in when somebody
    writes ``evaluate_function(src, {...})`` expecting the TypeScript
    ``evaluateWith`` shape.
    """
    if not args:
        return
    first = args[0]
    if not isinstance(first, Mapping) or len(first) == 0:
        return
    if not all(isinstance(k, str) and k in EVALUATE_OPTION_NAMES for k in first.keys()):
        return
    spelled = ", ".join(f"{k}=..." for k in first.keys())
    raise AutomationError(
        "INVALID_ARGUMENT",
        f"{where}: the first page argument is a mapping whose every key is an option name "
        f"({sorted(first.keys())}), which is almost certainly an options bag passed by position. "
        f"Options on this SDK are keyword only: write {where.split('(')[0]}(source, {spelled}). "
        "Passed positionally it would have gone to the PAGE as argument zero and the call would "
        "have run in the default world, silently. If this really is data the page wants, add a key "
        "that is not an option name, or wrap it: [{'value': <your mapping>}].",
        {"looksLikeOptions": sorted(first.keys())},
    )


__all__ = ["EVALUATE_OPTION_NAMES", "EvaluateWorld", "check_world", "guard_page_arguments"]
