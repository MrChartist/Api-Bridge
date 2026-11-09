/**
 * Order-safety contract cases, run for every broker adapter on top of its recorded fixtures.
 *
 * Real brokers fail in a handful of ways that cost money, and each one is checked here:
 *
 *   missingOrderId  The reply to an order has no order id. It must throw, never come back as a placed order.
 *   garbledReply    The reply is HTML, empty or `{}`. Same rule.
 *   lostReply       The request went out and the answer never came back (reset socket, timeout). The adapter must
 *                   throw after exactly ONE send (no blind retry), and the Bridge must read that as OUTCOME_UNKNOWN,
 *                   which the reconciliation job resolves from the order book.
 *   refusedBody     The broker's own documented refusal (often HTTP 200 with an error body). It must throw.
 *   stopLoss        A stop-loss (SL) and a stop-loss market (SL-M) order must carry the trigger price (and for SL
 *                   the limit price) in the request. Dropping the trigger is the classic silent failure.
 *   sessionExpired  The broker's documented "session ended" reply on an order call must throw an error the Bridge
 *                   treats as a session error (code SESSION_LOGIN_REQUIRED, UPSTREAM_AUTH or SESSION_EXPIRED), so
 *                   the account shows "login needed" instead of a generic failure.
 *
 * missingOrderId, garbledReply, lostReply and the generic stopLoss check are DERIVED from the adapter's recorded
 * place-order sample (the sample reply with the order id removed, and so on). Nothing is invented. refusedBody,
 * sessionExpired and the exact stop-loss field mapping need the broker's own documented payloads, so they come from
 * an optional fixture file, server/brokers/__fixtures__/<id>/orderCases.json, whose bodies must be copied from the
 * broker's official documentation (or a sandbox recording) and carry a `source`. A broker without that file is
 * listed as "needs fixture" in the generated matrix (docs/BROKERS.md) instead of being guessed.
 *
 * orderCases.json:
 *   {
 *     "refusals":       [ { "name", "source", "reply": { "status", "json" | "text", "headers" } } ],
 *     "sessionExpired": { "source", "reply": { ... } },
 *     "stopLoss":       { "source", "order": { adapter-shaped SL order }, "slmOrder": { ... }, "expectBody": { ... }, "slmExpectBody": { ... } },
 *     "cancel":         { "source", "note", "expectUrl" | "expectBody" }       // variety on cancel, where the broker has one
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError, CAPABILITIES, SESSION_ERROR_CODES } from "./contract.mjs";
import { guardAdapterErrors } from "./errorGuard.mjs";
import { issueOrderGate } from "./orderGate.mjs";
import { FIXTURES_ROOT, defaultArgs, methodOf, withStubs } from "./contractHarness.mjs";
import { fromBrokerError } from "../bridge/core/errors.mjs";


export const ORDER_CASES = Object.freeze(["missingOrderId", "garbledReply", "lostReply", "refusedBody", "stopLoss", "cancelVariety", "sessionExpired"]);

/** Result states of one case. "needs-fixture" is a gap, not a failure; "fail" is a real adapter problem. */
export const CASE_STATES = Object.freeze(["pass", "fail", "needs-fixture", "n/a"]);

const clone = (v) => JSON.parse(JSON.stringify(v));
const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/** Load orderCases.json for a broker (null when the broker has none). */
export function loadOrderCases(brokerId, { root = FIXTURES_ROOT } = {}) {
  const file = join(root, brokerId, "orderCases.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
}

function gateFor(adapter, cap) {
  return issueOrderGate({ verdict: { ok: true }, liveArmed: true, action: cap, brokerId: adapter.id });
}

/**
 * Several adapters space their calls on the wall clock (1 request a second and the like), which would make the matrix
 * take minutes. While an order call runs, waits are cut to a millisecond; nothing else about the call changes.
 */
async function withFastWaits(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...rest) => realSetTimeout(cb, Math.min(Number(ms) || 0, 1), ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/** One gated order call against a stubbed network. */
async function callOrder(adapter, cap, creds, args, responses) {
  const fn = adapter[methodOf(adapter, cap)];
  return withFastWaits(() => withStubs(responses, () => fn(creds, ...args, gateFor(adapter, cap))));
}

/** Index of the response the order call itself was answered from: the last write request of the baseline run. */
function sendIndexOf(calls) {
  const writes = calls.filter((c) => WRITE_METHODS.has(c.method) && c.matched >= 0);
  return (writes.length ? writes.at(-1) : calls.filter((c) => c.matched >= 0).at(-1))?.matched ?? -1;
}

/** Remove every property whose value is `id` (as text) from a JSON value. Returns the number of removals. */
function stripId(node, id) {
  let n = 0;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (node[i] !== null && typeof node[i] === "object") n += stripId(node[i], id);
      else if (String(node[i]) === id) { node.splice(i, 1); n++; }
    }
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (node[k] !== null && typeof node[k] === "object") n += stripId(node[k], id);
      else if (String(node[k]) === id) { delete node[k]; n++; }
    }
  }
  return n;
}

