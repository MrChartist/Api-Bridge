/**
 * T-sec-8: after an e2e-like run with a stub broker whose credentials
 * contain TOKEN_SENTINEL_123 and an egress lookup that sees 198.51.100.23, neither string appears in
 * readiness/state.json, the captured logs (debug level), the trading.readiness payloads or the formatted
 * notifications.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createLogger } from "../core/logger.mjs";
import { TRADING_DAY_10AM_IST, shiftedClock, stubBroker, stubRegistry } from "../e2e/fixtures.mjs";
import { formatEvent } from "../notify/format.mjs";

const SENTINEL = "TOKEN_SENTINEL_123";
const DETECTED = "198.51.100.23";

let app;
let echo;
const lines = [];
const payloads = [];
let dataDir;

beforeAll(async () => {
  echo = http.createServer((_req, res) => res.end(`${DETECTED}\n`));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  dataDir = mkdtempSync(join(tmpdir(), "mcb-rd-secrets-"));
  const { config } = loadConfig({
    raw: {
      dataDir,
      server: { port: 0 },
      safety: { liveTrading: true },
      accounts: [{ id: "stub-live", broker: "zerodha", label: "Stub", live: { enabled: true, allowedSources: ["rest", "webhook"], registeredIp: "203.0.113.10" } }],
      readiness: { egressIp: { mode: "lookup", lookupUrl: `http://127.0.0.1:${echo.address().port}/ip` } },
    },
    env: {},
  });
  const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const stub = stubBroker("zerodha");
  app = await createApp({ config, logger, clock: shiftedClock(TRADING_DAY_10AM_IST), brokers: stubRegistry({ zerodha: stub }) });
  app.deps.bus.on("trading.readiness", (p) => payloads.push(p));
  await app.listen();
  await app.deps.accounts.connect("stub-live", { values: { apiKey: `key-${SENTINEL}`, accessToken: `token-${SENTINEL}` } });
  await app.deps.readiness.check({ reason: "test" });
  // A kill-switch cycle adds more transitions and payloads.
  const ctx = { principal: { kind: "local", id: "cli" }, scopes: new Set(["admin"]), loopback: true, source: "cli", requestId: null };
  await app.deps.safety.engageKillSwitch(ctx, { reason: "test" });
  await app.deps.readiness.check({ reason: "test" });
  await app.deps.safety.releaseKillSwitch(ctx, { confirm: "RELEASE" });
  await app.deps.readiness.check({ reason: "test" });
  await app.close();
});

afterAll(async () => {
  await new Promise((r) => echo?.close(() => r()));
});

describe("T-sec-8: no secrets and no egress IP in readiness outputs", () => {
  it("the run did detect the address and produce payloads", () => {
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.some((p) => p.reasons?.some((r) => r.code === "IP_MISMATCH"))).toBe(true);
  });

  it("state.json holds neither the sentinel nor the detected IP", () => {
    const text = readFileSync(join(dataDir, "readiness", "state.json"), "utf8");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(DETECTED);
  });

  it("logs, payloads and formatted notifications hold neither", () => {
    const logs = lines.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain(DETECTED);
    const all = JSON.stringify(payloads);
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain(DETECTED);
    for (const p of payloads) {
      const { title, text } = formatEvent("trading.readiness", p);
      expect(`${title}\n${text}`).not.toContain(SENTINEL);
      expect(`${title}\n${text}`).not.toContain(DETECTED);
    }
  });
});
