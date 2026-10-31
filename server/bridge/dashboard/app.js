// Mr. Chartist API Bridge — local dashboard. Talks only to this Bridge (same origin). The API key lives in
// sessionStorage for this tab and is sent as a Bearer header; it is never put in a URL.
// Opened from `mc-bridge start --open` or `mc-bridge open`, the URL carries a one-time sign-in code in its fragment
// (#signin=<code>): it is removed from the address bar before anything else and exchanged for a key (POST /v1/sign-in).
// Pure helpers (ticketFields, confirmCodeNotice, friendlyError ...) are exported for tests; DOM code runs only in a browser.

import { animateNav, animatePage, bannerIn, bannerOut, installAutoAnimations, pulse, reducedMotion, sheetIn, sheetOut, shake } from "./motion.js";
import { DASH, ageText, formatRupee } from "./format.js";
import { DENSITY_SLOT, SIDEBAR_SLOT, parseDensity, resolveDensity, resolveSidebar, toggleSidebar } from "./layout-prefs.js";
import { watch as liveWatch } from "./live.js";

// Page hooks for views.js (optional: app.js start-up already runs them automatically; both are idempotent).
export { animateNav, animatePage };

const KEY_SLOT = "mcb.dashboard.key";

// ── One-time sign-in link ──

/**
 * The sign-in code in a URL fragment (#signin=<code>), or null when there is none. Whatever follows signin= is
 * returned as it is (the Bridge refuses a malformed code with the same answer as a used one). Pure.
 * @param {string} hash  location.hash
 */
export function signInCodeFromHash(hash) {
  const m = /^#\/?signin=([^&]*)/.exec(String(hash ?? ""));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Label of the keys POST /v1/sign-in creates (server/bridge/auth/module.mjs). */
export const SIGN_IN_KEY_LABEL = "Dashboard sign-in";
/** The message shown when a sign-in link does not work (the Bridge says the same). */
export const SIGN_IN_FAILED = { title: "This sign-in link did not work", detail: "This sign-in link has expired or was already used. Open the Bridge again from its shortcut, or run mc-bridge open." };

/**
 * Exchange a sign-in code for a key. Never throws. Pure apart from the injected fetch.
 * @param {string} code @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ key: string } | { error: { title: string, detail: string } | { network: true } }>}
 */
export async function redeemSignIn(code, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl("/v1/sign-in", { method: "POST", headers: { "Content-Type": "application/json", "X-MCB-Client": "dashboard" }, body: JSON.stringify({ code }), cache: "no-store" });
  } catch {
    return { error: { network: true } };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && typeof body?.data?.key === "string") return { key: body.data.key };
  // Show the Bridge's own words (expired or used, too many attempts, only from this computer) when it gave any.
  return { error: { title: SIGN_IN_FAILED.title, detail: typeof body?.detail === "string" && body.detail ? body.detail : SIGN_IN_FAILED.detail } };
}

/**
 * Take the sign-in code out of the address bar at once (history.replaceState, so it is not kept in history either)
 * and return it, or null when the page was opened without one.
 */
function takeSignInCode() {
  if (typeof location === "undefined" || typeof history === "undefined") return null;
  const code = signInCodeFromHash(location.hash);
  if (code === null) return null;
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  } catch {
    location.hash = "";
  }
  return code;
}
// First thing in the browser, before any other code runs or the page is drawn.
const pendingSignInCode = takeSignInCode();
const THEME_SLOT = "mcb.dashboard.theme";

// ── Storage (wrapped: private windows and blocked storage must not break the page) ──

export function store(kind = "local") {
  const get = () => {
    try {
      return kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(k) {
      try {
        return get()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null || v === undefined) get()?.removeItem(k);
        else get()?.setItem(k, v);
      } catch {
        /* storage blocked: keep going without it */
      }
    },
  };
}
const session = store("session");
const local = store("local");
/** Set by "Sign out" in this tab, so the page does not sign itself straight back in on this computer. */
const NO_AUTO_SLOT = "mcb.dashboard.noAutoSignIn";
// A key from a typed key or a sign-in link lives in this tab; one from signing in on this computer is remembered in
// this browser (it expires on the Bridge after 30 days, and "Sign out" forgets it).
let memoryKey = session.get(KEY_SLOT) ?? local.get(KEY_SLOT);

/**
 * The page module the address opens with (pure): the Options desk, screeners, calendar, recorder or live events load
 * on demand (views.js); fetching the one this tab opens on alongside views.js saves a round of loading on a cold start.
 */
export function bootModuleFor(hash) {
  const page = String(hash ?? "").replace(/^#\/?/, "").split(/[/?]/)[0].toLowerCase();
  if (["chain", "strategy", "positions", "oi", "vol"].includes(page)) return "./desk.js";
  if (page === "screeners") return /^#\/?screeners\/events/.test(hash) ? "./events.js" : /^#\/?screeners\/stocks/.test(hash) ? null : /^#\/?screeners\/arbitrage/.test(hash) ? "./desk.js" : "./screener.js";
  if (page === "calendar") return "./calendar.js";
  if (page === "recorder") return "./recorder.js";
  return null;
}
if (typeof location !== "undefined" && memoryKey) {
  const mod = bootModuleFor(location.hash);
  if (mod) import(mod).catch(() => {});
}

/** @param {string|null} k @param {{ remember?: boolean }} [o]  remember: keep it in this browser, not only this tab */
export function setKey(k, { remember = false } = {}) {
  memoryKey = k || null;
  session.set(KEY_SLOT, memoryKey);
  if (!memoryKey || remember) local.set(KEY_SLOT, memoryKey);
}

/** True when the page is opened by a loopback address (the Bridge's own computer). Pure apart from the default. */
export const onLoopbackHost = (hostname = typeof location !== "undefined" ? location.hostname : "") => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(String(hostname));

/**
 * Sign the dashboard in on the Bridge's own computer, without a key (POST /v1/sign-in/local). Never throws.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ key: string } | { error: { title: string, detail: string } | { network: true } }>}
 */
export async function signInLocal(fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl("/v1/sign-in/local", { method: "POST", headers: { "X-MCB-Client": "dashboard" }, cache: "no-store", credentials: "same-origin" });
  } catch {
    return { error: { network: true } };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && typeof body?.data?.key === "string") return { key: body.data.key };
  return { error: { title: "Could not sign in on this computer", detail: typeof body?.detail === "string" && body.detail ? body.detail : "Use an API key instead, or open the Bridge again from its shortcut." } };
}
export const currentKey = () => memoryKey;

// ── Errors in plain words ──

/**
 * A short, helpful message for an API error (problem+json code) or a network failure. Pure.
 * @param {{ status?: number, code?: string, message?: string, network?: boolean }} err
 * @returns {{ title: string, detail: string }}
 */
export function friendlyError(err) {
  const detail = err?.message ?? "";
  if (err?.network) return { title: "Cannot reach the Bridge", detail: "Is it still running? Start it again from its shortcut (or the start file you double-clicked), then refresh this page." };
  switch (err?.code) {
    case "UNAUTHENTICATED":
      return { title: "That key was not accepted", detail: "It may be mistyped, expired or revoked, or made by another Bridge (each Bridge only accepts its own keys). To sign in without a key, run npm run dev in the Bridge folder (demo mode) or npm run bridge -- open while it runs; or create one with: npm run bridge -- keys create --label me --scope admin,paper" };
    case "SCOPE_REQUIRED":
      return { title: "This key is not allowed to do that", detail: `${detail} Sign in with an admin key to manage the Bridge.` };
    case "LOOPBACK_ONLY":
      return { title: "Only from this computer", detail: "This page manages keys and accounts, so it works only at http://127.0.0.1 on the computer running the Bridge." };
    case "SESSION_EXPIRED":
      return { title: "Broker session expired", detail: `${detail} Log in again: Accounts page, Log in.` };
    case "BROKER_UNAVAILABLE":
    case "NO_ACCOUNT":
      return { title: "No broker connected for this", detail: `${detail} Add your broker and log in on the Accounts page, or try everything with sample data in demo mode.` };
    case "ACCOUNT_FORBIDDEN":
      return { title: "This key cannot do that", detail };
    case "UPSTREAM_ERROR":
      return { title: "The broker did not accept this", detail };
    case "UPSTREAM_TIMEOUT":
      return { title: "The broker did not answer", detail: `${detail} Check your internet connection and try again in a moment.` };
    case "RATE_LIMITED":
    case "UPSTREAM_RATE_LIMITED":
      return { title: "Slow down a little", detail: `${detail} The Bridge is keeping you inside the broker's limits; try again in a moment.` };
    case "KILL_SWITCH_ENGAGED":
      return { title: "The kill switch is on", detail: "No orders are sent until an admin releases it on the Safety page." };
    case "SYMBOL_NOT_FOUND":
      // Most often the contract list is simply not loaded yet: it comes from a broker you are logged in to.
      return { title: "Symbol not found", detail: `${detail} If you have not logged in to your broker today, log in on Accounts: the contract list comes from your broker. Symbols look like NSE:RELIANCE or NFO:NIFTY-2026-10-27-25000-CE.` };
    case "VALIDATION_FAILED":
      return { title: "Please check the form", detail };
    case "INVALID_ORDER":
      return { title: "The order was refused", detail };
    case "NOT_IMPLEMENTED":
      return { title: "Not available yet", detail };
    default:
      return { title: err?.status ? `The Bridge answered ${err.status}` : "Something went wrong", detail };
  }
}

// ── API ──

export class ApiError extends Error {
  constructor(message, { status, code, network = false, body } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.network = network;
    this.body = body;
  }
}

/**
 * The last transient failure (network, 429 or 5xx) seen by api(), numbered. Auto-refresh compares `seq` before and
 * after a page reload to learn whether it should back off (pages draw their own error boxes and do not throw).
 */
export const apiHealth = { seq: 0, failure: null };
const noteFailure = (status, retryAfterMs = 0) => {
  apiHealth.failure = { seq: ++apiHealth.seq, status: status ?? null, retryAfterMs };
};
const noteStatus = (res) => {
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get("retry-after"));
    noteFailure(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
  }
};

