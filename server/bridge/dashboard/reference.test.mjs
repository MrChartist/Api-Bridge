/** reference.js (docs/spec/p1-02-reference.md §5.1, §9.4): bundle loading, fallback, values, banners and the lot gate. */
import { describe, expect, it } from "vitest";
import { checkSource } from "./copyRules.mjs";
import { readFileSync } from "node:fs";
import {
  BANNER_DAYS,
  HIDDEN_SLOT,
  REF_DEFAULTS,
  REF_RETRY_MS,
  REF_TTL_MS,
  bannerModel,
  chipModel,
  clearReferenceCache,
  dayText,
  demoStaleAsked,
  eventShort,
  factsRows,
  fallbackBundle,
  hideEvent,
  holidayTomorrow,
  loadReference,
  basketLotGate,
  lotConfirmGate,
  lotStaleCheck,
  rateText,
  readHidden,
  refCalendar,
  refCharges,
  refRate,
  refSession,
  refSignature,
  staleText,
} from "./reference.js";

const BUNDLE = {
  underlying: "NIFTY",
  exchange: "NFO",
  session: { state: "OPEN", date: "2026-10-29", preOpen: "09:00", open: "09:15", close: "15:30", holiday: null, special: null, source: "S5 default" },
  nextTradingDay: "2026-10-30",
  holidays: [{ date: "2026-11-10", label: "Diwali Balipratipada", exchanges: ["NSE", "BSE"], verified: false }],
  rate: { value: 0.065, asOf: null, source: "default (not sourced)", quality: "default", stale: true },
  lots: { current: 65, next: { lot: 65, from: null }, source: "nse-archives:fo_mktlots.csv", asOf: "2026-10-29", stale: false, staleTradingDays: 0, conflict: null },
  freeze: { freezeQty: 1800, source: "exchange-list", verified: false },
  events: [],
  charges: { asOf: "2026-04-01", source: "Union Budget 2026 STT", opt: { sttSell: 0.0015, exerciseStt: 0.0015, stampBuy: 0.00003, txn: { NSE: 0.0003503, BSE: 0.000325 } }, fut: { sttSell: 0.0005, stampBuy: 0.00002, txn: { NSE: 0.0000173, BSE: 0 } }, sebiPerCrore: 10, ipftPerCrore: 0, gst: 0.18, brokerage: { kind: "flat", perOrder: 20 } },
};
const stale = (n = 2) => ({ ...BUNDLE, lots: { ...BUNDLE.lots, asOf: "2026-10-27", stale: true, staleTradingDays: n } });
const EVENTS = [
  { kind: "lot-revision", underlying: "BANKNIFTY", effectiveOn: "2026-11-25", daysAway: 5, text: "BANKNIFTY lot size changes from 30 to 35 for contracts from the Dec 2026 series (first trading day 25 Nov, in 5 days). Source: demo data, 29 Oct.", ref: {} },
  { kind: "corporate-action", underlying: "RELIANCE", effectiveOn: "2026-11-04", daysAway: 6, text: "RELIANCE 1:1 bonus, ex-date 4 Nov (in 4 trading days). Strikes halve and lots double on that day.", ref: { type: "bonus" } },
  { kind: "holiday-expiry-shift", underlying: "NIFTY", effectiveOn: "2026-11-09", daysAway: 3, text: "NIFTY weekly expiry is on 9 Nov, a day earlier than usual: 2026-11-10 is a holiday.", ref: {} },
  { kind: "holiday-expiry-shift", underlying: "NIFTY", effectiveOn: "2026-10-27", daysAway: -2, text: "already past", ref: {} },
];
/** A localStorage stand-in (store() shape); `throws` makes every call fail as blocked storage does. */
const memStore = (throws = false) => {
  const m = new Map();
  return {
    get: (k) => {
      if (throws) throw new Error("blocked");
      return m.get(k) ?? null;
    },
    set: (k, v) => {
      if (throws) throw new Error("blocked");
      m.set(k, v);
    },
  };
};

