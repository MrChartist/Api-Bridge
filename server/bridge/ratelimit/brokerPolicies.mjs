/**
 * Broker policy table — the ratelimit module, DATA ONLY (accounts and market import it; it imports nothing).
 *
 * One entry per adapter id in server/brokers/registry.mjs (all 41). Every number carries `verified` and, where there
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
 *    own per-account cap (default 5/s) in safety.
 *  - The `ratelimit` config section can only LOWER these numbers.
 *
 * `maxQuoteBatch` is the number of instruments ONE upstream HTTP request carries (the adapter splits longer lists
 * itself). Callers that hand an adapter N instruments should pass cost = ceil(N / maxQuoteBatch) to schedule().
 *
 * `pooling` says whether the broker's terms clearly allow one user's read-only market-data calls to be spread over
 * several of that same user's accounts. No broker's published terms clearly allow it and none clearly forbids it
 * (the November 2026 review of 14 brokers found neither), so every entry is "unknown", which the Bridge treats as
 * not allowed unless the user also consents (server/bridge/sources/pooling.mjs). `poolingNote` says in one sentence what
 * the review found. Change `pooling` only with a citation to the broker's terms: "allowed" needs a clause or a written
 * answer from the broker, and "not-allowed" needs a clause about read pooling (a clause about circumventing ORDER
 * limits, such as Motilal's, is only a note).
 *
 * `dataEntitlement` says whether live data needs a paid plan: { value: "free" | "paid" | "paid-for-live" | "unknown",
 * note, verified, source? }. "paid-for-live" means trading calls are free but live quotes need a paid data plan. When an
 * entry has none, the data plan is unknown. A pooled account needs its own plan, so `mc-bridge doctor` warns.
 *
 * `tiers` (optional): documented plans of one broker, for example Fyers Standard and Prime. The entry's own limits,
 * groups, maxQuoteBatch and feed always equal the DEFAULT tier (`defaultTier`), the safe, lower one. A user picks a
 * tier per account in config (`ratelimit.accounts.<id>.tier`) or per broker (`ratelimit.brokers.<id>.tier`).
 *
 * Field shape: core/contracts.mjs BrokerPolicy / LimitSpec, plus additive extensions (not yet in contracts.mjs or
 * the OpenAPI BrokerPolicy schema; consumers that ignore them stay correct, only less precise):
 *   LimitSpec.extraWindows?: Array<{ windowMs, limit }>   windows other than second/minute/day (Dhan's hourly cap)
 *   BrokerPolicy.groups?: Record<string, LimitSpec & { classes: EndpointClass[] }>
 *   BrokerPolicy.feed: { maxConnections, maxSubscriptions, verified?, source?, note?, ...sub-limits }
 *   BrokerPolicy.dataEntitlement?, poolingNote, tiers?, defaultTier?
 */

/** When the per-number review was done. */
export const POLICY_TABLE_CHECKED = "2026-11";

/** The values `dataEntitlement.value` may take. */
export const DATA_ENTITLEMENTS = Object.freeze(["free", "paid", "paid-for-live", "unknown"]);

/** `poolingNote` for brokers the pooling review did not cover. */
export const POOLING_NOT_REVIEWED = "Not reviewed: no published term about spreading reads over several of your accounts was checked for this broker.";

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

/** Feed caps with the page they came from. `extra` carries broker-specific sub-limits (kept as data, not enforced). */
const feedOf = (source, verified, caps) => Object.freeze({ maxConnections: null, maxSubscriptions: null, ...caps, verified, source });
/** Data entitlement: what the broker charges for live data (see the header). */
const entitlement = (value, note, { verified = false, source } = {}) => Object.freeze({ value, note, verified, ...(source ? { source } : {}) });
/** A limits/feed bundle for one plan of a broker; `merge()` output plus maxQuoteBatch, feed, a label and a note. */
const tier = (label, { limits = {}, groups = {}, maxQuoteBatch = DEFAULT_MAX_QUOTE_BATCH, feed = NO_FEED, dataEntitlement, note }) =>
  Object.freeze({
    label,
    limits: Object.freeze({ ...limits }),
    groups: Object.freeze({ ...groups }),
    maxQuoteBatch,
    feed: Object.freeze({ ...feed }),
    ...(dataEntitlement ? { dataEntitlement } : {}),
    ...(note ? { note } : {}),
  });

