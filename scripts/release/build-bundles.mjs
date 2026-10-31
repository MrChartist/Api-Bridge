#!/usr/bin/env node
// Builds the ready-to-run downloads: one ZIP per system with the Bridge, its parts (node_modules) and a private
// Node.js already inside, so installing is "unzip, double-click" with nothing else to download.
//
//   node scripts/release/build-bundles.mjs [--out dist] [--only linux-x64,windows-x64] [--node-dist <url>]
//
// Node.js comes from nodejs.org (newest 22.x), checked against its published SHA-256. The production dependencies are
// pure JavaScript (the build fails if one ever needs an install script), so one node_modules folder fits every system.
// Needs `zip` and `tar` on the build machine (GitHub's ubuntu runners have both).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = resolve(ROOT, flag("--out", "dist"));
const NODE_DIST = flag("--node-dist", process.env.MCB_NODE_DIST || "https://nodejs.org/dist").replace(/\/+$/, "");
const ONLY = flag("--only", "").split(",").filter(Boolean);

/** Systems we ship. `node` is nodejs.org's platform name; `launcher` is what the user double-clicks. */
export const TARGETS = Object.freeze([
  { id: "windows-x64", node: "win-x64", archive: "zip", launcher: "start-windows.bat" },
  { id: "macos-arm64", node: "darwin-arm64", archive: "tar.gz", launcher: "start-mac.command" },
  { id: "macos-x64", node: "darwin-x64", archive: "tar.gz", launcher: "start-mac.command" },
  { id: "linux-x64", node: "linux-x64", archive: "tar.gz", launcher: "start-linux.sh" },
  { id: "linux-arm64", node: "linux-arm64", archive: "tar.gz", launcher: "start-linux.sh" },
]);

