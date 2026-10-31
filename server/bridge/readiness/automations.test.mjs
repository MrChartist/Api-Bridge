import { describe, expect, it } from "vitest";
import { createAutomationRegistry } from "./automations.mjs";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("automation registry (p1-05 §3.8)", () => {
  it("register, update (moves between accounts), remove", () => {
    const reg = createAutomationRegistry();
    const h = reg.register({ id: "g1", kind: "guard", accountId: "a", mode: "live", label: "Guard 1" });
    expect(reg.byAccount("a").map((x) => x.id)).toEqual(["g1"]);
    h.update({ accountId: "b", label: "Guard one" });
    expect(reg.byAccount("a")).toEqual([]);
    expect(reg.get("g1")).toMatchObject({ accountId: "b", label: "Guard one" });
    h.remove();
    expect(reg.count()).toBe(0);
  });

  it("refuses a duplicate id and bad input", () => {
    const reg = createAutomationRegistry();
    reg.register({ id: "g1", kind: "guard", accountId: "a", mode: "live" });
    expect(() => reg.register({ id: "g1", kind: "guard", accountId: "a", mode: "live" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => reg.register({ id: "g2", kind: "robot", accountId: "a", mode: "live" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => reg.register({ id: "g3", kind: "guard", accountId: "a", mode: "both" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("onState is called for that account only; a throwing consumer does not block others; paper is always ready", async () => {
    const reg = createAutomationRegistry({ logger: { warn() {} } });
    const seen = [];
    reg.register({ id: "bad", kind: "alert", accountId: "a", mode: "live", onState: () => {
      throw new Error("boom");
    } });
    reg.register({ id: "live-a", kind: "guard", accountId: "a", mode: "live", onState: (s) => seen.push(["live-a", s.state]) });
    reg.register({ id: "paper-a", kind: "guard", accountId: "a", mode: "paper", onState: (s) => seen.push(["paper-a", s.state]) });
    reg.register({ id: "live-b", kind: "guard", accountId: "b", mode: "live", onState: (s) => seen.push(["live-b", s.state]) });
    reg.notify({ accountId: "a", state: "cannot_trade", reasons: [{ code: "IP_MISMATCH" }], at: "x" });
    await flush();
    expect(seen).toEqual([
      ["live-a", "cannot_trade"],
      ["paper-a", "ready"],
    ]);
  });
});
