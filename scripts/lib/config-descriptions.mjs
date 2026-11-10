/**
 * Plain-words descriptions for every key of bridge.config.json, one entry per key path as scripts/lib/config-model.mjs
 * lists them. docs/guides/config.md is generated from the schema (types, defaults, limits) plus this file.
 * scripts/config-reference.test.mjs fails when a key in the schema has no entry here, and when an entry names a key that no
 * longer exists, so a new setting cannot ship undocumented and a removed one cannot linger.
 *
 * Write for someone who has never seen the code: say what the setting does and what happens when it is changed. Do not
 * repeat the default or the range (the table shows them).
 */

/** Section heading text, in file order: { title, about, guide? } where `guide` is the guide that explains the section in depth. */
export const SECTIONS = {
  general: { about: "Keys that sit at the top of the file, outside any section: where data is kept, where the master key is, and demo mode." },
  server: { about: "Where the Bridge listens and who may talk to it. The defaults keep it on this computer only.", guide: "vps.md" },
  cors: { about: "Which web pages in a browser may call the Bridge.", guide: "safety.md" },
  logging: { about: "What the Bridge writes to its log.", guide: "operations.md" },
  accounts: { about: "Your broker accounts and the paper account. One entry per account.", guide: "accounts.md" },
  safety: { about: "The limits every order passes, paper and live. The Bridge applies the stricter of these and an account's own limits.", guide: "safety.md" },
  morningLogin: { about: "The reminder to log in to your brokers on trading mornings.", guide: "accounts.md" },
  ratelimit: { about: "How the Bridge stays inside each broker's request limits and shares them between your tools. These settings can only lower a broker's documented limits, never raise them.", guide: "rate-limits.md" },
  symbols: { about: "How the instrument list (every share, future and option) is loaded and kept.", guide: "symbols.md" },
  market: { about: "How fresh a price must be, how long ranges of history are fetched, and how option chains are built.", guide: "rate-limits.md" },
  stream: { about: "The live price stream over WebSocket and server-sent events.", guide: "streaming.md" },
  orders: { about: "How orders wait for confirmation, how an unknown result is looked up again, and how long order records are kept. Nothing here can switch live trading on.", guide: "orders.md" },
  paper: { about: "The paper-trading engine: starting money, fills, square-off, margin and charges.", guide: "paper-margin.md" },
  readiness: { about: "The trading-readiness check of live accounts: session, registered address, headroom and the kill switch.", guide: "deployment.md" },
  integrations: { about: "Defaults for the spreadsheet routes under /xl (Excel, Google Sheets, AmiBroker).", guide: "excel-sheets.md" },
  hooks: { about: "Alert hooks (TradingView, ChartInk and others): queue, duplicate checks, allowed addresses and limits.", guide: "webhooks.md" },
  mcp: { about: "The MCP endpoint for AI assistants. Read-only unless you add order tools here.", guide: "mcp.md" },
  compat: { about: "The compatibility REST API at /api/v1 for tools that send the key in the request body.", guide: "compat-api.md" },
  sources: { about: "Optional free data sources and plugins. Their answers are labelled delayed or end-of-day and never feed orders.", guide: "sources.md" },
  backup: { about: "Copies of your data folder: before an upgrade, by hand and on a daily schedule.", guide: "backup.md" },
  notify: { about: "Phone messages (Telegram): which events, quiet hours, pacing and retries. The bot token is never stored here.", guide: "notifications.md" },
  library: { about: "Collections: named lists of instruments and option universes.", guide: "collections.md" },
  events: { about: "Events out: the event stream with replay, and signed outbound webhooks.", guide: "events.md" },
  downloads: { about: "Saving history to files, and keeping datasets up to date.", guide: "downloads.md" },
  recorder: { about: "Recording live prices and option chains to files, by hand or by rules every trading day.", guide: "recording.md" },
  storage: { about: "Free-disk checks for the folder the Bridge writes to.", guide: "operations.md" },
};

const D = {};
const d = (path, text) => {
  if (Object.hasOwn(D, path)) throw new Error(`config description given twice: ${path}`);
  D[path] = text;
};

// ---- server -----------------------------------------------------------------------------------------------------
d("server.host", "The address the Bridge listens on. 127.0.0.1 means this computer only. Anything else needs allowNonLoopback.");
d("server.port", "The port of the main listener (API and dashboard). 0 lets the system pick a free one. The environment variable MCB_PORT overrides it.");
d("server.allowNonLoopback", "Must be true before the Bridge will listen on anything but this computer. Every route still needs an API key.");
d("server.remoteDashboard", "Serve the dashboard pages to other computers. Only allowed in demo mode (a public demo); the Bridge refuses to start with this on and real accounts.");
d("server.localPeers", "Addresses (IPv4 or IPv4/CIDR) that count as this computer for routes that must come from this computer, besides loopback. Only for Docker, where your browser arrives from the container network's gateway. Leave empty otherwise.");
d("server.allowedHosts", "Extra Host header names the Bridge accepts. Loopback names are always accepted. This is the guard against a web page pointing its own name at 127.0.0.1.");
d("server.bodyLimitBytes", "The largest request body the Bridge accepts, in bytes. A bigger body is refused.");
d("server.publicIngress.enabled", "Turn on a second listener that serves only the alert routes (hooks), for a tunnel or proxy that receives TradingView alerts. Off by default.");
d("server.publicIngress.host", "The address of the alert listener. Keep it on 127.0.0.1 and point your tunnel at it.");
d("server.publicIngress.port", "The port of the alert listener. It must differ from the other listeners.");
d("server.publicIngress.allowedHosts", "Host names the alert listener accepts (your public host name).");
d("server.sheetsIngress.enabled", "Turn on a third listener that serves only GET /xl/* for read-only keys, for Google Sheets through a tunnel. Off by default.");
d("server.sheetsIngress.host", "The address of the Sheets listener. Keep it on 127.0.0.1 and point your tunnel at it.");
d("server.sheetsIngress.port", "The port of the Sheets listener. It must differ from the other listeners.");
d("server.sheetsIngress.allowedHosts", "Host names the Sheets listener accepts (your public host name).");
d("server.sheetsIngress.requestsPerMinute", "Requests per minute the Sheets listener accepts from one caller address. Behind a local tunnel every caller shares one address, so this caps them together.");