// ── The shared fetch layer ──
//
// Every page reads through api(). For GET it adds three things, so pages that ask for the same data share it:
//  1. one request per URL at a time: a second caller of a URL already on its way waits for the same answer;
//  2. a short memory of answers (SHARE_MS): parts of a page and other pages asking within a moment get the same one;
//  3. paint from memory on a page switch: during the first moments after a switch (beginNavigation), an answer up to
//     PAINT_FROM_CACHE_MS old is used at once and a fresh one is fetched behind it; pages that show market data label
//     it with its own data time, and onRevalidated() lets the router redraw the other pages when the fresh one differs.
// Never from memory: one-time and audit reads, and states a person acts on (safety, tickets, order preview). Any
// write (POST, PUT, PATCH, DELETE) forgets every remembered answer, so what follows an order is always fresh.

/** Answers shared between callers asking within this many ms. */
export const SHARE_MS = 1000;
/** On a page switch, an answer up to this old paints at once while a fresh one is fetched. */
export const PAINT_FROM_CACHE_MS = 30_000;
/** How long after a page switch its first reads may paint from memory. */
export const NAV_WINDOW_MS = 2500;
/** A prefetched answer serves the next ask for this long. */
export const PREFETCH_USE_MS = 4000;
const CACHE_MAX = 300;
/** GETs never answered from memory (one-time, audit, safety-critical or diagnostics). */
const NO_CACHE_RE = /^\/v1\/(stream\/token|sign-in|requests|audit|safety|tickets|orders\/preview|readiness|limits|usage)(\/|\?|$)/;
/** Market reads that take ?priority=background when prefetched (a click on the same thing raises it). */
const MARKET_RE = /^\/v1\/(optionchain|quotes|ltp|expiries|depth|history)\?/;

/** POSTs that read or start something and change no state the pages show: they keep the remembered answers. */
const READ_LIKE_POST_RE = /^\/v1\/(stream\/token|sign-in|orders\/preview|margin\/preview|readiness\/check|scanner\/plan|reference\/corporate-actions\/preview|studies\/compute|paper\/accounts\/[^/]+\/margin|strategy\/(price|payoff|preview))(\/|\?|$)/;
/**
 * Whether a write may change what the remembered answers say (pure). A dry run (body `dryRun: true`, such as Cancel
 * all's count on the Orders page) changes nothing.
 */
export const forgetsAnswers = (method, path, body) => method !== "GET" && !READ_LIKE_POST_RE.test(String(path)) && !(method === "POST" && body?.dryRun === true);
/** Writes so far that forgot the remembered answers: an answer a page keeps itself is good until this moves. */
let writes = 0;
export const writeCount = () => writes;

/** Whether a GET path may be remembered (pure). */
export const cacheable = (path) => typeof path === "string" && path.startsWith("/v1/") && !NO_CACHE_RE.test(path);

/**
 * May a remembered answer of this age be used now (pure)? Shared answers are always fine; older ones only while a page
 * is switching in. @returns {"fresh"|"paint"|null}
 */
export function cacheUse(ageMs, navigating) {
  if (!(ageMs >= 0)) return null;
  if (ageMs <= SHARE_MS) return "fresh";
  if (navigating && ageMs <= PAINT_FROM_CACHE_MS) return "paint";
  return null;
}

const answers = new Map(); // path -> { at, ok, status, ct, text, headers }
const inflight = new Map(); // path -> Promise<answer>
const routeReads = new Map(); // page -> Set<path> read while it switched in (what to prefetch on hover)
const revalidatedListeners = new Set();
let navUntil = 0;
let navPage = null;

/** The router calls this when a page starts to render: its first reads may paint from memory. */
export function beginNavigation(page) {
  navPage = typeof page === "string" ? page : null;
  navUntil = performance.now() + NAV_WINDOW_MS;
}
/** Call fn(path) when an answer painted from memory was refreshed and came back different. */
export function onRevalidated(fn) {
  revalidatedListeners.add(fn);
  return () => revalidatedListeners.delete(fn);
}

function remember(path, a) {
  answers.delete(path);
  answers.set(path, a);
  if (answers.size > CACHE_MAX) answers.delete(answers.keys().next().value);
}

/** One network GET per path at a time; ok answers are remembered. */
function fetchShared(path, { headers, priority = null } = {}) {
  const running = inflight.get(path);
  if (running) return running;
  const url = priority === "background" && MARKET_RE.test(path) ? `${path}&priority=background` : path;
  const p = (async () => {
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(url, { headers });
    } catch {
      noteFailure(null);
      throw new ApiError("The Bridge did not answer.", { network: true });
    }
    noteStatus(res);
    const a = { at: Date.now(), ok: res.ok, status: res.status, ct: res.headers.get("content-type") ?? "", text: await res.text(), headers: res.headers, ms: Math.round(performance.now() - t0), prefetched: priority === "background" };
    if (a.ok && cacheable(path)) remember(path, a);
    return a;
  })().finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

function baseHeaders(page = navPage) {
  const headers = { Authorization: `Bearer ${memoryKey}`, "X-MCB-Client": "dashboard" };
  // Which page asked (the Bridge credits its broker calls to it on API › Rate limits).
  if (page && /^[a-z-]{2,20}$/.test(page)) headers["X-MCB-Page"] = page;
  return headers;
}

/** An answer as api() returns it: parsed afresh for each caller, so no page can change another page's data. */
function toResult(a, { raw, ms }) {
  let data = a.text;
  if (a.ct.includes("json") && a.text) {
    try {
      data = JSON.parse(a.text);
    } catch {
      /* leave as text */
    }
  }
  if (!a.ok && !raw) {
    // problem+json (detail / title), or a proxy's or broker's own shape ({ error: { message } }, { message }).
    const said = data?.detail ?? data?.title ?? (typeof data?.error === "string" ? data.error : data?.error?.message) ?? data?.message;
    throw new ApiError(typeof said === "string" && said ? said : `HTTP ${a.status}`, { status: a.status, code: data?.code ?? data?.error?.code, body: data });
  }
  return { data, headers: a.headers, status: a.status, ms, text: a.text };
}

/** Fetch `path` again behind an answer painted from memory; tell the router when it changed. */
function revalidate(path, served) {
  fetchShared(path, { headers: baseHeaders() })
    .then((a) => {
      if (a.ok && a.text !== served.text) for (const fn of revalidatedListeners) fn(path);
    })
    .catch(() => {});
}

/**
 * Call the Bridge. Returns { data, headers, status, ms, text, cached? }. With raw: true, error answers are returned
 * too (and nothing is shared or remembered: the test console shows the real call). `fresh: true` skips the memory.
 * `paintOld: true` treats this read like a page switch: a remembered answer up to PAINT_FROM_CACHE_MS old (a
 * prefetch, say) is returned at once with `cached: "paint"` while a fresh one is fetched behind it (the caller reads
 * again to get it; the second read joins that request).
 */
export async function api(path, { method = "GET", body, raw = false, fresh = false, paintOld = false } = {}) {
  const headers = baseHeaders();
  if (method !== "GET" || raw) {
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const forget = forgetsAnswers(method, path, body);
    if (forget) {
      answers.clear();
      writes += 1;
    }
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      noteFailure(null);
      throw new ApiError("The Bridge did not answer.", { network: true });
    }
    noteStatus(res);
    const a = { ok: res.ok, status: res.status, ct: res.headers.get("content-type") ?? "", text: await res.text(), headers: res.headers };
    if (forget) {
      answers.clear();
      writes += 1;
    }
    return toResult(a, { raw, ms: Math.round(performance.now() - t0) });
  }
  const navigating = performance.now() < navUntil;
  if (navigating && navPage && cacheable(path)) {
    let reads = routeReads.get(navPage);
    if (!reads) routeReads.set(navPage, (reads = new Set()));
    if (reads.size < 16) reads.add(path);
  }
  noteRead(path);
  if (!fresh && cacheable(path)) {
    const hit = answers.get(path);
    const age = hit ? Date.now() - hit.at : NaN;
    // A prefetched answer (the expiry chip under the pointer) serves the click that follows it for a few seconds.
    const use = hit ? cacheUse(age, navigating || paintOld) ?? (hit.prefetched && age <= PREFETCH_USE_MS ? "fresh" : null) : null;
    if (use) {
      hit.prefetched = false; // a prefetch serves one ask; the page's own refreshes go to the Bridge
      if (use === "paint") revalidate(path, hit);
      return { ...toResult(hit, { raw, ms: 0 }), cached: use };
    }
  }
  const t0 = performance.now();
  const a = await fetchShared(path, { headers });
  const out = toResult(a, { raw, ms: Math.round(performance.now() - t0) });
  const held = positionSymbols(path, out.data);
  if (held) noteRead(path, { symbols: held, mode: "ltp", update: true });
  return out;
}

// ── Polls become stream subscriptions ──
// A page that reads the same /v1/quotes or /v1/ltp URL again within AUTO_WATCH_MS is polling: its symbols are then
// watched on the shared live connection (live.js) until it stops, so the Bridge answers the next polls from ticks
// instead of the broker. Positions, Home, Strategy and the screeners get this without knowing about it.
export const AUTO_WATCH_MS = 15_000;
const AUTO_WATCH_MAX = 400;
const AUTO_WATCH_RE = /^\/v1\/(quotes|ltp)\?(?:[^#]*&)?symbols=([^&#]+)/;
const autoWatches = new Map(); // path -> { seen, handle, timer, n }
let autoWatched = 0;

/** The symbols and stream mode of a polled read, or null (pure). */
export function pollTarget(path) {
  const m = AUTO_WATCH_RE.exec(String(path));
  if (!m) return null;
  let raw = m[2];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return symbols.length ? { symbols, mode: m[1] === "quotes" ? "quote" : "ltp" } : null;
}

/**
 * The open positions' symbols in a /v1/positions answer (pure): a page polling positions (the chain, OI and Strategy
 * read them every few seconds for held lots and delta) has them watched too, so the Bridge marks them to market from
 * ticks instead of a broker read per poll. Null for any other path.
 */
export function positionSymbols(path, body) {
  if (!/^\/v1\/positions(?:\?|$)/.test(String(path))) return null;
  const rows = Array.isArray(body?.data) ? body.data : [];
  const out = new Set();
  for (const p of rows) if (typeof p?.symbol === "string" && Number(p.netQty)) out.add(p.symbol);
  return [...out].slice(0, 100);
}

function noteRead(path, target = pollTarget(path)) {
  if (!target || typeof window === "undefined") return;
  const now = Date.now();
  const w = autoWatches.get(path);
  if (!w) {
    autoWatches.set(path, { seen: now, handle: null, timer: null, n: 0 });
    return;
  }
  if (w.handle && target.update && now - w.seen <= AUTO_WATCH_MS) {
    // Positions change (a fill, a close): follow them, within the same cap.
    const extra = target.symbols.length - w.n;
    if (autoWatched + extra <= AUTO_WATCH_MAX) {
      w.handle.update(target.symbols);
      autoWatched += extra;
      w.n = target.symbols.length;
    }
  } else if (!w.handle && now - w.seen <= AUTO_WATCH_MS && target.symbols.length && autoWatched + target.symbols.length <= AUTO_WATCH_MAX) {
    w.n = target.symbols.length;
    autoWatched += w.n;
    w.handle = liveWatch(target.symbols, target.mode, () => {});
  }
  w.seen = now;
  clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    w.handle?.stop();
    if (w.handle) autoWatched -= w.n;
    autoWatches.delete(path);
  }, AUTO_WATCH_MS);
}

