#!/usr/bin/env node
/**
 * Before / after tables from scripts/perf/run.mjs results (docs/perf/README.md).
 *
 *   node scripts/perf/table.mjs --before b1.json,b2.json --after a1.json,a2.json
 *
 * Each cell shows the mean of the rounds, and the rounds themselves in brackets when there are several (the spread
 * between rounds is the noise). Prints Markdown.
 */
import { readFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const load = (list) => (list ?? "").split(",").filter(Boolean).map((f) => JSON.parse(readFileSync(f, "utf8")));
const before = load(arg("before"));
const after = load(arg("after"));
if (!before.length || !after.length) {
  console.error("Give --before and --after (comma-separated result files).");
  process.exit(2);
}

const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const fmt = (xs, unit = "") => {
  const m = mean(xs);
  if (m === null) return "–";
  const r = Math.round(m);
  return xs.length > 1 ? `${r}${unit} (${xs.map((x) => (Number.isFinite(x) ? Math.round(x) : "–")).join(", ")})` : `${r}${unit}`;
};
const pageOf = (runs, id) => runs.map((r) => r.pages.find((p) => p.page === id)).filter(Boolean);
const pick = (rows, f) => rows.map(f);

const metrics = [
  ["First paint, ms", (p) => p.fcp],
  ["First data, ms", (p) => p.firstData],
  ["Switch (first), ms", (p) => p.switchFirst],
  ["Switch (from cache), ms", (p) => p.switchCached],
  ["JS KB", (p) => p.jsKB],
  ["REST / min", (p) => p.restPerMin],
  ["Duplicates", (p) => p.duplicates],
  ["Broker / min (raw)", (p) => p.brokerPerMinRaw],
  ["Long tasks (count / ms)", null],
  ["Tick to cell p50 / p95, ms", null],
];

const ids = before[0].pages.map((p) => p.page);
const out = [];
out.push("| Page | Figure | Before | After |", "|---|---|---|---|");
for (const id of ids) {
  const b = pageOf(before, id);
  const a = pageOf(after, id);
  if (!b.length || !a.length) continue;
  for (const [label, f] of metrics) {
    let bv;
    let av;
    if (label.startsWith("Long tasks")) {
      bv = `${fmt(pick(b, (p) => p.longTasks))} / ${fmt(pick(b, (p) => p.longTaskMs))}`;
      av = `${fmt(pick(a, (p) => p.longTasks))} / ${fmt(pick(a, (p) => p.longTaskMs))}`;
    } else if (label.startsWith("Tick")) {
      const has = (rows) => rows.some((p) => p.tickToCell?.n > 0);
      bv = has(b) ? `${fmt(pick(b, (p) => p.tickToCell.p50))} / ${fmt(pick(b, (p) => p.tickToCell.p95))}` : "–";
      av = has(a) ? `${fmt(pick(a, (p) => p.tickToCell.p50))} / ${fmt(pick(a, (p) => p.tickToCell.p95))}` : "–";
    } else {
      bv = fmt(pick(b, f));
      av = fmt(pick(a, f));
    }
    out.push(`| ${id} | ${label} | ${bv} | ${av} |`);
  }
}
const busy = (runs) => runs.map((r) => r.busiest).filter(Boolean);
const idle = (runs) => runs.map((r) => r.idle).filter(Boolean);
out.push("", "| Scenario | Before | After |", "|---|---|---|");
out.push(`| Idle Bridge (no page), broker calls / min | ${fmt(idle(before).map((x) => x.brokerPerMin))} | ${fmt(idle(after).map((x) => x.brokerPerMin))} |`);
out.push(`| Busiest (Chain + OI + Strategy + Live events), broker calls / min, raw | ${fmt(busy(before).map((x) => x.brokerPerMinRaw))} | ${fmt(busy(after).map((x) => x.brokerPerMinRaw))} |`);
const cls = (runs, k) => runs.map((x) => x.byClass?.[k] ?? 0);
for (const k of ["chain", "quote", "history", "depth"]) {
  const bb = cls(busy(before), k);
  const aa = cls(busy(after), k);
  if (bb.every((x) => !x) && aa.every((x) => !x)) continue;
  out.push(`| Busiest: ${k} calls in the window | ${fmt(bb)} | ${fmt(aa)} |`);
}
const bm = mean(busy(before).map((x) => x.brokerPerMinRaw));
const am = mean(busy(after).map((x) => x.brokerPerMinRaw));
if (bm) out.push("", `Busiest scenario: ${Math.round((1 - am / bm) * 100)} % fewer broker calls (raw, background jobs included).`);
console.log(out.join("\n"));
