/**
 * OrderService readiness line: automated LIVE sends are refused with
 * CANNOT_TRADE while their account cannot trade (no safety slot, no broker call); a person's live order gets a warning
 * and goes on to safety.check; paper orders get no line; gateAutomated false → warning only; no readiness service →
 * no line.
 */
import { describe, expect, it, vi } from "vitest";
import { buildHarness, liveOrder } from "./__fixtures__/helpers.mjs";

const reasons = {
  cannot_trade: [{ check: "egress", code: "IP_MISMATCH", severity: "fail", message: "This computer's internet address does not match the static IP registered for Main." }],
  warn: [{ check: "dailyLoss", code: "DAILY_LOSS_NEAR", severity: "warn", message: "₹1,750 of ₹10,000 daily loss left." }],
  ready: [],
  unknown: [],
};

function fakeReadiness(state, { stale = false, fresh } = {}) {
  const view = (s, st) => ({ ok: s === "ready" || s === "warn", state: s, reasons: reasons[s] ?? [], checkedAt: "2026-10-19T10:00:00+05:30", stale: st });
  return {
    canTrade: vi.fn(() => view(state, stale)),
    ensureFresh: vi.fn(async () => view(fresh ?? state, false)),
  };
}

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("readiness gate for automated live sends", () => {
  it("webhook live + cannot_trade → CANNOT_TRADE; no slot, no broker call, audited as order.refused", async () => {
    const readiness = fakeReadiness("cannot_trade");
    const h = buildHarness({ readiness });
    const e = await reject(h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder()));
    expect(e).toMatchObject({ code: "CANNOT_TRADE", status: 403 });
    expect(e.detail).toMatch(/cannot trade right now \(This computer's internet address does not match/);
    expect(e.errors).toEqual([expect.objectContaining({ path: "readiness.egress" })]);
    expect(h.zerodha.placed).toHaveLength(0);
    expect(h.safety.calls.map((c) => c[0])).not.toContain("acquireOrderSlot");
    expect(h.safety.calls.map((c) => c[0])).not.toContain("check");
    expect(h.scheduler.calls).toEqual([]);
    expect(h.audit.types()).toEqual(["order.refused"]);
    expect(h.audit.records[0].data).toMatchObject({ code: "CANNOT_TRADE", mode: "live", reasons: ["readiness.egress"] });
    expect(readiness.canTrade).toHaveBeenCalledWith("zerodha-main", { mode: "live" });
  });

  it("webhook live + stale state → ensureFresh once, then pass or block on the fresh answer", async () => {
    const ok = fakeReadiness("ready", { stale: true, fresh: "ready" });
    const h = buildHarness({ readiness: ok });
    await h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder());
    expect(ok.ensureFresh).toHaveBeenCalledTimes(1);
    expect(ok.ensureFresh).toHaveBeenCalledWith("zerodha-main", { timeoutMs: 5000 });
    expect(h.zerodha.placed).toHaveLength(1);

    const bad = fakeReadiness("ready", { stale: true, fresh: "cannot_trade" });
    const h2 = buildHarness({ readiness: bad });
    expect(await reject(h2.svc.place(h2.ctx("live", { source: "webhook" }), liveOrder()))).toMatchObject({ code: "CANNOT_TRADE" });
    expect(bad.ensureFresh).toHaveBeenCalledTimes(1);
    expect(h2.zerodha.placed).toHaveLength(0);

    const still = fakeReadiness("unknown", { fresh: "unknown" });
    const h3 = buildHarness({ readiness: still });
    const e = await reject(h3.svc.place(h3.ctx("live", { source: "webhook" }), liveOrder()));
    expect(e.code).toBe("CANNOT_TRADE");
    expect(e.detail).toMatch(/could not be checked/);
    expect(h3.zerodha.placed).toHaveLength(0);
  });

  it("a person's live order (REST) on a cannot_trade account gets a READINESS warning and proceeds to safety.check", async () => {
    const h = buildHarness({ readiness: fakeReadiness("cannot_trade") });
    const { order } = await h.svc.place(h.ctx("live"), liveOrder());
    expect(order.mode).toBe("live");
    expect(order.warnings.join(" ")).toMatch(/^Readiness: cannot trade: This computer's internet address/);
    expect(h.safety.calls.map((c) => c[0])).toEqual(["check", "acquireOrderSlot"]);
    const p = await h.svc.preview(h.ctx("live"), liveOrder());
    expect(p.checks).toContainEqual(expect.objectContaining({ code: "READINESS", severity: "warn" }));
  });

  it("a webhook order on a warn account carries the warning and is sent", async () => {
    const h = buildHarness({ readiness: fakeReadiness("warn") });
    const { order } = await h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder());
    expect(order.warnings.join(" ")).toMatch(/Readiness: warn: ₹1,750 of ₹10,000 daily loss left/);
    expect(h.zerodha.placed).toHaveLength(1);
  });

  it("paper orders get no readiness line", async () => {
    const readiness = fakeReadiness("cannot_trade");
    const h = buildHarness({ readiness });
    const { order } = await h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder({ mode: "paper" }));
    expect(order.mode).toBe("paper");
    expect(readiness.canTrade).not.toHaveBeenCalled();
  });

  it("readiness.gateAutomated false → a warning only", async () => {
    const h = buildHarness({ readiness: fakeReadiness("cannot_trade"), raw: { readiness: { gateAutomated: false } } });
    const { order } = await h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder());
    expect(order.warnings.join(" ")).toMatch(/Readiness: cannot trade/);
    expect(h.zerodha.placed).toHaveLength(1);
  });

  it("no readiness service (stub or disabled) → no line", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder());
    expect(order.warnings.join(" ")).not.toMatch(/Readiness/);
    const off = { canTrade: vi.fn(() => ({ ok: true, state: "unknown", reasons: [], disabled: true })), ensureFresh: vi.fn() };
    const h2 = buildHarness({ readiness: off });
    await h2.svc.place(h2.ctx("live", { source: "webhook" }), liveOrder());
    expect(off.ensureFresh).not.toHaveBeenCalled();
    expect(h2.zerodha.placed).toHaveLength(1);
  });

  it("the preview of an automated order shows the block before anything is sent", async () => {
    const h = buildHarness({ readiness: fakeReadiness("cannot_trade") });
    const p = await h.svc.preview(h.ctx("live", { source: "webhook" }), liveOrder());
    expect(p.ok).toBe(false);
    expect(p.checks).toContainEqual(expect.objectContaining({ code: "CANNOT_TRADE", severity: "block" }));
  });
});
