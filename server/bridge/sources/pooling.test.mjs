/**
 * Pooling consent: the service (accept, revoke, status, isPooled), the consent gate in AccountManager's
 * marketDataCandidates (blocked without consent, per-account, revoke at once, version bump, not-allowed) and the
 * pooling lines of `mc-bridge doctor`. No network; every test uses its own data folder.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountManager } from "../accounts/accountManager.mjs";
import { apiKeyAdapter, createCapturingLogger, createFakeClock, createMemorySecretStore, createStubRegistry } from "../accounts/__fixtures__/stubs.mjs";
import { loadConfig } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { BROKER_POLICIES } from "../ratelimit/brokerPolicies.mjs";
import {
  POOLING_NOTICE,
  POOLING_NOTICE_TEXT,
  POOLING_NOTICE_VERSION,
  consentFile,
  createPoolingService,
  isCurrentConsent,
  poolingDoctorChecks,
  readConsentRecord,
  writeConsentRecord,
} from "./pooling.mjs";

const OPT = { pooling: true, poolingWhenTermsUnknown: true };
const ACCOUNTS = [
  { id: "dhan-main", broker: "stubkey", label: "Main Dhan", holder: "self", marketData: OPT },
  { id: "dhan-two", broker: "stubkey", holder: "self", marketData: OPT },
  { id: "dhan-spouse", broker: "stubkey", holder: "spouse", marketData: OPT },
  { id: "kite-main", broker: "stubblock", holder: "self", marketData: OPT },
  { id: "kite-none", broker: "stubkey", marketData: OPT },
  { id: "paper", broker: "paper" },
];
/** stubkey: terms unknown (like every real broker today). stubblock: a broker whose policy says not-allowed. */
const POLICIES = { stubkey: { brokerId: "stubkey", pooling: "unknown" }, stubblock: { brokerId: "stubblock", pooling: "not-allowed" } };

const NOW = Date.parse("2026-11-08T09:30:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "mcb-pool-"));
const configFor = (dataDir, accounts = ACCOUNTS) => loadConfig({ raw: { dataDir, accounts }, env: {} }).config;

function service({ dataDir = tmp(), accounts = ACCOUNTS, policies = POLICIES, effective } = {}) {
  const config = configFor(dataDir, accounts);
  const cap = createCapturingLogger();
  const svc = createPoolingService({ config, paths: { dataDir }, clock: { now: () => NOW }, logger: cap.logger }, { policies, effective });
  return { svc, dataDir, cap, config };
}

const rejects = async (promise, fragment) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe("VALIDATION_FAILED");
    if (fragment) expect(JSON.stringify([err.detail, err.errors])).toMatch(fragment);
    return err;
  }
  throw new Error("expected a VALIDATION_FAILED refusal");
};

