#!/usr/bin/env node
// Writes the release notes for one version from CHANGELOG.md, for the Release workflow (and for a maintainer to preview).
//
//   node scripts/release/release-notes.mjs v2.1.0            prints the notes of "## 2.1.0" (or "## [2.1.0] - 2026-12-01")
//   node scripts/release/release-notes.mjs 2.1.0 --allow-unreleased   the same, even if "## Unreleased" still has lines
//
// It stops with a message (exit 1) when there is no section for that version, when the section is empty, or when
// "Unreleased" still holds lines: those belong under the new version heading before a release is tagged. Nothing is
// written to disk and nothing is published.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** "## [2.1.0] - 2026-12-01" -> "2.1.0"; "## Unreleased" -> "unreleased"; "## v2.1.0 (2026-12-01)" -> "2.1.0". */
export function headingKey(line) {
  const title = line.replace(/^##\s+/, "").trim();
  const m = /^\[?v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\]?(?:\s*[-–—(].*)?$/.exec(title);
  if (m) return m[1];
  return title.replace(/^\[|\]$/g, "").toLowerCase();
}

/** The sections of a changelog: [{ key, heading, body }] in file order (only second-level headings start one). */
export function sections(markdown) {
  const out = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) out.push({ key: headingKey(line), heading: line.trim(), lines: [] });
    else if (out.length) out.at(-1).lines.push(line);
  }
  return out.map((s) => ({ key: s.key, heading: s.heading, body: s.lines.join("\n").trim() }));
}

/**
 * The notes for `version` ("v2.1.0" or "2.1.0").
 * @returns {{ ok: true, notes: string } | { ok: false, problem: string }}
 */
export function releaseNotes(markdown, version, { allowUnreleased = false } = {}) {
  const want = String(version).replace(/^v/, "");
  const all = sections(markdown);
  const section = all.find((s) => s.key === want);
  if (!section) return { ok: false, problem: `CHANGELOG.md has no "## ${want}" section. Move the lines under "## Unreleased" into a new "## ${want} - <date>" heading first (docs/release-process.md).` };
  if (!section.body) return { ok: false, problem: `The "## ${want}" section of CHANGELOG.md is empty.` };
  const unreleased = all.find((s) => s.key === "unreleased");
  if (!allowUnreleased && unreleased && unreleased.body) {
    return { ok: false, problem: `"## Unreleased" in CHANGELOG.md still has lines. They would be left out of the ${want} release notes: move them under "## ${want}" first, or pass --allow-unreleased.` };
  }
  return { ok: true, notes: `${section.body}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  if (!version) {
    console.error("usage: node scripts/release/release-notes.mjs <version or tag> [--allow-unreleased]");
    process.exit(2);
  }
  const result = releaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version, { allowUnreleased: args.includes("--allow-unreleased") });
  if (!result.ok) {
    console.error(result.problem);
    process.exit(1);
  }
  process.stdout.write(result.notes);
}
