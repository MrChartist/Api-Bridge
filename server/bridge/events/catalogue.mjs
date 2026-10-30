/**
 * Live events catalogue (stream S28, docs/guides/live-events.md). The one list of event kinds the engine can detect,
 * with a plain definition, the side it reads as (bull, bear or neutral; "move" means the side follows the price
 * direction at the time), its category for the event picker, and its parameters with defaults and bounds. Pure data:
 * the server validates selections against it and the dashboard draws the picker from GET /v1/events/catalogue.
 *
 * Stock events run on quotes of stocks and indices (and the front future for F&O stocks); option events run on chain
 * legs and chain-level metrics (walls, PCR, max pain, straddle, basis) computed with dashboard/options.js.
 */

/** Picker categories, in display order. `asset` says which feed the kinds in it read. */
export const CATEGORIES = Object.freeze([
  { id: "price", label: "Price", asset: "stock" },
  { id: "gap", label: "Gaps", asset: "stock" },
  { id: "volume", label: "Volume", asset: "stock" },
  { id: "circuit", label: "Circuits", asset: "stock" },
  { id: "levels", label: "Levels and pivots", asset: "stock" },
  { id: "reversal", label: "Swings and reversals", asset: "stock" },
  { id: "fno", label: "F&O OI", asset: "stock" },
  { id: "custom", label: "Custom conditions", asset: "stock" },
  { id: "opt-oi", label: "Option OI", asset: "option" },
  { id: "opt-iv", label: "Premium and IV", asset: "option" },
  { id: "opt-walls", label: "Walls, PCR and max pain", asset: "option" },
  { id: "opt-volume", label: "Unusual option volume", asset: "option" },
]);

const p = (key, label, def, min, max, step = 1, unit = "") => Object.freeze({ key, label, default: def, min, max, step, unit });
const AFTER = p("afterMinutes", "After the first", 15, 0, 120, 1, "min");

/**
 * Every event kind. side: "bull" | "bear" | "neutral" | "move" (follows the price direction) | "pair" (the variant
 * decides: an up-cross is bull, a down-cross bear).
 */
