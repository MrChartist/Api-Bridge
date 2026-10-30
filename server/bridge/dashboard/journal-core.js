// journal-core.js: the trade journal's maths (BRD I5), shared by the Bridge (server/bridge/journal) and the Journal tab
// (journal.js). Pure: no DOM, no fetch, no clock.
//
// Fills become trades by strategy group: every fill of one account on one underlying and expiry (the Positions page's
// groups) belongs to the trade that is open there; a trade opens when that group goes from flat to holding something
// and closes when every leg in it is flat again. A roll therefore closes one trade (the old expiry) and opens another
// (the new one). Equity fills group by symbol. P&L of a closed trade = sell value − buy value − charges.
import { detectStructure } from "./options.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const OPT_RE = /^([A-Z]+):([A-Z0-9&_.-]+?)-(\d{4}-\d{2}-\d{2})-(\d+(?:\.\d+)?)-(CE|PE)$/;
const FUT_RE = /^([A-Z]+):([A-Z0-9&_.-]+?)-(\d{4}-\d{2}-\d{2})-FUT$/;
const r2 = (v) => Math.round(v * 100) / 100;

/** A contract from its Bridge symbol: { underlying, expiry, kind: "OPT"|"FUT"|"EQ", strike, right, exchange }. */
export function parseContract(symbol) {
  const s = String(symbol ?? "");
  const o = OPT_RE.exec(s);
  if (o) return { exchange: o[1], underlying: o[2], expiry: o[3], kind: "OPT", strike: Number(o[4]), right: o[5] };
  const f = FUT_RE.exec(s);
  if (f) return { exchange: f[1], underlying: f[2], expiry: f[3], kind: "FUT", strike: null, right: null };
  const [ex, name] = s.includes(":") ? s.split(":") : ["", s];
  return { exchange: ex, underlying: name, expiry: null, kind: "EQ", strike: null, right: null };
}

/** A fill, normalised: { account, symbol, side, qty, price, charges, at (ms), tag, clientOrderId, mode, sample }. */
export function normFill(f) {
  const at = Date.parse(f?.tradedAt ?? f?.at ?? "");
  const qty = num(f?.qty) ?? num(f?.quantity) ?? 0;
  const price = num(f?.price) ?? num(f?.avgPrice);
  if (!f?.symbol || !(qty > 0) || price === null || !Number.isFinite(at) || (f.side !== "BUY" && f.side !== "SELL")) return null;
  return { account: f.accountId ?? f.account ?? "", symbol: f.symbol, side: f.side, qty, price, charges: num(f.charges) ?? 0, at, tag: f.tag ?? null, clientOrderId: f.clientOrderId ?? null, mode: f.mode ?? "paper", sample: Boolean(f.sample) };
}

/** The strategy group a fill belongs to. */
export function groupKeyOf(f) {
  const c = parseContract(f.symbol);
  return c.kind === "EQ" ? `${f.account}|${f.symbol}` : `${f.account}|${c.underlying}|${c.expiry}`;
}

/** A short stable id for a trade (FNV-1a of its group and first fill time, base 36): "t-…". */
export function tradeId(key, openedAt) {
  let h = 0x811c9dc5;
  const s = `${key}|${openedAt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t-${h.toString(36)}${Math.round(openedAt / 1000).toString(36)}`;
}

/**
 * Group fills into trades, newest first.
 * @param {object[]} fills  paper or broker trades (normFill shapes them)
 * @param {{ marks?: Record<string, number>, notes?: Record<string, { tags?: string[], notes?: string, setup?: string }> }} o
 *   marks: symbol → last price, for the open trades' unrealised P&L; notes: id → the person's tags, notes and setup.
 * @returns {object[]} { id, account, mode, underlying, expiry, kind, openedAt, closedAt, status, fills, legs, structure,
 *   buyValue, sellValue, charges, realised, unrealised, pnl, tags, notes, setup, sample }
 */
