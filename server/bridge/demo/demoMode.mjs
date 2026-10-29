/**
 * Demo mode: `mc-bridge start --demo`, `"demo": true` in bridge.config.json, or MCB_DEMO=1.
 *
 * What changes (and why it can never touch a real broker or real money):
 *  - The broker registry holds ONLY the demo adapter (demoAdapter.mjs), which makes no network calls and has no order
 *    methods. No real adapter is loaded, so no request can reach a broker.
 *  - The accounts in the config file are replaced by four demo accounts: "demo" (sample market data, connected
 *    automatically), "demo-paper" (your paper account), and two more paper accounts for the family book (P1-13):
 *    "demo-paper-spouse" (holder demo-spouse) and "demo-paper-other" (holder demo-other, outside the family). Real
 *    accounts, their saved sessions and their paper books are left alone; the demo uses its own account ids.
 *  - Live trading is forced off (safety.liveTrading = false), whatever the config says.
 *  - Every HTTP response carries `X-MCB-Data: demo` and, for JSON bodies with a `meta` object, `meta.demo: true` and
 *    `meta.dataNotice`; /v1/health says `demo: true`; the dashboard shows a "Demo data" banner on every page.
 */
import { accountSchema } from "../core/config.mjs";
import { DEMO_BROKER_ID, DEMO_NOTICE, createDemoAdapter } from "./demoAdapter.mjs";

export { DEMO_BROKER_ID, DEMO_NOTICE };
export const DEMO_HEADER = "X-MCB-Data";
export const DEMO_MARKET_ACCOUNT = "demo";
export const DEMO_PAPER_ACCOUNT = "demo-paper";
/** The family-book sample accounts (docs/spec/p1-12-guard-participants.md §5.3): a spouse's and a non-family holder's. */
export const DEMO_SPOUSE_ACCOUNT = "demo-paper-spouse";
export const DEMO_OTHER_ACCOUNT = "demo-paper-other";
const DEMO_IDS = new Set([DEMO_MARKET_ACCOUNT, DEMO_PAPER_ACCOUNT, DEMO_SPOUSE_ACCOUNT, DEMO_OTHER_ACCOUNT]);
/** Added to "account not found" errors in demo mode, where the usual account ids from the docs do not exist. */
export const DEMO_ACCOUNT_HINT = `Demo mode has four accounts: "${DEMO_PAPER_ACCOUNT}" for paper orders and positions, "${DEMO_MARKET_ACCOUNT}" for market data, and two sample paper accounts for the family book, "${DEMO_SPOUSE_ACCOUNT}" and "${DEMO_OTHER_ACCOUNT}".`;

/** The accounts demo mode runs with (parsed, so defaults are filled in exactly as for a real config). */
export function demoAccounts() {
  return [
    accountSchema.parse({ id: DEMO_MARKET_ACCOUNT, broker: DEMO_BROKER_ID, label: "Demo market data", holder: "demo" }),
    accountSchema.parse({ id: DEMO_PAPER_ACCOUNT, broker: "paper", label: "Paper account", holder: "demo" }),
    accountSchema.parse({ id: DEMO_SPOUSE_ACCOUNT, broker: "paper", label: "Paper · spouse (sample)", holder: "demo-spouse" }),
    accountSchema.parse({ id: DEMO_OTHER_ACCOUNT, broker: "paper", label: "Paper · not family (sample)", holder: "demo-other" }),
  ];
}

/** Is demo mode asked for by the environment? */
export const demoFromEnv = (env = {}) => env.MCB_DEMO === "1" || env.MCB_DEMO === "true";

/**
 * Apply demo mode to a parsed (mutable) core config. Returns the warnings to show.
 * @param {any} cfg
 */
export function applyDemoConfig(cfg) {
  const replaced = cfg.accounts.filter((a) => !DEMO_IDS.has(a.id)).length;
  cfg.demo = true;
  cfg.accounts = demoAccounts();
  cfg.safety.liveTrading = false;
  const warnings = ["DEMO MODE: sample prices generated on this computer, not live market data. No broker is connected and live trading is off; orders go to the demo paper account."];
  if (replaced) warnings.push(`Demo mode ignores the ${replaced} account(s) in your config file while it runs; nothing about them is changed.`);
  return warnings;
}

