/**
 * What may be priced from. Orders, price bands, market protection and paper fills must act only on a trusted real-time
 * value: one the Bridge's own broker path answered, labelled `realtime`, not stale, not from a data source.
 *
 * The market service already refuses stale, backup and revalidating answers for the strict purposes (`order`, `risk`,
 * `paper`, `alert`). This is the second check on the CALLER's side, so a caller that forgot the purpose, a fake, or a
 * future change in the service still cannot turn a labelled-stale, delayed, end-of-day, unofficial or plugin value into a
 * price an order or a paper fill uses. It fails closed: a value with no usable freshness label is not trusted.
 */

/** Flags that say a value is not a plain, current, official real-time one. */
const UNTRUSTED_FLAGS = Object.freeze(["stale", "delayed", "eod", "unofficial", "plugin", "untrusted_source", "last-bar-provisional"]);

/** The service's labels for a value that came from a data source rather than a broker account or the stream. */
const UNTRUSTED_SOURCES = Object.freeze(["backup"]);

/**
 * Is this item (an `ltp`/`quotes`/`depth` item with a `freshness` label) a trusted real-time value?
 * @param {{ freshness?: { class?: string, stale?: boolean, source?: string, official?: boolean, revalidating?: boolean, flags?: string[] } } | null | undefined} item
 */
export function isTrustedRealtime(item) {
  const f = item?.freshness;
  if (!f || typeof f !== "object") return false;
  if (f.class !== "realtime") return false;
  if (f.stale === true || f.revalidating === true) return false;
  if (f.official === false) return false;
  if (typeof f.source === "string" && UNTRUSTED_SOURCES.includes(f.source)) return false;
  if (Array.isArray(f.flags) && f.flags.some((x) => UNTRUSTED_FLAGS.includes(x))) return false;
  return true;
}

/** The item's last price when it is a finite positive number from a trusted real-time value, else null. */
export function trustedLtp(item) {
  if (!isTrustedRealtime(item)) return null;
  const v = item.ltp;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
