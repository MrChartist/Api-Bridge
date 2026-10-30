/**
 * Market alert rules over analytics metrics — stream S15, hosted by the alerts module (one alert system: the bell's
 * inbox shows their fires; canonical routes /v1/alerts/market, PR 17's /v1/analytics/alert-rules kept as an alias). Ported from the OptionsDesk AlertRuleBuilder, but the rules
 * read the Bridge's own analytics (chain, quotes, math.mjs) and are delivered through the notify service.
 *
 *   GET    /v1/analytics/alert-rules                  the caller's rules, with their last check
 *   POST   /v1/analytics/alert-rules                  save a rule
 *   DELETE /v1/analytics/alert-rules/:ruleId          remove a rule
 *   POST   /v1/analytics/alert-rules/:ruleId/check    evaluate now (add ?dryRun=true to leave state and phone alone)
 *
 * Metrics: pcr_oi (above/below), max_pain_distance (|spot - max pain| as percent of spot, above/below), gex_regime
 * (net gamma exposure flips sign, optionally only `to` one regime), atm_iv (above/below, percent), basis_pct (futures
 * basis as percent of spot, above/below) and spot_cross (spot crosses `value`, op above/below/either), plus:
 *   unusual_count   number of unusual option contracts (unusual.mjs score >= minScore, default 50) for the expiry, above/below
 *   tide_sentiment  option-flow sentiment (tide.mjs) changes label, optionally only `to` bullish/bearish/neutral
 *   iv_rank         ATM IV rank 0-100 over the stored IV history (volStats.mjs); no data until MIN_IV_DAYS days are stored
 *   fii_net_streak  signed run of same-sign FII net days (flows.mjs): +3 = three days of buying, -3 = three of selling
 *   volume_spike    latest daily volume / average of the previous 20 days (futures when expiry is given, else spot)
 *
 * Edge trigger: a rule fires once when its condition turns true and re-arms when it clears. A threshold rule whose
 * condition is already true on its first check fires then; crossing and regime rules need a baseline first, so their
 * first check only records where things stand. A check with no data changes nothing. Rules run by themselves every
 * `everyMinutes` (market hours only unless marketHoursOnly is false) once startSchedule() is called. Read scope: a
 * rule can only read analytics and send a message, never touch an order.
 *
 * Delivery: the notify service listens to the bus, so a fired rule emits "scan.alert" (name = rule name, newMatches =
 * [message], savedId = rule id), which every notify target already understands, plus "analytics.alert" with the full
 * detail for anyone listening for it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";
import { marketSession } from "../../lib/marketHours.mjs";
import { daysBetween } from "../../lib/blackScholes.mjs";
import { netStreak, parseFiiDii } from "./flows.mjs";
import { futuresBasis, gammaExposure, ivSkew, oiAnalysis } from "./math.mjs";
import { createTideStore, tideView } from "./tide.mjs";
import { MIN_IV_DAYS, rankAndPercentile } from "./volStats.mjs";
import { scanChain } from "./unusual.mjs";

export const ALERT_METRICS = Object.freeze(["pcr_oi", "max_pain_distance", "gex_regime", "atm_iv", "basis_pct", "spot_cross", "unusual_count", "tide_sentiment", "iv_rank", "fii_net_streak", "volume_spike"]);
const THRESHOLD = new Set(["pcr_oi", "max_pain_distance", "atm_iv", "basis_pct", "unusual_count", "iv_rank", "fii_net_streak", "volume_spike"]);
/** Label-change metrics: metric -> state key and the labels `to` may name. */
const CHANGE = Object.freeze({ gex_regime: { key: "regime", to: ["positive", "negative", "neutral"] }, tide_sentiment: { key: "label", to: ["bullish", "bearish", "neutral"] } });
const NEEDS_EXPIRY = new Set(["pcr_oi", "max_pain_distance", "gex_regime", "atm_iv", "basis_pct", "unusual_count", "tide_sentiment", "iv_rank"]);
const DEFAULT_MIN_SCORE = 50;
const VOLUME_DAYS = 20;
/** metric -> the field of the metrics object it reads */
const FIELD = Object.freeze({ pcr_oi: "pcrOi", max_pain_distance: "maxPainDistancePct", gex_regime: "gexRegime", atm_iv: "atmIv", basis_pct: "basisPct", spot_cross: "spot", unusual_count: "unusualCount", tide_sentiment: "tideSentiment", iv_rank: "ivRank", fii_net_streak: "fiiNetStreak", volume_spike: "volumeRatio" });
const MAX_RULES = 100;

