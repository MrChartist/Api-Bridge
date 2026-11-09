"""Typed, immutable records for what the Bridge returns (standard library only).

Each record is a frozen dataclass built from the Bridge's JSON with ``Record.from_dict(d)``. Fields the Bridge adds
later are kept in ``raw`` so nothing is lost; fields it does not send are ``None``. Names are snake_case
(``changePct`` becomes ``change_pct``); ``to_dict()`` gives the wire names back.

Every market-data record carries ``freshness``: where the number came from and how current it is. Before you size an
order from a price, ask the label::

    quote = bridge.quote("NSE:RELIANCE")
    quote.freshness.require_realtime()      # raises NotRealtime for delayed, end-of-day, unofficial or stale data
    qty = int(50_000 // quote.ltp)

The wire shapes as ``TypedDict`` (for code that keeps plain dicts) are in ``mrchartist_bridge.models``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, Generic, Iterator, List, Mapping, Optional, Sequence, Tuple, TypeVar

from .errors import NotRealtime

IST = timezone(timedelta(hours=5, minutes=30), "IST")
"""India Standard Time (UTC+05:30, no daylight saving). Used for every timestamp this library creates."""

T = TypeVar("T")

_EMPTY: Mapping[str, Any] = {}


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> Optional[int]:
    n = _num(v)
    return None if n is None else int(n)


def parse_time(v: Any) -> Optional[datetime]:
    """Timestamp from ISO-8601 text, epoch seconds or epoch milliseconds (a number above 10^11). Always timezone-aware
    (IST when the text has no offset)."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=IST)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        secs = v / 1000.0 if abs(v) > 1e11 else float(v)
        return datetime.fromtimestamp(secs, tz=IST)
    if isinstance(v, str):
        s = v.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            d = datetime.fromisoformat(s)
        except ValueError:
            # Python 3.9 fromisoformat is strict about fractions: trim to microseconds.
            m = re.match(r"^(.*?\.\d{1,6})\d*(.*)$", s)
            if not m:
                return None
            try:
                d = datetime.fromisoformat(m.group(1) + m.group(2))
            except ValueError:
                return None
        return d if d.tzinfo else d.replace(tzinfo=IST)
    return None


def _d(v: Any) -> Mapping[str, Any]:
    return v if isinstance(v, Mapping) else _EMPTY


# ── freshness ──────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Freshness:
    """Where a value came from and how current it is (the Bridge's ``freshness`` label).

    ``data_class`` is the wire field ``class`` (``class`` is a Python keyword): ``realtime``, ``delayed`` or ``eod``.
    Orders, risk checks, paper fills and alerts may use real-time data only: call ``require_realtime()``.
    """

    source: str = "unknown"
    as_of: Optional[datetime] = None
    age_ms: Optional[int] = None
    stale: bool = False
    account_id: Optional[str] = None
    broker: Optional[str] = None
    provider: Optional[str] = None
    data_class: str = "realtime"
    delay_sec: int = 0
    official: bool = True
    confidence: str = "high"
    flags: Tuple[str, ...] = ()
    revalidating: bool = False
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Optional[Mapping[str, Any]]) -> "Freshness":
        d = _d(d)
        source = str(d.get("source") or "unknown")
        # An older Bridge sent no class: a broker, stream, cache or paper value is real time; anything else is not.
        default_class = "realtime" if source in ("stream", "cache", "broker", "paper") else "delayed"
        flags = d.get("flags")
        return cls(
            source=source,
            as_of=parse_time(d.get("asOf")),
            age_ms=_int(d.get("ageMs")),
            stale=bool(d.get("stale", False)),
            account_id=d.get("accountId"),
            broker=d.get("broker"),
            provider=d.get("provider"),
            data_class=str(d.get("class") or default_class),
            delay_sec=_int(d.get("delaySec")) or 0,
            official=bool(d.get("official", source in ("stream", "cache", "broker", "paper"))),
            confidence=str(d.get("confidence") or ("high" if default_class == "realtime" else "low")),
            flags=tuple(str(x) for x in flags) if isinstance(flags, (list, tuple)) else (),
            revalidating=bool(d.get("revalidating", False)),
            raw=dict(d),
        )

    @property
    def is_realtime(self) -> bool:
        """Real-time class (not delayed, not end-of-day). A real-time value can still be ``stale``: see ``is_fresh``."""
        return self.data_class == "realtime" and self.delay_sec == 0

    @property
    def is_delayed(self) -> bool:
        return self.data_class == "delayed"

    @property
    def is_eod(self) -> bool:
        return self.data_class == "eod"

    @property
    def is_fresh(self) -> bool:
        """Real time and not older than the freshness target for the read."""
        return self.is_realtime and not self.stale

    def usable_for_orders(self) -> bool:
        """True when this value may feed an order, a risk check, a paper fill or an alert."""
        return self.is_fresh and self.official and "unofficial" not in self.flags

    def require_realtime(self, *, allow_stale: bool = False, what: str = "this price") -> "Freshness":
        """Return ``self`` when the value is real-time, official and fresh; otherwise raise ``NotRealtime``.

        Call it before you size or price an order from the value. ``allow_stale=True`` accepts a real-time value that
        is older than the freshness target (a quiet instrument), never delayed or end-of-day data.
        """
        problems = []
        if not self.is_realtime:
            problems.append("it is %s data (%s, delay about %d s)" % (self.data_class, self.provider or self.source, self.delay_sec))
        if self.stale and not allow_stale:
            problems.append("it is stale (%s ms old)" % (self.age_ms if self.age_ms is not None else "unknown"))
        if not self.official or "unofficial" in self.flags:
            problems.append("its source is not official")
        if problems:
            raise NotRealtime("Cannot use %s for an order: %s. Orders, risk checks, paper fills and alerts accept real-time data only." % (what, "; ".join(problems)), self)
        return self

    def to_dict(self) -> Dict[str, Any]:
        out = {k: v for k, v in dict(self.raw).items()}
        out.update({"source": self.source, "class": self.data_class, "delaySec": self.delay_sec, "official": self.official, "confidence": self.confidence, "flags": list(self.flags), "stale": self.stale, "ageMs": self.age_ms})
        return out


