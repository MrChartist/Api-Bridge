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
 */
import { ENDPOINT_CLASSES } from "../core/contracts.mjs";
import { SEBI_UNREGISTERED_OPS_CEILING } from "../core/config.mjs";
import { BROKER_POLICIES, DEFAULT_CLASS_LIMITS, DEFAULT_GROUP_CLASSES, DEFAULT_MAX_QUOTE_BATCH, PAPER_POLICY } from "./brokerPolicies.mjs";
import { windowsFromSpec } from "./tokenBucket.mjs";

export const WINDOW_KEYS = Object.freeze(["perSecond", "perMinute", "perDay"]);

/**
 * @typedef {{ perSecond?: number, perMinute?: number, perDay?: number, extraWindows?: Array<{ windowMs: number, limit: number }> }} Windows
 * @typedef {Windows & { verified: boolean, source?: string, defaulted?: boolean, derivedPerSecond?: boolean, lowered?: boolean }} EffectiveSpec
 * @typedef {EffectiveSpec & { classes: string[] }} EffectiveGroup
 * @typedef {{ brokerId: string, known: boolean, limits: Record<string, EffectiveSpec>, groups: Record<string, EffectiveGroup>,
 *   maxQuoteBatch: number, feed: { maxConnections: number|null, maxSubscriptions: number|null },
 *   pooling: "allowed"|"not-allowed"|"unknown", maxModificationsPerOrder: number|null, notes?: string, unlimited?: boolean }} EffectivePolicy
 * @typedef {{ limits?: Partial<Record<string, Windows>>, groups?: Record<string, Windows>, maxQuoteBatch?: number }} PolicyOverride
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
  const base = raw ?? { brokerId, limits: {}, maxQuoteBatch: DEFAULT_MAX_QUOTE_BATCH, feed: { maxConnections: null, maxSubscriptions: null }, pooling: "unknown", maxModificationsPerOrder: null };

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
    maxModificationsPerOrder: base.maxModificationsPerOrder ?? null,
  };
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
  const base = resolvePolicy(brokerId);
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
