/**
 * Sweep feasibility (stream S19, docs/spec/p1-06-stocks.md §6.9). PURE: no clock, no I/O.
 *
 *   R(class)  = the per-minute rate of the class's tightest window (perSecond × 60, perMinute, limit × 60000 / windowMs
 *               of each extra window, over the class's own limits and every group that covers it) × budgetShare
 *   B         = maxQuoteBatch;  L = 2 × (2 × stockStrikes + 1) legs per stock-expiry
 *   chain     C = N × E calls;  quotes  Q = ceil((N × E × L + N + indexSpots) / B)
 *   minutes   = calls / R
 *   auto      chain for stocks when C / R(chain) ≤ maxMinutes and the broker serves an option chain (broker ΔOI);
 *             else quotes when the adapter's quote path is verified for OI; else chain for the stocks that fit,
 *             maxStocksThatFit = floor((maxMinutes × R(chain) − index calls on the same budget) / E)
 *   interval  max(minIntervalSeconds, ceil(sessionSeconds × calls / (share × perDay)) per daily window,
 *             windowSeconds / floor(share × limit / calls) per extra window)
 */

/** Classes whose limits a call of `cls` is counted against: the class itself and every group listing it. */
export function windowsFor(policy, cls) {
  const specs = [];
  const own = policy?.limits?.[cls];
  if (own) specs.push({ key: `class:${cls}`, ...own, classes: [cls] });
  for (const [name, g] of Object.entries(policy?.groups ?? {})) if (Array.isArray(g.classes) && g.classes.includes(cls)) specs.push({ key: `group:${name}`, ...g });
  return specs;
}

/** True when two classes draw on one budget (same class, or a group covering both). */
export function sameBudget(policy, a, b) {
  if (a === b) return true;
  return Object.values(policy?.groups ?? {}).some((g) => Array.isArray(g.classes) && g.classes.includes(a) && g.classes.includes(b));
}

/** Per-minute rate of the tightest window of a class at full budget (null when the policy has no window for it). */
export function perMinuteOf(policy, cls) {
  let r = Infinity;
  for (const s of windowsFor(policy, cls)) {
    if (Number.isFinite(s.perSecond)) r = Math.min(r, s.perSecond * 60);
    if (Number.isFinite(s.perMinute)) r = Math.min(r, s.perMinute);
    for (const w of s.extraWindows ?? []) if (Number.isFinite(w.limit) && w.windowMs > 0) r = Math.min(r, (w.limit * 60_000) / w.windowMs);
  }
  return Number.isFinite(r) ? r : null;
}

/** R(class) = tightest per-minute rate × share (§6.9). Unknown classes get the conservative 1/s default. */
export function rateOf(policy, cls, share) {
  return (perMinuteOf(policy, cls) ?? 60) * share;
}

/** The auto-repeat interval floor from daily and long windows for `callsByClass` per sweep. */
export function autoIntervalSeconds(policy, callsByClass, { share, minIntervalSeconds, sessionMinutes }) {
  let interval = minIntervalSeconds;
  const seen = new Set();
  for (const cls of Object.keys(callsByClass)) {
    for (const s of windowsFor(policy, cls)) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      // Every class of this sweep that draws on this window.
      const calls = Object.entries(callsByClass)
        .filter(([c]) => s.classes.includes(c))
        .reduce((a, [, n]) => a + n, 0);
      if (!(calls > 0)) continue;
      if (Number.isFinite(s.perDay) && s.perDay > 0) interval = Math.max(interval, Math.ceil((sessionMinutes * 60 * calls) / (share * s.perDay)));
      for (const w of s.extraWindows ?? []) {
        if (!(w.limit > 0 && w.windowMs > 0)) continue;
        const sweeps = Math.floor((share * w.limit) / calls);
        interval = Math.max(interval, sweeps >= 1 ? Math.ceil(w.windowMs / 1000 / sweeps) : Math.ceil((w.windowMs / 1000) * (calls / (share * w.limit))));
      }
    }
  }
  return interval;
}

const round1 = (x) => Math.round(x * 10) / 10;
const minutesText = (m) => (m < 1.5 ? "about 1 minute" : `about ${Math.ceil(m)} minutes`);
const pctText = (share) => `${Math.round(share * 100)}%`;
const brokerName = (b) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : "this broker");

