"""CSV files the SDK writes must not run as formulas when opened in a spreadsheet (same rule as the Bridge's own CSV)."""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from mrchartist_bridge import frames  # noqa: E402

EVIL = [
    '=HYPERLINK("http://evil","x")',
    "+cmd|calc",
    "-5+3",
    "@SUM(1)",
    "\tTAB",
    "\rCR",
]


def _raw_cells(text, column):
    """The cells exactly as a spreadsheet would receive them (CSV unquoted, nothing else undone)."""
    return [row[column] for row in list(csv.reader(io.StringIO(text, newline="")))[1:]]


def test_rows_to_csv_guards_every_formula_start():
    text = frames.rows_to_csv([{"symbol": v, "note": "ok"} for v in EVIL])
    cells = _raw_cells(text, 0)
    assert cells == ["'" + v for v in EVIL]
    assert not any(c.startswith(("=", "+", "-", "@", "\t", "\r")) for c in cells)


def test_plain_numbers_and_text_that_is_not_a_formula_are_left_alone():
    text = frames.rows_to_csv([{"qty": -5, "price": 12.5, "txt": "-5", "dec": "12.5", "sym": "NSE:RELIANCE", "none": None}])
    assert text.splitlines()[1] == "-5,12.5,-5,12.5,NSE:RELIANCE,"


def test_round_trip_gives_back_the_same_text():
    rows = [{"symbol": v, "note": "hello"} for v in EVIL]
    back = frames.parse_table(frames.rows_to_csv(rows))
    assert [r["symbol"] for r in back] == EVIL
    assert all(r["note"] == "hello" for r in back)


def test_guard_functions_match_the_servers():
    assert frames.guard_formula_text("=1+1") == "'=1+1"
    assert frames.guard_formula_text("-5") == "-5"
    assert frames.guard_formula_text("-5.25") == "-5.25"
    assert frames.guard_formula_text("-5+3") == "'-5+3"
    assert frames.guard_formula_text("abc") == "abc"
    assert frames.unguard_formula_text("'=1+1") == "=1+1"
    assert frames.unguard_formula_text("'abc") == "'abc"  # only our own apostrophe comes off
    assert frames.unguard_formula_text("") == ""


def test_orders_style_rows_with_a_hostile_tag_and_message_are_guarded():
    # Result.to_csv() of orders and positions goes through rows_to_csv: a broker message or an alert tag may be hostile
    text = frames.rows_to_csv([{"status_message": "=cmd|' /C calc'!A0", "tag": "@evil", "qty": 3}])
    assert _raw_cells(text, 0) == ["'=cmd|' /C calc'!A0"]
    assert _raw_cells(text, 1) == ["'@evil"]