/**
 * Warm what a page reads before it is opened (menu hover or focus): its reads from the last visit that are not
 * remembered already, market data at background priority. Never more than one request per path.
 */
export function prefetchPage(page) {
  const reads = routeReads.get(page);
  if (!reads) return;
  for (const path of reads) prefetch(path);
}

/**
 * Warm one GET a person is about to ask for (an expiry chip under the pointer): fetched once at background priority
 * unless an answer under 5 s old is remembered; a click on it then paints from memory (the page-switch window) or joins
 * the request already on its way.
 */
export function prefetch(path) {
  if (!memoryKey || !cacheable(path)) return;
  const hit = answers.get(path);
  if (hit && Date.now() - hit.at <= 5000) return;
  fetchShared(path, { headers: baseHeaders("prefetch"), priority: "background" }).catch(() => {});
}
export const optional = (p) => p.then((r) => r, (error) => ({ error }));

// ── DOM helpers ──

/** h("div", { class: "x", onclick }, child, "text") */
export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** Icons: small stroked SVGs (static strings from this file). */
export const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  accounts: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
  console: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m6.5 9 3 3-3 3"/><path d="M12 15h5"/>',
  scan: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6"/><path d="M11 8v6"/>',
  limits: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/><circle cx="12" cy="14" r="1.5"/>',
  orders: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/><path d="m15 8 2 2"/>',
  integrations: '<path d="M9 7H6a3 3 0 0 0 0 6h3"/><path d="M15 7h3a3 3 0 0 1 0 6h-3"/><path d="M8 10h8"/><path d="M12 13v8"/>',
  safety: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v6H4V5h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  minus: '<path d="M5 12h14"/>',
  remove: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  add: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  strategy: '<path d="M3 17h5l4-10 4 10h5"/><path d="M3 21h18"/>',
  bars: '<path d="M4 20V10M9 20V4M14 20v-7M19 20V8"/>',
  wave: '<path d="M3 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0"/><path d="M3 20h18"/>',
  scale: '<path d="M12 4v16M5 20h14M4 8h16"/><path d="m4 8-2.5 6h5zM20 8l-2.5 6h5z"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.3c3 .2 5.5 2.3 5.5 5.7"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d="m15 10-2 2 2 2"/>',
  rail: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d="m13 10 2 2-2 2"/>',
  density: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18.4 5.6"/><circle cx="15.5" cy="9.5" r="1.1"/>',
};
export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.innerHTML = ICONS[name] ?? "";
  return s;
}

/**
 * The coloured squircle behind an icon (IPO Decode's IconTile, Settings-style). `tint` is an iOS system colour name
 * (blue, green, red, orange, indigo, purple, pink, teal, mint, gray); `size` is "sm" (28), "md" (32) or "lg" (44).
 */
export function iconTile(name, tint = "blue", size = "md") {
  return h("span", { class: `icon-tile tint-${tint} tile-${size}`, "aria-hidden": "true" }, icon(name));
}

/** A HUD confirmation in #toast (one at a time; a new one replaces the old). views.js may hide it with `$("toast").hidden = true`. */
export function toast(text, { tone = "ok" } = {}) {
  const t = document.getElementById("toast");
  const gen = (toast.gen = (toast.gen ?? 0) + 1);
  const wasHidden = t.hidden;
  // Tones: "ok" a done action (green check); "info" a refused or not-yet-possible action (neutral ⓘ); "warn" a caution
  // (amber !); "error" a failure (red !, read out at once, stays a little longer). Never the green check for a problem.
  const kind = TOAST_TONES.has(tone) ? tone : "ok";
  const glyph = kind === "ok" ? "check" : kind === "info" ? "info" : "warn";
  t.dataset.tone = kind;
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  t.replaceChildren(h("span", { class: `toast-icon${kind === "ok" ? "" : ` ${kind}`}` }, icon(glyph)), h("span", { class: "toast-text" }, text));
  t.hidden = false;
  raiseToast(t);
  placeToast(t);
  if (wasHidden) bannerIn(t);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    // Hide after sliding out, unless another toast took over meanwhile.
    bannerOut(t).then(() => {
      if (toast.gen === gen) t.hidden = true;
    });
  }, kind === "error" || kind === "warn" ? 4200 : 2600);
}
const TOAST_TONES = new Set(["ok", "info", "warn", "error"]);

const TOAST_CONTROLS = "button, a[href], input, select, textarea, summary, [role=tab], [role=button]";

/** How many visible controls the toast's box (plus a 4px margin) overlaps. */
function toastCovers(t) {
  const r = t.getBoundingClientRect();
  if (!r.width || typeof document.elementsFromPoint !== "function") return 0;
  const [l, top, rt, b] = [r.left - 4, r.top - 4, r.right + 4, r.bottom + 4];
  let n = 0;
  for (const c of document.querySelectorAll(TOAST_CONTROLS)) {
    if (t.contains(c)) continue;
    const q = c.getBoundingClientRect();
    if (!q.width || q.right <= l || q.left >= rt || q.bottom <= top || q.top >= b) continue;
    // Count it only where it is really on top there (not under a sheet, scrolled out or clipped by its panel).
    const x = (Math.max(l, q.left) + Math.min(rt, q.right)) / 2;
    const y = (Math.max(top, q.top) + Math.min(b, q.bottom)) / 2;
    const under = document.elementsFromPoint(x, y).find((e) => !t.contains(e));
    if (under && (under === c || c.contains(under))) n++;
  }
  return n;
}

/**
 * The control the person used last (pointer or key), so a toast never lands on it: a slider dragged on Strategy, the
 * button just pressed. Kept for 4s; after that only the count of covered controls decides.
 */
let lastUsed = null;
let lastUsedAt = 0;
if (typeof document !== "undefined") {
  const note = (e) => {
    const c = e.target?.closest?.(TOAST_CONTROLS);
    if (!c || c.closest?.("#toast")) return;
    lastUsed = c;
    lastUsedAt = Date.now();
  };
  document.addEventListener("pointerdown", note, true);
  document.addEventListener("keydown", note, true);
  document.addEventListener("input", note, true);
}
function coversLast(t) {
  if (!lastUsed?.isConnected || Date.now() - lastUsedAt > 4000) return false;
  const r = t.getBoundingClientRect();
  const q = lastUsed.getBoundingClientRect();
  return r.width > 0 && q.width > 0 && !(q.right <= r.left - 4 || q.left >= r.right + 4 || q.bottom <= r.top - 4 || q.top >= r.bottom + 4);
}

/**
 * Where the toast goes. Wide screens: top centre under the toolbar (app.css), else the bottom right
 * ([data-place="low"]). Phones and tablets: bottom centre above the tab bar and any sticky bottom bar, else top centre
 * under the toolbar ([data-place="top"]). The other place is taken when the first covers the control just used, or
 * covers more controls; neither place ever reaches the tab bar.
 */
function placeToast(t) {
  delete t.dataset.place;
  const cost = () => (coversLast(t) ? 100 : 0) + toastCovers(t);
  const first = cost();
  if (!first) return;
  t.dataset.place = window.matchMedia?.("(min-width: 1024px)").matches ? "low" : "top";
  if (cost() >= first) delete t.dataset.place;
}

/**
 * The toast is a manual popover (index.html): re-showing it makes it the newest top-layer entry, so it sits above an
 * open sheet or palette. Browsers without popovers keep the fixed --z-toast layer.
 */
function raiseToast(t) {
  if (typeof t.showPopover !== "function") return;
  try {
    if (t.matches(":popover-open")) t.hidePopover();
    t.showPopover();
  } catch {
    /* not in the document, or popovers unsupported: the CSS layer still shows it */
  }
}

export async function copyText(text, label = "Copied") {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", {}, text);
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false; /* the person can still select the text */
    }
    ta.remove();
  }
  if (ok) toast(label);
  else toast("This browser blocked copying. Select the text and press Ctrl+C.", { tone: "warn" });
  return ok;
}

/** A Copy button that answers on itself too: "Copied" with a check for a moment, then back to its label. */
export function copyButton(getText, { label = "Copy", done = "Copied", toastLabel = "Copied", cls = "small copy", onCopy, ariaLabel } = {}) {
  const b = h("button", { type: "button", class: cls, ...(ariaLabel ? { "aria-label": ariaLabel } : {}) }, icon("copy"), label);
  b.addEventListener("click", async () => {
    const ok = await copyText(typeof getText === "function" ? getText() : getText, toastLabel);
    if (!ok) return;
    onCopy?.();
    clearTimeout(b._copiedTimer);
    b.dataset.copied = "true";
    b.replaceChildren(icon("check"), done);
    b._copiedTimer = setTimeout(() => {
      delete b.dataset.copied;
      b.replaceChildren(icon("copy"), label);
    }, 1800);
  });
  return b;
}

/** Highlight JSON text (escaped first, so nothing in the data is ever interpreted as HTML). Pure. */
export function highlightJson(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, lit, num) => {
    if (str) return colon ? `<span class="json-key">${str}</span>${colon}` : `<span class="json-str">${str}</span>`;
    if (lit) return `<span class="json-lit">${lit}</span>`;
    return `<span class="json-num">${num}</span>`;
  });
}

