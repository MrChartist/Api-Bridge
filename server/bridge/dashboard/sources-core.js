// Sources page: the pure logic (no DOM, no network, no clock unless it is passed in), so it can be tested in Node.
//
// What lives here: the one tone scale (calm, busy, heads up, at the limit) with hysteresis and a minimum dwell, the
// burn-rate forecast, the pooled room across accounts and sources, the risk sort, plain-language labels (health, data
// class, delay, route verdicts, trace reasons), the quota presets and their validation, and the pooling consent model.
// The page modules (sources-page.js, sources-providers.js, quotas-view.js) only draw what these return.
//
// Response shapes are the ones in the build plan: GET /v1/sources, /v1/usage, /v1/limits?explain=1, /v1/quotas,
// /v1/pooling and GET /v1/sources/trace. Every function tolerates a missing field: a half-built Bridge never throws here.

import { DASH, formatInt } from "./format.js";

// ── The tone scale ──

/**
 * Where each tone starts (a share of a budget used) and where it ends again. One scale for the whole dashboard: the
 * page, the pooled sentence and every meter read the same numbers. `exit*` are lower than the entry values on purpose
 * (hysteresis): a budget hovering around 80 % does not flicker between two words.
 */
export const LIMIT_TONES = Object.freeze({
  busy: 0.6,
  headsUp: 0.8,
  limit: 0.95,
  /** A budget that will run out sooner than this (seconds) is a heads up whatever its share. */
  forecastHeadsUpSec: 60,
  exitBusy: 0.5,
  exitHeadsUp: 0.7,
  /** The limit lifts when more than 10 % of the budget is back. */
  exitLimit: 0.9,
  /** ...and the forecast is longer than this (seconds). */
  exitForecastSec: 120,
  /** A tone is kept at least this long before it may fall back (ms). It can always rise at once. */
  dwellMs: 5000,
});

export const TONES = Object.freeze(["calm", "busy", "headsup", "limit"]);
const RANK = Object.freeze({ calm: 0, busy: 1, headsup: 2, limit: 3 });
export const toneRank = (t) => RANK[t] ?? 0;

/** Short words for a row. */
export const TONE_WORD = Object.freeze({ calm: "Calm", busy: "Busy", headsup: "Heads up", limit: "At the limit" });
/** The sentence that leads the page. */
export const TONE_SENTENCE = Object.freeze({ calm: "Plenty of room", busy: "Busy", headsup: "Heads up", limit: "At the limit" });

/** The tone of a share (0 to 1) and an optional forecast (seconds until the budget is empty). No hysteresis. */
export function toneForShare(share, forecastSec = null) {
  const s = Number.isFinite(share) ? share : 0;
  if (s >= LIMIT_TONES.limit) return "limit";
  if (s >= LIMIT_TONES.headsUp || (Number.isFinite(forecastSec) && forecastSec < LIMIT_TONES.forecastHeadsUpSec)) return "headsup";
  if (s >= LIMIT_TONES.busy) return "busy";
  return "calm";
}

/**
 * Keeps the tone of many budgets steady. `update(key, share, forecastSec, at)` returns the tone to show:
 *  - it rises at once (a risk is never hidden);
 *  - it falls only when the share is below that tone's exit value (and the forecast is long enough) AND the tone has
 *    been shown for at least `dwellMs`, so a budget that flaps does not strobe.
 * @param {{ dwellMs?: number }} [opts]
 */
export function createToneTracker({ dwellMs = LIMIT_TONES.dwellMs } = {}) {
  /** @type {Map<string, { tone: string, since: number }>} */
  const state = new Map();
  const canLeave = (tone, share, forecastSec) => {
    const forecastOk = !Number.isFinite(forecastSec) || forecastSec > LIMIT_TONES.exitForecastSec;
    if (tone === "limit") return share < LIMIT_TONES.exitLimit;
    if (tone === "headsup") return share < LIMIT_TONES.exitHeadsUp && forecastOk;
    if (tone === "busy") return share < LIMIT_TONES.exitBusy;
    return true;
  };
  return {
    update(key, share, forecastSec, at) {
      const next = toneForShare(share, forecastSec);
      const cur = state.get(key);
      if (!cur) {
        state.set(key, { tone: next, since: at });
        return next;
      }
      if (RANK[next] > RANK[cur.tone]) {
        cur.tone = next;
        cur.since = at;
      } else if (RANK[next] < RANK[cur.tone] && at - cur.since >= dwellMs && canLeave(cur.tone, share, forecastSec)) {
        cur.tone = next;
        cur.since = at;
      }
      return cur.tone;
    },
    get: (key) => state.get(key)?.tone ?? null,
    forget: (key) => state.delete(key),
    /** Drop every key not in `keep` (a source that went away). */
    prune(keep) {
      for (const k of [...state.keys()]) if (!keep.has(k)) state.delete(k);
    },
  };
}

// ── Windows, rates and the forecast ──

