/**
 * Route handlers for the market module (docs/openapi.yaml, tag "Market data"). Every JSON handler answers { data, meta };
 * /v1/ltp and /v1/quotes add `errors` (ItemError[]) for symbols that failed, so one bad symbol never fails the call.
 *
 *   GET /v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE[&account=][&maxAgeMs=]
 *   GET /v1/quotes?symbols=...[&account=][&maxAgeMs=]
 *   GET /v1/depth?symbol=...[&account=][&maxAgeMs=]
 *   GET /v1/history?symbol=...&interval=5m&(from=...[&to=...] | [to=...&]countback=N)[&format=csv][&account=]
 *   GET /v1/expiries?underlying=NIFTY[&exchange=NFO][&account=]
 *   GET /v1/optionchain?underlying=NIFTY&expiry=2026-10-27[&strikes=10][&greeks=false][&ivModel=b76-forward][&account=][&maxAgeMs=]
 *
 * Every read also takes ?purpose= (display by default; alert, paper, risk and order accept only real-time data from a
 * trusted source, never a delayed one) and ?swr=true (stale-while-revalidate: an older cached value now, labelled `stale` and
 * `revalidating`, refreshed in the background) and ?priority=background (a prefetch; it never runs ahead of a click).
 *
 * A pinned read (`account=`) is checked against the key's account list (ctx.requireAccountAccess) before anything
 * else happens. An unpinned read is served only by accounts the key may use (allowedAccountsFor): a key limited to
 * some accounts never borrows another account's market-data entitlement or rate budget. meta.accountId echoes the pinned account (null when the read was pooled; each item's freshness says
 * which account actually supplied it).
 */
import { BridgeError } from "../core/errors.mjs";
import { csv } from "../core/http.mjs";
import { IV_MODELS } from "./chain.mjs";
import { parseMarketConfig } from "./config.mjs";
import { historyCsvRows } from "./history.mjs";
import { PURPOSES } from "../sources/contract.mjs";
import { MAX_AGE_LIMIT_MS, MAX_SYMBOLS } from "./marketDataService.mjs";
import { noteRoute } from "./routeInfo.mjs";

const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** 1 May 2027 00:00 IST: from then the chain IV default becomes b76-forward. */
export const LEGACY_IV_DEPRECATION = Date.UTC(2027, 3, 30, 18, 30) / 1000;
const LEGACY_IV_HEADERS = Object.freeze({ Deprecation: `@${LEGACY_IV_DEPRECATION}`, Link: '</docs/CHANGELOG.md#optionchain-ivmodel>; rel="deprecation"' });

/** Optional query value: absent or empty -> undefined. */
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