/** A registry with only the demo adapter (same shape as server/brokers/registry.mjs). */
export function createDemoRegistry(opts) {
  const demo = createDemoAdapter(opts);
  return {
    has: (id) => id === DEMO_BROKER_ID,
    get(id) {
      if (id !== DEMO_BROKER_ID) throw new Error(`Demo mode serves only the demo broker; ${id} is not available. Restart without --demo to use real brokers.`);
      return demo;
    },
    list: () => [DEMO_BROKER_ID],
  };
}

/**
 * Rate limits for the demo broker. Generous enough for a dashboard and a few scripts, low enough that the rate-limit
 * views show real usage. Not a real broker's figures.
 */
/** The demo broker's limits are defined here, so they count as known (not conservative defaults). */
const DEMO_SOURCE = "server/bridge/demo/demoMode.mjs (sample limits)";
export const DEMO_POLICY = Object.freeze({
  brokerId: DEMO_BROKER_ID,
  limits: Object.freeze({
    order: Object.freeze({ perSecond: 10, verified: true, source: DEMO_SOURCE }),
    quote: Object.freeze({ perSecond: 10, perMinute: 400, verified: true, source: DEMO_SOURCE }),
    depth: Object.freeze({ perSecond: 10, verified: true, source: DEMO_SOURCE }),
    history: Object.freeze({ perSecond: 5, verified: true, source: DEMO_SOURCE }),
    // 32 a minute: the recorder gets 16 (its 50 %), enough for the default demo plan (14 index chains by REST and 5
    // stocks every 5 min: 15 a minute) but not for every index at 4 expiries (17), so the Data recorder page can show
    // "This account cannot carry all of it" and "Use what fits".
    chain: Object.freeze({ perSecond: 5, perMinute: 32, verified: true, source: DEMO_SOURCE }),
    portfolio: Object.freeze({ perSecond: 10, verified: true, source: DEMO_SOURCE }),
    master: Object.freeze({ perSecond: 1, verified: true, source: DEMO_SOURCE }),
    other: Object.freeze({ perSecond: 10, verified: true, source: DEMO_SOURCE }),
  }),
  groups: Object.freeze({ quoteFamily: Object.freeze({ perSecond: 10, perMinute: 400, verified: true, source: DEMO_SOURCE, classes: Object.freeze(["quote", "depth", "chain"]) }) }),
  maxQuoteBatch: 200,
  feed: Object.freeze({ maxConnections: 1, maxSubscriptions: 500 }),
  pooling: "not-allowed",
  maxModificationsPerOrder: null,
  notes: "Demo broker: sample limits so the rate-limit views have something to show. Not a real broker's figures.",
});

/**
 * Label a JSON handler result in demo mode: `meta.demo` and `meta.dataNotice` on { data, meta } bodies. Other
 * values are returned unchanged (the X-MCB-Data header still marks them).
 * @param {unknown} value
 */
export function labelDemoResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (value.meta && typeof value.meta === "object" && !Array.isArray(value.meta)) {
    return { ...value, meta: { ...value.meta, demo: true, dataNotice: DEMO_NOTICE } };
  }
  return value;
}

/**
 * SecretStore for demo mode: kept in memory only. Demo mode holds no real credential (the demo account's only saved
 * value is a placeholder), so it neither reads nor writes secrets.enc and never creates a master key.
 * Same contract as auth/secretStore.mjs (SERVICE_CONTRACTS.secrets).
 */
export function createDemoSecretStore() {
  const data = new Map();
  const check = (name) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._@-]{0,127}$/.test(name)) throw new Error("bad secret name");
  };
  return {
    async get(name) {
      check(name);
      return data.has(name) ? structuredClone(data.get(name)) : null;
    },
    async set(name, value) {
      check(name);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A secret value must be a JSON object.");
      data.set(name, structuredClone(value));
    },
    async delete(name) {
      check(name);
      return data.delete(name);
    },
    async list() {
      return [...data.keys()].sort();
    },
    status() {
      return { keySource: "none", path: "(demo mode: memory only)", entries: data.size };
    },
  };
}