/** A short description of the windows used (the plan's `basis`). */
function basisText(broker, policy, classes) {
  const parts = [];
  for (const cls of classes) {
    const w = windowsFor(policy, cls)[0];
    if (!w) {
      parts.push(`${cls} defaults`);
      continue;
    }
    const lim = Number.isFinite(w.perMinute) ? `${w.perMinute}/min` : Number.isFinite(w.perSecond) ? `${w.perSecond}/s` : "default";
    parts.push(`${cls} ${lim}${w.verified === false ? " (unverified)" : ""}${cls === "quote" ? ` × ${policy?.maxQuoteBatch ?? 1} instruments` : ""}`);
  }
  return `${broker ?? "unknown"} policy: ${[...new Set(parts)].join(", ")}`;
}

/**
 * Plan one sweep.
 * indexSpots: index spots NOT served by their chain call (0 when index chains come from the broker's chain endpoint,
 * which returns the spot); they ride in the stocks' batched spot read.
 * preferQuotes (demo mode): use the quote path for stocks whenever it is verified and fits, so the demo shows both
 * methods.
 * @param {{ broker: string|null, policy: object, caps: { optionChain: boolean }, quotesVerified: boolean, preferQuotes?: boolean,
 *   indexKeys: number, indexSpots: number, stocks: number, stockExpiries: number, method?: "auto"|"chain"|"quotes",
 *   cfg: { budgetShare: number, maxMinutes: number, stockStrikes: number, indexStrikes: number, minIntervalSeconds: number },
 *   sessionMinutes: number, optIn?: number|null, hvCalls?: number, hvSource?: string }} p
 */
