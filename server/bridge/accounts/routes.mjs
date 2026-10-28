/**
 * Route handlers for stream S1 (docs/openapi.yaml, tag Accounts). Every handler answers { data, meta } and never
 * includes a credential: AccountSummary/SessionState carry state and times only, and connect() takes the request
 * body straight to AccountManager without logging or echoing it.
 *
 * Auditing: account.connected / account.disconnected / account.added / account.removed go to deps.audit (S9) with
 * ids, broker and resulting state only. While the audit service is still a stub the action proceeds and a warning is
 * logged.
 *
 * Adding and removing accounts (POST /v1/accounts, DELETE /v1/accounts/{id}; admin, this computer only, and only with
 * an admin key that may use every account): the change is saved to the config file first (configFile.mjs), then the
 * running Bridge starts or stops using the account at once (AccountManager.addAccount/removeAccount); no restart.
 *  - Added accounts are always paper only: `live.enabled` is false and the route accepts no live settings. Turning
 *    live trading on stays a deliberate edit of the config file.
 *  - Ids: 2-32 lowercase letters, digits or hyphens. Without one: "<broker>-main", then "<broker>-2", "<broker>-3" ...
 *    ("paper", "paper-2" ... for paper accounts), skipping ids the Bridge or the file already use.
 *  - Removing refuses an account with live trading set up in the file (remove those in the file, on purpose) and the
 *    last paper account. It deletes the account's saved keys and session from SecretStore; its paper-trading
 *    history files stay in the data folder.
 *  - Demo mode refuses both: demo replaces the accounts with its sample ones.
 */
import { isStub } from "../core/contracts.mjs";
import { accountSchema, deepFreeze } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { BROKER_NAMES, PAPER_BROKER, VERIFIED_BROKERS, adapterCapabilities, loadBrokerPolicies } from "./brokerInfo.mjs";
import { addAccountToConfigFile, configFileAccountIds, removeAccountFromConfigFile } from "./configFile.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ADD_FIELDS = new Set(["broker", "id", "label"]);
const DEMO_REFUSAL = "Demo mode uses its own sample accounts. Close the Bridge and start it again without demo mode to add or remove your broker accounts.";

/**
 * The broker's login page address with {field} placeholders (adapter auth.loginUrl), only when it is https and every
 * placeholder is one of the fields the person types (credentialFields), so a page can fill it in. Otherwise null.
 */
