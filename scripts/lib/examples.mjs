/**
 * Example requests for every operation: the values the collections and the per-endpoint pages show.
 *
 * Rules: paper account and paper mode in anything that places an order, well-known symbols, placeholders (never a
 * real key, token, secret or account id) wherever a value only you know goes.
 *
 * A request body comes from, in this order: the example written in docs/openapi.yaml (`requestBody.content.*.example`),
 * the table below, else the request schema (required fields only, openapi-model.mjs). The spec examples are the ones
 * Swagger and Redoc show too; scripts/examples.bodies.test.mjs checks that every body validates against its schema and
 * that the ones a demo Bridge can run are accepted.
 *
 * The collections chain calls with variables: a request that creates something stores its id (CAPTURES), and the
 * requests that need that id read it, so create-then-use works without copying ids by hand.
 */
import { HINTS, deref, sample } from "./openapi-model.mjs";

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
  cancelAllOrders: { account: "demo-paper", mode: "paper" },
  modifyOrder: { price: 1450 },
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
  compatPlacesmartorder: COMPAT({ strategy: "my-script", symbol: "RELIANCE", exchange: "NSE", action: "BUY", product: "CNC", pricetype: "MARKET", position_size: 1 }),
  compatBasketorder: COMPAT({ strategy: "my-script", orders: [{ symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 1, pricetype: "MARKET", product: "CNC" }] }),
  compatSplitorder: COMPAT({ strategy: "my-script", symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 5, splitsize: 2, pricetype: "MARKET", product: "CNC" }),
  compatModifyorder: COMPAT({ orderid: "<orderId>", quantity: 1, price: 1450, pricetype: "LIMIT" }),
  compatCancelallorder: COMPAT({}),
  compatCloseposition: COMPAT({}),
  compatOpenposition: COMPAT({ symbol: "RELIANCE", exchange: "NSE", product: "CNC" }),
  compatOptionsorder: COMPAT({ strategy: "my-script", underlying: "NIFTY", exchange: "NSE_INDEX", offset: "ATM", option_type: "CE", action: "BUY", quantity: 75, pricetype: "MARKET", product: "MIS" }),
  compatOptionsymbol: COMPAT({ underlying: "NIFTY", exchange: "NSE_INDEX", offset: "ATM", option_type: "CE" }),
  compatIntervals: COMPAT({}),
  compatMargin: COMPAT({}),
  compatSymbol: COMPAT({ symbol: "RELIANCE", exchange: "NSE" }),
  compatSearch: COMPAT({ query: "RELIANCE", exchange: "NSE" }),
  compatExpiry: COMPAT({ symbol: "NIFTY", exchange: "NFO" }),
  compatOptionchain: COMPAT({ underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: "24NOV26" }),
});

/**
 * What a request stores for later ones, by operationId: variable name -> where it is in the JSON answer.
 * Postman writes a test script with `pm.collectionVariables.set`; Bruno a `vars:post-response` block.
 */
export const CAPTURES = Object.freeze({
  getExpiries: { expiry: "data.expiries[0]" },
  placeOrder: { orderId: "data.orderId" },
  createKey: { keyId: "data.record.id" },
  createHook: { hookId: "data.id" },
  createDownload: { downloadId: "data.id" },
  createRecording: { recordingId: "data.id" },
  createRecordingRule: { ruleId: "data.id" },
  createSubscription: { subscriptionId: "data.id" },
});
/** Collection variables, with the value they hold until a request stores a real one. */
export const VARIABLES = Object.freeze({
  expiry: HINTS.expiry,
  orderId: "<orderId>",
  keyId: "<keyId>",
  hookId: "<hookId>",
  downloadId: "<downloadId>",
  recordingId: "<recordingId>",
  ruleId: "<ruleId>",
  subscriptionId: "<subscriptionId>",
});

/** Path values for operations whose `name` is not the collection name. */
const NAME_VALUES = Object.freeze({
  getDataset: "large-caps-1d",
  updateDatasetInfo: "large-caps-1d",
  updateDataset: "large-caps-1d",
  deleteDataset: "large-caps-1d",
  getDownloadFile: "NSE_RELIANCE_1d.csv",
});

/** Optional query parameters worth sending in the example (everything else is listed, switched off, in collections). */
export const QUERY_EXTRAS = Object.freeze({
  getHistory: { countback: 50 },
  getOptionChain: { strikes: 5 },
  xlQuotes: { symbols: "NSE:RELIANCE,NSE:NIFTY" },
  xlChain: { format: "csv" },
  xlHistory: { layout: "standard" },
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
  const pathParams = op.parameters
    .filter((p) => p.in === "path")
    .map((p) => {
      const named = p.name === "name" ? (NAME_VALUES[op.id] ?? "large-caps") : undefined;
      return { name: p.name, value: named ?? String(sample(spec, p.schema, p.name) ?? HINTS[p.name] ?? `<${p.name}>`), var: Object.hasOwn(VARIABLES, p.name) ? p.name : null };
    });
  let path = op.path;
  for (const p of pathParams) path = path.replace(`{${p.name}}`, p.value);
  const extras = QUERY_EXTRAS[op.id] ?? {};
  const query = op.parameters
    .filter((p) => p.in === "query")
    .map((p) => {
      const has = Object.hasOwn(extras, p.name);
      return { name: p.name, value: has ? String(extras[p.name]) : qvalue(spec, p), required: p.required, description: p.description, enabled: p.required || has, var: p.name === "expiry" ? "expiry" : null };
    });
  const headers = op.parameters.filter((p) => p.in === "header" && (p.required || p.name === "Idempotency-Key")).map((p) => ({ name: p.name, value: HEADER_VALUES[p.name] ?? String(sample(spec, p.schema, p.name)) }));
  let body = null;
  let bodyText = null;
  let contentType = null;
  if (op.requestBody) {
    contentType = op.requestBody.contentType;
    body = op.requestBody.example !== undefined ? op.requestBody.example : Object.hasOwn(BODIES, op.id) ? BODIES[op.id] : sample(spec, op.requestBody.schema);
    if (op.bodyKey && body && typeof body === "object") body = { ...body, apikey: "{{apiKey}}" };
    bodyText = JSON.stringify(body, null, 2);
  }
  return { path, pathParams, query, headers, body, bodyText, contentType };
}

/** The same example as a query string with only the enabled parameters. `vars: true` writes `{{name}}` for a parameter a variable fills (collections). */
export const queryString = (ex, { vars = false } = {}) => ex.query.filter((q) => q.enabled).map((q) => `${q.name}=${vars && q.var ? `{{${q.var}}}` : q.value}`).join("&");

export { deref };
