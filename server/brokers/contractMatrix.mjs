/**
 * The per-broker contract matrix: the shared harness result plus the order-safety cases, for every registered adapter.
 * docs/BROKERS.md and the verification test are generated from this, so the table can never claim more than the tests
 * prove, and a missing fixture shows up as "needs fixture" instead of being hidden.
 */
import { createBrokerRegistry } from "./registry.mjs";
import { loadFixtures } from "./contractHarness.mjs";
import { validateAdapter } from "./contract.mjs";
import { ORDER_CASES, orderCaseFailures, runOrderSafetyCases } from "./contractOrderCases.mjs";
import { BROKER_NAMES } from "../bridge/accounts/brokerInfo.mjs";
import { LEVEL_ORDER, expectedLevel, levelCounts, loadVerification, verificationOf } from "./verification.mjs";

export const CASE_LABELS = Object.freeze({
  missingOrderId: "No order id",
  garbledReply: "Garbled reply",
  lostReply: "Lost reply",
  refusedBody: "Refusal",
  stopLoss: "Stop-loss",
  cancelVariety: "Cancel variety",
  sessionExpired: "Session ended",
});

/**
 * @typedef {{ id: string, name: string, hasOrders: boolean,
 *   cases: Record<string, { state: string, problems: string[], detail: string }>, failures: string[], gaps: string[],
 *   contractComplete: boolean }} MatrixRow
 */

/**
 * Run the order-safety cases for every adapter (recorded replies, no network) and check that it is on the strict contract.
 * The shared capability harness is run by each broker's own test file (it needs per-broker setup such as a stubbed
 * instrument cache), and CI fails when any of those fail, so it is not repeated here.
 */
let memo = null;
export function buildContractMatrix(opts = {}) {
  // Run once per process: several adapters remember a dead session after the session case, so a second run in the same
  // process would start from that state. Callers share the one result.
  if (opts.registry) return computeMatrix(opts);
  memo ??= computeMatrix(opts);
  return memo;
}

async function computeMatrix({ registry = createBrokerRegistry() } = {}) {
  /** @type {MatrixRow[]} */
  const rows = [];
  for (const id of [...registry.list()].sort()) {
    const adapter = registry.get(id);
    const fixtures = loadFixtures(id);
    const strict = validateAdapter(adapter, { strict: true });
    const orders = await runOrderSafetyCases(adapter, fixtures);
    const failures = [...strict.errors.map((e) => `${id}: ${e}`), ...orderCaseFailures(orders)];
    const gaps = Object.entries(orders.cases).filter(([, r]) => r.state === "needs-fixture").map(([name]) => name);
    rows.push({
      id,
      name: BROKER_NAMES[id] ?? id,
      hasOrders: orders.hasOrders,
      cases: orders.cases,
      failures,
      gaps,
      contractComplete: failures.length === 0 && gaps.length === 0,
    });
  }
  return rows;
}

const CELL = { pass: "pass", fail: "FAIL", "needs-fixture": "needs fixture", "n/a": "n/a" };

/**
 * The verification section of docs/BROKERS.md (everything between the generated markers).
 * @param {MatrixRow[]} rows
 */
