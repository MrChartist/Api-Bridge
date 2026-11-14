// One paper order, one event per transition: a placed-and-filled order used to publish `order.updated` twice (the paper
// engine and the order service both did), so a receiver that counts fills or sends a message per event reported each twice.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../core/__fixtures__/demoBridge.mjs";

let demo;
beforeAll(async () => {
  demo = await bootDemoBridge();
});
afterAll(async () => {
  await demo?.close();
});

const BODY = { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" };
const events = async (orderId) => {
  const r = await demo.call("GET", "/v1/events?since=0&limit=500&topics=order.*");
  expect(r.status).toBe(200);
  return (r.json.data ?? []).filter((e) => e.data?.orderId === orderId);
};

describe("order.updated for a paper order", () => {
  it("a market order that fills publishes one filled event, carrying the realised P&L", async () => {
    const placed = await demo.call("POST", "/v1/orders", { body: BODY, headers: { "Idempotency-Key": "paper-events-fill-1" } });
    expect([200, 201]).toContain(placed.status);
    const id = placed.json.data.orderId;
    expect(placed.json.data.status).toBe("filled");
    const seen = await events(id);
    expect(seen.filter((e) => e.data.status === "filled")).toHaveLength(1);
    expect(seen[0].data).toHaveProperty("realisedPnl");
  });

  it("a limit order that is placed, changed and cancelled publishes one event for each step", async () => {
    const ltp = (await demo.call("GET", "/v1/ltp?symbols=NSE:RELIANCE")).json.data[0].ltp;
    const price = Math.round((ltp * 0.99) / 0.1) * 0.1;
    const placed = await demo.call("POST", "/v1/orders", { body: { ...BODY, orderType: "LIMIT", price: Number(price.toFixed(1)) }, headers: { "Idempotency-Key": "paper-events-limit-1" } });
    expect([200, 201]).toContain(placed.status);
    const id = placed.json.data.orderId;
    expect((await events(id)).map((e) => e.data.status)).toEqual(["open"]);
    const modified = await demo.call("PATCH", `/v1/orders/${id}`, { body: { price: Number((price - 0.1).toFixed(1)) }, headers: { "Idempotency-Key": "paper-events-limit-2" } });
    expect(modified.status, modified.text).toBe(200);
    expect((await events(id)).map((e) => e.data.status)).toEqual(["open", "open"]);
    const cancelled = await demo.call("DELETE", `/v1/orders/${id}`, { headers: { "Idempotency-Key": "paper-events-limit-3" } });
    expect(cancelled.status).toBe(200);
    expect((await events(id)).map((e) => e.data.status)).toEqual(["open", "open", "cancelled"]);
  });
});
