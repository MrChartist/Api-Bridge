"""EMA crossover on an index future.

Builds bars of the nearest NIFTY (or BANKNIFTY) future from live ticks and follows the fast EMA across the slow one:
fast above slow is long, below is short. With trade = "option" (the default) it expresses the view with an
at-the-money option (a call when long, a put when short), which fits the Bridge's default per-order value limit;
with trade = "future" it buys or sells the future itself (one future lot is worth far more than the default
maxOrderValue of 2 lakh, so raise that limit in your config first, or the Bridge refuses the order).
"""

from mrchartist_bridge.errors import BridgeApiError
from mrchartist_bridge.strategy import ConfigError, Param, Strategy


class Ema:
    def __init__(self, period):
        self.k = 2.0 / (period + 1)
        self.value = None
        self.count = 0

    def add(self, x):
        self.value = x if self.value is None else self.value + self.k * (x - self.value)
        self.count += 1
        return self.value


class EmaCrossover(Strategy):
    name = "EMA crossover"
    description = "Follows a fast EMA crossing a slow EMA on the nearest index future, with an ATM option or the future itself."
    timeframes = ["15s", "30s", "1m", "3m", "5m", "15m"]
    params = {
        "underlying": Param("NIFTY", choices=["NIFTY", "BANKNIFTY"], help="Index whose nearest future gives the signal"),
        "timeframe": Param("1m", choices=["15s", "30s", "1m", "3m", "5m", "15m"], help="Bar size"),
        "fast": Param(9, min=2, max=100, help="Fast EMA length in bars"),
        "slow": Param(21, min=3, max=300, help="Slow EMA length in bars"),
        "trade": Param("option", choices=["option", "future"], help="Trade an ATM option (fits default limits) or the future"),
        "lots": Param(1, min=1, max=10, help="Lots per order"),
        "enter_on_start": Param(True, help="Take the current side as soon as the EMAs are ready, without waiting for a cross"),
        "exit_on_stop": Param(True, help="Close the position when you press Stop"),
    }

    def on_start(self):
        if self.p.fast >= self.p.slow:
            raise ConfigError("fast (%d) must be shorter than slow (%d)" % (self.p.fast, self.p.slow))
        self.future = self.near_future(self.p.underlying)
        self.subscribe(self.future)
        self.fast_ema, self.slow_ema = Ema(self.p.fast), Ema(self.p.slow)
        self.side = None
        held = {s: q for s, q in self.positions().items() if q}
        if held:
            sym, q = next(iter(held.items()))
            self.side = "long" if (q > 0) != sym.endswith("-PE") else "short"
            self.log.info("Picked up the open position %s %+d (%s)", sym, q, self.side)
        try:
            bars = self.history(self.future, self.p.timeframe if self.p.timeframe.endswith("m") else "1m", countback=self.p.slow * 3)
            for b in bars:
                self.fast_ema.add(b.close)
                self.slow_ema.add(b.close)
            self.log.info("Warmed up from %d past bars", len(bars))
        except BridgeApiError as e:
            self.log.info("No history for this key (%s); warming up from live bars: %d %s bars", e.code, self.p.slow, self.p.timeframe)

    def on_bar(self, bar, timeframe):
        if timeframe != self.p.timeframe or bar.symbol != self.future:
            return
        prev = self.relation()
        self.fast_ema.add(bar.close)
        self.slow_ema.add(bar.close)
        if self.slow_ema.count < self.p.slow:
            if self.slow_ema.count % 5 == 0:
                self.log.info("Warming up: %d of %d bars", self.slow_ema.count, self.p.slow)
            return
        now = self.relation()
        self.log.debug("%s close %.2f, EMA%d %.2f, EMA%d %.2f", timeframe, bar.close, self.p.fast, self.fast_ema.value, self.p.slow, self.slow_ema.value)
        crossed = prev is not None and now != prev
        if crossed or (self.side is None and self.p.enter_on_start):
            self.log.info("EMA%d %s EMA%d at %.2f: going %s", self.p.fast, "above" if now == "long" else "below", self.p.slow, bar.close, now)
            self.go(now)

    def relation(self):
        if self.fast_ema.value is None or self.slow_ema.count < self.p.slow:
            return None
        return "long" if self.fast_ema.value > self.slow_ema.value else "short"

    def go(self, side):
        if side == self.side:
            return
        self.exit_all()
        # Set first: a refused order (a limit, the kill switch) waits for the next cross instead of retrying every bar.
        self.side = side
        if self.p.trade == "future":
            self.order("BUY" if side == "long" else "SELL", self.future, lots=self.p.lots)
        else:
            expiry = self.nearest_expiry(self.p.underlying)
            chain = self.option_chain(self.p.underlying, expiry, strikes=1, greeks=False)
            row = next(r for r in chain["rows"] if r["strike"] == chain["atmStrike"])
            self.buy(row["ce" if side == "long" else "pe"]["symbol"], lots=self.p.lots)

    def on_stop(self):
        if self.p.exit_on_stop and any(self.positions().values()):
            self.log.info("Stopping: closing the position")
            self.exit_all()
