"""Safe orders, reconciliation, waiting, target positions, batches and tickets (fake Bridge, no real network)."""

from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from fake_bridge import KEY, FakeBridge  # noqa: E402
from mrchartist_bridge import (  # noqa: E402
    Bridge,
    ConfirmationRequired,
    LiveNotConfirmed,
    NotRealtime,
    OrderNotFilled,
    OutcomeUnknown,
    PositionUnknown,
    WaitTimeout,
)
from mrchartist_bridge.records import IST  # noqa: E402

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class Clock:
    """A fake clock: sleeping advances it, so waits finish instantly and deterministically."""

    def __init__(self) -> None:
        self.t = 1000.0
        self.slept = []

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


@pytest.fixture()
def fake():
    f = FakeBridge()
    yield f
    f.close()


@pytest.fixture()
def clock():
    return Clock()


@pytest.fixture()
def bridge(fake, clock):
    return Bridge(fake.url, KEY, account="paper", sleep=clock.sleep, clock=clock.now)


def posted(fake):
    return [r for r in fake.requests if r["method"] == "POST" and r["path"] == "/v1/orders"]


# ── paper by default, live only when asked ──


def test_orders_are_paper_by_default_with_generated_ids(bridge, fake):
    o = bridge.orders.place("NSE:RELIANCE", "buy", quantity=3, product="cnc", price=2900)
    req = posted(fake)[0]
    assert req["body"]["mode"] == "paper" and req["body"]["side"] == "BUY" and req["body"]["product"] == "CNC" and req["body"]["orderType"] == "LIMIT" and req["body"]["price"] == 2900
    assert req["body"]["account"] == "paper" and re.match(r"^py-[0-9a-f]{20}$", req["body"]["clientOrderId"])
    assert UUID_RE.match(req["idem"]) and o.idempotency_key == req["idem"] and o.client_order_id == req["body"]["clientOrderId"]
    assert o.is_filled and not o.replayed and o.mode == "paper"