describe("the notice", () => {
  it("is one versioned constant that says every required thing in plain words", () => {
    expect(POOLING_NOTICE).toEqual({ version: POOLING_NOTICE_VERSION, text: POOLING_NOTICE_TEXT });
    const t = POOLING_NOTICE_TEXT;
    expect(t).toMatch(/spreads read-only market-data calls/);
    expect(t).toMatch(/your own broker accounts/);
    expect(t).toMatch(/No broker's published terms clearly allow this, and none clearly forbids it/);
    expect(t).toMatch(/You are responsible for following your brokers' terms/);
    expect(t).toMatch(/Orders always go through the account they belong to, from that account's own registered IP/);
    expect(t).toMatch(/turn this off at any time/);
    expect(t).toMatch(/Where a broker needs a paid data plan, every pooled account needs one/);
    expect(t).toMatch(/legal read/);
    expect(POOLING_NOTICE_VERSION).toMatch(/^pooling-\d+$/);
  });
});

describe("accepting consent", () => {
  it("stores { acceptedAt, version, accounts } in pooling/consent.json, atomically, readable only by the owner", async () => {
    const { svc, dataDir } = service();
    const record = await svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "dhan-two"] });
    expect(record).toEqual({ acceptedAt: "2026-11-08T09:30:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "dhan-two"] });
    const file = consentFile(dataDir);
    expect(file.endsWith(join("pooling", "consent.json"))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    // Atomic write: no temp files are left behind.
    expect(readdirSync(join(dataDir, "pooling"))).toEqual(["consent.json"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(svc.isPooled("dhan-main")).toBe(true);
    expect(svc.isPooled("dhan-spouse")).toBe(false);
  });

  it("refuses without the exact notice version, so the text must have been shown", async () => {
    const { svc, dataDir } = service();
    await rejects(svc.acceptConsent({ accounts: ["dhan-main"] }), /acknowledge/);
    await rejects(svc.acceptConsent({ acknowledge: "yes", accounts: ["dhan-main"] }), /acknowledge/);
    await rejects(svc.acceptConsent({ acknowledge: "pooling-0", accounts: ["dhan-main"] }), /acknowledge/);
    expect(existsSync(consentFile(dataDir))).toBe(false);
  });

  it("refuses an empty, malformed or repeated account list", async () => {
    const { svc } = service();
    const ack = POOLING_NOTICE_VERSION;
    await rejects(svc.acceptConsent({ acknowledge: ack }), /accounts/);
    await rejects(svc.acceptConsent({ acknowledge: ack, accounts: [] }), /accounts/);
    await rejects(svc.acceptConsent({ acknowledge: ack, accounts: "dhan-main" }), /accounts/);
    await rejects(svc.acceptConsent({ acknowledge: ack, accounts: ["Dhan Main"] }), /must be an account id/);
    await rejects(svc.acceptConsent({ acknowledge: ack, accounts: ["dhan-main", "dhan-main"] }), /listed twice/);
  });

  it("refuses unknown accounts", async () => {
    const { svc } = service();
    await rejects(svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "ghost-1"] }), /ghost-1 is not an account/);
  });

  it("refuses paper accounts", async () => {
    const { svc } = service();
    await rejects(svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "paper"] }), /paper account/);
  });

  it("refuses accounts of different holders", async () => {
    const { svc, dataDir } = service();
    await rejects(svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "dhan-spouse"] }), /never pooled \(self, spouse\)/);
    expect(existsSync(consentFile(dataDir))).toBe(false);
  });

  it("refuses an account with no holder", async () => {
    const { svc } = service();
    await rejects(svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["kite-none"] }), /has no holder/);
  });

  it("refuses a broker whose policy says pooling is not allowed", async () => {
    const { svc } = service();
    await rejects(svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "kite-main"] }), /says pooling is not allowed/);
  });

  it("replaces an earlier consent", async () => {
    const { svc } = service();
    await svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main"] });
    await svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-two"] });
    expect(svc.isPooled("dhan-main")).toBe(false);
    expect(svc.isPooled("dhan-two")).toBe(true);
  });
});

describe("revoking and versions", () => {
  it("revoke removes the consent at once and says whether there was one", async () => {
    const { svc, dataDir } = service();
    expect(await svc.revokeConsent()).toEqual({ revoked: false });
    await svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main"] });
    expect(svc.isPooled("dhan-main")).toBe(true);
    expect(await svc.revokeConsent()).toEqual({ revoked: true });
    expect(svc.isPooled("dhan-main")).toBe(false);
    expect(existsSync(consentFile(dataDir))).toBe(false);
    expect(svc.status().consent).toBeNull();
  });

  it("a consent for an older notice version counts for nothing until accepted again", async () => {
    const { svc, dataDir } = service();
    writeConsentRecord(dataDir, { acceptedAt: "2026-10-01T00:00:00.000Z", version: "pooling-0", accounts: ["dhan-main"] });
    expect(svc.isPooled("dhan-main")).toBe(false);
    expect(svc.status().consent).toMatchObject({ version: "pooling-0", accounts: ["dhan-main"], current: false });
    expect(isCurrentConsent({ version: "pooling-0" })).toBe(false);
    expect(isCurrentConsent({ version: POOLING_NOTICE_VERSION })).toBe(true);
    expect(isCurrentConsent(null)).toBe(false);
  });

  it("two service instances on one data folder always agree (the file is re-read when it changes)", async () => {
    const dataDir = tmp();
    const a = service({ dataDir }).svc;
    const b = service({ dataDir }).svc;
    expect(b.isPooled("dhan-main")).toBe(false);
    await a.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main"] });
    expect(b.isPooled("dhan-main")).toBe(true);
    await b.revokeConsent();
    expect(a.isPooled("dhan-main")).toBe(false);
  });

  it("ignores an unreadable or malformed consent file, warns once, and pools nothing", () => {
    const dataDir = tmp();
    const { svc, cap } = service({ dataDir });
    for (const text of ["{not json", JSON.stringify({ version: POOLING_NOTICE_VERSION, accounts: ["dhan-main"] }), JSON.stringify({ acceptedAt: "x", version: POOLING_NOTICE_VERSION, accounts: ["Bad Id"] })]) {
      writeConsentRecordRaw(dataDir, text);
      expect(svc.isPooled("dhan-main")).toBe(false);
    }
    expect(cap.text()).toMatch(/not a valid consent record/);
    expect(readConsentRecord(dataDir).problem).toMatch(/not a valid consent record/);
  });
});