def least_current(items: Sequence[Freshness]) -> Optional[Freshness]:
    """The least current label of several (delayed beats real-time, end-of-day beats delayed, stale beats fresh)."""
    rank = {"realtime": 0, "delayed": 1, "eod": 2}
    best: Optional[Freshness] = None
    for f in items:
        if best is None or (rank.get(f.data_class, 1), f.delay_sec, f.stale) > (rank.get(best.data_class, 1), best.delay_sec, best.stale):
            best = f
    return best


# ── market data ────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Ltp:
    """Last traded price of one symbol."""

    symbol: str
    ltp: float
    freshness: Freshness
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Ltp":
        return cls(symbol=str(d.get("symbol")), ltp=float(d["ltp"]) if d.get("ltp") is not None else float("nan"), freshness=Freshness.from_dict(d.get("freshness")), raw=dict(d))

    def require_realtime(self, **kw: Any) -> "Ltp":
        """Raise ``NotRealtime`` unless this price may feed an order. Returns ``self`` so it chains."""
        self.freshness.require_realtime(what="the price of %s" % self.symbol, **kw)
        return self

    def to_dict(self) -> Dict[str, Any]:
        return {"symbol": self.symbol, "ltp": self.ltp, "freshness": self.freshness.to_dict()}


@dataclass(frozen=True)
class Quote:
    """A quote: last price, day OHLC, change, volume, open interest and best bid/ask."""

    symbol: str
    ltp: float
    freshness: Freshness
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    """Previous close."""
    change: Optional[float] = None
    change_pct: Optional[float] = None
    volume: Optional[float] = None
    oi: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_qty: Optional[float] = None
    ask_qty: Optional[float] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Quote":
        return cls(
            symbol=str(d.get("symbol")),
            ltp=float(d["ltp"]) if d.get("ltp") is not None else float("nan"),
            freshness=Freshness.from_dict(d.get("freshness")),
            open=_num(d.get("open")), high=_num(d.get("high")), low=_num(d.get("low")), close=_num(d.get("close")),
            change=_num(d.get("change")), change_pct=_num(d.get("changePct")), volume=_num(d.get("volume")), oi=_num(d.get("oi")),
            bid=_num(d.get("bid")), ask=_num(d.get("ask")), bid_qty=_num(d.get("bidQty")), ask_qty=_num(d.get("askQty")),
            raw=dict(d),
        )

    @property
    def spread(self) -> Optional[float]:
        return None if self.bid is None or self.ask is None else self.ask - self.bid

    def require_realtime(self, **kw: Any) -> "Quote":
        self.freshness.require_realtime(what="the quote of %s" % self.symbol, **kw)
        return self

    def to_dict(self) -> Dict[str, Any]:
        out = {"symbol": self.symbol, "ltp": self.ltp, "open": self.open, "high": self.high, "low": self.low, "close": self.close, "change": self.change,
               "changePct": self.change_pct, "volume": self.volume, "oi": self.oi, "bid": self.bid, "ask": self.ask, "bidQty": self.bid_qty, "askQty": self.ask_qty}
        out["freshness"] = self.freshness.to_dict()
        return out


