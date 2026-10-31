// Static limits (starting values; tuned in the checker step). Kept in one place so every
// layer reads the same numbers. See docs/SPEC.md section 7 (in this package).
/** Longest accepted script, in UTF-16 code units. */
export const SOURCE_MAX_CHARS = 12_000;
/** Most lines in one script. */
export const SOURCE_MAX_LINES = 300;
/** Deepest block nesting by indentation. */
export const INDENT_MAX_DEPTH = 24;
/** Deepest nesting of ( ) and [ ]. */
export const BRACKET_MAX_DEPTH = 24;
/** Longest name. */
export const NAME_MAX_CHARS = 64;
/**
 * Characters as the length limits count them: Unicode code points, so an emoji or another character outside the basic
 * plane counts as one (a string's .length counts it as two UTF-16 units). Used by the text, label and options limits.
 */
export const charCount = (s) => [...s].length;
/** The first `n` characters of a text, never splitting a character in two. */
export const firstChars = (s, n) => [...s].slice(0, n).join('');
/** Longest text in quotes, after escapes are decoded (counted with charCount). */
export const STRING_MAX_CHARS = 200;
/** Longest number, as written. */
export const NUMBER_MAX_CHARS = 32;
/** Most nodes in one script's syntax tree. */
export const AST_MAX_NODES = 4_000;
/** Deepest nesting of the syntax tree. Long chains such as a + b + c + ... count as depth. */
export const AST_MAX_DEPTH = 64;
/** Deepest recursion the parser itself allows (guards the stack against inputs like many `not not not`). */
export const PARSE_MAX_RECURSION = 200;
// ---- Checker limits (S03). SPEC section 7 and section 10. ----
/** Most settings (`input(...)` parameters) in one script. */
export const MAX_INPUTS = 16;
/** Most choices in one `input("a", options=[...])` list (a dropdown longer than this is hard to read). */
export const MAX_INPUT_OPTIONS = 12;
/** Most characters in one choice of `options=[...]` (it is shown as a dropdown item). */
export const INPUT_OPTION_MAX_CHARS = 24;
/** Most `show()` columns in one script. */
export const MAX_SHOWS = 8;
/** Most candlesticks of history one value may need, in daily candlesticks. */
export const MAX_LOOKBACK = 5_000;
/** Most steps of one list comprehension (`range(n)`). */
export const MAX_UNROLL_PER_LOOP = 64;
/** Most steps of all list comprehensions together, after helpers are expanded. */
export const MAX_UNROLL_TOTAL = 512;
/** Deepest chain of helpers calling helpers. */
export const MAX_INLINE_DEPTH = 16;
/** Most syntax-tree nodes after every helper call is expanded in place. */
export const MAX_EXPANDED_NODES = 2_000;
/** Most values (series) alive at once. Enforced at compile time only, from the plan's estimate (E-LIVE-SERIES in ir/plan.ts); the
 * runtime reports the peak it measured (`usage.peakLiveSeries`) but does not stop a run on it. */
export const MAX_LIVE_SERIES = 64;
/** Most diagnostics reported for one script; the rest are counted. */
export const MAX_DIAGNOSTICS = 50;
/** Longest label for show(), plot() and alert(). */
export const LABEL_MAX_CHARS = 60;
