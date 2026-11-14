/**
 * Tags and names: the small helper that collections, and the datasets and downloaded files of the downloads module,
 * share so a tag means the same thing everywhere.
 *
 *   import { normaliseTags, parseTagFilter, matchesTags, filterByTags, validateName } from "../library/tags.mjs";
 *
 *   normaliseTags(["Nifty", " weekly ", "nifty"])      -> ["nifty", "weekly"]       (lower case, trimmed, unique, sorted)
 *   normaliseTags("a, b")                               -> ["a", "b"]                (a comma separated string works too)
 *   parseTagFilter("weekly,nifty")                      -> ["weekly", "nifty"]       (the `?tag=` query value)
 *   matchesTags(item.tags, ["weekly", "nifty"])         -> true when the item has EVERY wanted tag
 *   filterByTags(list, "weekly", (x) => x.tags)         -> the items that match a `?tag=` value
 *   validateName(name)                                   -> the trimmed name, or throws VALIDATION_FAILED
 *
 * A tag is 1 to 32 characters: lower-case letters, digits and `_ . : -`, starting with a letter or digit. At most 20 per item.
 * Pure functions: no I/O, no service. A dataset keeps `tags: string[]` and a changeable `label`/name next to its fixed id,
 * calls normaliseTags on write, and serves `GET /v1/datasets?tag=a,b` with filterByTags.
 */
import { BridgeError } from "../core/errors.mjs";

export const MAX_TAGS = 20;
export const TAG_RE = /^[a-z0-9][a-z0-9_.:-]{0,31}$/;
/** A name for a collection, dataset or file: letters, digits and `_ . -`, no spaces, 1 to 64 characters. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

/**
 * Tags as stored: lower case, trimmed, unique, sorted. Throws VALIDATION_FAILED naming a bad tag.
 * @param {unknown} input  array of strings, a comma separated string, or nothing
 * @param {string} [path]
 * @returns {string[]}
 */
export function normaliseTags(input, path = "tags") {
  if (input === undefined || input === null || input === "") return [];
  const list = typeof input === "string" ? input.split(",") : input;
  if (!Array.isArray(list)) throw invalid(path, "tags must be a list of words.");
  const out = new Set();
  for (const [i, raw] of list.entries()) {
    if (typeof raw !== "string") throw invalid(`${path}.${i}`, "a tag must be text.");
    const t = raw.trim().toLowerCase();
    if (t === "") continue;
    if (!TAG_RE.test(t)) throw invalid(`${path}.${i}`, `"${raw.slice(0, 40)}" is not a tag: use 1 to 32 letters, digits or _ . : - (for example "weekly" or "nifty-options").`);
    out.add(t);
  }
  if (out.size > MAX_TAGS) throw invalid(path, `at most ${MAX_TAGS} tags.`);
  return [...out].sort();
}

/** The `?tag=` query value (comma separated, or a list) as a clean list; unknown shapes give an empty list. */
export function parseTagFilter(value) {
  const list = Array.isArray(value) ? value.flatMap((v) => String(v).split(",")) : String(value ?? "").split(",");
  return [...new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** True when `itemTags` holds every wanted tag (an empty wish matches everything). */
export function matchesTags(itemTags, wanted) {
  const have = new Set(Array.isArray(itemTags) ? itemTags : []);
  return (wanted ?? []).every((t) => have.has(t));
}

/** Keep the items whose tags match a `?tag=` value (a string, a list or an already parsed list). `tagsOf` reads an item's tags. */
export function filterByTags(items, filter, tagsOf = (x) => x?.tags) {
  const wanted = parseTagFilter(filter);
  return wanted.length ? items.filter((x) => matchesTags(tagsOf(x), wanted)) : items;
}

/** A name for a collection, dataset or file. Returns it trimmed; throws VALIDATION_FAILED otherwise. */
export function validateName(name, path = "name") {
  const n = typeof name === "string" ? name.trim() : "";
  if (!NAME_RE.test(n)) throw invalid(path, `${path} must be 1 to 64 characters: letters, digits and _ . - (no spaces), starting with a letter or digit.`);
  return n;
}
