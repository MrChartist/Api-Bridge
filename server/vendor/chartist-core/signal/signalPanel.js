export const TRI_FALSE = 0;
export const TRI_TRUE = 1;
export const TRI_UNKNOWN = 2;
/** Problems found in a panel; empty means it satisfies the contract. */
export function validateSignalPanel(p) {
    const out = [];
    const days = p.calendar.length;
    const syms = p.symbols.length;
    for (let i = 1; i < days; i++)
        if (p.calendar[i] <= p.calendar[i - 1])
            out.push(`calendar is not ascending at position ${i}`);
    for (let i = 1; i < syms; i++)
        if (p.symbols[i] <= p.symbols[i - 1])
            out.push(`symbols are not strictly ascending at position ${i}`);
    const shape = (name, rows, required) => {
        if (!rows) {
            if (required)
                out.push(`${name} is missing`);
            return;
        }
        if (rows.length !== syms)
            out.push(`${name} has ${rows.length} rows for ${syms} symbols`);
        rows.forEach((row, s) => {
            if (row.length !== days)
                out.push(`${name}[${s}] has ${row.length} values for ${days} dates`);
        });
    };
    shape('entry', p.entry, true);
    shape('exit', p.exit, true);
    shape('rank', p.rank, false);
    shape('stopDist', p.stopDist, false);
    shape('targetDist', p.targetDist, false);
    shape('trailDist', p.trailDist, false);
    shape('partialDist', p.partialDist, false);
    if ((p.partialDist === undefined) !== (p.partialSizePct === undefined))
        out.push('partialDist and partialSizePct come together');
    if (p.partialSizePct !== undefined && !(p.partialSizePct >= 1 && p.partialSizePct <= 99))
        out.push(`partialSizePct is ${p.partialSizePct}, not 1 to 99`);
    for (const [name, rows] of [['entry', p.entry], ['exit', p.exit]]) {
        rows.forEach((row, s) => {
            for (let d = 0; d < row.length; d++) {
                if (row[d] > 2) {
                    out.push(`${name}[${s}][${d}] is ${row[d]}, not 0, 1 or 2`);
                    return;
                }
            }
        });
    }
    if (!p.bars.adjustmentPolicy)
        out.push('bars.adjustmentPolicy is empty');
    if (!p.bars.dataVersion)
        out.push('bars.dataVersion is empty');
    return out;
}
