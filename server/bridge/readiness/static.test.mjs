/**
 * The readiness monitor only reads: no file in readiness/ imports orders/ or paper/, calls an
 * adapter's order method, or engages the kill switch.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = import.meta.dirname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));

describe("readiness never sends or engages anything", () => {
  it("has source files", () => {
    expect(files).toEqual(expect.arrayContaining(["monitor.mjs", "checks.mjs", "routes.mjs", "module.mjs"]));
  });
  for (const f of files) {
    it(`${f}: no orders/ or paper/ import, no order method, no kill-switch engage`, () => {
      const src = readFileSync(join(DIR, f), "utf8");
      expect(src).not.toMatch(/from\s+["'][^"']*\/(orders|paper)\//);
      expect(src).not.toMatch(/\b(placeOrder|modifyOrder|cancelOrder)\s*\(/);
      expect(src).not.toMatch(/\bengageKillSwitch\s*\(/);
      expect(src).not.toMatch(/\breleaseKillSwitch\s*\(/);
    });
  }
  it("the demo simulation is read-only too", () => {
    const src = readFileSync(join(DIR, "../demo/demoReadiness.mjs"), "utf8");
    expect(src).not.toMatch(/\b(placeOrder|modifyOrder|cancelOrder|engageKillSwitch)\s*\(/);
    expect(src).not.toMatch(/liveTrading\s*=/);
  });
});