def test_live_needs_an_explicit_flag(bridge, fake):
    with pytest.raises(LiveNotConfirmed):
        bridge.orders.place_request({"account": "paper", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET", "mode": "live"})
    assert posted(fake) == []
    # live=True is carried through to the Bridge (which then applies its own gates)
    bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", live=True)
    assert posted(fake)[0]["body"]["mode"] == "live"


def test_live_is_never_sent_by_default_even_when_the_dict_says_paper(bridge, fake):
    bridge.orders.place_request({"account": "paper", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET", "mode": "paper"})
    assert posted(fake)[0]["body"]["mode"] == "paper"


def test_no_silent_defaults_for_product_or_order_type(bridge, fake):
    with pytest.raises(ValueError, match="product"):
        bridge.orders.place("NSE:X", "BUY", quantity=1, order_type="MARKET")
    with pytest.raises(ValueError, match="order_type"):
        bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC")
    with pytest.raises(ValueError, match="exactly one"):
        bridge.orders.place("NSE:X", "BUY", quantity=1, lots=1, product="CNC", order_type="MARKET")
    with pytest.raises(ValueError, match="side"):
        bridge.orders.place("NSE:X", "HOLD", quantity=1, product="CNC", order_type="MARKET")
    with pytest.raises(ValueError, match="trigger_price"):
        bridge.orders.place("NSE:X", "SELL", quantity=1, product="CNC", order_type="SL", price=10)
    assert posted(fake) == []


def test_trigger_infers_stop_orders(bridge, fake):
    bridge.orders.place("NSE:X", "SELL", quantity=1, product="MARGIN", trigger_price=95)
    bridge.orders.place("NSE:X", "SELL", quantity=1, product="MARGIN", trigger_price=95, price=94)
    assert [r["body"]["orderType"] for r in posted(fake)] == ["SL-M", "SL"]


def test_your_own_ids_are_used_and_sent_unchanged(bridge, fake):
    bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", idempotency_key="my-key-0001", client_order_id="my_order_1")
    r = posted(fake)[0]
    assert r["idem"] == "my-key-0001" and r["body"]["clientOrderId"] == "my_order_1"


def test_same_idempotency_key_replays_instead_of_placing_again(bridge, fake):
    a = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", idempotency_key="key-replay-1", client_order_id="cid1")
    b = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", idempotency_key="key-replay-1", client_order_id="cid1")
    assert not a.replayed and b.replayed and a.order_id == b.order_id and len(fake.orders) == 1


def test_lots_and_preview(bridge, fake):
    p = bridge.orders.preview("NFO:NIFTY-2026-12-29-FUT", "BUY", lots=2, product="MARGIN", order_type="MARKET")
    assert p.ok and p.mode == "paper" and not p.requires_human_confirmation
    body = [r for r in fake.requests if r["path"] == "/v1/orders/preview"][0]["body"]
    assert body["lots"] == 2 and "quantity" not in body and "clientOrderId" not in body and body["mode"] == "paper"
    assert posted(fake) == []


# ── real-time data only ──


def test_a_delayed_quote_cannot_price_or_back_an_order(bridge, fake):
    fake.delayed.add("NSE:SLOW")
    q = bridge.quote("NSE:SLOW")
    with pytest.raises(NotRealtime):
        bridge.orders.place("NSE:SLOW", "BUY", quantity=1, product="CNC", price=q)
    with pytest.raises(NotRealtime):
        bridge.orders.place("NSE:SLOW", "BUY", quantity=1, product="CNC", order_type="MARKET", ref=q)
    with pytest.raises(NotRealtime):
        bridge.orders.modify("x", price=q)
    assert posted(fake) == []


def test_a_realtime_quote_is_used_as_the_price(bridge, fake):
    q = bridge.quote("NSE:RELIANCE")
    bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=q)
    assert posted(fake)[0]["body"]["price"] == q.ltp
    with pytest.raises(ValueError, match="ref is the price of"):
        bridge.orders.place("NSE:TCS", "BUY", quantity=1, product="CNC", order_type="MARKET", ref=q)


# ── an unknown outcome is reconciled, never blindly retried ──


def test_network_drop_with_the_order_on_the_book_returns_that_order(bridge, fake):
    # place it behind the library's back with the same client id, then drop the reply of the library's own call
    fake.order_record({"account": "paper", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "orderType": "MARKET", "clientOrderId": "recon_2"})
    fake.fault("POST", "/v1/orders", drop=True, times=3)
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", client_order_id="recon_2", idempotency_key="key-recon-0002")
    assert o.client_order_id == "recon_2" and o.is_filled and o.replayed and o.idempotency_key == "key-recon-0002"
    assert len(posted(fake)) == 1  # the order was never sent a second time
    assert len(fake.orders) == 1


def test_unreconcilable_outcome_raises_with_the_ids_to_resend_and_never_resends(bridge, fake):
    fake.fault("POST", "/v1/orders", drop=True, times=1)
    with pytest.raises(OutcomeUnknown) as e:
        bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", client_order_id="recon_3", idempotency_key="key-recon-0003")
    assert e.value.client_order_id == "recon_3" and e.value.idempotency_key == "key-recon-0003"
    assert "key-recon-0003" in str(e.value) and "Do not send it again as a new order" in str(e.value)
    assert len(posted(fake)) == 1 and fake.orders == []
    # the documented safe follow-up: the same two ids, which the Bridge de-duplicates
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", client_order_id="recon_3", idempotency_key="key-recon-0003")
    assert o.is_filled and len(fake.orders) == 1


def test_server_outcome_unknown_is_reconciled(bridge, fake):
    fake.order_record({"account": "paper", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "orderType": "MARKET", "clientOrderId": "recon_4"})
    fake.fault("POST", "/v1/orders", 504, "OUTCOME_UNKNOWN")
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", client_order_id="recon_4")
    assert o.is_filled and o.replayed


def test_server_outcome_unknown_not_found_raises_outcome_unknown(bridge, fake):
    fake.fault("POST", "/v1/orders", 504, "OUTCOME_UNKNOWN")
    with pytest.raises(OutcomeUnknown):
        bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", client_order_id="recon_5")
    assert len(posted(fake)) == 1


def test_reconcile_false_hands_the_raw_error_back(bridge, fake):
    fake.fault("POST", "/v1/orders", 504, "OUTCOME_UNKNOWN")
    with pytest.raises(OutcomeUnknown) as e:
        bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET", reconcile=False)
    assert e.value.code == "OUTCOME_UNKNOWN"
    assert [r for r in fake.requests if "by-client-id" in r["path"]] == []


def test_a_refused_order_raises_a_typed_refusal(bridge, fake):
    from mrchartist_bridge import KillSwitchActive

    fake.kill_switch = True
    with pytest.raises(KillSwitchActive) as e:
        bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET")
    assert e.value.status == 423 and "Safety" in str(e.value)


# ── waiting and cancelling ──


def test_wait_for_fill_returns_a_filled_order_at_once(bridge, clock):
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET")
    assert bridge.orders.wait_for_fill(o).is_filled and clock.slept == []


def test_wait_for_fill_polls_until_the_order_fills(bridge, fake, clock):
    fake.hold_orders.add("slow_1")
    o2 = bridge.orders.place("NSE:X", "BUY", quantity=2, product="CNC", order_type="LIMIT", price=1, client_order_id="slow_1")
    assert o2.status == "open"
    polls = {"n": 0}
    orig = fake.route

    def route(method, path, q, body):
        if method == "GET" and path == "/v1/orders/%s" % o2.order_id:
            polls["n"] += 1
            if polls["n"] == 3:
                for x in fake.orders:
                    if x["orderId"] == o2.order_id:
                        x.update(status="filled", filledQuantity=2, avgPrice=1.0)
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    done = bridge.orders.wait_for_fill(o2, timeout=30)
    assert done.is_filled and polls["n"] == 3 and len(clock.slept) == 3 and clock.slept[1] >= clock.slept[0]  # backing off


def test_wait_for_fill_times_out_with_the_last_state(bridge, fake, clock):
    fake.hold_orders.add("slow_2")
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="LIMIT", price=1, client_order_id="slow_2")
    with pytest.raises(WaitTimeout) as e:
        bridge.orders.wait_for_fill(o.order_id, timeout=5)
    assert e.value.last.status == "open" and "still open" in str(e.value) and clock.t >= 1005


def test_wait_for_fill_can_raise_unless_filled(bridge, fake):
    fake.hold_orders.add("slow_3")
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="LIMIT", price=1, client_order_id="slow_3")
    bridge.orders.cancel(o)
    got = bridge.orders.wait_for_fill(o.order_id)
    assert got.status == "cancelled"
    with pytest.raises(OrderNotFilled) as e:
        bridge.orders.wait_for_fill(o.order_id, raise_unless_filled=True)
    assert e.value.order.status == "cancelled"


def test_cancel_get_and_list(bridge, fake):
    fake.hold_orders.add("c1")
    o = bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="LIMIT", price=1, client_order_id="c1")
    assert bridge.orders.cancel(o).status == "cancelled"
    assert [r for r in fake.requests if r["method"] == "DELETE"][0]["idem"]
    assert bridge.orders.get(o.order_id).status == "cancelled" and bridge.orders.by_client_id("c1").order_id == o.order_id
    assert len(bridge.orders.list(account="paper")) == 1


