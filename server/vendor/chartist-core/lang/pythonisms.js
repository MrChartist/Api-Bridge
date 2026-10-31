/**
 * Friendly messages for Python habits the language does not allow.
 * Each entry names the habit and the replacement. Plain words, no jargon.
 * The lexer uses the keyword, operator, string and character tables; the parser and checker
 * (later steps) use PARSER_HABITS and NAME_HABITS.
 */
/** Words that are valid in ChartistScript. Everything else in KEYWORD_HABITS is refused. */
export const ALLOWED_KEYWORDS = new Set([
    'def', 'if', 'elif', 'else', 'return', 'and', 'or', 'not', 'in', 'for', 'True', 'False', 'pass', 'lambda',
]);
const h = (code, message, hint) => ({ code, message, hint });
const IMPORT = h('E-PY-IMPORT', '`import` is not available.', 'Everything you need is already there: ta, price, candle, levels and more. Just use them by name, for example ta.sma(close, 20).');
const TRY = h('E-PY-TRY', '`try` and error handling are not available.', 'Missing data is handled for you: it becomes na and is shown as "no data". Use nz(x, 0) to replace a missing value.');
const WITH = h('E-PY-WITH', '`with` is not available.', 'Scripts cannot open files or connections, so there is nothing to wrap.');
const GLOBAL = h('E-PY-GLOBAL', '`global` is not available.', 'Each script works only with its own named values. Give a value a name with name = value.');
const ASYNC = h('E-PY-ASYNC', '`async`, `await` and `yield` are not available.', 'Scripts run in one pass over the candlesticks. Write plain functions with def.');
const BREAK = h('E-PY-BREAK', '`break` and `continue` are not available, because loops are not available.', 'To find the first or last event use ta.bars_since(...), ta.value_when(...) or ta.count(...).');
export const KEYWORD_HABITS = {
    while: h('E-PY-WHILE', '`while` is not available.', 'Loops over candlesticks are done for you. To count or find events use ta.bars_since(...), ta.count(...) or ta.value_when(...).'),
    import: IMPORT,
    from: IMPORT,
    class: h('E-PY-CLASS', '`class` is not available.', 'Use plain functions with def.'),
    try: TRY,
    except: TRY,
    finally: TRY,
    raise: TRY,
    with: WITH,
    as: WITH,
    global: GLOBAL,
    nonlocal: GLOBAL,
    async: ASYNC,
    await: ASYNC,
    yield: ASYNC,
    del: h('E-PY-DEL', '`del` is not available.', 'Give the value a new name instead of deleting the old one.'),
    assert: h('E-PY-ASSERT', '`assert` is not available.', 'To require something, put it in your final condition with and.'),
    is: h('E-PY-IS', '`is` is not available.', 'Use == to compare values.'),
    break: BREAK,
    continue: BREAK,
    None: h('E-PY-NONE', '`None` is not used.', 'A missing value is written na.'),
};
const BITWISE_HINT = 'Use and, or and not to combine conditions.';
/** Operators and punctuation that are refused, keyed by the exact text. */
export const OPERATOR_HABITS = {
    '&': h('E-PY-BITWISE', '`&` is a bitwise operator and is not available.', 'Use `and` to combine two conditions.'),
    '|': h('E-PY-BITWISE', '`|` is a bitwise operator and is not available.', 'Use `or` to combine two conditions.'),
    '^': h('E-PY-BITWISE', '`^` is a bitwise operator and is not available.', 'Use ** for a power, for example x ** 2.'),
    '~': h('E-PY-BITWISE', '`~` is a bitwise operator and is not available.', 'Use `not` to reverse a condition.'),
    '<<': h('E-PY-BITWISE', '`<<` is a bitwise operator and is not available.', BITWISE_HINT),
    '>>': h('E-PY-BITWISE', '`>>` is a bitwise operator and is not available.', BITWISE_HINT),
    '&&': h('E-PY-BITWISE', '`&&` is not used in this language.', 'Write `and` instead of &&.'),
    '||': h('E-PY-BITWISE', '`||` is not used in this language.', 'Write `or` instead of ||.'),
    '!': h('E-PY-NOT', '`!` is not used in this language.', 'Write `not` instead of !, for example not (close > open). To compare, use !=.'),
    ';': h('E-PY-SEMICOLON', '`;` is not available.', 'Put each statement on its own line.'),
    '{': h('E-PY-BRACES', 'Braces `{ }` are not available. Dictionaries and sets are not supported.', 'To start a block, end the line with a colon and indent the next lines by 4 spaces.'),
    '}': h('E-PY-BRACES', 'Braces `{ }` are not available. Dictionaries and sets are not supported.', 'To start a block, end the line with a colon and indent the next lines by 4 spaces.'),
    '?': h('E-PY-TERNARY', '`?` is not available.', 'Write a if condition else b.'),
    ':=': h('E-PY-WALRUS', '`:=` is not available.', 'Use = on its own line, then use the name on the next line.'),
    '\\': h('E-PY-BACKSLASH', 'A backslash cannot continue a line.', 'Put the expression inside brackets ( ) to continue it on the next line.'),
    $: h('E-LEX-CHAR', 'The character `$` is not used in this language.', 'Names use letters, digits and _ only.'),
    '`': h('E-LEX-CHAR', 'The backtick is not used in this language.', 'Use straight quotes " or \' for text.'),
};
/** Used by the parser and checker in later steps. */
export const PARSER_HABITS = {
    forLoop: h('E-PY-FOR', '`for` loops are not available.', 'Use a list in brackets with a fixed range, for example all([low[i] > low[i + 3] for i in range(3)]).'),
    negativeIndex: h('E-PY-NEGATIVE-INDEX', 'A negative index would look into the future.', 'Use x[0] for the current candlestick and x[1] for the previous one.'),
    slice: h('E-PY-SLICE', 'Slices such as x[1:3] are not available.', 'Use ta.highest(x, n), ta.lowest(x, n) or ta.sma(x, n) for a window of candlesticks.'),
    augAssign: h('E-PY-AUGASSIGN', 'Updating a value in place (+=, -=, *=, /=) is not available.', 'Give the result a new name, for example total2 = total + x.'),
    matmul: h('E-PY-MATMUL', '`@` is only used for the line that names the script type, such as @screener.', 'Use * to multiply.'),
    returnAnnotation: h('E-PY-ANNOTATION', 'Return type notes with -> are not used.', 'Remove the -> part.'),
};
/** Names people bring from other languages. Used by the checker. */
export const NAME_HABITS = {
    true: h('E-PY-BOOL-CASE', '`true` is not defined.', 'Write True with a capital T.'),
    false: h('E-PY-BOOL-CASE', '`false` is not defined.', 'Write False with a capital F.'),
    null: h('E-PY-NONE', '`null` is not defined.', 'A missing value is written na.'),
    nan: h('E-PY-NONE', '`nan` is not defined.', 'A missing value is written na.'),
    NaN: h('E-PY-NONE', '`NaN` is not defined.', 'A missing value is written na.'),
    undefined: h('E-PY-NONE', '`undefined` is not defined.', 'A missing value is written na.'),
};
/**
 * Habits from Pine Script, and AND / OR / NOT from spreadsheet and AmiBroker formulas (2026-10-25). Each one
 * names the habit and what to write here. The lexer uses `comment` and `version`, the parser `var`, `logic` and `tuple`, the
 * checker the rest.
 */
