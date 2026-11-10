import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

const files = repoFiles().filter((f) => !f.startsWith("node_modules/") && f !== "package-lock.json" && !f.endsWith(".test.mjs")); // tests may name the bad form to forbid it

/**
 * `npx mc-bridge` outside a checkout downloads whatever package has that name on npm (today an unrelated one), because
 * this project is not published. The command people run is `mc-bridge` (installed, on PATH), `npm run bridge --` or
 * `node bin/mc-bridge.mjs` (a checkout).
 */
const BARE = /\bnpx\s+(?:(?:--?[\w-]+(?:=\S+)?)\s+)*(?:mc-bridge|@mrchartist\/\S+)|\bnpm\s+(?:i|install|add)\s+(?:-g\s+|--global\s+)?(?:mc-bridge|@mrchartist\/(?:api-bridge|bridge-client))\b|\bnpm\s+exec\s+(?:--\s+)?mc-bridge\b/;

describe("how docs tell people to run the CLI", () => {
  it("no file uses npx or npm install for a package of this project", () => {
    const hits = [];
    for (const f of files) {
      const text = readText(f);
      if (text === null) continue;
      text.split("\n").forEach((line, i) => {
        if (BARE.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the pattern catches the forms it is meant to catch", () => {
    for (const bad of ["npx mc-bridge start", "npx --no-install mc-bridge doctor", "npx -y mc-bridge keys list", "npm install -g mc-bridge", "npx @mrchartist/bridge-client", "npm exec mc-bridge"]) {
      expect(BARE.test(bad), bad).toBe(true);
    }
    for (const ok of ["mc-bridge start", "npm run bridge -- start", "node bin/mc-bridge.mjs start", "npx vitest run", "npm install --save-exact"]) {
      expect(BARE.test(ok), ok).toBe(false);
    }
  });

  it("the package stays private, so there is no published name to point at", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toEqual({ "mc-bridge": "bin/mc-bridge.mjs" });
  });

  it("the guides index explains how to run the command", () => {
    expect(readFileSync(join(ROOT, "docs/guides/README.md"), "utf8")).toMatch(/npm run bridge --/);
  });
});
