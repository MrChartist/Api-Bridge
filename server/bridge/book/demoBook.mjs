/**
 * Demo holders and a seeded paper book (stream S27; docs/spec/p1-12-guard-participants.md §5.3). Demo mode only.
 *
 *   Holder tags (book-demo/holders.json, set only when missing, so a change made on the Accounts page sticks):
 *     demo → self ("You (demo)"), demo-spouse → spouse, demo-other → other.
 *   Paper book (through orders.place with a local principal, mode "paper", tag DEMOSEED, nearest expiry after today), for each
 *   paper account that holds no open F&O position:
 *     demo-paper:         NIFTY short strangle, 1 lot, strikes ±2 % from spot (the spec's 2 lots do not fit the
 *                         paper account's default ₹10 lakh capital next to the spread); BANKNIFTY bull call spread, 1 lot
 *     demo-paper-spouse:  SENSEX iron condor, 1 lot, shorts ±1.5 %, wings ±3 %
 *     demo-paper-other:   NIFTY long call at the money, 1 lot (the spec's long future is above the default
 *                         ₹2,00,000 per-order value limit, which demo mode keeps rather than loosens)
 * Hedges are bought before the shorts are sold, as a person would place them.
 */
import { createCallContext } from "../core/context.mjs";
import { DEMO_PAPER_ACCOUNT, DEMO_SPOUSE_ACCOUNT, DEMO_OTHER_ACCOUNT } from "../demo/demoMode.mjs";

export const DEMO_HOLDER_TAGS = Object.freeze({
  demo: Object.freeze({ relationship: "self", label: "You (demo)" }),
  "demo-spouse": Object.freeze({ relationship: "spouse", label: "Spouse (sample)" }),
  "demo-other": Object.freeze({ relationship: "other", label: "Not family (sample)" }),
});

const SEED_TAG = "DEMOSEED";

/** The row whose strike is nearest `target`. */
const nearest = (rows, target) => rows.reduce((best, r) => (Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best), rows[0]);

/** The nearest expiry's chain for an underlying (rows with ce/pe symbols, spot). */
async function chainOf(marketData, underlying, today) {
  const ex = await marketData.expiries(underlying, {});
  // The nearest expiry after today (an expiry-day seed at night would be worthless by the time anyone looks).
  const expiry = (ex?.expiries ?? []).find((e) => e > today) ?? (ex?.expiries ?? [])[0];
  if (!expiry) throw new Error(`no ${underlying} expiry`);
  const chain = await marketData.optionChain({ underlying, expiry, strikes: 40 }, {});
  const rows = (chain?.rows ?? []).filter((r) => r.ce?.symbol && r.pe?.symbol);
  const spot = Number(chain?.underlyingLtp);
  if (!rows.length || !(spot > 0)) throw new Error(`no ${underlying} chain`);
  return { expiry, rows, spot, expiries: ex.expiries };
}

/** The legs to seed per account: [{ symbol, side, lots }] in send order (buys first). */
export async function demoSeedPlan({ marketData, today }) {
  const nifty = await chainOf(marketData, "NIFTY", today);
  const bank = await chainOf(marketData, "BANKNIFTY", today);
  const sensex = await chainOf(marketData, "SENSEX", today);
  const plan = {};
  plan[DEMO_PAPER_ACCOUNT] = [
    { symbol: nearest(bank.rows, bank.spot).ce.symbol, side: "BUY", lots: 1 },
    { symbol: nearest(bank.rows, bank.spot * 1.02).ce.symbol, side: "SELL", lots: 1 },
    { symbol: nearest(nifty.rows, nifty.spot * 1.02).ce.symbol, side: "SELL", lots: 1 },
    { symbol: nearest(nifty.rows, nifty.spot * 0.98).pe.symbol, side: "SELL", lots: 1 },
  ];
  plan[DEMO_SPOUSE_ACCOUNT] = [
    { symbol: nearest(sensex.rows, sensex.spot * 1.03).ce.symbol, side: "BUY", lots: 1 },
    { symbol: nearest(sensex.rows, sensex.spot * 0.97).pe.symbol, side: "BUY", lots: 1 },
    { symbol: nearest(sensex.rows, sensex.spot * 1.015).ce.symbol, side: "SELL", lots: 1 },
    { symbol: nearest(sensex.rows, sensex.spot * 0.985).pe.symbol, side: "SELL", lots: 1 },
  ];
  // One long NIFTY call (a future's notional is above the default per-order value limit, which the demo keeps).
  plan[DEMO_OTHER_ACCOUNT] = [{ symbol: nearest(nifty.rows, nifty.spot).ce.symbol, side: "BUY", lots: 1 }];
  return plan;
}

/**
 * Seed demo holder tags and paper books. Safe to call on every demo start.
 * @param {{ config: any, orders: any, marketData: any, symbols: any, store: any, logger: any, clock?: { now(): number } }} deps
 * @returns {Promise<{ tagged: string[], seeded: string[] }>}
 */
export async function seedDemoBook(deps) {
  const { orders, marketData, store, logger } = deps;
  const tagged = [];
  const cur = store.tags();
  for (const [holder, tag] of Object.entries(DEMO_HOLDER_TAGS)) {
    if (cur[holder]) continue;
    store.set(holder, tag, "demo");
    tagged.push(holder);
  }
  const ctx = createCallContext({ source: "system", principal: { kind: "local", id: "cli" }, scopes: ["paper"], log: logger });
  const accounts = [DEMO_PAPER_ACCOUNT, DEMO_SPOUSE_ACCOUNT, DEMO_OTHER_ACCOUNT].filter((id) => (deps.config.accounts ?? []).some((a) => a.id === id));
  const empty = [];
  for (const id of accounts) {
    const r = await orders.positions(ctx, id, { mode: "paper" });
    const open = (r?.items ?? []).some((p) => Number(p.netQty) && /^(NFO|BFO):/.test(String(p.symbol)));
    if (!open) empty.push(id);
  }
  if (!empty.length) return { tagged, seeded: [] };
  const day = new Date((deps.clock?.now?.() ?? Date.now()) + 19_800_000).toISOString().slice(0, 10);
  const plan = await demoSeedPlan({ marketData, today: day });
  const seeded = [];
  for (const id of empty) {
    let i = 0;
    for (const leg of plan[id] ?? []) {
      i += 1;
      const r = await orders.place(
        ctx,
        { account: id, symbol: leg.symbol, side: leg.side, lots: leg.lots, product: "MARGIN", orderType: "MARKET", mode: "paper", tag: SEED_TAG },
        { idempotencyKey: `demoseed-${id}-${day}-${i}-${leg.symbol}` },
      );
      if (r?.order?.status === "rejected") logger?.warn?.("demo book seed order rejected", { account: id, symbol: leg.symbol, message: r.order.statusMessage });
    }
    seeded.push(id);
  }
  logger?.info?.("demo book seeded", { accounts: seeded });
  return { tagged, seeded };
}
