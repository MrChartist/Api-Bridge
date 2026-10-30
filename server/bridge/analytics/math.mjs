/**
 * Pure option analytics over a Bridge OptionChain ({ rows: [{ strike, ce, pe }], underlyingLtp, lotSize }) and over
 * plain numbers. No I/O. Ported from the OptionsDesk analysis pages (OI analysis, gamma exposure, skew, strategy
 * payoff, position sizer, futures basis) so every tool reads them from the Bridge instead.
 */
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : 0);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const rowsOf = (chain) => (Array.isArray(chain?.rows) ? chain.rows : []);

/** Highest-N strikes by `pick(row)`, ties broken by strike. */
const top = (rows, pick, n) =>
  rows
    .map((r) => ({ strike: r.strike, value: pick(r) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.strike - b.strike)
    .slice(0, n);

/** Expiry price (among listed strikes) at which option writers pay out the least. */
export function maxPain(rows) {
  let best = Infinity;
  let at = null;
  for (const k of rows) {
    let pain = 0;
    for (const r of rows) {
      pain += Math.max(0, k.strike - r.strike) * num(r.ce?.oi);
      pain += Math.max(0, r.strike - k.strike) * num(r.pe?.oi);
    }
    if (pain < best) {
      best = pain;
      at = k.strike;
    }
  }
  return at;
}

/** Open-interest picture: totals, put-call ratios, max pain, support and resistance, per-strike OI and change. */
export function oiAnalysis(chain, { top: n = 3 } = {}) {
  const rows = rowsOf(chain);
  const sum = (side, f) => rows.reduce((t, r) => t + num(r[side]?.[f]), 0);
  const ceOi = sum("ce", "oi");
  const peOi = sum("pe", "oi");
  const ceVol = sum("ce", "volume");
  const peVol = sum("pe", "volume");
  const ceChg = sum("ce", "oiChange");
  const peChg = sum("pe", "oiChange");
  const ratio = (a, b) => (b > 0 ? round(a / b, 3) : null);
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    underlyingLtp: chain?.underlyingLtp ?? null,
    atmStrike: chain?.atmStrike ?? null,
    totals: { ceOi, peOi, ceVolume: ceVol, peVolume: peVol, ceOiChange: ceChg, peOiChange: peChg },
    pcrOi: ratio(peOi, ceOi),
    pcrVolume: ratio(peVol, ceVol),
    pcrOiChange: ratio(peChg, ceChg),
    maxPain: maxPain(rows),
    resistance: top(rows, (r) => num(r.ce?.oi), n),
    support: top(rows, (r) => num(r.pe?.oi), n),
    biggestCeOiAdds: top(rows, (r) => num(r.ce?.oiChange), n),
    biggestPeOiAdds: top(rows, (r) => num(r.pe?.oiChange), n),
    strikes: rows.map((r) => ({ strike: r.strike, ceOi: num(r.ce?.oi), peOi: num(r.pe?.oi), ceOiChange: num(r.ce?.oiChange), peOiChange: num(r.pe?.oiChange) })),
  };
}

/**
 * Dealer gamma exposure per strike, in rupees per 1 % move of the underlying: gamma x OI x lot size x spot^2 x 1 %.
 * Calls count positive and puts negative (dealers assumed long calls and short puts, the usual convention).
 * `flipStrike` is where the running total from the lowest strike changes sign.
 */
export function gammaExposure(chain) {
  const rows = rowsOf(chain);
  const spot = num(chain?.underlyingLtp);
  const lot = num(chain?.lotSize) || 1;
  const k = spot > 0 ? spot * spot * 0.01 * lot : 0;
  let running = 0;
  let flip = null;
  let prevSign = 0;
  let net = 0;
  const strikes = rows.map((r) => {
    const call = num(r.ce?.gamma) * num(r.ce?.oi) * k;
    const put = -num(r.pe?.gamma) * num(r.pe?.oi) * k;
    running += call + put;
    net += call + put;
    const sign = Math.sign(running);
    if (flip === null && prevSign !== 0 && sign !== 0 && sign !== prevSign) flip = r.strike;
    if (sign !== 0) prevSign = sign;
    return { strike: r.strike, callGex: round(call, 0), putGex: round(put, 0), netGex: round(call + put, 0) };
  });
  const biggest = [...strikes].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0] ?? null;
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    underlyingLtp: chain?.underlyingLtp ?? null,
    lotSize: chain?.lotSize ?? null,
    unit: "INR per 1% move",
    netGex: round(net, 0),
    regime: net > 0 ? "positive" : net < 0 ? "negative" : "neutral",
    flipStrike: flip,
    largestStrike: biggest?.strike ?? null,
    strikes,
  };
}