export const alertRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    underlying: z.string().trim().regex(/^[A-Za-z0-9&_-]{1,30}$/, "an underlying such as NIFTY"),
    /** YYYY-MM-DD; needed by every metric except spot_cross. */
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional(),
    metric: z.enum(ALERT_METRICS),
    /** above / below for thresholds; for spot_cross the direction of the crossing (default either). */
    op: z.enum(["above", "below", "either"]).optional(),
    value: z.number().finite().optional(),
    /** gex_regime only: fire only when the regime changes to this one. */
    to: z.enum(["positive", "negative", "neutral", "bullish", "bearish"]).optional(),
    /** unusual_count only: the least unusual-activity score (0-100) a contract needs to be counted. Default 50. */
    minScore: z.number().min(0).max(100).optional(),
    everyMinutes: z.number().int().min(1).max(1440).optional(),
    marketHoursOnly: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = (path, message) => ctx.addIssue({ code: "custom", path: [path], message });
    if (NEEDS_EXPIRY.has(r.metric) && !r.expiry) bad("expiry", `expiry is required for ${r.metric}.`);
    if (THRESHOLD.has(r.metric)) {
      if (r.value === undefined) bad("value", `value is required for ${r.metric}.`);
      if (r.op !== "above" && r.op !== "below") bad("op", `op must be above or below for ${r.metric}.`);
    }
    if (r.metric === "spot_cross" && r.value === undefined) bad("value", "value (the level) is required for spot_cross.");
    if (r.to !== undefined && !CHANGE[r.metric]) bad("to", "to applies to gex_regime and tide_sentiment only.");
    else if (r.to !== undefined && !CHANGE[r.metric].to.includes(r.to)) bad("to", `to must be one of ${CHANGE[r.metric].to.join(", ")} for ${r.metric}.`);
    if (r.minScore !== undefined && r.metric !== "unusual_count") bad("minScore", "minScore applies to unusual_count only.");
  });

const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const LABEL = { pcr_oi: "PCR (OI)", max_pain_distance: "Max pain distance %", atm_iv: "ATM IV %", basis_pct: "Futures basis %", spot_cross: "Spot", gex_regime: "Net GEX regime", unusual_count: "Unusual contracts", tide_sentiment: "Flow sentiment", iv_rank: "ATM IV rank", fii_net_streak: "FII net streak (days, + buying)", volume_spike: "Volume vs 20-day average (x)" };

/**
 * Pure edge-triggered evaluation. `metrics` is { pcrOi, maxPainDistancePct, gexRegime, atmIv, basisPct, spot, unusualCount, tideSentiment, ivRank, fiiNetStreak, volumeRatio } (null
 * or missing when unknown). `rule.state` is what the previous check left behind; it is not mutated, the new state is
 * returned. @returns {{ fired: boolean, status: "ok"|"baseline"|"no_data", value: number|string|null, condition: boolean|null, state: object, message: string|null }}
 */
