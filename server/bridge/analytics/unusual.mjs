/**
 * Unusual options activity scanner for stream S15 (Unusual-Whales-style, for NSE/BSE options). Read-only, computed
 * from the Bridge's own option chain; there is no trade tape, so aggressor side is a quote-position proxy only.
 *
 *   GET /v1/analytics/unusual?underlyings=NIFTY,BANKNIFTY[,..max 10][&expiry=][&minPremium=][&minVolOi=]
 *       [&side=call|put|both][&sort=score|premium|volOi][&limit=50]
 */
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { nowMsOf, unitMultiplier, upcomingExpiries } from "./math.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function numParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(name, `${name} must be a number from ${min} to ${max}.`);
  return n;
}

export const MAX_UNDERLYINGS = 10;
export const FLAGS = Object.freeze({ VOLUME_SPIKE: "VOLUME_SPIKE", BIG_PREMIUM: "BIG_PREMIUM", OTM_LOTTERY: "OTM_LOTTERY", IV_ANOMALY: "IV_ANOMALY", OI_BUILDUP: "OI_BUILDUP" });
export const THRESHOLDS = Object.freeze({
  volOi: 1, // VOLUME_SPIKE: volume >= 1 x open interest
  premiumInr: 10_000_000, // BIG_PREMIUM: traded premium >= INR 1 crore
  otmPct: 3, // OTM_LOTTERY: >= 3 % out of the money ...
  lotteryVolOi: 0.5, // ... with volume/OI >= 0.5
  ivDeviation: 0.25, // IV_ANOMALY: IV differs from ATM IV by >= 25 %
  oiBuildupPct: 10, // OI_BUILDUP: OI grew >= 10 % over the prior OI
  aggressorBuy: 0.7, // ltp at >= 70 % of the bid-ask spread: buyer-aggressive proxy
  aggressorSell: 0.3, // ltp at <= 30 %: seller-aggressive proxy
});

/** Score weights (sum 100) and the full-credit point for each component. */
export const SCORE_WEIGHTS = Object.freeze({ volOi: 30, premium: 25, otm: 15, iv: 15, oiBuildup: 15 });
export const METHOD = Object.freeze({
  score:
    "score = 30*min(volOi/3,1) + 25*min(premiumInr/20000000,1) + 15*min(otmPct/5,1) + 15*min(|iv/atmIv-1|/0.5,1) + 15*min(oiChangePct/20,1); " +
    "each term is clamped to 0..1 before weighting, missing inputs contribute 0, result rounded to 1 decimal (0-100). Contracts with volume <= 0 or no ltp are skipped.",
  volOi: "volume / open interest (null when OI is 0).",
  premiumInr: "volume x ltp in INR (volume is in units on this Bridge); null when the chain carries no lot size.",
  otmPct: "distance of strike from spot as % of spot, positive when out of the money, negative when in the money.",
  ivVsAtm: "contract IV / ATM IV (mean of ATM call and put IV), so 1.0 is in line.",
  oiChangePct: "oiChange / (oi - oiChange) x 100 (growth over the prior open interest); null when prior OI is 0.",
  aggressor:
    "PROXY ONLY, not trade-tape data: position of ltp in the bid-ask spread, (ltp-bid)/(ask-bid). >= 0.7 'buyer-aggressive', <= 0.3 'seller-aggressive', else 'neutral'; null when there is no valid spread.",
  flags: `VOLUME_SPIKE volOi>=${THRESHOLDS.volOi}; BIG_PREMIUM premiumInr>=${THRESHOLDS.premiumInr}; OTM_LOTTERY otmPct>=${THRESHOLDS.otmPct} and volOi>=${THRESHOLDS.lotteryVolOi}; IV_ANOMALY |ivVsAtm-1|>=${THRESHOLDS.ivDeviation}; OI_BUILDUP oiChangePct>=${THRESHOLDS.oiBuildupPct}.`,
});

/** Aggressor proxy from the ltp position inside the bid-ask spread. */
export function aggressorProxy(leg) {
  const bid = num(leg?.bid);
  const ask = num(leg?.ask);
  const ltp = num(leg?.ltp);
  if (!(bid > 0) || !(ask > bid) || !(ltp > 0)) return { position: null, side: null, proxy: true };
  const position = clamp01((ltp - bid) / (ask - bid));
  const side = position >= THRESHOLDS.aggressorBuy ? "buyer-aggressive" : position <= THRESHOLDS.aggressorSell ? "seller-aggressive" : "neutral";
  return { position: round(position, 3), side, proxy: true };
}

