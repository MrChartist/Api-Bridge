/**
 * Doctor line for collections (collections.json): how many, and whether the file was damaged and set aside.
 * Reads one file; creates nothing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{ config: any }} o
 * @returns {Array<{ level: "ok"|"warn", check: string, message: string, blocking?: boolean }>}
 */
export function libraryDoctorChecks({ config }) {
  const out = [];
  const dir = config.dataDir;
  if (!existsSync(dir)) return out;
  try {
    const set = readdirSync(dir).filter((n) => n.startsWith("collections.json.corrupt-"));
    if (set.length) out.push({ level: "warn", check: "collections", message: `The collections file was damaged once and set aside (${set.length} copy${set.length === 1 ? "" : "ies"} kept, for example ${set[0]}). Collections made before that must be created again, or restored from the copy by hand.`, blocking: true });
  } catch {
    /* unreadable folder: the data-dir check reports it */
  }
  const file = join(dir, "collections.json");
  if (!existsSync(file)) return out;
  try {
    const n = (JSON.parse(readFileSync(file, "utf8")).collections ?? []).length;
    out.push({ level: "ok", check: "collections", message: `${n} collection${n === 1 ? "" : "s"}` });
  } catch {
    out.push({ level: "warn", check: "collections", message: "collections.json cannot be read; the Bridge will set it aside at the next start and begin with no collections." });
  }
  return out;
}
