/**
 * The tool behind `npm run test:future`: the preload really moves `Date`, keeps the real clock reachable for children outside
 * node, reaches node child processes, and a bad argument is refused. Cheap, so it runs in every normal test run (the full
 * clock-shifted run itself is `npm run test:future`, one CI job).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/openapi-model.mjs";

const PRELOAD = join(REPO_ROOT, "test", "shiftClock.cjs");
const DAY = 86_400_000;

function nodeWith(days, code) {
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}` };
  if (days === null) delete env.TEST_CLOCK_SHIFT_DAYS;
  else env.TEST_CLOCK_SHIFT_DAYS = String(days);
  const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe("clock shift for npm run test:future", () => {
  it("moves Date.now() and new Date() by the number of days and keeps the real clock reachable", () => {
    const out = nodeWith(100, "const real = globalThis.__mcbRealNow(); console.log(JSON.stringify({ shifted: Date.now(), real, viaNew: new Date().getTime(), explicit: new Date(2026, 0, 1).getFullYear(), type: typeof Date() }))");
    expect(Math.abs(out.shifted - out.real - 100 * DAY)).toBeLessThan(5000);
    expect(Math.abs(out.viaNew - out.real - 100 * DAY)).toBeLessThan(5000);
    expect(out.explicit).toBe(2026); // constructing a date from parts is untouched
    expect(out.type).toBe("string");
  });

  it("does nothing when no shift is asked, so the preload is safe to leave in NODE_OPTIONS", () => {
    const out = nodeWith(null, "console.log(JSON.stringify({ hook: typeof globalThis.__mcbRealNow }))");
    expect(out.hook).toBe("undefined");
  });

  it("the run script refuses a day count that is not a positive number", () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "test-future.mjs"), "-5"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: npm run test:future/);
  });
});
