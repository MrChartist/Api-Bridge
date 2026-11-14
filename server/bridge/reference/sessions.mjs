/**
 * Dated session rules (reference/data/sessions.json): which hours apply to a segment on a date. Pure: no I/O, no clock.
 *
 * A rule is { id, segment: "cash"|"derivatives", exchanges, from, to?, preOpen, open, close, expiringIndexClose?, cas?,
 * verified, circular, source (URL), readOn, note }. The rule whose from/to contains the date applies; when none does
 * (a date before the first rule) the oldest rule is used, and a date-less question gets the newest one.
 *
 * Two views of one rule:
 *  - the window: the times as the data states them. Read-only features (calendar pages, recorder schedule, history
 *    session edges, readiness) use it and always show the `verified` flag.
 *  - the gate window: what the LIVE-order gate may rely on. A verified rule is used as it is. A rule with verified:false
 *    can only make the window shorter than `gateFloor`, never longer: an unverified longer session must not open the gate.
 */
import { DEFAULT_SESSIONS, DEFAULT_SESSION_SOURCE } from "./defaults.mjs";

/** "cash" for NSE/BSE, "derivatives" for NFO/BFO, null for exchanges the session table does not cover. */
export function segmentOf(exchange) {
  const e = String(exchange ?? "NFO").toUpperCase();
  if (e === "NSE" || e === "BSE") return "cash";
  if (e === "NFO" || e === "BFO") return "derivatives";
  return null;
}

const earlier = (a, b) => (a <= b ? a : b);
const later = (a, b) => (a >= b ? a : b);

/** The rule of a segment for an exchange on a date (see the module comment), or null when the table has no such segment. */
export function ruleFor(rules, exchange, date) {
  const seg = segmentOf(exchange);
  const ex = String(exchange ?? "NFO").toUpperCase();
  if (!seg) return null;
  const mine = (rules ?? []).filter((r) => r.segment === seg && (!r.exchanges || r.exchanges.includes(ex)));
  if (!mine.length) return null;
  const byFromDesc = [...mine].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
  if (!date) return byFromDesc[0];
  const hit = byFromDesc.find((r) => r.from <= date && (!r.to || date <= r.to));
  return hit ?? byFromDesc[byFromDesc.length - 1];
}

/**
 * The window of one rule with its gate view.
 * @param {object} rule
 * @param {{ preOpen: string, open: string, close: string }} floor
 */
export function windowOfRule(rule, floor) {
  const verified = rule.verified === true;
  const gate = verified
    ? { preOpen: rule.preOpen, open: rule.open, close: rule.close, expiringIndexClose: rule.expiringIndexClose ?? null }
    : {
        preOpen: later(rule.preOpen, floor.preOpen),
        open: later(rule.open, floor.open),
        close: earlier(rule.close, floor.close),
        expiringIndexClose: rule.expiringIndexClose ? earlier(rule.expiringIndexClose, floor.close) : null,
      };
  return {
    preOpen: rule.preOpen,
    open: rule.open,
    close: rule.close,
    expiringIndexClose: rule.expiringIndexClose ?? null,
    cas: rule.cas ?? null,
    verified,
    ruleId: rule.id,
    from: rule.from,
    to: rule.to ?? null,
    circular: rule.circular ?? null,
    url: rule.source ?? null,
    readOn: rule.readOn ?? null,
    note: rule.note ?? null,
    source: verified && rule.circular ? rule.circular : DEFAULT_SESSION_SOURCE,
    gate,
  };
}

/** Used only when a calendar is built with no rules at all (a test double): the labelled, unverified default window. */
export function fallbackWindow(exchange, floor) {
  const base = DEFAULT_SESSIONS[String(exchange ?? "NFO").toUpperCase()] ?? DEFAULT_SESSIONS.NFO;
  return windowOfRule({ id: "default", segment: segmentOf(exchange), from: "2000-01-01", preOpen: base.preOpen, open: base.open, close: base.close, verified: false, circular: null, source: null, readOn: null }, floor ?? base);
}

/**
 * The close that applies to one contract on a date. `instrument` is { kind: "index"|"stock"|null, expiry: "YYYY-MM-DD"|null }.
 * Read-only use (gate false): the segment close. Gate use: an index contract that expires that day (or whose
 * expiry or kind is not known) stops at expiringIndexClose when the rule has one; everything else at the close.
 */
export function closeOf(win, date, { gate = false, instrument = null } = {}) {
  const w = gate ? win.gate : win;
  if (!gate || !w.expiringIndexClose) return w.close;
  const inst = instrument ?? {};
  if (inst.kind === "stock") return w.close;
  if (inst.expiry && inst.expiry !== date) return w.close;
  return w.expiringIndexClose;
}
