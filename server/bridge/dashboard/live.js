// One live connection per browser tab (WebSocket /v1/stream), shared by every page: the chain, OI, Strategy and
// Positions watch their symbols here instead of each polling the Bridge, and the budget indicator listens for
// `budget` messages. A symbol watched by three pages is subscribed once; a symbol nobody watches any more is
// unsubscribed after a short linger, so switching pages back and forth does not churn the broker feed.
//
// Ticks are delivered once per animation frame, newest value per symbol (a page draws each frame at most once).
// Pure helpers (subscriptionDiff, mergeTick) are exported for tests; the connection code runs only in a browser.

import { api } from "./app.js";

/** How long a symbol stays subscribed after its last watcher left (a page switch and back keeps it). */
export const LINGER_MS = 15_000;
/** Largest subscribe op the Bridge takes in one message (stream.maxSymbolsPerRequest default). */
export const OP_CHUNK = 200;
/**
 * Ticks are handed to pages at most this often. A broker feed sends a burst of ticks over a few frames; one delivery
 * per burst means one redraw of the chain instead of four (each redraw is a full patch and layout of the table).
 */
export const DELIVER_MIN_MS = 150;

/**
 * What to subscribe and unsubscribe (pure): `want` symbol -> mode, `have` symbol -> mode on the wire. A symbol whose
 * mode must rise is subscribed again at the higher mode; modes never fall while subscribed.
 * @returns {{ subscribe: Map<string, string[]>, unsubscribe: string[] }}  subscribe: mode -> symbols
 */
export function subscriptionDiff(want, have) {
  const rank = { ltp: 0, quote: 1, depth: 2 };
  const subscribe = new Map();
  for (const [sym, mode] of want) {
    const cur = have.get(sym);
    if (cur !== undefined && rank[cur] >= rank[mode]) continue;
    if (!subscribe.has(mode)) subscribe.set(mode, []);
    subscribe.get(mode).push(sym);
  }
  const unsubscribe = [...have.keys()].filter((s) => !want.has(s));
  return { subscribe, unsubscribe };
}

/** A tick merged over the last one for its symbol (pure): null fields of a lighter mode never wipe known values. */
export function mergeTick(prev, tick) {
  if (!prev) return { ...tick };
  const out = { ...prev };
  for (const [k, v] of Object.entries(tick)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// ── Connection (browser only) ──

const watchers = new Set(); // { symbols: Set, mode, onTicks }
const lingering = new Map(); // symbol -> { mode, until }
const onWire = new Map(); // symbol -> mode
const latest = new Map(); // symbol -> merged tick
const budgetListeners = new Set();
/** Saved-scan alerts (subscribe_scans): fn(msg) for each { type: "scan", event: "alert" }. */
const scanListeners = new Set();
const statusListeners = new Set();
let lastBudget = null;
let ws = null;
let state = "off"; // off | connecting | live | down
let retry = 0;
let syncQueued = false;
let pendingTicks = new Map();
let frameQueued = false;
let lingerTimer = null;
let deliveredAt = 0;

const inBrowser = () => typeof window !== "undefined" && typeof WebSocket !== "undefined";

function setState(s) {
  if (s === state) return;
  state = s;
  for (const fn of statusListeners) {
    try {
      fn(s);
    } catch {
      /* a listener error must not stop the others */
    }
  }
}

/** live | connecting | down | off */
export const liveState = () => state;

/** Call fn(state) on every change; returns an unsubscribe function. */
export function onLiveState(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function wanted() {
  const want = new Map();
  const rank = { ltp: 0, quote: 1, depth: 2 };
  const add = (sym, mode) => {
    const cur = want.get(sym);
    if (cur === undefined || rank[mode] > rank[cur]) want.set(sym, mode);
  };
  for (const w of watchers) for (const s of w.symbols) add(s, w.mode);
  const t = Date.now();
  for (const [s, l] of lingering) {
    if (l.until <= t) lingering.delete(s);
    else add(s, l.mode);
  }
  return want;
}

function send(op) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(op));
}

function sync() {
  syncQueued = false;
  if (!inBrowser()) return;
  if (!ws && (watchers.size || budgetListeners.size || scanListeners.size)) connect();
  if (ws?.readyState !== 1) return;
  const { subscribe, unsubscribe } = subscriptionDiff(wanted(), onWire);
  for (const [mode, syms] of subscribe) {
    for (let i = 0; i < syms.length; i += OP_CHUNK) {
      const part = syms.slice(i, i + OP_CHUNK);
      send({ op: "subscribe", symbols: part, mode });
      for (const s of part) onWire.set(s, mode);
    }
  }
  for (let i = 0; i < unsubscribe.length; i += OP_CHUNK) {
    const part = unsubscribe.slice(i, i + OP_CHUNK);
    send({ op: "unsubscribe", symbols: part });
    for (const s of part) {
      onWire.delete(s);
      latest.delete(s);
    }
  }
  scheduleLingerSweep();
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(sync);
}

function scheduleLingerSweep() {
  if (lingerTimer || !lingering.size) return;
  const next = Math.min(...[...lingering.values()].map((l) => l.until));
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    queueSync();
  }, Math.max(250, next - Date.now() + 50));
}

