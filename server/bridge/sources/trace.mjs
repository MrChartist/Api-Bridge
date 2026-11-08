/**
 * GET /v1/sources/trace: a dry run of the router. It says which source would answer a read and why every other source
 * was passed over, in plain words. It makes no upstream call, spends no budget and claims no probe.
 *
 *   GET /v1/sources/trace?capability=quotes&symbols=NSE:RELIANCE&purpose=display&maxAgeMs=2000[&backup=true][&interval=5m][&account=]
 *
 * Answers { data: TraceResult, meta } where TraceResult is
 *   { request, considered: [{ id, kind, verdict: "chosen"|"fallback"|"skipped", reason, score?, spareBudget?, health }],
 *     class, note }
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { INTERVALS } from "../market/history.mjs";
import { allowedAccountsFor, autoBackupFor, parseSymbolList } from "../market/routes.mjs";
import { CAPABILITIES, PURPOSES } from "./contract.mjs";
import { historySupport } from "./router.mjs";

const TRACE_CAPABILITIES = Object.freeze([...CAPABILITIES, "depth"]);
const MAX_AGE_LIMIT_MS = 3_600_000;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ROUTE = "/v1/sources/trace";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};

function routerOf(deps) {
  const pick = (name) => {
    try {
      return deps[name];
    } catch {
      return undefined;
    }
  };
  const direct = pick("sourceRouter");
  if (direct) return direct;
  const md = pick("marketData");
  return md?.sourceRouter;
}

/**
 * The handler for GET /v1/sources/trace.
 * @param {object} deps full deps passed to register()
 */
export function createTraceHandler(deps) {
  return async function trace(ctx) {
    const router = routerOf(deps);
    if (!router || typeof router.trace !== "function") throw new BridgeError("NOT_IMPLEMENTED", "Source routing is not running in this Bridge.");
    const q = ctx.query;
    const capability = opt(q, "capability") ?? "quotes";
    if (!TRACE_CAPABILITIES.includes(capability)) throw invalid("capability", `capability must be one of ${TRACE_CAPABILITIES.join(", ")}.`);
    const purpose = opt(q, "purpose") ?? "display";
    if (!PURPOSES.includes(purpose)) throw invalid("purpose", `purpose must be one of ${PURPOSES.join(", ")}.`);
    const symbolsRaw = opt(q, "symbols");
    const symbols = symbolsRaw === undefined ? [] : parseSymbolList(symbolsRaw);
    const req = { capability, purpose };
    if (symbols.length) req.symbols = symbols;
    const maxAge = opt(q, "maxAgeMs");
    if (maxAge !== undefined) {
      if (!/^\d+$/.test(maxAge) || Number(maxAge) > MAX_AGE_LIMIT_MS) throw invalid("maxAgeMs", `maxAgeMs must be a whole number from 0 to ${MAX_AGE_LIMIT_MS}.`);
      req.maxAgeMs = Number(maxAge);
    }
    const deadline = opt(q, "deadlineMs");
    if (deadline !== undefined) {
      if (!/^\d+$/.test(deadline) || Number(deadline) > 600_000) throw invalid("deadlineMs", "deadlineMs must be a whole number from 0 to 600000.");
      req.deadlineMs = Number(deadline);
    }
    const backup = opt(q, "backup");
    if (backup !== undefined && !["true", "false", "1", "0"].includes(backup.toLowerCase())) throw invalid("backup", "backup must be true or false.");
    req.allowSources = backup === undefined ? autoBackupFor(deps) : backup === "true" || backup === "1";
    const allowed = allowedAccountsFor(ctx);
    if (allowed) req.allowedAccounts = allowed;

    const account = opt(q, "account");
    if (account !== undefined) {
      if (!ACCOUNT_RE.test(account)) throw invalid("account", "account is not a valid account id.");
      ctx.requireAccountAccess(account);
      // A pinned read never moves, so there is nothing to route.
      return {
        data: {
          request: { ...req, account, allowBackup: false },
          considered: [{ id: account, kind: "broker", verdict: "chosen", reason: "chosen: you pinned this account, so nothing else is considered and no backup source is used", health: { state: "ok", errorRate: 0, p50Ms: null, lastError: null, nextTryAt: null } }],
          class: "realtime",
          note: `A read pinned to ${account} is answered by that account only.`,
        },
        meta: { requestId: ctx.requestId },
      };
    }

    if (capability === "history") {
      const interval = opt(q, "interval") ?? "1d";
      if (!INTERVALS.includes(interval)) throw invalid("interval", `interval must be one of ${INTERVALS.join(", ")}.`);
      req.interval = interval;
      let exchange;
      try {
        exchange = symbols.length ? parseSymbol(symbols[0]).exchange : undefined;
      } catch {
        exchange = undefined;
      }
      const accounts = deps.accounts;
      req.brokerCapability = "historical";
      req.supports = (id) => historySupport(accounts, id, interval, exchange);
    }
    if (capability === "depth") req.allowSources = false;
    const data = router.trace(req);
    return { data, meta: { requestId: ctx.requestId } };
  };
}

/**
 * Register GET /v1/sources/trace (read scope). Safe to call more than once and from more than one module: a route
 * that is already there is left alone.
 * @param {{ get: Function, routes?: () => Array<{ method: string, pattern: string }> }} app
 * @param {object} deps
 */
export function registerTraceRoutes(app, deps) {
  try {
    if (typeof app.routes === "function" && app.routes().some((r) => r.method === "GET" && r.pattern === ROUTE)) return false;
  } catch {
    // fall through and try to register
  }
  app.get(ROUTE, createTraceHandler(deps), { scope: "read" });
  return true;
}
