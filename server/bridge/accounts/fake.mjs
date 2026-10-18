/**
 * In-memory AccountManager for OTHER streams' tests (S3, S4, S5, S6, S7, S9, S10, S11). It satisfies
 * SERVICE_CONTRACTS.accounts exactly, needs no SecretStore, makes no broker call, and lets a test steer sessions.
 *
 *   import { createFakeAccountManager } from "../accounts/fake.mjs";
 *   const accounts = createFakeAccountManager({
 *     accounts: [
 *       { id: "dhan-main", broker: "dhan", adapter: myStubAdapter, creds: { clientId: "1", accessToken: "t" } },
 *       { id: "zerodha-2", broker: "zerodha", pooling: true, capabilities: ["ltp", "quotes"], state: "expired" },
 *       { id: "paper", broker: "paper" },
 *     ],
 *     bus,                       // optional: emits "account.status" on setState and honours "account.session_rejected"
 *     policies: { dhan: { pooling: "allowed" } },  // optional: broker policy table used by marketDataCandidates
 *   });
 *   accounts.setState("dhan-main", "expired");   // test helper
 *
 * Semantics follow the real manager: paper is always connected and has no adapter/creds; creds() throws
 * SESSION_EXPIRED unless the account is connected; marketDataCandidates() pools only accounts with pooling: true
 * AND broker policy "allowed", else returns the first connected capable account, in the given order.
 */
import { BridgeError } from "../core/errors.mjs";
import { BROKER_NAMES, PAPER_BROKER, adapterCapabilities, normalisePolicies, poolingFor } from "./brokerInfo.mjs";
import { PAPER_CAPABILITIES } from "./session.mjs";

/** Market-data and portfolio capabilities a fake broker account gets when none are given. */
export const DEFAULT_FAKE_CAPABILITIES = Object.freeze([
  "testConnection",
  "instruments",
  "expiries",
  "optionChain",
  "ltp",
  "quotes",
  "depth",
  "historical",
  "feed",
  "positions",
  "holdings",
  "funds",
  "orderBook",
  "tradeBook",
  "placeOrder",
  "modifyOrder",
  "cancelOrder",
]);

/**
 * @typedef {{ id: string, broker: string, label?: string, enabled?: boolean, pooling?: boolean, capabilities?: string[],
 *   state?: import("../core/contracts.mjs").SessionStateName, expiresAt?: string | null, creds?: Record<string, string>,
 *   adapter?: object, liveAllowedByConfig?: boolean, authKind?: string | null }} FakeAccount
 */

/**
 * @param {{ accounts?: FakeAccount[], bus?: { on: Function, emit: Function }, policies?: Record<string, any> }} [opts]
 */
