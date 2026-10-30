"""Sell options at the open-interest walls, biased by the put-call ratio.

Reads the Bridge's OI analytics (/v1/analytics/oi: PCR, support and resistance by open interest) every 15 seconds.
Support is the put strike with the most open interest at least min_gap points below the spot, resistance the call
strike with the most at least min_gap above it. A PCR at or above bull_pcr sells only the put at support, at or below
bear_pcr only the call at resistance, and in between both (a strangle at the walls). A leg is bought back when the spot
breaks its wall, when its premium rises stop_loss_pct over the entry, or when the PCR bias no longer wants it.
"""

from mrchartist_bridge.strategy import Param, Strategy, option_parts


class OiWalls(Strategy):
    name = "OI walls"
    description = "Sells the put at the OI support and the call at the OI resistance, biased by the put-call ratio, with a stop loss per leg."
    timer_seconds = 15
    params = {
        "underlying": Param("NIFTY", choices=["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"], help="Index to read OI for and trade"),
        "lots": Param(1, min=1, max=10, help="Lots for each leg"),
        "bull_pcr": Param(1.2, min=0.5, max=3.0, step=0.05, help="At or above this PCR (OI), sell only the put"),
        "bear_pcr": Param(0.8, min=0.2, max=2.0, step=0.05, help="At or below this PCR (OI), sell only the call"),
        "strikes": Param(15, min=5, max=50, help="Strikes each side of ATM to look for walls"),
        "min_gap": Param(75, min=0, max=2000, step=25, help="Sell a wall only this many points or more away from the spot"),
        "stop_loss_pct": Param(50.0, min=10, max=300, step=5, help="Buy a leg back when its premium rises this much (%)"),
        "exit_on_stop": Param(True, help="Close the legs when you press Stop"),
    }

    def on_start(self):
        self.expiry = self.nearest_expiry(self.p.underlying)
        self.last_pcr = None
        held = [s for s, q in self.positions().items() if q < 0]
        if held:
            self.log.info("Picked up open legs: %s", ", ".join(held))
            self.subscribe(held)
        self.on_timer()

    def walls(self, oi):
        spot = oi["underlyingLtp"]
        gap = self.p.min_gap
        # A wall right at the spot is broken by the next wiggle: only walls at least min_gap points away count.
        support = next((w["strike"] for w in oi.get("support") or [] if w["strike"] <= spot - gap), None)
        resistance = next((w["strike"] for w in oi.get("resistance") or [] if w["strike"] >= spot + gap), None)
        if support is None or resistance is None:
            # The top walls are on the wrong side of the spot: take the largest OI strike that is not.
            rows = oi.get("strikes") or []
            below = [r for r in rows if r["strike"] <= spot - gap]
            above = [r for r in rows if r["strike"] >= spot + gap]
            if support is None and below:
                support = max(below, key=lambda r: r.get("peOi") or 0)["strike"]
            if resistance is None and above:
                resistance = max(above, key=lambda r: r.get("ceOi") or 0)["strike"]
        return spot, support, resistance

    def symbol(self, strike, right):
        prefix = "BFO" if self.p.underlying == "SENSEX" else "NFO"
        return "%s:%s-%s-%s-%s" % (prefix, self.p.underlying, self.expiry, strike, right)

    def on_timer(self):
        if self.stopping:
            return
        oi = self.oi_analytics(self.p.underlying, self.expiry, strikes=self.p.strikes)
        pcr = oi.get("pcrOi")
        spot, support, resistance = self.walls(oi)
        if pcr is None:
            return
        if pcr != self.last_pcr:
            self.log.info("PCR %.2f, spot %.2f, support %s, resistance %s, max pain %s", pcr, spot, support, resistance, oi.get("maxPain"))
            self.last_pcr = pcr
        want = set()
        if pcr >= self.p.bull_pcr:
            want = {"PE"}
        elif pcr <= self.p.bear_pcr:
            want = {"CE"}
        else:
            want = {"PE", "CE"}
        targets = {"PE": self.symbol(support, "PE") if support else None, "CE": self.symbol(resistance, "CE") if resistance else None}
        book = self.pnl()["positions"]
        held = {s: p for s, p in book.items() if p["qty"] < 0}
        # Exits first: a broken wall, a stop loss, or a side the bias no longer wants. A leg stays when the wall moves.
        for sym, p in held.items():
            parts = option_parts(sym)
            right = parts["right"] if parts else None
            ltp = p.get("ltp")
            why = None
            if right == "PE" and spot <= parts["strike"]:
                why = "spot %.2f broke the %s support" % (spot, parts["strike"])
            elif right == "CE" and spot >= parts["strike"]:
                why = "spot %.2f broke the %s resistance" % (spot, parts["strike"])
            elif ltp is not None and p["avg"] and ltp >= p["avg"] * (1 + self.p.stop_loss_pct / 100):
                why = "stop loss: premium %.2f against entry %.2f" % (ltp, p["avg"])
            elif right not in want:
                why = "PCR %.2f no longer wants the %s side" % (pcr, right)
            if why:
                self.log.info("Buying back %s: %s", sym, why)
                self.exit(sym)
        held_rights = {option_parts(s)["right"] for s, q in self.positions().items() if q < 0 and option_parts(s)}
        for right in sorted(want - held_rights):
            sym = targets.get(right)
            if not sym:
                continue
            self.log.info("Selling %s at the %s wall", sym, "support" if right == "PE" else "resistance")
            self.sell(sym, lots=self.p.lots)
            self.subscribe(sym)

    def on_stop(self):
        if self.p.exit_on_stop and any(self.positions().values()):
            self.log.info("Stopping: buying back the open legs")
            self.exit_all()
