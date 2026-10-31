// The calculations behind `ind.<id>(...)` (S09). Each study calls the same kernel function, with the same arguments, as
// the chart does for the same study, so a script and the chart agree; `tests/chartist/ind-parity.test.ts` proves it
// against the app's own `computeIndicatorForCandles` for every study, on the same candlesticks.
//
// Candlesticks reach the kernel as objects stamped at 12:00 UTC of the session date: that is the same calendar day in
// India (17:30) and in the US (07:00 or 08:00), so the kernel's day logic gives one answer in both markets.
import { calcADLine, calcADR, calcADRPercent, calcADX, calcALMA, calcAO, calcATR, calcAnchoredVwap, calcAroon, calcAroonOsc, calcBB, calcBBW, calcBOP, calcCCI, calcCHOP, calcCMF, calcCMO, calcChaikinOsc, calcConnorsRSI, calcCoppock, calcDEMA, calcDPO, calcDonchian, calcEMA, calcEOM, calcEWO, calcElderRay, calcEnvelope, calcFisher, calcForceIndex, calcHMA, calcHistoricalVol, calcIchimoku, calcKAMA, calcKDJ, calcKST, calcKeltner, calcKlinger, calcLSMA, calcLinRegChannel, calcMACD, calcMFI, calcMassIndex, calcMcGinley, calcMomentum, calcNVI, calcNetVolume, calcOBV, calcPPOFull, calcPVI, calcPVT, calcPercentB, calcPivotHL, calcRMA, calcROC, calcRSI, calcRVI, calcRelativeVolume, calcSAR, calcSMA, calcSMI, calcStdDev, calcStochRSI, calcStochastic, calcSuperTrend, calcTEMA, calcTRIX, calcTSI, calcUlcerIndex, calcUltimateOsc, calcVROC, calcVWMA, calcVolumeWithMa, calcVortex, calcWMA, calcWilliamsR, calcZigZag, sessionAwareVwap, sessionAwareVwapBands, vwapSessionSupported, vwapWithAnchor, } from '../../kernel/index.js';
import { RuntimeError } from '../../runtime/errors.js';
import { STUDY_SPEC_BY_ID, STUDY_SPECS } from './specs.js';
const ymdToMs = (ymd) => Date.UTC(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100) - 1, ymd % 100, 12);
/** The candlesticks as the kernel reads them. A missing value stays NaN, which the kernel treats as missing. */
export function studyInputs(b) {
    const n = b.n;
    const open = Array.from(b.open);
    const high = Array.from(b.high);
    const low = Array.from(b.low);
    const close = Array.from(b.close);
    const volume = Array.from(b.volume);
    const candles = new Array(n);
    for (let i = 0; i < n; i++)
        candles[i] = { date: ymdToMs(b.date[i]), open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] };
    return { n, candles, open, high, low, close, volume };
}
/** The same inputs with another series in place of the close (`src=`); the candlestick objects carry it too. */
export function withClose(x, src) {
    const close = Array.from(src);
    return { ...x, close, candles: x.candles.map((c, i) => ({ ...c, close: close[i] })) };
}
const num = (p, k) => p[k];
const str = (p, k) => p[k];
/** ZigZag as one value per candlestick: each leg filled by a straight line between its two points. */
function zigzagValues(n, points) {
    const out = new Array(n).fill(null);
    const inRange = (i) => Number.isInteger(i) && i >= 0 && i < n;
    if (points.length === 1 && inRange(points[0].index))
        out[points[0].index] = points[0].price;
    for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k];
        const b = points[k + 1];
        const span = b.index - a.index;
        if (span <= 0 || !inRange(a.index) || !inRange(b.index))
            continue;
        for (let i = a.index; i <= b.index; i++)
            out[i] = a.price + ((b.price - a.price) * (i - a.index)) / span;
    }
    return out;
}
export const COMPUTE = {
    ema: (x, p) => calcEMA(x.close, num(p, 'length')),
    sma: (x, p) => calcSMA(x.close, num(p, 'length')),
    wma: (x, p) => calcWMA(x.close, num(p, 'length')),
    hma: (x, p) => calcHMA(x.close, num(p, 'length')),
    dema: (x, p) => calcDEMA(x.close, num(p, 'length')),
    tema: (x, p) => calcTEMA(x.close, num(p, 'length')),
    rma: (x, p) => calcRMA(x.close, num(p, 'length')),
    vwma: (x, p) => calcVWMA(x.close, x.volume, num(p, 'length')),
    lsma: (x, p) => calcLSMA(x.close, num(p, 'length'), num(p, 'offset')),
    alma: (x, p) => calcALMA(x.close, num(p, 'window'), num(p, 'offset'), num(p, 'sigma')),
    kama: (x, p) => calcKAMA(x.close, num(p, 'er'), num(p, 'fast'), num(p, 'slow')),
    mcginley: (x, p) => calcMcGinley(x.close, num(p, 'length'), num(p, 'k')),
    envelope: (x, p) => calcEnvelope(x.close, num(p, 'length'), num(p, 'pct'), str(p, 'ma_type'), x.volume),
    vwap: (x) => sessionAwareVwap(x.candles),
    vwapbands: (x) => sessionAwareVwapBands(x.candles),
    bb: (x, p) => calcBB(x.close, num(p, 'length'), num(p, 'k')),
    keltner: (x, p) => calcKeltner(x.high, x.low, x.close, num(p, 'length'), num(p, 'mult'), num(p, 'atr_length')),
    donchian: (x, p) => calcDonchian(x.high, x.low, num(p, 'length')),
    supertrend: (x, p) => calcSuperTrend(x.high, x.low, x.close, num(p, 'period'), num(p, 'mult')),
    sar: (x, p) => calcSAR(x.high, x.low, num(p, 'step'), num(p, 'max'), undefined, x.close),
    ichimoku: (x, p) => calcIchimoku(x.high, x.low, x.close, num(p, 'tenkan'), num(p, 'kijun'), num(p, 'senkou_b')),
    linregchannel: (x, p) => calcLinRegChannel(x.candles, { length: num(p, 'length'), deviations: num(p, 'deviations') }),
    sessionvwap: (x, p) => {
        let anchor = str(p, 'anchor');
        // A session anchor has no meaning on daily candlesticks (each is its own session), so it falls back to month.
        if (anchor === 'session' && !vwapSessionSupported(x.candles))
            anchor = 'month';
        return vwapWithAnchor(x.candles, { anchor: anchor, source: 'hlc3', bandMultipliers: [1, 2, 3] });
    },
    avwap: (x, p) => {
        let anchor = str(p, 'anchor');
        // Same rule: a session anchor on daily candlesticks falls back to the highest high of the look-back.
        if (anchor === 'session' && !vwapSessionSupported(x.candles))
            anchor = 'highestHigh';
        return calcAnchoredVwap(x.candles, {
            anchor: anchor, lookback: num(p, 'lookback'), periodsBack: num(p, 'periods_back'), source: 'hlc3', bandMultipliers: [1, 2, 3],
        }).points;
    },
    pivothl: (x, p) => calcPivotHL(x.candles, { left: num(p, 'left'), right: num(p, 'right') }),
    zigzag: (x, p) => zigzagValues(x.n, calcZigZag(x.candles, { deviation: num(p, 'deviation'), legs: num(p, 'legs') })).map((v) => ({ points: v })),
    rsi: (x, p) => calcRSI(x.close, num(p, 'length')),
    macd: (x, p) => calcMACD(x.close, num(p, 'fast'), num(p, 'slow'), num(p, 'signal')),
    stoch: (x, p) => calcStochastic(x.high, x.low, x.close, num(p, 'length'), num(p, 'smooth')),
    adx: (x, p) => calcADX(x.high, x.low, x.close, num(p, 'length')),
    atr: (x, p) => calcATR(x.high, x.low, x.close, num(p, 'length')),
    obv: (x) => calcOBV(x.close, x.volume),
    williamsr: (x, p) => calcWilliamsR(x.high, x.low, x.close, num(p, 'length')),
    cmf: (x, p) => calcCMF(x.high, x.low, x.close, x.volume, num(p, 'length')),
    dpo: (x, p) => calcDPO(x.close, num(p, 'length')),
    trix: (x, p) => calcTRIX(x.close, num(p, 'length')),
    tsi: (x, p) => calcTSI(x.close, num(p, 'long'), num(p, 'short'), num(p, 'signal')),
    ppo: (x, p) => calcPPOFull(x.close, num(p, 'fast'), num(p, 'slow'), num(p, 'signal')),
    cmo: (x, p) => calcCMO(x.close, num(p, 'length')),
    aroon: (x, p) => calcAroon(x.high, x.low, num(p, 'length')),
    bbw: (x, p) => calcBBW(x.close, num(p, 'length'), num(p, 'k')),
    chop: (x, p) => calcCHOP(x.high, x.low, x.close, num(p, 'length')),
    ewo: (x, p) => calcEWO(x.close, num(p, 'fast'), num(p, 'slow')),
    stochrsi: (x, p) => calcStochRSI(x.close, num(p, 'length'), num(p, 'length'), num(p, 'k_smooth'), num(p, 'd_smooth')),
    cci: (x, p) => calcCCI(x.high, x.low, x.close, num(p, 'length')),
    mfi: (x, p) => calcMFI(x.high, x.low, x.close, x.volume, num(p, 'length')),
    roc: (x, p) => calcROC(x.close, num(p, 'length')),
    kdj: (x, p) => calcKDJ(x.high, x.low, x.close, num(p, 'length'), num(p, 'k_smooth'), num(p, 'd_smooth')),
    adline: (x) => calcADLine(x.high, x.low, x.close, x.volume),
    ao: (x) => calcAO(x.high, x.low),
    vroc: (x, p) => calcVROC(x.volume, num(p, 'length')),
    uo: (x, p) => calcUltimateOsc(x.high, x.low, x.close, num(p, 'p1'), num(p, 'p2'), num(p, 'p3')),
    crsi: (x, p) => calcConnorsRSI(x.close, num(p, 'rsi_length'), num(p, 'streak_length'), num(p, 'rank_length')),
    fisher: (x, p) => calcFisher(x.high, x.low, num(p, 'length')),
    coppock: (x, p) => calcCoppock(x.close, num(p, 'roc_long'), num(p, 'roc_short'), num(p, 'wma')),
    vortex: (x, p) => calcVortex(x.high, x.low, x.close, num(p, 'length')),
    stddev: (x, p) => calcStdDev(x.close, num(p, 'length')),
    massindex: (x, p) => calcMassIndex(x.high, x.low, num(p, 'ema_length'), num(p, 'sum_length')),
    kst: (x) => calcKST(x.close),
    chaikinosc: (x, p) => calcChaikinOsc(x.high, x.low, x.close, x.volume, num(p, 'fast'), num(p, 'slow')),
    forceindex: (x, p) => calcForceIndex(x.close, x.volume, num(p, 'length')),
    eom: (x, p) => calcEOM(x.high, x.low, x.volume, num(p, 'length')),
    elderray: (x, p) => calcElderRay(x.high, x.low, x.close, num(p, 'length')),
    percentb: (x, p) => calcPercentB(x.close, num(p, 'length'), num(p, 'mult')),
    historicalvol: (x, p) => calcHistoricalVol(x.close, num(p, 'length'), num(p, 'annualisation')),
    ulcer: (x, p) => calcUlcerIndex(x.close, num(p, 'length')),
    adr: (x, p) => calcADR(x.high, x.low, num(p, 'length')),
    adrpercent: (x, p) => calcADRPercent(x.high, x.low, num(p, 'length')),
    momentum: (x, p) => calcMomentum(x.close, num(p, 'length')),
    aroonosc: (x, p) => calcAroonOsc(x.high, x.low, num(p, 'length')),
    rvi: (x, p) => calcRVI(x.candles, num(p, 'length')),
    bop: (x, p) => calcBOP(x.candles, num(p, 'smooth')),
    smi: (x, p) => calcSMI(x.high, x.low, x.close, num(p, 'k_length'), num(p, 'd_length'), num(p, 'ema_length')),
    pvt: (x) => calcPVT(x.close, x.volume),
    nvi: (x, p) => calcNVI(x.close, x.volume, num(p, 'start')),
    pvi: (x, p) => calcPVI(x.close, x.volume, num(p, 'start')),
    klinger: (x, p) => calcKlinger(x.high, x.low, x.close, x.volume, num(p, 'fast'), num(p, 'slow'), num(p, 'signal')),
    netvolume: (x) => calcNetVolume(x.close, x.volume),
    volumema: (x, p) => calcVolumeWithMa(x.candles, num(p, 'ma_length')),
    rvol: (x, p) => calcRelativeVolume(x.candles, { anchor: 'day', length: num(p, 'length'), mode: str(p, 'mode') === 'regular' ? 'regular' : 'cumulative' }).map((pt) => pt.rvol),
};
/** Script field name -> key in the kernel's result, where they differ. */
const KERNEL_KEY = {
    adx: { plus_di: 'plusDI', minus_di: 'minusDI' },
    ichimoku: { senkou_a: 'senkouA', senkou_b: 'senkouB' },
    sar: { up: 'isUp' },
};
const asNumber = (v) => {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : Number.NaN;
    if (typeof v === 'boolean')
        return v ? 1 : 0;
    return Number.NaN;
};
/** One array per field, as long as the candlesticks (cut or padded with missing values, so a plot can never misalign). */
export function flatten(raw, fields, n, rename = {}) {
    const out = {};
    for (const f of fields) {
        const a = new Float64Array(n).fill(Number.NaN);
        const key = rename[f] ?? f;
        const m = Math.min(n, raw.length);
        for (let i = 0; i < m; i++) {
            const el = raw[i];
            // A group result has an object per candlestick; a single series has a bare number (or null).
            a[i] = el !== null && typeof el === 'object' ? asNumber(el[key]) : f === 'value' ? asNumber(el) : Number.NaN;
        }
        out[f] = a;
    }
    return out;
}
/** Settings of a call, by name: the values the script gave, then the defaults for any it left out. */
export function paramsOf(spec, ctx) {
    const out = {};
    spec.params.forEach((p, i) => {
        const a = ctx.args[i];
        if (p.kind === 'choice') {
            if (a && 't' in a)
                out[p.name] = a.t;
            else
                out[p.name] = p.default;
        }
        else if (a && 'c' in a)
            out[p.name] = a.c;
        else
            out[p.name] = p.default;
    });
    return out;
}
const results = new WeakMap();
const inputsOf = new WeakMap();
/**
 * The fields of a study, with the script's rule for missing values applied (2026-10-25, B2-1): a direction exists only where
 * the line it describes exists. The chart's kernel gives Supertrend a direction of 1 during its warm-up (it colours nothing
 * there); for a script that would read as "up trend" on a stock with five candlesticks.
 */