// ---- cors, dataDir, masterKeyFile, demo -------------------------------------------------------------------------
d("cors.allowedOrigins", "Web page origins (scheme://host[:port], no path) that a browser may call the Bridge from. Empty means none. Scripts, Excel, AmiBroker and the dashboard need none. No wildcard is allowed.");
d("dataDir", "The folder for keys, accounts, paper books, orders, audit log, downloads, recordings and backups. A relative path is read from the folder of the config file. MCB_DATA_DIR overrides it. Without a config file the Bridge uses a folder in your user area.");
d("masterKeyFile", "The file holding the master key that encrypts saved broker logins. A relative path is read from the folder of the config file. MCB_MASTER_KEY or MCB_MASTER_KEY_FILE in the environment take precedence. Without it the key is data/master.key. Keep it outside the data folder, so a backup of the data folder never carries the key.");
d("demo", "Run with sample prices and no real broker. Live trading is off. The same as starting with --demo or MCB_DEMO=1.");

// ---- logging ----------------------------------------------------------------------------------------------------
d("logging.level", "How much the Bridge says: debug, info, warn, error or silent. MCB_LOG_LEVEL overrides it.");
d("logging.requests", "Which requests get an access line: errors (status 400 and above, and anything slower than one second), all, or off.");
d("logging.file", "Also write logs/bridge.log in the data folder, rotated. When not set it is on for mc-bridge start and off in Docker (use docker logs).");
d("logging.maxFileMb", "The size at which the log file is rotated, in megabytes.");
d("logging.keepFiles", "How many rotated log files are kept.");

// ---- accounts ---------------------------------------------------------------------------------------------------
d("accounts", "The list of accounts. Each entry has the settings below. Logins never go in this file; they are saved encrypted when you log in.");
d("accounts[].id", "Your name for the account: 2 to 32 lowercase letters, digits or hyphens. Used as account= in queries and \"account\" in orders.");
d("accounts[].broker", "The broker adapter id (dhan, zerodha, upstox and the others in BROKERS.md), or paper for a practice account.");
d("accounts[].label", "A name to show on the dashboard and in answers.");
d("accounts[].holder", "Whose account this is: any stable label such as self or spouse, never a PAN. Reads are spread over accounts only when they have the same holder.");
d("accounts[].enabled", "false keeps the account in the file but out of use.");
d("accounts[].live.enabled", "Allow live orders on this account. Needs safety.liveTrading too. A paper account can never have it on.");
d("accounts[].live.allowedSources", "Which request sources may send live orders on this account: rest, webhook, mcp, cli, guard, alert. Listing mcp still needs a person to confirm each order.");
d("accounts[].live.registeredIp", "The static IP address you registered with your broker for orders. Used by the readiness check.");
d("accounts[].live.backupIp", "A second registered address, for brokers that allow a primary and a backup. The readiness check accepts either.");
d("accounts[].marketData.pooling", "Let this account's request budget serve reads that did not name an account. Off by default; it also needs your consent in the dashboard.");
d("accounts[].marketData.poolingWhenTermsUnknown", "Also pool when the broker's terms on spreading reads over your accounts are not confirmed (true for every broker today). Your own decision, made in this file only.");
d("accounts[].limits.dailyMaxOrders", "A stricter daily order count for this account than the global one.");
d("accounts[].limits.dailyMaxLoss", "A stricter daily loss limit (rupees) for this account than the global one.");
d("accounts[].limits.maxOrderValue", "A stricter order value limit (rupees) for this account than the global one.");
d("accounts[].limits.maxLotsPerOrder", "A stricter lots-per-order limit for this account than the global one.");
d("accounts[].limits.orderRatePerSecond", "A stricter order rate (orders per second) for this account. The lower of this and the global value applies.");

// ---- safety -----------------------------------------------------------------------------------------------------
d("safety.liveTrading", "The master switch for live orders. Off by default. The environment can never turn it on; MCB_PAPER_ONLY=1 forces it off.");
d("safety.orderRatePerSecond", "Orders per second per account (place, modify and cancel all count). It cannot be set above 10.");
d("safety.dailyMaxOrders", "Orders per account per IST day. An order that passes its checks reserves its place at once.");
d("safety.dailyMaxLoss", "The daily loss per account, in rupees, after which new orders are refused. Paper uses realised paper P&L; live uses the broker's day P&L.");
d("safety.maxOrderValue", "The largest value of one order, in rupees. A modify is checked on the order as it would stand after the change.");
d("safety.maxLotsPerOrder", "The most lots in one order.");
d("safety.priceBandPct", "Limit and trigger prices must be within this percentage of the last price.");
d("safety.marketOrders", "protect sends a market order as a limit at the last price plus or minus marketProtectionPct (or uses the broker's own protection). reject refuses market orders.");
d("safety.marketProtectionPct", "The percentage around the last price used to protect a market order.");
d("safety.killSwitchOnStart", "Start with the kill switch already on (no new orders until you release it). MCB_KILL_SWITCH=1 does the same.");

