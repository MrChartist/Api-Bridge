// today-core.js: the figures behind "today" — the Accounts page's Today column and Home, the trader's cockpit.
// Pure: positions, funds, orders, chains and the reference bundle in, figures and words out. No DOM, no fetch, no
// clock (callers pass `nowMs`). today-core.test.mjs checks every export.
import { atmRow, chainSummary, maxPainCurve, oiWalls, rowsAroundAtm } from "./options.js";
import { straddleLevels } from "./vol-suite-core.js";
import { formatInt, formatSignedRupee } from "./format.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const IST_MS = 19_800_000;
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMins = (ms) => {
  const d = new Date(ms + IST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
};
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DAY_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const HM = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "Mon, 2 Nov" for "2026-11-02" (Intl writes "Mon 2 Nov" or "Mon, 2 Nov" by engine; one comma-free form). */
export const dayText = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "") ? DAY_FMT.format(new Date(`${iso}T00:00:00Z`)).replace(",", "") : "");
/** "09:15" → 555 (minutes after IST midnight); null when not a time. */
const hm = (s) => (/^\d{2}:\d{2}$/.test(String(s ?? "")) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);

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

// ── Home: the market clock ──

/** "1h 20m" from 80 minutes, "20m" under an hour, "under 1m" below a minute. */
export function durationText(mins) {
  const m = num(mins);
  if (m === null || m < 0) return "";
  if (m < 1) return "under 1m";
  const whole = Math.floor(m);
  const hrs = Math.floor(whole / 60);
  return hrs ? `${formatInt(hrs)}h ${formatInt(whole % 60)}m` : `${formatInt(whole)}m`;
}

/** The first trading day after `iso` (weekends and the listed holidays skipped; 14 days at most). */
export function nextTradingDay(iso, holidays = []) {
  const off = new Set((holidays ?? []).map((x) => x?.date).filter(Boolean));
  let d = iso;
  for (let i = 0; i < 14; i++) {
    d = addDays(d, 1);
    const w = dowOf(d);
    if (w >= 1 && w <= 5 && !off.has(d)) return d;
  }
  return null;
}

/**
 * Where the F&O session stands now, from the reference bundle's session times and holiday list: { phase ("open" |
 * "pre" | "closed"), hero ("Open" | "Closed"), sub (the next thing that happens, in words), elapsed (0–1, the share of
 * today's session gone: 1 once it closed, 0 before the open and on days without a session), minsLeft (open only),
 * holiday (today's holiday label or null), next (closed only: the next trading day, "YYYY-MM-DD") }. Before the open it still says Closed: the figures are the last close.
 */
export function marketClock({ nowMs, session = null, holidays = [] }) {
  const open = hm(session?.open) ?? 555;
  const close = hm(session?.close) ?? 930;
  const today = istDay(nowMs);
  const mins = istMins(nowMs);
  const w = dowOf(today);
  const hol = (holidays ?? []).find((x) => x?.date === today) ?? null;
  const trading = w >= 1 && w <= 5 && !hol;
  const at = `${session?.open ?? "09:15"} IST`;
  if (trading && mins >= open && mins < close) {
    const left = close - mins;
    return { phase: "open", hero: "Open", sub: `${durationText(left)} to close · closes ${session?.close ?? "15:30"} IST`, elapsed: (mins - open) / (close - open), minsLeft: left, holiday: null };
  }
  if (trading && mins < open) return { phase: "pre", hero: "Closed", sub: `Opens today at ${at} · in ${durationText(open - mins)}`, elapsed: 0, minsLeft: null, holiday: null };
  const next = nextTradingDay(today, holidays);
  const why = hol ? `${hol.label} · ` : w === 0 || w === 6 ? "Weekend · " : "";
  return { phase: "closed", hero: "Closed", sub: `${why}opens ${next ? dayText(next) : "next trading day"}, ${at}`, elapsed: trading ? 1 : 0, minsLeft: null, holiday: hol?.label ?? null, next };
}

/**
 * How current a reading is: while the session runs, up to 90 s old is Live, up to 10 minutes Delayed, older Stale;
 * outside it the last close is the current reading, so "Closing data" and its time. { state, text }.
 */
