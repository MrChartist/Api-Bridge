/**
 * Where Idempotency-Key matters over real HTTP: the compat order routes honour it like /v1/orders (a retried order returns the
 * first answer and places nothing twice), and a malformed key is a 400 only on routes that use it, never on a public webhook
 * receiver or another write route that ignores it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPAT_IDEMPOTENT_ROUTES, ignoresIdempotencyKey, pipelineChecksIdempotencyKey } from "./idempotency.mjs";
import { ENDPOINTS } from "../compat/module.mjs";
import { bootDemoBridge } from "./__fixtures__/demoBridge.mjs";

let b;
beforeAll(async () => {
  b = await bootDemoBridge();
});
afterAll(() => b?.close());

let n = 0;
const idk = () => `compat-key-${++n}-abcdef`;
const order = (over = {}) => ({ symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 1, pricetype: "MARKET", product: "MIS", ...over });
const compat = (endpoint, body, headers = {}) => b.call("POST", `/api/v1/${endpoint}`, { body: { apikey: b.key, ...body }, headers, auth: null });
const orderCount = async () => (await b.call("GET", "/v1/orders?limit=200")).json.data.length;

describe("compat order routes honour Idempotency-Key", () => {
  it("the compat route list is a subset of the real compat endpoints", () => {
    for (const r of COMPAT_IDEMPOTENT_ROUTES) expect(Object.keys(ENDPOINTS), r).toContain(r.replace("POST /api/v1/", ""));
  });

  it("a retried placeorder returns the first answer and places one order", async () => {
    const before = await orderCount();
    const h = { "Idempotency-Key": idk() };
    const first = await compat("placeorder", order(), h);
    expect(first.status, first.text).toBe(200);
    expect(first.json.status).toBe("success");
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    const second = await compat("placeorder", order(), h);
    expect(second.status, second.text).toBe(200);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.json.orderid).toBe(first.json.orderid);
    expect(await orderCount()).toBe(before + 1);
  });

  it("without a key every call is a new order, as before", async () => {
    const a = await compat("placeorder", order());
    const c = await compat("placeorder", order());
    expect(a.json.orderid).not.toBe(c.json.orderid);
  });

  it("the key may travel in the body for clients that cannot set headers; the header wins", async () => {
    const key = idk();
    const first = await compat("placeorder", order({ idempotency_key: key }));
    const second = await compat("placeorder", order({ idempotency_key: key }));
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.json.orderid).toBe(first.json.orderid);
  });

  it("the same key with another order is 409 IDEMPOTENCY_KEY_REUSED in the compat error shape, and a malformed key is a 400", async () => {
    const h = { "Idempotency-Key": idk() };
    expect((await compat("placeorder", order(), h)).status).toBe(200);
    const other = await compat("placeorder", order({ quantity: 7 }), h);
    expect(other.status).toBe(409);
    expect(other.json).toMatchObject({ status: "error", code: "IDEMPOTENCY_KEY_REUSED" });
    const bad = await compat("placeorder", order(), { "Idempotency-Key": "x1" });
    expect(bad.status).toBe(400);
    expect(bad.json.status).toBe("error");
  });

  it("a retried basket and split order place their orders once", async () => {
    const before = await orderCount();
    const h1 = { "Idempotency-Key": idk() };
    const basket = { orders: [order(), order({ symbol: "TCS" })] };
    const f = await compat("basketorder", basket, h1);
    const s = await compat("basketorder", basket, h1);
    expect(s.headers.get("idempotency-replayed")).toBe("true");
    expect(s.text).toBe(f.text);
    const h2 = { "Idempotency-Key": idk() };
    const split = order({ quantity: 6, splitsize: 2 });
    const f2 = await compat("splitorder", split, h2);
    const s2 = await compat("splitorder", split, h2);
    expect(s2.headers.get("idempotency-replayed")).toBe("true");
    expect(s2.text).toBe(f2.text);
    expect(await orderCount()).toBe(before + 2 + 3);
  });

  it("a retried cancelorder and modifyorder carry their key too", async () => {
    const ltp = (await compat("quotes", { symbol: "RELIANCE", exchange: "NSE" })).json.data.ltp;
    const placed = await compat("placeorder", order({ pricetype: "LIMIT", price: Math.round(ltp * 0.98 * 20) / 20, quantity: 2 }));
    expect(placed.status, placed.text).toBe(200);
    const id = placed.json.orderid;
    const hc = { "Idempotency-Key": idk() };
    const c1 = await compat("cancelorder", { orderid: id }, hc);
    const c2 = await compat("cancelorder", { orderid: id }, hc);
    expect(c1.status, c1.text).toBe(200);
    expect(c2.headers.get("idempotency-replayed")).toBe("true");
    expect(c2.text).toBe(c1.text);
  });
});

describe("a malformed Idempotency-Key is a 400 only where the key is used", () => {
  it("routes: the pipeline checks the create routes and /v1/orders, ignores the rest, leaves the compat order routes to their handler", () => {
    expect(pipelineChecksIdempotencyKey("POST", "/v1/orders")).toBe(true);
    expect(pipelineChecksIdempotencyKey("POST", "/v1/downloads")).toBe(true);
    expect(pipelineChecksIdempotencyKey("POST", "/hooks/:source/:token")).toBe(false);
    expect(ignoresIdempotencyKey("POST", "/hooks/:source/:token")).toBe(true);
    expect(ignoresIdempotencyKey("POST", "/api/v1/placeorder")).toBe(false);
    expect(pipelineChecksIdempotencyKey("POST", "/api/v1/placeorder")).toBe(false);
    expect(ignoresIdempotencyKey("POST", "/api/v1/quotes")).toBe(true);
  });

  it("the public webhook receiver ignores a short or odd key and says so, instead of dropping the alert with a 400", async () => {
    const made = await b.call("POST", "/v1/hooks", { body: { source: "generic", label: "idem-scope", account: "demo-paper" } });
    expect(made.status, made.text).toBe(201);
    for (const key of ["x1", "a/b+c=d{}", "short"]) {
      const r = await b.call("POST", made.json.data.path, { auth: null, body: { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1 }, headers: { "Idempotency-Key": key } });
      expect(r.status, `${key}: ${r.text}`).not.toBe(400);
      expect(r.headers.get("idempotency-ignored"), key).toBe("true");
    }
  });

  it("a write route that does not use the key ignores a malformed one; a route that uses it still answers 400", async () => {
    const ignored = await b.call("POST", "/v1/downloads/dl_nope/pause", { headers: { "Idempotency-Key": "x1" } });
    expect(ignored.status).not.toBe(400);
    expect(ignored.headers.get("idempotency-ignored")).toBe("true");
    expect((await b.call("POST", "/v1/collections", { body: { name: "scope-x", symbols: [] }, headers: { "Idempotency-Key": "x1" } })).status).toBe(400);
    expect((await b.call("POST", "/v1/orders", { body: { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1 }, headers: { "Idempotency-Key": "x1" } })).status).toBe(400);
    // a read-only compat call is not an order: it does not look at the key
    const quotes = await compat("quotes", { symbol: "RELIANCE", exchange: "NSE" }, { "Idempotency-Key": "x1" });
    expect(quotes.status).not.toBe(400);
  });
});
