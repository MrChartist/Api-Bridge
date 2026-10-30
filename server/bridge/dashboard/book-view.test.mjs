import { describe, expect, it } from "vitest";
import { aggregate, priceHolder, noDataReason } from "./book-core.js";
// views.js imports desk.js, which imports positions.js, which imports book-view.js: load it first so the cycle settles.
await import("./views.js");
const { bookViewModel, contractName, exitArgs, lotsText, money, moneyCompact, relationshipChip, SCOPES, BOOK_POLL_MS } = await import("./book-view.js");

const holder = (o) =>
  priceHolder({
    priceSource: { kind: "account", broker: "zerodha", account: "z" },
    accounts: [{ account: "z", broker: "zerodha", label: "Main", mode: "live", margin: { used: 145200, available: 310000, asOf: "2026-10-29T11:15:04+05:30", source: "broker" }, error: null }],
    underlyings: [
      {
        underlying: "NIFTY",
        spot: 25120,
        lot: 65,
        legs: [{ account: "z", symbol: "NFO:NIFTY-2026-11-03-25600-CE", kind: "OPT", right: "CE", strike: 25600, expiry: "2026-11-03", q: -130, avg: 82.4, mark: 120, markSource: "mid", greeks: { delta: 0.42, gamma: 0.00031, theta: -9.8, vega: 11.2 }, guarded: ["gd_1"] }],
      },
    ],
    ...o,
  });

const SELF = holder({ holder: "self", label: "Me", relationship: "self", inFamily: true });
const SPOUSE = holder({
  holder: "spouse",
  label: "Asha",
  relationship: "spouse",
  inFamily: true,
  priceSource: { kind: "none", code: "NO_DATA_ACCOUNT", reason: noDataReason("Asha") },
  accounts: [{ account: "u", broker: "upstox", label: "Asha", mode: "live", margin: null, error: null }],
  underlyings: [{ underlying: "SENSEX", spot: null, lot: 20, legs: [{ account: "u", symbol: "BFO:SENSEX-2026-11-05-83500-CE", kind: "OPT", right: "CE", strike: 83500, expiry: "2026-11-05", q: -40, avg: 245, mark: null, brokerPnl: 1350, greeks: null }] }],
});
const FRIEND = holder({ holder: "friend", label: "friend", relationship: "other", inFamily: false, accounts: [{ account: "d", broker: "dhan", label: "Friend", mode: "live", margin: null, error: { code: "BROKER_UNAVAILABLE", message: "Dhan did not answer." } }], underlyings: [] });

