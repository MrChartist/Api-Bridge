/**
 * Neutral copy (BRD §8.1, RA/IA rules): the ONE banned-word list for dashboard text, and the helpers every test uses
 * to scan it (docs/spec/README.md §3.1 F0). Screens describe facts ("IV is higher than on 70 % of days", "in ban",
 * "largest call OI"); they never advise ("best", "cheap", "safe", "buy signal", "support").
 *
 * The only allowed uses are order-side controls (a Buy or Sell button, the side toggle of a ticket), which name the
 * side of an order. A test gives each file its own allowlist of exactly those strings; nothing else is exempt.
 *
 * Pure: no DOM and no file access, so tests (and, if ever needed, pages) can import it.
 *
 *   import { checkSource } from "./copyRules.mjs";
 *   expect(checkSource(readFileSync("calendar.js", "utf8"), { allow: [/^(Buy|Sell)$/] })).toEqual([]);
 */

/** The banned words (base forms). Matching is whole-word and case-insensitive, with the inflections in BANNED_RE. */
export const BANNED_WORDS = Object.freeze(["recommend", "best", "buy", "sell", "rich", "cheap", "safe", "avoid", "opportunity", "signal", "bullish", "bearish", "support", "resistance"]);

/**
 * Whole words, with common inflections ("recommended", "buying", "sellers", "cheaper", "safest", "opportunities",
 * "signals", "supported"). Not "safety" (the Safety page), not "bestow"-style longer words.
 */
export const BANNED_RE =
  /\b(recommend(?:s|ed|ing|ation|ations)?|best|buy(?:s|ing|er|ers)?|sell(?:s|ing|er|ers)?|rich(?:er|est)?|cheap(?:er|est|ly)?|safe(?:r|st|ly)?|avoid(?:s|ed|ing)?|opportunit(?:y|ies)|signal(?:s|led|ling|ed|ing)?|bullish|bearish|support(?:s|ed|ing)?|resistance)\b/gi;

/**
 * Banned words in a piece of text.
 * @param {string} text
 * @returns {Array<{ word: string, index: number }>}
 */
export function findBanned(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  for (const m of text.matchAll(BANNED_RE)) out.push({ word: m[0], index: m.index ?? 0 });
  return out;
}

const REGEX_PREV = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;

/**
 * Split JavaScript source into code (comments removed, string contents kept in place) and the list of string
 * literal texts (quoted strings and the literal parts of template strings). A small tokenizer, good for the
 * dashboard's own files; it is not a full parser.
 * @param {string} src
 * @returns {{ code: string, strings: string[] }}
 */
export function scanJs(src) {
  const strings = [];
  let code = "";
  let i = 0;
  const n = src.length;
  /** Last non-space character emitted to `code`, for the regex-vs-divide guess. */
  const prevSignificant = () => {
    const t = code.trimEnd();
    return { ch: t.at(-1) ?? "", text: t };
  };
  /** Template strings nest through ${ ... }; each entry counts open braces inside one substitution. */
  const templateDepth = [];
  const readTemplate = () => {
    // i is just after a backtick or a closing "}" of a substitution.
    let buf = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        buf += src.slice(i, i + 2);
        code += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        code += c;
        i += 1;
        strings.push(buf);
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        code += "${";
        i += 2;
        strings.push(buf);
        templateDepth.push(0);
        return;
      } else {
        buf += c;
        code += c;
        i += 1;
      }
    }
    strings.push(buf);
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i += 1;
    } else if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      code += " ";
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          buf += src.slice(j, j + 2);
          j += 2;
        } else {
          buf += src[j];
          j += 1;
        }
      }
      strings.push(buf);
      code += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "`") {
      code += c;
      i += 1;
      readTemplate();
    } else if (templateDepth.length && c === "{") {
      templateDepth[templateDepth.length - 1] += 1;
      code += c;
      i += 1;
    } else if (templateDepth.length && c === "}") {
      if (templateDepth[templateDepth.length - 1] === 0) {
        templateDepth.pop();
        code += c;
        i += 1;
        readTemplate();
      } else {
        templateDepth[templateDepth.length - 1] -= 1;
        code += c;
        i += 1;
      }
    } else if (c === "/") {
      const { ch, text } = prevSignificant();
      if (ch === "" || REGEX_PREV.has(ch) || REGEX_KEYWORDS.test(text)) {
        // Regex literal: copy through to the closing slash (respecting classes and escapes); not a string.
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") j += 2;
          else if (src[j] === "[") (inClass = true), (j += 1);
          else if (src[j] === "]") (inClass = false), (j += 1);
          else if (src[j] === "/" && !inClass) break;
          else j += 1;
        }
        code += src.slice(i, j + 1);
        i = j + 1;
      } else {
        code += c;
        i += 1;
      }
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, strings };
}

/**
 * Check strings against the banned list.
 * @param {Iterable<string>} strings
 * @param {{ allow?: Array<string | RegExp> }} [opts]  a string equal to an allowed string, or matching an allowed
 *   RegExp, is exempt (order-side controls only)
 * @returns {Array<{ text: string, word: string }>}
 */
export function checkCopy(strings, { allow = [] } = {}) {
  const out = [];
  // A /g or /y RegExp keeps lastIndex between test() calls; use a stateless copy so every string is checked alike.
  const rules = allow.map((a) => (typeof a === "string" ? a : new RegExp(a.source, a.flags.replace(/[gy]/g, ""))));
  for (const s of strings) {
    if (typeof s !== "string" || !s) continue;
    if (rules.some((a) => (typeof a === "string" ? a === s : a.test(s)))) continue;
    for (const { word } of findBanned(s)) out.push({ text: s, word });
  }
  return out;
}

/**
 * Check every string literal of a JavaScript source file (comments and identifiers are not copy).
 * @param {string} src
 * @param {{ allow?: Array<string | RegExp> }} [opts]
 */
export function checkSource(src, opts) {
  return checkCopy(scanJs(src).strings, opts);
}

/**
 * Check several files, each with its own allowlist.
 * @param {Array<{ name: string, src: string, allow?: Array<string | RegExp> }>} files
 * @returns {Array<{ file: string, text: string, word: string }>}
 */
export function checkFiles(files) {
  return files.flatMap((f) => checkSource(f.src, { allow: f.allow ?? [] }).map((v) => ({ file: f.name, ...v })));
}
