"""Python trading strategies for the Mr. Chartist API Bridge (docs/STRATEGIES-PYTHON.md).

A strategy is a small class in a ``.py`` file in your Bridge's ``strategies`` folder::

    from mrchartist_bridge.strategy import Strategy, Param

    class Breakout(Strategy):
        name = "NIFTY breakout"
        symbols = ["NSE:NIFTY"]
        timeframes = ["1m"]
        params = {"lots": Param(1, min=1, max=10, help="Lots per order")}

        def on_bar(self, bar, timeframe):
            if bar.close > bar.open and not self.position("NFO:NIFTY-2026-11-23-FUT"):
                self.buy("NFO:NIFTY-2026-11-23-FUT", lots=self.p.lots)

The Bridge starts it as a child process (``python3 -m mrchartist_bridge strategy run <file>``) with an API key made
for this one run, limited to the account you chose. Every order goes through the Bridge's REST order API, so the
kill switch, per-order limits, daily limits and the paper/live gates apply exactly as they do to any other script.
Orders are paper unless the Bridge started the strategy in live mode after its live checks and your second
confirmation.

Standard library only (Python 3.9+), like the rest of the SDK.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import math
import os
import queue
import random
import signal
import string
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

from .client import BridgeClient
from .errors import BridgeApiError, BridgeConnectionError

__all__ = [
    "Bar",
    "ConfigError",
    "Param",
    "Quote",
    "Strategy",
    "StrategyLogger",
    "TIMEFRAMES",
    "build_book",
    "chain_legs",
    "option_parts",
    "describe_file",
    "load_strategy_class",
    "main",
    "run_file",
]

#: A line on stdout that starts with this is a message for the Bridge's runner (logs, heartbeats), not plain output.
PROTOCOL_PREFIX = "@@mcb "
IST = timezone(timedelta(hours=5, minutes=30))
#: Bar sizes on_bar can be asked for, in seconds.
TIMEFRAMES: Dict[str, int] = {"15s": 15, "30s": 30, "1m": 60, "2m": 120, "3m": 180, "5m": 300, "10m": 600, "15m": 900, "30m": 1800, "1h": 3600}
HEARTBEAT_S = 5.0
#: Exit codes the runner reads: 0 finished or stopped, 1 crashed (it may restart), 3 the file or params are wrong (no restart).
EXIT_OK, EXIT_CRASH, EXIT_CONFIG = 0, 1, 3
#: Exit code 4: the Bridge refused the strategy for a reason a restart cannot fix (kill switch, a daily limit, the key's
#: scope or account), so the runner does not restart it.
EXIT_REFUSED = 4
REFUSALS_THAT_STOP = frozenset({"KILL_SWITCH_ACTIVE", "DAILY_LIMIT_REACHED", "PAPER_ONLY", "SCOPE_REQUIRED", "ACCOUNT_FORBIDDEN", "UNAUTHENTICATED", "CANNOT_TRADE", "AUTOMATION_NOT_ALLOWED"})
_ID_CHARS = string.ascii_lowercase + string.digits


class ConfigError(Exception):
    """Raise from on_start when the settings cannot work (the runner then does not restart the strategy)."""


# ───────────────────────────── params ─────────────────────────────


class Param:
    """A setting with a typed default. The dashboard draws a form from these; values are checked before the start.

    ``Param(1, min=1, max=10)`` is an int, ``Param(0.5)`` a float, ``Param(True)`` a bool, ``Param("09:20")`` a
    string, ``Param("both", choices=["both", "calls", "puts"])`` a choice.
    """

    KINDS = ("int", "float", "bool", "str", "choice")

    def __init__(self, default: Any, *, min: Optional[float] = None, max: Optional[float] = None, choices: Optional[Sequence[Any]] = None, step: Optional[float] = None, help: str = "", label: str = "", kind: Optional[str] = None) -> None:  # noqa: A002
        if kind is None:
            if choices is not None:
                kind = "choice"
            elif isinstance(default, bool):
                kind = "bool"
            elif isinstance(default, int):
                kind = "int"
            elif isinstance(default, float):
                kind = "float"
            elif isinstance(default, str):
                kind = "str"
            else:
                raise TypeError("Param default must be an int, float, bool or str (got %s)" % type(default).__name__)
        if kind not in self.KINDS:
            raise ValueError("Param kind must be one of %s" % ", ".join(self.KINDS))
        self.kind = kind
        self.min = min
        self.max = max
        self.choices = list(choices) if choices is not None else None
        self.step = step
        self.help = help
        self.label = label
        if kind == "choice" and (not self.choices or default not in self.choices):
            raise ValueError("A choice Param needs choices that include its default")
        self.default = self.coerce(default)

    def coerce(self, value: Any) -> Any:
        """The value as this param's type, or ValueError saying why not."""
        k = self.kind
        if k == "bool":
            if isinstance(value, bool):
                return value
            if isinstance(value, str) and value.lower() in ("true", "false", "1", "0", "yes", "no", "on", "off"):
                return value.lower() in ("true", "1", "yes", "on")
            if value in (0, 1):
                return bool(value)
            raise ValueError("must be true or false")
        if k == "choice":
            if value in self.choices:  # type: ignore[operator]
                return value
            raise ValueError("must be one of %s" % ", ".join(str(c) for c in self.choices or []))
        if k == "str":
            if not isinstance(value, str):
                raise ValueError("must be text")
            if len(value) > 200:
                raise ValueError("must be at most 200 characters")
            return value
        if isinstance(value, bool):
            raise ValueError("must be a number")
        if isinstance(value, str):
            value = value.strip()
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise ValueError("must be a number") from None
        if not math.isfinite(num):
            raise ValueError("must be a finite number")
        if k == "int":
            if num != int(num):
                raise ValueError("must be a whole number")
            num = int(num)
        if self.min is not None and num < self.min:
            raise ValueError("must be at least %s" % _num_text(self.min))
        if self.max is not None and num > self.max:
            raise ValueError("must be at most %s" % _num_text(self.max))
        return num

    def to_json(self, name: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": name, "kind": self.kind, "default": self.default}
        for key in ("min", "max", "step"):
            if getattr(self, key) is not None:
                out[key] = getattr(self, key)
        if self.choices is not None:
            out["choices"] = list(self.choices)
        if self.help:
            out["help"] = self.help
        if self.label:
            out["label"] = self.label
        return out


def _num_text(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


class Params:
    """Resolved params with attribute access: ``self.p.lots``."""

    def __init__(self, values: Mapping[str, Any]) -> None:
        self.__dict__.update(values)

    def as_dict(self) -> Dict[str, Any]:
        return dict(self.__dict__)

    def __repr__(self) -> str:
        return "Params(%s)" % ", ".join("%s=%r" % kv for kv in sorted(self.__dict__.items()))


def resolve_params(declared: Mapping[str, Param], given: Optional[Mapping[str, Any]]) -> Tuple[Dict[str, Any], List[str]]:
    """Defaults overlaid with ``given``. Returns (values, problems); unknown names are problems too."""
    values = {name: p.default for name, p in declared.items()}
    problems: List[str] = []
    for name, raw in (given or {}).items():
        if name not in declared:
            problems.append("%s: not a param of this strategy" % name)
            continue
        try:
            values[name] = declared[name].coerce(raw)
        except ValueError as e:
            problems.append("%s: %s" % (name, e))
    return values, problems


# ───────────────────────────── market data shapes ─────────────────────────────


class Quote(dict):
    """A tick from the Bridge stream (a dict) that also reads as attributes: ``quote.ltp``, ``quote.symbol``."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


class Bar:
    """One finished bar built from live ticks (or read from history)."""

    __slots__ = ("symbol", "timeframe", "time", "open", "high", "low", "close", "volume", "ticks")

    def __init__(self, symbol: str, timeframe: str, time: int, open: float, high: float, low: float, close: float, volume: float = 0.0, ticks: int = 0) -> None:  # noqa: A002
        self.symbol, self.timeframe, self.time = symbol, timeframe, time
        self.open, self.high, self.low, self.close, self.volume, self.ticks = open, high, low, close, volume, ticks

    def __repr__(self) -> str:
        return "Bar(%s %s %d o=%s h=%s l=%s c=%s)" % (self.symbol, self.timeframe, self.time, self.open, self.high, self.low, self.close)


class BarBuilder:
    """Turns ticks into bars per (symbol, timeframe). A bar is finished when the first tick of the next one arrives."""

    def __init__(self, timeframes: Iterable[str]) -> None:
        self.frames = []
        for tf in timeframes:
            if tf not in TIMEFRAMES:
                raise ValueError("Unknown timeframe %r. Use one of %s" % (tf, ", ".join(TIMEFRAMES)))
            self.frames.append((tf, TIMEFRAMES[tf]))
        self._open: Dict[Tuple[str, str], Bar] = {}
        self._last_volume: Dict[str, float] = {}

    def add(self, symbol: str, price: float, ts_ms: float, volume: Optional[float] = None) -> List[Bar]:
        done: List[Bar] = []
        dv = 0.0
        if volume is not None:
            prev = self._last_volume.get(symbol)
            dv = max(0.0, volume - prev) if prev is not None else 0.0
            self._last_volume[symbol] = volume
        for tf, secs in self.frames:
            start = int(ts_ms // 1000 // secs * secs)
            key = (symbol, tf)
            bar = self._open.get(key)
            if bar is not None and start > bar.time:
                done.append(bar)
                bar = None
            if bar is None:
                self._open[key] = Bar(symbol, tf, start, price, price, price, price, dv, 1)
            elif start == bar.time:
                bar.high = max(bar.high, price)
                bar.low = min(bar.low, price)
                bar.close = price
                bar.volume += dv
                bar.ticks += 1
        return done


def option_parts(symbol: str) -> Optional[Dict[str, Any]]:
    """``NFO:NIFTY-2026-11-03-26100-CE`` -> {"exchange", "underlying", "expiry", "strike", "right"}; None if not an option."""
    try:
        exch, rest = symbol.split(":", 1)
        parts = rest.split("-")
        if len(parts) < 6 or parts[-1] not in ("CE", "PE"):
            return None
        strike = float(parts[-2])
        return {"exchange": exch, "underlying": "-".join(parts[:-5]), "expiry": "-".join(parts[-5:-2]), "strike": int(strike) if strike.is_integer() else strike, "right": parts[-1]}
    except (ValueError, AttributeError):
        return None


def chain_legs(chain: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Every contract of an option chain by symbol: ``{symbol: {"strike", "right", "ltp", "delta", "iv", "oi", ...}}``."""
    out: Dict[str, Dict[str, Any]] = {}
    for row in chain.get("rows") or []:
        for right in ("ce", "pe"):
            leg = row.get(right)
            if leg and leg.get("symbol"):
                out[leg["symbol"]] = dict(leg, strike=row.get("strike"), right=right.upper())
    return out


# ───────────────────────────── book (positions and P&L from the strategy's own orders) ─────────────────────────────


def build_book(orders: Iterable[Mapping[str, Any]], ltps: Optional[Mapping[str, float]] = None) -> Dict[str, Any]:
    """Net position and P&L per symbol from filled quantities, average cost method. The same rule as the Bridge's
    runner (server/bridge/strategies/book.mjs), so the dashboard and the strategy agree.

    Returns ``{"positions": {symbol: {"qty", "avg", "realised", "unrealised", "ltp"}}, "realised", "unrealised", "total"}``.
    """
    ltps = ltps or {}
    pos: Dict[str, Dict[str, Any]] = {}
    for o in sorted(orders, key=lambda o: (str(o.get("placedAt") or ""), str(o.get("orderId") or ""))):
        q = int(o.get("filledQuantity") or 0)
        px = o.get("avgPrice")
        if q <= 0 or px is None:
            continue
        px = float(px)
        p = pos.setdefault(o["symbol"], {"qty": 0, "avg": 0.0, "realised": 0.0})
        s = q if o.get("side") == "BUY" else -q
        qty = p["qty"]
        if qty == 0 or (qty > 0) == (s > 0):
            p["avg"] = (p["avg"] * abs(qty) + px * q) / (abs(qty) + q)
            p["qty"] = qty + s
        else:
            closing = min(abs(qty), q)
            p["realised"] += closing * (px - p["avg"]) * (1 if qty > 0 else -1)
            p["qty"] = qty + s
            if p["qty"] == 0:
                p["avg"] = 0.0
            elif (p["qty"] > 0) != (qty > 0):
                p["avg"] = px
    realised = unrealised = 0.0
    for sym, p in pos.items():
        ltp = ltps.get(sym)
        p["ltp"] = ltp
        p["unrealised"] = (p["qty"] * (float(ltp) - p["avg"])) if (ltp is not None and p["qty"]) else 0.0
        p["realised"] = round(p["realised"], 2)
        p["unrealised"] = round(p["unrealised"], 2)
        realised += p["realised"]
        unrealised += p["unrealised"]
    return {"positions": pos, "realised": round(realised, 2), "unrealised": round(unrealised, 2), "total": round(realised + unrealised, 2)}


# ───────────────────────────── logging ─────────────────────────────


class StrategyLogger:
    """Log lines that stream to the Bridge (its Algo page shows them live). Outside the Bridge they print plainly."""

    LEVELS = ("debug", "info", "warn", "error")

    def __init__(self, out: Any = None, *, runner: Optional[bool] = None) -> None:
        self._out = out if out is not None else sys.stdout
        self._runner = (os.environ.get("MCB_STRATEGY_RUNNER") == "1") if runner is None else runner
        self._lock = threading.Lock()

    def emit(self, kind: str, **fields: Any) -> None:
        """A protocol message for the runner (no-op outside it)."""
        if not self._runner:
            return
        self._write(PROTOCOL_PREFIX + json.dumps(dict({"t": kind}, **fields), default=str, separators=(",", ":")))

    def _write(self, line: str) -> None:
        with self._lock:
            try:
                self._out.write(line + "\n")
                self._out.flush()
            except (OSError, ValueError):
                pass

    def log(self, level: str, msg: Any, *args: Any) -> None:
        text = str(msg) % args if args else str(msg)
        if level not in self.LEVELS:
            level = "info"
        if self._runner:
            self.emit("log", level=level, msg=text[:2000])
        else:
            self._write("%s %-5s %s" % (datetime.now(IST).strftime("%H:%M:%S"), level.upper(), text))

    def debug(self, msg: Any, *args: Any) -> None:
        self.log("debug", msg, *args)

    def info(self, msg: Any, *args: Any) -> None:
        self.log("info", msg, *args)

    def warn(self, msg: Any, *args: Any) -> None:
        self.log("warn", msg, *args)

    warning = warn

    def error(self, msg: Any, *args: Any) -> None:
        self.log("error", msg, *args)


# ───────────────────────────── the strategy base class ─────────────────────────────


class Strategy:
    """Base class. Override the ``on_*`` methods you need; every one is optional.

    Class attributes:
        name, description   shown on the Algo page
        symbols             streamed live from the start (ticks go to on_tick, bars to on_bar)
        timeframes          bar sizes for on_bar, e.g. ["1m", "5m"] (15s to 1h)
        params              {name: Param(default, ...)}: read as ``self.p.<name>``
        timer_seconds       call on_timer every N seconds (0: never)
        product             default product for orders ("MARGIN", "INTRADAY", "CNC")
        tick_mode           stream mode: "ltp" or "quote" (bid, ask, OI)
    """

    name: str = ""
    description: str = ""
    symbols: Sequence[str] = ()
    timeframes: Sequence[str] = ()
    params: Dict[str, Param] = {}
    timer_seconds: float = 0
    product: str = "MARGIN"
    tick_mode: str = "quote"
    #: Consecutive errors in callbacks before the strategy stops as crashed (the runner may restart it).
    max_consecutive_errors: int = 20

    def __init__(
        self,
        bridge: Optional[BridgeClient] = None,
        *,
        account: Optional[str] = None,
        mode: Optional[str] = None,
        params: Optional[Mapping[str, Any]] = None,
        strategy_id: Optional[str] = None,
        run_id: Optional[str] = None,
        logger: Optional[StrategyLogger] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        env = os.environ
        self.bridge = bridge if bridge is not None else BridgeClient()
        self.account = account or env.get("MCB_STRATEGY_ACCOUNT") or ""
        if not self.account:
            raise ValueError("No account: the Bridge sets MCB_STRATEGY_ACCOUNT, or pass account=...")
        self.mode = (mode or env.get("MCB_STRATEGY_MODE") or "paper").lower()
        if self.mode not in ("paper", "live"):
            raise ValueError("mode must be paper or live")
        self.id = _safe_id(strategy_id or env.get("MCB_STRATEGY_ID") or type(self).__name__)
        self.run_id = run_id or env.get("MCB_STRATEGY_RUN") or "".join(random.choice(_ID_CHARS) for _ in range(6))
        self.log = logger or StrategyLogger()
        self._clock = clock
        values, problems = resolve_params(type(self).params, params)
        if problems:
            raise ValueError("Params not valid: " + "; ".join(problems))
        self.p = Params(values)
        self.order_prefix = "A-%s-" % self.id
        self._seq = 0
        self._orders: Dict[str, Dict[str, Any]] = {}
        self._ticks: Dict[str, Quote] = {}
        self._ltp_cache: Dict[str, Tuple[float, float]] = {}
        self._stream: Any = None
        self._stop = threading.Event()
        self._stop_reason: Optional[str] = None
        self.counts = {"ticks": 0, "bars": 0, "orders": 0, "refused": 0, "errors": 0}
        self._bars = BarBuilder(self.timeframes)
        self._extra_symbols: List[str] = []

    # ── lifecycle hooks (override) ──
    def on_start(self) -> None:
        """Called once after the strategy has loaded its orders from earlier runs today."""

    def on_tick(self, quote: Quote) -> None:
        """Called for every live tick of a subscribed symbol."""

    def on_bar(self, bar: Bar, timeframe: str) -> None:
        """Called when a bar of one of ``timeframes`` finishes."""

    def on_order_update(self, order: Dict[str, Any]) -> None:
        """Called when one of this strategy's orders changes (filled, cancelled, rejected ...)."""

    def on_timer(self) -> None:
        """Called every ``timer_seconds``."""

    def on_stop(self) -> None:
        """Called once when the strategy stops (Stop button, kill switch, Bridge shutdown or self.stop())."""

    # ── control ──
    def stop(self, reason: str = "stopped by the strategy") -> None:
        """Ask the strategy to stop after the current callback. on_stop still runs."""
        self._stop_reason = reason
        self._stop.set()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def now(self) -> datetime:
        """The time in IST."""
        return datetime.fromtimestamp(self._clock(), IST)

    # ── orders (always through the Bridge's REST order API) ──
    def _next_client_id(self) -> str:
        self._seq += 1
        return "%s%s-%d" % (self.order_prefix, self.run_id, self._seq)

    def order(
        self,
        side: str,
        symbol: str,
        *,
        lots: Optional[int] = None,
        quantity: Optional[int] = None,
        order_type: str = "MARKET",
        price: Optional[float] = None,
        trigger_price: Optional[float] = None,
        product: Optional[str] = None,
        validity: Optional[str] = None,
        tag: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Place one order on this strategy's account. Raises BridgeApiError when the Bridge refuses it (kill switch,
        limits, validation); the refusal is logged and counted either way."""
        side = side.upper()
        if side not in ("BUY", "SELL"):
            raise ValueError("side must be BUY or SELL")
        if lots is None and quantity is None:
            lots = 1
        if lots is not None and quantity is not None:
            raise ValueError("Pass lots or quantity, not both")
        body: Dict[str, Any] = {
            "account": self.account,
            "symbol": symbol,
            "side": side,
            "product": product or self.product,
            "orderType": order_type,
            "mode": self.mode,
            "clientOrderId": self._next_client_id(),
        }
        if lots is not None:
            body["lots"] = int(lots)
        else:
            body["quantity"] = int(quantity)  # type: ignore[arg-type]
        if price is not None:
            body["price"] = float(price)
        if trigger_price is not None:
            body["triggerPrice"] = float(trigger_price)
        if validity:
            body["validity"] = validity
        if tag:
            body["tag"] = tag
        size = ("%d lot%s" % (lots, "" if lots == 1 else "s")) if lots is not None else "%d units" % quantity  # type: ignore[str-format]
        try:
            res = self.bridge.place_order(body)
        except BridgeApiError as e:
            self.counts["refused"] += 1
            self.log.warn("Order refused: %s %s %s (%s: %s)", side, size, symbol, e.code, e.detail or e)
            raise
        order = dict(res.get("data") or {})
        order.setdefault("clientOrderId", body["clientOrderId"])
        order.setdefault("side", side)
        order.setdefault("symbol", symbol)
        self._remember(order)
        self.counts["orders"] += 1
        filled = order.get("status") == "filled"
        self.log.info(
            "%s %s %s %s%s",
            side,
            size,
            symbol,
            order.get("status", "sent"),
            (" at %s" % order.get("avgPrice")) if filled and order.get("avgPrice") is not None else "",
        )
        self.log.emit("order", orderId=order.get("orderId"), clientOrderId=order.get("clientOrderId"), symbol=symbol, side=side, status=order.get("status"))
        return order

    def buy(self, symbol: str, lots: Optional[int] = None, **kw: Any) -> Dict[str, Any]:
        """Buy (MARKET unless order_type=...). ``self.buy("NFO:NIFTY-2026-11-03-26000-CE", lots=1)``."""
        return self.order("BUY", symbol, lots=lots, **kw)

    def sell(self, symbol: str, lots: Optional[int] = None, **kw: Any) -> Dict[str, Any]:
        return self.order("SELL", symbol, lots=lots, **kw)

    def exit(self, symbol: str, **kw: Any) -> Optional[Dict[str, Any]]:
        """Close this strategy's own position in ``symbol`` (never anything else on the account). None when flat."""
        qty = self.position(symbol)
        if not qty:
            return None
        return self.order("SELL" if qty > 0 else "BUY", symbol, quantity=abs(qty), **kw)

    def exit_all(self) -> List[Dict[str, Any]]:
        """Close every position this strategy holds: buys back shorts first (lower margin), then sells longs."""
        out = []
        legs = [(s, q) for s, q in self.positions().items() if q]
        for sym, q in sorted(legs, key=lambda sq: 0 if sq[1] < 0 else 1):
            try:
                r = self.exit(sym)
                if r is not None:
                    out.append(r)
            except BridgeApiError:
                pass
        return out

    def cancel(self, order_id: str) -> Dict[str, Any]:
        res = self.bridge.cancel_order(order_id)
        order = dict(res.get("data") or {})
        if order:
            self._remember(order)
        return order

    def cancel_open_orders(self) -> int:
        n = 0
        for o in list(self._orders.values()):
            if o.get("status") in ("open", "pending", "trigger_pending", "partially_filled"):
                try:
                    self.cancel(o["orderId"])
                    n += 1
                except BridgeApiError as e:
                    self.log.warn("Cancel refused for %s (%s)", o.get("orderId"), e.code)
        return n

    def orders(self) -> List[Dict[str, Any]]:
        """This strategy's orders today (all runs), oldest first."""
        return sorted(self._orders.values(), key=lambda o: (str(o.get("placedAt") or ""), str(o.get("orderId") or "")))

    def _remember(self, order: Mapping[str, Any]) -> None:
        oid = order.get("orderId")
        if not oid:
            return
        cur = self._orders.get(oid, {})
        cur.update({k: v for k, v in order.items() if v is not None})
        self._orders[oid] = cur

    def _mine(self, order: Mapping[str, Any]) -> bool:
        return str(order.get("clientOrderId") or "").startswith(self.order_prefix)

    def refresh_orders(self) -> None:
        """Read this strategy's orders for today from the Bridge (they survive a restart)."""
        today = self.now().strftime("%Y-%m-%d")
        cursor = None
        for _ in range(20):
            page = self.bridge.orders(account=self.account, mode=self.mode, limit=500, cursor=cursor)
            for o in page.get("data") or []:
                if self._mine(o) and str(o.get("placedAt") or "")[:10] == today:
                    self._remember(o)
            cursor = (page.get("meta") or {}).get("nextCursor")
            if not cursor:
                break

    # ── positions and P&L (this strategy's own orders, priced from live ticks or the Bridge) ──
    def positions(self) -> Dict[str, int]:
        """Net quantity per symbol from this strategy's fills (units; negative is short)."""
        book = build_book(self._orders.values())
        return {s: p["qty"] for s, p in book["positions"].items() if p["qty"]}

    def position(self, symbol: str) -> int:
        return self.positions().get(symbol, 0)

    def pnl(self) -> Dict[str, Any]:
        """``{"realised", "unrealised", "total", "positions": {...}}`` for this strategy today."""
        held = [s for s, q in self.positions().items() if q]
        return build_book(self._orders.values(), self.ltps(held) if held else {})

    # ── market data ──
    def ltp(self, symbol: str, max_age_s: float = 5.0) -> Optional[float]:
        """Last price: the live tick when fresh, else the Bridge (cached for a moment)."""
        q = self._ticks.get(symbol)
        now = self._clock()
        if q is not None and q.get("ltp") is not None and now - q.get("_at", 0) <= max_age_s:
            return float(q["ltp"])
        return self.ltps([symbol]).get(symbol)

    def ltps(self, symbols: Sequence[str]) -> Dict[str, float]:
        now = self._clock()
        out: Dict[str, float] = {}
        missing = []
        for s in symbols:
            q = self._ticks.get(s)
            if q is not None and q.get("ltp") is not None and now - q.get("_at", 0) <= 5.0:
                out[s] = float(q["ltp"])
                continue
            hit = self._ltp_cache.get(s)
            if hit and now - hit[1] <= 2.0:
                out[s] = hit[0]
            else:
                missing.append(s)
        for i in range(0, len(missing), 50):
            try:
                r = self.bridge.ltp(missing[i : i + 50])
            except (BridgeApiError, BridgeConnectionError) as e:
                self.log.warn("Prices unavailable: %s", e)
                continue
            for item in r.get("data") or []:
                if item.get("ltp") is not None:
                    out[item["symbol"]] = float(item["ltp"])
                    self._ltp_cache[item["symbol"]] = (float(item["ltp"]), now)
        return out

    def quote(self, symbol: str) -> Optional[Quote]:
        """The last live tick of a subscribed symbol (None before the first one)."""
        return self._ticks.get(symbol)

    def expiries(self, underlying: str) -> List[str]:
        return list((self.bridge.expiries(underlying).get("data") or {}).get("expiries") or [])

    def nearest_expiry(self, underlying: str, skip: int = 0) -> str:
        today = self.now().strftime("%Y-%m-%d")
        ex = [e for e in self.expiries(underlying) if e >= today]
        if len(ex) <= skip:
            raise BridgeApiError({"status": 404, "code": "NO_EXPIRY", "detail": "No expiry for %s" % underlying, "retryable": False})
        return ex[skip]

    def option_chain(self, underlying: str, expiry: str, *, strikes: int = 10, greeks: bool = True) -> Dict[str, Any]:
        return self.bridge.option_chain(underlying, expiry, strikes=strikes, greeks=greeks)["data"]

    def oi_analytics(self, underlying: str, expiry: str, *, strikes: int = 15) -> Dict[str, Any]:
        """The Bridge's OI analytics: PCR (OI, volume, OI change), max pain, support and resistance by OI."""
        return self.bridge.request("GET", "/v1/analytics/oi", query={"underlying": underlying, "expiry": expiry, "strikes": strikes}).body["data"]

    def near_future(self, underlying: str, exchange: str = "NFO") -> str:
        """The nearest future of an index or stock, e.g. NFO:NIFTY-2026-11-23-FUT."""
        today = self.now().strftime("%Y-%m-%d")
        rows = self.bridge.search_instruments(underlying, exchange=exchange, kind="FUT", limit=20).get("data") or []
        futs = sorted((r for r in rows if r.get("underlying") == underlying and (r.get("expiry") or "") >= today), key=lambda r: r.get("expiry") or "")
        if not futs:
            raise BridgeApiError({"status": 404, "code": "SYMBOL_NOT_FOUND", "detail": "No future for %s" % underlying, "retryable": False})
        return futs[0]["symbol"]

    def history(self, symbol: str, interval: str, countback: int = 200) -> List[Bar]:
        """Past candles as Bars (needs market data the strategy's key may read; may be refused)."""
        data = self.bridge.history(symbol, interval, countback=countback)["data"]
        return [Bar(symbol, interval, int(c["time"]), c["open"], c["high"], c["low"], c["close"], c.get("volume") or 0) for c in data.get("candles") or []]

    def subscribe(self, symbols: Union[str, Sequence[str]]) -> None:
        """Stream more symbols (their ticks go to on_tick and into bars)."""
        syms = [symbols] if isinstance(symbols, str) else list(symbols)
        new = [s for s in syms if s not in self._extra_symbols and s not in self.symbols]
        self._extra_symbols.extend(new)
        if new and self._stream is not None:
            self._stream.subscribe(new, self.tick_mode)

    # ── event dispatch (the runtime calls these; tests may too) ──
    def _call(self, fn: Callable[..., None], *args: Any) -> None:
        try:
            fn(*args)
            self.counts["errors"] = 0
        except BridgeApiError:
            # Already logged where it was raised (a refused order); keep running.
            self.counts["errors"] = 0
        except Exception as e:  # noqa: BLE001
            self.counts["errors"] += 1
            self.log.error("%s in %s: %s (%s)", type(e).__name__, getattr(fn, "__name__", "callback"), e, _where(e))
            if self.counts["errors"] >= self.max_consecutive_errors:
                raise RuntimeError("%d errors in a row; stopping" % self.counts["errors"]) from e

    def dispatch(self, msg: Mapping[str, Any]) -> None:
        """Handle one stream message: ticks feed on_tick and the bar builder; order events feed on_order_update."""
        t = msg.get("type")
        if t == "tick":
            self._tick(msg)
        elif t == "snapshot":
            for tick in msg.get("ticks") or []:
                self._tick(tick, snapshot=True)
        elif t == "order":
            order = msg.get("order") or {}
            if self._mine(order):
                self._remember(order)
                self._call(self.on_order_update, dict(self._orders.get(order.get("orderId"), order)))

    def _tick(self, tick: Mapping[str, Any], snapshot: bool = False) -> None:
        sym = tick.get("symbol")
        if not sym or tick.get("ltp") is None:
            return
        q = Quote(tick)
        q["_at"] = self._clock()
        self._ticks[sym] = q
        if snapshot:
            return
        self.counts["ticks"] += 1
        self._call(self.on_tick, q)
        ts = tick.get("receivedAt") or (self._clock() * 1000)
        for bar in self._bars.add(sym, float(tick["ltp"]), float(ts), tick.get("volume")):
            self.counts["bars"] += 1
            self._call(self.on_bar, bar, bar.timeframe)

    # ── the run loop ──
    def run(self, *, stream: Any = None, install_signals: bool = True, watch_stdin: Optional[bool] = None) -> int:
        """Run until stopped. Returns the process exit code (0 stopped or finished, 1 crashed)."""
        runner = os.environ.get("MCB_STRATEGY_RUNNER") == "1"
        if install_signals and threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGINT):
                try:
                    signal.signal(sig, lambda *_: self.stop("stop requested"))
                except (ValueError, OSError):  # pragma: no cover - platform specific
                    pass
        if watch_stdin if watch_stdin is not None else runner:
            threading.Thread(target=self._watch_parent, name="mcb-parent", daemon=True).start()
        events: "queue.Queue[Mapping[str, Any]]" = queue.Queue(maxsize=10000)
        self.log.emit("hello", id=self.id, run=self.run_id, account=self.account, mode=self.mode, params=self.p.as_dict(), pid=os.getpid())
        self.log.info("Starting %s on %s (%s)", self.name or type(self).__name__, self.account, self.mode)
        code = EXIT_OK
        try:
            try:
                self.refresh_orders()
            except (BridgeApiError, BridgeConnectionError) as e:
                self.log.warn("Could not read earlier orders: %s", e)
            self.on_start()
            symbols = list(dict.fromkeys(list(self.symbols) + self._extra_symbols))
            if stream is None:
                stream = self.bridge.stream(symbols, mode=self.tick_mode, orders=[self.account])
            self._stream = stream
            if stream is not None:
                threading.Thread(target=self._pump, args=(stream, events), name="mcb-stream", daemon=True).start()
            next_timer = self._clock() + self.timer_seconds if self.timer_seconds > 0 else None
            next_beat = 0.0
            while not self._stop.is_set():
                try:
                    msg = events.get(timeout=0.25)
                except queue.Empty:
                    msg = None
                if msg is not None:
                    if msg.get("type") == "_stream_end":
                        raise RuntimeError("The live stream ended: %s" % msg.get("why"))
                    self.dispatch(msg)
                now = self._clock()
                if next_timer is not None and now >= next_timer and not self._stop.is_set():
                    next_timer = now + self.timer_seconds
                    self._call(self.on_timer)
                if now >= next_beat:
                    next_beat = now + HEARTBEAT_S
                    self.log.emit("heartbeat", **self.counts)
        except ConfigError as e:
            code = EXIT_CONFIG
            self.log.error("Settings problem: %s", e)
        except BridgeApiError as e:
            if e.code in REFUSALS_THAT_STOP:
                code = EXIT_REFUSED
                self.log.error("Stopped: the Bridge refused it (%s: %s). Not restarted.", e.code, e.detail or e)
            else:
                code = EXIT_CRASH
                self.log.error("Crashed: BridgeApiError %s: %s (%s)", e.code, e.detail or e, _where(e))
        except Exception as e:  # noqa: BLE001
            code = EXIT_CRASH
            self.log.error("Crashed: %s: %s (%s)", type(e).__name__, e, _where(e))
        finally:
            try:
                self.on_stop()
            except Exception as e:  # noqa: BLE001
                self.log.error("on_stop failed: %s: %s", type(e).__name__, e)
            if self._stream is not None:
                try:
                    self._stream.close()
                except Exception:  # noqa: BLE001
                    pass
            if code == EXIT_OK:
                self.log.info("Stopped: %s", self._stop_reason or "stopped")
            self.log.emit("bye", code=code, reason=self._stop_reason, **self.counts)
        return code

    def _pump(self, stream: Any, events: "queue.Queue[Mapping[str, Any]]") -> None:
        why = "closed"
        try:
            for msg in stream:
                if self._stop.is_set():
                    return
                try:
                    events.put(msg, timeout=5)
                except queue.Full:
                    self.log.warn("Strategy is falling behind the stream; a message was dropped")
        except Exception as e:  # noqa: BLE001
            why = "%s: %s" % (type(e).__name__, e)
        if not self._stop.is_set():
            events.put({"type": "_stream_end", "why": why})

    def _watch_parent(self) -> None:
        """The runner keeps stdin open; end of input means the Bridge went away, so stop."""
        try:
            while sys.stdin.readline():
                pass
        except (OSError, ValueError):
            pass
        self.stop("the Bridge closed")


def _where(e: BaseException) -> str:
    """Where an exception was raised, as "file.py line 12, in on_start" (the innermost frame), for one-line logs."""
    frames = traceback.extract_tb(e.__traceback__) if e.__traceback__ else []
    if isinstance(e, SyntaxError) and e.filename:
        return "%s line %s" % (os.path.basename(e.filename), e.lineno)
    if not frames:
        return "no traceback"
    f = frames[-1]
    return "%s line %s, in %s" % (os.path.basename(f.filename), f.lineno, f.name)


def _safe_id(s: str) -> str:
    out = "".join(c if c in _ID_CHARS or c == "_" else "_" for c in str(s).lower())[:32].strip("_")
    return out or "strategy"


# ───────────────────────────── loading and describing files ─────────────────────────────


def load_strategy_class(path: str) -> type:
    """Import a strategy file and return its Strategy subclass (the module's ``STRATEGY``, else the one defined there)."""
    spec = importlib.util.spec_from_file_location("mcb_strategy_" + _safe_id(os.path.splitext(os.path.basename(path))[0]), path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load %s" % path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    chosen = getattr(mod, "STRATEGY", None)
    if isinstance(chosen, type) and issubclass(chosen, Strategy):
        return chosen
    found = [v for v in vars(mod).values() if isinstance(v, type) and issubclass(v, Strategy) and v is not Strategy and v.__module__ == mod.__name__]
    if len(found) != 1:
        raise ValueError("%s must define exactly one Strategy subclass (or set STRATEGY = YourClass); found %d" % (os.path.basename(path), len(found)))
    return found[0]


_PARAM_FACTORIES = {"Param"}


def describe_file(path: str) -> Dict[str, Any]:
    """What the dashboard needs about a strategy file, read WITHOUT running it (Python's ast, literals only):
    its class, name, description, symbols, timeframes and declared params."""
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src, filename=path)
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and any(_base_name(b) == "Strategy" for b in n.bases)]
    chosen = None
    for n in tree.body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "STRATEGY" for t in n.targets) and isinstance(n.value, ast.Name):
            chosen = next((c for c in classes if c.name == n.value.id), None)
    if chosen is None:
        if len(classes) != 1:
            raise ValueError("The file must define exactly one class that extends Strategy (found %d)" % len(classes))
        chosen = classes[0]
    out: Dict[str, Any] = {"className": chosen.name, "name": "", "description": ast.get_docstring(chosen) or "", "symbols": [], "timeframes": [], "params": [], "timerSeconds": 0}
    for stmt in chosen.body:
        target, value = None, None
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            target, value = stmt.targets[0].id, stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
            target, value = stmt.target.id, stmt.value
        if target is None:
            continue
        if target in ("name", "description"):
            v = _literal(value)
            if isinstance(v, str):
                out[target] = v
        elif target in ("symbols", "timeframes"):
            v = _literal(value)
            if isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v):
                out[target] = list(v)
        elif target == "timer_seconds":
            v = _literal(value)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out["timerSeconds"] = v
        elif target == "params":
            out["params"] = _params_from_ast(value)
    if not out["name"]:
        out["name"] = chosen.name
    for tf in out["timeframes"]:
        if tf not in TIMEFRAMES:
            raise ValueError("Unknown timeframe %r" % tf)
    return out