# ── target position ──


def test_to_target_falls_back_to_reading_the_position(bridge, fake):
    fake.positions["NSE:X"] = 10
    r = bridge.orders.to_target("NSE:X", target_quantity=4, product="CNC", order_type="MARKET")
    assert (r.via, r.current_quantity, r.delta, r.action) == ("client", 10, -6, "SELL") and r.order.quantity == 6 and r.order.side == "SELL"
    again = bridge.orders.to_target("NSE:X", target_quantity=4, product="CNC", order_type="MARKET")
    assert again.action == "NONE" and again.order is None and len(posted(fake)) == 1


def test_to_target_with_lots_uses_the_lot_size(bridge, fake):
    r = bridge.orders.to_target("NFO:NIFTY-2026-12-29-FUT", target_lots=2, product="MARGIN", order_type="MARKET")
    assert r.target_quantity == 2 * fake.lot and r.order.quantity == 2 * fake.lot and r.action == "BUY"


def test_to_target_treats_an_unreadable_position_as_unknown_never_flat(bridge, fake):
    fake.positions_fail = True
    with pytest.raises(PositionUnknown) as e:
        bridge.orders.to_target("NSE:X", target_quantity=0, product="CNC", order_type="MARKET")
    assert posted(fake) == [] and "could not be read" in str(e.value)


