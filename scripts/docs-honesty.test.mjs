import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("docs that point at a release which does not exist yet", () => {
  it("install.md says so near the top, once, and points at the git checkout steps", () => {
    const install = read("docs/guides/install.md");
    const top = install.split("\n").slice(0, 20).join("\n");
    expect(top).toMatch(/No release has been published yet/);
    expect(top).toContain("README.md#five-minutes-to-a-first-answer");
    expect(install.match(/No release has been published yet/g)).toHaveLength(1);
  });

  it("the README heading that notice links to exists", () => {
    expect(read("README.md")).toMatch(/^## Five minutes to a first answer$/m);
  });

  it("only install.md links to a release download; other docs do not promise one", () => {
    const hits = repoFiles()
      .filter((f) => /\.(md|txt|json|yml|yaml)$/.test(f) && !["docs/guides/install.md", "docs/release-process.md", "docs/llms-full.txt", "docs/search-index.json", "package-lock.json"].includes(f) && !f.startsWith(".github/workflows/"))
      .filter((f) => /releases\/(latest|download)/.test(readText(f) ?? ""));
    expect(hits).toEqual([]);
  });

  it("the installers tell a person with no release to use a git checkout", () => {
    expect(read("install.sh")).toMatch(/If no release has been published yet.*git checkout/);
    expect(read("install.ps1")).toMatch(/If no release has been published yet.*git checkout/);
  });

  it("the release process says to remove the notice with the first release", () => {
    expect(read("docs/release-process.md")).toMatch(/remove the "no release yet" notice/);
  });
});
