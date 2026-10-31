// run(): the entry point hosts call. Takes a compiled script and one instrument's daily candlesticks, checks the
// settings, builds the calendar, works the program out under a budget and hands back one array per output.
//
// Pure: the same compiled script, data and options give the same numbers (byte for byte; a missing value is always
// the same NaN and -0 is written as 0). It reads no file, no clock, no network.
import { settingRange } from '../check/settings.js';
import { Budget, DEFAULT_MAX_ELEMENTS } from './budget.js';
import { aggregateBars, buildCalendar, dailyBars, rulesFromHolidays } from './data.js';
import { BadInput, MissingData, NotYetSupported } from './errors.js';
import { CORE_FUNCTIONS } from './functions.js';
import { execute } from './vectorExec.js';
/** Check one setting value against its declaration. */
function checkInput(i, v) {
    const bad = (why) => {
        throw new BadInput(`Setting ${i.name} ${why}.`);
    };
    switch (i.type) {
        case 'int':
            if (typeof v !== 'number' || !Number.isInteger(v))
                return bad('must be a whole number');
            break;
        case 'float':
            if (typeof v !== 'number' || !Number.isFinite(v))
                return bad('must be a number');
            break;
        case 'bool':
            if (typeof v !== 'boolean')
                return bad('must be True or False');
            return v ? 1 : 0;
        case 'str':
            if (typeof v !== 'string')
                return bad('must be text');
            if (i.options && !i.options.includes(v))
                return bad(`must be one of ${i.options.join(', ')}`);
            return v;
    }
    const x = v;
    // The same range the checker assumed when it proved the history a script needs: explicit min/max, else for a whole number
    // from 1 (or the default, if lower) to the larger of 500 and five times the default, never above 2,500.
    const { lo, hi } = settingRange(i.type, i.default, i.min, i.max);
    if (lo !== undefined && x < lo)
        bad(`must be at least ${lo}`);
    if (hi !== undefined && x > hi)
        bad(`must be at most ${hi}`);
    return x;
}
/** Resolve every setting: the default, or the checked override. Unknown names are refused. */
export function resolveInputs(program, given = {}) {
    const out = new Map();
    const known = new Map(program.inputs.map((i) => [i.name, i]));
    for (const name of Object.keys(given))
        if (!known.has(name))
            throw new BadInput(`There is no setting called ${name}.`);
    for (const i of program.inputs) {
        const v = Object.hasOwn(given, i.name) ? given[i.name] : i.default;
        out.set(i.name, checkInput(i, v));
    }
    return out;
}
/** NaN is always the same NaN and -0 is 0, so equal results are equal bytes. */
function canonical(a) {
    for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v !== v)
            a[i] = Number.NaN;
        else if (v === 0)
            a[i] = 0;
    }
}
export function run(script, daily, options = {}) {
    const { program, plan } = script;
    if (plan.crossPasses > 0 && !options.cross)
        throw new NotYetSupported('a function across all stocks (xs / breadth): use runPanel');
    const inputs = resolveInputs(program, options.inputs);
    const lines = script.lines;
    const lineOf = (node) => {
        const l = lines?.[node];
        return l !== undefined && l > 0 ? l : null;
    };
    const d = dailyBars(daily);
    const cal = options.calendar ?? buildCalendar(daily.date, options.holidays ? rulesFromHolidays(Array.from(options.holidays)) : {});
    if (cal.n !== d.n)
        throw new RangeError(`runtime: the calendar has ${cal.n} sessions for ${d.n} candlesticks`);
    const cache = new Map([['D', d]]);
    const bars = (frame) => {
        const hit = cache.get(frame);
        if (hit)
            return hit;
        if (frame !== 'W' && frame !== 'M')
            throw new NotYetSupported(`candlestick size ${frame}`);
        const b = aggregateBars(d, cal, frame);
        cache.set(frame, b);
        return b;
    };
    // `ref(...)` also lists the capability 'bench' (the host must offer other instruments), but only `bench.*` needs the benchmark index.
    const needsBench = program.nodes.some((n) => n.op === 'bench');
    if (needsBench && !options.bench)
        throw new MissingData('the benchmark');
    const budget = new Budget(options.maxElements ?? DEFAULT_MAX_ELEMENTS, lineOf);
    const { outputs, stats } = execute(program, {
        cal,
        bars,
        bench: options.bench ? dailyBars(options.bench) : undefined,
        refs: options.refs ? new Map(Object.entries(options.refs).map(([k, v]) => [k, dailyBars(v)])) : undefined,
        values: options.values ? new Map(Object.entries(options.values)) : undefined,
        snapshots: options.snapshots,
        deriv: options.deriv,
    }, { budget, functions: options.functions ? { ...CORE_FUNCTIONS, ...options.functions } : CORE_FUNCTIONS, inputs, lineOf });
    for (const o of outputs)
        canonical(o.values);
    return { outputs, usage: { elements: budget.used, nodes: stats.nodes, peakLiveSeries: stats.peakLiveSeries } };
}
