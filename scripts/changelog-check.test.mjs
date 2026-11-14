import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedEntries, baseFromEnv, collect, evaluate, unreleasedLines, watchedChanges } from "./changelog-check.mjs";

const BASE = "# Changelog\n\n## Unreleased\n\n- Old entry.\n\n## 2.0.0\n\n- Released entry.\n";
const WITH_NEW = "# Changelog\n\n## Unreleased\n\n- New entry.\n- Old entry.\n\n## 2.0.0\n\n- Released entry.\n";
const ONLY_RELEASED_EDIT = "# Changelog\n\n## Unreleased\n\n- Old entry.\n\n## 2.0.0\n\n- Released entry.\n- Added to a release by mistake.\n";

/** A fake git: answers the three commands the script uses from a table. */
const fakeGit = (files, baseChangelog) => (args) => {
  if (args[0] === "merge-base") return "abc123\n";
  if (args[0] === "diff") return `${files.join("\n")}\n`;
  if (args[0] === "show") {
    if (baseChangelog === null) throw new Error("path does not exist");
    return baseChangelog;
  }
  throw new Error(`unexpected git ${args.join(" ")}`);
};

const run = (files, head, base = BASE) => evaluate(collect({ base: "origin/main", git: fakeGit(files, base), readHead: () => head }));

describe("which changes need a release note", () => {
  it("watches server/, the OpenAPI file and sdk/, and ignores tests, docs and fixtures", () => {
    expect(
      watchedChanges([
        "server/bridge/orders/service.mjs", "docs/openapi.yaml", "sdk/python/mrchartist_bridge/client.py", "sdk/node/src/client.mjs",
        "server/bridge/orders/service.test.mjs", "sdk/python/tests/test_client.py", "sdk/node/test/client.test.mjs", "sdk/node/README.md",
        "docs/guides/quickstart.md", "README.md", "scripts/gen-docs-index.mjs", "server/brokers/fixtures/dhan.json", "src/app.ts",
      ]),
    ).toEqual(["server/bridge/orders/service.mjs", "docs/openapi.yaml", "sdk/python/mrchartist_bridge/client.py", "sdk/node/src/client.mjs"]);
  });
});

describe("the Unreleased section", () => {
  it("reads only the lines between Unreleased and the next release", () => {
    expect(unreleasedLines(BASE).filter(Boolean)).toEqual(["- Old entry."]);
    expect(unreleasedLines("# Changelog\n\n## [Unreleased]\n- x\n## 1.0\n- y")).toEqual(["- x"]);
    expect(unreleasedLines("# Changelog\n## 1.0\n- y")).toEqual([]);
    expect(unreleasedLines(undefined)).toEqual([]);
  });

  it("finds new bullet lines, not edits elsewhere, not blank lines, not continuation text", () => {
    expect(addedEntries(BASE, WITH_NEW)).toEqual(["- New entry."]);
    expect(addedEntries(BASE, ONLY_RELEASED_EDIT)).toEqual([]);
    expect(addedEntries(BASE, BASE.replace("- Old entry.", "- Old entry.\n  continued text"))).toEqual([]);
    expect(addedEntries("", WITH_NEW)).toEqual(["- New entry.", "- Old entry."]);
  });
});

describe("the check", () => {
  it("passes when no watched file changed", () => {
    const r = run(["docs/guides/quickstart.md", "server/bridge/orders/service.test.mjs"], BASE);
    expect(r).toMatchObject({ status: "ok", files: [] });
  });

  it("passes when a watched file changed and the changelog has a new Unreleased line", () => {
    expect(run(["server/bridge/orders/service.mjs"], WITH_NEW)).toMatchObject({ status: "ok", files: ["server/bridge/orders/service.mjs"] });
  });

  it("fails when a watched file changed and the changelog did not", () => {
    const r = run(["docs/openapi.yaml", "sdk/node/src/client.mjs"], BASE);
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/2 changed files/);
    expect(r.message).toContain("docs/openapi.yaml");
  });

  it("fails when the only changelog edit is outside Unreleased", () => {
    expect(run(["server/x.mjs"], ONLY_RELEASED_EDIT).status).toBe("fail");
  });

  it("treats a base without a changelog as empty", () => {
    expect(run(["server/x.mjs"], WITH_NEW, null).status).toBe("ok");
  });

  it("only warns, and checks nothing, when there is no pull request base", () => {
    const r = evaluate(collect({ base: null, git: () => { throw new Error("git must not run"); }, readHead: () => BASE }));
    expect(r.status).toBe("warn");
    expect(r.message).toMatch(/not checked/);
  });

  it("takes the base from --base, then from the pull request environment", () => {
    expect(baseFromEnv(["--base", "origin/dev"], { GITHUB_BASE_REF: "main" })).toBe("origin/dev");
    expect(baseFromEnv([], { GITHUB_BASE_REF: "main" })).toBe("origin/main");
    expect(baseFromEnv([], {})).toBeNull();
  });
});

describe("with a real git repository", () => {
  it("fails for a server change without a note and passes once the note is added", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-changelog-"));
    const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "CHANGELOG.md"), BASE);
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server/a.mjs"), "export const a = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "change"]);
    writeFileSync(join(dir, "server/a.mjs"), "export const a = 2;\n");
    git(["commit", "-q", "-am", "change code"]);
    const check = () => evaluate(collect({ base: "main", git, readHead: () => readFileSync(join(dir, "CHANGELOG.md"), "utf8") }));
    expect(check().status).toBe("fail");
    writeFileSync(join(dir, "CHANGELOG.md"), WITH_NEW);
    git(["commit", "-q", "-am", "note"]);
    expect(check().status).toBe("ok");
  });
});
