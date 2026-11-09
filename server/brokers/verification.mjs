/**
 * The broker verification ladder, read from server/brokers/verification.json.
 *
 *   beta           recorded samples only: the adapter was written from the broker's documentation and is tested against
 *                  recorded sample replies. Nothing here has touched a real broker.
 *   contract       every contract case passes (the shared harness plus the order-safety cases in contractOrderCases.mjs),
 *                  with no case missing. Derived from code: scripts/generate-broker-verification.mjs rewrites beta or
 *                  contract from the test results, and verification.test.mjs fails when the file and the code disagree.
 *   sandbox        checked against the broker's own sandbox or paper environment. Set by hand, with the evidence.
 *   live-verified  checked with a real account, with the date and who did it. Set by hand, with the evidence.
 *
 * This module has no side effects and no network access: the dashboard, GET /v1/brokers and the docs generator all read
 * the same file through it.
 */
import { readFileSync } from "node:fs";

export const VERIFICATION_FILE = new URL("./verification.json", import.meta.url);

/** Rank of each level; a higher level needs everything the lower ones need. */
export const LEVEL_ORDER = Object.freeze(["beta", "contract", "sandbox", "live-verified"]);

/** Levels a person sets after checking against a real broker; the generator never writes or removes these. */
export const MANUAL_LEVELS = Object.freeze(["sandbox", "live-verified"]);

let cached = null;

/** @returns {{ version: number, levels: Array<{ id: string, label: string, meaning: string }>, brokers: Record<string, { level: string, verifiedOn?: string|null, verifiedBy?: string, evidence?: string, note?: string }> }} */
export function loadVerification({ fresh = false } = {}) {
  if (!cached || fresh) cached = JSON.parse(readFileSync(VERIFICATION_FILE, "utf-8"));
  return cached;
}

const labelOf = (level) => loadVerification().levels.find((l) => l.id === level)?.label ?? level;

/** The recorded level for a broker id ("beta" for a broker the file does not list). */
export function verificationOf(brokerId) {
  const rec = loadVerification().brokers[brokerId];
  const level = rec && LEVEL_ORDER.includes(rec.level) ? rec.level : "beta";
  return {
    level,
    label: labelOf(level),
    ...(rec?.verifiedOn !== undefined ? { verifiedOn: rec.verifiedOn } : {}),
    ...(rec?.verifiedBy ? { verifiedBy: rec.verifiedBy } : {}),
  };
}

/** Whether a broker has been checked end to end with a real account. */
export function isLiveVerified(brokerId) {
  return verificationOf(brokerId).level === "live-verified";
}

/** Brokers verified end to end with a live account. */
export function liveVerifiedBrokers() {
  return Object.entries(loadVerification().brokers)
    .filter(([, rec]) => rec.level === "live-verified")
    .map(([id]) => id)
    .sort();
}

/** How many brokers sit at each level (counts come from the file, never typed by hand). */
export function levelCounts(brokerIds = Object.keys(loadVerification().brokers)) {
  const counts = Object.fromEntries(LEVEL_ORDER.map((l) => [l, 0]));
  for (const id of brokerIds) counts[verificationOf(id).level] += 1;
  return counts;
}

/**
 * What the code says the level of a broker can be, from its contract result: "contract" when every case passes and none
 * is missing, otherwise "beta". A recorded sandbox or live-verified level is allowed only on top of a complete contract.
 * @param {{ contractComplete: boolean }} row
 * @param {string} recorded
 */
export function expectedLevel(row, recorded) {
  if (MANUAL_LEVELS.includes(recorded)) return row.contractComplete ? recorded : "beta";
  return row.contractComplete ? "contract" : "beta";
}
