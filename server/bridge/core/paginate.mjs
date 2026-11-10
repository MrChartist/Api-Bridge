/**
 * One way to page a list route: `?limit=` and `?cursor=` in, `meta.nextCursor` out (null on the last page).
 *
 * The lists these routes page are small, in-memory or on-disk snapshots (downloads, recordings, collections, keys ...), so
 * a page is a slice of the sorted list. The cursor is opaque to callers (base64url of the key of the last item sent and its
 * position): the next page starts after that key, so an item added or removed between two calls does not repeat or skip
 * its neighbours; if the key is gone the position is used.
 *
 * Without `limit` a route returns the whole list (or its own default, `defaultLimit`), so a client that never asked for a
 * page sees what it always saw. A route that pages says so in docs/openapi.yaml with the `Limit` / `ListLimit` and `Cursor`
 * parameters and `meta.nextCursor`.
 *
 *   const { limit, cursor } = pageParams(ctx.query, { defaultLimit: 100 });
 *   const { items, nextCursor } = paginate(rows, { limit, cursor, keyOf: (r) => r.id });
 *   return { data: items, meta: meta(ctx, { nextCursor, total: rows.length }) };
 */
import { BridgeError } from "./errors.mjs";

export const MAX_PAGE_LIMIT = 500;

const bad = (name, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path: name, message }] });

/**
 * @param {URLSearchParams} query
 * @param {{ defaultLimit?: number | null, maxLimit?: number }} [opts]
 * @returns {{ limit: number | null, cursor: string | null }}
 */
export function pageParams(query, { defaultLimit = null, maxLimit = MAX_PAGE_LIMIT } = {}) {
  const l = query.get("limit");
  let limit = defaultLimit;
  if (l !== null && l !== "") {
    if (!/^\d+$/.test(l) || Number(l) < 1 || Number(l) > maxLimit) throw bad("limit", `limit must be a whole number from 1 to ${maxLimit}.`);
    limit = Number(l);
  }
  const c = query.get("cursor");
  if (c !== null && c.length > 512) throw bad("cursor", "cursor is too long.");
  return { limit, cursor: c === null || c === "" ? null : c };
}

const encode = (key, pos) => Buffer.from(JSON.stringify({ k: key, p: pos }), "utf8").toString("base64url");

function decode(cursor) {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (v && typeof v === "object" && Number.isInteger(v.p) && v.p >= 0) return { key: v.k === null || v.k === undefined ? null : String(v.k), pos: v.p };
  } catch {
    /* fall through */
  }
  throw bad("cursor", "cursor is not valid. Use the nextCursor of the previous page unchanged.");
}

/**
 * @template T
 * @param {T[]} rows  the whole list, in the order the route documents
 * @param {{ limit: number | null, cursor: string | null, keyOf: (row: T) => string | number }} opts
 * @returns {{ items: T[], nextCursor: string | null }}
 */
export function paginate(rows, { limit, cursor, keyOf }) {
  let start = 0;
  if (cursor) {
    const c = decode(cursor);
    const at = c.key === null ? -1 : rows.findIndex((r) => String(keyOf(r)) === c.key);
    // The last row sent is gone (deleted or renamed): one row before it may have gone too, so step back one. A repeat is
    // safer than a skipped row.
    start = at >= 0 ? at + 1 : Math.min(Math.max(c.pos - 1, 0), rows.length);
  }
  const end = limit === null ? rows.length : Math.min(rows.length, start + limit);
  const items = rows.slice(start, end);
  const nextCursor = end < rows.length && items.length ? encode(keyOf(items[items.length - 1]), end) : null;
  return { items, nextCursor };
}
