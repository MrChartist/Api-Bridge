#!/usr/bin/env node
// SHA256SUMS.txt for a release folder: written by the release build, checked again before publishing, and the same
// format `sha256sum -c` reads. The installers (install.sh, install.ps1) check their download against this file.
//
//   node scripts/release/checksums.mjs write dist     write dist/SHA256SUMS.txt for every release file in dist
//   node scripts/release/checksums.mjs verify dist    check every file in dist against dist/SHA256SUMS.txt (exit 1 on any difference)
//
// Which files are listed: the downloads (.zip, .exe, .tar.gz) and the installer scripts (install.sh, install.ps1).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUMS_FILE = "SHA256SUMS.txt";
const LISTED = /(\.zip|\.exe|\.tar\.gz)$|^install\.(sh|ps1)$/;

export const sha256Of = (buf) => createHash("sha256").update(buf).digest("hex");

/** The release files in `dir` that belong in the list, sorted by name. */
export const releaseFiles = (dir) => readdirSync(dir).filter((f) => f !== SUMS_FILE && LISTED.test(f)).sort();

/** The text of SHA256SUMS.txt for `dir`: "<sha256>  <name>" per line, as `sha256sum` writes it. */
export function checksums(dir) {
  return releaseFiles(dir)
    .map((f) => `${sha256Of(readFileSync(join(dir, f)))}  ${f}\n`)
    .join("");
}

/** @returns {Map<string, string>} name -> lower-case hex; throws on a line that is not "<64 hex>  <name>" */
export function parseSums(text) {
  const out = new Map();
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](\S.*)$/.exec(line);
    if (!m) throw new Error(`${SUMS_FILE} line ${i + 1} is not "<sha256>  <file name>"`);
    if (out.has(m[2])) throw new Error(`${SUMS_FILE} lists ${m[2]} twice`);
    out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/**
 * Check `dir` against its SHA256SUMS.txt: every listed file must exist with the listed hash, and every release file
 * must be listed (a file missing from the list could not be checked by an installer).
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyChecksums(dir) {
  const problems = [];
  let listed;
  try {
    listed = parseSums(readFileSync(join(dir, SUMS_FILE), "utf8"));
  } catch (err) {
    return { ok: false, problems: [`${SUMS_FILE}: ${err.message}`] };
  }
  for (const [name, hash] of listed) {
    let data;
    try {
      data = readFileSync(join(dir, name));
    } catch {
      problems.push(`${name} is listed but missing`);
      continue;
    }
    if (sha256Of(data) !== hash) problems.push(`${name} does not match its listed checksum`);
  }
  for (const f of releaseFiles(dir)) if (!listed.has(f)) problems.push(`${f} is not listed in ${SUMS_FILE}`);
  if (listed.size === 0) problems.push(`${SUMS_FILE} lists nothing`);
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dirArg] = process.argv.slice(2);
  const dir = resolve(dirArg ?? "dist");
  if (cmd === "write") {
    writeFileSync(join(dir, SUMS_FILE), checksums(dir), "utf8");
    console.log(`Wrote ${join(dir, SUMS_FILE)} (${releaseFiles(dir).length} files)`);
  } else if (cmd === "verify") {
    const r = verifyChecksums(dir);
    if (!r.ok) {
      for (const p of r.problems) console.error(`  ${p}`);
      console.error(`${SUMS_FILE} check failed.`);
      process.exit(1);
    }
    console.log(`${SUMS_FILE} matches every file in ${dir}.`);
  } else {
    console.error("Usage: node scripts/release/checksums.mjs write|verify <folder>");
    process.exit(2);
  }
}
