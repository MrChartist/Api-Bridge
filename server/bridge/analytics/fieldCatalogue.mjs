/**
 * The field catalogue behind /v1/fields (stream S15): one entry per datum the Bridge can serve for a symbol, with the
 * words people search for it by, what it applies to, which existing service call supplies it, and the Excel formula.
 * Pure data: fields.mjs reads it and nothing here does I/O. Bump FIELD_CATALOGUE_VERSION when a field is added,
 * removed or changes meaning (additions are a minor bump, a changed meaning or unit is a major bump).
 *
 * source.kind tells fields.mjs how to fill a cell:
 *   quote    one number from marketData.quotes (one batched call for every symbol on the grid)
 *   symbol   read from the canonical symbol itself, no call
 *   leg      the option's own row in marketData.optionChain (iv, Greeks, OI change)
 *   chain    computed from a whole marketData.optionChain (ATM IV, PCR, max pain)
 *   lot      lot size from marketData.optionChain
 *   expiries marketData.expiries
 *   basis    future quote minus the cash quote (both from marketData.quotes)
 *   vwap     today's 5m candles from marketData.history
 *   days     days from now to the symbol's expiry, computed
 * history: true when /v1/fields/history can serve it per bar. override: true when `override=expiry:,rate:` changes it.
 */

export const FIELD_CATALOGUE_VERSION = "1.0.0";

export const FIELD_CATEGORIES = Object.freeze(["price", "volume", "derivatives", "greeks", "volatility", "analytics", "reference"]);

const ALL = ["equity", "index", "future", "option"];
const CASH = ["equity", "index"];
const DERIV = ["future", "option"];
const TRADED = ["equity", "future", "option"];

const NIFTY = "NSE:NIFTY";
const RELIANCE = "NSE:RELIANCE";
const FUT = "NFO:NIFTY-2026-11-24-FUT";
const OPT = "NFO:NIFTY-2026-11-24-25000-CE";

function field(f) {
  const out = {
    description: "",
    aliases: [],
    dataType: "number",
    unit: null,
    cadence: "realtime",
    history: false,
    override: false,
    ...f,
    excelCall: f.excelCall ?? `=MC.BDP("${f.example.symbol}","${f.id}")`,
  };
  return Object.freeze({ ...out, aliases: Object.freeze([...out.aliases]), applies_to: Object.freeze([...out.applies_to]), source: Object.freeze({ ...out.source }), example: Object.freeze({ ...out.example }) });
}

const quote = (key) => ({ kind: "quote", service: "marketData", call: "quotes", field: key });
const leg = (key) => ({ kind: "leg", service: "marketData", call: "optionChain", field: key });
const chain = (key) => ({ kind: "chain", service: "marketData", call: "optionChain", field: key });
const symbolPart = (key) => ({ kind: "symbol", service: null, call: "parseSymbol", field: key });

