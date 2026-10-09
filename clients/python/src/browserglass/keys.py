"""A minimal DOM ``key``/``code`` table for ``press_key``, ``type_text``,
and ``human_type``. Mirrors ``packages/automation/src/keys.ts``.

Deliberately NOT a transcription of the CDP virtual-key table; the wire's
``input.key`` message carries only DOM ``key``/``code``/``text``, and the
CDP-level hardening happens server side. An unmapped printable character
still works correctly by falling back to ``input.text``, so nothing is
lost for characters outside this table, only per-keystroke
``keydown``/``keyup`` fidelity.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, Optional


@dataclass(frozen=True)
class KeyCode:
    key: str
    code: str


_NAMED_KEYS: Dict[str, KeyCode] = {
    "Enter": KeyCode("Enter", "Enter"),
    "Tab": KeyCode("Tab", "Tab"),
    "Escape": KeyCode("Escape", "Escape"),
    "Backspace": KeyCode("Backspace", "Backspace"),
    "Delete": KeyCode("Delete", "Delete"),
    "Insert": KeyCode("Insert", "Insert"),
    "ArrowUp": KeyCode("ArrowUp", "ArrowUp"),
    "ArrowDown": KeyCode("ArrowDown", "ArrowDown"),
    "ArrowLeft": KeyCode("ArrowLeft", "ArrowLeft"),
    "ArrowRight": KeyCode("ArrowRight", "ArrowRight"),
    "Home": KeyCode("Home", "Home"),
    "End": KeyCode("End", "End"),
    "PageUp": KeyCode("PageUp", "PageUp"),
    "PageDown": KeyCode("PageDown", "PageDown"),
    "Space": KeyCode(" ", "Space"),
    "F1": KeyCode("F1", "F1"),
    "F2": KeyCode("F2", "F2"),
    "F3": KeyCode("F3", "F3"),
    "F4": KeyCode("F4", "F4"),
    "F5": KeyCode("F5", "F5"),
    "F6": KeyCode("F6", "F6"),
    "F7": KeyCode("F7", "F7"),
    "F8": KeyCode("F8", "F8"),
    "F9": KeyCode("F9", "F9"),
    "F10": KeyCode("F10", "F10"),
    "F11": KeyCode("F11", "F11"),
    "F12": KeyCode("F12", "F12"),
    "Alt": KeyCode("Alt", "AltLeft"),
    "Control": KeyCode("Control", "ControlLeft"),
    "Meta": KeyCode("Meta", "MetaLeft"),
    "Shift": KeyCode("Shift", "ShiftLeft"),
}

# US QWERTY punctuation, key to code. Shifted variants (e.g. '!' for '1')
# share the unshifted key's code.
_PUNCTUATION_CODES: Dict[str, str] = {
    "`": "Backquote", "~": "Backquote",
    "-": "Minus", "_": "Minus",
    "=": "Equal", "+": "Equal",
    "[": "BracketLeft", "{": "BracketLeft",
    "]": "BracketRight", "}": "BracketRight",
    "\\": "Backslash", "|": "Backslash",
    ";": "Semicolon", ":": "Semicolon",
    "'": "Quote", '"': "Quote",
    ",": "Comma", "<": "Comma",
    ".": "Period", ">": "Period",
    "/": "Slash", "?": "Slash",
    " ": "Space",
}

_DIGIT_SHIFT: Dict[str, str] = {
    "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5",
    "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0",
}

_LOWER = re.compile(r"^[a-z]$")
_UPPER = re.compile(r"^[A-Z]$")
_DIGIT = re.compile(r"^[0-9]$")


def named_key_code(name: str) -> Optional[KeyCode]:
    """Resolves one of the named keys above (case sensitive, e.g.
    ``'Enter'``, ``'ArrowLeft'``, ``'F5'``), or ``None`` for anything
    else. Used by :meth:`~browserglass.client.AutomationClient.press_key`."""
    return _NAMED_KEYS.get(name)


def printable_key_code(char: str) -> Optional[KeyCode]:
    """Resolves a single printable character to a best-effort DOM
    ``key``/``code`` pair for a real per-key ``keydown``/``keyup`` pair,
    or ``None`` when no reasonable ``code`` is known (multi-codepoint
    graphemes, most non-Latin scripts): the caller falls back to
    ``input.text`` in that case, which is always correct even without a
    ``code``."""
    if len(char) != 1:
        return None
    if _LOWER.match(char):
        return KeyCode(char, f"Key{char.upper()}")
    if _UPPER.match(char):
        return KeyCode(char, f"Key{char}")
    if _DIGIT.match(char):
        return KeyCode(char, f"Digit{char}")
    digit_shift = _DIGIT_SHIFT.get(char)
    if digit_shift is not None:
        return KeyCode(char, digit_shift)
    punct = _PUNCTUATION_CODES.get(char)
    if punct is not None:
        return KeyCode(char, punct)
    return None
