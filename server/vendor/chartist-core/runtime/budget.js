// The run budget, counted in "elements touched": every value a step reads or writes. It is checked BEFORE a step is
// worked out, so a step that would blow the budget never allocates its arrays. Same script, same data, same count:
// the count is part of the deterministic result.
import { BudgetExceeded } from './errors.js';
/**
 * A starting ceiling for one symbol. A typical script on 2,500 candlesticks touches 100,000 to 500,000 values; a
 * rolling average over 200 candlesticks touches 500,000 on its own. Needs verification against real scripts (S18).
 */
export const DEFAULT_MAX_ELEMENTS = 25_000_000;
export class Budget {
    limit;
    lineOf;
    spent = 0;
    constructor(limit = DEFAULT_MAX_ELEMENTS, lineOf = () => null) {
        this.limit = limit;
        this.lineOf = lineOf;
        if (!Number.isFinite(limit) || limit < 0)
            throw new RangeError('runtime: a budget is a number of elements, zero or more');
    }
    /** Count `count` elements for `node`. Throws before the work is done if the total would pass the limit. A count is
     * never negative: a negative one would refund the budget (a window of -1000 once gave back 59,520 elements). */
    touch(count, node = null) {
        if (!Number.isFinite(count) || count < 0)
            throw new RangeError(`runtime: a step cannot touch ${count} elements`);
        const next = this.spent + count;
        if (next > this.limit)
            throw new BudgetExceeded(next, this.limit, node, node === null ? null : this.lineOf(node));
        this.spent = next;
    }
    get used() {
        return this.spent;
    }
}
