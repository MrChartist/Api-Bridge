/**
 * After a restore: how many webhook subscriptions the restored folder lists. A subscription's URL and signing secret live
 * only in the encrypted secrets store (never in a backup file of their own), so after a restore on another computer, or
 * without secrets.enc and the original master key, each one needs its secret again. Reads one small file; never throws.
 */
import { join } from "node:path";
import { readLinesSync } from "../../lib/jsonl.mjs";

/** @param {string} dataDir @returns {number} */
export function webhookSecretsNeeded(dataDir) {
  try {
    const { items } = readLinesSync(join(dataDir, "events", "subscriptions.jsonl"));
    const live = new Set();
    for (const r of items) {
      if (r?.op === "put" && typeof r.r?.id === "string") live.add(r.r.id);
      else if (r?.op === "del" && typeof r.id === "string") live.delete(r.id);
    }
    return live.size;
  } catch {
    return 0;
  }
}