function writeConsentRecordRaw(dataDir, text) {
  // A real consent file, then overwritten with arbitrary text (changes its size, so the service notices).
  writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T00:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["dhan-main"] });
  writeFileSync(consentFile(dataDir), `${text}${" ".repeat(Math.floor(Math.random() * 50))}`);
}

describe("status()", () => {
  it("groups real accounts by holder with the policy, the note, the data plan and whether each is pooled", async () => {
    const policies = { ...POLICIES, stubkey: { ...POLICIES.stubkey, poolingNote: "Silent on several accounts.", dataEntitlement: { value: "paid-for-live", note: "Rs 499 a month.", verified: true, source: "https://example.test/p" } } };
    const { svc } = service({ policies, effective: (id) => id === "dhan-main" });
    const empty = svc.status();
    expect(empty.consent).toBeNull();
    expect(empty.notice).toEqual({ version: POOLING_NOTICE_VERSION, text: POOLING_NOTICE_TEXT });
    expect(empty.groups.map((g) => [g.holder, g.accounts.map((a) => a.id)])).toEqual([
      ["self", ["dhan-main", "dhan-two", "kite-main"]],
      ["spouse", ["dhan-spouse"]],
      [null, ["kite-none"]],
    ]);
    const dhan = empty.groups[0].accounts[0];
    expect(dhan).toEqual({
      id: "dhan-main",
      label: "Main Dhan",
      broker: "stubkey",
      poolingPolicy: "unknown",
      poolingNote: "Silent on several accounts.",
      dataEntitlement: { value: "paid-for-live", note: "Rs 499 a month." },
      optedIn: true,
      consented: false,
      inPool: true,
    });
    expect(empty.groups[0].accounts[2]).toMatchObject({ id: "kite-main", poolingPolicy: "not-allowed", inPool: false });
    await svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "dhan-two"] });
    const after = svc.status();
    expect(after.consent).toEqual({ acceptedAt: "2026-11-08T09:30:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "dhan-two"], current: true });
    expect(after.groups[0].accounts.map((a) => a.consented)).toEqual([true, true, false]);
  });

  it("gives every account a label: the one the person set, else the account manager's, else the broker", () => {
    const { svc } = service();
    const labels = Object.fromEntries(svc.status().groups.flatMap((g) => g.accounts.map((a) => [a.id, a.label])));
    expect(labels).toEqual({ "dhan-main": "Main Dhan", "dhan-two": "stubkey", "dhan-spouse": "stubkey", "kite-main": "stubblock", "kite-none": "stubkey" });
    const config = configFor(tmp());
    const viaManager = createPoolingService({ config, accounts: { list: () => [{ id: "dhan-two", label: "Second Dhan" }] } }, { policies: POLICIES });
    expect(viaManager.status().groups[0].accounts.find((a) => a.id === "dhan-two").label).toBe("Second Dhan");
    const broken = createPoolingService({ config, accounts: { list: () => { throw new Error("down"); } } }, { policies: POLICIES });
    expect(broken.status().groups[0].accounts[1].label).toBe("stubkey");
  });

  it("never lists paper accounts, and says unknown for a broker with no researched plan or note", () => {
    const { svc } = service({ policies: {} });
    const ids = svc.status().groups.flatMap((g) => g.accounts.map((a) => a.id));
    expect(ids).not.toContain("paper");
    expect(svc.status().groups[0].accounts[0]).toMatchObject({ poolingPolicy: "unknown", dataEntitlement: { value: "unknown" } });
    expect(svc.status().groups[0].accounts[0].poolingNote).toMatch(/Not reviewed/);
  });

  it("works without a data folder (memory only)", async () => {
    const svc = createPoolingService({ config: { accounts: ACCOUNTS } }, { policies: POLICIES });
    expect(svc.isPooled("dhan-main")).toBe(false);
    await svc.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["dhan-main"] });
    expect(svc.isPooled("dhan-main")).toBe(true);
    await svc.revokeConsent();
    expect(svc.isPooled("dhan-main")).toBe(false);
  });
});

