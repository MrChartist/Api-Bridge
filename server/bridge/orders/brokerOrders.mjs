/**
 * Live order payloads per broker.
 *
 * The broker contract fixes the adapter order SIGNATURES (placeOrder(creds, order, resolvedLotSize, gate),
 * modifyOrder(creds, orderId, changes, gate), cancelOrder(creds, orderId, gate)) but each adapter reads its own
 * field names from `order` and `changes` (Dhan: securityId/exchangeSegment/STOP_LOSS; Zerodha: tradingsymbol/
 * exchange; Upstox: instrumentKey). A wrong field name on a real-money call is the costliest bug there is, so live
 * orders are only wired for brokers whose adapter payload has been read and mapped here. Every other broker can
 * still trade in paper mode; a live order for it is refused with CAPABILITY_UNSUPPORTED before anything is sent.
 *
 * Each mapper was written from the adapter's own body builder (named in `source`) and is unit-tested against that
 * builder, so the two cannot drift silently. Add a broker only together with such a test.
 *
 * liveVerified: whether the mapping has been checked against a REAL account (not only fixtures). Unverified mappers
 * still work, but every live preview and place carries a SAFETY_WARNING saying so (OrderService), so nobody sends real
 * money through a fixture-only mapping without being told. Read from server/brokers/verification.json (isLiveVerified), the one record of who is verified.
 *
 * Quantities: the adapter computes units = lots × resolvedLotSize itself, so place() passes whole lots per leg and
 * the instrument master's lot size; modify() passes units, as each adapter's modify builder documents.
 */
import { BridgeError } from "../core/errors.mjs";
import { isLiveVerified } from "../../brokers/verification.mjs";

/**
 * @typedef {{ side: "BUY"|"SELL", orderType: "LIMIT"|"MARKET"|"SL"|"SL-M", product: string, validity?: "DAY"|"IOC",
 *   price?: number, triggerPrice?: number, disclosedQuantity?: number }} EffectiveOrder   after the market-order policy
 * @typedef {{ token: string, exchange: string, tradingSymbol: string | null }} BrokerRef
 * @typedef {{
 *   brokerId: string, source: string, nativeMarketProtection: boolean, disclosedQuantity: boolean, tag: boolean,
 *   liveVerified: boolean,
 *   unsupported(input: { exchange: string, ref: BrokerRef }): string | null,
 *   place(input: { order: EffectiveOrder, ref: BrokerRef, lots: number, tag: string | null, marketProtectionPct: number | null }): object,
 *   modify(input: { next: EffectiveOrder & { quantity: number }, marketProtectionPct: number | null }): object,
 * }} LiveOrderMapper
 */

const DHAN_SEGMENT = Object.freeze({ NSE: "NSE_EQ", BSE: "BSE_EQ", NFO: "NSE_FNO", BFO: "BSE_FNO", MCX: "MCX_COMM", CDS: "NSE_CURRENCY" });
const DHAN_ORDER_TYPE = Object.freeze({ LIMIT: "LIMIT", MARKET: "MARKET", SL: "STOP_LOSS", "SL-M": "STOP_LOSS_MARKET" });
const priced = (t) => t === "LIMIT" || t === "SL";
const triggered = (t) => t === "SL" || t === "SL-M";

