/**
 * Which brokers can record what (docs/spec/p1-01-recorder.md §5.2–5.3, §7.1 panel 5): one row per adapter in the
 * broker registry plus the demo broker, from the broker policy table, each adapter's declared feed and the planner
 * with the default `recorder` config. scripts/recorder-feasibility.mjs prints the same rows as the doc table, and
 * GET /v1/options/recorder?feasibility=true returns them for the Data recorder page, so the page, the doc and the
 * code cannot disagree. Pure apart from building the registry once (memoised: the rows depend on code only).
 */
import { declaredCapabilities } from "../../brokers/contract.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { BROKER_NAMES } from "../accounts/brokerInfo.mjs";
import { DEMO_POLICY } from "../demo/demoMode.mjs";
import { resolvePolicy } from "../ratelimit/policy.mjs";
import { parseRecorderConfig } from "./config.mjs";
import { feasibilityCells, feasibilityRow } from "./plan.mjs";

/** The rows for every adapter (sorted by name) plus demo, last. */
export function feasibilityRows() {
  const cfg = parseRecorderConfig({});
  const registry = createBrokerRegistry();
  const rows = registry
    .list()
    .map((id) => feasibilityRow({ broker: id, policy: resolvePolicy(id), hasFeed: declaredCapabilities(registry.get(id)).includes("feed"), cfg, label: BROKER_NAMES[id] ?? id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  rows.push(feasibilityRow({ broker: "demo", policy: resolvePolicy("demo", {}, { demo: DEMO_POLICY }), hasFeed: true, cfg, label: "Demo (sample data)" }));
  return rows;
}

let cached = null;
/**
 * The rows in the API shape: { broker, label, feed, rest, indices, stocks, restAllowed, indexByStream, indexByRest,
 * indexRefused, stocksTotal }. Computed once per process.
 */
export function feasibilityTableRows() {
  cached ??= Object.freeze(
    feasibilityRows().map((r) =>
      Object.freeze({
        broker: r.broker,
        label: r.label,
        ...feasibilityCells(r),
        restAllowed: Boolean(r.restAllowed),
        indexByStream: r.indexByStream,
        indexByRest: r.indexByRest,
        indexRefused: r.indexRefused,
        stocksTotal: r.stocksByStream + r.stocksByRest,
      }),
    ),
  );
  return cached;
}
