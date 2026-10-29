/**
 * Order request validation — stream S7.
 *
 *  1. Shape (zod, matching docs/openapi.yaml exactly): OrderRequest, OrderChanges, the cancel-all body and the list
 *     queries. No default product or order type; exactly one of quantity (units) or lots; unknown fields refused.
 *  2. Pre-trade checks against the resolved instrument (`checkInstrumentOrder`): tradable kind, product allowed for
 *     the instrument, lot multiple, tick size for price and trigger, freeze quantity (slice only when configured),
 *     SL price/trigger order. Each problem is a Check { code, message, severity } so preview can show all of them
 *     and place can refuse with the first.
 *  3. Market-order policy (`applyMarketPolicy`): "reject" refuses MARKET and SL-M; "protect" keeps them when the
 *     broker has native market protection (with a percentage), or converts them to LIMIT / SL at LTP ± pct, rounded
 *     to the tick, and says so in a warning.
 *  4. `fingerprint()`: a stable hash of a request body for idempotency and ticket binding.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { fromValidation } from "../core/errors.mjs";

export const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,255}$/;
export const TAG_RE = /^[A-Za-z0-9_-]{1,20}$/;
export const PRODUCTS = Object.freeze(["CNC", "INTRADAY", "MARGIN", "MTF"]);
export const ORDER_TYPES = Object.freeze(["LIMIT", "MARKET", "SL", "SL-M"]);
export const ORDER_STATUSES = Object.freeze(["pending", "open", "trigger_pending", "partially_filled", "filled", "cancelled", "rejected", "expired", "outcome_unknown"]);
export const TERMINAL_STATUSES = Object.freeze(new Set(["filled", "cancelled", "rejected", "expired"]));

const positivePrice = z.number().finite().gt(0).max(1e9);

/** OrderRequest (docs/openapi.yaml components.schemas.OrderRequest). */
export const orderRequestSchema = z
  .object({
    account: z.string().regex(ACCOUNT_RE, "use the account id from your config"),
    symbol: z.string().min(1).max(64),
    side: z.enum(["BUY", "SELL"]),
    quantity: z.number().int().min(1).max(100_000_000).optional(),
    lots: z.number().int().min(1).max(100_000).optional(),
    /** The lot size the caller has checked; used only when reference lot data is stale (p1-02 §3.6, LOT_SIZE_STALE). */
    lotSizeConfirmed: z.number().int().min(1).max(10_000_000).optional(),
    product: z.enum(PRODUCTS),
    orderType: z.enum(ORDER_TYPES),
    price: positivePrice.optional(),
    triggerPrice: positivePrice.optional(),
    validity: z.enum(["DAY", "IOC"]).optional(),
    marketProtectionPct: z.number().finite().gt(0).max(10).optional(),
    disclosedQuantity: z.number().int().min(0).optional(),
    mode: z.enum(["paper", "live"]).optional(),
    clientOrderId: z.string().regex(CLIENT_ORDER_ID_RE, "use 1-64 letters, digits, '_' or '-'").optional(),
    tag: z.string().regex(TAG_RE, "use 1-20 letters, digits, '_' or '-'").optional(),
    algoId: z.string().min(1).max(32).optional(),
    confirmToken: z.string().min(16).max(256).optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const hasQty = o.quantity !== undefined;
    const hasLots = o.lots !== undefined;
    if (hasQty === hasLots) ctx.addIssue({ code: "custom", path: ["quantity"], message: "Send exactly one of quantity (units) or lots." });
    const needsPrice = o.orderType === "LIMIT" || o.orderType === "SL";
    const needsTrigger = o.orderType === "SL" || o.orderType === "SL-M";
    if (needsPrice && o.price === undefined) ctx.addIssue({ code: "custom", path: ["price"], message: `price is required for ${o.orderType} orders.` });
    if (!needsPrice && o.price !== undefined) ctx.addIssue({ code: "custom", path: ["price"], message: `price is not used for ${o.orderType} orders; remove it.` });
    if (needsTrigger && o.triggerPrice === undefined) ctx.addIssue({ code: "custom", path: ["triggerPrice"], message: `triggerPrice is required for ${o.orderType} orders.` });
    if (!needsTrigger && o.triggerPrice !== undefined) ctx.addIssue({ code: "custom", path: ["triggerPrice"], message: `triggerPrice is only used for SL and SL-M orders.` });
    if (o.marketProtectionPct !== undefined && o.orderType !== "MARKET" && o.orderType !== "SL-M") {
      ctx.addIssue({ code: "custom", path: ["marketProtectionPct"], message: "marketProtectionPct is only used for MARKET and SL-M orders." });
    }
    if (o.disclosedQuantity !== undefined && hasQty && o.disclosedQuantity > o.quantity) {
      ctx.addIssue({ code: "custom", path: ["disclosedQuantity"], message: "disclosedQuantity cannot be more than quantity." });
    }
  });