@dataclass(frozen=True)
class DepthLevel:
    price: float
    qty: float
    orders: Optional[int] = None


@dataclass(frozen=True)
class Depth:
    """Market depth: bids best first, asks best first."""

    symbol: str
    bids: Tuple[DepthLevel, ...]
    asks: Tuple[DepthLevel, ...]
    freshness: Freshness
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Depth":
        def lv(rows: Any) -> Tuple[DepthLevel, ...]:
            return tuple(DepthLevel(float(r.get("price") or 0), float(r.get("qty") or 0), _int(r.get("orders"))) for r in (rows or []) if isinstance(r, Mapping))

        return cls(str(d.get("symbol")), lv(d.get("bids")), lv(d.get("asks")), Freshness.from_dict(d.get("freshness")), dict(d))

    @property
    def best_bid(self) -> Optional[DepthLevel]:
        return self.bids[0] if self.bids else None

    @property
    def best_ask(self) -> Optional[DepthLevel]:
        return self.asks[0] if self.asks else None

    @property
    def spread(self) -> Optional[float]:
        return (self.asks[0].price - self.bids[0].price) if self.bids and self.asks else None

    def require_realtime(self, **kw: Any) -> "Depth":
        self.freshness.require_realtime(what="the depth of %s" % self.symbol, **kw)
        return self


@dataclass(frozen=True)
class Candle:
    """One bar. ``time`` is the bar's open as an IST-aware datetime; ``epoch`` the same in seconds."""

    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    oi: Optional[float] = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Candle":
        t = parse_time(d.get("time"))
        if t is None:
            raise ValueError("candle without a time")
        return cls(t, float(d["open"]), float(d["high"]), float(d["low"]), float(d["close"]), float(d.get("volume") or 0), _num(d.get("oi")))

    @property
    def epoch(self) -> int:
        return int(self.time.timestamp())

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"time": self.epoch, "open": self.open, "high": self.high, "low": self.low, "close": self.close, "volume": self.volume}
        if self.oi is not None:
            out["oi"] = self.oi
        return out


@dataclass(frozen=True)
class History:
    """Candles of one symbol, ascending, with the label of the data. ``partial`` is True when the broker could not
    supply the whole range. Iterable and sized: ``for c in history``, ``len(history)``, ``history[-1]``."""

    symbol: str
    interval: str
    candles: Tuple[Candle, ...]
    freshness: Freshness
    partial: bool = False
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "History":
        return cls(str(d.get("symbol")), str(d.get("interval")), tuple(Candle.from_dict(c) for c in d.get("candles") or []), Freshness.from_dict(d.get("freshness")), bool(d.get("partial", False)), dict(d))

    def __iter__(self) -> Iterator[Candle]:
        return iter(self.candles)

    def __len__(self) -> int:
        return len(self.candles)

    def __getitem__(self, i: Any) -> Any:
        return self.candles[i]

    def closes(self) -> List[float]:
        return [c.close for c in self.candles]

    def to_dataframe(self) -> Any:
        """pandas DataFrame (needs ``pip install mrchartist-bridge[pandas]``); see ``mrchartist_bridge.frames``."""
        from .frames import to_dataframe

        return to_dataframe(self)

    def to_csv(self) -> str:
        from .frames import to_csv

        return to_csv(self)


# ── portfolio ──────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Position:
    symbol: str
    product: str
    net_qty: float
    avg_price: float
    pnl: float
    ltp: Optional[float] = None
    realised_pnl: Optional[float] = None
    unrealised_pnl: Optional[float] = None
    charges: Optional[float] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Position":
        return cls(str(d.get("symbol")), str(d.get("product")), float(d.get("netQty") or 0), float(d.get("avgPrice") or 0), float(d.get("pnl") or 0), _num(d.get("ltp")),
                   _num(d.get("realisedPnl")), _num(d.get("unrealisedPnl")), _num(d.get("charges")), dict(d))

    @property
    def is_flat(self) -> bool:
        return self.net_qty == 0

    @property
    def side(self) -> Optional[str]:
        return "BUY" if self.net_qty > 0 else "SELL" if self.net_qty < 0 else None


