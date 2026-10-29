/** Option Screener logic (screens.js): presets, settings, the filter funnel, reasons, hand-off and the baseline. */
import { describe, expect, it } from "vitest";
import * as O from "./options.js";
import * as S from "./screens.js";

const NOW = Date.UTC(2026, 9, 29, 4, 0); // 29 Oct 2026 09:30 IST
const priced = (k, right, F = 26450) => {
  const p = O.black76(F, k, 5 / 365, 14, right);
  const d = O.probItm(F, k, 5 / 365, 14, right);
  return { symbol: `NFO:NIFTY-2026-11-03-${k}-${right}`, ltp: p, bid: Math.max(0.05, p - 0.3), ask: p + 0.3, oi: 750000, oiChange: k % 100 ? -30000 : 90000, volume: 3000000 + (k === 26700 ? 30000000 : 0), iv: 14 + (k === 26300 ? 2 : 0), close: p * 0.9, change: p * 0.1, delta: right === "CE" ? d : -d, theta: -p * 0.05, vega: 5 };
};
const strikes = Array.from({ length: 25 }, (_, i) => 25850 + i * 50);
const chain = (expiry = "2026-11-03", u = "NIFTY") => ({ underlying: u, expiry, underlyingLtp: 26450, atmStrike: 26450, lotSize: 75, rows: strikes.map((k) => ({ strike: k, ce: priced(k, "CE"), pe: priced(k, "PE") })) });

describe("screener presets", () => {
  it("has eight presets with unique ids, a fixed lead, formula titles and valid defaults", () => {
    expect(S.PRESETS.map((p) => p.id)).toEqual(["overview", "unusual", "buildup", "sell", "buy", "ivout", "hedge", "arb"]);
    for (const p of S.PRESETS) {
      const ids = p.columns.map((c) => c.id);
      expect(new Set(ids).size, p.id).toBe(ids.length);
      expect(p.columns[0].id).toBe("name");
      for (const c of p.columns) {
        expect([1, 2, 3], `${p.id}.${c.id}`).toContain(c.p);
        expect(c.title.length, `${p.id}.${c.id} title`).toBeGreaterThan(3);
      }
      expect(p.columns.find((c) => c.id === p.defaults.sort.by)?.sortable, p.id).toBe(true);
      for (const id of Object.keys(p.defaults.filters)) expect(p.filters, `${p.id} ${id}`).toContain(id);
      for (const k of [p.card.badge, ...p.card.keys]) expect(ids, `${p.id} card ${k}`).toContain(k);
      expect(p.description.length).toBeLessThan(140);
    }
  });

  it("every column formats a missing value as --", () => {
    for (const p of S.PRESETS) for (const c of p.columns) if (!c.text && c.id !== "name") expect(c.fmt(null, {}), `${p.id}.${c.id}`).toBe("--");
  });
});

