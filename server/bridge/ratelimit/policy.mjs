/**
 * Policy resolution. Turns a raw entry of BROKER_POLICIES (data, brokerPolicies.mjs) plus the
 * `ratelimit` config overrides into the EFFECTIVE policy the scheduler enforces and /v1/limits reports.
 *
 * Rules (docs/ARCHITECTURE.md §6):
 *  1. verified LimitSpec  -> used as written;
 *     unverified LimitSpec -> each window is min(figure, default); windows only the figure has are kept (they are
 *                             extra constraints, so they can only slow us down); windows only the default has are added;
 *     missing LimitSpec    -> the default (DEFAULT_CLASS_LIMITS).
 *  2. Orders never exceed the SEBI retail unregistered-algo ceiling (10/s, needs verification) whatever a broker allows.
 *  3. A spec with a per-minute (or hour-scale) figure but no per-second figure gets a derived per-second cap of
 *     ceil(perMinute / 30), at least 1 (no more than twice the average rate), so a documented minute budget is not
 *     spent in one burst that trips an unpublished per-second limit. Daily caps are quotas and derive nothing.
 *  4. Groups are copied as declared (verified or not); a broker with no `groups` gets one shared quote/depth/chain
 *     budget equal to its effective quote limit.
 *  5. Overrides (broker-level, then account-level) can only LOWER: every window becomes min(effective, override).
 *  6. A broker with documented plans (`tiers`, e.g. Fyers Standard and Prime) is resolved for ONE plan: the account's
 *     `tier`, else the broker-level `tier`, else the entry's default (the lower plan). An unknown plan name falls back to
 *     the default plan (never to a higher one) and the result says so in `tierFallback`. A plan is a choice among
 *     documented plans, not an override: only pick Prime if you have it. Overrides then lower that plan's figures.
 */
import { ENDPOINT_CLASSES } from "../core/contracts.mjs";
import { SEBI_UNREGISTERED_OPS_CEILING } from "../core/config.mjs";
import { BROKER_POLICIES, DATA_ENTITLEMENTS, DEFAULT_CLASS_LIMITS, DEFAULT_GROUP_CLASSES, DEFAULT_MAX_QUOTE_BATCH, PAPER_POLICY, POOLING_NOT_REVIEWED } from "./brokerPolicies.mjs";
import { windowsFromSpec } from "./tokenBucket.mjs";

export const WINDOW_KEYS = Object.freeze(["perSecond", "perMinute", "perDay"]);

/**
 * @typedef {{ perSecond?: number, perMinute?: number, perDay?: number, extraWindows?: Array<{ windowMs: number, limit: number }> }} Windows
 * @typedef {Windows & { verified: boolean, source?: string, defaulted?: boolean, derivedPerSecond?: boolean, lowered?: boolean }} EffectiveSpec
 * @typedef {EffectiveSpec & { classes: string[] }} EffectiveGroup
 * @typedef {{ brokerId: string, known: boolean, limits: Record<string, EffectiveSpec>, groups: Record<string, EffectiveGroup>,
 *   maxQuoteBatch: number, feed: { maxConnections: number|null, maxSubscriptions: number|null },
 *   pooling: "allowed"|"not-allowed"|"unknown", poolingNote: string, dataEntitlement: { value: string, note: string, verified: boolean, source?: string },
 *   maxModificationsPerOrder: number|null, notes?: string, unlimited?: boolean,
 *   tier?: string, tiers?: string[], tierFallback?: string }} EffectivePolicy
 * @typedef {{ limits?: Partial<Record<string, Windows>>, groups?: Record<string, Windows>, maxQuoteBatch?: number, tier?: string }} PolicyOverride
 */

const minDefined = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));

function mergeExtra(a = [], b = []) {
  const byMs = new Map();
  for (const w of [...a, ...b]) {
    if (!(w?.windowMs > 0 && w?.limit > 0)) continue;
    byMs.set(w.windowMs, Math.min(byMs.get(w.windowMs) ?? Infinity, w.limit));
  }
  return [...byMs].sort((x, y) => x[0] - y[0]).map(([windowMs, limit]) => Object.freeze({ windowMs, limit }));
}

