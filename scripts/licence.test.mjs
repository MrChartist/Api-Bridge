import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

/** Files whose job is to talk about other people's licences; they may use these words about them. */
const ABOUT_OTHERS = new Set(["THIRD-PARTY-NOTICES.md", "scripts/licence.test.mjs"]);

/** Wording that would claim a licence other than the PolyForm Noncommercial one on this repository. */
const CONTRADICTING = [
  /under the \[?MIT Licen[cs]e/i,
  /open[- ]source \(MIT\)/i,
  /all rights reserved/i,
  /proprietary licen[cs]e/i,
];

const files = repoFiles().filter((f) => !f.startsWith("node_modules/") && f !== "package-lock.json");

describe("licence text in the repository", () => {
  it("LICENSE is PolyForm Noncommercial and names the same holder in every copy", () => {
    const root = readFileSync(join(ROOT, "LICENSE"), "utf8");
    expect(root).toMatch(/PolyForm Noncommercial License 1\.0\.0/);
    const holder = (t) => t.split("\n").find((l) => l.startsWith("Required Notice: Copyright"));
    for (const copy of ["sdk/python/LICENSE", "sdk/node/LICENSE"]) {
      expect(holder(readFileSync(join(ROOT, copy), "utf8")), copy).toBe(holder(root));
    }
  });

  it("no file carries wording that contradicts the licence", () => {
    const hits = [];
    for (const f of files) {
      if (ABOUT_OTHERS.has(f)) continue;
      const text = readText(f);
      if (text === null) continue;
      for (const re of CONTRADICTING) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("every shipped integration file with a copyright line says PolyForm Noncommercial and points at LICENSE", () => {
    const shipped = files.filter((f) => /^(integrations|examples|sdk|deploy|docker)\//.test(f));
    const bad = [];
    let withLine = 0;
    for (const f of shipped) {
      if (/(^|\/)LICENSE$/.test(f)) continue; // a LICENSE file has its own rules
      const text = readText(f);
      if (text === null) continue;
      const line = text.split("\n").slice(0, 12).find((l) => /\bcopyright\b/i.test(l));
      if (!line) continue;
      withLine++;
      if (!/PolyForm Noncommercial/.test(line) || !/LICENSE/.test(line)) bad.push(`${f}: ${line.trim()}`);
    }
    expect(bad).toEqual([]);
    expect(withLine).toBeGreaterThan(0); // the AmiBroker include at least
  });

  it("the AmiBroker include states the licence", () => {
    const afl = readFileSync(join(ROOT, "integrations/amibroker/mrchartist-bridge.afl"), "utf8");
    expect(afl.split("\n").slice(0, 5).join("\n")).toContain("Copyright (c) 2026 Mr. Chartist. PolyForm Noncommercial License 1.0.0, see LICENSE");
  });

  it("every package manifest that declares a licence declares PolyForm-Noncommercial-1.0.0", () => {
    for (const f of files.filter((p) => /(^|\/)package\.json$/.test(p))) {
      const json = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
      if (json.license !== undefined) expect(json.license, f).toBe("PolyForm-Noncommercial-1.0.0");
    }
  });
});