/** IV by strike, ATM IV, and the put-minus-call IV gap `width` strikes either side of ATM (risk reversal). */
export function ivSkew(chain, { width = 3 } = {}) {
  const rows = rowsOf(chain);
  const atmIdx = rows.findIndex((r) => r.strike === chain?.atmStrike);
  const iv = (leg) => (num(leg?.iv) > 0 ? num(leg.iv) : null);
  const points = rows.map((r) => ({ strike: r.strike, ceIv: iv(r.ce), peIv: iv(r.pe) }));
  const atm = atmIdx >= 0 ? points[atmIdx] : null;
  const atmIv = atm ? (atm.ceIv !== null && atm.peIv !== null ? (atm.ceIv + atm.peIv) / 2 : atm.ceIv ?? atm.peIv) : null;
  const lo = atmIdx - width >= 0 ? points[atmIdx - width] : null;
  const hi = atmIdx >= 0 && atmIdx + width < points.length ? points[atmIdx + width] : null;
  const rr = lo?.peIv != null && hi?.ceIv != null ? lo.peIv - hi.ceIv : null;
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    atmStrike: chain?.atmStrike ?? null,
    atmIv: round(atmIv, 2),
    width,
    putStrike: lo?.strike ?? null,
    callStrike: hi?.strike ?? null,
    riskReversal: round(rr, 2),
    skew: rr === null ? null : rr > 0.5 ? "put-heavy" : rr < -0.5 ? "call-heavy" : "flat",
    points,
  };
}

/**
 * Strategy payoff at expiry. Legs: { type: "CE"|"PE"|"FUT", side: "buy"|"sell", strike, price, lots, lotSize }
 * (strike is ignored for FUT, where `price` is the entry price). Returns the curve, max profit and loss
 * (null when unbounded), and the break-even prices.
 */
export function strategyPayoff(legs, { spot, from, to, step } = {}) {
  const strikes = legs.filter((l) => l.type !== "FUT").map((l) => l.strike);
  const anchors = [...strikes, ...legs.filter((l) => l.type === "FUT").map((l) => l.price), spot].filter((x) => Number.isFinite(x) && x > 0);
  if (!anchors.length) return { curve: [], maxProfit: null, maxLoss: null, breakevens: [], netPremium: 0 };
  const lo = from ?? Math.max(0, Math.min(...anchors) * 0.85);
  const hi = to ?? Math.max(...anchors) * 1.15;
  const stp = step ?? Math.max((hi - lo) / 200, 0.05);
  const at = (p) =>
    legs.reduce((t, l) => {
      const qty = (l.lots ?? 1) * (l.lotSize ?? 1) * (l.side === "buy" ? 1 : -1);
      const value = l.type === "CE" ? Math.max(0, p - l.strike) : l.type === "PE" ? Math.max(0, l.strike - p) : p;
      return t + qty * (value - l.price);
    }, 0);
  const curve = [];
  for (let p = lo; p < hi + stp / 2; p += stp) curve.push({ price: round(p, 2), pnl: round(at(p), 2) });
  const breakevens = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.pnl === 0) breakevens.push(a.price);
    else if (a.pnl * b.pnl < 0) breakevens.push(round(a.price + ((0 - a.pnl) * (b.price - a.price)) / (b.pnl - a.pnl), 2));
  }
  // Slope beyond the ends tells whether the loss or profit is unbounded.
  const slopeUp = at(hi * 2) - at(hi);
  const slopeDown = at(0) - at(Math.max(lo, 1));
  const pnls = curve.map((c) => c.pnl);
  const netPremium = legs.reduce((t, l) => t + (l.lots ?? 1) * (l.lotSize ?? 1) * l.price * (l.type === "FUT" ? 0 : l.side === "buy" ? -1 : 1), 0);
  return {
    curve,
    maxProfit: slopeUp > 1e-9 ? null : round(Math.max(...pnls, at(0)), 2),
    maxLoss: slopeUp < -1e-9 || slopeDown < -1e-9 ? null : round(Math.min(...pnls, at(0)), 2),
    unboundedProfit: slopeUp > 1e-9,
    unboundedLoss: slopeUp < -1e-9,
    breakevens: [...new Set(breakevens)],
    netPremium: round(netPremium, 2),
  };
}

/** Lots to trade so that a stop-out loses at most riskPct of capital. */
export function positionSize({ capital, riskPct, entry, stop, lotSize = 1, maxLots }) {
  const riskAmount = capital * (riskPct / 100);
  const perUnit = Math.abs(entry - stop);
  if (!(perUnit > 0)) return { riskAmount: round(riskAmount), riskPerUnit: 0, lots: 0, quantity: 0, capitalAtRisk: 0, note: "entry and stop are the same price" };
  let lots = Math.floor(riskAmount / (perUnit * lotSize));
  if (maxLots !== undefined) lots = Math.min(lots, maxLots);
  const quantity = lots * lotSize;
  return {
    riskAmount: round(riskAmount),
    riskPerUnit: round(perUnit, 2),
    lots,
    quantity,
    capitalAtRisk: round(quantity * perUnit),
    notional: round(quantity * entry),
    direction: stop < entry ? "long" : "short",
    note: lots === 0 ? "risk budget is smaller than one lot" : null,
  };
}

/** Futures basis against spot: points, percent, and the annualised carry over the days left. */
export function futuresBasis({ spot, future, daysToExpiry }) {
  if (!(spot > 0) || !(future > 0)) return { basis: null, basisPct: null, annualisedPct: null, state: null };
  const basis = future - spot;
  const pct = (basis / spot) * 100;
  return {
    basis: round(basis, 2),
    basisPct: round(pct, 3),
    annualisedPct: daysToExpiry > 0 ? round(pct * (365 / daysToExpiry), 2) : null,
    state: basis > 0 ? "contango" : basis < 0 ? "backwardation" : "flat",
  };
}
