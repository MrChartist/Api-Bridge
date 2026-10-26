import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerError, SessionRequiredError } from "../../brokers/contract.mjs";
import { assertService, notImplementedService } from "../core/contracts.mjs";
import { loadConfig } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createAccountManager, secretName } from "./accountManager.mjs";
import { loadBrokerPolicies } from "./brokerInfo.mjs";
import {
  apiKeyAdapter,
  createCapturingLogger,
  createFakeClock,
  createMemorySecretStore,
  createStubRegistry,
  oauthAdapter,
  requestTokenAdapter,
  sessionAdapter,
} from "./__fixtures__/stubs.mjs";

const PASSWORD = "Pw-9f8e7d6c5b";
const TOTP = "482913";
const managers = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
});

async function setup({ accounts, adapters, policies = {}, secrets, safety, clock = createFakeClock(), options = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-acc-"));
  const { config } = loadConfig({ raw: { dataDir, accounts, ...(safety ? { safety } : {}) }, env: {} });
  const cap = createCapturingLogger();
  const bus = createEventBus({ logger: cap.logger });
  const events = [];
  bus.on("account.status", (p) => events.push(p));
  const store = secrets ?? createMemorySecretStore();
  const mgr = await createAccountManager(
    { config, logger: cap.logger, bus, clock, paths: { dataDir }, brokers: createStubRegistry(adapters), secrets: store },
    { policies, watchFs: false, ...options },
  );
  managers.push(mgr);
  return { mgr, store, bus, events, clock, cap, config, dataDir };
}

async function expectBridge(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected ${code}`);
}

describe("AccountManager: summaries", () => {
  it("meets the service contract and lists accounts in config order with no secrets", async () => {
    const { mgr } = await setup({
      accounts: [
        { id: "dhan-main", broker: "stubkey", label: "Main", live: { enabled: true }, holder: "self", marketData: { pooling: true } },
        { id: "angel", broker: "stubsess" },
        { id: "paper", broker: "paper" },
        { id: "ghost", broker: "nosuchbroker" },
      ],
      adapters: { stubkey: apiKeyAdapter(), stubsess: sessionAdapter() },
      policies: { stubkey: { brokerId: "stubkey", pooling: "allowed" } },
      safety: { liveTrading: true },
    });
    assertService("accounts", mgr);
    const list = mgr.list();
    expect(list.map((a) => a.id)).toEqual(["dhan-main", "angel", "paper", "ghost"]);
    expect(list[0]).toMatchObject({ broker: "stubkey", label: "Main", enabled: true, liveAllowedByConfig: true, pooling: true, authKind: "apiKeyToken" });
    expect(list[0].session).toEqual({ state: "missing", expiresAt: null, checkedAt: null, message: expect.any(String) });
    expect(list[0].capabilities).toEqual(["testConnection", "expiries", "optionChain", "ltp", "quotes", "depth"]);
    expect(list[1]).toMatchObject({ authKind: "sessionLogin", label: "stubsess", liveAllowedByConfig: false, pooling: false });
    expect(list[2]).toMatchObject({ broker: "paper", label: "Paper account", authKind: null, session: { state: "connected" } });
    expect(list[2].capabilities).toContain("placeOrder");
    expect(list[2].capabilities).not.toContain("quotes");
    expect(list[3].session.state).toBe("error");
    expect(mgr.get("angel").id).toBe("angel");
    await expectBridge(() => mgr.get("nope"), "ACCOUNT_NOT_FOUND");
    await expectBridge(() => mgr.status("nope"), "ACCOUNT_NOT_FOUND");
  });

  it("pooling needs both the account opt-in and broker policy 'allowed'", async () => {
    const { mgr } = await setup({
      accounts: [
        { id: "aa", broker: "stubkey", holder: "self", marketData: { pooling: true } },
        { id: "bb", broker: "stuboauth", holder: "self", marketData: { pooling: true } },
        { id: "cc", broker: "stubkey" },
      ],
      adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() },
      policies: { stubkey: { pooling: "allowed" }, stuboauth: { pooling: "unknown" } },
    });
    expect(mgr.list().map((a) => a.pooling)).toEqual([true, false, false]);
  });

  it("poolingWhenTermsUnknown pools a broker with unknown terms, never one whose terms say not-allowed", async () => {
    const opt = { pooling: true, poolingWhenTermsUnknown: true };
    const { mgr } = await setup({
      accounts: [
        { id: "aa", broker: "stubkey", holder: "self", marketData: opt },
        { id: "bb", broker: "stuboauth", holder: "self", marketData: opt },
        { id: "cc", broker: "stubkey", marketData: opt },
      ],
      adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() },
      policies: { stubkey: { pooling: "unknown" }, stuboauth: { pooling: "not-allowed" } },
    });
    // cc names no holder, so it is never pooled.
    expect(mgr.list().map((a) => a.pooling)).toEqual([true, false, false]);
  });

  it("the paper account has no adapter, creds or session to manage", async () => {
    const { mgr } = await setup({ accounts: [{ id: "paper", broker: "paper" }], adapters: {} });
    await expectBridge(() => mgr.adapter("paper"), "CAPABILITY_UNSUPPORTED");
    await expectBridge(mgr.creds("paper"), "CAPABILITY_UNSUPPORTED");
    await expectBridge(mgr.connect("paper", {}), "CAPABILITY_UNSUPPORTED");
    await expectBridge(mgr.disconnect("paper"), "CAPABILITY_UNSUPPORTED");
    expect(await mgr.testConnection("paper")).toMatchObject({ ok: true });
    expect(mgr.status("paper").state).toBe("connected");
    expect(mgr.capabilities("paper").policy).toBeNull();
  });
});

describe("AccountManager: key brokers", () => {
  it("connect saves values, verifies once, emits account.status, and creds() returns them", async () => {
    const adapter = apiKeyAdapter();
    const { mgr, store, events } = await setup({ accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: adapter } });
    await expectBridge(mgr.creds("dd"), "SESSION_EXPIRED");
    const state = await mgr.connect("dd", { values: { clientId: "1100", accessToken: "eyJhbGciOi.dhan-token-1234567" } });
    expect(state).toMatchObject({ state: "connected", expiresAt: null, message: null });
    expect(state.checkedAt).toMatch(/\+05:30$/);
    expect(adapter.seen).toHaveLength(1);
    const rec = store.data.get(secretName("dd"));
    expect(rec).toMatchObject({ values: { clientId: "1100", accessToken: "eyJhbGciOi.dhan-token-1234567" }, session: null, sessionExpiresAt: null });
    expect(events).toEqual([{ accountId: "dd", broker: "stubkey", session: "connected" }]);
    expect(await mgr.creds("dd")).toEqual({ clientId: "1100", accessToken: "eyJhbGciOi.dhan-token-1234567" });
    // A second connect with only a new token keeps the saved client id.
    await mgr.connect("dd", { values: { accessToken: "second-token-abcdef" } });
    expect(await mgr.creds("dd")).toEqual({ clientId: "1100", accessToken: "second-token-abcdef" });
  });

  it("a key the broker refuses is saved but the state is 'error', with secrets redacted from the message", async () => {
    const adapter = apiKeyAdapter({ testResult: { status: "error", message: "token tok-SECRET-999 is invalid" } });
    const { mgr, cap } = await setup({ accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: adapter } });
    const state = await mgr.connect("dd", { values: { clientId: "1", accessToken: "tok-SECRET-999" } });
    expect(state.state).toBe("error");
    expect(state.message).toContain("did not accept");
    expect(state.message).not.toContain("tok-SECRET-999");
    await expectBridge(mgr.creds("dd"), "SESSION_EXPIRED");
    expect(mgr.marketDataCandidates({ capability: "ltp" })).toEqual([]);
    expect(cap.text()).not.toContain("tok-SECRET-999");
  });

  it("a thrown verification error is redacted and also gives state 'error'", async () => {
    const adapter = apiKeyAdapter({ testThrows: new BrokerError("upstream said tok-ABCDEFG-1 bad", { code: "UPSTREAM_AUTH" }) });
    const { mgr } = await setup({ accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: adapter } });
    const state = await mgr.connect("dd", { values: { accessToken: "tok-ABCDEFG-1" } });
    expect(state.state).toBe("error");
    expect(state.message).not.toContain("tok-ABCDEFG-1");
  });

  it("refuses empty input, secret-looking values and disabled accounts", async () => {
    const { mgr, store } = await setup({ accounts: [{ id: "dd", broker: "stubkey" }, { id: "off", broker: "stubkey", enabled: false }], adapters: { stubkey: apiKeyAdapter() } });
    await expectBridge(mgr.connect("dd", {}), "VALIDATION_FAILED");
    await expectBridge(mgr.connect("dd", { values: { tradingPin: "1234" } }), "VALIDATION_FAILED");
    await expectBridge(mgr.connect("off", { values: { clientId: "1" } }), "VALIDATION_FAILED");
    await expectBridge(mgr.creds("off"), "SESSION_EXPIRED");
    expect(mgr.status("off")).toMatchObject({ state: "missing", message: expect.stringContaining("disabled") });
    expect(store.writes).toHaveLength(0);
  });

  it("oauth tokens expire at the adapter's stated time; disconnect drops the day's token and keeps the keys", async () => {
    const clock = createFakeClock(Date.parse("2026-10-19T03:30:00Z"));
    const { mgr, store, events } = await setup({ clock, accounts: [{ id: "zz", broker: "stuboauth" }], adapters: { stuboauth: oauthAdapter() } });
    const s = await mgr.connect("zz", { values: { apiKey: "kite-key", apiSecret: "kite-secret-123", accessToken: "kite-access-456" } });
    expect(s).toMatchObject({ state: "connected", expiresAt: "2026-10-20T06:00:00+05:30" });
    clock.set(Date.parse("2026-10-20T00:30:00Z"));
    expect(mgr.status("zz").state).toBe("expired");
    expect(events.at(-1)).toMatchObject({ accountId: "zz", session: "expired", expiresAt: "2026-10-20T06:00:00+05:30" });
    await expectBridge(mgr.creds("zz"), "SESSION_EXPIRED");
    const out = await mgr.disconnect("zz");
    expect(out.state).toBe("missing");
    expect(store.data.get("account:zz").values).toEqual({ apiKey: "kite-key", apiSecret: "kite-secret-123" });
    expect(events.at(-1)).toMatchObject({ session: "missing" });
    expect((await mgr.disconnect("zz")).state).toBe("missing"); // idempotent
  });

  it("requestTokenExchange brokers expire at the next IST midnight; apiKeyToken disconnect keeps values but logs out", async () => {
    const clock = createFakeClock(Date.parse("2026-10-19T03:30:00Z"));
    const { mgr, store } = await setup({ clock, accounts: [{ id: "ss", broker: "stubreq" }, { id: "dd", broker: "stubkey" }], adapters: { stubreq: requestTokenAdapter(), stubkey: apiKeyAdapter() } });
    expect((await mgr.connect("ss", { values: { userId: "FA1", apiKey: "k", apiSecret: "sec-12345", requestCode: "code-1" } })).expiresAt).toBe("2026-10-20T00:00:00+05:30");
    await mgr.connect("dd", { values: { clientId: "1", accessToken: "tok-123456" } });
    expect((await mgr.disconnect("dd")).state).toBe("missing");
    expect(store.data.get("account:dd").values).toEqual({ clientId: "1", accessToken: "tok-123456" });
    await expectBridge(mgr.creds("dd"), "SESSION_EXPIRED");
    expect((await mgr.connect("dd", {})).state).toBe("connected"); // reconnect with the saved values
  });
});

describe("AccountManager: session login (password + TOTP)", () => {
  it("secrets reach adapter.login() once and are never stored, returned or logged", async () => {
    const clock = createFakeClock();
    const adapter = sessionAdapter({ now: clock.now });
    const { mgr, store, cap, events } = await setup({ clock, accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    const state = await mgr.connect("angel", { values: { apiKey: "smart-api-key-1", clientId: "A123" }, secrets: { password: PASSWORD, totpCode: TOTP } });
    expect(state.state).toBe("connected");
    expect(adapter.logins).toEqual([{ apiKey: "smart-api-key-1", clientId: "A123", password: PASSWORD, totpCode: TOTP }]);
    // Nothing secret in the store, in any write.
    const stored = JSON.stringify(store.writes);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(TOTP);
    expect(stored).not.toMatch(/password|totp/i);
    expect(store.data.get("account:angel")).toMatchObject({ values: { apiKey: "smart-api-key-1", clientId: "A123" }, session: { sessionToken: "sess-token-abcdef123", feedToken: "feed-token-xyz789" } });
    // Nor in the state, events or logs.
    for (const text of [JSON.stringify(state), JSON.stringify(events), JSON.stringify(mgr.list()), cap.text()]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(TOTP);
    }
    const creds = await mgr.creds("angel");
    expect(creds).toEqual({ apiKey: "smart-api-key-1", clientId: "A123", sessionToken: "sess-token-abcdef123", feedToken: "feed-token-xyz789", sessionExpiresAt: String(clock.now() + 6 * 3600_000) });
    expect(JSON.stringify(creds)).not.toContain(PASSWORD);
    // creds() registers the session values with the logger, so they are masked if anything logs them.
    cap.logger.info("oops", { note: "value sess-token-abcdef123 leaked" });
    expect(cap.lines.at(-1)).not.toContain("sess-token-abcdef123");
  });

  it("a failed login saves nothing and its error never carries the typed secret", async () => {
    const adapter = sessionAdapter({ loginThrows: (c) => new BrokerError(`Invalid password ${c.password} for code ${c.totpCode}`, { code: "UPSTREAM_AUTH" }) });
    const { mgr, store, cap } = await setup({ accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    const err = await expectBridge(mgr.connect("angel", { values: { apiKey: "k1", clientId: "A1" }, secrets: { password: PASSWORD, totpCode: TOTP } }), "UPSTREAM_ERROR");
    expect(JSON.stringify({ d: err.detail, b: err.broker, m: err.message })).not.toContain(PASSWORD);
    expect(JSON.stringify({ d: err.detail, b: err.broker })).not.toContain(TOTP);
    expect(err.cause).toBeUndefined();
    expect(store.writes).toHaveLength(0);
    expect(mgr.status("angel").state).toBe("missing");
    expect(cap.text()).not.toContain(PASSWORD);
  });

  it("an input refusal from the adapter maps to VALIDATION_FAILED", async () => {
    const { BrokerInputError } = await import("../../brokers/contract.mjs");
    const adapter = sessionAdapter({ loginThrows: new BrokerInputError("Stub: missing clientId.") });
    const { mgr } = await setup({ accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    await expectBridge(mgr.connect("angel", { secrets: { password: PASSWORD, totpCode: TOTP } }), "VALIDATION_FAILED");
  });

  it("a login result that leaks the secret or has undeclared keys is refused and nothing is saved", async () => {
    for (const session of [{ sessionToken: `x${PASSWORD}x` }, { sessionToken: "ok-token-1234", other: "x" }]) {
      const adapter = sessionAdapter({ loginResult: { session, expiresAt: Date.now() + 3600_000 } });
      const { mgr, store } = await setup({ accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
      await expectBridge(mgr.connect("angel", { secrets: { password: PASSWORD, totpCode: TOTP } }), "UPSTREAM_ERROR");
      expect(store.writes).toHaveLength(0);
    }
  });

  it("limits login attempts to 5 a minute per account", async () => {
    const clock = createFakeClock();
    const adapter = sessionAdapter({ loginThrows: new BrokerError("nope", { code: "UPSTREAM_AUTH" }) });
    const { mgr } = await setup({ clock, accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    const input = { secrets: { password: PASSWORD, totpCode: TOTP } };
    for (let i = 0; i < 5; i += 1) await expectBridge(mgr.connect("angel", input), "UPSTREAM_ERROR");
    const err = await expectBridge(mgr.connect("angel", input), "RATE_LIMITED");
    expect(err.retryAfterMs).toBe(60_000);
    expect(adapter.logins).toHaveLength(5);
    clock.advance(60_001);
    await expectBridge(mgr.connect("angel", input), "UPSTREAM_ERROR");
  });

  it("two concurrent connects run one after the other", async () => {
    const clock = createFakeClock();
    let active = 0;
    let maxActive = 0;
    const adapter = sessionAdapter({
      loginResult: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { session: { sessionToken: "tok-concurrent-1" }, expiresAt: clock.now() + 3600_000 };
      },
    });
    const { mgr } = await setup({ clock, accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    const input = { secrets: { password: PASSWORD, totpCode: TOTP } };
    const [a, b] = await Promise.all([mgr.connect("angel", input), mgr.connect("angel", input)]);
    expect([a.state, b.state]).toEqual(["connected", "connected"]);
    expect(maxActive).toBe(1);
  });

  it("the session expires at the login's expiresAt (lazily and by timer)", async () => {
    const adapter = sessionAdapter({ loginResult: () => ({ session: { sessionToken: "tok-short-1" }, expiresAt: Date.now() + 40 }) });
    const { mgr, events } = await setup({ clock: { now: () => Date.now() }, accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    mgr.start();
    await mgr.connect("angel", { secrets: { password: PASSWORD, totpCode: TOTP } });
    expect(events.at(-1).session).toBe("connected");
    await vi.waitFor(() => expect(events.at(-1).session).toBe("expired"), { timeout: 2000, interval: 10 });
    mgr.stop();
  });
});

describe("AccountManager: rejection, test and reload", () => {
  it("account.session_rejected marks a connected account expired until the next connect", async () => {
    const { mgr, bus, events } = await setup({ accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: apiKeyAdapter() } });
    bus.emit("account.session_rejected", { accountId: "dd", broker: "stubkey", code: "SESSION_EXPIRED" }); // not connected: ignored
    expect(events).toHaveLength(0);
    await mgr.connect("dd", { values: { clientId: "1", accessToken: "tok-123456" } });
    bus.emit("account.session_rejected", { accountId: "dd", broker: "stubkey", code: "UPSTREAM_AUTH" });
    expect(mgr.status("dd")).toMatchObject({ state: "expired", message: expect.stringContaining("rejected") });
    expect(events.at(-1)).toMatchObject({ accountId: "dd", session: "expired" });
    await expectBridge(mgr.creds("dd"), "SESSION_EXPIRED");
    await mgr.reload(); // same record: still expired
    expect(mgr.status("dd").state).toBe("expired");
    await mgr.connect("dd", {});
    expect(mgr.status("dd").state).toBe("connected");
    bus.emit("account.session_rejected", { accountId: "unknown" }); // harmless
  });

  it("testConnection reports results and turns a session error into 'expired'", async () => {
    const clock = createFakeClock();
    const adapter = sessionAdapter({ now: clock.now });
    const { mgr } = await setup({ clock, accounts: [{ id: "angel", broker: "stubsess" }], adapters: { stubsess: adapter } });
    expect(await mgr.testConnection("angel")).toMatchObject({ ok: false });
    await mgr.connect("angel", { secrets: { password: PASSWORD, totpCode: TOTP } });
    expect(await mgr.testConnection("angel")).toEqual({ ok: true, message: "Session OK." });
    expect(adapter.tests.at(-1)).toMatchObject({ sessionToken: "sess-token-abcdef123" });
    expect(JSON.stringify(adapter.tests)).not.toContain(PASSWORD);
    adapter.testConnection = async () => {
      throw new SessionRequiredError("Stub: token rejected");
    };
    expect(await mgr.testConnection("angel")).toMatchObject({ ok: false, message: expect.stringContaining("rejected") });
    expect(mgr.status("angel").state).toBe("expired");
  });

  it("testConnection never throws for a broker failure and redacts the token", async () => {
    const adapter = apiKeyAdapter();
    const { mgr } = await setup({ accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: adapter } });
    await mgr.connect("dd", { values: { accessToken: "tok-REDACTME-1" } });
    adapter.testConnection = async () => {
      throw new BrokerError("network down while sending tok-REDACTME-1");
    };
    const r = await mgr.testConnection("dd");
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("tok-REDACTME-1");
    expect(mgr.status("dd").state).toBe("connected");
    adapter.testConnection = async () => ({ status: "error", message: "tok-REDACTME-1 bad" });
    expect((await mgr.testConnection("dd")).message).not.toContain("tok-REDACTME-1");
  });

  it("reload() picks up a session written by another process (the CLI) and emits account.status", async () => {
    const store = createMemorySecretStore();
    const { mgr, events } = await setup({ secrets: store, accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: apiKeyAdapter() } });
    expect(mgr.status("dd").state).toBe("missing");
    store.data.set("account:dd", { values: { clientId: "1", accessToken: "cli-token-123" }, session: null, sessionExpiresAt: null, connectedAt: new Date().toISOString(), rev: "cli-1" });
    await mgr.reload();
    expect(mgr.status("dd").state).toBe("connected");
    expect(events.at(-1)).toMatchObject({ accountId: "dd", session: "connected" });
    store.data.delete("account:dd");
    await mgr.reload();
    expect(mgr.status("dd").state).toBe("missing");
  });

  it("start() watches the secrets file and re-reads the store when it changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-watch-"));
    const path = join(dir, "secrets.enc");
    writeFileSync(path, "v1");
    const store = createMemorySecretStore({ path });
    const { mgr } = await setup({ secrets: store, accounts: [{ id: "dd", broker: "stubkey" }], adapters: { stubkey: apiKeyAdapter() }, options: { pollMs: 20 } });
    mgr.start();
    store.data.set("account:dd", { values: { accessToken: "cli-token-xyz" }, rev: "cli-2" });
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(path, "v2-longer");
    await vi.waitFor(() => expect(mgr.status("dd").state).toBe("connected"), { timeout: 3000, interval: 20 });
    mgr.stop();
  });

  it("boots with a stub SecretStore: accounts read as missing and one warning is logged", async () => {
    const { mgr, cap } = await setup({ secrets: notImplementedService("secrets"), accounts: [{ id: "dd", broker: "stubkey" }, { id: "ee", broker: "stubkey" }], adapters: { stubkey: apiKeyAdapter() } });
    expect(mgr.list().map((a) => a.session.state)).toEqual(["missing", "missing"]);
    expect(cap.lines.filter((l) => l.includes("could not read saved broker sessions"))).toHaveLength(1);
    await expectBridge(mgr.connect("dd", { values: { clientId: "1" } }), "NOT_IMPLEMENTED");
    mgr.start(); // falls back to <dataDir>/secrets.enc for watching
    mgr.stop();
  });
});

describe("AccountManager: marketDataCandidates", () => {
  const accounts = [
    { id: "k1", broker: "stubkey", holder: "self", marketData: { pooling: true } },
    { id: "o1", broker: "stuboauth", holder: "self", marketData: { pooling: true } },
    { id: "k2", broker: "stubkey", holder: "self", marketData: { pooling: true } },
    { id: "k3", broker: "stubkey" },
    { id: "off", broker: "stubkey", enabled: false, holder: "self", marketData: { pooling: true } },
    { id: "paper", broker: "paper" },
  ];
  const connectAll = async (mgr) => {
    for (const id of ["k1", "o1", "k2", "k3"]) await mgr.connect(id, { values: id.startsWith("o") ? { apiKey: "k", accessToken: "t-123456" } : { accessToken: "t-123456" } });
  };

  it("pools across opted-in accounts whose broker allows it, in config order", async () => {
    const { mgr } = await setup({ accounts, adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() }, policies: { stubkey: { pooling: "allowed" } } });
    expect(mgr.marketDataCandidates({ capability: "quotes" })).toEqual([]);
    await connectAll(mgr);
    expect(mgr.marketDataCandidates({ capability: "quotes" })).toEqual(["k1", "k2"]);
    // historical: only the oauth stub declares it, and its broker does not allow pooling -> single primary.
    expect(mgr.marketDataCandidates({ capability: "historical" })).toEqual(["o1"]);
    expect(mgr.marketDataCandidates({ capability: "feed" })).toEqual([]);
    expect(mgr.marketDataCandidates({ capability: "" })).toEqual([]);
    expect(mgr.marketDataCandidates()).toEqual([]);
  });

  it("without pooling permission returns only the first connected capable account", async () => {
    const { mgr, bus } = await setup({ accounts, adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() }, policies: {} });
    await connectAll(mgr);
    expect(mgr.marketDataCandidates({ capability: "ltp" })).toEqual(["k1"]);
    bus.emit("account.session_rejected", { accountId: "k1", broker: "stubkey", code: "UPSTREAM_AUTH" });
    expect(mgr.marketDataCandidates({ capability: "ltp" })).toEqual(["o1"]);
  });

  it("never pools accounts of different holders, and never pools an account without a holder", async () => {
    const family = [
      { id: "mine", broker: "stubkey", holder: "self", marketData: { pooling: true } },
      { id: "spouse", broker: "stubkey", holder: "spouse", marketData: { pooling: true } },
      { id: "nolabel", broker: "stubkey", marketData: { pooling: true } },
      { id: "mine2", broker: "stubkey", holder: "self", marketData: { pooling: true } },
    ];
    const { mgr } = await setup({ accounts: family, adapters: { stubkey: apiKeyAdapter() }, policies: { stubkey: { pooling: "allowed" } } });
    for (const a of family) await mgr.connect(a.id, { values: { accessToken: "t-123456" } });
    expect(mgr.marketDataCandidates({ capability: "quotes" })).toEqual(["mine", "mine2"]);
    expect(mgr.list().map((a) => [a.id, a.pooling])).toEqual([["mine", true], ["spouse", true], ["nolabel", false], ["mine2", true]]);
    // A key limited to the spouse's account gets only that account, never the other holder's pool.
    expect(mgr.marketDataCandidates({ capability: "quotes", allowedAccounts: ["spouse"] })).toEqual(["spouse"]);
  });

  it("keeps unpinned reads inside the caller's allowed accounts and never borrows the primary", async () => {
    const { mgr } = await setup({ accounts, adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() }, policies: { stubkey: { pooling: "allowed" } } });
    await connectAll(mgr);
    expect(mgr.marketDataCandidates({ capability: "quotes", allowedAccounts: ["k2"] })).toEqual(["k2"]);
    expect(mgr.marketDataCandidates({ capability: "quotes", allowedAccounts: ["k3"] })).toEqual(["k3"]);
    expect(mgr.marketDataCandidates({ capability: "quotes", allowedAccounts: ["paper"] })).toEqual([]);
    expect(mgr.marketDataCandidates({ capability: "quotes", allowedAccounts: [] })).toEqual([]);
    expect(mgr.marketDataCandidates({ capability: "quotes", allowedAccounts: "*" })).toEqual(["k1", "k2"]);
    expect(mgr.marketDataCandidates({ capability: "ltp", accountId: "k1", allowedAccounts: ["k2"] })).toEqual([]);
  });

  it("a pinned account is returned when it has the capability, whatever its pooling", async () => {
    const { mgr } = await setup({ accounts, adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() } });
    expect(mgr.marketDataCandidates({ capability: "ltp", accountId: "k3" })).toEqual(["k3"]);
    expect(mgr.marketDataCandidates({ capability: "historical", accountId: "k3" })).toEqual([]);
    expect(mgr.marketDataCandidates({ capability: "ltp", accountId: "paper" })).toEqual([]);
    expect(mgr.marketDataCandidates({ capability: "ltp", accountId: "off" })).toEqual([]);
    expect(mgr.marketDataCandidates({ capability: "ltp", accountId: "nope" })).toEqual([]);
  });

  it("capabilities() returns the declared list and the broker policy", async () => {
    const policy = { brokerId: "stubkey", pooling: "allowed", maxQuoteBatch: 1000 };
    const { mgr } = await setup({ accounts, adapters: { stubkey: apiKeyAdapter(), stuboauth: oauthAdapter() }, policies: [policy] });
    expect(mgr.capabilities("k1")).toEqual({ capabilities: ["testConnection", "expiries", "optionChain", "ltp", "quotes", "depth"], policy });
    expect(mgr.capabilities("o1").policy).toBeNull();
    expect(mgr.brokerPolicy("stubkey")).toEqual(policy);
  });
});

describe("broker policy loading", () => {
  it("a missing S3 module means every broker is 'unknown', silently", async () => {
    const warn = vi.fn();
    const err = Object.assign(new Error("Cannot find module '/x/ratelimit/brokerPolicies.mjs'"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(await loadBrokerPolicies({ warn }, async () => Promise.reject(err))).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("a broken module is logged and also gives an empty table", async () => {
    const warn = vi.fn();
    expect(await loadBrokerPolicies({ warn }, async () => Promise.reject(new SyntaxError("bad")))).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reads BROKER_POLICIES as an object or an array", async () => {
    expect(await loadBrokerPolicies(undefined, async () => ({ BROKER_POLICIES: { dhan: { pooling: "allowed" } } }))).toEqual({ dhan: { pooling: "allowed" } });
    expect(await loadBrokerPolicies(undefined, async () => ({ BROKER_POLICIES: [{ brokerId: "dhan", pooling: "not-allowed" }] }))).toEqual({ dhan: { brokerId: "dhan", pooling: "not-allowed" } });
  });

  it("the real loader works whether or not S3 has shipped its table", async () => {
    const table = await loadBrokerPolicies({ warn: () => {} });
    expect(typeof table).toBe("object");
  });
});