/**
 * A code block: a head row (title, Copy) above the code, so Copy never covers it; the code scrolls sideways instead of
 * wrapping mid-token. `onCopy` runs after copying (the welcome checklist listens).
 */
export function codeBlock(code, { title, json = false, onCopy } = {}) {
  const pre = h("pre", { tabindex: "0" });
  if (json) pre.innerHTML = highlightJson(code);
  else pre.textContent = code;
  const btn = copyButton(code, { onCopy, ariaLabel: title ? `Copy: ${title}` : "Copy" });
  return h("div", { class: "code-block" }, h("div", { class: "code-head" }, h("div", { class: "code-title" }, title ?? ""), btn), h("div", { class: "code" }, pre));
}

/**
 * A status pill. Colour is meaning: ok (green) and bad (red) are good / bad state, warn (orange) is caution or
 * awaiting, info (blue) is selected / in progress, demo (orange) marks sample data; no class (or accent) is neutral.
 */
export function pill(text, cls = "") {
  const state = cls === "ok" || cls === "bad" || cls === "warn";
  return h("span", { class: `pill ${cls}`.trim() }, state ? h("span", { class: "pdot", "aria-hidden": "true" }) : null, text);
}

/**
 * The one empty state: icon tile, title, one line and an action (a node or a list). `compact: true` is the in-card
 * variant (no icon tile, 16 px padding) for Options panels.
 */
export function emptyState(iconName, title, text, action, { compact = false } = {}) {
  return h(
    "div",
    { class: compact ? "empty compact" : "empty" },
    compact ? null : iconTile(iconName, "gray", "lg"),
    h("strong", {}, title),
    text ? h("p", {}, text) : null,
    action ? h("div", { class: "empty-acts" }, action) : null,
  );
}

// ── Shared states for the Options pages (PRD 08 §5): one look for loading, error, freshness ──

const mm = (q) => typeof matchMedia === "function" && matchMedia(q).matches;
/** True when the only pointer is a finger (no mouse or trackpad as well). */
export const touchOnly = () => mm("(pointer: coarse)") && !mm("(any-pointer: fine)");
/** "Tap" on touch-only screens, "Click" elsewhere (P4: phones never read "press B"). */
export const touchWord = () => (touchOnly() ? "Tap" : "Click");
/** A keyboard hint, only where there is a keyboard-class pointer: "" on touch-only screens. */
export const keyHint = (text) => (touchOnly() ? "" : text);

/**
 * Skeleton rows at the final row height (no layout shift when the data lands), with one screen-reader line. The
 * host panel should carry aria-busy while it shows. Static DOM: no timers.
 */
export function loadingState({ rows = 8, cols = 4, label = "Loading", height = null } = {}) {
  const el = h(
    "div",
    { class: "skel-state", role: "status" },
    h("span", { class: "sr-only" }, label),
    Array.from({ length: rows }, () => h("div", { class: "skel-row", "aria-hidden": "true" }, Array.from({ length: cols }, () => h("i")))),
  );
  if (height) el.style.setProperty("--skel-h", `${height}px`);
  return el;
}

/**
 * An error in plain words with Retry. Without data it sits in the panel body; with data kept (`lastGood`, an ISO
 * time) it is a slim bar at the top of the panel saying what is still shown.
 */
export function errorState(err, { onRetry = null, lastGood = null } = {}) {
  const f = err instanceof Error || err?.code || err?.network ? friendlyError(err) : { title: String(err?.title ?? err ?? "Something went wrong"), detail: err?.detail ?? "" };
  const auth = ["SESSION_EXPIRED", "UNAUTHENTICATED", "NO_ACCOUNT", "BROKER_UNAVAILABLE", "SYMBOL_NOT_FOUND"].includes(err?.code);
  const retry = onRetry ? h("button", { type: "button", class: "small err-retry", onclick: () => onRetry() }, icon("refresh"), "Retry") : null;
  if (lastGood) {
    // An answer without a known code: say what the server said ("Broker feed unavailable (503)"), not just its status.
    const said = typeof err?.message === "string" && err.message && !/^HTTP \d+$/.test(err.message) ? err.message.replace(/\.$/, "") : "";
    const what = said && f.title.startsWith("The Bridge answered") ? `${said} (${err.status})` : f.title;
    return h(
      "div",
      { class: "err-bar", role: "alert" },
      icon("warn"),
      h("span", { class: "err-text" }, h("strong", {}, `Couldn't refresh: ${what}.`), ` Showing ${istTime(lastGood)}.`),
      retry,
    );
  }
  return h(
    "div",
    { class: "err-state", role: "alert" },
    h("strong", {}, f.title),
    f.detail ? h("p", {}, f.detail) : null,
    h("div", { class: "empty-acts" }, retry, auth ? h("a", { href: "#/accounts", class: "err-link" }, "Log in on Accounts") : null),
  );
}

/**
 * The Options top bar's one live control: Live / Pause and data freshness in a single button (docs/design/foundation.md
 * §5.1). "● 08:52:24" while live, "Paused · 12 s old", "Stale · 45 s old", "Not updating · 2 min old",
 * "Market closed · 15:29:59". update() patches text nodes only; tick() pulses the dot once (one successful refresh).
 */
export function liveControl({ onToggle, refreshMs = 3000 } = {}) {
  const text = document.createTextNode("Waiting");
  const dot = h("span", { class: "live-dot", "aria-hidden": "true" });
  const glyph = h("span", { class: "live-glyph", "aria-hidden": "true" });
  const el = h("button", { type: "button", class: "live-ctl", "aria-keyshortcuts": "P", onclick: () => onToggle?.() }, dot, glyph, h("span", { class: "live-txt" }, text));
  let sig = "";
  let flip = false;
  return {
    el,
    update({ kind = "live", asOf = null, ageMs = null, source = null, live = true } = {}) {
      const t = istTime(asOf);
      const age = ageMs === null ? "" : ageText(ageMs);
      const words =
        kind === "error"
          ? `Not updating${age ? ` · ${age}` : ""}`
          : kind === "paused"
            ? `Paused${age ? ` · ${age}` : ""}`
            : kind === "stale"
              ? `Stale${age ? ` · ${age}` : ""}`
              : kind === "closed"
                ? `Market closed · ${t}`
                : asOf
                  ? t
                  : "Waiting";
      const s = `${kind}|${words}|${source}|${asOf}|${live}`;
      if (s === sig) return;
      sig = s;
      if (text.data !== words) text.data = words;
      // Live with no data yet: "Waiting" with a neutral dot (green would claim a live feed before the first load).
      el.dataset.kind = kind === "live" && !asOf ? "waiting" : kind;
      el.setAttribute("aria-pressed", String(live));
      glyph.replaceChildren(live ? "" : icon("pause"));
      const what = live ? `Live: refreshing every ${refreshMs / 1000} s. ${touchWord()} to pause${keyHint(" (P)")}` : `Paused. ${touchWord()} to resume${keyHint(" (P)")}`;
      el.title = [what, source ? `Data from ${source}` : "", asOf ? `${istDateTime(asOf)} IST` : ""].filter(Boolean).join(" · ");
      // The state word comes first, then what the data is, then the action: "Not updating, data 15 s old. Pause updates".
      const state = kind === "error" ? "Not updating" : kind === "stale" ? "Stale" : kind === "closed" ? "Market closed" : live ? "Live" : "Paused";
      const data = kind === "live" || kind === "closed" ? (asOf ? `data as of ${t}` : "waiting for data") : age ? `data ${age}` : "no data yet";
      el.setAttribute("aria-label", `${state}, ${data}. ${live ? "Pause" : "Resume"} updates`);
    },
    /** One ring pulse on the dot (re-added per successful refresh, never an endless loop). */
    tick() {
      flip = !flip;
      dot.classList.toggle("tick-a", flip);
      dot.classList.toggle("tick-b", !flip);
    },
  };
}

/**
 * Put the page's context (underlying, expiry, spot, account, live control) into the app toolbar's #toolbar-ctx slot.
 * `page` is the route that owns it: a render that finishes after the visitor has moved on mounts nothing.
 */
export function mountToolbarCtx(page, ...nodes) {
  const slot = typeof document !== "undefined" ? document.getElementById("toolbar-ctx") : null;
  if (!slot || document.documentElement.dataset.page !== page) return false;
  slot.replaceChildren(...nodes.flat().filter(Boolean));
  slot.hidden = false;
  return true;
}

/**
 * The toolbar pickers (underlying, expiry: a transparent native select over a `.ctx-pick` label) open a menu drawn
 * like the dashboard's popovers instead of the OS list, wherever a mouse or trackpad is used. Touch keeps the native
 * picker. The select stays the source of truth: a choice sets its value and fires "change", so pages need no wiring.
 */