// ── The gate in AccountManager.marketDataCandidates ──

const managers = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
});

async function manager({ accounts, policies, dataDir = tmp() }) {
  const config = configFor(dataDir, accounts);
  const cap = createCapturingLogger();
  const mgr = await createAccountManager(
    { config, logger: cap.logger, bus: createEventBus({ logger: cap.logger }), clock: createFakeClock(), paths: { dataDir }, brokers: createStubRegistry({ stubkey: apiKeyAdapter(), stubblock: apiKeyAdapter({ id: "stubblock" }) }), secrets: createMemorySecretStore() },
    { policies, watchFs: false },
  );
  managers.push(mgr);
  for (const a of accounts.filter((x) => x.broker !== "paper")) await mgr.connect(a.id, { values: { accessToken: "t-123456" } });
  return { mgr, dataDir };
}

const POOL = ["dhan-main", "dhan-two"];
const consent = (mgr, accounts = POOL) => mgr.pooling.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts });
const unpinned = (mgr) => mgr.marketDataCandidates({ capability: "quotes" });
const flags = (mgr) => Object.fromEntries(mgr.list().map((a) => [a.id, a.pooling]));

describe("consent gate in marketDataCandidates", () => {
  it("blocks pooling without consent, even when everything else allows it", async () => {
    const { mgr } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    expect(unpinned(mgr)).toEqual(["dhan-main"]); // the single primary account, nothing spread
    expect(flags(mgr)).toMatchObject({ "dhan-main": false, "dhan-two": false });
  });

  it("pools the consented accounts once consent is given", async () => {
    const { mgr } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    await consent(mgr);
    expect(unpinned(mgr)).toEqual(["dhan-main", "dhan-two"]);
    expect(flags(mgr)).toMatchObject({ "dhan-main": true, "dhan-two": true });
  });

  it("consent for account A does not pool account B", async () => {
    const { mgr } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    await consent(mgr, ["dhan-main"]);
    expect(flags(mgr)).toMatchObject({ "dhan-main": true, "dhan-two": false });
    // Only A is in the pool, so the pool is A alone (B is not borrowed).
    expect(unpinned(mgr)).toEqual(["dhan-main"]);
    await consent(mgr, ["dhan-two"]);
    expect(flags(mgr)).toMatchObject({ "dhan-main": false, "dhan-two": true });
    expect(unpinned(mgr)).toEqual(["dhan-two"]);
  });

  it("revoking consent ends pooling at once, on the next read", async () => {
    const { mgr } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    await consent(mgr);
    expect(unpinned(mgr)).toEqual(["dhan-main", "dhan-two"]);
    await mgr.pooling.revokeConsent();
    expect(unpinned(mgr)).toEqual(["dhan-main"]);
    expect(flags(mgr)).toMatchObject({ "dhan-main": false, "dhan-two": false });
  });

  it("revoking from another instance on the same data folder ends pooling here at once", async () => {
    const { mgr, dataDir } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    await consent(mgr);
    const other = service({ dataDir }).svc;
    await other.revokeConsent();
    expect(unpinned(mgr)).toEqual(["dhan-main"]);
  });

  it("a notice version bump invalidates the old consent until it is accepted again", async () => {
    const { mgr, dataDir } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    writeConsentRecord(dataDir, { acceptedAt: "2026-10-01T00:00:00.000Z", version: "pooling-0", accounts: POOL });
    expect(unpinned(mgr)).toEqual(["dhan-main"]);
    expect(flags(mgr)).toMatchObject({ "dhan-main": false, "dhan-two": false });
    await consent(mgr);
    expect(unpinned(mgr)).toEqual(["dhan-main", "dhan-two"]);
  });

  it("a broker whose policy says not-allowed never pools, even with a consent file that lists it", async () => {
    const { mgr, dataDir } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    // The service refuses to record it, so write the file by hand to prove the gate does not rely on that.
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T09:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "kite-main"] });
    expect(flags(mgr)).toMatchObject({ "dhan-main": true, "kite-main": false });
    expect(unpinned(mgr)).toEqual(["dhan-main"]);
    await rejects(mgr.pooling.acceptConsent({ acknowledge: POOLING_NOTICE_VERSION, accounts: ["kite-main"] }), /not allowed/);
  });

  it("a broker with unknown terms still needs the poolingWhenTermsUnknown flag as well as consent", async () => {
    const accounts = ACCOUNTS.map((a) => (a.id === "dhan-two" ? { ...a, marketData: { pooling: true } } : a));
    const { mgr } = await manager({ accounts, policies: POLICIES });
    await consent(mgr);
    expect(flags(mgr)).toMatchObject({ "dhan-main": true, "dhan-two": false });
  });

  it("an account that did not opt in is not pooled by a consent that lists it", async () => {
    const accounts = ACCOUNTS.map((a) => (a.id === "dhan-two" ? { ...a, marketData: { pooling: false } } : a));
    const { mgr } = await manager({ accounts, policies: POLICIES });
    await consent(mgr);
    expect(flags(mgr)).toMatchObject({ "dhan-main": true, "dhan-two": false });
  });

  it("accounts of different holders still never pool together, consent or not", async () => {
    const { mgr, dataDir } = await manager({ accounts: ACCOUNTS, policies: POLICIES });
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T09:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["dhan-main", "dhan-two", "dhan-spouse"] });
    expect(unpinned(mgr)).toEqual(["dhan-main", "dhan-two"]);
  });

  it("every real broker's policy is unknown, so pooling needs consent AND poolingWhenTermsUnknown for them all", () => {
    for (const [id, p] of Object.entries(BROKER_POLICIES)) expect(p.pooling, id).toBe("unknown");
  });
});