def test_to_target_uses_the_server_route_when_the_bridge_has_it(bridge, fake):
    fake.has_to_target = True
    fake.positions["NSE:X"] = 1
    r = bridge.orders.to_target("NSE:X", target_quantity=5, product="CNC", order_type="MARKET")
    assert r.via == "server" and r.current_quantity == 1 and r.delta == 4 and r.order.quantity == 4
    req = [x for x in fake.requests if x["path"] == "/v1/orders/to-target"][0]
    assert req["body"]["targetQuantity"] == 5 and req["body"]["mode"] == "paper" and UUID_RE.match(req["idem"])
    assert [x for x in fake.requests if x["path"] == "/v1/positions"] == []  # the Bridge did the reading


def test_to_target_catches_a_404_from_a_bridge_whose_meta_was_unreadable(fake, clock):
    fake.fault("GET", "/v1/meta", 500, times=5)
    b = Bridge(fake.url, KEY, account="paper", max_retries=0, sleep=clock.sleep, clock=clock.now)
    r = b.orders.to_target("NSE:X", target_quantity=2, product="CNC", order_type="MARKET")  # POST to-target 404s, then the fallback
    assert r.via == "client" and r.order.quantity == 2


def test_to_target_validates_its_arguments(bridge):
    with pytest.raises(ValueError):
        bridge.orders.to_target("NSE:X", product="CNC")
    with pytest.raises(ValueError):
        bridge.orders.to_target("NSE:X", target_quantity=1)


# ── batch ──


