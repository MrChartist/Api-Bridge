/**
 * Broker policy table — stream S3, DATA ONLY (S1 and S5 import it; it imports nothing).
 *
 * One entry per adapter id in server/brokers/registry.mjs (all 33). Every number carries `verified` and, where there
 * is one, a `source` URL. What `verified: true` means here: the figure was read on the broker's OWN official API
 * documentation page named in `source` during the broker-layer review (checked October 2026), and is quoted in
 * that adapter's header comment. It does NOT mean it was measured against a live account. Figures from third-party
 * code, forum posts, "about" wording or our own guesses are `verified: false`.
 *
 * How the scheduler uses this table (resolution lives in policy.mjs, not here):
 *  - A verified LimitSpec is used as written.
 *  - An unverified LimitSpec falls back to the conservative DEFAULT_CLASS_LIMITS, except that any unverified window
 *    LOWER than the default is kept (a lower unverified figure can only make us slower, never break a limit).
 *  - A class with no LimitSpec gets the default.
 *  - `groups` are budgets shared by several classes (one upstream limit that covers, say, quotes, depth and option
 *    chains). A request draws from its class bucket AND every group that lists its class. Groups are always applied
 *    (verified or not), since an extra constraint can only slow us down. When a broker declares no groups, quote,
 *    depth and chain share one budget (DEFAULT_GROUPS), because many adapters serve all three from the quote API.
 *  - Orders are additionally capped at the SEBI retail unregistered-algo ceiling (10/s) here and at SafetyGuard's
 *    own per-account cap (default 5/s) in S9.
 *  - The `ratelimit` config section can only LOWER these numbers.
 *
 * `maxQuoteBatch` is the number of instruments ONE upstream HTTP request carries (the adapter splits longer lists
 * itself). Callers that hand an adapter N instruments should pass cost = ceil(N / maxQuoteBatch) to schedule().
 *
 * `pooling` says whether the broker's terms clearly allow one user's read-only market-data calls to be spread over
 * several of that same user's accounts. No broker's terms say so clearly today, so every entry is "unknown", which
 * the Bridge treats as not allowed. Change one only with a citation to the broker's terms.
 *
 * Field shape: core/contracts.mjs BrokerPolicy / LimitSpec, plus two additive extensions (proposed to the lead for
 * contracts.mjs and the OpenAPI BrokerPolicy schema; consumers that ignore them stay correct, only less precise):
 *   LimitSpec.extraWindows?: Array<{ windowMs, limit }>   windows other than second/minute/day (Dhan's hourly cap)
 *   BrokerPolicy.groups?: Record<string, LimitSpec & { classes: EndpointClass[] }>
 */

/** When the per-number review was done. */
export const POLICY_TABLE_CHECKED = "2026-10";

/**
 * Conservative defaults for anything unknown or unverified (docs/ARCHITECTURE.md §6): 1 request/s for quote, depth,
 * history and chain; 2/s portfolio; 5/s orders. Masters and other calls are rare and get 1/s.
 * @type {Readonly<Record<string, { perSecond?: number, perMinute?: number, perDay?: number }>>}
 */
export const DEFAULT_CLASS_LIMITS = Object.freeze({
  order: Object.freeze({ perSecond: 5 }),
  quote: Object.freeze({ perSecond: 1 }),
  depth: Object.freeze({ perSecond: 1 }),
  history: Object.freeze({ perSecond: 1 }),
  chain: Object.freeze({ perSecond: 1 }),
  portfolio: Object.freeze({ perSecond: 2 }),
  master: Object.freeze({ perSecond: 1, perMinute: 10 }),
  other: Object.freeze({ perSecond: 1 }),
});

/** Classes that share the quote budget when a broker declares no groups of its own. */
export const DEFAULT_GROUP_CLASSES = Object.freeze(["quote", "depth", "chain"]);

export const DEFAULT_MAX_QUOTE_BATCH = 1;

// ── Builders (keep entries short and uniform) ──

const v = (source, spec) => Object.freeze({ ...spec, verified: true, source });
const u = (spec, source) => Object.freeze({ ...spec, verified: false, ...(source ? { source } : {}) });
/** The same LimitSpec for several classes plus a shared group budget for them. */
function shared(name, classes, spec) {
  const limits = {};
  for (const c of classes) limits[c] = spec;
  return { limits, groups: { [name]: Object.freeze({ ...spec, classes: Object.freeze([...classes]) }) } };
}
const NO_FEED = Object.freeze({ maxConnections: null, maxSubscriptions: null });

