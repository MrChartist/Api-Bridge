"""Streams: reconnect and resubscribe, seq gaps, conflation, typed events, callbacks, asyncio (fake stream server)."""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_ws import FakeStream  # noqa: E402
from mrchartist_bridge import AsyncBridge, Bridge, FeedStatus, GoAway, Heartbeat, OrderUpdate, Snapshot, Tick, parse_event  # noqa: E402

TICK = {"type": "tick", "symbol": "NSE:NIFTY", "ltp": 24800.5, "receivedAt": 1700000000000, "exchangeTs": 1700000000000, "accountId": "demo", "broker": "demo"}


@pytest.fixture()
def srv(request):
    made = []

    def make(script):
        s = FakeStream(script)
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def bridge_for(s):
    return Bridge(s.url, "mcb_test_stream_key", max_retries=0)


def collect(stream, n, timeout=10):
    out = []

    def run():
        for m in stream:
            out.append(m)
            if len(out) >= n:
                stream.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    stream.close()
    return out


def test_subscribes_after_connecting_and_yields_messages(srv):
    s = srv([[("wait_op", "subscribe"), {"type": "snapshot", "mode": "ltp", "symbols": ["NSE:NIFTY"], "ticks": [TICK], "pending": []}, dict(TICK)]])
    st = bridge_for(s).stream(["NSE:NIFTY"], mode="ltp")
    got = collect(st, 2)
    assert [m["type"] for m in got] == ["snapshot", "tick"]
    assert s.received[0][0] == {"op": "subscribe", "symbols": ["NSE:NIFTY"], "mode": "ltp"}
    assert len(s.tokens) == 1  # a single-use token per connection, never the API key in the URL


def test_reconnects_with_a_fresh_token_and_resubscribes(srv):
    s = srv([[("wait_op", "subscribe"), ("wait_op", "subscribe_orders"), dict(TICK), "close"], [("wait_op", "subscribe"), ("wait_op", "subscribe_orders"), dict(TICK, ltp=24801.0)]])
    reconnects = []
    st = Bridge(s.url, "mcb_test_stream_key", max_retries=0, sleep=lambda x: None).stream(["NSE:NIFTY"], orders=True, on_reconnect=reconnects.append, sleep=lambda x: None)
    got = collect(st, 2)
    assert [m["ltp"] for m in got] == [24800.5, 24801.0]
    assert len(s.tokens) == 2 and s.connections == 2 and reconnects == [1] and st.reconnects >= 1
    for ops in s.received:  # everything it was asked for is asked again
        assert {"op": "subscribe", "symbols": ["NSE:NIFTY"], "mode": "ltp"} in ops and {"op": "subscribe_orders"} in ops


def test_a_gap_in_seq_is_counted_and_reported(srv):
    s = srv([[("wait_op", "subscribe"), dict(TICK, seq=1), dict(TICK, seq=2), dict(TICK, seq=5), dict(TICK, seq=6)]])
    gaps = []
    st = bridge_for(s).stream(["NSE:NIFTY"], on_gap=lambda expected, got: gaps.append((expected, got)))
    collect(st, 4)
    assert gaps == [(3, 5)] and st.gaps == 1


def test_conflation_is_summed_from_heartbeats(srv):
    s = srv([[("wait_op", "subscribe"), {"type": "heartbeat", "time": "2026-11-09T10:00:00+05:30", "conflated": 3}, {"type": "heartbeat", "time": "x", "conflated": 4}]])
    st = bridge_for(s).stream(["NSE:NIFTY"])
    collect(st, 2)
    assert st.conflated == 7


def test_go_away_waits_as_told_before_reconnecting(srv):
    s = srv([[("wait_op", "subscribe"), {"type": "go_away", "reason": "shutdown", "reconnectAfterMs": 1500}, "close"], [("wait_op", "subscribe"), dict(TICK)]])
    waits = []
    st = Bridge(s.url, "mcb_test_stream_key", max_retries=0).stream(["NSE:NIFTY"], sleep=waits.append)
    got = collect(st, 2)
    assert got[0]["type"] == "go_away" and got[1]["type"] == "tick" and waits[0] == 1.5


def test_callback_api(srv):
    s = srv([[("wait_op", "subscribe"), dict(TICK), dict(TICK, ltp=1.0), {"type": "order", "order": {"orderId": "o1", "accountId": "a", "mode": "paper", "status": "filled"}}]])
    st = bridge_for(s).stream(["NSE:NIFTY"], orders=True)
    seen = []
    st.on("tick", lambda m: seen.append(("tick", m["ltp"]))).on("order", lambda m: seen.append(("order", m["order"]["status"])))
    n = st.run(max_messages=3)
    assert n == 3 and seen == [("tick", 24800.5), ("tick", 1.0), ("order", "filled")] and st.closed


