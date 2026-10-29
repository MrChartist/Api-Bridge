/**
 * Recorder planner (stream S17, docs/spec/p1-01-recorder.md §5, M3). Pure.
 *
 * Decides, for the ONE data account, which source records each configured chain — the broker stream (zero REST
 * calls), REST inside the recorder's half of the budget, the NSE website backup (opt-in) — and refuses what the
 * account cannot carry, saying exactly what it can. The same function produces the feasibility table for every broker
 * (scripts/recorder-feasibility.mjs → docs/guides/recorder.md), so the doc cannot drift from brokerPolicies.mjs.
 *
 * Rules (§5.1):
 *  1. Stream first, in priority order, while the recorder's subscriptions stay ≤ floor(streamShare × feedCap). A
 *     chain costs 2 × (2 × strikes + 1) legs, plus its underlying's spot and futures once (index: spot + 2 futures;
 *     stock: spot + 1 future). The stream stops at the first chain that does not fit, so a lower-priority chain never
 *     takes room a higher one asked for.
 *  2. The feed must run on the data account; otherwise the stream capacity is 0 and REST is used.
 *  3. REST at ≤ budgetShare of every window (budget.mjs); an index chain costs 1 call a minute, a stock chain
 *     1 / stockEveryMinutes.
 *  4. Never take the last token: no REST on classes below 2 requests/s unless `allowSingleTokenRest`.
 * Priority: index chains by expiry rank, then the configured index order (all nearest expiries first); then stocks the
 * same way.
 */
import { budgetCaps, restRule, windowLabel } from "./budget.mjs";

/** Spot + futures subscribed per underlying on the stream. */
export const UNDERLYING_SYMBOLS = Object.freeze({ index: 3, stock: 2 });
/** The feed cap when an adapter has a feed but its policy states none (brokers/upstreamFeedLimits.mjs). */
export const DEFAULT_FEED_CAP = 1500;
/** Chains per minute the NSE website backup is asked for (its pacing is not published; conservative). */
export const NSE_BACKUP_PER_MINUTE = 10;

/** Legs of one chain with `strikes` each side of ATM. */
export const legsFor = (strikes) => 2 * (2 * strikes + 1);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmt = (n) => Number(n).toLocaleString("en-IN");

/**
 * Candidate chains in priority order.
 * @param {object} cfg  recorder settings
 * @param {Record<string, { kind?: "index"|"stock", exchange?: string, expiries: string[] }>} available
 * @returns {{ candidates: Array<{ underlying, expiry, kind, exchange, rank, everyMinutes, strikesEachSide, legs }>, notOffered: string[] }}
 */
export function candidateChains(cfg, available) {
  const notOffered = [];
  const lists = { index: [], stock: [] };
  const spec = {
    index: { names: cfg.indices, expiries: cfg.indexExpiries, strikes: cfg.indexStrikes, every: 1 },
    stock: { names: cfg.stocks, expiries: cfg.stockExpiries, strikes: cfg.stockStrikes, every: cfg.stockEveryMinutes },
  };
  for (const kind of ["index", "stock"]) {
    const s = spec[kind];
    const perRank = [];
    for (const u of s.names) {
      const a = available?.[u];
      if (!a || !Array.isArray(a.expiries) || a.expiries.length === 0) {
        notOffered.push(u);
        continue;
      }
      a.expiries.slice(0, s.expiries).forEach((x, rank) => {
        (perRank[rank] ??= []).push({ underlying: u, expiry: x, kind, exchange: a.exchange ?? null, rank, everyMinutes: s.every, strikesEachSide: s.strikes, legs: legsFor(s.strikes) });
      });
    }
    for (const group of perRank) if (group) lists[kind].push(...group);
  }
  return { candidates: [...lists.index, ...lists.stock], notOffered };
}

/**
 * Plan a recording.
 * @param {{ cfg: object, account: { id: string, broker: string } | null, policy: object | null, feedCap: number,
 *   feedOnDataAccount?: boolean, feedAccountId?: string | null, endpointClass?: "chain"|"quote",
 *   available: Record<string, { kind?: string, exchange?: string, expiries: string[] }>, nseBackup?: boolean,
 *   brokerName?: string, callsPerRead?: number }} input
 *   callsPerRead: broker calls one chain read costs (1 for a broker chain; a chain built from quotes costs its quote
 *   batches plus a spot read, restSource.mjs builtChainCost).
 */