const withReply = (responses, idx, reply) => responses.map((r, i) => {
  if (i !== idx) return r;
  const { json, text, status, headers, networkError, ...rest } = r; // eslint-disable-line no-unused-vars
  return { ...rest, ...reply };
});

const result = (state, problems = [], detail = "") => ({ state, problems, detail });
const sends = (calls, idx) => calls.filter((c) => c.matched === idx).length;

/** What the Bridge would do with this error on a live WRITE (fromBrokerError with write: true). */
export function bridgeCodeOfWrite(err) {
  return fromBrokerError(err, { brokerId: "x", write: true }).code;
}

/** Shared assertions after an order call that must have been REFUSED by the adapter. */
function mustThrowOnce(label, r, sendIdx, { unknown = false } = {}) {
  const problems = [];
  if (!r.error) {
    problems.push(`${label}: resolved as ${JSON.stringify(r.value)} instead of throwing`);
    return problems;
  }
  if (sendIdx >= 0 && sends(r.calls, sendIdx) !== 1) problems.push(`${label}: the order request was sent ${sends(r.calls, sendIdx)} times (must be exactly once)`);
  // The answer says nothing about whether the order went out, so the Bridge must read it as OUTCOME_UNKNOWN (checked in
  // the order book later), not as a refusal the user could safely retry.
  if (unknown) {
    const code = bridgeCodeOfWrite(r.error);
    if (code !== "OUTCOME_UNKNOWN") problems.push(`${label}: the Bridge would read this as ${code}, not OUTCOME_UNKNOWN (error code ${r.error?.code ?? "none"})`);
  }
  if (/unexpected network call/.test(String(r.error.message))) problems.push(`${label}: the adapter made a request the fixture does not describe (${String(r.error.message).slice(0, 120)})`);
  return problems;
}

/**
 * Derived cases for placeOrder from the recorded sample.
 * @returns {Record<string, { state: string, problems: string[], detail: string }>}
 */
export async function runDerivedPlaceCases(adapter, fx, creds, args) {
  const out = {};
  const base = await callOrder(adapter, "placeOrder", creds, args, fx.responses);
  if (base.error || !base.value?.orderId) {
    const why = base.error ? base.error.message : "no order id in the recorded sample";
    for (const c of ["missingOrderId", "garbledReply", "lostReply"]) out[c] = result("fail", [`baseline place failed: ${why}`]);
    return out;
  }
  const sendIdx = sendIndexOf(base.calls);
  const id = String(base.value.orderId);
  const sendReply = fx.responses[sendIdx];

  // (1) the reply without its order id
  if (sendReply?.json !== undefined) {
    const json = clone(sendReply.json);
    const removed = stripId(json, id);
    if (removed === 0) out.missingOrderId = result("n/a", [], "the order id is not a plain field of the sample reply");
    else {
      const r = await callOrder(adapter, "placeOrder", creds, args, withReply(fx.responses, sendIdx, { json }));
      out.missingOrderId = result("pass", mustThrowOnce("a reply without an order id", r, sendIdx, { unknown: true }));
    }
  } else out.missingOrderId = result("n/a", [], "the sample reply is not JSON");
  if (out.missingOrderId.problems.length) out.missingOrderId.state = "fail";

  // (2) garbled replies
  const garbled = [
    ["an HTML error page", { status: 200, text: "<html><body><h1>502 Bad Gateway</h1></body></html>" }],
    ["an empty body", { status: 200, text: "" }],
    ["an empty JSON object", { status: 200, json: {} }],
    ["JSON null", { status: 200, text: "null" }],
  ];
  const gp = [];
  for (const [label, reply] of garbled) {
    const r = await callOrder(adapter, "placeOrder", creds, args, withReply(fx.responses, sendIdx, reply));
    gp.push(...mustThrowOnce(label, r, sendIdx, { unknown: true }));
  }
  out.garbledReply = result(gp.length ? "fail" : "pass", gp);

  // (3) the answer never arrives
  const lp = [];
  for (const [label, networkError] of [["a reset connection", "fetch failed"], ["a timeout", "timeout"]]) {
    const r = await callOrder(adapter, "placeOrder", creds, args, withReply(fx.responses, sendIdx, { networkError }));
    lp.push(...mustThrowOnce(`after ${label}`, r, sendIdx, { unknown: true }));
  }
  out.lostReply = result(lp.length ? "fail" : "pass", lp);
  return out;
}