export function dataLine({ phase, asOfMs, nowMs }) {
  const t = num(asOfMs);
  if (t === null) return { state: "none", text: "Time not reported" };
  const when = HM.format(new Date(t));
  if (phase !== "open") return { state: "closing", text: `Closing data · ${DAY_MONTH.format(new Date(t + IST_MS))}, ${when} IST` };
  const age = Math.max(0, (nowMs - t) / 1000);
  if (age <= 90) return { state: "live", text: `Live · ${when} IST` };
  const old = `${durationText(age / 60)} old`;
  return age <= 600 ? { state: "delayed", text: `Delayed · ${old} · ${when} IST` } : { state: "stale", text: `Stale · ${old} · ${when} IST` };
}

// ── Home: key option levels for one underlying ──

/** Strikes either side of the ATM strike that the walls read (the Option Chain and OI pages use the same window). */
export const WALL_WINDOW = 7;

/**
 * The levels a trader reads off one expiry's chain: spot, the ATM straddle and the expected move (0.85 × straddle,
 * a pricing convention), the Call wall (most Call OI at or above spot) and Put wall (most Put OI at or below it)
 * within the ATM strike ± 7 listed strikes, max pain, PCR over the rows read (with that scope), ATM IV, and the gamma
 * flip when the exposure model gave one. Every figure the chain cannot back is null.
 * @param {object} chain GET /v1/optionchain data
 * @param {{ flip?: number|null }} [opts]
 */
export function keyLevels(chain, { flip = null } = {}) {
  const rows = chain?.rows ?? [];
  const sm = chainSummary(chain);
  const spot = sm.spot;
  const atm = atmRow(chain);
  const win = rowsAroundAtm(chain, WALL_WINDOW);
  const wall = (side) => {
    const w = oiWalls(win, side, spot, { top: 1 })[0];
    return w ? { strike: w.strike, oi: w.oi, dist: w.dist } : null;
  };
  const mp = maxPainCurve(rows, spot);
  const lv = straddleLevels({ premium: sm.straddle, strike: sm.atm, spot });
  const f = num(flip);
  return {
    spot,
    atm: sm.atm,
    ceLtp: num(atm?.ce?.ltp),
    peLtp: num(atm?.pe?.ltp),
    straddle: sm.straddle,
    move: lv?.expectedMove ?? null,
    movePct: lv?.movePct ?? null,
    rangeLo: lv?.rangeLo ?? null,
    rangeHi: lv?.rangeHi ?? null,
    callWall: wall("ce"),
    putWall: wall("pe"),
    maxPain: mp ? { strike: mp.strike, dist: spot === null ? null : mp.strike - spot } : null,
    pcr: sm.pcr,
    pcrStrikes: rows.filter((r) => num(r.ce?.oi) !== null || num(r.pe?.oi) !== null).length,
    atmIv: sm.atmIv,
    flip: f === null ? null : { price: f, dist: spot === null ? null : f - spot },
    lot: num(chain?.lotSize),
  };
}

/** The level names, by kind, as the cockpit prints them. */
export const LEVEL_NAMES = Object.freeze({ ce: "Call wall", pe: "Put wall", mp: "Max pain", gx: "Gamma flip", lo: "Move low", hi: "Move high", spot: "Spot" });

/**
 * keyLevels on one price axis, for a ruler: { lo, hi, x(price) → 0–1, marks: [{ price, x, kinds, tags }], band:
 * { x0, x1 } | null (the expected-move range), spot: { price, x }, off: [names left off] }. Levels at one price share a mark (two
 * sources agreeing is the point); spot is always a mark of its own. Null without a spot.
 */
export function levelAxis(lv) {
  const spot = num(lv?.spot);
  if (spot === null) return null;
  const items = [
    ["ce", lv.callWall?.strike],
    ["pe", lv.putWall?.strike],
    ["mp", lv.maxPain?.strike],
    ["gx", lv.flip?.price],
    ["lo", lv.rangeLo],
    ["hi", lv.rangeHi],
  ].filter(([, p]) => num(p) !== null);
  // A level more than three expected moves from spot would squash the rest into a corner: it is left off the ruler
  // (and named in `off`; its tile still prints it).
  const reach = num(lv.move) !== null && lv.move > 0 ? 3 * lv.move : null;
  const off = reach === null ? [] : items.filter(([, p]) => Math.abs(Number(p) - spot) > reach);
  for (const o of off) items.splice(items.indexOf(o), 1);
  const prices = [spot, ...items.map(([, p]) => Number(p))];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = Math.max((max - min) * 0.08, spot * 0.001);
  const lo = min - pad;
  const hi = max + pad;
  const x = (p) => (p - lo) / (hi - lo);
  const byPrice = new Map();
  for (const [k, p] of items) {
    const key = Math.round(Number(p) * 100) / 100;
    const m = byPrice.get(key) ?? { price: key, x: x(key), kinds: [], tags: [] };
    m.kinds.push(k);
    m.tags.push(LEVEL_NAMES[k]);
    byPrice.set(key, m);
  }
  const marks = [...byPrice.values()].sort((a, b) => a.price - b.price);
  const band = num(lv.rangeLo) !== null && num(lv.rangeHi) !== null ? { x0: x(lv.rangeLo), x1: x(lv.rangeHi) } : null;
  return { lo, hi, x, marks, band, spot: { price: spot, x: x(spot) }, off: off.map(([k]) => LEVEL_NAMES[k]) };
}

