// Workspace state and the small pure engines behind the trading-terminal chrome: the shared Analytics context
// (underlying, expiry, strikes), collapsed sidebar groups, recent pages, density, the IST market clock, Vim-style
// two-key navigation and the auto-refresh scheduler.
//
// Everything here is DOM-free so it runs in Node tests. Browser storage is always wrapped: private windows and blocked
// storage must never break the page, so every read and write is in try/catch and the state simply lives in memory
// when storage is unavailable. chrome.js draws the controls; views.js and palette.js call into this file.

import { REF_DEFAULTS, hmMinutes } from "./reference.js";

// ───────────────────────── storage ─────────────────────────

const SLOTS = {
  context: "mcb.dashboard.context",
  collapsed: "mcb.dashboard.navCollapsed",
  recent: "mcb.dashboard.recentPages",
  density: "mcb.dashboard.density",
  refresh: "mcb.dashboard.autoRefresh",
};

/** A get/set wrapper over localStorage or sessionStorage that never throws. */
export function safeStore(kind = "local", source) {
  const area = () => {
    try {
      if (source) return source;
      return kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return area()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined) area()?.removeItem(key);
        else area()?.setItem(key, value);
      } catch {
        /* storage blocked or full: keep going in memory */
      }
    },
  };
}

const parseJson = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

// ───────────────────────── shared context ─────────────────────────

/** The quick-pick underlyings in the context bar and the palette. */
export const UNDERLYING_CHIPS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"];
export const STRIKE_OPTIONS = [5, 10, 15, 20, 30];
export const DEFAULT_CONTEXT = Object.freeze({ underlying: "NIFTY", expiry: "", strikes: 10 });

/** A symbol as the Bridge expects it: upper case, letters, digits and & _ - (1 to 30), or null. */
export function normalizeUnderlying(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9&_-]{1,30}$/.test(s) ? s : null;
}
const normalizeExpiry = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
const normalizeStrikes = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null;
};

/** Whatever was stored (or typed) turned into a valid context; anything invalid falls back to the default. */
export function normalizeContext(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    underlying: normalizeUnderlying(o.underlying) ?? DEFAULT_CONTEXT.underlying,
    expiry: normalizeExpiry(o.expiry),
    strikes: normalizeStrikes(o.strikes) ?? DEFAULT_CONTEXT.strikes,
  };
}

/**
 * The workspace context. `state` has accessor properties (underlying, expiry, strikes): assigning one validates,
 * persists (localStorage, with sessionStorage as a fallback) and tells subscribers. analyticsViews.js exposes it as its
 * `selection` object, so every control that already reads and writes `selection` shares one persisted context.
 * Changing the underlying clears the expiry (an expiry belongs to one underlying).
 * @param {{ local?: ReturnType<typeof safeStore>, session?: ReturnType<typeof safeStore> }} [stores]
 */
export function createContext(stores = {}) {
  const local = stores.local ?? safeStore("local");
  const session = stores.session ?? safeStore("session");
  const listeners = new Set();
  let data = normalizeContext(parseJson(local.get(SLOTS.context) ?? session.get(SLOTS.context), null));
  const persist = () => {
    const text = JSON.stringify(data);
    local.set(SLOTS.context, text);
    session.set(SLOTS.context, text);
  };
  const emit = (changed) => {
    for (const fn of [...listeners]) {
      try {
        fn({ ...data }, changed);
      } catch {
        /* one broken listener must not stop the rest */
      }
    }
  };
  /** Apply a partial change. Returns the names of the fields that actually changed. */
  const set = (patch) => {
    const changed = [];
    const next = { ...data };
    const u = "underlying" in patch ? normalizeUnderlying(patch.underlying) : null;
    if (u && u !== next.underlying) {
      next.underlying = u;
      next.expiry = ""; // an expiry belongs to one underlying
      changed.push("underlying");
    }
    if ("expiry" in patch) {
      const e = normalizeExpiry(patch.expiry);
      if (e !== next.expiry) {
        next.expiry = e;
        changed.push("expiry");
      }
    }
    const k = "strikes" in patch ? normalizeStrikes(patch.strikes) : null;
    if (k !== null && k !== next.strikes) {
      next.strikes = k;
      changed.push("strikes");
    }
    if (!changed.length) return changed;
    data = next;
    persist();
    emit(changed);
    return changed;
  };
  const state = {};
  for (const key of ["underlying", "expiry", "strikes"]) {
    Object.defineProperty(state, key, { enumerable: true, get: () => data[key], set: (v) => void set({ [key]: v }) });
  }
  return {
    state,
    get: () => ({ ...data }),
    set,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Forget what is stored and go back to the defaults (tests). */
    reset() {
      data = { ...DEFAULT_CONTEXT };
      persist();
      emit(["underlying", "expiry", "strikes"]);
    },
  };
}

