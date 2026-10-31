/**
 * Probe budget (p1-05 §8): for every broker in BROKER_POLICIES, one probe per cooldown stays at or under 1 % of the
 * portfolio class's per-minute limit (or 2 % of per-second × 60 when only a per-second limit is set). Brokers whose
 * limits are low get a longer cooldown (probeCooldownSeconds), never a bigger share.
 */
import { describe, expect, it } from "vitest";
import { BROKER_POLICIES } from "../ratelimit/brokerPolicies.mjs";
import { probeCooldownSeconds } from "./checks.mjs";

const specsFor = (policy, cls) => [policy?.limits?.[cls], ...Object.values(policy?.groups ?? {}).filter((g) => g?.classes?.includes(cls))].filter(Boolean);

describe("readiness probe budget over BROKER_POLICIES", () => {
  const brokers = Object.entries(BROKER_POLICIES);
  it("covers the wired brokers", () => {
    expect(brokers.length).toBeGreaterThan(10);
    expect(Object.keys(BROKER_POLICIES)).toEqual(expect.arrayContaining(["dhan", "zerodha", "upstox"]));
  });
  for (const [id, policy] of brokers) {
    it(`${id}: probe rate within budget`, () => {
      const cooldown = probeCooldownSeconds(policy, "portfolio", 30);
      expect(cooldown).toBeGreaterThanOrEqual(30);
      const perMinute = 60 / cooldown;
      for (const s of specsFor(policy, "portfolio")) {
        if (Number.isFinite(s.perMinute)) expect(perMinute).toBeLessThanOrEqual(0.01 * s.perMinute + 1e-9);
        else if (Number.isFinite(s.perSecond)) expect(perMinute).toBeLessThanOrEqual(0.02 * s.perSecond * 60 + 1e-9);
      }
    });
  }
  it("brokers that need a longer cooldown than 30 s are listed with their policy", () => {
    // 1/s on portfolio → 50 s (2 % of 60/min); ICICI Direct's shared 100/min window → 60 s (1 %).
    const raised = Object.fromEntries(brokers.map(([id, p]) => [id, probeCooldownSeconds(p, "portfolio", 30)]).filter(([, c]) => c > 30));
    expect(raised).toEqual({
      anandrathi: 50,
      angelone: 50,
      compositedge: 50,
      fivepaisaxts: 50,
      ibulls: 50,
      icicidirect: 60,
      iifl: 50,
      jainamxts: 50,
      rmoney: 50,
      rupeezy: 50,
      wisdom: 50,
    });
  });
});
