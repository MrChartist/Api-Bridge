/**
 * Market Tide for stream S15: net call versus put premium flow through the Indian trading session, in the style of
 * Unusual Whales' Market Tide. Read-only. Every call to the route (or to recordTide) reads the option chain and keeps a
 * snapshot of per-contract cumulative volume, ltp and bid/ask in a bounded per-underlying ring. Between two consecutive
 * snapshots, premium traded per contract is estimated as
 *     (volume now - volume before) x mid price (volume in units on this Bridge)
 * where mid is (bid + ask) / 2 when both sides are quoted, else ltp. It is split into call and put, and into buy- and
 * sell-aggressive with a PROXY: where the last traded price sits inside the bid/ask spread (position = (ltp - bid) /
 * (ask - bid); at or above AGGRESSOR_BUY_AT counts as bought at the ask, at or below AGGRESSOR_SELL_AT as sold at the
 * bid, in between or without a usable spread it is unclassified). The bridge has no trade tape, so this is an
 * estimate, not exchange-reported trade direction. Snapshots only exist when the route (or recordTide) is called, so
 * gaps in calling are gaps in the series; an interval's flow is attributed to the end of the interval.
 *
 *   GET /v1/analytics/tide?underlying=NIFTY[&expiry=][&windowMin=][&strikes=][&top=5]
 *
 * The session series is persisted atomically to <dataDir>/analytics/tide-<UNDERLYING>.json (0600), loaded lazily, and
 * reset on a new IST trading day or when the expiry being tracked changes. Disk errors never fail a request.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { nowMsOf, unitMultiplier, upcomingExpiries } from "./math.mjs";
import { demoChainAt } from "../demo/demoAdapter.mjs";
import { DEFAULT_SESSIONS } from "../reference/defaults.mjs";

/** Proxy thresholds: share of the bid-ask spread at which an ltp is read as an aggressive buy or sell. */
export const AGGRESSOR_BUY_AT = 0.6;
export const AGGRESSOR_SELL_AT = 0.4;
/** Sentiment: |directional premium| / classified premium must exceed this to leave neutral. */
export const SENTIMENT_THRESHOLD = 0.1;
export const AGGRESSOR_NOTE = "buy/sell split is a proxy from where ltp sits inside the bid-ask spread, not exchange trade direction";

const IST_OFFSET_MS = 330 * 60_000;
const UNDERLYING_RE = /^[A-Z0-9][A-Z0-9_&-]{0,29}$/;
const FILE_VERSION = 1;

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pos = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** IST calendar day (YYYY-MM-DD) of an epoch-ms instant. */
export const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Mid of a quote: (bid + ask) / 2 when both are positive and not crossed, else ltp, else null. */
export function midPrice({ bid, ask, ltp }) {
  const b = pos(bid);
  const a = pos(ask);
  if (b !== null && a !== null && a >= b) return (a + b) / 2;
  return pos(ltp);
}

/** Proxy aggressor side from ltp inside the spread: "buy", "sell" or null (unclassified). */
export function aggressorSide({ bid, ask, ltp }) {
  const b = pos(bid);
  const a = pos(ask);
  const p = pos(ltp);
  if (b === null || a === null || p === null || a <= b) return null;
  const at = (p - b) / (a - b);
  if (at >= AGGRESSOR_BUY_AT) return "buy";
  if (at <= AGGRESSOR_SELL_AT) return "sell";
  return null;
}

/** Compact per-contract snapshot of a chain: { ts, contracts: Map<"strike|CE", { strike, side, volume, ltp, bid, ask }> }. */
export function tideSnapshot(chain, ts) {
  const contracts = new Map();
  for (const r of chain?.rows ?? []) {
    const strike = Number(r?.strike);
    if (!Number.isFinite(strike)) continue;
    for (const [side, leg] of [["CE", r.ce], ["PE", r.pe]]) {
      if (!leg) continue;
      const volume = Number(leg.volume);
      if (!Number.isFinite(volume) || volume < 0) continue;
      contracts.set(`${strike}|${side}`, { strike, side, volume, ltp: pos(leg.ltp), bid: pos(leg.bid), ask: pos(leg.ask) });
    }
  }
  return { ts, contracts };
}

