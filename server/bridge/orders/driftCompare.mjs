/**
 * Order-book drift: the pure comparison between what the Bridge recorded for an account's live orders and what the
 * broker's order book shows. It reads two lists and returns differences. It never calls anything and never changes
 * either side, so it cannot place, change or cancel an order (docs/guides/orders-drift.md).
 *
 * Differences (`kind`):
 *   closed_at_broker     the Bridge has the order open; the broker shows it complete, cancelled, rejected or expired
 *   missing_at_broker    the Bridge has the order open; the broker's book has no such order
 *   status_mismatch      both have the order, with different states (any other pair than the one above)
 *   quantity_mismatch    both have the order with the same state but a different quantity
 *   fill_mismatch        both have the order with the same state but a different filled quantity
 *   unknown_at_broker    an OPEN order at the broker that no Bridge order owns (placed in the broker app, or by another tool)
 *   outcome_unknown      the Bridge does not know whether it placed the order; `brokerMatches` shows what the broker has that fits
 *
 * A completed or cancelled order at the broker that the Bridge did not place is not a difference: it is counted
 * (`externalClosed`) so a person who also trades by hand is not nagged.
 */
import { findLegInBook } from "./reconcile.mjs";
import { bridgeStatus } from "./portfolio.mjs";

/** Bridge leg states that mean "still working at the broker". */
export const BRIDGE_OPEN = Object.freeze(new Set(["pending", "open", "trigger_pending", "partially_filled"]));
/** Broker order-book states that mean "still working". */
export const BROKER_OPEN = Object.freeze(new Set(["OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED"]));

export const DRIFT_KINDS = Object.freeze(["closed_at_broker", "missing_at_broker", "status_mismatch", "quantity_mismatch", "fill_mismatch", "unknown_at_broker", "outcome_unknown"]);

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
const words = (s) => String(s ?? "").toLowerCase().replaceAll("_", " ");
const rowSymbol = (row) => (row?.exchange && row?.tradingSymbol ? `${row.exchange}:${row.tradingSymbol}` : String(row?.tradingSymbol ?? row?.symbol ?? "") || null);

const brokerSide = (row) => ({
  status: row ? bridgeStatus(row.status) : null,
  brokerStatus: row?.status ?? null,
  quantity: num(row?.qty),
  filledQuantity: num(row?.filledQty),
});
const bridgeSide = (leg) => ({ status: leg.status, quantity: num(leg.quantity), filledQuantity: num(leg.filledQuantity) });
const what = (row) => [row?.side, rowSymbol(row)].filter(Boolean).join(" ");
const label = (leg) => `${leg.side ?? ""} ${leg.symbol ?? "order"}`.trim();

/**
 * @param {{ accountId: string, legs: object[], book: object[], knownBrokerIds?: Iterable<string> }} input
 *   legs: rows from OrderService.driftLegs (read before the book was read), book: contract Order rows,
 *   knownBrokerIds: broker order ids the Bridge learned of while the book was being read (never reported as unknown).
 * @returns {{ differences: object[], counts: { bridgeOpen: number, brokerOpen: number, externalClosed: number } }}
 */
