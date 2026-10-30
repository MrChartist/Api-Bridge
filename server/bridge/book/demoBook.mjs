/**
 * Demo holders and a seeded paper book (stream S27; docs/spec/p1-12-guard-participants.md §5.3). Demo mode only.
 *
 *   Holder tags (book-demo/holders.json, set only when missing, so a change made on the Accounts page sticks):
 *     demo → self ("You (demo)"), demo-spouse → spouse, demo-other → other.
 *   Paper book (through orders.place with a local principal, mode "paper", tag DEMOSEED, nearest expiry after today), for each
 *   paper account that holds no open F&O position, or whose open F&O legs are no longer whole lots of the instrument's
 *   current lot size (a demo home seeded before a lot change, NIFTY 75 → 65: the book is reset and seeded again, so the
 *   quantities always follow the reference lot and never a number written here):
 *     demo-paper:         NIFTY short strangle, 1 lot, strikes ±2 % from spot (the spec's 2 lots do not fit the
 *                         paper account's default ₹10 lakh capital next to the spread); BANKNIFTY bull call spread, 1 lot
 *     demo-paper-spouse:  SENSEX iron condor, 1 lot, shorts ±1.5 %, wings ±3 %
 *     demo-paper-other:   NIFTY long call at the money, 1 lot (the spec's long future is above the default
 *                         ₹2,00,000 per-order value limit, which demo mode keeps rather than loosens)
 * Hedges are bought before the shorts are sold, as a person would place them.
 */
import { createCallContext } from "../core/context.mjs";
import { isStub } from "../core/contracts.mjs";
import { createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { DEMO_PAPER_ACCOUNT, DEMO_SPOUSE_ACCOUNT, DEMO_OTHER_ACCOUNT } from "../demo/demoMode.mjs";

export const DEMO_HOLDER_TAGS = Object.freeze({
  demo: Object.freeze({ relationship: "self", label: "You (demo)" }),
  "demo-spouse": Object.freeze({ relationship: "spouse", label: "Spouse (sample)" }),
  "demo-other": Object.freeze({ relationship: "other", label: "Not family (sample)" }),
});

const SEED_TAG = "DEMOSEED";
/** Quote-class reads one seeded paper order makes (its LTP, its depth, the underlying's spot). */
const SEED_ORDER_COST = 3;
/** Reads the seed plan makes (three underlyings: expiries and a chain each, in the shared quote family). */
const SEED_CHAIN_COST = 3;
/** The longest the seed waits for headroom before it goes anyway (the scheduler still never exceeds a limit). */
const SEED_WAIT_MAX_MS = 15_000;

/**
 * Wait (at most SEED_WAIT_MAX_MS) until the shared background gate says `cost` quote-class reads keep every window
 * of the market data account at least half free. No scheduler or account (tests), or the Bridge stopping: no wait.
 */
function backgroundPace(deps) {
  const stopped = typeof deps.stopped === "function" ? deps.stopped : () => false;
  const scheduler = deps.scheduler;
  if (!scheduler || isStub(scheduler) || typeof scheduler.headroom !== "function") return async () => {};
  const gate = createBackgroundGate({ scheduler });
  let account = null;
  try {
    account = deps.accounts?.marketDataCandidates?.({ capability: "quotes" })?.[0] ?? null;
  } catch {
    account = null;
  }
  if (!account) return async () => {};
  const sleep = (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  return async (cost) => {
    const until = Date.now() + SEED_WAIT_MAX_MS;
    while (Date.now() < until && !stopped()) {
      let wait;
      try {
        if (gate.allow(account, "quote", { cost })) return;
        wait = gate.waitMs(account, "quote", { cost });
      } catch {
        return;
      }
      await sleep(Math.min(1000, Math.max(50, wait || 250)));
    }
  };
}

/** The row whose strike is nearest `target`. */
const nearest = (rows, target) => rows.reduce((best, r) => (Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best), rows[0]);

/** The nearest expiry's chain for an underlying (rows with ce/pe symbols, spot). */
async function chainOf(marketData, underlying, today, priority) {
  const opts = priority ? { priority } : {};
  const ex = await marketData.expiries(underlying, opts);
  // The nearest expiry after today (an expiry-day seed at night would be worthless by the time anyone looks).
  const expiry = (ex?.expiries ?? []).find((e) => e > today) ?? (ex?.expiries ?? [])[0];
  if (!expiry) throw new Error(`no ${underlying} expiry`);
  const chain = await marketData.optionChain({ underlying, expiry, strikes: 40 }, opts);
  const rows = (chain?.rows ?? []).filter((r) => r.ce?.symbol && r.pe?.symbol);
  const spot = Number(chain?.underlyingLtp);
  if (!rows.length || !(spot > 0)) throw new Error(`no ${underlying} chain`);
  return { expiry, rows, spot, expiries: ex.expiries };
}

/**
 * True when an open leg is not a whole number of its instrument's current lot (from the instrument master, which the
 * demo builds from the reference tables). Legs whose lot cannot be read are left alone.
 * @param {{ symbol: string, netQty: number }[]} legs
 * @param {{ resolve(symbol: string): Promise<{ lotSize?: number | null }> } | undefined} symbols
 */
export async function offLot(legs, symbols) {
  if (typeof symbols?.resolve !== "function") return false;
  for (const p of legs) {
    const lot = Number((await Promise.resolve(symbols.resolve(p.symbol)).catch(() => null))?.lotSize);
    if (lot > 0 && Number(p.netQty) % lot !== 0) return true;
  }
  return false;
}

/** The legs to seed per account: [{ symbol, side, lots }] in send order (buys first). */
export async function demoSeedPlan({ marketData, today, priority }) {
  const nifty = await chainOf(marketData, "NIFTY", today, priority);
  const bank = await chainOf(marketData, "BANKNIFTY", today, priority);
  const sensex = await chainOf(marketData, "SENSEX", today, priority);
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
  const reseeded = [];
  // The lot check reads the instrument master: make sure it is loaded (never throws).
  await Promise.resolve(deps.symbols?.warm?.()).catch(() => null);
  for (const id of accounts) {
    const r = await orders.positions(ctx, id, { mode: "paper" });
    const fno = (r?.items ?? []).filter((p) => Number(p.netQty) && /^(NFO|BFO):/.test(String(p.symbol)));
    if (!fno.length) {
      empty.push(id);
      continue;
    }
    if (typeof deps.paper?.reset === "function" && (await offLot(fno, deps.symbols))) {
      const acct = await Promise.resolve(deps.paper.account?.(id)).catch(() => null);
      await deps.paper.reset(id, acct?.startingCapital ? { startingCapital: acct.startingCapital } : {});
      empty.push(id);
      reseeded.push(id);
    }
  }
  if (reseeded.length) logger?.info?.("demo book reseeded: lot sizes changed since it was seeded", { accounts: reseeded });
  if (!empty.length) return { tagged, seeded: [] };
  const day = new Date((deps.clock?.now?.() ?? Date.now()) + 19_800_000).toISOString().slice(0, 10);
  const pace = backgroundPace(deps);
  await pace(SEED_CHAIN_COST);
  const plan = await demoSeedPlan({ marketData, today: day, priority: "background" });
  const seeded = [];
  for (const id of empty) {
    let i = 0;
    for (const leg of plan[id] ?? []) {
      i += 1;
      // A start-up job like the recorder: each paper fill prices its leg (LTP, depth, the spot), so wait until those
      // reads leave the quote windows at least half free for what a person asks in the first seconds.
      await pace(SEED_ORDER_COST);
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