const blank = () => ({ callPremium: 0, putPremium: 0, callBuy: 0, callSell: 0, putBuy: 0, putSell: 0 });
const addFlow = (into, side, aggr, premium) => {
  const call = side === "CE";
  into[call ? "callPremium" : "putPremium"] += premium;
  if (aggr === "buy") into[call ? "callBuy" : "putBuy"] += premium;
  else if (aggr === "sell") into[call ? "callSell" : "putSell"] += premium;
};
/** Calls bought and puts sold are bullish; calls sold and puts bought are bearish. Unclassified flow is excluded. */
const directional = (f) => f.callBuy - f.callSell - (f.putBuy - f.putSell);

/**
 * Premium flow in the interval between two snapshots. Contracts missing from either snapshot, or whose cumulative
 * volume went down (a feed reset), contribute nothing.
 * @returns {{ flow: object, byStrike: Map<number, object> }}
 */
export function intervalFlow(prev, cur, lotSize = 1) {
  const flow = blank();
  const byStrike = new Map();
  const lot = Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 1;
  for (const [key, now] of cur.contracts) {
    const was = prev.contracts.get(key);
    if (!was) continue;
    const dv = now.volume - was.volume;
    if (!(dv > 0)) continue;
    const mid = midPrice(now);
    if (mid === null) continue;
    const premium = dv * mid * lot;
    const aggr = aggressorSide(now);
    addFlow(flow, now.side, aggr, premium);
    const sf = byStrike.get(now.strike) ?? blank();
    addFlow(sf, now.side, aggr, premium);
    byStrike.set(now.strike, sf);
  }
  return { flow, byStrike };
}

const freshState = (day, expiry) => ({ day, expiry, lotSize: null, points: [], totals: blank(), cumulativeNet: 0, cumulativeDeltaAdjusted: 0, strikes: new Map(), ring: [] });

function serialise(st, underlying) {
  return JSON.stringify({
    version: FILE_VERSION,
    underlying,
    day: st.day,
    expiry: st.expiry,
    lotSize: st.lotSize,
    points: st.points,
    totals: st.totals,
    cumulativeNet: st.cumulativeNet,
    cumulativeDeltaAdjusted: st.cumulativeDeltaAdjusted,
    strikes: [...st.strikes].map(([strike, f]) => ({ strike, ...f })),
  });
}

const FLOW_KEYS = Object.keys(blank());
const isFlow = (o) => o && typeof o === "object" && FLOW_KEYS.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
const POINT_KEYS = [...FLOW_KEYS, "ts", "net", "cumulativeNet", "cumulativeDeltaAdjusted"];

/** Parse a persisted file; null when it is malformed, from another version, or from a different day. */
function parseFile(text, underlying, day) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || j.version !== FILE_VERSION || j.underlying !== underlying || j.day !== day || typeof j.expiry !== "string") return null;
  if (!Array.isArray(j.points) || !j.points.every((p) => p && POINT_KEYS.every((k) => typeof p[k] === "number" && Number.isFinite(p[k])))) return null;
  if (!isFlow(j.totals) || !Number.isFinite(j.cumulativeNet) || !Number.isFinite(j.cumulativeDeltaAdjusted) || !Array.isArray(j.strikes)) return null;
  const st = freshState(day, j.expiry);
  st.lotSize = Number.isFinite(j.lotSize) && j.lotSize > 0 ? j.lotSize : null;
  st.points = j.points.map((p) => ({ ...p }));
  st.totals = { ...j.totals };
  st.cumulativeNet = j.cumulativeNet;
  st.cumulativeDeltaAdjusted = j.cumulativeDeltaAdjusted;
  for (const s of j.strikes) if (Number.isFinite(s?.strike) && isFlow(s)) st.strikes.set(s.strike, Object.fromEntries(FLOW_KEYS.map((k) => [k, s[k]])));
  return st;
}

/**
 * Per-underlying session store.
 * @param {{ clock?: { now(): number }, dataDir?: string | null, maxSnapshots?: number, maxPoints?: number, maxKeys?: number, minIntervalMs?: number }} [o]
 *   dataDir null disables persistence. Reads closer together than minIntervalMs are not recorded.
 */