// ---- morningLogin -----------------------------------------------------------------------------------------------
d("morningLogin.enabled", "Send the login reminders.");
d("morningLogin.remindAt", "The IST time on trading days when the account.login_needed event is emitted for each account that needs a login. The Telegram message has its own time, notify.morning.at.");
d("morningLogin.warnBeforeEndMinutes", "Remind again this many minutes before a session that ends before the close. 0 turns the second reminder off.");

// ---- ratelimit --------------------------------------------------------------------------------------------------
d("ratelimit.client.perSecond", "Requests per second each API key may make to the Bridge.");
d("ratelimit.client.burst", "The size of a short burst a key may make. When not set it equals perSecond.");
d("ratelimit.client.perDay", "Requests per IST day each key may make. When not set there is no daily cap.");
d("ratelimit.client.maxConcurrent", "Requests one key may have in flight at once. Beyond it the Bridge answers 429.");
for (const kind of ["ui", "mcp", "excel", "script", "other"]) {
  d(`ratelimit.client.kindWeights.${kind}`, `Share of a busy broker queue for keys made for the "${kind}" kind of client (1 to 16). Defaults when not set: ui 4, mcp 2, excel 1, script 1, other 1.`);
}
d("ratelimit.client.keys", "Budgets for single keys, by the key's 10-character id (the part in mcb_<id>_...).");
d("ratelimit.client.keys.<name>.perSecond", "Requests per second for this key.");
d("ratelimit.client.keys.<name>.burst", "Burst size for this key.");
d("ratelimit.client.keys.<name>.perDay", "Requests per IST day for this key.");
d("ratelimit.client.keys.<name>.weight", "This key's share of a busy broker queue (1 to 16).");

const WINDOWS = (who, scope) => ({
  limits: `Lower ${scope} limits per kind of request. The name is order, quote, depth, history, chain, portfolio, master or other.`,
  perSecond: `Requests per second for this kind of request.`,
  perMinute: `Requests per minute for this kind of request.`,
  perDay: `Requests per day for this kind of request.`,
  extraWindows: `Extra windows other than second, minute and day (up to 4), for example an hourly cap.`,
  windowMs: `Length of the extra window in milliseconds.`,
  limit: `Requests allowed in the extra window.`,
  groups: `Lower limits for a named group of request kinds that share one budget at ${who}, as that broker's documentation counts them.`,
});
for (const [who, base] of [["the broker", "ratelimit.brokers.<name>"], ["the account", "ratelimit.accounts.<name>"]]) {
  const scope = who === "the broker" ? "this broker's" : "this account's";
  const w = WINDOWS(who, scope);
  d(`${base}.limits`, w.limits);
  d(`${base}.groups`, w.groups);
  for (const root of [`${base}.limits.<name>`, `${base}.groups.<name>`]) {
    d(`${root}.perSecond`, w.perSecond);
    d(`${root}.perMinute`, w.perMinute);
    d(`${root}.perDay`, w.perDay);
    d(`${root}.extraWindows`, w.extraWindows);
    d(`${root}.extraWindows[].windowMs`, w.windowMs);
    d(`${root}.extraWindows[].limit`, w.limit);
  }
  d(`${base}.maxQuoteBatch`, `How many instruments one request to ${who === "the broker" ? "this broker" : "this account's broker"} carries for prices. It can only be lowered.`);
  d(`${base}.tier`, "The broker plan your limits come from, for brokers with documented plans. Pick a higher plan only if you have it. Unknown names are refused for a broker entry.");
}
d("ratelimit.brokers", "Lower limits for every account of one broker, by broker id. A value above the documented limit is a config error, so a typo cannot quietly do nothing.");
d("ratelimit.accounts", "Lower limits for one account, by account id. A value above the broker's limit is clamped at run time.");
d("ratelimit.queue.maxQueuedPerAccount", "Requests waiting for one account's budget, all kinds together. More are refused with UPSTREAM_RATE_LIMITED.");
d("ratelimit.queue.maxQueuedPerConsumer", "Requests one key may have waiting per account. When not set it is 200. Beyond it that key is refused.");
d("ratelimit.queue.ageingMs", "Every this many milliseconds a waiting request that is not an order moves up one priority level (never above live).");
d("ratelimit.queue.maxWaitMs.order", "How long an order may wait for budget before it is refused, in milliseconds.");
d("ratelimit.queue.maxWaitMs.live", "How long a request at the live priority may wait for budget before it is refused, in milliseconds.");
d("ratelimit.queue.maxWaitMs.interactive", "How long a request at the interactive priority may wait for budget before it is refused, in milliseconds.");
d("ratelimit.queue.maxWaitMs.background", "How long a request at the background priority (downloads, recordings, prefetches) may wait for budget before it is refused, in milliseconds.");
d("ratelimit.maxInFlightPerAccount", "Broker calls other than orders running at once per account. Orders are never held back by this.");
d("ratelimit.maxInFlightPerConsumer", "Broker calls one key may hold at once while others wait. When not set it is half of maxInFlightPerAccount.");
d("ratelimit.windowPaddingMs", "Extra width added to every sliding window to absorb network delay, in milliseconds.");
d("ratelimit.backoff.initialMs", "The first wait after a broker asks the Bridge to slow down, in milliseconds. It grows from here.");
d("ratelimit.backoff.maxMs", "The longest wait after repeated slow-down requests, in milliseconds.");

