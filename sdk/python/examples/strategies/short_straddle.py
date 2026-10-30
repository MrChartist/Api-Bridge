"""Short straddle on the nearest weekly expiry, with a stop loss and a target on the combined premium.

Sells the at-the-money call and put. Every few seconds it adds up the two premiums: when the sum rises by
stop_loss_pct over the entry it buys both back (stop loss); when it falls by target_pct it buys both back (target).
It also exits when the IST clock passes square_off while it runs. Paper by default, like every strategy.
"""

from mrchartist_bridge.errors import BridgeApiError
from mrchartist_bridge.strategy import Param, Strategy

INDEX = {"NIFTY": "NSE:NIFTY", "BANKNIFTY": "NSE:BANKNIFTY", "FINNIFTY": "NSE:FINNIFTY", "SENSEX": "BSE:SENSEX"}


class ShortStraddle(Strategy):
    name = "Short straddle"
    description = "Sells the ATM call and put of the nearest weekly expiry. Exits both on a stop loss or a target on the combined premium, or at the square-off time."
    timer_seconds = 5
    params = {
        "underlying": Param("NIFTY", choices=["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"], help="Index whose weekly options are sold"),
        "lots": Param(1, min=1, max=10, help="Lots for each leg"),
        "stop_loss_pct": Param(30.0, min=5, max=200, step=5, help="Exit when the combined premium rises this much above the entry (%)"),
        "target_pct": Param(40.0, min=5, max=95, step=5, help="Exit when the combined premium falls this much below the entry (%)"),
        "square_off": Param("15:15", help="IST time (HH:MM) at which an open straddle is closed"),
        "max_entries": Param(1, min=1, max=5, help="Straddles to open per day at most"),
        "exit_on_stop": Param(True, help="Close the straddle when you press Stop"),
    }

    def on_start(self):
        held = {s: q for s, q in self.positions().items() if q}
        self.legs = []
        self.entry = None
        self._was_before_square_off = self.now().strftime("%H:%M") < self.p.square_off
        shorts = sorted(s for s, q in held.items() if q < 0)
        if len(held) == 2 and len(shorts) == 2 and {s[-2:] for s in shorts} == {"CE", "PE"} and len({s[:-3].rsplit("-", 1)[0] for s in shorts}) == 1:
            self.legs = shorts
        elif held:
            # One leg left over (part of an exit was refused): close it rather than run half a straddle.
            self.log.info("Found %d leftover leg%s that are not a whole straddle; closing them first: %s", len(held), "" if len(held) == 1 else "s", ", ".join("%s %+d" % sq for sq in sorted(held.items())))
            self.exit_all()
            if any(self.positions().values()):
                self.stop("could not close the leftover legs")
                return
        if self.legs:
            book = self.pnl()["positions"]
            self.entry = sum(book[s]["avg"] for s in self.legs)
            self.log.info("Picked up the open straddle %s, entry premium %.2f", " + ".join(self.legs), self.entry)
            self.subscribe(self.legs)
            return
        entries = sum(1 for o in self.orders() if o.get("side") == "SELL" and str(o.get("symbol", "")).endswith("-CE") and o.get("status") == "filled")
        if entries >= self.p.max_entries:
            self.log.info("Already opened %d straddle(s) today (max_entries %d); nothing to do", entries, self.p.max_entries)
            self.stop("done for today")
            return
        self.open_straddle()

    def open_straddle(self):
        u = self.p.underlying
        expiry = self.nearest_expiry(u)
        chain = self.option_chain(u, expiry, strikes=2, greeks=False)
        atm = chain["atmStrike"]
        row = next(r for r in chain["rows"] if r["strike"] == atm)
        ce, pe = row["ce"]["symbol"], row["pe"]["symbol"]
        self.log.info("%s spot %.2f, ATM %s, expiry %s: selling %s and %s", u, chain["underlyingLtp"], atm, expiry, ce, pe)
        filled = []
        try:
            for sym in (ce, pe):
                filled.append(self.sell(sym, lots=self.p.lots))
        except BridgeApiError as e:
            # Never leave half a straddle: buy back the leg that went through, then stop.
            self.log.warn("The Bridge refused a leg (%s); closing the other one", e.code)
            self.legs = [ce, pe]
            self.exit_all()
            self.legs = []
            self.stop("entry refused: %s" % e.code)
            return
        self.legs = [ce, pe]
        self.subscribe(self.legs)
        prices = [o.get("avgPrice") for o in filled]
        self.entry = sum(prices) if all(p is not None for p in prices) else None
        if self.entry is not None:
            self.log.info("Entry premium %.2f: stop at %.2f, target at %.2f", self.entry, self.stop_level(), self.target_level())

    def stop_level(self):
        return self.entry * (1 + self.p.stop_loss_pct / 100)

    def target_level(self):
        return self.entry * (1 - self.p.target_pct / 100)

    def on_timer(self):
        if not self.legs or self.stopping:
            return
        if self.entry is None:
            book = self.pnl()["positions"]
            if all(s in book and book[s]["qty"] for s in self.legs):
                self.entry = sum(book[s]["avg"] for s in self.legs)
            return
        prices = self.ltps(self.legs)
        if len(prices) < len(self.legs):
            return
        premium = sum(prices.values())
        before = self.now().strftime("%H:%M") < self.p.square_off
        if premium >= self.stop_level():
            self.close("stop loss: premium %.2f reached %.2f" % (premium, self.stop_level()))
        elif premium <= self.target_level():
            self.close("target: premium %.2f reached %.2f" % (premium, self.target_level()))
        elif self._was_before_square_off and not before:
            self.close("square-off time %s" % self.p.square_off)
        self._was_before_square_off = before

    def close(self, why):
        self.log.info("Closing the straddle (%s)", why)
        self.exit_all()
        self.legs = []
        p = self.pnl()
        self.log.info("Straddle closed. Realised P&L %.2f", p["realised"])
        self.stop(why)

    def on_order_update(self, order):
        if order.get("status") == "rejected":
            self.log.warn("Order %s was rejected: %s", order.get("orderId"), order.get("statusMessage"))

    def on_stop(self):
        if self.legs and self.p.exit_on_stop:
            self.log.info("Stopping: buying back the open legs")
            self.exit_all()
