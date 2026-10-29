/**
 * Every name a dashboard module uses must exist in its scope. A helper defined inside one view function and called
 * from another (a ReferenceError the first time that page draws a row) is caught here, before a person opens the page:
 * the TypeScript checker reads the dashboard's plain JS and reports only "cannot find name" errors (no type rules).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const tsc = join(root, "node_modules", ".bin", "tsc");
const files = readdirSync(here)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".min.js"))
  .map((f) => join("server", "bridge", "dashboard", f));

describe("dashboard modules", () => {
  it.skipIf(!existsSync(tsc))("use no name that is not defined in scope", () => {
    const r = spawnSync(tsc, ["--ignoreConfig", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2023,dom,dom.iterable", "--types", "", ...files], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 512 * 1024 * 1024 });
    expect(r.error).toBeUndefined();
    const missing = `${r.stdout}\n${r.stderr}`.split("\n").filter((line) => /error TS(2304|2552|2662|2663):/.test(line));
    expect(missing).toEqual([]);
  }, 60_000);
});