// ---- symbols ----------------------------------------------------------------------------------------------------
d("symbols.refreshAfterIst", "An instrument list fetched before this IST time is fetched again once the time has passed, so each trading day starts with the day's list.");
d("symbols.diskCache", "Keep today's instrument list in the data folder so a restart costs no download.");
d("symbols.failureBackoffMs", "After a failed download of an instrument list, wait this long before trying that broker again, in milliseconds.");
d("symbols.warmOnStart", "Load the connected brokers' instrument lists in the background when the Bridge starts.");

// ---- market -----------------------------------------------------------------------------------------------------
d("market.freshness.ltpMs", "How old a last price may be before the Bridge fetches a new one, when the caller gives no maxAgeMs (milliseconds). It can be tightened freely and loosened only up to the maximum shown.");
d("market.freshness.quoteMs", "The same for full quotes (milliseconds).");
d("market.freshness.depthMs", "The same for market depth (milliseconds). Depth older than 5 seconds is never served whatever you set.");
d("market.freshness.chainMs", "The same for option chains (milliseconds).");
d("market.freshness.expiriesMs", "The same for the list of expiry dates (milliseconds).");
d("market.freshness.historyMs", "The same for history answers (milliseconds).");
d("market.stale.enabled", "When a broker's budget is used up, serve a cached value labelled stale instead of making the caller wait past its deadline.");
d("market.stale.maxStaleMs", "The oldest cached value that may be served as stale, in milliseconds. Depth is capped at 5 seconds whatever this says.");
d("market.stale.waitMs", "How long a read that has a stale fallback waits for budget before falling back, in milliseconds.");
d("market.batch.windowMs", "Price requests that arrive within this many milliseconds are merged into one broker call per account.");
d("market.batch.maxSymbols", "A merged batch is sent early when it reaches this many symbols.");
d("market.streamFirst", "Answer last prices and quotes from a live stream subscription when there is one, so they cost no broker request.");
d("market.quietLegMaxAgeMs", "For chains built from the stream: a leg that has not ticked within the chain freshness target is still used up to this age, when its subscription is live on a feed that is ticking now (milliseconds). 0 requires every leg to have ticked recently.");
d("market.history.maxChunks", "The most broker calls one history request may make. A longer range returns the newest part with partial: true.");
d("market.history.maxSpanDays.intraday", "Days of intraday bars asked from the broker in one call.");
d("market.history.maxSpanDays.daily", "Days of daily bars asked from the broker in one call.");
d("market.history.brokers", "Different spans per broker, by broker id. Use only figures from the broker's own documentation.");
d("market.history.brokers.<name>.intraday", "Days of intraday bars per call for this broker.");
d("market.history.brokers.<name>.daily", "Days of daily bars per call for this broker.");
d("market.history.localFirst", "Answer GET /v1/history from datasets stored on this computer when they cover the range, and ask the broker only for the rest. ?dataset=<name> always reads from that dataset.");
d("market.chain.source", "auto uses the broker's own chain where the account offers one and otherwise builds it from the instrument list plus quotes. broker or built forces one way.");
d("market.chain.riskFreeRate", "The yearly interest rate (as a decimal, 0.07 is 7 percent) used for computed Greeks. When not set the Bridge uses its built-in rate.");
d("market.chain.ivModelDefault", "The implied-volatility model used when a request names none. legacy-bs-spot until 1 May 2027, then b76-forward; set b76-forward to switch early. See API-DEPRECATIONS.md.");
d("market.chain.maxBuiltLegs", "The most option instruments a chain built by the Bridge will price.");
d("market.cache.maxEntries", "How many answers the in-memory cache keeps.");

// ---- stream -----------------------------------------------------------------------------------------------------
d("stream.heartbeatMs", "How often a heartbeat goes to every stream client, in milliseconds.");
d("stream.maxClients", "Open stream connections (WebSocket and server-sent events), all keys together.");
d("stream.maxClientsPerKey", "Open stream connections for one API key.");
d("stream.maxSymbolsPerClient", "Symbols one connection may subscribe to. Beyond it the Bridge answers SUBSCRIPTION_LIMIT.");
d("stream.maxSymbolsPerRequest", "Symbols in one subscribe message or one server-sent-events address.");
d("stream.maxSubscriptionsPerUpstream", "An extra cap on subscriptions per broker feed. When not set the broker's documented limit applies.");
d("stream.staleAfterMs", "A connected feed with no tick for this long is reported as stale, in milliseconds.");
d("stream.staleRebuildAfterMs", "During market hours a feed silent this long is treated as a dead connection and rebuilt, in milliseconds. 0 means never. The wait doubles after each silent rebuild, up to 16 times.");
d("stream.connectTimeoutMs", "A feed that has not reported connected this long after it was built is rebuilt, in milliseconds.");
d("stream.upstreamIdleMs", "Close a broker feed this long after its last subscription went away, in milliseconds.");
d("stream.unsubscribeLingerMs", "Keep a symbol subscribed at the broker this long after the last client left, in milliseconds.");
d("stream.adapterGraceMs", "Let the broker adapter reconnect by itself for this long before the Bridge rebuilds the feed, in milliseconds.");
d("stream.backoff.initialMs", "The first wait before reconnecting a broker feed, in milliseconds. It grows from here.");
d("stream.backoff.maxMs", "The longest wait between reconnect attempts, in milliseconds.");
d("stream.maxQueuedMessages", "Messages other than ticks waiting for one slow client before that client is dropped.");
d("stream.highWaterMarkBytes", "Stop writing to a client while this many bytes are still unsent to it.");
d("stream.maxOpsPerSecond", "Messages per second a client may send to the Bridge on one connection.");

