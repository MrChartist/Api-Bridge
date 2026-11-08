/**
 * Demo-mode sources. They make NO network calls and serve deterministic sample data derived from the demo market
 * (demo/demoAdapter.mjs), so the dashboard and the tests can show every state a source can be in:
 *
 *   demo          broker, builtin, realtime. A descriptor only (the demo broker account answers through the
 *                 accounts module); it makes the broker row appear next to the others.
 *   demo-delayed  free, opt-in, class delayed (900 s), unofficial, noticeVersion "demo-1". Needs the notice acknowledged.
 *   demo-eod      free, byok, class eod. Needs a key (any text of 4+ characters; it is only checked for being present).
 *
 * Registered only when the Bridge runs in demo mode (registerBuiltinSources in builtin.mjs). The sample prices are the
 * demo market's own, shifted back in time: delayed = 15 minutes ago, end-of-day = the last weekday's close.
 */
import { DEMO_BROKER_ID } from "../demo/demoAdapter.mjs";
import { candles, demoChainAt, demoUnderlying, expiriesFor, quoteOf, spotAt } from "../demo/demoAdapter.mjs";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { DEFAULT_SESSIONS } from "../reference/defaults.mjs";

export const DEMO_DELAYED_ID = "demo-delayed";
export const DEMO_EOD_ID = "demo-eod";
export const DEMO_NOTICE_VERSION = "demo-1";
export const DEMO_DELAY_SEC = 900;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const TERMS = Object.freeze({ url: "https://example.invalid/demo-sample-data", note: "Sample data made on this computer to show how a delayed or end-of-day source looks. Nothing real is read." });
const noQuote = (symbol) => new BridgeError("SYMBOL_NOT_FOUND", `The demo sources only know index and cash symbols of the demo market, not ${symbol}.`);

/** Minutes after IST midnight at which the demo market closes (the reference default session, not a literal here). */
const CLOSE_MINUTES = (() => {
  const [h, m] = DEFAULT_SESSIONS.NSE.close.split(":").map(Number);
  return h * 60 + m;
})();

