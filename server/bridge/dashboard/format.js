// format.js — the only place the dashboard turns a number into display text (the Mr. Chartist house rule, as in
// IPO Decode's utils/number-format.js).
//
// Figures are printed WITHOUT thousands separators: ₹125000.50, 3000, 1234.56%. Decimal points, the rupee sign, the
// percent sign and meaningful precision are kept. A negative starts with the true minus sign U+2212 ("−4.10", "−₹42.00"),
// never a hyphen (TYPE-SYSTEM.md §4). Only display changes: values sent to the Bridge, maths and input parsing never
// pass through here (formatInput is the one exception: an editable field's text, which keeps the ASCII hyphen so the
// parser reads it back). Missing data prints as "--", never as 0.
//
// Use these instead of Number.prototype.toLocaleString or Intl.NumberFormat (format.test.mjs checks the other dashboard
// files do not reach for them). Pure; safe in Node.

/** What a missing figure prints as. */
export const DASH = "--";
/** The true minus sign: every negative figure on the page starts with it. */
export const MINUS = "\u2212";

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
/** Plain text (ASCII hyphen) for maths on the formatted figure; the exported formatters add the true minus last. */
const plain = (value, options) => noNegativeZero(formatter(options).format(Number(value)));
const fixedPlain = (value, dp) => plain(value, { minimumFractionDigits: dp, maximumFractionDigits: dp });
/** A leading hyphen becomes the true minus sign. */
export const trueMinus = (text) => String(text).replace(/^-/, MINUS);

/** True for a finite number (a numeric string counts); null, undefined, "", NaN and Infinity do not. */
export const isFigure = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));

/** Any number, no grouping. Defaults: up to 3 fraction digits. Missing → "--". */
export function formatNumber(value, options) {
  if (!isFigure(value)) return DASH;
  return trueMinus(plain(value, options));
}

/** A whole number (rounded). Missing → "--". */
export const formatInt = (value) => formatNumber(value, { maximumFractionDigits: 0 });

/** Exactly `dp` decimals: use it for every cell of a numeric column so the decimals line up. Missing → "--". */
export const formatFixed = (value, dp = 2) => formatNumber(value, { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** ₹ prefix, exactly `dp` decimals (default 2, the money column rule). A negative puts its sign first ("−₹42.00"). Missing → "--". */
export function formatRupee(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const abs = fixedPlain(Math.abs(Number(value)), dp);
  return Number(value) < 0 && Number(abs) !== 0 ? `${MINUS}₹${abs}` : `₹${abs}`;
}

/** A signed figure with an explicit + for gains ("+12.30", "−4.10", "0.00"), fixed decimals. Missing → "--". */
export function formatSigned(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const text = fixedPlain(value, dp);
  return Number(text) > 0 ? `+${text}` : trueMinus(text);
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
  // The unit is checked again after rounding: 99,957 is "1.00L", not "100.0K"; 9,999,999 is "1.00Cr", not "100.00L".
  const UNITS = [[1, "", 0, 1e3], [1e3, "K", 1, 100], [1e5, "L", 2, 100], [1e7, "Cr", 2, Infinity]];
  let k = a >= 1e7 ? 3 : a >= 1e5 ? 2 : a >= 1e3 ? 1 : 0;
  while (k < 3 && Math.abs(Number(fixedPlain(a / UNITS[k][0], UNITS[k][2]))) >= UNITS[k][3]) k += 1;
  const [div, unit, dp] = UNITS[k];
  const text = `${fixedPlain(n / div, dp)}${unit}`;
  return signed && Number(fixedPlain(n / div, dp)) > 0 ? `+${text}` : trueMinus(text.replace(/^-(0(?:\.0+)?)(\D*)$/, "$1$2"));
}

/**
 * An axis tick in compact units with the padded zeros trimmed: "6L", "−1L", "2.5L", "500K", "1.25Cr", "0". Ticks are
 * round numbers, so the trailing zeros formatCompact keeps for column alignment only add noise on an axis.
 */
export function formatCompactTick(value) {
  const t = formatCompact(value);
  return t === DASH ? t : t.replace(/(\.\d*?)0+(?=\D*$)/, "$1").replace(/\.(?=\D*$)/, "");
}

/**
 * Money with an explicit sign, sign first: "+₹1204.50", "−₹1204.50", "₹0.00" (a value that rounds to zero has no
 * sign). The one money rule for P&L, credit / debit and max profit / loss. Missing → "--".
 */
export function formatSignedRupee(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const n = Number(value);
  const t = fixedPlain(Math.abs(n), dp);
  if (Number(t) === 0) return `₹${t}`;
  return `${n > 0 ? "+" : MINUS}₹${t}`;
}

/**
 * Whole rupees with Indian grouping ("₹1,750", "₹10,000", "₹1,25,000", "−₹500"), built with string maths. The one
 * exception to the no-separator rule: sentences that sit next to the Bridge's own messages (the readiness facts beside
 * "₹1,750 of ₹10,000 daily loss left." from server/bridge/readiness/checks.mjs) print the same figure the same way.
 * Missing → "--".
 */
export function formatRupeeGrouped(value) {
  if (!isFigure(value)) return DASH;
  const n = Math.round(Number(value));
  const s = String(Math.abs(n));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${n < 0 ? MINUS : ""}₹${grouped}`;
}

/** An editable field's starting text: fixed decimals, no grouping, an ASCII hyphen (the field's parser reads it back). Missing → "". */
export const formatInput = (value, dp = 2) => (isFigure(value) ? fixedPlain(value, dp) : "");

/** How old data is, in whole units: "12 s old", "2 min old", "1 h old". Negative (clock skew) or under 1 s → "just now". */
export function ageText(ms) {
  if (!isFigure(ms) || Number(ms) < 1000) return "just now";
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${s} s old`;
  if (s < 3600) return `${Math.floor(s / 60)} min old`;
  return `${Math.floor(s / 3600)} h old`;
}

const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
/** A calendar day ("2026-11-03") as "3 Nov" (an expiry in a contract name). Anything else comes back as given; "" when missing. */
export function formatDayMonth(isoDay) {
  if (typeof isoDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) return isoDay ?? "";
  const d = new Date(`${isoDay}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDay : DAY_MONTH.format(d);
}
