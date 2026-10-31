#!/usr/bin/env node
/**
 * Regenerates server/vendor/chartist-core/ from a checkout of the owner's scanner repository: the ChartistScript core
 * (packages/chartist-core) compiled once from TypeScript to plain ES modules, so the Bridge runs it with no build step.
 *
 *   node scripts/vendor-chartist-core.mjs [--core ../scanner] [--out server/vendor/chartist-core]
 *                                         [--check] [--tests <dir>]
 *
 *   --core   the scanner checkout, or its packages/chartist-core folder (default ../scanner next to this repository)
 *   --out    where the compiled copy goes (default server/vendor/chartist-core); the folder is replaced
 *   --check  compile to a temporary folder and compare with --out; exit 1 when they differ (nothing is written)
 *   --tests  also compile the core's own tests, fixtures and examples into <dir>, as a tree vitest can run against the
 *            same compiled sources (see docs/guides/studies.md, "Updating the copy")
 *
 * What it does, and the only changes it makes to the core:
 *   1. copies src/ (without __tests__ and *.test.ts) to a temporary folder and compiles it with this repository's own
 *      TypeScript (node_modules/.bin/tsc; target ES2023, ESNext modules, comments kept, no declarations);
 *   2. gives every relative import an explicit file name (`./x` becomes `./x.js`, `./dir` becomes `./dir/index.js`),
 *      because the core is written for a bundler and Node's ES modules need the full name. Every rewritten specifier is
 *      checked to name a file that exists;
 *   3. copies COPYRIGHT, PROVENANCE.md, THIRD_PARTY_NOTICES.md, SECURITY.md and README.md unchanged, and writes
 *      VENDOR.json (source commit, compiler, a sha256 of every file) and VENDORED.md (where it came from).
 *
 * The core is the owner's code, all rights reserved (COPYRIGHT in the copy). It is not covered by this repository's
 * LICENSE. Never edit the copy by hand: change the scanner and run this script again. server/bridge/studies/vendor.test.mjs
 * fails when a file no longer matches VENDOR.json.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Compiler options for the vendored copy. Recorded in VENDOR.json. */
export const COMPILER_OPTIONS = Object.freeze({
  target: "ES2023",
  lib: ["ES2023"],
  module: "ESNext",
  moduleResolution: "bundler",
  isolatedModules: true,
  moduleDetection: "force",
  strict: true,
  skipLibCheck: true,
  noFallthroughCasesInSwitch: true,
  declaration: false,
  sourceMap: false,
  removeComments: false,
  noEmitOnError: true,
  newLine: "lf",
});

/** Files kept beside the compiled code, unchanged. */
export const NOTICE_FILES = Object.freeze(["COPYRIGHT", "PROVENANCE.md", "THIRD_PARTY_NOTICES.md", "SECURITY.md", "README.md"]);

const toPosix = (p) => p.split(sep).join("/");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The packages/chartist-core folder from a path to the scanner checkout or to the package itself. */
export function resolveCore(path) {
  const abs = resolve(path);
  for (const c of [abs, join(abs, "packages", "chartist-core")]) {
    if (existsSync(join(c, "src", "index.ts")) && existsSync(join(c, "COPYRIGHT"))) return c;
  }
  throw new Error(`No ChartistScript core at ${abs} (looked for src/index.ts and COPYRIGHT, also under packages/chartist-core).`);
}

/** The git commit of the core's checkout, and whether the package folder has uncommitted changes. */
function gitInfo(core) {
  const git = (...args) => execFileSync("git", ["-C", core, ...args], { encoding: "utf8" }).trim();
  try {
    const commit = git("rev-parse", "HEAD");
    const dirty = git("status", "--porcelain", "--", ".") !== "";
    let remote = "";
    try {
      remote = git("remote", "get-url", "origin");
    } catch {
      /* no remote */
    }
    const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote)?.[1] ?? (remote || "unknown");
    const committedAt = git("log", "-1", "--format=%cI");
    return { repo, path: toPosix(relative(git("rev-parse", "--show-toplevel"), core)) || ".", commit, committedAt, dirty };
  } catch {
    return { repo: "unknown", path: ".", commit: "unknown", committedAt: null, dirty: true };
  }
}