export const PINE_HABITS = {
    comment: h('E-PINE-COMMENT', '`//` starts a comment in Pine Script; here a comment starts with #.', 'Write # in place of //.'),
    version: h('E-PINE-COMMENT', '`//@version=...` is a Pine Script line and is not needed here.', 'Delete the line, or write # in place of // to keep it as a comment. There is one version of this language.'),
    var: h('E-PINE-VAR', '`var` is not used here: a name is set with name = value.', 'Remove var. Every value is worked out for every candlestick; for a value that carries forward from an event use ta.value_when, ta.latch or ta.bars_since.'),
    tuple: h('E-PINE-TUPLE', 'Names in square brackets cannot be set at once: [a, b] = ... is Pine Script.', 'Write the names without the brackets: a, b = ....'),
    na: h('E-PINE-NA', '`na(x)` is Pine Script for "x is missing"; here na is only the missing value itself.', 'Write is_na(x).'),
    plotshape: (word) => h('E-PINE-PLOTSHAPE', `\`${word}\` is Pine Script; here a marker is drawn with mark(condition).`, 'Write mark(condition, shape="triangle_up", where="below"). The shapes are dot, triangle_up, triangle_down, square and diamond.'),
    hline: h('E-PINE-HLINE', '`hline` is Pine Script; here a level line is a plot of a fixed number.', 'Write plot(70, "Overbought"): a number written in the script draws a flat line.'),
    declare: (word) => h('E-PINE-DECLARE', `\`${word}(...)\` is how Pine Script names a script; here the script type is a line above a def.`, word === 'strategy'
        ? 'Write @strategy() on a line of its own, then def rules(): with strategy.entry(...) and strategy.exit(...) inside.'
        : 'Delete the line: a script that plots is an indicator already. To give it a name, write @indicator(name="...") above def chart(): and put the plot lines inside.'),
    input: (field) => h('E-PINE-INPUT', `\`input.${field}\` is Pine Script; here every setting is written input(default).`, 'Write input(20), or input(20, min=1, max=200, title="Length"). In a short script: n = input(20). In a script with def: def scan(n: int = input(20)):.'),
    logic: (word) => h('E-LOGIC-CASE', `\`${word}\` is written in small letters here: ${word.toLowerCase()}.`, `Write ${word.toLowerCase()}, as in close > open and volume > 0.`),
};
/** AND, OR and NOT written in capitals (or with a capital first letter). */
export const LOGIC_WORDS = new Set(['AND', 'OR', 'NOT', 'And', 'Or', 'Not']);
export function habitForKeyword(word) {
    return Object.prototype.hasOwnProperty.call(KEYWORD_HABITS, word) ? KEYWORD_HABITS[word] : undefined;
}
export function habitForOperator(text) {
    return Object.prototype.hasOwnProperty.call(OPERATOR_HABITS, text) ? OPERATOR_HABITS[text] : undefined;
}
/** `f"..."`, `r"..."`, `b"..."`, `u"..."` and two-letter combinations. */
export function habitForStringPrefix(prefix) {
    if (/f/i.test(prefix)) {
        return h('E-PY-FSTRING', 'f-strings are not available.', 'Write the label as plain text in quotes, and show values in a column with show(value, "label").');
    }
    return h('E-PY-STRING-PREFIX', `Text prefixes such as ${prefix} are not available.`, 'Write the text in plain quotes, for example "label".');
}
export const TRIPLE_QUOTE = h('E-PY-TRIPLE-QUOTE', 'Text in triple quotes is not available.', 'Use one line of text in single or double quotes.');
/** Describe one code point safely for a message. */
export function describeChar(cp) {
    const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    const printable = cp > 32 && cp !== 127 && !(cp >= 0x2000 && cp <= 0x200f) && cp !== 0x2028 && cp !== 0x2029 && cp !== 0x3000 && cp !== 0xfeff && cp !== 0xa0;
    return printable ? `"${String.fromCodePoint(cp)}" (${hex})` : hex;
}
const SMART = {
    0x201c: { says: 'curly double quote', hint: 'Replace it with a straight quote ". Word processors and chat apps often change quotes when you paste.' },
    0x201d: { says: 'curly double quote', hint: 'Replace it with a straight quote ". Word processors and chat apps often change quotes when you paste.' },
    0x2018: { says: 'curly single quote', hint: "Replace it with a straight quote '. Word processors and chat apps often change quotes when you paste." },
    0x2019: { says: 'curly single quote', hint: "Replace it with a straight quote '. Word processors and chat apps often change quotes when you paste." },
    0x2013: { says: 'en dash', hint: 'Replace it with a minus sign -.' },
    0x2014: { says: 'em dash', hint: 'Replace it with a minus sign -.' },
    0x2212: { says: 'minus sign', hint: 'Replace it with the normal minus sign - on the keyboard.' },
    0x00d7: { says: 'multiplication sign', hint: 'Use * to multiply.' },
    0x00f7: { says: 'division sign', hint: 'Use / to divide.' },
    0x2265: { says: 'greater-or-equal sign', hint: 'Write >= instead.' },
    0x2264: { says: 'less-or-equal sign', hint: 'Write <= instead.' },
    0x2260: { says: 'not-equal sign', hint: 'Write != instead.' },
    0x20b9: { says: 'rupee sign', hint: 'Currency symbols can only appear inside quotes, for example "Price in ₹".' },
};
function isSpaceLike(cp) {
    return cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}
function isInvisible(cp) {
    return (cp >= 0x200b && cp <= 0x200f) || cp === 0x2028 || cp === 0x2029 || cp === 0x2060 || cp === 0xfeff;
}
/** The error to raise for a non-ASCII character that appears outside text and comments. */
export function habitForCharacter(cp) {
    if (isSpaceLike(cp)) {
        return h('E-LEX-CHAR', `A special space character (${describeChar(cp)}) was found.`, 'Replace it with a normal space. This often happens when code is copied from a web page or a chat.');
    }
    if (isInvisible(cp)) {
        return h('E-LEX-CHAR', `An invisible character (${describeChar(cp)}) was found.`, 'Delete it and type the line again. This often happens when code is copied from a web page or a chat.');
    }
    const smart = SMART[cp];
    if (smart) {
        return h('E-LEX-CHAR', `A ${smart.says} (${describeChar(cp)}) was found where a plain keyboard character is needed.`, smart.hint);
    }
    return h('E-LEX-CHAR', `The character ${describeChar(cp)} is not allowed here.`, 'Names use only the letters A to Z, digits and _. Text with other characters must be inside quotes.');
}