function deliver() {
  frameQueued = false;
  deliveredAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const batch = pendingTicks;
  pendingTicks = new Map();
  for (const w of watchers) {
    let mine = null;
    for (const [sym, tick] of batch) {
      if (!w.symbols.has(sym)) continue;
      (mine ??= new Map()).set(sym, tick);
    }
    if (!mine) continue;
    try {
      w.onTicks(mine);
    } catch {
      /* one page's error must not stop another page's ticks */
    }
  }
}

function acceptTick(t) {
  if (!t?.symbol) return;
  const merged = mergeTick(latest.get(t.symbol), t);
  latest.set(t.symbol, merged);
  pendingTicks.set(t.symbol, merged);
  if (!frameQueued) {
    frameQueued = true;
    // A hidden tab gets no animation frames; deliver on a timer there so the data is current when it comes back.
    // Otherwise the next frame, but no sooner than DELIVER_MIN_MS after the last delivery.
    const wait = Math.max(0, DELIVER_MIN_MS - (performance.now() - deliveredAt));
    if (typeof document !== "undefined" && document.hidden) setTimeout(deliver, 250);
    else if (wait > 0) setTimeout(() => requestAnimationFrame(deliver), wait);
    else requestAnimationFrame(deliver);
  }
}

async function connect() {
  if (ws || !inBrowser()) return;
  setState("connecting");
  ws = { readyState: 0, send() {}, close() {} }; // placeholder while the token is fetched
  let token;
  try {
    token = (await api("/v1/stream/token", { method: "POST" })).data?.data?.token;
  } catch {
    token = null;
  }
  if (!token) {
    ws = null;
    return later();
  }
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/stream?token=${encodeURIComponent(token)}`;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch {
    ws = null;
    return later();
  }
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    onWire.clear();
    setState("live");
    if (budgetListeners.size) send({ op: "subscribe_budget" });
    if (scanListeners.size) send({ op: "subscribe_scans" });
    queueSync();
  };
  sock.onmessage = (m) => {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.type === "tick") acceptTick(msg);
    else if (msg.type === "snapshot") for (const t of msg.ticks ?? []) acceptTick(t);
    else if (msg.type === "budget") {
      lastBudget = msg;
      for (const fn of budgetListeners) {
        try {
          fn(msg);
        } catch {
          /* keep going */
        }
      }
    } else if (msg.type === "scan" && msg.event === "alert") {
      for (const fn of scanListeners) {
        try {
          fn(msg);
        } catch {
          /* keep going */
        }
      }
    } else if (msg.type === "error" && msg.op === "subscribe" && Array.isArray(msg.symbols)) {
      // Over a subscription cap: those symbols stay with polling (the pages keep their REST refresh).
      for (const s of msg.symbols) onWire.delete(s);
    } else if (msg.type === "go_away") {
      retry = Math.max(retry, 1);
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    onWire.clear();
    if (watchers.size || budgetListeners.size || scanListeners.size) later();
    else setState("off");
  };
}

function later() {
  setState("down");
  retry += 1;
  setTimeout(() => queueSync(), Math.min(15_000, 500 * 2 ** Math.min(retry, 5)));
}

/**
 * Watch symbols. `onTicks(Map<symbol, tick>)` runs at most once per animation frame with the newest tick of each
 * changed symbol (merged with what was known). Returns { update(symbols), stop(), last(symbol) }.
 * @param {string[]} symbols canonical symbols
 * @param {"ltp"|"quote"|"depth"} mode
 * @param {(ticks: Map<string, object>) => void} onTicks
 */
export function watch(symbols, mode, onTicks) {
  const w = { symbols: new Set(symbols ?? []), mode, onTicks };
  watchers.add(w);
  for (const s of w.symbols) lingering.delete(s);
  queueSync();
  // Values already known (another page watches them) are delivered at once.
  const known = new Map([...w.symbols].filter((s) => latest.has(s)).map((s) => [s, latest.get(s)]));
  if (known.size) queueMicrotask(() => watchers.has(w) && onTicks(known));
  const release = (syms) => {
    const until = Date.now() + LINGER_MS;
    for (const s of syms) lingering.set(s, { mode: w.mode, until });
  };
  return {
    update(next) {
      const n = new Set(next ?? []);
      release([...w.symbols].filter((s) => !n.has(s)));
      for (const s of n) lingering.delete(s);
      w.symbols = n;
      queueSync();
    },
    stop() {
      if (!watchers.delete(w)) return;
      release(w.symbols);
      queueSync();
    },
    last: (s) => latest.get(s) ?? null,
    get live() {
      return state === "live";
    },
  };
}

/** The newest tick known for a symbol, or null. */
export const lastTick = (s) => latest.get(s) ?? null;

/** Listen for API budget messages (ratelimit/budget.mjs). Returns an unsubscribe function. */
export function onBudget(fn) {
  budgetListeners.add(fn);
  if (lastBudget) queueMicrotask(() => budgetListeners.has(fn) && fn(lastBudget));
  if (ws?.readyState === 1 && budgetListeners.size === 1) send({ op: "subscribe_budget" });
  queueSync();
  return () => {
    budgetListeners.delete(fn);
    if (!budgetListeners.size) send({ op: "unsubscribe_budget" });
  };
}

/** Listen for saved-scan alerts (new matches). Returns an unsubscribe function. */
export function onScanAlerts(fn) {
  scanListeners.add(fn);
  if (ws?.readyState === 1 && scanListeners.size === 1) send({ op: "subscribe_scans" });
  queueSync();
  return () => {
    scanListeners.delete(fn);
    if (!scanListeners.size) send({ op: "unsubscribe_scans" });
  };
}
