// Parsers for the exchange's derivatives files. They read a file you give them; they fetch nothing.
//
// Every parser is driven by the NAMES in the header row, not by column positions, so a reordered or widened file
// still reads correctly, and a file whose names differ from what is expected is refused with the list of what is
// missing instead of being read wrongly. The UDiFF and legacy bhavcopy readers were run on real files (UDiFF from
// 2026-10-17; on 2026-10-26 UDiFF 2 Jul 2024, 32843 rows, and legacy 2 Jan 2023, 49695 rows, both with 0 problems). The
// lot-size, ban-list and freeze-quantity layouts are still unchecked: Needs verification (docs/features/derivatives/README.md).
// A row that cannot be read is skipped and listed in `problems`; it never stops the file.
//
// Expiry dates are read from each row (UDiFF `XpryDt`, legacy `EXPIRY_DT`), never worked out from a rule: expiry days
// have moved before and holidays shift them.
import { parseCsv } from './csv.js';
import { parseDayMonthYear, parseIsoDate, parseMonthYear } from './dates.js';
export class FileFormatError extends Error {
    missing;
    constructor(message, missing = []) {
        super(message);
        this.missing = missing;
        this.name = 'FileFormatError';
    }
}
const norm = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
class Header {
    index = new Map();
    constructor(cells) {
        cells.forEach((c, i) => { if (!this.index.has(norm(c)))
            this.index.set(norm(c), i); });
    }
    /** Column number of the first alias present, or -1. */
    find(...aliases) {
        for (const a of aliases) {
            const i = this.index.get(norm(a));
            if (i !== undefined)
                return i;
        }
        return -1;
    }
    /** Column numbers for required names; throws naming every one that is missing. */
    need(spec) {
        const out = {};
        const missing = [];
        for (const [key, aliases] of Object.entries(spec)) {
            const i = this.find(...aliases);
            if (i < 0)
                missing.push(aliases[0]);
            out[key] = i;
        }
        if (missing.length)
            throw new FileFormatError(`missing columns: ${missing.join(', ')}`, missing);
        return out;
    }
}
/** A number, or null for an empty cell or a dash. `undefined` means the cell holds something that is not a number. */
function num(cell) {
    const s = (cell ?? '').trim();
    if (s === '' || s === '-')
        return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s))
        return undefined;
    const v = Number(s);
    return Number.isFinite(v) ? v : undefined;
}
function withHeader(text) {
    const all = parseCsv(text);
    if (all.length === 0)
        throw new FileFormatError('the file is empty');
    return { header: new Header(all[0]), body: all.slice(1) };
}
// ---- UDiFF F&O bhavcopy (from 2024-01-02) -------------------------------------------------------------------------
const UDIFF_TYPES = {
    STF: { kind: 'future', segment: 'stock' },
    STO: { kind: 'option', segment: 'stock' },
    IDF: { kind: 'future', segment: 'index' },
    IDO: { kind: 'option', segment: 'index' },
};
export function parseUdiff(text) {
    const { header, body } = withHeader(text);
    const c = header.need({
        date: ['TradDt'], type: ['FinInstrmTp'], symbol: ['TckrSymb'], expiry: ['XpryDt'], strike: ['StrkPric'], side: ['OptnTp'],
        close: ['ClsPric'], settle: ['SttlmPric'], oi: ['OpnIntrst'], oiChange: ['ChngInOpnIntrst'], volume: ['TtlTradgVol'],
    });
    const optional = {
        open: header.find('OpnPric'), high: header.find('HghPric'), low: header.find('LwPric'), prev: header.find('PrvsClsgPric'),
        underlying: header.find('UndrlygPric'), turnover: header.find('TtlTrfVal'), lot: header.find('NewBrdLotQty'),
    };
    const out = { rows: [], problems: [] };
    body.forEach((r, k) => {
        const row = k + 2;
        const bad = (reason) => { out.problems.push({ row, reason }); };
        const type = UDIFF_TYPES[(r[c.type] ?? '').trim().toUpperCase()];
        if (!type)
            return bad(`unsupported instrument type "${(r[c.type] ?? '').trim()}"`);
        const tradeDate = parseIsoDate(r[c.date] ?? '');
        const expiry = parseIsoDate(r[c.expiry] ?? '');
        if (!tradeDate)
            return bad('trade date is not a date');
        if (!expiry)
            return bad('expiry is not a date');
        const symbol = (r[c.symbol] ?? '').trim();
        if (!symbol)
            return bad('no symbol');
        let strike = null;
        let side = null;
        if (type.kind === 'option') {
            const s = (r[c.side] ?? '').trim().toUpperCase();
            if (s !== 'CE' && s !== 'PE')
                return bad(`option type "${s}" is not CE or PE`);
            side = s;
            const k2 = num(r[c.strike]);
            if (typeof k2 !== 'number' || k2 <= 0)
                return bad('option strike is not a positive number');
            strike = k2;
        }
        const get = (i) => (i < 0 ? null : num(r[i]));
        const vals = {
            open: get(optional.open), high: get(optional.high), low: get(optional.low), close: num(r[c.close]), settle: num(r[c.settle]),
            prev: get(optional.prev), underlying: get(optional.underlying), turnover: get(optional.turnover), lot: get(optional.lot),
            oi: num(r[c.oi]), oiChange: num(r[c.oiChange]), volume: num(r[c.volume]),
        };
        const unreadable = Object.entries(vals).find(([, v]) => v === undefined);
        if (unreadable)
            return bad(`${unreadable[0]} is not a number`);
        if (vals.oi === null || vals.oiChange === null || vals.volume === null)
            return bad('open interest, its change or volume is empty');
        out.rows.push({
            tradeDate, kind: type.kind, segment: type.segment, symbol, expiry, strike, side,
            open: vals.open ?? null, high: vals.high ?? null, low: vals.low ?? null, close: vals.close ?? null, settle: vals.settle ?? null,
            prevClose: vals.prev ?? null, underlying: vals.underlying ?? null,
            oi: vals.oi, oiChange: vals.oiChange, volume: vals.volume,
            turnover: vals.turnover ?? null, lot: vals.lot ?? null,
        });
    });
    return out;
}
// ---- legacy F&O bhavcopy (2000 to mid-2024) -------------------------------------------------------------------------
const LEGACY_TYPES = {
    FUTIDX: { kind: 'future', segment: 'index' },
    FUTSTK: { kind: 'future', segment: 'stock' },
    OPTIDX: { kind: 'option', segment: 'index' },
    OPTSTK: { kind: 'option', segment: 'stock' },
};
export function parseLegacyBhavcopy(text) {
    const { header, body } = withHeader(text);
    const c = header.need({
        type: ['INSTRUMENT'], symbol: ['SYMBOL'], expiry: ['EXPIRY_DT'], strike: ['STRIKE_PR'], side: ['OPTION_TYP'], close: ['CLOSE'],
        settle: ['SETTLE_PR'], volume: ['CONTRACTS'], oi: ['OPEN_INT'], oiChange: ['CHG_IN_OI'], date: ['TIMESTAMP'],
    });
    const optional = { open: header.find('OPEN'), high: header.find('HIGH'), low: header.find('LOW'), lakh: header.find('VAL_INLAKH') };
    const out = { rows: [], problems: [] };
    body.forEach((r, k) => {
        const row = k + 2;
        const bad = (reason) => { out.problems.push({ row, reason }); };
        const type = LEGACY_TYPES[(r[c.type] ?? '').trim().toUpperCase()];
        if (!type)
            return bad(`unsupported instrument "${(r[c.type] ?? '').trim()}"`);
        const tradeDate = parseDayMonthYear(r[c.date] ?? '');
        const expiry = parseDayMonthYear(r[c.expiry] ?? '');
        if (!tradeDate)
            return bad('trade date is not a date');
        if (!expiry)
            return bad('expiry is not a date');
        const symbol = (r[c.symbol] ?? '').trim();
        if (!symbol)
            return bad('no symbol');
        let strike = null;
        let side = null;
        if (type.kind === 'option') {
            const s = (r[c.side] ?? '').trim().toUpperCase();
            if (s !== 'CE' && s !== 'PE')
                return bad(`option type "${s}" is not CE or PE`);
            side = s;
            const k2 = num(r[c.strike]);
            if (typeof k2 !== 'number' || k2 <= 0)
                return bad('option strike is not a positive number');
            strike = k2;
        }
        const get = (i) => (i < 0 ? null : num(r[i]));
        const vals = {
            open: get(optional.open), high: get(optional.high), low: get(optional.low), close: num(r[c.close]), settle: num(r[c.settle]),
            lakh: get(optional.lakh), oi: num(r[c.oi]), oiChange: num(r[c.oiChange]), volume: num(r[c.volume]),
        };
        const unreadable = Object.entries(vals).find(([, v]) => v === undefined);
        if (unreadable)
            return bad(`${unreadable[0]} is not a number`);
        if (vals.oi === null || vals.oiChange === null || vals.volume === null)
            return bad('open interest, its change or contracts is empty');
        out.rows.push({
            tradeDate, kind: type.kind, segment: type.segment, symbol, expiry, strike, side,
            open: vals.open ?? null, high: vals.high ?? null, low: vals.low ?? null, close: vals.close ?? null, settle: vals.settle ?? null,
            prevClose: null, underlying: null,
            oi: vals.oi, oiChange: vals.oiChange, volume: vals.volume,
            // The legacy file gives traded value in lakh of rupees.
            turnover: vals.lakh === null || vals.lakh === undefined ? null : vals.lakh * 100_000, lot: null,
        });
    });
    return out;
}
/** Layout: UNDERLYING, SYMBOL, then one column per contract month (`OCT-26`). Needs verification against a real file. */
export function parseLotSizes(text) {
    const all = parseCsv(text);
    if (all.length === 0)
        throw new FileFormatError('the file is empty');
    const header = all[0].map((h) => h.trim());
    const symbolCol = header.findIndex((h) => norm(h) === 'symbol');
    const nameCol = header.findIndex((h) => norm(h) === 'underlying');
    if (symbolCol < 0)
        throw new FileFormatError('missing columns: SYMBOL', ['SYMBOL']);
    const out = { rows: [], problems: [] };
    const months = [];
    header.forEach((h, col) => {
        if (col === symbolCol || col === nameCol || h === '')
            return;
        const key = parseMonthYear(h);
        if (key)
            months.push({ col, key });
        else
            out.problems.push({ row: 1, reason: `column "${h}" is not a contract month` });
    });
    if (months.length === 0)
        throw new FileFormatError('no contract-month columns found', ['a month column such as OCT-26']);
    all.slice(1).forEach((r, k) => {
        const symbol = (r[symbolCol] ?? '').trim();
        if (!symbol) {
            out.problems.push({ row: k + 2, reason: 'no symbol' });
            return;
        }
        const lots = {};
        for (const { col, key } of months) {
            const v = num(r[col]);
            if (v === undefined) {
                out.problems.push({ row: k + 2, reason: `lot size for ${key} is not a number` });
                continue;
            }
            if (v !== null && v > 0 && Number.isInteger(v))
                lots[key] = v;
        }
        out.rows.push({ symbol, name: nameCol >= 0 ? (r[nameCol] ?? '').trim() : '', lots });
    });
    return out;
}
/**
 * Layout: a title line naming the date, then numbered lines `1,SYMBOL`. A file that says no stock is in the ban gives
 * an empty list. Needs verification against a real file.
 */
