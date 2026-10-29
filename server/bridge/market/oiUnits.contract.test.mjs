/**
 * OI-unit contract test (docs/spec/p1-01-recorder.md §10, M10). For the dhan, zerodha and upstox fixtures (run through
 * the real adapters with fetch stubbed, no network) and the demo adapter, every normalised chain leg with OI and a
 * known lot size is checked for "OI is a multiple of the lot" (units, not lots). A broker may be marked verified in
 * market/oiUnits.mjs only when its fixture passes; the fixtures here carry documentation sample numbers, so those
 * brokers must stay unverified, and the recorder labels their snapshots `oiUnitVerified: false`.
 */
import { describe, expect, it, vi } from "vitest";
import { createFetchStub, loadFixtures } from "../../brokers/contractHarness.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { createDemoAdapter, demoInstruments } from "../demo/demoAdapter.mjs";
import { rowsFromBrokerChain } from "./chain.mjs";
import { oiToUnits } from "./normalise.mjs";
import { OI_LOT_EXCEPTIONS, OI_UNITS, oiUnitFor, oiUnitVerified } from "./oiUnits.mjs";

const NOW = Date.parse("2026-10-19T10:00:00+05:30");
const BROKERS = ["dhan", "zerodha", "upstox"];

async function withFetch(responses, fn) {
  const stub = createFetchStub(responses);
  const real = globalThis.fetch;
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  globalThis.fetch = stub.fetch;
  for (const k of Object.keys(saved)) console[k] = () => {};
  try {
    let done = false;
    const p = Promise.resolve()
      .then(fn)
      .finally(() => {
        done = true;
      });
    p.catch(() => {});
    for (let i = 0; i < 200 && !done; i += 1) await vi.advanceTimersByTimeAsync(250);
    return await p;
  } finally {
    globalThis.fetch = real;
    Object.assign(console, saved);
  }
}

/** Lots and OI of one broker's fixture chain, normalised to units by its table entry. */
async function fixtureLegs(id) {
  const adapter = createBrokerRegistry().get(id);
  const { manifest, byCapability } = loadFixtures(id);
  const creds = { ...(manifest.creds || {}) };
  const instruments = await withFetch(byCapability.instruments.responses, () => adapter.fetchInstruments({ ...creds, ...(byCapability.instruments.creds || {}) }));
  const chainFx = byCapability.optionChain;
  const chain = await withFetch(chainFx.responses, () => adapter.fetchOptionChain({ ...creds, ...(chainFx.creds || {}) }, ...(chainFx.args ?? [manifest.symbol, manifest.expiry])));
  const underlying = String(manifest.symbol ?? "NIFTY").toUpperCase();
  const lotRow = (instruments?.data ?? []).find((r) => String(r.underlying ?? r.tradingSymbol ?? "").toUpperCase().startsWith(underlying) && /^(CE|PE)$/.test(String(r.optionType ?? "")) && Number(r.lotSize) > 1);
  const lotSize = lotRow ? Number(lotRow.lotSize) : null;
  const built = rowsFromBrokerChain(chain, { underlying, expiry: manifest.expiry, exchange: "NFO", declared: "broker", greeks: true, nowMs: NOW, rate: 0.065, oiUnit: oiUnitFor(id, "chain"), lotSize });
  const legs = built.rows.flatMap((r) => [r.ce, r.pe]).filter((l) => l && l.oi !== null);
  return { underlying, expiry: manifest.expiry, lotSize, legs };
}

/** Legs whose OI is not a multiple of the lot (documented exceptions excluded). */
const offLot = (id, f) => (f.lotSize ? f.legs.filter((l) => l.oi % f.lotSize !== 0 && !OI_LOT_EXCEPTIONS.includes(`${id}:${f.underlying}:${f.expiry}`)) : []);

describe("OI units: fixtures and the table agree (§10)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fixtures = {};
  for (const id of BROKERS) fixtures[id] = await fixtureLegs(id);
  vi.useRealTimers();

  it("each broker's fixture has a chain with OI and a lot size from its instrument master", () => {
    for (const id of BROKERS) {
      expect(fixtures[id].legs.length, id).toBeGreaterThan(0);
      expect(fixtures[id].lotSize, id).toBeGreaterThan(1);
    }
  });

  it("a broker is verified only when its fixture passes the multiple-of-lot check", () => {
    for (const id of BROKERS) {
      const bad = offLot(id, fixtures[id]);
      if (OI_UNITS[id].verified) expect(bad, `${id} is marked verified but its fixture OI is not a multiple of the lot`).toEqual([]);
    }
    // The fixtures carry documentation sample numbers (not multiples of the lot), so these stay unverified for now.
    for (const id of BROKERS) if (offLot(id, fixtures[id]).length) expect(oiUnitVerified(id)).toBe(false);
  });

  it("the demo adapter's chain OI is always a whole number of lots, and demo is verified", async () => {
    const adapter = createDemoAdapter({ now: () => NOW });
    const lots = new Map(demoInstruments(NOW).filter((r) => r.optionType).map((r) => [`${r.underlying}|${r.expiry}`, r.lotSize]));
    let checked = 0;
    for (const u of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      const expiry = (await adapter.fetchExpiryList({}, u)).data[0];
      const res = await adapter.fetchOptionChain({}, u, expiry);
      const lotSize = lots.get(`${u}|${expiry}`);
      const built = rowsFromBrokerChain(res, { underlying: u, expiry, exchange: u === "SENSEX" ? "BFO" : "NFO", declared: "computed", greeks: false, nowMs: NOW, rate: 0.065, oiUnit: oiUnitFor("demo"), lotSize });
      for (const leg of built.rows.flatMap((r) => [r.ce, r.pe])) {
        if (!leg || leg.oi === null) continue;
        checked += 1;
        expect(leg.oi % lotSize, `${leg.symbol} OI ${leg.oi} lot ${lotSize}`).toBe(0);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(oiUnitVerified("demo")).toBe(true);
  });

  it("brokers missing from the table are unverified; units pass through", () => {
    expect(oiUnitVerified("fyers")).toBe(false);
    expect(oiUnitFor("fyers")).toBe("units");
  });
});

describe("oiToUnits", () => {
  it("units pass through; lots multiply by the lot; unknown lot gives null, never a guess", () => {
    expect(oiToUnits(7350, "units", 75)).toBe(7350);
    expect(oiToUnits(98, "lots", 75)).toBe(7350);
    expect(oiToUnits(98, "lots", null)).toBeNull();
    expect(oiToUnits(null, "lots", 75)).toBeNull();
    expect(oiToUnits("12", "units")).toBe(12);
  });
  it("rowsFromBrokerChain converts a lots-quoting broker", () => {
    const res = { data: { last_price: 100, oc: { "100.000000": { ce: { last_price: 5, oi: 10, previous_oi: 8 }, pe: { last_price: 4, oi: 3 } } } } };
    const built = rowsFromBrokerChain(res, { underlying: "NIFTY", expiry: "2026-10-27", exchange: "NFO", declared: "broker", greeks: false, nowMs: NOW, rate: 0.065, oiUnit: "lots", lotSize: 75 });
    expect(built.rows[0].ce).toMatchObject({ oi: 750, oiChange: 150 });
    expect(built.rows[0].pe.oi).toBe(225);
  });
});