export function compareOrderBook({ accountId, legs, book, knownBrokerIds = [] }) {
  const rows = (Array.isArray(book) ? book : []).filter((r) => r && r.orderId !== undefined && r.orderId !== null);
  const byId = new Map(rows.map((r) => [String(r.orderId), r]));
  const claimed = new Set([...knownBrokerIds].map(String));
  for (const l of legs) if (l.brokerOrderId) claimed.add(String(l.brokerOrderId));

  const differences = [];
  const add = (d) => differences.push({ accountId, ...d });
  const handled = new Set(); // broker rows explained by an unknown or in-flight leg

  for (const leg of legs) {
    if (leg.brokerOrderId) {
      const row = byId.get(String(leg.brokerOrderId));
      const open = BRIDGE_OPEN.has(leg.status);
      if (!row) {
        if (open) {
          add({
            kind: "missing_at_broker",
            orderId: leg.orderId,
            brokerOrderId: leg.brokerOrderId,
            symbol: leg.symbol,
            side: leg.side,
            bridge: bridgeSide(leg),
            broker: null,
            message: `The Bridge has ${label(leg)} (${leg.orderId}) as ${words(leg.status)}, but the broker's order book has no order ${leg.brokerOrderId}. Check the order in your broker app.`,
          });
        }
        continue;
      }
      const broker = brokerSide(row);
      const bridge = bridgeSide(leg);
      let statusDiffers = false;
      if (row.status !== "UNKNOWN" && leg.status !== broker.status) {
        statusDiffers = true;
        const closed = open && !BROKER_OPEN.has(row.status);
        add({
          kind: closed ? "closed_at_broker" : "status_mismatch",
          orderId: leg.orderId,
          brokerOrderId: leg.brokerOrderId,
          symbol: leg.symbol,
          side: leg.side,
          bridge,
          broker,
          message: closed
            ? `The Bridge still has ${label(leg)} (${leg.orderId}) as ${words(leg.status)}, but the broker shows it as ${words(broker.status)}. The Bridge's record is behind.`
            : `The Bridge has ${label(leg)} (${leg.orderId}) as ${words(leg.status)}; the broker shows ${words(broker.status)}.`,
        });
      }
      if (bridge.quantity !== null && broker.quantity !== null && bridge.quantity !== broker.quantity) {
        add({
          kind: "quantity_mismatch",
          orderId: leg.orderId,
          brokerOrderId: leg.brokerOrderId,
          symbol: leg.symbol,
          side: leg.side,
          bridge,
          broker,
          message: `The Bridge has ${label(leg)} (${leg.orderId}) for ${bridge.quantity}; the broker shows ${broker.quantity}.`,
        });
      } else if (!statusDiffers && bridge.filledQuantity !== null && broker.filledQuantity !== null && bridge.filledQuantity !== broker.filledQuantity) {
        add({
          kind: "fill_mismatch",
          orderId: leg.orderId,
          brokerOrderId: leg.brokerOrderId,
          symbol: leg.symbol,
          side: leg.side,
          bridge,
          broker,
          message: `The Bridge shows ${bridge.filledQuantity} of ${label(leg)} (${leg.orderId}) filled; the broker shows ${broker.filledQuantity}.`,
        });
      }
      continue;
    }

    // No broker order id yet: an unknown outcome, or a write still in flight. Look for what fits in the broker's book.
    const unknown = leg.status === "outcome_unknown";
    if (!unknown && leg.status !== "pending") continue;
    const matches = leg.ref && leg.sentAt
      ? rows.filter((r) => !claimed.has(String(r.orderId)) && findLegInBook({ ref: leg.ref, side: leg.side, quantity: leg.quantity, orderType: leg.orderType, price: leg.price, sentAt: leg.sentAt, tickSize: leg.tickSize }, [r], claimed).match)
      : [];
    for (const r of matches) handled.add(String(r.orderId));
    if (!unknown) continue; // in flight: its answer is still coming, nothing to report
    add({
      kind: "outcome_unknown",
      orderId: leg.orderId,
      brokerOrderId: null,
      symbol: leg.symbol,
      side: leg.side,
      bridge: bridgeSide(leg),
      broker: null,
      brokerMatches: matches.map((r) => ({ brokerOrderId: String(r.orderId), symbol: rowSymbol(r), side: r.side ?? null, price: num(r.price), placedAt: r.placedAt ?? null, ...brokerSide(r) })),
      message:
        matches.length === 0
          ? `The Bridge does not know whether ${label(leg)} (${leg.orderId}) was placed, and the broker's order book shows no order that fits it. Check your broker app before sending it again.`
          : matches.length === 1
            ? `The Bridge does not know whether ${label(leg)} (${leg.orderId}) was placed. The broker's book has one order that fits: ${matches[0].orderId}, ${words(brokerSide(matches[0]).status)}. It is matched by instrument, side, quantity and time, so confirm it in your broker app.`
            : `The Bridge does not know whether ${label(leg)} (${leg.orderId}) was placed, and ${matches.length} orders in the broker's book fit it, so it cannot tell which. Check your broker app.`,
    });
  }

  let externalClosed = 0;
  for (const r of rows) {
    const id = String(r.orderId);
    if (claimed.has(id) || handled.has(id)) continue;
    if (!BROKER_OPEN.has(r.status)) {
      externalClosed += 1;
      continue;
    }
    add({
      kind: "unknown_at_broker",
      orderId: null,
      brokerOrderId: id,
      symbol: rowSymbol(r),
      side: r.side ?? null,
      bridge: null,
      broker: brokerSide(r),
      message: `The broker has an open order ${id}${what(r) ? ` (${what(r)})` : ""} that the Bridge did not place. It was probably placed in your broker app or by another tool. The Bridge leaves it alone.`,
    });
  }

  return {
    differences,
    counts: {
      bridgeOpen: legs.filter((l) => BRIDGE_OPEN.has(l.status) || l.status === "outcome_unknown").length,
      brokerOpen: rows.filter((r) => BROKER_OPEN.has(r.status)).length,
      externalClosed,
    },
  };
}

/** A stable key for one difference, to tell new drift from drift already reported. */
export const differenceKey = (d) => [d.accountId, d.kind, d.orderId ?? "", d.brokerOrderId ?? "", d.bridge?.status ?? "", d.broker?.brokerStatus ?? "", d.bridge?.quantity ?? "", d.broker?.quantity ?? "", d.bridge?.filledQuantity ?? "", d.broker?.filledQuantity ?? ""].join("|");