def test_typed_events(srv):
    s = srv([[("wait_op", "subscribe"), {"type": "snapshot", "mode": "quote", "symbols": ["NSE:NIFTY"], "ticks": [dict(TICK, open=1.0, changePct=0.5, bid=2.0)], "pending": ["NSE:X"]},
              dict(TICK), {"type": "order", "order": {"orderId": "o1", "accountId": "a", "mode": "paper", "status": "filled", "filledQuantity": 2, "avgPrice": 10.5, "clientOrderId": "c1"}},
              {"type": "status", "accountId": "demo", "broker": "demo", "state": "up", "connected": True, "reason": None, "subscriptions": 1},
              {"type": "heartbeat", "time": "t", "conflated": 2}, {"type": "budget", "accounts": []}]])
    st = bridge_for(s).stream(["NSE:NIFTY"], mode="quote", orders=True)
    evs = []

    def run():
        for e in st.events():
            evs.append(e)
            if len(evs) == 6:
                st.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(10)
    st.close()
    snap, tick, order, status, hb, other = evs
    assert isinstance(snap, Snapshot) and snap.mode == "quote" and snap.pending == ("NSE:X",) and snap.ticks[0].open == 1.0 and snap.ticks[0].change_pct == 0.5 and snap.ticks[0].bid == 2.0
    assert isinstance(tick, Tick) and tick.symbol == "NSE:NIFTY" and tick.ltp == 24800.5 and tick.received_at.year == 2023 and tick.age_ms > 0 and tick.seq == 2
    assert isinstance(order, OrderUpdate) and order.is_filled and order.filled_quantity == 2 and order.client_order_id == "c1"
    assert isinstance(status, FeedStatus) and status.connected and status.state == "up"
    assert isinstance(hb, Heartbeat) and hb.conflated == 2
    assert other.type == "budget" and other.raw["accounts"] == []


def test_parse_event_is_total():
    assert parse_event({"type": "from_the_future", "seq": 1}).type == "from_the_future"
    assert isinstance(parse_event({"type": "go_away", "reason": "slow_consumer", "reconnectAfterMs": 0}), GoAway)
    assert parse_event({"type": "error", "code": "SUBSCRIPTION_LIMIT", "message": "m", "retryable": False}).code == "SUBSCRIPTION_LIMIT"


def test_no_reconnect_when_asked_not_to(srv):
    s = srv([[("wait_op", "subscribe"), dict(TICK), "close"]])
    st = bridge_for(s).stream(["NSE:NIFTY"], reconnect=False)
    got = collect(st, 5, timeout=5)
    assert len(got) == 1 and s.connections == 1


def test_context_manager_closes(srv):
    s = srv([[("wait_op", "subscribe"), dict(TICK)]])
    with bridge_for(s).stream(["NSE:NIFTY"]) as st:
        assert next(iter(st))["type"] == "tick"
    assert st.closed


# ── asyncio ──


def test_async_stream_events_and_typed(srv):
    s = srv([[("wait_op", "subscribe"), dict(TICK), dict(TICK, ltp=2.0)]])

    async def main():
        async with AsyncBridge(s.url, "mcb_test_stream_key", max_retries=0) as ab:
            got = []
            async with ab.stream(["NSE:NIFTY"]) as stream:
                async for ev in stream.events():
                    got.append(ev)
                    if len(got) == 2:
                        break
            return got

    got = asyncio.run(asyncio.wait_for(main(), 10))
    assert [e.ltp for e in got] == [24800.5, 2.0] and all(isinstance(e, Tick) for e in got)


def test_async_stream_raises_fatal_errors_in_the_consumer(srv):
    # a bad key on the token request is not retried: the error reaches the awaiting code
    s = srv([[]])

    async def main():
        ab = AsyncBridge(s.url, "k", max_retries=0)
        ab.sync.client.stream_token = lambda: (_ for _ in ()).throw(RuntimeError("boom"))  # type: ignore[method-assign]
        async with ab.stream(["NSE:NIFTY"], reconnect=False) as stream:
            async for _ in stream:
                pass

    with pytest.raises(Exception):
        asyncio.run(asyncio.wait_for(main(), 10))


def test_async_stream_leaves_no_unawaited_coroutine_when_the_loop_goes_away_first(srv, monkeypatch):
    # The pump thread builds `queue.put(item)` and then schedules it on the loop; if the loop has closed in between, scheduling
    # raises. The un-scheduled coroutine used to be dropped un-awaited ("coroutine 'Queue.put' was never awaited").
    import gc
    import warnings

    s = srv([[("wait_op", "subscribe"), dict(TICK)]])

    def loop_is_gone(coro, loop):
        raise RuntimeError("Event loop is closed")

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", loop_is_gone)

    async def main():
        ab = AsyncBridge(s.url, "mcb_test_stream_key", max_retries=0)
        stream = ab.stream(["NSE:NIFTY"], reconnect=False)
        stream._start()
        stream._thread.join(10)  # the pump ends: every put failed quietly and closed the stream
        assert not stream._thread.is_alive()

    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter("always")
        asyncio.run(asyncio.wait_for(main(), 15))
        gc.collect()
    assert [str(w.message) for w in seen if "never awaited" in str(w.message)] == []