describe("book view-model (positions All accounts / Family)", () => {
  it("scopes and the 15 s poll", () => {
    expect(SCOPES.map(([v]) => v)).toEqual(["account", "all", "family"]);
    expect(BOOK_POLL_MS).toBe(15000);
  });

  it("family view: the totals strip, holder sections with relationship chips (text, not colour alone), outside list", () => {
    const body = aggregate([SELF, SPOUSE, FRIEND], { view: "family", family: { name: "Family", relationships: ["self", "spouse"] }, asOf: "2026-10-29T11:15:04+05:30" });
    const vm = bookViewModel(body, "family");
    expect(vm.strip.map((t) => [t.label, t.value])).toEqual([
      ["Family P&L", "−₹3538"],
      ["Θ ₹/day", "+₹1274"],
      ["Vega ₹/pt", "−₹1456"],
      ["₹Δ", "−₹13.72L"],
      ["Margin used / free", "₹1.45L / ₹3.10L"],
    ]);
    expect(vm.strip[4].sub).toBe("Sum of separate accounts; margin is not shared between accounts.");
    expect(vm.holders.map((x) => [x.label, x.chip.text])).toEqual([["Me", "Self"], ["Asha", "Spouse"]]);
    expect(vm.outside).toEqual([{ holder: "friend", label: "friend", chip: { text: "Other · Outside family", tone: "warn" }, accounts: "1 account", note: "Guards and alert actions are not allowed on this holder's accounts." }]);
    expect(vm.notes[0]).toMatch(/Margin is not shared between accounts/);
  });

  it("leg rows: account first, contract name, lots, position Greeks (q × per-unit), guard shield", () => {
    const vm = bookViewModel(aggregate([SELF], { view: "holders", family: { name: "Family", relationships: ["self"] }, asOf: "t" }), "all");
    const l = vm.holders[0].underlyings[0].legs[0];
    expect(l).toMatchObject({ account: "z", accountLabel: "Main", name: "NIFTY 3 Nov 25600 CE", lots: "−2 lots", side: "S", avg: "82.40", mark: "120.00", pnl: "−₹4888", pnlTone: "neg", delta: "−54.6", theta: "+₹1274", vega: "−₹1456", guarded: true });
    expect(vm.holders[0].chip.text).toBe("Self · Family");
    expect(vm.holders[0].underlyings[0].greeks.map((g) => g.k)).toEqual(["Δ", "₹Δ", "Γ", "Θ", "Vega"]);
    expect(vm.holders[0].accounts[0]).toMatchObject({ modeBadge: "Live", margin: "₹1.45L used · ₹3.10L free" });
    expect(vm.holders[0].accounts[0].asOf).toMatch(/^as reported by zerodha at /);
  });

  it("a holder without its own market data: Greeks — with the reason; P&L from the broker", () => {
    const vm = bookViewModel(aggregate([SPOUSE], { view: "holders", family: { name: "Family", relationships: ["spouse"] }, asOf: "t" }), "all");
    const u = vm.holders[0].underlyings[0];
    expect(u.greeks).toBeNull();
    expect(u.greeksMissing).toBe("No market-data account for Asha; Greeks need spot and IV from that holder's own data.");
    expect(u.legs[0]).toMatchObject({ delta: "–", theta: "–", pnl: "+₹1350", greeksTitle: u.greeksMissing });
  });

  it("an account error shows its message; the demo market-data account is never badged Live", () => {
    const vm = bookViewModel(aggregate([FRIEND], { view: "holders", family: { name: "Family", relationships: [] }, asOf: "t" }), "all");
    expect(vm.holders[0].accounts[0]).toMatchObject({ error: "Dhan did not answer.", pnlText: "–" });
    expect(vm.holders[0].chip).toEqual({ text: "Other · Outside family", tone: "warn" });
    const demo = bookViewModel({ holders: [{ ...SELF, accounts: [{ ...SELF.accounts[0], broker: "demo" }] }] }, "all");
    expect(demo.holders[0].accounts[0].modeBadge).toBe("Sample");
  });

  it("family scope never draws an outside-family holder, even from a holders-view body (while switching scope)", () => {
    const holdersBody = aggregate([SELF, SPOUSE, FRIEND], { view: "holders", family: { name: "Family", relationships: ["self", "spouse"] }, asOf: "t" });
    const vm = bookViewModel(holdersBody, "family");
    expect(vm.holders.map((x) => x.holder)).toEqual(["self", "spouse"]);
    expect(vm.holders.every((x) => x.inFamily)).toBe(true);
  });

  it("an unread account is called out: totals leave it out", () => {
    const vm = bookViewModel(aggregate([SELF, FRIEND], { view: "holders", family: { name: "Family", relationships: ["self"] }, asOf: "t" }), "all");
    expect(vm.unreadNote).toBe("1 account could not be read; totals leave it out.");
    expect(bookViewModel(aggregate([SELF], { view: "holders", family: { name: "Family", relationships: ["self"] }, asOf: "t" }), "all").unreadNote).toBeNull();
  });

  it("no visible holder: no totals strip of zeros, only the empty state", () => {
    const vm = bookViewModel(aggregate([], { view: "family", family: { name: "Family", relationships: ["self"] }, asOf: "t" }), "family");
    expect(vm.strip).toBeNull();
    expect(vm.visible).toBe(false);
    expect(vm.emptyReason).toBe("no-accounts");
  });

  it("exit ticket arguments: the leg's own account, full quantity, units when not a lot multiple, IV and Δ from the row", () => {
    const vm = bookViewModel(aggregate([SELF], { view: "holders", family: { name: "Family", relationships: ["self"] }, asOf: "t" }), "all");
    const l = vm.holders[0].underlyings[0].legs[0];
    const a = exitArgs(l);
    expect(a).toMatchObject({ account: "z", side: "BUY", qty: 130, held: 130, exit: true, units: false, lotSize: 65 });
    expect(a.quote()).toMatchObject({ ltp: 120, delta: 0.42 });
    expect(exitArgs({ ...l, q: -100 }).units).toBe(true);
  });

  it("formatters", () => {
    expect(money(-4888.4)).toBe("−₹4888");
    expect(money(0)).toBe("₹0");
    expect(money(null)).toBe("–");
    expect(moneyCompact(261248)).toBe("+₹2.61L");
    expect(lotsText(-130, 65)).toBe("−2 lots");
    expect(lotsText(65, 65)).toBe("+1 lot");
    expect(lotsText(10, 65)).toBe("+10 qty");
    expect(contractName({ kind: "FUT", expiry: "2026-11-24" }, "NIFTY")).toBe("NIFTY 24 Nov FUT");
    expect(relationshipChip({ relationship: null, inFamily: false }, "all")).toEqual({ text: "No relationship · Outside family", tone: "warn" });
  });
});