export function createTideStore({ clock = { now: () => Date.now() }, dataDir = null, maxSnapshots = 8, maxPoints = 2000, maxKeys = 32, minIntervalMs = 15_000 } = {}) {
  /** @type {Map<string, object>} insertion order doubles as least-recently-used order */
  const states = new Map();
  const fileOf = (u) => join(dataDir, "analytics", `tide-${u}.json`);

  function persist(u, st) {
    if (!dataDir) return "disabled";
    try {
      writeFileAtomic(fileOf(u), serialise(st, u));
      return "ok";
    } catch {
      return "failed";
    }
  }

  function stateFor(u, day) {
    let st = states.get(u);
    if (!st && dataDir) {
      try {
        st = parseFile(readFileSync(fileOf(u), "utf8"), u, day) ?? undefined;
      } catch {
        st = undefined;
      }
    }
    if (st) {
      states.delete(u);
      states.set(u, st);
      while (states.size > maxKeys) states.delete(states.keys().next().value);
    }
    return st;
  }

  return {
    clock,
    /** Record a chain read. Returns { recorded, reason?, persistence }. */
    record(underlying, expiry, chain) {
      const u = String(underlying).toUpperCase();
      const ts = clock.now();
      const day = istDay(ts);
      let st = stateFor(u, day);
      if (!st || st.day !== day || st.expiry !== expiry) {
        st = freshState(day, expiry);
        states.delete(u);
        states.set(u, st);
        while (states.size > maxKeys) states.delete(states.keys().next().value);
      }
      // Volume is in units on this Bridge: the multiplier is 1 unless the chain counts contracts (units: "lots").
      const lot = pos(chain?.lotSize) === null ? null : unitMultiplier(chain);
      if (lot !== null) st.lotSize = lot;
      const snap = tideSnapshot(chain, ts);
      const last = st.ring.at(-1);
      if (last && ts - last.ts < minIntervalMs) return { recorded: false, reason: "min_spacing", persistence: "unchanged" };
      if (last && ts > last.ts) {
        const { flow, byStrike } = intervalFlow(last, snap, st.lotSize ?? 1);
        const net = flow.callPremium - flow.putPremium;
        st.cumulativeNet += net;
        st.cumulativeDeltaAdjusted += directional(flow);
        for (const k of FLOW_KEYS) st.totals[k] += flow[k];
        for (const [strike, f] of byStrike) {
          const into = st.strikes.get(strike) ?? blank();
          for (const k of FLOW_KEYS) into[k] += f[k];
          st.strikes.set(strike, into);
        }
        const r = (v) => round(v, 2);
        st.points.push({
          ts,
          callPremium: r(flow.callPremium),
          putPremium: r(flow.putPremium),
          callBuy: r(flow.callBuy),
          callSell: r(flow.callSell),
          putBuy: r(flow.putBuy),
          putSell: r(flow.putSell),
          net: r(net),
          cumulativeNet: r(st.cumulativeNet),
          cumulativeDeltaAdjusted: r(st.cumulativeDeltaAdjusted),
        });
        while (st.points.length > maxPoints) st.points.shift();
      }
      st.ring.push(snap);
      while (st.ring.length > maxSnapshots) st.ring.shift();
      return { recorded: true, persistence: persist(u, st) };
    },
    /** The session state for an underlying today (loading it lazily from disk), or null. */
    session(underlying) {
      const u = String(underlying).toUpperCase();
      const st = stateFor(u, istDay(clock.now()));
      return st && st.day === istDay(clock.now()) ? st : null;
    },
    clear() {
      states.clear();
    },
  };
}

/** Sentiment from the session's directional premium. Neutral inside +/- SENTIMENT_THRESHOLD of classified premium. */
export function tideSentiment(totals) {
  const classified = totals.callBuy + totals.callSell + totals.putBuy + totals.putSell;
  const base = { threshold: SENTIMENT_THRESHOLD, rule: "score = (callBuy - callSell - putBuy + putSell) / classified premium; bullish above +threshold, bearish below -threshold; calls bought and puts sold are bullish", proxy: true };
  if (!(classified > 0)) return { ...base, label: "neutral", score: null, reason: "no classified flow yet" };
  const score = directional(totals) / classified;
  return { ...base, label: score > SENTIMENT_THRESHOLD ? "bullish" : score < -SENTIMENT_THRESHOLD ? "bearish" : "neutral", score: round(score, 4) };
}

