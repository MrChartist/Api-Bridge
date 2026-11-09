#!/usr/bin/env node
// Makes a shareable Excel template: the same workbook the dashboard downloads (Setup, Watchlist, Positions, Holdings,
// Funds, Orders, Feed), with a sample watchlist and NO key. Hand it to someone: they paste their own read-only key into
// the yellow cell on Setup. It needs nothing but Node (no npm install), and it never contacts a Bridge.
//
//   node integrations/excel/make-template.mjs [out.xlsx] [--host http://127.0.0.1:4300] [--only watchlist,positions]
//
// --only keeps just those sheets (watchlist, positions, holdings, funds, orders).
import { writeFileSync } from "node:fs";
import { bridgeWorkbook, SHEET_CHOICES } from "../../server/bridge/dashboard/workbook-core.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const host = flag("--host") ?? "http://127.0.0.1:4300";
const only = flag("--only");
const out = args[0] ?? "bridge-template.xlsx";
const include = Object.fromEntries(SHEET_CHOICES.map((c) => [c.id, only ? only.split(",").includes(c.id) : true]));
writeFileSync(out, bridgeWorkbook({ host, include, madeAt: new Date().toISOString().slice(0, 10) }));
console.log(`Wrote ${out}. It has no key: paste a read-only key into Setup, cell B6.`);