function pickWindows(spec) {
  const out = {};
  for (const k of WINDOW_KEYS) if (spec?.[k] > 0) out[k] = spec[k];
  const extra = mergeExtra(spec?.extraWindows);
  if (extra.length) out.extraWindows = extra;
  return out;
}

function hasAnyWindow(w) {
  return WINDOW_KEYS.some((k) => w[k] > 0) || (w.extraWindows?.length ?? 0) > 0;
}

/** Rule 3: derived per-second cap. */
function withDerivedPerSecond(spec) {
  if (spec.perSecond > 0) return spec;
  /** Per-minute equivalents of the minute and hour-scale windows (a daily cap is a quota, not a pace). */
  const rates = [];
  if (spec.perMinute > 0) rates.push(spec.perMinute);
  for (const w of spec.extraWindows ?? []) rates.push((w.limit * 60_000) / w.windowMs);
  if (!rates.length) return spec;
  return { ...spec, perSecond: Math.max(1, Math.ceil(Math.min(...rates) / 30)), derivedPerSecond: true };
}

/**
 * Effective LimitSpec for one class (rules 1-3).
 * @param {string} cls
 * @param {object | undefined} raw
 * @returns {EffectiveSpec}
 */
export function effectiveClassSpec(cls, raw) {
  const def = DEFAULT_CLASS_LIMITS[cls] ?? DEFAULT_CLASS_LIMITS.other;
  let out;
  if (!raw || !hasAnyWindow(pickWindows(raw))) {
    out = { ...pickWindows(def), verified: false, defaulted: true };
  } else if (raw.verified === true) {
    out = { ...pickWindows(raw), verified: true };
  } else {
    const w = pickWindows(raw);
    out = { verified: false };
    for (const k of WINDOW_KEYS) {
      const val = minDefined(w[k], def[k]);
      if (val != null) out[k] = val;
    }
    if (w.extraWindows) out.extraWindows = w.extraWindows;
  }
  if (raw?.source) out.source = raw.source;
  if (cls === "order") out.perSecond = Math.min(out.perSecond ?? SEBI_UNREGISTERED_OPS_CEILING, SEBI_UNREGISTERED_OPS_CEILING);
  return withDerivedPerSecond(out);
}

/** Apply a lowering override to a spec (rule 5). */
export function lowerSpec(spec, override) {
  if (!override) return spec;
  const out = { ...spec };
  let changed = false;
  for (const k of WINDOW_KEYS) {
    if (!(override[k] > 0)) continue;
    const next = minDefined(out[k], override[k]);
    if (next !== out[k]) {
      out[k] = next;
      changed = true;
    }
  }
  if (override.extraWindows?.length) {
    const merged = mergeExtra(out.extraWindows, override.extraWindows);
    if (JSON.stringify(merged) !== JSON.stringify(out.extraWindows ?? [])) {
      out.extraWindows = merged;
      changed = true;
    }
  }
  if (changed) out.lowered = true;
  return out;
}

function freezeSpec(s) {
  return Object.freeze({ ...s, ...(s.extraWindows ? { extraWindows: Object.freeze([...s.extraWindows]) } : {}), ...(s.classes ? { classes: Object.freeze([...s.classes]) } : {}) });
}

/** Raw table entry for a broker id (paper and unknown brokers included). */
export function rawPolicy(brokerId, table = BROKER_POLICIES) {
  if (brokerId === "paper") return PAPER_POLICY;
  return table[brokerId] ?? null;
}

/** `dataEntitlement` as the API reports it: a known value, a note and the proof flags. */
function entitlementOf(raw) {
  const value = DATA_ENTITLEMENTS.includes(raw?.value) ? raw.value : "unknown";
  const note = typeof raw?.note === "string" && raw.note ? raw.note : "The data plan for this broker has not been researched.";
  return { value, note, verified: raw?.verified === true, ...(raw?.source ? { source: raw.source } : {}) };
}

/**
 * Pick the plan (rule 6). Returns the fields of the chosen tier to lay over the entry (nothing for brokers without tiers).
 * @param {object | undefined} raw  the raw table entry
 * @param {string | undefined} wanted
 */