function tidy(id, fields) {
    if (id === 'supertrend' && fields.direction && fields.value) {
        const v = fields.value;
        const d = fields.direction;
        for (let i = 0; i < d.length; i++)
            if (!Number.isFinite(v[i]))
                d[i] = Number.NaN;
    }
    return fields;
}
/**
 * A study run separately on each unbroken stretch of known candlesticks (`known[i]`), starting its warm-up afresh at the
 * start of each one; every candlestick outside a stretch is unknown. The kernels fill gaps for the chart (sanitize.ts carries
 * the last price forward and back-fills a leading gap), which would invent values the script cannot know: a window (or a
 * running state) that touches a missing value gives unknown, as `ta.*` does on the same series (SPEC, unknown is not false;
 * review fix 2026-10-17 for `src=`, and 2026-10-25 (B2-3) for a candlestick whose own prices are missing).
 */
function studyOnRuns(compute, p, spec, x, known, fields) {
    const n = x.n;
    const out = {};
    for (const f of fields)
        out[f] = new Float64Array(n).fill(Number.NaN);
    let i = 0;
    while (i < n) {
        if (!known(i)) {
            i++;
            continue;
        }
        let j = i;
        while (j < n && known(j))
            j++;
        const m = j - i;
        const part = {
            n: m, candles: x.candles.slice(i, j), open: x.open.slice(i, j), high: x.high.slice(i, j),
            low: x.low.slice(i, j), close: x.close.slice(i, j), volume: x.volume.slice(i, j),
        };
        const got = tidy(spec.id, flatten(compute(part, p), fields, m, KERNEL_KEY[spec.id]));
        for (const f of fields)
            out[f].set(got[f], i);
        i = j;
    }
    return out;
}
/**
 * Studies that are a running total from the first candlestick (2026-10-25, V-3). Splitting them at a missing candlestick would
 * start the total again from its seed (OBV back to 0, NVI back to 1000), a jump no volume caused. A missing candlestick adds
 * nothing instead: the study runs over the known candlesticks only, as if the missing one were not there, which is
 * `ta.cum_sum`'s rule and what the chart's kernels give (they carry the last price over the gap). Its own value is unknown.
 */
