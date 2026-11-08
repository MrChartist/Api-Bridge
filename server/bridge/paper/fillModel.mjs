/**
 * Paper fill model. Pure functions only (no I/O, no clock), so every rule here is unit-tested with plain
 * numbers. The engine (paperEngine.mjs) feeds them prices from deps.marketData and `tick` events.
 *
 * Rules (docs/ARCHITECTURE.md §7, also returned to clients as FILL_MODEL_TEXT):
 *  - MARKET fills at once at the opposite best price from depth when available (ask for a buy, bid for a sell), else
 *    at LTP ± slippage (buy pays up, sell receives less), rounded to the tick away from the trader's favour.
 *  - LIMIT fills when the market crosses the limit, at the limit. When the book is known (depth, or best bid/ask)
 *    the opposite touch decides: a buy when ask <= limit, a sell when bid >= limit. Only when the book is unknown does
 *    LTP decide (a buy when LTP <= limit, a sell when LTP >= limit).
 *    A LIMIT that is already marketable when placed (or modified) fills at once at the better of the market price
 *    and the limit, as an exchange would match it against the book.
 *  - SL and SL-M wait in trigger_pending until LTP crosses the trigger (a buy when LTP >= trigger, a sell when
 *    LTP <= trigger). Then SL-M fills like a MARKET order and SL becomes a LIMIT at its price.
 *  - Fills are whole (no partial fills), with no queue position and no market impact.
 *
 * Margin (approximate, documented as such): cash delivery (CNC, MTF, MARGIN on equity) blocks the full value;
 * INTRADAY equity blocks `intradayEquityPct`; futures block `futuresPct` of contract value; option buys block the
 * premium; option writing blocks `optionSellPct` of strike × quantity.
 */

/** Short description returned by GET /v1/paper/accounts/{id} (PaperAccount.fillModel). */
export const FILL_MODEL_TEXT =
  "MARKET orders fill at once at the opposite best price from market depth when available, otherwise at the last traded price plus or minus the configured slippage. " +
  "LIMIT orders fill at the limit when the opposite best price (ask for a buy, bid for a sell) crosses it, or the last traded price when bid and ask are unknown (a marketable limit fills at once at the better price). " +
  "SL and SL-M orders trigger when the last traded price crosses the trigger; SL-M then fills like a market order and SL becomes a limit order. " +
  "Prices are checked on every live tick and at least every few seconds otherwise. Fills are whole, with no queue position, partial fills or market impact. " +
  "Margin is a simple approximation (full value for delivery, a percentage for intraday, futures and option writing, premium for option buys). " +
  "Intraday positions are squared off automatically at the configured time (15:20 IST by default for NSE and BSE).";

const EPS = 1e-9;

/** Round to 2 decimals (paise). */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Round to 4 decimals (average prices). */
export const round4 = (n) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/**
 * Round a price to the instrument's tick size.
 * @param {number} price
 * @param {number} tick  > 0 (anything else rounds to paise)
 * @param {"nearest"|"up"|"down"} [mode]
 */
export function roundToTick(price, tick, mode = "nearest") {
  const t = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const q = price / t;
  const n = mode === "up" ? Math.ceil(q - EPS) : mode === "down" ? Math.floor(q + EPS) : Math.round(q);
  // Avoid 0.30000000000000004-style noise by rounding to the tick's decimal places.
  const decimals = Math.min(8, Math.max(2, (String(t).split(".")[1] ?? "").length));
  return Number((n * t).toFixed(decimals));
}