// ---- orders -----------------------------------------------------------------------------------------------------
d("orders.ticketTtlMs", "How long a ticket waits for a person to confirm it, in milliseconds.");
d("orders.confirmTokenTtlMs", "How long a confirmed ticket's single-use token may be used, in milliseconds.");
d("orders.confirmPaperFromMcp", "Orders prepared by an AI assistant need a person's confirmation even when they are paper orders.");
d("orders.liveCallTimeoutMs", "A live order call to the broker that takes longer than this becomes OUTCOME_UNKNOWN, in milliseconds. The Bridge never sends it again by itself.");
d("orders.reconcileIntervalMs", "How often orders with an unknown outcome are looked up in the broker's order book, in milliseconds.");
d("orders.reconcileGiveUpMs", "Stop looking after this long, in milliseconds. The order then stays outcome_unknown: check your broker's own order book.");
d("orders.sliceAboveFreeze", "Split an order above the exchange's freeze quantity into several orders. When false it is refused instead.");
d("orders.maxSlices", "The most orders one sliced order may be split into.");
d("orders.orderRetentionDays", "Days that live order records are kept on disk.");
d("orders.maxOrderLookups", "Paper orders read per account for one listing.");

// ---- paper ------------------------------------------------------------------------------------------------------
d("paper.startingCapital", "Rupees in a new or reset paper account. Demo mode starts with 25 lakh when this is left at its default.");
d("paper.slippageBps", "Market orders that fill without depth fill at the last price plus or minus this many basis points (1 basis point is 0.01 percent).");
d("paper.useDepth", "Fill a market order at the best opposite price when market depth is available.");
d("paper.pollIntervalMs", "Pending paper orders are priced again at least this often even without new ticks, in milliseconds.");
d("paper.squareOff.enabled", "Close open intraday paper positions automatically at the square-off time.");
d("paper.squareOff.time", "The IST time of the intraday square-off.");
d("paper.squareOff.times", "Different square-off times per exchange (NSE, BSE, NFO, BFO, MCX, CDS), as HH:MM. Built-in times for MCX and CDS apply under these.");
d("paper.sessionEnd.time", "Pending DAY orders expire at this IST time. When not set the exchange's session close from the reference data is used.");
d("paper.sessionEnd.times", "Different expiry times per exchange, as HH:MM.");
d("paper.margin.model", "portfolio margins F&O legs together per underlying with an approximate scan, so hedges count. simple margins every leg by itself with the percentages below. Equity always uses the percentages.");
d("paper.margin.intradayEquityPct", "Percentage of order value blocked for intraday equity.");
d("paper.margin.futuresPct", "Percentage of contract value blocked for futures, in the simple model or when no underlying price is known.");
d("paper.margin.optionSellPct", "Percentage of strike times quantity blocked for option writing, in the simple model or when no underlying price is known. Option buys block the premium.");
d("paper.brokerage.perOrder", "A flat charge in rupees per filled paper order.");
d("paper.brokerage.pct", "A percentage of turnover charged per filled paper order.");
d("paper.brokerage.maxPerOrder", "A cap in rupees on the charge per filled order. null means no cap.");
d("paper.historyLimit", "Finished orders and trades kept per paper account. Pending orders are always kept.");

// ---- readiness --------------------------------------------------------------------------------------------------
d("readiness.enabled", "Run the trading-readiness checks.");
d("readiness.intervalMinutes", "Minutes between continuous checks inside the window on trading days.");
d("readiness.window.from", "IST time the continuous checks start. It must be before the end time.");
d("readiness.window.to", "IST time the continuous checks stop.");
d("readiness.preOpenAt", "IST time of the pre-open check of every live account. It must lie inside the window.");
d("readiness.probe.enabled", "Make one cheap read call to each live account's broker to prove the session works.");
d("readiness.probe.timeoutMs", "How long that read may take before it counts as failed, in milliseconds.");
d("readiness.probe.cooldownSeconds", "The least time between two probes of one account, in seconds.");
d("readiness.probe.endpointClass", "Which kind of read the probe uses: portfolio, other or quote.");
d("readiness.egressIp.mode", "off makes no outside call. lookup asks the service at lookupUrl for this computer's public address and compares it with the registered one. manual records the address you state in manualIp and can never notice a change.");
d("readiness.egressIp.lookupUrl", "The https address of an IPv4-only address-echo service you choose. That service sees your IP every time. Needed when mode is lookup.");
d("readiness.egressIp.manualIp", "The address you state this computer uses. Needed when mode is manual.");
d("readiness.egressIp.timeoutMs", "How long the lookup may take, in milliseconds.");
d("readiness.egressIp.maxSkewMs", "The clock difference, in milliseconds, above which the readiness card warns that this computer's clock is off.");
d("readiness.gateAutomated", "Refuse automated live orders (alerts) with CANNOT_TRADE while their account cannot trade. false turns the refusal into a warning.");
d("readiness.staleAfterMinutes", "A reading older than this is shown as not checked recently.");
d("readiness.warn.sessionExpiresWithinMinutes", "Warn when a broker session ends within this many minutes.");
d("readiness.warn.dailyOrdersLeftPct", "Warn when this percentage or less of the daily order count is left.");
d("readiness.warn.dailyLossLeftPct", "Warn when this percentage or less of the daily loss limit is left.");
d("readiness.notify.cooldownMinutes", "The least time between two notifications about the same problem.");
d("readiness.notify.onRecovery", "Notify when an account that could not trade is ready again.");
d("readiness.notify.preopenOnlyIfFailing", "Send the pre-open notification only when something is failing.");

