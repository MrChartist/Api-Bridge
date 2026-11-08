/**
 * Pooling consent. Pooling spreads one person's read-only market-data calls over that person's own broker accounts.
 * No broker's published terms clearly allow or forbid it (docs/guides/rate-limits.md), so it is OFF until the person
 * reads the notice below and accepts it for named accounts.
 *
 * The consent record is { acceptedAt, version, accounts: [ids] }, kept in <dataDir>/pooling/consent.json (written
 * atomically, mode 0600). The AccountManager asks `isPooled(accountId)` on every unpinned read, so:
 *  - an account is pooled only if a consent for the CURRENT notice version lists it (a version bump invalidates the
 *    old consent until the person accepts the new text);
 *  - revoking removes the file, and pooling stops on the very next read;
 *  - the file is re-read whenever it changes on disk (another process, for example the CLI), so two service instances
 *    on one data folder always agree.
 *
 * The other rules (account opted in, same holder, broker not "not-allowed", `poolingWhenTermsUnknown`) stay in
 * AccountManager; this module only owns the consent and explains the state (`status()`).
 *
 * Nothing here talks to a broker. Orders are never pooled: they always go through the account they belong to.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileSignature } from "../auth/fsUtil.mjs";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { BridgeError } from "../core/errors.mjs";
import { BROKER_POLICIES, POOLING_NOT_REVIEWED } from "../ratelimit/brokerPolicies.mjs";

/** Bump this whenever POOLING_NOTICE_TEXT changes in substance: every earlier consent stops counting. */
export const POOLING_NOTICE_VERSION = "pooling-1";

/** The notice a person accepts, in plain words. One constant, shown as is by the dashboard and GET /v1/pooling. */
export const POOLING_NOTICE_TEXT = [
  "Pooling spreads read-only market-data calls (quotes, option chains, history) across your own broker accounts, so each account's rate limit is used instead of only one account's.",
  "No broker's published terms clearly allow this, and none clearly forbids it. The Bridge cannot tell you it is permitted.",
  "You are responsible for following your brokers' terms. A legal read is recommended before you turn this on.",
  "Orders always go through the account they belong to, from that account's own registered IP. Pooling never moves an order and never shares credentials.",
  "Only accounts of the same holder are pooled, and only the accounts you name here.",
  "Where a broker needs a paid data plan, every pooled account needs one.",
  "You can turn this off at any time. Revoking it stops pooling at once.",
].join("\n");

export const POOLING_NOTICE = Object.freeze({ version: POOLING_NOTICE_VERSION, text: POOLING_NOTICE_TEXT });

const PAPER_BROKER = "paper";
const MAX_ACCOUNTS = 64;

/** Where the consent record lives. */
export const consentFile = (dataDir) => join(dataDir, "pooling", "consent.json");

const isId = (x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{1,31}$/.test(x);

/** A stored record, or null when it is not a well-formed consent record. */
function parseRecord(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || typeof raw.acceptedAt !== "string" || typeof raw.version !== "string" || !Array.isArray(raw.accounts)) return null;
  if (!raw.accounts.every(isId)) return null;
  return Object.freeze({ acceptedAt: raw.acceptedAt, version: raw.version, accounts: Object.freeze([...raw.accounts]) });
}

/**
 * Read the consent record from a data folder without a service (doctor, tests). Never throws.
 * @param {string} dataDir
 * @returns {{ record: { acceptedAt: string, version: string, accounts: readonly string[] } | null, problem?: string }}
 */
export function readConsentRecord(dataDir) {
  try {
    const text = readFileSync(consentFile(dataDir), "utf8");
    const record = parseRecord(text);
    return record ? { record } : { record: null, problem: "the consent file is not a valid consent record, so it is ignored" };
  } catch (err) {
    if (err?.code === "ENOENT") return { record: null };
    return { record: null, problem: `the consent file could not be read (${err?.code ?? "error"}), so pooling stays off` };
  }
}

/** Write a record as is (tests and the service). */
export function writeConsentRecord(dataDir, record) {
  writeFileAtomic(consentFile(dataDir), `${JSON.stringify({ acceptedAt: record.acceptedAt, version: record.version, accounts: [...record.accounts] }, null, 2)}\n`);
}

/** Is this record a consent for the current notice? */
export const isCurrentConsent = (record, version = POOLING_NOTICE_VERSION) => Boolean(record) && record.version === version;