describe("loadReference", () => {
  it("reads the bundle once per underlying for 10 minutes, then again", async () => {
    clearReferenceCache();
    const calls = [];
    const get = async (path) => (calls.push(path), { ...BUNDLE });
    const a = await loadReference("nifty", { get, now: 1000 });
    const b = await loadReference("NIFTY", { get, now: 1000 + REF_TTL_MS - 1 });
    expect(a).toBe(b);
    expect(calls).toEqual(["/v1/reference/bundle?underlying=NIFTY"]);
    await loadReference("NIFTY", { get, now: 1000 + REF_TTL_MS + 1 });
    await loadReference("BANKNIFTY", { get, now: 1000 });
    await loadReference("NIFTY", { get, now: 2000, force: true });
    expect(calls).toHaveLength(4);
    await loadReference("NIFTY", { get, now: 2000, demoStale: true });
    expect(calls.at(-1)).toBe("/v1/reference/bundle?underlying=NIFTY&demoStale=1");
  });

  it("falls back to the labelled dashboard defaults when the bundle fails, and tries again after a backoff", async () => {
    clearReferenceCache();
    let fail = true;
    const get = async () => {
      if (fail) throw new Error("Not found");
      return { ...BUNDLE };
    };
    const b = await loadReference("NIFTY", { get, now: 0 });
    expect(b.fallback).toBe(true);
    expect(refRate(b)).toMatchObject({ value: REF_DEFAULTS.rate.value, source: "dashboard fallback", isDefault: true });
    expect(refSession(b)).toMatchObject({ open: REF_DEFAULTS.session.open, close: REF_DEFAULTS.session.close });
    expect(chipModel(b).tone).toBe("bad");
    expect(bannerModel(b).shown[0].text).toBe("Reference data unavailable: using dashboard defaults");
    fail = false;
    expect((await loadReference("NIFTY", { get, now: REF_RETRY_MS + 1 })).fallback).toBeUndefined();
    // A bundle without a session is not trusted either.
    clearReferenceCache();
    expect((await loadReference("NIFTY", { get: async () => ({}), now: 0 })).fallback).toBe(true);
  });

  it("a failing read is not repeated on every refresh tick: one request per backoff, the same fallback object", async () => {
    clearReferenceCache();
    let calls = 0;
    const get = async () => {
      calls += 1;
      throw new Error("The Bridge answered 429");
    };
    const a = await loadReference("NIFTY", { get, now: 0 });
    const b = await loadReference("NIFTY", { get, now: 3000 });
    const c = await loadReference("NIFTY", { get, now: REF_RETRY_MS - 1 });
    expect(calls).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(refSignature(b)).toBe(refSignature(a));
    // After the backoff it asks again; a second failure doubles the wait, up to the 10-minute TTL.
    const d = await loadReference("NIFTY", { get, now: REF_RETRY_MS });
    expect(calls).toBe(2);
    expect(refSignature(d)).toBe(refSignature(a));
    await loadReference("NIFTY", { get, now: REF_RETRY_MS + 2 * REF_RETRY_MS - 1 });
    expect(calls).toBe(2);
    await loadReference("NIFTY", { get, now: REF_RETRY_MS + 2 * REF_RETRY_MS });
    expect(calls).toBe(3);
    // force still reads at once.
    await loadReference("NIFTY", { get, now: REF_RETRY_MS + 2 * REF_RETRY_MS + 1, force: true });
    expect(calls).toBe(4);
  });

  it("asks for stale demo lots only when the page URL says so", () => {
    expect(demoStaleAsked("#/chain?demoStale=1")).toBe(true);
    expect(demoStaleAsked("#/chain")).toBe(false);
  });
});