export const KINDS = Object.freeze(
  [
    // ── Stock: price ──
    { kind: "day_high", label: "New day high", category: "price", side: "bull", asset: "stock", def: "The price trades above the day's high so far, once the first minutes of the session have passed.", params: [AFTER] },
    { kind: "day_low", label: "New day low", category: "price", side: "bear", asset: "stock", def: "The price trades below the day's low so far, once the first minutes of the session have passed.", params: [AFTER] },
    { kind: "move_pct", label: "% move", category: "price", side: "pair", asset: "stock", def: "The change from the previous close crosses one of the levels, up or down (each level fires once a day per direction).", params: [p("levels", "Levels", [2, 5, 10], 0.5, 20, 0.5, "%")] },
    { kind: "vwap_cross", label: "VWAP cross", category: "price", side: "pair", asset: "stock", def: "The price crosses the day's volume-weighted average price by more than the buffer.", params: [AFTER, p("bufferPct", "Buffer", 0.1, 0, 2, 0.05, "%")] },
    // ── Gaps ──
    { kind: "gap_up", label: "Gap up", category: "gap", side: "bull", asset: "stock", def: "The day opens above the previous close by at least the threshold.", params: [p("minPct", "Gap at least", 1, 0.2, 20, 0.1, "%")] },
    { kind: "gap_down", label: "Gap down", category: "gap", side: "bear", asset: "stock", def: "The day opens below the previous close by at least the threshold.", params: [p("minPct", "Gap at least", 1, 0.2, 20, 0.1, "%")] },
    { kind: "gap_filled", label: "Gap filled", category: "gap", side: "pair", asset: "stock", def: "A stock that gapped by at least the threshold trades back to the previous close (a filled gap up reads bear, a filled gap down bull).", params: [p("minPct", "Gap at least", 1, 0.2, 20, 0.1, "%")] },
    // ── Volume ──
    { kind: "vol_above_prev", label: "Volume above prev day", category: "volume", side: "move", asset: "stock", def: "Today's volume so far passes the previous day's full volume.", params: [] },
    { kind: "vol_surge", label: "Volume surge", category: "volume", side: "move", asset: "stock", def: "Volume so far is a multiple of what an average day (20 days; the previous day when that is missing) has traded by this minute, using the NSE intraday volume curve.", params: [p("multiple", "Pace at least", 2.5, 1.2, 20, 0.1, "×"), p("minMinutes", "After the first", 10, 1, 120, 1, "min")] },
    // ── Circuits ──
    { kind: "only_buyers", label: "Only buyers", category: "circuit", side: "bull", asset: "stock", def: "Locked at the upper circuit: the price is at the upper band (broker band, else the 2/5/10/20 % band rounded to the tick) with buyers waiting and no sell quantity.", params: [] },
    { kind: "only_sellers", label: "Only sellers", category: "circuit", side: "bear", asset: "stock", def: "Locked at the lower circuit: the price is at the lower band with sellers waiting and no buy quantity.", params: [] },
    { kind: "circuit_unlocked", label: "Circuit unlocked", category: "circuit", side: "pair", asset: "stock", def: "A stock that was locked at a band trades off it with both sides quoted again (an upper unlock reads bear, a lower unlock bull).", params: [] },
    // ── Levels ──
    { kind: "prev_high_break", label: "Prev day high break", category: "levels", side: "bull", asset: "stock", def: "The price trades above the previous day's high.", params: [] },
    { kind: "prev_low_break", label: "Prev day low break", category: "levels", side: "bear", asset: "stock", def: "The price trades below the previous day's low.", params: [] },
    { kind: "pivot_cross", label: "Pivot crossover", category: "levels", side: "pair", asset: "stock", def: "The price crosses a classic floor pivot from the previous day: P = (H + L + C) / 3, R1 = 2P − L, S1 = 2P − H.", params: [] },
    { kind: "all_time_high", label: "All-time high", category: "levels", side: "bull", asset: "stock", def: "The price trades above the highest high in the daily history the Bridge could fetch (the record says from which date, so a short history is never called all-time without saying so).", params: [] },
    { kind: "all_time_low", label: "All-time low", category: "levels", side: "bear", asset: "stock", def: "The price trades below the lowest low in the daily history the Bridge could fetch (the record says from which date).", params: [] },
    { kind: "high_52w", label: "52-week high", category: "levels", side: "bull", asset: "stock", def: "The price trades above the highest high of the last 52 weeks.", params: [] },
    { kind: "low_52w", label: "52-week low", category: "levels", side: "bear", asset: "stock", def: "The price trades below the lowest low of the last 52 weeks.", params: [] },
    // ── Swings ──
    { kind: "swing_up", label: "Swing up", category: "reversal", side: "bull", asset: "stock", def: "After a swing low, the price turns up by at least the reversal size (zigzag on the day's ticks).", params: [p("reversalPct", "Reversal at least", 1, 0.2, 10, 0.1, "%")] },
    { kind: "swing_down", label: "Swing down", category: "reversal", side: "bear", asset: "stock", def: "After a swing high, the price turns down by at least the reversal size.", params: [p("reversalPct", "Reversal at least", 1, 0.2, 10, 0.1, "%")] },
    // ── F&O stock OI (front future) ──
    { kind: "oi_buildup", label: "OI build-up change", category: "fno", side: "pair", asset: "stock", def: "The front future's build-up class changes: long build-up (price up, OI up), short build-up (down, up), short covering (up, down) or long unwinding (down, down), with the same noise filter as OI Analysis.", params: [p("minOiPct", "OI change at least", 1, 0.1, 20, 0.1, "%")] },
    { kind: "oi_surge", label: "OI surge", category: "fno", side: "move", asset: "stock", def: "The front future's open interest changes by at least the threshold within the window.", params: [p("pct", "OI change at least", 3, 0.5, 50, 0.5, "%"), p("windowMinutes", "Within", 15, 1, 60, 1, "min")] },
    // ── Options: the underlying crosses a strike ──
    { kind: "ul_cross_strike", label: "Spot crosses a strike", category: "opt-walls", side: "pair", asset: "option", def: "The underlying's price crosses a listed strike of its nearest expiry (and names the monthly expiry's OI at that strike when it differs), with that strike's call and put OI and OI change. A hysteresis band keeps noise around a strike from firing again. Up reads bull, down bear.", params: [p("hysteresisPct", "Hysteresis", 0.05, 0, 1, 0.01, "% of spot")] },
    // ── Custom conditions ──
    { kind: "custom", label: "Custom condition", category: "custom", side: "pair", asset: "stock", def: "One of your named conditions (POST /v1/events/conditions) turned true on a tick. It fires on the false-to-true edge only; the condition's name is the label.", params: [] },
    // ── Options: OI ──
    { kind: "opt_oi_surge", label: "Strike OI surge", category: "opt-oi", side: "pair", asset: "option", def: "A strike's OI change over the window is a multiple of its own recent pace (and at least the minimum lots). Call writing reads bear, put writing bull.", params: [p("multiple", "Pace at least", 3, 1.5, 20, 0.5, "×"), p("windowMinutes", "Window", 5, 1, 30, 1, "min"), p("minLots", "At least", 200, 1, 100000, 1, "lots")] },
    { kind: "opt_buildup", label: "Strike build-up change", category: "opt-oi", side: "pair", asset: "option", def: "A strike's build-up class since the previous close changes (long build-up, short build-up, short covering, long unwinding; classifyBuildup from OI Analysis).", params: [p("minLots", "OI change at least", 100, 1, 100000, 1, "lots")] },
    // ── Options: premium and IV ──
    { kind: "opt_premium_spike", label: "Premium spike", category: "opt-iv", side: "pair", asset: "option", def: "An option's premium moves by at least the threshold within the window (premiums under the floor are ignored). A call jump reads bull, a put jump bear.", params: [p("pct", "Move at least", 25, 5, 500, 5, "%"), p("windowMinutes", "Within", 5, 1, 30, 1, "min"), p("minPremium", "Premium at least", 2, 0.05, 1000, 0.05, "₹")] },
    { kind: "iv_spike", label: "IV spike", category: "opt-iv", side: "neutral", asset: "option", def: "ATM IV (or a strike's IV) rises by at least the threshold in vol points within the window.", params: [p("points", "Rise at least", 1.5, 0.2, 50, 0.1, "vol pts"), p("windowMinutes", "Within", 15, 1, 60, 1, "min")] },
    { kind: "iv_crush", label: "IV crush", category: "opt-iv", side: "neutral", asset: "option", def: "ATM IV (or a strike's IV) falls by at least the threshold in vol points within the window.", params: [p("points", "Fall at least", 1.5, 0.2, 50, 0.1, "vol pts"), p("windowMinutes", "Within", 15, 1, 60, 1, "min")] },
    { kind: "straddle_move", label: "Straddle expansion or contraction", category: "opt-iv", side: "neutral", asset: "option", def: "The ATM straddle premium changes by at least the threshold within the window.", params: [p("pct", "Change at least", 8, 1, 100, 1, "%"), p("windowMinutes", "Within", 15, 1, 60, 1, "min")] },
    { kind: "opt_near_band", label: "Option near price band", category: "opt-iv", side: "pair", asset: "option", def: "An option trades within the distance of its exchange price band (when the feed sends bands).", params: [p("withinPct", "Within", 2, 0.1, 20, 0.1, "%")] },
    // ── Options: walls, PCR, max pain, basis ──
    { kind: "wall_shift", label: "Call or put wall shift", category: "opt-walls", side: "pair", asset: "option", def: "The strike with the most call OI (resistance) or put OI (support) moves to another strike. A wall moving up reads bull, down bear.", params: [] },
    { kind: "pcr_cross", label: "PCR crosses a level", category: "opt-walls", side: "pair", asset: "option", def: "The OI put-call ratio crosses one of the levels (up reads bull: put writing; down bear).", params: [p("levels", "Levels", [0.7, 1, 1.3], 0.1, 5, 0.05, "")] },
    { kind: "pcr_jump", label: "Sharp PCR change", category: "opt-walls", side: "pair", asset: "option", def: "The OI put-call ratio changes by at least the threshold within the window.", params: [p("change", "Change at least", 0.1, 0.02, 2, 0.01, ""), p("windowMinutes", "Within", 15, 1, 60, 1, "min")] },
    { kind: "max_pain_shift", label: "Max pain shift", category: "opt-walls", side: "pair", asset: "option", def: "The max pain strike (maxPain from the chain maths) moves to another strike.", params: [] },
    { kind: "basis_jump", label: "Futures basis jump", category: "opt-walls", side: "pair", asset: "option", def: "The front future's basis over spot (cost of carry) changes by at least the threshold of spot within the window.", params: [p("pct", "Change at least", 0.08, 0.01, 2, 0.01, "% of spot"), p("windowMinutes", "Within", 15, 1, 60, 1, "min")] },
    // ── Options: unusual volume ──
    { kind: "opt_unusual_volume", label: "Unusual option volume", category: "opt-volume", side: "pair", asset: "option", def: "A strike's volume today passes a multiple of its open interest (volume / OI), and at least the minimum lots. Calls read bull, puts bear.", params: [p("ratio", "Volume / OI at least", 1.5, 0.2, 50, 0.1, "×"), p("minLots", "Volume at least", 500, 1, 1000000, 1, "lots")] },
  ].map((k) => Object.freeze({ ...k, params: Object.freeze(k.params) })),
);

