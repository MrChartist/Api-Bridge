/**
 * The Integrations snippets name the SDKs the repository really ships (sdk/python, sdk/node) and install them from the
 * repository, because neither is published to PyPI or npm. Pure: no DOM, no server.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snippets } from "./snippets.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pyproject = readFileSync(resolve(root, "sdk/python/pyproject.toml"), "utf8");
const nodePkg = JSON.parse(readFileSync(resolve(root, "sdk/node/package.json"), "utf8"));

describe("integration snippets match the shipped SDKs", () => {
  const s = snippets({ base: "http://127.0.0.1:4300", folder: "/opt/api bridge" });

  it("imports the Python package the repository ships", () => {
    expect(pyproject).toMatch(/^name = "mrchartist-bridge"/m);
    const code = s.python.map((x) => x.code).join("\n");
    expect(code).toContain("from mrchartist_bridge import BridgeClient");
  });

  it("imports the Node package the repository ships, from the tarball npm pack makes", () => {
    expect(nodePkg.name).toBe("@mrchartist/bridge-client");
    expect(nodePkg.private).toBe(true); // not published: the snippet must not say `npm install @mrchartist/bridge-client`
    const code = s.node.map((x) => x.code).join("\n");
    expect(code).toContain(`from "${nodePkg.name}"`);
    expect(code).toContain(`mrchartist-bridge-client-${nodePkg.version}.tgz`);
    expect(code).not.toMatch(/npm install @mrchartist/);
  });

  it("installs from the Bridge's own folder, quoting a path with a space, and says nothing is published", () => {
    expect(s.python[0].code).toContain('pip install "/opt/api bridge/sdk/python"');
    expect(s.python[0].title).toMatch(/not on PyPI/);
    expect(s.node[0].code).toContain('cd "/opt/api bridge/sdk/node" && npm pack');
    expect(s.node[0].title).toMatch(/not on npm/);
    expect(snippets({ base: "http://h:1" }).python[0].code).toContain("pip install /path/to/api-bridge-v2/sdk/python");
  });
});
