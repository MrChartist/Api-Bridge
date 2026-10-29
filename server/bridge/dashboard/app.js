// Mr. Chartist API Bridge — local dashboard. Talks only to this Bridge (same origin). The API key lives in
// sessionStorage for this tab and is sent as a Bearer header; it is never put in a URL.
// Opened from `mc-bridge start --open` or `mc-bridge open`, the URL carries a one-time sign-in code in its fragment
// (#signin=<code>): it is removed from the address bar before anything else and exchanged for a key (POST /v1/sign-in).
// Pure helpers (ticketFields, confirmCodeNotice, friendlyError ...) are exported for tests; DOM code runs only in a browser.

import { animateNav, animatePage, bannerIn, bannerOut, installAutoAnimations, installPressFeedback, pulse, sheetIn, sheetOut, shake } from "./motion.js";
import { DASH, ageText, formatRupee } from "./format.js";

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
      return { title: "That key was not accepted", detail: "It may be mistyped, expired or revoked. Open the Bridge again from its shortcut (or run mc-bridge open) to sign in without a key, or create a new one with: npm run bridge -- keys create --label me --scope admin,paper" };
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
      return { title: "Symbol not found", detail: `${detail} Symbols look like NSE:RELIANCE, NSE:NIFTY or NFO:NIFTY-2026-10-27-25000-CE.` };
    case "VALIDATION_FAILED":
      return { title: "Please check the form", detail };
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

/** Call the Bridge. Returns { data, headers, status, ms, text }. With raw: true, error answers are returned too. */
export async function api(path, { method = "GET", body, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${memoryKey}`, "X-MCB-Client": "dashboard" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("The Bridge did not answer.", { network: true });
  }
  const ms = Math.round(performance.now() - t0);
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let data = text;
  if (ct.includes("json") && text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as text */
    }
  }
  if (!res.ok && !raw) throw new ApiError(data?.detail ?? data?.title ?? `HTTP ${res.status}`, { status: res.status, code: data?.code, body: data });
  return { data, headers: res.headers, status: res.status, ms, text };
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
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  strategy: '<path d="M3 17h5l4-10 4 10h5"/><path d="M3 21h18"/>',
  bars: '<path d="M4 20V10M9 20V4M14 20v-7M19 20V8"/>',
  wave: '<path d="M3 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0"/><path d="M3 20h18"/>',
  scale: '<path d="M12 4v16M5 20h14M4 8h16"/><path d="m4 8-2.5 6h5zM20 8l-2.5 6h5z"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
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
export function toast(text) {
  const t = document.getElementById("toast");
  const gen = (toast.gen = (toast.gen ?? 0) + 1);
  const wasHidden = t.hidden;
  t.replaceChildren(h("span", { class: "toast-icon" }, icon("check")), h("span", { class: "toast-text" }, text));
  t.hidden = false;
  if (wasHidden) bannerIn(t);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    // Hide after sliding out, unless another toast took over meanwhile.
    bannerOut(t).then(() => {
      if (toast.gen === gen) t.hidden = true;
    });
  }, 2600);
}

export async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", {}, text);
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* the person can still select the text */
    }
    ta.remove();
  }
  toast(label);
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

/** A code block with a copy button. `onCopy` runs after copying (the welcome checklist listens). */
export function codeBlock(code, { title, json = false, onCopy } = {}) {
  const pre = h("pre", { tabindex: "0" });
  if (json) pre.innerHTML = highlightJson(code);
  else pre.textContent = code;
  const btn = h("button", { type: "button", class: "small copy", onclick: () => copyText(code).then(() => onCopy?.()) }, icon("copy"), "Copy");
  return h("div", { class: "code-block" }, title ? h("div", { class: "code-title" }, title) : null, h("div", { class: "code" }, pre, btn));
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
  const auth = ["SESSION_EXPIRED", "UNAUTHENTICATED", "NO_ACCOUNT", "BROKER_UNAVAILABLE"].includes(err?.code);
  const retry = onRetry ? h("button", { type: "button", class: "small err-retry", onclick: () => onRetry() }, icon("refresh"), "Retry") : null;
  if (lastGood) {
    return h(
      "div",
      { class: "err-bar", role: "alert" },
      icon("warn"),
      h("span", { class: "err-text" }, h("strong", {}, `Couldn't refresh: ${f.title}.`), ` Showing ${istTime(lastGood)}.`),
      retry,
    );
  }
  return h(
    "div",
    { class: "err-state", role: "alert" },
    h("strong", {}, f.title),
    f.detail ? h("p", {}, f.detail) : null,
    h("div", { class: "empty-acts" }, retry, auth ? h("a", { href: "#/accounts", class: "err-link" }, "Accounts") : null),
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
      el.dataset.kind = kind;
      el.setAttribute("aria-pressed", String(live));
      glyph.replaceChildren(live ? "" : icon("pause"));
      const what = live ? `Live: refreshing every ${refreshMs / 1000} s. ${touchWord()} to pause${keyHint(" (P)")}` : `Paused. ${touchWord()} to resume${keyHint(" (P)")}`;
      el.title = [what, source ? `Data from ${source}` : "", asOf ? `${istDateTime(asOf)} IST` : ""].filter(Boolean).join(" · ");
      el.setAttribute("aria-label", `${live ? "Live" : "Paused"}, data ${kind === "live" && asOf ? `as of ${t}` : words}. ${live ? "Pause" : "Resume"} updates`);
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

/** The one demo indicator's explanation (the toolbar's "Demo" and the phone ⋯ badge). */
export const DEMO_EXPLAINER = "Sample prices generated on this computer. Not live market data. Orders are paper only.";

/** The shared placeholder for the owner's chart engine: fixed aspect ratio, dashed hairline, centred caption. */
export function chartSlot(label, sub = "") {
  return h("div", { class: "chart-slot-box", role: "img", "aria-label": `Chart engine slot: ${label}` }, h("span", { class: "chart-slot-kicker" }, "Chart engine slot"), h("span", { class: "chart-slot-label" }, label), sub ? h("span", { class: "chart-slot-sub" }, sub) : null);
}

/**
 * A popover that is a bottom sheet on phones (< 720 px, in #dialog with aria-modal) and a body-attached popover from
 * 720 px up, placed against the trigger and clamped to the viewport (never clipped by a panel). Both trap Tab, close
 * on Esc and return focus to the trigger. Returns { el, close() }; `onClose` runs once.
 */
export function sheetPopover({ trigger, title, body, head = [], cls = "", onClose = null }) {
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
    document.removeEventListener("pointerdown", outside, true);
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
      const left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w));
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
  (body.querySelector?.("button, input, select") ?? closeBtn).focus({ preventScroll: true });
  return { el, close, place };
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
      h("tbody", {}, rows.map((r) => h("tr", {}, columns.map((c, i) => h("td", { class: cls(c, i), "data-label": c.label || undefined }, c.cell(r)))))),
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

