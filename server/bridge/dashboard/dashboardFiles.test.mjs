import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";

const here = import.meta.dirname;
const read = (f) => readFileSync(resolve(here, f), "utf8");

/** Every dashboard file the browser can load: what index.html names, then each relative import (static or dynamic). */
function loadedFiles() {
  const seen = new Set(["index.html"]);
  const queue = [];
  for (const m of read("index.html").matchAll(/(?:src|href)="\/dashboard\/([^"]+)"/g)) queue.push(m[1]);
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f) || !/\.(js|css|svg)$/.test(f) || !existsSync(resolve(here, f))) continue;
    seen.add(f);
    if (f.endsWith(".js") && !f.endsWith(".min.js")) for (const m of read(f).matchAll(/(?:from |import\()"\.\/([^"]+)"/g)) queue.push(m[1]);
  }
  return seen;
}

describe("dashboard file allowlist", () => {
  it("serves every file the browser loads (a missing one would 404 the whole dashboard)", () => {
    for (const f of loadedFiles()) expect(Object.hasOwn(DASHBOARD_FILES, f), `${f} is in DASHBOARD_FILES`).toBe(true);
  });

  it("lists only files that exist", () => {
    const files = new Set(readdirSync(here));
    for (const f of Object.keys(DASHBOARD_FILES)) expect(files.has(f), `${f} exists`).toBe(true);
  });

  it("lists no file the browser never loads", () => {
    const loaded = loadedFiles();
    for (const f of Object.keys(DASHBOARD_FILES)) expect(loaded.has(f), `${f} is loaded by the dashboard`).toBe(true);
  });
});