export function loginUrlTemplate(adapter) {
  const url = adapter?.capabilities?.auth?.loginUrl;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  const fields = Array.isArray(adapter.credentialFields) ? adapter.credentialFields : [];
  const placeholders = [...url.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  return placeholders.every((p) => fields.includes(p)) ? url : null;
}

/**
 * The id a new account gets when none was asked for: "<broker>-main", then "<broker>-2" ... ("paper", "paper-2" ...).
 * @param {string} broker
 * @param {Set<string>} taken
 */
export function suggestAccountId(broker, taken) {
  const first = broker === PAPER_BROKER ? PAPER_BROKER : `${broker}-main`;
  if (!taken.has(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const id = `${broker}-${n}`;
    if (!taken.has(id)) return id;
  }
  throw new BridgeError("VALIDATION_FAILED", "Choose an id for this account.");
}

/** Accounts the request's key may use ("*" = all). Local (CLI) callers see everything. */
export function visibleAccountIds(ctx) {
  if (ctx.principal?.kind === "local") return "*";
  const allowed = ctx.key?.accounts;
  if (allowed === "*") return "*";
  return Array.isArray(allowed) ? new Set(allowed) : new Set();
}

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/**
 * Append an audit record; never fails the request because the audit service is missing, but a real audit failure
 * after a credential change is logged loudly.
 */
async function audit(deps, ctx, type, accountId, data) {
  const auditLog = deps.audit;
  if (!auditLog || isStub(auditLog)) {
    ctx.log.warn("audit log not available; action not audited", { type, accountId });
    return;
  }
  try {
    await auditLog.append({
      type,
      actor: { kind: ctx.principal.kind, id: ctx.principal.id },
      source: ctx.source,
      accountId,
      requestId: ctx.requestId,
      data,
    });
  } catch (err) {
    ctx.log.error("audit append failed", { type, accountId, code: err?.code });
  }
}

/**
 * Build the handlers. `deps` is the full deps object passed to register().
 * @param {object} deps
 * @param {{ policies?: Record<string, any> }} [opts]  policies: S3's table, used when the scheduler is still a stub.
 */
/** The 41 real adapters as directory entries (demo mode only): names and declared capabilities, available: false. */
let catalogueCache = null;
function realBrokerCatalogue() {
  if (catalogueCache) return catalogueCache;
  const reg = createBrokerRegistry();
  catalogueCache = reg
    .list()
    .slice()
    .sort()
    .map((id) => {
      const adapter = reg.get(id);
      return {
        id,
        name: BROKER_NAMES[id] ?? id,
        authKind: adapter.capabilities?.auth?.kind ?? "apiKeyToken",
        capabilities: adapterCapabilities(adapter),
        verified: VERIFIED_BROKERS.includes(id),
        available: false,
        note: "Not loaded in demo mode. Start without --demo to connect this broker.",
      };
    });
  return catalogueCache;
}

export function createAccountRoutes(deps, { policies = {} } = {}) {
  const accounts = deps.accounts;

  function policyFor(brokerId) {
    if (deps.scheduler && !isStub(deps.scheduler)) {
      try {
        return deps.scheduler.policyFor(brokerId) ?? null;
      } catch {
        // fall through to the static table
      }
    }
    return policies[brokerId] ?? null;
  }

  function accountParam(ctx) {
    const id = ctx.params.accountId;
    ctx.requireAccountAccess(id); // before any lookup, so a key cannot probe which ids exist
    return id;
  }

  return {
    /** GET /v1/brokers */
    listBrokers(ctx) {
      const data = deps.brokers
        .list()
        .slice()
        .sort()
        .map((id) => {
          const adapter = deps.brokers.get(id);
          const item = {
            id,
            name: BROKER_NAMES[id] ?? adapter.displayName ?? id,
            ...(adapter.demo ? { demo: true } : {}),
            authKind: adapter.capabilities?.auth?.kind ?? "apiKeyToken",
            capabilities: adapterCapabilities(adapter),
            verified: VERIFIED_BROKERS.includes(id),
            // What a login form needs (field names and labels only; no values ever leave the Bridge).
            credentialFields: Array.isArray(adapter.credentialFields) ? [...adapter.credentialFields] : [],
            loginFields: (adapter.capabilities?.auth?.loginFields ?? []).map((f) => ({ key: f.key, label: f.label ?? f.key, kind: f.kind ?? "secret" })),
            tokenExpiry: adapter.capabilities?.auth?.tokenExpiry ?? null,
          };
          // The broker's own login page, for brokers that declare one the dashboard can fill in (Zerodha, ICICI ...).
          const loginUrl = loginUrlTemplate(adapter);
          if (loginUrl) item.loginUrl = loginUrl;
          const policy = policyFor(id);
          if (policy) item.policy = policy;
          return item;
        });
      // Demo mode loads only the demo adapter. The real brokers are still listed (for the dashboard's directory),
      // marked unavailable: nothing about them is loaded into the running Bridge and no account can use them.
      if (deps.config?.demo) {
        for (const b of realBrokerCatalogue()) if (!data.some((d) => d.id === b.id)) data.push(b);
      }
      return { data, meta: meta(ctx) };
    },

    /** GET /v1/accounts — only the accounts this key may use. */
    listAccounts(ctx) {
      const visible = visibleAccountIds(ctx);
      const data = accounts.list().filter((a) => visible === "*" || visible.has(a.id));
      return { data, meta: meta(ctx) };
    },

    /** POST /v1/accounts (admin, loopback only, unlimited admin key): add a paper-only account and use it at once. */
    async addAccount(ctx) {
      requireWholeBridge(ctx);
      if (deps.config?.demo) throw new BridgeError("VALIDATION_FAILED", DEMO_REFUSAL);
      const body = ctx.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", "Send { broker, id?, label? } as a JSON object.");
      const extra = Object.keys(body).filter((k) => !ADD_FIELDS.has(k));
      if (extra.length) {
        throw new BridgeError("VALIDATION_FAILED", "Only broker, id and label can be set here. Live trading and other settings are changed in the config file.", {
          errors: extra.slice(0, 5).map((k) => ({ path: String(k).slice(0, 40), message: "unknown field" })),
        });
      }
      const broker = typeof body.broker === "string" ? body.broker.trim().toLowerCase() : "";
      const known = broker === PAPER_BROKER || (broker !== "demo" && /^[a-z0-9]{2,20}$/.test(broker) && deps.brokers.has(broker));
      if (!known) throw new BridgeError("VALIDATION_FAILED", "Choose one of the supported brokers (GET /v1/brokers lists them), or paper.", { errors: [{ path: "broker", message: "unknown broker" }] });
      if (body.label !== undefined && typeof body.label !== "string") throw new BridgeError("VALIDATION_FAILED", "The name must be text.", { errors: [{ path: "label", message: "must be text" }] });
      const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ") : "";
      if (label.length > 60) throw new BridgeError("VALIDATION_FAILED", "Keep the name to 60 characters or fewer.", { errors: [{ path: "label", message: "at most 60 characters" }] });
      const configFile = deps.paths?.configFile;
      if (!configFile) throw new BridgeError("VALIDATION_FAILED", "This Bridge was started without a config file location, so it cannot save a new account. Add it under \"accounts\" in bridge.config.json instead.");

      const taken = new Set([...accounts.list().map((a) => a.id), ...configFileAccountIds(configFile)]);
      let id;
      if (body.id === undefined || body.id === null || body.id === "") id = suggestAccountId(broker, taken);
      else {
        id = typeof body.id === "string" ? body.id.trim() : "";
        if (!ACCOUNT_ID_RE.test(id)) throw new BridgeError("VALIDATION_FAILED", "The account id must be 2-32 lowercase letters, digits or hyphens, starting with a letter or digit.", { errors: [{ path: "id", message: "use 2-32 lowercase letters, digits or hyphens" }] });
        if (taken.has(id)) throw new BridgeError("VALIDATION_FAILED", `The account id "${id}" is already used. Choose another one.`, { errors: [{ path: "id", message: "already used" }] });
      }
      const entry =
        broker === PAPER_BROKER
          ? { id, broker, label: label || defaultLabel(broker, id) }
          : // The same shape `mc-bridge init` writes: paper only, the holder is you, no pooling.
            { id, broker, label: label || defaultLabel(broker, id), holder: "self", live: { enabled: false, allowedSources: ["rest"] }, marketData: { pooling: false } };
      const parsed = accountSchema.safeParse(entry);
      if (!parsed.success) throw new BridgeError("VALIDATION_FAILED", `This account cannot be added: ${parsed.error.issues[0]?.message ?? "not valid"}.`);

      const { created } = await addAccountToConfigFile(configFile, entry);
      let account = null;
      let restartNeeded = true;
      if (typeof accounts.canAddAccounts === "function" && accounts.canAddAccounts()) {
        try {
          account = await accounts.addAccount(deepFreeze(parsed.data));
          restartNeeded = false;
        } catch (err) {
          ctx.log.warn("the new account was saved but could not be loaded until the Bridge restarts", { accountId: id, code: err?.code });
        }
      }
      await audit(deps, ctx, "account.added", id, { broker, label: entry.label, restartNeeded, configFileCreated: created });
      return json({ data: { account, restartNeeded, configFile }, meta: meta(ctx, { accountId: id }) }, { status: 201 });
    },

    /** DELETE /v1/accounts/{accountId} (admin, loopback only, unlimited admin key): remove an account added by mistake. */
    async removeAccount(ctx) {
      const id = accountParam(ctx);
      requireWholeBridge(ctx);
      if (deps.config?.demo) throw new BridgeError("VALIDATION_FAILED", DEMO_REFUSAL);
      const summary = accounts.get(id); // ACCOUNT_NOT_FOUND
      const entry = (deps.config?.accounts ?? []).find((a) => a.id === id);
      if (entry?.live?.enabled) {
        throw new BridgeError("VALIDATION_FAILED", `Live trading is set up for ${id} in your config file. Accounts with live trading are removed only there, on purpose: take it out of bridge.config.json and restart the Bridge.`);
      }
      if (summary.broker === PAPER_BROKER && accounts.list().filter((a) => a.broker === PAPER_BROKER).length <= 1) {
        throw new BridgeError("VALIDATION_FAILED", "This is your only paper account. Keep it so you can always practise without real money.");
      }
      const configFile = deps.paths?.configFile;
      if (!configFile) throw new BridgeError("VALIDATION_FAILED", "This Bridge was started without a config file location, so it cannot remove accounts. Remove it under \"accounts\" in bridge.config.json instead.");
      const { removed } = await removeAccountFromConfigFile(configFile, id);
      let restartNeeded = true;
      let savedKeysDeleted = false;
      if (typeof accounts.canAddAccounts === "function" && accounts.canAddAccounts()) {
        const r = await accounts.removeAccount(id);
        restartNeeded = false;
        savedKeysDeleted = r.secretsDeleted && summary.broker !== PAPER_BROKER;
      }
      await audit(deps, ctx, "account.removed", id, { broker: summary.broker, removedFromConfigFile: removed, savedKeysDeleted, restartNeeded });
      return { data: { id, removed: true, savedKeysDeleted, restartNeeded }, meta: meta(ctx, { accountId: id }) };
    },

    /** GET /v1/accounts/{accountId} */
    getAccount(ctx) {
      const id = accountParam(ctx);
      return { data: accounts.get(id), meta: meta(ctx, { accountId: id }) };
    },

    /** POST /v1/accounts/{accountId}/session (admin, loopback only) */
    async connect(ctx) {
      const id = accountParam(ctx);
      const body = ctx.body === undefined ? {} : ctx.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", "Send { values, secrets } as a JSON object.");
      const before = safeStatus(accounts, id);
      let state;
      try {
        state = await accounts.connect(id, body);
      } catch (err) {
        await audit(deps, ctx, "account.connect_failed", id, { code: err instanceof BridgeError ? err.code : "INTERNAL", previousState: before });
        throw err;
      }
      await audit(deps, ctx, "account.connected", id, { broker: brokerOf(accounts, id), state: state.state, expiresAt: state.expiresAt, previousState: before });
      return { data: state, meta: meta(ctx, { accountId: id }) };
    },

    /** DELETE /v1/accounts/{accountId}/session (admin, loopback only) */
    async disconnect(ctx) {
      const id = accountParam(ctx);
      const before = safeStatus(accounts, id);
      const state = await accounts.disconnect(id);
      await audit(deps, ctx, "account.disconnected", id, { broker: brokerOf(accounts, id), state: state.state, previousState: before });
      return { data: state, meta: meta(ctx, { accountId: id }) };
    },

    /** POST /v1/accounts/{accountId}/test */
    async test(ctx) {
      const id = accountParam(ctx);
      const r = await accounts.testConnection(id);
      return { data: { ok: Boolean(r.ok), message: String(r.message ?? "") }, meta: meta(ctx, { accountId: id }) };
    },
  };
}

/** "Zerodha (Kite) (main)", "Zerodha (Kite) (2)", "Paper account", or the broker name with a custom id. */
export function defaultLabel(broker, id) {
  const name = broker === PAPER_BROKER ? "Paper account" : BROKER_NAMES[broker] ?? broker;
  const n = new RegExp(`^${broker}-(\\d+)$`).exec(id)?.[1];
  if (broker === PAPER_BROKER) return (id === PAPER_BROKER ? name : n ? `${name} ${n}` : `${name} (${id})`).slice(0, 60);
  return `${name} (${id === `${broker}-main` ? "main" : n ?? id})`.slice(0, 60);
}

/** Adding or removing accounts changes the whole Bridge: an admin key limited to some accounts may not. */
function requireWholeBridge(ctx) {
  if (!ctx.canAccessAccounts("*")) {
    throw new BridgeError("ACCOUNT_FORBIDDEN", "Adding or removing accounts needs an admin key that may use every account.");
  }
}

function safeStatus(accounts, id) {
  try {
    return accounts.status(id).state;
  } catch (err) {
    if (err instanceof BridgeError && err.code === "ACCOUNT_NOT_FOUND") throw err;
    return null;
  }
}

function brokerOf(accounts, id) {
  try {
    return accounts.get(id).broker;
  } catch {
    return null;
  }
}

/** S3's policy table for the routes (loaded once per register). */
export const loadRoutePolicies = loadBrokerPolicies;