describe("chain records and runPreset", () => {
  const scan = () => {
    const parts = [S.chainRecords(chain("2026-11-03"), { now: NOW, hv20: 12, fetchedAt: NOW }), S.chainRecords(chain("2026-11-10"), { now: NOW, hv20: 12, fetchedAt: NOW })];
    return S.finishScan(parts, { base: { "NIFTY|2026-11-03": { atmIv: 13, at: NOW } } });
  };

  it("builds legs, overview, hedges and arbitrage rows; joins term and the baseline", () => {
    const s = scan();
    expect(s.chains).toBe(2);
    expect(s.legs.length).toBe(100);
    expect(s.overview.map((o) => o.key)).toEqual(["NIFTY|2026-11-03", "NIFTY|2026-11-10"]);
    const o = s.overview[0];
    expect(o.name).toBe("NIFTY 3 Nov");
    expect(o.term).toBeCloseTo(o.atmIv - s.overview[1].atmIv, 10);
    expect(o.ivChg).toBeCloseTo(o.atmIv - 13, 10);
    expect(o.verdict.basis).toBe("hv");
    expect(s.legs[0].name).toBe("NIFTY 3 Nov 25850 CE");
    expect(S.chainRecords({ ...chain("2026-10-01") }, { now: NOW })).toBeNull();
  });

  it("runs filters in a fixed order with funnel counts, sorts stably, limits rows", () => {
    const s = scan();
    const sell = S.presetById("sell");
    const r = S.runPreset(S.recordsFor(s, sell), sell, S.defaultFilters(sell));
    expect(r.funnel.map((f) => f.filter)).toEqual(sell.filters);
    expect(r.funnel.reduce((a, f) => a + f.removed, 0) + r.total).toBe(100);
    for (let i = 1; i < r.rows.length; i++) expect((r.rows[i - 1].scoreSell ?? -1) >= (r.rows[i].scoreSell ?? -1)).toBe(true);
    const lim = S.runPreset(S.recordsFor(s, sell), sell, S.defaultFilters(sell), null, { limit: 2 });
    expect(lim.rows.length).toBeLessThanOrEqual(2);
    expect(lim.total).toBe(r.total);
    // Δ min 0.95 leaves nothing; the funnel says why
    const none = S.runPreset(S.recordsFor(s, sell), sell, { ...S.defaultFilters(sell), absDelta: [0.95, 0.99] });
    expect(none.total).toBe(0);
    expect(S.topBlockers(none.funnel)[0].removed).toBeGreaterThan(0);
  });

  it("sorts asc / desc with ties broken by the lead text and missing values last", () => {
    const p = { ...S.presetById("buy"), filters: [] };
    const recs = [{ name: "B", scoreBuy: 5 }, { name: "A", scoreBuy: 5 }, { name: "C", scoreBuy: null }, { name: "D", scoreBuy: 9 }];
    expect(S.runPreset(recs, p, {}, { by: "scoreBuy", dir: "desc" }).rows.map((r) => r.name)).toEqual(["D", "A", "B", "C"]);
    expect(S.runPreset(recs, p, {}, { by: "scoreBuy", dir: "asc" }).rows.map((r) => r.name)).toEqual(["A", "B", "D", "C"]);
  });

  it("relaxes a filter to its default, then a step wider", () => {
    expect(S.relaxValue("spread", 1, 3)).toBe(3);
    expect(S.relaxValue("spread", 3, 3)).toBe(5);
    expect(S.relaxValue("liq", 3, 3)).toBe(2);
    expect(S.relaxValue("absDelta", [0.1, 0.3], [0.1, 0.3])).toEqual([0.05, 0.35]);
    expect(S.relaxValue("otm", true, true)).toBe(false);
    expect(S.filterText("absDelta", [0.1, 0.3])).toBe("Δ 0.10–0.30");
    expect(S.filterText("spread", 3)).toBe("Spread ≤ 3%");
    expect(S.filterText("pop", 65)).toBe("POP ≥ 65%");
  });

  it("writes deterministic reasons of at most 80 characters without --", () => {
    const s = scan();
    for (const p of S.PRESETS) {
      for (const rec of S.recordsFor(s, p).slice(0, 30)) {
        const t = S.reason(rec, p.id);
        expect(t.length, p.id).toBeLessThanOrEqual(80);
        expect(t).not.toMatch(/--/);
        expect(S.reason(rec, p.id)).toBe(t);
      }
    }
    expect(S.reason({ volOi: 12.5, oiLots: 1200, oiChgPct: 4.2, changePct: -3 }, "unusual")).toBe("Vol/OI 12.5× on 1.2K lots OI · OI +4.2% · price -3.0%");
    expect(S.reason({ ivHv: -2, popLong: 0.34, leverage: 39.2 }, "buy")).toBe("IV 2.0 pts under HV · POP 34% · 39× leverage");
    expect(S.reason({ ivHv: 3.1, right: "PE", strike: 26000, support: 26200, thetaLot: 669 }, "sell")).toBe("IV 3.1 pts over HV · beyond put wall · θ ₹669/day");
  });

  it("recomputes every tab over about 1000 legs quickly", () => {
    const parts = Array.from({ length: 10 }, (_, i) => S.chainRecords(chain(`2026-11-${String(3 + i).padStart(2, "0")}`), { now: NOW, hv20: 12 }));
    const s = S.finishScan(parts);
    const t0 = performance.now();
    for (const p of S.PRESETS) S.runPreset(S.recordsFor(s, p), p, S.defaultFilters(p), null, { limit: 50 });
    expect(performance.now() - t0).toBeLessThan(60); // ≤ 6 ms in a browser; generous for CI
  });
});