export const CUMULATIVE_STUDIES = new Set(['obv', 'adline', 'pvt', 'nvi', 'pvi', 'vwap', 'vwapbands', 'sessionvwap', 'avwap']);
/** A study run over the known candlesticks only, the unknown ones taken out and given unknown (see CUMULATIVE_STUDIES). */
function studySkipping(compute, p, spec, x, known, fields) {
    const at = [];
    for (let i = 0; i < x.n; i++)
        if (known(i))
            at.push(i);
    const pick = (a) => at.map((i) => a[i]);
    const part = { n: at.length, candles: pick(x.candles), open: pick(x.open), high: pick(x.high), low: pick(x.low), close: pick(x.close), volume: pick(x.volume) };
    const got = tidy(spec.id, flatten(compute(part, p), fields, at.length, KERNEL_KEY[spec.id]));
    const out = {};
    for (const f of fields) {
        const a = new Float64Array(x.n).fill(Number.NaN);
        at.forEach((i, k) => (a[i] = got[f][k]));
        out[f] = a;
    }
    return out;
}
/** The rule for a stretch of unknown candlesticks: a running total skips them, every other study starts again after them. */
function studyAroundGaps(compute, p, spec, x, known, fields) {
    return CUMULATIVE_STUDIES.has(spec.id) ? studySkipping(compute, p, spec, x, known, fields) : studyOnRuns(compute, p, spec, x, known, fields);
}
/** A study over a script series (`src=`): run on each unbroken stretch of known values of that series (see studyOnRuns). */
export function studyOnKnownRuns(compute, p, spec, x, own, field) {
    return studyAroundGaps(compute, p, spec, withClose(x, own), (i) => Number.isFinite(own[i]), [field])[field];
}
/** Whether a candlestick's own prices are all known (open, high, low and close). Volume is left to each study. */
function pricesKnown(x) {
    const ok = (i) => Number.isFinite(x.open[i]) && Number.isFinite(x.high[i]) && Number.isFinite(x.low[i]) && Number.isFinite(x.close[i]);
    for (let i = 0; i < x.n; i++)
        if (!ok(i))
            return ok;
    return undefined;
}
/** The function the runtime calls for `ind.<id>`; one calculation serves every field the script reads. */
function studyFunction(spec, compute) {
    return (ctx) => {
        const p = paramsOf(spec, ctx);
        // `src=` (WP1, 2026-10-17): the argument after the settings, when the script gave one. The study reads it in place
        // of the close; not cached, since the series is the script's own.
        const src = spec.source ? ctx.args[spec.params.length] : undefined;
        if (src && !('t' in src)) {
            let width = 2;
            for (const q of spec.params)
                if (q.kind === 'len')
                    width += Math.min(500, Number(p[q.name]));
            ctx.touch(ctx.n * width);
            const own = 's' in src ? src.s : new Float64Array(ctx.n).fill(src.c);
            const want = ctx.out ?? 'value';
            if (!spec.fields.includes(want))
                throw new RuntimeError('E-RT-INTERNAL', `ind.${spec.id} has no field ${want}`);
            return studyOnKnownRuns(compute, p, spec, studyInputs(ctx.bars), own, want);
        }
        let cache = results.get(ctx.bars);
        if (!cache)
            results.set(ctx.bars, (cache = new Map()));
        const key = `${spec.id}|${JSON.stringify(p)}`;
        let fields = cache.get(key);
        if (!fields) {
            // Work is about the window each setting looks across: counted before the calculation runs.
            let width = 2;
            for (const q of spec.params)
                if (q.kind === 'len')
                    width += Math.min(500, Number(p[q.name]));
            ctx.touch(ctx.n * width);
            let x = inputsOf.get(ctx.bars);
            if (!x)
                inputsOf.set(ctx.bars, (x = studyInputs(ctx.bars)));
            // A candlestick with missing prices splits the run, as for src= (B2-3); without one, the whole run in one go.
            const known = pricesKnown(x);
            fields = known ? studyAroundGaps(compute, p, spec, x, known, spec.fields) : tidy(spec.id, flatten(compute(x, p), spec.fields, ctx.n, KERNEL_KEY[spec.id]));
            cache.set(key, fields);
        }
        const want = ctx.out ?? 'value';
        const a = fields[want];
        if (!a)
            throw new RuntimeError('E-RT-INTERNAL', `ind.${spec.id} has no field ${want}`);
        // The caller may keep or change the array it gets, so it gets its own copy; the cache stays clean.
        return a.slice();
    };
}
/** `ta.zigzag(pct)`: the same ZigZag as `ind.zigzag`, with a swing needing pct percent and the default pivot window. Chart only. */
const zigzagFunction = (ctx) => {
    const a = ctx.args[0];
    const pct = a && 'c' in a ? a.c : 5;
    ctx.touch(ctx.n * 12);
    const x = studyInputs(ctx.bars);
    return flatten(zigzagValues(x.n, calcZigZag(x.candles, { deviation: pct, legs: 10 })).map((v) => ({ value: v })), ['value'], ctx.n).value;
};
/** `ind.<id>` for every study that can be calculated here, and `ta.zigzag`. */
export const STUDY_FUNCTIONS = Object.fromEntries([
    ['ta.zigzag', zigzagFunction],
    ...STUDY_SPECS.filter((s) => !s.unavailable).map((s) => {
        const compute = COMPUTE[s.id];
        if (!compute)
            throw new Error(`stdlib/studies: no calculation for ind.${s.id}`);
        return [`ind.${s.id}`, studyFunction(s, compute)];
    }),
]);
export { STUDY_SPEC_BY_ID };