// ── Home: the calendar, the book and the header line ──

/**
 * Index expiries from today to `days` ahead, soonest first (ties in the order the bundles came): [{ u, date, kind,
 * days, shifted }]. `bundles` are GET /v1/reference/bundle answers.
 */
export function upcomingExpiries(bundles, today, days = 14) {
  return (bundles ?? [])
    .flatMap((b, i) => (b?.expiries ?? []).map((e) => ({ u: b.underlying, date: e.date, kind: e.kind, shifted: !!e.shifted, i })))
    .map((e) => ({ ...e, days: Math.round((Date.parse(`${e.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) }))
    .filter((e) => Number.isFinite(e.days) && e.days >= 0 && e.days <= days)
    .sort((a, b) => a.days - b.days || a.i - b.i)
    .map(({ i, ...e }) => e);
}

/**
 * Bars for a book's P&L, one per group (at most `n`, the largest first): [{ label, v, h }] with h = |v| ÷ the
 * largest |v| (0–1). Groups without a P&L figure are left out.
 */
export function pnlBars(groups, n = 8) {
  const xs = (groups ?? []).filter((g) => num(g?.pnl) !== null).map((g) => ({ label: g.label ?? g.underlying ?? "", v: Number(g.pnl) }));
  xs.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const top = xs.slice(0, n);
  const max = top.reduce((m, x) => Math.max(m, Math.abs(x.v)), 0);
  return top.map((x) => ({ ...x, h: max > 0 ? Math.abs(x.v) / max : 0 }));
}

/** Readiness checks passed across the accounts of a GET /v1/readiness snapshot: { pass, total } ("n/a" not counted). */
export function readinessChecks(snap) {
  let pass = 0;
  let total = 0;
  for (const a of snap?.accounts ?? []) {
    for (const c of Object.values(a?.checks ?? {})) {
      const s = c?.status;
      if (!s || s === "n/a") continue;
      total += 1;
      if (s === "pass") pass += 1;
    }
  }
  return { pass, total };
}

/** Events today split by side: { total, bull, bear } (`side` "bull" | "bear"; anything else is neither). */
export function eventSplit(events, today) {
  let total = 0;
  let bull = 0;
  let bear = 0;
  for (const e of events ?? []) {
    const t = num(e?.ts) ?? Date.parse(e?.time ?? "");
    if (!Number.isFinite(t) || istDay(t) !== today) continue;
    total += 1;
    if (e.side === "bull") bull += 1;
    else if (e.side === "bear") bear += 1;
  }
  return { total, bull, bear };
}

/**
 * Home's one-line summary under the title: "Market open · 1h 20m to close · 5 books open · P&L today +₹629 · NIFTY
 * expiry in 3 days". Parts without a figure are left out.
 */
export function homeSummary({ clock = null, books = null, pnl = null, expiry = null } = {}) {
  const parts = [];
  if (clock) parts.push(clock.phase === "open" ? `Market open · ${durationText(clock.minsLeft)} to close` : clock.holiday ? `Market closed · ${clock.holiday}` : "Market closed");
  if (num(books) !== null) parts.push(books ? `${formatInt(books)} book${books === 1 ? "" : "s"} open` : "Nothing open");
  if (num(pnl) !== null && num(books)) parts.push(`P&L today ${formatSignedRupee(pnl, 0)}`);
  if (expiry) parts.push(expiry.days === 0 ? `${expiry.u} expiry today` : `${expiry.u} expiry ${expiry.days === 1 ? "tomorrow" : `in ${formatInt(expiry.days)} days`}`);
  return parts.join(" · ");
}