export function chooseTier(raw, wanted) {
  if (!raw?.tiers) return { id: null, fields: {} };
  const dflt = raw.defaultTier && raw.tiers[raw.defaultTier] ? raw.defaultTier : Object.keys(raw.tiers)[0];
  const known = typeof wanted === "string" && Object.hasOwn(raw.tiers, wanted);
  const id = known ? wanted : dflt;
  const t = raw.tiers[id];
  const fields = { limits: t.limits, groups: t.groups, maxQuoteBatch: t.maxQuoteBatch, feed: t.feed };
  if (t.dataEntitlement) fields.dataEntitlement = t.dataEntitlement;
  const fallback = wanted !== undefined && !known ? `${String(wanted).slice(0, 40)} is not a plan of ${raw.brokerId} (${Object.keys(raw.tiers).join(", ")}); using ${dflt}` : undefined;
  return { id, fields, ...(fallback ? { fallback } : {}) };
}

/**
 * Resolve the effective policy for a broker.
 * @param {string} brokerId
 * @param {{ broker?: PolicyOverride, account?: PolicyOverride }} [overrides]
 * @param {Readonly<Record<string, object>>} [table]  the raw table (tests pass their own)
 * @returns {Readonly<EffectivePolicy>}
 */
export function resolvePolicy(brokerId, overrides = {}, table = BROKER_POLICIES) {
  if (brokerId === "paper") return Object.freeze({ ...PAPER_POLICY, known: true, unlimited: true });
  const raw = table[brokerId];
  const known = Boolean(raw);
  const chosen = chooseTier(raw, overrides.account?.tier ?? overrides.broker?.tier);
  const base = raw ? { ...raw, ...chosen.fields } : { brokerId, limits: {}, maxQuoteBatch: DEFAULT_MAX_QUOTE_BATCH, feed: { maxConnections: null, maxSubscriptions: null }, pooling: "unknown", maxModificationsPerOrder: null };

  const limits = {};
  for (const cls of ENDPOINT_CLASSES) {
    let spec = effectiveClassSpec(cls, base.limits?.[cls]);
    spec = lowerSpec(spec, overrides.broker?.limits?.[cls]);
    spec = lowerSpec(spec, overrides.account?.limits?.[cls]);
    if (cls === "order") spec = { ...spec, perSecond: Math.min(spec.perSecond, SEBI_UNREGISTERED_OPS_CEILING) };
    limits[cls] = freezeSpec(withDerivedPerSecond(spec));
  }

  const groups = {};
  if (base.groups) {
    for (const [name, g] of Object.entries(base.groups)) {
      const classes = (g.classes ?? []).filter((c) => ENDPOINT_CLASSES.includes(c));
      if (!classes.length) continue;
      let spec = { ...pickWindows(g), verified: g.verified === true, ...(g.source ? { source: g.source } : {}) };
      if (!hasAnyWindow(spec)) continue;
      spec = lowerSpec(spec, overrides.broker?.groups?.[name]);
      spec = lowerSpec(spec, overrides.account?.groups?.[name]);
      groups[name] = freezeSpec({ ...withDerivedPerSecond(spec), classes });
    }
  } else {
    const q = limits.quote;
    groups.quoteFamily = freezeSpec({ ...pickWindows(q), verified: q.verified, ...(q.source ? { source: q.source } : {}), classes: [...DEFAULT_GROUP_CLASSES], defaulted: true });
  }

  const maxQuoteBatch = Math.max(1, Math.floor(minDefined(minDefined(base.maxQuoteBatch, overrides.broker?.maxQuoteBatch), overrides.account?.maxQuoteBatch) ?? DEFAULT_MAX_QUOTE_BATCH));
  const out = {
    brokerId,
    known,
    limits: Object.freeze(limits),
    groups: Object.freeze(groups),
    maxQuoteBatch,
    feed: Object.freeze({ ...base.feed }),
    pooling: base.pooling === "allowed" || base.pooling === "not-allowed" ? base.pooling : "unknown",
    poolingNote: typeof base.poolingNote === "string" && base.poolingNote ? base.poolingNote : POOLING_NOT_REVIEWED,
    dataEntitlement: Object.freeze(entitlementOf(base.dataEntitlement)),
    maxModificationsPerOrder: base.maxModificationsPerOrder ?? null,
  };
  if (raw?.tiers) {
    out.tier = chosen.id;
    out.tiers = Object.keys(raw.tiers);
    if (chosen.fallback) out.tierFallback = chosen.fallback;
  }
  if (base.notes) out.notes = base.notes;
  if (!known) out.notes = `No policy for broker "${brokerId}"; conservative defaults apply.`;
  return Object.freeze(out);
}

