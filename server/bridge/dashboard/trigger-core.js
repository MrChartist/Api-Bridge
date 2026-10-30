// Triggers (GTT, OCO, trailing stops, stops and targets) in plain words, and the request bodies the sheets send.
// Pure: no DOM, no fetch, no clock. The engine is on the Bridge (server/bridge/triggers/); this only describes it.
import { DASH, formatFixed, formatInt, isFigure } from "./format.js";
import { REF_DEFAULTS, hmMinutes } from "./reference.js";

/** Triggers that can still fire. */
export const OPEN_TRIGGER = Object.freeze(new Set(["waiting", "active", "firing"]));

/** The side of the price a trigger sits on ("above" or "below"), or null when it is the price itself. */
export function opFor(trigger, ltp) {
  if (!isFigure(trigger) || !isFigure(ltp) || Number(trigger) === Number(ltp)) return null;
  return Number(trigger) > Number(ltp) ? "above" : "below";
}

/** Default buffer between a GTT's trigger and its limit price: 0.5 % (a buy pays up to it, a sell down to it). */
export const GTT_BUFFER_PCT = 0.5;

const tickRound = (v, tick, dir) => {
  const t = Number(tick) > 0 ? Number(tick) : 0.05;
  const u = v / t;
  return Math.round((dir === "up" ? Math.ceil(u - 1e-9) : Math.floor(u + 1e-9)) * t * 1e6) / 1e6;
};

/**
 * The limit price a GTT's order should carry so it fills when it fires: the trigger plus a buffer for a buy, minus it
 * for a sell, rounded to the tick away from the trigger. Null without a trigger.
 */
export function gttLimit(trigger, side, tick = 0.05, bufferPct = GTT_BUFFER_PCT) {
  if (!isFigure(trigger) || Number(trigger) <= 0) return null;
  const t = Number(trigger);
  return side === "BUY" ? tickRound(t * (1 + bufferPct / 100), tick, "up") : Math.max(Number(tick) || 0.05, tickRound(t * (1 - bufferPct / 100), tick, "down"));
}

/** A warning when a GTT's limit is on the wrong side of its trigger (it would rest unfilled once it fires), else null. */
export function gttLimitWarning(side, trigger, limit) {
  if (!isFigure(trigger) || !isFigure(limit)) return null;
  if (side === "BUY" && Number(limit) < Number(trigger)) return `A buy limit of ${formatFixed(limit, 2)} is under the trigger ${formatFixed(trigger, 2)}: when it fires the order may rest unfilled. Use ${formatFixed(trigger, 2)} or more, or a market order.`;
  if (side === "SELL" && Number(limit) > Number(trigger)) return `A sell limit of ${formatFixed(limit, 2)} is over the trigger ${formatFixed(trigger, 2)}: when it fires the order may rest unfilled. Use ${formatFixed(trigger, 2)} or less, or a market order.`;
  return null;
}

/** How long a GTT lasts for a product: an intraday one ends at today's 15:20 square-off; carry lasts to expiry. */
export function gttValidityText(product) {
  return product === "INTRADAY" ? "Intraday: good till 15:20 today, then cancelled." : "Good till the contract expires.";
}

/** The price a GTT entry is expected to fill at: its limit, or the trigger for a market order. */
export function gttFillPrice({ orderType, price, trigger }) {
  if (orderType === "LIMIT" && isFigure(price)) return Number(price);
  return isFigure(trigger) ? Number(trigger) : null;
}

/**
 * P&L of a position if it is closed at `price`: (price − average) × signed quantity. Null without the figures.
 * @param {number} price @param {number} avg @param {number} qty signed units (long +, short −)
 */
export function pnlAt(price, avg, qty) {
  if (!isFigure(price) || !isFigure(avg) || !isFigure(qty)) return null;
  return (Number(price) - Number(avg)) * Number(qty);
}

/** The short chip for a position's open exits: "SL 449.00 · T 785.00" (trailing: "TSL"), or null. */
export function exitChipText(triggers, symbol) {
  const mine = (triggers ?? []).filter((t) => t.symbol === symbol && t.reduceOnly && OPEN_TRIGGER.has(t.status) && t.status !== "waiting");
  if (!mine.length) return null;
  const parts = [];
  for (const t of mine)
    for (const l of t.legs ?? []) parts.push(`${l.role === "target" ? "T" : l.trail ? "TSL" : "SL"} ${formatFixed(l.trigger, 2)}`);
  return parts.join(" · ");
}

