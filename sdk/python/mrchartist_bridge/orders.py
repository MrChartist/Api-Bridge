"""Safe orders and order tickets (``bridge.orders`` and ``bridge.tickets``).

The rules this module enforces for you:

* **Paper unless you say live.** ``place(...)`` sends ``mode="paper"``. A live order needs ``live=True`` in the call
  (and, on the Bridge, a live key, a live-enabled account and every safety check). A request dict that says
  ``"mode": "live"`` without ``live=True`` raises ``LiveNotConfirmed`` before anything is sent.
* **Real-time data only.** Pass a ``Quote``/``Ltp`` as ``price=`` or ``ref=`` and it is checked with
  ``require_realtime()`` first, so an order is never sized or priced from delayed, end-of-day or stale data.
* **Idempotent by default.** Every write carries an ``Idempotency-Key`` and a generated ``client_order_id``.
* **An unknown outcome is reconciled, not retried.** If the Bridge (or the network) cannot say whether the broker took
  the order, ``place`` looks the order up by its client order id. It never sends a second order for you.
* **Approval stays on the Bridge's computer.** ``tickets`` only watches; it cannot confirm, and nothing here accepts
  approval from a script.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from .client import new_idempotency_key
from .errors import (
    BridgeApiError,
    BridgeConnectionError,
    LiveNotConfirmed,
    LoopbackOnly,
    NotFound,
    OrderNotFilled,
    OutcomeUnknown,
    PositionUnknown,
    ScopeRequired,
    WaitTimeout,
)
from .records import Ltp, Order, Position, Preview, Quote, Result, Ticket, TicketOutcome, problems_from

if TYPE_CHECKING:  # pragma: no cover
    from .bridge import Bridge

Side = str
PriceLike = Union[float, int, Ltp, Quote, None]

_SIDES = ("BUY", "SELL")
_PRODUCTS = ("CNC", "INTRADAY", "MARGIN", "MTF")
_TYPES = ("LIMIT", "MARKET", "SL", "SL-M")


def new_client_order_id() -> str:
    """A client order id (matches the Bridge's ``^[A-Za-z0-9_-]{1,64}$``; unique per account per day)."""
    return "py-" + uuid.uuid4().hex[:20]


def _price(v: PriceLike, what: str) -> Optional[float]:
    """A number from a price argument. A ``Quote`` or ``Ltp`` must be real-time, official and fresh."""
    if v is None:
        return None
    if isinstance(v, (Ltp, Quote)):
        v.freshness.require_realtime(what="%s (%s)" % (what, v.symbol))
        return float(v.ltp)
    return float(v)


@dataclass(frozen=True)
class TargetResult:
    """Outcome of ``to_target``: where the position was, where it should be, and the order that gets it there."""

    symbol: str
    current_quantity: float
    target_quantity: float
    delta: float
    action: str
    """``BUY``, ``SELL`` or ``NONE`` (already at the target)."""
    order: Optional[Order]
    via: str
    """``server`` (the Bridge's own route, atomic) or ``client`` (this library read the position, then placed one order)."""


@dataclass(frozen=True)
class BatchItem:
    index: int
    ok: bool
    order: Optional[Order] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


@dataclass(frozen=True)
class BatchResult:
    """Per-order results of ``batch``, in the order sent."""

    results: Tuple[BatchItem, ...]
    via: str
    batch_id: Optional[str] = None

    @property
    def ok(self) -> bool:
        return all(r.ok for r in self.results)

    @property
    def orders(self) -> List[Order]:
        return [r.order for r in self.results if r.order is not None]

    @property
    def failed(self) -> List[BatchItem]:
        return [r for r in self.results if not r.ok]


class Orders:
    """Paper-first order placement. Reach it as ``bridge.orders``."""

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    # ── building ──

    def _body(
        self,
        symbol: str,
        side: str,
        *,
        quantity: Optional[int],
        lots: Optional[int],
        product: Optional[str],
        order_type: Optional[str],
        price: PriceLike,
        trigger_price: PriceLike,
        account: Optional[str],
        live: bool,
        validity: Optional[str],
        client_order_id: Optional[str],
        tag: Optional[str],
        confirm_token: Optional[str],
        ref: Union[Ltp, Quote, None],
        extra: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        side = (side or "").upper()
        if side not in _SIDES:
            raise ValueError("side must be BUY or SELL, not %r" % side)
        if (quantity is None) == (lots is None):
            raise ValueError("give exactly one of quantity (units) or lots")
        if not product:
            raise ValueError("product is required (CNC, INTRADAY, MARGIN or MTF): the Bridge has no default")
        product = product.upper()
        if ref is not None:
            if isinstance(ref, (Ltp, Quote)) and ref.symbol != symbol:
                raise ValueError("ref is the price of %s, but the order is for %s" % (ref.symbol, symbol))
            _price(ref, "the reference price")
        px = _price(price, "the limit price")
        trig = _price(trigger_price, "the trigger price")
        if order_type is None:
            if trig is not None:
                order_type = "SL" if px is not None else "SL-M"
            elif px is not None:
                order_type = "LIMIT"
            else:
                raise ValueError("pass order_type=\"MARKET\" explicitly, or a price for a LIMIT order: there is no default order type")
        order_type = order_type.upper()
        if order_type not in _TYPES:
            raise ValueError("order_type must be one of %s" % ", ".join(_TYPES))
        if order_type in ("LIMIT", "SL") and px is None:
            raise ValueError("%s orders need a price" % order_type)
        if order_type in ("SL", "SL-M") and trig is None:
            raise ValueError("%s orders need trigger_price" % order_type)
        acct = account or self._b.account_for(live)
        body: Dict[str, Any] = {"account": acct, "symbol": symbol, "side": side, "product": product, "orderType": order_type, "mode": "live" if live else "paper"}
        if quantity is not None:
            body["quantity"] = int(quantity)
        else:
            body["lots"] = int(lots)  # type: ignore[arg-type]
        if px is not None:
            body["price"] = px
        if trig is not None:
            body["triggerPrice"] = trig
        if validity:
            body["validity"] = validity
        body["clientOrderId"] = client_order_id or new_client_order_id()
        if tag:
            body["tag"] = tag
        if confirm_token:
            body["confirmToken"] = confirm_token
        for k, v in (extra or {}).items():
            if v is not None:
                body[k] = v
        return body

    def _check_live(self, body: Mapping[str, Any], live: bool) -> None:
        if body.get("mode") == "live" and not live:
            raise LiveNotConfirmed("This order says mode=\"live\". Pass live=True to place a live order: orders are paper unless you ask for live explicitly.")

    # ── place / preview ──

    def place(
        self,
        symbol: str,
        side: str,
        *,
        quantity: Optional[int] = None,
        lots: Optional[int] = None,
        product: Optional[str] = None,
        order_type: Optional[str] = None,
        price: PriceLike = None,
        trigger_price: PriceLike = None,
        account: Optional[str] = None,
        live: bool = False,
        validity: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        client_order_id: Optional[str] = None,
        tag: Optional[str] = None,
        confirm_token: Optional[str] = None,
        ref: Union[Ltp, Quote, None] = None,
        reconcile: bool = True,
        timeout: Optional[float] = None,
    ) -> Order:
        """Place one order. **Paper unless ``live=True``.**

        ``product`` is required; ``order_type`` is inferred only for a price (LIMIT) or a trigger (SL / SL-M): say
        ``order_type="MARKET"`` yourself. ``price`` and ``ref`` may be a ``Quote``/``Ltp``: it must be real-time.

        An idempotency key and a client order id are generated when you give none (and returned on the ``Order``),
        so calling again with the same two ids can never create a second order. If the outcome is unknown the order
        is looked up by its client order id: you get the real ``Order`` back, or ``OutcomeUnknown`` (never a blind
        retry). Raises the ``OrderRefused`` family when the Bridge refuses the order.
        """
        body = self._body(symbol, side, quantity=quantity, lots=lots, product=product, order_type=order_type, price=price, trigger_price=trigger_price, account=account, live=live,
                          validity=validity, client_order_id=client_order_id, tag=tag, confirm_token=confirm_token, ref=ref)
        return self.place_request(body, live=live, idempotency_key=idempotency_key, reconcile=reconcile, timeout=timeout)

    def place_request(self, order: Mapping[str, Any], *, live: bool = False, idempotency_key: Optional[str] = None, reconcile: bool = True, timeout: Optional[float] = None) -> Order:
        """``place`` for a request dict in the Bridge's own field names (``orderType``, ``triggerPrice`` ...).

        ``mode`` is set from ``live``; a dict that already says ``"mode": "live"`` needs ``live=True``.
        """
        body = dict(order)
        self._check_live(body, live)
        body["mode"] = "live" if live else "paper"
        if "account" not in body:
            body["account"] = self._b.account_for(live)
        if not body.get("clientOrderId"):
            body["clientOrderId"] = new_client_order_id()
        key = idempotency_key or new_idempotency_key()
        try:
            res = self._b.client._write("POST", "/v1/orders", body, key, timeout)
        except OutcomeUnknown as e:
            if not reconcile:
                raise
            e.client_order_id = body["clientOrderId"]
            return self._reconcile_or_raise(body["clientOrderId"], key, e)
        except BridgeConnectionError as e:
            if not (reconcile and e.outcome_unknown):
                raise
            e.client_order_id = body["clientOrderId"]
            return self._reconcile_or_raise(body["clientOrderId"], key, e)
        data = res.get("data")
        order_obj = Order.from_dict(data, replayed=bool(res.get("replayed")), idempotency_key=key) if isinstance(data, Mapping) else None
        if order_obj is None:
            raise BridgeApiError({"status": 0, "code": "UNEXPECTED_REPLY", "detail": "The Bridge's reply to the order had no order in it."}, key)
        if order_obj.status == "outcome_unknown" and reconcile:
            return self._reconcile_or_raise(body["clientOrderId"], key, None, first=order_obj)
        return order_obj

    def preview(self, symbol: str, side: str, *, quantity: Optional[int] = None, lots: Optional[int] = None, product: Optional[str] = None, order_type: Optional[str] = None, price: PriceLike = None,
                trigger_price: PriceLike = None, account: Optional[str] = None, live: bool = False, validity: Optional[str] = None, ref: Union[Ltp, Quote, None] = None) -> Preview:
        """What the safety checks say about this order, and the margin a paper order blocks, without placing it."""
        body = self._body(symbol, side, quantity=quantity, lots=lots, product=product, order_type=order_type, price=price, trigger_price=trigger_price, account=account, live=live,
                          validity=validity, client_order_id=None, tag=None, confirm_token=None, ref=ref)
        body.pop("clientOrderId", None)
        r = self._b.client.preview_order(body)
        return Preview.from_dict(r.get("data") or {})

    # ── reconcile ──

    def reconcile(self, client_order_id: str, *, attempts: int = 4, wait: float = 0.5) -> Optional[Order]:
        """Look an order up by client order id, a few times (it may still be on its way). ``None`` when not found."""
        last: Optional[Order] = None
        for i in range(max(1, attempts)):
            try:
                r = self._b.client.order_by_client_id(client_order_id)
                data = r.get("data")
                if isinstance(data, Mapping):
                    last = Order.from_dict(data)
                    if last.status != "outcome_unknown":
                        return last
            except NotFound as e:
                if type(e) is not NotFound and not e.code == "ORDER_NOT_FOUND":
                    raise
            if i < attempts - 1:
                self._b._sleep(wait * (i + 1))
        return last

    def _reconcile_or_raise(self, client_order_id: str, key: str, cause: Optional[Exception], first: Optional[Order] = None) -> Order:
        found = None
        try:
            found = self.reconcile(client_order_id)
        except BridgeApiError:
            found = None
        if found is not None and found.status != "outcome_unknown":
            return Order.from_dict(found.raw, replayed=True, idempotency_key=key)
        problem = {
            "status": 0, "code": "OUTCOME_UNKNOWN",
            "detail": "The Bridge could not tell whether this order reached the broker, and it is %s in the order book." % ("still undecided" if (found or first) else "not yet"),
            "retryable": False,
        }
        err = OutcomeUnknown(problem, key, client_order_id=client_order_id)
        err.with_hint("Do not send it again as a new order. Look again with bridge.orders.reconcile(%r), or place it again with idempotency_key=%r and client_order_id=%r (the Bridge de-duplicates)." % (client_order_id, key, client_order_id))
        raise err from cause

    # ── read / change ──

    def get(self, order_id: str) -> Order:
        return Order.from_dict(self._b.client.order(order_id)["data"])

    def by_client_id(self, client_order_id: str) -> Order:
        return Order.from_dict(self._b.client.order_by_client_id(client_order_id)["data"])

    def list(self, *, account: Optional[str] = None, mode: Optional[str] = None, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Result[Order]:
        r = self._b.client.orders(account=account, mode=mode, status=status, limit=limit, cursor=cursor)
        return Result([Order.from_dict(o) for o in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    def all(self, **filters: Any) -> List[Order]:
        """Every order matching the filters (follows the cursor)."""
        return [Order.from_dict(o) for o in self._b.client.paginate(self._b.client.orders, **filters)]

    def cancel(self, order: Union[str, Order], *, idempotency_key: Optional[str] = None) -> Order:
        oid = order.order_id if isinstance(order, Order) else order
        r = self._b.client.cancel_order(oid, idempotency_key=idempotency_key)
        return Order.from_dict(r["data"], replayed=bool(r.get("replayed")), idempotency_key=r.get("idempotency_key"))

    def modify(self, order: Union[str, Order], *, quantity: Optional[int] = None, price: PriceLike = None, trigger_price: PriceLike = None, order_type: Optional[str] = None,
               validity: Optional[str] = None, idempotency_key: Optional[str] = None) -> Order:
        oid = order.order_id if isinstance(order, Order) else order
        changes = {k: v for k, v in {"quantity": quantity, "price": _price(price, "the new price"), "triggerPrice": _price(trigger_price, "the new trigger price"), "orderType": order_type, "validity": validity}.items() if v is not None}
        if not changes:
            raise ValueError("nothing to change: give quantity, price, trigger_price, order_type or validity")
        r = self._b.client.modify_order(oid, changes, idempotency_key=idempotency_key)
        return Order.from_dict(r["data"], replayed=bool(r.get("replayed")), idempotency_key=r.get("idempotency_key"))

    def cancel_all(self, *, account: Optional[str] = None, mode: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Cancel every open order (of one account and mode when given). Returns the Bridge's reply."""
        return self._b.client.cancel_all_orders(account=account, mode=mode, idempotency_key=idempotency_key)

    # ── waiting ──

    def wait_for_fill(self, order: Union[str, Order], timeout: float = 30.0, *, poll: float = 0.5, max_poll: float = 3.0, raise_unless_filled: bool = False) -> Order:
        """Poll until the order is filled, cancelled, rejected or expired; return it.

        Polling starts at ``poll`` seconds and slows to ``max_poll``. Raises ``WaitTimeout`` (``.last`` holds the latest
        ``Order``; the order may still fill) when ``timeout`` passes. With ``raise_unless_filled=True`` a rejected,
        cancelled or expired order raises ``OrderNotFilled`` (``.order``) instead of being returned.
        """
        oid = order.order_id if isinstance(order, Order) else order
        deadline = self._b._clock() + timeout
        current = order if isinstance(order, Order) else self.get(oid)
        delay = poll
        while True:
            if current.is_terminal:
                if raise_unless_filled and not current.is_filled:
                    raise OrderNotFilled("Order %s ended %s%s." % (oid, current.status, (": " + current.status_message) if current.status_message else ""), current)
                return current
            if current.status == "outcome_unknown" and current.client_order_id:
                again = self.reconcile(current.client_order_id, attempts=1)
                if again is not None and again.status != "outcome_unknown":
                    current = again
                    continue
            remaining = deadline - self._b._clock()
            if remaining <= 0:
                raise WaitTimeout("Order %s is still %s after %.0f s. It may still fill: look again with bridge.orders.get(%r)." % (oid, current.status, timeout, oid), current)
            self._b._sleep(min(delay, remaining))
            delay = min(max_poll, delay * 1.5)
            current = self.get(oid)

    # ── target position and batches (server routes where they exist) ──

    def to_target(
        self,
        symbol: str,
        *,
        target_quantity: Optional[int] = None,
        target_lots: Optional[int] = None,
        product: Optional[str] = None,
        order_type: Optional[str] = None,
        price: PriceLike = None,
        account: Optional[str] = None,
        live: bool = False,
        idempotency_key: Optional[str] = None,
        ref: Union[Ltp, Quote, None] = None,
        timeout: Optional[float] = None,
    ) -> TargetResult:
        """Get the net position of ``symbol`` to a target (signed units, or signed lots), in one call.

        ``target_quantity=0`` flattens. Uses ``POST /v1/orders/to-target`` when this Bridge has it (one atomic read
        and order). On an older Bridge it falls back to this library: it reads the position, then places ONE order for
        the difference. An unreadable position raises ``PositionUnknown`` and is never treated as flat. The fallback
        is not atomic: another order placed meanwhile is not seen.
        """
        if (target_quantity is None) == (target_lots is None):
            raise ValueError("give exactly one of target_quantity (signed units) or target_lots (signed lots)")
        if not product:
            raise ValueError("product is required (CNC, INTRADAY, MARGIN or MTF)")
        acct = account or self._b.account_for(live)
        key = idempotency_key or new_idempotency_key()
        route = self._b.supports("POST", "/v1/orders/to-target")
        if route is not False:
            if ref is not None:
                _price(ref, "the reference price")
            body: Dict[str, Any] = {"account": acct, "symbol": symbol, "product": product.upper(), "mode": "live" if live else "paper"}
            if target_quantity is not None:
                body["targetQuantity"] = int(target_quantity)
            else:
                body["targetLots"] = int(target_lots)  # type: ignore[arg-type]
            if order_type:
                body["orderType"] = order_type.upper()
            px = _price(price, "the limit price")
            if px is not None:
                body["price"] = px
                body.setdefault("orderType", "LIMIT")
            try:
                res = self._b.client._write("POST", "/v1/orders/to-target", body, key, timeout)
            except NotFound as e:
                if route is True or type(e) is not NotFound:
                    raise
                route = False  # an older Bridge answered 404: use the fallback
            else:
                d = res.get("data") or {}
                o = d.get("order")
                tq = d.get("targetQuantity")
                return TargetResult(symbol, float(d.get("currentQuantity") or 0), float(tq if tq is not None else (target_quantity or 0)), float(d.get("delta") or 0),
                                    str(d.get("action") or "NONE"), Order.from_dict(o, replayed=bool(res.get("replayed")), idempotency_key=key) if isinstance(o, Mapping) else None, "server")
        # client-side fallback
        if target_lots is not None:
            target = int(target_lots) * self._b.symbols.instrument(symbol).lot_size
        else:
            target = int(target_quantity)  # type: ignore[arg-type]
        current = self._current_quantity(acct, symbol, product.upper(), live)
        delta = target - current
        if delta == 0:
            return TargetResult(symbol, current, target, 0.0, "NONE", None, "client")
        side = "BUY" if delta > 0 else "SELL"
        o = self.place(symbol, side, quantity=abs(int(delta)), product=product, order_type=order_type, price=price, account=acct, live=live, idempotency_key=key, ref=ref, timeout=timeout,
                       client_order_id=None)
        return TargetResult(symbol, current, target, float(delta), side, o, "client")

    def _current_quantity(self, account: str, symbol: str, product: str, live: bool) -> float:
        """Net quantity now. Raises ``PositionUnknown`` when the positions cannot be read (never returns 0 then)."""
        try:
            r = self._b.client.positions(account, mode="live" if live else "paper")
        except (BridgeApiError, BridgeConnectionError) as e:
            err = PositionUnknown({"status": 0, "code": "POSITION_UNKNOWN", "detail": "The position of %s could not be read (%s), so no order was sized from it." % (symbol, e)}, None)
            raise err from e
        total = 0.0
        for p in r.get("data") or []:
            if isinstance(p, Mapping):
                pos = Position.from_dict(p)
                if pos.symbol == symbol and pos.product == product:
                    total += pos.net_qty
        return total

    def batch(self, orders: Sequence[Mapping[str, Any]], *, account: Optional[str] = None, live: bool = False, stop_on_error: bool = False, idempotency_key: Optional[str] = None,
              timeout: Optional[float] = None) -> BatchResult:
        """Place several independent orders, with a result for each.

        ``orders`` are dicts in the Bridge's field names (``symbol``, ``side``, ``lots`` or ``quantity``, ``product``,
        ``orderType``, ``price`` ...). Uses ``POST /v1/orders/batch`` when the Bridge has it. Otherwise the library sends
        them one at a time, each with its own idempotency key (``<key>-<index>``) and client order id; a refusal is
        recorded on its item and the rest still go (stop at the first with ``stop_on_error=True``).
        """
        if not orders:
            raise ValueError("batch needs at least one order")
        acct = account or self._b.account_for(live)
        key = idempotency_key or new_idempotency_key()
        prepared: List[Dict[str, Any]] = []
        for i, o in enumerate(orders):
            d = dict(o)
            self._check_live(d, live)
            d.pop("account", None)
            d["mode"] = "live" if live else "paper"
            d.setdefault("clientOrderId", new_client_order_id())
            prepared.append(d)
        route = self._b.supports("POST", "/v1/orders/batch")
        if route is not False:
            body = {"account": acct, "orders": prepared, "stopOnError": bool(stop_on_error)}
            try:
                res = self._b.client._write("POST", "/v1/orders/batch", body, key, timeout)
            except NotFound as e:
                if route is True or type(e) is not NotFound:
                    raise
            else:
                d = res.get("data") or {}
                sitems: List[BatchItem] = []
                for r in d.get("results") or []:
                    err = r.get("error") if isinstance(r.get("error"), Mapping) else {}
                    sitems.append(BatchItem(int(r.get("index", len(sitems))), bool(r.get("ok")), Order.from_dict(r["order"]) if isinstance(r.get("order"), Mapping) else None, err.get("code"), err.get("message")))
                return BatchResult(tuple(sitems), "server", (res.get("meta") or {}).get("batchId") or d.get("batchId"))
        items: List[BatchItem] = []
        stopped = False
        for i, d in enumerate(prepared):
            if stopped:
                items.append(BatchItem(i, False, None, "SKIPPED", "Not sent: an earlier order failed and stop_on_error is set."))
                continue
            d2 = dict(d, account=acct)
            try:
                placed = self.place_request(d2, live=live, idempotency_key="%s-%d" % (key, i), timeout=timeout)
                items.append(BatchItem(i, True, placed))
            except BridgeApiError as e:
                items.append(BatchItem(i, False, None, e.code, e.message))
                stopped = bool(stop_on_error)
        return BatchResult(tuple(items), "client")


class Tickets:
    """Orders waiting for a person to approve them on the Bridge's computer (``bridge.tickets``).

    Watching tickets needs an admin key and works from the Bridge's own computer only. This class never confirms or
    rejects a ticket: approval happens in the dashboard, by a person.
    """

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    def _list(self, state: str) -> List[Ticket]:
        try:
            r = self._b.client._get("/v1/tickets", {"state": state})
        except (ScopeRequired, LoopbackOnly) as e:
            raise e.with_hint("Watching tickets needs an admin key, from the computer the Bridge runs on. A script cannot approve a ticket: a person does that in the dashboard (Pending confirmations).")
        return [Ticket.from_dict(t) for t in (r.get("data") or []) if isinstance(t, Mapping)]

    def list(self, state: str = "open") -> List[Ticket]:
        """Open tickets (``state="open"``) or the ones declined in the last 15 minutes (``state="rejected"``)."""
        return self._list(state)

    def get(self, ticket_id: str) -> Optional[Ticket]:
        for state in ("open", "rejected"):
            for t in self._list(state):
                if t.ticket_id == ticket_id:
                    return t
        return None

    def status(self, ticket: Union[str, Ticket, Preview], *, last_seen: Optional[Ticket] = None, order_client_id: Optional[str] = None) -> TicketOutcome:
        """The state of one ticket now: ``pending``, ``rejected``, ``confirmed`` or ``expired``.

        A ticket still in the open list is ``pending``. A declined one is ``rejected`` (with the person's reason).
        One that left the list before it expired was approved (``confirmed``); one that left because its time ran out is
        ``expired``. When the order's ``client_order_id`` is known it is looked up to settle a doubt. ``unknown`` only
        when the ticket was never seen open (it may be older than the 15 minutes the declined list keeps).
        """
        tid = ticket if isinstance(ticket, str) else ticket.ticket_id
        if not tid:
            raise ValueError("that preview has no ticket: the order did not need a human confirmation")
        seen = last_seen if last_seen is not None else (ticket if isinstance(ticket, Ticket) else None)
        for t in self._list("open"):
            if t.ticket_id == tid:
                if t.expires_at is not None and t.expires_at <= self._b.now():
                    return TicketOutcome(tid, "expired", t)
                return TicketOutcome(tid, "pending", t)
        for t in self._list("rejected"):
            if t.ticket_id == tid:
                return TicketOutcome(tid, "rejected", t, None, t.reason)
        cid = order_client_id or (seen.order.get("clientOrderId") if seen is not None else None)
        if cid:
            o = self.reconcile_order(cid)
            if o is not None:
                return TicketOutcome(tid, "confirmed", seen, o)
        if seen is None:
            return TicketOutcome(tid, "unknown", None, None, "The ticket is neither open nor recently declined, and it was never seen open, so it cannot be said whether it was approved or timed out.")
        if seen.expires_at is not None and seen.expires_at <= self._b.now():
            return TicketOutcome(tid, "expired", seen)
        return TicketOutcome(tid, "confirmed", seen)

    def reconcile_order(self, client_order_id: str) -> Optional[Order]:
        try:
            return Order.from_dict(self._b.client.order_by_client_id(client_order_id)["data"])
        except NotFound:
            return None

    def wait(self, ticket: Union[str, Ticket, Preview], timeout: float = 90.0, *, poll: float = 1.0, order_client_id: Optional[str] = None) -> TicketOutcome:
        """Wait until a person has answered the ticket; return how it ended (``confirmed``, ``rejected`` or ``expired``).

        Tickets expire after about 60 seconds, so the default timeout covers that. Raises ``WaitTimeout`` if ``timeout``
        passes first. Needs an admin key on the Bridge's computer (see the class docstring).
        """
        tid = ticket if isinstance(ticket, str) else ticket.ticket_id
        if not tid:
            raise ValueError("that preview has no ticket: the order did not need a human confirmation")
        deadline = self._b._clock() + timeout
        seen: Optional[Ticket] = ticket if isinstance(ticket, Ticket) else None
        last = TicketOutcome(tid, "pending", seen)
        while True:
            out = self.status(tid, last_seen=seen, order_client_id=order_client_id)
            if out.ticket is not None:
                seen = out.ticket
            if out.is_final:
                return out
            last = out
            remaining = deadline - self._b._clock()
            if remaining <= 0:
                raise WaitTimeout("Ticket %s is still waiting for a person after %.0f s." % (tid, timeout), last)
            self._b._sleep(min(poll, remaining))
