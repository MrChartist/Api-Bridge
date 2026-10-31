// Version numbers carried by every compiled script (PRD L-14). Draft until the IR is frozen.
/** Version of this package. */
export const CORE_VERSION = '0.0.0';
/** Version of the intermediate form (IR). 0 means draft: it may still change. It becomes 1 when the owner approves the freeze. */
export const IR_VERSION = 0;
/** Version of the package's public functions and types. 0 means draft. */
export const API_VERSION = 0;
/**
 * Version of the standard-library manifest. Changes whenever a name, argument rule or tag changes (a test pins a digest
 * of those, `stdlib/stdlib.golden.json`). rc.3 (S31) adds the stage-2 `fut.*` and `opt.*` names, which every host refuses with E-DATA-STAGE until the data stage is switched on. rc.8 (2026-10-18) retires the pattern ids hanging_man and inverted_hammer (E-ARG-RETIRED) and adds long_legged_doji and four_price_doji. rc.9 (2026-10-20): show() takes a number or true/false, no longer text (text columns never ran; E-ARG-TYPE). rc.10 (2026-10-25): the warm-up of ta.rsi, ta.atr, ta.ema and ta.rma is where their first value is, the same as their ind.* twins (it was 1 or 2 more). rc.11 (2026-10-25, audit): ta.rsi of a flat series is 50 (was 100), as ind.rsi; an ind.* study is unknown across a candlestick whose own prices are missing (was carried forward); ind.supertrend direction is unknown where its line is; ind.roc and ind.vroc from 0 are unknown (were 0); ind.cci, ind.stddev and ind.bb of a flat window have no spread. rc.12 (2026-10-25, verify): a running-total study (ind.obv, ind.adline, ind.pvt, ind.nvi, ind.pvi, the VWAPs) skips a missing candlestick and carries on, instead of starting again from its seed. rc.13 (2026-10-26, chart indicator audit I1): ind.keltner gains atr_length (default 10) and its mult default is 2 (EMA 20, ATR 10, x2); ind.vwap and ind.vwapbands start again each month on daily candlesticks and each year on weekly and monthly ones (they ran from the first candlestick loaded); ind.rvol on daily candlesticks divides by the average of the previous length candlesticks, today excluded (it included today); ind.sar follows ta.sar's rule order (seed from the closes, penetration tested before the two-bar clamp, a reversal placed outside the reversal candlestick); ind.mcginley never steps past the price (no blow-up after a large gap); ind.chop starts one candlestick earlier, ind.crsi one later, ind.fisher's trigger has no value on its first candlestick. 1.0.0-rc.1: the names for release A are all present (prices, `ta`, the 83
 * studies as `ind`, candlestick patterns, levels, `info`, `fund`); it becomes 1.0.0 when the owner sets
 * `STDLIB_IS_FROZEN`, after which the golden file is not re-recorded without a new version.
 */
export const STDLIB_VERSION = '1.0.0-rc.13';
export const IR_IS_FROZEN = false;
/** True once the owner approves the standard library for release A. Then a changed name, argument or tag needs a new version. */
export const STDLIB_IS_FROZEN = false;