export function evaluateRule(rule, metrics) {
  const prev = rule.state && typeof rule.state === "object" ? rule.state : {};
  const value = metrics?.[FIELD[rule.metric]] ?? null;
  const label = LABEL[rule.metric];
  const none = { fired: false, status: "no_data", value: null, condition: null, state: { ...prev }, message: null };

  const change = CHANGE[rule.metric];
  if (change) {
    if (typeof value !== "string") return none;
    const was = prev[change.key];
    if (was === undefined) return { ...none, status: "baseline", value, state: { [change.key]: value } };
    const changed = value !== was && (!rule.to || rule.to === value);
    return { fired: changed, status: "ok", value, condition: changed, state: { [change.key]: value }, message: changed ? `${rule.underlying} ${label} changed from ${was} to ${value}` : null };
  }
  if (!isNum(value)) return none;

  if (rule.metric === "spot_cross") {
    const level = rule.value;
    const side = value > level ? "above" : value < level ? "below" : (prev.side ?? null);
    if (prev.side === undefined || prev.side === null) return { ...none, status: side ? "baseline" : "no_data", value, state: side ? { side } : {} };
    const crossed = side !== prev.side && (!rule.op || rule.op === "either" || rule.op === side);
    return { fired: crossed, status: "ok", value, condition: crossed, state: { side }, message: crossed ? `${rule.underlying} ${label} crossed ${side} ${level} (now ${value})` : null };
  }

  const condition = rule.op === "above" ? value > rule.value : value < rule.value;
  const fired = condition && prev.active !== true;
  return { fired, status: "ok", value, condition, state: { active: condition }, message: fired ? `${rule.underlying} ${label} is ${rule.op} ${rule.value} (now ${value})` : null };
}

/**
 * Gather what a rule needs through marketData and math.mjs: only the data for its own metric.
 * @param {object} rule
 * @param {{ marketData: object }} deps
 * @param {object} [opts] marketData read options (allowedAccounts, accountId, signal ...)
 * @returns {Promise<object>} metrics for evaluateRule, plus `freshness` when the source reports one
 */
export async function metricsFor(rule, deps, opts = {}) {
  const md = deps.marketData;
  const u = rule.underlying.toUpperCase();
  const out = {};
  const chain = (greeks) => md.optionChain({ underlying: u, expiry: rule.expiry, greeks }, opts);
  switch (rule.metric) {
    case "pcr_oi": {
      const c = await chain(false);
      out.pcrOi = oiAnalysis(c).pcrOi;
      out.freshness = c.freshness;
      break;
    }
    case "max_pain_distance": {
      const c = await chain(false);
      const mp = oiAnalysis(c).maxPain;
      const spot = Number(c.underlyingLtp);
      out.spot = spot > 0 ? spot : null;
      out.maxPain = mp;
      out.maxPainDistancePct = mp !== null && spot > 0 ? round((Math.abs(spot - mp) / spot) * 100) : null;
      out.freshness = c.freshness;
      break;
    }
    case "gex_regime": {
      const c = await chain(true);
      out.gexRegime = gammaExposure(c).regime;
      out.freshness = c.freshness;
      break;
    }
    case "atm_iv": {
      const c = await chain(true);
      out.atmIv = ivSkew(c).atmIv;
      out.freshness = c.freshness;
      break;
    }
    case "basis_pct": {
      const fx = defaultOptionExchange(u);
      const spotSym = `${fx === "BFO" ? "BSE" : "NSE"}:${u}`;
      const futSym = `${fx}:${u}-${rule.expiry}-FUT`;
      const r = await md.quotes([spotSym, futSym], opts);
      const px = (s) => r.items.find((i) => i.symbol === s)?.ltp ?? null;
      out.spot = px(spotSym);
      out.basisPct = futuresBasis({ spot: out.spot, future: px(futSym), daysToExpiry: daysBetween(new Date(), rule.expiry) }).basisPct;
      break;
    }
    case "spot_cross": {
      const fx = defaultOptionExchange(u);
      const sym = `${fx === "BFO" ? "BSE" : "NSE"}:${u}`;
      const r = await md.ltp([sym], opts);
      out.spot = r.items.find((i) => i.symbol === sym)?.ltp ?? null;
      break;
    }
    case "unusual_count": {
      const c = await chain(true);
      const min = rule.minScore ?? DEFAULT_MIN_SCORE;
      out.unusualCount = scanChain(c).filter((x) => x.score >= min).length;
      out.freshness = c.freshness;
      break;
    }
    case "tide_sentiment": {
      const c = await chain(false);
      const store = tideStoreFor(deps);
      store.record(u, rule.expiry, c);
      const s = tideView(store.session(u)).sentiment;
      out.tideSentiment = s.score === null ? null : s.label;
      out.freshness = c.freshness;
      break;
    }
    case "iv_rank": {
      const c = await chain(true);
      const atm = ivSkew(c).atmIv;
      out.atmIv = isNum(atm) ? atm : null;
      const series = storedIvSeries(deps, u).map((p) => p.iv);
      if (out.atmIv !== null) series.push(out.atmIv); // today's reading as the newest point; a same-day stored point only adds a duplicate
      out.ivHistoryDays = series.length;
      out.ivRank = out.atmIv !== null && series.length >= MIN_IV_DAYS ? rankAndPercentile(series).rank : null;
      out.freshness = c.freshness;
      break;
    }
    case "fii_net_streak": {
      const rows = await fiiRows(deps);
      const s = netStreak(rows, "fii");
      out.fiiNetStreak = rows.length ? (s.direction === "selling" ? -s.count : s.count) : null;
      break;
    }
    case "volume_spike": {
      const fx = defaultOptionExchange(u);
      const sym = rule.expiry ? `${fx}:${u}-${rule.expiry}-FUT` : `${fx === "BFO" ? "BSE" : "NSE"}:${u}`;
      const h = await md.history({ symbol: sym, interval: "1d", countback: VOLUME_DAYS + 1 }, opts);
      const vols = (h.candles ?? []).map((k) => Number(k?.volume));
      const latest = vols.at(-1);
      const prior = vols.slice(0, -1).filter((v) => v > 0);
      const avg = prior.length >= 5 ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
      out.volumeRatio = isNum(latest) && latest > 0 && avg ? round(latest / avg, 2) : null;
      out.freshness = h.freshness;
      break;
    }
    default:
      throw new BridgeError("VALIDATION_FAILED", `Unknown alert metric ${rule.metric}.`);
  }
  return out;
}

