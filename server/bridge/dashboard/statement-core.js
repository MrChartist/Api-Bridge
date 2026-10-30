// Statement: realised P&L by FIFO, F&O turnover, itemised charges and a day-by-day ledger, from the Bridge's fills
// (pure: no DOM, no fetch, no clock). An estimate for the trader's own records, not tax advice: the broker's tax P&L
// and contract notes are final, and a CA confirms how it is filed. Tax payable is never computed here.

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const qtyOf = (t) => Math.abs(num(t.qty ?? t.quantity) ?? 0);
/** "YYYY-MM-DD" (IST) of an ISO time with an offset, or of epoch ms. */
export const istDayOf = (at) => new Date((typeof at === "number" ? at : Date.parse(at)) + 19_800_000).toISOString().slice(0, 10);

/** F&O contracts are futures and options; everything else is equity. */
export const isFno = (symbol) => /-(FUT|CE|PE)$/.test(String(symbol ?? ""));

/**
 * Where a closed trade's P&L is usually reported (Indian practice; a CA confirms): F&O as non-speculative business
 * income; equity bought and sold the same day (intraday) as speculative business income; equity delivery as capital
 * gains, short term up to 12 months held and long term after.
 */
export const SEGMENTS = Object.freeze([
  ["fno", "F&O", "Non-speculative business income"],
  ["intraday", "Equity intraday", "Speculative business income"],
  ["stcg", "Equity delivery, held 12 months or less", "Short-term capital gain (STCG)"],
  ["ltcg", "Equity delivery, held over 12 months", "Long-term capital gain (LTCG)"],
]);

function segmentOf(symbol, product, openedAt, closedAt) {
  if (isFno(symbol)) return "fno";
  if (product === "INTRADAY" || istDayOf(openedAt) === istDayOf(closedAt)) return "intraday";
  const held = Date.parse(closedAt) - Date.parse(openedAt);
  return held > 365 * 86_400_000 ? "ltcg" : "stcg";
}

/**
 * Realised P&L, first in first out, per symbol and product. Each closing fill becomes one closed trade:
 * { day, at, openedAt, symbol, product, segment, qty, side ("long" | "short"), entry, exit, pnl }. What is still open is
 * left in `open` as { symbol, product, qty (signed), avg }.
 * @param {object[]} trades GET /v1/trades rows (any order)
 */
export function fifoRealised(trades) {
  const sorted = [...(trades ?? [])].filter((t) => qtyOf(t) > 0 && num(t.price) !== null).sort((a, b) => Date.parse(a.tradedAt) - Date.parse(b.tradedAt));
  const books = new Map();
  const closed = [];
  for (const t of sorted) {
    const key = `${t.symbol}|${t.product ?? ""}`;
    const lots = books.get(key) ?? [];
    books.set(key, lots);
    const dir = t.side === "BUY" ? 1 : -1;
    let left = qtyOf(t);
    const price = num(t.price);
    while (left > 0 && lots.length && Math.sign(lots[0].qty) === -dir) {
      const lot = lots[0];
      const take = Math.min(left, Math.abs(lot.qty));
      const long = lot.qty > 0;
      const pnl = (long ? price - lot.price : lot.price - price) * take;
      closed.push({ day: istDayOf(t.tradedAt), at: t.tradedAt, openedAt: lot.at, symbol: t.symbol, product: t.product ?? null, segment: segmentOf(t.symbol, t.product, lot.at, t.tradedAt), qty: take, side: long ? "long" : "short", entry: lot.price, exit: price, pnl });
      lot.qty -= Math.sign(lot.qty) * take;
      left -= take;
      if (lot.qty === 0) lots.shift();
    }
    if (left > 0) lots.push({ qty: dir * left, price, at: t.tradedAt });
  }
  const open = [];
  for (const [key, lots] of books) {
    const q = lots.reduce((s, l) => s + l.qty, 0);
    if (!q) continue;
    const [symbol, product] = key.split("|");
    open.push({ symbol, product: product || null, qty: q, avg: lots.reduce((s, l) => s + Math.abs(l.qty) * l.price, 0) / Math.abs(q) });
  }
  return { closed, open };
}

/** The Indian financial year (1 April to 31 March) that contains an IST day: { from, to, label: "FY 2026-27" }. */
export function financialYear(day) {
  const y = Number(day.slice(0, 4));
  const start = day.slice(5) >= "04-01" ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `FY ${start}-${String(start + 1).slice(2)}` };
}