export function buildTrades(fills, { marks = {}, notes = {} } = {}) {
  const list = (fills ?? []).map(normFill).filter(Boolean).sort((a, b) => a.at - b.at || (a.side === b.side ? 0 : a.side === "BUY" ? -1 : 1));
  const open = new Map();
  const done = [];
  const finish = (t) => {
    const n = notes[t.id] ?? {};
    t.tags = Array.isArray(n.tags) ? n.tags : [];
    t.notes = typeof n.notes === "string" ? n.notes : "";
    t.setup = typeof n.setup === "string" ? n.setup : "";
    t.structure = t.peak.length ? detectStructure(t.peak).name : "Equity";
    delete t.net;
    delete t.peak;
    done.push(t);
  };
  for (const f of list) {
    const key = groupKeyOf(f);
    let t = open.get(key);
    if (!t) {
      const c = parseContract(f.symbol);
      t = { id: tradeId(key, f.at), key, account: f.account, mode: f.mode, underlying: c.underlying, expiry: c.expiry, kind: c.kind, openedAt: f.at, closedAt: null, status: "open", fills: 0, buyValue: 0, sellValue: 0, charges: 0, realised: null, unrealised: null, pnl: null, net: new Map(), peak: [], legs: [], sample: f.sample };
      open.set(key, t);
    }
    const sign = f.side === "BUY" ? 1 : -1;
    t.fills += 1;
    t.charges += f.charges;
    if (sign > 0) t.buyValue += f.qty * f.price;
    else t.sellValue += f.qty * f.price;
    t.net.set(f.symbol, (t.net.get(f.symbol) ?? 0) + sign * f.qty);
    const held = [...t.net.entries()].filter(([, q]) => q !== 0);
    if (held.length >= t.peak.length && held.length) {
      t.peak = held.map(([s, q]) => ({ ...parseContract(s), q }));
      t.legs = held.map(([s, q]) => ({ symbol: s, q }));
    }
    if (!held.length) {
      t.status = "closed";
      t.closedAt = f.at;
      t.realised = r2(t.sellValue - t.buyValue);
      t.unrealised = 0;
      t.pnl = r2(t.sellValue - t.buyValue - t.charges);
      open.delete(key);
      finish(t);
    }
  }
  for (const t of open.values()) {
    let value = 0;
    let priced = true;
    for (const [s, q] of t.net) {
      if (!q) continue;
      const m = num(marks[s]);
      if (m === null) priced = false;
      else value += q * m;
    }
    t.legs = [...t.net.entries()].filter(([, q]) => q).map(([s, q]) => ({ symbol: s, q }));
    t.realised = null;
    t.unrealised = priced ? r2(t.sellValue - t.buyValue + value) : null;
    t.pnl = priced ? r2(t.sellValue - t.buyValue + value - t.charges) : null;
    finish(t);
  }
  return done.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt) || b.openedAt - a.openedAt);
}

/** Largest fall of a running total from its high (≥ 0), over P&L figures in time order. */
export function maxDrawdown(pnls) {
  let run = 0;
  let high = 0;
  let dd = 0;
  for (const p of pnls ?? []) {
    run += num(p) ?? 0;
    high = Math.max(high, run);
    dd = Math.max(dd, high - run);
  }
  return dd;
}

/** One stats row over closed trades: n, wins, losses, winRate (%, null under 1 trade), avgWin, avgLoss, expectancy… */
export function statsOf(trades, key = "All") {
  const closed = (trades ?? []).filter((t) => t.status === "closed" && num(t.pnl) !== null).sort((a, b) => a.closedAt - b.closedAt);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const sum = (ls) => ls.reduce((a, t) => a + t.pnl, 0);
  const n = closed.length;
  const avgWin = wins.length ? sum(wins) / wins.length : null;
  const avgLoss = losses.length ? sum(losses) / losses.length : null;
  const winRate = n ? (wins.length / n) * 100 : null;
  return {
    key,
    n,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    // Expected P&L per trade from these trades: p(win) × average win + p(loss) × average loss (= total / n).
    expectancy: n ? sum(closed) / n : null,
    total: sum(closed),
    maxDrawdown: maxDrawdown(closed.map((t) => t.pnl)),
    best: n ? Math.max(...closed.map((t) => t.pnl)) : null,
    worst: n ? Math.min(...closed.map((t) => t.pnl)) : null,
  };
}

/**
 * Stats per tag, structure, underlying or setup (closed trades only), most trades first. A trade with several tags
 * counts under each; one with none under "Untagged" (or "No setup").
 */
