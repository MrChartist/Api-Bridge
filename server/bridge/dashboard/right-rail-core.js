// right-rail-core.js: the pure side of the right rail (right-rail.js). Which tools show and in what order, which one is
// open, how much room the rail and its panel take at a window width, the mini option chain's rows, the % move level,
// and the sector heatmap (grouping by sector and a squarified treemap). No DOM, no fetch, no clock: numbers in,
// plain objects out, so right-rail.test.mjs runs it in Node. Numbers become text in right-rail.js through format.js.
import { sectorOf } from "./sector-map.js";

// ── Tools and the rail's state ──

/** The rail's tools, in their default order. Customise is always last and cannot be hidden. */
export const RAIL_TOOLS = Object.freeze([
  Object.freeze({ id: "watchlist", label: "Watchlist", tint: "blue" }),
  Object.freeze({ id: "chain", label: "Option chain", tint: "indigo", key: "Shift+O" }),
  Object.freeze({ id: "depth", label: "Market depth", tint: "teal" }),
  Object.freeze({ id: "positions", label: "Positions", tint: "green" }),
  Object.freeze({ id: "alerts", label: "Super Alerts", tint: "orange" }),
  Object.freeze({ id: "heatmap", label: "Sector heatmap", tint: "pink" }),
]);
export const CUSTOMISE = Object.freeze({ id: "customise", label: "Customise", tint: "gray" });
const TOOL_IDS = RAIL_TOOLS.map((t) => t.id);
const ALL_IDS = [...TOOL_IDS, CUSTOMISE.id];
export const toolInfo = (id) => RAIL_TOOLS.find((t) => t.id === id) ?? (id === CUSTOMISE.id ? CUSTOMISE : null);

/** The state a fresh browser starts with: every tool shown, nothing open, the rail placed by the window width. */
export const RAIL_DEFAULTS = Object.freeze({ open: null, order: TOOL_IDS, hidden: Object.freeze([]), place: "auto" });

/**
 * A stored state (any shape, or a JSON string) made safe: unknown tools dropped, missing ones appended in the default
 * order, duplicates removed; `open` only when it names a shown tool (or Customise); `place` "auto" or "edge". Other
 * keys (a tool's own memory: the watchlist, the depth symbol) are kept as they are.
 */
export function normalizeRail(raw) {
  let r = raw;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      r = null;
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) r = {};
  const seen = new Set();
  const order = [];
  for (const id of Array.isArray(r.order) ? r.order : []) if (TOOL_IDS.includes(id) && !seen.has(id)) seen.add(id), order.push(id);
  for (const id of TOOL_IDS) if (!seen.has(id)) order.push(id);
  const hidden = TOOL_IDS.filter((id) => Array.isArray(r.hidden) && r.hidden.includes(id));
  const open = ALL_IDS.includes(r.open) && !hidden.includes(r.open) ? r.open : null;
  return { ...r, open, order, hidden, place: r.place === "edge" ? "edge" : "auto" };
}

/** The ids the rail draws, top to bottom: the shown tools in order, then Customise. */
export const visibleTools = (state) => [...state.order.filter((id) => !state.hidden.includes(id)), CUSTOMISE.id];

/** Open a tool, or close it when it is the one open (a tool that is hidden opens nothing). */
export function toggleTool(state, id) {
  if (!ALL_IDS.includes(id) || state.hidden.includes(id)) return { ...state, open: null };
  return { ...state, open: state.open === id ? null : id };
}

/** Move a tool up (-1) or down (+1) one place; at either end it stays put. */
export function moveTool(state, id, delta) {
  const i = state.order.indexOf(id);
  const j = i + Math.sign(delta);
  if (i < 0 || j < 0 || j >= state.order.length) return state;
  const order = [...state.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...state, order };
}