describe("values from a bundle", () => {
  it("rate, session, calendar and charges", () => {
    expect(rateText(BUNDLE)).toBe("6.50 % default, not sourced");
    expect(rateText({ rate: { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill", quality: "user", stale: false } })).toBe("5.71 % · 91-day T-bill (28 Oct)");
    expect(rateText(null)).toBe("6.50 % dashboard default");
    expect(refSession({ session: { open: "bad" } }).open).toBe(REF_DEFAULTS.session.open);
    const cal = refCalendar(BUNDLE);
    expect(cal.isTradingDay("2026-11-10")).toBe(false);
    expect(cal.isTradingDay("2026-11-07")).toBe(false); // Saturday
    expect(cal.isTradingDay("2026-11-09")).toBe(true);
    expect(cal.label("2026-11-10")).toBe("Diwali Balipratipada");
    // A BSE-only holiday does not close NFO.
    expect(refCalendar({ exchange: "NFO", holidays: [{ date: "2026-11-11", label: "x", exchanges: ["BSE"] }] }).isTradingDay("2026-11-11")).toBe(true);
    // A timed special session makes its day a trading day (spec §6.4); an untimed one does not.
    const muhurat = { exchange: "NFO", holidays: [], session: { date: "2026-11-08", open: "09:15", close: "15:30", special: { label: "Muhurat", open: "18:00", close: "19:00" } } };
    expect(refCalendar(muhurat).isTradingDay("2026-11-08")).toBe(true);
    expect(refCalendar({ ...muhurat, session: { ...muhurat.session, special: { label: "Muhurat", open: null, close: null } } }).isTradingDay("2026-11-08")).toBe(false);
    // "Holiday tomorrow" only for a weekday: Friday 6 Nov evening, with a (made-up) Saturday holiday, says nothing.
    const sat = { exchange: "NFO", holidays: [{ date: "2026-11-07", label: "Sat holiday", exchanges: ["NSE", "BSE"] }, { date: "2026-11-10", label: "Diwali Balipratipada", exchanges: ["NSE", "BSE"] }] };
    expect(holidayTomorrow(sat, Date.parse("2026-11-06T12:00:00Z"))).toBeNull();
    expect(holidayTomorrow(sat, Date.parse("2026-11-09T12:00:00Z"))).toBe("Diwali Balipratipada");
    const r = refCharges(BUNDLE);
    expect(r).toMatchObject({ asOf: "Apr 2026", asOfDate: "2026-04-01", brokeragePerOrder: 20, gst: 0.18 });
    expect(refCharges(null).opt).toEqual(REF_DEFAULTS.charges.opt);
  });

  it("formats dates without Intl", () => {
    expect(dayText("2026-10-27")).toBe("27 Oct");
    expect(dayText("2026-11-24", { weekday: true, year: true })).toBe("Tue 24 Nov 2026");
    expect(dayText("x")).toBe("--");
  });
});

describe("lotConfirmGate (acceptance criterion 4)", () => {
  it("is needed for stale lots or a master/reference conflict, never otherwise", () => {
    expect(lotConfirmGate(BUNDLE, 65).needed).toBe(false);
    const g = lotConfirmGate(stale(), 65);
    expect(g).toMatchObject({ needed: true, reason: "stale", lot: 65 });
    expect(g.text).toBe("Lot size 65 units, from 27 Oct (2 trading days old). I have checked it.");
    const c = lotConfirmGate({ ...BUNDLE, lots: { ...BUNDLE.lots, conflict: { master: 65, reference: 75 } } }, 65);
    expect(c).toMatchObject({ needed: true, reason: "conflict" });
    expect(c.text).toContain("the reference list says 75");
    // A fallback bundle: staleness is unknown, so lots are confirmed against the broker's contract.
    const f = lotConfirmGate(fallbackBundle("NIFTY"), 65);
    expect(f).toMatchObject({ needed: true, reason: "fallback", lots: [65] });
    expect(f.text).toBe("Reference data unavailable: lot size 65 units from your broker's contract. I have checked it.");
    // No bundle yet (the ticket waits for it) or no lot: nothing to confirm against.
    expect(lotConfirmGate(null, 65).needed).toBe(false);
    expect(lotConfirmGate(stale(), null).needed).toBe(false);
    expect(lotConfirmGate(stale(), 0).needed).toBe(false);
    // An order in units is never gated; futures in lots are (the ticket passes no options-only exception).
    expect(lotConfirmGate(stale(), 65, { units: true }).needed).toBe(false);
  });

  it("a per-contract LOT_SIZE_STALE from the order preview opens the gate the bundle did not (truth table)", () => {
    const server = { code: "LOT_SIZE_STALE", severity: "block", message: "Lot size for NIFTY is from 27 Oct (2 trading days old). Confirm 65 units per lot or send quantity in units." };
    // [bundle, server check, units] → needed / reason
    const table = [
      [BUNDLE, null, false, false, null],
      [BUNDLE, server, false, true, "server"],
      [BUNDLE, server, true, false, null],
      [BUNDLE, { code: "SPREAD_WIDE", message: "x" }, false, false, null],
      [stale(), server, false, true, "stale"],
      [fallbackBundle("NIFTY"), null, false, true, "fallback"],
      [fallbackBundle("NIFTY"), null, true, false, null],
      [null, server, false, false, null],
    ];
    for (const [b, s, units, needed, reason] of table) expect(lotConfirmGate(b, 65, { server: s, units })).toMatchObject({ needed, reason });
    expect(lotConfirmGate(BUNDLE, 65, { server }).text).toBe("Lot size for NIFTY is from 27 Oct (2 trading days old). Lot size 65 units from your broker's contract. I have checked it.");
    expect(lotStaleCheck([{ code: "X" }, server])).toBe(server);
    expect(lotStaleCheck(undefined)).toBe(null);
  });

  it("the basket gate names every distinct lot, and confirms only those (calendar with different lots)", () => {
    const legs = [
      { lotSize: 30, expiry: "2026-11-24" },
      { lotSize: 30, expiry: "2026-11-24" },
      { lotSize: 35, expiry: "2026-12-29" },
    ];
    const g = basketLotGate(stale(), legs);
    expect(g).toMatchObject({ needed: true, reason: "stale", lots: [30, 35] });
    expect(g.text).toBe("Lot sizes 30 units (Nov), 35 units (Dec), from 27 Oct (2 trading days old). I have checked them.");
    expect(basketLotGate(BUNDLE, legs).needed).toBe(false);
    expect(basketLotGate(fallbackBundle("BANKNIFTY"), legs)).toMatchObject({ needed: true, reason: "fallback", lots: [30, 35] });
    const sv = basketLotGate(BUNDLE, legs, { server: [{ code: "LOT_SIZE_STALE", message: "Lot size for BANKNIFTY differs between the broker master (35) and the reference file (30). Confirm 35 units per lot or send quantity in units." }] });
    expect(sv).toMatchObject({ needed: true, reason: "server", lots: [30, 35] });
    expect(sv.text).toContain("Lot sizes 30 units (Nov), 35 units (Dec)");
    // One distinct lot reads like the ticket's gate.
    expect(basketLotGate(stale(), legs.slice(0, 2)).text).toBe("Lot size 30 units, from 27 Oct (2 trading days old). I have checked it.");
    // The basket sends lotSizeConfirmed only for a lot in gate.lots.
    const src = readFileSync(new URL("./strategy-place.js", import.meta.url), "utf8");
    expect(src).toMatch(/\(gate\.lots \?\? \[\]\)\.includes\(Number\(r\.lotSize\)\)\) b\.lotSizeConfirmed = Number\(r\.lotSize\)/);
  });

  it("the order ticket gates futures in lots as well as options", () => {
    const src = readFileSync(new URL("./desk.js", import.meta.url), "utf8");
    expect(src).toMatch(/let gate = lotConfirmGate\(st\.ref, lotSize, \{ units: inUnits \}\)/);
    expect(src).not.toMatch(/!fut && !inUnits \? lotConfirmGate/);
  });

  it("the ticket works the gate out again on its 1 s tick and waits for the first bundle (spec §5.4)", () => {
    const src = readFileSync(new URL("./desk.js", import.meta.url), "utf8");
    expect(src).toMatch(/const g = lotConfirmGate\(st\.ref, lotSize, \{ units: inUnits, server: serverLot \}\)/);
    expect(src).toMatch(/setInterval\(\(\) => \(drawQuote\(\), drawWarnings\(\), syncGate\(\)\), 1000\)/);
    expect(src).toMatch(/const gateOk = \(\) => !refPending\(\) && \(!gate\.needed \|\| gateBox\.checked\)/);
    expect(src).toMatch(/"Reading contract data"/);
  });

  it("every page passes the reference rate to parityGrowth (spec §5.6: no caller drops it)", () => {
    const calls = [];
    for (const f of ["desk.js", "positions.js", "options.js", "volatility.js", "arbitrage.js", "oi.js", "strategy.js"]) {
      let src = "";
      try {
        src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      } catch {
        continue;
      }
      for (const m of src.matchAll(/parityGrowth\(([^()]|\([^()]*\))*\)/g)) if (!/export const parityGrowth/.test(src.slice(Math.max(0, m.index - 20), m.index + 14))) calls.push(`${f}: ${m[0]}`);
    }
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c, c).toMatch(/,\s*(refRate\(st\.ref\)\.value|rate)\)$/);
  });

  it("the strategy basket refuses to run without the lot-size tick, not only through the disabled button", () => {
    const src = readFileSync(new URL("./strategy-place.js", import.meta.url), "utf8");
    expect(src).toMatch(/if \(blocked\(\) \|\| !gateOk\(\) \|\| \(isLive\(\) && !ack\.checked\)\) return;/);
    expect(src).toMatch(/Tick the lot-size check above/);
  });
});

describe("banners and the chip", () => {
  it("say what each event kind is, descriptively (no banned words)", () => {
    const b = { ...BUNDLE, events: EVENTS };
    const m = bannerModel(b, { max: 5 });
    expect(m.shown.map((x) => x.kind)).toEqual(["holiday-expiry-shift", "lot-revision", "corporate-action"]);
    expect(m.more).toBe(0);
    for (const x of m.all) expect(checkSource(JSON.stringify(x.text))).toEqual([]);
    expect(EVENTS.slice(0, 3).map(eventShort)).toEqual(["Lot change 25 Nov", "Bonus ex 4 Nov", "Expiry on 9 Nov"]);
    // At most `max` show; the rest is counted.
    expect(bannerModel(b, { max: 2 })).toMatchObject({ more: 1 });
    // The server keeps only events within reference.bannerDays; the client trusts that window (a user's bannerDays of
    // 10 reaches the banners) and drops only past events.
    expect(BANNER_DAYS).toBe(7);
    expect(bannerModel(b, { max: 9 }).all.some((x) => x.text === "already past")).toBe(false);
    expect(bannerModel({ ...BUNDLE, events: [{ kind: "lot-revision", underlying: "NIFTY", effectiveOn: "2026-11-08", daysAway: 10, text: "ten days out" }] }, { max: 9 }).all.some((x) => x.text === "ten days out")).toBe(true);
  });

  it("put the stale warning first and hide events for the day", () => {
    const b = { ...stale(), events: EVENTS };
    const m = bannerModel(b, { max: 9, hidden: { "holiday-expiry-shift:NIFTY:2026-11-09": "2026-10-29" } });
    expect(m.shown[0]).toMatchObject({ kind: "stale", tone: "warn", hideable: false });
    expect(m.shown[0].text).toBe("Contract data is 2 trading days old (lot sizes from 27 Oct). Check the lot size before ordering in lots.");
    expect(m.shown.map((x) => x.kind)).not.toContain("holiday-expiry-shift");
    expect(staleText(BUNDLE)).toBeNull();
    // The rate is never a banner (ui-pass-3.md §6): banners are notices to act on; the chip says where the rate comes from.
    expect(bannerModel(BUNDLE, { rateNote: true }).all.map((x) => x.kind)).not.toContain("rate");
    expect(bannerModel(BUNDLE).shown).toEqual([]);
  });

  it("warn when a stock's ban list is older than allowed (the bundle's ban.stale)", () => {
    const ban = { inBan: false, mwplPct: 84.2, band: "high", forDate: "2026-10-30", asOf: "2026-10-26", source: "nse-archives:combineoi", stale: true, staleTradingDays: 3 };
    const m = bannerModel({ ...BUNDLE, underlying: "RELIANCE", ban });
    expect(m.shown[0]).toMatchObject({ kind: "stale", tone: "warn" });
    expect(m.shown[0].text).toBe("The ban list and MWPL are from 26 Oct (3 trading days old). Check them before opening positions in this stock.");
    expect(staleText({ ...BUNDLE, ban: { ...ban, stale: false, staleTradingDays: 1 } })).toBeNull();
  });

  it("remember hidden events until tomorrow and survive storage that throws", () => {
    const s = memStore();
    hideEvent("a", "2026-10-29", s);
    expect(readHidden("2026-10-29", s)).toEqual({ a: "2026-10-29" });
    expect(readHidden("2026-10-30", s)).toEqual({});
    s.set(HIDDEN_SLOT, "not json");
    expect(readHidden("2026-10-29", s)).toEqual({});
    const bad = memStore(true);
    expect(() => hideEvent("a", "2026-10-29", bad)).not.toThrow();
    expect(readHidden("2026-10-29", bad)).toEqual({});
  });

  it("chip reads Lot · Freeze · events, with a warning tone when stale", () => {
    const m = chipModel({ ...BUNDLE, events: EVENTS.slice(2, 3) }, { lot: 65, now: Date.UTC(2026, 9, 29, 5) });
    expect(m).toMatchObject({ text: "Lot 65 · Freeze 1800 · 1 event", short: "Lot 65 · 1 event", tone: "normal", dot: true, count: 1 });
    expect(chipModel(stale(), { lot: 65 })).toMatchObject({ text: "Lot 65 · Freeze 1800 · Stale", tone: "warn" });
    // The day before a weekday holiday: "Holiday tomorrow".
    expect(chipModel(BUNDLE, { lot: 65, now: Date.UTC(2026, 10, 9, 5) }).text).toBe("Lot 65 · Freeze 1800 · Holiday tomorrow");
    expect(chipModel(BUNDLE, { lot: 65 }).aria).toContain("Open contract facts");
    // Fallback: with a chain lot it still shows the lot; with none (Market calendar) it says so in words, never "Lot --".
    expect(chipModel(fallbackBundle("NIFTY"), { lot: 65 })).toMatchObject({ text: "Lot 65 · Defaults", tone: "bad" });
    expect(chipModel(fallbackBundle("NIFTY"))).toMatchObject({ text: "Reference: defaults", short: "Reference: defaults", tone: "bad" });
    expect(chipModel(fallbackBundle("NIFTY")).aria).toContain("Reference data unavailable");
  });

  it("chip names a default or old rate on the pages that price with it, with the warn dot", () => {
    const m = chipModel(BUNDLE, { lot: 65, rate: true, now: Date.UTC(2026, 9, 29, 5) });
    expect(m).toMatchObject({ text: "Lot 65 · Freeze 1800 · Rate 6.50 % default", rateWarn: true, dot: true, tone: "normal" });
    expect(chipModel(BUNDLE, { lot: 65, now: Date.UTC(2026, 9, 29, 5) })).toMatchObject({ rateWarn: false });
    const sourced = { ...BUNDLE, rate: { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill", quality: "user", stale: false } };
    expect(chipModel(sourced, { lot: 65, rate: true, now: Date.UTC(2026, 9, 29, 5) })).toMatchObject({ text: "Lot 65 · Freeze 1800", rateWarn: false });
    expect(chipModel({ ...sourced, rate: { ...sourced.rate, stale: true } }, { lot: 65, rate: true, now: Date.UTC(2026, 9, 29, 5) }).text).toBe("Lot 65 · Freeze 1800 · Rate 5.71 % old");
  });

  it("facts sheet rows carry each value's source", () => {
    const rows = factsRows({ ...BUNDLE, events: EVENTS.slice(2, 3) }, { lot: 65 });
    const by = Object.fromEntries(rows.map((r) => [r.k, r]));
    expect(by["Session today"].v).toBe("09:15–15:30 IST");
    expect(by["Lot size"].sub).toContain("nse-archives:fo_mktlots.csv");
    expect(by["Freeze qty"]).toMatchObject({ v: "1800 units" });
    expect(by.Rate.sub).toContain("default, not sourced");
    expect(by.Upcoming.v).toBe("Expiry on 9 Nov");
    expect(factsRows({ ...BUNDLE, freeze: { freezeQty: null } }).find((r) => r.k === "Freeze qty").sub).toBe("Freeze qty unknown: slicing is not checked");
  });
});

describe("reference.js holds the only dashboard copy of the S5 defaults", () => {
  it("every default is tagged as a fallback", () => {
    expect(REF_DEFAULTS.rate.source).toBe("dashboard fallback");
    expect(REF_DEFAULTS.session.source).toBe("dashboard fallback");
    expect(REF_DEFAULTS.charges.brokerage.source).toBe("dashboard fallback");
    expect(Object.isFrozen(REF_DEFAULTS)).toBe(true);
  });
  it("no banned words in its strings", () => {
    expect(checkSource(readFileSync(new URL("./reference.js", import.meta.url), "utf8"))).toEqual([]);
  });
});