// ── Stop-loss orders (SL, SL-M) on the ticket: held at the exchange (paper: the paper engine), not on the Bridge ──

/** A start for an SL order's trigger: 1 % beyond the price on the side it waits for (above for a buy). */
export function slTriggerStart(side, ltp, tick = 0.05) {
  if (!isFigure(ltp) || Number(ltp) <= 0) return null;
  return tickRound(Number(ltp) * (side === "BUY" ? 1.01 : 0.99), tick, side === "BUY" ? "up" : "down");
}

/**
 * What is wrong with an SL or SL-M order's prices, in plain words, or null: the trigger must be past the price now on
 * the side the order waits for (a buy above, a sell below), and an SL's limit must be at or beyond the trigger.
 * @returns {{ field: "trigger"|"price", message: string } | null}
 */
export function stopOrderProblem({ side, orderType, trigger, price, ltp }) {
  if (orderType !== "SL" && orderType !== "SL-M") return null;
  if (!isFigure(trigger) || Number(trigger) <= 0) return { field: "trigger", message: "Enter a trigger price." };
  const t = Number(trigger);
  if (isFigure(ltp)) {
    if (side === "BUY" && t <= Number(ltp)) return { field: "trigger", message: `A stop-loss buy triggers above the price now (${formatFixed(ltp, 2)}). For a buy below it, use a limit order.` };
    if (side === "SELL" && t >= Number(ltp)) return { field: "trigger", message: `A stop-loss sell triggers below the price now (${formatFixed(ltp, 2)}). For a sell above it, use a limit order.` };
  }
  if (orderType === "SL") {
    if (!isFigure(price) || Number(price) <= 0) return { field: "price", message: "Enter the limit price the order uses once triggered." };
    if (side === "BUY" && Number(price) < t) return { field: "price", message: "For a stop-loss buy the limit is at or above the trigger." };
    if (side === "SELL" && Number(price) > t) return { field: "price", message: "For a stop-loss sell the limit is at or below the trigger." };
  }
  return null;
}

/** One line saying what an SL or SL-M order does. */
export function stopOrderText({ side, orderType, trigger, price }) {
  if (!isFigure(trigger)) return "";
  const when = `when LTP ${side === "BUY" ? "rises to" : "falls to"} ${formatFixed(trigger, 2)}`;
  return orderType === "SL-M" ? `Sends a market ${side === "BUY" ? "buy" : "sell"} ${when}. Rests at the exchange until then.` : `Sends a limit ${side === "BUY" ? "buy" : "sell"} at ${isFigure(price) ? formatFixed(price, 2) : DASH} ${when}. Rests at the exchange until then.`;
}

/**
 * Whether the market takes orders at `ms` (09:15 to 15:30 IST on a weekday; holidays are the Bridge's to know, so an
 * after-market order set on a holiday is still checked there). The ticket offers "At the open" when this is false.
 */
export function marketClosedAt(ms) {
  const d = new Date(ms + 19_800_000);
  const wd = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd === 0 || wd === 6 || mins < hmMinutes(REF_DEFAULTS.session.open) || mins >= hmMinutes(REF_DEFAULTS.session.close);
}

