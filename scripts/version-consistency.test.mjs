import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./lib/repo-files.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const yamlInfoVersion = (rel) => /^info:\n(?:[ ]+.*\n)*?[ ]+version:\s*"?([^"\n]+)"?\s*$/m.exec(read(rel))?.[1];

const pkg = json("package.json");
const V = pkg.version;

describe("one version for the server and everything that describes it ", () => {
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

  it("quickstart examples show the current version", () => {
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
    expect(node.license).toBe("SEE LICENSE IN LICENSE");
  });

});