export function renderVerificationSection(rows) {
  const v = loadVerification();
  const counts = levelCounts(rows.map((r) => r.id));
  const lines = [];
  lines.push("### Verification ladder");
  lines.push("");
  lines.push(`${rows.length} brokers: ${LEVEL_ORDER.map((l) => `${counts[l]} ${v.levels.find((x) => x.id === l).label.toLowerCase()}`).join(", ")}. The levels, from \`server/brokers/verification.json\`:`);
  lines.push("");
  for (const l of v.levels) lines.push(`- **${l.label}** (\`${l.id}\`): ${l.meaning}`);
  lines.push("");
  lines.push("To move a broker up the ladder, follow [broker-verification.md](broker-verification.md).");
  lines.push("");
  lines.push("| Broker | id | Level | Verified on | By | Order cases missing |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    const rec = verificationOf(r.id);
    const missing = r.hasOrders ? (r.gaps.length ? r.gaps.map((g) => CASE_LABELS[g]).join(", ") : "none") : "no order methods";
    lines.push(`| ${r.name} | \`${r.id}\` | ${rec.label} | ${rec.verifiedOn === undefined ? "n/a" : rec.verifiedOn ?? "not recorded"} | ${rec.verifiedBy ?? "n/a"} | ${missing} |`);
  }
  lines.push("");
  lines.push("### Order-safety contract cases");
  lines.push("");
  lines.push("Every adapter with order methods is run against these cases on recorded replies (no network). A refused or id-less reply must never come back as a placed order, a lost reply must be sent once and read as an unknown outcome, a stop-loss must carry its trigger price, and the broker's own \"session ended\" reply must log the account out.");
  lines.push("");
  lines.push("`needs fixture` means the broker's documented payload for that case has not been recorded yet. It is a gap, shown on purpose, and the broker stays at Beta until it is filled. `n/a` means the broker has no such call or the adapter does not offer it.");
  lines.push("");
  lines.push(`| Broker | ${ORDER_CASES.map((c) => CASE_LABELS[c]).join(" | ")} |`);
  lines.push(`|---|${ORDER_CASES.map(() => "---").join("|")}|`);
  for (const r of rows) {
    if (!r.hasOrders) {
      lines.push(`| ${r.name} | ${ORDER_CASES.map(() => "n/a").join(" | ")} |`);
      continue;
    }
    lines.push(`| ${r.name} | ${ORDER_CASES.map((c) => CELL[r.cases[c]?.state] ?? "?").join(" | ")} |`);
  }
  return lines.join("\n");
}

export const SECTION_START = "<!-- verification:start (generated by scripts/generate-broker-verification.mjs, do not edit) -->";
export const SECTION_END = "<!-- verification:end -->";

const STATUS_TEXT = Object.freeze({
  beta: "Beta: not yet verified with a live account",
  contract: "Contract-tested: not yet verified with a live account",
  sandbox: "Sandbox-verified: not yet verified with a live account",
  "live-verified": "Verified with a live account",
});

/** The Status cell of every capability-table row follows the verification file. */
function syncStatusCells(markdown) {
  return markdown
    .split("\n")
    .map((line) => {
      const m = /^\| [^|]+ \| `([a-z0-9]+)` \|.* \| (Beta: [^|]*|Contract-tested: [^|]*|Sandbox-verified: [^|]*|Verified with a live account) \|$/.exec(line);
      if (!m) return line;
      return line.slice(0, line.length - m[2].length - 2) + `${STATUS_TEXT[verificationOf(m[1]).level]} |`;
    })
    .join("\n");
}

/** Replace the generated section inside a BROKERS.md text (or append it before "## Limits" when absent). */
export function spliceVerificationSection(markdown, rows) {
  markdown = syncStatusCells(markdown);
  const block = `${SECTION_START}\n${renderVerificationSection(rows)}\n${SECTION_END}`;
  const a = markdown.indexOf(SECTION_START);
  const b = markdown.indexOf(SECTION_END);
  if (a !== -1 && b !== -1 && b > a) return markdown.slice(0, a) + block + markdown.slice(b + SECTION_END.length);
  const anchor = markdown.indexOf("## Limits, live feed and data plans");
  if (anchor === -1) return `${markdown.trimEnd()}\n\n${block}\n`;
  return `${markdown.slice(0, anchor)}${block}\n\n${markdown.slice(anchor)}`;
}

/** The level file as the code says it should be: beta/contract recomputed, manual levels kept (when still allowed). */
export function expectedVerificationFile(rows) {
  const current = loadVerification();
  const brokers = {};
  for (const r of rows) {
    const rec = current.brokers[r.id] ?? { level: "beta" };
    const level = expectedLevel(r, rec.level);
    const next = { level };
    if (level === rec.level) for (const k of ["verifiedOn", "verifiedBy", "evidence", "note"]) if (rec[k] !== undefined) next[k] = rec[k];
    brokers[r.id] = next;
  }
  return { ...current, brokers };
}