/** Expiry dates still ahead (today counts), from the Bridge's /v1/expiries list. Pure. */
export function upcomingExpiries(list, today = new Date().toISOString().slice(0, 10)) {
  return (Array.isArray(list) ? list : []).filter((e) => typeof e === "string" && e >= today).sort();
}

/** "Thu · in 6 days" for an expiry date, relative to `today` (YYYY-MM-DD). Pure. */
export function expiryNote(expiry, today = new Date().toISOString().slice(0, 10)) {
  const d = Date.parse(`${expiry}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return "";
  const days = Math.round((d - t) / 86_400_000);
  const dow = new Date(d).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
  return `${dow} · ${days === 0 ? "today" : days === 1 ? "tomorrow" : days < 0 ? `${-days} days ago` : `in ${days} days`}`;
}

// ───────────────────────── sidebar groups ─────────────────────────

/**
 * Which sidebar groups are collapsed, remembered per browser. The group that holds the current page is always shown
 * open (its saved choice is kept for later).
 */
export function createNavState(store = safeStore("local")) {
  let collapsed = new Set(parseJson(store.get(SLOTS.collapsed), []).filter((g) => typeof g === "string"));
  const save = () => store.set(SLOTS.collapsed, JSON.stringify([...collapsed]));
  return {
    isOpen: (group, activeGroup) => group === activeGroup || !collapsed.has(group),
    isCollapsedPref: (group) => collapsed.has(group),
    /** The saved collapsed group names. */
    collapsed: () => [...collapsed],
    /** Replace the saved choice (a layout being applied). */
    replace(groups) {
      collapsed = new Set((Array.isArray(groups) ? groups : []).filter((g) => typeof g === "string"));
      save();
    },
    /** Flip a group. Returns the new open state of its saved choice. */
    toggle(group) {
      if (collapsed.has(group)) collapsed.delete(group);
      else collapsed.add(group);
      save();
      return !collapsed.has(group);
    },
    set(group, open) {
      if (open) collapsed.delete(group);
      else collapsed.add(group);
      save();
    },
    /** Drop saved choices for groups that no longer exist. */
    prune(groups) {
      const keep = new Set(groups);
      const before = collapsed.size;
      collapsed = new Set([...collapsed].filter((g) => keep.has(g)));
      if (collapsed.size !== before) save();
    },
  };
}

// ───────────────────────── recent pages and density ─────────────────────────

export const RECENT_MAX = 5;
/** Put `id` first in a recent list (no duplicates, at most RECENT_MAX). Pure. */
export const pushRecent = (list, id) => [id, ...(Array.isArray(list) ? list : []).filter((x) => x !== id)].slice(0, RECENT_MAX);

export function createRecents(store = safeStore("local")) {
  let ids = parseJson(store.get(SLOTS.recent), []).filter((x) => typeof x === "string").slice(0, RECENT_MAX);
  return {
    list: () => [...ids],
    push(id) {
      ids = pushRecent(ids, id);
      store.set(SLOTS.recent, JSON.stringify(ids));
    },
  };
}

export const DENSITIES = ["comfortable", "compact"];
export function createDensity(store = safeStore("local")) {
  let value = DENSITIES.includes(store.get(SLOTS.density)) ? store.get(SLOTS.density) : "comfortable";
  return {
    get: () => value,
    set(v) {
      value = DENSITIES.includes(v) ? v : "comfortable";
      store.set(SLOTS.density, value === "comfortable" ? null : value);
      return value;
    },
  };
}

// ───────────────────────── market clock (IST) ─────────────────────────

const IST_OFFSET_MS = 5.5 * 3_600_000;
// Session times come from the reference store's labelled defaults (reference.js), never a literal here.
const PRE_OPEN = hmMinutes(REF_DEFAULTS.session.preOpen);
const OPEN = hmMinutes(REF_DEFAULTS.session.open);
const CLOSE = hmMinutes(REF_DEFAULTS.session.close);

/** "2h 14m", "9m 05s", "3d 4h": the time left, for the market chip. Pure. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const hh = Math.floor((total % 86400) / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (d > 0) return `${d}d ${hh}h`;
  if (hh > 0) return `${hh}h ${String(mm).padStart(2, "0")}m`;
  if (mm >= 10) return `${mm}m`;
  if (mm > 0) return `${mm}m ${String(ss).padStart(2, "0")}s`;
  return `${ss}s`;
}

/**
 * NSE cash and F&O session in IST: pre-open 09:00 to 09:15, open 09:15 to 15:30, Monday to Friday. Exchange holidays
 * are not known to the browser, so a holiday shows as a normal weekday; the chip's tooltip says so. Pure.
 * @param {Date | number} [now]
 * @returns {{ state: "open" | "preopen" | "closed", label: string, next: "open" | "close", remainingMs: number, text: string, short: string }}
 */
export function marketStatus(now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const ist = new Date(t + IST_OFFSET_MS);
  const dow = ist.getUTCDay(); // 0 = Sunday
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const sinceMidnightMs = ((minutes * 60) + ist.getUTCSeconds()) * 1000 + ist.getUTCMilliseconds();
  const weekday = dow >= 1 && dow <= 5;
  const msTo = (target) => target * 60_000 - sinceMidnightMs;
  if (weekday && minutes >= PRE_OPEN && minutes < OPEN) {
    const remainingMs = msTo(OPEN);
    return { state: "preopen", label: "Pre-open", next: "open", remainingMs, text: `Pre-open · opens in ${formatCountdown(remainingMs)}`, short: `Pre-open · ${formatCountdown(remainingMs)}` };
  }
  if (weekday && minutes >= OPEN && minutes < CLOSE) {
    const remainingMs = msTo(CLOSE);
    return { state: "open", label: "Open", next: "close", remainingMs, text: `Market open · closes in ${formatCountdown(remainingMs)}`, short: `Open · ${formatCountdown(remainingMs)}` };
  }
  // Closed: count to the next 09:15 on a weekday (a Friday evening and the weekend both point at Monday).
  let days = 0;
  if (weekday && minutes < PRE_OPEN) days = 0;
  else {
    days = 1;
    let nextDow = (dow + 1) % 7;
    while (nextDow === 0 || nextDow === 6) {
      days += 1;
      nextDow = (nextDow + 1) % 7;
    }
  }
  const remainingMs = days * 86_400_000 + msTo(OPEN);
  return { state: "closed", label: "Closed", next: "open", remainingMs, text: `Market closed · opens in ${formatCountdown(remainingMs)}`, short: `Closed · ${formatCountdown(remainingMs)}` };
}

// ───────────────────────── Vim-style navigation ─────────────────────────

/**
 * What follows "g" for each page id: one key where a free letter exists, else a two-letter code (g e x = Exposure,
 * g s c = Screener). A key may never be the start of a longer one (that would be ambiguous), so Scanner is "sn" and
 * Expiry day "ed", leaving "s" and "e" as prefixes only. goKeyTable() enforces that for any table it is given.
 */
export const GO_KEYS = Object.freeze({
  home: "h",
  accounts: "a",
  console: "t",
  limits: "r",
  scanner: "sn",
  orders: "d",
  safety: "k",
  keys: "y",
  integrations: "i",
  activity: "u",
  chain: "c",
  oi: "o",
  gex: "g",
  skew: "v",
  payoff: "p",
  calculators: "x",
  futures: "f",
  flows: "l",
  expiry: "ed",
  oichange: "n",
  strategies: "m",
  greeksgrid: "w",
  alerts: "j",
  positions: "z",
  unusual: "b",
  tide: "q",
  exposure: "ex",
  screener: "sc",
});

/**
 * A unique 2 to 4 letter code for every page, shown in the nav tooltip and the page header and typed in the command
 * line ("banknifty oc", "oi nifty", "help gx"). None may equal EQ, FUT, OPT or HELP (see ASSET_TOKENS).
 */
export const PAGE_CODES = Object.freeze({
  home: "HM",
  accounts: "ACT",
  console: "CON",
  limits: "RL",
  scanner: "SCN",
  orders: "ORD",
  safety: "SAF",
  keys: "KEY",
  integrations: "INT",
  activity: "LOG",
  chain: "OC",
  oi: "OI",
  gex: "GX",
  skew: "SK",
  payoff: "PAY",
  calculators: "CALC",
  futures: "FTR",
  flows: "FII",
  expiry: "XD",
  oichange: "OIC",
  strategies: "STR",
  greeksgrid: "GRK",
  alerts: "ALR",
  positions: "POS",
  unusual: "UOA",
  tide: "TIDE",
  exposure: "EXP",
  screener: "SCR",
});
export const codeOf = (id) => PAGE_CODES[id] ?? null;
/** { CODE: pageId } for the pages that exist. Pure. */
export function codeTable(pageIds, map = PAGE_CODES) {
  const have = new Set(pageIds);
  const out = {};
  for (const [id, code] of Object.entries(map)) if (have.has(id) && !(code in out)) out[code] = id;
  return out;
}

/** { key: pageId } for the pages that exist (so a removed page frees its key). A key that starts a longer one is dropped. Pure. */
export function goKeyTable(pageIds, map = GO_KEYS) {
  const have = new Set(pageIds);
  const out = {};
  for (const [id, key] of Object.entries(map)) if (have.has(id) && !(key in out)) out[key] = id;
  const keys = Object.keys(out);
  for (const k of keys) if (keys.some((o) => o !== k && o.startsWith(k))) delete out[k];
  return out;
}

/**
 * A key-sequence recogniser: the leader key (g) arms it, then one or two keys (within `timeoutMs` of the previous key)
 * pick the page. A key that is a whole code ends the sequence at once; a key that only starts longer codes waits for
 * the next one, so one- and two-key codes never clash. It never fires while the person is typing: the caller reports
 * that with `typing: true`, which also disarms it.
 * `feed` returns { kind: "none" } (not ours, let the key through), { kind: "pending", typed } or { kind: "go", id }.
 */
export function createSequencer({ table, leader = "g", timeoutMs = 1500, now = () => Date.now() }) {
  let armedAt = null; // when the last key of the sequence arrived
  let typed = ""; // keys after the leader so far
  const tableRef = () => (typeof table === "function" ? table() : table);
  const reset = () => {
    armedAt = null;
    typed = "";
  };
  return {
    isPending: () => armedAt !== null && now() - armedAt <= timeoutMs,
    typed: () => typed,
    cancel: reset,
    feed(key, { typing = false, modifier = false, shift = false, repeat = false } = {}) {
      if (typing || modifier) {
        reset();
        return { kind: "none" };
      }
      if (repeat) return { kind: armedAt === null ? "none" : "pending" };
      const k = String(key ?? "");
      const live = armedAt !== null && now() - armedAt <= timeoutMs;
      if (!live) {
        reset();
        if (k === leader && !shift) {
          armedAt = now();
          return { kind: "pending" };
        }
        return { kind: "none" };
      }
      if (k === "Escape" || shift || k.length !== 1) {
        reset();
        return { kind: "none" };
      }
      const next = typed + k.toLowerCase();
      const t = tableRef();
      if (next in t) {
        reset();
        return { kind: "go", id: t[next] };
      }
      if (Object.keys(t).some((code) => code.startsWith(next))) {
        typed = next;
        armedAt = now();
        return { kind: "pending" };
      }
      reset();
      return { kind: "none" };
    },
  };
}

// ───────────────────────── palette vocabulary ─────────────────────────

/** Extra words people may type to find a page, by page id (the palette also searches the label, title and group). */
export const PAGE_KEYWORDS = Object.freeze({
  home: "overview dashboard start welcome",
  accounts: "brokers broker login connect sessions zerodha angel upstox",
  console: "test try request api call endpoint",
  limits: "rate limit usage quota throttle",
  scanner: "scan screener condition rsi universe",
  orders: "order positions tickets confirm paper trade",
  safety: "kill switch risk daily limit halt live trading",
  keys: "api key token access scope",
  integrations: "webhook python excel claude chatgpt amibroker setup",
  activity: "log audit requests history",
  chain: "option chain calls puts ce pe strike oi iv ltp",
  oi: "open interest pcr put call ratio max pain walls",
  gex: "gamma exposure dealer flip gex",
  skew: "iv implied volatility skew smile surface term",
  payoff: "strategy payoff pnl breakeven legs straddle strangle condor spread",
  calculators: "calculator greeks delta theta vega position size risk lots black scholes",
  futures: "future basis carry premium synthetic rollover",
  flows: "fii dii fpi institutions cash flow buying selling",
  expiry: "expiry day straddle max pain walls countdown theta",
  oichange: "oi change spurts buildup unwinding long short",
  strategies: "strategy finder templates iron condor bull bear view",
  greeksgrid: "greeks grid delta gamma theta vega straddle history",
  alerts: "alert rules notify pcr iv basis trigger",
  positions: "positions greeks exposure lot split planner portfolio",
  unusual: "unusual options activity flow uoa scanner big premium volume oi spike whale sweep",
  tide: "market tide net premium flow call put sentiment bullish bearish",
  exposure: "greek exposure delta gamma vanna charm gex oi explorer heatmap walls zero gamma",
  screener: "contract screener filter vol stats iv rank hv deals block bulk insiders events calendar nse",
});

/** Pages whose content is data only, so re-running their loader on a timer is safe (no forms or half-typed input). */
export const AUTO_REFRESH_PAGES = Object.freeze(["home", "limits", "orders", "activity", "chain", "oi", "gex", "skew", "futures", "flows", "expiry", "oichange", "greeksgrid", "unusual", "tide", "exposure"]);
export const isAutoRefreshable = (id) => AUTO_REFRESH_PAGES.includes(id);

/**
 * Pages built around a form (their own inputs, drafts or results the person is working on). Changing the context bar
 * must not re-run their loader: they keep their state and just read the new context when the person next runs them.
 * Every other page is a data page and is redrawn with the new context.
 */
export const FORM_PAGES = Object.freeze(["payoff", "calculators", "strategies", "alerts", "positions"]);
export const isFormPage = (id) => FORM_PAGES.includes(id);
/** The page on screen (set by chrome.js), so shared controls can tell a form page from a data page. */
export const nowShowing = { id: null };

// ───────────────────────── auto-refresh ─────────────────────────

export const REFRESH_CHOICES = Object.freeze([
  { ms: 0, label: "Auto-refresh off", short: "Off" },
  { ms: 5000, label: "Every 5s", short: "5s" },
  { ms: 15000, label: "Every 15s", short: "15s" },
  { ms: 30000, label: "Every 30s", short: "30s" },
  { ms: 60000, label: "Every 1m", short: "1m" },
]);
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * The wait before the next automatic refresh. After `failures` failed runs in a row the wait doubles each time (capped at
 * five minutes); a server-given Retry-After (ms) is honoured when it asks for longer. Pure.
 */
export function backoffDelay(baseMs, failures = 0, retryAfterMs = 0) {
  if (failures <= 0) return baseMs;
  const doubled = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(failures, 8));
  const asked = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, 2 * MAX_BACKOFF_MS) : 0;
  return Math.max(doubled, asked);
}

/**
 * Schedules a page's loader on a cadence. Guarantees:
 *  - runs never overlap: the next wait starts only after the current run has finished (and a tick that finds a run or a
 *    manual load in flight just waits again);
 *  - nothing runs while the tab is hidden: the timer is dropped, and on return the run is made at once if it is due;
 *  - a failed run (it throws, or returns { ok: false, status?, retryAfterMs? }) backs off, 429 included;
 *  - `eligible: false` (a page with forms) stops the timer without forgetting the chosen cadence.
 * `run()` resolves { ok: true } (or nothing) on success. Timers and the clock are injectable for tests.
 */
export function createRefresher({ run, onState = () => {}, canRun = () => true, isHidden = () => false, now = () => Date.now(), timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }, store = safeStore("local") }) {
  let intervalMs = Number(store.get(SLOTS.refresh)) || 0;
  if (!REFRESH_CHOICES.some((c) => c.ms === intervalMs)) intervalMs = 0;
  let eligible = true;
  let timer = null;
  let inFlight = false;
  let failures = 0;
  let retryAfterMs = 0;
  let dueAt = null;
  let lastOkAt = null;
  let lastAttemptAt = null;
  let lastError = null;
  const status = () => (!intervalMs ? "off" : !eligible ? "unavailable" : isHidden() ? "paused" : inFlight ? "running" : failures ? "backoff" : "idle");
  const snapshot = () => ({ intervalMs, status: status(), failures, dueAt, lastOkAt, lastError, eligible });
  const emit = () => {
    try {
      onState(snapshot());
    } catch {
      /* a broken listener must not stop the loop */
    }
  };
  const stopTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  /** Plan the next run `delay` ms from now (default: the cadence, or the backoff wait after failures). */
  const schedule = (delay) => {
    stopTimer();
    if (!intervalMs || !eligible || isHidden()) {
      dueAt = null;
      emit();
      return;
    }
    const wait = delay ?? backoffDelay(intervalMs, failures, retryAfterMs);
    dueAt = now() + wait;
    timer = timers.set(tick, wait);
    emit();
  };
  async function tick() {
    timer = null;
    if (!intervalMs || !eligible || isHidden()) return schedule();
    if (inFlight || !canRun()) return schedule(Math.min(intervalMs, 3000)); // something else is loading or being typed: wait again, never stack
    inFlight = true;
    lastAttemptAt = now();
    emit();
    let result = null;
    try {
      result = (await run()) ?? { ok: true };
    } catch (err) {
      result = { ok: false, status: err?.status, retryAfterMs: err?.retryAfterMs, error: err };
    }
    inFlight = false;
    if (result.ok === false) {
      failures += 1;
      retryAfterMs = result.status === 429 ? Math.max(Number(result.retryAfterMs) || 0, intervalMs * 2) : Number(result.retryAfterMs) || 0;
      lastError = { status: result.status ?? null, message: result.error?.message ?? null };
    } else {
      failures = 0;
      retryAfterMs = 0;
      lastError = null;
      lastOkAt = now();
    }
    schedule();
  }
  return {
    snapshot,
    get intervalMs() {
      return intervalMs;
    },
    /** Choose a cadence (0 = off). Starts the first wait from now. */
    setInterval(ms) {
      intervalMs = REFRESH_CHOICES.some((c) => c.ms === Number(ms)) ? Number(ms) : 0;
      store.set(SLOTS.refresh, intervalMs ? String(intervalMs) : null);
      failures = 0;
      retryAfterMs = 0;
      schedule();
    },
    /** The page changed: `ok` says whether the new page may be refreshed on a timer. */
    pageChanged(ok) {
      eligible = Boolean(ok);
      failures = 0;
      retryAfterMs = 0;
      schedule();
    },
    /** A load just finished by other means (page opened, Reload pressed): wait a whole cadence from now. */
    loaded() {
      if (inFlight) return;
      failures = 0;
      retryAfterMs = 0;
      lastOkAt = now();
      lastAttemptAt = now();
      schedule();
    },
    /** Call from visibilitychange. */
    visibilityChanged() {
      if (isHidden()) {
        stopTimer();
        emit();
        return;
      }
      if (!intervalMs || !eligible || inFlight) return emit();
      // Back on screen: run at once if a run came due while hidden, otherwise wait out the rest of the cadence.
      const wait = backoffDelay(intervalMs, failures, retryAfterMs);
      const due = dueAt ?? (lastAttemptAt === null ? null : lastAttemptAt + wait);
      schedule(due === null ? wait : Math.max(0, due - now()));
    },
    dispose() {
      stopTimer();
    },
  };
}

// ───────────────────────── small formatters ─────────────────────────

/** hh:mm:ss in IST for the "updated" stamp. Pure. */
export function stampText(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ───────────────────────── the one instance of each, shared by every module ─────────────────────────

export const workspace = createContext();
export const navState = createNavState();
export const recents = createRecents();
export const density = createDensity();
