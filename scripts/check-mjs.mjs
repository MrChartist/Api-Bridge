// Syntax-checks every .mjs file under server/, scripts/ and bin/ with `node --check`.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walk(p)) : p.endsWith(".mjs") ? [p] : [];
});
const files = [...walk("server"), ...walk("scripts"), ...walk("bin")];
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
console.log(`node --check: ${files.length} files OK`);
