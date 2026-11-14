// One live connection per browser tab (WebSocket /v1/stream), shared by every page: pages that poll a price watch
// their symbols here instead (api() in app.js does this for repeated reads), and the budget indicator listens for
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
 * Ticks are handed to a page at most this often by default. A broker feed sends a burst of ticks over a few frames;
 * one delivery per burst means one redraw of a page that redraws a whole view instead of four. A page that
 * patches only the cells a tick changed asks for every frame (watch(..., { minGapMs: 0 })).
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
const statusListeners = new Set();
let lastBudget = null;
let ws = null;
let state = "off"; // off | connecting | live | down
let retry = 0;
let syncQueued = false;
let frameQueued = false;
let frameDue = 0;
let lingerTimer = null;

const inBrowser = () => typeof window !== "undefined" && typeof WebSocket !== "undefined";

const wantsConnection = () => watchers.size > 0 || budgetListeners.size > 0;

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
  if (!ws && wantsConnection()) connect();
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

const clockMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Hand each watcher its pending ticks when its own gap since its last delivery has passed; queue the rest. */
function deliver() {
  frameQueued = false;
  const t = clockMs();
  let next = Infinity;
  for (const w of watchers) {
    if (!w.pending.size) continue;
    const wait = w.minGapMs - (t - w.deliveredAt);
    if (wait > 1) {
      next = Math.min(next, wait);
      continue;
    }
    const mine = w.pending;
    w.pending = new Map();
    w.deliveredAt = t;
    try {
      w.onTicks(mine);
    } catch {
      /* one page's error must not stop another page's ticks */
    }
  }
  if (next < Infinity) queueFrame(next);
}

/**
 * The next delivery: the next animation frame, `wait` ms from now at the soonest. A hidden tab gets no animation
 * frames; it is delivered on a timer there so the data is current when it comes back.
 */
function queueFrame(wait = 0) {
  const due = clockMs() + wait;
  // One delivery queued at a time, unless this one is due sooner (a per-frame watcher behind a 150 ms one).
  if (frameQueued && due >= frameDue - 1) return;
  frameQueued = true;
  frameDue = due;
  if (typeof document !== "undefined" && document.hidden) setTimeout(deliver, Math.max(250, wait));
  else if (wait > 1) setTimeout(() => requestAnimationFrame(deliver), wait);
  else requestAnimationFrame(deliver);
}

function acceptTick(t) {
  if (!t?.symbol) return;
  const merged = mergeTick(latest.get(t.symbol), t);
  latest.set(t.symbol, merged);
  let soonest = Infinity;
  const now = clockMs();
  for (const w of watchers) {
    if (!w.symbols.has(t.symbol)) continue;
    w.pending.set(t.symbol, merged);
    soonest = Math.min(soonest, Math.max(0, w.minGapMs - (now - w.deliveredAt)));
  }
  if (soonest < Infinity) queueFrame(soonest);
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
    if (wantsConnection()) later();
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
 * changed symbol (merged with what was known), and no sooner than `minGapMs` after its last delivery
 * (DELIVER_MIN_MS by default: a page that redraws a whole view per delivery; 0 for a page that patches only the
 * cells a tick changed). Returns { update(symbols), stop(), last(symbol) }.
 * @param {string[]} symbols canonical symbols
 * @param {"ltp"|"quote"|"depth"} mode
 * @param {(ticks: Map<string, object>) => void} onTicks
 * @param {{ minGapMs?: number }} [opts]
 */
export function watch(symbols, mode, onTicks, { minGapMs = DELIVER_MIN_MS } = {}) {
  const w = { symbols: new Set(symbols ?? []), mode, onTicks, minGapMs: Math.max(0, Number(minGapMs) || 0), pending: new Map(), deliveredAt: -Infinity };
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
      for (const s of w.pending.keys()) if (!n.has(s)) w.pending.delete(s);
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