function entry(brokerId, { limits = {}, groups, maxQuoteBatch = DEFAULT_MAX_QUOTE_BATCH, feed = NO_FEED, maxModificationsPerOrder = null, notes }) {
  const p = {
    brokerId,
    limits: Object.freeze({ ...limits }),
    maxQuoteBatch,
    feed: Object.freeze({ ...feed }),
    pooling: "unknown",
    maxModificationsPerOrder,
  };
  if (groups) p.groups = Object.freeze({ ...groups });
  if (notes) p.notes = notes;
  return Object.freeze(p);
}

function merge(...parts) {
  const out = { limits: {}, groups: {} };
  for (const p of parts) {
    Object.assign(out.limits, p.limits ?? {});
    Object.assign(out.groups, p.groups ?? {});
  }
  return out;
}

// ── Sources (official documentation pages cited by each adapter) ──

const S = Object.freeze({
  aliceblue: "https://ant.aliceblueonline.com/productdocumentation/",
  angelone: "https://smartapi.angelone.in/docs",
  arrow: "https://docs.arrow.trade/rest-api/rate-limits/",
  xts: "https://symphonyfintech.com/xts-trading-front-end-api-v2/",
  xtsMd: "https://symphonyfintech.com/xts-market-data-front-end-api-v2/",
  iiflXts: "https://ttblaze.iifl.com/doc/interactive/",
  dhan: "https://dhanhq.co/docs/v2/",
  firstock: "https://firstock.in/api/docs/",
  flattrade: "https://pi.flattrade.in/docs",
  fyers: "https://fyers.in/api-docs/v3/",
  groww: "https://groww.in/trade-api/docs/curl",
  iiflcapital: "https://developers.iiflcapital.com/apidocs/annexure",
  indmoney: "https://api-docs.indstocks.com/getting-started/",
  mstock: "https://tradingapi.mstock.com/docs/v1/Introduction/",
  nubra: "https://nubra.io/products/api/docs/rest-api-v3/RateLimits.html",
  pocketful: "https://api.pocketful.in/docs/curl",
  shoonya: "https://shoonya.com/api-documentation",
  tradejini: "https://developer.tradejini.com/docs/",
  upstox: "https://upstox.com/developer/api-documentation/rate-limiting",
  zebu: "https://zebumyntapi.web.app/",
  zerodha: "https://kite.trade/docs/connect/v3/exceptions/",
});

/** XTS (Symphony) deployments share one engine; limits from Symphony's official table. */
function xtsPolicy(brokerId, { verified, source = S.xts }) {
  const mk = (spec) => (verified ? v(source, spec) : u(spec, source));
  return entry(brokerId, {
    limits: {
      order: mk({ perSecond: 10 }),
      quote: u({ perSecond: 1 }, S.xtsMd),
      depth: u({ perSecond: 1 }, S.xtsMd),
      history: u({ perSecond: 1 }, S.xtsMd),
      master: u({ perSecond: 1 }, S.xtsMd),
      portfolio: mk({ perSecond: 1 }),
      other: mk({ perSecond: 1 }),
    },
    maxQuoteBatch: 50,
    notes: verified
      ? "XTS: order book, positions, holdings and balance 1/s; place, modify and cancel share 10/s (official table). Market-data limits come from Symphony's earlier table (1/s)."
      : "XTS deployment: Symphony's table is assumed but this broker's own deployment was not checked, so the conservative defaults apply.",
  });
}

// ── The table ──

