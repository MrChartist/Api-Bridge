import { describe, expect, it } from "vitest";
import { classAllowedFor, classRank, dataQuality, meetsMaxAge, validateDescriptor, worstClass } from "./contract.mjs";

const good = { id: "demo-delayed", name: "Demo delayed", kind: "free", tier: "byok", class: "delayed", delaySec: 900, official: true, capabilities: ["quotes"], limits: { perMinute: 5 }, terms: { url: "https://example.com/terms", note: "You use your own key." } };

describe("data class", () => {
  it("ranks and combines classes", () => {
    expect(classRank("realtime")).toBe(0);
    expect(classRank("eod")).toBe(2);
    expect(classRank("nope")).toBe(3);
    expect(worstClass(["realtime", "delayed"])).toBe("delayed");
    expect(worstClass(["delayed", "eod", "realtime"])).toBe("eod");
    expect(worstClass([])).toBe("realtime");
  });
  it("lets only real-time data serve orders, alerts, paper and risk", () => {
    for (const p of ["order", "alert", "paper", "risk"]) expect(classAllowedFor("delayed", p)).toBe(false);
    expect(classAllowedFor("realtime", "order")).toBe(true);
    expect(classAllowedFor("delayed", "display")).toBe(true);
    expect(classAllowedFor("eod", "analysis")).toBe(true);
  });
  it("serves a caller only when the source is current enough for its maxAge", () => {
    expect(meetsMaxAge({ class: "realtime" }, 500)).toBe(true);
    expect(meetsMaxAge({ class: "delayed", delaySec: 900 }, 2000)).toBe(false);
    expect(meetsMaxAge({ class: "delayed", delaySec: 900 }, 900_000)).toBe(true);
    expect(meetsMaxAge({ class: "eod" }, 60_000)).toBe(false);
    expect(meetsMaxAge({ class: "eod" }, null)).toBe(true);
  });
  it("builds quality fields", () => {
    expect(dataQuality({ class: "realtime" })).toEqual({ class: "realtime", delaySec: 0, official: false, confidence: "high", flags: [] });
    expect(dataQuality({ class: "delayed", delaySec: 900, flags: ["unofficial"] }).delaySec).toBe(900);
  });
});

describe("validateDescriptor", () => {
  it("accepts a complete descriptor", () => expect(validateDescriptor(good)).toEqual({ ok: true, errors: [] }));
  it("reports every problem at once", () => {
    const r = validateDescriptor({ id: "X", kind: "x", class: "delayed", capabilities: [], limits: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(6);
  });
  it("requires terms outside the builtin tier and a notice version for opt-in", () => {
    expect(validateDescriptor({ ...good, terms: undefined }).errors.join()).toMatch(/terms/);
    const optIn = { ...good, tier: "opt-in", official: false };
    expect(validateDescriptor(optIn).errors.join()).toMatch(/noticeVersion/);
    expect(validateDescriptor({ ...optIn, noticeVersion: "1" }).ok).toBe(true);
  });
  it("refuses an official opt-in source and a delayed source without a delay", () => {
    expect(validateDescriptor({ ...good, tier: "opt-in", noticeVersion: "1" }).errors.join()).toMatch(/opt-in source is by definition/);
    expect(validateDescriptor({ ...good, delaySec: undefined }).errors.join()).toMatch(/delaySec/);
  });
});
