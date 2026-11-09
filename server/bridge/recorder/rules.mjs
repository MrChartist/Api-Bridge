/**
 * Auto-record rules and presets (pure helpers). A rule says "every trading day, record this, this often, in these hours".
 * The service turns each enabled rule into one recording named `rule-<id>`, whose files keep growing day after day in
 * its own folder.
 */
import { randomBytes, createHash } from "node:crypto";

/** The recording id of a rule. */
export const recordingIdOfRule = (ruleId) => `rule-${ruleId}`;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);

/** A fresh rule id from its name that is not in `taken`. */
export function newRuleId(name, taken) {
  const base = slug(name) || "rule";
  for (let i = 0; i < 20; i += 1) {
    const id = i === 0 && base.length >= 2 && !taken.has(base) ? base : `${base}-${randomBytes(2).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
  return `rule-${randomBytes(4).toString("hex")}`;
}

/** What a rule's recording is built from; a change here restarts the recording's plan (the files stay). */
export function ruleFingerprint(rule) {
  const { id, name, enabled, preset, source, createdAt, updatedAt, ...plan } = rule;
  void id; void name; void enabled; void preset; void source; void createdAt; void updatedAt;
  return createHash("sha256").update(JSON.stringify(plan, Object.keys(plan).sort())).digest("hex").slice(0, 16);
}

/**
 * The one-click presets. A preset is a rule with a plain name; applying it turns auto-record on.
 * `needs` says what the preset reads (so the dashboard can explain it).
 */
export const PRESETS = Object.freeze({
  "index-option-chains": Object.freeze({
    id: "index-option-chains",
    title: "Record index option chains",
    about: "NIFTY and BANKNIFTY option chains, 10 strikes either side of the ATM, current expiry, every 30 seconds, during market hours. The strikes follow the price and the expiry rolls by itself.",
    needs: "a connected broker login (the chain comes from your broker or the live feed)",
    rule: Object.freeze({
      name: "Index option chains",
      kind: "chain",
      underlying: Object.freeze(["NIFTY", "BANKNIFTY"]),
      universe: Object.freeze({ expiries: "current-weekly", strikes: Object.freeze({ around: "atm", count: 10 }), sides: Object.freeze(["CE", "PE"]), includeUnderlying: true, includeFuture: false }),
      everySec: 30,
      schedule: "market-hours",
      format: "csv",
    }),
  }),
  "my-watchlist": Object.freeze({
    id: "my-watchlist",
    title: "Record my watchlist",
    about: "Every symbol of your watchlist collection, one price a second from the live feed, during market hours.",
    needs: "a collection called watchlist (you can pick another name) in the library of collections",
    rule: Object.freeze({
      name: "My watchlist",
      kind: "quotes",
      collection: "watchlist",
      everySec: 1,
      schedule: "market-hours",
      format: "csv",
    }),
  }),
});

export const presetList = () => Object.values(PRESETS).map((p) => ({ id: p.id, title: p.title, about: p.about, needs: p.needs, rule: structuredClone(p.rule) }));
