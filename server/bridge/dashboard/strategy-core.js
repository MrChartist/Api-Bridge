// Strategy Builder helpers (pure, tested in strategy-core.test.mjs): the extra ready-made templates on top of
// options.js PRESETS, the Spacing choice, template search, the Width and Wings moves, copy / share / paste of a
// position, and position sizing against a risk budget. No DOM; numbers become text only through format.js.
import { DASH, formatCompactTick, formatFixed, formatInt, isFigure } from "./format.js";
import * as O from "./options.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Spacing: how far apart a ready-made's legs sit ──

/** "auto" keeps the 1σ layout of options.js; a number is the gap unit in listed strikes (1, 2, 3 or 5). */
export const SPACINGS = Object.freeze([["auto", "Auto"], ["1", "1"], ["2", "2"], ["3", "3"], ["5", "5"]]);
export const normSpacing = (v) => (SPACINGS.some(([k]) => k === String(v)) ? String(v) : "auto");

/** The smallest gap between listed strikes (50 when there is only one). */
export function strikeStep(strikes) {
  const ks = [...new Set((strikes ?? []).map(num).filter((k) => k !== null && k > 0))].sort((a, b) => a - b);
  const gaps = ks.slice(1).map((k, i) => k - ks[i]).filter((d) => d > 0);
  return gaps.length ? Math.min(...gaps) : 50;
}

/** The `move` handed to options.js presetLegs: Auto keeps the caller's 1σ move; n steps put the short strikes 2n strikes out. */
export function spacingMove(spacing, step, move = null) {
  const s = normSpacing(spacing);
  if (s === "auto") return num(move);
  return 2 * Number(s) * (num(step) && step > 0 ? step : 50);
}

/** One template unit in listed strikes: n for a Spacing of n; on Auto, half the 1σ move (at least one strike). */
export function ladderUnit(spacing, step, move = null) {
  const s = normSpacing(spacing);
  if (s !== "auto") return Number(s);
  const st = num(step) && step > 0 ? step : 50;
  const m = num(move) && move > 0 ? move : st * 4;
  return Math.max(1, Math.round(m / 2 / st));
}

// ── Extra templates (the options.js 35 plus these 15 make 50) ──

const P = (id, name, group, risk, hint, { needsFut = false, multi = false, aliases = [] } = {}) => Object.freeze({ id, name, group, risk, needsFut, multi, hint, view: hint, aliases: Object.freeze(aliases), extra: true });

/** Legs in listed strikes from the ATM strike (× the unit): [right, offset, side, lots] or ["FUT", side]. */
const EXTRA_LEGS = Object.freeze({
  "bull-call-fly": [["CE", 1, "BUY"], ["CE", 3, "SELL", 2], ["CE", 5, "BUY"]],
  "bull-condor": [["CE", 1, "BUY"], ["CE", 3, "SELL"], ["CE", 5, "SELL"], ["CE", 7, "BUY"]],
  "call-ratio": [["CE", 0, "BUY"], ["CE", 2, "SELL", 2]],
  "long-future": [["FUT", "BUY"]],
  "bear-put-fly": [["PE", -1, "BUY"], ["PE", -3, "SELL", 2], ["PE", -5, "BUY"]],
  "bear-condor": [["PE", -1, "BUY"], ["PE", -3, "SELL"], ["PE", -5, "SELL"], ["PE", -7, "BUY"]],
  "put-ratio": [["PE", 0, "BUY"], ["PE", -2, "SELL", 2]],
  "reverse-jade-lizard": [["PE", -4, "BUY"], ["PE", -2, "SELL"], ["CE", 2, "SELL"]],
  "put-diagonal": [["PE", -2, "SELL", 1, "front"], ["PE", 0, "BUY", 1, "back"]],
  "short-future": [["FUT", "SELL"]],
  batman: [["PE", -3, "SELL", 2], ["PE", -1, "BUY"], ["CE", 1, "BUY"], ["CE", 3, "SELL", 2]],
  "double-plateau": [["PE", -7, "BUY"], ["PE", -5, "SELL"], ["PE", -3, "SELL"], ["PE", -1, "BUY"], ["CE", 1, "BUY"], ["CE", 3, "SELL"], ["CE", 5, "SELL"], ["CE", 7, "BUY"]],
  "long-put-fly": [["PE", -2, "BUY"], ["PE", 0, "SELL", 2], ["PE", 2, "BUY"]],
  strap: [["CE", 0, "BUY", 2], ["PE", 0, "BUY"]],
  strip: [["PE", 0, "BUY", 2], ["CE", 0, "BUY"]],
});

