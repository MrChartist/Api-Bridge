/**
 * Contract test: every real broker adapter (server/brokers/registry.mjs) is run against its recorded fixtures
 * (server/brokers/__fixtures__/<id>/, fetch stubbed by contractHarness.createFetchStub, so no network) and its
 * market-data output is fed through S5's normalisers. Whatever shape a broker returns within the contract, the Bridge
 * must turn it into the OpenAPI shapes without losing prices, inventing zeros or failing.
 *
 * Several adapters pace their own upstream calls with timers (the XTS family waits 1 s between market-data calls), so
 * setTimeout is faked here and advanced while each call is pending; nothing waits in real time.
 */
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES, declaredCapabilities } from "../../brokers/contract.mjs";
import { createFetchStub, loadFixtures } from "../../brokers/contractHarness.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { isCanonicalSymbol } from "../core/symbolFormat.mjs";
import { rowsFromBrokerChain } from "./chain.mjs";
import { depthFields, normaliseCandles, quoteFields } from "./normalise.mjs";

const MARKET_CAPS = ["instruments", "expiries", "optionChain", "ltp", "quotes", "depth", "historical"];
const NOW = Date.parse("2026-10-19T10:00:00+05:30");

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
    return { value: await p };
  } catch (error) {
    return { error };
  } finally {
    globalThis.fetch = real;
    Object.assign(console, saved);
  }
}

function defaultArgs(cap, fx, manifest) {
  if (Array.isArray(fx.args)) return fx.args;
  if (cap === "expiries" || cap === "ltp") return [manifest.symbol];
  if (cap === "optionChain") return [manifest.symbol, manifest.expiry];
  return [];
}

/** Run each declared market capability in the harness's order (module-level instrument caches carry over). */
async function runAdapter(adapter) {
  const { manifest, byCapability } = loadFixtures(adapter.id);
  const declared = new Set(declaredCapabilities(adapter));
  const out = {};
  for (const cap of MARKET_CAPS) {
    const fx = byCapability[cap];
    if (!declared.has(cap) || !fx) continue;
    const method = CAPABILITIES[cap].methods.find((m) => typeof adapter[m] === "function");
    const creds = { ...(manifest.creds || {}), ...(fx.creds || {}) };
    out[cap] = await withFetch(fx.responses, () => adapter[method](creds, ...defaultArgs(cap, fx, manifest)));
  }
  return { manifest, out };
}

const registry = createBrokerRegistry();
const ids = registry.list();

describe("S5 normalisers accept every adapter's fixture output", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const runs = [];
  for (const id of ids) {
    const adapter = registry.get(id);
    runs.push({ id, adapter, ...(await runAdapter(adapter)) });
  }
  vi.useRealTimers();

  it("covers all 41 adapters", () => {
    expect(runs.length).toBe(41);
  });

  it("quotes: every priced row normalises with the same LTP and nulls (not zeros) for missing fields", () => {
    const problems = [];
    let checked = 0;
    for (const r of runs) {
      const q = r.out.quotes;
      if (!q || q.error) continue;
      for (const row of q.value?.data ?? []) {
        if (!(row.ltp > 0)) continue;
        checked += 1;
        const f = quoteFields(row);
        if (!f) problems.push(`${r.id}: row ${row.token} lost its price`);
        else {
          if (f.ltp !== row.ltp) problems.push(`${r.id}: ltp ${row.ltp} became ${f.ltp}`);
          for (const k of ["open", "high", "low", "close", "bid", "ask"]) if (row[k] === null && f[k] !== null) problems.push(`${r.id}: ${k} null became ${f[k]}`);
          if (f.changePct !== null && !Number.isFinite(f.changePct)) problems.push(`${r.id}: changePct not finite`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it("depth: levels survive, sorted best first", () => {
    const problems = [];
    let checked = 0;
    for (const r of runs) {
      const d = r.out.depth;
      if (!d || d.error) continue;
      checked += 1;
      const raw = d.value?.data ?? {};
      const f = depthFields(raw);
      if (f.bids.length !== (raw.bids ?? []).length || f.asks.length !== (raw.asks ?? []).length) problems.push(`${r.id}: depth levels dropped`);
      for (let i = 1; i < f.bids.length; i += 1) if (f.bids[i].price > f.bids[i - 1].price) problems.push(`${r.id}: bids not best first`);
      for (let i = 1; i < f.asks.length; i += 1) if (f.asks[i].price < f.asks[i - 1].price) problems.push(`${r.id}: asks not best first`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(15);
  });

  it("historical: every candle survives normalisation", () => {
    const problems = [];
    let checked = 0;
    for (const r of runs) {
      const h = r.out.historical;
      if (!h || h.error) continue;
      checked += 1;
      const raw = h.value?.data ?? [];
      const c = normaliseCandles(raw);
      if (c.length !== raw.length) problems.push(`${r.id}: ${raw.length - c.length} candle(s) dropped`);
      if (c.some((x, i) => i > 0 && x.time <= c[i - 1].time)) problems.push(`${r.id}: candles not ascending`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(15);
  });

  it("option chains: rows with canonical leg symbols and a Greeks source on every priced leg", () => {
    const problems = [];
    let checked = 0;
    for (const r of runs) {
      const c = r.out.optionChain;
      if (!c || c.error) continue;
      // node:https / WebSocket adapters (mstock, tradejini) cannot be answered by the fetch stub: no raw strikes.
      const rawStrikes = Object.entries(c.value?.data?.oc ?? {}).filter(([k, v]) => Number.parseFloat(k) > 0 && (v?.ce || v?.pe)).length;
      if (rawStrikes === 0) continue;
      const underlying = String(r.manifest.symbol ?? "NIFTY").toUpperCase();
      const expiry = r.manifest.expiry ?? "2026-10-27";
      const declaredRaw = r.adapter.capabilities?.optionChain?.greeks;
      let built;
      try {
        built = rowsFromBrokerChain(c.value, { underlying, expiry, exchange: ["SENSEX", "BANKEX"].includes(underlying) ? "BFO" : "NFO", declared: declaredRaw === "computed" ? "computed" : "broker", greeks: true, nowMs: NOW, rate: 0.065 });
      } catch (err) {
        problems.push(`${r.id}: ${err.message}`);
        continue;
      }
      checked += 1;
      if (built.rows.length !== rawStrikes) problems.push(`${r.id}: ${rawStrikes} strikes became ${built.rows.length} rows`);
      for (const row of built.rows) {
        for (const leg of [row.ce, row.pe]) {
          if (!leg) continue;
          if (!isCanonicalSymbol(leg.symbol)) problems.push(`${r.id}: ${leg.symbol} is not canonical`);
          if (leg.iv !== null && !(leg.iv > 0 && leg.iv < 500)) problems.push(`${r.id}: iv ${leg.iv} out of range`);
          if (leg.ltp !== null && leg.iv !== null && leg.greeksSource === null) problems.push(`${r.id}: ${leg.symbol} has IV but no greeksSource`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(25);
  });
});