const SL_PRICE = 247.35;
const SL_TRIGGER = 241.8;
const SL_TYPES = ["SL", "STOP_LOSS", "STOPLOSS_LIMIT", "STOPLIMIT", "SL-L"];
const SLM_TYPES = ["SL-M", "STOP_LOSS_MARKET", "STOPLOSS_MARKET", "STOP", "SLM"];

/** The request text a broker would see: url + body, percent-decoded. */
const haystack = (call) => {
  let t = `${call.url} ${typeof call.body === "string" ? call.body : JSON.stringify(call.body ?? "")}`;
  try { t = decodeURIComponent(t.replace(/\+/g, " ")); } catch { /* keep raw */ }
  return t;
};

/**
 * Stop-loss mapping: the trigger (and limit) price must reach the broker. When the broker's orderCases.json names the
 * adapter-shaped orders, those are used; otherwise the common vocabularies are tried against the recorded sample.
 */
export async function runStopLossCase(adapter, fx, creds, args, cases) {
  if (cases?.stopLoss?.offered === false) return result("n/a", [], `not offered: ${cases.stopLoss.note ?? "the adapter sends no stop-loss orders"}`);
  const baseOrder = args[0];
  const sendIdx = sendIndexOf((await callOrder(adapter, "placeOrder", creds, args, fx.responses)).calls);
  const reply = sendIdx >= 0 ? { ...fx.responses[sendIdx] } : null;
  if (!reply) return result("fail", ["baseline place made no request"]);
  delete reply.expectBody; // the SL request differs from the recorded LIMIT one

  const respFor = () => fx.responses.map((r, i) => (i === sendIdx ? reply : r));
  const tryOrder = async (order) => callOrder(adapter, "placeOrder", creds, [order, ...args.slice(1)], respFor());
  const problems = [];
  const mapped = [];
  const notes = [];
  const variants = [
    { label: "SL", fixed: cases?.stopLoss?.order, types: SL_TYPES, build: (t) => ({ ...baseOrder, orderType: t, price: SL_PRICE, triggerPrice: SL_TRIGGER }), needPrice: true, expect: cases?.stopLoss?.expectBody },
    { label: "SL-M", fixed: cases?.stopLoss?.slmOrder, types: SLM_TYPES, build: (t) => ({ ...baseOrder, orderType: t, triggerPrice: SL_TRIGGER, price: undefined }), needPrice: false, expect: cases?.stopLoss?.slmExpectBody },
  ];
  for (const v of variants) {
    const candidates = v.fixed ? [v.fixed] : v.types.map(v.build);
    let sent = null;
    for (const order of candidates) {
      const r = await tryOrder(order);
      const call = r.calls.find((c) => c.matched === sendIdx);
      if (call) { sent = { r, call, order }; break; }
    }
    if (!sent) {
      // Many brokers' API terms or this adapter do not offer market-type orders: SL-M refused before any request is fine
      // once the SL (limit) variant is proven; an SL variant nothing accepts needs the broker's own vocabulary.
      if (v.needPrice) mapped.push(`SL: no accepted order type (${v.fixed ? "fixture order refused" : `tried ${v.types.join(", ")}`})`);
      else notes.push("SL-M not offered by the adapter");
      continue;
    }
    const { r, call, order } = sent;
    if (r.error) { problems.push(`${v.label}: the order was sent but the adapter then threw: ${r.error.message}`); continue; }
    const text = haystack(call);
    const trig = order.triggerPrice ?? SL_TRIGGER;
    const px = order.price ?? SL_PRICE;
    if (!text.includes(String(trig))) problems.push(`${v.label}: the trigger price ${trig} is not in the request`);
    if (v.needPrice && !text.includes(String(px))) problems.push(`${v.label}: the limit price ${px} is not in the request`);
    if (!v.needPrice && text.includes(String(SL_PRICE))) problems.push(`${v.label}: a limit price was sent for a stop-loss market order`);
    if (v.expect) {
      let body = call.body;
      try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(String(body ?? ""))); }
      // Noren-family brokers wrap the JSON in a jData form field.
      if (typeof body?.jData === "string") { try { body = { ...body, ...JSON.parse(body.jData) }; } catch { /* keep the form fields */ } }
      for (const [k, want] of Object.entries(v.expect)) if (JSON.stringify(body?.[k]) !== JSON.stringify(want) && String(body?.[k]) !== String(want)) problems.push(`${v.label}: ${k} should be ${JSON.stringify(want)}, got ${JSON.stringify(body?.[k])}`);
    }
  }
  if (problems.length) return result("fail", problems);
  if (mapped.length) return result("needs-fixture", [], mapped.join("; "));
  const pinned = cases?.stopLoss?.expectBody ? "checked against documented field names" : "trigger and limit price reach the broker; field names not pinned";
  return result("pass", [], [pinned, ...notes].join("; "));
}