export const EXTRA_PRESETS = Object.freeze([
  P("bull-call-fly", "Bull butterfly", "bull", "defined", "Peaks a little above ATM, cheap", { aliases: ["call butterfly", "otm butterfly"] }),
  P("bull-condor", "Bull condor", "bull", "defined", "A flat top above ATM, both sides capped", { aliases: ["call condor"] }),
  P("call-ratio", "Call ratio spread", "bull", "undefined", "Up a little, not too far: open above", { aliases: ["front ratio", "1x2"] }),
  P("long-future", "Long future", "bull", "undefined", "Straight line up, one for one", { needsFut: true, aliases: ["futures buy"] }),
  P("bear-put-fly", "Bear butterfly", "bear", "defined", "Peaks a little below ATM, cheap", { aliases: ["put butterfly", "otm butterfly"] }),
  P("bear-condor", "Bear condor", "bear", "defined", "A flat top below ATM, both sides capped", { aliases: ["put condor"] }),
  P("put-ratio", "Put ratio spread", "bear", "undefined", "Down a little, not too far: large below", { aliases: ["front ratio", "1x2"] }),
  P("reverse-jade-lizard", "Reverse jade lizard", "bear", "undefined", "Range to down, no downside risk", { aliases: ["twisted sister"] }),
  P("put-diagonal", "Diagonal (put)", "bear", "defined", "Drifts down slowly; gains on time", { multi: true, aliases: ["put diagonal"] }),
  P("short-future", "Short future", "bear", "undefined", "Straight line down, one for one", { needsFut: true, aliases: ["futures sell"] }),
  P("batman", "Batman", "neutral", "undefined", "Two peaks either side of ATM", { aliases: ["double ratio"] }),
  P("double-plateau", "Double plateau", "neutral", "defined", "Two flat tops, both sides capped", { aliases: ["double condor"] }),
  P("long-put-fly", "Long put butterfly", "neutral", "defined", "Pins at ATM, built with puts", { aliases: ["put fly"] }),
  P("strap", "Strap", "vol", "defined", "A big move, more so up", { aliases: ["2 calls 1 put"] }),
  P("strip", "Strip", "vol", "defined", "A big move, more so down", { aliases: ["2 puts 1 call"] }),
]);

/** Other names the options.js presets go by: search finds them under these too. */
const ALIASES = Object.freeze({
  "iron-fly": ["iron butterfly"],
  "long-call-fly": ["call butterfly", "fly"],
  "call-ratio-back": ["call backspread"],
  "put-ratio-back": ["put backspread"],
  "risk-reversal": ["range forward", "fence"],
  "long-synthetic": ["synthetic future"],
  "short-synthetic": ["synthetic future"],
  "bull-put": ["credit spread", "put credit"],
  "bear-call": ["credit spread", "call credit"],
  "bull-call": ["debit spread", "call debit"],
  "bear-put": ["debit spread", "put debit"],
  "call-calendar": ["time spread", "horizontal"],
  "put-calendar": ["time spread", "horizontal"],
  "box": ["box spread"],
});

/** Every template: options.js PRESETS (with their aliases) then EXTRA_PRESETS, in group order. */
export const TEMPLATES = Object.freeze(
  O.PRESET_GROUPS.flatMap(([g]) => [
    ...O.PRESETS.filter((p) => p.group === g).map((p) => Object.freeze({ ...p, aliases: Object.freeze(ALIASES[p.id] ?? []), extra: false })),
    ...EXTRA_PRESETS.filter((p) => p.group === g),
  ]),
);
export const templateById = (id) => TEMPLATES.find((p) => p.id === id) ?? null;

/**
 * Templates matching a search: every word must appear in the name, an alias, the hint or the group's label.
 * An empty query returns the group's own templates (all of them without a group).
 */