describe("screenerConfig", () => {
  it("fills defaults from {} and garbage", () => {
    for (const saved of [undefined, null, "x", [], {}]) {
      const c = S.screenerConfig(saved);
      expect(c.preset).toBe("overview");
      expect(c.underlyings).toEqual(["NIFTY", "BANKNIFTY", "SENSEX"]);
      expect([c.expiries, c.monthly, c.strikes, c.auto, c.rows, c.brokerage, c.wingStrikes, c.hedgeNotional]).toEqual([2, true, 30, 120, 50, 20, 4, null]);
      expect(c.filters.sell.absDelta).toEqual([0.1, 0.3]);
      expect(c.sort.hedge).toEqual({ by: "annualised", dir: "asc" });
    }
    expect(S.screenerConfig({}, { demo: true }).auto).toBe(60);
  });

  it("drops unknown ids, keeps column order, appends new columns, clamps ranges", () => {
    const c = S.screenerConfig({
      preset: "nope",
      underlyings: ["NIFTY", "ZZZ", "NIFTY"],
      expiries: 9,
      strikes: 25,
      auto: 30,
      rows: 7,
      brokerage: -5,
      wingStrikes: 50,
      filters: { sell: { absDelta: [0.4, 0.2], spread: "x", otm: "yes", side: "PE" }, buildup: { tags: ["SB", "QQ"] } },
      sort: { sell: { by: "nope", dir: "asc" }, buy: { by: "capital", dir: "asc" } },
      cols: { sell: ["-ivHv", "bid", "zzz", "name"] },
    });
    expect(c.preset).toBe("overview");
    expect(c.underlyings).toEqual(["NIFTY"]);
    expect([c.expiries, c.strikes, c.auto, c.rows, c.brokerage, c.wingStrikes]).toEqual([3, 30, 60, 50, 0, 10]);
    expect(c.filters.sell.absDelta).toEqual([0.2, 0.4]);
    expect(c.filters.sell.spread).toBe(3);
    expect(c.filters.sell.otm).toBe(true);
    expect(c.filters.sell.side).toBe("PE");
    expect(c.filters.buildup.tags).toEqual(["SB"]);
    expect(c.sort.sell).toEqual({ by: "scoreSell", dir: "desc" });
    expect(c.sort.buy).toEqual({ by: "capital", dir: "asc" });
    const sellIds = S.presetById("sell").columns.map((x) => x.id);
    expect(c.cols.sell.slice(0, 3)).toEqual(["name", "-ivHv", "bid"]);
    expect(c.cols.sell.map((x) => x.replace(/^-/, "")).sort()).toEqual([...sellIds].sort());
    expect(S.visibleColumns(S.presetById("sell"), c.cols.sell).map((x) => x.id)).not.toContain("ivHv");
    expect(S.screenerConfig({ auto: 0 }).auto).toBe(0);
    expect(S.screenerConfig({ auto: 290 }).auto).toBe(300);
  });

  it("picks the nearest N expiries plus the monthly, in sweep order", () => {
    expect(S.scanExpiries(["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"], { n: 2 })).toEqual(["2026-11-03", "2026-11-10", "2026-11-24"]);
    expect(S.scanExpiries(["2026-11-24", "2026-12-29"], { n: 2 })).toEqual(["2026-11-24", "2026-12-29"]);
    expect(S.scanExpiries(["2026-10-29", "2026-11-05", "2026-11-19"], { n: 2, monthly: true })).toEqual(["2026-10-29", "2026-11-05"]);
    expect(S.scanExpiries(["2026-11-03", "2026-11-10", "2026-11-24"], { n: 1, monthly: false })).toEqual(["2026-11-03"]);
    const order = S.scanOrder(new Map([["A", ["a1", "a2", "a3"]], ["B", ["b1"]]]));
    expect(order.map((x) => x.expiry)).toEqual(["a1", "b1", "a2", "a3"]);
  });
});

