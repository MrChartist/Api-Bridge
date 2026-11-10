import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./lib/repo-files.mjs";
import { headingKey, releaseNotes, sections } from "./release/release-notes.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const yamlInfoVersion = (rel) => /^info:\n(?:[ ]+.*\n)*?[ ]+version:\s*"?([^"\n]+)"?\s*$/m.exec(read(rel))?.[1];

const pkg = json("package.json");
const V = pkg.version;

describe("one version for the server and everything that describes it (docs/release-process.md)", () => {
  it("package.json has a SemVer version", () => {
    expect(V).toMatch(SEMVER);
  });

  it("package-lock.json names the same package and version", () => {
    const lock = json("package-lock.json");
    expect({ name: lock.name, version: lock.version }).toEqual({ name: pkg.name, version: V });
    expect({ name: lock.packages[""].name, version: lock.packages[""].version }).toEqual({ name: pkg.name, version: V });
    expect(lock.packages[""].engines).toEqual(pkg.engines);
  });

  it("the OpenAPI and AsyncAPI documents carry the server version", () => {
    expect(yamlInfoVersion("docs/openapi.yaml")).toBe(V);
    expect(yamlInfoVersion("docs/asyncapi.yaml")).toBe(V);
  });

  it("the MCP relay reports the server version, not a number of its own", () => {
    expect(read("server/bridge/mcp/stdio.mjs")).not.toMatch(/version:\s*"\d+\.\d+\.\d+"/);
  });

  it("install and quickstart examples show the current version", () => {
    const install = read("docs/guides/install.md");
    const shown = [...install.matchAll(/(?:--version|MCB_VERSION\s*=)\s*"?(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set([V]));
    const quickstart = read("docs/guides/quickstart.md");
    expect(quickstart).toContain(`${pkg.name}@${V} dev`);
    expect(quickstart).toContain(`"version": "${V}"`);
  });
});

describe("the SDKs are versioned on their own and agree with themselves", () => {
  it("Python: pyproject, __version__ and the User-Agent say the same", () => {
    const py = /^version = "([^"]+)"/m.exec(read("sdk/python/pyproject.toml"))?.[1];
    expect(py).toMatch(SEMVER);
    expect(/^__version__ = "([^"]+)"/m.exec(read("sdk/python/mrchartist_bridge/__init__.py"))?.[1]).toBe(py);
    const [major, minor] = py.split(".");
    expect(/^USER_AGENT = "mrchartist-bridge-python\/([^"]+)"/m.exec(read("sdk/python/mrchartist_bridge/client.py"))?.[1]).toBe(`${major}.${minor}`);
  });

  it("Node: package.json, the User-Agent and the README install line say the same", () => {
    const node = json("sdk/node/package.json");
    expect(node.version).toMatch(SEMVER);
    const [major, minor] = node.version.split(".");
    expect(/userAgent \?\? "mrchartist-bridge-node\/([^"]+)"/.exec(read("sdk/node/src/client.mjs"))?.[1]).toBe(`${major}.${minor}`);
    expect(read("sdk/node/README.md")).toContain(`mrchartist-bridge-client-${node.version}.tgz`);
    expect(node.license).toBe("MIT");
  });

});

describe("CHANGELOG.md and the release notes extraction", () => {
  const changelog = read("CHANGELOG.md");

  it("keeps an Unreleased section first, where pull requests add their lines", () => {
    expect(sections(changelog)[0].key).toBe("unreleased");
  });

  it("has a section for the current version that the release workflow can extract", () => {
    const r = releaseNotes(changelog, `v${V}`, { allowUnreleased: true });
    expect(r.ok, r.problem).toBe(true);
    expect(r.notes.trim().length).toBeGreaterThan(20);
  });

  it("the release workflow uses the extraction script, not an inline pattern", () => {
    const wf = read(".github/workflows/release.yml");
    expect(wf).toContain("scripts/release/release-notes.mjs");
    expect(wf).not.toMatch(/awk .*CHANGELOG/);
  });

  it("reads headings written as 2.1.0, [2.1.0], v2.1.0 and with a date", () => {
    for (const h of ["## 2.1.0", "## [2.1.0]", "## v2.1.0", "## [2.1.0] - 2026-12-01", "## 2.1.0 (2026-12-01)", "## 2.1.0 — 2026-12-01"]) expect(headingKey(h), h).toBe("2.1.0");
    expect(headingKey("## [Unreleased]")).toBe("unreleased");
    expect(headingKey("## 2.1.0-beta.1")).toBe("2.1.0-beta.1");
  });

  it("returns the notes of one version only, and refuses to release past unreleased lines", () => {
    const md = "# Changelog\n\n## Unreleased\n\n- Next thing.\n\n## [2.1.0] - 2026-12-01\n\n- Added A.\n\n### Fixed\n\n- Fixed B.\n\n## 2.0.0\n\n- Old.\n";
    expect(releaseNotes(md, "v2.1.0", { allowUnreleased: true })).toEqual({ ok: true, notes: "- Added A.\n\n### Fixed\n\n- Fixed B.\n" });
    expect(releaseNotes(md, "2.1.0")).toMatchObject({ ok: false, problem: expect.stringMatching(/Unreleased.*still has lines/) });
    expect(releaseNotes(md, "2.2.0", { allowUnreleased: true })).toMatchObject({ ok: false, problem: expect.stringMatching(/no "## 2\.2\.0" section/) });
    expect(releaseNotes("## Unreleased\n\n## 2.1.0\n\n## 2.0.0\n- x\n", "2.1.0")).toMatchObject({ ok: false, problem: expect.stringMatching(/empty/) });
    expect(releaseNotes("## Unreleased\n\n## 2.1.0\n\n- A.\n", "v2.1.0")).toEqual({ ok: true, notes: "- A.\n" });
  });

  it("ignores a heading inside a code fence", () => {
    const md = "## 2.1.0\n\n```md\n## 9.9.9\n```\n\n- Real.\n";
    expect(sections(md).map((s) => s.key)).toEqual(["2.1.0"]);
  });
});