/** A numbered section eyebrow ("01  GET STARTED ———"), as IPO Decode's SectionEyebrow. */
export function sectionEyebrow(index, label) {
  return h("div", { class: "sec-eyebrow" }, h("b", {}, index), h("span", {}, label), h("i", { "aria-hidden": "true" }));
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
    let settled = false;
    let closing = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      d.removeEventListener("cancel", onCancel);
      d.removeEventListener("close", onClose);
      d.removeEventListener("click", onBackdrop);
      if (modal.token === token) lockScroll(false);
      resolve(v);
    };
    // Animate the sheet away, then close the native dialog (focus returns to the opener) and resolve.
    // canClose() === false refuses Escape, the X and a backdrop tap (e.g. while orders are going out). The body's own
    // buttons pass force = true once they have decided.
    const close = (v, force = false) => {
      if (closing || settled) return;
      if (!force && canClose && canClose() === false) return;
      closing = true;
      sheetOut(d, d).then(() => {
        if (modal.token === token && d.open) d.close();
        finish(v);
      });
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
export function checklistState({ demo = false, accounts = [], keys = [], copied = false, tested = false }) {
  const brokerConnected = accounts.some((a) => a.broker !== "paper" && a.session?.state === "connected");
  // Keys made by sign-in links are the dashboard's own, not a key for a tool.
  const activeKeys = keys.filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()) && !(k.clientKind === "ui" && k.label === SIGN_IN_KEY_LABEL));
  return [
    { id: "broker", done: demo || brokerConnected },
    { id: "key", done: activeKeys.length >= 2 },
    { id: "snippet", done: Boolean(copied) },
    { id: "test", done: Boolean(tested) },
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

// ── Theme ──

export function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  else root.removeAttribute("data-theme");
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === (choice ?? "auto")));
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
}

if (typeof document !== "undefined" && document.getElementById("login-form")) {
  applyTheme(local.get(THEME_SLOT) ?? "auto");
  // Motion: button press feedback, and page / sidebar entrances on navigation.
  installPressFeedback(document);
  installAutoAnimations();
  // Appearance buttons (the sidebar's and the More sheet's) and "Forget key", wherever they are drawn.
  document.addEventListener("click", (e) => {
    const t = /** @type {Element} */ (e.target);
    const choice = t?.closest?.("[data-theme-choice]");
    if (choice) chooseTheme(/** @type {HTMLElement} */ (choice).dataset.themeChoice);
    else if (t?.closest?.("[data-action=logout]")) forgetKey();
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