function installCtxPicker() {
  const fine = () => typeof matchMedia !== "function" || matchMedia("(pointer: fine)").matches;
  /** @type {{ el: HTMLElement, sel: HTMLSelectElement, label: Element, close: (refocus?: boolean) => void } | null} */
  let open = null;
  // A picker marked data-search (the desk's underlying) opens its page's symbol search instead of this menu.
  const pickOf = (t) => {
    const label = t?.closest?.(".ctx-pick");
    const sel = label && !label.hasAttribute("data-search") ? label.querySelector("select") : null;
    return sel && !sel.disabled ? /** @type {HTMLSelectElement} */ (sel) : null;
  };
  const show = (sel, viaKeyboard) => {
    if (open) {
      const same = open.sel === sel;
      open.close(false);
      if (same) return;
    }
    const label = sel.closest(".ctx-pick");
    const items = [...sel.options].map((o) =>
      h("button", { type: "button", role: "option", class: "ctx-menu-item", "aria-selected": String(o.selected), disabled: o.disabled, "data-value": o.value, tabindex: "-1" },
        h("span", { class: "ctx-menu-text" }, o.textContent), h("span", { class: "ctx-menu-check", "aria-hidden": "true" })));
    const el = h("div", { class: "ctx-menu", role: "listbox", "aria-label": sel.getAttribute("aria-label") ?? "" }, items);
    document.body.append(el);
    label.classList.add("open");
    const place = () => {
      const r = label.getBoundingClientRect();
      el.style.minWidth = `${Math.max(r.width, 140)}px`;
      const w = el.offsetWidth;
      el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
      el.style.top = `${r.bottom + 6}px`;
      el.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 18)}px`;
    };
    place();
    const focusAt = (i) => {
      const live = items.filter((b) => !b.disabled);
      if (!live.length) return;
      const b = live[(i + live.length) % live.length];
      b.focus({ preventScroll: true });
      b.scrollIntoView({ block: "nearest" });
    };
    const current = items.find((b) => b.getAttribute("aria-selected") === "true");
    current?.scrollIntoView({ block: "center" });
    if (viaKeyboard) focusAt(Math.max(0, items.filter((b) => !b.disabled).indexOf(current)));
    const outside = (e) => { if (!el.contains(e.target) && !label.contains(e.target)) close(false); };
    const onScroll = (e) => { if (!el.contains(e.target)) close(false); };
    const onHash = () => close(false);
    function close(refocus) {
      if (open?.el !== el) return;
      open = null;
      el.remove();
      label.classList.remove("open");
      document.removeEventListener("pointerdown", outside, true);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onHash);
      removeEventListener("hashchange", onHash);
      if (refocus) sel.focus({ preventScroll: true });
    }
    const choose = (b, refocus) => {
      close(refocus);
      if (sel.value === b.dataset.value) return;
      sel.value = b.dataset.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    el.addEventListener("click", (e) => {
      const b = /** @type {Element} */ (e.target).closest?.(".ctx-menu-item");
      if (b && !(/** @type {HTMLButtonElement} */ (b).disabled)) choose(b, false);
    });
    el.addEventListener("keydown", (e) => {
      const live = items.filter((b) => !b.disabled);
      const i = live.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
      if (e.key === "ArrowDown") focusAt(i + 1);
      else if (e.key === "ArrowUp") focusAt(i < 0 ? -1 : i - 1);
      else if (e.key === "Home") focusAt(0);
      else if (e.key === "End") focusAt(-1);
      else if (e.key === "Escape" || e.key === "Tab") close(true);
      else if ((e.key === "Enter" || e.key === " ") && i >= 0) choose(live[i], true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    setTimeout(() => open?.el === el && document.addEventListener("pointerdown", outside, true));
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onHash);
    addEventListener("hashchange", onHash);
    open = { el, sel, label, close };
  };
  document.addEventListener("pointerdown", (e) => {
    const sel = e.button === 0 && fine() ? pickOf(e.target) : null;
    if (!sel) return;
    e.preventDefault(); // no OS list, and no focus ring for a mouse press
    show(sel, false);
  }, true);
  document.addEventListener("keydown", (e) => {
    const sel = fine() && /** @type {Element} */ (e.target)?.matches?.(".ctx-pick select") ? pickOf(e.target) : null;
    if (!sel || !(e.key === "Enter" || e.key === " " || (e.key === "ArrowDown" && e.altKey) || e.key === "F4")) return;
    e.preventDefault();
    show(sel, true);
  }, true);
}

/** The one demo indicator's explanation (the toolbar's "Demo" and the phone ⋯ badge). */
export const DEMO_EXPLAINER = "Sample prices generated on this computer. Not live market data. Orders are paper only.";

/**
 * A chart slot: the light chart engine (chart-lite.js, registered as `app.chartEngine`) draws into it. The engine
 * module loads on the first slot, so a page without a chart never fetches it. Returns the slot element with
 * `el.chart`, a controller usable at once (calls made before the engine arrives are queued):
 *   el.chart.set(spec)     draw this data now (live data: one redraw per frame however often it is called)
 *   el.chart.load(loader)  load with `async () => spec` (a new contract or underlying), drawn when near the viewport
 *   el.chart.reload()      run the loader again
 *   el.chart.destroy()     stop it (charts also stop themselves when their box leaves the page)
 * `opts`: { data?: spec, load?: loader, refreshMs?, id? }. A spec is chart-lite-core.js `buildModel`'s; a loader may
 * return { empty: { title, text } } when no data source exists yet, and the slot says so plainly.
 * The second argument may be the options object (no sub-line). Null only if no engine is registered.
 */
export function chartSlot(label, sub = "", opts = {}) {
  if (!app.chartEngine) return null;
  if (sub && typeof sub === "object") [opts, sub] = [sub, ""];
  const box = h("div", { class: "lc-slot", "data-chart-slot": opts.id ?? undefined, "aria-label": label, role: "group" }, sub ? h("p", { class: "lc-sub" }, sub) : null);
  box.chart = app.chartEngine.mount(box, { label, ...opts });
  return box;
}

/** The engine behind `app.chartEngine`: chart-lite.js, imported on first use; a controller proxy until it arrives. */
let chartModule = null;
function chartEngine() {
  const load = () => (chartModule ??= import("./chart-lite.js"));
  return {
    name: "chart-lite",
    load,
    /** Mount a chart slot in `box` (see chartSlot); the returned controller queues calls until the module is in. */
    mount(box, opts) {
      let real = null;
      let dead = false;
      let lastSet = null;
      let lastLoad = null;
      let reloads = 0;
      const host = h("div", { class: "lc-wrap" });
      box.append(host);
      load()
        .then((m) => {
          if (dead) return;
          real = m.mountSlot(host, opts);
          if (lastLoad) real.load(lastLoad);
          if (lastSet) real.set(lastSet);
          if (reloads && !lastLoad) real.reload();
        })
        .catch(() => host.replaceChildren(emptyState("chart", "Chart unavailable", "The chart module did not load. Reload the page to try again.", null, { compact: true })));
      return {
        set: (spec) => (real ? real.set(spec) : (lastSet = spec)),
        load: (fn) => (real ? real.load(fn) : (lastLoad = fn)),
        reload: () => (real ? real.reload() : (reloads += 1)),
        destroy: () => ((dead = true), real?.destroy()),
        get chart() {
          return real?.chart ?? null;
        },
      };
    },
    /** Open a chart full size (chart-lite.js openChartModal): { label, load, studies? }. */
    async open(title, opts) {
      return (await load()).openChartModal(title, opts);
    },
    /** Create a chart directly in `host` (no loader or states): resolves to chart-lite.js createChart's chart. */
    async create(host, spec) {
      return (await load()).createChart(host, spec);
    },
  };
}

/**
 * A popover that is a bottom sheet on phones (< 720 px, in #dialog with aria-modal) and a body-attached popover from
 * 720 px up, placed against the trigger and clamped to the viewport (never clipped by a panel). Both trap Tab, close
 * on Esc and return focus to the trigger. Returns { el, close() }; `onClose` runs once.
 */
const OPEN_POPS = new WeakMap();
export function sheetPopover({ trigger, title, body, head = [], cls = "", onClose = null, within = null }) {
  // One popover per trigger: clicking the trigger again while its popover is open closes it (no second copy).
  const open = trigger ? OPEN_POPS.get(trigger) : null;
  if (open) {
    open.close();
    return open;
  }
  const phone = mm("(max-width: 719px)");
  let closed = false;
  const closeBtn = h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close"));
  const headEl = h("div", { class: "pop-head" }, h("strong", { id: "pop-title" }, title), head, closeBtn);
  const done = () => {
    if (closed) return;
    closed = true;
    trigger?.setAttribute("aria-expanded", "false");
    removeEventListener("resize", place);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("hashchange", close);
    document.removeEventListener("pointerdown", outside, true);
    if (trigger && OPEN_POPS.get(trigger) === handle) OPEN_POPS.delete(trigger);
    onClose?.();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  const trap = (e, root) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const f = [...root.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  let el;
  let raf = 0;
  function place() {
    if (phone || !el?.isConnected || !trigger) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const r = trigger.getBoundingClientRect();
      const w = el.offsetWidth;
      const hgt = el.offsetHeight;
      // `within`: an element (a column, a panel) the popover stays inside; it opens from the trigger's left then.
      const b = within?.isConnected ? within.getBoundingClientRect() : null;
      const minL = Math.max(8, b ? b.left : 8);
      const maxL = Math.max(minL, Math.min(innerWidth - w - 8, b ? b.right - w : innerWidth));
      const left = Math.max(minL, Math.min(maxL, b ? r.left : r.right - w));
      let top = r.bottom + 6;
      if (top + hgt > innerHeight - 8) top = Math.max(8, Math.min(innerHeight - hgt - 8, r.top - hgt - 6));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    });
  }
  const onScroll = (e) => {
    if (el && !el.contains(e.target)) place();
  };
  const outside = (e) => {
    if (el && !el.contains(e.target) && !trigger?.contains(e.target)) close();
  };
  function close() {
    if (closed) return;
    if (phone) {
      const d = document.getElementById("dialog");
      if (d.open) d.close();
      else done();
      return;
    }
    el?.remove();
    done();
  }
  trigger?.setAttribute("aria-expanded", "true");
  if (phone) {
    const d = document.getElementById("dialog");
    d.classList.add("sheet");
    el = h("div", { class: `pop-sheet ${cls}`.trim() }, headEl, body);
    d.replaceChildren(h("div", { class: "sheet-grabber", "aria-hidden": "true" }), el);
    d.setAttribute("aria-labelledby", "pop-title");
    d.setAttribute("aria-modal", "true");
    d.onkeydown = null;
    const onKey = (e) => trap(e, d);
    const onBackdrop = (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    };
    const onDlgClose = () => {
      d.removeEventListener("keydown", onKey);
      d.removeEventListener("close", onDlgClose);
      d.removeEventListener("click", onBackdrop);
      d.removeAttribute("aria-modal");
      lockScroll(false);
      done();
    };
    d.addEventListener("keydown", onKey);
    d.addEventListener("close", onDlgClose);
    d.addEventListener("click", onBackdrop);
    if (!d.open) d.showModal();
    lockScroll(true);
    sheetIn(d, d);
  } else {
    el = h("div", { class: `popover floating ${cls}`.trim(), role: "dialog", "aria-modal": "false", "aria-labelledby": "pop-title" }, headEl, body);
    el.addEventListener("keydown", (e) => trap(e, el));
    document.body.append(el);
    place();
    addEventListener("resize", place);
    addEventListener("scroll", onScroll, true);
    setTimeout(() => !closed && document.addEventListener("pointerdown", outside, true));
  }
  // A route change (palette, keyboard back, a hash link) closes it too, not only a pointerdown outside.
  addEventListener("hashchange", close);
  (body.querySelector?.("button, input, select") ?? closeBtn).focus({ preventScroll: true });
  const handle = { el, close, place };
  if (trigger) OPEN_POPS.set(trigger, handle);
  return handle;
}

export function alertBox(err, cls = "bad") {
  const f = err instanceof Error || err?.code || err?.network ? friendlyError(err) : { title: String(err?.title ?? err), detail: err?.detail ?? "" };
  return h("div", { class: `alert ${cls}`, role: "alert" }, icon(cls === "info" ? "info" : "warn"), h("div", {}, h("strong", {}, f.title), f.detail ? h("span", { class: "detail" }, f.detail) : null));
}

/**
 * A table inside a card. Numeric columns (`num: true`) are right-aligned with tabular figures. On phones the table
 * never widens the page: `mobile: "stack"` (default) turns each row into a grouped block of label / value lines (the
 * first column is the row's title, a column without a label holds its actions); `mobile: "scroll"` keeps the grid and
 * scrolls sideways inside the card (for logs with many short rows); `mobile: "stack-wide"` stacks on tablets too (below
 * 1100px), for wide tables whose last column holds the row's actions.
 */
/** A cell whose whole content is the missing-value placeholder draws it in the quiet ink, so it reads as "nothing here". */
const emptyMark = (v) => (v === DASH ? h("span", { class: "empty-dash" }, DASH) : v);

export function table(columns, rows, empty, { mobile = "stack", caption = null } = {}) {
  if (!rows.length) return empty;
  const cls = (c, i) => [c.num ? "num" : "", c.wrap ? "wrap" : "", c.label ? "" : "act", i === 0 ? "lead" : ""].join(" ").trim() || undefined;
  return h(
    "div",
    { class: `table-wrap ${mobile === "scroll" ? "scroll-x" : mobile === "stack-wide" ? "stack stack-wide" : "stack"}` },
    h(
      "table",
      {},
      caption ? h("caption", { class: "sr-only" }, caption) : null,
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { scope: "col", class: c.num ? "num" : undefined }, c.label || h("span", { class: "pal-sr-only" }, "Actions"))))),
      h("tbody", {}, rows.map((r) => h("tr", {}, columns.map((c, i) => h("td", { class: cls(c, i), "data-label": c.label || undefined }, emptyMark(c.cell(r))))))),
    ),
  );
}

/** A grouped content card (IPO Decode's lg-card) with an optional tinted icon tile in its header. */
export function card({ title, sub, actions, body, flush = false, cls = "", id, glyph, tint = "blue" }) {
  return h(
    "section",
    { class: `card ${cls}`.trim(), id },
    title || actions
      ? h("header", { class: "card-head" }, glyph ? iconTile(glyph, tint) : null, h("div", { class: "card-titles" }, title ? h("h2", {}, title) : null, sub ? h("p", {}, sub) : null), actions ? h("div", { class: "card-actions" }, actions) : null)
      : null,
    h("div", { class: flush ? "card-body flush" : "card-body" }, body),
  );
}

/** A plain section label over a group that has no title of its own (Home's "Today" figures). No pill, no rule. */
export function sectionEyebrow(label) {
  return h("h2", { class: "sec-eyebrow" }, label);
}

export function meterRow(name, used, limit, valueText) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const span = h("span");
  span.style.width = `${Math.max(pct, used > 0 ? 3 : 0)}%`;
  const cls = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "ok";
  return h("div", { class: "meter" }, h("span", { class: "name" }, name), h("div", { class: `bar ${cls}` }, span), h("span", { class: "val" }, valueText ?? `${used} / ${limit}`));
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const validDate = (iso) => (iso ? !Number.isNaN(new Date(iso).getTime()) : false);
export const istTime = (iso) => (validDate(iso) ? IST_TIME.format(new Date(iso)) : DASH);
export const istDateTime = (iso) => (validDate(iso) ? IST_DATE_TIME.format(new Date(iso)) : DASH);

// ── Sheet (modal dialog) ──

/** While a sheet or the palette is open the page behind it does not scroll. */
export function lockScroll(on) {
  document.documentElement.classList.toggle("sheet-open", Boolean(on));
}

/**
 * Show a sheet: a bottom sheet on phones, a centred card from 720px up (IPO Decode's Sheet). The native modal
 * <dialog> keeps focus inside and returns it to the opener; Escape, the close button and a tap on the dimmed backdrop
 * close it; the page behind stops scrolling. buttons: [{ label, cls, value, onClick? }]; onClick returning false keeps
 * it open. `body` may be a function that receives close(value). Resolves with the value (undefined when dismissed).
 * A button may carry `id`, and `ref(el)` is called with its element once drawn (so callers keep a direct reference).
 */
export function modal({ title, body, buttons = [], canClose = null }) {
  const d = document.getElementById("dialog");
  d.classList.add("sheet");
  return new Promise((resolve) => {
    const token = (modal.token = {});
    // A sheet that is still sliding away from an earlier modal takes no more input; this one starts live.
    d.inert = false;
    delete d.dataset.closing;
    d.closeNow = null;
    let settled = false;
    let closing = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      d.removeEventListener("cancel", onCancel);
      d.removeEventListener("close", onClose);
      d.removeEventListener("click", onBackdrop);
      if (modal.token === token) {
        lockScroll(false);
        d.inert = false;
        delete d.dataset.closing;
        d.closeNow = null;
      }
      resolve(v);
    };
    // Animate the sheet away, then close the native dialog (focus returns to the opener) and resolve.
    // canClose() === false refuses Escape, the X and a backdrop tap (e.g. while orders are going out). The body's own
    // buttons pass force = true once they have decided.
    const close = (v, force = false) => {
      if (closing || settled) return;
      if (!force && canClose && canClose() === false) return;
      closing = true;
      // While it slides away the sheet is inert: keys typed meanwhile (Ctrl K, a search) never land in its fields.
      // closeNow() ends the slide at once, for the palette opening over it.
      d.inert = true;
      d.dataset.closing = "";
      const done = () => {
        if (settled) return;
        if (modal.token === token && d.open) d.close();
        finish(v);
      };
      d.closeNow = done;
      sheetOut(d, d).then(done);
    };
    // Escape: keep the native behaviour (resolves undefined) but let the sheet slide away first.
    const onCancel = (e) => {
      e.preventDefault();
      close(undefined);
    };
    // Closed some other way (e.g. the browser forced it): resolve, unless a newer modal already reopened it.
    const onClose = () => {
      if (!d.open) finish(undefined);
    };
    // A tap on the dimmed area outside the panel (the <dialog> box is the panel; its ::backdrop is the rest).
    const onBackdrop = (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(undefined);
    };
    const content = typeof body === "function" ? body(close) : body;
    const closeBtn = h("button", { type: "button", class: "icon-btn sheet-close", "aria-label": "Close", onclick: () => close(undefined) }, icon("close"));
    // replaceChildren prints null as the text "null": an empty string stands for "no action row".
    d.replaceChildren(
      h("div", { class: "sheet-grabber", "aria-hidden": "true" }),
      h("div", { class: "sheet-head" }, h("h2", { class: "sheet-title", id: "dialog-title" }, title), closeBtn),
      h("div", { class: "dialog-body" }, content),
      buttons.length
        ? h(
            "div",
            { class: "dialog-actions" },
            buttons.map((b) =>
              h(
                "button",
                {
                  type: "button",
                  class: b.cls ?? "",
                  id: b.id,
                  onclick: async () => {
                    if (closing) return;
                    if (b.onClick) {
                      const v = await b.onClick();
                      if (v === false) return;
                      close(v ?? b.value);
                    } else close(b.value);
                  },
                },
                b.label,
              ),
            ),
          )
        : "",
    );
    for (const [i, b] of buttons.entries()) if (typeof b.ref === "function") b.ref(d.querySelectorAll(".dialog-actions > button")[i] ?? null);
    d.setAttribute("aria-labelledby", "dialog-title");
    d.addEventListener("cancel", onCancel);
    d.addEventListener("close", onClose);
    d.addEventListener("click", onBackdrop);
    // Enter in a one-line field presses the sheet's main (primary) action, as in any form. Fields that use Enter
    // themselves (search pickers, textareas, a focused button) stop it first or are skipped here.
    d.onkeydown = (e) => {
      // Tab stays inside the sheet: a native modal <dialog> lets it leave past the last control (to the browser and
      // back to the page behind), so the first and last controls hand focus round to each other.
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const f = [...d.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null && !x.closest("[inert], [hidden]"));
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        const a = document.activeElement;
        if (e.shiftKey && (a === first || !d.contains(a))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (a === last || !d.contains(a))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key !== "Enter" || e.isComposing || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || ["checkbox", "radio", "button", "submit", "search", "file"].includes(el.type)) return;
      if (el.closest("form")) return; // a form inside the sheet handles its own submit
      const primary = [...d.querySelectorAll(".dialog-actions > button.primary")].pop();
      if (!primary || primary.disabled) return;
      e.preventDefault();
      primary.click();
    };
    if (!d.open) d.showModal();
    lockScroll(true);
    d.querySelector(".dialog-body")?.scrollTo?.(0, 0);
    // Focus: the first field to type in; else the first action (Cancel, never the confirming one); else Close.
    const first = d.querySelector(".dialog-body :is(input:not([type=hidden]):not([type=radio]):not(:disabled), select, textarea)") ?? d.querySelector(".dialog-actions button") ?? closeBtn;
    first.focus({ preventScroll: true });
    sheetIn(d, d);
  });
}

// ── Ticket helpers (pure; tested) ──

/**
 * Every field of a pending ticket's order, in the order a person should read them before confirming. The
 * confirmation covers exactly this body, so nothing that changes what is sent may be left out. Live mode, MARKET
 * orders and blocking checks are flagged. Pure (no DOM) so it can be tested.
 * @returns {Array<[string, string, string?]>}  [label, value, css class]
 */
export function ticketFields(ticket, accountsById = new Map()) {
  const o = ticket?.order ?? {};
  const show = (v) => (v === undefined || v === null || v === "" ? DASH : String(v));
  const money = (v) => (typeof v === "number" && Number.isFinite(v) ? formatRupee(v) : DASH);
  const acc = accountsById.get(o.account);
  const mode = String(o.mode ?? "paper");
  const orderType = show(o.orderType);
  const rows = [
    ["Account", acc ? `${o.account} (${acc.broker ?? "?"}${acc.label ? ` · ${acc.label}` : ""})` : show(o.account)],
    ["Mode", mode === "live" ? "LIVE (real money)" : mode, mode === "live" ? "bad" : undefined],
    ["Side", show(o.side), o.side === "SELL" ? "warn" : undefined],
    ["Quantity", o.lots ? `${o.lots} lot(s)` : show(o.quantity)],
    ["Symbol", show(o.symbol)],
    ["Order type", orderType === "MARKET" || orderType === "SL-M" ? `${orderType} (no price limit)` : orderType, orderType === "MARKET" || orderType === "SL-M" ? "warn" : undefined],
    ["Price", o.price === undefined || o.price === null ? DASH : money(o.price)],
    ["Trigger price", o.triggerPrice === undefined || o.triggerPrice === null ? DASH : money(o.triggerPrice)],
    ["Product", show(o.product)],
    ["Validity", show(o.validity ?? "DAY")],
    ["Estimated value", money(ticket?.estimatedValue)],
  ];
  if (o.tag) rows.push(["Tag", String(o.tag)]);
  for (const c of ticket?.checks ?? []) {
    const block = c?.severity === "block";
    rows.push([block ? "Blocked" : "Warning", `${c?.code ?? ""}${c?.message ? `: ${c.message}` : ""}`, block ? "bad" : "warn"]);
  }
  return rows;
}

/** Text shown once after a confirmation: the single-use code and when it stops working. Pure. */
export function confirmCodeNotice(ticketId, result) {
  const token = result?.data?.confirmToken ?? result?.confirmToken ?? null;
  const expiresAt = result?.data?.expiresAt ?? result?.expiresAt ?? null;
  if (!token) return null;
  return {
    token,
    text: `Ticket ${ticketId} confirmed. Give this single-use code to the client that prepared it${expiresAt ? `; it expires at ${istTime(expiresAt)} IST` : ""}. It is shown only once.`,
  };
}

/**
 * Welcome checklist state from what the Bridge reports plus what this browser remembers. Pure.
 * @returns {Array<{ id: string, done: boolean }>}
 */
export function checklistState({ demo = false, accounts = [], keys = [], chainOpened = false, traded = false, orders = [] }) {
  const brokerConnected = accounts.some((a) => a.broker !== "paper" && a.session?.state === "connected");
  // A key for a tool: active, not the dashboard's own sign-in key and not an admin key (init makes one of those).
  const toolKeys = keys.filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()) && !(k.clientKind === "ui" && k.label === SIGN_IN_KEY_LABEL) && !(k.scopes ?? []).includes("admin"));
  // A paper order the person placed (demo mode seeds a few of its own, tagged DEMOSEED).
  const placed = orders.some((o) => o?.mode === "paper" && o.tag !== "DEMOSEED");
  return [
    { id: "broker", done: demo || brokerConnected },
    { id: "key", done: toolKeys.length >= 1 },
    { id: "chain", done: Boolean(chainOpened) },
    { id: "trade", done: Boolean(traded) || placed },
  ];
}

// ── Broker login form (pure; tested) ──

/** Plain-English names for the fields brokers ask for (GET /v1/brokers credentialFields). */
const FIELD_LABELS = Object.freeze({
  apiKey: "API key",
  apiSecret: "API secret",
  accessToken: "Access token",
  clientId: "Client ID",
  clientCode: "Client code",
  userId: "User ID",
  appId: "App ID",
  appKey: "App key",
  appCode: "App code",
  appName: "App name",
  appSource: "App source",
  appSecret: "App secret",
  secretKey: "Secret key",
  userKey: "User key",
  encryptionKey: "Encryption key",
  authCode: "Auth code",
  authToken: "Auth token",
  requestToken: "Request token",
  requestCode: "Request code",
  userSession: "User session",
  userSessionId: "User session ID",
  apiSession: "API session",
  apiToken: "API token",
  vendorCode: "Vendor code",
  mobileNumber: "Mobile number",
  phone: "Phone number",
  ucc: "UCC (client code)",
  applicationId: "Application ID",
  apiClientId: "API client ID",
  authorizationKey: "Authorization key",
  ssoId: "SSO ID",
  interactiveApiKey: "Interactive (orders) API key",
  interactiveApiSecret: "Interactive (orders) API secret",
  interactiveSessionToken: "Interactive session token",
  marketApiKey: "Market data API key",
  marketApiSecret: "Market data API secret",
});
/** Fields that identify you rather than unlock anything: shown as you type them. Everything else is masked. */
const PLAIN_FIELDS = new Set(["clientId", "clientCode", "userId", "appId", "appName", "appSource", "applicationId", "apiClientId", "vendorCode", "mobileNumber", "phone", "ucc", "ssoId"]);
/** Values that belong to one day's session for brokers whose token is minted daily (session.mjs DAILY_TOKEN_VALUE_KEYS, plus the same idea under other names). */
const DAILY_FIELDS = new Set(["accessToken", "requestToken", "requestCode", "authCode", "userSession", "userSessionId", "interactiveSessionToken", "apiSession", "authToken", "ssoId"]);

/** A readable name for a broker field key: "apiKey" -> "API key". Pure. */
export function fieldLabel(key) {
  const k = String(key ?? "");
  if (FIELD_LABELS[k]) return FIELD_LABELS[k];
  const words = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().replace(/\bapi\b/g, "API").replace(/\bid\b/g, "ID");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Plain-language steps for one broker's login, by auth kind (GET /v1/brokers authKind, tokenExpiry, loginUrl). Pure.
 * @returns {string[]}
 */
export function loginHelp(broker) {
  const name = broker?.name ?? "your broker";
  const ends = broker?.tokenExpiry ? ` (it ends at ${broker.tokenExpiry})` : "";
  switch (broker?.authKind) {
    case "oauthRedirect":
      return [
        `Enter your app's API key and secret from ${name}'s developer site once; they are saved, encrypted, on this computer.`,
        `Each trading day, log in on ${name}'s own page${broker?.loginUrl ? " (button below)" : ""} and paste that day's access token here${ends}.`,
      ];
    case "requestTokenExchange":
      return [
        `Enter your API details from ${name}'s developer site once; they are saved, encrypted, on this computer.`,
        `Each trading day, log in on ${name}'s own page${broker?.loginUrl ? " (button below)" : ""}, copy the one-time code it gives you and paste it here. The Bridge swaps it for the day's session.`,
      ];
    case "sessionLogin":
      return [
        `Enter your API details from ${name} once; they are saved, encrypted, on this computer.`,
        "Each time you log in, type your PIN or password and the current 6-digit code from your authenticator app. These are used once to log in and are never saved.",
      ];
    default:
      return [
        `Copy these from ${name}'s API or developer page. They are saved, encrypted, on this computer only, and go nowhere but ${name}.`,
        "When the broker ends the token, make a new one there and log in here again.",
      ];
  }
}

