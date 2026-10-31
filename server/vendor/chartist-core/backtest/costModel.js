import { computeCharges } from './costTable.js';
/** Charges of a fill in paise from a cost table. Equity delivery by default; F&O rows in the table stay unused until S34. */
export function costModelFromTable(table, segment = 'EQ_DELIVERY') {
    return (f) => computeCharges(table, { segment, side: f.side, date: f.date, turnoverPaise: f.valuePaise }).total;
}
