/**
 * What a collection is, and the checks a collection definition passes before it is stored.
 *
 *   static           { name, kind: "static", symbols: ["NSE:RELIANCE", ...] }              a fixed list of canonical symbols
 *   option-universe  { name, kind: "option-universe", universe: {
 *                       underlying: "NIFTY",
 *                       expiries: "current-weekly" | "next-weekly" | "current-monthly" | "all-weekly" | ["2026-11-24", ...],
 *                       strikes: { around: "atm", count: 10 } | { from: 24000, to: 26000 },
 *                       sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false } }
 *
 * Both have `description` and `tags`. Symbols are checked for FORM only here (core/symbolFormat.mjs, no data needed);
 * whether they exist in a broker's instrument master is not checked at write time (the masters change daily).
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { isIsoDate } from "../reference/calendar.mjs";
import { NAME_RE, normaliseTags } from "./tags.mjs";

export const KINDS = Object.freeze(["static", "option-universe"]);
export const EXPIRY_RULES = Object.freeze(["current-weekly", "next-weekly", "current-monthly", "all-weekly"]);
export const SIDES = Object.freeze(["CE", "PE"]);
/** Names that cannot be a collection name because they are routes. */
export const RESERVED_NAMES = Object.freeze(["import", "export"]);
export const MAX_EXPLICIT_EXPIRIES = 60;
export const MAX_STRIKES_EACH_SIDE = 200;

const UNDERLYING_RE = /^[A-Z0-9][A-Z0-9&_-]{0,29}$/;
const isoDate = z.string().refine(isIsoDate, "a real date such as 2026-11-24");

const strikesSchema = z.union([
  z
    .object({ around: z.literal("atm"), count: z.number().int().min(1).max(MAX_STRIKES_EACH_SIDE).default(10) })
    .strict(),
  z
    .object({ from: z.number().positive().max(10_000_000), to: z.number().positive().max(10_000_000) })
    .strict()
    .refine((s) => s.from <= s.to, { message: "from must not be above to" }),
]);

export const universeSchema = z
  .object({
    underlying: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(UNDERLYING_RE, "an index or stock name such as NIFTY or RELIANCE (no exchange prefix)")),
    expiries: z.union([z.enum(EXPIRY_RULES), z.array(isoDate).min(1).max(MAX_EXPLICIT_EXPIRIES)]).default("current-weekly"),
    strikes: strikesSchema.default({ around: "atm", count: 10 }),
    sides: z
      .array(z.enum(SIDES))
      .min(1)
      .max(2)
      .default(["CE", "PE"])
      .transform((s) => SIDES.filter((x) => s.includes(x))),
    includeUnderlying: z.boolean().default(true),
    includeFuture: z.boolean().default(false),
  })
  .strict()
  .transform((u) => (Array.isArray(u.expiries) ? { ...u, expiries: [...new Set(u.expiries)].sort() } : u));

const nameField = z.string().trim().regex(NAME_RE, "1 to 64 characters: letters, digits and _ . - (no spaces), starting with a letter or digit");
const descriptionField = z.string().trim().max(500);

const baseShape = {
  description: descriptionField.optional(),
  tags: z.array(z.string().max(40)).max(40).optional(),
};

const createSchema = z
  .object({
    name: nameField,
    kind: z.enum(KINDS).optional(),
    symbols: z.array(z.string().min(1).max(80)).max(50_000).optional(),
    universe: z.unknown().optional(),
    ...baseShape,
  })
  .strict();

const patchSchema = z
  .object({
    name: nameField.optional(),
    kind: z.enum(KINDS).optional(),
    symbols: z.array(z.string().min(1).max(80)).max(50_000).optional(),
    universe: z.unknown().optional(),
    ...baseShape,
  })
  .strict();

/** Canonical symbols from lenient input, in order, without duplicates. Throws VALIDATION_FAILED naming the first bad entries. */
export function canonicalSymbols(list, path = "symbols", { maxSymbols = 50_000 } = {}) {
  const out = [];
  const seen = new Set();
  const errors = [];
  for (const [i, raw] of list.entries()) {
    if (typeof raw !== "string") {
      errors.push({ path: `${path}.${i}`, message: "a symbol must be text" });
      continue;
    }
    try {
      const c = parseSymbol(raw.trim()).canonical;
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    } catch (err) {
      errors.push({ path: `${path}.${i}`, message: `${String(raw).slice(0, 40)}: ${err?.detail ?? "not a symbol the Bridge understands"}` });
    }
    if (errors.length >= 20) break;
  }
  if (errors.length) {
    throw new BridgeError("VALIDATION_FAILED", `${errors.length === 1 ? "A symbol is" : "Some symbols are"} not in a form the Bridge understands. Use canonical symbols such as NSE:RELIANCE or NFO:NIFTY-2026-11-24-25000-CE.`, { errors });
  }
  if (out.length > maxSymbols) throw new BridgeError("VALIDATION_FAILED", `A collection holds at most ${maxSymbols} symbols (this one has ${out.length}). Split it into several collections.`, { errors: [{ path, message: `more than ${maxSymbols} symbols` }] });
  return out;
}

