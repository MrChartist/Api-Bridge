/**
 * Compat handlers: an order never picks its option strike from backup (public, possibly delayed) data.
 */
import { describe, expect, it } from "vitest";
import { createCompatHandlers } from "./handlers.mjs";

const ctx = { signal: undefined, key: { id: "k1", accounts: "*", scopes: ["paper"] }, scopes: new Set(["read", "paper"]), principal: { kind: "key", id: "k1" }, requireScope: () => {}, requireAccountAccess: () => {} };

function deps(source) {
  const seen = [];
  const chain = { underlyingLtp: 25010, atmStrike: 25000, lotSize: 65, freshness: { source }, rows: [24900, 25000, 25100].map((k) => ({ strike: k, ce: { symbol: `NFO:NIFTY-2026-11-03-${k}-CE` }, pe: { symbol: `NFO:NIFTY-2026-11-03-${k}-PE` } })) };
  return {
    seen,
    accounts: { list: () => [{ id: "dhan-main", broker: "dhan", enabled: true }], get: () => ({ broker: "dhan" }) },
    backupData: { autoFallback: () => true },
    symbols: { resolve: async () => ({ tickSize: 0.05, freezeQty: 1800 }) },
    marketData: {
      async optionChain(p, opts) {
        seen.push(opts);
        return chain;
      },
    },
    orders: { place: async () => ({ order: { orderId: "PAPER-1" } }) },
  };
}

describe("compat options orders", () => {
  it("reads the chain without backup for an order and refuses a backup-priced chain", async () => {
    const d = deps("backup");
    const h = createCompatHandlers(d, { analyzer: true });
    await expect(h.optionsorder(ctx, { underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: "03NOV26", offset: "ATM", option_type: "CE", action: "BUY", quantity: 65, pricetype: "MARKET", product: "MIS" })).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(d.seen[0].allowBackup).toBe(false);
    expect(d.seen[0].purpose).toBe("order"); // strike choice for an order accepts only trusted real-time data
  });

  it("an option symbol lookup (no order) never uses backup data either, even when autoFallback is on, and says it is a display read", async () => {
    const d = deps("backup");
    expect(d.backupData.autoFallback()).toBe(true);
    const h = createCompatHandlers(d, { analyzer: true });
    const r = await h.optionsymbol(ctx, { underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: "03NOV26", offset: "OTM1", option_type: "CE" });
    expect(r.symbol).toBe("NIFTY03NOV2625100CE");
    expect(d.seen[0].allowBackup).toBe(false); // a compat answer has no field for the data class, so it is never built from a source
    expect(d.seen[0].purpose).toBe("display");
  });

  it("no compat market-data read ever allows backup, whatever the config says, and every read states its purpose", async () => {
    const seen = [];
    const rec = (name) => async (...a) => {
      seen.push([name, a.at(-1)]);
      if (name === "quotes") return { items: [{ symbol: "NSE:RELIANCE", ltp: 1, freshness: { class: "realtime", stale: false } }], errors: [] };
      if (name === "depth") return { asks: [], bids: [] };
      if (name === "history") return { candles: [] };
      if (name === "expiries") return { expiries: ["2026-11-03"] };
      return { rows: [], atmStrike: 0, underlyingLtp: 0 };
    };
    const d = { ...deps("broker"), marketData: { quotes: rec("quotes"), depth: rec("depth"), history: rec("history"), expiries: rec("expiries"), optionChain: rec("optionChain") } };
    const h = createCompatHandlers(d, { analyzer: true });
    await h.quotes(ctx, { symbol: "RELIANCE", exchange: "NSE" });
    await h.multiquotes(ctx, { symbols: [{ symbol: "RELIANCE", exchange: "NSE" }] });
    await h.depth(ctx, { symbol: "RELIANCE", exchange: "NSE" });
    await h.history(ctx, { symbol: "RELIANCE", exchange: "NSE", interval: "D", start_date: "2026-10-01" });
    await h.expiry(ctx, { symbol: "NIFTY" });
    await h.optionchain(ctx, { underlying: "NIFTY", expiry_date: "03NOV26" });
    expect(seen.length).toBeGreaterThanOrEqual(7);
    for (const [name, opts] of seen) {
      expect(opts.allowBackup, name).toBe(false);
      expect(opts.purpose, name).toBe("display");
    }
  });
});

describe("compat quotes and staleness", () => {
  const quotes = (stale) => ({ quotes: async () => ({ items: [{ symbol: "NSE:RELIANCE", ltp: 1400, freshness: { class: "realtime", stale } }], errors: [] }) });

  it("says so (data.stale) when a quote came from an aged cache entry, and adds nothing when it is current", async () => {
    const stale = createCompatHandlers({ ...deps("broker"), marketData: quotes(true) }, { analyzer: true });
    expect((await stale.quotes(ctx, { symbol: "RELIANCE", exchange: "NSE" })).data.stale).toBe(true);
    expect((await stale.multiquotes(ctx, { symbols: [{ symbol: "RELIANCE", exchange: "NSE" }] })).results[0].data.stale).toBe(true);
    const fresh = createCompatHandlers({ ...deps("broker"), marketData: quotes(false) }, { analyzer: true });
    expect(await fresh.quotes(ctx, { symbol: "RELIANCE", exchange: "NSE" })).not.toHaveProperty("data.stale");
  });
});

