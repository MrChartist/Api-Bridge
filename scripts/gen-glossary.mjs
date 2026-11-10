#!/usr/bin/env node
/**
 * Builds docs/guides/glossary.md from the dashboard's own glossary (server/bridge/dashboard/glossary.js: GLOSSARY for the
 * words the dashboard explains with a "?" button, DOC_TERMS for the words only the guides use). One source, so the app
 * and the guides cannot define the same word two ways. scripts/glossary.test.mjs fails when the committed page is stale.
 *
 *   node scripts/gen-glossary.mjs           write
 *   node scripts/gen-glossary.mjs --check   exit 1 when the committed page is out of date
 */
import { pathToFileURL } from "node:url";
import { DOC_TERMS, GLOSSARY } from "../server/bridge/dashboard/glossary.js";
import { REPO_ROOT } from "./lib/openapi-model.mjs";
import { runCli } from "./lib/outputs.mjs";

const OUT = "docs/guides/glossary.md";
const byTerm = (a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" });
const line = (e) => `- **${e.term}**: ${e.text}`;

/** The page text. */
export function glossaryPage(dashboard = GLOSSARY, guides = DOC_TERMS) {
  return [
    "# Glossary",
    "",
    "Short meanings for the words these guides and the dashboard use. The dashboard shows the first group as a small **?** next to the",
    "word; the second group is words the guides use that the dashboard does not mark. *This page is generated from",
    "`server/bridge/dashboard/glossary.js` (run `npm run docs:generate`); change the words there.*",
    "",
    "## Words the dashboard explains",
    "",
    ...[...dashboard].sort(byTerm).map(line),
    "",
    "## Words the guides use",
    "",
    ...[...guides].sort(byTerm).map(line),
    "",
    "More: [the error codes](../api/errors.md), [troubleshooting](troubleshooting.md), the [FAQ](faq.md).",
    "",
  ].join("\n");
}

export function buildGlossary() {
  return new Map([[OUT, glossaryPage()]]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli("gen-glossary", REPO_ROOT, buildGlossary(), [OUT]);