/** One fill as a ticket leg, for the charges model (options.js charges): the whole fill in one "lot". */
export function fillLeg(t) {
  return { kind: /-FUT$/.test(String(t.symbol)) ? "FUT" : "OPT", side: t.side, price: num(t.price), lots: 1, lotSize: qtyOf(t), symbol: t.symbol };
}

const CHARGE_KEYS = Object.freeze(["brokerage", "stt", "txn", "sebi", "stamp", "gst"]);
export const CHARGE_LABELS = Object.freeze({ brokerage: "Brokerage", stt: "STT", txn: "Exchange", sebi: "SEBI", stamp: "Stamp duty", gst: "GST" });

/**
 * The charges of one F&O fill from the ticket's model: `chargesFn` is options.js `charges`, `rates` the reference
 * table's (reference.js refCharges). Equity fills are not priced (null): the model covers futures and options.
 */
export function fillChargesWith(chargesFn, rates) {
  return (t) => {
    if (!isFno(t.symbol) || num(t.price) === null || !qtyOf(t)) return null;
    const c = chargesFn([fillLeg(t)], rates, { lotSize: qtyOf(t) });
    const out = { total: 0 };
    for (const k of CHARGE_KEYS) out[k] = Number(c?.[k] ?? 0) + (k === "txn" ? Number(c?.ipft ?? 0) : 0);
    out.total = CHARGE_KEYS.reduce((s, k) => s + out[k], 0);
    return out;
  };
}

/** Fills in a period: count, bought and sold value and charges, the same sums the Trades tab shows. */
export function fillTotals(trades, { from = "0000-01-01", to = "9999-12-31", chargesOf = () => null } = {}) {
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

/**
 * The statement for a period: realised P&L by segment, F&O turnover by the ICAI guidance note's method (the sum of the
 * absolute profit or loss of each settled trade; for options that settled difference includes the premium), charges
 * itemised, the net, and (paper) a ledger by day from the opening cash.
 * @param {object[]} trades all fills (fills before `from` are needed for FIFO; only closes inside the period count)
 * @param {{ from?: string, to?: string, chargesOf?: (t: object) => object | null, opening?: number | null }} [o]
 */
export function statement(trades, { from = "0000-01-01", to = "9999-12-31", chargesOf = () => null, opening = null } = {}) {
  const inside = (day) => day >= from && day <= to;
  const { closed, open } = fifoRealised(trades);
  const rows = closed.filter((c) => inside(c.day));
  const segments = Object.fromEntries(SEGMENTS.map(([k]) => [k, { realised: 0, turnover: 0, trades: 0, wins: 0 }]));
  for (const c of rows) {
    const s = segments[c.segment];
    s.realised += c.pnl;
    s.turnover += Math.abs(c.pnl);
    s.trades += 1;
    if (c.pnl > 0) s.wins += 1;
  }
  const fills = fillTotals(trades, { from, to, chargesOf });
  const dayCharges = new Map();
  for (const t of trades ?? []) {
    const day = istDayOf(t.tradedAt);
    if (!inside(day)) continue;
    dayCharges.set(day, (dayCharges.get(day) ?? 0) + (chargesOf(t)?.total ?? 0));
  }
  const days = [...new Set([...rows.map((c) => c.day), ...dayCharges.keys()])].sort();
  let balance = num(opening);
  const ledger = days.map((day) => {
    const realised = rows.filter((c) => c.day === day).reduce((s, c) => s + c.pnl, 0);
    const ch = dayCharges.get(day) ?? 0;
    const start = balance;
    if (balance !== null) balance += realised - ch;
    return { day, opening: start, realised, charges: ch, net: realised - ch, closing: balance };
  });
  const realised = rows.reduce((s, c) => s + c.pnl, 0);
  return { closed: rows, open, segments, realised, turnover: segments.fno.turnover, fills, charges: fills.charges, net: realised - fills.charges.total, ledger };
}

/** Realised P&L by financial year and segment, across every closed trade: [{ fy, label, segments: { fno: n, ... } }]. */
export function byFinancialYear(trades) {
  const out = new Map();
  for (const c of fifoRealised(trades).closed) {
    const fy = financialYear(c.day);
    const row = out.get(fy.label) ?? { fy: fy.from, label: fy.label, segments: Object.fromEntries(SEGMENTS.map(([k]) => [k, 0])) };
    row.segments[c.segment] += c.pnl;
    out.set(fy.label, row);
  }
  return [...out.values()].sort((a, b) => b.fy.localeCompare(a.fy));
}
