// What can stop a run. All are plain errors with a code and, when the script's source map is given, the line of the
// script that caused them. A host turns them into a friendly message; none of them leaks data.
export class RuntimeError extends Error {
    code;
    node;
    line;
    constructor(code, message, 
    /** The node of the program being worked out. */
    node = null, 
    /** The line of the script that first wrote that node, when known. */
    line = null) {
        super(message);
        this.code = code;
        this.node = node;
        this.line = line;
        this.name = 'RuntimeError';
    }
}
/** The run touched more values than its budget allows. */
export class BudgetExceeded extends RuntimeError {
    used;
    limit;
    constructor(used, limit, node, line) {
        super('E-BUDGET', line !== null
            ? `This script is too expensive to run: it touched ${used} values (limit ${limit}). The line that pushed it over is line ${line}.`
            : `This script is too expensive to run: it touched ${used} values (limit ${limit}).`, node, line);
        this.used = used;
        this.limit = limit;
        this.name = 'BudgetExceeded';
    }
}
/** Something the language allows but this version of the runtime does not run yet (a forming candlestick, `ta.scan`, a cross-section). */
export class NotYetSupported extends RuntimeError {
    constructor(what, node = null, line = null) {
        super('E-RT-NOT-YET', `${what} is not available in this version.`, node, line);
        this.name = 'NotYetSupported';
    }
}
/** The data given does not fit what the script needs. */
export class MissingData extends RuntimeError {
    constructor(what, node = null, line = null) {
        super('E-RT-DATA', `${what} was not provided.`, node, line);
        this.name = 'MissingData';
    }
}
/** A setting value outside what the script allows. */
export class BadInput extends RuntimeError {
    constructor(message) {
        super('E-RT-INPUT', message);
        this.name = 'BadInput';
    }
}