@dataclass(frozen=True)
class Holding:
    symbol: str
    qty: float
    avg_price: float
    isin: Optional[str] = None
    ltp: Optional[float] = None
    pnl: Optional[float] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Holding":
        return cls(str(d.get("symbol")), float(d.get("qty") or 0), float(d.get("avgPrice") or 0), d.get("isin"), _num(d.get("ltp")), _num(d.get("pnl")), dict(d))


@dataclass(frozen=True)
class Funds:
    available_cash: float
    used_margin: float
    total_balance: Optional[float] = None
    collateral: Optional[float] = None
    withdrawable: Optional[float] = None
    realised_pnl: Optional[float] = None
    unrealised_pnl: Optional[float] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Funds":
        return cls(float(d.get("availableCash") or 0), float(d.get("usedMargin") or 0), _num(d.get("totalBalance")), _num(d.get("collateral")), _num(d.get("withdrawable")),
                   _num(d.get("realisedPnl")), _num(d.get("unrealisedPnl")), dict(d))


# ── orders ─────────────────────────────────────────────────────────────────────────────────────────────────────

TERMINAL_STATUSES = frozenset({"filled", "cancelled", "rejected", "expired"})
"""Order statuses that cannot change any more. ``outcome_unknown`` is not terminal: it needs reconciling."""


@dataclass(frozen=True)
class Order:
    """An order as the Bridge reports it (paper or live)."""

    order_id: str
    account_id: str
    mode: str
    symbol: str
    side: str
    quantity: int
    filled_quantity: int
    order_type: str
    product: str
    status: str
    client_order_id: Optional[str] = None
    broker: Optional[str] = None
    avg_price: Optional[float] = None
    price: Optional[float] = None
    trigger_price: Optional[float] = None
    validity: Optional[str] = None
    broker_status: Optional[str] = None
    status_message: Optional[str] = None
    source: Optional[str] = None
    tag: Optional[str] = None
    placed_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    legs: Tuple[Mapping[str, Any], ...] = field(default=(), compare=False, repr=False)
    replayed: bool = False
    """True when the Bridge returned a stored result for this idempotency key (nothing new was placed)."""
    idempotency_key: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any], *, replayed: bool = False, idempotency_key: Optional[str] = None) -> "Order":
        return cls(
            order_id=str(d.get("orderId")), account_id=str(d.get("accountId")), mode=str(d.get("mode") or "paper"), symbol=str(d.get("symbol")), side=str(d.get("side")),
            quantity=_int(d.get("quantity")) or 0, filled_quantity=_int(d.get("filledQuantity")) or 0, order_type=str(d.get("orderType")), product=str(d.get("product")),
            status=str(d.get("status")), client_order_id=d.get("clientOrderId"), broker=d.get("broker"), avg_price=_num(d.get("avgPrice")), price=_num(d.get("price")),
            trigger_price=_num(d.get("triggerPrice")), validity=d.get("validity"), broker_status=d.get("brokerStatus"), status_message=d.get("statusMessage"), source=d.get("source"),
            tag=d.get("tag"), placed_at=parse_time(d.get("placedAt")), updated_at=parse_time(d.get("updatedAt")), legs=tuple(l for l in (d.get("legs") or []) if isinstance(l, Mapping)),
            replayed=replayed, idempotency_key=idempotency_key, raw=dict(d),
        )

    @property
    def is_live(self) -> bool:
        return self.mode == "live"

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def is_filled(self) -> bool:
        return self.status == "filled"

    @property
    def is_open(self) -> bool:
        return self.status in ("pending", "open", "trigger_pending", "partially_filled")

    @property
    def remaining_quantity(self) -> int:
        return max(0, self.quantity - self.filled_quantity)


@dataclass(frozen=True)
class Trade:
    trade_id: str
    order_id: str
    symbol: str
    side: str
    qty: float
    price: float
    account_id: Optional[str] = None
    mode: Optional[str] = None
    product: Optional[str] = None
    charges: Optional[float] = None
    traded_at: Optional[datetime] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Trade":
        return cls(str(d.get("tradeId")), str(d.get("orderId")), str(d.get("symbol")), str(d.get("side")), float(d.get("qty") or 0), float(d.get("price") or 0), d.get("accountId"),
                   d.get("mode"), d.get("product"), _num(d.get("charges")), parse_time(d.get("tradedAt")), dict(d))


@dataclass(frozen=True)
class Check:
    """One check of an order preview. ``severity`` is ``block`` (the order would be refused) or ``warn``."""

    code: str
    message: str
    severity: str