export const KIND_BY_ID = new Map(KINDS.map((k) => [k.kind, k]));
export const STOCK_KINDS = Object.freeze(KINDS.filter((k) => k.asset === "stock").map((k) => k.kind));
export const OPTION_KINDS = Object.freeze(KINDS.filter((k) => k.asset === "option").map((k) => k.kind));

/**
 * One alert per move: the rank of each level event in its direction. When one tick (or the fold window) brings
 * several of these for the same symbol and direction, only the highest becomes a row; the rest are listed in its
 * `also`. A later, higher one upgrades the row.
 */
export const LADDER = Object.freeze({
  all_time_high: { dir: 1, rank: 4 },
  high_52w: { dir: 1, rank: 3 },
  prev_high_break: { dir: 1, rank: 2 },
  day_high: { dir: 1, rank: 1 },
  all_time_low: { dir: -1, rank: 4 },
  low_52w: { dir: -1, rank: 3 },
  prev_low_break: { dir: -1, rank: 2 },
  day_low: { dir: -1, rank: 1 },
});

/** One-tap selections. Stock presets first, then the option group (asked for as OI, IV, Walls, Unusual volume). */
export const PRESETS = Object.freeze([
  { id: "momentum", label: "Momentum", asset: "stock", kinds: ["day_high", "day_low", "move_pct", "prev_high_break", "prev_low_break", "high_52w", "low_52w", "all_time_high", "all_time_low", "vwap_cross"] },
  { id: "reversals", label: "Reversals", asset: "stock", kinds: ["swing_up", "swing_down", "gap_filled", "pivot_cross", "circuit_unlocked"] },
  { id: "circuits", label: "Circuits", asset: "stock", kinds: ["only_buyers", "only_sellers", "circuit_unlocked"] },
  { id: "volume", label: "Volume", asset: "stock", kinds: ["vol_above_prev", "vol_surge"] },
  { id: "fno-oi", label: "F&O OI", asset: "stock", kinds: ["oi_buildup", "oi_surge"] },
  { id: "opt-oi", label: "OI", asset: "option", kinds: ["opt_oi_surge", "opt_buildup"] },
  { id: "opt-iv", label: "IV", asset: "option", kinds: ["iv_spike", "iv_crush", "straddle_move", "opt_premium_spike", "opt_near_band"] },
  { id: "opt-walls", label: "Walls", asset: "option", kinds: ["wall_shift", "pcr_cross", "pcr_jump", "max_pain_shift", "basis_jump", "ul_cross_strike"] },
  { id: "opt-volume", label: "Unusual volume", asset: "option", kinds: ["opt_unusual_volume"] },
]);

