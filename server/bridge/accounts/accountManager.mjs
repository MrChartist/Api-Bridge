/**
 * AccountManager — stream S1 (docs/STREAMS.md §S1). The contract (methods, argument and return types, rules) is
 * SERVICE_CONTRACTS.accounts in ../core/contracts.mjs; app.mjs refuses to boot an implementation that misses a method.
 *
 * What it does
 *  - Builds account summaries from config.accounts and the broker registry (deps.brokers). The virtual "paper"
 *    broker is an account with no adapter: always connected, no market-data capabilities (it borrows pooled data),
 *    and creds()/adapter() throw CAPABILITY_UNSUPPORTED.
 *  - connect(): validates `values` against the adapter's credentialFields and `secrets` against its login fields.
 *    For sessionLogin brokers the secrets (password/PIN + the current TOTP code) go to adapter.login() exactly once
 *    and are then dropped: they are never stored, cached, logged, registered with the logger or echoed in errors.
 *    Only the adapter's declared auth.sessionFields are kept. Everything kept lives in deps.secrets (encrypted at
 *    rest by S2) under "account:<id>"; see session.mjs for the record shape. Other auth kinds save the typed keys
 *    and verify them with one adapter.testConnection() call (requestTokenExchange adapters do their documented
 *    code exchange inside that call).
 *  - Session state machine per account: missing -> (checking) -> connected -> expired | error, with a daily expiry
 *    (adapter login result, auth.tokenExpiry, or the next IST midnight) checked lazily on every read and by a
 *    timer. Emits "account.status" on every visible change. "account.session_rejected" (from the scheduler) marks
 *    the account expired until the next connect.
 *  - marketDataCandidates(): the accounts that may serve an unpinned market-data read (opt-in AND the broker policy
 *    from S3 says pooling is "allowed" AND the account names its `holder`; only accounts of ONE holder are pooled,
 *    because a family member is a different user under the brokers' personal-use terms), else the single primary
 *    account, in config order. A caller's account restriction (`allowedAccounts`) is applied first, so a key limited
 *    to some accounts never spends another account's market-data entitlement or rate budget.
 *  - addAccount()/removeAccount() (POST/DELETE /v1/accounts, after routes.mjs saved the change to the config file)
 *    start or stop using an account without a restart, through the accounts list the app shares with its services.
 *  - Re-reads SecretStore when its file changes (e.g. the `mc-bridge` CLI in another process), with fs.watch plus a
 *    slow stat poll as a fallback. start()/stop() (called by module.mjs) run the watcher and expiry timers.
 *
 * The manager keeps only non-secret facts in memory (record stamp, expiry, whether a session exists). Credentials
 * are read from SecretStore on each creds() call and handed straight to the caller.
 */
import { randomUUID } from "node:crypto";
import { statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SessionRequiredError, normaliseError as contractNormaliseError, redactSecrets } from "../../brokers/contract.mjs";
import { checkLoginResult } from "../../brokers/contractShapes.mjs";
import { createLoginRateLimiter } from "../../brokers/sessionLogin.mjs";
import { liveAllowedByConfig } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { isSecretFieldName } from "../core/logger.mjs";
import { BROKER_NAMES, PAPER_BROKER, adapterCapabilities, loadBrokerPolicies, normalisePolicies, poolingFor } from "./brokerInfo.mjs";
import {
  PAPER_CAPABILITIES,
  deriveState,
  describeRecord,
  mergeValues,
  pickSessionFields,
  sessionExpiryFor,
  toIstIso,
  validateConnectInput,
} from "./session.mjs";

/** SecretStore entry name for an account. */
export const secretName = (accountId) => `account:${accountId}`;

const MAX_TIMER_MS = 2_147_000_000; // setTimeout's ceiling is 2^31-1 ms (~24.8 days)
export const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_ATTEMPTS_PER_WINDOW = 5;

/**
 * @typedef {object} AccountManagerOptions
 * @property {Record<string, any> | any[]} [policies]   Broker policy table (tests). Default: S3's brokerPolicies.mjs.
 * @property {() => Promise<any>} [importPolicies]       Test seam for loading the policy module.
 * @property {number} [pollMs]                           Stat-poll interval for the secrets file (default 5000).
 * @property {boolean} [watchFs]                         Use fs.watch as well as polling (default true).
 * @property {{ take(key: string, now?: number): boolean }} [loginLimiter]  Default: 5 login attempts/min per account.
 */