def test_batch_fallback_sends_one_by_one_with_derived_keys(bridge, fake):
    orders = [{"symbol": "NSE:A", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET"}, {"symbol": "NSE:B", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "LIMIT"},
              {"symbol": "NSE:C", "side": "SELL", "quantity": 2, "product": "CNC", "orderType": "MARKET"}]
    r = bridge.orders.batch(orders, idempotency_key="batch-key-1")
    assert r.via == "client" and r.ok and len(r.orders) == 3 and r.failed == []
    keys = [x["idem"] for x in posted(fake)]
    assert keys[0] == "batch-key-1-0" and keys[-1] == "batch-key-1-2"
    assert all(x["body"]["mode"] == "paper" for x in posted(fake))


def test_batch_stop_on_error_skips_the_rest(bridge, fake):
    fake.fault("POST", "/v1/orders", 422, "INVALID_ORDER", times=1)
    r = bridge.orders.batch([{"symbol": "NSE:A", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET"}, {"symbol": "NSE:B", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET"}], stop_on_error=True)
    assert [i.ok for i in r.results] == [False, False] and r.results[0].error_code == "INVALID_ORDER" and r.results[1].error_code == "SKIPPED" and len(posted(fake)) == 1


def test_batch_uses_the_server_route(bridge, fake):
    fake.has_batch = True
    r = bridge.orders.batch([{"symbol": "NSE:A", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET"}, {"symbol": "NSE:B", "side": "BUY", "quantity": 0, "product": "CNC", "orderType": "MARKET"}])
    assert r.via == "server" and r.batch_id == "batch_1" and [i.ok for i in r.results] == [True, False] and r.results[1].error_code == "INVALID_ORDER" and len(r.orders) == 1
    req = [x for x in fake.requests if x["path"] == "/v1/orders/batch"][0]
    assert req["body"]["stopOnError"] is False and req["body"]["account"] == "paper" and all("account" not in o and o["mode"] == "paper" for o in req["body"]["orders"])


def test_batch_refuses_a_live_dict_without_live_true(bridge):
    with pytest.raises(LiveNotConfirmed):
        bridge.orders.batch([{"symbol": "NSE:A", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET", "mode": "live"}])
    with pytest.raises(ValueError):
        bridge.orders.batch([])


# ── tickets ──


def _ticket(tid, expires_in=60, client_order_id=None, status="open", reason=None):
    now = datetime.now(IST)
    order = {"account": "paper", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "product": "CNC", "orderType": "MARKET"}
    if client_order_id:
        order["clientOrderId"] = client_order_id
    t = {"ticketId": tid, "order": order, "source": "mcp", "checks": [], "createdAt": now.isoformat(), "expiresAt": (now + timedelta(seconds=expires_in)).isoformat(), "status": status}
    if reason:
        t["reason"] = reason
    return t


def test_tickets_wait_sees_a_pending_ticket_then_a_confirmation(bridge, fake, clock):
    fake.tickets.append(_ticket("t1"))
    n = {"i": 0}
    orig = fake.route

    def route(method, path, q, body):
        if path == "/v1/tickets":
            n["i"] += 1
            if n["i"] > 2:
                fake.tickets.clear()  # a person approved it on the Bridge's computer
        return orig(method, path, q, body)

    fake.route = route  # type: ignore[method-assign]
    out = bridge.tickets.wait("t1", timeout=30)
    assert out.state == "confirmed" and out.is_confirmed and out.ticket.ticket_id == "t1" and clock.slept


def test_tickets_wait_returns_rejected_with_the_reason(bridge, fake):
    fake.rejected_tickets.append(_ticket("t2", status="rejected", reason="too big"))
    out = bridge.tickets.wait("t2", timeout=5)
    assert out.state == "rejected" and out.reason == "too big" and not out.is_confirmed


def test_tickets_wait_reports_expired_when_nobody_answered(bridge, fake):
    fake.tickets.append(_ticket("t3", expires_in=-1))  # still listed, but its time is up
    assert bridge.tickets.wait("t3", timeout=10).state == "expired"


def test_a_ticket_that_vanished_after_its_time_is_expired_not_confirmed(bridge):
    from mrchartist_bridge import Ticket

    seen = Ticket.from_dict(_ticket("t3b", expires_in=-5))
    assert bridge.tickets.status("t3b", last_seen=seen).state == "expired"
    fresh = Ticket.from_dict(_ticket("t3c", expires_in=30))
    assert bridge.tickets.status("t3c", last_seen=fresh).state == "confirmed"  # gone before its time ran out: approved


def test_tickets_wait_settles_confirmed_by_the_order_it_made(bridge, fake):
    fake.order_record({"account": "paper", "symbol": "NSE:X", "side": "BUY", "quantity": 1, "orderType": "MARKET", "clientOrderId": "tk_order"})
    out = bridge.tickets.status("t4", order_client_id="tk_order")
    assert out.state == "confirmed" and out.order.client_order_id == "tk_order"


def test_tickets_wait_times_out_while_a_person_has_not_answered(bridge, fake):
    fake.tickets.append(_ticket("t5", expires_in=3600))
    with pytest.raises(WaitTimeout) as e:
        bridge.tickets.wait("t5", timeout=3, poll=1)
    assert e.value.last.state == "pending"


def test_a_ticket_that_was_never_seen_and_is_gone_is_unknown(bridge):
    assert bridge.tickets.status("ghost").state == "unknown"


def test_tickets_need_an_admin_key_and_say_so(bridge, fake):
    fake.fault("GET", "/v1/tickets", 403, "SCOPE_REQUIRED")
    from mrchartist_bridge import ScopeRequired

    with pytest.raises(ScopeRequired) as e:
        bridge.tickets.list()
    assert "a person does that in the dashboard" in str(e.value)


def test_confirmation_required_carries_the_ticket_id(bridge, fake):
    fake.fault("POST", "/v1/orders", 409, "CONFIRMATION_REQUIRED", ticketId="t9")
    with pytest.raises(ConfirmationRequired) as e:
        bridge.orders.place("NSE:X", "BUY", quantity=1, product="CNC", order_type="MARKET")
    assert e.value.ticket_id == "t9" and "never happens from code" in str(e.value)


def test_the_library_has_no_way_to_confirm_a_ticket(bridge):
    assert not hasattr(bridge.tickets, "confirm") and not hasattr(bridge.tickets, "approve") and not hasattr(bridge.orders, "confirm")
