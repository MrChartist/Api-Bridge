/**
 * Writes (or checks) a generated tree. A generator returns a Map of relative path -> text for the folders it owns;
 * `syncOutputs` makes those folders match it exactly (stale files removed), or with `check` only reports differences.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
};

/**
 * @param {string} root repository root
 * @param {Map<string, string>} files path relative to root -> content
 * @param {{ owned: string[], check?: boolean }} opts `owned`: folders (or single files) relative to root the generator fully owns
 * @returns {{ changed: string[], removed: string[], written: number }}
 */
export function syncOutputs(root, files, { owned, check = false }) {
  const changed = [];
  const removed = [];
  for (const [rel, text] of files) {
    const abs = resolve(root, rel);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (current === text) continue;
    changed.push(rel);
    if (!check) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
  for (const own of owned) {
    const abs = resolve(root, own);
    const present = existsSync(abs) && statSync(abs).isDirectory() ? walk(abs) : existsSync(abs) ? [abs] : [];
    for (const f of present) {
      const rel = relative(root, f).split("\\").join("/");
      if (files.has(rel)) continue;
      removed.push(rel);
      if (!check) rmSync(f);
    }
  }
  return { changed, removed, written: files.size };
}

/** Run a generator from the command line: `--check` fails (exit 1) when the committed files are out of date. */
export function runCli(name, root, files, owned, argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const r = syncOutputs(root, files, { owned, check });
  if (check) {
    if (r.changed.length || r.removed.length) {
      console.error(`${name}: generated files are out of date. Run: node scripts/${name}.mjs`);
      for (const f of r.changed) console.error(`  differs: ${f}`);
      for (const f of r.removed) console.error(`  stale:   ${f}`);
      process.exit(1);
    }
    console.log(`${name}: ${r.written} generated files are up to date`);
    return;
  }
  console.log(`${name}: ${r.written} files (${r.changed.length} written, ${r.removed.length} removed)`);
}