const policyPooling = (policies, brokerId) => {
  const p = policies?.[brokerId]?.pooling;
  return p === "allowed" || p === "not-allowed" ? p : "unknown";
};

const fail = (detail, errors) => new BridgeError("VALIDATION_FAILED", detail, errors ? { errors } : undefined);

/**
 * @typedef {object} PoolingServiceOptions
 * @property {Readonly<Record<string, any>>} [policies]            Broker policy table (default: the shipped one).
 * @property {() => Array<object>} [accountsOf]                    Configured accounts (default: deps.config.accounts).
 * @property {(accountId: string) => boolean} [effective]          Whether the account is pooled right now (default: asks deps.accounts).
 * @property {string} [dataDir]                                    Override the data folder (tests). No folder: memory only.
 */

/**
 * @param {{ config?: any, paths?: { dataDir?: string }, clock?: { now(): number }, logger?: any, accounts?: any }} deps
 * @param {PoolingServiceOptions} [options]
 */
export function createPoolingService(deps = {}, options = {}) {
  const dataDir = options.dataDir ?? deps.paths?.dataDir ?? deps.config?.dataDir ?? null;
  const policies = options.policies ?? BROKER_POLICIES;
  const now = () => (typeof deps.clock?.now === "function" ? deps.clock.now() : Date.now());
  const log = typeof deps.logger?.child === "function" ? deps.logger.child({ module: "pooling" }) : deps.logger;
  const accountsOf = options.accountsOf ?? (() => deps.config?.accounts ?? []);
  const effective =
    options.effective ??
    ((id) => {
      try {
        return deps.accounts.list().find((a) => a.id === id)?.pooling === true;
      } catch {
        return false;
      }
    });

  /** Cached record plus the file signature it was read at. Without a data folder the record lives in memory only. */
  let cache = { sig: undefined, record: null, problem: undefined };
  let warned = false;

  /** The stored record (a file changed by another process is picked up here). */
  function load() {
    if (!dataDir) return cache.record;
    let sig;
    try {
      sig = fileSignature(consentFile(dataDir));
    } catch {
      sig = "unreadable";
    }
    if (sig === cache.sig) return cache.record;
    const { record, problem } = sig === null ? { record: null } : readConsentRecord(dataDir);
    cache = { sig, record, problem };
    if (problem && !warned) {
      warned = true;
      log?.warn?.(`pooling: ${problem}`);
    }
    return record;
  }

  function store(record) {
    if (!dataDir) {
      cache = { sig: undefined, record, problem: undefined };
      return;
    }
    if (record) writeConsentRecord(dataDir, record);
    else rmSync(consentFile(dataDir), { force: true });
    cache = { sig: undefined, record: null, problem: undefined }; // re-read, so the signature is the file's own
    load();
  }

  const byId = (id) => accountsOf().find((a) => a.id === id);

  return {
    notice: POOLING_NOTICE,

    /** The consent record as stored (any version), or null. */
    consent: () => load(),

    /** True when a consent for the current notice lists this account. Synchronous: AccountManager calls it per read. */
    isPooled(accountId) {
      const record = load();
      return isCurrentConsent(record) && record.accounts.includes(accountId);
    },

    /**
     * What GET /v1/pooling reports: the consent, the notice, and the accounts grouped by holder with each broker's
     * pooling policy, data plan and whether the account is pooled right now.
     */
    status() {
      const record = load();
      const current = isCurrentConsent(record);
      const groups = new Map();
      for (const a of accountsOf()) {
        if (a.broker === PAPER_BROKER) continue;
        const holder = typeof a.holder === "string" && a.holder ? a.holder : null;
        if (!groups.has(holder)) groups.set(holder, []);
        const p = policies[a.broker];
        groups.get(holder).push({
          id: a.id,
          broker: a.broker,
          poolingPolicy: policyPooling(policies, a.broker),
          poolingNote: p?.poolingNote ?? POOLING_NOT_REVIEWED,
          dataEntitlement: { value: p?.dataEntitlement?.value ?? "unknown", note: p?.dataEntitlement?.note ?? "The data plan for this broker has not been researched." },
          optedIn: a.marketData?.pooling === true,
          consented: current && record.accounts.includes(a.id),
          inPool: effective(a.id) === true,
        });
      }
      return {
        consent: record ? { acceptedAt: record.acceptedAt, version: record.version, accounts: [...record.accounts], current } : null,
        groups: [...groups].map(([holder, accounts]) => ({ holder, accounts })),
        notice: { version: POOLING_NOTICE_VERSION, text: POOLING_NOTICE_TEXT },
      };
    },

    /**
     * Record the person's consent for the named accounts. `acknowledge` must equal the current notice version, which
     * proves the notice text was shown. Every account must exist, be a real (not paper) account of the same holder, and
     * its broker's policy must not be "not-allowed".
     * @param {{ acknowledge?: unknown, accounts?: unknown }} input
     * @param {{ merge?: boolean }} [opts]  merge: ADD these accounts to the consent already given for the current notice
     *   (what a key limited to some accounts may do) instead of replacing the whole record. The merged list must still
     *   share one holder; the error then does not name holders or accounts the caller did not send.
     */
    async acceptConsent(input, { merge = false } = {}) {
      const { acknowledge, accounts } = input ?? {};
      if (acknowledge !== POOLING_NOTICE_VERSION) {
        throw fail(`Read the pooling notice and send acknowledge: "${POOLING_NOTICE_VERSION}" to accept it.`, [{ path: "acknowledge", message: `must equal ${POOLING_NOTICE_VERSION}` }]);
      }
      if (!Array.isArray(accounts) || accounts.length === 0) throw fail("Name the accounts to pool, for example { accounts: [\"dhan-main\", \"zerodha-main\"] }.", [{ path: "accounts", message: "must be a non-empty list of account ids" }]);
      if (accounts.length > MAX_ACCOUNTS) throw fail(`At most ${MAX_ACCOUNTS} accounts can be named.`, [{ path: "accounts", message: `at most ${MAX_ACCOUNTS}` }]);
      const errors = [];
      const ids = [];
      accounts.forEach((id, i) => {
        if (!isId(id)) errors.push({ path: `accounts[${i}]`, message: "must be an account id" });
        else if (ids.includes(id)) errors.push({ path: `accounts[${i}]`, message: "is listed twice" });
        else ids.push(id);
      });
      if (errors.length) throw fail("The account list is not valid.", errors.slice(0, 10));

      const holders = new Set();
      for (const [i, id] of accounts.entries()) {
        const a = byId(id);
        if (!a) {
          errors.push({ path: `accounts[${i}]`, message: `${id} is not an account of this Bridge` });
          continue;
        }
        if (a.broker === PAPER_BROKER) {
          errors.push({ path: `accounts[${i}]`, message: `${id} is a paper account; paper accounts make no broker calls and are never pooled` });
          continue;
        }
        if (policyPooling(policies, a.broker) === "not-allowed") {
          errors.push({ path: `accounts[${i}]`, message: `${id}: the policy for ${a.broker} says pooling is not allowed` });
          continue;
        }
        if (typeof a.holder !== "string" || !a.holder) {
          errors.push({ path: `accounts[${i}]`, message: `${id} has no holder; set "holder" on the account in the config file first` });
          continue;
        }
        holders.add(a.holder);
      }
      if (errors.length) throw fail("These accounts cannot be pooled.", errors.slice(0, 10));
      let all = ids;
      if (merge) {
        const have = load();
        if (have && isCurrentConsent(have)) {
          for (const id of have.accounts) {
            const a = byId(id);
            if (!a) continue; // an account that left the config drops out of the merged consent
            if (!ids.includes(id)) all = [...all, id];
            if (typeof a.holder === "string" && a.holder) holders.add(a.holder);
          }
          if (holders.size > 1) throw fail("These accounts do not share one holder with the accounts already covered by the pooling consent, so they cannot be added. Accounts of different holders are never pooled.", [{ path: "accounts", message: "accounts must share one holder with the existing consent" }]);
        }
      }
      if (holders.size > 1) {
        throw fail(`Accounts of different holders are never pooled (${[...holders].sort().join(", ")}). Name accounts of one holder.`, [{ path: "accounts", message: "accounts must share one holder" }]);
      }

      const record = Object.freeze({ acceptedAt: new Date(now()).toISOString(), version: POOLING_NOTICE_VERSION, accounts: Object.freeze([...all]) });
      store(record);
      log?.info?.("pooling consent accepted", { version: record.version, accounts: record.accounts.length });
      return record;
    },

    /**
     * Remove the consent. Pooling ends on the next read.
     * With `accounts`, remove only those accounts from the consent (what a key limited to some accounts may do): the record
     * is deleted only when no account is left. Without it the whole record goes.
     * @param {{ accounts?: string[] }} [opts]
     * @returns {Promise<{ revoked: boolean, removed?: string[] }>}  revoked: whether anything was removed
     */
    async revokeConsent({ accounts } = {}) {
      const have = load();
      if (!have) return { revoked: false };
      if (!Array.isArray(accounts)) {
        store(null);
        log?.info?.("pooling consent revoked");
        return { revoked: true };
      }
      const removed = have.accounts.filter((id) => accounts.includes(id));
      if (!removed.length) return { revoked: false, removed: [] };
      const left = have.accounts.filter((id) => !accounts.includes(id));
      if (!left.length) store(null);
      else store(Object.freeze({ acceptedAt: have.acceptedAt, version: have.version, accounts: Object.freeze(left) }));
      log?.info?.("pooling consent revoked for some accounts", { removed: removed.length, left: left.length });
      return { revoked: true, removed };
    },
  };
}