export function planRecording(input) {
  const { cfg, account, policy } = input;
  const endpointClass = input.endpointClass ?? "chain";
  const name = input.brokerName ?? account?.broker ?? "This broker";
  const warnings = [];
  const refused = [];
  const chains = [];
  if (!account || !policy) {
    return {
      ok: false,
      chains,
      refused,
      capacity: { stream: { cap: 0, used: 0, feedLimit: 0, share: cfg.streamShare }, rest: { endpointClass, allowed: false, why: "No data account.", perMinute: 0, used: 0 } },
      budget: { restCallsPerMinute: 0, restCapPerMinute: 0, brokerPerMinute: null, share: cfg.budgetShare },
      message: "No connected account can serve option chains, so nothing is recorded. Connect an account on the Accounts page.",
      warnings,
    };
  }
  const { candidates, notOffered } = candidateChains(cfg, input.available ?? {});
  for (const u of notOffered) refused.push({ underlying: u, expiry: null, reason: "not-offered", detail: `${u} is not offered by this account (no option contracts in its instrument list).` });

  // ── Stream (rules 1, 2) ──
  const feedLimit = Math.max(0, Math.floor(input.feedCap ?? 0));
  const feedOk = input.feedOnDataAccount !== false;
  const streamOn = cfg.sources.stream && feedOk && feedLimit > 0;
  if (cfg.sources.stream && !feedOk && input.feedAccountId) warnings.push(`The live feed runs on ${input.feedAccountId}; the recorder's account ${account.id} is used for REST only.`);
  const streamCap = streamOn ? Math.floor(cfg.streamShare * feedLimit) : 0;
  let streamUsed = 0;
  const streamUnderlyings = new Set();
  let streamOpen = streamOn;
  const left = [];
  for (const c of candidates) {
    if (streamOpen) {
      const extra = streamUnderlyings.has(c.underlying) ? 0 : UNDERLYING_SYMBOLS[c.kind];
      if (streamUsed + c.legs + extra <= streamCap) {
        streamUsed += c.legs + extra;
        streamUnderlyings.add(c.underlying);
        chains.push({ ...c, source: "stream" });
        continue;
      }
      streamOpen = false;
    }
    left.push(c);
  }

  // ── REST (rules 3, 4) ──
  const rule = restRule(policy, endpointClass, { allowSingleTokenRest: cfg.allowSingleTokenRest });
  const caps = budgetCaps(policy, endpointClass, cfg.budgetShare);
  const perRead = Math.max(1, Math.ceil(Number(input.callsPerRead) || 1));
  const perSecondCap = caps.windows.filter((w) => w.windowMs === 1000).reduce((m, w) => Math.min(m, w.cap), Infinity);
  const fitsOneRead = !(perRead > 1 && perRead > perSecondCap);
  const restOn = cfg.sources.rest && rule.allowed && fitsOneRead;
  if (cfg.sources.rest && rule.allowed && !fitsOneRead) rule.why = `too slow for chains built from quotes: one read takes ${perRead} calls and the recorder may use ${perSecondCap} a second.`;
  if (rule.singleToken && rule.allowed) warnings.push(`REST recording is on for a ${rule.perSecond}/s class: your own requests may wait up to 1 s.`);
  // Costs in calls per 15 minutes (integers: an index chain 15, a stock chain 15 / every).
  let restLeft15 = restOn ? caps.perMinute * 15 : 0;
  let restUsed15 = 0;
  const leftAfterRest = [];
  for (const c of left) {
    const cost = (15 / c.everyMinutes) * perRead;
    if (restOn && cost <= restLeft15) {
      restLeft15 -= cost;
      restUsed15 += cost;
      chains.push({ ...c, source: "rest" });
    } else leftAfterRest.push(c);
  }
  if (caps.perDay !== null && restUsed15 > 0) {
    const perMin = restUsed15 / 15;
    const minutes = Math.floor(caps.perDay / perMin);
    if (minutes < 375) warnings.push(`${name}'s daily limit gives the recorder ${fmt(caps.perDay)} calls a day; at ${fmt(Math.round(perMin))} a minute that lasts about ${Math.floor(minutes / 60)} h ${minutes % 60} min of the session, then the rest of the day records as budget gaps.`);
  }

  // ── NSE website backup (opt-in, never in demo) ──
  let nseLeft = input.nseBackup ? NSE_BACKUP_PER_MINUTE * 15 : 0;
  for (const c of leftAfterRest) {
    const cost = 15 / c.everyMinutes;
    if (nseLeft >= cost) {
      nseLeft -= cost;
      chains.push({ ...c, source: "nse-backup" });
      continue;
    }
    const roomLeft = streamCap - streamUsed;
    let detail;
    if (streamOn && !restOn) detail = `Feed room left: ${fmt(roomLeft)} legs; this chain needs ${c.legs} plus ${c.kind === "index" ? "2 futures and spot" : "1 future and spot"}.`;
    else if (restOn) detail = `REST budget left: ${fmt(Math.floor(restLeft15 / 15))} calls/min of ${fmt(caps.perMinute)}; feed room left: ${fmt(Math.max(0, roomLeft))} legs.`;
    else detail = rule.why ? `${name} ${endpointClass === "chain" ? "option chain" : "quotes"}: ${rule.why}` : "No source can carry this chain.";
    refused.push({ underlying: c.underlying, expiry: c.expiry, kind: c.kind, reason: "capacity", detail });
  }

  // Back into priority order for display.
  const order = new Map(candidates.map((c, i) => [`${c.underlying}|${c.expiry}`, i]));
  chains.sort((a, b) => order.get(`${a.underlying}|${a.expiry}`) - order.get(`${b.underlying}|${b.expiry}`));

  const restCallsPerMinute = Math.round((restUsed15 / 15) * 100) / 100;
  const result = {
    ok: !refused.some((r) => r.reason === "capacity"),
    chains: chains.map(({ rank, ...c }) => c),
    refused,
    capacity: {
      stream: { cap: streamCap, used: streamUsed, feedLimit, share: cfg.streamShare },
      rest: { endpointClass, allowed: restOn, why: restOn ? rule.why : (cfg.sources.rest ? (rule.why ? `${name} ${endpointClass === "chain" ? "option chain" : "quotes"} is ${rule.why}` : null) : "REST recording is switched off."), perMinute: restOn ? caps.perMinute : 0, used: restCallsPerMinute, windows: caps.windows.map((w) => ({ bucket: w.bucket, window: w.label, cap: w.cap, verified: w.verified })) },
    },
    budget: { restCallsPerMinute, restCapPerMinute: restOn ? caps.perMinute : 0, brokerPerMinute: caps.brokerPerMinute, share: cfg.budgetShare },
    warnings,
  };
  result.message = planMessage(cfg, result, { name, perMinute: caps.perMinute, restOn });
  return result;
}

