"""Iron condor with an adjustment when the position's delta drifts.

Sells an out-of-the-money call and put near short_delta and buys wings wing_width points further out (wings first,
so the margin stays low). Every 10 seconds it adds up the position's delta from the live chain. When the net delta
per lot drifts past adjust_delta, the side the market moved away from (the untested side) is rolled closer: its
spread is bought back and sold again at short_delta, once its short option has drifted 0.05 or more below short_delta.
At most max_adjustments a day.
"""

from mrchartist_bridge.errors import BridgeApiError
from mrchartist_bridge.strategy import ConfigError, Param, Strategy, chain_legs, option_parts

STEP = {"NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "SENSEX": 100}


class IronCondor(Strategy):
    name = "Iron condor"
    description = "Short strangle near a chosen delta with bought wings. Rolls the untested side when the position delta drifts."
    timer_seconds = 10
    params = {
        "underlying": Param("NIFTY", choices=["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"], help="Index whose weekly options are traded"),
        "lots": Param(1, min=1, max=10, help="Lots for each leg"),
        "short_delta": Param(0.2, min=0.05, max=0.45, step=0.01, help="Delta of the sold call and put"),
        "wing_width": Param(200, min=50, max=2000, step=50, help="Points between each sold option and its wing"),
        "adjust_delta": Param(0.1, min=0.02, max=1.0, step=0.01, help="Roll the untested side when the net delta per lot passes this"),
        "max_adjustments": Param(3, min=0, max=10, help="Rolls per day at most"),
        "exit_on_stop": Param(True, help="Close all four legs when you press Stop"),
    }

    def on_start(self):
        if self.p.wing_width % STEP[self.p.underlying]:
            raise ConfigError("wing_width must be a multiple of %d for %s" % (STEP[self.p.underlying], self.p.underlying))
        self.adjustments = 0
        self.waiting = False
        held = {s: q for s, q in self.positions().items() if q}
        if held and self.whole_condor(held):
            self.expiry = option_parts(next(iter(held)))["expiry"]
            self.log.info("Picked up the open condor: %s", ", ".join("%s %+d" % sq for sq in sorted(held.items())))
            self.subscribe(list(held))
            return
        if held:
            # Leftovers of a condor cut short (the kill switch or a limit refused part of an exit or a roll): close
            # them and start clean, rather than managing a lopsided position as if it were a condor.
            self.log.info("Found %d leftover leg%s that are not a whole condor; closing them first: %s", len(held), "" if len(held) == 1 else "s", ", ".join("%s %+d" % sq for sq in sorted(held.items())))
            self.exit_all()
            if any(self.positions().values()):
                self.stop("could not close the leftover legs")
                return
        self.expiry = self.nearest_expiry(self.p.underlying)
        chain = self.option_chain(self.p.underlying, self.expiry, strikes=30)
        try:
            self.open_side(chain, "CE")
            self.open_side(chain, "PE")
        except BridgeApiError as e:
            # Never leave part of a condor: close the legs that went through, then stop.
            self.log.warn("The Bridge refused a leg (%s); closing what was opened", e.code)
            self.exit_all()
            self.stop("entry refused: %s" % e.code)

    @staticmethod
    def whole_condor(held):
        """One short and one long of each right, all options of one expiry, the long further out than the short."""
        parts = {s: option_parts(s) for s in held}
        if len(held) != 4 or any(p is None for p in parts.values()) or len({p["expiry"] for p in parts.values()}) != 1:
            return False
        for right in ("CE", "PE"):
            side = [(parts[s]["strike"], q) for s, q in held.items() if parts[s]["right"] == right]
            shorts = [k for k, q in side if q < 0]
            longs = [k for k, q in side if q > 0]
            if len(shorts) != 1 or len(longs) != 1:
                return False
            if (longs[0] - shorts[0]) * (1 if right == "CE" else -1) <= 0:
                return False
        return True

    def pick(self, chain, right):
        """The contract of `right` whose |delta| is closest to short_delta, and its wing."""
        legs = [leg for leg in chain_legs(chain).values() if leg["right"] == right and leg.get("delta") is not None]
        if not legs:
            raise ConfigError("The chain has no deltas for %s" % self.p.underlying)
        short = min(legs, key=lambda leg: abs(abs(leg["delta"]) - self.p.short_delta))
        wing_strike = short["strike"] + (self.p.wing_width if right == "CE" else -self.p.wing_width)
        wing = next((leg for leg in legs if leg["strike"] == wing_strike), None)
        if wing is None:
            raise ConfigError("No %s strike at %s in the chain; try a smaller wing_width" % (right, wing_strike))
        return short, wing

    def open_side(self, chain, right):
        short, wing = self.pick(chain, right)
        self.log.info("%s side: sell %s (delta %.2f), buy %s", right, short["strike"], short["delta"], wing["strike"])
        self.buy(wing["symbol"], lots=self.p.lots)
        self.sell(short["symbol"], lots=self.p.lots)
        self.subscribe([short["symbol"], wing["symbol"]])

    def close_side(self, right):
        for sym, q in sorted(self.positions().items(), key=lambda sq: sq[1]):
            parts = option_parts(sym)
            if q and parts and parts["right"] == right:
                self.exit(sym)

    def on_timer(self):
        if self.stopping or not any(self.positions().values()):
            return
        chain = self.option_chain(self.p.underlying, self.expiry, strikes=30)
        legs = chain_legs(chain)
        lot = chain.get("lotSize") or 1
        net = 0.0
        for sym, q in self.positions().items():
            d = (legs.get(sym) or {}).get("delta")
            if d is not None:
                net += q * d
        per_lot = net / lot / self.p.lots
        self.log.debug("Net delta %.3f per lot, spot %.2f", per_lot, chain["underlyingLtp"])
        if abs(per_lot) <= self.p.adjust_delta:
            return
        if self.adjustments >= self.p.max_adjustments:
            if self.adjustments == self.p.max_adjustments:
                self.log.warn("Delta %.2f per lot is past %.2f, but the %d adjustments for today are used", per_lot, self.p.adjust_delta, self.p.max_adjustments)
                self.adjustments += 1
            return
        # Negative delta: the market rose against the short call, so the put side is untested (and the reverse).
        untested = "PE" if per_lot < 0 else "CE"
        # Roll only a side that has drifted away from short_delta: rolling one that is already there changes nothing.
        shorts = [abs((legs.get(sym) or {}).get("delta") or 0) for sym, q in self.positions().items() if q < 0 and (option_parts(sym) or {}).get("right") == untested]
        if shorts and max(shorts) >= self.p.short_delta - 0.05:
            if not self.waiting:
                self.log.info("Net delta %.2f per lot is past %.2f, but the %s side is still near delta %.2f: nothing to roll", per_lot, self.p.adjust_delta, untested, self.p.short_delta)
                self.waiting = True
            return
        self.waiting = False
        self.adjustments += 1
        self.log.info("Net delta %.2f per lot passed %.2f: rolling the %s side closer (adjustment %d)", per_lot, self.p.adjust_delta, untested, self.adjustments)
        self.close_side(untested)
        try:
            self.open_side(chain, untested)
        except BridgeApiError as e:
            self.log.warn("Could not reopen the %s side (%s); it stays closed", untested, e.code)

    def on_stop(self):
        if self.p.exit_on_stop and any(self.positions().values()):
            self.log.info("Stopping: closing the condor")
            self.exit_all()
