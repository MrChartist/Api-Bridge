/**
 * Order-book profile for stream S15: the shape of one symbol's market depth, from whatever depth the account's broker
 * serves (5 levels from most quote APIs, 20 or 200 where a broker offers a deeper book, such as Dhan's full-depth
 * feeds). Read-only; one depth read through marketData (same freshness, account pinning and rate limits as /v1/depth).
 *
 *   GET /v1/analytics/depth-profile?symbol=NSE:RELIANCE[&levels=5|20|200][&account=][&maxAgeMs=]
 *
 * Per side: each level with its running total (cumulative quantity), its share of the side and of the largest level,
 * orders and average order size, and `large` when the level holds at least LARGE_MULTIPLE times the median level of
 * both sides. Across the book: best bid and ask, mid, spread (in price and basis points of mid), the microprice
 * (best prices weighted by the opposite side's size), and the quantity imbalance (bid - ask) / (bid + ask) over the
 * whole book and over the best five levels, from -1 (all ask) to +1 (all bid). The three largest levels per side are
 * listed with their distance from mid.
 *
 * levels is a hint: the answer says how many levels each side really has (`levels.bids`, `levels.asks`).
 */
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, depthLevelsParam, readOptionsBase } from "../market/routes.mjs";

/** A level is "large" at this many times the median level size. */
export const LARGE_MULTIPLE = 3;
const TOP = 5;

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rnd = (v, dp = 2) => {
  const n = fin(v);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const imbalance = (b, a) => (b + a > 0 ? (b - a) / (b + a) : null);

/** Clean, sorted levels: positive price, quantity of at least 0; bids high to low, asks low to high. */
function side(list, dir) {
  const out = [];
  for (const l of Array.isArray(list) ? list : []) {
    const price = fin(l?.price);
    const qty = fin(l?.qty);
    if (price === null || price <= 0 || qty === null || qty < 0) continue;
    out.push({ price, qty, orders: fin(l?.orders) });
  }
  return out.sort((a, b) => (a.price - b.price) * dir);
}

/**
 * The profile of a book (pure).
 * @param {{ bids?: object[], asks?: object[] }} book DepthItem fields
 */
export function depthProfile(book) {
  const bids = side(book?.bids, -1);
  const asks = side(book?.asks, 1);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const all = [...bids, ...asks].map((l) => l.qty).filter((q) => q > 0);
  const med = median(all);
  const maxQty = all.length ? Math.max(...all) : 0;
  const ladder = (rows) => {
    const total = sum(rows.map((r) => r.qty));
    let cum = 0;
    return rows.map((r, i) => {
      cum += r.qty;
      return {
        level: i + 1,
        price: r.price,
        qty: r.qty,
        orders: r.orders,
        avgOrder: r.orders ? rnd(r.qty / r.orders, 0) : null,
        cum,
        cumShare: total > 0 ? rnd(cum / total, 4) : null,
        share: maxQty > 0 ? rnd(r.qty / maxQty, 4) : null,
        distanceBps: mid ? rnd(((r.price - mid) / mid) * 10_000, 1) : null,
        large: med !== null && med > 0 && r.qty >= LARGE_MULTIPLE * med,
      };
    });
  };
  const bidRows = ladder(bids);
  const askRows = ladder(asks);
  const bidQty = sum(bids.map((l) => l.qty));
  const askQty = sum(asks.map((l) => l.qty));
  const bidTop = sum(bids.slice(0, TOP).map((l) => l.qty));
  const askTop = sum(asks.slice(0, TOP).map((l) => l.qty));
  const b1 = bids[0]?.qty ?? 0;
  const a1 = asks[0]?.qty ?? 0;
  const micro = bestBid !== null && bestAsk !== null && b1 + a1 > 0 ? (bestAsk * b1 + bestBid * a1) / (b1 + a1) : null;
  const walls = (rows) =>
    [...rows]
      .sort((x, y) => y.qty - x.qty || x.level - y.level)
      .slice(0, 3)
      .map((r) => ({ price: r.price, qty: r.qty, level: r.level, distanceBps: r.distanceBps }));
  const orders = (rows) => (rows.every((r) => r.orders === null) ? null : sum(rows.map((r) => r.orders ?? 0)));
  return {
    levels: { bids: bids.length, asks: asks.length },
    bestBid,
    bestAsk,
    mid: rnd(mid, 4),
    spread: bestBid !== null && bestAsk !== null ? rnd(bestAsk - bestBid, 4) : null,
    spreadBps: bestBid !== null && bestAsk !== null && mid ? rnd(((bestAsk - bestBid) / mid) * 10_000, 2) : null,
    microprice: rnd(micro, 4),
    totals: { bidQty, askQty, bidOrders: orders(bidRows), askOrders: orders(askRows) },
    imbalance: rnd(imbalance(bidQty, askQty), 4),
    imbalanceTop5: rnd(imbalance(bidTop, askTop), 4),
    medianLevelQty: med,
    largeMultiple: LARGE_MULTIPLE,
    walls: { bids: walls(bidRows), asks: walls(askRows) },
    bids: bidRows,
    asks: askRows,
  };
}

/** @returns {Array<[string, string, object, (ctx: any) => Promise<object>]>} */
export function depthProfileRoutes(deps) {
  async function profile(ctx) {
    const raw = ctx.query.get("symbol");
    const symbol = raw === null ? "" : raw.trim();
    if (!symbol) throw invalid("symbol", "symbol is required, for example NSE:RELIANCE.");
    const levels = depthLevelsParam(ctx.query);
    const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
    const d = await deps.marketData.depth(symbol, levels ? { ...opts, levels } : opts);
    return {
      data: { symbol: d.symbol, requestedLevels: levels ?? 5, ...depthProfile(d) },
      meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, freshness: d.freshness },
    };
  }
  return [["GET", "/v1/analytics/depth-profile", { scope: "read" }, profile]];
}
