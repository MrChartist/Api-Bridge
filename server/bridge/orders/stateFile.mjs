/**
 * The order service's state file, <dataDir>/orders/state.json: idempotency records, the clientOrderId map and the live
 * order records. Holds no secrets. Writes are atomic and synced (temp file, fsync, rename, fsync of the folder; the one
 * shared helper), owner-only permissions.
 *
 * A file that is empty, cut off or of an unknown version is NEVER silently replaced. It is moved aside as
 * state.json.corrupt-<time> (the shared quarantine), and a marker file `state-damaged.json` is written next to it. While
 * the marker exists the Bridge refuses LIVE orders (ORDER_STATE_DAMAGED) because it no longer knows which client order
 * ids it already sent: a retried alert could place a second real order. Paper orders keep working from the fresh state.
 * The marker survives a restart, and goes only when the owner has checked the broker's order book and acknowledged
 * (POST /v1/orders/state/acknowledge, or `mc-bridge orders acknowledge-state`).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { loadJsonOrQuarantine } from "../../lib/safeStore.mjs";

export const STATE_VERSION = 1;
export const DAMAGED_MARKER = "state-damaged.json";

/**
 * @param {string} path
 * @param {{ logger?: { warn(msg: string, f?: object): void, error(msg: string, f?: object): void }, now?: () => number }} [opts]
 */
export function createStateFile(path, { logger, now = () => Date.now() } = {}) {
  const markerPath = join(dirname(path), DAMAGED_MARKER);
  /** @type {{ at: string, file: string, movedTo: string | null, reason: string } | null} */
  let damaged = null;
  try {
    if (existsSync(markerPath)) damaged = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    // A marker that cannot be read still means "damaged": fail closed.
    damaged = { at: new Date(now()).toISOString(), file: path, movedTo: null, reason: "the damage marker itself could not be read" };
  }
  return {
    path,
    /** The damage that is still waiting for the owner, or null. */
    damage: () => (damaged ? { ...damaged } : null),
    /** The owner checked the order book: clear the marker. @returns {boolean} whether there was one */
    acknowledge() {
      const had = damaged !== null;
      rmSync(markerPath, { force: true });
      damaged = null;
      return had;
    },
    /** @returns {object | null} the saved object, or null when there is none or it was damaged (and set aside) */
    read() {
      const r = loadJsonOrQuarantine(path, {
        what: "order records (orders/state.json)",
        log: logger,
        now: now(),
        validate: (v) => (v && typeof v === "object" && v.version === STATE_VERSION) || "has an unknown version or format",
      });
      if (r.quarantinedTo !== null || (r.reason && !r.missing)) {
        damaged = { at: new Date(now()).toISOString(), file: path, movedTo: r.quarantinedTo, reason: r.reason ?? "damaged" };
        try {
          writeFileAtomic(markerPath, `${JSON.stringify(damaged)}\n`);
        } catch (err) {
          logger?.error("the order-state damage marker could not be written; live orders are refused until the Bridge restarts", { err: String(err?.message ?? err) });
        }
        logger?.error("Order records were damaged and set aside. Paper orders continue; live orders are refused until you check the broker's order book and acknowledge (mc-bridge orders acknowledge-state).", { movedTo: r.quarantinedTo });
      }
      return r.value ?? null;
    },
    /** Write atomically. Never throws (a failed write is logged). @returns {boolean} */
    write(data) {
      try {
        writeFileAtomic(path, JSON.stringify({ version: STATE_VERSION, ...data }));
        return true;
      } catch (err) {
        logger?.error("orders state file could not be written", { path, err: String(err?.message ?? err), code: err?.code });
        return false;
      }
    },
  };
}
