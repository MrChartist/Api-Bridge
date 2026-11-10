/**
 * OPS-14: a client that keeps retrying a refused order adds one audit record a minute with a count, not one per retry.
 */
import { describe, expect, it } from "vitest";
import { buildHarness, liveOrder } from "./__fixtures__/helpers.mjs";

const refused = async (h, order) => {
  try {
    await h.svc.place(h.ctx("live"), order);
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal");
};

describe("refused orders in the audit log", () => {
  it("fifty identical refusals in a minute are one record; a minute later the next one carries the count", async () => {
    const h = buildHarness();
    const order = liveOrder({ account: "zerodha-2" }); // zerodha-2 has no live.enabled: PAPER_ONLY
    for (let i = 0; i < 50; i += 1) expect((await refused(h, order)).code).toBe("PAPER_ONLY");
    expect(h.audit.types().filter((t) => t === "order.refused")).toHaveLength(1);
    await h.clock.advance(61_000);
    await refused(h, order);
    const types = h.audit.types().filter((t) => t === "order.refused");
    expect(types).toHaveLength(2);
    const second = h.audit.records.filter((r) => r.type === "order.refused")[1];
    expect(second.data.suppressed).toBe(49);
  });

  it("a different order shape, symbol or code is its own record (nothing real is hidden)", async () => {
    const h = buildHarness();
    await refused(h, liveOrder({ account: "zerodha-2", quantity: 10 }));
    await refused(h, liveOrder({ account: "zerodha-2", quantity: 11 }));
    await refused(h, liveOrder({ account: "zerodha-2", side: "SELL" }));
    await refused(h, liveOrder({ account: "paper" })); // another account
    expect(h.audit.types().filter((t) => t === "order.refused")).toHaveLength(4);
  });
});