export function planSweep(p) {
  const share = p.cfg.budgetShare;
  const B = Math.max(1, Math.floor(p.policy?.maxQuoteBatch ?? 1));
  const E = Math.max(1, p.stockExpiries);
  const N = Math.max(0, p.stocks);
  const L = 2 * (2 * p.cfg.stockStrikes + 1);
  const method = p.method ?? "auto";
  const chainCls = p.caps.optionChain ? "chain" : "quote";
  const Rchain = rateOf(p.policy, "chain", share);
  const Rquote = rateOf(p.policy, "quote", share);
  if (method === "quotes" && !p.quotesVerified) {
    return { error: { code: "CAPABILITY_UNSUPPORTED", message: `The quote path of ${brokerName(p.broker)} is not verified for option OI, bid and ask; use method "auto" or "chain".` } };
  }

  // Index chains: one chain call each, or a built chain (one spot read plus the legs in B-sized quote calls).
  const indexLegs = 2 * (2 * p.cfg.indexStrikes + 1);
  const indexEach = p.caps.optionChain ? 1 : 1 + Math.ceil(indexLegs / B);
  const indexCalls = p.indexKeys * indexEach;
  const indexGroup = { kind: "index", method: "chain", keys: p.indexKeys, calls: indexCalls, class: chainCls, ratePerMin: round1(chainCls === "chain" ? Rchain : Rquote), minutes: 0 };
  indexGroup.minutes = indexCalls ? round1(indexCalls / (chainCls === "chain" ? Rchain : Rquote)) : 0;

  const chainCalls = N * E * (p.caps.optionChain ? 1 : 1 + Math.ceil(L / B));
  const chainMin = chainCalls / (chainCls === "chain" ? Rchain : Rquote);
  const quoteCalls = N ? Math.ceil((N * E * L + N + p.indexSpots) / B) : 0;
  const quoteMin = quoteCalls / Rquote;
  // Index calls that share the stock group's budget eat into its 10 minutes.
  const indexSharing = (cls) => (sameBudget(p.policy, cls, chainCls) ? indexCalls : 0);
  const fitChain = () => Math.max(0, Math.floor((p.cfg.maxMinutes * (chainCls === "chain" ? Rchain : Rquote) - indexSharing(chainCls)) / (E * (p.caps.optionChain ? 1 : 1 + Math.ceil(L / B)))));
  const fitQuotes = () => {
    const budget = p.cfg.maxMinutes * Rquote - indexSharing("quote");
    return Math.max(0, Math.floor((budget * B - p.indexSpots) / (E * L + 1)));
  };

  let stockMethod;
  let stockCalls;
  let stockMin;
  let maxFit = N;
  const indexMinOn = (cls) => (sameBudget(p.policy, cls, chainCls) ? indexCalls / (cls === "chain" ? Rchain : Rquote) : 0);
  const chainFits = chainMin + indexMinOn(chainCls) <= p.cfg.maxMinutes;
  const quotesFit = quoteMin + indexMinOn("quote") <= p.cfg.maxMinutes;
  if (method === "chain") {
    stockMethod = "chain";
    maxFit = chainFits ? N : Math.min(N, fitChain());
  } else if (method === "quotes") {
    stockMethod = "quotes";
    maxFit = quotesFit ? N : Math.min(N, fitQuotes());
  } else if (p.preferQuotes && p.quotesVerified && quotesFit) {
    stockMethod = "quotes";
  } else if (p.caps.optionChain && chainFits) {
    stockMethod = "chain";
  } else if (p.quotesVerified && quotesFit) {
    stockMethod = "quotes";
  } else {
    const viaChain = Math.min(N, fitChain());
    const viaQuotes = p.quotesVerified ? Math.min(N, fitQuotes()) : -1;
    stockMethod = viaQuotes > viaChain ? "quotes" : "chain";
    maxFit = Math.max(viaChain, viaQuotes);
  }
  const covered = Math.min(N, maxFit);
  if (stockMethod === "chain") {
    stockCalls = covered * E * (p.caps.optionChain ? 1 : 1 + Math.ceil(L / B));
    stockMin = stockCalls / (chainCls === "chain" ? Rchain : Rquote);
  } else {
    stockCalls = covered ? Math.ceil((covered * E * L + covered + p.indexSpots) / B) : 0;
    stockMin = stockCalls / Rquote;
  }
  const stockCls = stockMethod === "chain" ? chainCls : "quote";
  const groups = [];
  if (p.indexKeys) groups.push(indexGroup);
  if (N) groups.push({ kind: "stock", method: stockMethod, keys: covered * E, stocks: covered, calls: stockCalls, class: stockCls, ratePerMin: round1(stockCls === "chain" ? Rchain : Rquote), minutes: round1(stockMin) });
  const minutes = round1(groups.reduce((a, g) => a + g.calls / (g.class === "chain" ? Rchain : Rquote), 0));
  const callsByClass = {};
  for (const g of groups) callsByClass[g.class] = (callsByClass[g.class] ?? 0) + g.calls;
  const autoIntervalSec = autoIntervalSeconds(p.policy, callsByClass, { share, minIntervalSeconds: p.cfg.minIntervalSeconds, sessionMinutes: p.sessionMinutes });
  const limited = covered < N;
  const fits = !limited;
  const who = `${brokerName(p.broker)}`;
  const how = stockMethod === "quotes" ? "quotes" : "chains";
  let message;
  if (!limited) {
    message = `This account can sweep ${p.indexKeys ? `${p.indexKeys} index chains and ` : ""}${N === 0 ? "no stocks" : `all ${N} stocks`} in ${minutesText(minutes)} (${who} ${how}, ${pctText(share)} budget).`;
  } else {
    const list = p.optIn ? ` Your opted-in list has ${p.optIn}; the first ${covered} are covered.` : ` The first ${covered} stocks by name are covered.`;
    message = `This ${who} account can sweep ${covered} stocks in ${p.cfg.maxMinutes} minutes with ${E} expir${E === 1 ? "y" : "ies"} each.${list}`;
  }
  return {
    fits,
    limited,
    groups,
    minutes,
    hv: { calls: p.hvCalls ?? 0, source: p.hvSource ?? "broker", minutes: p.hvCalls ? round1(p.hvCalls / rateOf(p.policy, "history", share)) : 0 },
    autoIntervalSec,
    maxStocksThatFit: covered,
    message,
    quotesVerified: Boolean(p.quotesVerified),
    basis: basisText(p.broker, p.policy, [...new Set(groups.map((g) => g.class))]),
  };
}