/** Mean of the positive IVs of the ATM call and put, or null. */
function atmIvOf(chain) {
  const row = (chain?.rows ?? []).find((r) => r.strike === chain?.atmStrike);
  const ivs = [num(row?.ce?.iv), num(row?.pe?.iv)].filter((v) => v > 0);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
}

/** Score 0-100 from the metrics (see METHOD.score). */
export function scoreOf({ volOi, premiumInr, otmPct, ivVsAtm, oiChangePct }) {
  const w = SCORE_WEIGHTS;
  const s =
    w.volOi * clamp01((volOi ?? 0) / 3) +
    w.premium * clamp01((premiumInr ?? 0) / 20_000_000) +
    w.otm * clamp01((otmPct ?? 0) / 5) +
    w.iv * (ivVsAtm === null || ivVsAtm === undefined ? 0 : clamp01(Math.abs(ivVsAtm - 1) / 0.5)) +
    w.oiBuildup * clamp01((oiChangePct ?? 0) / 20);
  return round(s, 1);
}

/** Scan one chain; returns contract rows (volume > 0 and ltp > 0 only), unsorted and unfiltered by thresholds. */
export function scanChain(chain) {
  const spot = num(chain?.underlyingLtp);
  const lot = num(chain?.lotSize) > 0 ? Number(chain.lotSize) : null;
  const atmIv = atmIvOf(chain);
  const out = [];
  for (const r of chain?.rows ?? []) {
    for (const [leg, side] of [[r.ce, "call"], [r.pe, "put"]]) {
      const volume = num(leg?.volume);
      const ltp = num(leg?.ltp);
      if (!(volume > 0) || !(ltp > 0)) continue;
      const oi = num(leg.oi) ?? 0;
      const oiChange = num(leg.oiChange);
      const volOi = oi > 0 ? volume / oi : null;
      // Volume is in units on this Bridge (unitMultiplier 1); a chain marked units: "lots" counts contracts.
      const premiumInr = lot ? volume * ltp * unitMultiplier(chain) : null;
      const otmRaw = spot > 0 ? (side === "call" ? r.strike - spot : spot - r.strike) / spot * 100 : null;
      const iv = num(leg.iv) > 0 ? Number(leg.iv) : null;
      const ivVsAtm = iv && atmIv ? iv / atmIv : null;
      const prior = oiChange !== null ? oi - oiChange : 0;
      const oiChangePct = oiChange !== null && prior > 0 ? (oiChange / prior) * 100 : null;
      const flags = [];
      if (volOi !== null && volOi >= THRESHOLDS.volOi) flags.push(FLAGS.VOLUME_SPIKE);
      if (premiumInr !== null && premiumInr >= THRESHOLDS.premiumInr) flags.push(FLAGS.BIG_PREMIUM);
      if (otmRaw !== null && otmRaw >= THRESHOLDS.otmPct && volOi !== null && volOi >= THRESHOLDS.lotteryVolOi) flags.push(FLAGS.OTM_LOTTERY);
      if (ivVsAtm !== null && Math.abs(ivVsAtm - 1) >= THRESHOLDS.ivDeviation) flags.push(FLAGS.IV_ANOMALY);
      if (oiChangePct !== null && oiChangePct >= THRESHOLDS.oiBuildupPct) flags.push(FLAGS.OI_BUILDUP);
      out.push({
        underlying: chain?.underlying ?? null,
        expiry: chain?.expiry ?? null,
        symbol: leg.symbol ?? null,
        side,
        strike: r.strike,
        ltp,
        volume,
        oi,
        oiChange,
        oiChangePct: round(oiChangePct),
        volOi: round(volOi, 3),
        premiumInr: round(premiumInr),
        otmPct: round(otmRaw),
        iv,
        atmIv: round(atmIv),
        ivVsAtm: round(ivVsAtm, 3),
        aggressor: aggressorProxy(leg),
        flags,
        score: scoreOf({ volOi, premiumInr, otmPct: otmRaw, ivVsAtm, oiChangePct }),
      });
    }
  }
  return out;
}

