#!/usr/bin/env node
/**
 * Regenerates the generated parts of the broker verification record from the code:
 *   - server/brokers/verification.json   beta / contract levels (sandbox and live-verified are kept as recorded)
 *   - docs/BROKERS.md                    the "Verification ladder" and "Order-safety contract cases" tables
 * server/brokers/verification.test.mjs fails when either file is stale.
 *   node scripts/generate-broker-verification.mjs          write both
 *   node scripts/generate-broker-verification.mjs --check  exit 1 when a file would change
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContractMatrix, expectedVerificationFile, spliceVerificationSection } from "../server/brokers/contractMatrix.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const rows = await buildContractMatrix();
const verifyPath = resolve(root, "server/brokers/verification.json");
const docPath = resolve(root, "docs/BROKERS.md");
const nextVerify = `${JSON.stringify(expectedVerificationFile(rows), null, 2)}\n`;
const nextDoc = spliceVerificationSection(readFileSync(docPath, "utf-8"), rows);
const stale = [];
if (readFileSync(verifyPath, "utf-8") !== nextVerify) stale.push("server/brokers/verification.json");
if (readFileSync(docPath, "utf-8") !== nextDoc) stale.push("docs/BROKERS.md");
if (check) {
  if (stale.length) {
    console.error(`Stale: ${stale.join(", ")}. Run: node scripts/generate-broker-verification.mjs`);
    process.exit(1);
  }
  console.log("Broker verification record is up to date.");
} else {
  writeFileSync(verifyPath, nextVerify);
  writeFileSync(docPath, nextDoc);
  console.log(`Wrote ${stale.length ? stale.join(" and ") : "nothing (already up to date)"}.`);
}