// ── mc-bridge doctor ──

const PAID = new Set(["paid", "paid-for-live"]);

/**
 * The pooling lines of `mc-bridge doctor`. Pure: reads only the config, the policy table and the consent file.
 * @param {{ config: { dataDir: string, accounts: Array<any> }, policies?: Readonly<Record<string, any>>, consent?: ReturnType<typeof readConsentRecord> }} input
 * @returns {Array<{ level: "ok"|"warn", check: "pooling", message: string }>}
 */
export function poolingDoctorChecks({ config, policies = BROKER_POLICIES, consent }) {
  const out = [];
  const warn = (message) => out.push({ level: "warn", check: "pooling", message });
  const opted = (config.accounts ?? []).filter((a) => a.broker !== PAPER_BROKER && a.enabled !== false && a.marketData?.pooling === true);
  if (!opted.length) {
    out.push({ level: "ok", check: "pooling", message: "Pooling is off (no account opts in)" });
    return out;
  }
  const { record, problem } = consent ?? readConsentRecord(config.dataDir);
  if (problem) warn(`Pooling: ${problem}.`);
  const current = isCurrentConsent(record);
  if (record && !current) warn(`Pooling consent was given for an older notice (${record.version}); the current one is ${POOLING_NOTICE_VERSION}. Accept it again (dashboard, or PUT /v1/pooling/consent) or pooling stays off.`);

  const missing = opted.filter((a) => !(current && record.accounts.includes(a.id))).map((a) => a.id);
  if (missing.length) {
    warn(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} set to pool market data but ${record && current ? "not covered by your consent" : "you have not given consent"}, so ${missing.length === 1 ? "it is" : "they are"} not pooled. Accept the pooling notice for ${missing.length === 1 ? "it" : "them"} (dashboard, or PUT /v1/pooling/consent).`);
  }

  for (const a of opted) {
    const terms = policyPooling(policies, a.broker);
    if (terms === "not-allowed") warn(`${a.id}: the policy for ${a.broker} says pooling is not allowed, so it is never pooled.`);
    else if (terms === "unknown" && a.marketData?.poolingWhenTermsUnknown !== true) {
      warn(`${a.id} (${a.broker}): no broker terms are known to allow pooling, and "poolingWhenTermsUnknown" is not set, so it is not pooled. ${policies[a.broker]?.poolingNote ?? ""}`.trim());
    }
  }

  const noHolder = opted.filter((a) => !a.holder).map((a) => a.id);
  if (noHolder.length) warn(`${noHolder.join(", ")} ${noHolder.length === 1 ? "has" : "have"} no "holder", so ${noHolder.length === 1 ? "it is" : "they are"} never pooled.`);
  const holders = [...new Set(opted.filter((a) => a.holder).map((a) => a.holder))];
  if (holders.length > 1) {
    warn(`Accounts that pool belong to different holders (${holders.join(", ")}). Only one holder's accounts are ever pooled together, because a family member is a different user under your brokers' terms. Give pooled accounts one holder.`);
  }

  const paid = opted.filter((a) => PAID.has(policies[a.broker]?.dataEntitlement?.value));
  for (const a of paid) {
    const d = policies[a.broker].dataEntitlement;
    warn(`${a.id} (${a.broker}) needs a paid data plan for live data: ${d.note} Every pooled account needs its own plan.`);
  }

  if (!out.length) out.push({ level: "ok", check: "pooling", message: `${opted.length} account(s) pool market data under the consent given ${record.acceptedAt}` });
  return out;
}