@dataclass(frozen=True)
class Preview:
    """What the Bridge would do with an order, without placing it."""

    ok: bool
    mode: str
    checks: Tuple[Check, ...]
    requires_human_confirmation: bool
    quantity: Optional[int] = None
    estimated_value: Optional[float] = None
    ltp: Optional[float] = None
    margin_required: Optional[float] = None
    ticket_id: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Preview":
        checks = tuple(Check(str(c.get("code")), str(c.get("message")), str(c.get("severity"))) for c in d.get("checks") or [] if isinstance(c, Mapping))
        margin = _d(d.get("margin"))
        return cls(bool(d.get("ok")), str(d.get("mode") or "paper"), checks, bool(d.get("requiresHumanConfirmation")), _int(d.get("quantity")), _num(d.get("estimatedValue")),
                   _num(d.get("ltp")), _num(margin.get("required")), d.get("ticketId"), dict(d))

    @property
    def blocks(self) -> Tuple[Check, ...]:
        return tuple(c for c in self.checks if c.severity == "block")

    @property
    def warnings(self) -> Tuple[Check, ...]:
        return tuple(c for c in self.checks if c.severity == "warn")


@dataclass(frozen=True)
class Ticket:
    """An order waiting for a person to approve it on the Bridge's computer."""

    ticket_id: str
    order: Mapping[str, Any] = field(compare=False)
    source: str
    created_at: Optional[datetime]
    expires_at: Optional[datetime]
    status: str = "open"
    client: Optional[str] = None
    reason: Optional[str] = None
    checks: Tuple[Check, ...] = ()
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Ticket":
        checks = tuple(Check(str(c.get("code")), str(c.get("message")), str(c.get("severity"))) for c in d.get("checks") or [] if isinstance(c, Mapping))
        return cls(str(d.get("ticketId")), dict(_d(d.get("order"))), str(d.get("source") or ""), parse_time(d.get("createdAt")), parse_time(d.get("expiresAt")), str(d.get("status") or "open"),
                   d.get("client"), d.get("reason"), checks, dict(d))


@dataclass(frozen=True)
class TicketOutcome:
    """How a ticket ended. ``state`` is ``pending`` (still waiting), ``confirmed`` (a person approved it),
    ``rejected`` (a person declined; ``reason`` may say why), ``expired`` (nobody answered in time) or ``unknown`` (the ticket
    was never seen open and is gone: it cannot be told apart any more)."""

    ticket_id: str
    state: str
    ticket: Optional[Ticket] = None
    order: Optional[Order] = None
    reason: Optional[str] = None

    @property
    def is_confirmed(self) -> bool:
        return self.state == "confirmed"

    @property
    def is_final(self) -> bool:
        return self.state != "pending"


# ── reference data ─────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Instrument:
    symbol: str
    exchange: str
    kind: str
    underlying: str
    lot_size: int
    tick_size: float
    name: Optional[str] = None
    expiry: Optional[date] = None
    strike: Optional[float] = None
    right: Optional[str] = None
    freeze_qty: Optional[int] = None
    isin: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Instrument":
        exp = d.get("expiry")
        try:
            expiry = date.fromisoformat(exp[:10]) if isinstance(exp, str) and exp else None
        except ValueError:
            expiry = None
        return cls(str(d.get("symbol")), str(d.get("exchange")), str(d.get("kind")), str(d.get("underlying")), _int(d.get("lotSize")) or 1, _num(d.get("tickSize")) or 0.05, d.get("name"), expiry,
                   _num(d.get("strike")), d.get("right"), _int(d.get("freezeQty")), d.get("isin"), dict(d))

    def units(self, lots: int) -> int:
        """Units (quantity) in ``lots`` lots."""
        return lots * self.lot_size


@dataclass(frozen=True)
class Source:
    """A data source (your broker accounts, a free provider or a plugin) and how its answers are labelled."""

    id: str
    name: str
    kind: str
    tier: str
    enabled: bool
    configured: bool
    data_class: str
    delay_sec: Optional[int]
    official: bool
    capabilities: Tuple[str, ...]
    health_state: Optional[str] = None
    needs_key: bool = False
    flags: Tuple[str, ...] = ()
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Source":
        return cls(str(d.get("id")), str(d.get("name") or d.get("id")), str(d.get("kind")), str(d.get("tier")), bool(d.get("enabled")), bool(d.get("configured")), str(d.get("class") or "realtime"),
                   _int(d.get("delaySec")), bool(d.get("official")), tuple(d.get("capabilities") or ()), _d(d.get("health")).get("state"), bool(d.get("needsKey")), tuple(d.get("flags") or ()), dict(d))

    @property
    def is_realtime(self) -> bool:
        return self.data_class == "realtime"