/** Show or hide a tool. Hiding the open tool closes the panel. */
export function setToolHidden(state, id, hidden) {
  if (!TOOL_IDS.includes(id)) return state;
  const set = new Set(state.hidden);
  if (hidden) set.add(id);
  else set.delete(id);
  return { ...state, hidden: TOOL_IDS.filter((t) => set.has(t)), open: hidden && state.open === id ? null : state.open };
}

/** What a stored state keeps (the open tool too, so the rail comes back as it was left). */
export const railToStore = (state) => JSON.stringify(state);

// ── Room on screen ──

/** The rail card's width and the panel's width (px); app.css draws them from the same numbers (--rr-card, --rr-panel-w). */
export const RAIL_CARD = 52;
export const PANEL_W = 360;
/** The page keeps at least this much beside a pushed panel (the chain's Core columns fit it), else the panel floats. */
export const PUSH_MIN_PAGE = 960;
/** The page keeps at least this much beside the full rail, else the rail folds to a thin edge (the chain at 1280 px). */
export const RAIL_MIN_PAGE = 1180;

/**
 * Where the rail and its panel go at a window width. `pageW` is the width the page has beside the sidebar.
 *  rail: "off" (phones and tablets: no rail), "edge" (a thin handle on the right edge; the rail shows over the page
 *        while it is used), "full" (the floating icon card, the page narrowed by its width).
 *  panel: null (closed), "push" (the page narrows beside it) or "overlay" (it floats over the page's right side).
 * @param {{ width: number, pageW?: number, open?: boolean, place?: "auto"|"edge", inset?: number }} o
 */
export function railLayout({ width, pageW = width, open = false, place = "auto", inset = 16 }) {
  if (!(width >= 1024)) return { rail: "off", panel: null };
  const railRoom = RAIL_CARD + inset;
  const rail = place !== "edge" && pageW - railRoom >= RAIL_MIN_PAGE ? "full" : "edge";
  if (!open) return { rail, panel: null };
  const push = rail === "full" && pageW - railRoom - (PANEL_W + inset) >= PUSH_MIN_PAGE;
  return { rail, panel: push ? "push" : "overlay" };
}

// ── Option chain (mini) ──

const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The ATM strike of a chain: its own atmStrike when listed, else the strike nearest the underlying's price. */
export function chainAtm(chain) {
  const rows = Array.isArray(chain?.rows) ? chain.rows : [];
  if (!rows.length) return null;
  const atm = num(chain.atmStrike);
  if (atm !== null && rows.some((r) => num(r.strike) === atm)) return atm;
  const spot = num(chain.underlyingLtp);
  if (spot === null) return num(rows[Math.floor(rows.length / 2)].strike);
  return rows.reduce((best, r) => (Math.abs(num(r.strike) - spot) < Math.abs(best - spot) ? num(r.strike) : best), num(rows[0].strike));
}

/**
 * The mini chain: `n` strikes either side of ATM, each with the call and put LTP, OI and OI as a share of the largest
 * OI shown (0..1, for the bars), and which side is in the money. Missing figures stay null.
 * @returns {{ atm: number|null, spot: number|null, rows: Array<{ strike: number, atm: boolean, ce: object|null, pe: object|null, ceItm: boolean, peItm: boolean }> }}
 */
