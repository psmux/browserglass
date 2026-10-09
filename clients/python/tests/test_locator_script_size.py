"""The page scripts have to fit under the gateway's evaluate ceiling.

The fake gateway these tests talk to does not enforce that ceiling, which
is how the TypeScript waiter reached 34582 bytes and broke every waiting
verb against a real gateway with no test going red. This file is the
guard for the Python copy, and it checks ``compact_page_script`` the same
way ``packages/automation/test/client/locator-compact.test.ts`` checks the
TypeScript one.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from browserglass.locator import script
from browserglass.locator.script import MAX_EVALUATE_SOURCE_BYTES, compact_page_script

PAGE_SCRIPTS = sorted(
    (name, value) for name, value in vars(script).items() if name.endswith("_SCRIPT") and isinstance(value, str)
)

# At least 20 percent of the ceiling has to stay free.
BUDGET_BYTES = int(MAX_EVALUATE_SOURCE_BYTES * 0.8)


def test_finds_the_scripts_it_is_meant_to_guard() -> None:
    assert [name for name, _ in PAGE_SCRIPTS] == [
        "CLEAR_SCRIPT",
        "DISPATCH_CLICK_SCRIPT",
        "READ_SCRIPT",
        "RESOLVE_SCRIPT",
        "SELECT_SCRIPT",
        "WAIT_SCRIPT",
    ]


@pytest.mark.parametrize(("name", "source"), PAGE_SCRIPTS)
def test_script_leaves_twenty_percent_of_the_ceiling_free(name: str, source: str) -> None:
    size = len(source.encode("utf-8"))
    assert size <= BUDGET_BYTES, f"{name} is {size} bytes; the budget is {BUDGET_BYTES}"


@pytest.mark.parametrize(("name", "source"), PAGE_SCRIPTS)
def test_script_is_already_compact(name: str, source: str) -> None:
    assert compact_page_script(source) == source, name


def test_ceiling_matches_the_protocol_package() -> None:
    evaluate_ts = Path(__file__).resolve().parents[3] / "packages/protocol/src/wire/messages/evaluate.ts"
    if not evaluate_ts.exists():
        pytest.skip("not inside the monorepo, so there is no protocol source to compare with")
    found = re.search(r"export const MAX_EVALUATE_SOURCE_BYTES = (\d+);", evaluate_ts.read_text(encoding="utf-8"))
    assert found is not None
    assert int(found.group(1)) == MAX_EVALUATE_SOURCE_BYTES


def test_drops_comment_lines_blank_lines_and_indentation() -> None:
    source = "\n".join(
        [
            "(spec) => {",
            "  // a line comment",
            "",
            "  /**",
            "   * a block comment",
            "   */",
            "  /* one line block */",
            "  var url = 'http://xy';",
            "  return url; // trailing comment stays",
            "}",
        ]
    )
    assert compact_page_script(source) == "\n".join(
        ["(spec) => {", "var url = 'http://xy';", "return url; // trailing comment stays", "}"]
    )


def test_never_touches_text_inside_a_line() -> None:
    source = "  var a = 'http://example.com';\n  var r = /\\/\\/+/g;"
    assert compact_page_script(source) == "var a = 'http://example.com';\nvar r = /\\/\\/+/g;"


def test_refuses_a_template_literal() -> None:
    with pytest.raises(ValueError, match="backtick"):
        compact_page_script("var a = `x`;")


def test_refuses_a_string_continued_with_a_backslash() -> None:
    with pytest.raises(ValueError, match="backslash"):
        compact_page_script("var a = 'x\\\n  y';")


@pytest.mark.parametrize(
    "source",
    ["var a = '/*';", "/* a */ var a = 1;", "/* a\n b */ var a = 1;", "/* never closed"],
)
def test_refuses_a_block_comment_marker_it_cannot_account_for(source: str) -> None:
    with pytest.raises(ValueError, match="block comment"):
        compact_page_script(source)
