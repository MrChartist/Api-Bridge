// format.js — the only place the dashboard turns a number into display text (the house rule for numbers).
//
// Figures are printed WITHOUT thousands separators: ₹125000.50, 3000, 1234.56% (formatRupeeGrouped is the exception,
// for a figure read on its own: a limit, a sentence beside the Bridge's own messages). Decimal points, the rupee sign, the
// percent sign and meaningful precision are kept. A negative starts with the true minus sign U+2212 ("−4.10", "−₹42.00"),
// never a hyphen. Only display changes: values sent to the Bridge, maths and input parsing never pass through here.
// Missing data prints as DASH, an en dash "–", never as 0.
//
// Use these instead of Number.prototype.toLocaleString or Intl.NumberFormat (format.test.mjs checks the other dashboard
// files do not reach for them). Pure; safe in Node.

/** What a missing figure prints as: one en dash "–" (U+2013), never "--" and never 0. */
export const DASH = "\u2013";
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

/** Any number, no grouping. Defaults: up to 3 fraction digits. Missing → DASH. */
export function formatNumber(value, options) {
  if (!isFigure(value)) return DASH;
  return trueMinus(plain(value, options));
}

/** A whole number (rounded). Missing → DASH. */
export const formatInt = (value) => formatNumber(value, { maximumFractionDigits: 0 });

/** The word for a count: one when it is exactly 1, otherwise `many` (default: one + "s"). The one place a plural is decided. */
export const pluralWord = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);

/** A count with its word: "1 call", "2 calls", "0 calls". */
export const plural = (n, one, many) => `${formatInt(n)} ${pluralWord(n, one, many)}`;

/** Exactly `dp` decimals: use it for every cell of a numeric column so the decimals line up. Missing → DASH. */
export const formatFixed = (value, dp = 2) => formatNumber(value, { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** ₹ prefix, exactly `dp` decimals (default 2, the money column rule). A negative puts its sign first ("−₹42.00"). Missing → DASH. */
export function formatRupee(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const abs = fixedPlain(Math.abs(Number(value)), dp);
  return Number(value) < 0 && Number(abs) !== 0 ? `${MINUS}₹${abs}` : `₹${abs}`;
}

/** A percentage with fixed decimals ("12.3%"). Missing → DASH. */
export const formatPercent = (value, dp = 1) => (isFigure(value) ? `${formatFixed(value, dp)}%` : DASH);

/**
 * Money with an explicit sign, sign first: "+₹1204.50", "−₹1204.50", "₹0.00" (a value that rounds to zero has no
 * sign). The one money rule for P&L, credit / debit and max profit / loss. Missing → DASH.
 */
export function formatSignedRupee(value, dp = 2) {
  if (!isFigure(value)) return DASH;
  const n = Number(value);
  const t = fixedPlain(Math.abs(n), dp);
  if (Number(t) === 0) return `₹${t}`;
  return `${n > 0 ? "+" : MINUS}₹${t}`;
}

/** Indian digit grouping of a plain figure ("1234567.50" → "12,34,567.50"); the sign and decimals pass through. */
export function groupIndian(text) {
  const [, sign, int, frac = ""] = /^(-?)(\d+)(\.\d+)?$/.exec(text) ?? [null, "", text];
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  return `${sign}${rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3}${frac}`;
}

/**
 * Rupees with Indian grouping ("₹1,750", "₹10,000", "₹1,25,000", "−₹500"; with `dp` 2: "₹1,70,626.00"). The one
 * exception to the no-separator rule, for figures read on their own rather than in a column: sentences that sit next
 * to the Bridge's own messages (the readiness facts beside "₹1,750 of ₹10,000 daily loss left." from
 * server/bridge/readiness/checks.mjs), the daily limits. Whole rupees by default.
 * Missing → DASH.
 */
export function formatRupeeGrouped(value, dp = 0) {
  if (!isFigure(value)) return DASH;
  const abs = fixedPlain(Math.abs(Number(value)), dp);
  return `${Number(value) < 0 && Number(abs) !== 0 ? MINUS : ""}₹${groupIndian(abs)}`;
}

const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
/** A calendar day ("2026-11-03") as "3 Nov" (an expiry in a contract name). Anything else comes back as given; "" when missing. */
export function formatDayMonth(isoDay) {
  if (typeof isoDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) return isoDay ?? "";
  const d = new Date(`${isoDay}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDay : DAY_MONTH.format(d);
}

/**
 * Where the dashboard's "Guide" links point. One place, so there is one line to change. They name the `main` branch
 * because no release tag exists yet; the first release changes GUIDE_REF to its version tag (`v2.0.0`), so a Bridge of
 * an older version reads the guides written for it.
 */
export const GUIDE_REF = "main";
export const guideUrl = (name, anchor = "") => `https://github.com/MrChartist/api-bridge-v2/blob/${GUIDE_REF}/docs/guides/${name}.md${anchor}`;
