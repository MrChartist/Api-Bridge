/**
 * Neutral copy (BRD §8.1): the one banned-word list and its scanner (copyRules.mjs), plus the files held to it.
 * Each Phase 1 step adds its new dashboard files to NEUTRAL_COPY_FILES, with an allowlist of order-side controls
 * only (for example /^(Buy|Sell)$/ for a ticket's side toggle).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANNED_WORDS, checkCopy, checkFiles, checkSource, findBanned, scanJs } from "./copyRules.mjs";

/** file -> allowlist (strings or RegExps that name an order side). */
const NEUTRAL_COPY_FILES = Object.freeze({
  "format.js": [],
  "chain-metrics.js": [],
  "chain-facts.js": [],
  "flows.js": ["SELL"], // ticketRisk compares the order side
  "oi-store.js": [],
  "viz.js": [],
  "vol-curves.js": [],
  "motion.js": [],
  "participants.js": [],
  "book-core.js": [],
  "book-view.js": ["BUY", "SELL"],
  // P1-2b (docs/spec/p1-02-reference.md §7.2): reference chips, banners and the Market calendar describe facts only.
  "reference.js": [],
  "calendar.js": [],
  // Trader tools (ux-audit.md, trading pass 2): the what-if panel and the journal state figures, never advice.
  "whatif.js": [],
  "whatif-core.js": ["SELL"],
  "journal.js": ["buy", "sell"], // the side-tag class names
  "journal-core.js": ["BUY", "SELL"],
  "explain-core.js": [],
  // The OI suite (OI change, Spurts, PCR, Max pain, OI heatmap): build-up names and plain words, never advice.
  "oi-suite-core.js": [],
  "analyticsOi.js": [],
  "explain.js": [],
  // Screeners › Stocks: the scan library, the builder's values and the results describe numbers, never advice.
  "scanner.js": ["BUY"], // the ATM straddle handed to Strategy Builder names its legs' side
  "scan-builder.js": [],
  "scan-library.js": [],
  // The option chain's insight cards and help: column names that carry an order side are the only exceptions.
  "chain-help.js": ["POP buy", "POP sell"],
  "chain-insight-core.js": [],
  "chain-insight.js": ["PoP buy", "PoP sell"], // the action sheet's figure labels, matched to their columns
});

describe("banned-word list", () => {
  it("is the one list from docs/spec/README.md §3.1", () => {
    expect(BANNED_WORDS).toEqual(["recommend", "best", "buy", "sell", "rich", "cheap", "safe", "avoid", "opportunity", "signal", "bullish", "bearish", "support", "resistance"]);
  });

  it("matches whole words and inflections, any case, and nothing else", () => {
    const words = (t) => findBanned(t).map((x) => x.word);
    expect(words("We recommend this; Recommended; recommendations")).toEqual(["recommend", "Recommended", "recommendations"]);
    expect(words("Best BUY, sellers, cheaper, safest, opportunities, signals, supported, Resistance, bullish, bearish, rich, avoid")).toHaveLength(13);
    expect(words("Safety card, bestow, buyback-free? subsidy, richness, signalling")).toEqual(["signalling"]);
    expect(words("Kill switch, IV rank, largest call OI, in ban, lot changes")).toEqual([]);
    expect(findBanned(null)).toEqual([]);
  });
});

describe("source scanner", () => {
  it("reads string literals and template text, not comments, identifiers or regex literals", () => {
    const src = [
      "// best buy in a comment",
      "/* sell rich */",
      'const buyQty = 1; const label = "Largest call OI";',
      "const t = `IV ${x > 1 ? \"higher\" : `lower ${y}`} than on 70 % of days`;",
      "const re = /sell|buy/g; const half = a / b / c;",
      "const s = 'it\\'s fine';",
    ].join("\n");
    const { strings, code } = scanJs(src);
    expect(strings).toEqual(["Largest call OI", "IV ", "higher", "lower ", "", " than on 70 % of days", "it\\'s fine"]);
    expect(code).not.toMatch(/comment/);
    expect(checkSource(src)).toEqual([]);
  });

  it("flags advice in strings and honours a per-file allowlist of order-side controls", () => {
    const src = 'const a = "Buy"; const b = "Sell"; const c = "Best strike to sell";';
    expect(checkSource(src).map((v) => v.text)).toEqual(["Buy", "Sell", "Best strike to sell", "Best strike to sell"]);
    expect(checkSource(src, { allow: [/^(Buy|Sell)$/] })).toEqual([{ text: "Best strike to sell", word: "Best" }, { text: "Best strike to sell", word: "sell" }]);
    expect(checkCopy(["Sell premium"], { allow: ["Sell premium"] })).toEqual([]);
    // A /g allowlist entry exempts every matching string, not every other one.
    expect(checkCopy(["Buy", "Sell", "Buy", "Sell"], { allow: [/^(Buy|Sell)$/g] })).toEqual([]);
    expect(checkFiles([{ name: "x.js", src: 'q("Cheap")' }])).toEqual([{ file: "x.js", text: "Cheap", word: "Cheap" }]);
  });
});

describe("dashboard files held to neutral copy", () => {
  it("have no banned words outside their order-side allowlists", () => {
    const files = Object.entries(NEUTRAL_COPY_FILES).map(([name, allow]) => ({ name, allow, src: readFileSync(new URL(`./${name}`, import.meta.url), "utf8") }));
    expect(checkFiles(files)).toEqual([]);
  });
});