/** The length of a window name from the Bridge ("1s", "1m", "60s", "1h", "day", "second", "minute") in seconds, or null. */
export function windowSeconds(name) {
  if (typeof name === "number") return name > 0 ? name : null;
  const s = String(name ?? "").toLowerCase();
  const named = { second: 1, minute: 60, hour: 3600, day: 86400 };
  if (Object.hasOwn(named, s)) return named[s];
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

/** "per second", "per minute", "per day", "every 30 minutes": a window as people say it. */
export function perText(windowSec) {
  if (!(windowSec > 0)) return "";
  if (windowSec === 1) return "per second";
  if (windowSec === 60) return "per minute";
  if (windowSec === 3600) return "per hour";
  if (windowSec === 86400) return "per day";
  if (windowSec % 3600 === 0) return `every ${windowSec / 3600} hours`;
  if (windowSec % 60 === 0) return `every ${windowSec / 60} minutes`;
  return `every ${windowSec} seconds`;
}

/**
 * Calls per second from a counter that only goes up (calls today), smoothed. A sample after a long gap (a hidden tab)
 * or after the counter went down (a new day) restarts the estimate instead of spiking it.
 * @param {{ alpha?: number, maxGapMs?: number }} [opts]
 */
export function createRateTracker({ alpha = 0.3, maxGapMs = 5000 } = {}) {
  /** @type {Map<string, { total: number, at: number, rate: number | null }>} */
  const state = new Map();
  return {
    /** @returns {number | null} calls per second, null until two close samples exist */
    update(key, total, at) {
      if (!Number.isFinite(total)) return state.get(key)?.rate ?? null;
      const prev = state.get(key);
      if (!prev || total < prev.total || at - prev.at > maxGapMs || at <= prev.at) {
        state.set(key, { total, at, rate: null });
        return null;
      }
      const inst = (total - prev.total) / ((at - prev.at) / 1000);
      const rate = prev.rate === null ? inst : alpha * inst + (1 - alpha) * prev.rate;
      state.set(key, { total, at, rate });
      return rate;
    },
    get: (key) => state.get(key)?.rate ?? null,
    prune(keep) {
      for (const k of [...state.keys()]) if (!keep.has(k)) state.delete(k);
    },
  };
}

/**
 * When will this budget run out at the current pace? Pure.
 *  - a budget that refills continuously (a second or a minute window) gains `limit / window` calls a second;
 *  - a fixed budget (a day) gains nothing until it resets.
 * Only a run-out inside five windows is worth saying; later than that, or never, is "calm".
 * @param {{ remaining: number, limit: number, windowSec: number, rate: number | null, fixed?: boolean, resetInSec?: number | null }} b
 * @returns {{ kind: "calm" | "empty" | "runsOut", seconds: number | null }}
 */
export function forecastEmpty({ remaining, limit, windowSec, rate, fixed = false, resetInSec = null }) {
  if (!(limit > 0)) return { kind: "calm", seconds: null };
  if (remaining <= 0) return { kind: "empty", seconds: 0 };
  if (!Number.isFinite(rate) || rate === null || rate <= 0) return { kind: "calm", seconds: null };
  const refill = fixed ? 0 : limit / Math.max(1, windowSec);
  const net = rate - refill;
  if (net <= 0) return { kind: "calm", seconds: null };
  let seconds = remaining / net;
  if (fixed && Number.isFinite(resetInSec) && resetInSec !== null && seconds > resetInSec) return { kind: "calm", seconds: null };
  if (seconds > 5 * Math.max(1, windowSec)) return { kind: "calm", seconds: null };
  seconds = Math.max(0, seconds);
  return { kind: "runsOut", seconds: seconds < 5 ? Math.max(1, Math.round(seconds)) : Math.round(seconds / 5) * 5 };
}

// ── Plain-language numbers ──

/** A wait as a phrase: "a few seconds", "about 40 seconds", "about 4 minutes", "about 2 hours". */
export function waitPhrase(sec) {
  if (!Number.isFinite(sec)) return DASH;
  if (sec < 5) return "a few seconds";
  if (sec < 90) return `about ${Math.round(sec / 5) * 5} seconds`;
  const min = Math.round(sec / 60);
  if (sec < 3600) return min === 1 ? "about a minute" : `about ${min} minutes`;
  const hours = Math.round(sec / 3600);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/** A short countdown: "8 s", "2 min", "1 h 5 min". */
export function shortWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
}

/** "just now", "2 s ago", "3 min ago": how old the last reading is. */
export function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.round(ms / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** A delay in seconds as people say it: 900 -> "15 min", 20 -> "20 s", 5400 -> "1.5 h". */
export function delayText(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const hours = Math.round((sec / 3600) * 10) / 10;
  return `${hours} h`;
}

/** Share of a budget used as a whole percent, 0 to 100. */
export const percent = (share) => (Number.isFinite(share) ? Math.max(0, Math.min(100, Math.round(share * 100))) : 0);

// ── Data class, health, labels ──

export const CLASS_WORD = Object.freeze({ realtime: "Real-time", delayed: "Delayed", eod: "End of day" });

/** The label of a data class, with the delay: "Real-time", "Delayed 15 min", "End of day". */
export function classLabel(cls, delaySec) {
  if (cls === "delayed") {
    const d = delayText(delaySec);
    return d ? `Delayed ${d}` : "Delayed";
  }
  return CLASS_WORD[cls] ?? "Unknown data class";
}

/** The plain sentence that goes with a class (what it is good for). */
export function classAdvice(cls, delaySec) {
  if (cls === "delayed") return `${delayText(delaySec) ? `${delayText(delaySec)} behind the market` : "Behind the market"}. Good for charts and watchlists, never used for orders or alerts.`;
  if (cls === "eod") return "Prices from the end of the trading day. Good for history and cross-checks, never used for orders or alerts.";
  return "Straight from your broker, as live as the broker makes it.";
}

export const officialLabel = (official) => (official ? "Official" : "Unofficial");

export const CAPABILITY_WORD = Object.freeze({ quotes: "quotes", history: "history", expiries: "expiry dates", optionChain: "option chains" });
/** ["quotes","history"] -> "quotes and history". */
export function capabilityText(caps) {
  const words = (Array.isArray(caps) ? caps : []).map((c) => CAPABILITY_WORD[c] ?? c);
  if (!words.length) return "nothing yet";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export const CLASS_NAME = Object.freeze({ order: "Orders", quote: "Quotes", depth: "Market depth", history: "History", chain: "Option chains", portfolio: "Positions and funds", master: "Instrument list", other: "Other calls" });
/** The endpoint classes that carry market-data reads (what pooling and fallback are about). */
export const DATA_CLASSES = Object.freeze(["quote", "depth", "history", "chain"]);

const titleCase = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : "");

/**
 * Health of a source in one word and one sentence. `state` is the machine state, `tone` the colour family
 * (ok, warn, bad, off), `word` what people read, `detail` the reason with the next try when there is one.
 * @param {object} src  a row of GET /v1/sources
 * @param {{ time?: (iso: string) => string }} [fmt]  how to print a time (the page passes IST)
 */
export function sourceHealth(src, { time = (iso) => String(iso) } = {}) {
  const h = src?.health ?? {};
  if (!src?.enabled) {
    if (src?.needsKey && !src?.configured) return { state: "setup", tone: "off", word: "Needs a key", detail: "Add your key to use this source." };
    return { state: "off", tone: "off", word: "Off", detail: "You have not turned this source on." };
  }
  if (src.needsKey && !src.configured) return { state: "setup", tone: "warn", word: "Needs a key", detail: "This source is on but has no key, so it cannot answer." };
  const retry = h.nextTryAt ? ` Trying again at ${time(h.nextTryAt)}.` : "";
  const last = h.lastError ? `${String(h.lastError).replace(/\.$/, "")}.` : "";
  if (h.state === "open") return { state: "paused", tone: "bad", word: "Paused", detail: `The Bridge stopped using it after repeated errors.${last ? ` Last error: ${last}` : ""}${retry}`.trim(), nextTryAt: h.nextTryAt ?? null };
  if (h.state === "disabled") return { state: "off", tone: "off", word: "Off", detail: "This source is switched off." };
  if (h.state === "degraded") return { state: "slow", tone: "warn", word: "Slow", detail: `It is answering more slowly or with some errors than usual.${last ? ` Last error: ${last}` : ""}`.trim(), nextTryAt: h.nextTryAt ?? null };
  return { state: "working", tone: "ok", word: "Working", detail: Number.isFinite(h.p50Ms) && h.p50Ms > 0 ? `Usually answers in about ${formatInt(h.p50Ms)} ms.` : "Answering normally." };
}

/** Health of a broker account from a /v1/usage row. */
export function accountHealth(acct) {
  const back = Math.max(0, ...Object.values(acct?.classes ?? {}).map((c) => c.backoffMs ?? 0), acct?.backoffMs ?? 0);
  if (acct?.healthy === false || back > 0) {
    return { state: "backoff", tone: "warn", word: "Backing off", detail: back > 0 ? `${titleCase(acct.broker)} asked us to wait. Trying again in ${shortWait(back)}.` : `${titleCase(acct.broker)} is not answering well. The Bridge is waiting before it asks again.`, retryMs: back || null };
  }
  return { state: "working", tone: "ok", word: "Working", detail: "Answering normally." };
}

const HEALTH_SEVERITY = Object.freeze({ paused: 3.5, backoff: 3.2, slow: 2, setup: 0.5, working: 0, off: -1 });

// ── Budgets and rows ──

/** One budget as the page needs it. `share` is used / limit. */
function makeBudget({ cls = null, clsName = "", used, limit, windowSec, resetInSec = null, fixed = false }) {
  const u = Math.max(0, Number(used) || 0);
  const l = Number(limit);
  const share = l > 0 ? Math.min(1, u / l) : 0;
  return { cls, clsName, used: u, limit: l, remaining: Math.max(0, l - u), share, windowSec, per: perText(windowSec), resetInSec, fixed: fixed || windowSec >= 86400 };
}

/** Scale a budget to calls per minute (second windows grow, day windows are left alone: they are not "this minute"). */
function perMinute(b) {
  if (!b || !(b.windowSec > 0) || b.windowSec > 3600) return null;
  const k = 60 / b.windowSec;
  return { used: b.used * k, limit: b.limit * k };
}

/**
 * The budgets of one broker account: every endpoint class with its tightest window ("binding": the fullest share), the
 * market-data one the row shows, and the minute and day figures the pooled room adds up.
 * @param {object} a  a row of /v1/usage `accounts`
 */
export function accountBudgets(a) {
  const classes = Object.entries(a?.classes ?? {}).map(([cls, c]) => {
    const wins = (Array.isArray(c.windows) && c.windows.length ? c.windows : [{ window: c.window, used: c.used, limit: c.limit, resetMs: c.resetMs }])
      .map((w) => ({ windowSec: windowSeconds(w.window), used: Number(w.used) || 0, limit: Number(w.limit), resetMs: Number(w.resetMs) || 0 }))
      .filter((w) => w.windowSec && w.limit > 0 && Number.isFinite(w.limit));
    const budgets = wins.map((w) => makeBudget({ cls, clsName: CLASS_NAME[cls] ?? titleCase(cls), used: w.used, limit: w.limit, windowSec: w.windowSec, resetInSec: w.resetMs ? Math.ceil(w.resetMs / 1000) : null }));
    const binding = budgets.reduce((best, b) => (!best || b.share > best.share || (b.share === best.share && b.windowSec < best.windowSec) ? b : best), null);
    return { cls, name: CLASS_NAME[cls] ?? titleCase(cls), callsToday: Number(c.callsToday) || 0, throttledToday: Number(c.throttledToday) || 0, refusedToday: Number(c.refusedToday) || 0, backoffMs: Number(c.backoffMs) || 0, budgets, binding };
  });
  const data = classes.filter((c) => DATA_CLASSES.includes(c.cls) && c.binding);
  const pool = data.length ? data : classes.filter((c) => c.binding);
  const headline = pool.reduce((best, c) => (!best || c.binding.share > best.binding.share ? c : best), null);
  // The room pooling adds up is the quote budget: the calls most tools make.
  const quoteClass = classes.find((c) => c.cls === "quote" && c.binding) ?? pool[0] ?? null;
  const minuteSource = quoteClass?.budgets.find((b) => b.windowSec === 60) ?? quoteClass?.budgets.filter((b) => b.windowSec < 60).sort((x, y) => y.share - x.share)[0] ?? null;
  const daySource = quoteClass?.budgets.find((b) => b.windowSec >= 86400) ?? null;
  return { classes, headline: headline?.binding ?? null, headlineClass: headline?.cls ?? null, minute: perMinute(minuteSource), minuteSource, day: daySource ? { used: daySource.used, limit: daySource.limit } : null, callsToday: classes.reduce((n, c) => n + c.callsToday, 0) };
}

/** The minute and day budgets of a free source from its documented limits and its usage. */
export function sourceBudgets(src) {
  const lim = src?.limits ?? {};
  const use = src?.usage ?? {};
  const out = { minute: null, day: null, binding: null };
  const perMin = Number(lim.perMinute) > 0 ? Number(lim.perMinute) : Number(lim.perSecond) > 0 ? Number(lim.perSecond) * 60 : null;
  if (perMin) out.minute = makeBudget({ used: use.lastMinute ?? 0, limit: perMin, windowSec: 60 });
  if (Number(lim.perDay) > 0) out.day = makeBudget({ used: use.today ?? 0, limit: Number(lim.perDay), windowSec: 86400, fixed: true });
  out.binding = [out.minute, out.day].filter(Boolean).reduce((best, b) => (!best || b.share > best.share ? b : best), null);
  return out;
}

/**
 * The rows of the sources list, one per working thing: each broker account (from usage) and each source (from
 * /v1/sources, brokers of that list that are already an account are not repeated).
 * @param {{ sources?: object[] | null, usage?: { accounts?: object[] } | null, time?: (iso: string) => string, onlyEnabled?: boolean }} input
 */
export function buildRows({ sources = null, usage = null, time, onlyEnabled = true } = {}) {
  const rows = [];
  const accounts = usage?.accounts ?? [];
  const accountKeys = new Set();
  for (const a of accounts) {
    const b = accountBudgets(a);
    accountKeys.add(a.accountId);
    accountKeys.add(a.broker);
    const health = accountHealth(a);
    rows.push({
      key: `acct:${a.accountId}`,
      kind: "account",
      id: a.accountId,
      name: a.accountId,
      sub: `${titleCase(a.broker)}, your broker account`,
      cls: "realtime",
      delaySec: 0,
      official: true,
      enabled: true,
      configured: true,
      health,
      budget: b.headline,
      budgetClass: b.headlineClass,
      classes: b.classes,
      minute: b.minute,
      day: b.day,
      counter: b.callsToday,
      counterLabel: "calls today",
      inFlight: a.inFlight ?? 0,
      queued: a.queued ?? 0,
      terms: null,
      source: null,
    });
  }
  for (const s of sources ?? []) {
    if (s.kind === "broker" && (accountKeys.has(s.id) || accountKeys.has(s.accountId))) continue;
    if (onlyEnabled && !s.enabled) continue;
    const b = sourceBudgets(s);
    const health = sourceHealth(s, { time });
    rows.push({
      key: `src:${s.id}`,
      kind: "source",
      id: s.id,
      name: s.name ?? s.id,
      sub: `${s.official ? "Official" : "Unofficial"} source: ${capabilityText(s.capabilities)}`,
      cls: s.class ?? "realtime",
      delaySec: s.delaySec ?? null,
      official: Boolean(s.official),
      enabled: Boolean(s.enabled),
      configured: s.configured !== false,
      health,
      budget: b.binding,
      budgetClass: null,
      classes: [],
      minute: b.minute ? { used: b.minute.used, limit: b.minute.limit } : null,
      day: b.day ? { used: b.day.used, limit: b.day.limit } : null,
      counter: Number(s.usage?.today) || 0,
      counterLabel: "calls today",
      inFlight: 0,
      queued: 0,
      terms: s.terms ?? null,
      source: s,
    });
  }
  return rows;
}

/**
 * Add the live parts to rows: the tone (kept steady by a tracker), the burn rate and the forecast. Mutates and returns
 * the rows. `trackers` is `{ tones, rates }` made by createToneTracker and createRateTracker.
 */
export function annotateRows(rows, { tones, rates, at }) {
  for (const r of rows) {
    const b = r.budget;
    r.rate = rates.update(r.key, r.counter, at);
    if (!b) {
      r.forecast = { kind: "calm", seconds: null };
      r.tone = "calm";
      continue;
    }
    // A class budget has its own counter; the row's counter is every call of the account, so the forecast uses the share
    // of that rate the budget's class carries (all of it for a source).
    const classRate = r.kind === "account" ? classRateOf(r, rates, at) : r.rate;
    r.forecast = forecastEmpty({ remaining: b.remaining, limit: b.limit, windowSec: b.windowSec, rate: classRate, fixed: b.fixed, resetInSec: b.resetInSec });
    const secs = r.forecast.kind === "runsOut" ? r.forecast.seconds : r.forecast.kind === "empty" ? 0 : null;
    r.tone = tones.update(r.key, b.share, secs, at);
    r.classRate = classRate;
  }
  return rows;
}

function classRateOf(row, rates, at) {
  const c = row.classes.find((x) => x.cls === row.budgetClass);
  if (!c) return row.rate;
  return rates.update(`${row.key}:${c.cls}`, c.callsToday, at);
}

/** How much attention a row needs: bigger is more at risk. Tone first, then health, then how full the budget is. */
export function riskScore(row) {
  const tone = { calm: 0, busy: 1, headsup: 3, limit: 4 }[row.tone ?? "calm"] ?? 0;
  const health = HEALTH_SEVERITY[row.health?.state] ?? 0;
  const forecast = row.forecast?.kind === "runsOut" ? 0.5 * (1 - Math.min(row.forecast.seconds, 600) / 600) : 0;
  return Math.max(tone, health) + (row.budget?.share ?? 0) + forecast;
}

export const SORTS = Object.freeze([["risk", "Risk"], ["name", "Name"], ["room", "Room left"]]);

/** Sort rows (a new array): by risk (default), name, or how little room is left. Stable, name breaks ties. */
export function sortRows(rows, mode = "risk") {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en", { sensitivity: "base" });
  const copy = [...rows];
  if (mode === "name") return copy.sort(byName);
  // Least room first; a row without a budget figure goes last.
  if (mode === "room") return copy.sort((a, b) => (b.budget?.share ?? -1) - (a.budget?.share ?? -1) || byName(a, b));
  return copy.sort((a, b) => riskScore(b) - riskScore(a) || byName(a, b));
}

// ── Pooled room ──

/** Rows that add room: switched on, set up, and not paused or backing off. */
const contributes = (r) => r.enabled && r.configured && r.health.state !== "paused" && r.health.state !== "backoff" && r.health.state !== "off" && r.health.state !== "setup";

/**
 * The room across every account and source, in calls per minute (second budgets are scaled up), or per day when no
 * source has a minute figure. `in` lists what counts, `out` what does not and why.
 * @returns {{ window: "minute" | "day" | null, used: number, limit: number, remaining: number, share: number, counted: object[], notCounted: object[] }}
 */
export function pooledRoom(rows) {
  const counted = [];
  const notCounted = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    if (!contributes(r)) {
      notCounted.push({ key: r.key, name: r.name, reason: r.health.state === "paused" ? "it is paused" : r.health.state === "backoff" ? "it is backing off" : r.health.state === "setup" ? "it has no key" : "it is not available" });
      continue;
    }
    counted.push(r);
  }
  const minute = counted.filter((r) => r.minute && r.minute.limit > 0);
  const useMinute = minute.length > 0;
  const part = useMinute ? minute : counted.filter((r) => r.day && r.day.limit > 0);
  if (!part.length) return { window: null, used: 0, limit: 0, remaining: 0, share: 0, counted: [], notCounted };
  const key = useMinute ? "minute" : "day";
  const used = part.reduce((n, r) => n + r[key].used, 0);
  const limit = part.reduce((n, r) => n + r[key].limit, 0);
  for (const r of counted) if (!part.includes(r)) notCounted.push({ key: r.key, name: r.name, reason: useMinute ? "it only has a daily budget" : "it has no budget figure" });
  return {
    window: key,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    share: limit > 0 ? Math.min(1, used / limit) : 0,
    counted: part.map((r) => ({ key: r.key, name: r.name, remaining: Math.max(0, r[key].limit - r[key].used), limit: r[key].limit, cls: r.cls, delaySec: r.delaySec })),
    notCounted,
  };
}

/**
 * The most pressing forecast across rows: the budget that runs out soonest. null when nothing runs out.
 * @returns {{ row: object, seconds: number } | null}
 */
export function soonestRunOut(rows) {
  let best = null;
  for (const r of rows) {
    if (!r.enabled || r.forecast?.kind !== "runsOut") continue;
    if (!best || r.forecast.seconds < best.seconds) best = { row: r, seconds: r.forecast.seconds };
  }
  return best;
}

/**
 * The one forecast sentence under the pooled meter.
 * @returns {{ text: string, tone: "calm" | "warn" }}
 */
export function forecastSentence(rows) {
  const hit = soonestRunOut(rows);
  if (!hit) return { text: "At this pace: stays calm.", tone: "calm" };
  const r = hit.row;
  const what = r.kind === "account" ? `${titleCase(String(r.sub).split(",")[0])} ${(r.budget?.clsName ?? "call").toLowerCase()} budget` : `${r.name} budget`;
  return { text: `At this pace the ${what} runs out in ${waitPhrase(hit.seconds)}.`, tone: "warn" };
}

/**
 * The sentence and detail that lead the Overview.
 * @param {{ pool: ReturnType<typeof pooledRoom>, tone: string, rows: object[] }} p
 */
export function heroText({ pool, tone, rows }) {
  const sentence = TONE_SENTENCE[tone] ?? TONE_SENTENCE.calm;
  const counted = pool.counted.length;
  if (!rows.length) return { sentence: "Nothing to measure yet", detail: "Connect a broker account or turn on a free source and its room shows here.", figure: DASH };
  if (!pool.window) return { sentence, detail: "None of your sources states a call budget, so there is nothing to run out of.", figure: DASH };
  const unit = pool.window === "minute" ? "this minute" : "today";
  const figure = `${formatInt(pool.remaining)}`;
  const across = counted === 1 ? `1 source` : `${counted} sources`;
  const detail = {
    calm: `About ${figure} calls of room ${unit}, across ${across}.`,
    busy: `About ${figure} calls of room left ${unit}, across ${across}. Fine, but it is filling up.`,
    headsup: `About ${figure} calls of room left ${unit}, across ${across}. Slow down heavy tools or add a source.`,
    limit: `Only ${figure} calls of room left ${unit}. New calls wait for room to free up.`,
  }[tone] ?? "";
  return { sentence, detail, figure };
}

/** Rows whose own tone needs a word on the page (heads up or the limit), worst first. */
export function attentionRows(rows) {
  return rows.filter((r) => r.enabled && (r.tone === "headsup" || r.tone === "limit")).sort((a, b) => riskScore(b) - riskScore(a));
}

/**
 * The heads-up banner text for a row and where its calls go next.
 * @returns {{ title: string, detail: string, tone: "warn" | "bad" }}
 */
export function attentionText(row, rows) {
  const c = row.budget?.clsName ?? "Calls";
  const isOrder = ["order", "portfolio"].includes(row.budgetClass ?? "");
  const next = rows.filter((r) => r !== row && contributes(r) && r.cls === "realtime" && r.tone !== "limit" && r.tone !== "headsup").sort((a, b) => (a.budget?.share ?? 0) - (b.budget?.share ?? 0))[0];
  const where = next ? `New ${c.toLowerCase()} calls will go to ${next.name} first.` : "Calls will wait for room to free up.";
  const orders = isOrder ? "" : " Orders are not affected.";
  if (row.tone === "limit") {
    const reset = row.budget?.resetInSec ? ` Room starts coming back in about ${waitPhrase(row.budget.resetInSec).replace(/^about /, "")}.` : "";
    return { title: `${row.name}: ${c.toLowerCase()} are at the limit`, detail: `${where}${orders}${reset}`.trim(), tone: "bad" };
  }
  const when = row.forecast?.kind === "runsOut" ? `will be full in ${waitPhrase(row.forecast.seconds)} at this pace` : "are getting full";
  return { title: `${row.name}: ${c.toLowerCase()} ${when}`, detail: `${where}${orders}`.trim(), tone: "warn" };
}

/** A meter's spoken value: "380 of 600 calls left per minute, busy, runs out in about 40 seconds". */
export function meterSpeech(row) {
  const b = row.budget;
  if (!b) return `${row.name}: no budget figure`;
  const parts = [`${formatInt(b.remaining)} of ${formatInt(b.limit)} calls left ${b.per}`, TONE_WORD[row.tone ?? "calm"].toLowerCase()];
  if (row.forecast?.kind === "runsOut") parts.push(`runs out in ${waitPhrase(row.forecast.seconds)}`);
  return parts.join(", ");
}

// ── Recent requests and the route trace ──

/** Which question a path asks the router: quotes, history, expiries, optionChain, or null for anything else. */
export function capabilityForPath(path) {
  const p = String(path ?? "").split("?")[0];
  if (/^\/v1\/(ltp|quotes|depth)\b/.test(p)) return "quotes";
  if (/^\/v1\/history\b/.test(p)) return "history";
  if (/^\/v1\/expiries\b/.test(p)) return "expiries";
  if (/^\/v1\/optionchain\b/.test(p)) return "optionChain";
  return null;
}

export const CAPABILITY_ASK = Object.freeze([["quotes", "Quotes"], ["history", "History"], ["expiries", "Expiry dates"], ["optionChain", "Option chain"]]);

export const PURPOSES = Object.freeze([
  ["display", "Showing on screen"],
  ["analysis", "Charts and analysis"],
  ["alert", "Alerts"],
  ["paper", "Paper trading"],
  ["risk", "Risk checks"],
  ["order", "Placing an order"],
]);
export const PURPOSE_NOTE = Object.freeze({
  display: "Any source may answer, delayed ones are labelled.",
  analysis: "Any source may answer, delayed ones are labelled.",
  alert: "Only real-time sources: a late price could fire a wrong alert.",
  paper: "Only real-time sources, so paper fills match the market.",
  risk: "Only real-time sources: risk checks must not use late prices.",
  order: "Only real-time sources: orders never use delayed data.",
});

/**
 * One line for a request in Recent requests: what the router did, in words. Reads the optional `route` the Bridge may
 * attach to a logged request: { from: "stream" | "cache" | "shared" | "live" | "stale", source, sourceName, class, delaySec }.
 * Without it the line says only what the log knows (the status).
 * @returns {{ text: string, tone: "ok" | "info" | "warn" | "bad" | "" , known: boolean }}
 */
export function requestVerdict(entry) {
  const r = entry?.route;
  const status = Number(entry?.status);
  if (status === 429) return { text: "Held back: over a limit", tone: "warn", known: true };
  if (status >= 500) return { text: "Failed", tone: "bad", known: true };
  if (status >= 400) return { text: `Refused (${status})`, tone: "bad", known: true };
  if (!r) return { text: "Answered", tone: "", known: false };
  const name = r.sourceName ?? r.source ?? "a source";
  if (r.from === "stream") return { text: "Answered from the live stream", tone: "ok", known: true };
  if (r.from === "cache") return { text: "Served from cache", tone: "ok", known: true };
  if (r.from === "shared") return { text: "Shared another call's answer", tone: "ok", known: true };
  if (r.from === "stale") return { text: "Served the last good value", tone: "warn", known: true };
  if (r.class === "delayed") return { text: `Used ${name}, delayed ${delayText(r.delaySec) || "a little"}`, tone: "info", known: true };
  if (r.class === "eod") return { text: `Used ${name}, end of day data`, tone: "info", known: true };
  return { text: `Answered from ${name}`, tone: "ok", known: true };
}

/** "NSE:RELIANCE" style symbols from free text: split on commas and spaces, upper-case, at most 20. */
export function parseSymbols(text) {
  return [...new Set(String(text ?? "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 20);
}

/** The query string of GET /v1/sources/trace. */
export function traceQuery({ capability = "quotes", symbols = [], purpose = "display", maxAgeMs = null }) {
  const q = new URLSearchParams();
  q.set("capability", capability);
  if (symbols.length) q.set("symbols", symbols.join(","));
  q.set("purpose", purpose);
  if (Number.isFinite(maxAgeMs) && maxAgeMs !== null) q.set("maxAgeMs", String(Math.round(maxAgeMs)));
  return q.toString();
}

/**
 * A trace reason in plain words. The Bridge sends text; a bare token (best-score, no-spare-budget) is spelled out.
 * Text with spaces is used as it is, with a capital first letter and a full stop.
 */
export function reasonText(reason) {
  const raw = String(reason ?? "").trim();
  if (!raw) return "";
  if (/^[a-z0-9]+([_-][a-z0-9]+)+$/i.test(raw) || /^[a-z0-9]+$/i.test(raw)) {
    const known = {
      "best-score": "It had the most room and the best record.",
      "no-spare-budget": "It has no room left right now.",
      "breaker-open": "It is paused after repeated errors.",
      "not-enabled": "It is switched off.",
      disabled: "It is switched off.",
      "not-configured": "It has no key yet.",
      "needs-key": "It has no key yet.",
      "class-not-allowed": "Its data is too late for this purpose.",
      "too-old": "Its data is older than the answer asked for.",
      "max-age": "Its data is older than the answer asked for.",
      "no-consent": "Pooling is not turned on for this account.",
      "no-capability": "It cannot answer this kind of question.",
      "capability": "It cannot answer this kind of question.",
      "deadline": "It could not answer in time.",
      fallback: "Next in line if the first choice fails.",
    };
    const k = raw.toLowerCase().replace(/_/g, "-");
    if (Object.hasOwn(known, k)) return known[k];
    return `${titleCase(raw.replace(/[_-]+/g, " ").toLowerCase())}.`;
  }
  const t = titleCase(raw);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * A trace as the sheet shows it. Pure.
 * @param {object} trace  the TraceResult
 * @param {(id: string) => string} nameOf  display name of a source id
 * @returns {{ headline: string, detail: string, cls: string, steps: Array<{ id: string, name: string, verdict: string, glyph: string, word: string, reason: string, spare: string | null, health: string | null }> , chosen: object | null }}
 */
export function traceModel(trace, nameOf = (id) => id) {
  const considered = Array.isArray(trace?.considered) ? trace.considered : [];
  const chosen = considered.find((c) => c.verdict === "chosen") ?? null;
  const fallback = considered.filter((c) => c.verdict === "fallback");
  const cls = trace?.class ?? (chosen?.class ?? "realtime");
  let headline;
  if (chosen) {
    const nm = nameOf(chosen.id);
    headline = cls === "delayed" ? `Would use ${nm}, delayed.` : cls === "eod" ? `Would use ${nm}, end of day data.` : `Would be answered from ${nm}.`;
  } else headline = "No source can answer this right now.";
  const detailBits = [];
  if (trace?.note) detailBits.push(reasonText(trace.note));
  if (chosen && fallback.length) detailBits.push(`If it fails, ${nameOf(fallback[0].id)} is next.`);
  const wordOf = { chosen: "Chosen", fallback: "Next in line", skipped: "Not used" };
  const glyphOf = { chosen: "check", fallback: "arrow", skipped: "skip" };
  const steps = considered.map((c) => ({
    id: c.id,
    name: nameOf(c.id),
    verdict: c.verdict,
    glyph: glyphOf[c.verdict] ?? "skip",
    word: wordOf[c.verdict] ?? "Not used",
    reason: reasonText(c.reason),
    spare: Number.isFinite(c.spareBudget) ? `${formatInt(c.spareBudget)} calls of room` : null,
    health: c.health?.state && c.health.state !== "ok" ? ({ open: "Paused", degraded: "Slow", disabled: "Off" }[c.health.state] ?? null) : null,
  }));
  return { headline, detail: detailBits.join(" "), cls, steps, chosen };
}

// ── Quotas ──

export const KIND_WORD = Object.freeze({ ui: "Dashboard", mcp: "AI assistant", excel: "Excel or Sheets", script: "Script", other: "Other tool" });
export const kindLabel = (k) => KIND_WORD[k] ?? titleCase(k || "other tool");

/**
 * The three presets, scaled from the Bridge's default so they stay sensible when the default changes.
 *  Light: a quarter of the default, for a tool that only looks now and then.
 *  Normal: the default (no override).
 *  Heavy: three times the default, for a bot or a big spreadsheet.
 * @param {{ perSecond: number, burst: number }} def
 * @param {number} kindWeight  the weight this tool kind has by default
 */
export function quotaPresets(def, kindWeight = 1) {
  const ps = Math.max(0.1, Number(def?.perSecond) || 10);
  const bu = Math.max(1, Number(def?.burst) || ps * 2);
  const round1 = (n) => Math.round(n * 10) / 10;
  const w = Math.max(1, Number(kindWeight) || 1);
  return [
    { id: "light", label: "Light", note: "A quarter of normal. For something that only looks now and then.", values: { perSecond: Math.max(1, round1(ps / 4)), burst: Math.max(2, Math.round(bu / 4)), weight: Math.max(1, Math.round(w / 2)), perDay: null } },
    { id: "normal", label: "Normal", note: "The Bridge's usual amount.", values: { perSecond: round1(ps), burst: Math.round(bu), weight: w, perDay: null } },
    { id: "heavy", label: "Heavy", note: "Three times normal and a bigger share of the queue. For a bot or a large spreadsheet.", values: { perSecond: round1(ps * 3), burst: Math.round(bu * 3), weight: Math.min(100, w * 2), perDay: null } },
  ];
}

/** Which preset the values match, or "custom". */
export function matchPreset(values, presets) {
  const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.05;
  for (const p of presets) {
    const v = p.values;
    if (eq(values.perSecond, v.perSecond) && eq(values.burst, v.burst) && eq(values.weight, v.weight) && (values.perDay ?? null) === (v.perDay ?? null)) return p.id;
  }
  return "custom";
}

export const QUOTA_LIMITS = Object.freeze({ perSecondMax: 1000, burstMax: 10000, weightMax: 100, perDayMax: 100_000_000 });

/**
 * Check quota fields typed in a form. Empty per-day means no daily cap. Returns the body for PUT /v1/quotas/{keyId} or
 * the problems by field, in plain words.
 * @param {{ perSecond: string | number, burst: string | number, weight: string | number, perDay?: string | number | null }} f
 * @returns {{ ok: true, body: object } | { ok: false, errors: Record<string, string> }}
 */
export function validateQuota(f) {
  const errors = {};
  const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
  const ps = num(f.perSecond);
  const bu = num(f.burst);
  const wt = num(f.weight);
  const dayRaw = f.perDay === "" || f.perDay === null || f.perDay === undefined ? null : Number(f.perDay);
  if (!Number.isFinite(ps) || ps <= 0) errors.perSecond = "Enter how many calls a second, more than 0.";
  else if (ps > QUOTA_LIMITS.perSecondMax) errors.perSecond = `That is more than the Bridge allows (${formatInt(QUOTA_LIMITS.perSecondMax)} a second).`;
  if (!Number.isInteger(bu) || bu < 1) errors.burst = "Enter a whole number, 1 or more.";
  else if (bu > QUOTA_LIMITS.burstMax) errors.burst = `Keep the burst at ${formatInt(QUOTA_LIMITS.burstMax)} or less.`;
  else if (!errors.perSecond && bu < Math.ceil(ps)) errors.burst = "The burst must be at least the calls per second, or the rate could never be reached.";
  if (!Number.isInteger(wt) || wt < 1) errors.weight = "Enter a whole number, 1 or more.";
  else if (wt > QUOTA_LIMITS.weightMax) errors.weight = `Keep the weight at ${formatInt(QUOTA_LIMITS.weightMax)} or less.`;
  if (dayRaw !== null && (!Number.isInteger(dayRaw) || dayRaw < 1)) errors.perDay = "Leave empty for no daily cap, or enter a whole number, 1 or more.";
  else if (dayRaw !== null && dayRaw > QUOTA_LIMITS.perDayMax) errors.perDay = "That daily cap is larger than the Bridge accepts.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { perSecond: ps, burst: bu, weight: wt, perDay: dayRaw } };
}

/** How full a key's day is (0 to 1), or null with no daily cap. */
export const dayShare = (k) => (k?.perDay > 0 ? Math.min(1, (k.usage?.today ?? 0) / k.perDay) : null);

/** Where a key's numbers come from, in words. */
export function quotaSourceText(source) {
  if (source === "override") return "Custom for this key";
  if (source === "config") return "Set in the configuration file";
  return "The Bridge default";
}

/** Rows of GET /v1/quotas keys, the busiest first (throttled, then today's use), then label. */
export function sortKeys(keys) {
  return [...(keys ?? [])].sort((a, b) => (b.usage?.throttledToday ?? 0) - (a.usage?.throttledToday ?? 0) || (b.usage?.today ?? 0) - (a.usage?.today ?? 0) || String(a.label).localeCompare(String(b.label), "en", { sensitivity: "base" }));
}

/** The quota line of a key: "10 a second, bursts of 20, 5000 a day". */
export function quotaLine(k) {
  const bits = [`${formatInt(k.perSecond)} a second`, `bursts of ${formatInt(k.burst)}`];
  if (k.perDay > 0) bits.push(`${formatInt(k.perDay)} a day`);
  return bits.join(", ");
}

// ── Pooling ──

export const POLICY_WORD = Object.freeze({ allowed: "Allowed", "not-allowed": "Not allowed", unknown: "Not stated" });
export const POLICY_TONE = Object.freeze({ allowed: "ok", "not-allowed": "bad", unknown: "warn" });
export const POLICY_NOTE = Object.freeze({
  allowed: "This broker's published terms do not forbid sharing market-data reads between your own accounts.",
  "not-allowed": "This broker's terms forbid it, so the Bridge never pools this account.",
  unknown: "This broker's terms do not say. You decide whether to include it.",
});

/**
 * What the pooling sheet and card need from GET /v1/pooling.
 * @param {object | null} data  the `data` of the response
 */
export function poolingModel(data) {
  const consent = data?.consent ?? null;
  const groups = (data?.groups ?? []).map((g, i) => ({
    holder: g.holder ?? `Holder ${i + 1}`,
    accounts: (g.accounts ?? []).map((a) => ({ id: a.id, broker: a.broker, policy: a.poolingPolicy ?? "unknown", inPool: Boolean(a.inPool), choosable: (a.poolingPolicy ?? "unknown") !== "not-allowed" })),
  }));
  const all = groups.flatMap((g) => g.accounts);
  return {
    on: Boolean(consent),
    consent,
    groups,
    notice: data?.notice ?? { version: "", text: "" },
    poolable: groups.filter((g) => g.accounts.filter((a) => a.choosable).length >= 2),
    inPoolCount: all.filter((a) => a.inPool).length,
    canPool: groups.some((g) => g.accounts.filter((a) => a.choosable).length >= 2),
  };
}

/** Can the consent sheet submit? A tick and at least two chosen accounts, all of one holder. */
export function consentProblem({ ticked, chosen, groups }) {
  if (chosen.length < 2) return "Choose at least two accounts to pool.";
  const holders = new Set(groups.filter((g) => g.accounts.some((a) => chosen.includes(a.id))).map((g) => g.holder));
  if (holders.size > 1) return "Pool accounts of one person only. Choose accounts from one group.";
  if (!ticked) return "Tick the box to confirm you have read the notice.";
  return null;
}

// ── Providers (free and key-based sources) ──

/**
 * What a source card shows and does, from its row of GET /v1/sources.
 * @returns {{ state: string, tone: string, word: string, detail: string, action: "enable" | "key" | "notice" | "none", canSwitch: boolean, on: boolean }}
 */
export function providerState(src, { time } = {}) {
  const health = sourceHealth(src, { time });
  const tier = src?.tier;
  const on = Boolean(src?.enabled);
  let action = "none";
  if (!on) action = src?.needsKey && !src?.configured ? "key" : tier === "opt-in" ? "notice" : "enable";
  if (tier === "plugin" && !on) action = "none";
  const switchable = tier !== "builtin" && tier !== "plugin";
  return { ...health, action, canSwitch: switchable, on };
}

/** How a source is switched on, in words (the tier). */
export function tierText(tier) {
  return { builtin: "Part of the Bridge", byok: "Needs your own key", "opt-in": "Off until you accept a notice", plugin: "Plugin approved on this computer" }[tier] ?? "";
}

/** What the switch of a source asks before it turns on. */
export function enableSteps(src) {
  const steps = [];
  if (src?.needsKey && !src?.configured) steps.push("key");
  if (src?.tier === "opt-in") steps.push("notice");
  return steps;
}
