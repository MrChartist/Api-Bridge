// Estimated statutory charges on a fill and the totals the Trades tab shows (pure: no DOM, no fetch, no clock). The
// estimate covers futures and options on NSE and BSE with the dashboard's charge table (reference.js); equity fills are
// not priced. It is for the trader's own records: the broker's contract note is final.
import { refCharges } from "./reference.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const qtyOf = (t) => Math.abs(num(t.qty ?? t.quantity) ?? 0);
/** "YYYY-MM-DD" (IST) of an ISO time with an offset, or of epoch ms. */
export const istDayOf = (at) => new Date((typeof at === "number" ? at : Date.parse(at)) + 19_800_000).toISOString().slice(0, 10);

/** F&O contracts are futures and options; everything else is equity. */
export const isFno = (symbol) => /-(FUT|CE|PE)$/.test(String(symbol ?? ""));

const CHARGE_KEYS = Object.freeze(["brokerage", "stt", "txn", "sebi", "stamp", "gst"]);
const RATES = refCharges();

/** Statutory lines of one order: brokerage, STT (sells), exchange charge, SEBI fee, stamp duty (buys), GST. */
export function chargeLines(kind, side, turnover, exchange, rates = RATES) {
  const k = kind === "FUT" ? rates.fut : rates.opt;
  const brokerage = turnover > 0 ? num(rates.brokeragePerOrder) ?? 0 : 0;
  const stt = side === "SELL" ? turnover * k.sttSell : 0;
  const txn = turnover * (k.txn[exchange] ?? k.txn.NSE);
  const sebi = (turnover * rates.sebiPerCrore) / 1e7;
  const ipft = (turnover * (rates.ipftPerCrore ?? 0)) / 1e7;
  const stamp = side === "BUY" ? turnover * k.stampBuy : 0;
  const gst = (brokerage + txn + sebi + ipft) * rates.gst;
  return { brokerage, stt, txn, sebi, ipft, stamp, gst };
}

/**
 * The charges of one F&O fill: { brokerage, stt, txn, sebi, stamp, gst, total } in rupees (unrounded; the exchange
 * line includes the IPFT fee). Null for an equity fill or one without a price or quantity.
 */
export function fillCharges(t, rates = RATES) {
  const price = num(t?.price);
  const qty = qtyOf(t ?? {});
  if (!isFno(t?.symbol) || price === null || !qty) return null;
  const symbol = String(t.symbol);
  const c = chargeLines(/-FUT$/.test(symbol) ? "FUT" : "OPT", t.side, price * qty, /^BFO:/.test(symbol) ? "BSE" : "NSE", rates);
  const out = { brokerage: c.brokerage, stt: c.stt, txn: c.txn + c.ipft, sebi: c.sebi, stamp: c.stamp, gst: c.gst, total: 0 };
  out.total = CHARGE_KEYS.reduce((s, k) => s + out[k], 0);
  return out;
}

/** Fills in a period: count, bought and sold value and charges, the same sums the Trades tab shows. */
export function fillTotals(trades, { from = "0000-01-01", to = "9999-12-31", chargesOf = fillCharges } = {}) {
  const out = { count: 0, buyValue: 0, sellValue: 0, turnoverValue: 0, charges: Object.fromEntries([...CHARGE_KEYS, "total"].map((k) => [k, 0])), unpriced: 0 };
  for (const t of trades ?? []) {
    const day = istDayOf(t.tradedAt);
    if (day < from || day > to) continue;
    const v = qtyOf(t) * (num(t.price) ?? 0);
    out.count += 1;
    if (t.side === "BUY") out.buyValue += v;
    else out.sellValue += v;
    out.turnoverValue += v;
    const c = chargesOf(t);
    if (!c) out.unpriced += 1;
    else for (const k of [...CHARGE_KEYS, "total"]) out.charges[k] += c[k] ?? 0;
  }
  return out;
}
