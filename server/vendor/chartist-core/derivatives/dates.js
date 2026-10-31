// Dates in exchange files, as plain `YYYY-MM-DD` text. Parsed by hand and checked against the calendar, so a
// wrong date is refused (31 Feb) rather than rolled over, and the result does not depend on the machine's time zone.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n, w) => String(n).padStart(w, '0');
function make(y, m, d) {
    if (!Number.isInteger(y) || y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1)
        return null;
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}` : null;
}
/** `2026-10-09` */
export function parseIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    return m ? make(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
/** `09-OCT-2026`, `9-Oct-2026` */
export function parseDayMonthYear(s) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
    if (!m)
        return null;
    const month = MONTHS.indexOf(m[2].toUpperCase()) + 1;
    return month > 0 ? make(Number(m[3]), month, Number(m[1])) : null;
}
/** `OCT-26` or `Oct-2026` -> `2026-10` (a contract month, not a day). */
export function parseMonthYear(s) {
    const m = /^([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s.trim());
    if (!m)
        return null;
    const month = MONTHS.indexOf(m[1].toUpperCase()) + 1;
    if (month === 0)
        return null;
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return year >= 1990 && year <= 2100 ? `${pad(year, 4)}-${pad(month, 2)}` : null;
}
/** Whole days from `a` to `b`, both `YYYY-MM-DD`. Negative if `b` is earlier. */
export function daysBetween(a, b) {
    const [ya, ma, da] = a.split('-').map(Number);
    const [yb, mb, db] = b.split('-').map(Number);
    return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}