const tideStores = new WeakMap();
/** deps.tide when the host shares one, else a store of our own (kept in memory, one per deps). */
function tideStoreFor(deps) {
  if (deps.tide) return deps.tide;
  let s = tideStores.get(deps);
  if (!s) tideStores.set(deps, (s = createTideStore({ clock: deps.clock ?? { now: () => Date.now() } })));
  return s;
}

/**
 * Local helper (volStats keeps its IV history private to its route closure, so it cannot be imported): the stored
 * ATM IV series for an underlying from <dataDir>/analytics/iv-history.json, oldest first. Read only; [] when absent.
 */
function storedIvSeries(deps, underlying) {
  const dataDir = deps.paths?.dataDir;
  if (!dataDir) return [];
  try {
    const pts = JSON.parse(readFileSync(join(dataDir, "analytics", "iv-history.json"), "utf8"))?.series?.[underlying];
    if (!Array.isArray(pts)) return [];
    return pts.filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && isNum(p.iv) && p.iv > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    return [];
  }
}

const fiiCache = new WeakMap();
/**
 * Local helper (flows.mjs does not export its history or default fetcher): FII/DII sessions newest first, from
 * deps.fiiDiiFetcher (+ parseFiiDii) when the host provides one, else the rows flows.mjs persisted to
 * <dataDir>/analytics/fii-dii.json. Cached 5 minutes. [] when neither is available.
 */