/** The plain sentence the page shows above Save (§4.5). */
export function planMessage(cfg, plan, { name, perMinute, restOn }) {
  const idx = plan.chains.filter((c) => c.kind === "index");
  const stocks = plan.chains.filter((c) => c.kind === "stock");
  const askedIdx = idx.length + plan.refused.filter((r) => r.kind === "index" && r.reason === "capacity").length;
  const by = (list) => {
    const parts = [];
    for (const [src, label] of [
      ["stream", "by stream"],
      ["rest", "by REST"],
      ["nse-backup", "from the NSE website"],
    ]) {
      const n = list.filter((c) => c.source === src).length;
      if (n) parts.push(`${n} ${label}`);
    }
    return parts.length ? ` (${parts.join(", ")})` : "";
  };
  const idxText = idx.length === askedIdx ? `all ${plural(askedIdx, "index chain")}${by(idx)}` : `${idx.length} of the ${askedIdx} index chains${by(idx)}`;
  const stockNames = new Set([...stocks.map((c) => c.underlying)]);
  const askedStocks = cfg.stocks.length;
  const stockText = askedStocks === 0 ? "no stocks (none asked for)" : stockNames.size === askedStocks ? `all ${plural(askedStocks, "stock")}${by(stocks)}` : `${stockNames.size} of the ${askedStocks} stocks you asked for${by(stocks)}`;
  const note = restOn ? ` ${name} REST budget for the recorder: ${fmt(perMinute)} calls/min.` : "";
  return `This account can carry ${idxText} and ${stockText}.${note}`;
}

/**
 * The feed cap a broker's account would have on the hub: the policy's per-feed cap, or 1,500 when the adapter has a
 * feed and the policy states none; 0 without a feed.
 */
export function feedCapFor(policy, hasFeed, configCap = null) {
  if (!hasFeed) return 0;
  const caps = [configCap, policy?.feed?.maxSubscriptions].filter((v) => typeof v === "number" && v > 0);
  return caps.length ? Math.min(...caps) : DEFAULT_FEED_CAP;
}

/** Every default index with 3 expiries (feasibility assumes the broker lists them all). */
export function fullAvailability(cfg, stocks = []) {
  const out = {};
  const exp = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];
  for (const u of cfg.indices) out[u] = { kind: "index", expiries: exp };
  for (const u of stocks) out[u] = { kind: "stock", expiries: ["2026-11-24", "2026-12-29"] };
  return out;
}

/**
 * One feasibility row (§5.2) for a broker with the default config: index chains by stream and REST, and how many
 * stocks (±15, one expiry, 5 minutes) the room left would carry.
 * @param {{ broker: string, policy: object, hasFeed: boolean, cfg: object, label?: string }} p
 */