/** Build the response payload from a session state. */
export function tideView(st, { windowMin, top = 5, nowMs } = {}) {
  const t = st?.totals ?? blank();
  const allPoints = st?.points ?? [];
  const cut = windowMin ? (nowMs ?? allPoints.at(-1)?.ts ?? 0) - windowMin * 60_000 : -Infinity;
  const points = allPoints.filter((p) => p.ts >= cut);
  const series = points.map((p) => ({ time: new Date(p.ts).toISOString(), ...p }));
  const rankedStrikes = [...(st?.strikes ?? [])]
    .map(([strike, f]) => ({ strike, callPremium: round(f.callPremium), putPremium: round(f.putPremium), totalPremium: round(f.callPremium + f.putPremium), net: round(f.callPremium - f.putPremium), directionalNet: round(directional(f)) }))
    .sort((a, b) => b.totalPremium - a.totalPremium || a.strike - b.strike)
    .slice(0, top);
  const win = blank();
  for (const p of points) for (const k of FLOW_KEYS) win[k] += p[k];
  return {
    day: st?.day ?? null,
    expiry: st?.expiry ?? null,
    lotSize: st?.lotSize ?? null,
    lotSizeAssumed: st ? st.lotSize == null : null,
    intervals: allPoints.length,
    series,
    totals: {
      callPremium: round(t.callPremium),
      putPremium: round(t.putPremium),
      net: round(t.callPremium - t.putPremium),
      cumulativeNet: round(st?.cumulativeNet ?? 0),
      cumulativeDeltaAdjusted: round(st?.cumulativeDeltaAdjusted ?? 0),
      callBuyAggressive: round(t.callBuy),
      callSellAggressive: round(t.callSell),
      putBuyAggressive: round(t.putBuy),
      putSellAggressive: round(t.putSell),
      unclassified: round(t.callPremium + t.putPremium - (t.callBuy + t.callSell + t.putBuy + t.putSell)),
    },
    ...(windowMin ? { window: { minutes: windowMin, callPremium: round(win.callPremium), putPremium: round(win.putPremium), net: round(win.callPremium - win.putPremium), directionalNet: round(directional(win)) } } : {}),
    sentiment: tideSentiment(t),
    topStrikes: rankedStrikes,
    notes: [AGGRESSOR_NOTE, "premium = change in cumulative volume (units) x mid price between consecutive snapshots; snapshots exist only when this route is called"],
  };
}

const stores = new WeakMap();
/** The store shared by the route and recordTide: deps.tide when given, else one created per deps object. */
/** Demo mode replays the session up to now through this clock (seedDemoSession); otherwise it is the real clock. */
const replayAt = new WeakMap();
function storeFor(deps) {
  if (deps.tide) return deps.tide;
  let s = stores.get(deps);
  if (!s) {
    s = createTideStore({ clock: { now: () => replayAt.get(deps) ?? nowMsOf(deps) }, dataDir: deps.paths?.dataDir ?? null });
    stores.set(deps, s);
  }
  return s;
}

const isDemo = (deps) => {
  try {
    return Boolean(deps.config?.demo);
  } catch {
    return false;
  }
};
/**
 * The demo quotes its options with the last price at the middle of the spread, which the bid/ask aggressor proxy
 * cannot classify. For the replayed session only, each print leans toward the bid or the ask (per contract and
 * interval, between 15 % and 85 % of the spread), as real prints do when buyers or sellers press. Pure.
 */
export function leanPrints(chain, t) {
  if (!chain) return null;
  const lean = (key) => {
    let x = 2166136261;
    for (const ch of `${key}|${Math.floor(t / 300_000)}`) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
    return 0.15 + 0.7 * (x / 4294967296);
  };
  const leg = (l, key) => {
    if (!l || !(l.ask > l.bid) || !(l.ltp > 0)) return l;
    const spread = l.ask - l.bid;
    const f = lean(key);
    return { ...l, bid: Math.max(0, l.ltp - spread * f), ask: l.ltp + spread * (1 - f) };
  };
  return { ...chain, rows: chain.rows.map((r) => ({ ...r, ce: leg(r.ce, `${r.strike}CE`), pe: leg(r.pe, `${r.strike}PE`) })) };
}