// ── mc-bridge doctor ──

describe("poolingDoctorChecks", () => {
  const cfg = (accounts, dataDir = tmp()) => ({ dataDir, accounts: accounts.map((a) => ({ enabled: true, ...a })) });
  const messages = (checks) => checks.map((c) => `${c.level}: ${c.message}`);

  it("is quiet and ok when no account opts in", () => {
    expect(poolingDoctorChecks({ config: cfg([{ id: "a-1", broker: "zerodha", holder: "self", marketData: { pooling: false } }]) })).toEqual([{ level: "ok", check: "pooling", message: "Pooling is off (no account opts in)" }]);
  });

  it("warns when an account is set to pool but has no consent", () => {
    const checks = poolingDoctorChecks({ config: cfg([{ id: "zerodha-a", broker: "zerodha", holder: "self", marketData: OPT }, { id: "dhan-a", broker: "dhan", holder: "self", marketData: OPT }]) });
    expect(messages(checks).join("\n")).toMatch(/warn: zerodha-a, dhan-a are set to pool market data but you have not given consent/);
    expect(checks.every((c) => c.check === "pooling")).toBe(true);
  });

  it("warns for the accounts a consent does not cover, and for a consent from an older notice", () => {
    const dataDir = tmp();
    const accounts = [{ id: "zerodha-a", broker: "zerodha", holder: "self", marketData: OPT }, { id: "dhan-a", broker: "dhan", holder: "self", marketData: OPT }];
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T00:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["zerodha-a"] });
    expect(messages(poolingDoctorChecks({ config: cfg(accounts, dataDir) })).join("\n")).toMatch(/dhan-a is set to pool market data but not covered by your consent/);
    writeConsentRecord(dataDir, { acceptedAt: "2026-10-01T00:00:00.000Z", version: "pooling-0", accounts: ["zerodha-a", "dhan-a"] });
    const old = messages(poolingDoctorChecks({ config: cfg(accounts, dataDir) })).join("\n");
    expect(old).toMatch(/older notice \(pooling-0\)/);
    expect(old).toMatch(/not pooled/);
  });

  it("warns when pooled accounts need a paid data plan, naming the plan", () => {
    const dataDir = tmp();
    const accounts = [{ id: "zerodha-a", broker: "zerodha", holder: "self", marketData: OPT }, { id: "upstox-a", broker: "upstox", holder: "self", marketData: OPT }];
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T00:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["zerodha-a", "upstox-a"] });
    const text = messages(poolingDoctorChecks({ config: cfg(accounts, dataDir) })).join("\n");
    expect(text).toMatch(/zerodha-a \(zerodha\) needs a paid data plan for live data: .*Rs 500 a month/);
    expect(text).toMatch(/Every pooled account needs its own plan/);
    expect(text).not.toMatch(/upstox-a \(upstox\) needs a paid/);
  });

  it("warns when the pooled accounts belong to different holders or have none", () => {
    const dataDir = tmp();
    const accounts = [
      { id: "upstox-a", broker: "upstox", holder: "self", marketData: OPT },
      { id: "upstox-b", broker: "upstox", holder: "spouse", marketData: OPT },
      { id: "upstox-c", broker: "upstox", marketData: OPT },
    ];
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T00:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["upstox-a", "upstox-b", "upstox-c"] });
    const text = messages(poolingDoctorChecks({ config: cfg(accounts, dataDir) })).join("\n");
    expect(text).toMatch(/different holders \(self, spouse\)/);
    expect(text).toMatch(/upstox-c has no "holder"/);
  });

  it("warns that unknown terms need poolingWhenTermsUnknown, and that not-allowed never pools", () => {
    const dataDir = tmp();
    const accounts = [{ id: "upstox-a", broker: "upstox", holder: "self", marketData: { pooling: true } }, { id: "blocked-a", broker: "blocked", holder: "self", marketData: OPT }];
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T00:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["upstox-a"] });
    const text = messages(poolingDoctorChecks({ config: cfg(accounts, dataDir), policies: { ...BROKER_POLICIES, blocked: { brokerId: "blocked", pooling: "not-allowed" } } })).join("\n");
    expect(text).toMatch(/upstox-a \(upstox\): no broker terms are known to allow pooling, and "poolingWhenTermsUnknown" is not set/);
    expect(text).toMatch(/blocked-a: the policy for blocked says pooling is not allowed/);
  });

  it("says ok when consent covers every pooled account and nothing else is wrong", () => {
    const dataDir = tmp();
    const accounts = [{ id: "upstox-a", broker: "upstox", holder: "self", marketData: OPT }, { id: "angel-a", broker: "angelone", holder: "self", marketData: OPT }];
    writeConsentRecord(dataDir, { acceptedAt: "2026-11-08T00:00:00.000Z", version: POOLING_NOTICE_VERSION, accounts: ["upstox-a", "angel-a"] });
    expect(poolingDoctorChecks({ config: cfg(accounts, dataDir) })).toEqual([
      { level: "ok", check: "pooling", message: "2 account(s) pool market data under the consent given 2026-11-08T00:00:00.000Z" },
    ]);
  });

  it("ignores paper and disabled accounts", () => {
    const accounts = [{ id: "paper", broker: "paper", marketData: { pooling: true } }, { id: "zerodha-a", broker: "zerodha", holder: "self", enabled: false, marketData: OPT }];
    expect(poolingDoctorChecks({ config: cfg(accounts) })[0]).toMatchObject({ level: "ok", message: "Pooling is off (no account opts in)" });
  });
});
