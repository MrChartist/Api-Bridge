/**
 * Shutdown never hangs on the demo book seed. A seed step can sit in the market-data queue, whose windows move with
 * the Bridge clock; with a clock that stands still (as tests inject) that step never returns, and close() waited for
 * it for good, so suites closing a demo Bridge mid-seed hit their hook timeout.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createDemoRegistry } from "../demo/demoMode.mjs";
import { SEED_STOP_WAIT_MS } from "./module.mjs";

describe("demo Bridge shutdown", () => {
  it("closes within the seed's stop wait even while the seed is running on a frozen clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-book-stop-"));
    const now = Date.parse("2026-10-29T10:00:00+05:30"); // a Thursday in market hours, frozen
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    const app = await createApp({ config, logger: createNullLogger(), clock: { now: () => now }, brokers: createDemoRegistry({ now: () => now }) });
    await app.listen();
    await new Promise((r) => setTimeout(r, 500));
    const t = Date.now();
    await app.close();
    expect(Date.now() - t).toBeLessThan(SEED_STOP_WAIT_MS + 4000);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