/**
 * Buckets the scheduler builds for a policy: one per class plus one per group.
 * @param {EffectivePolicy} policy
 * @returns {Array<{ key: string, classes: string[], windows: import("./tokenBucket.mjs").WindowSpec[] }>}
 */
export function bucketPlan(policy) {
  if (policy.unlimited) return [];
  const plan = [];
  for (const cls of ENDPOINT_CLASSES) {
    const windows = windowsFromSpec(policy.limits[cls]);
    if (windows.length) plan.push({ key: `class:${cls}`, classes: [cls], windows });
  }
  for (const [name, g] of Object.entries(policy.groups ?? {})) {
    const windows = windowsFromSpec(g);
    if (windows.length) plan.push({ key: `group:${name}`, classes: [...g.classes], windows });
  }
  return plan;
}

/**
 * Check that a config override only lowers the broker's effective limits. Returns human-readable problems
 * (empty = fine). Adding a window the policy does not have is lowering, so it is allowed.
 * @param {string} brokerId
 * @param {PolicyOverride} override
 * @returns {Array<{ path: string[], message: string }>}
 */
export function overrideProblems(brokerId, override) {
  const problems = [];
  if (!BROKER_POLICIES[brokerId]) {
    problems.push({ path: [], message: `"${brokerId}" is not a broker id in the policy table` });
    return problems;
  }
  const tiers = Object.keys(BROKER_POLICIES[brokerId].tiers ?? {});
  if (override?.tier !== undefined && !tiers.includes(override.tier)) {
    problems.push({ path: ["tier"], message: tiers.length ? `"${override.tier}" is not a plan of ${brokerId} (known: ${tiers.join(", ")})` : `${brokerId} has no plans to choose from` });
  }
  // Lowering is judged against the plan the override itself selects.
  const base = resolvePolicy(brokerId, override?.tier !== undefined && tiers.includes(override.tier) ? { broker: { tier: override.tier } } : {});
  const check = (path, have, want) => {
    for (const k of WINDOW_KEYS) {
      if (want?.[k] > 0 && have?.[k] > 0 && want[k] > have[k]) {
        problems.push({ path: [...path, k], message: `${want[k]} is above the broker policy (${have[k]}); overrides may only lower limits` });
      }
    }
    for (const w of want?.extraWindows ?? []) {
      const cur = have?.extraWindows?.find((x) => x.windowMs === w.windowMs);
      if (cur && w.limit > cur.limit) problems.push({ path: [...path, "extraWindows"], message: `${w.limit} per ${w.windowMs} ms is above the broker policy (${cur.limit}); overrides may only lower limits` });
    }
  };
  for (const [cls, w] of Object.entries(override?.limits ?? {})) check(["limits", cls], base.limits[cls], w);
  for (const [name, w] of Object.entries(override?.groups ?? {})) {
    if (!base.groups[name]) problems.push({ path: ["groups", name], message: `${brokerId} has no group "${name}" (known: ${Object.keys(base.groups).join(", ") || "none"})` });
    else check(["groups", name], base.groups[name], w);
  }
  if (override?.maxQuoteBatch > base.maxQuoteBatch) problems.push({ path: ["maxQuoteBatch"], message: `${override.maxQuoteBatch} is above the broker policy (${base.maxQuoteBatch}); overrides may only lower limits` });
  return problems;
}

const HTTPS_URL = /^https:\/\/[^\s]+$/;
const ENTITLEMENT_KEYS = new Set(["value", "note", "verified", "source"]);

/**
 * Check a policy table (the shipped one, or a test's) for the rules in brokerPolicies.mjs: every verified figure has an
 * official https source, `pooling` is a known value and is never "allowed" without a poolingNote, `poolingNote` and
 * `dataEntitlement` are well formed (one line of text, a known value, a source for anything verified), and the default
 * plan of a tiered broker exists. Returns readable problems; empty means the table is fine.
 * @param {Readonly<Record<string, any>>} [table]
 * @returns {Array<{ broker: string, path: string, message: string }>}
 */