// ---- integrations -----------------------------------------------------------------------------------------------
d("integrations.xl.chainFormat", "The format of /xl/chain answers: csv or json.");
d("integrations.xl.historyLayout", "The column layout of /xl/history: standard or amibroker.");
d("integrations.xl.defaultCountback", "Bars /xl/history returns when the request gives neither a from date nor a countback.");
d("integrations.xl.maxSymbols", "The most symbols one /xl/quotes or /xl/instrument request may list.");
d("integrations.xl.cacheSeconds", "The max-age sent, in seconds, when a caller opts in with ?cache=1.");

// ---- hooks ------------------------------------------------------------------------------------------------------
d("hooks.queueSize", "Alerts waiting to be processed. A full queue answers 429.");
d("hooks.concurrency", "Alerts processed at the same time. Orders are still capped by the safety order rate.");
d("hooks.dedupeWindowMs", "The same alert seen again inside this window is acknowledged as a duplicate, in milliseconds.");
d("hooks.signatureToleranceS", "For signed generic hooks: how many seconds the signed timestamp may differ from this computer's clock.");
d("hooks.maxSignalsPerMinute", "Alerts per minute per hook that pass every check. More are held for up to rateWaitSec.");
d("hooks.maxHooks", "The most hooks you may create.");
d("hooks.allowSourceIps", "A list of addresses or IPv4 blocks added to every hook's own list of allowed senders.");
d("hooks.clientIpHeader", "The header that carries the sender's address behind a local tunnel (cf-connecting-ip, x-forwarded-for or x-real-ip). It is trusted only when the connection itself comes from this computer.");
d("hooks.burstWaitSec", "An alert that meets the per-account order-rate cap waits up to this many seconds for a free slot, then is reported as rejected. 0 turns waiting off.");
d("hooks.rateWaitSec", "An alert over maxSignalsPerMinute is held up to this many seconds and then handled; past it the answer is 429. 0 means always 429.");
d("hooks.signalsKept", "Recent alerts remembered per hook for the alert history. Kept in memory only.");
d("hooks.presets.tradingview.ips", "The addresses TradingView sends alerts from, used when a hook switches on the tradingview address list. Edit it when TradingView changes its list. Needed whenever you give this preset.");
d("hooks.presets.tradingview.verifiedAt", "The date you last checked that list.");
d("hooks.presets.tradingview.source", "Where you checked it.");

// ---- mcp, compat ------------------------------------------------------------------------------------------------
d("mcp.enabled", "Serve the MCP endpoint. false makes POST /mcp answer 404.");
d("mcp.toolsets", "Which groups of tools assistants get: market, analytics, account, orders. Add orders to let assistants prepare orders (a person still confirms each one).");
d("mcp.orderAccounts", "The accounts order tools may name. Empty means no order tools at all, even with orders in toolsets.");
d("mcp.maxItems", "The largest page one tool returns. A cursor fetches the rest.");
d("compat.enabled", "Serve /api/v1.");
d("compat.account", "The account compatibility calls act on. When not set, the first account the key may use.");
d("compat.analyzer", "Start in analyzer mode, which is the Bridge's paper mode. Leaving it only asks for live orders; the Bridge's own live rules still decide.");

// ---- sources ----------------------------------------------------------------------------------------------------
d("sources.autoFallback", "Let reads no broker can answer fall back to an enabled free source. The answer is labelled delayed or end-of-day.");
d("sources.timeoutMs", "How long one call to a source may take, in milliseconds.");
d("sources.providers", "Per-source switches by source id. false keeps a source off whatever the dashboard says. A source may read its own other settings here.");
d("sources.providers.<name>.enabled", "false keeps this source off.");
d("sources.pluginUser.uid", "Run plugins as this user id, so a plugin cannot signal the Bridge. Needs the Bridge to run as root; when not permitted, plugins are not started.");
d("sources.pluginUser.gid", "The group id to run plugins as.");
d("sources.plugins", "Plugins to start. Each entry names a folder, its sha256 and whether you grant it permission to run.");
d("sources.plugins[].path", "The plugin folder.");
d("sources.plugins[].sha256", "The 64-character checksum of the plugin, printed by mc-bridge sources plugins pin. A plugin that does not match does not run.");
d("sources.plugins[].granted", "true says you read the plugin and allow it to run.");
d("sources.plugins[].config", "The plugin's own settings. Never put a secret here.");

// ---- backup -----------------------------------------------------------------------------------------------------
d("backup.keep", "Automatic copies kept per kind (before an upgrade, before a restore).");
d("backup.maxSizeMb", "Settings and state larger than this are not copied automatically. Downloads and recordings are not counted.");
d("backup.includeData", "Also put downloads and recordings into manual and daily backups. Large. Never in the copy before an upgrade or a restore.");
d("backup.maxDataFiles", "More download and recording files than this and a backup with data is refused with a clear message.");
d("backup.manualKeep", "Manual backups kept in the data folder. Backups made with --out are never removed.");
d("backup.schedule.enabled", "Make a daily backup.");
d("backup.schedule.time", "The time of the daily backup on this computer's clock (HH:MM, 24-hour).");
d("backup.schedule.keep", "Daily backups kept.");
d("backup.schedule.includeSecrets", "Also copy the saved broker logins file. It is useless without the original master key.");

