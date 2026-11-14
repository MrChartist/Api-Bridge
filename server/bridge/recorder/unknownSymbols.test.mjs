/** A recording or rule with an unknown (or expired) symbol is refused when it is created, naming the symbols with suggestions. */
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { bootRecorder } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});

const boot = async () => {
  w = bootRecorder({ symbols: createFakeSymbolService({ today: "2026-11-09" }) });
  await w.svc.start();
};

describe("unknown symbols at creation", () => {
  it("accepts known symbols", async () => {
    await boot();
    const r = await w.svc.create({ kind: "quotes", symbols: ["NSE:NIFTY", "NSE:RELIANCE"], everySec: 1, sessionOnly: false });
    expect(r.id).toMatch(/^rec_/);
  });

  it("refuses an unknown symbol, naming it and suggesting the closest", async () => {
    await boot();
    const err = await w.svc.create({ kind: "quotes", symbols: ["NSE:NIFTY", "NSE:RELIANC"], everySec: 1, sessionOnly: false }).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.status).toBe(400);
    expect(err.detail).toContain("NSE:RELIANC");
    expect(err.fields.unknownSymbols).toHaveLength(1);
    expect(err.fields.unknownSymbols[0].suggestions).toContain("NSE:RELIANCE");
    expect(w.svc.list?.() ?? []).toHaveLength(0);
  });

  it("refuses an expired contract (a recording saves live data) without offering allowExpired", async () => {
    await boot();
    const err = await w.svc.create({ kind: "quotes", symbols: ["NFO:NIFTY-2026-10-27-25000-CE"], everySec: 1, sessionOnly: false }).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.detail).toMatch(/expired on 2026-10-27/);
    expect(err.detail).not.toContain("allowExpired");
  });

  it("refuses an auto-record rule with an unknown symbol", async () => {
    await boot();
    const err = await w.svc.createRule({ name: "typo", kind: "quotes", symbols: ["NSE:NOPE"], everySec: 5, schedule: "market-hours" }).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.fields.unknownSymbols[0].symbol).toBe("NSE:NOPE");
  });
});
