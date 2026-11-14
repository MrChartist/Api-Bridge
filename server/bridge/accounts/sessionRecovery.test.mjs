/**
 * The morning problem, end to end with the real AccountManager and the real scheduler (fake broker, fake clock, no network):
 * the broker ends the session overnight and answers in its own words. The Bridge must mark the account logged out, make
 * every later read fail fast with SESSION_EXPIRED WITHOUT calling the broker again, and use the new token after the login.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardAdapterErrors } from "../../brokers/errorGuard.mjs";
import { loadConfig } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createAccountManager } from "./accountManager.mjs";
import { apiKeyAdapter, createCapturingLogger, createMemorySecretStore, createStubRegistry } from "./__fixtures__/stubs.mjs";

const managers = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
});

/** A broker whose plain read throws its own wording ("Token expired") until it is given the Tuesday token. */
function overnightBroker() {
  const base = apiKeyAdapter();
  const calls = [];
  const adapter = {
    ...base,
    // The adapter recognises its own wording in normaliseError only, like most real ones.
    normaliseError: (e) => ({ statusCode: 502, code: /token expired/i.test(String(e?.message)) ? "UPSTREAM_AUTH" : "UPSTREAM_ERROR", message: String(e?.message) }),
    async fetchLTP(creds) {
      calls.push(creds.accessToken);
      if (creds.accessToken !== "token-tuesday") throw new Error("Broker says: Token expired");
      return { status: "success", data: { last_price: 25010 } };
    },
  };
  return { adapter, calls };
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-sess-"));
  const { config } = loadConfig({ raw: { dataDir, accounts: [{ id: "dd", broker: "stubkey" }] }, env: {} });
  const cap = createCapturingLogger();
  const bus = createEventBus({ logger: cap.logger, topics: TOPICS });
  const clock = createManualClock(Date.parse("2026-10-20T03:30:00Z"));
  const { adapter, calls } = overnightBroker();
  const events = [];
  bus.on("account.status", (p) => events.push(p));
  const accounts = await createAccountManager(
    { config, logger: cap.logger, bus, clock, paths: { dataDir }, brokers: createStubRegistry({ stubkey: adapter }), secrets: createMemorySecretStore() },
    { policies: {}, watchFs: false },
  );
  managers.push(accounts);
  const scheduler = createScheduler({ config: { ratelimit: {} }, logger: createLogger({ level: "silent" }), bus, clock, accounts });
  /** What MarketDataService.callBroker does: schedule, then read the account's adapter and its CURRENT creds. */
  const read = async () => {
    const p = scheduler
      .schedule({ accountId: "dd", endpointClass: "quote" }, async () => {
        const a = accounts.adapter("dd");
        const creds = await accounts.creds("dd");
        return a.fetchLTP(creds);
      })
      .then((value) => ({ value }), (error) => ({ error })); // settle at once: no unhandled rejection while the clock moves
    await clock.advance(1500); // the broker's quote limit is about one a second; time must pass between reads
    const r = await p;
    if (r.error) throw r.error;
    return r.value;
  };
  return { accounts, scheduler, bus, clock, events, calls, read };
}

describe("an expired session overnight", () => {
  it("the first failed read logs the account out, later reads fail fast without touching the broker, and the new login works", async () => {
    const { accounts, clock, events, calls, read } = await boot();
    await accounts.connect("dd", { values: { clientId: "1", accessToken: "token-monday" } });
    expect(accounts.status("dd").state).toBe("connected");

    // Tuesday morning: the broker no longer accepts Monday's token.
    const first = await read().then(() => null, (e) => e);
    expect(first.code).toBe("UPSTREAM_AUTH"); // the adapter's own wording, tagged by the guard
    expect(calls).toEqual(["token-monday"]);
    expect(accounts.status("dd")).toMatchObject({ state: "expired" });
    expect(events.at(-1)).toMatchObject({ accountId: "dd", session: "expired" });

    // Every later read, over the next hours: SESSION_EXPIRED, and the broker is never called with the stale token.
    for (let i = 0; i < 5; i++) {
      const err = await read().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe("SESSION_EXPIRED");
      await clock.advance(3600_000);
    }
    expect(calls).toEqual(["token-monday"]);

    // The user logs in with a new token: reads work again, with the new token only.
    await accounts.connect("dd", { values: { clientId: "1", accessToken: "token-tuesday" } });
    expect(accounts.status("dd").state).toBe("connected");
    await expect(read()).resolves.toEqual({ status: "success", data: { last_price: 25010 } });
    expect(calls).toEqual(["token-monday", "token-tuesday"]);
  });

  it("the guarded adapter is what the manager hands out, and its own functions are untouched otherwise", async () => {
    const { accounts } = await boot();
    const a = accounts.adapter("dd");
    expect(a.id).toBe("stubkey");
    expect(a).toBe(guardAdapterErrors(a)); // already a guarded view: guarding again returns the same object
    expect(a.capabilities.auth.kind).toBe("apiKeyToken");
  });
});