const IMPORT_RE = /^(\s*(?:import|export)\b[^;'"]*?\bfrom\s*)(['"])(\.{1,2}(?:\/[^'"\n]*)?)\2/gm;
const BARE_IMPORT_RE = /^(\s*import\s*)(['"])(\.{1,2}(?:\/[^'"\n]*)?)\2/gm;

/**
 * Give every relative specifier in an emitted file an explicit name. Throws when a specifier names nothing.
 * @param {string} text emitted JavaScript
 * @param {string} fileDir folder of the emitted file
 */
export function rewriteSpecifiers(text, fileDir) {
  const fix = (_m, head, q, spec) => {
    if (/\.(m?js|json)$/.test(spec)) return `${head}${q}${spec}${q}`;
    const base = resolve(fileDir, spec);
    let out;
    if (existsSync(`${base}.js`)) out = `${spec}.js`;
    else if (existsSync(join(base, "index.js"))) out = `${spec.replace(/\/$/, "")}/index.js`;
    else throw new Error(`Import "${spec}" in ${fileDir} names no compiled file.`);
    return `${head}${q}${out}${q}`;
  };
  return text.replace(IMPORT_RE, fix).replace(BARE_IMPORT_RE, fix);
}

/** Relative specifiers left without an explicit name (must be none after rewriteSpecifiers). */
export function bareRelativeSpecifiers(text) {
  const out = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) if (!/\.(m?js|json)$/.test(m[3])) out.push(m[3]);
  }
  return out;
}

function tscPath() {
  const p = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(p)) throw new Error("TypeScript is not installed here: run npm install (it is a devDependency).");
  return p;
}

const tscVersion = () => JSON.parse(readFileSync(join(ROOT, "node_modules", "typescript", "package.json"), "utf8")).version;

/**
 * Compile `rootDirs` (relative to `core`) into `outDir`, copying non-TypeScript files such as golden JSON beside them.
 * @param {string} core
 * @param {string} outDir
 * @param {{ tests?: boolean }} [o] tests=true keeps __tests__, *.test.ts, fixtures/ and examples/
 */
