import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SUMS_FILE, checksums, parseSums, releaseFiles, sha256Of, verifyChecksums } from "./checksums.mjs";
import { sourceArchiveNames, tarCreateArgs } from "./build-bundles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const made = [];
const release = () => {
  const dir = mkdtempSync(join(tmpdir(), "mcb-sums-"));
  made.push(dir);
  for (const [name, body] of Object.entries({
    "mr-chartist-bridge-1.2.3-source.tar.gz": "tarball",
    "mr-chartist-bridge-1.2.3-source.zip": "zipfile",
    "mr-chartist-bridge-1.2.3-linux-x64.zip": "bundle",
    "Mr-Chartist-Bridge-Setup-1.2.3.exe": "exe",
    "install.sh": "#!/bin/sh\n",
    "install.ps1": "Install-McBridge\n",
    "notes.txt": "not a release file",
  })) writeFileSync(join(dir, name), body);
  return dir;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("SHA256SUMS.txt", () => {
  it("lists the downloads and the installer scripts, in the format sha256sum reads", () => {
    const dir = release();
    expect(releaseFiles(dir)).toEqual(["Mr-Chartist-Bridge-Setup-1.2.3.exe", "install.ps1", "install.sh", "mr-chartist-bridge-1.2.3-linux-x64.zip", "mr-chartist-bridge-1.2.3-source.tar.gz", "mr-chartist-bridge-1.2.3-source.zip"]);
    const text = checksums(dir);
    expect(text.split("\n").filter(Boolean)).toHaveLength(6);
    expect(text).toContain(`${sha256Of(Buffer.from("tarball"))}  mr-chartist-bridge-1.2.3-source.tar.gz\n`);
    expect(text).not.toContain("notes.txt");
    expect(parseSums(text).get("install.sh")).toBe(sha256Of(Buffer.from("#!/bin/sh\n")));
    writeFileSync(join(dir, SUMS_FILE), text);
    // The real tool agrees with it.
    const r = spawnSync("sha256sum", ["-c", SUMS_FILE], { cwd: dir, encoding: "utf8" });
    if (!r.error) expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("verify passes, then names a changed file, a missing file and an unlisted file", () => {
    const dir = release();
    writeFileSync(join(dir, SUMS_FILE), checksums(dir));
    expect(verifyChecksums(dir)).toEqual({ ok: true, problems: [] });
    writeFileSync(join(dir, "install.sh"), "#!/bin/sh\necho owned\n");
    expect(verifyChecksums(dir).problems).toEqual(["install.sh does not match its listed checksum"]);
    rmSync(join(dir, "install.ps1"));
    writeFileSync(join(dir, "extra-1.2.3.exe"), "x");
    const p = verifyChecksums(dir).problems;
    expect(p).toContain("install.ps1 is listed but missing");
    expect(p).toContain("extra-1.2.3.exe is not listed in SHA256SUMS.txt");
  });

  it("refuses a list that is missing, empty, duplicated or malformed", () => {
    const dir = release();
    expect(verifyChecksums(dir).ok).toBe(false);
    writeFileSync(join(dir, SUMS_FILE), "");
    expect(verifyChecksums(dir).problems.join(" ")).toMatch(/lists nothing|is not listed/);
    expect(() => parseSums("abc  file")).toThrow(/line 1/);
    const h = "a".repeat(64);
    expect(() => parseSums(`${h}  a\n${h}  a\n`)).toThrow(/twice/);
    expect(parseSums(`${h} *star.zip\n${h.toUpperCase()}  up.zip\r\n`).get("star.zip")).toBe(h);
  });

  it("the command line writes and verifies, and exits 1 on a difference", () => {
    const dir = release();
    const tool = join(ROOT, "scripts/release/checksums.mjs");
    execFileSync(process.execPath, [tool, "write", dir]);
    expect(readFileSync(join(dir, SUMS_FILE), "utf8")).toBe(checksums(dir));
    expect(spawnSync(process.execPath, [tool, "verify", dir]).status).toBe(0);
    writeFileSync(join(dir, "mr-chartist-bridge-1.2.3-source.zip"), "changed");
    const bad = spawnSync(process.execPath, [tool, "verify", dir], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/does not match its listed checksum/);
    mkdirSync(join(dir, "empty"));
    expect(spawnSync(process.execPath, [tool, "frobnicate", dir]).status).toBe(2);
  });
});

describe("the release build and the installers agree", () => {
  it("names the source archives the way install.sh and install.ps1 look for them", () => {
    const n = sourceArchiveNames("2.0.0");
    expect(n).toEqual({ tar: "mr-chartist-bridge-2.0.0-source.tar.gz", zip: "mr-chartist-bridge-2.0.0-source.zip", top: "mr-chartist-bridge-2.0.0" });
    expect(readFileSync(join(ROOT, "install.sh"), "utf8")).toContain("mr-chartist-bridge-$ver-source.tar.gz");
    expect(readFileSync(join(ROOT, "install.ps1"), "utf8")).toContain("mr-chartist-bridge-$ver-source.zip");
  });

  it("makes the tar repeatable where the tar can, and the result is the same bytes every time", () => {
    const args = tarCreateArgs("tar (GNU tar) 1.35", "out.tar.gz", "stage", "top");
    expect(args).toEqual(expect.arrayContaining(["--sort=name", "--mtime=@0", "--owner=0", "-cf"]));
    expect(args).not.toContain("-czf");
    expect(tarCreateArgs("bsdtar 3.5.3 - libarchive 3.5.3", "o", "s", "t")).toEqual(["-czf", "o", "-C", "s", "t"]);
    const gnu = spawnSync("tar", ["--version"], { encoding: "utf8" });
    if (!/GNU tar/.test(gnu.stdout ?? "")) return;
    const root = mkdtempSync(join(tmpdir(), "mcb-tar-"));
    made.push(root);
    mkdirSync(join(root, "stage", "top", "bin"), { recursive: true });
    writeFileSync(join(root, "stage", "top", "bin", "a.txt"), "hello");
    execFileSync("tar", tarCreateArgs(gnu.stdout, join(root, "one.tar.gz"), join(root, "stage"), "top"));
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "stage", "top", "bin", "a.txt"), later, later);
    execFileSync("tar", tarCreateArgs(gnu.stdout, join(root, "two.tar.gz"), join(root, "stage"), "top"));
    expect(sha256Of(readFileSync(join(root, "one.tar.gz")))).toBe(sha256Of(readFileSync(join(root, "two.tar.gz"))));
    expect(execFileSync("tar", ["-tzf", join(root, "one.tar.gz")], { encoding: "utf8" })).toContain("top/bin/a.txt");
  });

  it("the release workflow checks the list and publishes the archives, the installers and the list", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
    expect(wf).toContain("node scripts/release/checksums.mjs verify dist");
    expect(wf).toMatch(/gh release create .*dist\/\*\.tar\.gz/);
    for (const f of ["dist/install.sh", "dist/install.ps1", "dist/SHA256SUMS.txt", "dist/*.exe", "dist/*.zip"]) expect(wf).toContain(f);
  });
});
