#!/usr/bin/env node
/**
 * Release-notes check for pull requests: a change to server/, docs/openapi.yaml or sdk/ needs a new line under
 * "Unreleased" in CHANGELOG.md.
 *
 *   node scripts/changelog-check.mjs [--base <ref>]
 *
 * The base comes from --base or, in a pull_request run, from GITHUB_BASE_REF (as origin/<branch>). With no base (a
 * local run, a push) there is nothing to compare: the script prints a warning and exits 0. With a base, a missing line
 * fails (exit 1). There is no way to opt out from inside a script (a marker in the pull request description is not
 * visible here); a change that really needs no note, such as a refactor, gets a one-line entry anyway or is split
 * from the code change. Test files, Markdown files and fixtures do not count as changes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WATCHED = [/^server\//, /^docs\/openapi\.yaml$/, /^sdk\//];
const IGNORED = [/\.test\.m?js$/, /\.spec\.m?js$/, /(^|\/)tests?\//, /(^|\/)__tests__\//, /(^|\/)fixtures?\//, /\.md$/, /^sdk\/python\/tests\//];

/** The changed files that need a release note. */
export const watchedChanges = (files) => files.filter((f) => WATCHED.some((r) => r.test(f)) && !IGNORED.some((r) => r.test(f)));

/** The lines of the "Unreleased" section of a changelog (up to the next "## " heading). */
export function unreleasedLines(markdown) {
  const lines = String(markdown ?? "").replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^##\s+\[?Unreleased\]?\s*$/i.test(l));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/** New entries (bullet lines) in the Unreleased section of `after` that were not in `before`. */
export function addedEntries(before, after) {
  const had = new Set(unreleasedLines(before).map((l) => l.trim()));
  return unreleasedLines(after).map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l) && !had.has(l));
}

/**
 * @param {{ changedFiles: string[]|null, baseChangelog: string|null, headChangelog: string }} input `changedFiles` is null when there is no base to compare with
 * @returns {{ status: "ok" | "warn" | "fail", message: string, files: string[] }}
 */
export function evaluate({ changedFiles, baseChangelog, headChangelog }) {
  if (changedFiles === null) return { status: "warn", message: "No pull request base is available (run with --base <ref>, or in a pull_request job): the changelog was not checked.", files: [] };
  const files = watchedChanges(changedFiles);
  if (!files.length) return { status: "ok", message: "No change to server/, docs/openapi.yaml or sdk/ that needs a release note.", files };
  const added = addedEntries(baseChangelog, headChangelog);
  if (added.length) return { status: "ok", message: `CHANGELOG.md has ${added.length} new line${added.length === 1 ? "" : "s"} under Unreleased.`, files };
  return {
    status: "fail",
    message: `${files.length} changed file${files.length === 1 ? "" : "s"} in server/, docs/openapi.yaml or sdk/ but no new line under "Unreleased" in CHANGELOG.md.\nAdd a short line for what a user would notice. Changed:\n${files.slice(0, 10).map((f) => `  ${f}`).join("\n")}${files.length > 10 ? `\n  ... and ${files.length - 10} more` : ""}`,
    files,
  };
}

/**
 * Collect the inputs with git. `git(args)` runs git and returns its output; it is a parameter so a test can fake it.
 */
export function collect({ base, git, readHead }) {
  if (!base) return { changedFiles: null, baseChangelog: null, headChangelog: readHead() };
  const mergeBase = git(["merge-base", base, "HEAD"]).trim() || base;
  const changedFiles = git(["diff", "--name-only", `${mergeBase}`, "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
  let baseChangelog = "";
  try {
    baseChangelog = git(["show", `${mergeBase}:CHANGELOG.md`]);
  } catch {
    baseChangelog = "";
  }
  return { changedFiles, baseChangelog, headChangelog: readHead() };
}

export function baseFromEnv(argv, env) {
  const i = argv.indexOf("--base");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  return null;
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const base = baseFromEnv(process.argv.slice(2), process.env);
  let input;
  try {
    input = collect({ base, git, readHead: () => readFileSync(resolve(root, "CHANGELOG.md"), "utf8") });
  } catch (err) {
    console.error(`changelog-check: could not compare with ${base}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}\nIn CI the checkout needs fetch-depth: 0 so the base branch is available.`);
    process.exit(2);
  }
  const r = evaluate(input);
  if (r.status === "fail") {
    console.error(`changelog-check: ${r.message}`);
    process.exit(1);
  }
  console.log(`changelog-check${r.status === "warn" ? " (warning)" : ""}: ${r.message}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
