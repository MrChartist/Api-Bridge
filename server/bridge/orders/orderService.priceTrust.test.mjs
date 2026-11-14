/**
 * An order is never priced from a stale, delayed, end-of-day, unofficial, plugin or unlabelled value. The market service
 * already refuses those for the `order` purpose; these tests prove the order service (a) asks with that purpose and
 * (b) still refuses such a value if a service or a fake hands one back anyway. Fakes only, no network.
 */
import { describe, expect, it } from "vitest";
import { buildHarness, liveOrder } from "./__fixtures__/helpers.mjs";

const NOW = Date.parse("2026-10-19T10:00:00+05:30");
const label = (over = {}) => ({ source: "broker", asOf: new Date(NOW).toISOString(), ageMs: 0, stale: false, accountId: "fake-1", broker: "fake", class: "realtime", delaySec: 0, official: true, confidence: "high", flags: [], ...over });

const UNTRUSTED = [
  ["labelled stale", label({ stale: true, source: "cache", flags: ["stale"] })],
  ["stale flag only", label({ flags: ["stale"] })],
  ["revalidating", label({ revalidating: true })],
  ["delayed", label({ class: "delayed", delaySec: 900, official: false, flags: ["delayed", "unofficial"], source: "backup" })],
  ["end of day", label({ class: "eod", delaySec: null, official: true, flags: ["eod"], source: "backup" })],
  ["unofficial", label({ official: false, flags: ["unofficial"] })],
  ["from a plugin", label({ class: "delayed", delaySec: 60, official: false, flags: ["plugin", "unofficial", "delayed", "untrusted_source"], source: "backup" })],
  ["from a backup source labelled realtime", label({ source: "backup" })],
  ["class missing", { source: "broker", stale: false }],
  ["no label at all", undefined],
];

const marketOrder = () => liveOrder({ account: "dhan-main", orderType: "MARKET", price: undefined });

function harnessWith(freshness) {
  const h = buildHarness();
  h.marketData.ltp = async (list, opts) => {
    h.marketData.calls.push(["ltp", [...list], { ...opts }]);
    return { items: list.map((symbol) => ({ symbol, ltp: 1500, ...(freshness === undefined ? {} : { freshness }) })), errors: [] };
  };
  return h;
}

describe("order price reads", () => {
  it("ask for purpose order, and a trusted real-time price is used to protect a MARKET order", async () => {
    const h = harnessWith(label());
    const { order } = await h.svc.place(h.ctx("live"), marketOrder());
    expect(order).toMatchObject({ orderType: "LIMIT", price: 1530 });
    const asks = h.marketData.calls.filter(([m]) => m === "ltp");
    expect(asks.length).toBeGreaterThan(0);
    for (const [, , opts] of asks) expect(opts).toMatchObject({ purpose: "order", priority: "live" });
  });

  it.each(UNTRUSTED)("never prices a MARKET order from a value that is %s", async (_name, freshness) => {
    const h = harnessWith(freshness);
    await expect(h.svc.place(h.ctx("live"), marketOrder())).rejects.toMatchObject({ code: "INVALID_ORDER" });
    expect(h.dhan.placed).toHaveLength(0); // nothing reached the broker
  });

  it.each(UNTRUSTED)("the price band check gets no price from a value that is %s", async (_name, freshness) => {
    const h = harnessWith(freshness);
    await h.svc.place(h.ctx("live"), liveOrder());
    const check = h.safety.calls.find((c) => c[0] === "check");
    expect(check[1].ltp ?? null).toBeNull();
  });

  it("the price band check does get a trusted price", async () => {
    const h = harnessWith(label());
    await h.svc.place(h.ctx("live"), liveOrder());
    expect(h.safety.calls.find((c) => c[0] === "check")[1].ltp).toBe(1500);
  });

  it("a read that throws gives no price and does not block a LIMIT order", async () => {
    const h = buildHarness();
    h.marketData.ltp = async () => {
      throw new Error("down");
    };
    const { order } = await h.svc.place(h.ctx("live"), liveOrder());
    expect(order.status).toBe("open");
  });
});
