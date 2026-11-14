import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../lib/repo-files.mjs";
import { shipped } from "./build-bundles.mjs";
import { NOTICES_FILE, checkNotices, copyrightLines, devLicenceCounts, productionPackages, renderNotices, tableRows } from "./third-party-notices.mjs";

const lockOf = (packages) => ({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });

describe("THIRD-PARTY-NOTICES.md", () => {
  it("lists exactly the production packages of package-lock.json, each with the licence its metadata states", () => {
    expect(checkNotices()).toEqual([]);
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    const prod = productionPackages(lock);
    expect(prod.length).toBeGreaterThan(50);
    expect(prod.filter((p) => p.license === "not stated")).toEqual([]);
    expect(tableRows(readFileSync(join(ROOT, NOTICES_FILE), "utf8"))).toHaveLength(prod.length);
  });

  it("carves broker names and logos out of the project licence and says what it does not claim", () => {
    const text = readFileSync(join(ROOT, NOTICES_FILE), "utf8");
    expect(text).toMatch(/Broker names and logos are not under the project licence/);
    expect(text).toMatch(/not affiliated with, sponsored by or endorsed by any broker/);
    expect(text).toMatch(/Node\.js/);
    expect(text).toMatch(/## Fonts\n\nNone\./);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("the README repeats the trademark carve-out and links the notices", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/## License, trademarks and logos/);
    expect(readme).toMatch(/not under the project licence/);
    expect(readme).toContain("THIRD-PARTY-NOTICES.md");
  });

  it("ships in the downloads", () => {
    expect(shipped(NOTICES_FILE)).toBe(true);
  });

  it("package.json offers npm run notices", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
    expect(scripts.notices).toContain("third-party-notices.mjs");
    expect(scripts["notices:check"]).toContain("--check");
  });
});

describe("the generator", () => {
  it("skips dev packages, lists a package once however many folders hold it, and marks a missing licence", () => {
    const lock = lockOf({
      "node_modules/a": { version: "1.0.0", license: "MIT" },
      "node_modules/b/node_modules/a": { version: "1.0.0", license: "MIT" },
      "node_modules/@s/c": { version: "2.0.0", license: "ISC" },
      "node_modules/d": { version: "3.0.0" },
      "node_modules/dev1": { version: "1.0.0", license: "Apache-2.0", dev: true },
      "node_modules/dev2": { version: "1.0.0", license: "Apache-2.0", dev: true },
    });
    expect(productionPackages(lock).map((p) => `${p.name}@${p.version} ${p.license}`)).toEqual(["@s/c@2.0.0 ISC", "a@1.0.0 MIT", "d@3.0.0 not stated"]);
    expect(devLicenceCounts(lock)).toEqual([["Apache-2.0", 2]]);
  });

  it("takes copyright lines from the licence text and never invents one", () => {
    expect(copyrightLines("MIT License\n\nCopyright (c) 2020 Someone\n(c) 2021 Other\nCopyright 2022 Third\n")).toEqual(["Copyright (c) 2020 Someone", "(c) 2021 Other"]);
    expect(copyrightLines("Permission is hereby granted")).toEqual([]);
  });

  it("the check fails when the lockfile moves on and when a package states no licence", () => {
    const root = mkdtempSync(join(tmpdir(), "mcb-notices-"));
    try {
      const lock = lockOf({ "node_modules/a": { version: "1.0.0", license: "MIT" } });
      mkdirSync(join(root, "node_modules/a"), { recursive: true });
      writeFileSync(join(root, "node_modules/a/LICENSE"), "MIT License\n\nCopyright (c) 2020 A Person\n\nPermission is hereby granted\n");
      writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
      expect(checkNotices({ root })).toEqual([expect.stringMatching(/is missing/)]);
      writeFileSync(join(root, NOTICES_FILE), renderNotices({ root }));
      expect(checkNotices({ root, full: true })).toEqual([]);
      writeFileSync(join(root, "package-lock.json"), JSON.stringify(lockOf({ "node_modules/a": { version: "1.1.0", license: "MIT" } })));
      expect(checkNotices({ root }).join("\n")).toMatch(/a@1\.1\.0 MIT[\s\S]*a@1\.0\.0 MIT/);
      writeFileSync(join(root, "package-lock.json"), JSON.stringify(lockOf({ "node_modules/a": { version: "1.0.0" } })));
      expect(checkNotices({ root }).join("\n")).toMatch(/states no licence/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
