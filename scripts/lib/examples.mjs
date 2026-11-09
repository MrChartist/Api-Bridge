/**
 * Example requests for every operation: the values the collections and the per-endpoint pages show.
 *
 * Rules: paper account and paper mode in anything that places an order, well-known symbols, placeholders (never a
 * real key, token, secret or account id) wherever a value only you know goes. Bodies not listed here are built from
 * the request schema (required fields only) by openapi-model.mjs.
 */
import { HINTS, deref, sample } from "./openapi-model.mjs";

const ORDER = Object.freeze({ account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET", mode: "paper" });
const COMPAT = (extra) => ({ apikey: "{{apiKey}}", ...extra });

/** Request bodies by operationId. `{{apiKey}}` is a collection variable, replaced by the key in your shell in curl. */
export const BODIES = Object.freeze({
  addAccount: { broker: "paper", id: "paper-2", label: "Second paper account" },
  connectAccount: { values: { apiKey: "<broker api key>", clientId: "<client id>" } },
  createKey: { label: "my-script", scopes: ["read", "paper"], accounts: "*", clientKind: "script" },
  signIn: { code: "<one-time code from mc-bridge open>" },
  updateSource: { enabled: false },
  configureSource: { apiKey: "<source api key>" },
  acceptPooling: { acknowledge: "<notice version from GET /v1/pooling>", accounts: ["demo-paper"] },
  setQuota: { perSecond: 5, burst: 10 },
  convertPosition: { account: "demo-paper", symbol: "NSE:RELIANCE", from: "INTRADAY", to: "CNC" },
  placeOrder: ORDER,
  previewOrder: ORDER,
  cancelAllOrders: { account: "demo-paper", mode: "paper" },
  modifyOrder: { price: 1400 },
  rejectTicket: { reason: "Not the order I meant" },
  resetPaperAccount: { startingCapital: 1000000 },
  paperBasketMargin: { legs: [{ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1 }] },
  engageKillSwitch: { reason: "Stopping for the day" },
  checkReadiness: { account: "demo-paper" },
  receiveHook: { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, orderType: "MARKET", id: "sig-1" },
  createHook: { source: "generic", label: "my alert", account: "demo-paper", mode: "paper" },
  mcp: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  compatPing: COMPAT({}),
  compatFunds: COMPAT({}),
  compatOrderbook: COMPAT({}),
  compatTradebook: COMPAT({}),
  compatPositionbook: COMPAT({}),
  compatHoldings: COMPAT({}),
  compatAnalyzer: COMPAT({}),
  compatAnalyzerToggle: COMPAT({ mode: true }),
  compatPlaceorder: COMPAT({ strategy: "my-script", symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 1, pricetype: "MARKET", product: "CNC" }),
  compatOrderstatus: COMPAT({ orderid: "<orderId>" }),
  compatCancelorder: COMPAT({ orderid: "<orderId>" }),
  compatQuotes: COMPAT({ symbol: "RELIANCE", exchange: "NSE" }),
  compatMultiquotes: COMPAT({ symbols: [{ symbol: "RELIANCE", exchange: "NSE" }, { symbol: "NIFTY", exchange: "NSE_INDEX" }] }),
  compatDepth: COMPAT({ symbol: "RELIANCE", exchange: "NSE" }),
  compatHistory: COMPAT({ symbol: "RELIANCE", exchange: "NSE", interval: "5m", start_date: "2026-11-02", end_date: "2026-11-06" }),
  compatSymbol: COMPAT({ symbol: "RELIANCE", exchange: "NSE" }),
  compatSearch: COMPAT({ query: "RELIANCE", exchange: "NSE" }),
  compatExpiry: COMPAT({ symbol: "NIFTY", exchange: "NFO" }),
  compatOptionchain: COMPAT({ underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: "24NOV26" }),
});

/** Optional query parameters worth sending in the example (everything else is listed, switched off, in collections). */
export const QUERY_EXTRAS = Object.freeze({
  getHistory: { countback: 50 },
  getOptionChain: { strikes: 5 },
  xlChain: { format: "csv" },
  xlHistory: { layout: "rows" },
  listOrders: { limit: 20 },
});

/** Header parameters shown in examples. */
const HEADER_VALUES = Object.freeze({ "Idempotency-Key": "my-order-0001" });

const qvalue = (spec, p) => {
  const v = sample(spec, p.schema, p.name);
  return v === null || v === undefined ? "" : Array.isArray(v) ? v.join(",") : String(v);
};

/**
 * @returns {{ path: string, pathParams: {name: string, value: string}[], query: {name: string, value: string, required: boolean, description: string, enabled: boolean}[],
 *   headers: {name: string, value: string}[], body: any, bodyText: string|null, contentType: string|null }}
 */
export function requestExample(spec, op) {
  const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => ({ name: p.name, value: String(sample(spec, p.schema, p.name) ?? HINTS[p.name] ?? `<${p.name}>`) }));
  let path = op.path;
  for (const p of pathParams) path = path.replace(`{${p.name}}`, p.value);
  const extras = QUERY_EXTRAS[op.id] ?? {};
  const query = op.parameters
    .filter((p) => p.in === "query")
    .map((p) => {
      const has = Object.hasOwn(extras, p.name);
      return { name: p.name, value: has ? String(extras[p.name]) : qvalue(spec, p), required: p.required, description: p.description, enabled: p.required || has };
    });
  const headers = op.parameters.filter((p) => p.in === "header" && (p.required || p.name === "Idempotency-Key")).map((p) => ({ name: p.name, value: HEADER_VALUES[p.name] ?? String(sample(spec, p.schema, p.name)) }));
  let body = null;
  let bodyText = null;
  let contentType = null;
  if (op.requestBody) {
    contentType = op.requestBody.contentType;
    body = Object.hasOwn(BODIES, op.id) ? BODIES[op.id] : sample(spec, op.requestBody.schema);
    if (op.bodyKey && body && typeof body === "object" && !("apikey" in body)) body = { apikey: "{{apiKey}}", ...body };
    bodyText = JSON.stringify(body, null, 2);
  }
  return { path, pathParams, query, headers, body, bodyText, contentType };
}

/** The same example as a query string with only the enabled parameters. */
export const queryString = (ex) => ex.query.filter((q) => q.enabled).map((q) => `${q.name}=${q.value}`).join("&");

export { deref };
