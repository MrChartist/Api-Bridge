/**
 * The compat REST API (/api/v1/*, apikey in the JSON body) end to end in demo mode.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { expiryToIso, isoToCompact, isoToDashed, toCanonical, fromCanonical } from "../compat/mapping.mjs";

describe("compat mapping", () => {
  it("reads and writes compact symbols and dates", () => {
    expect(toCanonical("RELIANCE", "NSE")).toBe("NSE:RELIANCE");
    expect(toCanonical("NIFTY", "NSE_INDEX")).toBe("NSE:NIFTY");
    expect(toCanonical("NIFTY27OCT2625000CE", "NFO")).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(toCanonical("NIFTY27OCT26FUT", "NFO")).toBe("NFO:NIFTY-2026-10-27-FUT");
    expect(fromCanonical("NSE:NIFTY")).toEqual({ symbol: "NIFTY", exchange: "NSE_INDEX" });
    expect(fromCanonical("NFO:NIFTY-2026-10-27-25000-PE")).toEqual({ symbol: "NIFTY27OCT2625000PE", exchange: "NFO" });
    expect(expiryToIso("27OCT26")).toBe("2026-10-27");
    expect(expiryToIso("27-OCT-26")).toBe("2026-10-27");
    expect(expiryToIso("3-Nov-2026")).toBe("2026-11-03");
    expect(isoToDashed("2026-10-27")).toBe("27-OCT-26");
    expect(isoToCompact("2026-10-27")).toBe("27OCT26");
    expect(() => toCanonical("X", "NOPE")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("compat REST over HTTP (demo mode)", () => {
  let app;
  let base;
  let reader;
  let trader;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-compat-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    // A fixed Monday 10:30 IST, so paper MARKET orders fill whatever time the tests run.
    let t = Date.UTC(2026, 9, 19, 5, 0, 0);
    app = await createApp({ config, logger: createNullLogger(), clock: { now: () => (t += 50) } });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key: reader } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"], accounts: "*" }));
    ({ key: trader } = await app.deps.keyStore.create({ label: "trader", scopes: ["paper"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const post = async (endpoint, body) => {
    const r = await fetch(`${base}/api/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  it("needs a valid apikey and answers errors in its own shape", async () => {
    const none = await post("ping", {});
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({ status: "error" });
    expect(none.body.message).toMatch(/apikey/);
    const wrong = await post("ping", { apikey: "mcb_nope_nope" });
    expect(wrong.status).toBe(401);
  });

  it("ping, analyzer and intervals", async () => {
    const p = await post("ping", { apikey: reader });
    expect(p.body).toMatchObject({ status: "success", mode: "analyze", data: { message: "pong", broker: "demo" } });
    const a = await post("analyzer", { apikey: reader });
    expect(a.body.data).toMatchObject({ analyze_mode: true, mode: "analyze" });
    const off = await post("analyzer/toggle", { apikey: reader, mode: false });
    expect(off.status).toBe(403); // leaving analyzer mode needs a live key
    const i = await post("intervals", { apikey: reader });
    expect(i.body.data.minutes).toContain("5m");
  });

  it("quotes, multiquotes, depth and history", async () => {
    const q = await post("quotes", { apikey: reader, symbol: "RELIANCE", exchange: "NSE" });
    expect(q.status).toBe(200);
    expect(q.body.data.ltp).toBeGreaterThan(0);
    expect(Object.keys(q.body.data).sort()).toEqual(["ask", "bid", "high", "low", "ltp", "oi", "open", "prev_close", "volume"]);
    const mq = await post("multiquotes", { apikey: reader, symbols: [{ symbol: "NIFTY", exchange: "NSE_INDEX" }, { symbol: "TCS", exchange: "NSE" }, { symbol: "X", exchange: "BAD" }] });
    expect(mq.body.status).toBe("success");
    expect(mq.body.results[0]).toMatchObject({ symbol: "X", exchange: "BAD" });
    expect(mq.body.results[0].error).toBeTruthy();
    expect(mq.body.results.slice(1).map((r) => r.symbol)).toEqual(["NIFTY", "TCS"]);
    const d = await post("depth", { apikey: reader, symbol: "RELIANCE", exchange: "NSE" });
    expect(d.body.data.bids.length).toBeGreaterThan(0);
    expect(d.body.data.bids[0]).toHaveProperty("quantity");
    const h = await post("history", { apikey: reader, symbol: "NIFTY", exchange: "NSE_INDEX", interval: "D", start_date: "2026-09-01", end_date: "2026-10-20" });
    expect(h.status).toBe(200);
    expect(h.body.data.length).toBeGreaterThan(10);
    expect(Object.keys(h.body.data[0]).sort()).toEqual(["close", "high", "low", "oi", "open", "timestamp", "volume"]);
  });

  it("expiry, option chain and option symbol by offset", async () => {
    const e = await post("expiry", { apikey: reader, symbol: "NIFTY", exchange: "NFO", instrumenttype: "options" });
    expect(e.body.data[0]).toMatch(/^\d{2}-[A-Z]{3}-\d{2}$/);
    const expiry = e.body.data[0].replace(/-/g, "");
    const c = await post("optionchain", { apikey: reader, underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: expiry, strike_count: 2 });
    expect(c.body).toMatchObject({ status: "success", underlying: "NIFTY", expiry_date: expiry });
    expect(c.body.chain).toHaveLength(5);
    expect(c.body.chain[2].ce.label).toBe("ATM");
    const atm = await post("optionsymbol", { apikey: reader, underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: expiry, offset: "ATM", option_type: "CE" });
    expect(atm.body.symbol).toBe(c.body.chain[2].ce.symbol);
    const itm = await post("optionsymbol", { apikey: reader, underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: expiry, offset: "ITM1", option_type: "CE" });
    expect(itm.body.symbol).toBe(c.body.chain[1].ce.symbol); // ITM call = lower strike
    const itmPut = await post("optionsymbol", { apikey: reader, underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: expiry, offset: "ITM1", option_type: "PE" });
    expect(itmPut.body.symbol).toBe(c.body.chain[3].pe.symbol);
  });

  it("orders need the paper scope and are paper orders in analyzer mode", async () => {
    const refused = await post("placeorder", { apikey: reader, strategy: "t", symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 1, pricetype: "MARKET", product: "CNC" });
    expect(refused.status).toBe(403);
    const r = await post("placeorder", { apikey: trader, strategy: "test", symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 2, pricetype: "MARKET", product: "MIS" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "success", mode: "analyze" });
    expect(r.body.orderid).toMatch(/^PAPER-/);
    const st = await post("orderstatus", { apikey: trader, orderid: r.body.orderid, strategy: "test" });
    expect(st.body.data).toMatchObject({ orderid: r.body.orderid, symbol: "RELIANCE", exchange: "NSE", action: "BUY", product: "MIS" });
    const ob = await post("orderbook", { apikey: trader });
    expect(ob.body.data.orders.some((o) => o.orderid === r.body.orderid)).toBe(true);
    expect(ob.body.data.statistics.total_buy_orders).toBeGreaterThanOrEqual(1);
  });

  it("smart orders move towards the target position; closeposition squares off", async () => {
    // let the paper engine fill the market order from the demo market
    const wait = () => new Promise((r) => setTimeout(r, 2500));
    const first = await post("placesmartorder", { apikey: trader, strategy: "t", symbol: "TCS", exchange: "NSE", action: "BUY", quantity: 0, position_size: 3, pricetype: "MARKET", product: "MIS" });
    expect(first.body.status).toBe("success");
    await wait();
    const pos = await post("openposition", { apikey: trader, strategy: "t", symbol: "TCS", exchange: "NSE", product: "MIS" });
    expect(pos.body.quantity).toBe("3");
    const again = await post("placesmartorder", { apikey: trader, strategy: "t", symbol: "TCS", exchange: "NSE", action: "BUY", quantity: 0, position_size: 3, pricetype: "MARKET", product: "MIS" });
    expect(again.body.message).toMatch(/No action needed/);
    const pb = await post("positionbook", { apikey: trader });
    expect(pb.body.data.find((p) => p.symbol === "TCS").quantity).toBe("3");
    const close = await post("closeposition", { apikey: trader, strategy: "t" });
    expect(close.body.status).toBe("success");
    await wait();
    const after = await post("openposition", { apikey: trader, strategy: "t", symbol: "TCS", exchange: "NSE", product: "MIS" });
    expect(after.body.quantity).toBe("0");
  }, 15_000);

  it("basket and split orders report each order", async () => {
    const b = await post("basketorder", {
      apikey: trader,
      strategy: "b",
      orders: [
        { symbol: "INFY", exchange: "NSE", action: "BUY", quantity: 1, pricetype: "MARKET", product: "MIS" },
        { symbol: "INFY", exchange: "NOPE", action: "BUY", quantity: 1, pricetype: "MARKET", product: "MIS" },
      ],
    });
    expect(b.body.results.map((r) => r.status)).toEqual(["success", "error"]);
    const s = await post("splitorder", { apikey: trader, strategy: "s", symbol: "INFY", exchange: "NSE", action: "SELL", quantity: 5, splitsize: 2, pricetype: "MARKET", product: "MIS" });
    expect(s.body).toMatchObject({ split_size: 2, total_quantity: 5 });
    expect(s.body.results.map((r) => r.quantity)).toEqual([2, 2, 1]);
    const funds = await post("funds", { apikey: trader });
    expect(Number(funds.body.data.availablecash)).toBeGreaterThan(0);
    expect(typeof funds.body.data.availablecash).toBe("string");
  });

  it("WebSocket: authenticate, subscribe with exchange/symbol pairs, receive market_data", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/v1/ws`);
    const inbox = [];
    const next = (pred, ms = 5000) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(inbox).slice(0, 400)}`)), ms);
        const check = () => {
          const i = inbox.findIndex(pred);
          if (i >= 0) {
            clearTimeout(t);
            resolve(inbox.splice(i, 1)[0]);
          } else setTimeout(check, 10);
        };
        check();
      });
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ action: "subscribe", mode: "LTP", symbols: [{ exchange: "NSE", symbol: "RELIANCE" }] }));
    expect((await next((m) => m.type === "error")).code).toBe("NOT_AUTHENTICATED");
    ws.send(JSON.stringify({ action: "authenticate", api_key: reader }));
    expect(await next((m) => m.type === "auth")).toMatchObject({ status: "success", broker: "demo" });
    ws.send(JSON.stringify({ action: "subscribe", mode: 2, symbols: [{ exchange: "NSE_INDEX", symbol: "NIFTY" }, { exchange: "BAD", symbol: "X" }] }));
    const sub = await next((m) => m.type === "subscribe");
    expect(sub.status).toBe("partial");
    expect(sub.subscriptions.find((x) => x.symbol === "NIFTY")).toMatchObject({ status: "success", mode: 2 });
    const tick = await next((m) => m.type === "market_data", 10_000);
    expect(tick).toMatchObject({ symbol: "NIFTY", exchange: "NSE_INDEX", mode: 2 });
    expect(tick.data.ltp).toBeGreaterThan(0);
    expect(tick.data).toHaveProperty("open");
    ws.send(JSON.stringify({ action: "unsubscribe_all" }));
    expect(await next((m) => m.type === "unsubscribe")).toMatchObject({ status: "success" });
    ws.close();
  }, 20_000);

  it("WebSocket: a bad key is refused and closed", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/v1/ws`);
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ action: "authenticate", api_key: "mcb_bad_bad" }));
    const code = await new Promise((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(4001);
    expect(msgs[0]).toMatchObject({ type: "auth", status: "error" });
  });
});