def _base_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


_MISSING = object()


def _literal(node: ast.AST) -> Any:
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return _MISSING


def _params_from_ast(node: ast.AST) -> List[Dict[str, Any]]:
    if not isinstance(node, ast.Dict):
        raise ValueError("params must be a dict literal: {\"name\": Param(default, ...)}")
    out = []
    for k, v in zip(node.keys, node.values):
        name = _literal(k) if k is not None else _MISSING
        if not isinstance(name, str) or not name.isidentifier():
            raise ValueError("Param names must be plain identifiers in quotes")
        if not (isinstance(v, ast.Call) and _base_name(v.func) in _PARAM_FACTORIES):
            raise ValueError("params[%r] must be Param(...)" % name)
        args = [_literal(a) for a in v.args]
        kwargs = {kw.arg: _literal(kw.value) for kw in v.keywords if kw.arg}
        if len(args) != 1 or args[0] is _MISSING or any(x is _MISSING for x in kwargs.values()):
            raise ValueError("params[%r]: use literal values only (numbers, text, True/False, lists)" % name)
        allowed = {"min", "max", "choices", "step", "help", "label", "kind"}
        extra = set(kwargs) - allowed
        if extra:
            raise ValueError("params[%r]: unknown option %s" % (name, ", ".join(sorted(extra))))
        try:
            out.append(Param(args[0], **kwargs).to_json(name))  # type: ignore[arg-type]
        except (TypeError, ValueError) as e:
            raise ValueError("params[%r]: %s" % (name, e)) from None
    return out


