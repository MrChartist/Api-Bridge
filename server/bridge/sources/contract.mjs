/**
 * The data-source contract: what every source of market data must look like to the router, whether it is a user's
 * broker account, a built-in free provider or a plugin. Pure: no I/O, no clock.
 *
 * A source answers read-only market-data questions. It never places orders and never sees broker credentials.
 * Every answer carries a data class so a delayed or end-of-day value can never be mistaken for a real-time one.
 */

/** How current an answer is. Lower rank is more current. */
export const DATA_CLASS = Object.freeze({ REALTIME: "realtime", DELAYED: "delayed", EOD: "eod" });
const CLASS_RANK = Object.freeze({ realtime: 0, delayed: 1, eod: 2 });

/** What a source can be asked. These mirror the market service's read paths. */
export const CAPABILITIES = Object.freeze(["quotes", "history", "expiries", "optionChain"]);

/** Where a source comes from. */
export const SOURCE_KINDS = Object.freeze(["broker", "free", "plugin"]);

/**
 * How a source is switched on:
 *  builtin  part of the Bridge, on by default (the user's own brokers)
 *  byok     bring your own key: the user holds the vendor account and accepts the vendor's terms
 *  opt-in   works without a key but is unofficial or terms-sensitive: off until the user accepts a notice
 *  plugin   third-party code the owner granted explicitly
 */
export const TIERS = Object.freeze(["builtin", "byok", "opt-in", "plugin"]);

/** Confidence labels on an answer. */
export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);

/** What a read is for. Money-moving and risk purposes accept only trusted real-time sources. */
export const PURPOSES = Object.freeze(["display", "analysis", "alert", "paper", "risk", "order"]);
const STRICT_PURPOSES = new Set(["alert", "paper", "risk", "order"]);

/** @param {string} c @returns {number} 0 for realtime, 1 delayed, 2 eod, 3 for anything unknown */
export const classRank = (c) => CLASS_RANK[c] ?? 3;

/** The least current class in a list; a composite answer takes this. Empty list gives "realtime". */
export function worstClass(classes) {
  let worst = "realtime";
  for (const c of classes) if (classRank(c) > classRank(worst)) worst = c;
  return worst;
}

/** True when a source of this class may serve a read made for this purpose. */
export function classAllowedFor(dataClass, purpose) {
  if (STRICT_PURPOSES.has(purpose)) return dataClass === "realtime";
  return classRank(dataClass) < 3;
}

/**
 * Whether a source's data is fresh enough for a caller's `maxAgeMs`. A delayed or EOD source can only satisfy a caller
 * whose maxAge is at least its delay; a caller that asks for fresher data than a source can give is not served by it.
 * @param {{ class: string, delaySec?: number|null }} source
 * @param {number|null|undefined} maxAgeMs  null or undefined means the caller accepts any age
 */
export function meetsMaxAge(source, maxAgeMs) {
  if (maxAgeMs === null || maxAgeMs === undefined) return true;
  if (source.class === "realtime") return true;
  if (source.class === "eod") return maxAgeMs >= 24 * 3600_000;
  return maxAgeMs >= (source.delaySec ?? 900) * 1000;
}

