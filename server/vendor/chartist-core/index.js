// Public entry of @chartist/core. Everything the app may import is exported here;
// deep imports into this package are not allowed (see docs/adr/0007-split-ready-boundary.md).
export { CORE_VERSION, IR_VERSION, API_VERSION, STDLIB_VERSION, IR_IS_FROZEN, STDLIB_IS_FROZEN } from './versions.js';
export { lex, tokenize, tryTokenize } from './lang/lexer.js';
export { MAX_SYNTAX_ERRORS, parse, tryParse, tryParseAll } from './lang/parser.js';
export { format, formatExpr, formatSource } from './lang/format.js';
export { ALLOWED_KEYWORDS } from './lang/pythonisms.js';
export { ENTRY_KINDS, childrenOf, measureTree, stripSpans } from './lang/ast.js';
export { ScriptError, formatError, formatDiagnostic, diagnosticToError, errorToDiagnostic } from './lang/errors.js';
export { check, checkSource } from './check/checker.js';
export { defaultIntRange, settingRange } from './check/settings.js';
export { EXPLAIN_LEFT, EXPLAIN_RIGHT, MAX_AUTO_COLUMNS, MAX_EXPLAIN_CLAUSES, SCREENER_MARK_TEXT, autoShowSource, explainClauses, explainSource, screenerChartSource } from './explain.js';
export { HOSTS, defaultHostFor } from './check/hosts.js';
export { describe as describeType } from './check/types.js';
export { ABS_PRICE_LEVEL_CODE, compile, compileSource, VERSIONS } from './compile.js';
export { NEVER_TRUE_CODE } from './ir/neverTrue.js';
export { PURE_HASH } from './hash/provider.js';
export { sha256Hex } from './hash/sha256.js';
export { hashProgram, nodeDigests } from './ir/hashing.js';
export { candlesticksNeeded, candlesticksNeededAtDefaults, makePlan } from './ir/plan.js';
export { validateIr } from './ir/validate.js';
export { serializeIr, deserializeIr, IrError } from './ir/serialize.js';
export { lower, LoweringError } from './ir/lower.js';
export { requiresOf } from './ir/analysis.js';
export { renderStdlibReference, argText, retText, signature as fnSignature } from './stdlib/reference.js';
export { validateSignalPanel, TRI_FALSE, TRI_TRUE, TRI_UNKNOWN } from './signal/signalPanel.js';
export { CAPABILITIES, FUNCTIONS, VALUES, NAMESPACES, PATTERN_IDS, PRICE_BLENDS, isPriceBlend, RETIRED_PATTERN_IDS, TF_CODES, BUILTIN_FUNCTIONS, GLOBAL_VALUES, RESERVED_NAMESPACES, fnSpec, valueSpec, membersOf, parseLegStrike } from './stdlib/manifest.js';
export { SEARCH_WORDS, searchWord } from './stdlib/searchWords.js';
export { MAX_INPUTS, MAX_SHOWS, MAX_LOOKBACK, MAX_UNROLL_PER_LOOP, MAX_UNROLL_TOTAL, MAX_INLINE_DEPTH, MAX_EXPANDED_NODES, MAX_LIVE_SERIES, MAX_DIAGNOSTICS, LABEL_MAX_CHARS, SOURCE_MAX_CHARS, SOURCE_MAX_LINES, INDENT_MAX_DEPTH, BRACKET_MAX_DEPTH, NAME_MAX_CHARS, STRING_MAX_CHARS, NUMBER_MAX_CHARS, AST_MAX_NODES, AST_MAX_DEPTH, PARSE_MAX_RECURSION, } from './limits.js';
// Derivatives maths and file parsers (S30). Data-free: no fetching, no storage.
export * from './derivatives/index.js';
// The vector runtime (S08): works a compiled script out over daily candlesticks, within a budget.
export { run, resolveInputs, Budget, DEFAULT_MAX_ELEMENTS, BadInput, BudgetExceeded, MissingData, NotYetSupported, RuntimeError, CORE_FUNCTIONS, aggregateBars, alignIndex, buildCalendar, dailyBars, rulesFromHolidays, runPanel, createPanelCache, averageRanks, percentRanks, descendingRanks, zscores, median } from './runtime/index.js';
// Scripts that draw on a chart (S21): what they draw and the numbers to draw.
export { describeIndicator, indicatorProblem, plainMarkText, runIndicator, colorOfCode, MAX_INDICATOR_PLOTS, MAX_INDICATOR_FILLS, MAX_MARK_TEXT_CHARS, COLOR_CODE } from './indicator.js';
// Scripts that raise alerts (S22): what they can say and when each condition is true.
export { alertProblem, alertValueNames, alertValueProblem, alertValueScript, cleanAlertMessage, describeAlert, runAlert, runAlertValues, unknownAlertFields, ALERT_MESSAGE_FIELDS, MAX_ALERT_CONDITIONS, MAX_ALERT_MESSAGE_CHARS, MAX_ALERT_VALUES } from './alert.js';
// The backtest core (S23): reproducibility id, labels, cost table, result envelope. The simulator follows (S24).
export * from './backtest/index.js';
// Script import (2026-10-25): detect the language of a pasted script (Pine Script, Chartink, AFL, Python) and convert it to
// ChartistScript deterministically, with line-mapped notes. docs/features/script-import/README.md
export { convert, detectLanguage, languageName, supportedLanguages, CONVERTERS } from './convert/index.js';
