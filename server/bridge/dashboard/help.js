// Per-page help for the "help <code>" drawer: what the page is for, what its fields and columns mean, and where the
// longer guide is. Plain data (no DOM, no HTML): the drawer draws it with textContent, so nothing here is ever parsed
// as markup. Every page id in workspace.js PAGE_CODES has an entry; help.test.mjs keeps the two in step.

const A = "docs/guides/analytics.md";
export const GUIDE_BASE = "docs/guides/";

/** @type {Record<string, { what: string, fields: [string, string][], doc: string, note?: string }>} */
export const PAGE_HELP = Object.freeze({
  home: {
    what: "Your Bridge at a glance: broker sessions, today's activity, safety state and the setup checklist.",
    fields: [["Sessions", "Connected broker accounts and whether each login is still valid."], ["Requests", "Calls the Bridge served today, and how many hit a limit."], ["Safety", "Whether live trading is on and whether the kill switch is engaged."]],
    doc: "docs/guides/README.md",
  },
  accounts: {
    what: "Add, log in to and remove broker accounts. The paper account is always there.",
    fields: [["Session", "Connected means the broker login works now; Expired means log in again."], ["Broker", "One of the supported brokers; credentials are kept on this computer."]],
    doc: "docs/guides/accounts.md",
  },
  console: {
    what: "Send any Bridge call and see the raw answer, including the paper order form.",
    fields: [["Endpoint", "The call to make (quote, option chain, order ...)."], ["Response", "Exactly what an API client would receive, with timing and headers."]],
    doc: "docs/guides/python.md",
  },
  limits: {
    what: "Live usage against each broker's rate limits, and how many calls the Bridge saved by pooling and caching.",
    fields: [["Used / limit", "Calls in the current window against the broker's allowance."], ["Saved", "Requests answered without calling the broker."]],
    doc: "docs/guides/rate-limits.md",
  },
  scanner: {
    what: "Scan a universe of stocks with a readable condition such as rsi(14) > 60 and close > sma(50).",
    fields: [["Universe", "The list of symbols to scan."], ["Condition", "A formula using indicators and price fields. A match means it is true on the latest bar."], ["Jobs", "Big scans run in the background, shared over your accounts."]],
    doc: "docs/guides/scanner.md",
  },
  orders: {
    what: "Orders and positions. Paper by default; tickets that need your confirmation wait here.",
    fields: [["Pending tickets", "Orders waiting for a human to confirm them with the code shown."], ["Mode", "Paper or live. Live needs explicit opt-ins."]],
    doc: "docs/guides/safety.md",
  },
  safety: {
    what: "The kill switch, daily loss limit and live-trading status.",
    fields: [["Kill switch", "Blocks every new order from every tool until released."], ["Daily loss limit", "Stops new orders once the day's loss reaches it."]],
    doc: "docs/guides/safety.md",
  },
  keys: {
    what: "Create and revoke API keys, one per tool, each with only the access it needs.",
    fields: [["Scope", "read, paper, trade or admin: what the key may do."], ["Label", "A name to tell keys apart. The key itself is shown once."]],
    doc: "docs/guides/README.md",
  },
  integrations: {
    what: "Copy-paste setup for webhooks, Python, TypeScript, Excel, AmiBroker, Claude and ChatGPT.",
    fields: [["Tabs", "One per tool. Snippets already contain this Bridge's address."]],
    doc: "docs/guides/README.md",
  },
  activity: {
    what: "Recent requests and the tamper-evident audit log.",
    fields: [["Request", "Method, path, status and time of a call."], ["Audit", "A hash-chained record of sensitive actions; a broken chain is flagged."]],
    doc: "docs/guides/safety.md",
  },
  chain: {
    what: "The option chain for one underlying and expiry: calls on the left, puts on the right, strike in the middle.",
    fields: [["OI", "Open interest: contracts still open at that strike."], ["OI chg", "Change in open interest since the previous close."], ["IV", "Implied volatility of that option, in percent."], ["LTP", "Last traded price."], ["ATM", "The strike closest to the spot price."], ["Strikes", "How many strikes each side of the money to show (set in the context bar)."]],
    doc: A,
  },
  oi: {
    what: "Open interest by strike, the put-call ratio and max pain.",
    fields: [["PCR", "Put OI divided by call OI. Above 1 means more put OI."], ["Max pain", "The strike where option buyers would lose the most at expiry."], ["Support / resistance", "Strikes with the largest put / call OI, often read as floors and ceilings."]],
    doc: A,
  },
  gex: {
    what: "Dealer gamma exposure by strike and the flip strike where it changes sign.",
    fields: [["GEX", "Gamma times OI times lot size, assuming dealers are long calls and short puts."], ["Flip strike", "Where net gamma crosses zero; above it moves tend to be damped, below it amplified."], ["Regime", "Positive, negative or neutral net gamma."]],
    doc: A,
    note: "A model, not a measurement: it rests on an assumption about who holds the options.",
  },
  skew: {
    what: "Implied volatility by strike for one expiry, and ATM IV across expiries (the surface).",
    fields: [["Skew", "How IV differs between puts and calls away from the money."], ["Risk reversal", "Put IV minus call IV at the same distance: positive means puts are richer."], ["Term", "ATM IV for each upcoming expiry."]],
    doc: A,
  },
  payoff: {
    what: "Build a multi-leg strategy by hand or from the live chain and see profit, loss and break-evens at expiry.",
    fields: [["Type", "CE, PE or FUT for each leg."], ["Side", "Buy or sell."], ["Price", "Entry price per unit."], ["Lots / lot size", "Quantity; lot size is the contract multiplier."], ["Spot", "Optional marker on the chart; also sets the range."]],
    doc: A,
  },
  calculators: {
    what: "Black-Scholes Greeks (from an IV or a price) and a position-size calculator.",
    fields: [["IV", "Implied volatility in percent."], ["Days", "Days to expiry."], ["Rate", "Risk-free rate in percent."], ["Risk budget", "The most you accept to lose on the trade, used to size the lots."]],
    doc: A,
  },
  futures: {
    what: "Every upcoming future with basis and carry, basis history and synthetic futures from put-call parity.",
    fields: [["Basis", "Future price minus spot."], ["Basis %", "Basis as a percent of spot."], ["Carry", "Annualised basis, the cost of holding the position to expiry."], ["Roll cost", "Price gap between the near and next future."]],
    doc: A,
  },
  flows: {
    what: "Cash-market buying and selling by foreign (FII/FPI) and domestic (DII) institutions.",
    fields: [["Net", "Buy value minus sell value for the day, in rupees crore."], ["Rolling sum", "Net over the last few sessions."], ["Streak", "Consecutive days of net buying or selling."]],
    doc: A,
    note: "Read from NSE's public data; the Bridge keeps the last 250 sessions.",
  },
  expiry: {
    what: "Expiry-day digest: time left, flags, the ATM straddle, max pain and OI walls in one view.",
    fields: [["Straddle", "ATM call plus ATM put price: the move the market is pricing."], ["Implied move", "The straddle as a percent of spot."], ["Walls", "Strikes with the largest call and put OI."]],
    doc: A,
  },
  oichange: {
    what: "Where open interest is being added or removed, and who is acting (long build-up, short build-up, unwinding).",
    fields: [["Window", "The period the change is measured over."], ["Build-up", "OI up with price up is long build-up; OI up with price down is short build-up."], ["Spurt", "A strike whose OI jumped against its recent baseline."]],
    doc: A,
    note: "History builds while the Bridge runs; right after a restart there is little to compare with.",
  },
  strategies: {
    what: "Find strategies for your view of the market, or build one from a template and open its payoff.",
    fields: [["View", "Bullish, bearish, neutral or volatile: what you expect."], ["Probability of profit", "A lognormal estimate from ATM IV, a guide only."], ["Offset / width", "Strike distance from the money and between legs."]],
    doc: A,
  },
  greeksgrid: {
    what: "Delta, gamma, theta and vega by strike, plus the ATM straddle's price history.",
    fields: [["Delta", "Price change per 1 point move in the underlying."], ["Gamma", "Change in delta per 1 point move."], ["Theta", "Value lost per day to time decay."], ["Vega", "Price change per 1 point of IV."], ["Candle", "Interval of the straddle history."]],
    doc: A,
  },
  alerts: {
    what: "Rules that notify you once per crossing when PCR, IV, basis, max pain distance, gamma regime or spot reaches a level.",
    fields: [["Watch", "The measure to follow."], ["Level", "The threshold, in the unit shown."], ["Check by itself", "How often the Bridge evaluates the rule on its own."], ["Only during market hours", "Skip evaluation outside NSE hours."]],
    doc: A,
  },
  positions: {
    what: "Net Greeks and exposure of an account's open option positions, and a lot-split planner for big orders.",
    fields: [["Account", "Whose positions to read."], ["Net delta / gamma / theta / vega", "The sum across the positions."], ["Lot split", "Plans child orders under the exchange freeze limit. It only plans; it sends nothing."]],
    doc: A,
  },
  unusual: {
    what: "Option contracts trading far above their usual size, ranked by a 0 to 100 score.",
    fields: [["Vol / OI", "Volume against open interest."], ["Premium traded", "Volume times price times lot size, in rupees."], ["Aggressor", "Whether trades look buyer- or seller-initiated, inferred from bid and ask (a proxy)."], ["Score", "Blend of the above; the formula is in the response."]],
    doc: A,
    note: "There is no trade tape in India; buy and sell are inferred.",
  },
  tide: {
    what: "Net call against put premium through the session and the sentiment it implies.",
    fields: [["Net premium", "Call premium traded minus put premium traded."], ["Window", "How far back to read."], ["Top strikes", "Strikes with the most premium."], ["Recording", "Readings only build up while something polls this page."]],
    doc: A,
  },
  exposure: {
    what: "Delta, gamma, vanna and charm exposure by strike and by expiry, and an OI heatmap.",
    fields: [["Vanna", "How delta changes as IV moves."], ["Charm", "How delta drifts as time passes."], ["Zero-gamma level", "Where net gamma changes sign."], ["Walls", "Strikes with the largest call and put exposure."]],
    doc: A,
  },
  screener: {
    what: "Filter and sort every contract, read volatility statistics, and follow NSE deals, insiders and events.",
    fields: [["Moneyness", "In, at or out of the money."], ["IV rank", "Where today's IV sits in its past range (needs about 20 days of history)."], ["HV", "Historical (realised) volatility over 10 to 60 days."], ["Deals", "NSE block and bulk deals."]],
    doc: A,
  },
});

/** The page's help, or null. */
export const helpFor = (id) => (Object.hasOwn(PAGE_HELP, id) ? PAGE_HELP[id] : null);