/** Is this broker error a "your session is no good" error? */
export function isSessionError(err) {
  return err instanceof SessionRequiredError || err?.code === "SESSION_LOGIN_REQUIRED" || err?.code === "UPSTREAM_AUTH" || err?.code === "SESSION_EXPIRED";
}

/** Values whose field name looks secret (API secret, access token ...), for message redaction. */
function secretLookingValues(obj) {
  return Object.entries(obj ?? {})
    .filter(([k, v]) => typeof v === "string" && v.length >= 4 && isSecretFieldName(k))
    .map(([, v]) => v);
}

/**
 * Turn a broker login/test failure into a BridgeError whose text cannot carry a typed secret or saved token.
 * A refused login is not "session expired": it maps to VALIDATION_FAILED (we refused the input) or an upstream code.
 * The original error is deliberately NOT attached as `cause`.
 */
function brokerFailure(adapter, brokerId, err, redactList) {
  let n;
  try {
    n = (typeof adapter.normaliseError === "function" ? adapter.normaliseError : contractNormaliseError)(err, { secrets: redactList });
  } catch {
    n = contractNormaliseError(err, { secrets: redactList });
  }
  const message = redactSecrets(String(n?.message ?? "The broker refused the request."), redactList).slice(0, 240);
  const brokerCode = typeof n?.code === "string" ? n.code : "UPSTREAM_ERROR";
  let code = "UPSTREAM_ERROR";
  if (n?.statusCode === 422) code = "VALIDATION_FAILED";
  else if (brokerCode === "UPSTREAM_RATE_LIMIT" || brokerCode === "UPSTREAM_RATE_LIMITED") code = "UPSTREAM_RATE_LIMITED";
  else if (brokerCode === "UPSTREAM_TIMEOUT") code = "UPSTREAM_TIMEOUT";
  return new BridgeError(code, `${BROKER_NAMES[brokerId] ?? brokerId}: ${message}`, { broker: { id: brokerId, code: brokerCode, message } });
}

/**
 * @param {object} deps  Core deps (config, logger, bus, clock, paths, brokers) plus SERVICE_CONTRACTS.accounts.requires (secrets).
 * @param {AccountManagerOptions} [options]
 * @returns {Promise<object>} AccountManager
 */
