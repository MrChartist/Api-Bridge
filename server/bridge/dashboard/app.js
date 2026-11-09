// API Bridge: the local dashboard. Talks only to this Bridge (same origin). The API key lives in
// sessionStorage for this tab and is sent as a Bearer header; it is never put in a URL.
// Opened from `mc-bridge start --open` or `mc-bridge open`, the URL carries a one-time sign-in code in its fragment
// (#signin=<code>): it is removed from the address bar before anything else and exchanged for a key (POST /v1/sign-in).
// Pure helpers (ticketFields, confirmCodeNotice, friendlyError ...) are exported for tests; DOM code runs only in a browser.

import { bannerIn, bannerOut, fadeOut, installAutoAnimations, pulse, reducedMotion, setText, sheetIn, sheetOut, shake, stackGhost, swipeDismiss } from "./motion.js";
import { DASH, formatRupee } from "./format.js";
import { DENSITY_SLOT, SIDEBAR_SLOT, parseDensity, resolveDensity, resolveSidebar, toggleSidebar } from "./layout-prefs.js";
import { watch as liveWatch } from "./live.js";
import { fixFor } from "./easy-core.js";

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
let memoryKey = session.get(KEY_SLOT);

export function setKey(k) {
  memoryKey = k || null;
  session.set(KEY_SLOT, memoryKey);
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
    // A prefetched answer (a menu item under the pointer) serves the click that follows it for a few seconds.
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
// instead of the broker. Pages get this without knowing about it.
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
 * The open positions' symbols in a /v1/positions answer (pure): a page polling positions has them watched too, so the
 * Bridge marks them to market from ticks instead of a broker read per poll. Null for any other path.
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
 * Warm one GET a person is about to ask for (a menu item under the pointer): fetched once at background priority
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

/**
 * Icons: one outline set on a 24px grid, drawn originally for this dashboard: 1.75px stroke, round caps and joins,
 * no fills (a dot is a zero-length round-capped stroke). `icon(name)` returns an <svg class="ic"> that takes its colour
 * from the text (currentColor); app.css sets its size in each place. The static strings below are the only markup.
 */
export const ICONS = {
  bridge: '<path d="M2.5 17h19"/><path d="M7 4v13M17 4v13"/><path d="M7 4.5c1.6 8.5 8.4 8.5 10 0"/><path d="M2.5 11.5 7 4.5M21.5 11.5 17 4.5"/>',
  home: '<path d="M4 10.8 12 4.2l8 6.6V19a1 1 0 0 1-1 1h-4v-5.5H9V20H5a1 1 0 0 1-1-1z"/>',
  accounts: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10.8" r="2"/><path d="M5.8 16c.7-1.5 1.9-2.2 3.2-2.2s2.5.7 3.2 2.2"/><path d="M15 10h3.2M15 13.6h3.2"/>',
  console: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 10 3 2.5-3 2.5"/><path d="M13 15h3.5"/>',
  limits: '<path d="M4.6 17.2a8.2 8.2 0 1 1 14.8 0"/><path d="M12 13.2 15.2 9"/><path d="M12 13.2h.01" stroke-width="3"/>',
  orders: '<rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M9 9h6M9 12.5h6M9 16h3.5"/>',
  keys: '<circle cx="8" cy="15.5" r="3.6"/><path d="m10.6 12.9 8.4-8.4"/><path d="m16 7.5 2.5 2.5"/><path d="m13.4 10.1 1.8 1.8"/>',
  integrations: '<path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-.9.9"/><path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l.9-.9"/>',
  safety: '<path d="M12 3.5 5 6v5.6c0 4.1 2.8 7.3 7 8.9 4.2-1.6 7-4.8 7-8.9V6z"/><path d="m9 12 2.2 2.2 4.1-4.2"/>',
  activity: '<path d="M3 12h3.6l2.4-6 4 12 2.4-6H21"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.6"/><path d="M15.5 8.5V7A2.5 2.5 0 0 0 13 4.5H7A2.5 2.5 0 0 0 4.5 7v6A2.5 2.5 0 0 0 7 15.5h1.5"/>',
  play: '<path d="M8 6v12a.9.9 0 0 0 1.4.8l9.3-6a.9.9 0 0 0 0-1.5l-9.3-6A.9.9 0 0 0 8 6z"/>',
  refresh: '<path d="M18.6 12.2a6.6 6.6 0 1 1-1.9-4.7"/><path d="M17.4 3.8v3.9h-3.9"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.8"/>',
  info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v5"/><path d="M12 7.9h.01" stroke-width="2.4"/>',
  warn: '<path d="M10.3 4.7 3 17.3a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0z"/><path d="M12 9.6v3.9"/><path d="M12 16.8h.01" stroke-width="2.4"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>',
  inbox: '<path d="m3.6 13.5 2.4-7.7a2 2 0 0 1 1.9-1.3h8.2a2 2 0 0 1 1.9 1.3l2.4 7.7"/><path d="M3.6 13.5V18a2 2 0 0 0 2 2h12.8a2 2 0 0 0 2-2v-4.5H15l-1 2H10l-1-2z"/>',
  bolt: '<path d="M13.2 3 5 13.6h6L10.8 21 19 10.4h-6z"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v1.7M12 18.8v1.7M3.5 12h1.7M18.8 12h1.7M6 6l1.2 1.2M16.8 16.8 18 18M6 18l1.2-1.2M16.8 7.2 18 6"/>',
  moon: '<path d="M19.5 14.4A8 8 0 0 1 9.6 4.5a8 8 0 1 0 9.9 9.9z"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2.6"/><path d="M8.5 20h7M12 16v4"/>',
  more: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.5 4.5"/>',
  logout: '<path d="M10 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h3"/><path d="m15 8 4 4-4 4"/><path d="M19 12H9.5"/>',
  chart: '<path d="M4 4.5V18a2 2 0 0 0 2 2h14"/><path d="m8 14.5 3.5-4 3 2.5 4.5-6"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12.5" rx="3"/><path d="M20.5 11.5h-4a2 2 0 0 0 0 4h4"/><path d="M16.8 13.5h.01" stroke-width="2.4"/>',
  clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.5V12l3 2"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="3"/>',
  up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  scale: '<path d="M12 4.5v15M7 19.5h10M5 7.5h14"/><path d="m5 7.5-2.5 6a2.5 2.5 0 0 0 5 0zM19 7.5l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.5-3.8 3.4-6 7-6s6.5 2.2 7 6"/>',
  download: '<path d="M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M9.5 4.5v15"/><path d="m16 9.5-2.5 2.5 2.5 2.5"/>',
  rail: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M9.5 4.5v15"/><path d="m13.5 9.5 2.5 2.5-2.5 2.5"/>',
  density: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M9.9 5.7A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.5 3.3M6.5 7.3C3.9 9.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m4 4 16 16"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.8"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5"/>',
  arrow: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
};
/** An <svg class="ic"> for `name` (see ICONS). Its size and colour come from the surrounding CSS (app.css 4). */
export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "ic");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.innerHTML = ICONS[name] ?? "";
  return s;
}