export function policyTableProblems(table = BROKER_POLICIES) {
  const problems = [];
  const bad = (broker, path, message) => problems.push({ broker, path, message });
  const oneLine = (x) => typeof x === "string" && x.trim().length > 0 && !/[\r\n]/.test(x);
  const checkSpec = (broker, path, spec) => {
    if (typeof spec?.verified !== "boolean") bad(broker, path, "needs a boolean verified flag");
    if (spec?.verified && !HTTPS_URL.test(spec.source ?? "")) bad(broker, path, "a verified figure needs an https source URL");
    for (const k of WINDOW_KEYS) if (spec?.[k] !== undefined && !(spec[k] > 0)) bad(broker, `${path}.${k}`, "must be a positive number");
  };
  const checkBundle = (broker, where, b) => {
    for (const [cls, spec] of Object.entries(b.limits ?? {})) {
      if (!ENDPOINT_CLASSES.includes(cls)) bad(broker, `${where}limits.${cls}`, "is not an endpoint class");
      checkSpec(broker, `${where}limits.${cls}`, spec);
    }
    for (const [name, g] of Object.entries(b.groups ?? {})) {
      checkSpec(broker, `${where}groups.${name}`, g);
      if (!Array.isArray(g.classes) || !g.classes.length || g.classes.some((c) => !ENDPOINT_CLASSES.includes(c))) bad(broker, `${where}groups.${name}.classes`, "must list endpoint classes");
    }
    const f = b.feed;
    if (!f || !("maxConnections" in f) || !("maxSubscriptions" in f)) bad(broker, `${where}feed`, "needs maxConnections and maxSubscriptions (null when unknown)");
    else if (f.verified && !HTTPS_URL.test(f.source ?? "")) bad(broker, `${where}feed`, "a verified feed cap needs an https source URL");
  };
  for (const [broker, p] of Object.entries(table)) {
    if (p.brokerId !== broker) bad(broker, "brokerId", "must equal the table key");
    if (!["allowed", "not-allowed", "unknown"].includes(p.pooling)) bad(broker, "pooling", 'must be "allowed", "not-allowed" or "unknown"');
    if (!oneLine(p.poolingNote)) bad(broker, "poolingNote", "needs a one-line note saying what the review found");
    if (p.dataEntitlement !== undefined) {
      const d = p.dataEntitlement;
      if (!DATA_ENTITLEMENTS.includes(d?.value)) bad(broker, "dataEntitlement.value", `must be one of ${DATA_ENTITLEMENTS.join(", ")}`);
      if (!oneLine(d?.note)) bad(broker, "dataEntitlement.note", "needs a one-line note");
      if (typeof d?.verified !== "boolean") bad(broker, "dataEntitlement.verified", "needs a boolean verified flag");
      if (d?.verified && !HTTPS_URL.test(d.source ?? "")) bad(broker, "dataEntitlement.source", "a verified entitlement needs an https source URL");
      for (const k of Object.keys(d ?? {})) if (!ENTITLEMENT_KEYS.has(k)) bad(broker, `dataEntitlement.${k}`, "is not a known field");
    }
    checkBundle(broker, "", p);
    if (p.tiers) {
      if (!p.defaultTier || !Object.hasOwn(p.tiers, p.defaultTier)) bad(broker, "defaultTier", "must name one of the tiers");
      for (const [id, t] of Object.entries(p.tiers)) {
        checkBundle(broker, `tiers.${id}.`, t);
        if (!oneLine(t.label)) bad(broker, `tiers.${id}.label`, "needs a label");
      }
      // The entry's own figures are the default tier's, so a reader who ignores tiers sees the safe plan.
      const d = p.tiers[p.defaultTier];
      if (d && JSON.stringify([p.limits, p.groups ?? {}, p.maxQuoteBatch, p.feed]) !== JSON.stringify([d.limits, d.groups, d.maxQuoteBatch, d.feed])) bad(broker, "tiers", "the entry's own limits, groups, maxQuoteBatch and feed must equal the default tier's");
    }
  }
  return problems;
}
