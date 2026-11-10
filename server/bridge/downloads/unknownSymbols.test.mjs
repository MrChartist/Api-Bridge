/**
 * An unknown symbol is refused when a download is created (400 VALIDATION_FAILED naming it, with suggestions), not hours
 * later on the first broker call. An expired contract is refused too unless the request says allowExpired.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { makeManager } from "./testkit.mjs";

const started = [];
const boot = async (o = {}) => {
  const m = makeManager({ symbols: createFakeSymbolService({ today: "2026-10-20" }), ...o });
  await m.manager.start();
  started.push(m.manager);
  return m;
};
afterEach(async () => {
  for (const m of started.splice(0)) await m.stop();
});

const body = (symbols, extra = {}) => ({ symbols, intervals: ["1d"], from: "2026-10-01", to: "2026-10-09", ...extra });

describe("unknown symbols at creation", () => {
  it("accepts known symbols", async () => {
    const m = await boot();
    const { job } = await m.manager.create(body(["NSE:RELIANCE", "NFO:NIFTY-2026-10-27-25000-CE"]));
    expect(job.status).toMatch(/queued|running|done/);
  });

  it("names every unknown symbol and suggests the closest real ones", async () => {
    const m = await boot();
    const err = await m.manager.create(body(["NSE:RELIANC", "NSE:INFY", "NSE:ZZZNOPE"])).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.status).toBe(400);
    expect(err.detail).toContain("NSE:RELIANC");
    expect(err.detail).toContain("NSE:ZZZNOPE");
    expect(err.detail).not.toContain("NSE:INFY (");
    expect(err.fields.unknownSymbols.map((u) => u.symbol)).toEqual(["NSE:RELIANC", "NSE:ZZZNOPE"]);
    expect(err.fields.unknownSymbols[0].suggestions).toContain("NSE:RELIANCE");
    expect(err.errors[0]).toMatchObject({ path: "symbols" });
    expect(m.manager.list()).toEqual([]);
  });

  it("the dry run refuses them as well", async () => {
    const m = await boot();
    await expect(m.manager.estimate(body(["NSE:NOPE"]))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses an expired contract and says how to allow it", async () => {
    const m = await boot();
    const err = await m.manager.create(body(["NFO:NIFTY-2026-09-29-25000-CE"])).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.detail).toMatch(/expired on 2026-09-29/);
    expect(err.detail).toContain("allowExpired: true");
    expect(err.fields.unknownSymbols[0].expired).toBe(true);
  });

  it("allowExpired lets an expired contract through for its history, but still refuses a typo", async () => {
    const m = await boot();
    const { job } = await m.manager.create(body(["NFO:NIFTY-2026-09-29-25000-CE"], { allowExpired: true }));
    expect(job.request.allowExpired).toBe(true);
    await expect(m.manager.create(body(["NSE:RELIANC"], { allowExpired: true }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("does not guess when there is no instrument master loaded yet", async () => {
    const empty = createFakeSymbolService({ instruments: [], today: "2026-10-20" });
    const m = await boot({ symbols: empty });
    const { job } = await m.manager.create(body(["NSE:RELIANC"]));
    expect(job.id).toBeTruthy();
  });
});
