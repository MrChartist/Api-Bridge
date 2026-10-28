// format.js — the only place the dashboard turns a number into display text (the Mr. Chartist house rule, as in
// IPO Decode's utils/number-format.js).
//
// Figures are printed WITHOUT thousands separators: ₹125000.50, 3000, 1234.56%. Decimal points, the rupee sign, the
// percent sign, minus signs and meaningful precision are kept. Only display changes: values sent to the Bridge, maths
// and input parsing never pass through here. Missing data prints as "--", never as 0.
//
// Use these instead of Number.prototype.toLocaleString or Intl.NumberFormat (format.test.mjs checks the other dashboard
// files do not reach for them). Pure; safe in Node.

/** What a missing figure prints as. */
export const DASH = "--";

const cache = new Map();
function formatter(options) {
  const key = JSON.stringify(options ?? {});
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-IN", { ...options, useGrouping: false });
    cache.set(key, f);
  }
  return f;
}
// A value that rounds to zero prints as zero: -0.04 at one decimal is "0.0", not "-0.0" (a loss nobody had).
const noNegativeZero = (text) => (/^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text);

/** True for a finite number (a numeric string counts); null, undefined, "", NaN and Infinity do not. */
export const isFigure = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));

/** Any number, no grouping. Defaults: up to 3 fraction digits. Missing → "--". */
export function formatNumber(value, options) {
  if (!isFigure(value)) return DASH;
  return noNegativeZero(formatter(options).format(Number(value)));
}

/** A whole number (rounded). Missing → "--". */
export const formatInt = (value) => formatNumber(value, { maximumFractionDigits: 0 });

/** Exactly `dp` decimals: use it for every cell of a numeric column so the decimals line up. Missing → "--". */
export const formatFixed = (value, dp = 2) => formatNumber(value, { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** ₹ prefix, exactly `dp` decimals (default 2, the money column rule). A negative puts its sign first ("-₹42.00"). Missing → "--". */
export function formatRupee(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const abs = formatFixed(Math.abs(Number(value)), dp);
  return Number(value) < 0 && Number(abs) !== 0 ? `-₹${abs}` : `₹${abs}`;
}

/** A signed figure with an explicit + for gains ("+12.30", "-4.10", "0.00"), fixed decimals. Missing → "--". */
export function formatSigned(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const text = formatFixed(value, dp);
  return Number(text) > 0 ? `+${text}` : text;
}

/** A percentage with fixed decimals ("12.3%"). Missing → "--". */
export const formatPercent = (value, dp = 1) => (isFigure(value) ? `${formatFixed(value, dp)}%` : DASH);

/**
 * Indian compact units for big counts (OI, volume, premium): 1.25Cr, 12.40L, 8.5K, 950. `signed` adds "+" to gains.
 * Still no grouping; 2 decimals for lakh and crore, 1 for thousand. Missing → "--".
 */
export function formatCompact(value, { signed = false } = {}) {
  if (!isFigure(value)) return DASH;
  const n = Number(value);
  const a = Math.abs(n);
  const [div, unit, dp] = a >= 1e7 ? [1e7, "Cr", 2] : a >= 1e5 ? [1e5, "L", 2] : a >= 1e3 ? [1e3, "K", 1] : [1, "", 0];
  const text = `${formatFixed(n / div, dp)}${unit}`;
  return signed && Number(formatFixed(n / div, dp)) > 0 ? `+${text}` : text.replace(/^-(0(?:\.0+)?)(\D*)$/, "$1$2");
}
