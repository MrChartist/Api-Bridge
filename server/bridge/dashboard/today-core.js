// today-core.js: the Accounts page's "Today" column. Pure: positions, funds and orders in, figures out.

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const istDay = (ms) => new Date(ms + 19_800_000).toISOString().slice(0, 10);

/**
 * One account's day: { pnl (positions' P&L today, realised and open; null when no figure), open (open positions),
 * orders (placed today), filled, margin (used), free }.
 * @param {{ accountId: string, positions?: object[]|null, funds?: object|null, orders?: object[], nowMs: number }} x
 */
export function accountToday({ accountId, positions = null, funds = null, orders = [], nowMs }) {
  const ps = positions ?? [];
  const known = ps.filter((p) => num(p.pnl) !== null);
  const today = istDay(nowMs);
  const mine = (orders ?? []).filter((o) => o.accountId === accountId && istDay(Date.parse(o.placedAt ?? "")) === today);
  const f = funds?.funds ?? funds ?? null;
  return {
    pnl: positions === null ? null : known.length ? known.reduce((a, p) => a + Number(p.pnl), 0) : ps.length ? null : 0,
    open: ps.filter((p) => num(p.netQty)).length,
    orders: mine.length,
    filled: mine.filter((o) => o.status === "filled").length,
    margin: num(f?.usedMargin),
    free: num(f?.availableCash),
  };
}