async function fiiRows(deps) {
  const t = deps.clock?.now?.() ?? Date.now();
  const hit = fiiCache.get(deps);
  if (hit && t - hit.at < 5 * 60_000) return hit.rows;
  let rows = [];
  if (typeof deps.fiiDiiFetcher === "function") {
    try {
      rows = parseFiiDii(await deps.fiiDiiFetcher());
    } catch {
      rows = [];
    }
  }
  if (!rows.length && deps.paths?.dataDir) {
    try {
      const raw = JSON.parse(readFileSync(join(deps.paths.dataDir, "analytics", "fii-dii.json"), "utf8"));
      rows = (Array.isArray(raw?.rows) ? raw.rows : []).filter((r) => r && typeof r.date === "string" && isNum(r.fii?.net) && isNum(r.dii?.net));
    } catch {
      rows = [];
    }
  }
  rows = [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  fiiCache.set(deps, { at: t, rows });
  return rows;
}

const newId = () => `arule_${randomBytes(8).toString("hex")}`;

/**
 * The rule store and runner.
 * @param {{ marketData: object, bus?: object, clock: { now(): number }, paths?: { dataDir: string }, logger?: object }} deps
 */
export function createAlertRules(deps) {
  const log = deps.logger?.child ? deps.logger.child({ module: "alert-rules" }) : deps.logger;
  const now = () => deps.clock.now();
  const iso = (t = now()) => new Date(t).toISOString();
  const filePath = deps.paths?.dataDir ? join(deps.paths.dataDir, "analytics", "alert-rules.json") : null;
  let timer = null;

  function load() {
    if (!filePath || !existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      return Array.isArray(raw?.rules) ? raw.rules : [];
    } catch (err) {
      log?.warn?.("could not read alert rules; starting with none", { err: err?.message });
      return [];
    }
  }
  const rules = load();
  const persist = () => {
    if (filePath) writeFileAtomic(filePath, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);
  };
  const safePersist = () => {
    try {
      persist();
    } catch (err) {
      log?.warn?.("could not save alert rules", { err: err?.message });
    }
  };

  deps.bus?.on?.("key.revoked", ({ keyId } = {}) => {
    if (!keyId) return;
    let changed = false;
    for (const r of rules) if (r.keyId === keyId && !r.disabledReason) ((r.disabledReason = "key revoked"), (changed = true));
    if (changed) safePersist();
  });

  function notify(rule, result) {
    const at = iso();
    const payload = { keyId: rule.keyId ?? null, savedId: rule.id, ruleId: rule.id, name: rule.name, newMatches: [result.message], message: result.message, metric: rule.metric, underlying: rule.underlying, expiry: rule.expiry ?? null, value: result.value, at };
    deps.bus?.emit?.("scan.alert", payload);
    deps.bus?.emit?.("analytics.alert", payload);
  }

  /** Evaluate one stored rule now. `dryRun` leaves its state alone and sends nothing. */
  async function check(rule, { dryRun = false, signal, priority } = {}) {
    const opts = {};
    if (priority) opts.priority = priority;
    if (rule.allowedAccounts) opts.allowedAccounts = rule.allowedAccounts;
    if (signal) opts.signal = signal;
    const metrics = await metricsFor(rule, deps, opts);
    const result = evaluateRule(rule, metrics);
    const checkedAt = iso();
    if (!dryRun) {
      rule.state = result.state;
      rule.lastCheck = { at: checkedAt, status: result.status, value: result.value, condition: result.condition, fired: result.fired };
      delete rule.lastError;
      if (result.fired) {
        rule.lastFiredAt = checkedAt;
        rule.fireCount = (rule.fireCount ?? 0) + 1;
      }
      safePersist();
      if (result.fired) notify(rule, result);
    }
    return { id: rule.id, name: rule.name, dryRun, checkedAt, fired: result.fired, status: result.status, condition: result.condition, value: result.value, message: result.message, freshness: metrics.freshness ?? null };
  }

  const due = (r, t) => {
    if (!r.enabled || !r.everyMinutes || r.disabledReason) return false;
    if (r.marketHoursOnly !== false) {
      const st = marketSession(new Date(t)).state;
      if (st !== "OPEN" && st !== "SPECIAL") return false;
    }
    return t - (r.lastStartedAt ? Date.parse(r.lastStartedAt) : 0) >= r.everyMinutes * 60_000;
  };

  const api = {
    list: () => rules.map((r) => structuredClone(r)),
    get: (id) => rules.find((r) => r.id === id) ?? null,
    save(input, who = {}) {
      const parsed = alertRuleSchema.safeParse(input ?? {});
      if (!parsed.success) throw fromValidation(parsed.error);
      if (rules.length >= MAX_RULES) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_RULES} alert rules.`);
      const rule = { id: newId(), ...parsed.data, underlying: parsed.data.underlying.toUpperCase(), allowedAccounts: who.allowedAccounts, keyId: who.keyId ?? null, createdAt: iso(), state: {}, lastCheck: null, lastFiredAt: null, fireCount: 0, lastStartedAt: null };
      rules.push(rule);
      try {
        persist();
      } catch (err) {
        rules.pop(); // a rule that could not be stored would vanish on restart, so do not pretend it exists
        log?.warn?.("could not save alert rules", { err: err?.message });
        throw new BridgeError("INTERNAL", "The alert rule could not be saved to disk.");
      }
      return structuredClone(rule);
    },
    remove(id) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) throw new BridgeError("NOT_FOUND", `No alert rule ${id}.`);
      const [r] = rules.splice(i, 1);
      try {
        persist();
      } catch (err) {
        rules.splice(i, 0, r);
        log?.warn?.("could not save alert rules", { err: err?.message });
        throw new BridgeError("INTERNAL", "The alert rule could not be removed from disk, so it was kept.");
      }
      return r;
    },
    check,
    /** Run every rule that is due. */
    async tick() {
      const t = now();
      for (const r of rules) {
        if (!due(r, t)) continue;
        r.lastStartedAt = iso(t);
        try {
          await check(r, { priority: "background" });
        } catch (err) {
          r.lastError = { code: err?.code ?? "INTERNAL", message: err?.detail ?? "Internal error.", at: iso(t) };
          safePersist();
        }
      }
    },
    startSchedule() {
      if (timer) return;
      timer = setInterval(() => api.tick().catch((err) => log?.warn?.("alert rule tick failed", { err: err?.message })), 30_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return api;
}

const services = new WeakMap();
/** The one rule service for these deps (the lead may call .startSchedule() / .stop() from the module lifecycle). */
export function alertRulesFor(deps) {
  let s = services.get(deps);
  if (!s) services.set(deps, (s = createAlertRules(deps)));
  return s;
}

const seesAll = (ctx) => ctx.principal?.kind === "local" || ctx.scopes?.has?.("admin");
// A rule with no keyId belongs to the local owner; a caller with no key must not match it by both being null.
const owns = (ctx, rec) => seesAll(ctx) || (rec.keyId != null && rec.keyId === ctx.key?.id);
const who = (ctx) => ({ allowedAccounts: allowedAccountsFor(ctx), keyId: ctx.key?.id ?? null });
const view = ({ allowedAccounts: _a, keyId: _k, ...r }) => r;

/** @returns {Array<[string, string, object, (ctx: object) => Promise<object>]>} */
export function alertRuleRoutes(deps, { base = "/v1/analytics/alert-rules" } = {}) {
  const svc = alertRulesFor(deps);
  const find = (ctx) => {
    const r = svc.get(ctx.params.ruleId);
    if (!r || !owns(ctx, r)) throw new BridgeError("NOT_FOUND", `No alert rule ${ctx.params.ruleId}.`);
    return r;
  };
  return [
    ["GET", base, { scope: "read" }, async (ctx) => ({ data: svc.list().filter((r) => owns(ctx, r)).map(view), meta: { requestId: ctx.requestId } })],
    ["POST", base, { scope: "read" }, async (ctx) => json({ data: view(svc.save(ctx.body, who(ctx))), meta: { requestId: ctx.requestId } }, { status: 201 })],
    [
      "DELETE",
      `${base}/:ruleId`,
      { scope: "read", body: "none" },
      async (ctx) => {
        const r = find(ctx);
        svc.remove(r.id);
        return { data: { id: r.id, deleted: true }, meta: { requestId: ctx.requestId } };
      },
    ],
    [
      "POST",
      `${base}/:ruleId/check`,
      { scope: "read", body: "none" },
      async (ctx) => {
        const r = find(ctx);
        const dryRun = ["1", "true"].includes(ctx.query?.get?.("dryRun") ?? "");
        return { data: await svc.check(r, { dryRun, signal: ctx.signal }), meta: { requestId: ctx.requestId } };
      },
    ],
  ];
}
