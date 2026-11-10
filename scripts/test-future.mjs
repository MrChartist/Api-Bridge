#!/usr/bin/env node
/**
 * `npm run test:future [-- days...]`: the whole test suite with the wall clock moved forward (default 60 days; give several
 * numbers to run it once for each, for example `npm run test:future -- 30 100 400`). A test that depends on today's date
 * (a hard-coded expiry, a key that "expires in a week", a price that follows the clock) goes red here long before it goes
 * red for the next person. The shift is test/shiftClock.cjs, loaded through NODE_OPTIONS so every worker and node child
 * process sees it. The exit code is that of the first failing run.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const days = (args.length ? args : [process.env.TEST_CLOCK_SHIFT_DAYS || "60"]).map(Number);
if (days.some((d) => !Number.isFinite(d) || d <= 0)) {
  console.error("usage: npm run test:future [-- <days ahead> ...]   (positive numbers, default 60)");
  process.exit(2);
}
const preload = join(root, "test", "shiftClock.cjs");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
let failed = 0;
for (const d of days) {
  console.log(`\n== test suite with the clock ${d} days ahead (${new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)}) ==`);
  const env = { ...process.env, TEST_CLOCK_SHIFT_DAYS: String(d), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`.trim() };
  const r = spawnSync(process.execPath, [vitest, "run"], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) failed = failed || r.status || 1;
}
process.exit(failed);
