import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every temporary folder a test makes lands inside this one, which test/tmpdir.mjs removes when the run ends. Set here,
// in the main process, so the workers and anything the tests spawn inherit it.
if (!process.env.MCB_TEST_TMPDIR) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-test-run-"));
  process.env.MCB_TEST_TMPDIR = dir;
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
}

// The suite checks the Bridge as it behaves when every tool needs a key (who may do what, scope by scope). Keyless
// access on this computer (auth/localAccess.mjs) is on by default for people, so it is switched off here and tested on
// its own, with server.keylessApi: true, in auth/localAccess.test.mjs. Set in the main process so spawned Bridges inherit it.
process.env.MCB_KEYLESS ??= "0";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.{test,spec}.mjs", "src/**/*.{test,spec}.{ts,mjs}", "scripts/**/*.{test,spec}.mjs"],
    // Budgets for tests and hooks that boot a whole Bridge. A demo Bridge starts its own background work at once
    // (instrument master, vol history seed, recorder back-fill: about 10 s of CPU when it runs to the end) on the same
    // event loop as the test, and about 50 test files boot one. Alone, a boot and its keys (an scrypt at N = 2^15
    // each) take about 1.5 s and these tests a few seconds; under the full parallel suite on a 4-core machine that
    // other jobs also load (load average 15 to 20), beforeAll hooks passed 20 s and single end-to-end tests 40 s.
    // Nothing in them waits on a timer, so the budget is for slow work, and a test that hangs still fails. Assertions
    // about speed measure CPU time or work counts (e2e/fixtures.mjs stopwatch), never these budgets.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./test/pinDate.mjs"],
    globalSetup: ["./test/tmpdir.mjs"],
  },
});
