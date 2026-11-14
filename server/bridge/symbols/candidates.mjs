/**
 * Ranking and the refuse-to-guess rule behind GET /v1/symbols/resolve. Pure functions over search results.
 *
 * A bare name (RELIANCE, M_M, Nifty Bank) is matched against the cash and index instruments first. It resolves only
 * when exactly one of them carries that name; two (RELIANCE on NSE and on BSE) is `ambiguous` and the caller must
 * name the exchange. Futures and options are never picked from a bare name unless exactly one contract carries it.
 * Anything short of an exact name is `not_found`, with the closest matches as suggestions.
 */

/** Letters and digits only, upper case: "M_M", "M&M" and "m m" are the same name. */
export const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const SPOT = new Set(["EQ", "INDEX"]);

/**
 * Why one instrument matched the query. tier: 1 exact name, 2 exact company name, 3 starts with, 4 contains, 5 fuzzy.
 * @param {string} q
 * @param {{ underlying: string, name: string | null, exchange: string, kind: string }} rec
 * @returns {{ tier: number, reason: string }}
 */
export function reasonFor(q, rec) {
  const n = norm(q);
  const u = norm(rec.underlying);
  const name = norm(rec.name);
  const kindText = rec.kind === "INDEX" ? "index" : rec.kind === "EQ" ? "share" : rec.kind === "FUT" ? "future" : "option";
  if (n && u === n) return { tier: 1, reason: `exact name match, ${kindText} on ${rec.exchange}` };
  if (n && name === n) return { tier: 2, reason: `exact company name match, ${kindText} on ${rec.exchange}` };
  if (n && u.startsWith(n)) return { tier: 3, reason: `name starts with ${q.trim()}, ${kindText} on ${rec.exchange}` };
  if (n && (u.includes(n) || name.includes(n))) return { tier: 4, reason: `name contains ${q.trim()}, ${kindText} on ${rec.exchange}` };
  return { tier: 5, reason: `close match on the name, ${kindText} on ${rec.exchange}` };
}

/**
 * @param {string} q the text the caller sent
 * @param {Array<object>} found search results (ResolvedInstrument-like), best first
 * @param {{ limit?: number }} [opts]
 * @returns {{ status: "resolved" | "ambiguous" | "not_found", pick: object | null, rule: string, candidates: Array<{ rec: object, reason: string, tier: number }> }}
 */
export function decideCandidates(q, found, { limit = 10 } = {}) {
  const ranked = found
    .map((rec, i) => ({ rec, i, ...reasonFor(q, rec) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map(({ rec, reason, tier }) => ({ rec, reason, tier }));
  const exactSpot = ranked.filter((c) => c.tier <= 2 && SPOT.has(c.rec.kind));
  const exactAny = ranked.filter((c) => c.tier <= 2);
  const top = ranked.slice(0, limit);
  if (exactSpot.length === 1) {
    return { status: "resolved", pick: exactSpot[0].rec, rule: `the only ${exactSpot[0].rec.kind === "INDEX" ? "index" : "cash instrument"} with this name`, candidates: top };
  }
  if (exactSpot.length > 1) {
    return { status: "ambiguous", pick: null, rule: `${exactSpot.length} cash or index instruments carry this name; name the exchange`, candidates: exactSpot.slice(0, limit) };
  }
  if (exactAny.length === 1) {
    return { status: "resolved", pick: exactAny[0].rec, rule: "the only contract with this name", candidates: top };
  }
  if (exactAny.length > 1) {
    return { status: "ambiguous", pick: null, rule: `${exactAny.length} contracts carry this name; send the full contract symbol`, candidates: exactAny.slice(0, limit) };
  }
  return { status: "not_found", pick: null, rule: top.length ? "no instrument has exactly this name; these are the closest" : "no instrument matches", candidates: top };
}