/** OrderChanges (PATCH /v1/orders/{orderId}). */
export const orderChangesSchema = z
  .object({
    quantity: z.number().int().min(1).max(100_000_000).optional(),
    price: positivePrice.optional(),
    triggerPrice: positivePrice.optional(),
    orderType: z.enum(ORDER_TYPES).optional(),
    validity: z.enum(["DAY", "IOC"]).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "Send at least one field to change." });

/** POST /v1/orders/cancel-all body. */
export const cancelAllSchema = z
  .object({
    account: z.string().regex(ACCOUNT_RE).optional(),
    mode: z.enum(["paper", "live"]).optional(),
  })
  .strict();

/**
 * Parse with a zod schema; throws VALIDATION_FAILED listing each field.
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} input
 * @param {string} [detail]
 * @returns {T}
 */
export function parseWith(schema, input, detail) {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
}

/** @param {unknown} input */
export const parseOrderRequest = (input) => parseWith(orderRequestSchema, input, "The order is missing fields or has fields that are not valid.");
/** @param {unknown} input */
export const parseOrderChanges = (input) => parseWith(orderChangesSchema, input, "The change request is not valid.");

// ───────────────────────────── Fingerprints ─────────────────────────────

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 hex of the canonical JSON of `value` (key order and undefined fields do not matter). */
export function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The order body without the confirmation token: what idempotency and tickets bind to. */
export function orderBody(req) {
  const { confirmToken, ...rest } = req;
  void confirmToken;
  return rest;
}

// ───────────────────────────── Number helpers ─────────────────────────────

const SCALE = 1e6;
const scaled = (v) => Math.round(v * SCALE);

/** Whether `value` is a whole multiple of `step` (6-decimal fixed point, no float drift). */
export function isMultipleOf(value, step) {
  if (!(step > 0)) return true;
  const s = scaled(step);
  return s === 0 || scaled(value) % s === 0;
}

/** Round to a multiple of `tick`: "down", "up" or "nearest". Result has no float noise. */
export function roundToTick(value, tick, direction = "nearest") {
  if (!(tick > 0)) return value;
  const s = scaled(tick);
  const v = value * SCALE;
  const n = direction === "down" ? Math.floor(v / s + 1e-9) : direction === "up" ? Math.ceil(v / s - 1e-9) : Math.round(v / s);
  return Number(((n * s) / SCALE).toFixed(6));
}

