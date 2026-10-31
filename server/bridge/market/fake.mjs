/**
 * In-memory MarketDataService for OTHER streams' tests (S7 orders, S8 paper, S10 integrations, S11 MCP/hooks). It
 * satisfies SERVICE_CONTRACTS.marketData exactly, needs no accounts, scheduler, symbols or stream hub, makes no
 * broker call and touches no disk. Prices are whatever the test sets; everything else is derived deterministically.
 *
 *   import { createFakeMarketData } from "../market/fake.mjs";
 *   const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25010, "NFO:NIFTY-2026-10-27-25000-CE": 120.5 } });
 *   md.setPrice("NSE:RELIANCE", 1402.3);                 // or setQuote(symbol, { ltp, bid, ask, ... })
 *   md.setDepth("NSE:RELIANCE", { bids: [{ price: 1402, qty: 50 }], asks: [{ price: 1402.5, qty: 10 }] });
 *   md.setCandles("NSE:NIFTY", "1d", [{ time, open, high, low, close, volume }]);
 *   md.setExpiries("NIFTY", ["2026-10-20", "2026-10-27"]);
 *   md.setChain("NIFTY", "2026-10-27", chainObject);       // else one is built around the underlying's price
 *   md.fail("NSE:INFY", "UPSTREAM_ERROR");               // per-item error (ltp/quotes) or thrown (depth/history)
 *   md.calls                                             // [["ltp", ["NSE:NIFTY"], { maxAgeMs: 0 }], ...]
 *
 * Symbols are canonicalised with core/symbolFormat.mjs (lenient input). Unknown symbols give SYMBOL_NOT_FOUND.
 * Freshness: source (default "broker"), accountId (default "fake-1"), broker (default "fake"), ageMs 0, stale false.
 */
import { assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { atmStrike, defaultOptionExchange, legSymbol, trimStrikes } from "./chain.mjs";
import { freshness, quoteFields } from "./normalise.mjs";

/**
 * @param {{ prices?: Record<string, number>, clock?: { now(): number }, source?: "stream"|"cache"|"broker"|"paper",
 *   accountId?: string | null, broker?: string | null, strikeStep?: number }} [opts]
 */
export function createFakeMarketData({ prices = {}, clock = { now: () => Date.now() }, source = "broker", accountId = "fake-1", broker = "fake", strikeStep = 50 } = {}) {
  const calls = [];
  /** canonical -> quote fields */
  const quotes = new Map();
  const depths = new Map();
  const candles = new Map();
  const expiryMap = new Map();
  const chains = new Map();
  const failures = new Map();

  const canon = (s) => parseSymbol(s).canonical;
  const fresh = () => freshness({ source, at: clock.now(), now: clock.now(), targetMs: 1000, stale: false, accountId, broker });
  const record = (name, ...args) => calls.push([name, ...args.map((a) => (a && typeof a === "object" ? strip(a) : a))]);
  const strip = (o) => {
    if (Array.isArray(o)) return [...o];
    const { signal, ...rest } = o;
    void signal;
    return structuredClone(rest);
  };
  const failure = (symbol) => {
    const code = failures.get(symbol);
    return code ? new BridgeError(code, `Fake failure for ${symbol}.`) : null;
  };
  const getQuote = (symbol) => {
    const f = failure(symbol);
    if (f) throw f;
    const q = quotes.get(symbol);
    if (!q) throw new BridgeError("SYMBOL_NOT_FOUND", `No fake price for ${symbol}.`);
    return q;
  };

  function setQuote(symbol, q) {
    const fields = quoteFields({ ...q, ltp: q.ltp });
    if (!fields) throw new Error(`fake market data: ${symbol} needs a positive ltp`);
    quotes.set(canon(symbol), fields);
  }
  for (const [s, p] of Object.entries(prices)) setQuote(s, { ltp: p });

  async function many(name, list, opts, pick) {
    record(name, list, opts ?? {});
    if (!Array.isArray(list) || list.length === 0) throw new BridgeError("VALIDATION_FAILED", "Give at least one symbol.");
    const items = [];
    const errors = [];
    const seen = new Set();
    for (const input of list) {
      let symbol;
      try {
        symbol = canon(input);
      } catch (err) {
        errors.push({ symbol: String(input), code: err.code ?? "VALIDATION_FAILED", message: err.detail ?? err.message });
        continue;
      }
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      try {
        items.push(pick(symbol, getQuote(symbol)));
      } catch (err) {
        errors.push({ symbol, code: err.code ?? "INTERNAL", message: err.detail ?? err.message });
      }
    }
    return { items, errors };
  }

  function syntheticChain(underlying, expiry, spot) {
    const exchange = defaultOptionExchange(underlying);
    const centre = Math.round(spot / strikeStep) * strikeStep;
    const rows = [];
    for (let i = -5; i <= 5; i += 1) {
      const strike = centre + i * strikeStep;
      if (strike <= 0) continue;
      const leg = (right) => {
        const intrinsic = right === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
        const ltp = Math.round((intrinsic + 20 + Math.abs(i) * 2) * 100) / 100;
        return { symbol: legSymbol(exchange, underlying, expiry, strike, right), ltp, bid: ltp - 0.5, ask: ltp + 0.5, oi: 1000, oiChange: 0, volume: 100, iv: null, delta: null, gamma: null, theta: null, vega: null, greeksSource: null };
      };
      rows.push({ strike, ce: leg("CE"), pe: leg("PE") });
    }
    return { underlyingLtp: spot, rows, lotSize: null };
  }

  const svc = {
    async ltp(list, opts) {
      return many("ltp", list, opts, (symbol, q) => ({ symbol, ltp: q.ltp, freshness: fresh() }));
    },
    async quotes(list, opts) {
      return many("quotes", list, opts, (symbol, q) => ({ symbol, ...q, freshness: fresh() }));
    },
    async depth(symbolIn, opts) {
      record("depth", symbolIn, opts ?? {});
      const symbol = canon(symbolIn);
      const f = failure(symbol);
      if (f) throw f;
      const d = depths.get(symbol);
      if (d) return { symbol, bids: d.bids.map((l) => ({ orders: null, ...l })), asks: d.asks.map((l) => ({ orders: null, ...l })), freshness: fresh() };
      const q = getQuote(symbol);
      const bid = q.bid ?? q.ltp;
      const ask = q.ask ?? q.ltp;
      return { symbol, bids: [{ price: bid, qty: q.bidQty ?? 100, orders: null }], asks: [{ price: ask, qty: q.askQty ?? 100, orders: null }], freshness: fresh() };
    },
    async history(params, opts) {
      record("history", params, opts ?? {});
      const symbol = canon(params?.symbol);
      const f = failure(symbol);
      if (f) throw f;
      const list = candles.get(`${symbol}|${params.interval}`);
      if (!list) throw new BridgeError("SYMBOL_NOT_FOUND", `No fake candles for ${symbol} ${params.interval}.`);
      let out = list.slice();
      const toSec = (v) => (typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : Math.floor(Date.parse(String(v).length === 10 ? `${v}T00:00:00+05:30` : v) / 1000));
      if (params.from !== undefined) out = out.filter((c) => c.time >= toSec(params.from));
      if (params.to !== undefined) out = out.filter((c) => c.time <= toSec(params.to) + (String(params.to).length === 10 ? 86_399 : 0));
      if (params.countback) out = out.slice(-params.countback);
      return { symbol, interval: params.interval, candles: out, freshness: fresh(), partial: false };
    },
    async expiries(underlying, opts) {
      record("expiries", underlying, opts ?? {});
      const u = String(underlying).toUpperCase();
      const list = expiryMap.get(u);
      if (!list) throw new BridgeError("SYMBOL_NOT_FOUND", `No fake expiries for ${u}.`);
      return { underlying: u, expiries: [...list], freshness: fresh() };
    },
    async optionChain(params, opts) {
      record("optionChain", params, opts ?? {});
      const u = String(params?.underlying).toUpperCase();
      const expiry = params?.expiry;
      let chain = chains.get(`${u}|${expiry}`);
      if (!chain) {
        const spotSym = ["SENSEX", "BANKEX", "SENSEX50"].includes(u) ? `BSE:${u}` : `NSE:${u}`;
        const spot = quotes.get(canon(spotSym))?.ltp;
        if (!spot) throw new BridgeError("SYMBOL_NOT_FOUND", `No fake chain or price for ${u}.`);
        chain = syntheticChain(u, expiry, spot);
      }
      const atm = atmStrike(chain.rows.map((r) => r.strike), chain.underlyingLtp);
      const rows = trimStrikes(chain.rows, atm, params.strikes).map((r) => ({
        strike: r.strike,
        ce: r.ce && params.greeks === false ? { ...r.ce, delta: null, gamma: null, theta: null, vega: null, greeksSource: null } : r.ce,
        pe: r.pe && params.greeks === false ? { ...r.pe, delta: null, gamma: null, theta: null, vega: null, greeksSource: null } : r.pe,
      }));
      return { underlying: u, expiry, underlyingLtp: chain.underlyingLtp ?? null, atmStrike: atm, lotSize: chain.lotSize ?? null, rows, freshness: fresh() };
    },

    // ── test helpers (not part of the contract) ──
    calls,
    setPrice(symbol, ltp) {
      const s = canon(symbol);
      const prev = quotes.get(s);
      setQuote(s, { ...(prev ?? {}), ltp });
    },
    setQuote,
    setDepth(symbol, d) {
      depths.set(canon(symbol), { bids: [...(d.bids ?? [])], asks: [...(d.asks ?? [])] });
    },
    setCandles(symbol, interval, list) {
      candles.set(`${canon(symbol)}|${interval}`, [...list].sort((a, b) => a.time - b.time));
    },
    setExpiries(underlying, list) {
      expiryMap.set(String(underlying).toUpperCase(), [...list].sort());
    },
    setChain(underlying, expiry, chain) {
      chains.set(`${String(underlying).toUpperCase()}|${expiry}`, structuredClone(chain));
    },
    fail(symbol, code = "UPSTREAM_ERROR") {
      failures.set(canon(symbol), code);
    },
    clearFailures() {
      failures.clear();
    },
  };
  assertService("marketData", svc);
  return svc;
}