export function tradeStats(trades, by = "structure") {
  const groups = new Map();
  const add = (k, t) => {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  };
  for (const t of trades ?? []) {
    if (t.status !== "closed") continue;
    if (by === "tag") (t.tags?.length ? t.tags : ["Untagged"]).forEach((g) => add(g, t));
    else if (by === "setup") add(t.setup?.trim() || "No setup", t);
    else if (by === "underlying") add(t.underlying, t);
    else add(t.structure, t);
  }
  return [...groups.entries()].map(([k, ls]) => statsOf(ls, k)).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/** Daily rows of several accounts summed per day: [{ day, pnl, accounts }], oldest first. */
export function mergeDaily(lists) {
  const by = new Map();
  for (const rows of lists ?? []) {
    for (const r of rows ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r?.day)) || num(r.pnl) === null) continue;
      const e = by.get(r.day) ?? { day: r.day, pnl: 0, accounts: 0 };
      e.pnl += num(r.pnl);
      e.accounts += 1;
      by.set(r.day, e);
    }
  }
  return [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

const DAY_MS = 86_400_000;
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
/**
 * A month of daily P&L as calendar weeks, Monday first: { month: "YYYY-MM", weeks: [[{ day, inMonth, pnl|null }]],
 * total, days (with a row), green, red, best, worst, scale (the largest |pnl|, for the colour) }.
 */
export function monthGrid(daily, month) {
  const by = new Map((daily ?? []).map((r) => [r.day, num(r.pnl)]));
  const [y, m] = String(month).split("-").map(Number);
  const first = Date.UTC(y, m - 1, 1);
  const dow = (new Date(first).getUTCDay() + 6) % 7; // Monday 0
  const start = first - dow * DAY_MS;
  const weeks = [];
  let total = 0;
  let days = 0;
  let green = 0;
  let red = 0;
  let best = null;
  let worst = null;
  let scale = 0;
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      const ms = start + (w * 7 + d) * DAY_MS;
      const day = isoOf(ms);
      const inMonth = new Date(ms).getUTCMonth() === m - 1;
      const pnl = inMonth && by.has(day) ? by.get(day) : null;
      if (pnl !== null) {
        total += pnl;
        days += 1;
        if (pnl > 0) green += 1;
        else if (pnl < 0) red += 1;
        best = best === null ? pnl : Math.max(best, pnl);
        worst = worst === null ? pnl : Math.min(worst, pnl);
        scale = Math.max(scale, Math.abs(pnl));
      }
      row.push({ day, inMonth, pnl });
    }
    if (row.some((c) => c.inMonth)) weeks.push(row);
  }
  return { month: `${y}-${String(m).padStart(2, "0")}`, weeks, total, days, green, red, best, worst, scale };
}

/** The month before or after "YYYY-MM". */
export function shiftMonth(month, by) {
  const [y, m] = String(month).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A CSV cell: quoted when needed; text that a spreadsheet would run as a formula starts with an apostrophe. */
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const isoTime = (ms) => (Number.isFinite(ms) ? new Date(ms + 19_800_000).toISOString().replace("T", " ").slice(0, 16) : "");
export const JOURNAL_CSV_COLUMNS = Object.freeze(["Opened (IST)", "Closed (IST)", "Account", "Mode", "Underlying", "Expiry", "Structure", "Status", "Legs", "Fills", "Paid", "Received", "Charges", "Net P&L", "Tags", "Setup", "Notes"]);
/** The journal as CSV (one row per trade, newest first), with a header row. */
export function journalCsv(trades) {
  const lines = [JOURNAL_CSV_COLUMNS.map(csvCell).join(",")];
  for (const t of trades ?? []) {
    lines.push(
      [
        isoTime(t.openedAt),
        isoTime(t.closedAt),
        t.account,
        t.sample ? "sample" : t.mode,
        t.underlying,
        t.expiry ?? "",
        t.structure,
        t.status,
        (t.legs ?? []).map((l) => `${l.q > 0 ? "+" : ""}${l.q} ${l.symbol}`).join(" | "),
        t.fills,
        t.buyValue,
        t.sellValue,
        t.charges,
        t.pnl,
        (t.tags ?? []).join("; "),
        t.setup ?? "",
        t.notes ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Clean a person's tags: trimmed, at most 24 characters each, no duplicates (case-insensitive), at most 12. */
export function cleanTags(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : String(tags ?? "").split(",")) {
    const s = String(t).trim().replace(/\s+/g, " ").slice(0, 24);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, 12);
}
