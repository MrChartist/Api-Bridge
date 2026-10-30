// scan-library.js: the ready-made scans (pure data; the Bridge serves the same list at GET /v1/scanner/library and
// demo mode plants hits for each). Every scan is a builder model (scan-builder.js), so one click runs it and the
// builder opens it for editing. Price scans are range and level based, never candle patterns. Copy is neutral: the
// scans describe what the numbers show, not what to do.

import { compileModel } from "./scan-builder.js";

const r = (left, op, right, mult) => (mult === undefined ? { left, op, right } : { left, op, right, mult });
const f = (id, p) => (p ? { id, p } : { id });
const num = (v) => ({ num: v });
const all = (...rules) => ({ join: "and", rules });

/** Library groups in display order. */
export const LIBRARY_GROUPS = Object.freeze([
  { id: "price", label: "Price" },
  { id: "fno", label: "F&O" },
  { id: "chain", label: "Option chain" },
]);

/**
 * side: which way the move points ("up", "down", "neutral"): a colour cue only.
 * needs: data the scan reads besides prices ("futures", "chain", "ivHistory", "mwpl").
 */
const RAW = [
  // ── Price ──
  { id: "gap-up", group: "price", name: "Gap up", side: "up", plain: "Opened more than 2 % above the previous close.", model: all(r(f("gap_pct"), "gt", num(2))), sort: "gap_pct" },
  { id: "gap-down", group: "price", name: "Gap down", side: "down", plain: "Opened more than 2 % below the previous close.", model: all(r(f("gap_pct"), "lt", num(-2))), sort: "gap_pct", order: "asc" },
  { id: "high-52w", group: "price", name: "At a 52-week high", side: "up", plain: "Today's high reached the 52-week high.", model: all(r(f("high"), "gte", f("high_52w"))), sort: "change_pct" },
  { id: "low-52w", group: "price", name: "At a 52-week low", side: "down", plain: "Today's low reached the 52-week low.", model: all(r(f("low"), "lte", f("low_52w"))), sort: "change_pct", order: "asc" },
  { id: "near-upper-circuit", group: "price", name: "Near the upper circuit", side: "up", plain: "Within 1 % of the upper price band.", model: all(r(f("to_upper_circuit_pct"), "lte", num(1))), sort: "to_upper_circuit_pct", order: "asc" },
  { id: "near-lower-circuit", group: "price", name: "Near the lower circuit", side: "down", plain: "Within 1 % of the lower price band.", model: all(r(f("to_lower_circuit_pct"), "lte", num(1))), sort: "to_lower_circuit_pct", order: "asc" },
  { id: "nr7", group: "price", name: "NR7", side: "neutral", plain: "Yesterday's range was the narrowest of the last 7 days.", model: all(r(f("nr7"), "yes")), sort: "range_pct", order: "asc" },
  { id: "inside-day", group: "price", name: "Inside day", side: "neutral", plain: "Yesterday's high and low stayed inside the day before.", model: all(r(f("inside_day"), "yes")), sort: "range_pct", order: "asc" },
  { id: "pdh-breakout-volume", group: "price", name: "Above previous-day high on volume", side: "up", plain: "Price above yesterday's high with volume at 1.5× its usual pace or more.", model: all(r(f("close"), "gt", f("prev_high")), r(f("vol_pace"), "gte", num(1.5))), sort: "vol_pace" },
  { id: "pdl-breakdown-volume", group: "price", name: "Below previous-day low on volume", side: "down", plain: "Price below yesterday's low with volume at 1.5× its usual pace or more.", model: all(r(f("close"), "lt", f("prev_low")), r(f("vol_pace"), "gte", num(1.5))), sort: "vol_pace" },
  { id: "high-20-volume", group: "price", name: "Above 20-day high on volume", side: "up", plain: "Close above the 20-day high, volume more than 2× the 20-day average volume.", model: all(r(f("close"), "gt", f("high_n", { n: 20 })), r(f("volume"), "gt", f("avg_volume_n", { n: 20 }), 2)), sort: "vol_pace" },

  // ── F&O ──
  { id: "long-buildup", group: "fno", name: "Long build-up", side: "up", plain: "Futures price up and futures OI up more than 3 %.", needs: ["futures"], model: all(r(f("fut_change_pct"), "gt", num(0.5)), r(f("fut_oi_change_pct"), "gt", num(3))), sort: "fut_oi_change_pct" },
  { id: "short-buildup", group: "fno", name: "Short build-up", side: "down", plain: "Futures price down and futures OI up more than 3 %.", needs: ["futures"], model: all(r(f("fut_change_pct"), "lt", num(-0.5)), r(f("fut_oi_change_pct"), "gt", num(3))), sort: "fut_oi_change_pct" },
  { id: "short-covering", group: "fno", name: "Short covering", side: "up", plain: "Futures price up and futures OI down more than 3 %.", needs: ["futures"], model: all(r(f("fut_change_pct"), "gt", num(0.5)), r(f("fut_oi_change_pct"), "lt", num(-3))), sort: "fut_oi_change_pct", order: "asc" },
  { id: "long-unwinding", group: "fno", name: "Long unwinding", side: "down", plain: "Futures price down and futures OI down more than 3 %.", needs: ["futures"], model: all(r(f("fut_change_pct"), "lt", num(-0.5)), r(f("fut_oi_change_pct"), "lt", num(-3))), sort: "fut_oi_change_pct", order: "asc" },
  { id: "oi-spike", group: "fno", name: "OI spike", side: "neutral", plain: "Futures OI up 10 % or more today.", needs: ["futures"], model: all(r(f("fut_oi_change_pct"), "gte", num(10))), sort: "fut_oi_change_pct" },
  { id: "near-ban", group: "fno", name: "Near the F&O ban", side: "neutral", plain: "Open interest at 80 % or more of the market-wide limit (the ban starts at 95 %).", needs: ["mwpl"], model: all(r(f("mwpl_pct"), "gte", num(80))), sort: "mwpl_pct" },
  { id: "pcr-high", group: "fno", name: "PCR high", side: "neutral", plain: "Put-call OI ratio at 1.5 or more.", needs: ["chain"], model: all(r(f("pcr"), "gte", num(1.5))), sort: "pcr" },
  { id: "pcr-low", group: "fno", name: "PCR low", side: "neutral", plain: "Put-call OI ratio at 0.5 or less.", needs: ["chain"], model: all(r(f("pcr"), "lte", num(0.5))), sort: "pcr", order: "asc" },
  { id: "iv-rank-high", group: "fno", name: "IV rank high", side: "neutral", plain: "ATM IV in the top fifth of its stored range (IV rank 80 or more).", needs: ["chain", "ivHistory"], model: all(r(f("iv_rank"), "gte", num(80))), sort: "iv_rank" },
  { id: "iv-rank-low", group: "fno", name: "IV rank low", side: "neutral", plain: "ATM IV in the bottom fifth of its stored range (IV rank 20 or less).", needs: ["chain", "ivHistory"], model: all(r(f("iv_rank"), "lte", num(20))), sort: "iv_rank", order: "asc" },
  { id: "iv-pctl-high", group: "fno", name: "IV percentile high", side: "neutral", plain: "ATM IV higher than on 90 % of the stored days.", needs: ["chain", "ivHistory"], model: all(r(f("iv_percentile"), "gte", num(90))), sort: "iv_percentile" },
  { id: "iv-pctl-low", group: "fno", name: "IV percentile low", side: "neutral", plain: "ATM IV lower than on 90 % of the stored days.", needs: ["chain", "ivHistory"], model: all(r(f("iv_percentile"), "lte", num(10))), sort: "iv_percentile", order: "asc" },
  { id: "iv-over-hv", group: "fno", name: "IV well over HV", side: "neutral", plain: "ATM IV more than 8 vol points above 20-day historical volatility.", needs: ["chain"], model: all(r(f("iv_hv_gap"), "gt", num(8))), sort: "iv_hv_gap" },
  { id: "iv-under-hv", group: "fno", name: "IV under HV", side: "neutral", plain: "ATM IV more than 3 vol points below 20-day historical volatility.", needs: ["chain"], model: all(r(f("iv_hv_gap"), "lt", num(-3))), sort: "iv_hv_gap", order: "asc" },
  { id: "futures-discount", group: "fno", name: "Futures at a discount", side: "neutral", plain: "The near-month future trades below the stock price.", needs: ["futures"], model: all(r(f("basis_pct"), "lt", num(0))), sort: "basis_pct", order: "asc" },
  { id: "rollover-high", group: "fno", name: "High rollover", side: "neutral", plain: "Next-month futures hold 60 % or more of near plus next OI.", needs: ["futures"], model: all(r(f("rollover_pct"), "gte", num(60))), sort: "rollover_pct" },
  { id: "cash-futures-arb", group: "fno", name: "Cash-futures carry", side: "neutral", plain: "Annualised futures basis of 9 % or more: the carry a cash-futures trade would lock in, before costs.", needs: ["futures"], model: all(r(f("basis_ann_pct"), "gte", num(9))), sort: "basis_ann_pct" },

  // ── Option chain ──
  { id: "oi-change-strike", group: "chain", name: "Largest strike OI change", side: "neutral", plain: "One strike's OI changed by 30 % or more today; the row names the strike.", needs: ["chain"], model: all(r(f("top_oi_chg_pct"), "gte", num(30))), sort: "top_oi_chg_pct" },
  { id: "unusual-option-volume", group: "chain", name: "Unusual option volume", side: "neutral", plain: "A strike traded at least 1.5× its open interest today.", needs: ["chain"], model: all(r(f("max_vol_oi"), "gte", num(1.5))), sort: "max_vol_oi" },
  { id: "put-skew-steep", group: "chain", name: "OTM puts priced over ATM", side: "neutral", plain: "The 5 % out-of-the-money put's IV is 4 or more vol points above ATM IV.", needs: ["chain"], model: all(r(f("put_skew"), "gte", num(4))), sort: "put_skew" },
  { id: "call-skew-under", group: "chain", name: "OTM calls priced under ATM", side: "neutral", plain: "The 5 % out-of-the-money call's IV is 1.5 or more vol points below ATM IV.", needs: ["chain"], model: all(r(f("call_skew"), "lte", num(-1.5))), sort: "call_skew", order: "asc" },
  { id: "max-pain-far", group: "chain", name: "Far from max pain", side: "neutral", plain: "Price 3 % or more away from the max pain strike.", needs: ["chain"], model: { join: "or", rules: [r(f("max_pain_dist_pct"), "gte", num(3)), r(f("max_pain_dist_pct"), "lte", num(-3))] }, sort: "max_pain_dist_pct" },
  { id: "straddle-under-move", group: "chain", name: "Straddle under the expected move", side: "neutral", plain: "The ATM straddle costs 0.75× the expected move or less.", needs: ["chain"], model: all(r(f("straddle_vs_move"), "lte", num(0.75))), sort: "straddle_vs_move", order: "asc" },
  { id: "straddle-over-move", group: "chain", name: "Straddle over the expected move", side: "neutral", plain: "The ATM straddle costs 0.95× the expected move or more.", needs: ["chain"], model: all(r(f("straddle_vs_move"), "gte", num(0.95))), sort: "straddle_vs_move" },
];

/** Every library scan with its condition text compiled from the model. */
export const LIBRARY = Object.freeze(
  RAW.map((s) => {
    const c = compileModel(s.model);
    if (c.errors.length) throw new Error(`scan-library: ${s.id}: ${c.errors[0].message}`);
    return Object.freeze({ ...s, needs: Object.freeze(s.needs ?? []), order: s.order ?? "desc", condition: c.text });
  }),
);
export const LIBRARY_BY_ID = new Map(LIBRARY.map((s) => [s.id, s]));

/**
 * The scan request for a library scan (POST /v1/scanner/jobs body): the live interval, the F&O universe unless one is
 * given, sorted by the scan's own column.
 */
export function libraryRequest(id, { universe = "FNO", model = null } = {}) {
  const s = LIBRARY_BY_ID.get(id);
  if (!s) return null;
  const condition = model ? compileModel(model).text : s.condition;
  return { name: s.name, universe, interval: "live", condition, sort: { by: s.sort, order: s.order } };
}