/**
 * Cancelling a resting stop-loss order must carry that order's own variety (Angel One and mStock take one in the body,
 * Kite puts it in the URL). `cancelVariety: { args, responses, expectBody }` in orderCases.json records a stop-loss
 * order in the book and the cancel the broker must receive. Brokers whose cancel carries no variety are "n/a".
 */
export async function runCancelVarietyCase(adapter, fx, creds, cases) {
  const cv = cases?.cancelVariety;
  if (!cv) return result("n/a", [], "the adapter's cancel call carries no order variety");
  const r = await callOrder(adapter, "cancelOrder", creds, cv.args, cv.responses);
  const problems = [];
  if (r.error) problems.push(`cancelling a stop-loss order threw: ${r.error.message}`);
  else {
    const call = r.calls.filter((c) => c.method === (cv.method ?? "DELETE") || WRITE_METHODS.has(c.method)).at(-1);
    let body = call?.body;
    try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(String(body ?? ""))); }
    for (const [k, want] of Object.entries(cv.expectBody ?? {})) if (String(body?.[k]) !== String(want)) problems.push(`cancel body ${k} should be ${JSON.stringify(want)}, got ${JSON.stringify(body?.[k])}`);
    if (cv.expectUrl && !String(call?.url).includes(cv.expectUrl)) problems.push(`cancel URL should contain ${cv.expectUrl}, got ${call?.url}`);
  }
  return result(problems.length ? "fail" : "pass", problems, "stop-loss cancel carries the order's own variety");
}

/** Fixture-driven case: the broker's documented refusals. */
export async function runRefusalCases(adapter, fx, creds, args, cases) {
  const out = {};
  const base = await callOrder(adapter, "placeOrder", creds, args, fx.responses);
  const sendIdx = sendIndexOf(base.calls);
  if (!cases?.refusals?.length) out.refusedBody = result("needs-fixture", [], "no documented refusal reply recorded");
  else {
    const problems = [];
    for (const f of cases.refusals) {
      const r = await callOrder(adapter, "placeOrder", creds, args, withReply(fx.responses, sendIdx, f.reply));
      problems.push(...mustThrowOnce(f.name, r, sendIdx));
      if (r.error && !(r.error instanceof BrokerError)) problems.push(`${f.name}: threw ${r.error?.name}, which is not a BrokerError`);
    }
    out.refusedBody = result(problems.length ? "fail" : "pass", problems, `${cases.refusals.length} documented refusal(s)`);
  }
  return out;
}

