/**
 * Tags for jobs and datasets. Uses the library module's tag helpers (library/tags.mjs: lower-case, unique, sorted; the
 * same rules for collections, datasets and files) when that module is part of this build, and the same rules here
 * when it is not, so a Bridge without the library still works.
 */
import { BridgeError } from "../core/errors.mjs";

const lib = await import("../library/tags.mjs").catch(() => null);

const TAG_RE = /^[a-z0-9][a-z0-9_.:-]{0,31}$/;

/** Tags as stored. undefined stays undefined. Throws VALIDATION_FAILED naming a bad tag. */
export function normaliseTags(input, path = "tags") {
  if (input === undefined) return undefined;
  if (lib?.normaliseTags) return lib.normaliseTags(input, path);
  const list = Array.isArray(input) ? input : String(input ?? "").split(",");
  const out = new Set();
  for (const raw of list) {
    const t = String(raw ?? "").trim().toLowerCase();
    if (!t) continue;
    if (!TAG_RE.test(t)) throw new BridgeError("VALIDATION_FAILED", `"${t.slice(0, 40)}" is not a valid tag: 1 to 32 lower-case letters, digits or _ . : -.`, { errors: [{ path, message: "bad tag" }] });
    out.add(t);
  }
  if (out.size > 20) throw new BridgeError("VALIDATION_FAILED", "at most 20 tags.", { errors: [{ path, message: "too many tags" }] });
  return [...out].sort();
}

/** Keep the items whose tags hold every tag of a `?tag=a,b` value. */
export function filterByTags(items, filter, tagsOf = (x) => x?.tags) {
  if (lib?.filterByTags) return lib.filterByTags(items, filter, tagsOf);
  const wanted = String(filter ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return wanted.length ? items.filter((x) => wanted.every((t) => (tagsOf(x) ?? []).includes(t))) : items;
}
