/**
 * `fields=` on the biggest list answers (history candles, quotes, instrument search): ask for only the columns you use.
 *
 *   GET /v1/history?symbol=NSE:NIFTY&interval=5m&countback=5000&fields=time,close
 *
 * The rule is the same everywhere:
 *  - a comma-separated list of field names; an unknown name is a 400 that lists the allowed ones (a typo never silently
 *    returns less than you meant);
 *  - some fields are always kept, because an item is useless without them and the data-class label must never be dropped
 *    (`symbol` and `freshness` on quotes, `symbol` on search, `time` on candles);
 *  - only the listed items' fields change. Nothing else in the answer (`meta`, `errors`, `freshness` of the whole history
 *    answer, `partial`) does;
 *  - without `fields` the answer is exactly what it was.
 */
import { BridgeError } from "./errors.mjs";

/**
 * @param {URLSearchParams} query
 * @param {{ allowed: readonly string[], always?: readonly string[] }} o
 * @returns {{ names: string[], keep: Set<string> } | null} null when `fields` was not sent
 */
export function parseFields(query, { allowed, always = [] }) {
  const all = query.getAll("fields");
  if (all.length === 0 || (all.length === 1 && all[0].trim() === "")) return null; // an empty value counts as not sent, as everywhere else
  if (all.length > 1) throw new BridgeError("VALIDATION_FAILED", "Send fields only once, as a comma-separated list.", { errors: [{ path: "fields", message: "repeated" }] });
  const names = [...new Set(all[0].split(",").map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) throw new BridgeError("VALIDATION_FAILED", `fields is empty. Name at least one field: ${allowed.join(", ")}.`, { errors: [{ path: "fields", message: "empty" }] });
  const unknown = names.filter((n) => !allowed.includes(n));
  if (unknown.length) {
    throw new BridgeError("VALIDATION_FAILED", `fields has ${unknown.length === 1 ? "a name" : "names"} this answer does not have: ${unknown.slice(0, 5).join(", ")}. Allowed: ${allowed.join(", ")}.`, {
      errors: [{ path: "fields", message: `unknown: ${unknown.slice(0, 5).join(", ")}`, allowed: [...allowed] }],
    });
  }
  return { names, keep: new Set([...always, ...names]) };
}

/** One item reduced to the kept fields, in its own order. Pure; the input is not changed. */
export function pickFields(item, keep) {
  if (!item || typeof item !== "object") return item;
  const out = {};
  for (const k of Object.keys(item)) if (keep.has(k)) out[k] = item[k];
  return out;
}

/** Every item of a list reduced to the kept fields. */
export const pickAll = (items, parsed) => (parsed ? items.map((i) => pickFields(i, parsed.keep)) : items);