function entry(
  brokerId,
  { limits = {}, groups, maxQuoteBatch = DEFAULT_MAX_QUOTE_BATCH, feed = NO_FEED, maxModificationsPerOrder = null, notes, dataEntitlement, poolingNote = POOLING_NOT_REVIEWED, tiers, defaultTier },
) {
  const p = {
    brokerId,
    limits: Object.freeze({ ...limits }),
    maxQuoteBatch,
    feed: Object.freeze({ ...feed }),
    pooling: "unknown",
    poolingNote,
    maxModificationsPerOrder,
  };
  if (groups) p.groups = Object.freeze({ ...groups });
  if (notes) p.notes = notes;
  if (dataEntitlement) p.dataEntitlement = dataEntitlement;
  if (tiers) {
    p.tiers = Object.freeze({ ...tiers });
    p.defaultTier = defaultTier ?? Object.keys(tiers)[0];
  }
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

/** A group budget over `classes` (a LimitSpec from v() or u() plus the classes it covers). */
const group = (classes, spec) => Object.freeze({ ...spec, classes: Object.freeze([...classes]) });

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
  fyers: "https://fyers.in/api-docs/v3/getting-started/plans-and-limits/",
  fyersWs: "https://fyers.in/api-docs/v3/api/websockets/websocket-overview/",
  fyersNotice: "https://fyers.in/notice-board/changes-to-fyers-api-rate-limits-and-usage",
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
  zerodhaWs: "https://kite.trade/docs/connect/v3/websocket/",
  zerodhaCost: "https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/what-are-the-charges-for-kite-apis",
  rupeezy: "https://vortex.rupeezy.in/docs/latest/",
  icicidirect: "https://api.icicidirect.com/breezeapi/documents/index.html",
  anandrathi: "https://algozy.rathi.com/doc/interactive/",
  fivepaisaxts: "https://symphonyfintech.com/xts-trading-front-end-api/",
  dhanFeed: "https://dhanhq.co/docs/v2/live-market-feed/",
  dhanDepth: "https://dhanhq.co/docs/v2/full-market-depth/",
  dhanChain: "https://dhanhq.co/docs/v2/option-chain/",
  dhanQuote: "https://dhanhq.co/docs/v2/market-quote/",
  dhanCost: "https://dhan.co/support/platforms/dhanhq-api/how-does-the-dhanhq-data-api-subscription-work/",
  angelForum: "https://smartapi.angelone.in/smartapi/forum/topic/4387/changes-in-api-rate-limit",
  angelWs: "https://smartapi.angelone.in/topic/1861/user-feedback-websocket-2-0-beta-rollout-python-language",
  angelCost: "https://angelone.in/knowledge-center/smartapi/detailed-introduction-to-smartapi",
  upstoxFeed: "https://upstox.com/developer/api-documentation/v3/get-market-data-feed/",
  upstoxCost: "https://upstox.com/trading-api/",
  growwFeed: "https://groww.in/trade-api/docs/python-sdk/feed",
  growwCost: "https://groww.in/blog/api-trading-on-groww",
  fivepaisaSite: "https://xstream.5paisa.com/",
  kotakLimits: "https://www.kotakneo.com/platform/kotak-neo-trade-api/static-ip-details/",
  kotakFeed: "https://www.kotakneo.com/support/what-is-the-maximum-number-of-scrips-which-can-be-subscribed-to-in-a-websocket-simultaneously/",
  kotakCost: "https://www.kotakneo.com/platform/kotak-neo-trade-api/",
  motilal: "https://invest.motilaloswal.com/moAPI/APIDocumentation/FAQ",
  icicidirectFaq: "https://www.icicidirect.com/faqs/fno/what-is-the-rate-limit-for-breeze-api",
  icicidirectCost: "https://www.icicidirect.com/futures-and-options/api/breeze",
  hdfcskyBlog: "https://hdfcsky.com/blogs/trading-strategies/hdfc-sky-api-rate-limits-session-validity-token-refresh",
  shoonyaLimits: "https://shoonya.com/api-documentation/rate-limits",
});

