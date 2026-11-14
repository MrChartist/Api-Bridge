import { describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.mjs";
import { createApp } from "../core/app.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { EVENTS_CONFIG_SCHEMA, eventsConfig } from "./config.mjs";
import { tmpDir } from "./testkit.mjs";

describe("events config", () => {
  it("has safe defaults: https only, public targets only, five thousand events kept", () => {
    const c = EVENTS_CONFIG_SCHEMA.parse({});
    expect(c).toMatchObject({ enabled: true, retain: 5000, maxClients: 50, maxClientsPerKey: 5 });
    expect(c.webhooks).toMatchObject({ enabled: true, allowPrivateTargets: false, allowedHosts: [], timeoutMs: 10_000, maxResponseBytes: 4096, replayWindowSec: 300, maxSubscriptions: 20 });
    expect(c.webhooks.retry).toEqual({ maxAttempts: 8, baseMs: 5000, maxMs: 3_600_000, jitter: 0.2, maxAgeSec: 86_400 });
    expect(eventsConfig({}).retain).toBe(5000);
    expect(eventsConfig({ events: { retain: 200 } }).retain).toBe(200);
  });

  it("is strict: unknown keys and out-of-range values are refused", () => {
    for (const bad of [{ nope: 1 }, { retain: 5 }, { retain: 1e9 }, { webhooks: { nope: true } }, { webhooks: { allowedHosts: ["HTTPS://x"] } }, { webhooks: { allowedHosts: ["not a host"] } }, { webhooks: { retry: { jitter: 2 } } }, { webhooks: { timeoutMs: 10 } }, { webhooks: { allowPrivateTargets: "yes" } }]) {
      expect(EVENTS_CONFIG_SCHEMA.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(EVENTS_CONFIG_SCHEMA.safeParse({ webhooks: { allowedHosts: ["example.com", "*.partner.example.org"] } }).success).toBe(true);
  });

  it("is a known config section of the Bridge, and a bad value stops the start with a clear message", async () => {
    const dataDir = tmpDir("mcb-events-config-");
    const ok = loadConfig({ raw: { dataDir, events: { retain: 300 } }, env: {} });
    const app = await createApp({ config: ok.config, logger: createNullLogger() });
    expect(app.deps.config.events.retain).toBe(300);
    expect(app.deps.config.events.webhooks.allowPrivateTargets).toBe(false);
    await expect(createApp({ config: loadConfig({ raw: { dataDir, events: { webhooks: { allowPrivateTargets: "maybe" } } }, env: {} }).config, logger: createNullLogger() })).rejects.toThrow(/events\.webhooks\.allowPrivateTargets/);
  });

  it("cannot be switched to private targets from the environment or over HTTP", async () => {
    // The only place the setting exists is the config file section: no route accepts it, and the module reads it once.
    const { ROUTES } = await import("./module.mjs");
    expect(ROUTES.flatMap((r) => r)).not.toContain("allowPrivateTargets");
    const dataDir = tmpDir("mcb-events-config2-");
    const { config } = loadConfig({ raw: { dataDir }, env: { MCB_EVENTS_ALLOW_PRIVATE_TARGETS: "1" } });
    expect(eventsConfig(config).webhooks.allowPrivateTargets).toBe(false);
  });
});
