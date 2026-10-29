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

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.{test,spec}.mjs", "src/**/*.{test,spec}.{ts,mjs}", "scripts/**/*.{test,spec}.mjs"],
    testTimeout: 20_000,
    setupFiles: ["./test/pinDate.mjs"],
    globalSetup: ["./test/tmpdir.mjs"],
  },
});