const SORTS = { score: (c) => c.score, premium: (c) => c.premiumInr ?? -1, volOi: (c) => c.volOi ?? -1 };

/** @param {object} deps full deps (needs marketData) */
export function unusualRoutes(deps) {
  const md = () => deps.marketData;
  return [
    [
      "GET",
      "/v1/analytics/unusual",
      { scope: "read" },
      async (ctx) => {
        const q = ctx.query;
        const raw = opt(q, "underlyings");
        if (!raw) throw invalid("underlyings", "underlyings is required, for example NIFTY,BANKNIFTY.");
        const underlyings = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
        if (!underlyings.length) throw invalid("underlyings", "underlyings is required, for example NIFTY,BANKNIFTY.");
        if (underlyings.length > MAX_UNDERLYINGS) throw invalid("underlyings", `underlyings accepts at most ${MAX_UNDERLYINGS} symbols.`);
        const bad = underlyings.find((u) => !/^[A-Z0-9&_-]{1,30}$/.test(u));
        if (bad) throw invalid("underlyings", `${bad} is not a valid underlying.`);
        const expiryIn = opt(q, "expiry");
        if (expiryIn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expiryIn)) throw invalid("expiry", "expiry must be YYYY-MM-DD.");
        const minPremium = numParam(q, "minPremium", 0, 1e13, 0);
        const minVolOi = numParam(q, "minVolOi", 0, 1e6, 0);
        const side = opt(q, "side") ?? "both";
        if (!["call", "put", "both"].includes(side)) throw invalid("side", "side must be call, put or both.");
        const sort = opt(q, "sort") ?? "score";
        if (!SORTS[sort]) throw invalid("sort", "sort must be score, premium or volOi.");
        const limit = numParam(q, "limit", 1, 500, 50);
        if (!Number.isInteger(limit)) throw invalid("limit", "limit must be a whole number from 1 to 500.");
        const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
        const nowMs = nowMsOf(deps);

        const errors = [];
        const scanned = [];
        let freshness;
        await Promise.all(
          underlyings.map(async (underlying) => {
            try {
              let expiry = expiryIn;
              if (!expiry) {
                const list = await md().expiries(underlying, opts);
                expiry = upcomingExpiries(list.expiries, nowMs)[0];
                if (!expiry) throw new BridgeError("SYMBOL_NOT_FOUND", `No upcoming expiry for ${underlying}.`);
              }
              const chain = await md().optionChain({ underlying, expiry, greeks: true }, opts);
              freshness ??= chain.freshness;
              const items = scanChain({ ...chain, underlying, expiry });
              scanned.push({ underlying, expiry, lotSizeMissing: !(num(chain.lotSize) > 0), contracts: items.length, items });
            } catch (err) {
              errors.push({ underlying, code: err?.code ?? "INTERNAL", message: err?.detail ?? err?.message ?? "scan failed" });
            }
          }),
        );
        const order = new Map(underlyings.map((u, i) => [u, i]));
        scanned.sort((a, b) => order.get(a.underlying) - order.get(b.underlying));
        errors.sort((a, b) => order.get(a.underlying) - order.get(b.underlying));

        const pick = SORTS[sort];
        const all = scanned
          .flatMap((s) => s.items)
          .filter((c) => (side === "both" || c.side === side) && (c.premiumInr ?? 0) >= minPremium && (c.volOi ?? 0) >= minVolOi && (minPremium === 0 || c.premiumInr !== null) && (minVolOi === 0 || c.volOi !== null))
          .sort((a, b) => pick(b) - pick(a) || b.score - a.score || a.underlying.localeCompare(b.underlying) || a.strike - b.strike || a.side.localeCompare(b.side));
        const data = {
          filters: { underlyings, expiry: expiryIn ?? "nearest", minPremium, minVolOi, side, sort, limit },
          count: all.length,
          returned: Math.min(all.length, limit),
          underlyings: scanned.map(({ items, ...s }) => s),
          contracts: all.slice(0, limit),
          method: METHOD,
          disclaimer: "Aggressor side is a bid/ask-position proxy, not trade-tape data. Informational only, not advice.",
        };
        return {
          data,
          ...(errors.length ? { errors } : {}),
          meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) },
        };
      },
    ],
  ];
}