export function searchTemplates(query, group = null) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return TEMPLATES.filter((p) => !group || p.group === group);
  const label = Object.fromEntries(O.PRESET_GROUPS);
  return TEMPLATES.filter((p) => {
    const hay = [p.name, p.hint, ...(p.aliases ?? []), label[p.group] ?? "", p.risk === "defined" ? "defined" : "undefined unlimited"].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Legs of an extra template on the chain's listed strikes, as options.js presetLegs returns them. [] when a strike
 * lies beyond the loaded ladder (a closer Spacing helps), a future is needed and missing, or a diagonal has no back expiry.
 */
export function extraLegs(id, chain, { unit = 1, fut = null, back = null } = {}) {
  const spec = EXTRA_LEGS[id];
  const meta = EXTRA_PRESETS.find((p) => p.id === id);
  if (!spec || !meta) return [];
  if (meta.needsFut && !fut?.symbol) return [];
  if (meta.multi && !(typeof back === "string" && DATE_RE.test(back))) return [];
  const atm = O.atmRow(chain);
  const strikes = [...new Set((chain?.rows ?? []).map((r) => num(r?.strike)).filter((k) => k !== null))].sort((a, b) => a - b);
  if (!atm || !strikes.length) return [];
  const i0 = strikes.indexOf(atm.strike);
  if (i0 < 0) return [];
  const u = Math.max(1, Math.floor(num(unit) ?? 1));
  const front = DATE_RE.test(String(chain?.expiry ?? "")) ? chain.expiry : null;
  const out = [];
  for (const [a, b, c, d, e] of spec) {
    if (a === "FUT") {
      out.push({ kind: "FUT", right: null, strike: null, side: b, lots: 1, symbol: fut.symbol, expiry: fut.expiry ?? null, lotSize: num(fut.lotSize) ?? null });
      continue;
    }
    const k = strikes[i0 + b * u];
    if (k === undefined) return [];
    const leg = { right: a, strike: k, side: c, lots: d ?? 1 };
    if (e === "front") leg.expiry = front;
    if (e === "back") leg.expiry = back;
    out.push(leg);
  }
  return out;
}

/**
 * Legs of any template with the Spacing applied: extras from the ladder, options.js presets with their move set
 * by the Spacing (Auto keeps the 1σ move). Same shape as presetLegs.
 */
export function templateLegs(id, chain, { spacing = "auto", move = null, forward = null, fut = null, back = null } = {}) {
  const step = strikeStep((chain?.rows ?? []).map((r) => r.strike));
  if (EXTRA_LEGS[id]) return extraLegs(id, chain, { unit: ladderUnit(spacing, step, move), fut, back });
  return O.presetLegs(id, chain, { move: spacingMove(spacing, step, move), forward, fut, back });
}

/** A tile's short money: "+₹3K", "−₹3.5K", "₹0"; null (no cap) is "Unlimited"; not a figure is a dash. */
export function tileMoney(v) {
  if (v === null) return "Unlimited";
  if (!isFigure(v)) return DASH;
  const n = Math.round(Number(v));
  if (n === 0) return "₹0";
  return `${n > 0 ? "+" : "−"}₹${formatCompactTick(Math.abs(n))}`;
}

// ── Width and Wings: move the whole shape ──

const isOpt = (l) => l && l.kind !== "FUT" && num(l.strike) !== null;
const reprice = (l, k) => {
  const y = { ...l, strike: k, symbol: null };
  delete y.entry;
  delete y.entryTag;
  return y;
};

/** The centre a position widens around: the mean of its sold option strikes, else of all its option strikes. */
export function legCentre(legs) {
  const on = (legs ?? []).filter((l) => isOpt(l) && l.on !== false);
  const sold = on.filter((l) => l.side === "SELL");
  const use = sold.length ? sold : on;
  return use.length ? use.reduce((a, l) => a + Number(l.strike), 0) / use.length : null;
}

/**
 * Width: every option leg above the centre moves `dir` listed strikes up, every leg below moves down (dir −1 brings
 * them in). Sold legs sitting at the centre move only as a straddle (a sold call and put there): the call up, the put
 * down. Narrowing never crosses the centre. Returns { legs } or { error: "none" | "edge" | "narrowest" }.
 * `strikesOf(expiry)` lists the strikes of a leg's expiry.
 */
export function widenLegs(legs, strikesOf, dir) {
  const c = legCentre(legs);
  if (c === null) return { error: "none" };
  const atC = (legs ?? []).filter((l) => isOpt(l) && l.on !== false && l.side === "SELL" && Math.abs(l.strike - c) < 1e-9);
  const straddle = atC.some((l) => l.right === "CE") && atC.some((l) => l.right === "PE");
  let moved = 0;
  const out = [];
  for (const l of legs ?? []) {
    if (!isOpt(l)) {
      out.push(l);
      continue;
    }
    const d = l.strike - c;
    const away = Math.abs(d) > 1e-9 ? Math.sign(d) : straddle && l.side === "SELL" ? (l.right === "CE" ? 1 : -1) : 0;
    if (!away) {
      out.push(l);
      continue;
    }
    const k = O.stepStrike(strikesOf(l.expiry) ?? [], l.strike, away * dir);
    if (k === null || k === l.strike) return { error: "edge" };
    if (dir < 0 && (k - c) * away < -1e-9) return { error: "narrowest" };
    out.push(reprice(l, k));
    moved += 1;
  }
  return moved ? { legs: out } : { error: "none" };
}

/**
 * Wings: only the bought option legs outside the sold strikes move, away from them (dir 1) or towards them (dir −1);
 * a wing never reaches a sold strike. Returns { legs } or { error: "none" | "edge" | "narrowest" }.
 */
export function wingLegs(legs, strikesOf, dir) {
  const sold = (legs ?? []).filter((l) => isOpt(l) && l.on !== false && l.side === "SELL").map((l) => l.strike);
  if (!sold.length) return { error: "none" };
  const hi = Math.max(...sold);
  const lo = Math.min(...sold);
  let moved = 0;
  const out = [];
  for (const l of legs ?? []) {
    const away = isOpt(l) && l.side === "BUY" && l.on !== false ? (l.strike > hi ? 1 : l.strike < lo ? -1 : 0) : 0;
    if (!away) {
      out.push(l);
      continue;
    }
    const k = O.stepStrike(strikesOf(l.expiry) ?? [], l.strike, away * dir);
    if (k === null || k === l.strike) return { error: "edge" };
    if (away > 0 ? k <= hi : k >= lo) return { error: "narrowest" };
    out.push(reprice(l, k));
    moved += 1;
  }
  return moved ? { legs: out } : { error: "none" };
}

// ── Copy, share and paste ──

/** "2026-11-03" → "3 Nov 2026" (no Intl: the same text in every locale, so it reads back). */
export function dayText(iso) {
  if (!DATE_RE.test(String(iso ?? ""))) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function isoOf(d, mon, y) {
  const m = MONTHS.findIndex((x) => x.toLowerCase() === String(mon).slice(0, 3).toLowerCase());
  const dd = Number(d);
  if (m < 0 || !(dd >= 1 && dd <= 31)) return null;
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * The position as plain text, one line per leg ("Buy 2 lots NIFTY 24500 CE 3 Nov 2026 @ 41.55"), under a title line.
 * Switched-off legs are left out. parseLegsText reads it back.
 */
export function legsText({ underlying = "", name = "", legs = [] } = {}) {
  const u = String(underlying ?? "").toUpperCase();
  const lines = (legs ?? [])
    .filter((l) => l && l.on !== false)
    .map((l) => {
      const lots = Math.max(1, Math.floor(num(l.lots) ?? 1));
      const what = l.kind === "FUT" ? "FUT" : `${formatInt(l.strike)} ${l.right}`;
      const px = num(l.price) ?? num(l.entry);
      return `${l.side === "SELL" ? "Sell" : "Buy"} ${lots} lot${lots === 1 ? "" : "s"} ${u ? `${u} ` : ""}${what}${l.expiry ? ` ${dayText(l.expiry)}` : ""}${px !== null && px > 0 ? ` @ ${formatFixed(px, 2)}` : ""}`;
    });
  const title = [name, u].filter(Boolean).join(" · ");
  return [title, ...lines].filter(Boolean).join("\n");
}

const LINE_RE = /^\s*(buy|sell|b|s)\s+(\d+)\s*(?:lots?|x|×)?\s+(?:([a-z][a-z0-9&_-]*)\s+)??(?:(\d+(?:\.\d+)?)\s*(ce|pe|call|put|c|p)\b|(fut(?:ure)?)\b)\s*(?:(\d{4}-\d{2}-\d{2})|(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-]+(\d{4}))?\s*(?:@\s*(\d+(?:\.\d+)?))?/i;

/**
 * Legs from pasted text: one "Buy|Sell <lots> [lots] [UNDERLYING] <strike> CE|PE|Call|Put [date] [@ price]" or
 * "... FUT [date]" per line. Lines that do not read as a leg are counted in `skipped`. Up to 12 legs.
 * @returns {{ underlying: string|null, legs: object[], skipped: number }}
 */
export function parseLegsText(text) {
  let underlying = null;
  const legs = [];
  let skipped = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      if (/\d/.test(line) && /\b(buy|sell)\b/i.test(line)) skipped += 1;
      continue;
    }
    if (legs.length >= O.MAX_LEGS) {
      skipped += 1;
      continue;
    }
    const [, sd, lotsT, u, kT, rt, futT, iso, d, mon, y, pxT] = m;
    const lots = Math.floor(Number(lotsT));
    if (!(lots >= 1 && lots <= 10000)) {
      skipped += 1;
      continue;
    }
    if (u && !underlying) underlying = u.toUpperCase();
    const expiry = iso ?? (d ? isoOf(d, mon, y) : null);
    const side = /^b/i.test(sd) ? "BUY" : "SELL";
    const price = pxT ? Number(pxT) : null;
    if (futT) legs.push({ kind: "FUT", right: null, strike: null, side, lots, expiry, price });
    else {
      const k = Number(kT);
      if (!(k > 0)) {
        skipped += 1;
        continue;
      }
      legs.push({ kind: "OPT", right: /^c/i.test(rt) ? "CE" : "PE", strike: k, side, lots, expiry, price });
    }
  }
  return { underlying, legs, skipped };
}

const b64e = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64d = (c) => new TextDecoder().decode(Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

/**
 * A compact, URL-safe code for a position: underlying, an optional name and the enabled legs (side, type, strike,
 * lots, expiry; a future keeps its symbol). Prices are not carried: whoever opens it sees today's quotes.
 */
export function shareCode({ underlying = "", name = "", legs = [] } = {}) {
  const L = (legs ?? [])
    .filter((l) => l && l.on !== false)
    .slice(0, O.MAX_LEGS)
    .map((l) => (l.kind === "FUT" ? ["F", l.side === "SELL" ? "S" : "B", Math.max(1, Math.floor(num(l.lots) ?? 1)), l.expiry ?? "", String(l.symbol ?? "")] : [l.right === "PE" ? "P" : "C", l.side === "SELL" ? "S" : "B", Math.max(1, Math.floor(num(l.lots) ?? 1)), l.expiry ?? "", Number(l.strike)]));
  return b64e(JSON.stringify({ v: 1, u: String(underlying ?? "").toUpperCase().slice(0, 32), n: String(name ?? "").slice(0, 60), l: L }));
}

/** The position in a share code, validated; null when the code is not one. */
export function readShareCode(code) {
  const c = String(code ?? "").trim();
  if (!c || c.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(c)) return null;
  let o;
  try {
    o = JSON.parse(b64d(c));
  } catch {
    return null;
  }
  if (!o || o.v !== 1 || typeof o.u !== "string" || !/^[A-Z0-9&_-]{1,32}$/.test(o.u) || !Array.isArray(o.l) || !o.l.length || o.l.length > O.MAX_LEGS) return null;
  const legs = [];
  for (const r of o.l) {
    if (!Array.isArray(r) || r.length !== 5) return null;
    const [t, sd, lots, expiry, last] = r;
    if (!["C", "P", "F"].includes(t) || !["B", "S"].includes(sd)) return null;
    if (!Number.isInteger(lots) || lots < 1 || lots > 10000) return null;
    if (expiry !== "" && !DATE_RE.test(expiry)) return null;
    const side = sd === "S" ? "SELL" : "BUY";
    if (t === "F") {
      if (typeof last !== "string" || !/^[A-Z]{2,4}:[A-Za-z0-9&_-]{1,60}$/.test(last)) return null;
      legs.push({ kind: "FUT", right: null, strike: null, side, lots, expiry: expiry || null, symbol: last });
    } else {
      if (!isFigure(last) || !(last > 0)) return null;
      legs.push({ kind: "OPT", right: t === "P" ? "PE" : "CE", strike: Number(last), side, lots, expiry: expiry || null });
    }
  }
  return { underlying: o.u, name: typeof o.n === "string" ? o.n.slice(0, 60) : "", legs };
}

// ── Position sizing ──

/**
 * How many of this position fit: the risk budget (capital × risk %) over the max loss, and capital over the margin.
 * `fits` is the smaller; `by` says which limit binds. An unlimited loss (null) is sized by margin only.
 */
export function positionSizing({ capital = null, riskPct = null, maxLoss = undefined, margin = null } = {}) {
  const cap = num(capital);
  const pct = num(riskPct);
  const budget = cap !== null && cap > 0 && pct !== null && pct > 0 ? (cap * Math.min(pct, 100)) / 100 : null;
  const loss = num(maxLoss);
  const byLoss = budget !== null && loss !== null && loss < -0.5 ? Math.floor(budget / -loss) : null;
  const m = num(margin);
  const byMargin = cap !== null && cap > 0 && m !== null && m > 0.5 ? Math.floor(cap / m) : null;
  let fits = null;
  let by = null;
  if (byLoss !== null && (byMargin === null || byLoss <= byMargin)) [fits, by] = [byLoss, "loss"];
  else if (byMargin !== null) [fits, by] = [byMargin, "margin"];
  return { budget, byLoss, byMargin, fits, by, unlimited: maxLoss === null };
}
