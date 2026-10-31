import { describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, assertService, isStub } from "../core/contracts.mjs";
import { FAKE_BROKER, FAKE_INSTRUMENTS, createFakeSymbolService, rowsFromSpecs } from "./fake.mjs";
import { loadMaster } from "./__fixtures__/helpers.mjs";

describe("fake SymbolService", () => {
  it("satisfies the contract and is not a stub", () => {
    const s = createFakeSymbolService();
    expect(() => assertService("symbols", s)).not.toThrow();
    expect(isStub(s)).toBe(false);
    for (const m of SERVICE_CONTRACTS.symbols.methods) expect(typeof s[m]).toBe("function");
  });

  it("serves FAKE_INSTRUMENTS under the fake broker, with nothing expired by default", async () => {
    const s = createFakeSymbolService();
    expect(FAKE_INSTRUMENTS.length).toBeGreaterThan(40);
    const r = await s.resolve("NFO:NIFTY-2026-10-20-25000-CE");
    expect(r).toMatchObject({ lotSize: 65, tickSize: 0.05, refs: { [FAKE_BROKER]: { token: expect.stringMatching(/^F\d+$/) } } });
    expect((await s.resolve("NSE:NIFTY1!")).canonical).toBe("NFO:NIFTY-2026-10-20-FUT".replace("10-20", "10-27"));
    expect((await s.resolve("NSE:NIFTYIT")).kind).toBe("INDEX");
    expect((await s.resolve("NSE:M&M")).isin).toBe("INE101A01026");
    expect((await s.search({ q: "reliance" })).items[0].canonical).toBe("NSE:RELIANCE");
    expect(await s.refresh()).toEqual({ brokers: [FAKE_BROKER], instruments: FAKE_INSTRUMENTS.length, errors: [] });
    expect(s.status().brokers[0]).toMatchObject({ broker: FAKE_BROKER, instruments: FAKE_INSTRUMENTS.length });
  });

  it("checks expiry when given a day", async () => {
    const s = createFakeSymbolService({ today: "2026-10-21" });
    await expect(s.resolve("NFO:NIFTY-2026-10-20-25000-CE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    expect((await s.resolve("NFO:NIFTY-2026-10-27-25000-CE")).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
  });

  it("takes custom instruments with per-broker refs, or raw masters", async () => {
    const s = createFakeSymbolService({
      instruments: [{ symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1, refs: { dhan: { token: "2885", tradingSymbol: "RELIANCE" }, zerodha: { token: "738561" } } }],
    });
    expect(await s.toBroker("NSE:RELIANCE", "zerodha")).toEqual({ token: "738561", exchange: "NSE", tradingSymbol: "NSE:RELIANCE" });
    expect(await s.fromBroker("dhan", { token: "2885", exchange: "NSE" })).toBe("NSE:RELIANCE");

    const m = createFakeSymbolService({ masters: { dhan: loadMaster("dhan") }, today: "2026-10-18" });
    expect((await m.resolve("51440", { broker: "dhan" })).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    m.setMaster("dhan", []);
    await expect(m.resolve("NSE:RELIANCE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });

  it("records calls for assertions", async () => {
    const s = createFakeSymbolService();
    await s.convert({ input: "NSE:NIFTY" });
    s.parse("NSE:RELIANCE");
    expect(s.calls).toEqual([["convert", { input: "NSE:NIFTY" }], ["parse", "NSE:RELIANCE"]]);
  });

  it("rowsFromSpecs builds contract rows", () => {
    const rows = rowsFromSpecs([{ symbol: "NFO:NIFTY-2026-10-27-25000-PE", lotSize: 65, freezeQty: 1755 }]);
    expect(rows.fake[0]).toMatchObject({ exchange: "NFO", instrumentType: "OPTIDX", underlying: "NIFTY", strike: 25000, optionType: "PE", freezeQty: 1755 });
    expect(() => createFakeSymbolService({ today: "not-a-day" })).toThrow();
  });
});