function compile(core, outDir, { tests = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), "chartist-core-"));
  try {
    const dirs = tests ? ["src", "fixtures", "examples"] : ["src"];
    for (const d of dirs) {
      if (!existsSync(join(core, d))) continue;
      cpSync(join(core, d), join(work, d), {
        recursive: true,
        filter: (from) => tests || !(/(^|[\\/])__tests__([\\/]|$)/.test(relative(core, from)) || /\.test\.ts$/.test(from)),
      });
    }
    const options = { ...COMPILER_OPTIONS, rootDir: ".", outDir: "./out", types: tests ? ["node"] : [], noEmitOnError: !tests };
    writeFileSync(join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: options, include: dirs }, null, 2));
    if (tests) {
      // The tests' types (vitest, node) come from this repository's own node_modules.
      symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"), "junction");
    }
    try {
      execFileSync(process.execPath, [tscPath(), "-p", join(work, "tsconfig.json")], { cwd: work, stdio: "pipe" });
    } catch (err) {
      // Test files may carry type errors the core's own config tolerates; they still emit. The core itself must be clean.
      if (!tests) throw new Error(`tsc failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
    const out = join(work, "out");
    for (const d of dirs) {
      if (!existsSync(join(work, d))) continue;
      for (const f of walk(join(work, d))) {
        if (f.endsWith(".ts")) continue;
        const dest = join(out, relative(work, f));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(f, dest);
      }
    }
    for (const f of walk(out)) {
      if (!f.endsWith(".js")) continue;
      const text = readFileSync(f, "utf8");
      const next = rewriteSpecifiers(text, dirname(f));
      if (next !== text) writeFileSync(f, next);
    }
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    cpSync(tests ? out : join(out, "src"), outDir, { recursive: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** sha256 of every file under dir except VENDOR.json, by posix path. */
export function hashTree(dir) {
  const files = {};
  for (const f of walk(dir).sort()) {
    const rel = toPosix(relative(dir, f));
    if (rel === "VENDOR.json") continue;
    files[rel] = sha256(readFileSync(f));
  }
  return files;
}

function vendoredMd(src, tsc) {
  return `# ChartistScript core (vendored copy)

This folder is a **compiled copy** of the ChartistScript core, \`@chartist/core\`, from the owner's scanner repository
(\`${src.repo}\`, folder \`${src.path}\`, commit \`${src.commit.slice(0, 7)}\`${src.dirty ? ", with uncommitted changes" : ""}).

- **Copyright.** The core is Copyright (c) 2026 Rohit Singh (Mr. Chartist), all rights reserved: see [COPYRIGHT](COPYRIGHT).
  It is **not** covered by this repository's MIT LICENSE. Where each part came from: [PROVENANCE.md](PROVENANCE.md) and
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The core's own README and SECURITY notes are kept beside them.
- **What changed.** Nothing but the build: the TypeScript in \`src/\` was compiled with TypeScript ${tsc} to ES2023
  modules (comments kept), and each relative import was given its full file name (\`./x\` to \`./x.js\`, \`./dir\` to
  \`./dir/index.js\`) so Node can load it without a bundler. Tests are not included.
- **Do not edit these files.** Change the core in the scanner repository and run
  \`node scripts/vendor-chartist-core.mjs --core <scanner checkout>\`. \`VENDOR.json\` holds a sha256 of every file and
  \`server/bridge/studies/vendor.test.mjs\` fails when one differs.
- **How the Bridge uses it.** Only \`server/bridge/studies/\` imports it: through \`index.js\` (the core's public entry),
  plus \`stdlib/studies/specs.js\` (data only: which pane each study is drawn in).
  Studies run on the server, in a worker thread with a time limit: see \`docs/guides/studies.md\`. The core's backtest and
  derivatives modules are part of the copy because they compile cleanly, but nothing in the Bridge calls them; the
  Bridge has its own backtest.
`;
}

function main(argv) {
  const flag = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  const core = resolveCore(flag("--core", resolve(ROOT, "..", "scanner")));
  const out = resolve(ROOT, flag("--out", join("server", "vendor", "chartist-core")));
  const check = argv.includes("--check");
  const testsDir = flag("--tests", null);
  const src = gitInfo(core);
  const tsc = tscVersion();

  const target = check ? mkdtempSync(join(tmpdir(), "chartist-core-check-")) : out;
  compile(core, target);
  for (const f of NOTICE_FILES) cpSync(join(core, f), join(target, f));
  writeFileSync(join(target, "package.json"), `${JSON.stringify({ name: "@chartist/core-vendored", private: true, license: "UNLICENSED", type: "module", sideEffects: false, main: "./index.js" }, null, 2)}\n`);
  writeFileSync(join(target, "VENDORED.md"), vendoredMd(src, tsc));
  for (const f of walk(target)) {
    if (!f.endsWith(".js")) continue;
    const left = bareRelativeSpecifiers(readFileSync(f, "utf8"));
    if (left.length) throw new Error(`${relative(target, f)} still has relative imports without a file name: ${left.join(", ")}`);
  }
  const files = hashTree(target);
  const lock = {
    note: "Generated by scripts/vendor-chartist-core.mjs. Do not edit the files listed here by hand.",
    source: src,
    compiler: { typescript: tsc, options: COMPILER_OPTIONS },
    files,
  };
  writeFileSync(join(target, "VENDOR.json"), `${JSON.stringify(lock, null, 2)}\n`);

  if (check) {
    let same = false;
    try {
      const committed = JSON.parse(readFileSync(join(out, "VENDOR.json"), "utf8"));
      same = JSON.stringify(committed.files) === JSON.stringify(files) && JSON.stringify(hashTree(out)) === JSON.stringify(files);
    } catch {
      same = false;
    }
    rmSync(target, { recursive: true, force: true });
    console.log(same ? `vendor-chartist-core: ${toPosix(relative(ROOT, out))} matches ${src.repo}@${src.commit.slice(0, 7)}` : `vendor-chartist-core: ${toPosix(relative(ROOT, out))} differs from ${src.repo}@${src.commit.slice(0, 7)}`);
    return same ? 0 : 1;
  }

  const js = Object.keys(files).filter((f) => f.endsWith(".js"));
  const bytes = Object.keys(files).reduce((n, f) => n + statSync(join(out, f)).size, 0);
  console.log(`vendor-chartist-core: ${js.length} modules, ${(bytes / 1024).toFixed(0)} KiB, from ${src.repo}@${src.commit.slice(0, 7)}${src.dirty ? " (dirty)" : ""} with TypeScript ${tsc} -> ${toPosix(relative(ROOT, out))}`);

  if (testsDir) {
    const dir = resolve(testsDir);
    compile(core, dir, { tests: true });
    // The tests read the package's own docs, examples and goldens by path from the package root.
    for (const f of [...NOTICE_FILES, "package.json", "CHANGELOG.md", "CONTRIBUTING.md"]) if (existsSync(join(core, f))) cpSync(join(core, f), join(dir, f));
    for (const d of ["docs", "conformance"]) if (existsSync(join(core, d))) cpSync(join(core, d), join(dir, d), { recursive: true });
    // Tests that check the source text itself (boundaries, docs quoting examples/) read the .ts files: keep them beside the
    // compiled .js. Every import in the compiled tests names a .js file, so the .ts files are only read, never run.
    for (const d of ["src", "fixtures", "examples"]) {
      if (!existsSync(join(core, d))) continue;
      cpSync(join(core, d), join(dir, d), { recursive: true, filter: (from) => statSync(from).isDirectory() || from.endsWith(".ts") });
    }
    writeFileSync(
      join(dir, "vitest.config.mjs"),
      'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({ test: { environment: "node", include: ["src/**/*.test.js"], testTimeout: 120000, hookTimeout: 120000 } });\n',
    );
    if (!existsSync(join(dir, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
    console.log(`vendor-chartist-core: the core's tests, compiled the same way, are in ${dir}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`vendor-chartist-core: ${err.message}`);
    process.exitCode = 1;
  }
}
