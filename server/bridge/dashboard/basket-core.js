// basket-core.js: the maths of sending a multi-leg basket (strategy-place.js draws and runs it). Pure: no DOM, no
// fetch. Freeze-quantity slicing, the send order (buys first for the margin benefit, or as listed), the body of the
// whole-basket margin read, and the progress of a run. BRD G4 and G8: slices are paced by the order sheet one at a
// time, so the account's order-rate cap applies as for any client; nothing here claims an atomic fill.

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Send orders a basket may use. */
export const SEND_ORDERS = Object.freeze(["buys-first", "as-listed"]);

/**
 * The most lots one order of this leg may carry: whole lots under the exchange freeze quantity, and under the
 * account's per-order limits from the safety config (maxLotsPerOrder, and maxOrderValue at the leg's price). The
 * smallest wins; `by` says which ("freeze", "lots" or "value"), null when nothing caps the leg. At least one lot: a
 * single lot above a limit is still one order, which the Bridge then refuses and says why. Limits are never raised
 * here, only obeyed.
 * @param {{ lotSize?: number, freezeQty?: number|null, price?: number|null }} leg
 * @param {{ maxLotsPerOrder?: number|null, maxOrderValue?: number|null }} [limits]
 * @returns {{ per: number|null, by: "freeze"|"lots"|"value"|null }}
 */
export function perOrderCap(leg, limits = {}) {
  const ls = num(leg?.lotSize) > 0 ? num(leg.lotSize) : 1;
  const caps = [];
  const fz = num(leg?.freezeQty);
  // Exchange freeze limits are "more than N is refused": a slice of exactly N units is allowed.
  if (fz > 0) caps.push(["freeze", Math.floor(fz / ls)]);
  const ml = num(limits?.maxLotsPerOrder);
  if (ml > 0) caps.push(["lots", Math.floor(ml)]);
  const mv = num(limits?.maxOrderValue);
  const px = num(leg?.price);
  // The Bridge checks value = price x quantity (the limit price for a limit order).
  if (mv > 0 && px > 0) caps.push(["value", Math.floor(mv / (px * ls))]);
  if (!caps.length) return { per: null, by: null };
  // Ties go to the first listed: the freeze, then the lots limit, then the value limit.
  const [by, per] = caps.reduce((a, c) => (c[1] < a[1] ? c : a));
  return { per: Math.max(1, per), by };
}

/**
 * Lots per slice for one leg: as many whole lots as fit under the freeze quantity (at least one lot). An order of
 * `lots` lots of `lotSize` is split into these (the last slice takes the rest). No freeze, or under it: one slice.
 * With `limits` (the account's per-order limits), a slice also fits maxLotsPerOrder and maxOrderValue at `price`.
 * @returns {number[]} lots per slice, in send order
 */
export function sliceLots(lots, lotSize, freezeQty, limits = null, price = null) {
  const L = Math.max(0, Math.round(num(lots) ?? 0));
  if (!L) return [];
  const { per } = perOrderCap({ lotSize, freezeQty, price }, limits ?? {});
  if (!per || L <= per) return [L];
  const out = [];
  for (let left = L; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

/**
 * Expand basket items into the rows that are sent: one row per slice. A row keeps its item's fields, with `lots` the
 * slice's lots, `slice` (1-based) and `slices` (count), `item` the item's index, the label suffixed " · 2/3", and
 * `slicedBy` (what set the slice size when the item was split: "freeze", "lots" or "value"). `limits` are the
 * account's per-order limits ({ maxLotsPerOrder, maxOrderValue }), or null when they are not known.
 */
export function expandSlices(items, limits = null) {
  const out = [];
  (items ?? []).forEach((it, item) => {
    const parts = sliceLots(it.lots, it.lotSize, it.freezeQty, limits, it.price);
    const slicedBy = parts.length > 1 ? perOrderCap(it, limits ?? {}).by : null;
    parts.forEach((lots, k) => out.push({ ...it, item, lots, slice: k + 1, slices: parts.length, slicedBy, label: parts.length > 1 ? `${it.label} · ${k + 1}/${parts.length}` : it.label }));
  });
  return out;
}

/**
 * One line per reason the basket was split, for the sheet: "Sliced to 10 lots per order: your per-order limit
 * (Safety)". Lines for the freeze say which legs. Empty when nothing was split.
 * @param {object[]} rows expandSlices() rows
 */
export function sliceNotes(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    if (!r.slicedBy || r.slice !== 1) continue;
    const per = r.lots;
    const k = `${r.slicedBy}|${per}`;
    if (!by.has(k)) by.set(k, { by: r.slicedBy, per, legs: [] });
    by.get(k).legs.push(String(r.label).replace(/ · \d+\/\d+$/, ""));
  }
  const lots = (n) => `${n} lot${n === 1 ? "" : "s"}`;
  return [...by.values()].map((x) =>
    x.by === "lots"
      ? `Sliced to ${lots(x.per)} per order: your per-order limit (Safety)`
      : x.by === "value"
        ? `Sliced to ${lots(x.per)} per order: your per-order value limit (Safety) at this price`
        : `Sliced to ${lots(x.per)} per order: the exchange freeze quantity (${x.legs.join(", ")})`,
  );
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