/** @type {Record<string, LiveOrderMapper>} */
export const LIVE_ORDER_MAPPERS = Object.freeze({
  dhan: Object.freeze({
    brokerId: "dhan",
    liveVerified: isLiveVerified("dhan"),
    source: "server/lib/dhanOrders.mjs buildOrderBody, server/lib/dhanPortfolio.mjs buildModifyOrderBody",
    nativeMarketProtection: false,
    disclosedQuantity: false,
    tag: true,
    unsupported: ({ exchange }) => (DHAN_SEGMENT[exchange] ? null : `Dhan orders on ${exchange} are not wired in the Bridge.`),
    place: ({ order, ref, lots, tag }) => {
      const o = {
        transactionType: order.side,
        exchangeSegment: DHAN_SEGMENT[ref.exchange],
        productType: order.product,
        orderType: DHAN_ORDER_TYPE[order.orderType],
        validity: order.validity ?? "DAY",
        securityId: String(ref.token),
        lots,
      };
      if (priced(order.orderType)) o.price = order.price;
      if (triggered(order.orderType)) o.triggerPrice = order.triggerPrice;
      if (tag) o.correlationId = tag;
      return o;
    },
    // Dhan takes the full field set back on a modify, not a sparse patch.
    modify: ({ next }) => {
      const c = { orderType: DHAN_ORDER_TYPE[next.orderType], validity: next.validity ?? "DAY", quantity: next.quantity };
      if (priced(next.orderType)) c.price = next.price;
      if (triggered(next.orderType)) c.triggerPrice = next.triggerPrice;
      return c;
    },
  }),
  zerodha: Object.freeze({
    brokerId: "zerodha",
    liveVerified: isLiveVerified("zerodha"),
    source: "server/brokers/zerodhaOrders.mjs buildOrderBody / buildModifyBody",
    nativeMarketProtection: true,
    disclosedQuantity: false,
    tag: true,
    unsupported: ({ ref }) => (ref.tradingSymbol ? null : "The Zerodha trading symbol for this instrument is not known (instrument master not loaded)."),
    place: ({ order, ref, lots, tag, marketProtectionPct }) => {
      const o = {
        tradingsymbol: ref.tradingSymbol,
        exchange: ref.exchange,
        transactionType: order.side,
        orderType: order.orderType,
        product: order.product,
        validity: order.validity ?? "DAY",
        lots,
      };
      if (priced(order.orderType)) o.price = order.price;
      if (triggered(order.orderType)) o.triggerPrice = order.triggerPrice;
      if (tag) o.tag = tag;
      if (marketProtectionPct !== null && (order.orderType === "MARKET" || order.orderType === "SL-M")) o.marketProtection = marketProtectionPct;
      return o;
    },
    modify: ({ next, marketProtectionPct }) => {
      const c = { orderType: next.orderType, validity: next.validity ?? "DAY", quantity: next.quantity };
      if (priced(next.orderType)) c.price = next.price;
      if (triggered(next.orderType)) c.triggerPrice = next.triggerPrice;
      if (marketProtectionPct !== null && (next.orderType === "MARKET" || next.orderType === "SL-M")) c.marketProtection = marketProtectionPct;
      return c;
    },
  }),
  upstox: Object.freeze({
    brokerId: "upstox",
    liveVerified: isLiveVerified("upstox"),
    source: "server/brokers/upstoxOrders.mjs buildOrderBody / buildModifyBody",
    nativeMarketProtection: true,
    disclosedQuantity: false,
    tag: true,
    unsupported: ({ exchange, ref }) => {
      if (exchange === "MCX") return "MCX orders are not supported through the Upstox API.";
      return /^[A-Z_]+\|.+$/.test(String(ref.token ?? "")) ? null : "The Upstox instrument key for this instrument is not known (instrument master not loaded).";
    },
    place: ({ order, ref, lots, tag, marketProtectionPct }) => {
      const o = {
        instrumentKey: String(ref.token),
        transactionType: order.side,
        orderType: order.orderType,
        product: order.product,
        validity: order.validity ?? "DAY",
        lots,
      };
      if (priced(order.orderType)) o.price = order.price;
      if (triggered(order.orderType)) o.triggerPrice = order.triggerPrice;
      if (tag) o.tag = tag;
      if (marketProtectionPct !== null && (order.orderType === "MARKET" || order.orderType === "SL-M")) o.marketProtection = upstoxProtection(marketProtectionPct);
      return o;
    },
    modify: ({ next, marketProtectionPct }) => {
      const c = { orderType: next.orderType, validity: next.validity ?? "DAY", quantity: next.quantity };
      if (priced(next.orderType)) c.price = next.price;
      if (triggered(next.orderType)) c.triggerPrice = next.triggerPrice;
      if (marketProtectionPct !== null && (next.orderType === "MARKET" || next.orderType === "SL-M")) c.marketProtection = upstoxProtection(marketProtectionPct);
      return c;
    },
  }),
});

/** Upstox takes a whole percentage from 1 to 25. */
function upstoxProtection(pct) {
  return Math.min(25, Math.max(1, Math.round(pct)));
}

/** @returns {LiveOrderMapper | null} */
export function liveMapperFor(brokerId) {
  return Object.hasOwn(LIVE_ORDER_MAPPERS, brokerId) ? LIVE_ORDER_MAPPERS[brokerId] : null;
}

/**
 * The mapper for a live order on this broker, or a CAPABILITY_UNSUPPORTED refusal message.
 * @param {string} brokerId
 * @param {object} adapter  broker adapter module
 * @param {"placeOrder"|"modifyOrder"|"cancelOrder"} action
 * @returns {{ mapper: LiveOrderMapper | null, problem: string | null }}
 */
export function liveSupport(brokerId, adapter, action) {
  const mapper = liveMapperFor(brokerId);
  if (!mapper) return { mapper: null, problem: `Live orders for ${brokerId} are not wired in the Bridge yet; use paper mode. (Live orders are available for ${Object.keys(LIVE_ORDER_MAPPERS).join(", ")}.)` };
  if (!adapter || typeof adapter[action] !== "function") return { mapper: null, problem: `The ${brokerId} adapter has no ${action}.` };
  return { mapper, problem: null };
}

/**
 * The warning for a mapper that has only been tested against fixtures, or null.
 * @param {LiveOrderMapper | null} mapper
 */
export function unverifiedWarning(mapper) {
  if (!mapper || mapper.liveVerified) return null;
  return `Live orders for ${mapper.brokerId} have been tested against recorded broker responses only, not yet against a real account. Start with the smallest quantity and check the order in the broker app.`;
}

/** Throw CAPABILITY_UNSUPPORTED (used where a check list is not being built). */
export function assertLiveSupport(brokerId, adapter, action) {
  const s = liveSupport(brokerId, adapter, action);
  if (s.problem) throw new BridgeError("CAPABILITY_UNSUPPORTED", s.problem);
  return s.mapper;
}