export function miniChainRows(chain, n = 5) {
  const all = (Array.isArray(chain?.rows) ? chain.rows : []).filter((r) => num(r?.strike) !== null).sort((a, b) => num(a.strike) - num(b.strike));
  const atm = chainAtm({ ...chain, rows: all });
  const spot = num(chain?.underlyingLtp);
  if (atm === null) return { atm: null, spot, rows: [] };
  const i = all.findIndex((r) => num(r.strike) === atm);
  const pick = all.slice(Math.max(0, i - n), i + n + 1);
  const leg = (q) => (q ? { ltp: num(q.ltp), oi: num(q.oi), oiChange: num(q.oiChange), symbol: typeof q.symbol === "string" ? q.symbol : null } : null);
  const maxOi = Math.max(0, ...pick.flatMap((r) => [num(r.ce?.oi) ?? 0, num(r.pe?.oi) ?? 0]));
  const share = (v) => (v === null || maxOi <= 0 ? 0 : Math.min(1, Math.max(0, v / maxOi)));
  const rows = pick.map((r) => {
    const strike = num(r.strike);
    const ce = leg(r.ce);
    const pe = leg(r.pe);
    if (ce) ce.oiShare = share(ce.oi);
    if (pe) pe.oiShare = share(pe.oi);
    return { strike, atm: strike === atm, ce, pe, ceItm: spot !== null && strike < spot, peItm: spot !== null && strike > spot };
  });
  return { atm, spot, rows };
}

/**
 * A "% move" alert as a price level: the underlying's price `pct` percent away from `spot`, crossed upward for a rise
 * and downward for a fall. Null when the inputs are not usable (no spot, no move, a fall of 100 % or more).
 * @returns {{ level: number, op: "above"|"below" } | null}
 */
export function pctMoveLevel(spot, pct) {
  const s = num(spot);
  const p = num(pct);
  if (s === null || s <= 0 || p === null || p === 0 || p <= -100) return null;
  return { level: Math.round(s * (1 + p / 100) * 100) / 100, op: p > 0 ? "above" : "below" };
}

// ── Sector heatmap ──

/** Many mover lists (gainers, losers, turnover) as one list, each symbol once (its first appearance wins). */
export function mergeMovers(...lists) {
  const out = new Map();
  for (const list of lists) for (const it of Array.isArray(list) ? list : []) if (it && typeof it.symbol === "string" && !out.has(it.symbol)) out.set(it.symbol, it);
  return [...out.values()];
}

/** The diverging step (-3..3) a % change paints: any rise is green, any fall red; flat (exactly 0) is the neutral 0. */
export function heatStep(pct) {
  const p = num(pct);
  if (p === null) return null;
  if (p === 0) return 0;
  const a = Math.abs(p);
  const s = a < 1 ? 1 : a < 2.5 ? 2 : 3;
  return p > 0 ? s : -s;
}

/**
 * F&O stocks grouped by sector. Each stock's weight is its turnover (sizeBy "turnover"; a stock without one counts as
 * the smallest known turnover, so it still shows) or 1 (sizeBy "equal"). A sector's change is the weighted mean of its
 * stocks' changes (stocks without a change left out). Sectors largest first; stocks the same within a sector.
 * Symbols the sector list does not name go to "Other".
 * @param {Array<{ symbol: string, changePct?: number|null, turnover?: number|null, ltp?: number|null }>} items
 * @param {{ sizeBy?: "turnover"|"equal", sectorOf?: (symbol: string) => string|null }} [o]
 */
export function groupBySector(items, { sizeBy = "turnover", sectorOf: of = sectorOf } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.symbol === "string");
  const known = list.map((it) => num(it.turnover)).filter((v) => v !== null && v > 0);
  const floor = known.length ? Math.min(...known) : 1;
  const groups = new Map();
  for (const it of list) {
    const t = num(it.turnover);
    const weight = sizeBy === "equal" ? 1 : t !== null && t > 0 ? t : floor;
    const sector = of(it.symbol) ?? "Other";
    if (!groups.has(sector)) groups.set(sector, []);
    groups.get(sector).push({ symbol: it.symbol, ticker: it.symbol.split(":").pop(), sector, weight, changePct: num(it.changePct), ltp: num(it.ltp), turnover: t });
  }
  const out = [...groups.entries()].map(([sector, stocks]) => {
    stocks.sort((a, b) => b.weight - a.weight || (a.ticker < b.ticker ? -1 : 1));
    const weight = stocks.reduce((s, x) => s + x.weight, 0);
    const moved = stocks.filter((x) => x.changePct !== null);
    const w = moved.reduce((s, x) => s + x.weight, 0);
    const changePct = moved.length && w > 0 ? Math.round((moved.reduce((s, x) => s + x.changePct * x.weight, 0) / w) * 100) / 100 : null;
    const up = moved.filter((x) => x.changePct > 0).length;
    const down = moved.filter((x) => x.changePct < 0).length;
    return { sector, weight, changePct, up, down, stocks };
  });
  return out.sort((a, b) => b.weight - a.weight || (a.sector < b.sector ? -1 : 1));
}

