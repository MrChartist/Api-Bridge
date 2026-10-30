// basket-core.js: the maths of sending a multi-leg basket (strategy-place.js draws and runs it). Pure: no DOM, no
// fetch. Freeze-quantity slicing, the send order (buys first for the margin benefit, or as listed), the body of the
// whole-basket margin read, and the progress of a run. BRD G4 and G8: slices are paced by the order sheet one at a
// time, so the account's order-rate cap applies as for any client; nothing here claims an atomic fill.

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Send orders a basket may use. */
export const SEND_ORDERS = Object.freeze(["buys-first", "as-listed"]);

/**
 * Lots per slice for one leg: as many whole lots as fit under the freeze quantity (at least one lot). An order of
 * `lots` lots of `lotSize` is split into these (the last slice takes the rest). No freeze, or under it: one slice.
 * @returns {number[]} lots per slice, in send order
 */
export function sliceLots(lots, lotSize, freezeQty) {
  const L = Math.max(0, Math.round(num(lots) ?? 0));
  const ls = num(lotSize) > 0 ? num(lotSize) : 1;
  const fz = num(freezeQty);
  if (!L) return [];
  if (!(fz > 0) || L * ls <= fz) return [L];
  // Exchange freeze limits are "more than N is refused": a slice of exactly N units is allowed.
  const per = Math.max(1, Math.floor(fz / ls));
  const out = [];
  for (let left = L; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

/**
 * Expand basket items into the rows that are sent: one row per slice. A row keeps its item's fields, with `lots` the
 * slice's lots, `slice` (1-based) and `slices` (count), `item` the item's index, and the label suffixed " · 2/3".
 */
export function expandSlices(items) {
  const out = [];
  (items ?? []).forEach((it, item) => {
    const parts = sliceLots(it.lots, it.lotSize, it.freezeQty);
    parts.forEach((lots, k) => out.push({ ...it, item, lots, slice: k + 1, slices: parts.length, label: parts.length > 1 ? `${it.label} · ${k + 1}/${parts.length}` : it.label }));
  });
  return out;
}

/**
 * Put rows in send order. "buys-first" (the default): every buy before any sell (a stable split), buys marked
 * phase "hedge" (each waited until filled) and sells "short", which is where the hedge benefit lowers the margin a sell
 * needs. "as-listed": the order given, nothing waited for. Exit baskets keep their own plan (shorts bought back first).
 */
export function orderRows(rows, order = "buys-first", { exit = false } = {}) {
  const list = [...(rows ?? [])];
  if (exit) return list;
  if (order === "as-listed") return list.map((r) => ({ ...r, phase: "listed" }));
  const buys = list.filter((r) => r.side === "BUY").map((r) => ({ ...r, phase: "hedge" }));
  const sells = list.filter((r) => r.side !== "BUY").map((r) => ({ ...r, phase: "short" }));
  return [...buys, ...sells];
}

/** The body of POST /v1/paper/accounts/{id}/margin for a basket (whole items, not slices), or null above 24 legs. */
export function basketMarginBody(items) {
  const legs = (items ?? [])
    .filter((it) => it.symbol && num(it.lots) > 0)
    .map((it) => {
      const l = { symbol: it.symbol, side: it.side === "SELL" ? "SELL" : "BUY", lots: Math.round(num(it.lots)) };
      if (num(it.price) > 0) l.price = num(it.price);
      return l;
    });
  if (!legs.length || legs.length > 24) return null;
  return { legs };
}

const DONE = new Set(["filled", "rejected", "cancelled", "expired", "skipped"]);
/**
 * Where a run stands: { total, filled, working (on the book), failed, waiting (not sent), done }. "Cancel remaining"
 * is offered while anything waits or works.
 */
export function basketProgress(rows) {
  const p = { total: 0, filled: 0, working: 0, failed: 0, waiting: 0, done: false };
  for (const r of rows ?? []) {
    p.total += 1;
    if (r.status === "filled") p.filled += 1;
    else if (r.status === "queued" || r.status === "sending") p.waiting += 1;
    else if (r.status === "open" || r.status === "partial" || r.status === "timeout" || r.status === "unknown") p.working += 1;
    else if (DONE.has(r.status)) p.failed += 1;
  }
  p.done = p.total > 0 && p.waiting === 0 && p.working === 0;
  return p;
}