/** The IST weekday close at or before `now`, as epoch ms. */
export function lastCloseAtOrBefore(now) {
  let day = Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  let close = day + CLOSE_MINUTES * 60_000 - IST_OFFSET_MS;
  if (close > now) {
    day -= DAY_MS;
    close -= DAY_MS;
  }
  for (;;) {
    const weekday = new Date(close + IST_OFFSET_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return close;
    close -= DAY_MS;
  }
}

/** Demo token and exchange of a cash or index symbol, or null. */
function cashToken(symbol) {
  try {
    const p = parseSymbol(symbol);
    if ((p.kind !== "EQ" && p.kind !== "INDEX") || !demoUnderlying(p.underlying)) return null;
    return { token: `DM-${p.underlying}`, exchange: p.exchange, underlying: p.underlying };
  } catch {
    return null;
  }
}

/** Demo underlying of a name like NIFTY or a canonical symbol, or null. */
function underlyingOf(text) {
  const name = String(text ?? "").includes(":") ? (cashToken(text)?.underlying ?? null) : String(text ?? "").toUpperCase();
  return name && demoUnderlying(name)?.expiry ? name : null;
}

function quotesAt(symbols, at, { full }) {
  const items = [];
  for (const symbol of symbols) {
    const c = cashToken(symbol);
    if (!c) continue;
    const q = quoteOf(c.token, c.exchange, at);
    if (!q) continue;
    const fields = full
      ? { ltp: q.ltp, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, oi: null, bid: q.bid, ask: q.ask, bidQty: q.bidQty, askQty: q.askQty }
      : { ltp: q.ltp, open: q.open, high: q.high, low: q.low, close: q.ltp, volume: q.volume, oi: null, bid: null, ask: null, bidQty: null, askQty: null };
    items.push({ symbol, fields, at });
  }
  return { items };
}

function historyOf(req, clip) {
  const c = cashToken(req.symbol);
  if (!c) throw noQuote(req.symbol);
  const toMs = Math.min(req.toMs, clip);
  return { candles: candles(c.token, req.interval, req.fromMs, toMs), partial: toMs < req.toMs, at: Math.min(clip, Math.max(req.fromMs, toMs)) };
}

function chainOf(underlying, expiry, at) {
  const u = underlyingOf(underlying);
  if (!u) throw new BridgeError("SYMBOL_NOT_FOUND", `The demo sources have no options on ${underlying}.`);
  const day = expiry ?? expiriesFor(u, at, 1)[0];
  const chain = demoChainAt(u, day, at);
  if (!chain) throw new BridgeError("SYMBOL_NOT_FOUND", `The demo sources have no chain for ${underlying} ${day}.`);
  return { expiry: day, underlyingLtp: chain.underlyingLtp, rows: chain.rows, at };
}

/** The demo broker as a descriptor only: its reads go through the accounts module, not through a source. */
export function demoBrokerSource() {
  return {
    descriptor: {
      id: DEMO_BROKER_ID,
      name: "Demo market data (sample, not live)",
      kind: "broker",
      tier: "builtin",
      class: "realtime",
      delaySec: null,
      official: true,
      capabilities: ["quotes", "history", "expiries", "optionChain"],
      limits: { perSecond: 10, perMinute: 400 },
    },
  };
}

/** Sample 15-minute-delayed source. Opt-in: off until the notice is acknowledged. */
export function demoDelayedSource() {
  return {
    descriptor: {
      id: DEMO_DELAYED_ID,
      name: "Demo delayed data (sample)",
      kind: "free",
      tier: "opt-in",
      class: "delayed",
      delaySec: DEMO_DELAY_SEC,
      official: false,
      capabilities: ["quotes", "history", "expiries", "optionChain"],
      limits: { perSecond: 2, perMinute: 60, perDay: 2000 },
      terms: TERMS,
      noticeVersion: DEMO_NOTICE_VERSION,
      needsKey: false,
    },
    async quotes(symbols, ctx) {
      return quotesAt(symbols, ctx.now - DEMO_DELAY_SEC * 1000, { full: true });
    },
    async history(req, ctx) {
      return historyOf(req, ctx.now - DEMO_DELAY_SEC * 1000);
    },
    async expiries(underlying, ctx) {
      const u = underlyingOf(underlying);
      if (!u) throw new BridgeError("SYMBOL_NOT_FOUND", `The demo sources have no expiries for ${underlying}.`);
      return { expiries: expiriesFor(u, ctx.now, 4), at: ctx.now - DEMO_DELAY_SEC * 1000 };
    },
    async optionChain(underlying, expiry, ctx) {
      return chainOf(underlying, expiry, ctx.now - DEMO_DELAY_SEC * 1000);
    },
    async test(ctx) {
      return { ok: spotAt("NIFTY", ctx.now) > 0, latencyMs: 1, detail: "Sample data answered." };
    },
  };
}

/** Sample end-of-day source. BYOK: off until a key is saved. */
export function demoEodSource() {
  return {
    descriptor: {
      id: DEMO_EOD_ID,
      name: "Demo end-of-day data (sample)",
      kind: "free",
      tier: "byok",
      class: "eod",
      delaySec: null,
      official: true,
      capabilities: ["quotes", "history"],
      limits: { perMinute: 5, perDay: 25 },
      terms: TERMS,
      needsKey: true,
    },
    async quotes(symbols, ctx) {
      return quotesAt(symbols, lastCloseAtOrBefore(ctx.now), { full: false });
    },
    async history(req, ctx) {
      if (req.interval !== "1d") throw new BridgeError("CAPABILITY_UNSUPPORTED", "The demo end-of-day source has daily candles only.");
      return historyOf(req, lastCloseAtOrBefore(ctx.now));
    },
    async test(ctx) {
      return ctx.apiKey ? { ok: true, latencyMs: 1, detail: "Key accepted by the sample source." } : { ok: false, detail: "No key." };
    },
  };
}

/** Register the demo sources. @param {{ register(p: object): unknown }} registry */
export function registerDemoSources(registry) {
  registry.register(demoBrokerSource());
  registry.register(demoDelayedSource());
  registry.register(demoEodSource());
}
