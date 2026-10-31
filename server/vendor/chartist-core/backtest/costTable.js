// The cost-rate table and the arithmetic on it (docs/adr/0005). Draft until the owner accepts the ADR.
//
// Rates are DATA in an immutable, versioned table, never code. Every rate is a decimal STRING, and every charge is worked out in
// integer arithmetic (BigInt) and rounded half up to the paisa, component by component in a fixed order, so no floating point
// is ever between a rate and a rupee. A table cannot be shown to a user unless it is signed off (`costTableGate`).
import { canonicalJson } from './canonical.js';
import { PURE_HASH } from '../hash/provider.js';
export const COST_SEGMENTS = ['EQ_DELIVERY', 'EQ_INTRADAY', 'FUT', 'OPT'];
export const COST_SIDES = ['BUY', 'SELL', 'BOTH'];
export const COST_COMPONENTS = ['BROKERAGE', 'STT', 'EXCH_TXN', 'SEBI', 'STAMP', 'DP', 'GST', 'OTHER'];
/**
 * How a rate applies. `PCT_OF_FEES` is an addition to the ADR's list (the ADR says GST applies to brokerage plus exchange and
 * SEBI fees and has no basis to say so): the percent is taken of the sum of the BROKERAGE, EXCH_TXN and SEBI charges.
 */
export const COST_BASES = ['PCT_OF_TURNOVER', 'PER_LAKH', 'PER_CRORE', 'FLAT_PER_ORDER', 'PCT_OF_PREMIUM', 'PCT_OF_INTRINSIC', 'PCT_OF_FEES'];
const isYmd = (n) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 19000101 || n > 21001231)
        return false;
    const y = Math.floor(n / 10000);
    const m = Math.floor((n % 10000) / 100);
    const d = n % 100;
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const RATE = /^\d{1,6}(\.\d{1,8})?$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Problems with a table; empty means it is well formed (not that it is signed off: see `costTableGate`). */
export function validateCostTable(t) {
    const out = [];
    if (typeof t.version !== 'string' || !VERSION.test(t.version))
        out.push('version must be 1 to 40 letters, digits, dots, dashes or underscores');
    if (!isYmd(t.createdOn))
        out.push('createdOn is not a date');
    if (!Array.isArray(t.rows) || t.rows.length === 0) {
        out.push('the table has no rows');
        return out;
    }
    t.rows.forEach((r, i) => {
        const at = `row ${i + 1}`;
        if (!COST_SEGMENTS.includes(r.segment))
            out.push(`${at}: unknown segment ${String(r.segment)}`);
        if (!COST_SIDES.includes(r.side))
            out.push(`${at}: unknown side ${String(r.side)}`);
        if (!COST_COMPONENTS.includes(r.component))
            out.push(`${at}: unknown component ${String(r.component)}`);
        if (!COST_BASES.includes(r.basis))
            out.push(`${at}: unknown basis ${String(r.basis)}`);
        if (typeof r.rate !== 'string' || !RATE.test(r.rate))
            out.push(`${at}: rate must be a decimal string with up to 8 decimals`);
        if (!isYmd(r.effectiveFrom))
            out.push(`${at}: effectiveFrom is not a date`);
        if (r.effectiveTo !== null && !isYmd(r.effectiveTo))
            out.push(`${at}: effectiveTo is not a date`);
        if (isYmd(r.effectiveFrom) && r.effectiveTo !== null && isYmd(r.effectiveTo) && r.effectiveTo < r.effectiveFrom)
            out.push(`${at}: effectiveTo is before effectiveFrom`);
        if (typeof r.source !== 'string' || r.source.trim() === '')
            out.push(`${at}: source is empty`);
        if (r.verifiedOn !== null && !isYmd(r.verifiedOn))
            out.push(`${at}: verifiedOn is not a date`);
        if (r.signedOffBy !== null && (typeof r.signedOffBy !== 'string' || r.signedOffBy.trim() === ''))
            out.push(`${at}: signedOffBy is empty`);
    });
    // No two rows may be in force together for the same segment and component on an overlapping side.
    const sidesOverlap = (a, b) => a === 'BOTH' || b === 'BOTH' || a === b;
    for (let i = 0; i < t.rows.length; i++) {
        for (let j = i + 1; j < t.rows.length; j++) {
            const a = t.rows[i];
            const b = t.rows[j];
            if (a.segment !== b.segment || a.component !== b.component || !sidesOverlap(a.side, b.side))
                continue;
            const aTo = a.effectiveTo ?? Infinity;
            const bTo = b.effectiveTo ?? Infinity;
            if (a.effectiveFrom <= bTo && b.effectiveFrom <= aTo)
                out.push(`rows ${i + 1} and ${j + 1} overlap (${a.segment} ${a.component})`);
        }
    }
    if (t.signOff) {
        const s = t.signOff;
        if (typeof s.by !== 'string' || s.by.trim() === '')
            out.push('signOff.by is empty');
        if (!isYmd(s.on))
            out.push('signOff.on is not a date');
        if (!Number.isInteger(s.contractNotes) || s.contractNotes < 0)
            out.push('signOff.contractNotes must be a whole number');
        if (!Number.isInteger(s.matched) || s.matched < 0 || s.matched > s.contractNotes)
            out.push('signOff.matched must be from 0 to contractNotes');
    }
    return out;
}
export const MIN_CONTRACT_NOTES = 5;
/** Whether a table may be used for a result a user sees: signed off, every row verified and signed, 5 or more notes all matched. */
export function costTableGate(t) {
    const reasons = [];
    if (!t.signOff)
        reasons.push('the cost table has not been signed off by the cost-table owner');
    else {
        if (t.signOff.contractNotes < MIN_CONTRACT_NOTES)
            reasons.push(`only ${t.signOff.contractNotes} contract notes were checked; ${MIN_CONTRACT_NOTES} are needed`);
        if (t.signOff.matched !== t.signOff.contractNotes)
            reasons.push(`${t.signOff.contractNotes - t.signOff.matched} of ${t.signOff.contractNotes} contract notes were not reproduced within Rs 1`);
    }
    if (t.rows.some((r) => r.verifiedOn === null || r.signedOffBy === null))
        reasons.push('some rates have not been verified and signed');
    return { ok: reasons.length === 0, reasons };
}
/** Content id of a table (what the store names it by, besides the version). */
export const costTableHash = (t, hash = PURE_HASH) => hash.sha256Hex(canonicalJson(t));
function parseDec(s) {
    const [i, f = ''] = s.split('.');
    return { n: BigInt(i + f), scale: f.length };
}
const pow10 = (k) => 10n ** BigInt(k);
/** round(a * rate / divisor) half up, for non-negative integers a and divisor. */
function mulDiv(a, rate, divisor) {
    const num = BigInt(a) * rate.n;
    const den = divisor * pow10(rate.scale);
    return Number((num * 2n + den) / (den * 2n));
}
/** The order components are rounded and added in (GST last but OTHER, because GST is worked out on the fees before it). */
const ORDER = ['BROKERAGE', 'STT', 'EXCH_TXN', 'SEBI', 'STAMP', 'DP', 'GST', 'OTHER'];
/**
 * The charges of one fill, in integer paise. Each component is rounded half up on its own, in `ORDER`; GST is worked out on the
 * ROUNDED brokerage, exchange and SEBI charges. A segment or date the table has no rows for gives zero for those components
 * (the caller decides whether that is acceptable; a signed table has every row it needs).
 */
