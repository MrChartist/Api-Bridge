import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, repoFiles } from "../lib/repo-files.mjs";
import { shipped, startsWithShebang, stageFiles, TARGETS } from "./build-bundles.mjs";

/** Files people start by double-clicking or typing, which must keep the execute bit in git and in every download. */
const LAUNCHERS = ["start-mac.command", "start-linux.sh", "install.sh", "bin/mc-bridge.mjs", "scripts/install/launch.sh", "docker/entrypoint.sh"];

const indexModes = () => {
  const out = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: ROOT }).toString().split("\0").filter(Boolean);
  return new Map(out.map((l) => [l.split("\t")[1], l.split(" ")[0]]));
};

const hasZipTools = spawnSync("zip", ["-v"]).status === 0 && spawnSync("zipinfo", ["-h"]).error === undefined;

describe("execute bits on launcher scripts", () => {
  it("git records every launcher and every #! script as mode 100755", () => {
    const modes = indexModes();
    for (const f of LAUNCHERS) expect(modes.get(f), `${f} is not executable in git (git update-index --chmod=+x ${f})`).toBe("100755");
    const wrong = [...modes].filter(([f, m]) => m !== "100755" && f !== "" && startsWithShebangSafe(f));
    expect(wrong.map(([f]) => f)).toEqual([]);
  });

  it("the launcher each download target tells people to open is executable", () => {
    const modes = indexModes();
    for (const t of TARGETS) if (!t.launcher.endsWith(".bat")) expect(modes.get(t.launcher), t.launcher).toBe("100755");
  });

  it("staging for a bundle makes scripts executable even when the checkout lost the bits", () => {
    const work = mkdtempSync(join(tmpdir(), "mcb-exec-"));
    try {
      const src = join(work, "src");
      mkdirSync(src);
      writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho hi\n");
      writeFileSync(join(src, "notes.txt"), "plain text\n");
      chmodSync(join(src, "run.sh"), 0o644);
      const dest = join(work, "dest");
      stageFiles(["run.sh", "notes.txt"], src, dest);
      expect(statSync(join(dest, "run.sh")).mode & 0o111).toBe(0o111);
      expect(statSync(join(dest, "notes.txt")).mode & 0o111).toBe(0);
      expect(startsWithShebang(join(dest, "run.sh"))).toBe(true);
      expect(startsWithShebang(join(dest, "notes.txt"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasZipTools)("a ZIP made the way build-bundles makes it keeps the bits on the launchers", () => {
    const work = mkdtempSync(join(tmpdir(), "mcb-zip-"));
    try {
      const files = repoFiles().filter((f) => LAUNCHERS.includes(f) && shipped(f));
      expect(files).toEqual(expect.arrayContaining(["start-mac.command", "start-linux.sh", "install.sh", "bin/mc-bridge.mjs"]));
      const top = join(work, "Mr Chartist Bridge");
      stageFiles(files, ROOT, top);
      const zip = join(work, "bundle.zip");
      // The same arguments as build-bundles.mjs.
      execFileSync("zip", ["-q", "-r", "-X", "-y", zip, "Mr Chartist Bridge"], { cwd: work });
      const listing = execFileSync("zipinfo", [zip]).toString().split("\n");
      for (const f of files) {
        const row = listing.find((l) => l.endsWith(`Mr Chartist Bridge/${f}`));
        expect(row, f).toBeTruthy();
        expect(row.slice(0, 10), `${f} lost its execute bit in the ZIP`).toBe("-rwxr-xr-x");
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

/** Reads the first two bytes of a tracked file; a file that is gone (deleted but not yet staged) is not a script. */
function startsWithShebangSafe(rel) {
  try {
    return startsWithShebang(join(ROOT, rel));
  } catch {
    return false;
  }
}