// ---- notify -----------------------------------------------------------------------------------------------------
d("notify.enabled", "Send phone messages.");
d("notify.events", "Switch single events on or off by name, for example { \"order.placed\": true }. Unknown names are refused.");
d("notify.quietHours.enabled", "Hold non-critical messages during quiet hours.");
d("notify.quietHours.start", "IST time quiet hours start.");
d("notify.quietHours.end", "IST time quiet hours end.");
d("notify.morning.enabled", "Send the morning message about accounts that are not logged in.");
d("notify.morning.at", "IST time of the morning message. The event for your own programs has its own time, morningLogin.remindAt.");
d("notify.morning.secondAt", "IST time of the second nudge at the open.");
d("notify.morning.endOfDay.enabled", "Send an end-of-day summary.");
d("notify.morning.endOfDay.at", "IST time of the end-of-day summary.");
d("notify.coalesceSeconds", "Similar messages arriving within this many seconds are combined into one.");
d("notify.dedupeSeconds", "An identical message inside this window is dropped.");
d("notify.rateLimitAlert.threshold", "Send a rate-limit warning after this many refusals inside the window.");
d("notify.rateLimitAlert.windowMinutes", "The window, in minutes, for that count.");
d("notify.pacing.perChatMs", "The least time between two messages to one chat, in milliseconds.");
d("notify.pacing.perSecond", "Messages per second for the whole bot.");
d("notify.pacing.groupPerMinute", "Messages per minute to one group chat.");
d("notify.retry.maxAttempts", "Times a failed message is tried.");
d("notify.retry.baseMs", "The first wait before a retry, in milliseconds. It grows from here.");
d("notify.retry.maxMs", "The longest wait between retries, in milliseconds.");
d("notify.retry.maxAgeMinutes", "A message older than this is dropped instead of sent late.");
d("notify.queue.max", "Messages waiting to be sent. When it is full the oldest message that is not critical is dropped.");
d("notify.inbound.enabled", "Answer commands sent to the bot (read-only prices and status).");
d("notify.inbound.commandsPerMinute", "Commands per minute the bot answers.");
d("notify.inbound.pollSeconds", "How long one wait for new commands lasts, in seconds.");
d("notify.inbound.allowKill", "Let the bot engage the kill switch after a one-time code. Releasing it is never possible from Telegram.");
d("notify.inbound.maxCommandAgeSeconds", "A command older than this is ignored, so a message that waited while the Bridge was off does not run later.");

// ---- library ----------------------------------------------------------------------------------------------------
d("library.enabled", "Switch collections on. false makes every use answer a plain error.");
d("library.maxCollections", "How many collections the store holds.");
d("library.maxSymbols", "The most symbols a collection may hold or resolve to.");
d("library.maxWeeklyExpiries", "How many weekly expiries all-weekly stops at.");
d("library.allowStaleAtm", "Let a labelled stale, delayed or end-of-day price be the default basis of an at-the-money strike for callers that do not say. A spreadsheet request always says no.");
d("library.strikeSteps", "The strike step of an index, by underlying name, used only when no listed strikes are known. Built in: NIFTY 50, BANKNIFTY 100, FINNIFTY 50, MIDCPNIFTY 25, SENSEX 100, BANKEX 100. A stock's step is never guessed.");

// ---- events -----------------------------------------------------------------------------------------------------
d("events.enabled", "Serve the event stream and keep the event log.");
d("events.retain", "Events kept for replay, in memory and on disk. They survive a restart.");
d("events.maxEventBytes", "One event's data above this size is replaced by a short note.");
d("events.heartbeatMs", "How often a heartbeat goes to event readers, in milliseconds.");
d("events.maxClients", "Open event connections, all keys together.");
d("events.maxClientsPerKey", "Open event connections for one key.");
d("events.maxBufferedBytes", "A reader this far behind is closed. It reconnects with its cursor.");
d("events.webhooks.enabled", "Allow signed outbound webhooks.");
d("events.webhooks.maxSubscriptions", "The most webhook subscriptions.");
d("events.webhooks.allowPrivateTargets", "Allow http:// and addresses on this computer or your home network as targets. Cloud metadata addresses are refused even then. Same as mc-bridge subscriptions allow-local.");
d("events.webhooks.allowedHosts", "When not empty, a target host must match one entry (example.com or *.example.com).");
d("events.webhooks.timeoutMs", "How long a delivery may take, in milliseconds.");
d("events.webhooks.maxResponseBytes", "How much of a receiver's answer is read, in bytes.");
d("events.webhooks.concurrency", "Deliveries running at once, all subscriptions together.");
d("events.webhooks.perSubscription", "Deliveries running at once for one subscription, so a receiver that never answers holds only its own slots.");
d("events.webhooks.breakerAfter", "After this many failures in a row a subscription gets one attempt per back-off period.");
d("events.webhooks.replayWindowSec", "The age in seconds that receivers are told to accept; also sent in a header.");
d("events.webhooks.retry.maxAttempts", "Attempts per delivery before it becomes a dead letter.");
d("events.webhooks.retry.baseMs", "The first wait before a retry, in milliseconds. It grows from here.");
d("events.webhooks.retry.maxMs", "The longest wait between retries, in milliseconds.");
d("events.webhooks.retry.jitter", "Random variation of each wait, as a fraction (0.2 is 20 percent).");
d("events.webhooks.retry.maxAgeSec", "A delivery older than this stops being retried, in seconds.");
d("events.webhooks.maxPendingPerSubscription", "Deliveries waiting for one subscription. More are dropped.");
d("events.webhooks.deadLetterMax", "Dead letters kept per subscription.");
d("events.webhooks.deliveryLogMax", "Delivery log entries kept per subscription.");