/** Whether `price` is a whole multiple of `tick` (with float tolerance). */
export function isTickMultiple(price, tick) {
  if (!(tick > 0)) return true;
  const q = price / tick;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

/**
 * Best opposite price from a depth snapshot, or null.
 * @param {"BUY"|"SELL"} side
 * @param {{ bids?: Array<{ price: number }>, asks?: Array<{ price: number }> } | null | undefined} depth
 */
export function bestOpposite(side, depth) {
  const level = side === "BUY" ? depth?.asks?.[0] : depth?.bids?.[0];
  const p = Number(level?.price);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Price for a MARKET fill (also SL-M after its trigger).
 * @param {{ side: "BUY"|"SELL", ltp?: number | null, bid?: number | null, ask?: number | null, depth?: object | null,
 *   slippageBps: number, tickSize: number }} p
 * @returns {{ price: number, basis: "depth" | "ltp" } | null}  null when there is no usable price
 */
export function marketFillPrice({ side, ltp, bid, ask, depth, slippageBps, tickSize }) {
  const fromDepth = bestOpposite(side, depth);
  if (fromDepth !== null) return { price: fromDepth, basis: "depth" };
  const touch = side === "BUY" ? ask : bid;
  if (Number.isFinite(touch) && touch > 0) return { price: touch, basis: "depth" };
  if (!(Number.isFinite(ltp) && ltp > 0)) return null;
  const factor = side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  const raw = ltp * factor;
  const price = roundToTick(raw, tickSize, side === "BUY" ? "up" : "down");
  return { price: price > 0 ? price : roundToTick(ltp, tickSize), basis: "ltp" };
}

/** Whether a stop order's trigger has been crossed by `ltp`. */
export function stopTriggered(side, triggerPrice, ltp) {
  return side === "BUY" ? ltp >= triggerPrice - EPS : ltp <= triggerPrice + EPS;
}

/** Whether `ltp` has crossed a limit (a buy at or below, a sell at or above). */
export function limitCrossed(side, limit, ltp) {
  return side === "BUY" ? ltp <= limit + EPS : ltp >= limit - EPS;
}

/** The opposite touch (best ask for a buy, best bid for a sell) from depth or bid/ask, or null when unknown. */
export function oppositeTouch(side, market) {
  const fromDepth = bestOpposite(side, market?.depth);
  if (fromDepth !== null) return fromDepth;
  const touch = side === "BUY" ? market?.ask : market?.bid;
  return Number.isFinite(touch) && touch > 0 ? touch : null;
}

/**
 * Whether a LIMIT is marketable now: against the opposite touch when the book is known, else against LTP. A buy at
 * 100 with LTP 99.5 but ask 101 is NOT marketable: no seller at or below 100 is showing.
 */
export function limitMarketable(side, limit, market) {
  const touch = oppositeTouch(side, market);
  return limitCrossed(side, limit, touch ?? market.ltp);
}

/**
 * What should happen to a pending order at a new price.
 *
 * @param {{ side: "BUY"|"SELL", orderType: "LIMIT"|"MARKET"|"SL"|"SL-M", price: number | null, triggerPrice: number | null,
 *   triggered: boolean }} order
 * @param {{ ltp: number, bid?: number | null, ask?: number | null, depth?: object | null }} market
 * @param {{ slippageBps: number, tickSize: number, immediate?: boolean }} opts
 *   immediate: the order was just placed or modified, so a marketable LIMIT gets the better price (exchange matching).
 * @returns {{ action: "none" } | { action: "trigger" } | { action: "fill", price: number, triggered: boolean } | { action: "noprice" }}
 */
export function evaluate(order, market, { slippageBps, tickSize, immediate = false }) {
  const ltp = market?.ltp;
  if (!(Number.isFinite(ltp) && ltp > 0)) return { action: "noprice" };
  let triggered = order.triggered;
  let type = order.orderType;
  if (type === "SL" || type === "SL-M") {
    if (!triggered) {
      if (!stopTriggered(order.side, order.triggerPrice, ltp)) return { action: "none" };
      triggered = true;
    }
    type = type === "SL" ? "LIMIT" : "MARKET";
  }
  if (type === "MARKET") {
    const fill = marketFillPrice({ side: order.side, ltp, bid: market.bid, ask: market.ask, depth: market.depth, slippageBps, tickSize });
    return fill ? { action: "fill", price: fill.price, triggered } : { action: "noprice" };
  }
  // LIMIT (or a triggered SL acting as one)
  if (!limitMarketable(order.side, order.price, market)) return triggered !== order.triggered ? { action: "trigger" } : { action: "none" };
  if (immediate || triggered !== order.triggered) {
    // Marketable on arrival: match at the better of market and limit.
    const m = marketFillPrice({ side: order.side, ltp, bid: market.bid, ask: market.ask, depth: market.depth, slippageBps: 0, tickSize });
    const mp = m?.price ?? ltp;
    const price = order.side === "BUY" ? Math.min(order.price, mp) : Math.max(order.price, mp);
    return { action: "fill", price, triggered };
  }
  return { action: "fill", price: order.price, triggered };
}

/**
 * Approximate margin for an exposure.
 * @param {{ kind: "INDEX"|"EQ"|"FUT"|"OPT", strike?: number | null }} inst
 * @param {{ side: "BUY"|"SELL", product: string, quantity: number, price: number }} exp  quantity in units (> 0)
 * @param {{ intradayEquityPct: number, futuresPct: number, optionSellPct: number }} m
 * @returns {number} rupees
 */
export function marginFor(inst, { side, product, quantity, price }, m) {
  const qty = Math.abs(quantity);
  if (qty === 0) return 0;
  const value = qty * price;
  if (inst.kind === "FUT") return round2((value * m.futuresPct) / 100);
  if (inst.kind === "OPT") {
    if (side === "BUY") return round2(value);
    const strikeValue = qty * (Number(inst.strike) > 0 ? Number(inst.strike) : price);
    return round2((strikeValue * m.optionSellPct) / 100);
  }
  // Equity (and anything else tradable in cash)
  if (product === "INTRADAY") return round2((value * m.intradayEquityPct) / 100);
  return round2(value);
}

/**
 * Brokerage for one filled order.
 * @param {number} turnover rupees
 * @param {{ perOrder: number, pct: number, maxPerOrder: number | null }} b
 */
export function brokerageFor(turnover, b) {
  let c = b.perOrder + (turnover * b.pct) / 100;
  if (b.maxPerOrder !== null && b.maxPerOrder !== undefined) c = Math.min(c, b.maxPerOrder);
  return round2(Math.max(0, c));
}

/**
 * Apply a fill to a position (pure; returns a new object) and report the realised P&L it produced.
 *
 * Same direction: quantity grows, average price is the weighted average. Opposite direction: the closed part
 * realises (fill − average) × closed quantity × direction; any excess opens a new position at the fill price.
 *
 * @param {{ netQty: number, avgPrice: number, realisedPnl: number, buyQty: number, sellQty: number, buyValue: number, sellValue: number }} pos
 * @param {{ side: "BUY"|"SELL", quantity: number, price: number }} fill
 * @returns {{ position: object, realised: number }}
 */
export function applyFill(pos, { side, quantity, price }) {
  const signed = side === "BUY" ? quantity : -quantity;
  const p = { ...pos };
  if (side === "BUY") {
    p.buyQty += quantity;
    p.buyValue += quantity * price;
  } else {
    p.sellQty += quantity;
    p.sellValue += quantity * price;
  }
  let realised = 0;
  if (p.netQty === 0 || Math.sign(p.netQty) === Math.sign(signed)) {
    const newQty = p.netQty + signed;
    p.avgPrice = (Math.abs(p.netQty) * p.avgPrice + quantity * price) / Math.abs(newQty);
    p.netQty = newQty;
  } else {
    const closing = Math.min(Math.abs(p.netQty), quantity);
    const dir = Math.sign(p.netQty); // +1 long being sold, -1 short being bought back
    realised = (price - p.avgPrice) * closing * dir;
    const newQty = p.netQty + signed;
    if (newQty === 0) p.avgPrice = 0;
    else if (Math.sign(newQty) !== dir) p.avgPrice = price; // flipped: the remainder opened at the fill price
    p.netQty = newQty;
  }
  p.realisedPnl += realised;
  return { position: p, realised };
}
