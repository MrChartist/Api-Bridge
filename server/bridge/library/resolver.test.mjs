import { afterEach, describe, expect, it } from "vitest";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { NIFTY_EXPIRIES_HOLIDAY_SHIFT, at, fakeMarketData, optionsOf, standardMarket } from "./__fixtures__/fakes.mjs";
import { cleanupLibraries, makeLibrary } from "./__fixtures__/lib.mjs";

afterEach(cleanupLibraries);

const universe = (over = {}) => ({ underlying: "NIFTY", expiries: "current-weekly", strikes: { around: "atm", count: 10 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false, ...over });
const make = (name, u, o = {}) => {
  const t = makeLibrary(o);
  t.lib.create({ name, kind: "option-universe", universe: u });
  return t;
};

describe("ATM and strikes: rounded to the listed strike step", () => {
  it("NIFTY current-weekly, ATM +/- 10: 21 strikes on a step of 50 around 25000, both sides, with the index", async () => {
    const { lib } = make("n", universe());
    const r = await lib.resolve("n");
    expect(r.atmSource).toBe("live");
    expect(r.symbols[0]).toBe("NSE:NIFTY");
    const strikes = optionsOf(r.symbols)["2026-11-10"];
    expect(strikes.CE).toHaveLength(21);
    expect(strikes.CE[0]).toBe(24500);
    expect(strikes.CE.at(-1)).toBe(25500);
    expect(strikes.PE).toEqual(strikes.CE);
    expect(r.count).toBe(1 + 42);
    expect(r.expiries[0]).toMatchObject({ expiry: "2026-11-10", kind: "weekly", atm: 25000, step: 50, strikeSource: "listed", strikes: 21 });
    expect(r.underlying).toMatchObject({ symbol: "NSE:NIFTY", price: 25012, class: "realtime" });
    expect(r.rule).toMatch(/current-weekly/);
    expect(r.resolvedAt).toBe("2026-11-09T05:30:00.000Z");
  });

  it.each([
    [25024, 25000],
    [25025, 25000], // an exact tie goes to the lower strike
    [25026, 25050],
    [25074.9, 25050],
    [25075, 25050],
    [24980, 25000],
  ])("price %f gives ATM %f", async (price, atm) => {
    const { lib, market } = make("n", universe({ strikes: { around: "atm", count: 2 } }));
    market.setPrice("NSE:NIFTY", price);
    const r = await lib.resolve("n");
    expect(r.expiries[0].atm).toBe(atm);
    expect(optionsOf(r.symbols)["2026-11-10"].CE).toEqual([atm - 100, atm - 50, atm, atm + 50, atm + 100]);
  });

  it("an index with a step of 100 rounds to 100 (BANKNIFTY 52340 -> 52300)", async () => {
    const { lib } = make("b", universe({ underlying: "BANKNIFTY", expiries: "current-monthly", strikes: { around: "atm", count: 3 } }));
    const r = await lib.resolve("b");
    expect(r.expiries[0]).toMatchObject({ expiry: "2026-11-24", kind: "monthly", atm: 52300, step: 100 });
    expect(optionsOf(r.symbols)["2026-11-24"].CE).toEqual([52000, 52100, 52200, 52300, 52400, 52500, 52600]);
  });

  it("a stock uses its own listed strikes (RELIANCE 1412 -> 1420 on a step of 20)", async () => {
    const { lib } = make("r", universe({ underlying: "RELIANCE", expiries: "current-monthly", strikes: { around: "atm", count: 2 }, includeUnderlying: false }));
    const r = await lib.resolve("r");
    expect(r.expiries[0]).toMatchObject({ expiry: "2026-11-24", atm: 1420, step: 20 });
    expect(optionsOf(r.symbols)["2026-11-24"].CE).toEqual([1380, 1400, 1420, 1440, 1460]);
    expect(r.symbols.some((s) => s === "NSE:RELIANCE")).toBe(false);
  });

  it("'count each side' counts LISTED strikes: near the edge of an uneven ladder it still never invents a strike", async () => {
    const { lib, market } = make("r", universe({ underlying: "RELIANCE", expiries: "current-monthly", strikes: { around: "atm", count: 3 }, sides: ["CE"], includeUnderlying: false }));
    market.setPrice("NSE:RELIANCE", 1590);
    const r = await lib.resolve("r");
    expect(r.expiries[0].atm).toBe(1600);
    expect(optionsOf(r.symbols)["2026-11-24"].CE).toEqual([1480, 1500, 1540, 1600, 1700]);
  });

  it("an explicit strike range needs no price at all", async () => {
    const { lib, market } = make("range", universe({ strikes: { from: 24900, to: 25100 }, includeUnderlying: false }));
    const r = await lib.resolve("range");
    expect(optionsOf(r.symbols)["2026-11-10"].CE).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(r.atmSource).toBe("not-needed");
    expect(r.underlying.price).toBeNull();
    expect(market.calls.filter((c) => c[0] === "ltp")).toHaveLength(0);
  });

  it("sides and the extras follow the rule: only CE, the future of the expiry's month, no index", async () => {
    const { lib } = make("x", universe({ expiries: "current-monthly", sides: ["CE"], includeUnderlying: false, includeFuture: true, strikes: { around: "atm", count: 1 } }));
    const r = await lib.resolve("x");
    expect(r.symbols).toContain("NFO:NIFTY-2026-11-24-FUT");
    expect(r.symbols).not.toContain("NSE:NIFTY");
    expect(r.symbols.filter((s) => s.endsWith("-PE"))).toEqual([]);
    expect(r.symbols.filter((s) => s.endsWith("-CE"))).toHaveLength(3);
  });

  it("a BSE index prices from BSE and lists BFO options", async () => {
    const { lib } = make("s", universe({ underlying: "SENSEX", expiries: "current-weekly", strikes: { around: "atm", count: 1 } }));
    const r = await lib.resolve("s");
    expect(r.underlying.symbol).toBe("BSE:SENSEX");
    expect(r.expiries[0]).toMatchObject({ expiry: "2026-11-12", atm: 82000, step: 100 });
    expect(r.symbols).toContain("BFO:SENSEX-2026-11-12-82000-CE");
  });
});

describe("rolling expiries: weekly and monthly", () => {
  const exp = async (rule, o) => {
    const t = make("n", universe({ expiries: rule, strikes: { around: "atm", count: 1 }, includeUnderlying: false }), o);
    const r = await t.lib.resolve("n");
    return r.expiries.map((e) => e.expiry);
  };

  it("current-weekly is the nearest, next-weekly the one after, current-monthly the last of the month", async () => {
    expect(await exp("current-weekly")).toEqual(["2026-11-10"]);
    expect(await exp("next-weekly")).toEqual(["2026-11-17"]);
    expect(await exp("current-monthly")).toEqual(["2026-11-24"]);
  });

  it("all-weekly is the weekly run, stopping at the configured count and before a monthly far away", async () => {
    expect(await exp("all-weekly")).toEqual(["2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08"]);
    expect(await exp("all-weekly", { library: { maxWeeklyExpiries: 7 } })).toEqual(["2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15"]);
  });

  it("a weekly expiry rolls on once it has closed on its day (15:40 IST for derivatives since 3 Aug 2026)", async () => {
    expect(await exp("current-weekly", { now: at("2026-11-10T10:00:00+05:30") })).toEqual(["2026-11-10"]);
    const t = make("n", universe({ strikes: { around: "atm", count: 1 } }), { now: at("2026-11-10T15:45:00+05:30") });
    const r = await t.lib.resolve("n");
    expect(r.expiries[0].expiry).toBe("2026-11-17");
    expect(r.warnings.join(" ")).toMatch(/2026-11-10 expiry closed at 15:40 IST today/);
  });

  it("an expiring index contract still trades at 15:35 until 7 Dec 2026, and rolls at 15:30 after that", async () => {
    const make1 = (now, expiries) => make("n", universe({ expiries, strikes: { around: "atm", count: 1 } }), { now: at(now) });
    expect((await make1("2026-11-10T15:35:00+05:30", "current-weekly").lib.resolve("n")).expiries[0].expiry).toBe("2026-11-10");
    const dec = await make1("2026-12-08T15:35:00+05:30", "current-monthly").lib.resolve("n");
    expect(dec.expiries[0].expiry).toBe("2026-12-29");
    expect(dec.warnings.join(" ")).toMatch(/2026-12-08 expiry closed at 15:30 IST today/);
  });

  it("the monthly expiry rolls to the next month after it closes", async () => {
    expect(await exp("current-monthly", { now: at("2026-11-24T16:00:00+05:30") })).toEqual(["2026-12-29"]);
  });

  it("an index with only monthly expiries answers a weekly rule with a plain error, never a monthly date", async () => {
    const { lib } = make("b", universe({ underlying: "BANKNIFTY", expiries: "current-weekly" }));
    await expect(lib.resolve("b")).rejects.toMatchObject({ code: "VALIDATION_FAILED", detail: expect.stringMatching(/BANKNIFTY has no weekly expiries/) });
  });

  it("a stock has monthly expiries only: current-monthly works, next-weekly is refused", async () => {
    const t = make("r", universe({ underlying: "RELIANCE", expiries: "current-monthly" }));
    expect((await t.lib.resolve("r")).expiries[0].expiry).toBe("2026-11-24");
    t.lib.update("r", { universe: universe({ underlying: "RELIANCE", expiries: "next-weekly" }) });
    await expect(t.lib.resolve("r")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("an explicit list uses those dates and skips what is not listed, saying which are listed nearby", async () => {
    const { lib } = make("d", universe({ expiries: ["2026-11-17", "2026-11-18", "2026-11-03"], strikes: { around: "atm", count: 1 }, includeUnderlying: false }));
    const r = await lib.resolve("d");
    expect(r.expiries.map((e) => e.expiry)).toEqual(["2026-11-17"]);
    expect(r.warnings.join(" ")).toMatch(/2026-11-18 \(Wednesday\) is not a listed expiry of NIFTY; skipped\. Listed near it: 2026-11-17, 2026-11-24/);
    expect(r.warnings.join(" ")).toMatch(/2026-11-03 \(Tuesday\) is already expired/);
  });

  it("a list that matches nothing is an error, not an empty answer", async () => {
    const { lib } = make("d", universe({ expiries: ["2026-11-18"] }));
    await expect(lib.resolve("d")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });
});

describe("holiday shifts", () => {
  const shifted = { holidays: ["2026-11-17"], niftyExpiries: NIFTY_EXPIRIES_HOLIDAY_SHIFT, market: standardMarket({ expiries: { NIFTY: [...NIFTY_EXPIRIES_HOLIDAY_SHIFT] } }) };

  it("when the usual Tuesday is a holiday the listed Monday is used and flagged, with the reason", async () => {
    const t = make("n", universe({ expiries: "next-weekly", strikes: { around: "atm", count: 1 } }), shifted);
    const r = await t.lib.resolve("n");
    expect(r.expiries[0]).toMatchObject({ expiry: "2026-11-16", shifted: true, ruleDate: "2026-11-17", reason: "2026-11-17 is a holiday" });
    expect(r.warnings.join(" ")).toMatch(/2026-11-16 \(Monday\) is not the usual expiry day: 2026-11-17 is a holiday/);
    expect(r.symbols.some((s) => s.includes("2026-11-16-25000-CE"))).toBe(true);
  });

  it("a normal week is not flagged", async () => {
    const t = make("n", universe({ strikes: { around: "atm", count: 1 } }), { holidays: ["2026-11-17"] });
    const r = await t.lib.resolve("n");
    expect(r.expiries[0].shifted).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("all-weekly keeps the shifted expiry in the run", async () => {
    const t = make("n", universe({ expiries: "all-weekly", strikes: { around: "atm", count: 1 } }), shifted);
    const r = await t.lib.resolve("n");
    expect(r.expiries.map((e) => e.expiry).slice(0, 3)).toEqual(["2026-11-10", "2026-11-16", "2026-11-24"]);
    expect(r.expiries.filter((e) => e.shifted).map((e) => e.expiry)).toEqual(["2026-11-16"]);
  });
});

describe("honest about the price", () => {
  it("a delayed price is refused, and labelled when the caller allows it", async () => {
    const t = make("n", universe());
    t.market.setPrice("NSE:NIFTY", 25012, { class: "delayed", source: "backup" });
    await expect(t.lib.resolve("n")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", detail: expect.stringMatching(/delayed/) });
    const r = await t.lib.resolve("n", { allowStale: true });
    expect(r.atmSource).toBe("delayed");
    expect(r.warnings.join(" ")).toMatch(/delayed source/);
    expect(r.underlying.class).toBe("delayed");
  });

  it("an end-of-day price is refused the same way", async () => {
    const t = make("n", universe());
    t.market.setPrice("NSE:NIFTY", 25012, { class: "eod" });
    await expect(t.lib.resolve("n")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", detail: expect.stringMatching(/end-of-day/) });
    expect((await t.lib.resolve("n", { allowStale: true })).atmSource).toBe("eod");
  });

  it("a stale price is refused with its age, and labelled when allowed", async () => {
    const t = make("n", universe());
    t.market.setPrice("NSE:NIFTY", 25012, { stale: true, ageMs: 600_000 });
    await expect(t.lib.resolve("n")).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE", detail: expect.stringMatching(/stale/) });
    const r = await t.lib.resolve("n", { allowStale: true });
    expect(r.atmSource).toBe("stale");
    expect(r.warnings.join(" ")).toMatch(/stale/);
  });

  it("no price at all is an error that says why", async () => {
    const t = make("n", universe());
    t.market.fail("NSE:NIFTY", "UPSTREAM_ERROR");
    await expect(t.lib.resolve("n")).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE", detail: expect.stringMatching(/not available.*fake failure/) });
    const empty = makeLibrary({ market: fakeMarketData({ expiries: { NIFTY: ["2026-11-10", "2026-11-17"] } }) });
    empty.lib.create({ name: "n", universe: universe() });
    await expect(empty.lib.resolve("n")).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });

  it("with the market closed the price is the last close: allowed, but labelled and warned", async () => {
    const t = make("n", universe(), { now: at("2026-11-09T20:00:00+05:30") });
    const r = await t.lib.resolve("n");
    expect(r.atmSource).toBe("last-close");
    expect(r.warnings.join(" ")).toMatch(/market is closed.*last close/);
    await expect(t.lib.resolve("n", { requireLive: true })).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE", detail: expect.stringMatching(/not live/) });
  });

  it("requireLive passes while the market is open", async () => {
    const t = make("n", universe());
    expect((await t.lib.resolve("n", { requireLive: true })).atmSource).toBe("live");
  });

  it("a price the caller supplies is used and labelled as supplied", async () => {
    const t = make("n", universe({ strikes: { around: "atm", count: 1 } }));
    const r = await t.lib.resolve("n", { spot: 25526 });
    expect(r.atmSource).toBe("supplied");
    expect(r.expiries[0].atm).toBe(25550);
    expect(t.market.calls.filter((c) => c[0] === "ltp")).toHaveLength(0);
  });

  it("library.allowStaleAtm makes labelled stale prices the default, and a caller can still refuse", async () => {
    const t = make("n", universe(), { library: { allowStaleAtm: true } });
    t.market.setPrice("NSE:NIFTY", 25012, { class: "delayed" });
    expect((await t.lib.resolve("n")).atmSource).toBe("delayed");
    await expect(t.lib.resolve("n", { allowStale: false })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("the price read is one ltp call at the caller's priority; backup data is only allowed with allowStale", async () => {
    const t = make("n", universe());
    await t.lib.resolve("n", { priority: "background" });
    const strict = t.market.calls.filter((c) => c[0] === "ltp").at(-1);
    expect(strict[2]).toMatchObject({ priority: "background" });
    expect(strict[2].allowBackup).toBeUndefined();
    await t.lib.resolve("n", { allowStale: true });
    expect(t.market.calls.filter((c) => c[0] === "ltp").at(-1)[2].allowBackup).toBe(true);
  });
});

describe("when no strikes are listed", () => {
  it("an index gets a generated grid on its usual step, and the answer says so", async () => {
    const t = make("f", universe({ underlying: "FINNIFTY", expiries: "current-monthly", strikes: { around: "atm", count: 2 }, includeUnderlying: false }));
    const r = await t.lib.resolve("f");
    expect(r.strikeSource).toBe("grid");
    expect(r.expiries[0]).toMatchObject({ atm: 24100, step: 50, strikeSource: "grid" });
    expect(optionsOf(r.symbols)["2026-11-24"].CE).toEqual([24000, 24050, 24100, 24150, 24200]);
    expect(r.warnings.join(" ")).toMatch(/generated grid on a step of 50/);
  });

  it("a configured step overrides the usual one", async () => {
    const t = make("f", universe({ underlying: "FINNIFTY", expiries: "current-monthly", strikes: { around: "atm", count: 1 }, includeUnderlying: false }), { library: { strikeSteps: { FINNIFTY: 25 } } });
    t.market.setPrice("NSE:FINNIFTY", 24110);
    const r = await t.lib.resolve("f");
    expect(optionsOf(r.symbols)["2026-11-24"].CE).toEqual([24075, 24100, 24125]);
  });

  it("a stock is never given a guessed step: it is an error that says what to do", async () => {
    const t = makeLibrary({ market: standardMarket({ expiries: { M_M: ["2026-11-24"] } }) });
    t.market.setPrice("NSE:M_M", 3100);
    t.lib.create({ name: "mm", universe: universe({ underlying: "M_M", expiries: "current-monthly" }) });
    await expect(t.lib.resolve("mm")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", detail: expect.stringMatching(/library\.strikeSteps\.M_M/) });
  });
});

describe("limits", () => {
  it("a universe that would be too large is refused with the numbers", async () => {
    const t = make("big", universe({ expiries: "all-weekly", strikes: { around: "atm", count: 40 } }), { library: { maxSymbols: 100 } });
    await expect(t.lib.resolve("big")).rejects.toMatchObject({ code: "VALIDATION_FAILED", detail: expect.stringMatching(/more than library\.maxSymbols \(100\)/) });
  });

  it("every symbol it returns is canonical and listed once", async () => {
    const t = make("n", universe({ expiries: "all-weekly", includeFuture: true }));
    const r = await t.lib.resolve("n");
    expect(new Set(r.symbols).size).toBe(r.symbols.length);
    for (const s of r.symbols) expect(parseSymbol(s).canonical).toBe(s);
  });
});