@dataclass(frozen=True)
class Account:
    id: str
    broker: str
    label: str
    enabled: bool
    session_state: Optional[str]
    live_allowed: bool
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Account":
        return cls(str(d.get("id")), str(d.get("broker")), str(d.get("label") or d.get("id")), bool(d.get("enabled")), _d(d.get("session")).get("state"), bool(d.get("liveAllowedByConfig")), dict(d))

    @property
    def is_paper(self) -> bool:
        return self.broker == "paper"


@dataclass(frozen=True)
class Health:
    """``GET /v1/health`` (no key needed)."""

    status: str
    version: str
    api_version: str
    demo: bool = False
    data_notice: Optional[str] = None
    uptime_seconds: Optional[int] = None
    starting: bool = False
    """True while the Bridge is still loading its book (reads of positions and orders wait for it)."""
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Health":
        return cls(str(d.get("status")), str(d.get("version")), str(d.get("apiVersion")), bool(d.get("demo", False)), d.get("dataNotice"), _int(d.get("uptimeSeconds")), bool(d.get("startup")), dict(d))

    @property
    def ok(self) -> bool:
        return self.status == "ok"


@dataclass(frozen=True)
class Ping:
    """Result of ``bridge.ping()``: the Bridge answered, and how fast."""

    ok: bool
    latency_ms: float
    version: str
    api_version: str
    demo: bool
    base_url: str
    authenticated: Optional[bool] = None
    """None when the key was not checked (``ping(check_key=False)``)."""


# ── result lists ───────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ItemProblem:
    """A symbol (or order) a multi-item read could not answer; the rest of the call still succeeded."""

    code: str
    message: str
    symbol: Optional[str] = None


class Result(Sequence[T], Generic[T]):
    """A list of records plus what came with it: ``meta`` (request id, cursor ...) and ``errors`` (items that failed).

    Behaves like a read-only list. ``result.freshness`` is the least current label among the items;
    ``result.raise_for_errors()`` raises when any item failed; ``result.by_symbol()`` indexes by symbol.
    """

    def __init__(self, items: Sequence[T], meta: Optional[Mapping[str, Any]] = None, errors: Optional[Sequence[ItemProblem]] = None) -> None:
        self._items: Tuple[T, ...] = tuple(items)
        self.meta: Mapping[str, Any] = dict(meta or {})
        self.errors: Tuple[ItemProblem, ...] = tuple(errors or ())

    def __len__(self) -> int:
        return len(self._items)

    def __getitem__(self, i: Any) -> Any:
        return self._items[i]

    def __iter__(self) -> Iterator[T]:
        return iter(self._items)

    def __repr__(self) -> str:
        return "Result(%d items, %d errors)" % (len(self._items), len(self.errors))

    @property
    def next_cursor(self) -> Optional[str]:
        return self.meta.get("nextCursor")

    @property
    def freshness(self) -> Optional[Freshness]:
        return least_current([f for f in (getattr(i, "freshness", None) for i in self._items) if isinstance(f, Freshness)])

    def by_symbol(self) -> Dict[str, T]:
        return {getattr(i, "symbol"): i for i in self._items if hasattr(i, "symbol")}

    def map(self, fn: Callable[[T], Any]) -> List[Any]:
        return [fn(i) for i in self._items]

    def require_realtime(self, **kw: Any) -> "Result[T]":
        """``NotRealtime`` unless every item is real-time and fresh."""
        for i in self._items:
            f = getattr(i, "freshness", None)
            if isinstance(f, Freshness):
                f.require_realtime(what="the price of %s" % getattr(i, "symbol", "an item"), **kw)
        return self

    def raise_for_errors(self) -> "Result[T]":
        if self.errors:
            from .errors import BridgeError

            raise BridgeError("; ".join("%s %s: %s" % (e.symbol or "", e.code, e.message) for e in self.errors))
        return self

    def to_dataframe(self) -> Any:
        from .frames import to_dataframe

        return to_dataframe(self)


def problems_from(errors: Any) -> Tuple[ItemProblem, ...]:
    out = []
    for e in errors or []:
        if isinstance(e, Mapping):
            out.append(ItemProblem(str(e.get("code")), str(e.get("message")), e.get("symbol") or e.get("input") or e.get("orderId")))
    return tuple(out)