/**
 * Fixture-driven case: the broker's documented "session ended" reply. Run LAST: several adapters remember a dead session
 * for the rest of the process. `sessionExpired.extraResponses` lists replies to calls the adapter may legitimately make
 * next (for example a documented token refresh that also fails).
 */
export async function runSessionCase(adapter, fx, creds, args, cases) {
  const out = {};
  const base = await callOrder(adapter, "placeOrder", creds, args, fx.responses);
  const sendIdx = sendIndexOf(base.calls);
  if (!cases?.sessionExpired) out.sessionExpired = result("needs-fixture", [], "no documented session-ended reply recorded");
  else {
    const problems = [];
    // Through the same guard the Bridge puts around every adapter (errorGuard.mjs), so this is what the scheduler sees.
    const responses = [...withReply(fx.responses, sendIdx, cases.sessionExpired.reply), ...(cases.sessionExpired.extraResponses ?? [])];
    const r = await callOrder(guardAdapterErrors(adapter), "placeOrder", creds, args, responses);
    problems.push(...mustThrowOnce("session-ended reply", r, sendIdx));
    if (r.error) {
      if (!SESSION_ERROR_CODES.includes(r.error?.code)) {
        problems.push(`session-ended reply: error code is ${r.error?.code ?? "none"}; the Bridge needs one of ${SESSION_ERROR_CODES.join(", ")} to mark the account logged out`);
      } else if (bridgeCodeOfWrite(r.error) !== "SESSION_EXPIRED") problems.push(`session-ended reply: the Bridge reads ${r.error.code} as ${bridgeCodeOfWrite(r.error)}, not SESSION_EXPIRED`);
    }
    out.sessionExpired = result(problems.length ? "fail" : "pass", problems);
  }
  return out;
}

/**
 * All order-safety cases for one broker.
 * @param {object} adapter
 * @param {{ manifest: object, byCapability: Record<string, any> }} fixtures
 * @returns {Promise<{ brokerId: string, hasOrders: boolean, cases: Record<string, { state: string, problems: string[], detail: string }> }>}
 */
export async function runOrderSafetyCases(adapter, fixtures, { cases = loadOrderCases(adapter.id) } = {}) {
  const caps = adapter.capabilities ?? {};
  if (!CAPABILITIES.placeOrder || !caps.placeOrder) return { brokerId: adapter.id, hasOrders: false, cases: {} };
  // Adapters that pace calls on the wall clock (the XTS family) expose a test hook to drop the spacing and any cached session.
  const reset = () => (typeof adapter.resetForTests === "function" ? adapter.resetForTests({ intervalMs: 0 }) : undefined);
  reset();
  const fx = fixtures.byCapability.placeOrder;
  if (!fx) return { brokerId: adapter.id, hasOrders: true, cases: Object.fromEntries(ORDER_CASES.map((c) => [c, result("needs-fixture", [], "no placeOrder.json sample")])) };
  const creds = { ...(fixtures.manifest.creds || {}), ...(fx.creds || {}) };
  const args = defaultArgs("placeOrder", fx, fixtures.manifest);
  // Order matters: the session case kills the adapter's session, so it goes last.
  const out = {
    ...(await runDerivedPlaceCases(adapter, fx, creds, args)),
    stopLoss: await runStopLossCase(adapter, fx, creds, args, cases),
    cancelVariety: await runCancelVarietyCase(adapter, fx, creds, cases),
    ...(await runRefusalCases(adapter, fx, creds, args, cases)),
    ...(reset(), await runSessionCase(adapter, fx, creds, args, cases)),
  };
  return { brokerId: adapter.id, hasOrders: true, cases: Object.fromEntries(ORDER_CASES.map((c) => [c, out[c]])) };
}

/** Flatten failures for expect(...).toEqual([]). */
export function orderCaseFailures(report) {
  return Object.entries(report.cases).flatMap(([name, r]) => (r.state === "fail" ? r.problems.map((p) => `${report.brokerId}.${name}: ${p}`) : []));
}
