/**
 * The `book` config section (stream S27, docs/spec/p1-12-guard-participants.md §2.6). All optional; zod `.strict()`.
 *
 *   "book": {
 *     "family": { "name": "Family", "relationships": ["self", "spouse", "dependent-child", "dependent-parent"] },
 *     "untaggedHolder": "self",   // accounts with no holder count as this holder (single-user installs keep working)
 *     "holders": {},              // optional locks: { "spouse": { "relationship": "spouse", "label": "Asha" } }
 *     "cacheSeconds": 10,
 *     "exchanges": ["NFO", "BFO"],
 *     "maxAccounts": 20
 *   }
 *
 * The family relationship list is the algo framework's family definition as we read it (self, spouse, dependent
 * children, dependent parents). It is **needs verification** (spec §9.3 V4): HUF is a tag but sits outside the
 * default list, so automation on an HUF account is refused until the owner adds "huf" here (OQ1).
 */
import { z } from "zod";

/** Every relationship a holder may carry (closed here; open in OpenAPI). */
export const RELATIONSHIPS = Object.freeze(["self", "spouse", "dependent-child", "dependent-parent", "huf", "other"]);
/** The default family definition (needs verification, V4). */
export const DEFAULT_FAMILY = Object.freeze(["self", "spouse", "dependent-child", "dependent-parent"]);
/** Plain names for each relationship (UI and messages). */
export const RELATIONSHIP_LABEL = Object.freeze({
  self: "Self",
  spouse: "Spouse",
  "dependent-child": "Dependent child",
  "dependent-parent": "Dependent parent",
  huf: "HUF",
  other: "Other",
});

/** Holder names: the same characters an account's `holder` may use (core/config.mjs). */
export const HOLDER_RE = /^[A-Za-z0-9 _.:-]{1,64}$/;
export const holderName = z.string().trim().min(1).max(64).regex(HOLDER_RE, "holder may use letters, digits, spaces and _ . : -");
export const relationship = z.enum(RELATIONSHIPS);
export const holderTag = z.object({ relationship, label: z.string().trim().max(40).optional() }).strict();

export const BOOK_CONFIG_SCHEMA = z
  .object({
    family: z
      .object({
        name: z.string().trim().min(1).max(40).default("Family"),
        relationships: z.array(relationship).max(RELATIONSHIPS.length).default([...DEFAULT_FAMILY]),
      })
      .strict()
      .prefault({}),
    untaggedHolder: holderName.default("self"),
    holders: z.record(holderName, holderTag).default({}),
    cacheSeconds: z.number().int().min(0).max(120).default(10),
    exchanges: z.array(z.enum(["NFO", "BFO", "MCX", "CDS"])).min(1).default(["NFO", "BFO"]),
    maxAccounts: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const parsed = new WeakMap();
/** The parsed `book` section of the Bridge config (defaults filled in), parsed once per config object. */
export function bookConfig(config) {
  const raw = config?.book;
  if (raw && typeof raw === "object" && parsed.has(raw)) return parsed.get(raw);
  const out = BOOK_CONFIG_SCHEMA.parse(raw ?? {});
  if (raw && typeof raw === "object") parsed.set(raw, out);
  return out;
}
