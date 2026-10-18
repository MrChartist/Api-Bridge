/**
 * Test fixtures for stream S1: a recording in-memory SecretStore, stub broker adapters for each auth kind, a
 * registry over them, and a capturing logger. No network, no disk (except where a test passes a real path).
 */
import { SessionRequiredError, BrokerError } from "../../../brokers/contract.mjs";
import { notImplementedService } from "../../core/contracts.mjs";
import { createLogger } from "../../core/logger.mjs";

/**
 * In-memory SecretStore that satisfies SERVICE_CONTRACTS.secrets and records every write (deep copies), so tests
 * can assert that no typed secret ever reached the store.
 * @param {{ path?: string, initial?: Record<string, object> }} [opts]
 */
export function createMemorySecretStore({ path = "/nonexistent/secrets.enc", initial = {} } = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const writes = [];
  return {
    data,
    writes,
    async get(name) {
      return data.has(name) ? structuredClone(data.get(name)) : null;
    },
    async set(name, value) {
      writes.push({ name, value: structuredClone(value) });
      data.set(name, structuredClone(value));
    },
    async delete(name) {
      return data.delete(name);
    },
    async list() {
      return [...data.keys()];
    },
    status() {
      return { keySource: "none", path, entries: data.size };
    },
  };
}

/** A logger whose JSON lines are kept in `lines` (as raw strings, i.e. exactly what would be written). */
export function createCapturingLogger() {
  const lines = [];
  const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  return { logger, lines, text: () => lines.join("\n") };
}

/** Clock that tests move by hand. */
export function createFakeClock(start = Date.parse("2026-10-19T03:30:00Z")) {
  let t = start;
  return { now: () => t, set: (v) => (t = v), advance: (ms) => (t += ms) };
}

const baseCaps = {
  testConnection: true,
  expiries: true,
  optionChain: true,
  ltp: true,
  quotes: true,
  depth: true,
};
const basics = {
  fetchExpiryList: async () => ({ status: "success", data: [] }),
  fetchOptionChain: async () => ({ status: "success", data: {} }),
  fetchLTP: async () => ({ status: "success", data: 0 }),
  fetchQuotes: async () => [],
  fetchDepth: async () => ({}),
};

/**
 * apiKeyToken adapter (Dhan-like). `testResult` / `testThrows` steer testConnection.
 * @param {{ id?: string, testResult?: object, testThrows?: Error, caps?: object }} [o]
 */
export function apiKeyAdapter(o = {}) {
  const seen = [];
  return {
    id: o.id ?? "stubkey",
    credentialFields: ["clientId", "accessToken"],
    capabilities: { auth: { kind: "apiKeyToken" }, ...baseCaps, ...(o.caps ?? {}) },
    seen,
    ...basics,
    async testConnection(creds) {
      seen.push({ ...creds });
      if (o.testThrows) throw o.testThrows;
      return o.testResult ?? { status: "success", message: "Connected to stub." };
    },
  };
}

/** oauthRedirect adapter with a stated token expiry. */
export function oauthAdapter(o = {}) {
  return {
    ...apiKeyAdapter(o),
    id: o.id ?? "stuboauth",
    credentialFields: ["apiKey", "apiSecret", "accessToken"],
    capabilities: { auth: { kind: "oauthRedirect", tokenExpiry: "06:00 IST next day" }, ...baseCaps, historical: true },
    fetchHistorical: async () => [],
  };
}

/** requestTokenExchange adapter (Noren-like). */
export function requestTokenAdapter(o = {}) {
  return {
    ...apiKeyAdapter(o),
    id: o.id ?? "stubreq",
    credentialFields: ["userId", "apiKey", "apiSecret", "requestCode", "accessToken"],
    capabilities: { auth: { kind: "requestTokenExchange" }, ...baseCaps },
  };
}

/**
 * sessionLogin adapter (Angel-like). login() records what it received (tests check secrets reached it once) and
 * returns `loginResult` (default: a valid session) or throws `loginThrows`.
 */
export function sessionAdapter(o = {}) {
  const logins = [];
  const tests = [];
  return {
    id: o.id ?? "stubsess",
    credentialFields: ["apiKey", "clientId"],
    capabilities: {
      auth: {
        kind: "sessionLogin",
        loginFields: [
          { key: "password", label: "PIN / MPIN", kind: "secret" },
          { key: "totpCode", label: "6-digit TOTP code", kind: "totp" },
        ],
        sessionFields: ["sessionToken", "feedToken"],
      },
      ...baseCaps,
    },
    logins,
    tests,
    ...basics,
    async login(creds) {
      logins.push({ ...creds });
      if (o.loginThrows) throw typeof o.loginThrows === "function" ? o.loginThrows(creds) : o.loginThrows;
      if (o.loginResult) return typeof o.loginResult === "function" ? o.loginResult(creds) : o.loginResult;
      return { session: { sessionToken: "sess-token-abcdef123", feedToken: "feed-token-xyz789" }, expiresAt: (o.now ?? Date.now)() + 6 * 3600_000 };
    },
    async testConnection(creds) {
      tests.push({ ...creds });
      if (o.testThrows) throw o.testThrows;
      if (!creds.sessionToken) throw new SessionRequiredError("Stub: not logged in.");
      return { status: "success", message: "Session OK." };
    },
  };
}

/** Registry over a map of adapters (same shape as server/brokers/registry.mjs). */
export function createStubRegistry(adapters) {
  return {
    has: (id) => Object.prototype.hasOwnProperty.call(adapters, id),
    get: (id) => {
      if (!adapters[id]) throw new Error(`Unknown broker: ${id}`);
      return adapters[id];
    },
    list: () => Object.keys(adapters),
  };
}

export { SessionRequiredError, BrokerError, notImplementedService };