const HOUR_MS = 3_600_000;

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

/** Fyers plans (Standard is the default). Both from https://fyers.in/api-docs/v3/getting-started/plans-and-limits/, effective 2026-10-16. */
const FYERS_TIERS = Object.freeze({
  standard: tier("Standard (free)", {
    ...merge(
      shared("dataApis", ["quote", "depth", "history", "chain"], v(S.fyers, { perSecond: 5, perMinute: 50, perDay: 5000 })),
      shared("transactionApis", ["order", "portfolio", "other"], v(S.fyers, { perSecond: 10, perMinute: 200, perDay: 100_000 })),
    ),
    maxQuoteBatch: 50,
    feed: feedOf(S.fyersWs, true, { maxConnections: 1, maxSubscriptions: 100, note: "Data Socket symbol limit is per user across all connections; only one WebSocket instance at a time." }),
  }),
  prime: tier("Prime (paid)", {
    ...merge(
      shared("dataApis", ["quote", "depth", "history", "chain"], v(S.fyers, { perSecond: 10, perMinute: 500, perDay: 500_000 })),
      shared("transactionApis", ["order", "portfolio", "other"], v(S.fyers, { perSecond: 10, perMinute: 500, perDay: 500_000 })),
    ),
    maxQuoteBatch: 1000,
    feed: feedOf(S.fyersWs, true, { maxConnections: 1, maxSubscriptions: 5000, note: "Prime allows 5,000 symbols on the Data Socket." }),
    dataEntitlement: entitlement("paid", "Prime is a paid subscription; the price is not on the pages read.", { verified: true, source: S.fyers }),
  }),
});

// ── The table ──

