/**
 * Portfolio and order-book row mapping.
 *
 * Broker adapters return contract rows (server/brokers/contract.mjs: Position, Holding, Funds, Order, Trade) with
 * broker instrument references. These helpers turn them into the OpenAPI shapes with canonical symbols (through
 * SymbolService.fromBroker; when a row cannot be mapped the symbol falls back to "EXCHANGE:tradingSymbol" and the
 * row carries `symbolResolved: false`). Portfolio reads are never cached: every call is a fresh broker read.
 */
import { CONTRACT_STATUS_MAP } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const num0 = (v) => num(v) ?? 0;

/**
 * Unwrap an adapter read result `{ status: "success", data }`.
 * @param {any} result
 * @param {string} what  for the message
 */
export function unwrap(result, what) {
  if (result && result.status === "success" && result.data !== undefined) return result.data;
  const message = typeof result?.message === "string" ? result.message.slice(0, 200) : `The broker did not return ${what}.`;
  throw new BridgeError("UPSTREAM_ERROR", message);
}

/**
 * Canonical symbol for a broker row, or a readable fallback.
 * @param {{ fromBroker: Function }} symbols
 * @param {string} broker
 * @param {{ token?: string, exchange?: string, tradingSymbol?: string }} row
 * @returns {Promise<{ symbol: string, resolved: boolean }>}
 */
export async function symbolFor(symbols, broker, row) {
  try {
    if (row?.token && row?.exchange) {
      const s = await symbols.fromBroker(broker, { token: String(row.token), exchange: row.exchange });
      if (s) return { symbol: s, resolved: true };
    }
  } catch {
    /* fall back below */
  }
  const ts = String(row?.tradingSymbol ?? row?.token ?? "UNKNOWN");
  return { symbol: `${row?.exchange ?? "NSE"}:${ts}`.slice(0, 64), resolved: false };
}

/** Map rows with a per-row async symbol lookup (bounded fan-out, order kept). */
export async function mapRows(rows, fn, concurrency = 16) {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const k = i++;
      out[k] = await fn(list[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}

/** OpenAPI Position. */
export function toPosition(row, { symbol, resolved }) {
  const p = {
    symbol,
    product: row.product ?? "INTRADAY",
    netQty: num0(row.netQty),
    avgPrice: num0(row.avgPrice),
    ltp: num(row.ltp),
    pnl: num0(row.pnl),
    realisedPnl: num(row.realisedPnl),
    unrealisedPnl: num(row.unrealisedPnl),
  };
  if (!resolved) p.symbolResolved = false;
  return p;
}

/** OpenAPI Holding. */
export function toHolding(row, { symbol, resolved }) {
  const h = { symbol, isin: row.isin ?? null, qty: num0(row.qty), avgPrice: num0(row.avgPrice), ltp: num(row.ltp), pnl: num(row.pnl) };
  if (!resolved) h.symbolResolved = false;
  return h;
}

/** OpenAPI Funds. */
export function toFunds(data) {
  return {
    availableCash: num0(data?.availableCash),
    usedMargin: num0(data?.usedMargin),
    totalBalance: num(data?.totalBalance),
    collateral: num(data?.collateral),
    withdrawable: num(data?.withdrawable),
    realisedPnl: num(data?.realisedPnl),
    unrealisedPnl: num(data?.unrealisedPnl),
  };
}

/** OpenAPI Trade from a broker trade-book row. `orderId` is the Bridge id when the order was placed by the Bridge. */
export function toTrade(row, { symbol, resolved }, { accountId, orderId }) {
  const t = {
    tradeId: String(row.tradeId ?? ""),
    orderId: orderId ?? String(row.orderId ?? ""),
    accountId,
    mode: "live",
    symbol,
    side: row.side === "SELL" ? "SELL" : "BUY",
    qty: num0(row.qty),
    price: num0(row.price),
    tradedAt: row.tradedAt ?? null,
  };
  if (!resolved) t.symbolResolved = false;
  if (orderId && row.orderId && orderId !== row.orderId) t.brokerOrderId = String(row.orderId);
  return t;
}

/** Contract order-book status -> Bridge OrderStatus. */
export function bridgeStatus(contractStatus) {
  return CONTRACT_STATUS_MAP[contractStatus] ?? "pending";
}