/**
 * Everything the Log in sheet draws for one broker: the fields to type (saved keys in `values`, one-time login
 * secrets in `secrets`) and the help text. `saved`: the account has logged in before, so empty fields keep what was
 * saved. Pure.
 * @returns {{ kind: string, help: string[], keepHint: boolean, fields: Array<{ key: string, group: "values"|"secrets",
 *   label: string, type: "text"|"password", inputmode?: string, pattern?: string, maxlength?: number, hint: string|null, required: boolean }> }}
 */
export function loginFormSpec(broker, { saved = false } = {}) {
  const kind = broker?.authKind ?? "apiKeyToken";
  const daily = kind === "oauthRedirect" || kind === "requestTokenExchange";
  const values = (broker?.credentialFields ?? []).map((key) => ({
    key,
    group: "values",
    label: fieldLabel(key),
    type: PLAIN_FIELDS.has(key) ? "text" : "password",
    hint: daily && DAILY_FIELDS.has(key) ? "New every trading day" : null,
    required: false,
  }));
  const secrets = (broker?.loginFields ?? []).map((f) =>
    f.kind === "totp"
      ? { key: f.key, group: "secrets", label: f.label ?? fieldLabel(f.key), type: "text", inputmode: "numeric", pattern: "[0-9]{6}", maxlength: 6, hint: "From your authenticator app. Used once, never saved", required: true }
      : { key: f.key, group: "secrets", label: f.label ?? fieldLabel(f.key), type: "password", hint: "Used once to log in, never saved", required: true },
  );
  return { kind, help: loginHelp(broker), keepHint: Boolean(saved) && values.length > 0, fields: [...values, ...secrets] };
}

