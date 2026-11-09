"""Typed records and the error tree (no network)."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

SDK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SDK))

from mrchartist_bridge import (  # noqa: E402
    BridgeApiError,
    Candle,
    Freshness,
    History,
    KillSwitchActive,
    NotRealtime,
    Order,
    OutcomeUnknown,
    PositionUnknown,
    Quote,
    RateLimited,
    Result,
    ScopeRequired,
    StateConflict,
    Unauthenticated,
    error_from_problem,
)
from mrchartist_bridge.records import IST, parse_time  # noqa: E402

REALTIME = {"source": "broker", "asOf": "2026-11-09T10:00:00.000+05:30", "ageMs": 5, "stale": False, "class": "realtime", "delaySec": 0, "official": True, "confidence": "high", "flags": []}
DELAYED = {"source": "backup", "asOf": "2026-11-09T09:45:00+05:30", "ageMs": 900000, "stale": False, "provider": "yahoo", "class": "delayed", "delaySec": 900, "official": False, "confidence": "low", "flags": ["delayed", "unofficial"]}


# ── freshness ──


def test_freshness_fields_and_helpers():
    f = Freshness.from_dict(REALTIME)
    assert (f.source, f.data_class, f.delay_sec, f.official, f.confidence, f.flags) == ("broker", "realtime", 0, True, "high", ())
    assert f.is_realtime and f.is_fresh and f.usable_for_orders() and not f.is_delayed and not f.is_eod
    assert f.as_of == datetime(2026, 11, 9, 10, 0, tzinfo=IST)
    assert f.require_realtime() is f


def test_delayed_data_never_passes_require_realtime():
    f = Freshness.from_dict(DELAYED)
    assert f.is_delayed and not f.is_realtime and not f.usable_for_orders()
    with pytest.raises(NotRealtime) as e:
        f.require_realtime()
    assert "delayed" in str(e.value) and "not official" in str(e.value)
    assert e.value.freshness is f
    with pytest.raises(NotRealtime):
        f.require_realtime(allow_stale=True)  # allow_stale never admits delayed data


def test_eod_and_stale():
    eod = Freshness.from_dict({**DELAYED, "class": "eod", "delaySec": 86400})
    assert eod.is_eod
    with pytest.raises(NotRealtime):
        eod.require_realtime()
    stale = Freshness.from_dict({**REALTIME, "stale": True, "ageMs": 60000})
    assert stale.is_realtime and not stale.is_fresh
    with pytest.raises(NotRealtime):
        stale.require_realtime()
    assert stale.require_realtime(allow_stale=True) is stale


def test_missing_class_on_an_older_bridge_is_inferred_conservatively():
    broker = Freshness.from_dict({"source": "broker", "asOf": "2026-11-09T10:00:00+05:30", "ageMs": 1, "stale": False})
    assert broker.is_realtime and broker.official
    backup = Freshness.from_dict({"source": "backup", "asOf": "2026-11-09T10:00:00+05:30", "ageMs": 1, "stale": False})
    assert backup.is_delayed
    with pytest.raises(NotRealtime):
        backup.require_realtime()


def test_unofficial_flag_blocks_orders_even_if_class_says_realtime():
    f = Freshness.from_dict({**REALTIME, "flags": ["unofficial"]})
    assert not f.usable_for_orders()
    with pytest.raises(NotRealtime):
        f.require_realtime()


def test_freshness_to_dict_round_trips_the_wire_names():
    d = Freshness.from_dict(DELAYED).to_dict()
    assert d["class"] == "delayed" and d["delaySec"] == 900 and d["flags"] == ["delayed", "unofficial"]


def test_quote_and_ltp_require_realtime_name_the_symbol():
    q = Quote.from_dict({"symbol": "NSE:X", "ltp": 10.5, "bid": 10.4, "ask": 10.6, "changePct": 1.5, "freshness": DELAYED})
    assert q.change_pct == 1.5 and q.spread == pytest.approx(0.2)
    with pytest.raises(NotRealtime) as e:
        q.require_realtime()
    assert "NSE:X" in str(e.value)


def test_records_are_frozen_and_hashable():
    q = Quote.from_dict({"symbol": "NSE:X", "ltp": 10.5, "freshness": REALTIME})
    with pytest.raises(Exception):
        q.ltp = 1  # type: ignore[misc]
    assert hash(q) == hash(Quote.from_dict({"symbol": "NSE:X", "ltp": 10.5, "freshness": REALTIME}))
    o = Order.from_dict({"orderId": "o1", "accountId": "a", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "filledQuantity": 0, "orderType": "LIMIT", "product": "CNC", "status": "open", "legs": [{"quantity": 1}]})
    assert hash(o) is not None and o.is_open and not o.is_terminal and o.remaining_quantity == 1


# ── times and candles ──


def test_parse_time_variants_are_always_aware_and_default_to_ist():
    assert parse_time("2026-11-09T10:00:00") == datetime(2026, 11, 9, 10, 0, tzinfo=IST)
    assert parse_time("2026-11-09T04:30:00Z") == datetime(2026, 11, 9, 4, 30, tzinfo=timezone.utc)
    assert parse_time("2026-11-09T10:00:00.123456789+05:30").microsecond == 123456  # nine digits: Python 3.9 would refuse them
    assert parse_time(1700000000).tzinfo is not None
    assert parse_time(1700000000000) == parse_time(1700000000)  # epoch milliseconds
    assert parse_time(None) is None and parse_time("garbage") is None


def test_history_candles_are_ist_aware_and_iterable():
    h = History.from_dict({"symbol": "NSE:X", "interval": "1d", "partial": True, "freshness": REALTIME,
                           "candles": [{"time": 1700000000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10}, {"time": 1700086400, "open": 1.5, "high": 3, "low": 1, "close": 2, "volume": 5, "oi": 7}]})
    assert len(h) == 2 and h.partial and h.closes() == [1.5, 2.0]
    assert h[0].time.utcoffset().total_seconds() == 19800 and h[0].epoch == 1700000000
    assert h[1].oi == 7 and h[0].oi is None
    assert isinstance(h[0], Candle) and list(h)[1].close == 2


def test_result_behaves_like_a_list_and_carries_errors():
    from mrchartist_bridge.records import ItemProblem, Ltp

    items = [Ltp.from_dict({"symbol": "A", "ltp": 1, "freshness": REALTIME}), Ltp.from_dict({"symbol": "B", "ltp": 2, "freshness": DELAYED})]
    r = Result(items, {"requestId": "r"}, [ItemProblem("SYMBOL_NOT_FOUND", "no C", "C")])
    assert len(r) == 2 and r[0].symbol == "A" and [i.ltp for i in r] == [1, 2] and r.by_symbol()["B"].ltp == 2
    assert r.freshness is not None and r.freshness.is_delayed  # the least current label wins
    with pytest.raises(NotRealtime):
        r.require_realtime()
    with pytest.raises(Exception):
        r.raise_for_errors()


# ── errors ──


@pytest.mark.parametrize(
    "code,cls",
    [("UNAUTHENTICATED", Unauthenticated), ("SCOPE_REQUIRED", ScopeRequired), ("KILL_SWITCH_ACTIVE", KillSwitchActive), ("OUTCOME_UNKNOWN", OutcomeUnknown), ("POSITION_UNKNOWN", PositionUnknown),
     ("STATE_CONFLICT", StateConflict), ("RATE_LIMITED", RateLimited), ("ORDER_RATE_LIMITED", RateLimited), ("UPSTREAM_RATE_LIMITED", RateLimited), ("SOMETHING_NEW", BridgeApiError)],
)
def test_error_code_mapping(code, cls):
    e = error_from_problem({"status": 400, "code": code, "detail": "d"})
    assert type(e) is cls and e.code == code and isinstance(e, BridgeApiError)


def test_position_unknown_is_an_outcome_unknown():
    assert issubclass(PositionUnknown, OutcomeUnknown)


def test_rate_limited_carries_scope_limit_and_a_hint():
    e = error_from_problem({"status": 429, "code": "RATE_LIMITED", "retryable": True, "retryAfterMs": 1500, "scope": "upstream", "limit": {"name": "dhan-quote-per-second", "remaining": 0, "resetMs": 1500}})
    assert isinstance(e, RateLimited) and e.scope == "upstream" and e.retry_after_ms == 1500 and e.limit["name"] == "dhan-quote-per-second"
    assert "broker" in str(e) and "1.5 s" in str(e)


def test_state_conflict_exposes_the_ticket_state():
    e = error_from_problem({"status": 409, "code": "STATE_CONFLICT", "state": "rejected", "ticketId": "t1"})
    assert isinstance(e, StateConflict) and e.state == "rejected" and e.ticket_id == "t1"


def test_unknown_code_falls_back_on_the_http_status():
    assert type(error_from_problem({"status": 429, "code": "HTTP_429"})) is RateLimited
    assert error_from_problem({"status": 404, "code": "HTTP_404"}).__class__.__name__ == "NotFound"


def test_hint_is_part_of_the_message_and_can_be_replaced():
    e = error_from_problem({"status": 401, "code": "UNAUTHENTICATED", "detail": "Bad key."})
    assert str(e).startswith("Bad key.") and "MCB_API_KEY" in str(e)
    e.with_hint("Use another key.")
    assert str(e) == "Bad key. Use another key."


def test_original_attributes_are_kept_for_old_callers():
    e = BridgeApiError({"status": 422, "code": "INVALID_ORDER", "title": "t", "detail": "d", "retryable": False, "requestId": "r1", "errors": [{"path": "a", "message": "b"}]}, idempotency_key="k")
    assert (e.status, e.code, e.title, e.detail, e.retryable, e.request_id, e.idempotency_key) == (422, "INVALID_ORDER", "t", "d", False, "r1", "k")
    assert e.errors == [{"path": "a", "message": "b"}]