export async function createAccountManager(deps, options = {}) {
  const { config, logger, bus, clock, brokers, secrets } = deps;
  const log = typeof logger.child === "function" ? logger.child({ module: "accounts" }) : logger;
  const now = () => clock.now();
  const policies = options.policies ? normalisePolicies(options.policies) : await loadBrokerPolicies(log, options.importPolicies);
  const loginLimiter = options.loginLimiter ?? createLoginRateLimiter({ max: LOGIN_ATTEMPTS_PER_WINDOW, windowMs: LOGIN_WINDOW_MS });
  const pollMs = options.pollMs ?? 5000;

  /** Accounts in config order (plus any added at run time, in the order they were added). */
  const accounts = [...config.accounts];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  /**
   * The app shares one accounts list between its services (config.mjs withAddableAccounts). When it does, an account
   * added here is visible to them at once; otherwise (a manager built on a plain frozen config) it cannot be hot-added.
   */
  const sharedAccounts = Array.isArray(config.accounts) && !Object.isFrozen(config.accounts) ? config.accounts : null;

  /**
   * Per-account in-memory state. Holds no secret.
   * @type {Map<string, { facts: ReturnType<typeof describeRecord>, rejectedStamp: string | null,
   *   error: { stamp: string | null, message: string } | null, checking: boolean, checkedAt: number | null,
   *   lastKey: string | null, timer: NodeJS.Timeout | null }>}
   */
  const mem = new Map();
  const freshMem = () => ({ facts: describeRecord(null, null), rejectedStamp: null, error: null, checking: false, checkedAt: null, lastKey: null, timer: null });
  for (const a of accounts) mem.set(a.id, freshMem());
  const locks = new Map();
  let started = false;
  let storeWarned = false;

  const adapterOf = (account) => (account.broker !== PAPER_BROKER && brokers.has(account.broker) ? brokers.get(account.broker) : null);

  function mustAccount(accountId) {
    const a = typeof accountId === "string" ? byId.get(accountId) : undefined;
    if (!a) throw new BridgeError("ACCOUNT_NOT_FOUND", `No account with id ${String(accountId).slice(0, 40)}. Accounts are declared in bridge.config.json.`);
    return a;
  }

  /** Serialise connect/disconnect per account so two logins can never interleave. */
  function withLock(accountId, fn) {
    const prev = locks.get(accountId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(accountId, tail);
    tail.then(() => {
      if (locks.get(accountId) === tail) locks.delete(accountId);
    });
    return run;
  }

  /** Internal state (epoch ms) for one account. */
  function compute(account) {
    if (account.broker === PAPER_BROKER) return { state: "connected", expiresAt: null, message: null };
    if (!adapterOf(account)) return { state: "error", expiresAt: null, message: `Unknown broker ${account.broker}. Check bridge.config.json.` };
    if (account.enabled === false) return { state: "missing", expiresAt: null, message: "This account is disabled in bridge.config.json." };
    const m = mem.get(account.id);
    return deriveState(m.facts, m, now());
  }

  function armTimer(account, s) {
    const m = mem.get(account.id);
    if (m.timer) {
      clearTimeout(m.timer);
      m.timer = null;
    }
    if (!started || s.state !== "connected" || s.expiresAt === null) return;
    const delay = Math.max(0, Math.min(s.expiresAt - now(), MAX_TIMER_MS));
    m.timer = setTimeout(() => {
      m.timer = null;
      evaluate(account);
    }, delay + 5);
    m.timer.unref?.();
  }

  /**
   * Recompute; emit account.status when something visible changed (the first evaluation only sets the baseline);
   * (re)arm the expiry timer. "checking" is transient and never emitted.
   */
  function evaluate(account, { emit = true } = {}) {
    const s = compute(account);
    const m = mem.get(account.id);
    if (s.state === "checking") return s;
    const key = `${s.state}|${s.expiresAt ?? ""}|${s.message ?? ""}`;
    if (key !== m.lastKey) {
      const isBaseline = m.lastKey === null;
      m.lastKey = key;
      if (emit && !isBaseline) {
        const payload = { accountId: account.id, broker: account.broker, session: s.state };
        if (s.expiresAt !== null) payload.expiresAt = toIstIso(s.expiresAt);
        if (s.message) payload.message = s.message;
        bus.emit("account.status", payload);
      }
      armTimer(account, s);
    } else if (started && !m.timer) {
      armTimer(account, s);
    }
    return s;
  }

  /** Public SessionState (ISO times with +05:30). */
  function sessionState(account) {
    const s = evaluate(account);
    const m = mem.get(account.id);
    return { state: s.state, expiresAt: toIstIso(s.expiresAt), checkedAt: toIstIso(m.checkedAt), message: s.message };
  }

  function capabilityList(account) {
    if (account.broker === PAPER_BROKER) return [...PAPER_CAPABILITIES];
    const adapter = adapterOf(account);
    return adapter ? adapterCapabilities(adapter) : [];
  }

  /**
   * Account opted in AND the broker's terms (S3 policy) allow spreading one user's reads over their accounts (or the
   * terms are unknown and the user opted in to that too with marketData.poolingWhenTermsUnknown) AND the account says
   * whose it is (`holder`), so accounts of different people are never pooled together. "not-allowed" always wins.
   */
  const brokerPoolingOk = (account) => {
    const terms = poolingFor(policies, account.broker);
    return terms === "allowed" || (terms === "unknown" && account.marketData?.poolingWhenTermsUnknown === true);
  };
  const effectivePooling = (account) =>
    account.broker !== PAPER_BROKER &&
    account.marketData?.pooling === true &&
    typeof account.holder === "string" &&
    account.holder.length > 0 &&
    brokerPoolingOk(account);

  function summary(account) {
    const adapter = adapterOf(account);
    return {
      id: account.id,
      broker: account.broker,
      label: account.label ?? (account.broker === PAPER_BROKER ? "Paper account" : BROKER_NAMES[account.broker] ?? account.broker),
      enabled: account.enabled !== false,
      session: sessionState(account),
      liveAllowedByConfig: liveAllowedByConfig(config, account),
      pooling: effectivePooling(account),
      capabilities: capabilityList(account),
      authKind: adapter ? adapter.capabilities?.auth?.kind ?? "apiKeyToken" : null,
    };
  }

  /** Apply freshly read record facts. A different record (new connect, CLI change) clears stale flags. */
  function applyFacts(account, facts) {
    const m = mem.get(account.id);
    if (!m) return; // removed while the store was being read
    if (facts.stamp !== m.facts.stamp) {
      m.rejectedStamp = null;
      m.error = null;
    }
    m.facts = facts;
  }

  /** Read one account's record from SecretStore and refresh the in-memory facts. Returns the record (or null). */
  async function readRecord(account) {
    const record = await secrets.get(secretName(account.id));
    applyFacts(account, describeRecord(record, adapterOf(account)));
    return record;
  }

  let reloading = null;
  let reloadAgain = false;
  /** Re-read every account's record (the CLI or another process may have changed the store). */
  async function reload({ emit = true } = {}) {
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    reloading = (async () => {
      do {
        reloadAgain = false;
        for (const account of [...accounts]) {
          if (!byId.has(account.id)) continue; // removed meanwhile
          if (account.broker !== PAPER_BROKER && adapterOf(account)) {
            try {
              await readRecord(account);
            } catch (err) {
              if (!storeWarned) {
                storeWarned = true;
                log.warn("could not read saved broker sessions; accounts show as not connected", { code: err?.code });
              }
            }
          }
          if (byId.has(account.id)) evaluate(account, { emit });
        }
      } while (reloadAgain);
    })();
    try {
      await reloading;
    } finally {
      reloading = null;
    }
  }

  // ── File watching (store changed by the CLI) ──
  let watcher = null;
  let poller = null;
  let debounce = null;
  let lastSig = null;
  function secretsPath() {
    try {
      const p = secrets.status()?.path;
      if (typeof p === "string" && p) return p;
    } catch {
      // stub or not ready: fall back to the documented location
    }
    return join(deps.paths?.dataDir ?? config.dataDir, "secrets.enc");
  }
  const fileSig = (p) => {
    try {
      const s = statSync(p);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "absent";
    }
  };
  function scheduleReload() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      reload().catch((err) => log.warn("reloading saved sessions failed", { code: err?.code }));
    }, 50);
    debounce.unref?.();
  }

  const offRejected = bus.on("account.session_rejected", (payload) => {
    const account = byId.get(payload?.accountId);
    if (!account || account.broker === PAPER_BROKER) return;
    const m = mem.get(account.id);
    if (!m.facts.usable || m.facts.stamp === null) return;
    m.rejectedStamp = m.facts.stamp;
    evaluate(account);
  });

  await reload({ emit: false });

  const svc = {
    /** @returns {import("../core/contracts.mjs").AccountSummary[]} every configured account, config order */
    list() {
      return accounts.map(summary);
    },

    /** @param {string} accountId @returns {import("../core/contracts.mjs").AccountSummary} throws ACCOUNT_NOT_FOUND */
    get(accountId) {
      return summary(mustAccount(accountId));
    },

    /** The broker adapter module. Paper accounts have none (CAPABILITY_UNSUPPORTED). */
    adapter(accountId) {
      const account = mustAccount(accountId);
      if (account.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account has no broker adapter.");
      const adapter = adapterOf(account);
      if (!adapter) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Unknown broker ${account.broker}.`);
      return adapter;
    },

    /**
     * Decrypted saved values plus session fields, read fresh from SecretStore. For sessionLogin brokers the
     * expiry is included as `sessionExpiresAt` (epoch ms, as text) so the adapter's own check applies too.
     * @returns {Promise<Record<string, string>>} throws SESSION_EXPIRED when not connected
     */
    async creds(accountId) {
      const account = mustAccount(accountId);
      if (account.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account has no broker credentials.");
      const adapter = svc.adapter(accountId);
      if (account.enabled === false) throw new BridgeError("SESSION_EXPIRED", `Account ${account.id} is disabled in bridge.config.json.`);
      const record = await readRecord(account);
      const s = evaluate(account);
      if (s.state !== "connected" || !record) throw new BridgeError("SESSION_EXPIRED", `${account.id}: ${s.message ?? "not connected"}`);
      const out = { ...(record.values ?? {}) };
      if (adapter.capabilities?.auth?.kind === "sessionLogin") {
        Object.assign(out, record.session ?? {});
        if (record.sessionExpiresAt) out.sessionExpiresAt = String(record.sessionExpiresAt);
      }
      for (const v of Object.values(out)) if (typeof v === "string") logger.addSecret?.(v);
      return out;
    },

    /** @returns {import("../core/contracts.mjs").SessionState} */
    status(accountId) {
      return sessionState(mustAccount(accountId));
    },

    /**
     * Connect or log in. See the file header for the rules. Returns the new SessionState. A sessionLogin failure
     * throws and saves nothing; a key-verification failure saves the keys and returns state "error".
     * @param {string} accountId
     * @param {{ values?: Record<string,string>, secrets?: Record<string,string> }} input
     */
    async connect(accountId, input = {}) {
      const account = mustAccount(accountId);
      if (account.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account needs no broker login.");
      const adapter = svc.adapter(accountId);
      if (account.enabled === false) throw new BridgeError("VALIDATION_FAILED", `Account ${account.id} is disabled in bridge.config.json. Enable it first.`);
      const auth = adapter.capabilities?.auth ?? { kind: "apiKeyToken" };
      const { values, secrets: typed } = validateConnectInput(adapter, input);
      if (auth.kind === "sessionLogin" && !loginLimiter.take(account.id, now())) {
        throw new BridgeError("RATE_LIMITED", "Too many login attempts for this account. Wait a minute and try again.", { retryAfterMs: LOGIN_WINDOW_MS });
      }

      return withLock(account.id, async () => {
        const m = mem.get(account.id);
        const saved = await secrets.get(secretName(account.id));
        const merged = mergeValues(adapter, saved?.values, values);
        const t = now();
        m.checking = true;
        try {
          if (auth.kind === "sessionLogin") {
            const secretValues = Object.values(typed);
            const redactList = [...secretValues, ...secretLookingValues(merged)];
            let result;
            try {
              result = await adapter.login({ ...merged, ...typed });
            } catch (err) {
              throw brokerFailure(adapter, account.broker, err, redactList);
            }
            const problems = checkLoginResult(result, { sessionFields: auth.sessionFields ?? [], secrets: secretValues, now: now() });
            if (problems.length) {
              log.warn("broker login returned an unexpected session; nothing was saved", { accountId: account.id, broker: account.broker, problems: problems.length });
              throw new BridgeError("UPSTREAM_ERROR", `${BROKER_NAMES[account.broker] ?? account.broker} login returned an unexpected session. Nothing was saved.`, {
                broker: { id: account.broker, code: "LOGIN_RESULT_INVALID" },
              });
            }
            const record = {
              values: merged,
              session: pickSessionFields(result.session, auth.sessionFields),
              sessionExpiresAt: result.expiresAt,
              connectedAt: new Date(t).toISOString(),
              rev: randomUUID(),
            };
            await secrets.set(secretName(account.id), record);
            applyFacts(account, describeRecord(record, adapter));
          } else {
            if (Object.keys(merged).length === 0) {
              throw new BridgeError("VALIDATION_FAILED", `Enter this broker's keys in 'values' (${(adapter.credentialFields ?? []).join(", ")}).`);
            }
            const record = { values: merged, session: null, sessionExpiresAt: sessionExpiryFor(auth, t), connectedAt: new Date(t).toISOString(), rev: randomUUID() };
            await secrets.set(secretName(account.id), record);
            applyFacts(account, describeRecord(record, adapter));
            const redactList = secretLookingValues(merged);
            try {
              const r = await adapter.testConnection({ ...merged });
              if (r?.status !== "success") {
                m.error = { stamp: m.facts.stamp, message: `The broker did not accept these keys: ${redactSecrets(String(r?.message ?? "no reason given"), redactList).slice(0, 200)}` };
              }
            } catch (err) {
              const e = brokerFailure(adapter, account.broker, err, redactList);
              m.error = { stamp: m.facts.stamp, message: `Could not verify these keys: ${e.broker?.message ?? e.detail}` };
            }
          }
          m.checkedAt = now();
        } finally {
          m.checking = false;
        }
        log.info("account connected", { accountId: account.id, broker: account.broker, authKind: auth.kind, state: compute(account).state });
        return sessionState(account);
      });
    },

    /**
     * Forget the broker session. Saved long-lived keys stay; session fields and (for brokers whose token is minted
     * daily: oauthRedirect, requestTokenExchange) the day's token are removed. Idempotent.
     */
    async disconnect(accountId) {
      const account = mustAccount(accountId);
      if (account.broker === PAPER_BROKER) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper account has no broker session.");
      const adapter = svc.adapter(accountId);
      const kind = adapter.capabilities?.auth?.kind ?? "apiKeyToken";
      return withLock(account.id, async () => {
        const m = mem.get(account.id);
        const saved = await secrets.get(secretName(account.id));
        if (saved) {
          const values = mergeValues(adapter, saved.values, {}, { dropDailyTokens: kind === "oauthRedirect" || kind === "requestTokenExchange" });
          const record = { values, session: null, sessionExpiresAt: null, connectedAt: saved.connectedAt ?? null, rev: randomUUID(), disconnectedAt: new Date(now()).toISOString() };
          await secrets.set(secretName(account.id), record);
          applyFacts(account, describeRecord(record, adapter));
        }
        m.rejectedStamp = null;
        m.error = null;
        log.info("account disconnected", { accountId: account.id, broker: account.broker });
        return sessionState(account);
      });
    },

    /**
     * One cheap authenticated broker call (adapter.testConnection). A broker failure never throws: the answer is
     * { ok, message }. A session error marks the account expired.
     */
    async testConnection(accountId) {
      const account = mustAccount(accountId);
      if (account.broker === PAPER_BROKER) return { ok: true, message: "Paper account: no broker connection is needed." };
      const adapter = svc.adapter(accountId);
      let creds;
      try {
        creds = await svc.creds(accountId);
      } catch (err) {
        if (err instanceof BridgeError && err.code === "SESSION_EXPIRED") return { ok: false, message: err.detail };
        throw err;
      }
      const m = mem.get(account.id);
      const redactList = secretLookingValues(creds);
      try {
        const r = await adapter.testConnection(creds);
        m.checkedAt = now();
        const ok = r?.status === "success";
        const message = redactSecrets(String(r?.message || (ok ? "Connected." : "The broker did not accept the session.")), redactList).slice(0, 240);
        evaluate(account);
        return { ok, message };
      } catch (err) {
        m.checkedAt = now();
        if (isSessionError(err)) {
          m.rejectedStamp = m.facts.stamp;
          evaluate(account);
          return { ok: false, message: "The broker rejected the session. Log in again." };
        }
        const e = brokerFailure(adapter, account.broker, err, redactList);
        evaluate(account);
        return { ok: false, message: e.broker?.message ?? e.detail };
      }
    },

    /** @returns {{ capabilities: string[], policy: import("../core/contracts.mjs").BrokerPolicy | null }} */
    capabilities(accountId) {
      const account = mustAccount(accountId);
      return { capabilities: capabilityList(account), policy: account.broker === PAPER_BROKER ? null : policies[account.broker] ?? null };
    },

    /**
     * Accounts that may serve an UNPINNED market-data read, in config order. See SERVICE_CONTRACTS.accounts.
     * allowedAccounts: the caller's account restriction (a key's `accounts` list); omitted or "*" means any account.
     * Accounts outside it are never used, even as the primary: the read fails with no candidate instead.
     * @param {{ capability: string, accountId?: string, allowedAccounts?: string[] | "*" }} q
     * @returns {string[]}
     */
    marketDataCandidates({ capability, accountId, allowedAccounts } = {}) {
      if (typeof capability !== "string" || !capability) return [];
      const mayUse = Array.isArray(allowedAccounts) ? (id) => allowedAccounts.includes(id) : () => true;
      if (accountId !== undefined && accountId !== null) {
        const a = byId.get(accountId);
        if (!a || !mayUse(a.id) || a.broker === PAPER_BROKER || a.enabled === false || !adapterOf(a)) return [];
        return capabilityList(a).includes(capability) ? [a.id] : [];
      }
      const eligible = accounts.filter(
        (a) => mayUse(a.id) && a.broker !== PAPER_BROKER && a.enabled !== false && adapterOf(a) && capabilityList(a).includes(capability) && evaluate(a).state === "connected",
      );
      const pooled = eligible.filter(effectivePooling);
      // One holder only: the first pooling account's holder (config order); other people's accounts are left out.
      if (pooled.length) return pooled.filter((a) => a.holder === pooled[0].holder).map((a) => a.id);
      return eligible.length ? [eligible[0].id] : [];
    },

    // ── Extras beyond the contract (module.mjs, CLI, tests). Other streams call only the contract methods. ──

    /** The S3 policy for a broker, or null when S3 has none (yet). */
    brokerPolicy(brokerId) {
      return policies[brokerId] ?? null;
    },

    /** Re-read SecretStore now (also runs automatically when the store file changes). */
    reload,

    /** Whether addAccount() can make a new account usable without a restart (see sharedAccounts above). */
    canAddAccounts() {
      return sharedAccounts !== null;
    },

    /**
     * Start using an account that was just saved to the config file (POST /v1/accounts), without a restart. `entry`
     * is a parsed, frozen accountSchema object; live trading stays whatever it says (the route always adds paper-only
     * accounts). Picks up a session already saved for this id, if any. Returns the new AccountSummary.
     * @param {Readonly<any>} entry
     */
    async addAccount(entry) {
      if (!sharedAccounts) throw new BridgeError("NOT_IMPLEMENTED", "This Bridge cannot add accounts while it runs. Restart it to load the new account.");
      if (!entry || typeof entry.id !== "string" || byId.has(entry.id)) throw new BridgeError("VALIDATION_FAILED", `The account id "${String(entry?.id).slice(0, 40)}" is already used.`);
      accounts.push(entry);
      byId.set(entry.id, entry);
      mem.set(entry.id, freshMem());
      sharedAccounts.push(entry);
      if (entry.broker !== PAPER_BROKER && adapterOf(entry)) {
        try {
          await readRecord(entry);
        } catch (err) {
          log.warn("could not read a saved session for the new account", { accountId: entry.id, code: err?.code });
        }
      }
      evaluate(entry, { emit: false });
      if (started) armTimer(entry, compute(entry));
      log.info("account added", { accountId: entry.id, broker: entry.broker });
      return summary(entry);
    },

    /**
     * Stop using an account that was just removed from the config file (DELETE /v1/accounts/{id}) and delete what
     * SecretStore holds for it (saved keys and session). Waits for a login in progress on it to finish first.
     * @param {string} accountId
     */
    async removeAccount(accountId) {
      const account = mustAccount(accountId);
      return withLock(account.id, async () => {
        const m = mem.get(account.id);
        if (m?.timer) clearTimeout(m.timer);
        mem.delete(account.id);
        byId.delete(account.id);
        accounts.splice(accounts.indexOf(account), 1);
        const i = sharedAccounts ? sharedAccounts.findIndex((a) => a.id === account.id) : -1;
        if (i >= 0) sharedAccounts.splice(i, 1);
        let secretsDeleted = true;
        if (account.broker !== PAPER_BROKER) {
          try {
            await secrets.delete(secretName(account.id));
          } catch (err) {
            secretsDeleted = false;
            log.warn("could not delete the saved keys of a removed account", { accountId: account.id, code: err?.code });
          }
        }
        log.info("account removed", { accountId: account.id, broker: account.broker });
        return { id: account.id, broker: account.broker, secretsDeleted };
      });
    },

    /** Start the store watcher and expiry timers. Idempotent. */
    start() {
      if (started) return;
      started = true;
      const p = secretsPath();
      lastSig = fileSig(p);
      if (options.watchFs !== false) {
        try {
          watcher = watch(dirname(p), { persistent: false }, (_event, file) => {
            if (!file || String(file) === basename(p)) scheduleReload();
          });
          watcher.on("error", () => {
            watcher?.close();
            watcher = null;
          });
        } catch {
          watcher = null; // directory missing or watch unsupported: the poll still covers it
        }
      }
      poller = setInterval(() => {
        const sig = fileSig(p);
        if (sig !== lastSig) {
          lastSig = sig;
          scheduleReload();
        }
      }, pollMs);
      poller.unref?.();
      for (const a of accounts) armTimer(a, compute(a));
    },

    /** Stop watchers and timers. Idempotent. */
    stop() {
      started = false;
      watcher?.close();
      watcher = null;
      if (poller) clearInterval(poller);
      poller = null;
      if (debounce) clearTimeout(debounce);
      debounce = null;
      for (const m of mem.values()) {
        if (m.timer) clearTimeout(m.timer);
        m.timer = null;
      }
    },

    /** stop() and remove the bus subscription (tests that build several managers on one bus). */
    dispose() {
      svc.stop();
      offRejected();
    },
  };
  return svc;
}