/** @type {Readonly<Record<string, import("../core/contracts.mjs").BrokerPolicy>>} */
export const BROKER_POLICIES = Object.freeze({
  aliceblue: entry("aliceblue", {
    ...merge(
      { limits: { order: v(S.aliceblue, { perSecond: 10 }), history: v(S.aliceblue, { perSecond: 20 }), portfolio: v(S.aliceblue, { perSecond: 30 }), other: v(S.aliceblue, { perSecond: 30 }) } },
      shared("quoteApi", ["quote", "depth", "chain"], v(S.aliceblue, { perSecond: 5 })),
    ),
    maxQuoteBatch: 50,
    notes: "Order API 10/s, Data API 20/s, Quote API 5/s, non-trading APIs 30/s.",
  }),

  angelone: entry("angelone", {
    ...merge(
      {
        limits: {
          order: v(S.angelone, { perSecond: 9 }),
          history: v(S.angelone, { perSecond: 3 }),
          portfolio: v(S.angelone, { perSecond: 1 }),
          other: v(S.angelone, { perSecond: 1 }),
        },
      },
      shared("marketQuote", ["quote", "depth", "chain"], v(S.angelone, { perSecond: 1 })),
    ),
    maxQuoteBatch: 50,
    notes: "RateLimit page: place/modify/cancel 9/s combined (a 10/s per segment figure from April 2026 is not yet confirmed, so 9/s stays); order book, positions, holdings 1/s; candles 3/s. The Market Data page says 1/s for 50-token quote calls.",
  }),

  arrow: entry("arrow", {
    ...merge(
      { limits: { order: v(S.arrow, { perSecond: 10 }), history: v(S.arrow, { perSecond: 10 }), portfolio: v(S.arrow, { perSecond: 10 }), other: v(S.arrow, { perSecond: 10 }) } },
      shared("marketData", ["quote", "depth", "chain"], v(S.arrow, { perSecond: 10 })),
    ),
    maxQuoteBatch: 100,
    notes: "10 requests a second per product (orders, positions, market data, historical).",
  }),

  compositedge: xtsPolicy("compositedge", { verified: true }),

  definedge: entry("definedge", {
    limits: { quote: u({ perSecond: 10 }), depth: u({ perSecond: 10 }), chain: u({ perSecond: 10 }) },
    maxQuoteBatch: 1,
    notes: "No published limits (the documentation is behind a bot wall). The adapter paces quotes at 10/s; the Bridge uses the conservative defaults.",
  }),

  dhan: entry("dhan", {
    ...merge(
      {
        limits: {
          order: v(S.dhan, { perSecond: 10, perMinute: 250, perDay: 7000, extraWindows: [{ windowMs: 3_600_000, limit: 1000 }] }),
          history: v(S.dhan, { perSecond: 5, perDay: 100_000 }),
          chain: u({ perSecond: 1, perMinute: 20 }, "https://dhanhq.co/docs/v2/option-chain/"),
          portfolio: v(S.dhan, { perSecond: 20 }),
          other: v(S.dhan, { perSecond: 20 }),
        },
      },
      shared("marketQuote", ["quote", "depth"], v("https://dhanhq.co/docs/v2/market-quote/", { perSecond: 1 })),
    ),
    maxQuoteBatch: 1000,
    feed: { maxConnections: 5, maxSubscriptions: 5000 },
    maxModificationsPerOrder: 25,
    notes: "Orders 10/s, 250/min, 1,000/hour, 7,000/day; data APIs 5/s and 1,00,000/day; market quote 1/s for up to 1,000 instruments; non-trading 20/s. Option chain: one unique request every 3 seconds (unverified here, kept because it is lower). Feed: 5 connections x 5,000 instruments.",
  }),

  firstock: entry("firstock", {
    ...merge(
      { limits: { order: v(S.firstock, { perSecond: 10 }), history: v(S.firstock, { perSecond: 3 }), portfolio: v(S.firstock, { perSecond: 10 }), other: v(S.firstock, { perSecond: 10 }) } },
      shared("quotes", ["quote", "depth", "chain"], v(S.firstock, { perSecond: 1 })),
    ),
    maxQuoteBatch: 50,
    notes: "exception-errors page: quotes 1/s (reduced from 4), historical 3/s, everything else 10/s.",
  }),

  fivepaisa: entry("fivepaisa", {
    maxQuoteBatch: 50,
    notes: "No rate limits found on the Xstream documentation pages; conservative defaults.",
  }),

  flattrade: entry("flattrade", {
    ...merge(
      shared("data", ["quote", "depth", "history", "chain", "portfolio", "other", "master"], v(S.flattrade, { perSecond: 40, perMinute: 200 })),
      { limits: { order: v(S.flattrade, { perSecond: 10, perMinute: 40 }) } },
    ),
    maxQuoteBatch: 1,
    notes: "API Rate Limit: 40/s and 200/min for data calls; Order API Rate Limit: 10/s and 40/min. Noren GetQuotes takes one instrument per call.",
  }),

  fyers: entry("fyers", {
    ...merge(
      shared("dataApis", ["quote", "depth", "history", "chain"], v(S.fyers, { perSecond: 5, perMinute: 50, perDay: 5000 })),
      shared("transactionApis", ["order", "portfolio", "other"], v(S.fyers, { perSecond: 10, perMinute: 200 })),
    ),
    maxQuoteBatch: 50,
    notes: "Standard plan. Exceeding the per-minute limit more than 3 times a day blocks the user for the rest of the day, so the Bridge never retries a Fyers rate-limit error.",
  }),

  groww: entry("groww", {
    ...merge(
      shared("liveData", ["quote", "depth", "chain", "history"], v(S.groww, { perSecond: 10, perMinute: 300 })),
      shared("nonTrading", ["portfolio", "other", "history", "master"], v(S.groww, { perSecond: 20, perMinute: 500 })),
      { limits: { order: v(S.groww, { perSecond: 10, perMinute: 250 }) } },
    ),
    maxQuoteBatch: 1,
    notes: "Orders 10/s 250/min; Live Data 10/s 300/min; Non Trading 20/s 500/min. Historical is counted against both data groups because the docs do not say which applies.",
  }),

  hdfcsecurities: entry("hdfcsecurities", { maxQuoteBatch: 10, notes: "The InvestRight docs publish no rate limit; conservative defaults." }),

  hdfcsky: entry("hdfcsky", { maxQuoteBatch: 10, notes: "The HDFC Sky docs publish no rate limit; conservative defaults." }),

  ibulls: xtsPolicy("ibulls", { verified: false }),

  iifl: xtsPolicy("iifl", { verified: true, source: S.iiflXts }),

  iiflcapital: entry("iiflcapital", {
    ...merge(
      {
        limits: {
          order: v(S.iiflcapital, { perSecond: 10 }),
          history: v(S.iiflcapital, { perSecond: 10 }),
          portfolio: v(S.iiflcapital, { perSecond: 3 }),
          other: v(S.iiflcapital, { perSecond: 3 }),
          master: v(S.iiflcapital, { perSecond: 2 }),
        },
      },
      shared("marketQuotes", ["quote", "depth", "chain"], v(S.iiflcapital, { perSecond: 10 })),
    ),
    maxQuoteBatch: 50,
    notes: "Annexure (non-registered, under 10 OPS): market quotes, depth, OI, historical 10/s; profile, order book, trade book, positions, holdings 3/s; place/modify/cancel 10/s combined; contract files 2/s.",
  }),

  indmoney: entry("indmoney", {
    ...merge(
      shared("dataQuote", ["quote", "depth", "history", "chain"], v(S.indmoney, { perSecond: 5, perDay: 100_000 })),
      shared("nonTrading", ["portfolio", "other"], v(S.indmoney, { perSecond: 15, perDay: 100_000 })),
      { limits: { order: v(S.indmoney, { perSecond: 10 }) } },
    ),
    maxQuoteBatch: 500,
    notes: "Order APIs 10/s; Data/Quote APIs 5/s (1,00,000/day); Non-Trading 15/s (1,00,000/day). Quote calls accept 1,000 instruments; the adapter sends 500.",
  }),

  jainamxts: xtsPolicy("jainamxts", { verified: false }),

  kotak: entry("kotak", { maxQuoteBatch: 25, notes: "Kotak Neo's SDK and docs publish no rate limit; conservative defaults." }),

  motilal: entry("motilal", { maxQuoteBatch: 1, notes: "No rate limit is documented; one call per instrument; conservative defaults." }),

  mstock: entry("mstock", {
    ...merge(
      { limits: { order: v(S.mstock, { perSecond: 30 }), history: v(S.mstock, { perSecond: 1 }) } },
      shared("quotes", ["quote", "depth", "chain"], v(S.mstock, { perSecond: 20 })),
    ),
    maxQuoteBatch: 100,
    notes: "Introduction page: orders 30/s (the Bridge caps orders at the SEBI 10/s ceiling), quotes 20/s, historical 1/s.",
  }),

  nubra: entry("nubra", {
    ...shared("marketData", ["quote", "depth", "history", "chain"], v(S.nubra, { perMinute: 60 })),
    maxQuoteBatch: 1,
    notes: "RateLimits page: REST market data and historical 60 requests a minute. Other limits are not published; conservative defaults.",
  }),

  paytm: entry("paytm", { maxQuoteBatch: 50, notes: "No rate limit is documented; conservative defaults." }),

  pocketful: entry("pocketful", {
    ...merge(
      shared("data", ["quote", "depth", "history", "chain"], v(S.pocketful, { perSecond: 10 })),
      shared("others", ["portfolio", "other", "master"], v(S.pocketful, { perSecond: 20 })),
      { limits: { order: v(S.pocketful, { perSecond: 10 }) } },
    ),
    maxQuoteBatch: 1,
    feed: { maxConnections: 8, maxSubscriptions: 1500 },
    notes: "Orders 10/s, data 10/s, others 20/s. Quotes are one instrument per call. Feed caps are the Bridge's own pool bounds, not broker figures.",
  }),

  rmoney: xtsPolicy("rmoney", { verified: false }),

  samco: entry("samco", { maxQuoteBatch: 25, notes: "No rate limits found in the Trade API v3.2 docs; conservative defaults." }),

  shoonya: entry("shoonya", {
    limits: { order: u({ perSecond: 10 }, S.shoonya), quote: u({ perSecond: 10 }, S.shoonya), depth: u({ perSecond: 10 }, S.shoonya), chain: u({ perSecond: 10 }, S.shoonya) },
    maxQuoteBatch: 1,
    notes: "The rate-limits page gives approximate figures (orders about 10/s per user; REST market data about 1/s per instrument), so the conservative defaults apply.",
  }),

  tradejini: entry("tradejini", {
    limits: { order: v(S.tradejini, { perSecond: 10 }) },
    maxQuoteBatch: 1,
    feed: { maxConnections: 5, maxSubscriptions: 3000 },
    notes: "Orders 10/s (orders page); login 3/s per IP. Market-data limits are not published; conservative defaults. Feed: 3,000 instruments per connection.",
  }),

  tradesmart: entry("tradesmart", { maxQuoteBatch: 1, notes: "The official docs could not be read (Cloudflare); conservative defaults." }),

  upstox: entry("upstox", {
    ...merge(
      shared("standard", ["quote", "depth", "history", "chain", "portfolio", "other", "master"], v(S.upstox, { perSecond: 50, perMinute: 500, extraWindows: [{ windowMs: 1_800_000, limit: 2000 }] })),
      { limits: { order: v(S.upstox, { perSecond: 10, perMinute: 500, extraWindows: [{ windowMs: 1_800_000, limit: 2000 }] }) } },
    ),
    maxQuoteBatch: 500,
    feed: { maxConnections: 2, maxSubscriptions: 2000 },
    notes: "Standard APIs 50/s, 500/min, 2,000/30 min; order APIs 10/s (regular algos), 500/min, 2,000/30 min. v3 feed: 2 connections; Full mode 2,000 instruments (LTPC 5,000).",
  }),

  wisdom: xtsPolicy("wisdom", { verified: false }),

  zebu: entry("zebu", {
    ...shared("perUser", ["order", "quote", "depth", "history", "chain", "portfolio", "other", "master"], u({ perSecond: 10 }, S.zebu)),
    maxQuoteBatch: 1,
    notes: "10 requests/second per user is a third-party figure, not on Zebu's OAuth pages; conservative defaults.",
  }),

  zerodha: entry("zerodha", {
    ...merge(
      {
        limits: {
          order: v(S.zerodha, { perSecond: 10 }),
          history: v(S.zerodha, { perSecond: 3 }),
          portfolio: v(S.zerodha, { perSecond: 10 }),
          other: v(S.zerodha, { perSecond: 10 }),
          master: v(S.zerodha, { perSecond: 10 }),
        },
        groups: { orderCaps: Object.freeze({ ...u({ perMinute: 400, perDay: 5000 }), classes: Object.freeze(["order"]) }) },
      },
      shared("quote", ["quote", "depth", "chain"], v(S.zerodha, { perSecond: 1 })),
    ),
    maxQuoteBatch: 500,
    feed: { maxConnections: 3, maxSubscriptions: 3000 },
    maxModificationsPerOrder: 25,
    notes: "Exceptions page: quote 1/s, historical 3/s, orders 10/s, everything else 10/s. Orders 400/min and 5,000/day are research figures (unverified) and are enforced because they only lower the budget. Feed: 3 connections x 3,000 instruments.",
  }),
});

/** Policy for accounts with broker "paper": nothing upstream, so no limits. */
export const PAPER_POLICY = Object.freeze({
  brokerId: "paper",
  limits: Object.freeze({}),
  groups: Object.freeze({}),
  maxQuoteBatch: 500,
  feed: NO_FEED,
  pooling: "not-allowed",
  maxModificationsPerOrder: null,
  notes: "Paper accounts make no broker calls of their own.",
});