export function createFakeAccountManager({ accounts = [], bus, policies = {} } = {}) {
  const table = normalisePolicies(policies);
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const a of accounts) {
    if (rows.has(a.id)) throw new Error(`fake accounts: duplicate id ${a.id}`);
    const paper = a.broker === PAPER_BROKER;
    rows.set(a.id, {
      id: a.id,
      broker: a.broker,
      label: a.label ?? (paper ? "Paper account" : BROKER_NAMES[a.broker] ?? a.broker),
      enabled: a.enabled !== false,
      pooling: Boolean(a.pooling),
      // Test double: a missing holder counts as "self" so simple fixtures pool; the real manager requires one.
      holder: typeof a.holder === "string" && a.holder ? a.holder : "self",
      capabilities: a.capabilities ? [...a.capabilities] : paper ? [...PAPER_CAPABILITIES] : a.adapter ? adapterCapabilities(a.adapter) : [...DEFAULT_FAKE_CAPABILITIES],
      state: paper ? "connected" : a.state ?? "connected",
      expiresAt: a.expiresAt ?? null,
      checkedAt: null,
      message: null,
      creds: a.creds ? { ...a.creds } : {},
      adapter: a.adapter ?? null,
      liveAllowedByConfig: Boolean(a.liveAllowedByConfig) && !paper,
      authKind: paper ? null : a.authKind ?? a.adapter?.capabilities?.auth?.kind ?? "apiKeyToken",
    });
  }
  /** Every contract call, for assertions: [method, ...args]. Secret-bearing inputs are recorded by key only. */
  const calls = [];

  const must = (id) => {
    const r = rows.get(id);
    if (!r) throw new BridgeError("ACCOUNT_NOT_FOUND", `No account with id ${id}.`);
    return r;
  };
  const sessionOf = (r) => ({ state: r.state, expiresAt: r.expiresAt, checkedAt: r.checkedAt, message: r.message });
  const effectivePooling = (r) => r.broker !== PAPER_BROKER && r.pooling && poolingFor(table, r.broker) === "allowed";
  const summary = (r) => ({
    id: r.id,
    broker: r.broker,
    label: r.label,
    enabled: r.enabled,
    session: sessionOf(r),
    liveAllowedByConfig: r.liveAllowedByConfig,
    pooling: effectivePooling(r),
    capabilities: [...r.capabilities],
    authKind: r.authKind,
  });

  function setState(id, state, { message = null, expiresAt } = {}) {
    const r = must(id);
    if (r.broker === PAPER_BROKER) return;
    const changed = r.state !== state || r.message !== message;
    r.state = state;
    r.message = message;
    if (expiresAt !== undefined) r.expiresAt = expiresAt;
    if (changed && bus && state !== "checking") {
      bus.emit("account.status", { accountId: id, broker: r.broker, session: state, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), ...(message ? { message } : {}) });
    }
  }

  const offRejected = bus?.on?.("account.session_rejected", (p) => {
    if (rows.get(p?.accountId)?.state === "connected") setState(p.accountId, "expired", { message: "The broker rejected the session. Log in again." });
  });

  return {
    list() {
      calls.push(["list"]);
      return [...rows.values()].map(summary);
    },
    get(id) {
      calls.push(["get", id]);
      return summary(must(id));
    },
    adapter(id) {
      calls.push(["adapter", id]);
      const r = must(id);
      if (r.broker === PAPER_BROKER || !r.adapter) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Account ${id} has no broker adapter in this fake.`);
      return r.adapter;
    },
    async creds(id) {
      calls.push(["creds", id]);
      const r = must(id);
      if (r.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account has no broker credentials.");
      if (r.state !== "connected" || !r.enabled) throw new BridgeError("SESSION_EXPIRED", `${id}: not connected`);
      return { ...r.creds };
    },
    status(id) {
      calls.push(["status", id]);
      return sessionOf(must(id));
    },
    async connect(id, input = {}) {
      calls.push(["connect", id, { values: Object.keys(input.values ?? {}), secrets: Object.keys(input.secrets ?? {}) }]);
      const r = must(id);
      if (r.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account needs no broker login.");
      Object.assign(r.creds, input.values ?? {}); // secrets are deliberately never kept, as in the real manager
      setState(id, "connected");
      return sessionOf(r);
    },
    async disconnect(id) {
      calls.push(["disconnect", id]);
      const r = must(id);
      if (r.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account has no broker session.");
      setState(id, "missing", { message: "Logged out.", expiresAt: null });
      return sessionOf(r);
    },
    async testConnection(id) {
      calls.push(["testConnection", id]);
      const r = must(id);
      if (r.broker === PAPER_BROKER) return { ok: true, message: "Paper account: no broker connection is needed." };
      return r.state === "connected" ? { ok: true, message: "Connected." } : { ok: false, message: `${id}: not connected` };
    },
    capabilities(id) {
      calls.push(["capabilities", id]);
      const r = must(id);
      return { capabilities: [...r.capabilities], policy: r.broker === PAPER_BROKER ? null : table[r.broker] ?? null };
    },
    marketDataCandidates({ capability, accountId, allowedAccounts } = {}) {
      calls.push(["marketDataCandidates", allowedAccounts === undefined ? { capability, accountId } : { capability, accountId, allowedAccounts }]);
      if (typeof capability !== "string" || !capability) return [];
      const mayUse = Array.isArray(allowedAccounts) ? (id) => allowedAccounts.includes(id) : () => true;
      if (accountId !== undefined && accountId !== null) {
        const r = rows.get(accountId);
        return r && mayUse(r.id) && r.broker !== PAPER_BROKER && r.enabled && r.capabilities.includes(capability) ? [r.id] : [];
      }
      const eligible = [...rows.values()].filter((r) => mayUse(r.id) && r.broker !== PAPER_BROKER && r.enabled && r.state === "connected" && r.capabilities.includes(capability));
      const pooled = eligible.filter(effectivePooling);
      if (pooled.length) return pooled.filter((r) => r.holder === pooled[0].holder).map((r) => r.id);
      return eligible.length ? [eligible[0].id] : [];
    },

    // ── test helpers (not part of the contract) ──
    /** Change an account's session state; emits account.status on the bus when given. */
    setState,
    /** Replace the credentials creds() returns. */
    setCreds(id, creds) {
      must(id).creds = { ...creds };
    },
    /** Every contract call made so far. */
    calls,
    /** Remove the bus subscription. */
    dispose() {
      offRejected?.();
    },
  };
}
