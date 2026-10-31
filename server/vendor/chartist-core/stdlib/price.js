const usable = (o, h, l, c) => o > 0 && h > 0 && l > 0 && c > 0 && h >= Math.max(o, c) && l <= Math.min(o, c);
function perBar(b, f) {
    const out = new Float64Array(b.n);
    for (let i = 0; i < b.n; i++)
        out[i] = f(i);
    return out;
}
const U = Number.NaN;
export const PRICE_KERNELS = {
    body: (b) => perBar(b, (i) => (usable(b.open[i], b.high[i], b.low[i], b.close[i]) ? (Math.abs(b.close[i] - b.open[i]) / b.close[i]) * 100 : U)),
    range: (b) => perBar(b, (i) => (usable(b.open[i], b.high[i], b.low[i], b.close[i]) ? ((b.high[i] - b.low[i]) / b.close[i]) * 100 : U)),
    close_pos: (b) => perBar(b, (i) => {
        const { open: o, high: h, low: l, close: c } = { open: b.open[i], high: b.high[i], low: b.low[i], close: b.close[i] };
        if (!usable(o, h, l, c))
            return U;
        return h - l > 0 ? ((c - l) / (h - l)) * 100 : 50;
    }),
    lower_wick_pct: (b) => perBar(b, (i) => {
        const { open: o, high: h, low: l, close: c } = { open: b.open[i], high: b.high[i], low: b.low[i], close: b.close[i] };
        if (!usable(o, h, l, c))
            return U;
        return h - l > 0 ? ((Math.min(o, c) - l) / (h - l)) * 100 : 0;
    }),
    gap_pct: (b) => perBar(b, (i) => {
        if (i === 0)
            return U;
        const pc = b.close[i - 1];
        const o = b.open[i];
        return pc > 0 && o > 0 ? ((o - pc) / pc) * 100 : U;
    }),
};