/** Repository files that do not belong in a download: tests, fixtures, CI, screenshots, deploy kits. */
export function shipped(path) {
  if (/(^|\/)__fixtures__\//.test(path) || /\.(test|spec)\.mjs$/.test(path)) return false;
  if (/^(\.github|test|deploy|docker|scripts\/release)\//.test(path) || path.startsWith("docs/screenshots/")) return false;
  if (/^(\.gitattributes|\.gitignore|\.dockerignore|Dockerfile|docker-compose\.yml|vitest\.config\.mjs|tsconfig\.json)$/.test(path)) return false;
  return true;
}

/** Newest v<major>.x from nodejs.org's index.json. @param {Array<{ version: string }>} index */
export function pickNode(index, major = 22) {
  const versions = index.map((r) => r.version).filter((v) => new RegExp(`^v${major}\\.\\d+\\.\\d+$`).test(v));
  versions.sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.slice(1).split(".").map(Number));
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  if (!versions.length) throw new Error(`no Node.js ${major}.x in the index`);
  return versions[0];
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], ...opts });

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  const work = mkdtempSync(join(tmpdir(), "mcb-bundles-"));
  mkdirSync(OUT, { recursive: true });
  try {
    // 1. The app: tracked files only (never a developer's local config, keys or data).
    const files = run("git", ["ls-files", "-z"], { cwd: ROOT }).toString().split("\0").filter(Boolean).filter(shipped);
    const app = join(work, "app");
    for (const f of files) {
      mkdirSync(dirname(join(app, f)), { recursive: true });
      cpSync(join(ROOT, f), join(app, f));
    }
    // 2. Production parts, once for every system.
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: "inherit" });
    const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
    const scripted = Object.entries(lock.packages).filter(([k, p]) => k && !p.dev && p.hasInstallScript).map(([k]) => k);
    if (scripted.length) throw new Error(`these production parts need an install script, so one node_modules cannot fit every system: ${scripted.join(", ")}`);
    // The Windows launcher's "parts are installed" mark (node-runtime.ps1, Test-McbPackagesCurrent): the lockfile's SHA-256,
    // so the first double-click does not reinstall. The macOS/Linux launchers look for node_modules/.package-lock.json.
    writeFileSync(join(app, "node_modules", ".mcb-installed"), createHash("sha256").update(readFileSync(join(app, "package-lock.json"))).digest("hex").toUpperCase());

    // 3. Node.js, checked.
    const nodeVersion = pickNode(JSON.parse((await download(`${NODE_DIST}/index.json`)).toString("utf8")));
    const sums = (await download(`${NODE_DIST}/${nodeVersion}/SHASUMS256.txt`)).toString("utf8");
    console.log(`Bridge ${version}, Node.js ${nodeVersion}`);

    // Each Node.js archive is downloaded, checked against SHASUMS256.txt and unpacked once; returns the unpacked folder.
    const unpacked = new Map();
    const nodeFor = async (platform, archive) => {
      const key = `${platform}.${archive}`;
      if (unpacked.has(key)) return unpacked.get(key);
      const name = `node-${nodeVersion}-${platform}.${archive}`;
      const expected = sums.split("\n").find((l) => l.trim().endsWith(`  ${name}`))?.split(/\s+/)[0];
      if (!expected) throw new Error(`${name} is not in SHASUMS256.txt`);
      const data = await download(`${NODE_DIST}/${nodeVersion}/${name}`);
      const got = createHash("sha256").update(data).digest("hex");
      if (got !== expected) throw new Error(`${name}: SHA-256 ${got} does not match nodejs.org (${expected})`);
      const dir = join(work, "node", key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), data);
      if (archive === "zip") run("unzip", ["-q", join(dir, name), "-d", dir]);
      else run("tar", ["-xzf", join(dir, name), "-C", dir]);
      rmSync(join(dir, name));
      const root = join(dir, name.replace(/\.(zip|tar\.gz)$/, ""));
      unpacked.set(key, root);
      return root;
    };

    for (const t of TARGETS) {
      if (ONLY.length && !ONLY.includes(t.id)) continue;
      // The folder people see after unzipping, with Node.js where the launchers look for it (<app>/runtime).
      const stage = join(work, t.id);
      const top = join(stage, "Mr Chartist Bridge");
      cpSync(app, top, { recursive: true });
      cpSync(await nodeFor(t.node, t.archive), join(top, "runtime"), { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(top, "READ ME FIRST.txt"), readMe(t, version, nodeVersion), "utf8");

      const zipName = `mr-chartist-bridge-${version}-${t.id}.zip`;
      rmSync(join(OUT, zipName), { force: true });
      // -X: no extra file attributes; -y: keep Node's symlinks (bin/npm) as links. Unix modes are kept for macOS/Linux.
      run("zip", ["-q", "-r", "-X", "-y", join(OUT, zipName), "Mr Chartist Bridge"], { cwd: stage });
      rmSync(stage, { recursive: true, force: true });
      console.log(`  ${zipName}`);
    }

    // The Windows Setup .exe (build-exe.mjs). Its blob is made by a Linux Node.js of the same version.
    if (!ONLY.length || ONLY.includes("windows-x64") || ONLY.includes("windows-exe")) {
      if (process.platform !== "linux" || process.arch !== "x64") throw new Error("build the Windows .exe on Linux x64 (as the Release workflow does), or pass --only without windows-x64");
      const { buildExe } = await import("./build-exe.mjs");
      const exeName = `Mr-Chartist-Bridge-Setup-${version}.exe`;
      await buildExe({
        app,
        nodeBinary: join(await nodeFor("win-x64", "zip"), "node.exe"),
        blobNode: join(await nodeFor("linux-x64", "tar.gz"), "bin", "node"),
        out: join(OUT, exeName),
        version,
        windows: true,
        work: join(work, "exe"),
      });
      console.log(`  ${exeName}`);
    }
    writeFileSync(join(OUT, "SHA256SUMS.txt"), checksums(OUT), "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function checksums(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".zip") || f.endsWith(".exe"))
    .sort()
    .map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}\n`)
    .join("");
}

/** The note at the top of the unzipped folder, in plain words. */
export function readMe(t, version, nodeVersion) {
  const steps = {
    "start-windows.bat": [
      "1. Double-click start-windows.bat.",
      '   If Windows shows "Windows protected your PC", click "More info", then "Run anyway" (only the first time).',
    ],
    "start-mac.command": [
      "1. Double-click start-mac.command.",
      '   The first time, macOS may say it cannot check the file. On macOS 15 or newer: open System Settings,',
      '   Privacy & Security, scroll down and click "Open Anyway". On older macOS: right-click the file, choose Open,',
      "   then Open again. (The one-line installer in the README avoids this step.)",
    ],
    "start-linux.sh": ["1. Double-click start-linux.sh, or in a terminal in this folder run:  sh start-linux.sh"],
  }[t.launcher];
  return [
    `Mr. Chartist API Bridge ${version}`,
    "",
    "Everything it needs is already in this folder, including its own Node.js (" + nodeVersion + "). Nothing else to install.",
    "",
    ...steps,
    "2. Your browser opens the dashboard, already signed in. Keep the small window open while you use the Bridge.",
    "3. To stop it, close that window (or press Ctrl+C in it). Double-click again to start it next time.",
    "",
    "Orders are paper (practice) by default. Real orders stay off until you switch them on yourself.",
    "Help: https://github.com/MrChartist/api-bridge#readme",
    "",
  ].join(t.launcher === "start-windows.bat" ? "\r\n" : "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