/**
 * The coloured squircle behind an icon (Settings-style). `tint` is a tile hue (blue, green, red, orange, teal, indigo,
 * purple, pink, gray); `size` is "sm" (26), "md" (32) or "lg" (44).
 */
export function iconTile(name, tint = "blue", size = "md") {
  return h("span", { class: `icon-tile tint-${tint} tile-${size}`, "aria-hidden": "true" }, icon(name));
}

/**
 * A confirmation in #toast (one at a time; a new one replaces the old). views.js may hide it with `$("toast").hidden = true`.
 * Two fixed live regions inside it carry the words: a polite one for a done action, an assertive one for a failure
 * (a role that changes on one region is not announced reliably). It pauses while the pointer or focus is on it; a
 * failure stays until dismissed, a caution 8 s, the rest 4 s.
 */
export function toast(text, { tone = "ok" } = {}) {
  const t = document.getElementById("toast");
  const gen = (toast.gen = (toast.gen ?? 0) + 1);
  const wasHidden = t.hidden;
  // Tones: "ok" a done action (green check); "info" a refused or not-yet-possible action (neutral ⓘ); "warn" a caution
  // (amber !); "error" a failure (red !, announced at once, stays until dismissed). Never the green check for a problem.
  const kind = TOAST_TONES.has(tone) ? tone : "ok";
  const glyph = kind === "ok" ? "check" : kind === "info" ? "info" : "warn";
  t.dataset.tone = kind;
  const polite = t.querySelector("#toast-polite");
  const assertive = t.querySelector("#toast-assertive");
  const [live, other] = kind === "error" ? [assertive, polite] : [polite, assertive];
  const wait = kind === "error" ? 0 : kind === "warn" ? 8000 : 4000;
  // The same words again within 2 s: one toast with a count, its timer restarted (nothing re-announced or re-animated).
  const key = typeof text === "string" ? `${kind}|${text}` : null;
  if (!wasHidden && key && toast.last?.key === key && Date.now() - toast.last.at < 2000) {
    toast.last.at = Date.now();
    const n = ++toast.last.n;
    let count = live.querySelector(".toast-count");
    if (!count) live.querySelector(".toast-text")?.after((count = h("span", { class: "toast-count" })));
    setText(count, `×${n}`);
    toast.arm?.(wait);
    return;
  }
  toast.last = key ? { key, at: Date.now(), n: 1 } : null;
  // The toast that is still showing stays behind as a shrunken copy that slides away (at most two copies).
  if (!wasHidden) stackGhost(t);
  other.replaceChildren();
  live.replaceChildren(h("span", { class: `toast-icon${kind === "ok" ? "" : ` ${kind}`}` }, icon(glyph)), h("span", { class: "toast-text" }, text));
  t.hidden = false;
  raiseToast(t);
  placeToast(t);
  bannerIn(t, t.dataset.place === "top" || (!t.dataset.place && window.matchMedia?.("(min-width: 1024px)").matches) ? "up" : "down");
  const close = () => {
    clearTimeout(toast.timer);
    // Hide after sliding out, unless another toast took over meanwhile.
    bannerOut(t).then(() => {
      if (toast.gen === gen) t.hidden = true;
    });
  };
  const arm = (ms) => {
    clearTimeout(toast.timer);
    if (ms > 0) toast.timer = setTimeout(close, ms);
  };
  arm(wait);
  toast.arm = (ms) => arm(ms ? Math.max(ms, 2000) : 0);
  toast.wait = wait;
  toast.close = close;
}
function setupToast() {
  const t = document.getElementById("toast");
  if (!t || t.dataset.ready) return;
  t.dataset.ready = "1";
  const hold = () => {
    if (toast.timer) clearTimeout(toast.timer);
  };
  const release = () => {
    if (!t.hidden && toast.wait) toast.arm(toast.wait);
  };
  t.addEventListener("pointerenter", hold);
  t.addEventListener("pointerleave", release);
  t.addEventListener("focusin", hold);
  t.addEventListener("focusout", release);
  t.querySelector(".toast-close")?.addEventListener("click", () => toast.close?.());
  t.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toast.close?.();
  });
  // Swipe toward the edge the toast sits on to dismiss it (60 px or 500 px/s); otherwise it springs back.
  swipeDismiss(t, {
    axis: "y",
    directions: () => [t.getBoundingClientRect().top < window.innerHeight / 2 ? -1 : 1],
    onStart: hold,
    onEnd: release,
    onDismiss: () => {
      clearTimeout(toast.timer);
      toast.gen = (toast.gen ?? 0) + 1;
      t.hidden = true;
    },
  });
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupToast);
  else setupToast();
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
 * The control the person used last (pointer or key), so a toast never lands on it: the button just pressed. Kept for 4s; after that only the count of covered controls decides.
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
export function copyButton(getText, { label = "Copy", done = "Copied", toastLabel = "Copied", cls = "small copy", ariaLabel } = {}) {
  const b = h("button", { type: "button", class: cls, ...(ariaLabel ? { "aria-label": ariaLabel } : {}) }, icon("copy"), label);
  b.addEventListener("click", async () => {
    const ok = await copyText(typeof getText === "function" ? getText() : getText, toastLabel);
    if (!ok) return;
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
 * wrapping mid-token.
 */
export function codeBlock(code, { title, json = false } = {}) {
  const pre = h("pre", { tabindex: "0" });
  if (json) pre.innerHTML = highlightJson(code);
  else pre.textContent = code;
  const btn = copyButton(code, { ariaLabel: title ? `Copy: ${title}` : "Copy" });
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
 * variant (no icon tile, 16 px padding).
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

/**
 * A loading placeholder for a card: a head line and `lines` shimmering text lines (class names in app.css 8). Pages may
 * return it while they wait; the router shows pageSkeleton() itself until a page has drawn.
 */
export function skeletonCard(lines = 3) {
  return h(
    "div",
    { class: "card skel-card", "aria-hidden": "true" },
    h("div", { class: "skel-head" }, h("span", { class: "skel-circle" }), h("span", { class: "skel-title" })),
    Array.from({ length: lines }, (_, i) => h("span", { class: i === lines - 1 ? "skel-line short" : i === 0 ? "skel-line" : "skel-line mid" })),
  );
}
/** The page placeholder: two skeleton cards. Announced once as "Loading" for screen readers. */
export function pageSkeleton() {
  return h("div", { class: "page-skeleton" }, h("span", { class: "sr-only", role: "status" }, "Loading…"), skeletonCard(3), skeletonCard(4));
}

const mm = (q) => typeof matchMedia === "function" && matchMedia(q).matches;

/** The one demo indicator's explanation (the toolbar's "Demo" and the phone ⋯ badge). */
export const DEMO_EXPLAINER = "Sample prices generated on this computer. Not live market data. Orders are paper only.";

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
  let closing = false;
  function close() {
    if (closed || closing) return;
    if (phone) {
      const d = document.getElementById("dialog");
      if (!d.open) return done();
      // The sheet slides away on the same spring as a swipe, then the dialog closes (focus returns to the trigger).
      closing = true;
      d.inert = true;
      sheetOut(d, d).then(() => {
        d.inert = false;
        if (d.open) d.close();
        else done();
      });
      return;
    }
    // A popover leaves with a 100 ms fade; it is inert meanwhile.
    closing = true;
    if (el) el.inert = true;
    fadeOut(el).then(() => el?.remove());
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
  // The likely fix as one button (easy-core.js fixFor): log in, open Keys, see why it is slow. A plain retry is left to the
  // caller, which knows what to run again.
  const fix = cls === "bad" && (err instanceof Error || err?.code || err?.status) ? fixFor(err) : null;
  const act = fix && fix.id !== "retry" ? h("div", { class: "alert-actions alert-fix" }, h("button", { type: "button", class: "small tinted", onclick: () => runFix(fix) }, fix.label)) : null;
  return h("div", { class: `alert ${cls}`, role: "alert" }, icon(cls === "info" ? "info" : cls === "ok" ? "check" : "warn"), h("div", {}, h("strong", {}, f.title), f.detail ? h("span", { class: "detail" }, f.detail) : null, act));
}

/** Do what a fix button says (easy-core.js fixFor): sign in again, or go to the page that explains and fixes it. */
export function runFix(fix) {
  const d = document.getElementById("dialog");
  if (d?.open) (d.closeNow ? d.closeNow() : d.close());
  if (fix.id === "login") forgetKey();
  else if (fix.id === "retry") dispatchEvent(new HashChangeEvent("hashchange"));
  else if (fix.route) location.hash = `#/${fix.route}`;
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

/** A grouped content card with an optional tinted icon tile in its header. */
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
 * Show a sheet: a bottom sheet on phones, a centred card from 720px up. The native modal
 * <dialog> keeps focus inside and returns it to the opener; Escape, the close button and a tap on the dimmed backdrop
 * close it; the page behind stops scrolling. buttons: [{ label, cls, value, onClick? }]; onClick returning false keeps
 * it open. `body` may be a function that receives close(value). Resolves with the value (undefined when dismissed).
 * A button may carry `id`, and `ref(el)` is called with its element once drawn (so callers keep a direct reference).
 * `dirty()` says there is something typed that closing would lose: Escape, the X, the backdrop, a swipe and a button that
 * answers "no" then ask "Discard changes?" inside the sheet first (a second Escape means "keep editing").
 */
export function modal({ title, body, buttons = [], canClose = null, dirty = null }) {
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
    const askDiscard = () => {
      const had = d.querySelector(".sheet-discard");
      if (had) {
        // Escape again: keep editing.
        const back = had._back;
        had.remove();
        back?.focus?.({ preventScroll: true });
        return;
      }
      const back = d.contains(document.activeElement) ? document.activeElement : null;
      const keep = h("button", { type: "button", class: "small", onclick: () => (bar.remove(), back?.focus?.({ preventScroll: true })) }, "Keep editing");
      const drop = h("button", { type: "button", class: "small destructive", onclick: () => close(undefined, true) }, "Discard");
      const bar = h("div", { class: "sheet-discard", role: "alert" }, h("strong", {}, "Discard changes?"), h("span", {}, "What you typed here is not saved."), h("div", { class: "sheet-discard-acts" }, keep, drop));
      bar._back = back;
      const actions = d.querySelector(".dialog-actions");
      if (actions) actions.before(bar);
      else d.querySelector(".dialog-body")?.append(bar);
      bar.scrollIntoView?.({ block: "nearest" });
      keep.focus({ preventScroll: true });
    };
    const close = (v, force = false) => {
      if (closing || settled) return;
      if (!force && canClose && canClose() === false) return;
      if (!force && dirty && (v === undefined || v === false || v === null) && dirty()) return askDiscard();
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
    // On a touch screen a field that takes focus raises the keyboard over the sheet at once: focus the title instead
    // (the sheet is named and the reader starts in the right place); the person taps the field when ready.
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (touch && first.closest(".dialog-body")) {
      const heading = d.querySelector(".sheet-title");
      heading?.setAttribute("tabindex", "-1");
      (heading ?? first).focus({ preventScroll: true });
    } else first.focus({ preventScroll: true });
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
/** Re-fit what measures itself after the sidebar or density changed. */
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

/** Forget the key in this tab and go back to the sign-in screen. */
export function forgetKey() {
  setKey(null);
  location.hash = "";
  location.reload();
}

// ── App boot (browser only) ──

export const app = { state: { demo: false, health: null, meta: null }, local };

async function signIn() {
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
  if (!memoryKey) {
    login.hidden = false;
    shell.hidden = true;
    document.getElementById("key-input")?.focus();
    return;
  }
  try {
    const [health, meta] = await Promise.all([api("/v1/health"), api("/v1/meta")]);
    app.state.health = health.data;
    app.state.meta = meta.data;
    app.state.demo = Boolean(health.data?.demo);
  } catch (err) {
    if (err.status === 401 || err.status === 403) setKey(null);
    login.hidden = false;
    shell.hidden = true;
    showLoginError(alertBox(err));
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
  // The trading-readiness badge in the toolbar (every page).
  import("./readiness.js").then((m) => m.mountReadinessBadge()).catch(() => {});
}

if (typeof document !== "undefined" && document.getElementById("login-form")) {
  applyTheme(local.get(THEME_SLOT) ?? "auto");
  applyLayout();
  addEventListener("resize", () => applyLayout(), { passive: true });
  if (typeof matchMedia === "function") matchMedia("(pointer: fine)").addEventListener?.("change", relayout);
  // Motion: page / sidebar entrances on navigation (a button press is CSS: app.css 8a).
  installAutoAnimations();
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
  // Sign-in: the show / hide button on the key field, and the copy buttons beside the setup commands.
  document.querySelector(".login-cmds")?.addEventListener("click", (e) => {
    const b = /** @type {Element} */ (e.target)?.closest?.("[data-copy]");
    if (b) copyText(/** @type {HTMLElement} */ (b).dataset.copy ?? "");
  });
  document.getElementById("key-toggle")?.addEventListener("click", (e) => {
    const input = document.getElementById("key-input");
    const btn = /** @type {HTMLElement} */ (e.currentTarget);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", String(show));
    btn.replaceChildren(icon(show ? "eyeoff" : "eye"));
    input.focus();
  });
  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("key-input");
    setKey(input.value.trim());
    input.value = "";
    showLoginError(null);
    signIn();
  });
  boot();
}

/**
 * A choice picked in a sideways-scrolling row (phone tab rows, chips) slides fully into view, so the
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

/** The sign-in error under the key field: the field is marked invalid and points at the message (null clears both). */
function showLoginError(node) {
  const box = document.getElementById("login-error");
  const input = document.getElementById("key-input");
  if (node) box.replaceChildren(node);
  else box.replaceChildren();
  if (node) {
    input?.setAttribute("aria-invalid", "true");
    input?.setAttribute("aria-describedby", "login-error");
  } else {
    input?.removeAttribute("aria-invalid");
    input?.removeAttribute("aria-describedby");
  }
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
    showLoginError(alertBox(result.error));
    shake(document.querySelector("#login .login-card") ?? document.getElementById("login-form"));
  }
}