/**
 * The connect request body from what was typed: empty fields are left out (so a saved value is kept), `secrets` only
 * when there are any. Pure. @param {(field) => string} read
 */
export function loginBody(spec, read) {
  const values = {};
  const secrets = {};
  for (const f of spec.fields) {
    const v = String(read(f) ?? "").trim();
    if (!v) continue;
    (f.group === "secrets" ? secrets : values)[f.key] = v;
  }
  return Object.keys(secrets).length ? { values, secrets } : { values };
}

/**
 * The broker's login page with its {field} placeholders filled from what was typed, or null until every one is
 * filled. Only https addresses. Pure.
 */
export function fillLoginUrl(template, values) {
  if (typeof template !== "string" || !template.startsWith("https://")) return null;
  let missing = false;
  const url = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) => {
    const v = String(values?.[k] ?? "").trim();
    if (!v) missing = true;
    return encodeURIComponent(v);
  });
  return missing ? null : url;
}

/** Whether a broker matches a search ("zer", "kite", "angel one" ...). Pure. */
export function brokerMatches(broker, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${broker?.name ?? ""} ${broker?.id ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// ── Kill switch ──

/**
 * "Stop all orders?": the one confirmation for engaging the kill switch (the Safety page and the readiness badge's
 * popover both call it). Resolves true once the switch is on.
 */
export async function confirmEngageKillSwitch() {
  const reason = h("input", { value: "Stopped from the dashboard", maxlength: "200" });
  const cancel = h("input", { type: "checkbox" });
  const go = await modal({
    title: "Stop all orders?",
    body: h("div", { class: "stack" }, h("p", {}, "New orders are refused at once, including ones already queued. Cancels still work."), h("label", { class: "field" }, "Reason", reason), h("label", { class: "check" }, cancel, "Also cancel open orders the Bridge placed")),
    buttons: [{ label: "Keep trading", value: false }, { label: "Stop all orders", cls: "primary", value: true }],
  });
  if (!go) return false;
  try {
    await api("/v1/safety/kill-switch", { method: "POST", body: { reason: reason.value || "manual", cancelOpenOrders: cancel.checked } });
    toast("Kill switch engaged");
    return true;
  } catch (err) {
    await modal({ title: "Could not engage", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    return false;
  }
}

// ── Theme ──

export function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  else root.removeAttribute("data-theme");
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === (choice ?? "auto")));
}

// ── Space: the sidebar (full or icon rail) and the density (compact or comfortable), layout-prefs.js ──

const finePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
/** Resolve the stored sidebar and density choices for this screen and set data-sb / data-density on <html>. */
export function applyLayout() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const w = typeof innerWidth === "number" ? innerWidth : 0;
  const sb = resolveSidebar(local.get(SIDEBAR_SLOT), w);
  const density = resolveDensity(local.get(DENSITY_SLOT), { fine: finePointer(), width: w });
  const changed = root.dataset.sb !== sb || root.dataset.density !== density;
  if (root.dataset.sb !== sb) root.dataset.sb = sb;
  if (root.dataset.density !== density) root.dataset.density = density;
  const t = document.getElementById("sb-toggle");
  if (t) {
    const rail = sb === "rail";
    const label = rail ? "Expand the sidebar" : "Collapse the sidebar to icons";
    t.setAttribute("aria-expanded", String(!rail));
    t.setAttribute("aria-label", label);
    t.title = label;
    if (t.dataset.icon !== sb) {
      t.dataset.icon = sb;
      t.replaceChildren(icon(rail ? "rail" : "sidebar"));
    }
  }
  const choice = parseDensity(local.get(DENSITY_SLOT));
  for (const b of document.querySelectorAll("[data-density-choice]")) b.setAttribute("aria-pressed", String(b.dataset.densityChoice === choice));
  return changed;
}
/** Re-fit what measures itself (the chain's columns and height, charts) after the sidebar or density changed. */
const relayout = () => {
  if (applyLayout() && typeof dispatchEvent === "function") requestAnimationFrame(() => dispatchEvent(new Event("resize")));
};
/** Compact, comfortable or auto (compact with a mouse on a desktop), remembered in this browser. */
export function chooseDensity(choice) {
  const c = parseDensity(choice);
  local.set(DENSITY_SLOT, c === "auto" ? null : c);
  relayout();
}
/** The sidebar's toggle: the icon rail or the full sidebar, remembered in this browser. */
export function toggleSidebarRail() {
  const cur = document.documentElement.dataset.sb;
  if (cur !== "rail" && cur !== "full") return;
  const next = toggleSidebar(cur, innerWidth);
  local.set(SIDEBAR_SLOT, next === "auto" ? null : next);
  relayout();
}