describe("handoffPrefs", () => {
  it("sets underlying, expiry and focus; merges the same leg; keeps other keys and baskets", () => {
    const prefs = { account: "paper", chain: { preset: "oi" }, baskets: { "BANKNIFTY|2026-11-24": [{ right: "CE", strike: 57000, side: "BUY", lots: 1 }], "NIFTY|2026-11-03": [{ right: "PE", strike: 26200, side: "SELL", lots: 1 }] } };
    const out = S.handoffPrefs(prefs, { underlying: "NIFTY", expiry: "2026-11-03", focus: { strike: 26200, side: "pe" }, leg: { right: "PE", strike: 26200, side: "SELL" } });
    expect(out.underlying).toBe("NIFTY");
    expect(out.expiry).toBe("2026-11-03");
    expect(out.focus).toEqual({ underlying: "NIFTY", expiry: "2026-11-03", strike: 26200, side: "pe" });
    expect(out.baskets["NIFTY|2026-11-03"]).toEqual([{ right: "PE", strike: 26200, side: "SELL", lots: 2 }]);
    expect(out.baskets["BANKNIFTY|2026-11-24"]).toEqual(prefs.baskets["BANKNIFTY|2026-11-24"]);
    expect(out.account).toBe("paper");
    expect(out.chain).toEqual({ preset: "oi" });
    expect(prefs.baskets["NIFTY|2026-11-03"][0].lots).toBe(1); // pure
    const two = S.handoffPrefs({}, { underlying: "NIFTY", expiry: "2026-11-10", legs: [{ right: "CE", strike: 26500, side: "BUY" }, { right: "PE", strike: 26400, side: "BUY" }] });
    expect(two.baskets["NIFTY|2026-11-10"].length).toBe(2);
    expect(two.focus).toBeUndefined();
  });
});

describe("dailyBaseline and HV", () => {
  it("keeps the first snapshot of the IST day and resets on a new day (18:45 UTC is the next IST day)", () => {
    const day1 = S.istDate(Date.UTC(2026, 9, 29, 10, 0));
    expect(day1).toBe("2026-10-29");
    const a = S.dailyBaseline(null, day1, [{ key: "NIFTY|2026-11-03", atmIv: 13, straddle: 300, pcr: 1 }], 1);
    const b = S.dailyBaseline(a.stored, day1, [{ key: "NIFTY|2026-11-03", atmIv: 15, straddle: 320, pcr: 1.1 }, { key: "SENSEX|2026-11-05", atmIv: null }], 2);
    expect(b.base["NIFTY|2026-11-03"]).toEqual({ atmIv: 13, straddle: 300, pcr: 1, at: 1 });
    expect(b.base["SENSEX|2026-11-05"]).toBeUndefined();
    const day2 = S.istDate(Date.UTC(2026, 9, 29, 18, 45));
    expect(day2).toBe("2026-10-30");
    const c = S.dailyBaseline(b.stored, day2, [{ key: "NIFTY|2026-11-03", atmIv: 15, straddle: 320, pcr: 1.1 }], 3);
    expect(c.stored.date).toBe("2026-10-30");
    expect(c.base["NIFTY|2026-11-03"].atmIv).toBe(15);
  });

  it("drops a final candle dated today before HV20", () => {
    const day = 86400;
    const t0 = Date.UTC(2026, 8, 1) / 1000;
    const candles = Array.from({ length: 30 }, (_, i) => ({ time: t0 + i * day, close: 100 * (1 + 0.01 * Math.sin(i)) }));
    const now = (t0 + 29 * day) * 1000 + 3600_000;
    const hv = S.hvFromCandles(candles, now);
    expect(hv.closes).toBe(29);
    expect(hv.hv20).toBeCloseTo(O.realisedVol(candles.slice(0, 29).map((c) => c.close), 20), 10);
  });
});
