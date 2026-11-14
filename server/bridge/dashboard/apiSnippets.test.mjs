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

  it("shows the event calls the SDKs really have (poll, subscribe, verify)", () => {
    const py = s.python.map((x) => x.code).join("\n");
    const js = s.node.map((x) => x.code).join("\n");
    const pyEvents = readFileSync(resolve(root, "sdk/python/mrchartist_bridge/events.py"), "utf8");
    const nodeEvents = readFileSync(resolve(root, "sdk/node/src/events.mjs"), "utf8");
    for (const word of ["def poll(", "def subscribe(", "def verify_signature("]) expect(pyEvents).toContain(word);
    for (const word of ["async poll(", "subscribe(o", "export function verifySignature("]) expect(nodeEvents).toContain(word);
    expect(py).toContain("bridge.events.poll(");
    expect(py).toContain("bridge.events.subscribe(");
    expect(py).toContain("bridge.events.verify_signature(");
    expect(js).toContain("bridge.events.poll(");
    expect(js).toContain("bridge.events.subscribe(");
    expect(js).toContain("bridge.events.verifySignature(");
  });

  it("installs from the Bridge's own folder, quoting a path with a space, and says nothing is published", () => {
    expect(s.python[0].code).toContain('pip install "/opt/api bridge/sdk/python"');
    expect(s.python[0].title).toMatch(/not on PyPI/);
    expect(s.node[0].code).toContain('cd "/opt/api bridge/sdk/node" && npm pack');
    expect(s.node[0].title).toMatch(/not on npm/);
    expect(snippets({ base: "http://h:1" }).python[0].code).toContain("pip install /path/to/api-bridge-v2/sdk/python");
  });

  it("quotes every shell-special character in a path, not only a space (audit F9)", () => {
    for (const bad of ["/opt/a&b", "/opt/a;rm -rf x", "/opt/$HOME/x", "/opt/`id`", '/opt/a"b', "/opt/it's"]) {
      const code = snippets({ base: "http://h:1", folder: bad }).python[0].code;
      const line = code.split("\n").find((l) => l.startsWith("pip install"));
      expect(line, bad).toMatch(/^pip install ".*"$/);
      // inside double quotes no unescaped " $ or ` remains
      const inner = line.slice('pip install "'.length, -1);
      expect(inner.replace(/\\./g, ""), bad).not.toMatch(/["$`]/);
    }
  });

  it("a Bridge on Windows gets PowerShell words: py, Activate.ps1, $env:, backslashes, no && or export", () => {
    const win = snippets({ base: "http://127.0.0.1:4300", key: "mcb_k", folder: "C:\\Users\\Asha Rao\\api-bridge" });
    const py = win.python[0].code;
    expect(py).toContain("py -m venv .venv");
    expect(py).toContain(".venv\\Scripts\\Activate.ps1");
    expect(py).toContain("pip install 'C:\\Users\\Asha Rao\\api-bridge\\sdk\\python'");
    expect(py).toContain("$env:MCB_API_KEY=mcb_k");
    expect(py).not.toMatch(/python3|export |&&|bin\/activate/);
    expect(win.python[0].lang).toBe("powershell");
    const js = win.node[0].code;
    expect(js).toContain("cd 'C:\\Users\\Asha Rao\\api-bridge\\sdk\\node'\nnpm pack");
    expect(js).not.toContain("&&");
    // a Unix Bridge is unchanged
    expect(snippets({ base: "http://h:1", folder: "/home/me/bridge" }).python[0].code).toContain("python3 -m venv .venv && . .venv/bin/activate");
  });
});