/** Apply an appearance (auto, light or dark) and remember it in this browser. */
export function chooseTheme(choice) {
  const c = choice === "light" || choice === "dark" ? choice : "auto";
  local.set(THEME_SLOT, c === "auto" ? null : c);
  applyTheme(c);
}

/** Forget the key (this tab and this browser) and go back to the sign-in screen, without signing straight back in. */
export function forgetKey() {
  setKey(null);
  session.set(NO_AUTO_SLOT, "1");
  location.hash = "";
  location.reload();
}

/** Get a key on this computer and keep it in this browser. Returns signInLocal's answer ("key" in it when signed in). */
async function autoSignIn() {
  const r = await signInLocal();
  if (!("key" in r)) return r;
  session.set(NO_AUTO_SLOT, null);
  setKey(r.key, { remember: true });
  return r;
}

/** The sign-in screen: one button on this computer, the key form (open) elsewhere. */
function showLogin() {
  const local = onLoopbackHost();
  const btn = document.getElementById("login-local");
  if (btn) btn.hidden = !local;
  const keyBox = /** @type {HTMLDetailsElement|null} */ (document.getElementById("login-key"));
  if (keyBox) keyBox.open = !local;
  const help = document.getElementById("login-help");
  if (help) help.hidden = local;
  const lead = document.getElementById("login-lead");
  if (lead) lead.textContent = local ? "You are on the Bridge's own computer, so no key is needed." : "This page is open from another computer: sign in with an API key from the Bridge's computer.";
  document.getElementById("login").hidden = false;
  document.getElementById("app").hidden = true;
  (local ? btn : document.getElementById("key-input"))?.focus();
}

// ── App boot (browser only) ──

export const app = { state: { demo: false, health: null, meta: null }, local, chartEngine: null };
// The light chart engine (chart-lite.js) fills every chart slot; the module itself loads on the first slot.
app.chartEngine = chartEngine();

async function signIn({ retried = false } = {}) {
  const login = document.getElementById("login");
  const shell = document.getElementById("app");
  // /v1/health needs no key, so the sign-in screen can say "demo" before anyone signs in.
  fetch("/v1/health")
    .then((r) => r.json())
    .then((hl) => {
      const el = document.getElementById("login-demo");
      if (el) el.hidden = !hl?.demo;
    })
    .catch(() => {});
  // On the Bridge's own computer there is no key to type: the page signs itself in (unless this tab just signed out).
  if (!memoryKey && onLoopbackHost() && session.get(NO_AUTO_SLOT) !== "1") await autoSignIn();
  if (!memoryKey) return showLogin();
  try {
    const [health, meta] = await Promise.all([api("/v1/health"), api("/v1/meta")]);
    app.state.health = health.data;
    app.state.meta = meta.data;
    app.state.demo = Boolean(health.data?.demo);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      setKey(null);
      // A remembered key that expired or was revoked: get a fresh one once, quietly.
      if (!retried && onLoopbackHost() && session.get(NO_AUTO_SLOT) !== "1" && "key" in (await autoSignIn())) return signIn({ retried: true });
    }
    showLogin();
    document.getElementById("login-error").replaceChildren(alertBox(err));
    shake(document.querySelector("#login .login-card") ?? document.getElementById("login-form"));
    return;
  }
  login.hidden = true;
  shell.hidden = false;
  if (!signIn.pulsing) signIn.pulsing = pulse(document.querySelector(".who .dot"));
  app.state.who = `Key ${memoryKey.split("_")[1] ?? ""} · v${app.state.health?.version ?? ""}`;
  document.getElementById("who").textContent = app.state.who;
  const { startRouter } = await import("./views.js");
  // Awaited so a banner shown after sign-in comes after the first page draw (which clears #toast).
  await startRouter();
  // The trading-readiness badge in the toolbar (every page; docs/spec/p1-05-readiness.md §6.3).
  import("./readiness.js").then((m) => m.mountReadinessBadge()).catch(() => {});
  // Position alerts: the bell (unread fires, every alert) once there is an alert (alerts.js).
  import("./alerts.js").then((m) => m.mountAlertBell()).catch(() => {});
}

if (typeof document !== "undefined" && document.getElementById("login-form")) {
  applyTheme(local.get(THEME_SLOT) ?? "auto");
  applyLayout();
  addEventListener("resize", () => applyLayout(), { passive: true });
  if (typeof matchMedia === "function") matchMedia("(pointer: fine)").addEventListener?.("change", relayout);
  // Motion: page / sidebar entrances on navigation (a button press is CSS: app.css 8a).
  installAutoAnimations();
  installCtxPicker();
  // Appearance buttons (the sidebar's and the More sheet's) and "Forget key", wherever they are drawn.
  document.addEventListener("click", (e) => {
    const t = /** @type {Element} */ (e.target);
    const choice = t?.closest?.("[data-theme-choice]");
    const dens = t?.closest?.("[data-density-choice]");
    if (choice) chooseTheme(/** @type {HTMLElement} */ (choice).dataset.themeChoice);
    else if (dens) chooseDensity(/** @type {HTMLElement} */ (dens).dataset.densityChoice);
    else if (t?.closest?.("#sb-toggle")) toggleSidebarRail();
    else if (t?.closest?.("[data-action=logout]")) forgetKey();
    revealInRow(t?.closest?.("button, [role=tab], [role=radio]"));
  });
  document.getElementById("login-local")?.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    document.getElementById("login-error").replaceChildren();
    const r = await autoSignIn();
    btn.disabled = false;
    if ("key" in r) return signIn();
    document.getElementById("login-error").replaceChildren(alertBox(r.error));
  });
  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("key-input");
    setKey(input.value.trim());
    input.value = "";
    document.getElementById("login-error").replaceChildren();
    signIn();
  });
  boot();
}

/**
 * A choice picked in a sideways-scrolling row (phone tab rows, chips, expiry strips) slides fully into view, so the
 * selected tab is never left half under the row's edge fade.
 */
function revealInRow(el) {
  const row = el?.parentElement;
  if (!row || row.scrollWidth <= row.clientWidth + 1) return;
  const x = getComputedStyle(row).overflowX;
  if (x !== "auto" && x !== "scroll") return;
  const a = el.getBoundingClientRect();
  const b = row.getBoundingClientRect();
  const pad = 24; // clear of the 12 to 16 px edge fades
  const dx = a.left < b.left + pad ? a.left - b.left - pad : a.right > b.right - pad ? a.right - b.right + pad : 0;
  if (dx) row.scrollBy({ left: dx, behavior: reducedMotion() ? "auto" : "smooth" });
}

/** Start-up: redeem a sign-in link first (when the page was opened with one), then sign in as usual. */
async function boot() {
  if (pendingSignInCode === null) return signIn();
  const result = await redeemSignIn(pendingSignInCode);
  if ("key" in result) setKey(result.key);
  await signIn();
  if ("key" in result) {
    if (!document.getElementById("app").hidden) toast("Signed in. Welcome to your Bridge.");
  } else if (!memoryKey) {
    // Already signed in in this tab: the older key keeps working, so an old link needs no error.
    document.getElementById("login-error").replaceChildren(alertBox(result.error));
    shake(document.querySelector("#login .login-card") ?? document.getElementById("login-form"));
  }
}
