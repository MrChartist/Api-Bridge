// Realistic response bodies for the Sources page (shapes from the build plan). Used by sources-core.test.mjs and by the
// local fake server that serves the page for browser checks. Never imported by the dashboard itself.
// No real credentials, accounts or people: ids are made up.

/** One account of GET /v1/usage. `windows` per class are [second, minute]; `calls` is callsToday. */
export function usageAccount({ id = "dhan-main", broker = "dhan", healthy = true, quote = [3, 10, 70, 600], history = [0, 1, 0, 60], order = [0, 25, 0, 250], calls = { quote: 4120, history: 88, order: 12 }, backoffMs = 0, inFlight = 0, queued = 0 } = {}) {
  const cls = (name, [s, sLimit, m, mLimit], callsToday, extra = {}) => ({
    used: s,
    limit: sLimit,
    queued: 0,
    resetMs: 700,
    window: "1s",
    backoffMs: extra.backoffMs ?? 0,
    callsToday,
    coalescedToday: 0,
    throttledToday: extra.throttled ?? 0,
    refusedToday: extra.refused ?? 0,
    windows: [
      { bucket: `class:${name}`, window: "1s", used: s, limit: sLimit, resetMs: 700 },
      { bucket: `class:${name}`, window: "1m", used: m, limit: mLimit, resetMs: 41_000 },
    ],
  });
  return {
    accountId: id,
    broker,
    healthy,
    inFlight,
    queued,
    classes: {
      quote: cls("quote", quote, calls.quote, { backoffMs }),
      history: cls("history", history, calls.history),
      order: cls("order", order, calls.order),
    },
  };
}

export function usage(accounts = [usageAccount(), usageAccount({ id: "zerodha-main", broker: "zerodha", quote: [0, 1, 12, 60], calls: { quote: 900, history: 40, order: 0 } })]) {
  return {
    accounts,
    savings: { servedFromStream: 5230, servedFromCache: 1810, coalesced: 640, batched: 320, since: "2026-11-09T00:00:00+05:30" },
    consumers: [
      { name: "Trading bot", calls: 3120, saved: 900 },
      { name: "Excel workbook", calls: 1440, saved: 300 },
      { name: "Dashboard", calls: 410, saved: 800 },
    ],
    generatedAt: "2026-11-09T09:45:00+05:30",
  };
}

/** One row of GET /v1/sources. */
export function source(over = {}) {
  return {
    id: "demo-delayed",
    name: "Delayed sample feed",
    kind: "free",
    tier: "opt-in",
    enabled: false,
    configured: true,
    class: "delayed",
    delaySec: 900,
    official: false,
    capabilities: ["quotes", "history"],
    limits: { perMinute: 30, perDay: 1000 },
    usage: { lastMinute: 0, today: 0 },
    health: { state: "ok", errorRate: 0, p50Ms: 180, lastError: null, nextTryAt: null },
    terms: { url: "https://example.com/terms", note: "Sample data for the demo. It is unofficial and fifteen minutes behind." },
    noticeVersion: "demo-1",
    needsKey: false,
    consent: null,
    ...over,
  };
}

export function sources() {
  return [
    source({ id: "demo", name: "Demo broker", kind: "broker", tier: "builtin", enabled: true, class: "realtime", delaySec: 0, official: true, capabilities: ["quotes", "history", "expiries", "optionChain"], limits: { perSecond: 10, perMinute: 400 }, usage: { lastMinute: 36, today: 420 }, terms: undefined, noticeVersion: undefined }),
    source({ id: "demo-delayed", enabled: true, consent: { acceptedAt: "2026-11-09T09:30:00+05:30", noticeVersion: "demo-1" }, usage: { lastMinute: 22, today: 260 } }),
    source({ id: "demo-eod", name: "End-of-day sample feed", tier: "byok", class: "eod", delaySec: null, official: true, capabilities: ["history"], limits: { perMinute: 5, perDay: 25 }, needsKey: true, configured: false, noticeVersion: undefined, terms: { url: "https://example.com/vendor-terms", note: "You use your own account with this vendor and accept its terms. The free plan allows 25 calls a day." } }),
    source({ id: "yahoo", name: "Yahoo Finance", tier: "opt-in", class: "delayed", delaySec: 900, official: false, capabilities: ["quotes", "history"], limits: { perMinute: 20, perDay: 2000 }, terms: { url: "https://example.com/yahoo-terms", note: "Unofficial. The vendor's terms forbid automated access, so you use it at your own risk." }, noticeVersion: "yahoo-1" }),
    source({ id: "ext-plugin", name: "Sample plugin", kind: "plugin", tier: "plugin", class: "eod", delaySec: null, official: false, capabilities: ["history"], limits: { perMinute: 10 }, terms: { url: "https://example.com/plugin", note: "Runs as a separate program that you approved on this computer." }, noticeVersion: undefined }),
  ];
}