/** @type {Readonly<Record<string, import("../core/contracts.mjs").BrokerPolicy>>} */
export const BROKER_POLICIES = Object.freeze({
  aliceblue: entry("aliceblue", {
    ...merge(
      { limits: { order: v(S.aliceblue, { perSecond: 10 }), history: v(S.aliceblue, { perSecond: 20 }), portfolio: v(S.aliceblue, { perSecond: 30 }), other: v(S.aliceblue, { perSecond: 30 }) } },
      shared("quoteApi", ["quote", "depth", "chain"], v(S.aliceblue, { perSecond: 5 })),
    ),
    maxQuoteBatch: 50,
    notes: "Order API 10/s, Data API 20/s, Quote API 5/s, non-trading APIs 30/s. Verify before release: the docs page is rendered by script and could not be re-read in the November 2026 review.",
    poolingNote: "The documentation page could not be read, so nothing is known about spreading reads over several accounts.",
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
      {
        groups: {
          // Minute and hour caps from a broker-run forum table (not the live docs page), so unverified. Groups are always
          // applied, so they can only slow the Bridge down; the verified per-second figures above stay as written.
          orderCaps: group(["order"], u({ perMinute: 500, extraWindows: [{ windowMs: HOUR_MS, limit: 1000 }] }, S.angelForum)),
          candleCaps: group(["history"], u({ perMinute: 120, extraWindows: [{ windowMs: HOUR_MS, limit: 5000 }] }, S.angelForum)),
        },
      },
    ),
    maxQuoteBatch: 50,
    feed: feedOf(S.angelWs, false, { maxConnections: 3, maxSubscriptions: 1000, note: "1,000 token and mode pairs per session; each pair counts separately." }),
    dataEntitlement: entitlement("free", "SmartAPI is free of cost, including historical data.", { verified: true, source: S.angelCost }),
    poolingNote: "Angel One's staff say the rate limit is based on User ID, but no official statement allows or forbids spreading reads over several accounts.",
    notes: "RateLimit page: place/modify/cancel 9/s combined (a 10/s per segment figure from April 2026 is not yet confirmed, so 9/s stays); order book, positions, holdings 1/s; candles 3/s. The Market Data page says 1/s for 50-token quote calls. Per-minute and hourly caps (orders 500/min and 1,000/hour; candles 120/min, the lowest of 120, 150 and 180 reported, and 5,000/hour) come from a forum table and are unverified. The same table says quotes 10/s, 500/min, 5,000/hour, which conflicts with the 1/s page, so 1/s stays.",
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
          // "One unique request every 3 seconds": a 3-second window of 1 (also 20 a minute, derived).
          chain: v(S.dhanChain, { extraWindows: [{ windowMs: 3000, limit: 1 }] }),
          portfolio: v(S.dhan, { perSecond: 20 }),
          other: v(S.dhan, { perSecond: 20 }),
        },
      },
      shared("marketQuote", ["quote", "depth"], v(S.dhanQuote, { perSecond: 1 })),
    ),
    maxQuoteBatch: 1000,
    feed: feedOf(S.dhanFeed, true, {
      maxConnections: 5,
      maxSubscriptions: 5000,
      perSubscribeMessage: 100,
      depth20PerConnection: 50,
      depth200PerConnection: 1,
      note: "A sixth connection disconnects the first (code 805). 100 instruments per subscribe message. 20-level depth: 50 instruments per connection; 200-level depth: 1 (full-market-depth page).",
    }),
    maxModificationsPerOrder: 25,
    dataEntitlement: entitlement("paid-for-live", "Trading APIs are free; the Data APIs (live feed, quotes, history, option chain) cost Rs 499 plus tax a month per account.", { verified: true, source: S.dhanCost }),
    poolingNote: "Dhan's terms are silent on several accounts, bar sharing credentials and bar 'data mining, data harvesting, data extracting' (written about the website), so get a legal read.",
    notes: "Orders 10/s, 250/min, 1,000/hour, 7,000/day; data APIs 5/s and 1,00,000/day; market quote 1/s for up to 1,000 instruments; non-trading 20/s. Option chain: one unique request every 3 seconds. Feed: 5 connections x 5,000 instruments. Quotes, history, option chain and the feed need the paid Data API plan.",
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
    ...merge(
      {
        limits: { order: u({ perSecond: 10, perMinute: 600 }, S.fivepaisaSite) },
        groups: { nonOrder: group(["quote", "depth", "history", "chain", "portfolio", "other"], u({ perMinute: 50 }, S.fivepaisaSite)) },
      },
    ),
    maxQuoteBatch: 50,
    feed: feedOf(S.fivepaisaSite, false, { maxSubscriptions: 200, note: "From the Xstream marketing page (\"200 Subscription\")." }),
    dataEntitlement: entitlement("free", "5paisa says all trading APIs are free of charge; this is a marketing-page statement.", { source: S.fivepaisaSite }),
    poolingNote: "The terms page was not read and nothing found says anything about several accounts.",
    notes: "No limits table on the Xstream documentation pages. The Xstream site FAQ says 600 order requests a minute and 50 requests a minute for other APIs, and a staff post after April 2026 says orders are capped at 10 a second. These are marketing and forum figures, so unverified; they only lower the budget.",
  }),

  flattrade: entry("flattrade", {
    ...merge(
      shared("data", ["quote", "depth", "history", "chain", "portfolio", "other", "master"], v(S.flattrade, { perSecond: 40, perMinute: 200 })),
      { limits: { order: v(S.flattrade, { perSecond: 10, perMinute: 40 }) } },
    ),
    maxQuoteBatch: 1,
    dataEntitlement: entitlement("free", "Pi is marketed as a free stock market API; no fee terms were found.", {}),
    poolingNote: "No API terms were found, so nothing is known about spreading reads over several accounts.",
    notes: "API Rate Limit: 40/s and 200/min for data calls; Order API Rate Limit: 10/s and 40/min. Noren GetQuotes takes one instrument per call. Verify before release: the docs page is rendered by script and could not be re-read in the November 2026 review (a public mirror of the docs agrees).",
  }),

  fyers: entry("fyers", {
    // Limits as changed on 16 October 2026. The entry's own figures are the Standard plan (the default, the lower one).
    ...FYERS_TIERS.standard,
    dataEntitlement: entitlement("free", "Standard is free (feed limited to 100 symbols); Prime is a paid plan with higher limits.", { verified: true, source: S.fyers }),
    poolingNote: "Fyers' terms bar permitting 'the use of the APIs by any third party' and sharing credentials with other clients, and say nothing about your own several accounts, so get a legal read.",
    tiers: FYERS_TIERS,
    defaultTier: "standard",
    notes: "Plans and limits page, effective 16 Oct 2026. Standard: data 5/s, 50/min, 5,000/day; other calls 10/s, 200/min, 1,00,000/day; 50 symbols per quote request; Data Socket 100 symbols per user across connections. Prime: data 10/s, 500/min, 5,00,000/day; other calls 10/s, 500/min, 5,00,000/day; 1,000 symbols per request; 5,000 symbols. Choose Prime per account with ratelimit.accounts.<id>.tier only if you have it. Older Fyers material said more than 3 per-minute breaches a day blocks the user for the rest of the day; the October 2026 notice only says requests may be restricted until the limit resets, so that rule is unverified now. The Bridge still never retries a Fyers rate-limit error.",
  }),

  groww: entry("groww", {
    ...merge(
      shared("liveData", ["quote", "depth", "chain", "history"], v(S.groww, { perSecond: 10, perMinute: 300 })),
      shared("nonTrading", ["portfolio", "other", "history", "master"], v(S.groww, { perSecond: 20, perMinute: 500 })),
      { limits: { order: v(S.groww, { perSecond: 10, perMinute: 250 }) } },
    ),
    maxQuoteBatch: 1,
    feed: feedOf(S.growwFeed, true, { maxSubscriptions: 1000, note: "The SDK feed page says up to 1,000 instruments at a time; a Groww blog says 3,000 per user and 5 sessions, so the lower figure is used." }),
    dataEntitlement: entitlement("paid-for-live", "The free trial covers orders, positions, holdings and margin but not live quotes, LTP, OHLC, option chain or Greeks; the Monthly plan is Rs 499 plus tax.", { verified: true, source: S.growwCost }),
    poolingNote: "Groww's API terms could not be read, so nothing is known about several accounts, and every pooled account would need the paid data plan.",
    notes: "Orders 10/s 250/min; Live Data 10/s 300/min; Non Trading 20/s 500/min. Historical is counted against both data groups because the docs do not say which applies. The token endpoint has its own limits (5/s, 30/min, 150 per 24 hours); the Bridge logs in once a day.",
  }),

  hdfcsecurities: entry("hdfcsecurities", { maxQuoteBatch: 10, notes: "The InvestRight docs publish no rate limit; conservative defaults." }),

  hdfcsky: entry("hdfcsky", {
    maxQuoteBatch: 10,
    feed: feedOf(S.hdfcskyBlog, false, { maxConnections: 3, maxSubscriptions: 300, note: "From HDFC Sky's own blog (up to 300 instruments per connection, three connections per API key); another guide lists the feed as coming soon." }),
    dataEntitlement: entitlement("free", "HDFC Sky says it offers free APIs; no page with the exact terms was readable.", { source: S.hdfcskyBlog }),
    poolingNote: "The developer documentation could not be read and no terms were found, so nothing is known about several accounts.",
    notes: "The HDFC Sky docs publish no rate limit; conservative defaults.",
  }),

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

  kotak: entry("kotak", {
    limits: { order: v(S.kotakLimits, { perSecond: 10 }) },
    maxQuoteBatch: 25,
    feed: feedOf(S.kotakFeed, false, { maxSubscriptions: 200, note: "The support FAQ says a maximum of 200 scrips per request; the page is old and contradicts itself, so this is unverified." }),
    dataEntitlement: entitlement("free", "Kotak says the Trade API is free of cost at present.", { verified: true, source: S.kotakCost }),
    poolingNote: "Kotak says API access and credentials are 'meant exclusively for the client's own use' and bars third-party access to your account; it says nothing about several of your own accounts, so get a legal read.",
    notes: "Orders are rate limited to 10 a second (the static IP page). Kotak Neo's SDK and docs publish no limit for data calls; conservative defaults apply to them.",
  }),

  motilal: entry("motilal", {
    limits: { order: v(S.motilal, { perSecond: 10 }) },
    maxQuoteBatch: 1,
    dataEntitlement: entitlement("unknown", "The site says 'no hidden cost'; no fee page was found.", { source: S.motilal }),
    poolingNote: "Motilal's FAQ says 'Using multiple API keys to circumvent the OPS limit is not permitted'; that is about order limits, not reads, and the FAQ contradicts itself, so ask the broker in writing.",
    notes: "FAQ Q86: 10 orders a second per exchange segment for retail users, counted per client (UCC), not per API key (Q92). No limit for data calls is documented; one call per instrument; conservative defaults.",
  }),

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
    feed: feedOf(S.shoonyaLimits, true, { maxConnections: 1, note: "One connection per session; every subscription is multiplexed on it." }),
    dataEntitlement: entitlement("unknown", "The terms say Finvasia may charge for the APIs 'selectively'; third parties call them free, which is unverified.", { source: "https://shoonya.com/api-terms-and-conditions" }),
    poolingNote: "Shoonya's terms say credentials 'are intended to be used only by you' and bar sublicensing the APIs to a third party; they are silent on several of your own accounts.",
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
    feed: feedOf(S.upstoxFeed, true, {
      maxConnections: 2,
      maxSubscriptions: 2000,
      byMode: {
        ltpc: { alone: 5000, combined: 2000 },
        optionGreeks: { alone: 3000, combined: 2000 },
        full: { alone: 2000, combined: 1500 },
      },
      note: "Per mode alone: LTPC 5,000, Option Greeks 3,000, Full 2,000 keys. When modes are mixed the caps drop to LTPC 2,000, Option Greeks 2,000, Full 1,500. Upstox Plus gives 5 connections.",
    }),
    dataEntitlement: entitlement("free", "Upstox says all trading and data APIs are free of cost; a per-order fee runs to 31 Dec 2026 and the fee after that is not confirmed.", { verified: true, source: S.upstoxCost }),
    poolingNote: "Upstox's developer terms (accepted when you create an app) could not be read; limits are per user and no page read mentions several accounts.",
    notes: "Standard APIs 50/s, 500/min, 2,000/30 min; order APIs 10/s (regular algos), 500/min, 2,000/30 min. v3 feed: 2 connections; Full mode 2,000 instruments (LTPC 5,000); mixed-mode caps are in feed.byMode.",
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
        groups: { orderCaps: group(["order"], v(S.zerodha, { perMinute: 400, perDay: 5000 })) },
      },
      shared("quote", ["quote", "depth", "chain"], v(S.zerodha, { perSecond: 1 })),
    ),
    maxQuoteBatch: 500,
    feed: feedOf(S.zerodhaWs, true, { maxConnections: 3, maxSubscriptions: 3000 }),
    maxModificationsPerOrder: 25,
    dataEntitlement: entitlement("paid-for-live", "The free Personal plan has no live or historical data; Connect is Rs 500 a month per app (key) and includes websocket data and historical candles.", { verified: true, source: S.zerodhaCost }),
    poolingNote: "Zerodha's documents are silent on several accounts; an API key is bound to one client id and its staff refer multi-user questions to the compliance team.",
    notes: "Exceptions page: quote 1/s, historical 3/s, orders 10/s (400/min and 5,000/day per user), everything else 10/s. Feed: 3 connections x 3,000 instruments per key.",
  }),
  anandrathi: xtsPolicy("anandrathi", { verified: false, source: S.anandrathi }),

  axisdirect: entry("axisdirect", {
    maxQuoteBatch: 50,
    notes: "The RAPID API collection publishes no rate limit; conservative defaults. Read-only adapter (no order methods).",
  }),

  bigul: entry("bigul", {
    maxQuoteBatch: 1,
    notes: "Bigul Connect publishes no rate limit; quotes come from its market-data WebSocket. Conservative defaults.",
  }),

  fivepaisaxts: xtsPolicy("fivepaisaxts", { verified: false, source: S.fivepaisaxts }),

  goodwill: entry("goodwill", {
    maxQuoteBatch: 1,
    notes: "The Goodwill API v1 docs publish no rate limit; one getquote call per contract. Conservative defaults.",
  }),

  icicidirect: entry("icicidirect", {
    limits: { order: v(S.icicidirectFaq, { perSecond: 10 }) },
    groups: { breeze: Object.freeze({ ...v(S.icicidirect, { perMinute: 100, perDay: 5000 }), classes: Object.freeze(["order", "quote", "depth", "history", "chain", "portfolio", "other", "master"]) }) },
    maxQuoteBatch: 1,
    dataEntitlement: entitlement("free", "ICICI Direct says there is no cost or fee to access Breeze API or its data.", { verified: true, source: S.icicidirectCost }),
    poolingNote: "No Breeze-specific terms were found; the 5,000 calls a day are shared by every endpoint, which makes pooling tempting and a legal read worthwhile.",
    notes: "Breeze: 100 calls a minute and 5,000 a day across every API (one shared budget), and 10 orders a second combined for place, modify, cancel and square-off. The per-class conservative defaults still apply on top.",
  }),

  profitmart: entry("profitmart", {
    maxQuoteBatch: 1,
    notes: "ProfitMax (Noren) publishes no rate limit; one instrument per GetQuotes call. Conservative defaults.",
  }),

  rupeezy: entry("rupeezy", {
    ...merge(
      {
        limits: {
          order: v(S.rupeezy, { perSecond: 10 }),
          history: v(S.rupeezy, { perSecond: 1 }),
          portfolio: v(S.rupeezy, { perSecond: 1 }),
        },
        groups: { daily: Object.freeze({ ...v(S.rupeezy, { perDay: 50_000 }), classes: Object.freeze(["order", "quote", "depth", "history", "chain", "portfolio", "other", "master"]) }) },
      },
      shared("dataApis", ["quote", "depth", "chain"], v(S.rupeezy, { perSecond: 1 })),
    ),
    maxQuoteBatch: 1000,
    notes: "Vortex usage page: 1/s for session, funds, quotes, history and option chain; 10/s for trading calls; 50,000 a day in all. Quotes take up to 1,000 instruments.",
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
  poolingNote: "Paper accounts make no broker calls, so there is nothing to pool.",
  dataEntitlement: Object.freeze({ value: "free", note: "Paper accounts use no broker data plan of their own.", verified: true }),
  maxModificationsPerOrder: null,
  notes: "Paper accounts make no broker calls of their own.",
});
