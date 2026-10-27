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
  });

  it("an option symbol lookup (no order) may use backup data", async () => {
    const d = deps("backup");
    const h = createCompatHandlers(d, { analyzer: true });
    const r = await h.optionsymbol(ctx, { underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: "03NOV26", offset: "OTM1", option_type: "CE" });
    expect(r.symbol).toBe("NIFTY03NOV2625100CE");
    expect(d.seen[0].allowBackup).toBe(true);
  });
});
