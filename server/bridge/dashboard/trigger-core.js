// Triggers (GTT, OCO, trailing stops, stops and targets) in plain words, and the request bodies the sheets send.
// Pure: no DOM, no fetch, no clock. The engine is on the Bridge (server/bridge/triggers/); this only describes it.
import { DASH, formatFixed, formatInt, isFigure } from "./format.js";

/** Triggers that can still fire. */
export const OPEN_TRIGGER = Object.freeze(new Set(["waiting", "active", "firing"]));

/** The side of the price a trigger sits on ("above" or "below"), or null when it is the price itself. */
export function opFor(trigger, ltp) {
  if (!isFigure(trigger) || !isFigure(ltp) || Number(trigger) === Number(ltp)) return null;
  return Number(trigger) > Number(ltp) ? "above" : "below";
}

/** What kind of trigger it is, in the words brokers use. */
export function kindText(t) {
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
