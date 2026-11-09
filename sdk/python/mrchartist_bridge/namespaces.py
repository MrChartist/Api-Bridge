"""Smaller groups of calls on ``Bridge``: ``symbols``, ``calendar``, ``hooks`` and ``xl``.

Several of these use routes newer Bridges add (``symbols/resolve``, ``calendar/*``, ``hooks/{id}/signals`` and
``hooks/{id}/test``). Each call checks the Bridge's route list (``GET /v1/meta``) first and, where a fallback is
possible, uses it; otherwise it raises ``FeatureUnavailable`` saying which route is missing. The request and reply
shapes of the newer routes follow the Bridge's published OpenAPI (``docs/openapi.yaml``) as of this library version;
the calls return the reply's ``data`` as plain Python values until those shapes are final.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Tuple, Union

from .errors import NotFound, ValidationFailed
from .records import Instrument, Result, problems_from

if TYPE_CHECKING:  # pragma: no cover
    from .bridge import Bridge


@dataclass(frozen=True)
class Resolved:
    """What a symbol text resolved to. ``canonical`` is None when it is ambiguous: look at ``candidates``."""

    input: str
    canonical: Optional[str]
    candidates: Tuple[str, ...] = ()
    rule: Optional[str] = None
    confidence: Optional[str] = None
    via: str = "server"
    """``server`` (``/v1/symbols/resolve``) or ``client`` (convert, then search)."""

    def require(self) -> str:
        """The canonical symbol, or ``SymbolNotFound`` (with the candidates in the message) when it is ambiguous or unknown."""
        if self.canonical:
            return self.canonical
        from .errors import SymbolNotFound

        more = (" Did you mean: %s?" % ", ".join(self.candidates[:5])) if self.candidates else ""
        raise SymbolNotFound({"status": 404, "code": "SYMBOL_NOT_FOUND", "detail": "Could not resolve %r to one symbol.%s" % (self.input, more)})


class Symbols:
    """Symbol lookup and conversion: ``bridge.symbols``."""

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    def instrument(self, symbol: str, *, include: Optional[str] = None) -> Instrument:
        """Lot size, tick size, expiry, strike ... of one canonical symbol."""
        return Instrument.from_dict(self._b.client.instrument(symbol, include=include)["data"])

    def search(self, q: str, *, exchange: Optional[str] = None, kind: Optional[str] = None, underlying: Optional[str] = None, expiry: Optional[str] = None, limit: Optional[int] = None) -> Result[Instrument]:
        r = self._b.client.search_instruments(q, exchange=exchange, kind=kind, underlying=underlying, expiry=expiry, limit=limit)
        return Result([Instrument.from_dict(i) for i in r.get("data") or []], r.get("meta"), problems_from(r.get("errors")))

    def convert(self, text: str, *, from_format: Optional[str] = None, exchange: Optional[str] = None, broker: Optional[str] = None) -> Dict[str, Any]:
        """``{"input", "canonical", "aliases"}`` for any symbol text the Bridge understands (chart tickers, compact symbols ...)."""
        return self._b.client.convert_symbol(text, from_format=from_format, exchange=exchange, broker=broker)["data"]

    def resolve(self, text: str) -> Resolved:
        """Turn free text (``"nifty 25000 ce"``, ``"NSE:NIFTY1!"``, ``"reliance"``) into a canonical symbol.

        Uses ``GET /v1/symbols/resolve`` when the Bridge has it. Otherwise: ``symbols/convert`` for anything that already
        looks like a symbol, then ``instruments/search`` for the rest (several matches: ``canonical`` is None and
        ``candidates`` lists them).
        """
        if self._b.supports("GET", "/v1/symbols/resolve"):
            d = self._b.client._get("/v1/symbols/resolve", {"input": text, "explain": 1}).get("data") or {}
            cands = tuple(str(c.get("symbol") if isinstance(c, Mapping) else c) for c in (d.get("candidates") or []))
            return Resolved(text, d.get("canonical"), cands, d.get("rule"), d.get("confidence"), "server")
        try:
            d = self.convert(text)
            if d.get("canonical"):
                return Resolved(text, str(d["canonical"]), (str(d["canonical"]),), "convert", "high", "client")
        except (ValidationFailed, NotFound):
            pass
        found = self.search(text, limit=10)
        cands = tuple(i.symbol for i in found)
        exact = [i for i in found if i.symbol.upper() == text.upper() or (i.underlying.upper() == text.upper() and i.kind in ("EQ", "INDEX"))]
        if len(exact) == 1:
            return Resolved(text, exact[0].symbol, cands, "search-exact", "medium", "client")
        if len(cands) == 1:
            return Resolved(text, cands[0], cands, "search-single", "medium", "client")
        return Resolved(text, None, cands, "search", "low", "client")


class Calendar:
    """Exchange holidays, sessions and whether the market is open: ``bridge.calendar``. Needs a Bridge with
    ``/v1/calendar/*``; older Bridges raise ``FeatureUnavailable``."""

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    def _call(self, path: str, what: str, **query: Any) -> Any:
        self._b.require_route("GET", path, what)
        return self._b.client._get(path, query).get("data")

    def holidays(self, year: int, exchange: str = "NSE") -> Any:
        return self._call("/v1/calendar/holidays", "the holiday calendar", year=year, exchange=exchange)

    def sessions(self, date: str) -> Any:
        """Session timings for an ISO date (``"2026-11-09"``)."""
        return self._call("/v1/calendar/sessions", "session timings", date=date)

    def status(self) -> Any:
        """Is the exchange open now, and when does it open or close next."""
        return self._call("/v1/calendar/status", "the market status")


class Hooks:
    """Alert hooks (TradingView, ChartInk, GoCharting, your own scripts): ``bridge.hooks``. Admin key, from the Bridge's computer."""

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    def list(self) -> List[Dict[str, Any]]:
        """Configured hooks (never their secret tokens)."""
        return list(self._b.client._get("/v1/hooks").get("data") or [])

    def signals(self, hook_id: str, *, since: Optional[str] = None, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Result[Dict[str, Any]]:
        """Recent signals a hook received, and what became of each (``GET /v1/hooks/{id}/signals``)."""
        path = "/v1/hooks/%s/signals" % urllib.parse.quote(hook_id, safe="")
        self._b.require_route("GET", "/v1/hooks/:hookId/signals", "the hook signal log")
        r = self._b.client._get(path, {"since": since, "status": status, "limit": limit, "cursor": cursor})
        return Result(list(r.get("data") or []), r.get("meta"), problems_from(r.get("errors")))

    def test(self, hook_id: str, message: Optional[Union[str, Mapping[str, Any]]] = None) -> Any:
        """Send a test alert through a hook's own checks without placing an order (``POST /v1/hooks/{id}/test``).
        ``message`` is an alert body (``alerts.AlertMessage`` or a dict); with none, the hook's template is used."""
        self._b.require_route("POST", "/v1/hooks/:hookId/test", "the hook test")
        body: Dict[str, Any] = {}
        if message is not None:
            body["message"] = message.to_dict() if hasattr(message, "to_dict") else message  # type: ignore[union-attr]
        return self._b.client._post("/v1/hooks/%s/test" % urllib.parse.quote(hook_id, safe=""), body).get("data")


class Xl:
    """The spreadsheet routes (``/xl/*``): plain text and CSV for Excel, Google Sheets and AmiBroker: ``bridge.xl``.

    Read-only; nothing under ``/xl`` can place an order. ``formula()`` builds the cell formula to paste into a sheet.
    """

    def __init__(self, bridge: "Bridge") -> None:
        self._b = bridge

    def _text(self, path: str, **query: Any) -> str:
        body = self._b.client.request("GET", path, query=query).body
        return body if isinstance(body, str) else str(body)

    def ltp(self, symbol: str) -> float:
        """The price, as the number a ``=WEBSERVICE`` cell would show."""
        return float(self._text("/xl/ltp", symbol=symbol).strip())

    def quote(self, symbol: str, field: str = "ltp") -> Union[float, str]:
        """One quote field (ltp, open, high, low, close, change, changePct, volume, oi, bid, ask)."""
        t = self._text("/xl/quote", symbol=symbol, field=field).strip()
        try:
            return float(t)
        except ValueError:
            return t

    def chain(self, underlying: str, expiry: str, *, format: str = "csv") -> Any:  # noqa: A002
        """One row per strike: CSV text (``format="csv"``) or a list of records (``"json"``)."""
        body = self._b.client.request("GET", "/xl/chain", query={"underlying": underlying, "expiry": expiry, "format": format}).body
        return body

    def history(self, symbol: str, interval: str, *, from_: Optional[str] = None, to: Optional[str] = None, layout: str = "standard") -> str:
        """Candles as CSV text (``layout="amibroker"`` for the AmiBroker import format)."""
        return self._text("/xl/history", symbol=symbol, interval=interval, **{"from": from_, "to": to, "layout": layout})

    def url(self, path: str, **query: Any) -> str:
        """The full URL of an /xl route, with NO key in it."""
        from .client import to_query

        return self._b.client.base_url + path + to_query(query)

    def formula(self, kind: str = "ltp", *, cell: str = "A1", field: str = "ltp", key_placeholder: str = "YOUR_READ_ONLY_KEY") -> str:
        """An Excel ``=WEBSERVICE(...)`` formula for ``kind`` (``ltp`` or ``quote``), reading the symbol from ``cell``.

        The key is a placeholder: Excel cannot send headers, so ``/xl`` accepts ``?key=`` only for read-only keys made
        with ``mc-bridge keys create --scope read --allow-query``. Never put a key that can trade into a spreadsheet.
        """
        if kind not in ("ltp", "quote"):
            raise ValueError("kind must be ltp or quote")
        base = self._b.client.base_url + "/xl/" + kind
        extra = "" if kind == "ltp" else "&field=%s" % urllib.parse.quote(field)
        return '=WEBSERVICE("%s?symbol="&ENCODEURL(%s)&"%s&key=%s")' % (base, cell, extra, key_placeholder)
