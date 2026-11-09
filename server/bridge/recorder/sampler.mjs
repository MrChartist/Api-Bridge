/**
 * One look at the market for a recording: where each row comes from and what it costs.
 *
 *   quotes   a symbol the live feed has a fresh price for is read from the feed (no broker call). A symbol the feed does
 *            not carry is read through the market service at background priority (stream, then cache, then ONE batched
 *            broker call), only when the interval is long enough (restMinSec) and the account has spare budget.
 *   chain    the option legs of each underlying + expiry come from one chain read through the market service at background
 *            priority (it answers from the feed when every leg is live, then the cache, then the broker). Other symbols of
 *            the same recording (the underlying, a future) are read like quotes.
 *
 * Only real-time rows are returned. A delayed, end-of-day or out-of-date answer is refused and counted, with the reason.
 * Calls avoided (served by the feed or the cache) are reported to the scheduler's savings counter.
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { createBackgroundGate } from "../ratelimit/backgroundGate.mjs";

const QUOTE_BATCH = 50;

const sourceOf = (f) => (f?.source === "stream" || f?.source === "cache" ? f.source : "broker");

/** Why an item is not real-time, in plain words, or null when it is. */
export function notRealtime(freshness) {
  if (!freshness) return null;
  if (freshness.class && freshness.class !== "realtime") return `${freshness.class} data${freshness.delaySec ? ` (${freshness.delaySec} s late)` : ""} from ${freshness.provider ?? freshness.source ?? "a source"}`;
  if (freshness.stale) return "an out-of-date value";
  if (freshness.source === "backup") return `a data source other than your broker (${freshness.provider ?? "backup"})`;
  return null;
}

/**
 * @param {{ marketData: any, streamHub: any, scheduler?: any, accounts?: any, now: () => number, share: () => number }} deps
 */