/** The universes a selection may name. FNO / NIFTY50 / INDICES come from the scanner's lists; WATCHLIST is the events watchlist. */
export const UNIVERSES = Object.freeze([
  { id: "FNO", label: "F&O stocks" },
  { id: "INDICES", label: "Indices" },
  { id: "NIFTY50", label: "NIFTY 50" },
  { id: "WATCHLIST", label: "Watchlist" },
  { id: "CASH", label: "Broader cash list" },
]);

/** Option modes: the indices' chains, every F&O stock's chain, or both. */
export const OPTION_MODES = Object.freeze(["indices", "stocks", "both"]);

/** The default parameter object of a kind. */
export function defaultParams(kind) {
  const k = KIND_BY_ID.get(kind);
  return Object.fromEntries((k?.params ?? []).map((x) => [x.key, Array.isArray(x.default) ? [...x.default] : x.default]));
}

/** The default selection: every stock kind and every option kind on, default parameters. */
export function defaultSelection() {
  return {
    version: 1,
    kinds: Object.fromEntries(KINDS.map((k) => [k.kind, { on: true, params: defaultParams(k.kind) }])),
    universes: ["FNO", "INDICES", "WATCHLIST"],
    optionMode: "both",
    watchlist: [],
    cooldownSeconds: 300,
  };
}

/** Clamp one parameter value to its spec (arrays: each item clamped, sorted, unique, at most 6). */
export function clampParam(spec, value) {
  const one = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(spec.max, Math.max(spec.min, n));
  };
  if (Array.isArray(spec.default)) {
    const list = (Array.isArray(value) ? value : [value]).map(one).filter((v) => v !== null);
    const out = [...new Set(list)].sort((a, b) => a - b).slice(0, 6);
    return out.length ? out : [...spec.default];
  }
  const v = one(value);
  return v === null ? spec.default : v;
}

/** The side a hit reads as, from its kind's rule and the hit's direction (+1 up / −1 down / 0). */
export function sideOf(kind, dir = 0) {
  const k = KIND_BY_ID.get(kind);
  if (!k) return "neutral";
  if (k.side === "bull" || k.side === "bear" || k.side === "neutral") return k.side;
  return dir > 0 ? "bull" : dir < 0 ? "bear" : "neutral";
}
