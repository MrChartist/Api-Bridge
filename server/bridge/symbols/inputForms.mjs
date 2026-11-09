/**
 * Spellings that chart tools, spreadsheets and alert text use for the same instrument, rewritten to the form the
 * resolver already reads. Pure functions, no I/O, nothing guessed: a rewrite applies only to a fixed list of words,
 * and each one says what it did (`rules`) so a bad alert can be explained.
 *
 *   NSE_INDEX:NIFTY 50   -> NSE:NIFTY          exchange words used for segments (NSE_INDEX, NSE_EQ, NSE_FO, BSE_FO ...)
 *   NSE:NIFTY BANK       -> NSE:BANKNIFTY      index display names (the same table the instrument masters use)
 *   NSE:RELIANCE-EQ      -> NSE:RELIANCE       the "-EQ" series tag some brokers append to cash symbols
 */
import { canonicalIndexName, INDEX_NAME_ALIASES } from "./aliases.mjs";

/** Exchange word -> { exchange, index? }. `index` marks the word as naming an index segment. */
export const EXCHANGE_WORDS = Object.freeze({
  NSE_INDEX: { exchange: "NSE", index: true },
  NSEINDEX: { exchange: "NSE", index: true },
  BSE_INDEX: { exchange: "BSE", index: true },
  BSEINDEX: { exchange: "BSE", index: true },
  NSE_EQ: { exchange: "NSE" },
  NSE_CM: { exchange: "NSE" },
  NSECM: { exchange: "NSE" },
  BSE_EQ: { exchange: "BSE" },
  BSE_CM: { exchange: "BSE" },
  BSECM: { exchange: "BSE" },
  NSE_FO: { exchange: "NFO" },
  NSE_FNO: { exchange: "NFO" },
  NSEFO: { exchange: "NFO" },
  BSE_FO: { exchange: "BFO" },
  BSE_FNO: { exchange: "BFO" },
  BSEFO: { exchange: "BFO" },
  MCX_FO: { exchange: "MCX" },
  MCX_COM: { exchange: "MCX" },
  NSE_CD: { exchange: "CDS" },
  CDS_FO: { exchange: "CDS" },
});

const PREFIXED = /^([A-Za-z_]{2,12})\s*:\s*(.+)$/;

/**
 * @param {string} input trimmed symbol text
 * @returns {{ input: string, rules: string[], indexHint: boolean }}
 *   input: the rewritten text (the same text when no rule applied); rules: one sentence per rewrite
 */
export function rewriteSymbolInput(input) {
  const m = PREFIXED.exec(input);
  if (!m) return { input, rules: [], indexHint: false };
  const word = m[1].toUpperCase();
  let rest = m[2].trim();
  const rules = [];
  let exchange = word;
  let indexHint = false;
  const w = EXCHANGE_WORDS[word];
  if (w) {
    exchange = w.exchange;
    indexHint = w.index === true;
    rules.push(`exchange word ${word} read as ${w.exchange}`);
  }
  if (exchange === "NSE" || exchange === "BSE") {
    const target = INDEX_NAME_ALIASES[rest.toUpperCase().replace(/\s+/g, " ")] ?? (indexHint ? canonicalIndexName(rest) : null);
    if (target && target !== rest.toUpperCase()) {
      rules.push(`index name ${rest} read as ${target}`);
      rest = target;
    }
  }
  if ((exchange === "NSE" || exchange === "BSE") && /^[A-Za-z0-9&_-]{1,25}-EQ$/i.test(rest) && rest.length > 3) {
    rest = rest.slice(0, -3);
    rules.push("series suffix -EQ removed");
  }
  if (!rules.length) return { input, rules, indexHint };
  return { input: `${exchange}:${rest}`, rules, indexHint };
}