const seeded = new WeakMap();
/**
 * Demo mode: a Bridge that just started has no readings yet, so the chart would be empty for minutes. The demo chain
 * is known at any instant, so the session so far (open to now, or to the close) is replayed every 5 minutes into the
 * store, once per underlying, expiry and day. Never used outside demo mode.
 */
function seedDemoSession(deps, store, underlying, expiry) {
  const now = nowMsOf(deps);
  const day = istDay(now);
  const key = `${underlying}|${expiry}|${day}`;
  const done = seeded.get(deps) ?? new Set();
  seeded.set(deps, done);
  if (done.has(key) || (store.session(underlying)?.points?.length ?? 0) > 3) return;
  done.add(key);
  const { open, close } = DEFAULT_SESSIONS.NSE;
  const from = Date.parse(`${day}T${open}:00+05:30`);
  const to = Math.min(now - 60_000, Date.parse(`${day}T${close}:00+05:30`));
  try {
    for (let t = from; t <= to; t += 5 * 60_000) {
      const chain = leanPrints(demoChainAt(underlying, expiry, t), t);
      if (!chain) break;
      replayAt.set(deps, t);
      store.record(underlying, expiry, chain);
    }
  } finally {
    replayAt.delete(deps);
  }
}

function cleanUnderlying(v) {
  if (!v) throw invalid("underlying", "underlying is required, for example NIFTY.");
  const u = v.toUpperCase();
  if (!UNDERLYING_RE.test(u)) throw invalid("underlying", "underlying may only contain letters, digits, _, & and -.");
  return u;
}

async function resolveExpiry(deps, underlying, expiry, opts) {
  if (expiry) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry must be YYYY-MM-DD.");
    return expiry;
  }
  const list = await deps.marketData.expiries(underlying, opts);
  const next = upcomingExpiries(list.expiries, nowMsOf(deps))[0];
  if (!next) throw invalid("expiry", `No upcoming expiry is listed for ${underlying}; pass expiry=YYYY-MM-DD.`);
  return next;
}

/**
 * Take one snapshot for an underlying without answering a request, for a scheduler to call. Uses the nearest upcoming
 * expiry unless one is given. Market data errors propagate; disk errors never do.
 * @param {object} deps needs marketData; optional paths.dataDir, tide, clock
 * @param {string} underlying
 * @param {{ expiry?: string, strikes?: number, signal?: AbortSignal }} [o]
 */
export async function recordTide(deps, underlying, { expiry, strikes, signal } = {}) {
  const u = cleanUnderlying(underlying);
  const opts = { signal };
  const exp = await resolveExpiry(deps, u, expiry, opts);
  const params = { underlying: u, expiry: exp };
  if (strikes !== undefined) params.strikes = strikes;
  const chain = await deps.marketData.optionChain(params, opts);
  return { underlying: u, expiry: exp, ...storeFor(deps).record(u, exp, chain) };
}

/** @param {object} deps needs marketData; optional paths.dataDir, tide (a createTideStore store), clock */
export function tideRoutes(deps) {
  return [
    ["GET", "/v1/analytics/tide", { scope: "read" }, async (ctx) => {
      const q = ctx.query;
      const underlying = cleanUnderlying(opt(q, "underlying"));
      const windowMin = intParam(q, "windowMin", 1, 1440);
      const strikes = intParam(q, "strikes", 1, 100);
      const top = intParam(q, "top", 1, 50, 5);
      const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
      const expiry = await resolveExpiry(deps, underlying, opt(q, "expiry"), opts);
      const params = { underlying, expiry };
      if (strikes !== undefined) params.strikes = strikes;
      const chain = await deps.marketData.optionChain(params, opts);
      const store = storeFor(deps);
      if (isDemo(deps)) seedDemoSession(deps, store, underlying, expiry);
      const rec = store.record(underlying, expiry, chain);
      const view = tideView(store.session(underlying), { windowMin, top, nowMs: store.clock.now() });
      return {
        data: { underlying, underlyingLtp: chain?.underlyingLtp ?? null, ...view, recorded: rec.recorded, persistence: rec.persistence },
        meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(chain?.freshness ? { freshness: chain.freshness } : {}) },
      };
    }],
  ];
}