/** When an after-market order goes, and where it is held: "Goes at 09:15 on Mon 26 Oct · held on this Bridge". */
export function amoWhenText(t) {
  const at = t.openAt ? new Date(Date.parse(t.openAt) + 19_800_000) : null;
  const day = at ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getUTCDay()]} ${formatInt(at.getUTCDate())} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getUTCMonth()]}` : null;
  const where = t.held === "broker" ? "Queued at your broker" : "Held on this Bridge: it must be running at 09:15 IST";
  return `${day ? `Goes at 09:15 on ${day}` : "Goes at the next open"} · ${where}`;
}

/**
 * The order checks that still apply to an order sent on a later IST day (an after-market order): today's daily
 * counters (DAILY_LIMIT_REACHED: the day's loss and order count) reset at the day roll, so they are left out; per-order
 * limits, the kill switch, the price band and the live gates stay.
 */
export function checksForLaterDay(checks) {
  return (checks ?? []).filter((c) => c?.code !== "DAILY_LIMIT_REACHED");
}

/** What kind of trigger it is, in the words brokers use. */
export function kindText(t) {
  if (t.origin === "amo") return "After-market order";
  if (t.origin === "bracket") return t.type === "oco" ? "Stop and target (on entry)" : t.legs?.[0]?.role === "target" ? "Target (on entry)" : "Stop (on entry)";
  const trails = (t.legs ?? []).some((l) => l.trail);
  if (t.origin === "position") {
    if (t.type === "oco") return trails ? "Trailing stop and target" : "Stop and target";
    return trails ? "Trailing stop" : t.legs?.[0]?.role === "target" ? "Target" : "Stop";
  }
  if (trails) return "Trailing GTT";
  return t.type === "oco" ? "GTT OCO" : "GTT";
}

/** The trigger's state in plain words, with a pill tone. */
export function statusText(t) {
  switch (t.status) {
    case "waiting":
      return { text: "Waits for the entry to fill", tone: "warn" };
    case "active":
      if (t.origin === "amo") return { text: t.result?.code ? "Queued · retrying" : "Queued for the open", tone: "info" };
      return { text: t.result?.code ? "Active · retrying" : "Active", tone: "info" };
    case "firing":
      return { text: "Sending", tone: "warn" };
    case "triggered":
      return t.result?.status === "rejected" ? { text: "Triggered · order rejected", tone: "bad" } : { text: "Triggered", tone: "ok" };
    case "failed":
      return { text: "Failed", tone: "bad" };
    case "cancelled":
      return { text: "Cancelled", tone: "" };
    case "expired":
      return { text: "Expired", tone: "" };
    default:
      return { text: String(t.status ?? "Unknown"), tone: "warn" };
  }
}

const sizeText = (units, lotSize) => {
  const lot = Number(lotSize) > 1 ? Number(lotSize) : 1;
  if (!isFigure(units)) return DASH;
  return lot > 1 && units % lot === 0 ? `${formatInt(units / lot)} lot${units / lot === 1 ? "" : "s"}` : `${formatInt(units)} qty`;
};

/** One leg: "Sell 1 lot at market when LTP ≤ 98.50 · trails 5.00". */
export function legText(leg, lotSize = 1) {
  const side = leg.order?.side === "BUY" ? "Buy" : "Sell";
  const how = leg.order?.orderType === "LIMIT" ? `at ${formatFixed(leg.order.price, 2)}` : "at market";
  if (leg.op === "open") return `${side} ${sizeText(leg.order?.quantity, lotSize)} ${how} at the open`;
  const cmp = leg.op === "above" ? "≥" : "≤";
  const trail = leg.trail ? (isFigure(leg.trail.points) ? ` · trails ${formatFixed(leg.trail.points, 2)}` : ` · trails ${formatFixed(leg.trail.pct, 1)}%`) : "";
  return `${side} ${sizeText(leg.order?.quantity, lotSize)} ${how} when LTP ${cmp} ${formatFixed(leg.trigger, 2)}${trail}`;
}

/** How far the price must move to reach a leg, as a percent of the price now (unsigned). */
export function distancePct(leg, ltp) {
  if (!isFigure(ltp) || !isFigure(leg?.trigger) || Number(ltp) === 0) return null;
  return Math.abs((Number(leg.trigger) - Number(ltp)) / Number(ltp)) * 100;
}

/** What happened, in one line (for fired, failed, cancelled or expired triggers, and retries). */
export function outcomeText(t) {
  const r = t.result ?? {};
  if (t.status === "triggered") return r.status === "rejected" ? `Order rejected: ${r.message ?? "no reason given"}` : `Order ${r.status ?? "sent"}${isFigure(r.quantity) ? ` · ${sizeText(r.quantity, t.lotSize)}` : ""}${isFigure(t.fireLtp) ? ` · LTP was ${formatFixed(t.fireLtp, 2)}` : ""}`;
  return r.message ?? "";
}

/**
 * The POST /v1/triggers body from a sheet's fields.
 * @param {{ account: string, symbol: string, product: string, mode?: string, side: "BUY"|"SELL", units: number,
 *   origin?: "gtt"|"bracket"|"position", parentOrderId?: string, entry?: number|null, stop?: number|null,
 *   target?: number|null, trail?: number|null, orderType?: "MARKET"|"LIMIT", price?: number|null, ltp?: number|null }} f
 *   `entry` is a GTT's one trigger; `stop` and `target` are an exit's (either or both); `trail` is points on the stop.
 */
export function triggerBody(f) {
  const order = (px) => ({ side: f.side, quantity: f.units, orderType: f.orderType === "LIMIT" ? "LIMIT" : "MARKET", ...(f.orderType === "LIMIT" && isFigure(px) ? { price: Number(px) } : {}) });
  const base = { account: f.account, symbol: f.symbol, product: f.product, ...(f.mode === "live" ? { mode: "live" } : {}), origin: f.origin ?? "gtt", ...(f.parentOrderId ? { parentOrderId: f.parentOrderId } : {}) };
  if (f.origin === "amo") return { ...base, type: "single", legs: [{ role: "entry", order: order(f.price) }] };
  if ((f.origin ?? "gtt") === "gtt") {
    const trail = isFigure(f.trail) && Number(f.trail) > 0 ? { trail: { points: Number(f.trail) } } : {};
    return { ...base, type: "single", legs: [{ trigger: Number(f.entry), role: "entry", ...trail, order: order(f.price) }] };
  }
  // An exit closes: a sell exit's stop sits below the price and its target above; a buy exit's the other way.
  const stopOp = f.side === "SELL" ? "below" : "above";
  const targetOp = stopOp === "below" ? "above" : "below";
  const legs = [];
  if (isFigure(f.stop)) legs.push({ trigger: Number(f.stop), op: stopOp, role: "stop", ...(isFigure(f.trail) && Number(f.trail) > 0 ? { trail: { points: Number(f.trail) } } : {}), order: order(f.stopPrice ?? f.price) });
  if (isFigure(f.target)) legs.push({ trigger: Number(f.target), op: targetOp, role: "target", order: order(f.targetPrice ?? f.price) });
  return { ...base, type: legs.length === 2 ? "oco" : "single", legs };
}

/**
 * Field problems before sending, in plain words: { field, message } or null. The Bridge checks again.
 * `kind` "gtt" needs `entry`; an exit needs a stop or a target on the right side of the price.
 */
export function triggerProblem(f) {
  const ltp = isFigure(f.ltp) ? Number(f.ltp) : null;
  if (!(Number(f.units) > 0)) return { field: "qty", message: "Enter a quantity." };
  if (f.origin === "amo") return f.orderType === "LIMIT" && !(Number(f.price) > 0) ? { field: "price", message: "Enter a limit price, or use a market order." } : null;
  if ((f.origin ?? "gtt") === "gtt") {
    if (!(Number(f.entry) > 0)) return { field: "entry", message: "Enter the trigger price." };
    if (ltp !== null && Number(f.entry) === ltp) return { field: "entry", message: "The trigger is the price now. Place the order instead." };
  } else {
    const hasStop = isFigure(f.stop) && Number(f.stop) > 0;
    const hasTarget = isFigure(f.target) && Number(f.target) > 0;
    if (!hasStop && !hasTarget) return { field: "stop", message: "Enter a stop, a target or both." };
    const long = f.side === "SELL";
    // A waiting bracket is checked against the entry price, an exit against the price now.
    const ref = isFigure(f.ref) ? Number(f.ref) : ltp;
    if (ref !== null) {
      if (hasStop && (long ? Number(f.stop) >= ref : Number(f.stop) <= ref)) return { field: "stop", message: `A stop for a ${long ? "long" : "short"} goes ${long ? "below" : "above"} ${formatFixed(ref, 2)}.` };
      if (hasTarget && (long ? Number(f.target) <= ref : Number(f.target) >= ref)) return { field: "target", message: `A target for a ${long ? "long" : "short"} goes ${long ? "above" : "below"} ${formatFixed(ref, 2)}.` };
    }
    if (isFigure(f.trail) && Number(f.trail) < 0) return { field: "trail", message: "The trail is a distance above zero." };
  }
  if (f.orderType === "LIMIT" && !(Number(f.price) > 0) && !(Number(f.stopPrice) > 0 || Number(f.targetPrice) > 0)) return { field: "price", message: "Enter a limit price, or use a market order." };
  return null;
}