/** Indian rupee formatting with Indian digit grouping, e.g. ₹2,00,000 or ₹1,234.50. */
export function rupees(amount) {
  if (!Number.isFinite(amount)) return "₹—";
  const fixed = Math.abs(amount).toFixed(2).replace(/\.00$/, "");
  const [int, frac] = fixed.split(".");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${amount < 0 ? "-" : ""}₹${rest ? `${rest},${last3}` : last3}${frac ? `.${frac}` : ""}`;
}

// ───────────────────────────── Pre-trade checks ─────────────────────────────

/**
 * @typedef {import("../core/contracts.mjs").Check} Check
 * @typedef {import("../core/contracts.mjs").ResolvedInstrument} ResolvedInstrument
 */

const block = (code, message) => ({ code, message, severity: "block" });
const warn = (code, message) => ({ code, message, severity: "warn" });

/**
 * Units for the order: lots × lotSize, or the quantity as given (which must then be a lot multiple).
 * @returns {{ quantity: number | null, checks: Check[] }}
 */
export function resolveQuantity(req, resolved) {
  const lot = resolved.lotSize;
  if (!(Number.isInteger(lot) && lot > 0)) {
    return { quantity: null, checks: [block("SYMBOL_NOT_FOUND", `No lot size is known for ${resolved.canonical}, so the order cannot be sized safely.`)] };
  }
  if (req.lots !== undefined) return { quantity: req.lots * lot, checks: [] };
  if (req.quantity % lot !== 0) {
    return { quantity: req.quantity, checks: [block("INVALID_ORDER", `quantity ${req.quantity} is not a multiple of the lot size ${lot} for ${resolved.canonical}. Send ${Math.max(lot, Math.floor(req.quantity / lot) * lot)} or use lots.`)] };
  }
  return { quantity: req.quantity, checks: [] };
}

/**
 * Pre-trade checks that need only the request and the instrument.
 * @param {object} req OrderRequest (parsed)
 * @param {ResolvedInstrument} resolved
 * @param {number} quantity units
 * @param {{ sliceAboveFreeze?: boolean, maxSlices?: number }} [opts]
 * @returns {{ checks: Check[], legs: number[] }}  legs: units per broker order (one leg unless sliced)
 */
export function checkInstrumentOrder(req, resolved, quantity, { sliceAboveFreeze = false, maxSlices = 10 } = {}) {
  const checks = [];
  const kind = resolved.kind;
  if (kind === "INDEX") checks.push(block("INVALID_ORDER", `${resolved.canonical} is an index and cannot be traded. Trade its futures or options instead.`));
  const derivative = kind === "FUT" || kind === "OPT";
  if (derivative && (req.product === "CNC" || req.product === "MTF")) {
    checks.push(block("INVALID_ORDER", `${req.product} is for cash-market shares. Use INTRADAY or MARGIN for ${resolved.canonical}.`));
  }
  if (kind === "EQ" && req.product === "MARGIN") {
    checks.push(block("INVALID_ORDER", `MARGIN is the carry-forward product for futures and options. Use CNC, MTF or INTRADAY for ${resolved.canonical}.`));
  }
  const tick = resolved.tickSize;
  for (const field of ["price", "triggerPrice"]) {
    const v = req[field];
    if (v !== undefined && tick > 0 && !isMultipleOf(v, tick)) {
      checks.push(block("INVALID_ORDER", `${field} ${v} is not a multiple of the tick size ${tick} for ${resolved.canonical}. Try ${roundToTick(v, tick)}.`));
    }
  }
  if (req.orderType === "SL" && req.price !== undefined && req.triggerPrice !== undefined) {
    if (req.side === "BUY" && req.price < req.triggerPrice) checks.push(block("INVALID_ORDER", "For a BUY stop-loss order the price must be at or above the trigger price."));
    if (req.side === "SELL" && req.price > req.triggerPrice) checks.push(block("INVALID_ORDER", "For a SELL stop-loss order the price must be at or below the trigger price."));
  }
  let legs = [quantity];
  const freeze = resolved.freezeQty;
  // Freeze quantity: the largest quantity the exchange accepts in one order (needs verification per segment against
  // the exchange's current freeze-limit circular; S4 supplies the number and marks whether it is verified).
  if (Number.isFinite(freeze) && freeze > 0 && quantity > freeze) {
    const perLeg = Math.floor(freeze / resolved.lotSize) * resolved.lotSize;
    const count = perLeg > 0 ? Math.ceil(quantity / perLeg) : Infinity;
    if (!sliceAboveFreeze) {
      checks.push(block("INVALID_ORDER", `quantity ${quantity} is above the exchange freeze quantity ${freeze} for ${resolved.canonical}. Send ${perLeg || freeze} or less per order, or turn on orders.sliceAboveFreeze.`));
    } else if (!(count <= maxSlices)) {
      checks.push(block("INVALID_ORDER", `quantity ${quantity} would need ${Number.isFinite(count) ? count : "too many"} orders at the freeze quantity ${freeze}; the limit is ${maxSlices}.`));
    } else {
      legs = [];
      let left = quantity;
      while (left > 0) {
        const q = Math.min(perLeg, left);
        legs.push(q);
        left -= q;
      }
      checks.push(warn("SLICED", `The order is above the freeze quantity ${freeze}, so it will go as ${legs.length} orders (${legs.join(" + ")}). Each one counts towards your order-rate and daily limits.`));
    }
  }
  if (req.algoId !== undefined) checks.push(warn("ALGO_ID_NOT_SENT", "algoId is kept in the audit log; this broker integration does not send it yet (needs verification per broker)."));
  return { checks, legs };
}

/**
 * Apply the market-order policy.
 * @param {object} order OrderRequest-like (orderType, side, price?, triggerPrice?, marketProtectionPct?)
 * @param {{ policy: "protect"|"reject", defaultPct: number, nativeProtection: boolean, ltp: number | null, tickSize: number }} p
 * @returns {{ order: object, checks: Check[], marketProtectionPct: number | null }}
 *   order: what to send (MARKET/SL-M kept only with native protection); marketProtectionPct: for native protection.
 */
export function applyMarketPolicy(order, { policy, defaultPct, nativeProtection, ltp, tickSize }) {
  if (order.orderType !== "MARKET" && order.orderType !== "SL-M") return { order, checks: [], marketProtectionPct: null };
  if (policy === "reject") {
    return { order, checks: [block("INVALID_ORDER", `${order.orderType} orders are turned off (safety.marketOrders is "reject"). Send a LIMIT or SL order instead.`)], marketProtectionPct: null };
  }
  const pct = order.marketProtectionPct ?? defaultPct;
  if (nativeProtection) {
    return { order, checks: [warn("MARKET_PROTECTION", `Sent as ${order.orderType} with the broker's market protection of ${pct}%.`)], marketProtectionPct: pct };
  }
  const up = order.side === "BUY";
  if (order.orderType === "SL-M") {
    const trigger = order.triggerPrice;
    const price = up ? roundToTick(trigger * (1 + pct / 100), tickSize, "down") : roundToTick(trigger * (1 - pct / 100), tickSize, "up");
    const next = { ...order, orderType: "SL", price };
    delete next.marketProtectionPct;
    return { order: next, checks: [warn("MARKET_PROTECTION", `SL-M converted to SL with a limit of ${price} (trigger ${trigger} ${up ? "+" : "-"} ${pct}%) because this broker has no native market protection.`)], marketProtectionPct: null };
  }
  if (!(Number.isFinite(ltp) && ltp > 0)) {
    return { order, checks: [block("INVALID_ORDER", "A MARKET order needs the last traded price to set its protection, and none is available right now. Send a LIMIT order instead.")], marketProtectionPct: null };
  }
  const price = up ? roundToTick(ltp * (1 + pct / 100), tickSize, "down") : roundToTick(ltp * (1 - pct / 100), tickSize, "up");
  const next = { ...order, orderType: "LIMIT", price };
  delete next.marketProtectionPct;
  return { order: next, checks: [warn("MARKET_PROTECTION", `MARKET converted to LIMIT at ${price} (last price ${ltp} ${up ? "+" : "-"} ${pct}%) because this broker has no native market protection.`)], marketProtectionPct: null };
}

/** Problems in Check form: block checks only, deduplicated by code and message. */
export function blocking(checks) {
  const seen = new Set();
  return checks.filter((c) => {
    if (c.severity !== "block") return false;
    const k = `${c.code}\u0000${c.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Lower = reported first when an order is refused. */
const CODE_PRIORITY = Object.freeze({
  KILL_SWITCH_ACTIVE: 0,
  PAPER_ONLY: 1,
  SCOPE_REQUIRED: 1,
  CONFIRMATION_REQUIRED: 2,
  SESSION_EXPIRED: 3,
  CAPABILITY_UNSUPPORTED: 3,
  SYMBOL_NOT_FOUND: 3,
  INVALID_ORDER: 4,
  ORDER_RATE_LIMITED: 5,
  DAILY_LIMIT_REACHED: 5,
  MARKET_CLOSED: 5,
});

/** Block checks in the order they should be reported (stable). */
export function sortByPriority(checks) {
  return checks
    .map((c, i) => ({ c, i, p: CODE_PRIORITY[c.code] ?? 6 }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.c);
}
