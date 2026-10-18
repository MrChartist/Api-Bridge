/**
 * In-memory PaperEngine for OTHER streams' tests (S7 orders, S9 safety, S11 hooks/MCP). It is the real engine
 * (paperEngine.mjs) over a memory store and a tiny built-in price source, so fills, funds and positions behave exactly
 * as in production, with no disk, no market-data service, no symbol service and no timers.
 *
 *   import { createFakePaperEngine } from "../paper/fake.mjs";
 *   const paper = createFakePaperEngine({ prices: { "NSE:RELIANCE": 1400 }, clock });   // any account id is accepted
 *   const paper = createFakePaperEngine({ accounts: ["paper-1"], bus });               // only these ids exist
 *   await paper.place("paper-1", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "MARKET" });
 *   paper.setPrice("NSE:RELIANCE", 1395);       // also evaluates pending orders, like a tick
 *   paper.calls                                 // [["place", "paper-1", {...}], ...] contract calls, for assertions
 *   await paper.runOnce()                       // square-off / expiry / poll pass with the fake clock
 *
 * Orders may omit `resolved`: the fake resolves any canonical symbol with lot size 1 and tick 0.05, unless the test
 * registers an instrument with setInstrument(symbol, { lotSize, tickSize, strike? }). Without a price, a MARKET order is
 * rejected and LIMIT/SL orders wait, exactly as the real engine does.
 */
import { assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { paperConfig } from "./config.mjs";
import { createPaperEngine } from "./paperEngine.mjs";
import { createMemoryStore } from "./paperStore.mjs";

const CONTRACT = ["place", "modify", "cancel", "order", "orders", "trades", "positions", "funds", "account", "reset"];

/**
 * @param {{ prices?: Record<string, number>, clock?: { now(): number }, accounts?: string[] | "*", bus?: object,
 *   logger?: object, paper?: object }} [opts]
 *   paper: partial `paper` config (defaults applied). accounts: allowed ids (default "*": any valid id).
 */
export function createFakePaperEngine({ prices = {}, clock = { now: () => Date.now() }, accounts = "*", bus, logger, paper } = {}) {
  const calls = [];
  const quotes = new Map();
  const instruments = new Map();
  const canon = (s) => parseSymbol(s).canonical;
  for (const [s, p] of Object.entries(prices)) quotes.set(canon(s), p);

  const marketData = {
    async ltp(list) {
      const items = [];
      const errors = [];
      for (const s of list) {
        const p = quotes.get(s);
        if (p) items.push({ symbol: s, ltp: p, freshness: { source: "paper", asOf: new Date(clock.now()).toISOString(), ageMs: 0, stale: false, accountId: null, broker: null } });
        else errors.push({ symbol: s, code: "SYMBOL_NOT_FOUND", message: `No fake price for ${s}.` });
      }
      return { items, errors };
    },
    async depth(symbol) {
      throw new BridgeError("SYMBOL_NOT_FOUND", `No fake depth for ${symbol}.`);
    },
  };
  const symbols = {
    async resolve(input) {
      const p = parseSymbol(input);
      const extra = instruments.get(p.canonical) ?? {};
      return { ...p, name: null, lotSize: extra.lotSize ?? 1, tickSize: extra.tickSize ?? 0.05, freezeQty: null, isin: null, refs: {}, strike: extra.strike ?? p.strike };
    },
  };
  const deps = {
    config: { accounts: [], paper: paperConfig(paper ?? {}) },
    logger: logger ?? createNullLogger(),
    bus: bus ?? createEventBus(),
    clock,
    paths: { dataDir: "" },
    marketData,
    symbols,
  };
  const store = createMemoryStore();
  const known = accounts === "*" ? () => true : (id) => accounts.includes(id);
  const engine = createPaperEngine(deps, { store, accountKnown: known, timers: { setInterval: () => 0, clearInterval: () => {} } });

  const fake = {};
  for (const m of CONTRACT) {
    fake[m] = (...args) => {
      calls.push([m, ...args.map((a) => (a && typeof a === "object" ? structuredClone(a) : a))]);
      return engine[m](...args);
    };
  }
  Object.assign(fake, {
    calls,
    store,
    bus: deps.bus,
    /** Set a price and evaluate pending orders on it (like a tick). */
    setPrice(symbol, ltp, { bid, ask } = {}) {
      const s = canon(symbol);
      quotes.set(s, ltp);
      engine.handleTick({ symbol: s, ltp, bid, ask });
    },
    /** Register lot size, tick size (and strike) for a symbol the fake resolves. */
    setInstrument(symbol, spec) {
      instruments.set(canon(symbol), { ...spec });
    },
    runOnce: () => engine.runOnce(),
    handleTick: (tick) => engine.handleTick(tick),
  });
  assertService("paper", fake);
  return fake;
}