// ---- downloads --------------------------------------------------------------------------------------------------
d("downloads.enabled", "Switch downloads off completely with false: every route answers CAPABILITY_UNSUPPORTED and nothing runs.");
d("downloads.maxConcurrentJobs", "Jobs that run at the same time. They still share one budget share per account.");
d("downloads.maxSymbolsPerJob", "The most symbols in one job. The hard limit is 500.");
d("downloads.retentionDays", "Delete finished jobs and their files after this many days. null keeps them until you delete them. Datasets are never deleted by this.");
d("downloads.maxDiskMb", "Writing stops when the downloads folder reaches this size, in megabytes.");
d("downloads.minFreeDiskMb", "A job pauses while the disk has less than this free, in megabytes. 0 switches the check off.");
d("downloads.maxQueuedJobs", "Jobs waiting, running or paused at once, all keys together. A new job over this is refused.");
d("downloads.maxQueuedJobsPerKey", "The same limit for the jobs started by one key.");
d("downloads.maxStoredJobs", "Jobs kept in all, finished ones too. Delete old jobs or set retentionDays when it is reached.");
d("downloads.pauseOnKeyRevoked", "Pause a key's open jobs when the key is revoked.");
d("downloads.maxBudgetShare", "The share of an account's spare request budget that downloads may use. A live read, an order check or another key always goes first. This is the default; PATCH /v1/downloads/settings changes it while the Bridge runs.");
d("downloads.afterHoursOnly", "Run only outside market hours. A job started during the session waits.");
d("downloads.localFirst", "Serve ranges already stored in a dataset from disk and fetch only the missing parts.");
d("downloads.retries", "Times one broker call is tried again after a temporary error before the item fails.");
d("downloads.progressThrottleMs", "How often a running job reports download.progress, in milliseconds.");

// ---- recorder ---------------------------------------------------------------------------------------------------
d("recorder.enabled", "Switch the recorder off completely with false.");
d("recorder.maxRecordings", "Recordings running, paused or waiting at one time. Rules count too.");
d("recorder.maxDiskMb", "All recordings together, in megabytes. Writing stops at the limit and never goes beyond it.");
d("recorder.retentionDays", "Delete day files older than this many days. null keeps everything.");
d("recorder.compressFinished", "Compress the files of finished days with gzip.");
d("recorder.minFreeDiskMb", "Stop writing when the disk has less than this free, in megabytes.");
d("recorder.maxBudgetShare", "The share of an account's spare request budget a recording may use when it needs the broker. This is the default; PATCH /v1/recordings/settings changes it while the Bridge runs.");
d("recorder.maxSymbolsPerRecording", "The most symbols one recording may hold.");
d("recorder.maxStreamSymbols", "How many symbols one recording asks the live feed for.");
d("recorder.gapAfterSec", "Silence longer than this inside a session is logged as a gap, in seconds. null means three times the interval, at least 30.");
d("recorder.reResolveMinutes", "A moving universe (an ATM window) is worked out again this often inside the session, in minutes. 0 means once a day.");
d("recorder.autoRecord.enabled", "Record by itself every trading day from the rules. Off until a person turns it on. The switch you set in the dashboard or with mc-bridge record auto is stored in the data folder and wins over this value.");
d("recorder.autoRecord.rules", "Rules kept in the config file. Rules made in the dashboard or the API live in the data folder instead.");
d("recorder.autoRecord.rules[].id", "A short name for the rule. Made from the name when not given.");
d("recorder.autoRecord.rules[].name", "The rule's name.");
d("recorder.autoRecord.rules[].enabled", "Turn the rule off without deleting it.");
d("recorder.autoRecord.rules[].kind", "quotes records prices; chain records option-chain snapshots.");
d("recorder.autoRecord.rules[].symbols", "The symbols to record. Give exactly one of symbols, collection or underlying.");
d("recorder.autoRecord.rules[].collection", "The name of a collection to record. Worked out again every day.");
d("recorder.autoRecord.rules[].underlying", "One underlying such as NIFTY, or a list of them, with the universe below.");
d("recorder.autoRecord.rules[].universe.expiries", "current-weekly, next-weekly, current-monthly, all-weekly, or a list of dates.");
d("recorder.autoRecord.rules[].universe.strikes", "{ around: \"atm\", count: 10 } or { from, to }.");
d("recorder.autoRecord.rules[].universe.sides", "CE, PE or both.");
d("recorder.autoRecord.rules[].universe.includeUnderlying", "Also record the underlying itself.");
d("recorder.autoRecord.rules[].universe.includeFuture", "Also record the future of the chosen expiry month.");
d("recorder.autoRecord.rules[].everySec", "Seconds between samples. At least 15 for a chain.");
d("recorder.autoRecord.rules[].schedule", "market-hours (trading days from the calendar) or { days, start, end } in IST.");
d("recorder.autoRecord.rules[].keepDays", "Keep only this many days of this rule's files.");
d("recorder.autoRecord.rules[].maxDiskMb", "A disk limit for this rule alone, in megabytes.");
d("recorder.autoRecord.rules[].compress", "Compress this rule's finished days.");
d("recorder.autoRecord.rules[].format", "csv or jsonl.");

// ---- storage ----------------------------------------------------------------------------------------------------
d("storage.minFreeMb", "Free space below this makes health say degraded and the Bridge warn, in megabytes.");
d("storage.hardFreeMb", "Free space below this pauses downloads, starts no new download and makes readiness say not ready, in megabytes. It must not be more than minFreeMb.");
d("storage.checkIntervalSec", "How often the free space is measured, in seconds.");

/** @type {Readonly<Record<string, string>>} */
export const DESCRIPTIONS = Object.freeze(D);