export function parseBanList(text) {
    let date = null;
    const symbols = [];
    for (const row of parseCsv(text)) {
        const first = row[0]?.trim() ?? '';
        if (row.length === 1) {
            const m = /(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(first);
            if (m && date === null)
                date = parseDayMonthYear(m[1]);
            continue;
        }
        if (/^\d+$/.test(first)) {
            const sym = (row[1] ?? '').trim().toUpperCase();
            if (/^[A-Z0-9&-]{1,20}$/.test(sym))
                symbols.push(sym);
        }
    }
    return { date, symbols };
}
export function parseFreezeQuantity(text) {
    const { header, body } = withHeader(text);
    const c = header.need({ symbol: ['SYMBOL', 'UNDERLYING'], quantity: ['FREEZE QTY', 'FREEZE_QTY', 'FRZ_QTY', 'FREEZE QUANTITY'] });
    const out = { rows: [], problems: [] };
    body.forEach((r, k) => {
        const symbol = (r[c.symbol] ?? '').trim().toUpperCase();
        const q = num(r[c.quantity]);
        if (!symbol)
            out.problems.push({ row: k + 2, reason: 'no symbol' });
        else if (typeof q !== 'number' || q <= 0 || !Number.isInteger(q))
            out.problems.push({ row: k + 2, reason: 'quantity is not a whole number above zero' });
        else
            out.rows.push({ symbol, quantity: q });
    });
    return out;
}