export function requests(now = Date.parse("2026-11-09T09:45:00+05:30")) {
  const at = (s) => new Date(now - s * 1000).toISOString();
  return [
    { at: at(3), method: "GET", path: "/v1/ltp", status: 200, ms: 84, keyId: "key_bot", client: null, requestId: "req_a1", route: { from: "stream", source: "dhan-main", sourceName: "Dhan", class: "realtime", delaySec: 0 } },
    { at: at(7), method: "GET", path: "/v1/quotes", status: 200, ms: 31, keyId: "key_excel", client: null, requestId: "req_a2", route: { from: "cache", source: "dhan-main", sourceName: "Dhan", class: "realtime", delaySec: 0 } },
    { at: at(11), method: "GET", path: "/v1/history", status: 200, ms: 612, keyId: "key_bot", client: null, requestId: "req_a3", route: { from: "live", source: "demo-delayed", sourceName: "Yahoo", class: "delayed", delaySec: 900 } },
    { at: at(19), method: "GET", path: "/v1/ltp", status: 429, ms: 12, keyId: "key_excel", client: null, requestId: "req_a4" },
    { at: at(25), method: "GET", path: "/v1/optionchain", status: 200, ms: 240, keyId: "key_bot", client: null, requestId: "req_a5" },
    { at: at(30), method: "GET", path: "/v1/accounts", status: 200, ms: 5, keyId: null, client: "dashboard", requestId: "req_a6" },
  ];
}

export function quotas() {
  return {
    default: { perSecond: 10, burst: 20 },
    kinds: { ui: 4, mcp: 2, excel: 2, script: 1, other: 1 },
    keys: [
      { keyId: "key_bot", label: "Trading bot", clientKind: "script", weight: 1, perSecond: 10, burst: 20, perDay: null, usage: { lastMinute: 412, today: 5120, throttledToday: 3 }, source: "default" },
      { keyId: "key_excel", label: "Excel workbook", clientKind: "excel", weight: 2, perSecond: 5, burst: 10, perDay: 20000, usage: { lastMinute: 38, today: 18400, throttledToday: 41 }, source: "override" },
      { keyId: "key_ai", label: "Claude assistant", clientKind: "mcp", weight: 2, perSecond: 10, burst: 20, perDay: null, usage: { lastMinute: 4, today: 160, throttledToday: 0 }, source: "default" },
      { keyId: "key_dash", label: "Dashboard", clientKind: "ui", weight: 4, perSecond: 10, burst: 20, perDay: null, usage: { lastMinute: 6, today: 410, throttledToday: 0 }, source: "default" },
    ],
  };
}

export function pooling({ on = false } = {}) {
  return {
    consent: on ? { acceptedAt: "2026-11-09T09:00:00+05:30", version: "pool-1", accounts: ["dhan-main", "zerodha-main"] } : null,
    groups: [
      {
        holder: "Your accounts",
        accounts: [
          { id: "dhan-main", label: "Dhan (main)", broker: "dhan", poolingPolicy: "unknown", inPool: on },
          { id: "zerodha-main", label: "Zerodha (family)", broker: "zerodha", poolingPolicy: "unknown", inPool: on },
          { id: "angel-main", broker: "angelone", poolingPolicy: "not-allowed", inPool: false },
        ],
      },
    ],
    notice: {
      version: "pool-1",
      text: "Pooling spreads read-only market-data calls across your own broker accounts, so each one has more room. No broker's published terms clearly allow or forbid this. You accept that your brokers may treat it differently from what you expect. Orders never move between accounts: every order goes through the account it belongs to.",
    },
  };
}

/** A TraceResult for GET /v1/sources/trace. */
export function trace({ chosen = "dhan-main" } = {}) {
  return {
    request: { capability: "quotes", symbols: ["NSE:RELIANCE"], purpose: "display" },
    considered: [
      { id: "dhan-main", kind: "broker", verdict: chosen === "dhan-main" ? "chosen" : "skipped", reason: chosen === "dhan-main" ? "best-score" : "no-spare-budget", score: 0.82, spareBudget: 0.88, health: { state: "ok" } },
      { id: "zerodha-main", kind: "broker", verdict: "fallback", reason: "Next in line if the first choice fails", score: 0.7, spareBudget: 0.4, health: { state: "ok" } },
      { id: "demo-delayed", kind: "source", verdict: "skipped", reason: "Its data is 15 minutes behind and this call asked for a fresh price", health: { state: "ok" } },
      { id: "yahoo", kind: "source", verdict: "skipped", reason: "disabled", health: { state: "disabled" } },
    ],
    class: "realtime",
    note: "Real-time sources are preferred for quotes.",
  };
}