export function feasibilityRow({ broker, policy, hasFeed, cfg, label }) {
  const feedCap = feedCapFor(policy, hasFeed);
  const plan = planRecording({ cfg, account: { id: broker, broker }, policy, feedCap, available: fullAvailability(cfg), brokerName: label ?? broker });
  const idx = plan.chains.filter((c) => c.kind === "index");
  const stockLegs = legsFor(cfg.stockStrikes) + UNDERLYING_SYMBOLS.stock;
  // Stocks: stream room is open only when every index chain got a stream slot (strict priority), then REST room.
  const allStream = idx.length === plan.chains.length && plan.refused.every((r) => r.reason !== "capacity") && idx.every((c) => c.source === "stream");
  const streamStocks = allStream ? Math.floor((plan.capacity.stream.cap - plan.capacity.stream.used) / stockLegs) : 0;
  const restLeft = plan.capacity.rest.allowed ? plan.capacity.rest.perMinute - plan.budget.restCallsPerMinute : 0;
  const restStocks = Math.max(0, Math.floor(restLeft * cfg.stockEveryMinutes + 1e-9));
  return {
    broker,
    label: label ?? broker,
    feedCap,
    streamCap: plan.capacity.stream.cap,
    streamUsed: plan.capacity.stream.used,
    endpointClass: plan.capacity.rest.endpointClass,
    restAllowed: plan.capacity.rest.allowed,
    restWhy: plan.capacity.rest.why,
    restPerMinute: plan.capacity.rest.perMinute,
    restWindows: plan.capacity.rest.windows,
    indexByStream: idx.filter((c) => c.source === "stream").length,
    indexByRest: idx.filter((c) => c.source === "rest").length,
    indexRefused: plan.refused.filter((r) => r.reason === "capacity").length,
    stocksByStream: streamStocks,
    stocksByRest: restStocks,
    warnings: plan.warnings,
    verifiedFeed: Boolean(policy?.feed?.maxSubscriptions),
  };
}

/**
 * The four text cells of one feasibility row (the doc table and the Data recorder page show the same words):
 * { feed, rest, indices, stocks }.
 */
export function feasibilityCells(r) {
  const feed = r.feedCap ? `${fmt(r.feedCap)} × 0.6 = ${fmt(r.streamCap)}${r.verifiedFeed ? "" : " (default cap)"}` : "no feed in adapter";
  const unverified = r.restWindows.some((w) => !w.verified) ? " (unverified)" : "";
  const perSecond = r.restWindows.filter((w) => w.window.endsWith("/s")).map((w) => Number(w.window.replace(/[^\d]/g, "")));
  const rest = r.restAllowed ? `${r.endpointClass}: ${fmt(r.restPerMinute)} calls/min${unverified}` : `off (${r.endpointClass} ${perSecond.length ? `${Math.min(...perSecond)}/s` : "limits unknown"}${unverified})`;
  const indices = [r.indexByStream ? `${r.indexByStream} stream` : null, r.indexByRest ? `${r.indexByRest} REST` : null, r.indexRefused ? `${r.indexRefused} refused` : null].filter(Boolean).join(", ") || "none";
  const n = r.stocksByStream + r.stocksByRest;
  const stocks = n ? `about ${fmt(n)}${r.stocksByStream && r.stocksByRest ? ` (${fmt(r.stocksByStream)} stream, ${fmt(r.stocksByRest)} REST)` : r.stocksByStream ? " by stream" : " by REST"}` : "0";
  return { feed, rest, indices, stocks };
}

/** The Markdown feasibility table (docs/guides/recorder.md §5.3), one row per broker. */
export function feasibilityMarkdown(rows) {
  const head = ["| Broker | Live feed: recorder share | REST for the recorder | Index chains (18 at ±40) | Stocks at 5 min (±15) |", "|---|---|---|---|---|"];
  const lines = rows.map((r) => {
    const c = feasibilityCells(r);
    return `| ${r.label} | ${c.feed} | ${c.rest} | ${c.indices} | ${c.stocks} |`;
  });
  return [...head, ...lines].join("\n");
}

export { windowLabel };

/**
 * The CAPACITY_EXCEEDED payload (§4.6): what the account can carry, and what it refused.
 * @returns {{ canCarry: { indices: string[], stocks: string[] }, refused: object[] }}
 */
export function capacityPayload(plan) {
  const uniq = (kind) => [...new Set(plan.chains.filter((c) => c.kind === kind).map((c) => c.underlying))];
  return { canCarry: { indices: uniq("index"), stocks: uniq("stock") }, refused: plan.refused.filter((r) => r.reason === "capacity") };
}
