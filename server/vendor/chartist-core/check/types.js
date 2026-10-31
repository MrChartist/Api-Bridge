// Types of values as the checker sees them (S03). Draft until the IR is frozen in S04.
// See docs/SPEC.md section 3 and section 10 (in this package).
export const FRAMES = ['1m', '5m', '15m', '30m', '1h', 'D', 'W', 'M'];
/** Finer sizes have a lower rank. */
export function frameRank(f) {
    return FRAMES.indexOf(f);
}
export function finestFrame(a, b) {
    return frameRank(a) <= frameRank(b) ? a : b;
}
/**
 * How many daily candlesticks one candlestick of this size stands for, used only to estimate how
 * much history a value needs. Intraday sizes count as 1 so the estimate is never too small.
 * Needs verification: weekly 5 and monthly 22 are approximations.
 */
export function frameWeight(f) {
    return f === 'W' ? 5 : f === 'M' ? 22 : 1;
}
export const NONE = { k: 'none' };
export const ANY = { k: 'scalar', base: 'any', series: false, frame: 'D', snap: false, lb: 0 };
export function constant(base, value, bounds) {
    const s = { k: 'scalar', base, series: false, frame: 'D', snap: false, lb: 0 };
    if (value !== undefined)
        s.value = value;
    if (typeof value === 'number') {
        s.lo = value;
        s.hi = value;
    }
    if (bounds) {
        if (bounds.lo !== undefined)
            s.lo = bounds.lo;
        if (bounds.hi !== undefined)
            s.hi = bounds.hi;
    }
    return s;
}
export function seriesOf(base, frame = 'D', lb = 0, snap = false) {
    return { k: 'scalar', base, series: true, frame, snap, lb };
}
export const isNumeric = (b) => b === 'int' || b === 'float' || b === 'any' || b === 'na';
export const isBoolish = (b) => b === 'bool' || b === 'any' || b === 'na';
/** Whole-number constant whose value is known. */
export function knownInt(t) {
    return t.k === 'scalar' && !t.series && t.base === 'int' && typeof t.value === 'number' ? t.value : undefined;
}
/** Plain-words name of a type, for messages. */
export function words(t) {
    switch (t.k) {
        case 'scalar': {
            const b = t.base === 'int' ? 'a whole number' :
                t.base === 'float' ? 'a number' :
                    t.base === 'bool' ? 'a true/false value' :
                        t.base === 'str' ? 'text' :
                            t.base === 'color' ? 'a colour' :
                                t.base === 'na' ? 'na' : 'a value';
            return t.series ? `${b} for every candlestick` : b;
        }
        case 'record': return `a group of values (${t.label})`;
        case 'tuple': return `a pair or group of ${t.items.length} values`;
        case 'list': return 'a list';
        case 'none': return 'nothing';
    }
}
/** Short exact description used by the typing tests: `float series`, `bool const`, `int series@W snapshot`. */
export function describe(t) {
    switch (t.k) {
        case 'scalar': {
            let s = `${t.base} ${t.series ? 'series' : t.setting ? 'setting' : 'const'}`;
            if (t.series && t.frame !== 'D')
                s += `@${t.frame}`;
            if (t.snap)
                s += ' snapshot';
            return s;
        }
        case 'record': return `group(${Object.keys(t.fields).join(',')})`;
        case 'tuple': return `tuple(${t.items.map(describe).join(', ')})`;
        case 'list': return `list[${t.n}] of ${describe(t.item)}`;
        case 'none': return 'none';
    }
}
/** Combine bases for arithmetic/branches: int with int stays int, any number mix is float. */
export function joinNumeric(a, b) {
    if (a === 'any' || b === 'any')
        return 'any';
    if (a === 'na')
        return b;
    if (b === 'na')
        return a;
    return a === 'int' && b === 'int' ? 'int' : 'float';
}
/** Can two bases be put in the same place (branches of if, ternary, return paths)? Returns the joined base. */
export function joinBase(a, b) {
    if (a === 'any' || b === 'any')
        return a === 'any' ? b : a;
    if (a === 'na')
        return b;
    if (b === 'na')
        return a;
    if (a === b)
        return a;
    if ((a === 'int' || a === 'float') && (b === 'int' || b === 'float'))
        return 'float';
    return null;
}
/** Join two scalars that are alternatives (the two sides of an if). Series if either side is. */
export function joinScalar(a, b, forceSeries) {
    const base = joinBase(a.base, b.base);
    if (base === null)
        return null;
    const series = forceSeries || a.series || b.series;
    const out = {
        k: 'scalar',
        base,
        series,
        frame: a.series && b.series ? finestFrame(a.frame, b.frame) : a.series ? a.frame : b.series ? b.frame : 'D',
        snap: a.snap || b.snap,
        lb: Math.max(a.lb, b.lb),
    };
    if (!series) {
        if (a.lo !== undefined && b.lo !== undefined)
            out.lo = Math.min(a.lo, b.lo);
        if (a.hi !== undefined && b.hi !== undefined)
            out.hi = Math.max(a.hi, b.hi);
        if (a.value !== undefined && a.value === b.value)
            out.value = a.value;
        if (a.setting || b.setting)
            out.setting = true;
    }
    return out;
}
/** Join two types that are alternatives. Returns null when they cannot share a place. */
export function joinTy(a, b, forceSeries) {
    if (a.k === 'scalar' && b.k === 'scalar')
        return joinScalar(a, b, forceSeries);
    if (a.k === 'tuple' && b.k === 'tuple' && a.items.length === b.items.length) {
        const items = [];
        for (let i = 0; i < a.items.length; i++) {
            const j = joinTy(a.items[i], b.items[i], forceSeries);
            if (!j)
                return null;
            items.push(j);
        }
        return { k: 'tuple', items };
    }
    if (a.k === 'record' && b.k === 'record' && a.label === b.label)
        return a;
    return null;
}
