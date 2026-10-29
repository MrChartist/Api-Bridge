/**
 * quotesVerified (docs/spec/p1-06-stocks.md §1.3, §9.3): for Dhan, Zerodha and Upstox, the documented quote response
 * for an NFO stock option (OPTSTK; fixtures in __fixtures__/quotes-<broker>.json, shapes from each broker's docs) runs
 * through the real adapter's fetchQuotes (fetch stubbed, no network) and S5's quoteFields to a non-null OI (a whole
 * number of lots, in units), bid and ask. The sweep's QUOTES_VERIFIED set must equal the brokers whose fixture passes
 * (plus the demo adapter); a broker without a passing fixture stays unverified and the planner uses chains or limits.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFetchStub, loadFixtures } from "../../brokers/contractHarness.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { quoteFields } from "../market/normalise.mjs";
import { createDemoAdapter, demoInstruments } from "../demo/demoAdapter.mjs";
import { QUOTES_VERIFIED } from "./sweep.mjs";

const BROKERS = ["dhan", "zerodha", "upstox"];
const fixture = (b) => JSON.parse(readFileSync(new URL(`./__fixtures__/quotes-${b}.json`, import.meta.url), "utf8"));

async function runQuotes(brokerId) {
  const fx = fixture(brokerId);
  const adapter = createBrokerRegistry().get(brokerId);
  const stub = createFetchStub(fx.responses);
  const real = globalThis.fetch;
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  globalThis.fetch = stub.fetch;
  for (const k of Object.keys(saved)) console[k] = () => {};
  try {
    const res = await adapter.fetchQuotes(loadFixtures(brokerId).manifest.creds, ...fx.args);
    return { rows: Array.isArray(res?.data) ? res.data : res, lot: fx.lot };
  } finally {
    globalThis.fetch = real;
    Object.assign(console, saved);
  }
}

describe("OPTSTK quote fixtures (quotesVerified)", () => {
  it.each(BROKERS)("%s: oi (whole lots), bid and ask survive the adapter and quoteFields", async (brokerId) => {
    const { rows, lot } = await runQuotes(brokerId);
    expect(rows).toHaveLength(1);
    const f = quoteFields(rows[0]);
    expect(f).not.toBeNull();
    expect(f.oi).not.toBeNull();
    expect(f.oi % lot).toBe(0);
    expect(f.bid).toBe(33.8);
    expect(f.ask).toBe(34.2);
    expect(QUOTES_VERIFIED.has(brokerId)).toBe(true);
  });

  it("the demo adapter's option quotes carry oi, bid and ask", async () => {
    const t = Date.parse("2026-11-19T10:00:00+05:30");
    const row = demoInstruments(t).find((r) => r.instrumentType === "OPTSTK" && r.underlying === "RELIANCE");
    const res = await createDemoAdapter({ now: () => t }).fetchQuotes({}, [{ token: row.token, exchange: "NFO" }]);
    const f = quoteFields(res.data[0]);
    expect(f.oi % row.lotSize).toBe(0);
    expect(f.bid).toBeLessThan(f.ask);
    expect(QUOTES_VERIFIED.has("demo")).toBe(true);
  });

  it("no other broker is marked verified without a fixture", () => {
    expect([...QUOTES_VERIFIED].sort()).toEqual([...BROKERS, "demo"].sort());
  });
});