export function createSampler({ marketData, streamHub, scheduler, accounts, now, share }) {
  const gate = scheduler && typeof scheduler.headroom === "function" ? createBackgroundGate({ scheduler }) : null;
  const saved = (n) => {
    if (n > 0) {
      try {
        scheduler?.recordSaving?.("servedFromStream", n);
      } catch {
        /* a counter must never stop a recording */
      }
    }
  };

  /** Whether the account that would serve this class has spare budget for background work (true when unknown). */
  function budgetAllows(cls) {
    if (!gate) return { ok: true, waitMs: 0 };
    try {
      const capability = cls === "chain" ? "optionChain" : "quotes";
      const account = accounts?.marketDataCandidates?.({ capability })?.[0];
      if (!account) return { ok: true, waitMs: 0 };
      const d = gate.check(account, cls, { share: Math.min(0.5, share()) });
      return { ok: d.ok, waitMs: d.waitMs };
    } catch {
      return { ok: true, waitMs: 0 };
    }
  }

  const readOpts = (everySec, extra = {}) => ({ priority: "background", backgroundShare: Math.min(0.5, share()), maxWaitMs: Math.min(20_000, Math.max(1000, Math.floor(everySec * 500))), allowBackup: false, ...extra });

  const errorInfo = (err, what) => {
    const code = err instanceof BridgeError || err?.code ? err.code : "INTERNAL";
    return { what, code, message: err?.detail ?? err?.message ?? String(err), retryAfterMs: Number(err?.retryAfterMs) || 0 };
  };

  /**
   * Quotes for a list of symbols.
   * @param {string[]} symbols
   * @param {{ everySec: number, maxTickAgeMs: number, restMinSec: number, at: number, noRest?: boolean, noRestMs?: number }} o
   *   noRest: the broker asked us to back off, so only the live feed may be used for now
   */
  async function quotes(symbols, o) {
    const rows = [];
    const refused = [];
    const errors = [];
    const out = { rows, refused, errors, madeCalls: 0, savedCalls: 0, fromStream: 0, deferred: false, skippedStale: 0 };
    const rest = [];
    for (const symbol of symbols) {
      let live = false;
      try {
        live = streamHub?.isLive?.(symbol) === true;
      } catch {
        live = false;
      }
      if (!live) {
        rest.push(symbol);
        continue;
      }
      const t = streamHub.lastTick(symbol);
      if (!t || !(t.ltp > 0) || o.at - t.receivedAt > o.maxTickAgeMs) {
        out.skippedStale += 1; // live feed, but this symbol has not traded lately: nothing new to record, no broker call
        continue;
      }
      rows.push({ ms: o.at, symbol, ltp: t.ltp, bid: t.bid, ask: t.ask, bidQty: t.bidQty, askQty: t.askQty, volume: t.volume, oi: t.oi, open: t.open, high: t.high, low: t.low, close: t.close, tickAtMs: t.receivedAt, source: "stream" });
      out.fromStream += 1;
    }
    out.savedCalls += Math.ceil(out.fromStream / QUOTE_BATCH);
    saved(Math.ceil(out.fromStream / QUOTE_BATCH));
    if (!rest.length) return out;
    if (o.everySec < o.restMinSec) {
      errors.push({ what: "quotes", code: "FEED_NOT_LIVE", message: `${rest.length} symbol(s) are not on the live feed and the interval (${o.everySec} s) is too short to read them one call at a time (at least ${o.restMinSec} s).`, retryAfterMs: 0 });
      return out;
    }
    const b = o.noRest ? { ok: false, waitMs: o.noRestMs ?? 0 } : budgetAllows("quote");
    if (!b.ok) {
      out.deferred = true;
      errors.push({ what: "quotes", code: "BUDGET", message: `The account's spare API budget is used up for now; ${rest.length} symbol(s) were skipped this time.`, retryAfterMs: b.waitMs });
      return out;
    }
    for (let i = 0; i < rest.length; i += 500) {
      const part = rest.slice(i, i + 500);
      try {
        const res = await marketData.quotes(part, readOpts(o.everySec, { maxAgeMs: Math.max(1000, o.everySec * 500) }));
        let broker = 0;
        for (const item of res.items ?? []) {
          const why = notRealtime(item.freshness);
          if (why) {
            refused.push({ symbol: item.symbol, reason: why });
            continue;
          }
          const src = sourceOf(item.freshness);
          if (src === "broker") broker += 1;
          rows.push({
            ms: o.at,
            symbol: item.symbol,
            ltp: item.ltp,
            bid: item.bid,
            ask: item.ask,
            bidQty: item.bidQty,
            askQty: item.askQty,
            volume: item.volume,
            oi: item.oi,
            open: item.open,
            high: item.high,
            low: item.low,
            close: item.close,
            tickAtMs: Date.parse(item.freshness?.asOf) || o.at,
            source: src,
          });
          if (src === "stream") out.fromStream += 1;
        }
        for (const e of res.errors ?? []) errors.push({ what: e.symbol, code: e.code ?? "UPSTREAM_ERROR", message: e.message ?? "", retryAfterMs: 0 });
        if (broker > 0) out.madeCalls += Math.ceil(broker / QUOTE_BATCH);
        else {
          const cached = (res.items ?? []).length;
          out.savedCalls += Math.ceil(cached / QUOTE_BATCH);
          saved(Math.ceil(cached / QUOTE_BATCH));
        }
      } catch (err) {
        errors.push(errorInfo(err, "quotes"));
      }
    }
    return out;
  }

  /**
   * Chain snapshots for option symbols grouped by underlying + expiry, plus quotes for the rest.
   * @param {string[]} symbols
   * @param {{ everySec: number, maxTickAgeMs: number, restMinSec: number, at: number, greeks?: boolean }} o
   */
  async function chains(symbols, o) {
    const groups = new Map();
    const others = [];
    for (const s of symbols) {
      let p = null;
      try {
        p = parseSymbol(s);
      } catch {
        /* checked when the symbols were resolved */
      }
      if (p?.kind === "OPT") {
        const key = `${p.underlying}|${p.expiry}`;
        (groups.get(key) ?? groups.set(key, { underlying: p.underlying, expiry: p.expiry, legs: new Set() }).get(key)).legs.add(p.canonical);
      } else others.push(s);
    }
    const out = { rows: [], refused: [], errors: [], madeCalls: 0, savedCalls: 0, fromStream: 0, deferred: false, skippedStale: 0 };
    for (const g of groups.values()) {
      const allLive = [...g.legs].every((s) => {
        try {
          return streamHub?.isLive?.(s) === true;
        } catch {
          return false;
        }
      });
      if (!allLive) {
        const b = o.noRest ? { ok: false, waitMs: o.noRestMs ?? 0 } : budgetAllows("chain");
        if (!b.ok) {
          out.deferred = true;
          out.errors.push({ what: `${g.underlying} ${g.expiry}`, code: "BUDGET", message: `The account's spare API budget is used up for now; the ${g.underlying} ${g.expiry} chain was skipped this time.`, retryAfterMs: b.waitMs });
          continue;
        }
      }
      try {
        const chain = await marketData.optionChain({ underlying: g.underlying, expiry: g.expiry, greeks: o.greeks !== false }, readOpts(o.everySec));
        const why = notRealtime(chain.freshness);
        if (why) {
          out.refused.push({ symbol: `${g.underlying} ${g.expiry}`, reason: why });
          continue;
        }
        const src = sourceOf(chain.freshness);
        const tickAtMs = Date.parse(chain.freshness?.asOf) || o.at;
        let n = 0;
        for (const r of chain.rows ?? []) {
          for (const leg of [r.ce, r.pe]) {
            if (!leg?.symbol || !g.legs.has(leg.symbol)) continue;
            out.rows.push({ ms: o.at, symbol: leg.symbol, ltp: leg.ltp, bid: leg.bid, ask: leg.ask, volume: leg.volume, oi: leg.oi, oiChange: leg.oiChange, close: leg.close, iv: leg.iv, delta: leg.delta, gamma: leg.gamma, theta: leg.theta, vega: leg.vega, spot: chain.underlyingLtp, tickAtMs, source: src });
            n += 1;
          }
        }
        if (n === 0) out.errors.push({ what: `${g.underlying} ${g.expiry}`, code: "EMPTY_CHAIN", message: `The chain of ${g.underlying} ${g.expiry} had none of the legs being recorded.`, retryAfterMs: 0 });
        if (src === "broker") out.madeCalls += 1;
        else {
          out.savedCalls += 1;
          if (src === "stream") out.fromStream += n;
          saved(1);
        }
      } catch (err) {
        out.errors.push(errorInfo(err, `${g.underlying} ${g.expiry}`));
      }
    }
    if (others.length) {
      const q = await quotes(others, o);
      out.rows.push(...q.rows);
      out.refused.push(...q.refused);
      out.errors.push(...q.errors);
      out.madeCalls += q.madeCalls;
      out.savedCalls += q.savedCalls;
      out.fromStream += q.fromStream;
      out.deferred ||= q.deferred;
      out.skippedStale += q.skippedStale;
    }
    return out;
  }

  return { quotes, chains, budgetAllows };
}