/**
 * A squarified treemap (Bruls, Huizing and van Wijk): each item with a positive `weight` gets a rectangle inside
 * `rect`, areas in proportion to weight, laid out row by row so the rectangles stay as square as the weights allow.
 * Items come back largest first, each with x, y, w, h; items without a positive weight are left out.
 * @template {{ weight: number }} T
 * @param {T[]} items
 * @param {{ x?: number, y?: number, w: number, h: number }} rect
 * @returns {Array<T & { x: number, y: number, w: number, h: number }>}
 */
export function squarify(items, { x = 0, y = 0, w, h }) {
  const list = (Array.isArray(items) ? items : []).map((it) => ({ it, v: num(it?.weight) ?? 0 })).filter((d) => d.v > 0).sort((a, b) => b.v - a.v);
  const total = list.reduce((s, d) => s + d.v, 0);
  if (!list.length || !(w > 0) || !(h > 0) || total <= 0) return [];
  const scale = (w * h) / total;
  const areas = list.map((d) => d.v * scale);
  const out = [];
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  /** The worst aspect ratio of a row laid along a side of length `side`. */
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row, start) => {
    const s = row.reduce((a, b) => a + b, 0);
    if (rw >= rh) {
      // A column down the left of what is left.
      const cw = s / rh;
      let yy = ry;
      row.forEach((a, k) => {
        const hh = a / cw;
        out.push({ ...list[start + k].it, x: rx, y: yy, w: cw, h: hh });
        yy += hh;
      });
      rx += cw;
      rw -= cw;
    } else {
      // A row across the top of what is left.
      const rhh = s / rw;
      let xx = rx;
      row.forEach((a, k) => {
        const ww = a / rhh;
        out.push({ ...list[start + k].it, x: xx, y: ry, w: ww, h: rhh });
        xx += ww;
      });
      ry += rhh;
      rh -= rhh;
    }
  };
  let row = [];
  let start = 0;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(rw, rh);
    if (!row.length || worst([...row, areas[i]], side) <= worst(row, side)) {
      row.push(areas[i]);
      i += 1;
    } else {
      place(row, start);
      start += row.length;
      row = [];
    }
  }
  if (row.length) place(row, start);
  return out;
}

/**
 * The two-level heatmap: sectors as treemap blocks inside a w × h box, each block's stocks as tiles inside it (below a
 * `head` px label strip when the block is tall enough to spare it). A `gap` px gutter separates sector blocks.
 * @param {ReturnType<typeof groupBySector>} groups
 * @param {{ w: number, h: number, head?: number, gap?: number }} box
 */
export function heatmapLayout(groups, { w, h, head = 18, gap = 2 }) {
  const blocks = squarify(groups ?? [], { x: 0, y: 0, w, h });
  return blocks.map((b) => {
    const bx = b.x + gap / 2;
    const by = b.y + gap / 2;
    const bw = Math.max(0, b.w - gap);
    const bh = Math.max(0, b.h - gap);
    const labelled = bh >= head * 2.5 && bw >= 44;
    const top = labelled ? head : 0;
    const tiles = squarify(b.stocks, { x: bx, y: by + top, w: bw, h: Math.max(0, bh - top) });
    return { sector: b.sector, changePct: b.changePct, up: b.up, down: b.down, weight: b.weight, labelled, x: bx, y: by, w: bw, h: bh, tiles };
  });
}