# ───────────────────────────── command line (the Bridge's runner calls this) ─────────────────────────────


def run_file(path: str, *, params: Optional[Mapping[str, Any]] = None) -> int:
    logger = StrategyLogger()
    try:
        cls = load_strategy_class(path)
    except Exception as e:  # noqa: BLE001
        logger.error("Could not load %s: %s: %s (%s)", os.path.basename(path), type(e).__name__, e, _where(e))
        return EXIT_CONFIG
    if params is None:
        raw = os.environ.get("MCB_STRATEGY_PARAMS") or "{}"
        try:
            params = json.loads(raw)
        except ValueError:
            logger.error("MCB_STRATEGY_PARAMS is not JSON")
            return EXIT_CONFIG
    try:
        strat = cls(params=params, logger=logger)
    except ValueError as e:
        logger.error("%s", e)
        return EXIT_CONFIG
    return strat.run()


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and args[0] == "describe":
        try:
            print(json.dumps({"ok": True, "strategy": describe_file(args[1])}))
            return 0
        except (OSError, SyntaxError, ValueError) as e:
            msg = "%s: %s" % (type(e).__name__, e) if isinstance(e, SyntaxError) else str(e)
            print(json.dumps({"ok": False, "error": msg[:500]}))
            return EXIT_CONFIG
    if len(args) == 2 and args[0] == "run":
        return run_file(args[1])
    sys.stderr.write("usage: python3 -m mrchartist_bridge strategy describe|run <file.py>\n")
    return 2


if __name__ == "__main__":  # pragma: no cover
    # Run through the package so user files and this runner share one Strategy class.
    from mrchartist_bridge.strategy import main as _main

    sys.exit(_main())