/** Whole number in [min, max] from the query, or undefined. */
function intParam(q, name, min, max) {
  const v = opt(q, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  const n = Number(v);
  if (n < min || n > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function boolParam(q, name, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  const s = v.toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  throw invalid(name, `${name} must be true or false.`);
}

/** Comma-separated symbols, trimmed, empties dropped, up to MAX_SYMBOLS. */
export function parseSymbolList(raw) {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw invalid("symbols", "symbols is required: a comma-separated list such as NSE:NIFTY,NSE:RELIANCE.");
  if (list.length > MAX_SYMBOLS) throw invalid("symbols", `Ask for at most ${MAX_SYMBOLS} symbols at a time.`);
  return list;
}

/**
 * The accounts a caller may have its unpinned reads served from: undefined for no restriction (the local operator,
 * or a key with accounts "*"), otherwise the key's list (plus the own accounts of a webhook or a strategy guard, as in requireAccountAccess). An empty list means none.
 * @param {import("../core/context.mjs").RequestContext} ctx
 * @returns {string[] | undefined}
 */
export function allowedAccountsFor(ctx) {
  if (ctx?.principal?.kind === "local") return undefined;
  const fromKey = ctx?.key?.accounts;
  if (fromKey === "*") return undefined;
  const list = Array.isArray(fromKey) ? [...fromKey] : [];
  const kind = ctx?.principal?.kind;
  if ((kind === "hook" || kind === "guard") && Array.isArray(ctx.hookAccounts)) list.push(...ctx.hookAccounts);
  return list;
}

/**
 * Read options shared by every route: pinned account (checked against the key), the key's account restriction for
 * unpinned reads, and maxAgeMs.
 * @param {import("../core/context.mjs").RequestContext} ctx
 */
export function readOptionsBase(ctx, { maxAge = true, autoBackup = false } = {}) {
  const q = ctx.query;
  const opts = { signal: ctx.signal };
  const allowed = allowedAccountsFor(ctx);
  if (allowed) opts.allowedAccounts = allowed;
  const account = opt(q, "account");
  if (account !== undefined) {
    if (!ACCOUNT_RE.test(account)) throw invalid("account", "account is not a valid account id.");
    ctx.requireAccountAccess(account);
    opts.accountId = account;
  }
  if (maxAge) {
    const m = intParam(q, "maxAgeMs", 0, MAX_AGE_LIMIT_MS);
    if (m !== undefined) opts.maxAgeMs = m;
  }
  if (opts.accountId === undefined && boolParam(q, "backup", autoBackup)) opts.allowBackup = true;
  // ?purpose=display|analysis|alert|paper|risk|order: what the read is for. The last four accept only trusted real-time data.
  const purpose = opt(q, "purpose");
  if (purpose !== undefined) {
    if (!PURPOSES.includes(purpose)) throw invalid("purpose", `purpose must be one of ${PURPOSES.join(", ")}.`);
    opts.purpose = purpose;
  }
  // ?swr=true: an older cached value (labelled stale and revalidating) now, a fresh one for the next read.
  if (boolParam(q, "swr", false)) opts.staleWhileRevalidate = true;
  // ?priority=background: a prefetch. It may only lower the priority, so a person's click always goes first (a click
  // that asks for the same thing joins the prefetch and raises it).
  const pri = opt(q, "priority");
  if (pri !== undefined) {
    if (pri !== "background" && pri !== "interactive") throw invalid("priority", "priority may be background or interactive.");
    opts.priority = pri;
  }
  return opts;
}

/**
 * The config default for `?backup=`: true when backup sources are on with autoFallback. Unpinned reads that no broker
 * can answer then fall back to them; `?backup=false` opts one read out, `?backup=true` opts in.
 * @param {object} deps
 */
export function autoBackupFor(deps) {
  try {
    const svc = deps.backupData;
    return Boolean(svc && typeof svc.autoFallback === "function" && svc.autoFallback());
  } catch {
    return false;
  }
}

const meta = (ctx, opts) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null });

/**
 * @param {object} deps full deps passed to register()
 */
export function createMarketRoutes(deps) {
  const md = () => deps.marketData;
  /** The chain IV model a request without ivModel gets (market.chain.ivModelDefault), read once. */
  let ivDefault;
  const chainIvModelDefault = () => {
    if (ivDefault === undefined) {
      try {
        ivDefault = parseMarketConfig(deps.config?.market).chain.ivModelDefault;
      } catch {
        ivDefault = "legacy-bs-spot";
      }
    }
    return ivDefault;
  };
  const readOptions = (ctx, o = {}) => readOptionsBase(ctx, { ...o, autoBackup: autoBackupFor(deps) });
  /** The name of a data source to show in the request log (its descriptor's name), if the sources service knows it. */
  const nameOf = (id) => {
    try {
      return deps.backupData?.registry?.get?.(id)?.descriptor?.name;
    } catch {
      return undefined;
    }
  };
  /** Tell the request log what answered this read (from the freshness labels it already returned). */
  const route = (ctx, labels) => noteRoute(ctx, labels, nameOf);

  return {
    async ltp(ctx) {
      const symbols = parseSymbolList(ctx.query.get("symbols"));
      const opts = readOptions(ctx);
      const r = await md().ltp(symbols, opts);
      route(ctx, r.items.map((i) => i.freshness));
      return { data: r.items, errors: r.errors, meta: meta(ctx, opts) };
    },

    async quotes(ctx) {
      const symbols = parseSymbolList(ctx.query.get("symbols"));
      const opts = readOptions(ctx);
      const r = await md().quotes(symbols, opts);
      route(ctx, r.items.map((i) => i.freshness));
      return { data: r.items, errors: r.errors, meta: meta(ctx, opts) };
    },

    async depth(ctx) {
      const symbol = opt(ctx.query, "symbol");
      if (!symbol) throw invalid("symbol", "symbol is required, for example NSE:RELIANCE.");
      const opts = readOptions(ctx);
      const data = await md().depth(symbol, opts);
      route(ctx, [data.freshness]);
      return { data, meta: { ...meta(ctx, opts), freshness: data.freshness } };
    },

    async history(ctx) {
      const q = ctx.query;
      const symbol = opt(q, "symbol");
      if (!symbol) throw invalid("symbol", "symbol is required, for example NSE:NIFTY.");
      const interval = opt(q, "interval");
      if (!interval) throw invalid("interval", "interval is required: 1m, 3m, 5m, 10m, 15m, 30m, 60m, 1d, 1w or 1M.");
      const format = opt(q, "format") ?? "json";
      if (format !== "json" && format !== "csv") throw invalid("format", "format must be json or csv.");
      const params = { symbol, interval };
      for (const name of ["from", "to"]) {
        const v = opt(q, name);
        if (v !== undefined) params[name] = v;
      }
      const countback = intParam(q, "countback", 1, 5000);
      if (countback !== undefined) params.countback = countback;
      const opts = readOptions(ctx, { maxAge: false });
      const data = await md().history(params, opts);
      route(ctx, [data.freshness]);
      if (format === "csv") {
        const name = `${data.symbol.replace(/[^A-Za-z0-9-]+/g, "_")}_${data.interval}.csv`;
        const headers = { "X-MCB-Partial": String(Boolean(data.partial)), "X-MCB-Freshness-Source": data.freshness.source };
        return csv(historyCsvRows(data), { filename: name, headers });
      }
      return { data, meta: { ...meta(ctx, opts), freshness: data.freshness } };
    },

    async expiries(ctx) {
      const underlying = opt(ctx.query, "underlying");
      if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
      const opts = readOptions(ctx, { maxAge: false });
      const exchange = opt(ctx.query, "exchange");
      if (exchange !== undefined) opts.exchange = exchange.toUpperCase();
      const data = await md().expiries(underlying, opts);
      route(ctx, [data.freshness]);
      return { data, meta: { ...meta(ctx, opts), freshness: data.freshness } };
    },

    async optionChain(ctx) {
      const q = ctx.query;
      const underlying = opt(q, "underlying");
      if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
      const expiry = opt(q, "expiry");
      if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
      const params = { underlying, expiry, greeks: boolParam(q, "greeks", true) };
      const strikes = intParam(q, "strikes", 1, 100);
      if (strikes !== undefined) params.strikes = strikes;
      const ivModel = opt(q, "ivModel");
      if (ivModel !== undefined) {
        if (!IV_MODELS.includes(ivModel)) throw invalid("ivModel", `ivModel must be one of ${IV_MODELS.join(", ")}.`);
        params.ivModel = ivModel;
      }
      const opts = readOptions(ctx);
      const data = await md().optionChain(params, opts);
      route(ctx, [data.freshness]);
      // The legacy model chosen by default (not asked for) is deprecated: say so in the headers (RFC 9745 / 8288). Decided
      // on the effective model, not on whether `pricing` is present (greeks=false has none under either model).
      if (ivModel === undefined && chainIvModelDefault() === "legacy-bs-spot") for (const [k, v] of Object.entries(LEGACY_IV_HEADERS)) ctx.setHeader?.(k, v);
      return { data, meta: { ...meta(ctx, opts), freshness: data.freshness } };
    },
  };
}
