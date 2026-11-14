"""Typed shapes of the Bridge's JSON as TypedDicts (written against docs/openapi.yaml), for code that keeps plain dicts.
The typed objects the Bridge class returns are in records.py. For type checkers and editors only:
the client returns plain dicts."""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional, Union

if sys.version_info >= (3, 11):  # pragma: no cover
    from typing import Literal, NotRequired, TypedDict
else:  # pragma: no cover
    from typing import Literal, TypedDict

    try:
        from typing_extensions import NotRequired
    except ImportError:  # typing_extensions is optional
        NotRequired = Optional  # type: ignore[assignment,misc]

Exchange = Literal["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"]
Interval = Literal["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w", "1M"]
StreamMode = Literal["ltp", "quote", "depth"]
Mode = Literal["paper", "live"]
Product = Literal["CNC", "INTRADAY", "MARGIN", "MTF"]
OrderType = Literal["LIMIT", "MARKET", "SL", "SL-M"]
OrderStatus = Literal["pending", "open", "trigger_pending", "partially_filled", "filled", "cancelled", "rejected", "expired", "outcome_unknown"]


class Freshness(TypedDict):
    source: Literal["stream", "cache", "broker", "paper"]
    asOf: str
    ageMs: int
    stale: bool
    accountId: NotRequired[Optional[str]]
    broker: NotRequired[Optional[str]]


class Meta(TypedDict):
    requestId: str
    nextCursor: NotRequired[Optional[str]]
    accountId: NotRequired[Optional[str]]
    mode: NotRequired[Mode]
    freshness: NotRequired[Freshness]


class ItemError(TypedDict):
    code: str
    message: str
    symbol: NotRequired[str]
    orderId: NotRequired[str]
    input: NotRequired[str]


class Envelope(TypedDict):
    data: Any
    meta: Meta
    errors: NotRequired[List[ItemError]]


class WriteResult(Envelope):
    replayed: bool
    idempotency_key: str


class LtpItem(TypedDict):
    symbol: str
    ltp: float
    freshness: Freshness


class QuoteItem(LtpItem):
    open: Optional[float]
    high: Optional[float]
    low: Optional[float]
    close: Optional[float]
    change: Optional[float]
    changePct: Optional[float]
    volume: Optional[float]
    oi: Optional[float]
    bid: Optional[float]
    ask: Optional[float]
    bidQty: Optional[float]
    askQty: Optional[float]


class Candle(TypedDict):
    time: int  # bar open, epoch seconds
    open: float
    high: float
    low: float
    close: float
    volume: float
    oi: NotRequired[float]


class HistoryResult(TypedDict):
    symbol: str
    interval: Interval
    candles: List[Candle]
    freshness: Freshness
    partial: bool


class ChainLeg(TypedDict):
    symbol: str
    ltp: Optional[float]
    bid: Optional[float]
    ask: Optional[float]
    oi: Optional[float]
    oiChange: Optional[float]
    volume: Optional[float]
    iv: Optional[float]  # percent
    delta: Optional[float]
    gamma: Optional[float]
    theta: Optional[float]
    vega: Optional[float]
    greeksSource: Optional[Literal["broker", "computed"]]


class ChainRow(TypedDict):
    strike: float
    ce: Optional[ChainLeg]
    pe: Optional[ChainLeg]


class OptionChain(TypedDict):
    underlying: str
    expiry: str
    underlyingLtp: Optional[float]
    atmStrike: Optional[float]
    lotSize: Optional[int]
    rows: List[ChainRow]
    freshness: Freshness


class OrderRequest(TypedDict):
    """Send exactly one of quantity (units) or lots. There is no default product or order type."""

    account: str
    symbol: str
    side: Literal["BUY", "SELL"]
    product: Product
    orderType: OrderType
    quantity: NotRequired[int]
    lots: NotRequired[int]
    price: NotRequired[float]
    triggerPrice: NotRequired[float]
    validity: NotRequired[Literal["DAY", "IOC"]]
    marketProtectionPct: NotRequired[float]
    disclosedQuantity: NotRequired[int]
    mode: NotRequired[Mode]  # paper unless "live"
    clientOrderId: NotRequired[str]
    tag: NotRequired[str]
    algoId: NotRequired[str]
    confirmToken: NotRequired[str]


class OrderResult(TypedDict):
    orderId: str
    clientOrderId: Optional[str]
    accountId: str
    broker: str
    mode: Mode
    symbol: str
    side: Literal["BUY", "SELL"]
    quantity: int
    filledQuantity: int
    orderType: OrderType
    product: Product
    status: OrderStatus
    legs: List[Dict[str, Any]]
    placedAt: str
    updatedAt: str


StreamMessage = Dict[str, Any]
"""Server stream message: heartbeat, snapshot, tick, order, status, error or go_away (see docs/asyncapi.yaml)."""

Json = Union[Dict[str, Any], List[Any], str, int, float, bool, None]
