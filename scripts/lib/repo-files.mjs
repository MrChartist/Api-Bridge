import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every file git tracks plus new files not yet added (and not ignored), as repo-relative paths with forward slashes. */
export function repoFiles(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.toString().split("\0").filter(Boolean))].sort();
}

/** The text of a file, or null when it looks binary or is gone (a deleted file git still lists mid-edit). */
export function readText(rel, root = ROOT) {
  try {
    const buf = readFileSync(join(root, rel));
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch {
    return null;
  }
}