/** A VALIDATION_FAILED whose message names the first problem (the whole list is in `errors`). */
function problem(zodError, what = "Some fields are missing or not valid") {
  const i = zodError.issues?.[0];
  const where = i ? ` ${(i.path ?? []).join(".") || "(root)"}: ${i.message}.` : "";
  return fromValidation(zodError, `${what}.${where}`);
}

export function parseUniverse(raw) {
  const r = universeSchema.safeParse(raw);
  if (!r.success) throw problem(r.error, "The option universe is not valid");
  return r.data;
}

/** Validate a name on its own (rename, duplicate, import). */
export function checkName(name, path = "name") {
  const r = nameField.safeParse(name);
  if (!r.success) throw new BridgeError("VALIDATION_FAILED", `${path} must be ${r.error.issues[0]?.message ?? "a valid name"}.`, { errors: [{ path, message: r.error.issues[0]?.message ?? "not valid" }] });
  if (RESERVED_NAMES.includes(r.data.toLowerCase())) throw new BridgeError("VALIDATION_FAILED", `"${r.data}" is a reserved word. Choose another name.`, { errors: [{ path, message: "reserved" }] });
  return r.data;
}

/**
 * A new collection definition, checked and normalised: { name, description, tags, kind, symbols | universe }.
 * @param {unknown} body
 * @param {{ maxSymbols?: number }} [o]
 */
export function parseCreate(body, { maxSymbols = 5000 } = {}) {
  const r = createSchema.safeParse(body);
  if (!r.success) throw problem(r.error);
  const d = r.data;
  const name = checkName(d.name);
  const kind = d.kind ?? (d.universe !== undefined ? "option-universe" : "static");
  const out = { name, description: d.description ?? "", tags: normaliseTags(d.tags), kind };
  if (kind === "static") {
    if (d.universe !== undefined) throw new BridgeError("VALIDATION_FAILED", "A static collection holds a symbols list, not a universe.", { errors: [{ path: "universe", message: "not for a static collection" }] });
    out.symbols = canonicalSymbols(d.symbols ?? [], "symbols", { maxSymbols });
  } else {
    if (d.symbols !== undefined) throw new BridgeError("VALIDATION_FAILED", "An option universe holds a universe rule, not a symbols list.", { errors: [{ path: "symbols", message: "not for an option-universe collection" }] });
    if (d.universe === undefined) throw new BridgeError("VALIDATION_FAILED", "An option universe needs a universe: { underlying, expiries, strikes, sides }.", { errors: [{ path: "universe", message: "required" }] });
    out.universe = parseUniverse(d.universe);
  }
  return out;
}

/**
 * A change to a collection (PATCH). Returns only the fields that were given, checked against the existing kind.
 * @param {unknown} body
 * @param {{ kind: string }} existing
 * @param {{ maxSymbols?: number }} [o]
 */
export function parsePatch(body, existing, { maxSymbols = 5000 } = {}) {
  const r = patchSchema.safeParse(body);
  if (!r.success) throw problem(r.error);
  const d = r.data;
  const out = {};
  if (d.kind !== undefined && d.kind !== existing.kind) throw new BridgeError("VALIDATION_FAILED", "The kind of a collection cannot be changed. Make a new collection instead.", { errors: [{ path: "kind", message: "cannot change" }] });
  if (d.name !== undefined) out.name = checkName(d.name);
  if (d.description !== undefined) out.description = d.description;
  if (d.tags !== undefined) out.tags = normaliseTags(d.tags);
  if (d.symbols !== undefined) {
    if (existing.kind !== "static") throw new BridgeError("VALIDATION_FAILED", "An option universe has no symbols list.", { errors: [{ path: "symbols", message: "not for an option-universe collection" }] });
    out.symbols = canonicalSymbols(d.symbols, "symbols", { maxSymbols });
  }
  if (d.universe !== undefined) {
    if (existing.kind !== "option-universe") throw new BridgeError("VALIDATION_FAILED", "A static collection has no universe.", { errors: [{ path: "universe", message: "not for a static collection" }] });
    out.universe = parseUniverse(d.universe);
  }
  if (!Object.keys(out).length) throw new BridgeError("VALIDATION_FAILED", "Send at least one of: name, description, tags, symbols, universe.");
  return out;
}