export function computeCharges(t, c) {
    if (!Number.isSafeInteger(c.turnoverPaise) || c.turnoverPaise < 0)
        throw new RangeError('turnoverPaise must be a non-negative integer');
    const out = { BROKERAGE: 0, STT: 0, EXCH_TXN: 0, SEBI: 0, STAMP: 0, DP: 0, GST: 0, OTHER: 0 };
    for (const comp of ORDER) {
        let sum = 0;
        for (const r of t.rows) {
            if (r.segment !== c.segment || r.component !== comp)
                continue;
            if (r.side !== 'BOTH' && r.side !== c.side)
                continue;
            if (c.date < r.effectiveFrom || (r.effectiveTo !== null && c.date > r.effectiveTo))
                continue;
            const rate = parseDec(r.rate);
            switch (r.basis) {
                case 'PCT_OF_TURNOVER':
                case 'PCT_OF_PREMIUM':
                    sum += mulDiv(c.turnoverPaise, rate, 100n);
                    break;
                case 'PER_LAKH':
                    sum += mulDiv(c.turnoverPaise, rate, 100000n);
                    break;
                case 'PER_CRORE':
                    sum += mulDiv(c.turnoverPaise, rate, 10000000n);
                    break;
                case 'FLAT_PER_ORDER':
                    sum += mulDiv(100, rate, 1n);
                    break;
                case 'PCT_OF_INTRINSIC':
                    sum += mulDiv(c.intrinsicPaise ?? 0, rate, 100n);
                    break;
                case 'PCT_OF_FEES':
                    sum += mulDiv(out.BROKERAGE + out.EXCH_TXN + out.SEBI, rate, 100n);
                    break;
            }
        }
        out[comp] = sum;
    }
    const total = ORDER.reduce((a, k) => a + out[k], 0);
    return { ...out, total };
}