export const FIELDS = Object.freeze([
  field({ id: "ltp", description: "Last traded price.", aliases: ["last", "last price", "last_price", "px_last", "price", "cmp"], category: "price", unit: "INR", applies_to: ALL, source: quote("ltp"), example: { symbol: RELIANCE, value: 1402.3 } }),
  field({ id: "bid", description: "Best bid price.", aliases: ["best bid", "bid price", "px_bid"], category: "price", unit: "INR", applies_to: TRADED, source: quote("bid"), example: { symbol: RELIANCE, value: 1402 } }),
  field({ id: "ask", description: "Best ask (offer) price.", aliases: ["best ask", "offer", "ask price", "px_ask"], category: "price", unit: "INR", applies_to: TRADED, source: quote("ask"), example: { symbol: RELIANCE, value: 1402.5 } }),
  field({ id: "bid_qty", description: "Quantity at the best bid.", aliases: ["bid size", "bid quantity"], category: "volume", dataType: "integer", unit: "shares", applies_to: TRADED, source: quote("bidQty"), example: { symbol: RELIANCE, value: 150 } }),
  field({ id: "ask_qty", description: "Quantity at the best ask.", aliases: ["ask size", "ask quantity", "offer size"], category: "volume", dataType: "integer", unit: "shares", applies_to: TRADED, source: quote("askQty"), example: { symbol: RELIANCE, value: 90 } }),
  field({ id: "open", description: "Today's opening price. In history, each bar's open.", aliases: ["open price", "px_open", "day open"], category: "price", unit: "INR", applies_to: ALL, history: true, source: quote("open"), example: { symbol: NIFTY, value: 25010.5 } }),
  field({ id: "high", description: "Today's high. In history, each bar's high.", aliases: ["day high", "high price", "px_high"], category: "price", unit: "INR", applies_to: ALL, history: true, source: quote("high"), example: { symbol: NIFTY, value: 25120 } }),
  field({ id: "low", description: "Today's low. In history, each bar's low.", aliases: ["day low", "low price", "px_low"], category: "price", unit: "INR", applies_to: ALL, history: true, source: quote("low"), example: { symbol: NIFTY, value: 24940 } }),
  field({ id: "close", description: "Close. In a live read this is the previous session's close, as brokers report it; in history it is each bar's close.", aliases: ["close price", "closing price", "px_close", "eod price"], category: "price", unit: "INR", cadence: "eod", applies_to: ALL, history: true, source: quote("close"), example: { symbol: NIFTY, value: 24985.2 }, excelCall: '=MC.BDH("NSE:NIFTY","close","2026-10-01","2026-10-30")' }),
  field({ id: "prev_close", description: "Previous session's close. In history, the previous bar's close.", aliases: ["previous close", "prev close", "yesterday close", "px_prev_close"], category: "price", unit: "INR", cadence: "eod", applies_to: ALL, history: true, source: quote("close"), example: { symbol: NIFTY, value: 24985.2 } }),
  field({ id: "change", description: "Last price minus previous close. In history, close minus the previous bar's close.", aliases: ["net change", "chg", "price change"], category: "price", unit: "INR", applies_to: ALL, history: true, source: quote("change"), example: { symbol: NIFTY, value: 25.3 } }),
  field({ id: "change_pct", description: "Change as a percent of previous close.", aliases: ["pct change", "percent change", "change %", "chg %", "chg_pct", "changepct"], category: "price", unit: "%", applies_to: ALL, history: true, source: quote("changePct"), example: { symbol: NIFTY, value: 0.1 } }),
  field({ id: "volume", description: "Traded volume for the session. In history, each bar's volume.", aliases: ["vol", "traded volume", "volume traded"], category: "volume", dataType: "integer", unit: "shares", applies_to: ALL, history: true, source: quote("volume"), example: { symbol: RELIANCE, value: 5120000 } }),
  field({ id: "oi", description: "Open interest, in contracts' units as the exchange reports it.", aliases: ["open interest", "open_int", "openint", "oi total"], category: "derivatives", dataType: "integer", unit: "units", applies_to: DERIV, history: true, source: quote("oi"), example: { symbol: FUT, value: 12500000 } }),
  field({ id: "oi_change", description: "Change in open interest since the previous session.", aliases: ["change in oi", "oi chg", "oi_chg", "oi change", "open interest change"], category: "derivatives", dataType: "integer", unit: "units", applies_to: ["option"], source: leg("oiChange"), example: { symbol: OPT, value: 150000 } }),
  field({ id: "vwap", description: "Volume-weighted average price of today's 5-minute candles (typical price weighted by volume).", aliases: ["volume weighted average price", "vwap price", "avg price"], category: "price", unit: "INR", applies_to: TRADED, source: { kind: "vwap", service: "marketData", call: "history", field: "5m candles" }, example: { symbol: RELIANCE, value: 1399.8 } }),

  field({ id: "iv", description: "Implied volatility of one option, in percent (broker's, else solved by Black-Scholes). Override rate to re-solve; override expiry to read the same strike and side in another expiry.", aliases: ["implied volatility", "implied vol", "ivol", "option iv"], category: "volatility", unit: "%", applies_to: ["option"], override: true, source: leg("iv"), example: { symbol: OPT, value: 13.4 } }),
  field({ id: "delta", description: "Option delta: change in option price per rupee move in the underlying.", aliases: ["option delta"], category: "greeks", unit: "per INR", applies_to: ["option"], override: true, source: leg("delta"), example: { symbol: OPT, value: 0.52 } }),
  field({ id: "gamma", description: "Option gamma: change in delta per rupee move in the underlying.", aliases: ["option gamma"], category: "greeks", unit: "per INR squared", applies_to: ["option"], override: true, source: leg("gamma"), example: { symbol: OPT, value: 0.0011 } }),
  field({ id: "theta", description: "Option theta: price decay per day.", aliases: ["option theta", "time decay"], category: "greeks", unit: "INR per day", applies_to: ["option"], override: true, source: leg("theta"), example: { symbol: OPT, value: -8.2 } }),
  field({ id: "vega", description: "Option vega: price change per one point of implied volatility.", aliases: ["option vega"], category: "greeks", unit: "INR per vol point", applies_to: ["option"], override: true, source: leg("vega"), example: { symbol: OPT, value: 11.6 } }),
  field({ id: "atm_iv", description: "At-the-money implied volatility (average of the call and put at the ATM strike) for the nearest expiry, or the expiry given in override or on an option or future symbol.", aliases: ["atm implied volatility", "atm vol", "atm ivol", "at the money iv"], category: "volatility", unit: "%", applies_to: ALL, override: true, source: chain("atm_iv"), example: { symbol: NIFTY, value: 13.1 } }),
  field({ id: "pcr_oi", description: "Put-call ratio by open interest for the chain.", aliases: ["put call ratio", "put-call ratio", "pcr", "oi pcr"], category: "analytics", unit: "ratio", applies_to: ALL, override: true, source: chain("pcr_oi"), example: { symbol: NIFTY, value: 0.92 } }),
  field({ id: "pcr_volume", description: "Put-call ratio by traded volume for the chain.", aliases: ["volume pcr", "pcr volume"], category: "analytics", unit: "ratio", applies_to: ALL, override: true, source: chain("pcr_volume"), example: { symbol: NIFTY, value: 0.88 } }),
  field({ id: "max_pain", description: "Strike at which option writers pay out the least at expiry.", aliases: ["maxpain", "max pain strike"], category: "analytics", unit: "INR", applies_to: ALL, override: true, source: chain("max_pain"), example: { symbol: NIFTY, value: 25000 } }),
  field({ id: "basis", description: "Futures price minus the cash price of the underlying.", aliases: ["futures basis", "future premium", "premium"], category: "derivatives", unit: "INR", applies_to: ["future"], source: { kind: "basis", service: "marketData", call: "quotes", field: "ltp (future, spot)" }, example: { symbol: FUT, value: 42.5 } }),
  field({ id: "basis_pct", description: "Futures basis as a percent of the cash price.", aliases: ["basis %", "basis percent", "premium %"], category: "derivatives", unit: "%", applies_to: ["future"], source: { kind: "basis", service: "marketData", call: "quotes", field: "ltp (future, spot)" }, example: { symbol: FUT, value: 0.17 } }),

  field({ id: "lot_size", description: "Contract lot size.", aliases: ["lot", "market lot", "contract size", "lotsize"], category: "reference", dataType: "integer", unit: "units", cadence: "eod", applies_to: DERIV, source: { kind: "lot", service: "marketData", call: "optionChain", field: "lotSize" }, example: { symbol: FUT, value: 75 } }),
  field({ id: "expiry", description: "Expiry date of a future or option.", aliases: ["expiry date", "maturity", "exp"], category: "reference", dataType: "date", cadence: "eod", applies_to: DERIV, source: symbolPart("expiry"), example: { symbol: FUT, value: "2026-11-24" } }),
  field({ id: "next_expiry", description: "Nearest upcoming expiry listed for the underlying.", aliases: ["nearest expiry", "front expiry", "next expiry"], category: "reference", dataType: "date", cadence: "eod", applies_to: CASH, source: { kind: "expiries", service: "marketData", call: "expiries", field: "expiries" }, example: { symbol: NIFTY, value: "2026-11-03" } }),
  field({ id: "days_to_expiry", description: "Days from now to the 15:30 IST expiry cutoff.", aliases: ["dte", "days to expiry", "days left"], category: "reference", unit: "days", applies_to: DERIV, source: { kind: "days", service: null, call: "clock", field: "expiry" }, example: { symbol: OPT, value: 25.4 } }),
  field({ id: "strike", description: "Option strike price.", aliases: ["strike price", "exercise price"], category: "reference", unit: "INR", cadence: "eod", applies_to: ["option"], source: symbolPart("strike"), example: { symbol: OPT, value: 25000 } }),
  field({ id: "option_type", description: "CE (call) or PE (put).", aliases: ["right", "call put", "cp", "ce pe", "put call"], category: "reference", dataType: "string", cadence: "eod", applies_to: ["option"], source: symbolPart("right"), example: { symbol: OPT, value: "CE" } }),
  field({ id: "instrument_type", description: "EQ, INDEX, FUT or OPT.", aliases: ["kind", "security type", "asset class"], category: "reference", dataType: "string", cadence: "eod", applies_to: ALL, source: symbolPart("kind"), example: { symbol: NIFTY, value: "INDEX" } }),
  field({ id: "exchange", description: "Exchange segment code (NSE, BSE, NFO, BFO, MCX, CDS).", aliases: ["venue", "segment", "exch"], category: "reference", dataType: "string", cadence: "eod", applies_to: ALL, source: symbolPart("exchange"), example: { symbol: NIFTY, value: "NSE" } }),
  field({ id: "underlying", description: "Underlying name of the instrument.", aliases: ["underlier", "underlying symbol"], category: "reference", dataType: "string", cadence: "eod", applies_to: ALL, source: symbolPart("underlying"), example: { symbol: OPT, value: "NIFTY" } }),
]);

/** @type {ReadonlyMap<string, object>} */
export const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));