/**
 * @typedef {object} SourceLimits
 * @property {number} [perSecond]
 * @property {number} [perMinute]
 * @property {number} [perDay]
 *
 * @typedef {object} SourceTerms
 * @property {string} url   the vendor's terms or documentation page
 * @property {string} note  one plain sentence about what the user accepts by enabling it
 *
 * @typedef {object} SourceDescriptor
 * @property {string} id            lowercase letters, digits and dashes; unique
 * @property {string} name          shown to people
 * @property {"broker"|"free"|"plugin"} kind
 * @property {"builtin"|"byok"|"opt-in"|"plugin"} tier
 * @property {"realtime"|"delayed"|"eod"} class
 * @property {number|null} delaySec  typical delay for a delayed source, null when not applicable
 * @property {boolean} official      true only for a documented API from the data's owner or the user's own broker
 * @property {string[]} capabilities subset of CAPABILITIES
 * @property {SourceLimits} limits   the vendor's documented limits; the Bridge never goes above them
 * @property {SourceTerms} [terms]   required unless tier is "builtin"
 * @property {string} [noticeVersion] opt-in sources: the version of the notice the user must acknowledge
 * @property {boolean} [needsKey]
 *
 * @typedef {object} SourceProvider
 * @property {SourceDescriptor} descriptor
 * @property {(symbols: string[], ctx: ReadContext) => Promise<{ items: Array<{ symbol: string, fields: object, at: number }> }>} [quotes]
 * @property {(req: { symbol: string, interval: string, fromMs: number, toMs: number }, ctx: ReadContext) => Promise<{ candles: object[], partial?: boolean, at: number }>} [history]
 * @property {(underlying: string, ctx: ReadContext) => Promise<{ expiries: string[], at: number }>} [expiries]
 * @property {(underlying: string, expiry: string|undefined, ctx: ReadContext) => Promise<{ underlyingLtp: number|null, rows: object[], at: number }>} [optionChain]
 * @property {(ctx: ReadContext) => Promise<{ ok: boolean, latencyMs?: number, detail?: string }>} [test]
 *
 * @typedef {object} ReadContext
 * @property {AbortSignal} [signal]  aborted at the caller's deadline
 * @property {number} now            epoch ms from the Bridge clock
 */

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Check a descriptor. Returns every problem, not just the first, so a plugin author sees them all at once.
 * @param {unknown} d
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDescriptor(d) {
  const errors = [];
  const o = d && typeof d === "object" ? /** @type {any} */ (d) : null;
  if (!o) return { ok: false, errors: ["descriptor must be an object"] };
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) errors.push("id must match ^[a-z][a-z0-9-]{1,30}$");
  if (typeof o.name !== "string" || !o.name.trim()) errors.push("name is required");
  if (!SOURCE_KINDS.includes(o.kind)) errors.push(`kind must be one of ${SOURCE_KINDS.join(", ")}`);
  if (!TIERS.includes(o.tier)) errors.push(`tier must be one of ${TIERS.join(", ")}`);
  if (!(o.class in CLASS_RANK)) errors.push("class must be realtime, delayed or eod");
  if (o.class === "delayed" && !(Number.isFinite(o.delaySec) && o.delaySec > 0)) errors.push("a delayed source must state delaySec");
  if (typeof o.official !== "boolean") errors.push("official must be true or false");
  if (!Array.isArray(o.capabilities) || !o.capabilities.length || o.capabilities.some((c) => !CAPABILITIES.includes(c))) errors.push(`capabilities must be a non-empty subset of ${CAPABILITIES.join(", ")}`);
  const lim = o.limits;
  if (!lim || typeof lim !== "object" || !["perSecond", "perMinute", "perDay"].some((k) => Number.isFinite(lim[k]) && lim[k] > 0)) errors.push("limits must state at least one of perSecond, perMinute, perDay");
  if (o.tier !== "builtin") {
    if (!o.terms || typeof o.terms.url !== "string" || !/^https:\/\//.test(o.terms.url) || typeof o.terms.note !== "string" || !o.terms.note.trim()) errors.push("terms.url (https) and terms.note are required unless tier is builtin");
  }
  if (o.tier === "opt-in" && (typeof o.noticeVersion !== "string" || !o.noticeVersion)) errors.push("an opt-in source needs a noticeVersion");
  if (o.tier === "opt-in" && o.official === true) errors.push("an opt-in source is by definition unofficial or terms-sensitive; use byok or builtin for official ones");
  return { ok: errors.length === 0, errors };
}

/** Freshness fields every answer carries beyond source, asOf, ageMs, stale, accountId, broker, provider. */
export function dataQuality({ class: dataClass, delaySec = null, official = false, confidence = "high", flags = [] }) {
  return { class: dataClass, delaySec: dataClass === "realtime" ? 0 : delaySec, official, confidence, flags: [...flags] };
}
