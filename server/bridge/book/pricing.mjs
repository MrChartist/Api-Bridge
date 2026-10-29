/**
 * The pricing wall (stream S27, docs/spec/p1-12-guard-participants.md §3.6). A holder's legs are priced ONLY from that
 * holder's own sources, never through another holder's account (BRD §8.3: family members are different users under
 * the brokers' personal-use terms):
 *
 *   1. a connected account of the holder with `quotes` (one with `optionChain` first): reads pinned to it (`accountId`);
 *   2. else, when every account of the holder is a paper account: the paper engine's own source (an unpinned read, as
 *      paper fills are priced today; paper is a local simulation, so no other person's broker session is involved);
 *   3. else: broker-reported figures only (ltp and P&L from each position row) and no Greeks (`NO_DATA_ACCOUNT`).
 *
 * The data account must also be one the caller's key may use: a key limited to some accounts never spends another
 * account's market-data entitlement.
 */
import { noDataReason } from "../dashboard/book-core.js";

const PAPER = "paper";

/**
 * @param {Array<{ id: string, broker: string, enabled?: boolean }>} holderAccounts  every configured account of the holder
 * @param {{ summaries: Map<string, { capabilities?: string[], session?: { state?: string } }>, canSee: (id: string) => boolean, label: string }} o
 * @returns {{ kind: "account", accountId: string, broker: string } | { kind: "paper" } | { kind: "none", code: "NO_DATA_ACCOUNT", reason: string }}
 */
export function priceSourceFor(holderAccounts, { summaries, canSee, label }) {
  const live = holderAccounts.filter((a) => a.broker !== PAPER && a.enabled !== false && canSee(a.id));
  const usable = live.filter((a) => {
    const s = summaries.get(a.id);
    return s?.session?.state === "connected" && (s.capabilities ?? []).includes("quotes");
  });
  const best = usable.find((a) => (summaries.get(a.id)?.capabilities ?? []).includes("optionChain")) ?? usable[0];
  if (best) return { kind: "account", accountId: best.id, broker: best.broker };
  if (holderAccounts.length && holderAccounts.every((a) => a.broker === PAPER)) return { kind: "paper" };
  return { kind: "none", code: "NO_DATA_ACCOUNT", reason: noDataReason(label) };
}

/** The ReadOptions for a holder's market-data reads (pinned for an account source; unpinned for paper). */
export function readOptionsFor(source) {
  if (source.kind === "account") return { accountId: source.accountId, maxAgeMs: 5000, priority: "interactive" };
  if (source.kind === "paper") return { maxAgeMs: 5000, priority: "interactive" };
  return null;
}
