/**
 * Demo reference datasets (p1-02 §4): deterministic per IST date, a rolling corporate action inside 7 days, 2–3 stocks
 * in ban, the BANKNIFTY revision banner before each monthly expiry, demo masters agreeing with demo lots, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_UNDERLYINGS, demoInstruments, expiriesFor } from "../demo/demoAdapter.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { calendarDaysBetween, istInstant } from "./calendar.mjs";
import { parseReferenceConfig } from "./config.mjs";
import { DEMO_STOCK_LOT, demoDatasets, demoLotFor, demoPrice } from "./demoReference.mjs";
import { demoCalendar, demoStockLotFormula } from "./demoTables.mjs";
import { createReferenceService } from "./referenceService.mjs";

const DAYS = Array.from({ length: 60 }, (_, i) => istInstant("2026-10-01", "10:00") + i * 86_400_000);

afterEach(() => vi.unstubAllGlobals());

describe("DEMO_STOCK_LOT", () => {
  it("is round(₹7.5 lakh / base) to a multiple of 25 (min 25) for every NIFTY 50 demo stock", () => {
    const stocks = DEMO_UNDERLYINGS.filter((u) => u.kind === "EQ");
    expect(Object.keys(DEMO_STOCK_LOT).sort()).toEqual(stocks.map((u) => u.symbol).sort());
    for (const u of stocks) expect(DEMO_STOCK_LOT[u.symbol], u.symbol).toBe(demoStockLotFormula(u.base));
  });
});

describe("determinism and the daily datasets", () => {
  it("the same IST date gives the same data", () => {
    const a = demoDatasets(istInstant("2026-10-29", "09:30"));
    const b = demoDatasets(istInstant("2026-10-29", "18:00"));
    expect(b).toBe(a);
    expect(JSON.stringify(demoDatasets(istInstant("2026-10-30", "09:30")).ban)).not.toBe(JSON.stringify(a.ban));
  });

  it.each(DAYS)("day %#: a corporate action within 7 days, 2–3 stocks in ban, 3 high", (t) => {
    const d = demoDatasets(t);
    const upcoming = d.actions.filter((x) => x.exDate >= d.today && calendarDaysBetween(d.today, x.exDate) <= 7);
    expect(upcoming.length).toBeGreaterThanOrEqual(1);
    expect(d.ban.symbols.length).toBeGreaterThanOrEqual(2);
    expect(d.ban.symbols.length).toBeLessThanOrEqual(3);
    const bands = d.mwpl.rows.map((r) => r.band);
    expect(bands.filter((b) => b === "ban")).toHaveLength(d.ban.symbols.length);
    expect(bands.filter((b) => b === "high")).toHaveLength(3);
    for (const r of d.mwpl.rows.filter((x) => x.band === "ban")) expect(r.mwplPct).toBeGreaterThanOrEqual(95.2);
    expect(d.inferred[0]).toMatchObject({ origin: "inferred", contract: { lot: 1875, standardLot: 375 } });
  });

  it("universe: added 20 and 45 days ago, DEMOEXIT removed, knownSince 120 days back", () => {
    const d = demoDatasets(istInstant("2026-10-29", "10:00"));
    expect(d.knownSince).toBe("2026-07-01");
    expect(d.universe.intervals.filter((i) => !i.fromIsFirstFetch).map((i) => i.from).sort()).toEqual(["2026-09-15", "2026-10-09"]); // 14 Sep is a holiday (Ganesh Chaturthi)
    expect(d.universe.intervals.find((i) => i.symbol === "DEMOEXIT").to).not.toBe(null);
  });
});

describe("lots: demo masters and demo reference agree", () => {
  it("NIFTY 65, BANKNIFTY 30 then 35 after the next monthly expiry, SENSEX 20", () => {
    const t = istInstant("2026-10-29", "10:00");
    const rows = demoInstruments(t).filter((r) => r.expiry);
    expect(new Set(rows.filter((r) => r.underlying === "NIFTY").map((r) => r.lotSize))).toEqual(new Set([65]));
    expect(new Set(rows.filter((r) => r.underlying === "SENSEX").map((r) => r.lotSize))).toEqual(new Set([20]));
    const bn = expiriesFor("BANKNIFTY", t);
    const bnLots = Object.fromEntries(rows.filter((r) => r.underlying === "BANKNIFTY").map((r) => [r.expiry, r.lotSize]));
    expect(bnLots[bn[0]]).toBe(30);
    expect(bnLots[bn[1]]).toBe(35);
    expect(demoLotFor("BANKNIFTY", bn[1], bn[0])).toBe(35);
  });

  it("demo holidays are verified except the last one of each year, so the unverified treatment can be seen", () => {
    const cal = demoCalendar();
    const y2026 = cal.holidays.filter((x) => x.date.startsWith("2026"));
    expect(y2026.filter((x) => !x.verified).map((x) => x.date)).toEqual(["2026-12-25"]);
    expect(cal.holidayOn("2026-11-24", "NFO")).toMatchObject({ verified: true });
  });

  it("holiday expiries move to the previous trading day", () => {
    const t = istInstant("2026-10-29", "10:00");
    expect(expiriesFor("NIFTY", t)).toEqual(["2026-11-03", "2026-11-09", "2026-11-17", "2026-11-23"]);
    expect(expiriesFor("BANKNIFTY", t)[0]).toBe("2026-11-23");
    for (const e of expiriesFor("NIFTY", t, 12)) expect(demoCalendar().isTradingDay(e, "NFO")).toBe(true);
  });
});

describe("the demo service", () => {
  const demoService = (t) => {
    const clock = { now: () => t };
    const symbols = createFakeSymbolService({ masters: { fake: demoInstruments(t) } });
    return createReferenceService({ config: { demo: true, reference: parseReferenceConfig({}) }, logger: createNullLogger(), clock, paths: {}, symbols });
  };

  it("never touches the network: sync and sources refuse, fetch is never called", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used in demo mode");
    });
    const svc = demoService(istInstant("2026-10-29", "10:00"));
    expect(() => svc.setSources({ nseArchives: true })).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    await expect(svc.sync({ datasets: ["lots"] })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    const b = await svc.bundle({ underlying: "NIFTY" });
    expect(b).toMatchObject({ lots: { current: 65, source: "demo", stale: false }, rate: { value: 0.065, source: "default (not sourced)", quality: "default" } });
    expect(svc.status()).toMatchObject({ demo: true, datasets: { lots: { available: true, source: "demo" } } });
  });

  it("the demo stale switch ages the lots in status() too, so the status strip agrees with the bundle", async () => {
    const svc = demoService(istInstant("2026-10-29", "10:00"));
    expect(svc.status()).toMatchObject({ demoLotsStale: false, datasets: { lots: { stale: false, asOf: "2026-10-29" } } });
    svc.setDemoLotsStale(true);
    const s = svc.status();
    expect(s.demoLotsStale).toBe(true);
    expect(s.datasets.lots).toMatchObject({ stale: true, asOf: "2026-10-27", staleTradingDays: 2 });
    expect((await svc.bundle({ underlying: "NIFTY" })).lots).toMatchObject({ stale: true, asOf: s.datasets.lots.asOf });
    svc.setDemoLotsStale(false);
    expect(svc.status().datasets.lots.stale).toBe(false);
  });

  it("the BANKNIFTY revision banner appears in the 7 days before each monthly expiry", async () => {
    for (const [day, expect7] of [
      ["2026-11-16", false],
      ["2026-11-18", true],
      ["2026-11-23", true],
    ]) {
      const svc = demoService(istInstant(day, "10:00"));
      const ev = await svc.events({ days: 7, underlying: "BANKNIFTY" });
      expect(ev.some((e) => e.kind === "lot-revision" && e.effectiveOn === "2026-11-25"), day).toBe(expect7);
    }
  });

  it("for every listed demo contract the reference lot equals the master lot (no conflict)", async () => {
    const t = istInstant("2026-10-29", "10:00");
    const svc = demoService(t);
    for (const u of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      const ex = await svc.expiries(u);
      expect(ex.expiries.length, u).toBeGreaterThan(0);
      for (const e of ex.expiries) {
        const l = await svc.lotFor(u, e.date, {});
        expect(l.conflict, `${u} ${e.date}`).toBe(null);
        expect(l.lot).toBe(e.lot);
      }
    }
  });

  it("the past split's example strikes: today's listed strikes are 'after', the pre-split strikes x5 'before'", () => {
    const t = istInstant("2026-10-29", "10:00");
    const svc = demoService(t);
    const split = svc.corporateActions().find((a) => a.type === "split");
    expect(split.exDate < "2026-10-29").toBe(true);
    const spot = demoPrice(split.symbol, t);
    const ex = split.adjusted.exampleStrikes;
    expect(ex).toHaveLength(5);
    const mid = ex[2];
    expect(Math.abs(mid.after - spot) / spot).toBeLessThan(0.02);
    for (const k of ex) expect(k.before).toBeCloseTo(k.after * 5, 2);
    expect(split.adjusted).toMatchObject({ lotBefore: DEMO_STOCK_LOT[split.symbol], lotAfter: DEMO_STOCK_LOT[split.symbol] * 5 });
    // The upcoming bonus still shows pre-action strikes near today's spot and their halves.
    const bonus = svc.corporateActions().find((a) => a.type === "bonus");
    const b = bonus.adjusted.exampleStrikes[2];
    expect(Math.abs(b.before - demoPrice(bonus.symbol, t)) / demoPrice(bonus.symbol, t)).toBeLessThan(0.02);
    expect(b.after).toBeCloseTo(b.before / 2, 2);
  });

  it("demoStale reports lots two trading days old", async () => {
    const svc = demoService(istInstant("2026-10-29", "10:00"));
    const b = await svc.bundle({ underlying: "NIFTY", demoStale: true });
    expect(b.lots).toMatchObject({ stale: true, staleTradingDays: 2, asOf: "2026-10-27" });
    expect(b.warnings.join(" ")).toMatch(/Contract data is 2 trading days old \(lot sizes from 27 Oct\)/);
  });
});
